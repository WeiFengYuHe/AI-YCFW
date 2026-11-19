import { existsSync } from 'node:fs'
// 无头 Chrome 实测：登录 → 打开 App → 截图 + 抓控制台错误 + 读关键 DOM 状态
// 用法：node tools/shot.mjs [宽] [高] [输出名]
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const CHROME = process.env.CHROME_PATH || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find((p) => { try { return existsSync(p) } catch { return false } }) || 'chrome'
const PORT = 9333
const APP = 'http://127.0.0.1:8100/'

const W = parseInt(process.argv[2] || '390', 10)
const H = parseInt(process.argv[3] || '844', 10)
const NAME = process.argv[4] || 'shot-mobile'
const OUTDIR = path.join(ROOT, 'docs', 'screenshots')
const USERDIR = path.join(ROOT, '.chrome-test')

// ---- 1) 拿一个有效登录 cookie
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'))
const loginRes = await fetch(APP + 'api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: cfg.auth.password })
})
if (!loginRes.ok) throw new Error('登录失败：' + loginRes.status)
const setCookie = loginRes.headers.get('set-cookie') || ''
const sid = /mc_sid=([^;]+)/.exec(setCookie)?.[1]
if (!sid) throw new Error('拿不到 session cookie')
console.log('已取得测试会话 cookie')

// ---- 2) 起 chrome
await fs.rm(USERDIR, { recursive: true, force: true }).catch(() => {})
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + USERDIR,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars', '--force-device-scale-factor=2',
  '--window-size=' + W + ',' + H,
  'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list')
      const list = await r.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('Chrome 调试端口没起来')
}

const page = await waitDevtools()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })

let msgId = 0
const pending = new Map()
const consoleLogs = []
const exceptions = []
ws.addEventListener('message', (ev) => {
  let j
  try { j = JSON.parse(ev.data) } catch { return }
  if (j.id && pending.has(j.id)) {
    pending.get(j.id)(j)
    pending.delete(j.id)
    return
  }
  if (j.method === 'Runtime.consoleAPICalled') {
    const args = (j.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')
    consoleLogs.push(j.params.type + ': ' + args)
  }
  if (j.method === 'Runtime.exceptionThrown') {
    const d = j.params.exceptionDetails
    exceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text)
  }
  if (j.method === 'Log.entryAdded' && j.params.entry.level === 'error') {
    consoleLogs.push('log-error: ' + j.params.entry.text)
  }
  if (j.method === 'Network.responseReceived') {
    const r = j.params.response
    if (r.status >= 400) consoleLogs.push('HTTP ' + r.status + ' ← ' + r.url)
  }
  if (j.method === 'Network.loadingFailed') {
    consoleLogs.push('LOAD-FAIL ' + (j.params.errorText || '') + ' ' + (j.params.requestId || ''))
  }
})

function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 2, mobile: W < 700
})
await send('Network.setCookie', { name: 'mc_sid', value: sid, domain: '127.0.0.1', path: '/' })

await send('Page.navigate', { url: APP })
await sleep(4500)
// __mc1: 可选动作
const SID = process.argv[5] || ''
const ACTION = process.argv[6] || ''
const ev2 = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result ? r.result.value : undefined
}
if (SID) { await ev2(`window.__mc ? window.__mc.openSession('${SID}') : null`); await sleep(2800) }
if (ACTION === 'drawer') { await ev2(`document.getElementById('app').classList.add('drawer-open')`); await sleep(600) }
if (ACTION === 'settings') { await ev2(`document.getElementById('openSettings').click()`); await sleep(1200) }
if (ACTION === 'top') { await ev2(`document.getElementById('messages').scrollTop = 0`); await sleep(500) }
if (ACTION === 'dark') { await ev2(`document.documentElement.setAttribute('data-theme','dark')`); await sleep(500) }

// ---- 3) 读关键 DOM 状态
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result ? r.result.value : undefined
}
const state = await evalJs(`(() => {
  const q = (s) => document.querySelectorAll(s).length
  return {
    loginShown: !document.getElementById('login').classList.contains('hidden'),
    appShown: !document.getElementById('app').classList.contains('hidden'),
    convRows: q('#convList .conv'),
    groups: [...document.querySelectorAll('.conv-group')].map(e => e.textContent),
    chatTitle: (document.getElementById('chatTitle')||{}).textContent,
    chatSub: (document.getElementById('chatSub')||{}).textContent,
    msgs: q('.msg'),
    assistantMsgs: q('.msg.assistant'),
    userMsgs: q('.msg.user'),
    thinkBlocks: q('.think'),
    toolCards: q('.tool'),
    codeBlocks: q('.code-block'),
    mdParagraphs: q('.md p'),
    dshLabel: (document.getElementById('dshLabel')||{}).textContent,
    firstConvTitles: [...document.querySelectorAll('.conv-title')].slice(0,5).map(e=>e.textContent)
  }
})()`)

await fs.mkdir(OUTDIR, { recursive: true })
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
const outFile = path.join(OUTDIR, NAME + '.png')
await fs.writeFile(outFile, Buffer.from(shot.data, 'base64'))

console.log('\n=== DOM 状态 ===')
console.log(JSON.stringify(state, null, 2))
console.log('\n=== 控制台（最后 20 条）===')
console.log(consoleLogs.slice(-20).join('\n') || '（无）')
console.log('\n=== JS 异常 ===')
console.log(exceptions.slice(-10).join('\n') || '（无）')
console.log('\n截图：' + outFile)

ws.close()
chrome.kill()
process.exit(0)
const state2 = await evalJs(`(() => { const S = window.__mc && window.__mc.S; return S ? {mode:S.mode, currentId:S.currentId, items:S.items.length, running:S.running, hasMore:S.hasMore, dshStatus:S.dshStatus, me: !!S.me, evtState: S.evtSrc && S.evtSrc.readyState, loginCls: document.getElementById('login').className, appCls: document.getElementById('app').className} : 'no __mc hook' })()`)
console.log('\n=== 内部状态 ===')
console.log(JSON.stringify(state2, null, 2))
