import { existsSync } from 'node:fs'
// 登录/首屏耗时实测
//  情形A：已登录（有 cookie）直接打开 → 看到会话列表要多久
//  情形B：未登录 → 输口令 → 进入并看到会话列表要多久
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const APP = 'http://127.0.0.1:8100/'
const CHROME = process.env.CHROME_PATH || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find((p) => { try { return existsSync(p) } catch { return false } }) || 'chrome'
const PORT = Number(process.argv[2] || 9336)
const USERDIR = path.join(ROOT, '.chrome-login')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'))

async function boot_(withCookie) {
  await fs.rm(USERDIR, { recursive: true, force: true }).catch(() => {})
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + USERDIR,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=390,844', 'about:blank'
  ], { stdio: 'ignore' })

  let page
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
      page = l.find((t) => t.type === 'page')
      if (page) break
    } catch { /* wait */ }
    await sleep(200)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const j = JSON.parse(e.data)
    if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)))
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text }
    return r.result ? r.result.value : undefined
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

  if (withCookie) {
    const lr = await fetch(APP + 'api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: cfg.auth.password })
    })
    const sid = /mc_sid=([^;]+)/.exec(lr.headers.get('set-cookie') || '')?.[1]
    await send('Network.setCookie', { name: 'mc_sid', value: sid, domain: '127.0.0.1', path: '/' })
  }
  return { chrome, send, ev, ws }
}

const waitRows = async (ev, ms) => {
  const t0 = Date.now()
  for (let i = 0; i < ms / 50; i++) {
    const n = await ev(`document.querySelectorAll('#convList .conv').length`)
    if (n > 0) return { ms: Date.now() - t0, rows: n }
    await sleep(50)
  }
  return { ms: null, rows: 0 }
}

// ---------- 情形A：已登录 ----------
console.log('=== 情形A：已登录，直接打开 ===')
let h = await boot_(true)
await h.send('Page.navigate', { url: APP })
const rA = await waitRows(h.ev, 20000)
const perfA = await h.ev(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fetchStart: Math.round(n.fetchStart) } : null })()`)
console.log('  会话列表出现:', rA.ms === null ? '超时' : rA.ms + 'ms', ' 条数:', rA.rows)
console.log('  页面加载:', JSON.stringify(perfA))
// __diag: 打印资源耗时
const res = await h.ev(`(() => {
  const nav = performance.getEntriesByType('navigation')[0]
  const rs = performance.getEntriesByType('resource').map(r => ({ n: r.name.replace(location.origin,''), t: Math.round(r.duration), s: Math.round(r.startTime) }))
  return { nav: nav ? { ttfb: Math.round(nav.responseStart), dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) } : null, rs }
})()`)
console.log('  资源耗时:', JSON.stringify(res, null, 1))
h.ws.close(); h.chrome.kill()
await sleep(400)

// ---------- 情形B：未登录 ----------
console.log('\n=== 情形B：未登录 → 输口令 → 进入 ===')
h = await boot_(false)
await h.send('Page.navigate', { url: APP })
await sleep(1200)
const loginShown = await h.ev(`!document.getElementById('login').classList.contains('hidden')`)
console.log('  登录页已出现:', loginShown)
const t0 = Date.now()
await h.ev(`(() => { document.getElementById('pw').value = ${JSON.stringify(cfg.auth.password)}; document.getElementById('loginBtn').click(); return true })()`)
const rB = await waitRows(h.ev, 25000)
console.log('  点击登录 → 看到会话列表:', rB.ms === null ? '超时' : rB.ms + 'ms', ' 条数:', rB.rows)
h.ws.close(); h.chrome.kill()
await fs.rm(USERDIR, { recursive: true, force: true }).catch(() => {})
process.exit(0)
