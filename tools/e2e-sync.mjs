import { existsSync } from 'node:fs'
// 端到端双端同步实测
//   设备A = 直接打 API/SSE 的"电脑端代理"
//   设备B = 无头 Chrome 里跑的手机界面
// 验证：
//   A 发问 → B 界面实时看到（流式）
//   B 点发送 → A 的 SSE 收到 user/message，且 DSH 会话历史里真的多了这条
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
const PORT = 9334
const USERDIR = path.join(ROOT, '.chrome-e2e')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'))
const AUTH = { Authorization: 'Bearer ' + cfg.auth.apiKey, 'Content-Type': 'application/json' }

function log(...a) { console.log(...a) }

// ---------- 1) 建一个一次性测试会话 ----------
const smokeDir = path.join(ROOT, 'data', '_smoke')
await fs.mkdir(smokeDir, { recursive: true })

const created = await fetch(APP + 'api/dsh/sessions', {
  method: 'POST',
  headers: AUTH,
  body: JSON.stringify({ cwd: smokeDir })
}).then((r) => r.json())
if (!created.sessionId) throw new Error('建会话失败：' + JSON.stringify(created))
const SID = created.sessionId
log('测试会话：', SID)

// ---------- 2) 设备A：订阅我服务的 SSE ----------
const sseSeen = []
let sseText = ''
const ac = new AbortController()
;(async () => {
  const r = await fetch(APP + 'api/events', { headers: AUTH, signal: ac.signal })
  const rd = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await rd.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop()
    for (const f of frames) {
      const lines = f.split('\n')
      const evLine = lines.find((l) => l.startsWith('event: '))
      const dataLine = lines.find((l) => l.startsWith('data: '))
      if (!evLine || !dataLine) continue
      const ev = evLine.slice(7)
      let data
      try { data = JSON.parse(dataLine.slice(6)) } catch { continue }
      if (ev !== 'dsh') continue
      if (data.method !== 'session/event') continue
      if (data.payload.sessionId !== SID) continue
      const e = data.payload.event
      sseSeen.push(e.type)
      if (e.type === 'assistant/chunk' && e.data.chunk.type === 'text-delta') sseText += e.data.chunk.text
    }
  }
})().catch(() => {})

// ---------- 3) 设备B：无头 Chrome 打开手机界面 ----------
const loginRes = await fetch(APP + 'api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: cfg.auth.password })
})
const sidCookie = /mc_sid=([^;]+)/.exec(loginRes.headers.get('set-cookie') || '')?.[1]
if (!sidCookie) throw new Error('拿不到 cookie')

await fs.rm(USERDIR, { recursive: true, force: true }).catch(() => {})
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + USERDIR,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--window-size=390,844', 'about:blank'
], { stdio: 'ignore' })

async function waitDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch { /* wait */ }
    await sleep(250)
  }
  throw new Error('chrome devtools 没起来')
}
const page = await waitDevtools()
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
await send('Network.setCookie', { name: 'mc_sid', value: sidCookie, domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: APP })
await sleep(4000)
log('手机界面已打开')
await ev(`window.__mc.openSession('${SID}')`)
await sleep(2500)
log('已切到测试会话，当前 DOM 消息数 =', await ev(`document.querySelectorAll('.msg').length`))

// ---------- 4) 方向 A→B：API 发问，看界面是否实时收到 ----------
log('\n--- 方向 A→B：从"另一端"(API) 发消息 ---')
const PROMPT = '只回复四个字：收到收到。不要调用任何工具，不要解释。'
await fetch(APP + 'api/dsh/sessions/' + SID + '/prompt', {
  method: 'POST', headers: AUTH, body: JSON.stringify({ text: PROMPT, mode: 'queue' })
})

let domText = ''
let sawUserBubble = false
const t0 = Date.now()
while (Date.now() - t0 < 120000) {
  await sleep(1500)
  const st = await ev(`(() => {
    const users = [...document.querySelectorAll('.msg.user .bubble')].map(e => e.textContent)
    const asst = [...document.querySelectorAll('.msg.assistant .md')].map(e => e.textContent).join('')
    const think = [...document.querySelectorAll('.think-title')].map(e => e.textContent)
    return { users, asst, think, stop: document.getElementById('sendBtn').classList.contains('stop') }
  })()`)
  if (st && st.users && st.users.some((u) => u.includes('收到收到') || u.includes('只回复四个字'))) sawUserBubble = true
  domText = (st && st.asst) || ''
  if (domText.includes('收到收到') && !st.stop) break
  if (Date.now() - t0 > 10000 && domText.length > 2 && !st.stop) break
}
log('  界面看到自己的提问气泡：', sawUserBubble)
log('  界面收到的回答：', JSON.stringify(domText.slice(0, 120)))
const counts = {}
for (const t of sseSeen) counts[t] = (counts[t] || 0) + 1
log('  SSE(另一端) 收到的帧统计：', JSON.stringify(counts))
log('  SSE(另一端) 收到的流式文本：', JSON.stringify(sseText.slice(0, 120)))

const shot1 = await send('Page.captureScreenshot', { format: 'png' })
await fs.mkdir(path.join(ROOT, 'docs', 'screenshots'), { recursive: true })
await fs.writeFile(path.join(ROOT, 'docs', 'screenshots', 'e2e-stream.png'), Buffer.from(shot1.data, 'base64'))

// ---------- 5) 方向 B→A：手机界面点发送 ----------
log('\n--- 方向 B→A：从"手机界面"点发送 ---')
const MARK = '手机端发的第二条-' + Date.now().toString(36)
await ev(`(() => {
  const inp = document.getElementById('input')
  inp.value = ${JSON.stringify(MARK)}
  inp.dispatchEvent(new Event('input'))
  document.getElementById('sendBtn').click()
  return true
})()`)
let gotUserFrame = false
const t1 = Date.now()
while (Date.now() - t1 < 45000) {
  await sleep(1200)
  const hist = await fetch(APP + 'api/dsh/sessions/' + SID + '/history?maxMessages=20', { headers: AUTH }).then((r) => r.json())
  const found = (hist.items || []).some((it) => it.kind === 'user' && (it.text || '').includes(MARK))
  if (found) { gotUserFrame = true; break }
}
log('  DSH 会话历史里出现手机端发的那条：', gotUserFrame)
log('  SSE 是否也收到了 user/message：', sseSeen.includes('user/message'))

await sleep(2500)
const shot2 = await send('Page.captureScreenshot', { format: 'png' })
await fs.writeFile(path.join(ROOT, 'docs', 'screenshots', 'e2e-send.png'), Buffer.from(shot2.data, 'base64'))

// ---------- 6) 收尾 ----------
ac.abort()
ws.close()
chrome.kill()

log('\n=== 结论 ===')
const pass1 = sawUserBubble && domText.length > 0
const pass2 = gotUserFrame
log('  A→B（一端发，另一端界面实时看到）：', pass1 ? 'PASS' : 'FAIL')
log('  B→A（界面发，另一端/历史收到）：', pass2 ? 'PASS' : 'FAIL')
log('  测试会话 id：', SID)
try {
  await fetch(APP + 'api/dsh/sessions/' + SID + '/rename', { method: 'POST', headers: AUTH, body: JSON.stringify({ title: '【自检】双端同步验证（可忽略）' }) })
} catch { }
process.exit(0)
