// ============================================================================
//  lib/dsh2.mjs —— DSH 0.2.x（含桌面软件）的 Remote API 客户端
//  ---------------------------------------------------------------------------
//  与 0.1.x 的 dsh.mjs 不同：
//    · 地址后面是 POST /api/<namespace>/<method>，payload 是 { args: {...} }
//    · 浏览器访问要先拿一个"本次启动令牌"：GET /connect?token=...&interactions=answer
//      服务端回 302 + 一个 dsh-auth-* Cookie；之后 HTTP / WebSocket 都带这个 Cookie
//    · 事件流是 /api/remote.mux 上的逻辑流；本文件为了零依赖和稳妥，先用
//      session/list + session/events 轮询（服务端负责定时刷新）
//
//  桌面软件（Electron）每次启动的 URL 里带 ?token=...，令牌不落盘；
//  但换来的 Cookie 有效期 30 天，所以拿到一次之后可以长期复用。
// ============================================================================

import crypto from 'node:crypto'
import { wsConnect } from './ws.mjs'
import { normalizeBaseUrl, sessionTitle, foldHistory, humanizeError } from './dsh.mjs'

const rid = () => crypto.randomUUID()

function setCookiesOf(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie()
  const one = res.headers.get('set-cookie')
  return one ? [one] : []
}

function cookiePairFrom(res) {
  for (const raw of setCookiesOf(res)) {
    const first = String(raw || '').split(';')[0].trim()
    if (/^dsh-auth-[^=]+=/.test(first)) return first
  }
  return ''
}

