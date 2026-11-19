// ============================================================================
//  lib/ws.mjs —— 极简 WebSocket 客户端（零依赖，只用 node:http + node:crypto）
//  ---------------------------------------------------------------------------
//  为什么不用浏览器的 WebSocket：Node 内置的 WebSocket 不能带 Cookie 头，
//  而 DSH 0.2.x 的 /api/remote.mux 要带登录 Cookie。
//  这里实现客户端到服务端的握手 + 文本帧 + ping/pong，够读 workspace/follow 的
//  第一帧（归档集合 / 工作区清单）用。不协商 permessage-deflate。
// ============================================================================

import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'

export function wsConnect(rawUrl, { headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(rawUrl) } catch { return reject(new Error('WebSocket 地址不合法：' + rawUrl)) }
    const mod = u.protocol === 'wss:' ? https : http
    const key = crypto.randomBytes(16).toString('base64')
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'wss:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key
      }, headers)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('WebSocket 握手超时')) })
    req.on('error', (e) => reject(e))
    req.on('response', (res) => {
      res.resume()
      reject(new Error('WebSocket 握手失败：HTTP ' + res.statusCode))
    })
    req.on('upgrade', (res, socket, head) => {
      try {
        socket.setNoDelay(true)
        resolve(makeClient(socket, head))
      } catch (e) { reject(e) }
    })
    req.end()
  })
}

function makeClient(socket, head) {
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
  const listeners = new Set()
  let frag = []
  let closed = false

  function emit(obj) {
    for (const fn of listeners) {
      try { fn(obj) } catch { /* 单个监听器失败不影响别的 */ }
    }
  }

  function sendFrame(opcode, payload) {
    if (closed) return
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
    const mask = crypto.randomBytes(4)
    let header
    if (data.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | data.length])
    } else if (data.length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(data.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(data.length), 2)
    }
    const masked = Buffer.alloc(data.length)
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3]
    try { socket.write(Buffer.concat([header, mask, masked])) } catch { /* ignore */ }
  }

  function sendJson(obj) {
    sendFrame(0x1, JSON.stringify(obj))
  }

  function handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) { // close
      closed = true
      try { socket.end() } catch { /* ignore */ }
      emit({ type: 'close' })
      return
    }
    if (opcode === 0x9) { sendFrame(0xA, payload); return } // ping -> pong
    if (opcode === 0xA) return // pong
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      frag.push(payload)
      if (!fin) return
      const all = Buffer.concat(frag)
      frag = []
      let obj
      try { obj = JSON.parse(all.toString('utf8')) } catch { return }
      emit(obj)
    }
  }

  function parse() {
    while (buf.length >= 2) {
      const b0 = buf[0]
      const b1 = buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        off = 10
      }
      let mask = null
      if (masked) {
        if (buf.length < off + 4) return
        mask = buf.slice(off, off + 4)
        off += 4
      }
      if (buf.length < off + len) return
      const payload = Buffer.from(buf.slice(off, off + len))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      buf = buf.slice(off + len)
      handleFrame(fin, opcode, payload)
    }
  }

  socket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); parse() })
  socket.on('close', () => { if (!closed) { closed = true; emit({ type: 'close' }) } })
  socket.on('error', () => { if (!closed) { closed = true; emit({ type: 'close' }) } })

  return {
    sendJson,
    sendFrame,
    onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    close() {
      if (closed) return
      closed = true
      try { sendFrame(0x8, Buffer.alloc(0)) } catch { /* ignore */ }
      try { socket.end() } catch { /* ignore */ }
    }
  }
}
