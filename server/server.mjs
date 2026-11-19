// ============================================================================
//  AI 对话 · 网页版 · 服务端
//  ---------------------------------------------------------------------------
//  它是 DSH 的「第二个前端」：
//    · 会话列表 / 历史 / 发消息 / 停止，全部转给本机 DSH Web（默认 127.0.0.1:3080）
//    · DSH 的事件流（WebSocket）由本进程常连，再以 SSE 广播给所有连着的手机和电脑
//      → 电脑上这个 GUI 里发的消息，手机上立刻能看到；手机上发的，电脑上也立刻能看到
//    · 额外提供「本地模型」模式（接本机 OpenAI 兼容网关），会话存本地 json
//    · 全站要登录：公网暴露时聊天记录和"能在本机执行命令的 Agent"都不会裸奔
//
//  零依赖：只用 Node 内置模块。启动：node server.mjs
//  配置：同目录 config.json（首次启动自动生成，含登录口令）
// ============================================================================

import http from 'node:http'
import zlib from 'node:zlib'
import { promises as fs, readFileSync, existsSync, statSync, renameSync, mkdirSync, createWriteStream } from 'node:fs'
import { spawn, execSync, execFileSync } from 'node:child_process'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import dns from 'node:dns/promises'
import { fileURLToPath } from 'node:url'

import { createLegacyClient, foldHistory, humanizeError, normalizeBaseUrl } from './lib/dsh.mjs'
import { createDsh2Client } from './lib/dsh2.mjs'
import { findDesktopDshPorts, isLoopbackUrl, localAuthCookie } from './lib/dsh-local-auth.mjs'
import { createStore } from './lib/store.mjs'
import { createZip } from './lib/zip.mjs'

// 目录布局（2026-11-18 整理到 DSH-YCFW）：
//   DSH-YCFW\
//     server\server.mjs   ← 本文件（ROOT）
//     server\lib\*.mjs    ← DSH 客户端 + 会话存储
//     server\web\         ← 前端静态文件（原 public）
//     data\  logs\  config.json
// 所以本文件用 SERVER_DIR 定位代码，用 APP_ROOT 定位数据和配置。
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = SERVER_DIR
const APP_ROOT = path.join(SERVER_DIR, '..')
// 数据/配置放哪：默认跟程序放一起；也可以用 DSH_YCFW_HOME 指到别处
// （npm i -g 装到 AppData 下时，bin/dsh-ycfw.mjs 会自动挑一个可写目录）
const HOME_DIR = process.env.DSH_YCFW_HOME ? path.resolve(process.env.DSH_YCFW_HOME) : APP_ROOT
const PUBLIC_DIR = path.join(SERVER_DIR, 'web')
const DATA_DIR = path.join(HOME_DIR, 'data')
const CONV_DIR = path.join(DATA_DIR, 'conversations')
const CONFIG_PATH = path.join(HOME_DIR, 'config.json')

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  port: 8100,
  // 纯净部署默认只监听本机（127.0.0.1）：开箱不把任何东西暴露到局域网/公网。
  // 要让手机或别的电脑访问，在「设置 → 外网访问」里把监听地址改成 0.0.0.0（或配隧道/反代），改完重启生效。
  host: '127.0.0.1',
  auth: { password: '', sessionDays: 30, apiKey: '' },
  // defaultCwd 留空 = 用 AI 服务自己的默认目录；要固定就填绝对路径
  // 纯净部署不假设本机有任何 AI 服务：baseUrl 留空 = 首次运行没有页面，用户自己「＋ 添加」。
  dsh: { baseUrl: '', defaultCwd: '', newSessionPreset: '' },
  // 「快速添加本机模型」的预设值。纯净部署默认关闭且地址留空，不含任何设备信息。
  local: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    maxTokens: 4096,
    temperature: 0.7,
    systemPrompt: '',
    historyCharBudget: 24000
  },
  // 可手动添加的"页面"。字段不写 = 首次运行没有页面（纯净）；
  // 写成空数组 [] = 用户把页面全删了（界面上会引导"＋ 添加"）。
  // 每条：{ id, name, kind:'dsh'|'openai', baseUrl, apiKey, model, note, enabled, autoOpen }
  ui: { appName: 'AI 对话', publicUrl: '' },
  // 对话数据自动备份（见「设置 → 备份」）。passwordHash/passwordSalt 是"部署端密码"的散列，
  // 只有服务部署端（本机回环）能用它修改备份设置或触发备份。
  backup: {
    enabled: true,
    intervalHours: 6,
    keep: 30,
    dir: '',
    passwordSalt: '',
    passwordHash: '',
    lastRunAt: 0
  }
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  if (!over || typeof over !== 'object') return out
  for (const k of Object.keys(over)) {
    const v = over[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

// 记事本保存的 UTF-8 可能带 BOM，JSON.parse 会失败 → 顺手剥掉，否则会被误判成"没有配置"而重生成口令
const readJsonSafe = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return fb } }

let config = deepMerge(DEFAULT_CONFIG, readJsonSafe(CONFIG_PATH, {}))
if (process.env.MC_DSH_HTTP) config.dsh.baseUrl = process.env.MC_DSH_HTTP

// 上游（本地模型网关）的密钥：默认不看任何固定路径，优先环境变量，其次数据目录里的 apikey.txt。
//   DSH_YCFW_APIKEY_FILE  直接指定文件
//   HOME_DIR\apikey.txt   放在数据目录里
// （老版本写死过某个项目的绝对路径，这里去掉了。）
function guessLocalKey() {
  const cands = []
  if (process.env.DSH_YCFW_APIKEY_FILE) cands.push(process.env.DSH_YCFW_APIKEY_FILE)
  cands.push(path.join(HOME_DIR, 'apikey.txt'))
  cands.push(path.join(APP_ROOT, 'apikey.txt'))
  for (const f of cands) {
    try {
      const lines = readFileSync(f, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
      if (lines.length) return lines[0]
    } catch { /* 下一个 */ }
  }
  return ''
}

const randomPassword = (n = 10) => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const buf = crypto.randomBytes(n)
  let s = ''
  for (let i = 0; i < n; i++) s += alphabet[buf[i] % alphabet.length]
  return s
}

async function saveConfig() {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
}

async function initConfig() {
  let dirty = false
  if (!config.auth.password) { config.auth.password = randomPassword(10); dirty = true }
  if (!config.auth.apiKey) { config.auth.apiKey = 'mc_' + crypto.randomBytes(16).toString('hex'); dirty = true }
  // 只有用户显式启用了「本机模型」才去猜密钥 —— 纯净部署绝不去读本机任何 apikey 文件
  if (config.local && config.local.enabled && !config.local.apiKey) {
    const k = guessLocalKey()
    if (k) { config.local.apiKey = k; dirty = true }
  }
  if (dirty || !existsSync(CONFIG_PATH)) await saveConfig()
}

// ---------------------------------------------------------------------------
// 连接（页面）：可手动添加的对话来源
//  ---------------------------------------------------------------------------
//  用户要求（2026-11-18）：「这两个页面应该做成可以手动添加的页面，最初只有一个，
//  通过链接其他 AI 来增加窗口」。所以：
//    · 默认只有内置的那一个（kind='dsh'，连本机 DSH，无需任何配置）
//    · 想加"本地模型"或别家的 AI，就在界面上加一条连接（走标准接口）
//  kind 只有两种，都是标准接口：
//    'dsh'    —— 本机 DSH Web（/api/*，会话实时同步，能力最全）
//    'openai' —— OpenAI 兼容（GET {base}/models、POST {base}/chat/completions 流式），
//                本地 llama.cpp / Ollama / LM Studio / DeepSeek / OpenAI 都能直接填
// ---------------------------------------------------------------------------
// 初次运行时（config 里没有 connections 字段）默认给什么页面：
//   配了 dsh.baseUrl（比如本机 DSH 在 3080）才给一个 DSH 页；
//   否则给空列表 —— 这个项目不绑死 DSH，用户自己「＋ 添加」。
const BUILTIN_DSH = {
  id: 'dsh',
  name: '本机 DSH',
  kind: 'dsh',
  note: '与本机 DSH 共用会话',
  enabled: true
}

function defaultConnections() {
  if (!config.dsh || !config.dsh.baseUrl) return []
  return [Object.assign({}, BUILTIN_DSH, { baseUrl: config.dsh.baseUrl })]
}

function normalizeConn(c) {
  if (!c || typeof c !== 'object') return null
  const kind = c.kind === 'openai' ? 'openai' : 'dsh'
  const id = String(c.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  if (!id) return null
  const out = {
    id,
    name: String(c.name || (kind === 'dsh' ? '会话型服务' : '自定义 AI')).slice(0, 40),
    kind,
    baseUrl: String(c.baseUrl || (kind === 'dsh' ? config.dsh.baseUrl : '')).trim().replace(/\/+$/, ''),
    note: String(c.note || '').slice(0, 120),
    enabled: c.enabled !== false,
    autoOpen: !!c.autoOpen
  }
  if (kind === 'dsh') {
    // api: '' = 自动（有 token/cookie 或地址像 0.2.x 就按新版，否则按 0.1.x）
    out.api = c.api === 'dsh2' ? 'dsh2' : c.api === 'legacy' ? 'legacy' : ''
    out.token = String(c.token || '').trim()
    out.cookie = String(c.cookie || '').trim()
    out.autoDesktop = !!c.autoDesktop
    out.localAuth = !!c.localAuth
  }
  if (kind === 'openai') {
    out.apiKey = String(c.apiKey || '').trim()
    out.model = String(c.model || '').trim() || 'local'
    out.maxTokens = Math.min(32768, Math.max(64, parseInt(c.maxTokens, 10) || 4096))
    out.temperature = Number.isFinite(parseFloat(c.temperature)) ? Math.min(2, Math.max(0, parseFloat(c.temperature))) : 0.7
    out.systemPrompt = String(c.systemPrompt || '').slice(0, 4000)
    out.historyCharBudget = Math.min(200000, Math.max(1000, parseInt(c.historyCharBudget, 10) || 24000))
  }
  return out
}

// 当前生效的连接列表。
// 关键区别（2026-11-18 晚修的 bug）：
//   config 里从来没有 connections 字段         → 用内置的「电脑端 DSH」（首次运行）
//   config 里 connections 是空数组 []          → 用户把页面全删了，返回空数组（界面引导"＋ 添加"）
// 之前两者混在一起，删光之后又"复活"成内置那一页，看起来就是"删不掉"。
function getConnections() {
  if (!Array.isArray(config.connections)) return defaultConnections()
  return config.connections.map(normalizeConn).filter(Boolean)
}

function findConn(id) {
  return getConnections().find((c) => c.id === id) || null
}

// 给前端看的版本：绝不带明文 apiKey
function publicConn(c) {
  const o = {
    id: c.id,
    name: c.name,
    kind: c.kind,
    baseUrl: c.baseUrl || '',
    note: c.note || '',
    enabled: c.enabled !== false,
    autoOpen: !!c.autoOpen
  }
  if (c.kind === 'openai') {
    o.model = c.model || ''
    o.apiKeySet = !!c.apiKey
    o.apiKeyTail = String(c.apiKey || '').slice(-4)
    o.maxTokens = c.maxTokens
    o.temperature = c.temperature
    o.systemPrompt = c.systemPrompt || ''
  }
  if (c.kind === 'dsh') {
    o.api = c.api || guessDshApi(c)
    o.tokenSet = !!c.token
    o.cookieSet = !!c.cookie
    o.tokenTail = String(c.token || '').slice(-4)
    o.autoDesktop = !!c.autoDesktop
    o.localAuth = !!c.localAuth
  }
  return o
}

async function saveConnections(list) {
  config.connections = list
  await saveConfig()
}

// ---------------------------------------------------------------------------
// 会话型（dsh）连接：每个页面一个客户端
//  ---------------------------------------------------------------------------
//  2026-11-19：以前全局只有一个 dsh 客户端，地址在模块加载时就定死了；
//  部署地址一改、或者加第二个会话型页面，就完全对不上。现在：
//    · 每个 kind='dsh' 的页面各有一个客户端（0.1.x legacy / 0.2.x dsh2）
//    · 请求用 X-DSH-Conn 头指定是哪个页面；不带就落到第一个
//    · 地址、令牌、Cookie 改了 → rebuildDshClients() 热替换，不用重启服务
const dshClients = new Map()
let dshDefaultEntry = null

function dshConnections() {
  return getConnections().filter((c) => c.kind === 'dsh' && c.enabled !== false)
}

function guessDshApi(conn) {
  if (conn.api === 'dsh2' || conn.api === 'legacy') return conn.api
  // 本机凭据登录 / 有令牌/Cookie 的一定是 0.2.x；否则按 0.1.x（老部署）走
  if (conn.localAuth || conn.token || conn.cookie) return 'dsh2'
  return 'legacy'
}

function dshSig(conn) {
  return [normalizeBaseUrl(conn.baseUrl || config.dsh.baseUrl), conn.api || '', conn.token || '', conn.cookie ? '1' : '0', conn.localAuth ? 'local' : ''].join('|')
}

function makeDshEntry(conn) {
  const baseUrl = normalizeBaseUrl(conn.baseUrl || config.dsh.baseUrl)
  const api = guessDshApi(conn)
  const entry = {
    id: conn.id,
    name: conn.name,
    conn,
    api,
    baseUrl,
    sig: dshSig(conn),
    client: null,
    unsub: null,
    pollTimer: null,
    listCache: { at: 0, data: null },
    listWarming: false,
    lastListSig: '',
    lastError: ''
  }
  if (api === 'dsh2') {
    let cookie = conn.cookie
    // 本机桌面软件：没有令牌/Cookie 时，用本机 DSH 的 browser-session secret 现签一个
    if (!cookie && conn.localAuth && isLoopbackUrl(baseUrl)) {
      cookie = localAuthCookie(baseUrl)
      if (cookie) console.log('[dsh2] 使用本机 DSH 凭据登录 ' + baseUrl + '（密钥不回传）')
      else entry.lastError = '读不到本机 DSH 凭据（~/.dsh/.credentials.yaml），请填令牌/Cookie'
    }
    entry.client = createDsh2Client({
      baseUrl,
      token: conn.token,
      cookie,
      onCookie: (pair) => { persistDshCookie(conn.id, pair).catch(() => {}) },
      refreshCookie: conn.localAuth && isLoopbackUrl(baseUrl) ? () => localAuthCookie(baseUrl) : null
    })
  } else {
    entry.client = createLegacyClient(baseUrl)
  }
  if (api === 'legacy' && entry.client.subscribe) {
    entry.unsub = entry.client.subscribe((frame) => handleDshFrame(entry, frame))
  }
  return entry
}

async function persistDshCookie(id, pair) {
  const list = getConnections()
  const i = list.findIndex((c) => c.id === id)
  if (i < 0 || !pair || list[i].cookie === pair) return
  list[i].cookie = pair
  await saveConnections(list)
  console.log('[dsh2] 已保存登录 Cookie（页面 ' + id + '），下次启动不用再填')
}

function startDsh2Polling(entry) {
  if (entry.pollTimer) clearInterval(entry.pollTimer)
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const [list, reg] = await Promise.all([
        entry.client.listSessions({}),
        entry.client.workspaceRegistry()
      ])
      const sig = JSON.stringify(list.map((s) => [s.id, s.title, s.running, s.updatedAt])) + '|' + JSON.stringify(reg.archivedSessionIds || [])
      if (sig !== entry.lastListSig) {
        entry.lastListSig = sig
        entry.listCache = { at: 0, data: null }
        broadcast('dsh-sync', { connId: entry.id, archivedCount: (reg.archivedSessionIds || []).length, at: now() })
      }
      entry.lastError = ''
      entry.lastPollAt = Date.now()
    } catch (e) {
      entry.lastError = humanizeError(e)
    } finally {
      busy = false
    }
  }
  entry.pollTimer = setInterval(tick, 2500)
  entry.pollTimer.unref?.()
  tick()
}