export function createDsh2Client({ baseUrl, token, cookie, onCookie, refreshCookie } = {}) {
  const HTTP = normalizeBaseUrl(baseUrl)
  const WS = HTTP.replace(/^http/, 'ws')
  let jar = String(cookie || '').trim()
  let registryCache = { at: 0, data: null }
  let registryBusy = null
  const launchToken = String(token || '').trim()
  let lastOkAt = 0
  let lastError = ''
  let stopped = false
  let exchanging = null

  function status() {
    return {
      kind: 'dsh2',
      baseUrl: HTTP,
      reachable: !!lastOkAt && Date.now() - lastOkAt < 15000,
      auth: !!jar,
      mux: lastOkAt ? 'polling' : 'closed',
      host: lastOkAt ? 'polling' : 'closed',
      muxSince: lastOkAt,
      lastFrameAt: lastOkAt,
      error: lastError
    }
  }

  async function exchangeToken(t = launchToken) {
    if (!HTTP) throw new Error('还没有配置会话型服务的地址')
    const tok = String(t || '').trim()
    if (!tok) {
      const e = new Error('桌面软件需要访问令牌：把带 ?token= 的地址整条贴进来，或填令牌/Cookie')
      e.code = 'auth-required'
      throw e
    }
    if (exchanging) return exchanging
    exchanging = (async () => {
      // 优先走浏览器同款：GET /?token=... → 303 + 一个 v1 浏览器 Cookie
      // （/connect 给的是 v2 API Cookie，绑定 API Peer，纯 HTTP 用不久）
      let url
      let res
      try {
        url = new URL(HTTP + '/')
        url.searchParams.set('token', tok)
        res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12000) })
        if (res.status === 401 || res.status === 403) {
          const e = new Error('令牌不对或已过期（HTTP ' + res.status + '）。桌面软件重启后令牌会变，重新复制一次')
          e.code = 'auth-required'
          throw e
        }
      } catch (e) {
        if (e.code === 'auth-required') throw e
        throw new Error('连不上会话型服务（' + HTTP + '）：' + e.message)
      }
      let pair = cookiePairFrom(res)
      if (!pair) {
        // 老一点的部署可能只认 /connect
        try {
          const c = new URL(HTTP + '/connect')
          c.searchParams.set('token', tok)
          c.searchParams.set('interactions', 'answer')
          res = await fetch(c, { redirect: 'manual', signal: AbortSignal.timeout(12000) })
          pair = cookiePairFrom(res)
        } catch { /* 下面统一报错 */ }
      }
      if (!pair) {
        if (res.status === 401 || res.status === 403) {
          const e = new Error('令牌不对或已过期（HTTP ' + res.status + '）。桌面软件重启后令牌会变，重新复制一次')
          e.code = 'auth-required'
          throw e
        }
        const e = new Error('登录失败：服务没有返回 dsh-auth Cookie（HTTP ' + res.status + '）')
        e.code = 'auth-required'
        throw e
      }
      jar = pair
      try { onCookie && onCookie(pair) } catch { /* 持久化失败不挡使用 */ }
      return pair
    })().finally(() => { exchanging = null })
    return exchanging
  }

  async function ensureAuth() {
    if (jar) return
    if (launchToken) return exchangeToken()
    const e = new Error('这个会话型服务要求登录令牌：填访问地址（带 token=）或令牌/Cookie')
    e.code = 'auth-required'
    throw e
  }

  async function rpc(endpoint, args = {}, timeoutMs = 25000, retried = false) {
    if (!HTTP) throw new Error('还没有配置会话型服务的地址')
    if (stopped) throw new Error('客户端已停止')
    await ensureAuth()
    const body = { type: 'client-request', rpcId: rid(), method: endpoint, payload: { args } }
    let res
    try {
      res = await fetch(HTTP + '/api/' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: jar },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (e) {
      lastError = '连不上会话型服务：' + e.message
      throw new Error(lastError)
    }
    if (res.status === 401 || res.status === 403) {
      // 本机凭据登录：Cookie 过期就现签一个新的（端口没变时最有用）
      if (!retried && typeof refreshCookie === 'function') {
        try {
          const fresh = refreshCookie()
          if (fresh) {
            jar = fresh
            return await rpc(endpoint, args, timeoutMs, true)
          }
        } catch { /* 继续走令牌 */ }
      }
      // Cookie 过期 / 桌面软件重启换了令牌：用保存的令牌再换一次 Cookie 重试
      if (!retried && launchToken) {
        jar = ''
        await exchangeToken()
        return await rpc(endpoint, args, timeoutMs, true)
      }
      lastError = '登录已失效（HTTP ' + res.status + '）'
      const e = new Error('登录已失效：重新填一次访问令牌或 Cookie')
      e.code = 'auth-required'
      throw e
    }
    const text = await res.text()
    if (!res.ok) {
      lastError = 'HTTP ' + res.status
      throw new Error('DSH ' + endpoint + ' 返回 HTTP ' + res.status + '：' + text.slice(0, 300))
    }
    let j
    try { j = JSON.parse(text) } catch {
      lastError = '响应不是 JSON'
      throw new Error('DSH ' + endpoint + ' 响应不是 JSON')
    }
    const result = j.result || {}
    if (result.ok === false) {
      const err = result.error || {}
      const e = new Error(err.message || 'DSH 调用失败')
      e.code = err.code
      e.details = err.details
      lastError = humanizeError(e)
      throw e
    }
    lastOkAt = Date.now()
    lastError = ''
    return result.value
  }

  async function listSessions({ includeSubagents = false, includeBlank = false } = {}) {
    // 0.2.x 的 descriptor 要求按参数名包一层：session/list(_request)
    const v = await rpc('session/list', { _request: {} })
    const items = Array.isArray(v) ? v : (v.items || v.sessions || [])
    return items
      .filter((s) => {
        if (!includeSubagents && s.origin === 'subagent') return false
        if (!includeBlank && s.blank) return false
        return true
      })
      .map((s) => {
        const ts = typeof s.updatedAt === 'number' ? s.updatedAt : (Date.parse(s.updatedAt) || 0)
        const id = s.sessionId || s.id || ''
        return {
          id,
          title: sessionTitle(s) || s.title || '（未命名会话）',
          updatedAt: ts,
          running: !!(s.running || (s.status && s.status.running)),
          blank: !!s.blank,
          cwd: s.cwd || '',
          agentPreset: s.agentPreset || '',
          parentSessionId: s.parentSessionId || '',
          hasTitle: !!(sessionTitle(s) || s.title),
          origin: s.origin || ''
        }
      })
      .filter((s) => s.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async function history(sessionId, { beforeSeq, maxMessages = 30 } = {}) {
    const args = {
      address: { kind: 'session', sessionId },
      maxMessages
    }
    if (typeof beforeSeq === 'number') args.beforeSeq = beforeSeq
    const v = await rpc('session/events', { request: args }, 60000)
    const records = v.records || v.events || []
    const events = records.map((r) => r.event || r)
    const last = events[events.length - 1]
    return {
      events,
      hasMore: !!v.hasMore,
      cursor: v.cursor || (last && last.seq) || 0
    }
  }

  async function prompt(sessionId, text, { mode = 'queue', clientTimeZone } = {}) {
    const args = {
      requestId: rid(),
      sessionId,
      mode,
      content: [{ type: 'text', text }]
    }
    if (clientTimeZone) args.clientTimeZone = clientTimeZone
    return await rpc('session/prompt', { request: args }, 60000)
  }

  async function cancel(sessionId) {
    return await rpc('session/cancel', { request: { sessionId } })
  }

  async function createSession({ cwd, workspaceId, agentPreset } = {}) {
    const args = {}
    if (workspaceId) args.workspaceId = workspaceId
    else if (cwd) args.cwd = cwd
    if (agentPreset) args.agentPreset = agentPreset
    return await rpc('session/create', { request: args }, 60000)
  }

  async function renameSession(sessionId, title) {
    return await rpc('session/rename', { request: { sessionId, title } })
  }

  async function archiveSession(sessionId, { stopActivity = false } = {}) {
    const v = await rpc('workspace/archiveSession', { request: { sessionId, stopActivity: !!stopActivity } })
    registryCache = { at: 0, data: null }
    return v
  }

  async function unarchiveSession(sessionId) {
    const v = await rpc('workspace/unarchiveSession', { request: { sessionId } })
    registryCache = { at: 0, data: null }
    return v
  }

  // 0.2.x 没有 workspace/list（只有 workspace/follow 流）。这里用极简 WS 客户端
  // 读它的第一帧 baseline：里面有工作区清单 + 归档集合。结果缓存 10 秒。
  async function workspaceRegistry() {
    if (registryCache.data && Date.now() - registryCache.at < 10000) return registryCache.data
    if (registryBusy) return registryBusy
    registryBusy = (async () => {
      try {
        await ensureAuth()
        const ws = await wsConnect(WS + '/api/remote.mux', { headers: { Cookie: jar }, timeoutMs: 8000 })
        const streamId = rid()
        const base = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { try { ws.close() } catch { } reject(new Error('workspace/follow 超时')) }, 8000)
          timer.unref?.()
          const off = ws.onMessage((m) => {
            if (!m || m.streamId !== streamId) return
            if (m.type === 'item') {
              clearTimeout(timer); off()
              const v = m.value && m.value.type === 'baseline' ? m.value.value : m.value
              resolve(v || {})
            } else if (m.type === 'error') {
              clearTimeout(timer); off()
              reject(new Error((m.error && m.error.message) || 'workspace/follow 失败'))
            } else if (m.type === 'end') {
              clearTimeout(timer); off()
              reject(new Error('workspace/follow 提前结束'))
            }
          })
          ws.sendJson({ type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} } })
        }).finally(() => { try { ws.close() } catch { /* ignore */ } })
        const items = Array.isArray(base.items) ? base.items : []
        const data = {
          items,
          archivedSessionIds: Array.isArray(base.archivedSessionIds) ? base.archivedSessionIds : [],
          pinnedSessionIds: Array.isArray(base.pinnedSessionIds) ? base.pinnedSessionIds : []
        }
        registryCache = { at: Date.now(), data }
        return data
      } catch (e) {
        if (e.code === 'auth-required') throw e
        return { items: [], archivedSessionIds: [], pinnedSessionIds: [] }
      } finally {
        registryBusy = null
      }
    })()
    return registryBusy
  }

  async function listWorkspaces() {
    const r = await workspaceRegistry()
    return r.items
  }

  async function respond() {
    const e = new Error('这个服务版本的审批/提问走流式接口，网页端暂未接入')
    e.code = 'unsupported'
    throw e
  }

  async function start() {
    stopped = false
    if (!HTTP) return
    try {
      if (!jar && launchToken) await exchangeToken()
      if (jar || launchToken) {
        const rows = await listSessions({})
        lastOkAt = Date.now()
        console.log('[dsh2] ' + HTTP + ' 已连接（' + rows.length + ' 个会话）')
      }
    } catch (e) {
      lastError = humanizeError(e)
      console.log('[dsh2] ' + HTTP + ' 连接失败：' + lastError)
    }
  }

  function stop() {
    stopped = true
  }

  async function test() {
    const t0 = Date.now()
    try {
      const rows = await listSessions({ includeBlank: true, includeSubagents: true })
      return { ok: true, ms: Date.now() - t0, detail: '会话型服务可用（' + rows.length + ' 个会话）', models: [] }
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, detail: humanizeError(e), models: [], code: e.code }
    }
  }

  return {
    kind: 'dsh2',
    baseUrl: HTTP,
    start,
    stop,
    status,
    subscribe: () => () => {},
    test,
    rpc,
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
    respond,
    setCookie: (v) => { jar = String(v || '').trim() },
    exchangeToken
  }
}

export { foldHistory, humanizeError, sessionTitle }
