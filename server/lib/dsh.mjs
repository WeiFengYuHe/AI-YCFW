// ============================================================================
//  lib/dsh.mjs —— DSH Web API 客户端（0.1.x 的 "会话型服务" 协议）
//  ---------------------------------------------------------------------------
//  DSH 0.1.x 的 HTTP 协议（实测确认，见引擎源码 dsh-host-apiproxy）：
//    · 一元调用：POST /api/<method>，请求体
//        {type:'client-request', rpcId, method, payload}
//      响应体 {type:'server-response', rpcId, result:{ok:true, value}} 或
//              {..., result:{ok:false, error:{code,message}}}
//    · 事件流：WebSocket ws://127.0.0.1:3080/api/events.mux（普通 GET 会 426）
//        帧：{type:'server-request', rpcId, method:<帧类型>, payload:<帧>}
//    · 审批/提问回答：POST /api/respond
//
//  2026-11-19 改成"每个连接一个客户端"：不再把地址写死在模块加载时，
//  这样部署地址改了、或者同时有两个会话型页面，都能各连各的。
// ============================================================================

import crypto from 'node:crypto'

const rid = () => crypto.randomUUID()

export const normalizeBaseUrl = (u) => String(u || '').trim().replace(/\/+$/, '')

// ---------------------------------------------------------------------------
// 一个地址 = 一个客户端（RPC + 两条事件流 + 自动重连）
// ---------------------------------------------------------------------------
export function createLegacyClient(rawBaseUrl) {
  const HTTP = normalizeBaseUrl(rawBaseUrl)
  const WS = HTTP.replace(/^http/, 'ws')
  const listeners = new Set()
  const hub = {
    mux: { ws: null, state: 'idle', since: 0, retry: 0, lastFrameAt: 0 },
    host: { ws: null, state: 'idle', since: 0, retry: 0, lastFrameAt: 0 }
  }
  let everConnected = false
  let stopped = false
  let reconnectTimer = null

  function emit(channel, method, payload, rpcId) {
    const frame = { channel, method, payload, rpcId }
    for (const fn of listeners) {
      try { fn(frame) } catch (e) { console.error('[dsh hub listener]', e.message) }
    }
  }

  function connectChannel(name, path) {
    if (stopped || !HTTP) return
    const slot = hub[name]
    if (slot.ws) { try { slot.ws.close() } catch { /* ignore */ } }
    slot.state = 'connecting'
    let ws
    try {
      ws = new WebSocket(WS + path)
    } catch {
      slot.state = 'error'
      scheduleReconnect(name, path)
      return
    }
    slot.ws = ws
    ws.addEventListener('open', () => {
      slot.state = 'open'
      slot.since = Date.now()
      slot.retry = 0
      everConnected = true
      emit('hub', 'hub/open', { channel: name })
      console.log('[dsh] ' + HTTP + ' ' + name + ' 事件流已连接')
    })
    ws.addEventListener('message', (ev) => {
      slot.lastFrameAt = Date.now()
      if (typeof ev.data !== 'string') return
      let j
      try { j = JSON.parse(ev.data) } catch { return }
      const method = j.method || (j.payload && j.payload.type) || 'unknown'
      emit(name, method, j.payload || {}, j.rpcId)
    })
    ws.addEventListener('error', () => { /* close 会紧跟着来 */ })
    ws.addEventListener('close', () => {
      const wasOpen = slot.state === 'open'
      slot.state = 'closed'
      slot.ws = null
      if (wasOpen) emit('hub', 'hub/close', { channel: name })
      scheduleReconnect(name, path)
    })
  }

  function scheduleReconnect(name, path) {
    if (stopped) return
    const slot = hub[name]
    slot.retry = Math.min((slot.retry || 0) + 1, 8)
    const delay = Math.min(1000 * Math.pow(1.6, slot.retry), 15000)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => connectChannel(name, path), delay)
    reconnectTimer.unref?.()
  }

  async function rpc(method, payload = {}, timeoutMs = 25000) {
    if (!HTTP) throw new Error('还没有配置会话型服务的地址')
    const body = { type: 'client-request', rpcId: rid(), method, payload }
    let resp
    try {
      resp = await fetch(HTTP + '/api/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (e) {
      throw new Error('连不上会话型服务（' + HTTP + '）：' + e.message)
    }
    const text = await resp.text()
    if (resp.status === 401 || resp.status === 403) {
      const err = new Error('会话型服务要求登录令牌（HTTP ' + resp.status + '）')
      err.code = 'auth-required'
      throw err
    }
    if (!resp.ok) {
      throw new Error('DSH ' + method + ' 返回 HTTP ' + resp.status + '：' + text.slice(0, 300))
    }
    let j
    try { j = JSON.parse(text) } catch { throw new Error('DSH ' + method + ' 响应不是 JSON') }
    const result = j.result || {}
    if (result.ok === false) {
      const err = result.error || {}
      const e = new Error(err.message || 'DSH 调用失败')
      e.code = err.code
      e.details = err.details
      throw e
    }
    return result.value
  }

  async function listSessions({ includeSubagents = false, includeBlank = false } = {}) {
    const v = await rpc('session.list', {})
    const items = (v.items || []).filter((s) => {
      if (!includeSubagents && s.origin === 'subagent') return false
      if (!includeBlank && s.blank) return false
      return true
    })
    return items
      .map((s) => ({
        id: s.sessionId,
        title: sessionTitle(s) || '（未命名会话）',
        updatedAt: s.updatedAt,
        running: !!s.running,
        blank: !!s.blank,
        cwd: s.cwd || '',
        agentPreset: s.agentPreset || '',
        parentSessionId: s.parentSessionId || '',
        hasTitle: !!sessionTitle(s)
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async function history(sessionId, { beforeSeq, maxMessages = 30 } = {}) {
    const payload = { sessionId, maxMessages }
    if (typeof beforeSeq === 'number') payload.beforeSeq = beforeSeq
    return await rpc('session.history', payload, 60000)
  }

  async function prompt(sessionId, text, { mode = 'queue', clientTimeZone } = {}) {
    const payload = { sessionId, mode, content: [{ type: 'text', text }] }
    if (clientTimeZone) payload.clientTimeZone = clientTimeZone
    return await rpc('session.prompt', payload, 60000)
  }

  async function cancel(sessionId) {
    return await rpc('session.cancel', { sessionId })
  }

  async function createSession({ cwd, workspaceId, agentPreset } = {}) {
    const payload = {}
    if (workspaceId) payload.workspaceId = workspaceId
    else if (cwd) payload.cwd = cwd
    if (agentPreset) payload.agentPreset = agentPreset
    return await rpc('session.create', payload, 60000)
  }

  async function renameSession(sessionId, title) {
    return await rpc('session.rename', { sessionId, title })
  }

  // 0.1.x 只有归档，没有取消归档（引擎里注释说"未来"才会加）。
  async function archiveSession(sessionId) {
    return await rpc('workspace.archiveSession', { sessionId })
  }

  async function unarchiveSession() {
    const e = new Error('这个会话型服务版本只支持归档，不支持取消归档')
    e.code = 'unsupported'
    throw e
  }

  // 工作区注册表：返回 {items:[{workspaceId,path,title,sessionIds}], archivedSessionIds:[...]}
  async function workspaceRegistry() {
    try {
      const v = await rpc('workspace.list', {})
      return {
        items: Array.isArray(v.items) ? v.items : [],
        archivedSessionIds: Array.isArray(v.archivedSessionIds) ? v.archivedSessionIds : []
      }
    } catch {
      return { items: [], archivedSessionIds: [] }
    }
  }

  async function listWorkspaces() {
    const r = await workspaceRegistry()
    return r.items
  }

  async function respond(clientResponse) {
    if (!HTTP) throw new Error('还没有配置会话型服务的地址')
    const r = await fetch(HTTP + '/api/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clientResponse),
      signal: AbortSignal.timeout(15000)
    })
    if (!r.ok) throw new Error('DSH respond HTTP ' + r.status)
    return await r.json()
  }

  function start() {
    stopped = false
    if (!HTTP) return
    connectChannel('mux', '/api/events.mux')
    connectChannel('host', '/api/events.host')
  }

  function stop() {
    stopped = true
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    for (const name of ['mux', 'host']) {
      const slot = hub[name]
      if (slot.ws) { try { slot.ws.close() } catch { /* ignore */ } }
      slot.ws = null
      slot.state = 'closed'
    }
    listeners.clear()
  }

  function status() {
    return {
      kind: 'legacy',
      baseUrl: HTTP,
      reachable: everConnected || hub.mux.state === 'open',
      mux: hub.mux.state,
      host: hub.host.state,
      muxSince: hub.mux.since,
      lastFrameAt: Math.max(hub.mux.lastFrameAt, hub.host.lastFrameAt)
    }
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  async function test() {
    const t0 = Date.now()
    try {
      const v = await rpc('session.list', {}, 8000)
      const n = Array.isArray(v.items) ? v.items.length : 0
      return { ok: true, ms: Date.now() - t0, detail: '会话型服务可用（' + n + ' 个会话）', models: [] }
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, detail: humanizeError(e), models: [], code: e.code }
    }
  }

  return {
    kind: 'legacy',
    baseUrl: HTTP,
    rpc,
    start,
    stop,
    status,
    subscribe,
    test,
    listSessions,
    history,
    prompt,
    cancel,
    createSession,
    renameSession,
    archiveSession,
    unarchiveSession,
    workspaceRegistry,
    listWorkspaces,
    respond
  }
}

// 把 DSH 的异常翻译成人话（给界面显示）
export function humanizeError(e) {
  const code = e && e.code
  const msg = (e && e.message) || String(e)
  const map = {
    'auth-required': '这个服务要求登录令牌：把它的访问地址（带 token= 的那条）或令牌填进来',
    'agent-busy': '这个会话正忙（模型正在生成），等它说完再试',
    'session-not-found': '会话不存在或已被删除',
    'fork-unavailable': '当前这一轮还没结束，不能从这里分叉',
    'title-invalid': '标题不能为空',
    'unknown-command': '未识别的斜杠命令',
    'command-error': '命令执行失败：' + msg,
    'bad-request': '请求参数不被接受：' + msg,
    'unsupported': msg
  }
  return map[code] || msg
}

// ---------------------------------------------------------------------------
// 会话列表摘要：0.1.x 与 0.2.x 的结构都能读
// ---------------------------------------------------------------------------
export function sessionTitle(summary) {
  const t = summary && summary.projections && summary.projections.values
    ? summary.projections.values.title
    : ''
  return typeof t === 'string' && t.trim() ? t.trim() : ''
}

// ---------------------------------------------------------------------------
// 历史事件折叠 → 可渲染消息
// ---------------------------------------------------------------------------
function blocksToText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  const parts = []
  for (const b of content) {
    if (!b) continue
    if (b.type === 'text') parts.push(b.text || '')
    else if (b.type === 'reasoning') parts.push('')
    else if (b.type === 'image') parts.push('[图片]')
    else if (b.type === 'tool-result') parts.push(blocksToText(b.content))
    else if (typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('')
}

const cap = (s, n) => {
  if (typeof s !== 'string') return ''
  return s.length > n ? s.slice(0, n) + '\n…（已截断 ' + (s.length - n) + ' 字）' : s
}

function normUserMessage(msg) {
  const content = (msg && msg.content) || []
  const texts = []
  let images = 0
  for (const b of content) {
    if (b.type === 'text') texts.push(b.text || '')
    else if (b.type === 'image') images++
  }
  return { text: texts.join('\n'), images }
}

const SYNTHETIC_RE = /^\s*<system-reminder>/i
const SYNTHETIC2_RE = /^\s*Current runtime context/i
// 每轮注入的运行时上下文（时间/时区/间隔）不是用户说的话，历史里直接跳过
const RUNTIME_CONTEXT_RE = /^\s*(Time sampled while preparing turn|Browser time zone for this request|Elapsed since the preceding model-visible message|Current runtime context)/i

/**
 * 把 history 的 events 折叠成消息数组。
 * 返回 { items, title, firstSeq, lastSeq }
 *   item = {kind:'user'|'assistant'|'notice', seq, turn, step, text, reasoning, calls[], images,
 *           interrupted, partial, synthetic}
 *   calls[] = {id, name, args, resultText, isError}
 */
export function foldHistory(entries, { toolResultCap = 4000, reasoningCap = 60000 } = {}) {
  // 预扫描：哪些 (turn:step) 已经有定稿的 assistant/message —— 那些帧里的 chunk 全部跳过
  // （否则一条几千 chunk 的巨型会话会把 CPU 白烧在拼字符串上）
  const finalized = new Set()
  for (const entry of entries) {
    const ev = entry.event || entry
    if (ev && ev.type === 'assistant/message' && ev.data) finalized.add(ev.data.turn + ':' + ev.data.step)
  }

  const items = []
  const stepItem = new Map()
  const callMap = new Map()
  let title = ''

  const ensureStep = (turn, step, seq) => {
    const key = turn + ':' + step
    let it = stepItem.get(key)
    if (!it) {
      it = { kind: 'assistant', seq: seq || 0, turn, step, text: '', reasoning: '', calls: [], partial: false }
      items.push(it)
      stepItem.set(key, it)
    }
    return it
  }

  // mode: 'append'（流式 chunk 累加）| 'replace'（定稿覆盖）| 'fill'（只在空的时候填）
  // 事件顺序可能是 tool/call 先、assistant/message 后，也可能反过来，
  // 所以必须区分"累加/覆盖/填空"三种语义，否则参数会被拼两遍。
  const upsertCall = (it, callId, name, args, mode) => {
    let c = callMap.get(callId)
    if (!c) {
      c = { id: callId, name: name || '工具', args: args || '', result: '', isError: false }
      callMap.set(callId, c)
      it.calls.push(c)
    } else {
      if (name && c.name !== name) c.name = name
      if (args) {
        if (mode === 'replace') c.args = args
        else if (mode === 'fill') { if (!c.args) c.args = args }
        else c.args = (c.args || '') + args
      }
    }
    return c
  }

  for (const entry of entries) {
    const ev = entry.event || entry
    if (!ev || !ev.type) continue
    const d = ev.data || {}

    switch (ev.type) {
      case 'user/message': {
        const msg = d.message || d
        if (msg && msg.source && msg.source.kind === 'tool') break // 工具结果伪装成 user 消息，单独处理
        const u = normUserMessage(msg)
        if (!u.text && !u.images) break
        if (RUNTIME_CONTEXT_RE.test(u.text)) break
        // 注入型的系统提示（workspace 指令 / 运行时快照 / 技能清单）不是人说的话，
        // 标记出来让界面折叠成一行灰字，否则手机上会被几十屏系统提示淹掉
        const synthetic = SYNTHETIC_RE.test(u.text) || SYNTHETIC2_RE.test(u.text) || u.text.includes('<system-reminder>')
        items.push({ kind: 'user', seq: ev.seq, text: u.text, images: u.images, at: ev.time || 0, synthetic })
        break
      }
      case 'assistant/message': {
        const it = ensureStep(d.turn, d.step, ev.seq)
        it.seq = ev.seq
        it.partial = false
        it.text = ''
        it.reasoning = ''
        // 丢掉这一 step 早前记录的调用（结果会从 message 里重建），避免参数重复拼
        for (const old of it.calls) callMap.delete(old.id)
        it.calls = []
        it.interrupted = !!d.interrupted
        it.usage = d.usage || null
        for (const b of (d.message && d.message.content) || []) {
          if (b.type === 'text') it.text += b.text || ''
          else if (b.type === 'reasoning') it.reasoning += b.text || ''
          else if (b.type === 'tool-call') upsertCall(it, b.id, b.name, b.arguments || '', 'replace')
          else if (b.type === 'tool-result') {
            const c = callMap.get(b.toolCallId)
            if (c) { c.result = blocksToText(b.content); c.isError = !!b.isError }
          }
        }
        break
      }
      case 'tool/call': {
        const it = ensureStep(d.turn, d.step, ev.seq)
        upsertCall(it, d.callId, d.name, d.arguments || '', 'fill')
        break
      }
      case 'tool/result': {
        const msg = d.message
        for (const b of (msg && msg.content) || []) {
          if (b.type !== 'tool-result') continue
          const c = callMap.get(b.toolCallId)
          if (c) { c.result = blocksToText(b.content); c.isError = !!b.isError }
        }
        break
      }
      case 'assistant/chunk': {
        const key = d.turn + ':' + d.step
        if (finalized.has(key)) break
        const ch = d.chunk || {}
        const it = ensureStep(d.turn, d.step, ev.seq)
        it.partial = true
        if (ch.type === 'text-delta') it.text += ch.text || ''
        else if (ch.type === 'reasoning-delta') it.reasoning += ch.text || ''
        else if (ch.type === 'tool-call-delta') upsertCall(it, ch.id, ch.name, ch.argumentsDelta || '', 'append')
        else if (ch.type === 'block-end' && ch.block && ch.block.type === 'tool-call') {
          upsertCall(it, ch.block.id, ch.block.name, ch.block.arguments || '', 'fill')
        }
        break
      }
      case 'session/title': {
        const t = d.title || d.value || (d.event && d.event.title)
        if (typeof t === 'string' && t.trim()) title = t.trim()
        break
      }
      case 'compaction/summary': {
        items.push({
          kind: 'notice',
          seq: ev.seq,
          text: '（此处发生了一次上下文压缩，更早的对话被摘要替代）'
        })
        break
      }
      default:
        break
    }
  }

  // 去掉空的 assistant 占位、裁剪超长工具输出
  const cleaned = []
  for (const it of items) {
    if (it.kind === 'assistant') {
      if (!it.text && !it.reasoning && !it.calls.length) continue
      it.text = cap(it.text, 200000)
      it.reasoning = cap(it.reasoning, reasoningCap)
      for (const c of it.calls) {
        c.resultText = cap(c.result || '', toolResultCap)
        delete c.result
      }
    }
    cleaned.push(it)
  }
  const seqs = cleaned.map((i) => i.seq).filter((n) => typeof n === 'number')
  return {
    items: cleaned,
    title,
    firstSeq: seqs.length ? Math.min(...seqs) : 0,
    lastSeq: seqs.length ? Math.max(...seqs) : 0
  }
}