async function rebuildDshClients() {
  const wanted = new Map()
  for (const conn of dshConnections()) {
    const sig = dshSig(conn)
    const old = dshClients.get(conn.id)
    if (old && old.sig === sig) { wanted.set(conn.id, old); continue }
    if (old) {
      try { old.unsub && old.unsub() } catch { /* ignore */ }
      try { old.client && old.client.stop && old.client.stop() } catch { /* ignore */ }
      if (old.pollTimer) clearInterval(old.pollTimer)
    }
    const entry = makeDshEntry(conn)
    dshClients.set(conn.id, entry)
    wanted.set(conn.id, entry)
    try { await entry.client.start() } catch (e) { console.log('[dsh] 启动失败 ' + conn.name + '：' + e.message) }
    if (entry.api === 'dsh2') startDsh2Polling(entry)
  }
  for (const [id, entry] of [...dshClients]) {
    if (wanted.has(id)) continue
    try { entry.unsub && entry.unsub() } catch { /* ignore */ }
    try { entry.client && entry.client.stop && entry.client.stop() } catch { /* ignore */ }
    if (entry.pollTimer) clearInterval(entry.pollTimer)
    dshClients.delete(id)
  }
  dshDefaultEntry = [...dshClients.values()][0] || null
  // 没有任何会话型页面，但老配置里还有 dsh.baseUrl：保留一个隐藏的默认上游（只用于自检）
  if (!dshDefaultEntry && config.dsh.baseUrl) {
    const pseudo = normalizeConn({ id: '__default__', name: '会话型服务', kind: 'dsh', baseUrl: config.dsh.baseUrl })
    const entry = makeDshEntry(pseudo)
    dshClients.set('__default__', entry)
    dshDefaultEntry = entry
    try { await entry.client.start() } catch { /* ignore */ }
  }
  console.log('[dsh] 会话型页面：' + ([...dshClients.values()].map((x) => x.name + '(' + x.api + ' ' + (x.baseUrl || '未填地址') + ')').join('、') || '无'))
}

function dshFor(req) {
  const id = String(req.headers['x-dsh-conn'] || '').trim()
  if (id && dshClients.has(id)) return dshClients.get(id)
  return dshDefaultEntry || [...dshClients.values()][0] || null
}

function requireDsh(req) {
  const e = dshFor(req)
  if (!e) {
    const err = new Error('还没有会话型页面：先在左侧「＋ 添加」里加一个')
    err.code = 'no-dsh'
    throw err
  }
  return e
}

function publicDshEntry(entry) {
  if (!entry) return null
  const st = entry.client.status ? entry.client.status() : {}
  return {
    id: entry.id,
    name: entry.name,
    api: entry.api,
    baseUrl: entry.baseUrl,
    ...st,
    error: entry.lastError || st.error || ''
  }
}

// 从 ~/.dsh/logs 与本项目 logs 里找 "dsh web: http://...?token=..." 这类启动地址
async function dshLogUrls() {
  const urls = []
  const dirs = [path.join(os.homedir(), '.dsh', 'logs'), path.join(HOME_DIR, 'logs')]
  for (const dir of dirs) {
    let files = []
    try { files = await fs.readdir(dir) } catch { continue }
    for (const name of files.slice(-40)) {
      if (!/\.(log|txt)$/i.test(name)) continue
      const full = path.join(dir, name)
      try {
        const st = await fs.stat(full)
        if (!st.isFile() || st.size === 0) continue
        const start = Math.max(0, st.size - 256 * 1024)
        const fh = await fs.open(full, 'r')
        const buf = Buffer.alloc(Math.min(st.size, 256 * 1024))
        await fh.read(buf, 0, buf.length, start)
        await fh.close()
        const text = buf.toString('utf8')
        const re = /dsh web:\s*(https?:\/\/[^\s"'<>]+)/g
        let m
        while ((m = re.exec(text))) urls.push(m[1])
      } catch { /* 下一个 */ }
    }
  }
  return urls.slice(-12)
}

function dshBaseCandidates() {
  const out = []
  const seen = new Set()
  const add = (u) => {
    const v = normalizeBaseUrl(u)
    if (!v || seen.has(v)) return
    try { new URL(v) } catch { return }
    seen.add(v)
    out.push(v)
  }
  if (process.env.DSH_WEB_URL) add(process.env.DSH_WEB_URL)
  if (config.dsh.baseUrl) add(config.dsh.baseUrl)
  for (const p of [3080]) add('http://127.0.0.1:' + p)
  return out
}

async function probeDshHttp(base) {
  // 1) 0.1.x：POST /api/session.list
  try {
    const body = { type: 'client-request', rpcId: crypto.randomUUID(), method: 'session.list', payload: {} }
    const r = await fetch(base + '/api/session.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500)
    })
    if (r.ok) {
      const j = await r.json().catch(() => null)
      if (j && j.result && j.result.ok === true) return { api: 'legacy', needAuth: false }
      return { api: 'legacy', needAuth: false }
    }
  } catch { /* 继续 */ }
  // 2) 0.2.x：根路径会 401 并要求认证
  try {
    const r = await fetch(base + '/', { redirect: 'manual', signal: AbortSignal.timeout(2500) })
    if (r.status === 401) {
      const text = await r.text().catch(() => '')
      if (/authentication required|dsh web/i.test(text)) return { api: 'dsh2', needAuth: true }
    }
    if (r.status === 200) {
      // 可能是 0.2.x 且已经有 Cookie（本机默认会话），也可能只是别的服务
      const body = { type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: {} } }
      const r2 = await fetch(base + '/api/session/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2500)
      })
      if (r2.status === 401 || r2.status === 403) return { api: 'dsh2', needAuth: true }
      if (r2.ok) return { api: 'dsh2', needAuth: false }
    }
  } catch { /* 继续 */ }
  return null
}

// 桌面软件每次启动都会换端口 + 换令牌；如果连接勾了「自动跟随日志」，
// 后台每 20 秒看一次日志，发现新的可用地址就自动换过来。
let localDesktopBusy = false
async function syncLocalDesktop() {
  if (localDesktopBusy) return
  const all = getConnections()
  const autos = all.filter((c) => c.kind === 'dsh' && c.localAuth)
  if (!autos.length) return
  localDesktopBusy = true
  try {
    for (const cand of findDesktopDshPorts()) {
      const cookie = localAuthCookie(cand.baseUrl)
      if (!cookie) continue
      const probe = createDsh2Client({ baseUrl: cand.baseUrl, cookie })
      const ok = await probe.test()
      if (!ok.ok) continue
      let changed = false
      for (const auto of autos) {
        const c = all.find((x) => x.id === auto.id)
        if (!c) continue
        if (c.baseUrl === cand.baseUrl && (c.api === 'dsh2')) continue
        c.baseUrl = cand.baseUrl
        c.api = 'dsh2'
        c.cookie = ''
        changed = true
      }
      if (changed) {
        await saveConnections(all)
        await rebuildDshClients()
        console.log('[dsh] 已跟随本机桌面软件端口：' + cand.baseUrl)
      }
      return
    }
  } catch { /* 下一轮 */ } finally {
    localDesktopBusy = false
  }
}

let desktopSyncBusy = false
async function syncDesktopFromLogs() {
  if (desktopSyncBusy) return
  const all = getConnections()
  // localAuth 的连接由 syncLocalDesktop 按端口跟随，不需要日志里的令牌
  const autos = all.filter((c) => c.kind === 'dsh' && c.autoDesktop && !c.localAuth)
  if (!autos.length) return
  desktopSyncBusy = true
  try {
    const urls = (await dshLogUrls()).reverse()
    for (const raw of urls) {
      let u
      try { u = new URL(raw) } catch { continue }
      const token = u.searchParams.get('token') || ''
      if (!token) continue
      const probe = createDsh2Client({ baseUrl: u.origin, token })
      const ok = await probe.test()
      if (!ok.ok) continue
      let changed = false
      for (const auto of autos) {
        const c = all.find((x) => x.id === auto.id)
        if (!c) continue
        if (c.baseUrl === u.origin && c.token === token) continue
        c.baseUrl = u.origin
        c.token = token
        c.cookie = ''
        c.api = 'dsh2'
        changed = true
      }
      if (!changed) return
      await saveConnections(all)
      await rebuildDshClients()
      console.log('[dsh] 已从日志同步桌面软件地址/令牌：' + u.origin)
      return
    }
  } catch { /* 下一轮 */ } finally {
    desktopSyncBusy = false
  }
}

async function discoverLocalDsh() {
  // 1) 桌面软件正在跑：从进程端口 + 本机 browser-session secret 直接签 Cookie
  for (const cand of findDesktopDshPorts()) {
    const cookie = localAuthCookie(cand.baseUrl)
    if (cookie) {
      const c = createDsh2Client({ baseUrl: cand.baseUrl, cookie })
      const r = await c.test()
      if (r.ok) {
        return {
          found: true,
          baseUrl: cand.baseUrl,
          api: 'dsh2',
          localAuth: true,
          detail: '找到本机 DSH 桌面软件，已用本机凭据自动登录（不用重启、不用令牌）'
        }
      }
    }
    const p = await probeDshHttp(cand.baseUrl)
    if (p) {
      return { found: true, baseUrl: cand.baseUrl, token: '', api: p.api, needAuth: p.needAuth, localAuth: !!cookie, detail: '找到本机 DSH 桌面软件' }
    }
  }

  const logs = (await dshLogUrls()).reverse()
  // 2) 日志里的带令牌地址（桌面软件 / dsh web 启动时打印的）
  for (const raw of logs) {
    let u
    try { u = new URL(raw) } catch { continue }
    const token = u.searchParams.get('token') || ''
    const base = u.origin
    if (token) {
      const c = createDsh2Client({ baseUrl: base, token })
      const r = await c.test()
      if (r.ok) return { found: true, baseUrl: base, token, api: 'dsh2', detail: '从日志里找到带令牌的启动地址' }
    }
    const p = await probeDshHttp(base)
    if (p) return { found: true, baseUrl: base, token: token || '', api: p.api, needAuth: p.needAuth, detail: '从日志里找到启动地址' }
  }
  // 再试常见端口
  for (const base of dshBaseCandidates()) {
    const cookie = localAuthCookie(base)
    if (cookie) {
      const c = createDsh2Client({ baseUrl: base, cookie })
      const r = await c.test()
      if (r.ok) return { found: true, baseUrl: base, api: 'dsh2', localAuth: true, detail: '在本机端口上用凭据自动登录 DSH' }
    }
    const p = await probeDshHttp(base)
    if (!p) continue
    return { found: true, baseUrl: base, token: '', api: p.api, needAuth: p.needAuth, detail: '在本机端口上探测到 DSH' }
  }
  return {
    found: false,
    detail: '没找到。确认 DSH 正在运行；本机桌面软件直接点检测即可（会用本机凭据自动登录），远程部署请填地址与令牌。'
  }
}

// ---------------------------------------------------------------------------
// 对话数据备份
//   需求：对话数据要有完整备份；备份能在网页设置里改；备份属于「限制项」，
//   额外一层只有服务部署端才知道的密码（登录口令之外）。
//   · 改备份设置 / 立即备份 / 恢复：本机回环 + 部署端密码
//   · 看状态/看快照列表：登录用户即可（不含任何密钥）
//   限制：目录必须绝对路径、不能是盘根、不能落在 data/ 或 logs/ 之内；
//         间隔 1~168 小时；保留 1~200 份；备份目录只在快照轮转时清自己产出的目录。
// ---------------------------------------------------------------------------
const BACKUP_DIR_DEFAULT = path.join(HOME_DIR, 'backups')
const DEPLOYER_MIN_LEN = 8

