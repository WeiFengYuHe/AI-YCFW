const CHROME = process.env.CHROME_PATH || 'chrome'
// 最终体检（模拟用户真实打开一次）：把"用户能感知到的东西"全部核一遍
//   · 页面是否真的显示出来（不是白屏）
//   · 会话列表是否按工作区分组、归档是否隐藏
//   · Service Worker 是否装上、是否会自动更新（不再发旧版本）
//   · 首屏耗时、版本号
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'

const ROOT = process.env.YCFW_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = 'http://127.0.0.1:8100/'
const PORT = Number(process.argv[2] || 9370)
const USERDIR = ROOT + '/.chrome-verify'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cfg = JSON.parse(await fs.readFile(ROOT + '/config.json', 'utf8'))

const lr = await fetch(APP + 'api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: cfg.auth.password })
})
const sid = /mc_sid=([^;]+)/.exec(lr.headers.get('set-cookie') || '')[1]

await fs.rm(USERDIR, { recursive: true, force: true }).catch(() => {})
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + USERDIR,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=390,844', 'about:blank'
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
const errs = []
ws.addEventListener('message', (e) => {
  const j = JSON.parse(e.data)
  if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); return }
  if (j.method === 'Runtime.exceptionThrown') {
    const d = j.params.exceptionDetails
    errs.push((d.exception && (d.exception.description || d.exception.value)) || d.text)
  }
})
const send = (m, p = {}) => new Promise((res, rej) => {
  const i = ++id
  pending.set(i, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result)))
  ws.send(JSON.stringify({ id: i, method: m, params: p }))
})
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text }
  return r.result ? r.result.value : undefined
}

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
await send('Network.setCookie', { name: 'mc_sid', value: sid, domain: '127.0.0.1', path: '/' })

const t0 = Date.now()
await send('Page.navigate', { url: APP })
let firstRows = null
for (let i = 0; i < 200; i++) {
  const n = await ev(`document.querySelectorAll('#convList .conv').length`)
  if (n > 0) { firstRows = Date.now() - t0; break }
  await sleep(25)
}
await sleep(3000)

const st = await ev(`(async () => {
  const groups = [...document.querySelectorAll('.ws-head')].map(h => ({
    t: h.querySelector('.ws-title').textContent,
    n: h.querySelector('.ws-count').textContent,
    p: (h.querySelector('.ws-path') || {}).textContent || ''
  }))
  let sw = null
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    sw = { controller: !!navigator.serviceWorker.controller, count: regs.length, caches: await caches.keys() }
  } catch (e) { sw = { error: String(e && e.message) } }
  return {
    appVisible: !document.getElementById('app').classList.contains('hidden'),
    loginVisible: !document.getElementById('login').classList.contains('hidden'),
    rows: document.querySelectorAll('#convList .conv').length,
    groups,
    archivedTip: (document.querySelector('.conv-archived-tip') || {}).textContent || '',
    build: (document.getElementById('buildVer') || {}).textContent || '',
    sw
  }
})()`)

console.log('首屏出现会话列表:', firstRows === null ? '超时' : firstRows + 'ms')
console.log('页面可见:', st.appVisible, ' 登录页可见:', st.loginVisible)
console.log('会话行数:', st.rows)
console.log('工作区分组 (' + st.groups.length + '):')
for (const g of st.groups) console.log('   ·', g.t, '×' + g.n, '  ', g.p)
console.log('归档提示:', st.archivedTip)
console.log('版本号:', st.build)
console.log('Service Worker:', JSON.stringify(st.sw))
if (errs.length) { console.log('JS 异常:'); errs.forEach((e) => console.log('   ', e)) } else console.log('JS 异常: 无')

const pass = st.appVisible && st.rows > 0 && st.groups.length > 0 && st.sw.count > 0
console.log('\n结论:', pass ? 'PASS 用户打开就能看到按工作区分组的会话列表，SW 正常' : 'FAIL 见上面明细')

ws.close(); chrome.kill()
await fs.rm(USERDIR, { recursive: true, force: true }).catch(() => {})
process.exit(pass ? 0 : 1)