function backupCfg() {
  const b = config.backup || {}
  return {
    enabled: b.enabled !== false,
    intervalHours: Math.min(168, Math.max(1, parseInt(b.intervalHours, 10) || 6)),
    keep: Math.min(200, Math.max(1, parseInt(b.keep, 10) || 30)),
    dir: String(b.dir || '').trim() || BACKUP_DIR_DEFAULT,
    passwordSalt: String(b.passwordSalt || ''),
    passwordHash: String(b.passwordHash || ''),
    lastRunAt: Number(b.lastRunAt) || 0
  }
}

const scryptHex = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex')

function deployerPasswordOk(pw) {
  const b = backupCfg()
  if (!b.passwordHash || !pw) return false
  try {
    const a = Buffer.from(scryptHex(pw, b.passwordSalt), 'hex')
    const t = Buffer.from(b.passwordHash, 'hex')
    return a.length === t.length && crypto.timingSafeEqual(a, t)
  } catch { return false }
}

function setDeployerPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex')
  config.backup = { ...backupCfg(), passwordSalt: salt, passwordHash: scryptHex(pw, salt) }
}

function resolveBackupDir(dir) {
  const raw = String(dir || '').trim()
  if (!raw) return BACKUP_DIR_DEFAULT
  if (!path.isAbsolute(raw)) throw new Error('备份目录要写绝对路径')
  const resolved = path.resolve(raw)
  if (/^[A-Za-z]:$/.test(resolved)) throw new Error('备份目录不能是盘根')
  const deny = [DATA_DIR, path.join(HOME_DIR, 'logs')].map((p) => path.resolve(p))
  for (const d of deny) {
    if (resolved === d || resolved.startsWith(d + path.sep)) throw new Error('备份目录不能放在数据/日志目录里面：' + d)
  }
  return resolved
}

async function listSnapshots() {
  const b = backupCfg()
  let dir = b.dir
  try { dir = resolveBackupDir(b.dir) } catch { /* 配置不合法就先按默认目录列出 */ }
  let ents = []
  try { ents = await fs.readdir(dir, { withFileTypes: true }) } catch { return { dir, items: [] } }
  const items = []
  for (const e of ents) {
    if (!e.isDirectory() || !/^snapshot-/.test(e.name)) continue
    const full = path.join(dir, e.name)
    let files = 0
    let bytes = 0
    const walk = async (d) => {
      for (const x of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, x.name)
        if (x.isDirectory()) await walk(p)
        else { try { const st = await fs.stat(p); files++; bytes += st.size } catch { /* skip */ } }
      }
    }
    try { await walk(full) } catch { /* skip */ }
    const at = String(e.name).replace(/^snapshot-/, '')
    items.push({ name: e.name, at, files, bytes })
  }
  items.sort((x, y) => (x.name < y.name ? 1 : -1))
  return { dir, items }
}

let backupBusy = false
let lastBackupResult = null

async function runBackup(reason = 'manual') {
  if (backupBusy) throw new Error('已经有一次备份在进行')
  backupBusy = true
  try {
    const b = backupCfg()
    const dir = resolveBackupDir(b.dir)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const dest = path.join(dir, 'snapshot-' + stamp)
    await fs.mkdir(dest, { recursive: true })
    let files = 0
    let bytes = 0
    const count = async (src) => {
      for (const x of await fs.readdir(src, { withFileTypes: true })) {
        const p = path.join(src, x.name)
        if (x.isDirectory()) await count(p)
        else { try { const st = await fs.stat(p); files++; bytes += st.size } catch { /* skip */ } }
      }
    }
    // data/（会话与连接）+ config.json（脱敏：去掉登录口令与对外 API Key 以外的都不动，但备份目录本身可能被共享，
    // 所以这里专门写一份不含口令的副本）
    if (existsSync(DATA_DIR)) {
      await fs.cp(DATA_DIR, path.join(dest, 'data'), { recursive: true })
      await count(DATA_DIR)
    }
    const safeCfg = JSON.parse(JSON.stringify(config))
    if (safeCfg.auth) { safeCfg.auth.password = '***'; safeCfg.auth.apiKey = '***' }
    if (safeCfg.backup) { safeCfg.backup.passwordHash = ''; safeCfg.backup.passwordSalt = '' }
    await fs.writeFile(path.join(dest, 'config.sanitized.json'), JSON.stringify(safeCfg, null, 2), 'utf8')
    files++
    const note = [
      '备份时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
      '触发方式：' + reason,
      '内容：data/（会话与页面连接）+ config.sanitized.json（已去掉登录口令与密钥）',
      '文件数：' + files + '，合计：' + (bytes / 1048576).toFixed(2) + ' MB'
    ].join('\r\n')
    await fs.writeFile(path.join(dest, '备份说明.txt'), note, 'utf8')
    // 轮转：只清理本目录里形如 snapshot-* 的旧快照
    const { items } = await listSnapshots()
    for (const old of items.slice(b.keep)) {
      try { await fs.rm(path.join(dir, old.name), { recursive: true, force: true }) } catch { /* skip */ }
    }
    config.backup = { ...backupCfg(), lastRunAt: Date.now() }
    await saveConfig()
    lastBackupResult = { at: Date.now(), dest, files, bytes, ok: true, reason }
    console.log('[backup] 完成 ' + dest + '（' + files + ' 个文件，' + (bytes / 1048576).toFixed(2) + ' MB）')
    return lastBackupResult
  } catch (e) {
    lastBackupResult = { at: Date.now(), ok: false, error: e.message, reason }
    console.log('[backup] 失败：' + e.message)
    throw e
  } finally {
    backupBusy = false
  }
}

// 定时检查（每 60 秒看一次是否到点），不阻塞主线程
setInterval(() => {
  const b = backupCfg()
  if (!b.enabled || backupBusy) return
  if (Date.now() - b.lastRunAt < b.intervalHours * 3600000) return
  runBackup('auto').catch(() => { /* 已记日志 */ })
}, 60000).unref()

// ---------------------------------------------------------------------------
// 外网访问自检：把"依赖什么"讲清楚，而不是只给一个填地址的框
// ---------------------------------------------------------------------------
async function netCheck() {
  const hints = []
  const lan = []
  try {
    for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) lan.push({ iface, ip: a.address })
    }
  } catch { /* ignore */ }
  const publicUrl = String((config.ui && config.ui.publicUrl) || '')
  const tunnelUrls = detectTunnelUrls()
  let dnsInfo = null
  let publicReachable = null
  if (publicUrl) {
    try {
      const u = new URL(publicUrl)
      try {
        const addrs = await dns.lookup(u.hostname, { all: true })
        dnsInfo = { ok: true, host: u.hostname, addresses: addrs.map((a) => a.address) }
      } catch (e) {
        dnsInfo = { ok: false, host: u.hostname, error: e.code === 'ENOTFOUND' ? '域名不存在（DNS 查不到）' : e.message }
      }
    } catch {
      dnsInfo = { ok: false, host: '', error: '地址格式不对' }
    }
    if (dnsInfo && dnsInfo.ok) {
      try {
        const r = await fetch(publicUrl, { method: 'HEAD', signal: AbortSignal.timeout(6000) })
        publicReachable = { ok: r.ok || r.status < 500, status: r.status }
      } catch (e) {
        publicReachable = { ok: false, error: e.name === 'TimeoutError' ? '超时（6 秒没响应）' : (e.cause && e.cause.code ? e.cause.code : e.message) }
      }
    } else {
      publicReachable = { ok: false, error: (dnsInfo && dnsInfo.error) || '域名解析失败' }
    }
  }
  const conns = getConnections()
  if (!conns.length) hints.push('还没有任何页面（连接）：先在左侧「＋ 添加」里配一个 AI 服务，否则打开也没法对话。')
  const host = String(config.host || '')
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    hints.push('当前只监听本机（' + host + '）：手机和别的电脑连不上。局域网访问就把监听地址改成 0.0.0.0；公网访问再加隧道或端口映射。改完需要重启服务。')
  }
  if (!publicUrl) hints.push('没填外网地址：填上之后启动横幅和标题会显示它，也方便自检能不能从外面打开。它本身不会"开通"外网，外网能不能打开取决于隧道/端口映射。')
  if (publicUrl && dnsInfo && !dnsInfo.ok) hints.push('外网地址的域名解析不了：' + dnsInfo.error + '。检查域名拼写，或换成隧道实际给出的域名。')
  if (tunnelUrls.length) {
    hints.push('检测到系统里已经在跑的隧道地址：' + tunnelUrls.join('、') + '。点上面的「检测到的隧道地址」可以一键填入。')
  }
  hints.push('公网访问的三种常规做法：① 同一局域网直接填 http://<本机局域网 IP>:' + config.port + '；② 隧道（tailscale funnel / cloudflared / frp / natapp）把公网域名转到本机端口；③ 有公网 IP 时做路由器端口映射 + 反向代理（建议加 HTTPS）。')
  hints.push('如果用子路径（例如 https://域名/chat/），隧道/反代要把 /chat 前缀去掉再转给本机 ' + config.port + ' 端口；否则会 404。')
  hints.push('依赖：本服务的对话依赖上游 AI 服务可用（页面配置里的 baseUrl 要能连通）；外网只影响"能不能打开这个网页"，不影响上游。')
  return {
    listening: { host, port: config.port },
    lan,
    publicUrl,
    dns: dnsInfo,
    publicReachable,
    tunnelUrls,
    connections: conns.length,
    hints
  }
}


// 每个 openai 连接一个 store（会话文件各存各的目录）
const CONN_STORE_ROOT = path.join(DATA_DIR, 'connections')
const connStores = new Map()

function getStore(conn) {
  if (!conn || conn.kind !== 'openai') return null
  let s = connStores.get(conn.id)
  if (s) return s
  s = createStore({
    convDir: path.join(CONN_STORE_ROOT, conn.id),
    // 每次取上游都重新读配置：改了地址/模型/密钥不用重启
    getUpstream: () => {
      const cur = findConn(conn.id) || conn
      return {
        baseUrl: cur.baseUrl || config.local.baseUrl,
        apiKey: cur.apiKey || config.local.apiKey || guessLocalKey(),
        model: cur.model || config.local.model || 'local',
        maxTokens: cur.maxTokens || config.local.maxTokens || 4096,
        temperature: Number.isFinite(cur.temperature) ? cur.temperature : (config.local.temperature ?? 0.7),
        systemPrompt: cur.systemPrompt || config.local.systemPrompt || '',
        historyCharBudget: cur.historyCharBudget || config.local.historyCharBudget || 24000
      }
    },
    guessKey: guessLocalKey,
    emit: (event, data) => broadcast('conn', { connId: conn.id, event, data })
  })
  s.init().catch(() => {})
  connStores.set(conn.id, s)
  return s
}

// 测试一条连接通不通（标准接口：#1 GET /models；#2 用一条最小对话验证真能生成）
async function testConnection(conn) {
  const t0 = Date.now()
  const base = String(conn.baseUrl || '').replace(/\/+$/, '')
  if (conn.kind === 'dsh') {
    if (!base) return { ok: false, ms: 0, detail: '缺地址（例如 http://127.0.0.1:3080 或桌面软件的 http://127.0.0.1:<端口>）', models: [] }
    const saved = dshClients.get(conn.id)
    if (saved && saved.sig === dshSig(conn)) {
      const r = await saved.client.test()
      return { ...r, api: saved.api, baseUrl: saved.baseUrl }
    }
    const api = guessDshApi(conn)
    let cookie = conn.cookie
    if (!cookie && conn.localAuth && isLoopbackUrl(base)) cookie = localAuthCookie(base)
    const probe = api === 'dsh2'
      ? createDsh2Client({ baseUrl: base, token: conn.token, cookie })
      : createLegacyClient(base)
    const r = await probe.test()
    if (r.ok || api === 'dsh2') return { ...r, api, baseUrl: base, localAuth: !!cookie && conn.localAuth }
    // 0.1.x 的探测失败时，再按 0.2.x 试一次：这样"换成桌面软件了"能给出明确提示
    const probe2 = createDsh2Client({ baseUrl: base, token: conn.token, cookie })
    const r2 = await probe2.test()
    if (r2.code === 'auth-required') {
      return { ...r2, api: 'dsh2', baseUrl: base, detail: '这个地址是 0.2.x / 桌面软件：需要它的访问令牌（带 token= 的地址或 Cookie）' }
    }
    return { ...r, api: 'legacy', baseUrl: base }
  }
  if (!base) return { ok: false, ms: 0, detail: '缺 baseUrl（例如 http://127.0.0.1:8080/v1）', models: [] }
  const auth = conn.apiKey ? { Authorization: 'Bearer ' + conn.apiKey } : {}
  let models = []
  try {
    const r = await fetch(base + '/models', { headers: auth, signal: AbortSignal.timeout(8000) })
    if (r.ok) {
      const j = await r.json().catch(() => null)
      if (j && Array.isArray(j.data)) models = j.data.map((d) => d && d.id).filter(Boolean)
    } else {
      return { ok: false, ms: Date.now() - t0, detail: 'GET /models 返回 HTTP ' + r.status, models: [] }
    }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: '连不上：' + e.message, models: [] }
  }
  // 再打一条最小对话，确认 /chat/completions 真的能用
  try {
    const r2 = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
      body: JSON.stringify({
        model: conn.model || (models[0] || 'local'),
        messages: [{ role: 'user', content: '只回两个字：在的' }],
        max_tokens: 16,
        temperature: 0,
        stream: false
      }),
      signal: AbortSignal.timeout(60000)
    })
    if (!r2.ok) {
      const t = await r2.text().catch(() => '')
      return { ok: false, ms: Date.now() - t0, detail: '/chat/completions 返回 HTTP ' + r2.status + (t ? '：' + t.slice(0, 160) : ''), models }
    }
    const j2 = await r2.json().catch(() => null)
    const txt = j2 && j2.choices && j2.choices[0] && j2.choices[0].message ? String(j2.choices[0].message.content || '').trim() : ''
    return { ok: true, ms: Date.now() - t0, detail: '可用，回复：「' + (txt || '(空)') + '」', models }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: '/chat/completions 失败：' + e.message, models }
  }
}


// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const now = () => new Date().toISOString()

function json(res, code, obj, extra) {
  let body = Buffer.from(JSON.stringify(obj), 'utf8')
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extra || {})
  }
  // 手机流量下 history 这种几十 KB 的 JSON 压一下很值（体积常见降到 1/6）
  if (res._gzip && body.length > 1024) {
    try {
      body = zlib.gzipSync(body, { level: 6 })
      headers['Content-Encoding'] = 'gzip'
      headers.Vary = 'Accept-Encoding'
    } catch { /* 压不动就原样发 */ }
  }
  headers['Content-Length'] = body.length
  res.writeHead(code, headers)
  res.end(body)
}

function textRes(res, code, msg) {
  const body = Buffer.from(msg, 'utf8')
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length })
  res.end(body)
}

async function readBody(req, limit = 2097152) {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------
const sessions = new Map()
const loginFails = new Map()
const COOKIE = 'mc_sid'

function issueSession(ip) {
  const token = crypto.randomBytes(24).toString('hex')
  sessions.set(token, { created: Date.now(), ip })
  return token
}

function sessionValid(token) {
  if (!token) return false
  const s = sessions.get(token)
  if (!s) return false
  if (Date.now() - s.created > config.auth.sessionDays * 86400000) { sessions.delete(token); return false }
  return true
}

function bearToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '')
  if (m) return m[1].trim()
  return req.headers['x-api-key'] ? String(req.headers['x-api-key']).trim() : ''
}

function isAuthed(req) {
  if (sessionValid(parseCookies(req.headers.cookie)[COOKIE])) return true
  const bt = bearToken(req)
  return !!(bt && config.auth.apiKey && bt === config.auth.apiKey)
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim()

// ---------------------------------------------------------------------------
// SSE 广播
// ---------------------------------------------------------------------------
const sseClients = new Set()

function broadcast(event, data) {
  if (!sseClients.size) return
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'
  for (const res of sseClients) {
    try { res.write(payload) } catch { sseClients.delete(res) }
  }
}

setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n') } catch { sseClients.delete(res) }
  }
}, 15000).unref?.()

// ---------------------------------------------------------------------------
// 会话存储（按连接分目录，见上面的 getStore/createStore）
// 2026-11-18：原来只有一个"本地模型"store，现在每个 openai 连接一个，
// 老代码里的 /api/local/* 仍然可用，统一指向"第一条 openai 连接"。
// ---------------------------------------------------------------------------
function primaryOpenAIConn() {
  return getConnections().find((c) => c.kind === 'openai') || null
}
function totalConversations() {
  let n = 0
  for (const s of connStores.values()) { try { n += s.size() } catch { /* ignore */ } }
  return n
}

// 启动时：给每条 openai 连接建好会话目录；顺手把老的 data/conversations 搬进
// data/connections/local（老版本只有一个"本地模型"，会话别丢）
async function initConnectionStores() {
  const conns = getConnections().filter((c) => c.kind === 'openai')
  await fs.mkdir(CONN_STORE_ROOT, { recursive: true }).catch(() => {})
  const legacyDir = CONV_DIR
  const legacyFiles = await fs.readdir(legacyDir).catch(() => [])
  if (legacyFiles.some((f) => f.endsWith('.json'))) {
    let localConn = conns.find((c) => c.id === 'local')
    if (!localConn) {
      localConn = normalizeConn({
        id: 'local',
        name: '本地模型',
        kind: 'openai',
        baseUrl: config.local.baseUrl,
        apiKey: config.local.apiKey,
        model: config.local.model
      })
      const list = getConnections().slice()
      list.push(localConn)
      await saveConnections(list)
      conns.push(localConn)
    }
    const dest = path.join(CONN_STORE_ROOT, 'local')
    await fs.mkdir(dest, { recursive: true }).catch(() => {})
    for (const f of legacyFiles) {
      if (!f.endsWith('.json')) continue
      try { await fs.rename(path.join(legacyDir, f), path.join(dest, f)) } catch { /* 忽略 */ }
    }
    console.log('[init] 老会话已迁移到 data/connections/local（' + legacyFiles.length + ' 个文件）')
  }
  let total = 0
  for (const c of getConnections()) {
    if (c.kind !== 'openai') continue
    const s = getStore(c)
    total += await s.init()
  }
  return total
}

// ---------------------------------------------------------------------------
// 把 DSH 的事件流转成广播
//  ---------------------------------------------------------------------------
//  两处优化（都是为了"数据传递更流畅"）：
//   1. 增量合并：模型逐字输出时 DSH 会推几百上千条 assistant/chunk，逐条转发
//      到手机上就是几百次 SSE 帧 + JSON 解析。这里按 60ms 一批合并成一条
//      （内容拼起来，语义不变），跨网帧数常见能降一个数量级。
//   2. 顺序保证：任何非增量帧（tool/call、assistant/message、turn/end…）到达前，
//      先把该会话待发的增量吐干净，避免"定稿之后又冒出半句话"。
// ---------------------------------------------------------------------------
const DELTA_FLUSH_MS = 60
const pendingDeltas = new Map()   // key -> { timer, sessionId, connId, turn, step, index, kind, text }

function deltaKind(ch) {
  if (ch.type === 'text-delta') return 'text'
  if (ch.type === 'reasoning-delta') return 'reasoning'
  return ''
}

function queueDelta(sessionId, ev, connId) {
  const d = ev.data || {}
  const ch = d.chunk || {}
  const kind = deltaKind(ch)
  if (!kind) return false
  const key = String(connId || '') + '|' + sessionId + '|' + d.turn + '|' + d.step + '|' + kind
  let p = pendingDeltas.get(key)
  if (!p) {
    p = { sessionId, connId, turn: d.turn, step: d.step, index: ch.index || 0, kind, text: '', timer: null }
    p.timer = setTimeout(() => flushDelta(key), DELTA_FLUSH_MS)
    p.timer.unref?.()
    pendingDeltas.set(key, p)
  }
  p.text += ch.text || ''
  return true
}

function flushDelta(key) {
  const p = pendingDeltas.get(key)
  if (!p) return
  pendingDeltas.delete(key)
  if (p.timer) clearTimeout(p.timer)
  if (!p.text) return
  broadcast('dsh', {
    connId: p.connId,
    channel: 'mux',
    method: 'session/event',
    payload: {
      sessionId: p.sessionId,
      batched: true,
      event: {
        type: 'assistant/chunk',
        data: {
          turn: p.turn,
          step: p.step,
          chunk: {
            type: p.kind === 'text' ? 'text-delta' : 'reasoning-delta',
            index: p.index,
            text: p.text
          }
        }
      }
    }
  })
}

function flushSessionDeltas(sessionId, connId) {
  for (const [key, p] of pendingDeltas) {
    if (p.sessionId === sessionId && (!connId || p.connId === connId)) flushDelta(key)
  }
}

// 折叠结果缓存：切回同一个对话时不用把几千条事件重新折一遍
const historyCache = new Map()   // key -> { at, sid, data }
const HISTORY_TTL = 20000

function cacheHistory(key, sid, data) {
  historyCache.set(key, { at: Date.now(), sid, data })
  if (historyCache.size > 40) {
    // 简单淘汰：删最老的几条
    const arr = [...historyCache.entries()].sort((a, b) => a[1].at - b[1].at)
    for (let i = 0; i < 10; i++) historyCache.delete(arr[i][0])
  }
}

function invalidateHistory(sid) {
  for (const [k, v] of historyCache) if (v.sid === sid) historyCache.delete(k)
}

// 会话列表缓存：每个会话型页面一份（100+ 个会话的 list 每次都要走一遍 DSH）
const LIST_TTL = 2500

// 组装给前端的会话视图：过滤已归档、挂上所属工作区
async function buildSessionPayload(entry) {
  if (!entry || !entry.baseUrl) {
    return { sessions: [], workspaces: [], archivedCount: 0, dsh: entry ? entry.client.status() : null, error: '这条页面还没填地址' }
  }
  const [list, reg] = await Promise.all([entry.client.listSessions({}), entry.client.workspaceRegistry()])
  const archived = new Set(reg.archivedSessionIds || [])
  const wsByPath = new Map()
  for (const w of reg.items) {
    if (w && w.path) wsByPath.set(String(w.path).toLowerCase(), w)
  }
  const sessions = []
  for (const s of list) {
    if (archived.has(s.id)) continue            // 已归档的一律不显示
    const w = s.cwd ? wsByPath.get(String(s.cwd).toLowerCase()) : null
    sessions.push({
      ...s,
      workspaceId: w ? w.workspaceId : '',
      workspacePath: w ? w.path : (s.cwd || '')
    })
  }
  const workspaces = reg.items.map((w) => ({
    id: w.workspaceId,
    path: w.path,
    title: w.title || (w.path ? String(w.path).split(/[\\/]/).pop() : '工作区'),
    sessionCount: (w.sessionIds || []).filter((id) => !archived.has(id)).length
  }))
  return {
    sessions,
    workspaces,
    archivedCount: archived.size,
    connId: entry.id,
    dsh: entry.client.status()
  }
}

// 预热：让"打开页面 / 登录后立刻要列表"这个动作不用等上游
async function warmSessions(entry) {
  if (!entry || entry.listWarming) return
  entry.listWarming = true
  try {
    const data = await buildSessionPayload(entry)
    entry.listCache = { at: Date.now(), data }
  } catch { /* 上游没起来就算了，等下次请求再试 */ } finally {
    entry.listWarming = false
  }
}

// 后台刷新（绝不阻塞请求）
function kickWarm(entry) {
  if (!entry || entry.listWarming) return
  warmSessions(entry)
}

// 新连接进来时告诉它"哪些会话正在生成"，省得它自己去比对
function runningSessions(entry) {
  if (!entry || !entry.listCache.data) return []
  return (entry.listCache.data.sessions || []).filter((s) => s.running).map((s) => s.id)
}

// 0.1.x 的事件流 → 每个页面各自广播（带 connId，前端按当前页面过滤）
function handleDshFrame(entry, frame) {
  const payload = frame.payload || {}
  const sid = payload.sessionId

  // 增量帧先入队，等下一批一次性发
  if (frame.method === 'session/event' && payload.event && payload.event.type === 'assistant/chunk') {
    if (queueDelta(sid, payload.event, entry.id)) return
  }

  // 其它帧：保证顺序（先吐完这个会话的增量），并让缓存失效
  if (sid) {
    flushSessionDeltas(sid, entry.id)
    const t = payload.event && payload.event.type
    if (t !== 'assistant/chunk') invalidateHistory(sid)
  }
  switch (frame.method) {
    case 'host/session-added':
    case 'host/session-removed':
    case 'host/session-status':
    case 'host/archived-sessions-changed':
    case 'session/title':
      entry.listCache = { at: 0, data: null }
      if (frame.method === 'host/archived-sessions-changed') {
        broadcast('dsh-sync', { connId: entry.id, archivedCount: (payload.archivedSessionIds || []).length, at: now() })
      }
      break
    default:
      break
  }

  broadcast('dsh', {
    connId: entry.id,
    channel: frame.channel,
    method: frame.method,
    payload: frame.payload,
    rpcId: frame.rpcId
  })
}

// 本地模型/引擎状态：绝不阻塞登录，用缓存 + 后台刷新
let localStatus = { at: 0, online: null, models: [], error: '', busy: false }
const LOCAL_STATUS_TTL = 20000

function buildMe() {
  if (config.local.enabled) kickLocalStatus()
  const fresh = !!localStatus.at && Date.now() - localStatus.at < LOCAL_STATUS_TTL
  const conns = getConnections().map(publicConn)
  const primary = dshDefaultEntry || [...dshClients.values()][0] || null
  const dshById = {}
  for (const e of dshClients.values()) dshById[e.id] = publicDshEntry(e)
  return {
    appName: config.ui.appName,
    build: shellCache.build || '',
    dsh: { baseUrl: primary ? primary.baseUrl : config.dsh.baseUrl, ...(primary ? primary.client.status() : {}), defaultCwd: config.dsh.defaultCwd },
    dshById,
    connections: conns,                       // 界面上那些"页面"
    presets: connectionPresets(),             // 添加连接时可以一键填的预设
    local: {
      enabled: config.local.enabled,
      baseUrl: config.local.baseUrl,
      model: config.local.model,
      maxTokens: config.local.maxTokens,
      temperature: config.local.temperature,
      online: localStatus.online,          // null = 还没测过
      models: localStatus.models,
      error: localStatus.error,
      fresh
    },
    sessionCount: totalConversations(),
    now: now()
  }
}

// 把子进程输出按 GBK 解成字符串（中文 Windows 的 schtasks/powershell 输出是 GBK）
function buf2str(b) {
  if (!b) return ''
  try { return new TextDecoder('gbk').decode(b) } catch { return String(b) }
}

// 是不是本机直连（隧道/反代过来的会带 x-forwarded-for，一律当远程）
function isLoopback(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').trim()
  if (xff) return false
  const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '')
  return ip === '127.0.0.1' || ip === '::1' || ip === ''
}

// 解析 Tailscale Funnel 当前映射：找出真正指向本服务端口的外网 URL。
// 输出形如：
//   https://<machine>.<tailnet>.ts.net (Funnel on)
//   |-- /chat proxy http://127.0.0.1:8100
function detectTunnelUrls() {
  const urls = []
  const push = (base, p) => {
    if (!base || !p) return
    const path = p === '/' ? '/' : '/' + p.replace(/^\/+|\/+$/g, '') + '/'
    const u = base.replace(/\/+$/, '') + path
    if (!urls.includes(u)) urls.push(u)
  }
  try {
    const out = execFileSync('tailscale', ['funnel', 'status'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    let base = ''
    for (const line of String(out).split(/\r?\n/)) {
      const b = /^\s*(https?:\/\/\S+)\s+\(Funnel on\)/i.exec(line)
      if (b) { base = b[1]; continue }
      const m = /^\s*\|--\s+(\S+)\s+proxy\s+https?:\/\/127\.0\.0\.1:(\d+)/i.exec(line)
      if (m && Number(m[2]) === Number(config.port)) push(base, m[1])
    }
  } catch { /* 没装/没开 */ }
  return urls
}

// 外网访问：只检测系统里有没有现成的隧道工具，绝不替用户执行（安全 + 可预期）
function tunnelStatus() {
  const which = (name) => {
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore', timeout: 4000, windowsHide: true })
      return true
    } catch { return false }
  }
  return {
    publicUrl: (config.ui && config.ui.publicUrl) || '',
    tailscale: which('tailscale'),
    cloudflared: which('cloudflared'),
    urls: detectTunnelUrls(),
    hint: '公网访问要自己准备隧道：Tailscale Funnel（tailscale funnel --bg --set-path /chat http://127.0.0.1:<端口>）或 Cloudflare Tunnel，然后在「设置 → 外网访问」里填地址。这个地址只用于显示/自检，不会自己开通外网。'
  }
}
// 开机自启状态（Windows 计划任务 DSH-YCFW）
function autostartStatus() {
  const out = {
    supported: process.platform === 'win32',
    installed: false,
    running: false,
    taskName: 'DSH-YCFW',
    npmCmd: 'npm start'
  }
  if (!out.supported) return out
  // 退出码 0 就说明任务存在（中文系统 schtasks 的输出是 GBK，别用正则匹配英文标签）
  try {
    execSync('schtasks /query /tn "' + out.taskName + '"', { stdio: 'ignore', timeout: 5000, windowsHide: true })
    out.installed = true
  } catch { out.installed = false }
  if (out.installed) {
    try {
      const buf = execSync('schtasks /query /tn "' + out.taskName + '" /fo LIST', { timeout: 5000, windowsHide: true })
      const txt = new TextDecoder('gbk').decode(buf)
      out.running = /Running|正在运行/i.test(txt)
    } catch { /* 读不到就当没在跑 */ }
  }
  return out
}
// 添加连接时能一键填的预设：全是通用地址，不含任何个人配置。
// （运行时 config.json 里的 local.baseUrl 只作为"本机 llama.cpp"这一条的默认值，可改）
function connectionPresets() {
  return [
    {
      key: 'llamacpp',
      name: '本机 llama.cpp',
      kind: 'openai',
      baseUrl: config.local.baseUrl || 'http://127.0.0.1:8080/v1',
      model: config.local.model || '',
      apiKey: '',
      note: 'llama-server 的 OpenAI 兼容接口（默认 8080）'
    },
    {
      key: 'ollama',
      name: 'Ollama',
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: '',
      apiKey: '',
      note: 'Ollama 自带 OpenAI 兼容层，模型名填 ollama list 里看到的'
    },
    {
      key: 'lmstudio',
      name: 'LM Studio',
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: '',
      apiKey: '',
      note: 'LM Studio 本机服务，默认 1234'
    },
    {
      key: 'openai',
      name: 'OpenAI',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: '',
      note: '云端，需要填你自己的 API Key'
    },
    {
      key: 'deepseek',
      name: 'DeepSeek',
      kind: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: '',
      note: '云端，需要填你自己的 API Key'
    },
    {
      key: 'dsh',
      name: '会话型服务（0.1.x）',
      kind: 'dsh',
      baseUrl: 'http://127.0.0.1:3080',
      model: '',
      apiKey: '',
      note: '0.1.x 网页版，不需要令牌'
    },
    {
      key: 'dsh2',
      name: 'DSH 桌面软件（0.2.x）',
      kind: 'dsh',
      baseUrl: '',
      api: 'dsh2',
      model: '',
      apiKey: '',
      note: '桌面软件：先点「检测本机 DSH」'
    }
  ]
}

function kickLocalStatus() {
  if (localStatus.busy) return
  if (Date.now() - localStatus.at < LOCAL_STATUS_TTL) return
  const conn = primaryOpenAIConn()
  if (!conn) { localStatus = { at: Date.now(), online: false, models: [], error: '还没有添加 openai 类型的连接', busy: false }; return }
  const s = getStore(conn)
  if (!s) return
  localStatus.busy = true
  s.fetchModels().then((r) => {
    localStatus = {
      at: Date.now(),
      online: !r.error,
      models: r.models || [],
      error: r.error || '',
      busy: false
    }
  }).catch((e) => {
    localStatus = { at: Date.now(), online: false, models: [], error: e.message, busy: false }
  })
}

// 事件流按页面各自订阅（见 makeDshEntry / handleDshFrame）。
// 这里只负责把"状态变化"推给前端，前端据此点灯。
const lastHubStates = new Map()
setInterval(() => {
  let changed = false
  for (const entry of dshClients.values()) {
    const st = entry.client.status ? entry.client.status() : {}
    const sig = [st.kind, st.mux, st.host, st.reachable, entry.lastError].join('|')
    if (sig !== lastHubStates.get(entry.id)) {
      lastHubStates.set(entry.id, sig)
      changed = true
      broadcast('hub', { connId: entry.id, dsh: publicDshEntry(entry), at: now() })
    }
  }
  // 每个页面各自一条 hub 帧；不再额外发一条"全局"的，避免把当前页面的状态覆盖掉
}, 4000).unref?.()

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
}

// ---------------------------------------------------------------------------
// 单请求外壳：把 style.css / app.js 内联进 index.html，
// 并且在登录状态下把首屏数据（me / 会话列表 / 工作区）直接嵌进页面。
// 效果：打开页面 = 1 个请求就画出完整首屏（手机上少一个往返都很明显）。
// ---------------------------------------------------------------------------
const BOOT_HOOK = '<!--MC_BOOT-->'
let shellCache = { sig: '', plain: '', build: '' }

async function statSig() {
  const files = ['index.html', 'style.css', 'app.js']
  const parts = []
  let newest = 0
  for (const f of files) {
    const st = await fs.stat(path.join(PUBLIC_DIR, f))
    parts.push(f + ':' + st.size + ':' + Math.round(st.mtimeMs))
    newest = Math.max(newest, st.mtimeMs)
  }
  return { sig: parts.join('|'), newest }
}

async function shellHtml(boot) {
  const { sig, newest } = await statSig()
  if (shellCache.sig !== sig) {
    const [html, css, js] = await Promise.all([
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8'),
      fs.readFile(path.join(PUBLIC_DIR, 'style.css'), 'utf8'),
      fs.readFile(path.join(PUBLIC_DIR, 'app.js'), 'utf8')
    ])
    const safeJs = js.replace(/<\/script/gi, '<\\/script')
    const out = html
      .replace('<link rel="stylesheet" href="./style.css">', '<style>\n' + css + '\n</style>')
      .replace('<script src="./app.js"></script>', BOOT_HOOK + '\n<script>\n' + safeJs + '\n</script>')
    const d = new Date(newest)
    const pad = (n) => String(n).padStart(2, '0')
    const build = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes())
    shellCache = { sig, plain: out, build }
  }
  if (!boot) return shellCache.plain.replace(BOOT_HOOK, '')
  const json = JSON.stringify({ ...boot, build: shellCache.build }).replace(/</g, '\\u003c')
  return shellCache.plain.replace(BOOT_HOOK, '<script>window.__MC_BOOT__=' + json + ';</script>')
}

// 静态资源：文本类走 gzip + ETag/304（手机上打开页面快很多），图片走长缓存
const TEXT_EXT = ['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt']

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath)
  if (rel === '/' || rel === '') rel = '/index.html'
  const full = path.normalize(path.join(PUBLIC_DIR, rel))
  if (!full.startsWith(PUBLIC_DIR)) return textRes(res, 403, 'forbidden')
  let stat, data
  try {
    stat = await fs.stat(full)
    if (!stat.isFile()) return textRes(res, 404, 'not found')
  } catch {
    return textRes(res, 404, 'not found')
  }
  const ext = path.extname(full).toLowerCase()
  const etag = 'W/"' + stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16) + '"'

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
    return res.end()
  }

  try { data = await fs.readFile(full) } catch { return textRes(res, 404, 'not found') }

  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff'
  }
  const isImg = ['.png', '.ico'].includes(ext)
  if (isImg) {
    headers['Cache-Control'] = 'public, max-age=604800'
  } else {
    // 每次都校验（改了立刻生效），但命中 304 时几乎不花流量
    headers['Cache-Control'] = 'no-cache'
  }

  if (TEXT_EXT.includes(ext) && res._gzip && data.length > 1024) {
    try {
      data = zlib.gzipSync(data, { level: 6 })
      headers['Content-Encoding'] = 'gzip'
      headers.Vary = 'Accept-Encoding'
    } catch { /* 压不动就算了 */ }
  }
  headers['Content-Length'] = data.length
  res.writeHead(200, headers)
  res.end(data)
}

// 打开页面：单请求返回内联外壳（登录时带首屏数据）
async function serveShell(req, res) {
  let boot = null
  try {
    if (isAuthed(req)) {
      const entry = dshDefaultEntry || [...dshClients.values()][0] || null
      if (entry && !entry.listCache.data) await warmSessions(entry)
      const c = (entry && entry.listCache.data) || { sessions: [], workspaces: [], archivedCount: 0 }
      boot = {
        me: buildMe(),
        connId: entry ? entry.id : '',
        sessions: c.sessions || [],
        workspaces: c.workspaces || [],
        archivedCount: c.archivedCount || 0
      }
    }
  } catch { boot = null }

  let body = Buffer.from(await shellHtml(boot), 'utf8')
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',       // 里面可能有会话标题，不进任何共享缓存
    'X-Content-Type-Options': 'nosniff'
  }
  if (res._gzip && body.length > 1024) {
    try {
      body = zlib.gzipSync(body, { level: 6 })
      headers['Content-Encoding'] = 'gzip'
      headers.Vary = 'Accept-Encoding'
    } catch { /* ignore */ }
  }
  headers['Content-Length'] = body.length
  res.writeHead(200, headers)
  res.end(body)
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const DSH_SESSION = /^\/api\/dsh\/sessions\/([A-Za-z0-9_.:-]+)(?:\/(history|prompt|cancel|rename|archive|unarchive))?$/
const LOCAL_CONV = /^\/api\/local\/conversations\/([A-Za-z0-9_-]+)$/

async function handleApi(req, res, p, url) {
  // ---- 登录 / 登出 ----
  if (p === '/api/login' && req.method === 'POST') {
    const rec = loginFails.get(clientIp(req))
    if (rec && rec.until > Date.now()) {
      return json(res, 429, { error: '失败次数过多，请 ' + Math.ceil((rec.until - Date.now()) / 60000) + ' 分钟后再试' })
    }
    let body
    try { body = await readBody(req, 4096) } catch { return json(res, 400, { error: '请求格式错误' }) }
    if (!body.password || body.password !== config.auth.password) {
      const n = ((rec && rec.count) || 0) + 1
      loginFails.set(clientIp(req), { count: n >= 5 ? 0 : n, until: n >= 5 ? Date.now() + 15 * 60000 : 0 })
      return json(res, 401, { error: n >= 5 ? '连续失败 5 次，锁定 15 分钟' : '口令不对' })
    }
    loginFails.delete(clientIp(req))
    const token = issueSession(clientIp(req))
    return json(res, 200, { ok: true }, {
      'Set-Cookie': COOKIE + '=' + token + '; Path=/; Max-Age=' + (config.auth.sessionDays * 86400) + '; HttpOnly; SameSite=Lax'
    })
  }

  if (p === '/api/logout' && req.method === 'POST') {
    const t = parseCookies(req.headers.cookie)[COOKIE]
    if (t) sessions.delete(t)
    return json(res, 200, { ok: true }, { 'Set-Cookie': COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' })
  }

  // 健康检查：不需要登录（守护脚本/监控探活用），只暴露连接状态，不含任何内容
  if (p === '/api/health' && req.method === 'GET') {
    const st = dshDefaultEntry ? publicDshEntry(dshDefaultEntry) : null
    return json(res, 200, { ok: true, dsh: st, at: now() })
  }

  // 自己关机：给本机的 停止.ps1 / 守护.ps1 用（2026-11-18 整理时加的）。
  // 为什么不直接 taskkill：实测由计划任务拉起时，任务管理器式的杀进程会被拒（Access denied），
  // 而进程自己退出最干净、也不会留下半截 SSE 连接。
  // 安全：只认本机回环 + 必须带 config.json 里的 auth.apiKey，公网/局域网来的直接 403。
  if (p === '/api/shutdown' && req.method === 'POST') {
    const ip = clientIp(req)
    const loopback = (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '')
    const key = String(req.headers['x-api-key'] || '')
    if (!loopback || !config.auth.apiKey || key !== config.auth.apiKey) {
      return json(res, 403, { error: 'forbidden' })
    }
    json(res, 200, { ok: true, bye: true })
    // 给响应留一点时间发出去，再退出
    setTimeout(() => { console.log('[shutdown] 收到本机停止请求，退出'); process.exit(0) }, 200)
    return
  }

  if (!isAuthed(req)) return json(res, 401, { error: '未登录' })

  // ---- 总体状态 ----
  // 关键：这里绝不能再等上游（模型引擎/DSH 状态）——登录慢就是慢在这一步。
  // 现在只读缓存 + 触发后台刷新，响应是纯内存操作。
  if (p === '/api/me' && req.method === 'GET') {
    return json(res, 200, buildMe())
  }

  // ---- SSE 事件流 ----
  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    // retry 让浏览器断线后 2 秒就回来（默认可能更慢）
    res.write('retry: 2000\n\n')
    res.write('event: hello\ndata: ' + JSON.stringify({
      at: now(),
      dsh: dshDefaultEntry ? publicDshEntry(dshDefaultEntry) : null,
      dshById: Object.fromEntries([...dshClients.values()].map((e) => [e.id, publicDshEntry(e)])),
      running: [...runningSessions(dshDefaultEntry)]
    }) + '\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  // =========================== DSH 模式（每个页面各自一个上游） ===========================
  // 自动找本机 DSH：常见端口 + 日志里 "dsh web: http://...?token=..." 的启动地址。
  // 桌面软件会打印这条日志（如果用带日志的启动器），找到后就能自动填地址和令牌。
  if (p === '/api/dsh/discover' && req.method === 'GET') {
    // 只在部署端本机可用：会读本机 DSH 凭据 / 日志里的令牌，不能给远程登录用户
    if (!isLoopback(req)) return json(res, 403, { error: '检测本机 DSH 只能在部署端本机操作' })
    const found = await discoverLocalDsh()
    return json(res, 200, found)
  }

  if (p === '/api/dsh/archived' && req.method === 'GET') {
    let dc
    try { dc = requireDsh(req) } catch (e) { return json(res, 400, { error: humanizeError(e) }) }
    try {
      const [list, reg] = await Promise.all([
        dc.client.listSessions({ includeBlank: true, includeSubagents: true }),
        dc.client.workspaceRegistry()
      ])
      const arch = new Set(reg.archivedSessionIds || [])
      return json(res, 200, {
        sessions: list.filter((s) => arch.has(s.id)),
        archivedCount: arch.size,
        connId: dc.id
      })
    } catch (e) {
      return json(res, 502, { error: humanizeError(e), detail: e.message })
    }
  }

  if (p === '/api/dsh/sessions' && req.method === 'GET') {
    // stale-while-revalidate：有缓存就立刻返回（哪怕已过期），后台再刷新。
    let dc
    try { dc = requireDsh(req) } catch (e) { return json(res, 400, { error: humanizeError(e) }) }
    if (dc.listCache.data) {
      if (Date.now() - dc.listCache.at > LIST_TTL) kickWarm(dc)
      return json(res, 200, { ...dc.listCache.data, cached: true, age: Date.now() - dc.listCache.at })
    }
    try {
      const data = await buildSessionPayload(dc)
      dc.listCache = { at: Date.now(), data }
      return json(res, 200, data)
    } catch (e) {
      return json(res, 502, { error: humanizeError(e), detail: e.message })
    }
  }

  if (p === '/api/dsh/sessions' && req.method === 'POST') {
    let dc
    try { dc = requireDsh(req) } catch (e) { return json(res, 400, { error: humanizeError(e) }) }
    let body = {}
    try { body = await readBody(req, 16384) } catch { /* 空体可以 */ }
    try {
      let cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
      if (cwd) {
        if (!path.isAbsolute(cwd)) return json(res, 400, { error: '工作目录要写绝对路径' })
        if (!existsSync(cwd)) {
          if (body.createDir) await fs.mkdir(cwd, { recursive: true })
          else return json(res, 400, { error: '目录不存在：' + cwd })
        }
      } else {
        cwd = config.dsh.defaultCwd
      }
      const v = await dc.client.createSession({ cwd, agentPreset: body.agentPreset || config.dsh.newSessionPreset || undefined })
      return json(res, 200, { ok: true, sessionId: v.sessionId, cwd })
    } catch (e) {
      return json(res, 502, { error: humanizeError(e), detail: e.message })
    }
  }

  if (p === '/api/dsh/workspaces' && req.method === 'GET') {
    let dc
    try { dc = requireDsh(req) } catch (e) { return json(res, 400, { error: humanizeError(e) }) }
    try {
      const ws = await dc.client.listWorkspaces()
      return json(res, 200, { workspaces: ws, defaultCwd: config.dsh.defaultCwd })
    } catch (e) {
      return json(res, 200, { workspaces: [], defaultCwd: config.dsh.defaultCwd, error: e.message })
    }
  }

  const m = DSH_SESSION.exec(p)
  if (m) {
    let dc
    try { dc = requireDsh(req) } catch (e) { return json(res, 400, { error: humanizeError(e) }) }
    const sessionId = m[1]
    const action = m[2] || ''
    const afterChange = () => {
      invalidateHistory(sessionId)
      dc.listCache = { at: 0, data: null }
      broadcast('dsh-sync', { connId: dc.id, at: now() })
    }

    // 删除 = 归档（DSH 没有删除会话的接口；0.1.x 连取消归档都没有）
    if (!action && req.method === 'DELETE') {
      try {
        const v = await dc.client.archiveSession(sessionId, { stopActivity: true })
        afterChange()
        return json(res, 200, {
          ok: true,
          archived: true,
          archivedSessionIds: v && v.archivedSessionIds,
          note: '会话型服务只支持归档：从列表隐藏，日志保留'
        })
      } catch (e) {
        return json(res, 502, { error: humanizeError(e), code: e.code })
      }
    }

    if (!action && req.method === 'GET') {
      try {
        const list = await dc.client.listSessions({ includeBlank: true, includeSubagents: true })
        const one = list.find((s) => s.id === sessionId)
        return json(res, 200, { session: one || null })
      } catch (e) {
        return json(res, 502, { error: humanizeError(e) })
      }
    }

    if (action === 'archive' && req.method === 'POST') {
      let body = {}
      try { body = await readBody(req, 16384) } catch { /* 空体 */ }
      try {
        const v = await dc.client.archiveSession(sessionId, { stopActivity: !!body.stopActivity })
        afterChange()
        return json(res, 200, { ok: true, archivedSessionIds: v && v.archivedSessionIds })
      } catch (e) {
        return json(res, 502, { error: humanizeError(e), code: e.code, detail: e.details })
      }
    }

    if (action === 'unarchive' && req.method === 'POST') {
      try {
        const v = await dc.client.unarchiveSession(sessionId)
        afterChange()
        return json(res, 200, { ok: true, archivedSessionIds: v && v.archivedSessionIds })
      } catch (e) {
        return json(res, e.code === 'unsupported' ? 501 : 502, { error: humanizeError(e), code: e.code })
      }
    }

    if (action === 'history' && req.method === 'GET') {
      const beforeSeq = url.searchParams.get('beforeSeq')
      const maxMessages = Math.max(1, Math.min(200, parseInt(url.searchParams.get('maxMessages') || '30', 10) || 30))
      const ck = dc.id + '|' + sessionId + '|' + (beforeSeq || '') + '|' + maxMessages
      const hit = historyCache.get(ck)
      if (hit) {
        if (Date.now() - hit.at < HISTORY_TTL) {
          return json(res, 200, { ...hit.data, cached: true })
        }
        // 过期了也先给旧的（切换对话不用等），刷新走下次
        return json(res, 200, { ...hit.data, cached: true, stale: true })
      }
      try {
        const v = await dc.client.history(sessionId, {
          beforeSeq: beforeSeq ? Number(beforeSeq) : undefined,
          maxMessages
        })
        const folded = foldHistory(v.events || [])
        const data = {
          sessionId,
          items: folded.items,
          title: folded.title,
          hasMore: !!v.hasMore,
          firstSeq: folded.firstSeq,
          lastSeq: folded.lastSeq
        }
        cacheHistory(ck, sessionId, data)
        return json(res, 200, data)
      } catch (e) {
        if (hit) return json(res, 200, { ...hit.data, stale: true })
        return json(res, 502, { error: humanizeError(e), detail: e.message })
      }
    }

    if (action === 'prompt' && req.method === 'POST') {
      let body
      try { body = await readBody(req, 262144) } catch (e) { return json(res, 400, { error: e.message }) }
      const txt = String(body.text || '').trim()
      if (!txt) return json(res, 400, { error: '不能发送空消息' })
      try {
        const v = await dc.client.prompt(sessionId, txt, {
          mode: body.mode === 'steer' ? 'steer' : 'queue',
          clientTimeZone: body.clientTimeZone
        })
        invalidateHistory(sessionId)
        dc.listCache = { at: 0, data: null }
        return json(res, 200, { ok: true, command: v?.command || null })
      } catch (e) {
        return json(res, 502, { error: humanizeError(e), code: e.code, detail: e.message })
      }
    }

    if (action === 'cancel' && req.method === 'POST') {
      try {
        await dc.client.cancel(sessionId)
        return json(res, 200, { ok: true })
      } catch (e) {
        return json(res, 502, { error: humanizeError(e) })
      }
    }

    if (action === 'rename' && req.method === 'POST') {
      let body
      try { body = await readBody(req, 16384) } catch (e) { return json(res, 400, { error: e.message }) }
      try {
        const v = await dc.client.renameSession(sessionId, String(body.title || '').trim())
        return json(res, 200, { ok: true, title: v.title || String(body.title || '').trim(), seq: v.seq })
      } catch (e) {
        return json(res, 502, { error: humanizeError(e) })
      }
    }
  }

  if (p === '/api/dsh/respond' && req.method === 'POST') {
    // 审批/提问的回答目前不做 UI，接口留好，避免以后要改协议
    let body
    try { body = await readBody(req, 65536) } catch (e) { return json(res, 400, { error: e.message }) }
    try {
      const dc = requireDsh(req)
      const r = await dc.client.respond(body)
      return json(res, 200, r)
    } catch (e) {
      return json(res, 502, { error: humanizeError(e) })
    }
  }

  // =========================== 连接（页面）管理 ===========================
  // 用户可手动添加/编辑/删除；每条连接走标准接口（dsh 或 openai 兼容）
  if (p === '/api/connections' && req.method === 'GET') {
    return json(res, 200, { connections: getConnections().map(publicConn), presets: connectionPresets() })
  }

  if (p === '/api/connections' && req.method === 'POST') {
    let body
    try { body = await readBody(req, 65536) } catch (e) { return json(res, 400, { error: e.message }) }
    const kind = body.kind === 'openai' ? 'openai' : 'dsh'
    if (body.localAuth && !isLoopback(req)) return json(res, 403, { error: '「使用本机 DSH 凭据」只能在部署端本机开启' })
    const baseUrl = normalizeBaseUrl(body.baseUrl || (kind === 'dsh' ? config.dsh.baseUrl : ''))
    if (kind === 'openai' && !baseUrl) return json(res, 400, { error: 'OpenAI 兼容连接必须填 baseUrl（例如 http://127.0.0.1:8080/v1）' })
    if (kind === 'dsh' && !baseUrl) return json(res, 400, { error: '会话型页面必须填地址（例如 http://127.0.0.1:3080，桌面软件是 http://127.0.0.1:<端口>）' })
    const id = 'c' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex')
    const conn = normalizeConn({
      id,
      name: String(body.name || (kind === 'dsh' ? '会话型服务' : '自定义 AI')).trim(),
      kind,
      baseUrl,
      api: body.api,
      token: body.token,
      cookie: body.cookie,
      autoDesktop: body.autoDesktop,
      localAuth: body.localAuth,
      apiKey: body.apiKey,
      model: body.model,
      note: body.note,
      maxTokens: body.maxTokens,
      temperature: body.temperature,
      systemPrompt: body.systemPrompt,
      autoOpen: body.autoOpen
    })
    if (!conn) return json(res, 400, { error: '参数不合法' })
    const list = getConnections().slice()
    list.push(conn)
    await saveConnections(list)
    if (conn.kind === 'openai') getStore(conn)   // 建目录 + 预热
    else await rebuildDshClients()
    return json(res, 200, { ok: true, connection: publicConn(conn), dsh: dshClients.has(conn.id) ? publicDshEntry(dshClients.get(conn.id)) : null })
  }

  // 先测再存（还没保存的连接）：POST /api/connections/test
  if (p === '/api/connections/test' && req.method === 'POST') {
    let body
    try { body = await readBody(req, 65536) } catch (e) { return json(res, 400, { error: e.message }) }
    const kind = body.kind === 'openai' ? 'openai' : 'dsh'
    if (kind === 'dsh' && body.localAuth && !isLoopback(req)) return json(res, 403, { error: '「使用本机 DSH 凭据」只能在部署端本机测试' })
    if (kind === 'dsh') {
      const probeConn = normalizeConn({
        id: 'probe',
        name: 'probe',
        kind: 'dsh',
        baseUrl: normalizeBaseUrl(body.baseUrl || config.dsh.baseUrl),
        api: body.api,
        token: body.token,
        cookie: body.cookie
      })
      if (!probeConn) return json(res, 400, { error: '参数不合法（需要一个地址）' })
      const r = await testConnection(probeConn)
      return json(res, 200, r)
    }
    const conn = normalizeConn({
      id: 'probe',
      name: 'probe',
      kind: 'openai',
      baseUrl: body.baseUrl,
      apiKey: body.apiKey !== undefined ? body.apiKey : (primaryOpenAIConn() || {}).apiKey,
      model: body.model
    })
    if (!conn) return json(res, 400, { error: '参数不合法（需要 baseUrl）' })
    const r = await testConnection(conn)
    return json(res, 200, r)
  }

  const CONN_ONE = /^\/api\/connections\/([A-Za-z0-9_-]+)$/.exec(p)
  if (CONN_ONE) {
    const id = CONN_ONE[1]
    const list = getConnections()
    const idx = list.findIndex((c) => c.id === id)
    if (idx < 0) return json(res, 404, { error: '连接不存在' })
    if (req.method === 'PATCH') {
      let body
      try { body = await readBody(req, 65536) } catch (e) { return json(res, 400, { error: e.message }) }
      const cur = list[idx]
      if (!isLoopback(req) && (cur.localAuth || body.localAuth)
        && (body.baseUrl !== undefined || body.localAuth !== undefined)) {
        return json(res, 403, { error: '「使用本机 DSH 凭据」的地址/开关只能在部署端本机修改' })
      }
      const next = normalizeConn(Object.assign({}, cur, {
        name: body.name !== undefined ? body.name : cur.name,
        baseUrl: body.baseUrl !== undefined ? body.baseUrl : cur.baseUrl,
        api: body.api !== undefined ? body.api : cur.api,
        token: body.token !== undefined ? body.token : cur.token,
        cookie: body.cookie !== undefined ? body.cookie : cur.cookie,
        autoDesktop: body.autoDesktop !== undefined ? body.autoDesktop : cur.autoDesktop,
        localAuth: body.localAuth !== undefined ? body.localAuth : cur.localAuth,
        model: body.model !== undefined ? body.model : cur.model,
        apiKey: body.apiKey !== undefined ? body.apiKey : cur.apiKey,
        note: body.note !== undefined ? body.note : cur.note,
        enabled: body.enabled !== undefined ? body.enabled : cur.enabled,
        maxTokens: body.maxTokens !== undefined ? body.maxTokens : cur.maxTokens,
        temperature: body.temperature !== undefined ? body.temperature : cur.temperature,
        systemPrompt: body.systemPrompt !== undefined ? body.systemPrompt : cur.systemPrompt,
        autoOpen: body.autoOpen !== undefined ? body.autoOpen : cur.autoOpen
      }))
      if (!next) return json(res, 400, { error: '参数不合法' })
      if (next.kind === 'dsh' && !next.baseUrl) return json(res, 400, { error: '会话型页面必须填地址' })
      list[idx] = next
      await saveConnections(list)
      if (next.kind === 'dsh') await rebuildDshClients()
      return json(res, 200, { ok: true, connection: publicConn(next), dsh: dshClients.has(next.id) ? publicDshEntry(dshClients.get(next.id)) : null })
    }
    if (req.method === 'DELETE') {
      // 允许删到 0 个：删光后界面会引导你「＋ 添加」
      list.splice(idx, 1)
      await saveConnections(list)
      if (getConnections().some((c) => c.kind === 'dsh')) await rebuildDshClients()
      else {
        for (const e of dshClients.values()) { try { e.client.stop && e.client.stop() } catch { /* ignore */ } if (e.pollTimer) clearInterval(e.pollTimer) }
        dshClients.clear()
        dshDefaultEntry = null
      }
      // 会话文件不删（万一用户手滑），只是不再出现在界面上
      return json(res, 200, { ok: true })
    }
    return json(res, 405, { error: '只支持 PATCH / DELETE' })
  }

  const CONN_TEST = /^\/api\/connections\/([A-Za-z0-9_-]+)\/test$/.exec(p)
  if (CONN_TEST && req.method === 'POST') {
    const conn = findConn(CONN_TEST[1])
    if (!conn) return json(res, 404, { error: '连接不存在' })
    if (conn.localAuth && !isLoopback(req)) return json(res, 403, { error: '「使用本机 DSH 凭据」只能在部署端本机测试' })
    const r = await testConnection(conn)
    return json(res, 200, r)
  }

  // =========================== 一条连接上的会话 ===========================
  const CONN_CONV = /^\/api\/conn\/([A-Za-z0-9_-]+)\/conversations$/.exec(p)
  if (CONN_CONV) {
    const conn = findConn(CONN_CONV[1])
    if (!conn) return json(res, 404, { error: '连接不存在' })
    const s = getStore(conn)
    if (!s) return json(res, 400, { error: '这条连接不是对话型（' + conn.kind + '）' })
    if (req.method === 'GET') return json(res, 200, { conversations: s.list() })
    if (req.method === 'POST') {
      let body = {}
      try { body = await readBody(req, 8192) } catch { /* 忽略 */ }
      const c = s.create(body.title)
      broadcast('conn', { connId: conn.id, event: 'conv-updated', data: { meta: s.meta(c) } })
      return json(res, 200, { conversation: s.meta(c) })
    }
    return json(res, 405, { error: '只支持 GET / POST' })
  }

  const CONN_CONV_ONE = /^\/api\/conn\/([A-Za-z0-9_-]+)\/conversations\/([A-Za-z0-9_-]+)$/.exec(p)
  if (CONN_CONV_ONE) {
    const conn = findConn(CONN_CONV_ONE[1])
    if (!conn) return json(res, 404, { error: '连接不存在' })
    const s = getStore(conn)
    if (!s) return json(res, 400, { error: '这条连接不是对话型' })
    const conv = s.get(CONN_CONV_ONE[2])
    if (!conv) return json(res, 404, { error: '会话不存在' })
    if (req.method === 'GET') {
      return json(res, 200, { conversation: s.meta(conv), messages: conv.messages.map(s.publicMessage) })
    }
    if (req.method === 'PATCH') {
      let body
      try { body = await readBody(req, 8192) } catch (e) { return json(res, 400, { error: e.message }) }
      const c2 = s.patch(conv.id, body)
      broadcast('conn', { connId: conn.id, event: 'conv-updated', data: { meta: s.meta(c2) } })
      return json(res, 200, { conversation: s.meta(c2) })
    }
    if (req.method === 'DELETE') {
      await s.remove(conv.id)
      broadcast('conn', { connId: conn.id, event: 'conv-deleted', data: { id: conv.id } })
      return json(res, 200, { ok: true })
    }
    return json(res, 405, { error: '只支持 GET / PATCH / DELETE' })
  }

  const CONN_CHAT = /^\/api\/conn\/([A-Za-z0-9_-]+)\/chat$/.exec(p)
  if (CONN_CHAT && req.method === 'POST') {
    const conn = findConn(CONN_CHAT[1])
    if (!conn) return json(res, 404, { error: '连接不存在' })
    const s = getStore(conn)
    if (!s) return json(res, 400, { error: '这条连接不是对话型' })
    let body
    try { body = await readBody(req, 262144) } catch (e) { return json(res, 400, { error: e.message }) }
    let conv = body.conversationId ? s.get(body.conversationId) : null
    if (body.conversationId && !conv) return json(res, 404, { error: '会话不存在' })
    if (!conv) {
      conv = s.create('')
      broadcast('conn', { connId: conn.id, event: 'conv-updated', data: { meta: s.meta(conv) } })
    }
    if (s.isRunning(conv.id)) return json(res, 409, { error: '这个对话正在生成中，先点停止' })
    const txt = String(body.text || '').trim()
    if (!txt && !body.regenerate) return json(res, 400, { error: '不能发送空消息' })
    try {
      s.startRun(conv, { regenerate: !!body.regenerate, text: txt })
      return json(res, 200, { ok: true, conversationId: conv.id, meta: s.meta(conv) })
    } catch (e) {
      return json(res, 400, { error: e.message })
    }
  }

  const CONN_STOP = /^\/api\/conn\/([A-Za-z0-9_-]+)\/stop$/.exec(p)
  if (CONN_STOP && req.method === 'POST') {
    const conn = findConn(CONN_STOP[1])
    const s = conn ? getStore(conn) : null
    if (!s) return json(res, 404, { error: '连接不存在或不是对话型' })
    let body
    try { body = await readBody(req, 8192) } catch { body = {} }
    return json(res, 200, { ok: true, stopped: s.stop(body.conversationId) })
  }

  // =========================== 老路径兼容 ===========================
  // /api/local/* 一律映射到"第一条 openai 连接"，老脚本（dev/tools/test-local.cjs 等）不用改
  const aliasStore = (() => { const c = primaryOpenAIConn(); return c ? getStore(c) : null })()
  if ((p.startsWith('/api/local/') || LOCAL_CONV.test(p)) && !aliasStore) {
    return json(res, 400, { error: '还没有添加 openai 类型的连接（在界面上点「＋ 添加页面」）' })
  }
  if (p === '/api/local/conversations' && req.method === 'GET') {
    return json(res, 200, { conversations: aliasStore.list() })
  }
  if (p === '/api/local/conversations' && req.method === 'POST') {
    let body = {}
    try { body = await readBody(req, 8192) } catch { /* 忽略 */ }
    const c = aliasStore.create(body.title)
    broadcast('conn', { connId: primaryOpenAIConn().id, event: 'conv-updated', data: { meta: aliasStore.meta(c) } })
    return json(res, 200, { conversation: aliasStore.meta(c) })
  }

  const lm = LOCAL_CONV.exec(p)
  if (lm) {
    const conv = aliasStore.get(lm[1])
    if (!conv) return json(res, 404, { error: '会话不存在' })
    if (req.method === 'GET') {
      return json(res, 200, { conversation: aliasStore.meta(conv), messages: conv.messages.map(aliasStore.publicMessage) })
    }
    if (req.method === 'PATCH') {
      let body
      try { body = await readBody(req, 8192) } catch (e) { return json(res, 400, { error: e.message }) }
      const c2 = aliasStore.patch(conv.id, body)
      broadcast('conn', { connId: primaryOpenAIConn().id, event: 'conv-updated', data: { meta: aliasStore.meta(c2) } })
      return json(res, 200, { conversation: aliasStore.meta(c2) })
    }
    if (req.method === 'DELETE') {
      await aliasStore.remove(conv.id)
      broadcast('conn', { connId: primaryOpenAIConn().id, event: 'conv-deleted', data: { id: conv.id } })
      return json(res, 200, { ok: true })
    }
  }

  if (p === '/api/local/chat' && req.method === 'POST') {
    let body
    try { body = await readBody(req, 262144) } catch (e) { return json(res, 400, { error: e.message }) }
    let conv = body.conversationId ? aliasStore.get(body.conversationId) : null
    if (body.conversationId && !conv) return json(res, 404, { error: '会话不存在' })
    if (!conv) {
      conv = aliasStore.create('')
      broadcast('conn', { connId: primaryOpenAIConn().id, event: 'conv-updated', data: { meta: aliasStore.meta(conv) } })
    }
    if (aliasStore.isRunning(conv.id)) return json(res, 409, { error: '这个对话正在生成中，先点停止' })
    const txt = String(body.text || '').trim()
    if (!txt && !body.regenerate) return json(res, 400, { error: '不能发送空消息' })
    try {
      aliasStore.startRun(conv, { regenerate: !!body.regenerate, text: txt })
      return json(res, 200, { ok: true, conversationId: conv.id, meta: aliasStore.meta(conv) })
    } catch (e) {
      return json(res, 400, { error: e.message })
    }
  }

  if (p === '/api/local/stop' && req.method === 'POST') {
    let body
    try { body = await readBody(req, 8192) } catch { body = {} }
    return json(res, 200, { ok: true, stopped: aliasStore.stop(body.conversationId) })
  }

  // ---- 设置 ----
  if (p === '/api/settings' && req.method === 'GET') {
    const b = backupCfg()
    const deploySide = isLoopback(req)
    return json(res, 200, {
      local: { ...config.local, apiKey: undefined, apiKeySet: !!config.local.apiKey, apiKeyTail: String(config.local.apiKey || '').slice(-4) },
      autostart: autostartStatus(),
      tunnel: tunnelStatus(),
      ui: { appName: config.ui.appName, publicUrl: config.ui.publicUrl || '' },
      dsh: config.dsh,
      net: { host: config.host, port: config.port },
      // 非部署端不返回备份目录/间隔等设置，只告诉它有没有密码；导出时凭密码即可
      backup: deploySide
        ? { enabled: b.enabled, intervalHours: b.intervalHours, keep: b.keep, dir: b.dir, hasPassword: !!b.passwordHash, localOnly: true }
        : { hasPassword: !!b.passwordHash, localOnly: false }
    })
  }

  if (p === '/api/settings' && req.method === 'PUT') {
    let body
    try { body = await readBody(req, 65536) } catch (e) { return json(res, 400, { error: e.message }) }
    const l = body.local || {}
    if (typeof l.baseUrl === 'string' && l.baseUrl.trim()) config.local.baseUrl = l.baseUrl.trim()
    if (typeof l.model === 'string' && l.model.trim()) config.local.model = l.model.trim()
    if (l.maxTokens !== undefined) {
      const n = parseInt(l.maxTokens, 10)
      if (Number.isFinite(n) && n >= 64 && n <= 32768) config.local.maxTokens = n
    }
    if (l.temperature !== undefined) {
      const t = parseFloat(l.temperature)
      if (Number.isFinite(t) && t >= 0 && t <= 2) config.local.temperature = t
    }
    if (typeof l.systemPrompt === 'string') config.local.systemPrompt = l.systemPrompt.slice(0, 4000)
    if (typeof l.apiKey === 'string' && l.apiKey.trim()) config.local.apiKey = l.apiKey.trim()
    if (typeof l.enabled === 'boolean') config.local.enabled = l.enabled
    let dshSettingsChanged = false
    if (typeof body.dsh?.defaultCwd === 'string' && body.dsh.defaultCwd.trim()) config.dsh.defaultCwd = body.dsh.defaultCwd.trim()
    if (typeof body.dsh?.baseUrl === 'string') {
      const v = normalizeBaseUrl(body.dsh.baseUrl)
      if (v && !/^https?:\/\//i.test(v)) return json(res, 400, { error: '会话型服务地址要以 http:// 或 https:// 开头' })
      if (v !== config.dsh.baseUrl) { config.dsh.baseUrl = v; dshSettingsChanged = true }
    }
    if (typeof body.dsh?.newSessionPreset === 'string') config.dsh.newSessionPreset = body.dsh.newSessionPreset.trim().slice(0, 80)
    if (typeof body.ui?.appName === 'string' && body.ui.appName.trim()) config.ui.appName = body.ui.appName.trim().slice(0, 40)
    if (typeof body.ui?.publicUrl === 'string') {
      const v = body.ui.publicUrl.trim()
      if (!v) config.ui.publicUrl = ''
      else if (/^https?:\/\/[^\s<>"']+$/i.test(v)) config.ui.publicUrl = v.slice(0, 300)
      else return json(res, 400, { error: '外网地址要以 http:// 或 https:// 开头' })
    }
    // 监听地址/端口（外网访问的意见 4：要在网页里有实际接口能调）
    let restartRequired = false
    if (body.net && typeof body.net === 'object') {
      if (typeof body.net.host === 'string') {
        const h = body.net.host.trim()
        const okHost = ['0.0.0.0', '127.0.0.1', 'localhost', '::'].includes(h) || /^[0-9a-fA-F:.]+$/.test(h)
        if (!okHost) return json(res, 400, { error: '监听地址只能是 0.0.0.0 / 127.0.0.1 / :: / 本机网卡 IP' })
        if (h !== config.host) { config.host = h; restartRequired = true }
      }
      if (body.net.port !== undefined) {
        const n = parseInt(body.net.port, 10)
        if (!Number.isFinite(n) || n < 1 || n > 65535) return json(res, 400, { error: '端口要在 1~65535' })
        if (n !== config.port) { config.port = n; restartRequired = true }
      }
    }
    await saveConfig()
    if (dshSettingsChanged) await rebuildDshClients()
    return json(res, 200, { ok: true, restartRequired })
  }

  // ---- 备份（对话数据）----
  if (p === '/api/backup' && req.method === 'GET') {
    const b = backupCfg()
    const snap = await listSnapshots()
    return json(res, 200, {
      enabled: b.enabled,
      intervalHours: b.intervalHours,
      keep: b.keep,
      dir: b.dir,
      hasPassword: !!b.passwordHash,
      lastRunAt: b.lastRunAt,
      nextRunAt: b.enabled ? b.lastRunAt + b.intervalHours * 3600000 : 0,
      busy: backupBusy,
      lastResult: lastBackupResult,
      snapshots: snap.items.slice(0, 50),
      snapshotDir: snap.dir,
      localOnly: isLoopback(req)
    })
  }

  // 改备份设置 / 设部署端密码：本机回环 + 部署端密码
  if (p === '/api/backup/config' && req.method === 'POST') {
    if (!isLoopback(req)) return json(res, 403, { error: '备份设置只允许在服务部署端（本机浏览器）修改' })
    let body
    try { body = await readBody(req, 16384) } catch (e) { return json(res, 400, { error: e.message }) }
    const b = backupCfg()
    if (b.passwordHash) {
      if (!deployerPasswordOk(body.password)) return json(res, 401, { error: '部署端密码不对' })
    } else {
      const np = String(body.newPassword || '')
      if (np.length < DEPLOYER_MIN_LEN) return json(res, 400, { error: '第一次要设置部署端密码，至少 ' + DEPLOYER_MIN_LEN + ' 位' })
    }
    let dir = b.dir
    if (body.dir !== undefined) {
      try { dir = resolveBackupDir(body.dir) } catch (e) { return json(res, 400, { error: e.message }) }
    }
    const next = { ...b, dir }
    if (body.enabled !== undefined) next.enabled = body.enabled !== false
    if (body.intervalHours !== undefined) {
      const n = parseInt(body.intervalHours, 10)
      if (!Number.isFinite(n) || n < 1 || n > 168) return json(res, 400, { error: '备份间隔要 1~168 小时' })
      next.intervalHours = n
    }
    if (body.keep !== undefined) {
      const n = parseInt(body.keep, 10)
      if (!Number.isFinite(n) || n < 1 || n > 200) return json(res, 400, { error: '保留份数要 1~200' })
      next.keep = n
    }
    if (body.newPassword) {
      const np = String(body.newPassword)
      if (np.length < DEPLOYER_MIN_LEN) return json(res, 400, { error: '部署端密码至少 ' + DEPLOYER_MIN_LEN + ' 位' })
      const salt = crypto.randomBytes(16).toString('hex')
      next.passwordSalt = salt
      next.passwordHash = scryptHex(np, salt)
    }
    config.backup = next
    await saveConfig()
    console.log('[backup] 设置已更新：enabled=' + next.enabled + ' 每 ' + next.intervalHours + 'h 保留 ' + next.keep + ' 份 dir=' + next.dir)
    return json(res, 200, { ok: true, hasPassword: !!next.passwordHash })
  }

  // 下载/提取一份快照：登录 + 部署端密码（不要求本机，手机也可以凭密码导出）
  if (p === '/api/backup/download' && req.method === 'POST') {
    let body = {}
    try { body = await readBody(req, 16384) } catch { /* 允许空体 */ }
    const b = backupCfg()
    if (!b.passwordHash) return json(res, 400, { error: '还没设置部署端密码：先在部署端设置里设一个' })
    if (!deployerPasswordOk(body.password)) return json(res, 401, { error: '部署端密码不对' })
    const snap = await listSnapshots()
    let name = String(body.name || '').trim()
    if (!name) name = (snap.items[0] && snap.items[0].name) || ''
    const item = snap.items.find((x) => x.name === name)
    if (!item) return json(res, 404, { error: '没找到这个快照' })
    const root = path.join(snap.dir, item.name)
    const entries = []
    const walk = async (dir, prefix) => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        const rel = prefix ? prefix + '/' + ent.name : ent.name
        if (ent.isDirectory()) { await walk(full, rel); continue }
        if (!ent.isFile()) continue
        const data = await fs.readFile(full)
        entries.push({ name: rel, data, mtime: (await fs.stat(full)).mtime })
      }
    }
    try {
      await walk(root, '')
      const zip = createZip(entries)
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + item.name + '.zip"; filename*=UTF-8\'\'' + encodeURIComponent(item.name + '.zip'),
        'Content-Length': zip.length,
        'Cache-Control': 'no-store'
      })
      res.end(zip)
      return
    } catch (e) {
      return json(res, 500, { error: '打包备份失败：' + e.message })
    }
  }

  if (p === '/api/backup/run' && req.method === 'POST') {
    if (!isLoopback(req)) return json(res, 403, { error: '立即备份只允许在服务部署端（本机浏览器）触发' })
    let body = {}
    try { body = await readBody(req, 8192) } catch { /* 允许空体 */ }
    const b = backupCfg()
    if (!b.passwordHash) return json(res, 400, { error: '还没设置部署端密码：先在设置里设一个' })
    if (!deployerPasswordOk(body.password)) return json(res, 401, { error: '部署端密码不对' })
    try {
      const r = await runBackup('manual')
      return json(res, 200, { ok: true, ...r })
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message })
    }
  }

  // ---- 外网访问自检 ----
  if (p === '/api/net/check' && req.method === 'GET') {
    try { return json(res, 200, await netCheck()) } catch (e) { return json(res, 500, { error: e.message }) }
  }

  // ---- 开机自启（Windows 计划任务）：只允许本机操作 ----
  if (p === '/api/settings/autostart' && req.method === 'POST') {
    if (!isLoopback(req)) return json(res, 403, { error: '这个操作只允许在本机（本机浏览器）里做' })
    if (process.platform !== 'win32') return json(res, 400, { error: '自启动目前只支持 Windows（用计划任务实现）' })
    let body
    try { body = await readBody(req, 8192) } catch (e) { return json(res, 400, { error: e.message }) }
    const enable = body.enable !== false
    // 2026-11-18：不再依赖 PowerShell 脚本，直接调用本包的入口（bin/dsh-ycfw.mjs autostart on|off）。
    // 它内部用 schtasks 注册/删除计划任务，和命令行 `dsh-ycfw autostart on` 完全同一条路径。
    const bin = path.join(APP_ROOT, 'bin', 'dsh-ycfw.mjs')
    if (!existsSync(bin)) return json(res, 500, { error: '找不到 bin/dsh-ycfw.mjs，包不完整' })
    let output = ''
    try {
      output = String(execFileSync(process.execPath, [bin, 'autostart', enable ? 'on' : 'off'], { timeout: 60000, windowsHide: true, encoding: 'utf8' }))
    } catch (e) {
      const tail = (buf2str(e.stdout) + buf2str(e.stderr)).slice(-600)
      console.log('[autostart] ' + (enable ? 'on' : 'off') + ' 失败：' + e.message + ' ' + tail)
      return json(res, 500, { ok: false, error: '设置自启失败：' + e.message, detail: tail, autostart: autostartStatus() })
    }
    const st = autostartStatus()
    if (st.installed !== enable) {
      return json(res, 500, { ok: false, error: '计划任务没有变成期望的状态', detail: output.slice(-400), autostart: st })
    }
    return json(res, 200, { ok: true, autostart: st })
  }


  return json(res, 404, { error: '接口不存在' })
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
function normalizePath(p) {
  // Tailscale Funnel 以 --set-path /chat 挂进来时路径可能带前缀，两种都认
  if (p === '/chat') return '/'
  if (p.startsWith('/chat/')) return p.slice(5)
  return p
}

const server = http.createServer(async (req, res) => {
  let url
  try { url = new URL(req.url, 'http://localhost') } catch { return textRes(res, 400, 'bad url') }
  const p = normalizePath(url.pathname)
  res.setHeader('Referrer-Policy', 'no-referrer')
  res._gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
  try {
    if (p.startsWith('/api/')) return await handleApi(req, res, p, url)
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html')) {
      return await serveShell(req, res)
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, p)
    return textRes(res, 405, 'method not allowed')
  } catch (e) {
    console.error('[http]', p, e && e.message)
    if (!res.headersSent) json(res, 500, { error: e && e.message || '服务端错误' })
    else { try { res.end() } catch { /* ignore */ } }
  }
})

// ---------------------------------------------------------------------------
// 自己写日志（不依赖外层重定向，这样进程可以被直接 WMI 拉起，pid 就是本进程，
// 停止脚本才能真的杀掉；之前用 cmd 包一层，pid 记的是 cmd，导致"改了代码不生效"）
// ---------------------------------------------------------------------------
function setupLogFile() {
  const logDir = path.join(HOME_DIR, 'logs')
  try { mkdirSync(logDir, { recursive: true }) } catch { /* ignore */ }
  const file = path.join(logDir, 'server.log')
  try {
    const st = statSync(file)
    if (st.size > 2 * 1024 * 1024) {
      try { renameSync(file, file + '.1') } catch { /* ignore */ }
    }
  } catch { /* 文件不存在 */ }
  const stream = createWriteStream(file, { flags: 'a' })
  const ts = () => new Date().toLocaleString('zh-CN', { hour12: false })
  const wrap = (orig) => (...args) => {
    const line = '[' + ts() + '] ' + args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')
    try { stream.write(line + '\n') } catch { /* ignore */ }
    orig(...args)
  }
  console.log = wrap(console.log.bind(console))
  console.error = wrap(console.error.bind(console))
}

async function main() {
  setupLogFile()
  await initConfig()
  const n = await initConnectionStores()
  await rebuildDshClients()
  syncLocalDesktop().catch(() => {})
  syncDesktopFromLogs().catch(() => {})
  setInterval(() => {
    syncLocalDesktop().catch(() => {})
    syncDesktopFromLogs().catch(() => {})
  }, 20000).unref?.()

  // 预热会话列表：等客户端来要的时候已经是热的（打开页面/登录后的第一屏不用等上游）
  for (const e of dshClients.values()) kickWarm(e)
  // 保温：有客户端在看就 3 秒一次（running 状态准），没人看就 8 秒一次
  setInterval(() => {
    const gap = sseClients.size > 0 ? 3000 : 8000
    for (const e of dshClients.values()) {
      if (!e.listCache.at || Date.now() - e.listCache.at > gap) kickWarm(e)
    }
  }, 3000).unref?.()
  const port = Number(process.env.MC_PORT || config.port || 8100)
  const host = process.env.MC_HOST || config.host || '127.0.0.1'
  // 端口被占时给一句人话，别甩一屏堆栈（多实例/后台服务已经在跑是最常见的情况）
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error('[dsh-ycfw] 端口 ' + port + ' 已被占用：本机可能已经有一个实例在跑（计划任务 DSH-YCFW / 控制台小窗口 / 另一个 npm start）。')
      console.error('          直接用现成的： http://127.0.0.1:' + port + '/')
      console.error('          要再起一个：   npm start -- --port 8200')
      console.error('          要停后台那个： 停止.ps1（或控制台点停止）')
      process.exit(3)
    }
    console.error('[dsh-ycfw] 监听失败：', e && e.message ? e.message : e)
    process.exit(1)
  })
  server.listen(port, host, () => {
    const line = '='.repeat(66)
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254') && !/^(100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.)/.test(i.address))
      .map((i) => i.address)
    console.log(line)
    console.log('  本机访问：  http://127.0.0.1:' + port + '/')
    console.log('  外网访问：  ' + (config.ui.publicUrl || '（未配置：设置 → 外网访问，或用隧道映射到本机端口）'))
    console.log('  登录口令：  ' + config.auth.password + '    （配置文件 config.json）')
    const connLines = getConnections()
    if (connLines.length) {
      console.log('  已连接 AI：')
      for (const c of connLines) console.log('    · ' + c.name + '  ' + (c.baseUrl || '') + (c.kind === 'openai' && c.model ? '  model=' + c.model : ''))
    } else {
      console.log('  已连接 AI：  （还没有页面，打开网页点「＋ 添加」）')
    }
    // npm start / bin 启动时自动打开浏览器（像 npm 那套：跑起来就能看）
    if (process.env.YCFW_OPEN === '1') {
      const url = 'http://127.0.0.1:' + port + '/'
      try {
        const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
        const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
        console.log('  已在浏览器打开：' + url)
      } catch (e) { console.log('  （自动打开浏览器失败：' + e.message + '，手动访问上面的地址）') }
    }
  })
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e))
process.on('SIGINT', () => { console.log('\n正在退出…'); process.exit(0) })

main().catch((e) => { console.error('启动失败：', e); process.exit(1) })
