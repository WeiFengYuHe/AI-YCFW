import { existsSync } from 'node:fs'
// 烟测页面.mjs —— 无头 Chrome 实测「页面（连接）」这套 UI
//   1) 进入页面：应该只有一个页面（电脑端 DSH）
//   2) 点「＋ 添加」→ 填一条 OpenAI 兼容连接（指向假上游）→ 保存 → 出现第二个页面
//   3) 切到新页面 → 发一条消息 → 看到假模型的回复
//   4) 截图留证
// 用法：node dev\tools\烟测页面.mjs [端口=8112] [输出名=连接页]
// 前置：自己起 server.mjs（同目录 dev\tools\测试连接接口.ps1 里有示例）和 模拟OpenAI.mjs
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
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
const PORT_DEBUG = 9334
const APP_PORT = Number(process.argv[2] || 8131)
const NAME = process.argv[3] || '连接页'
const MOCK = 'http://127.0.0.1:8199/v1'
const APP = 'http://127.0.0.1:' + APP_PORT + '/'
const OUTDIR = path.join(ROOT, 'docs', 'screenshots')
const USERDIR = path.join(ROOT, '.chrome-smoke')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 自己起假上游（8199）：只要它不在跑就拉一个，测完关掉
const MOCK_PORT = 8199
let mockProc = null
async function ensureMock() {
  try {
    const r = await fetch('http://127.0.0.1:' + MOCK_PORT + '/v1/models', { signal: AbortSignal.timeout(1200) })
    if (r.ok) return false
  } catch { /* 没起 */ }
  mockProc = spawn(process.execPath, [path.join(HERE, '模拟OpenAI.mjs'), String(MOCK_PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + MOCK_PORT + '/v1/models', { signal: AbortSignal.timeout(800) }); if (r.ok) return true } catch { }
    await sleep(250)
  }
  return true
}
await ensureMock()
process.on('exit', () => { try { mockProc?.kill() } catch { } })

// 自带一份临时服务（独立端口 + 临时数据目录），不碰正式 config.json
const TMP_HOME = path.join(os.tmpdir(), 'ycfw-page-test-' + Date.now())
await fs.mkdir(TMP_HOME, { recursive: true })
const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, DSH_YCFW_HOME: TMP_HOME, MC_PORT: String(APP_PORT) }
})
process.on('exit', () => { try { srv.kill() } catch { } })
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(APP + 'api/health', { signal: AbortSignal.timeout(1000) }); if (r.ok) break } catch { }
  await sleep(300)
}
const cfg = JSON.parse(await fs.readFile(path.join(TMP_HOME, 'config.json'), 'utf8'))
const loginRes = await fetch(APP + 'api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: cfg.auth.password })
})
if (!loginRes.ok) throw new Error('登录失败 ' + loginRes.status)
const sid = /mc_sid=([^;]+)/.exec(loginRes.headers.get('set-cookie') || '')?.[1]
if (!sid) throw new Error('拿不到 cookie')
console.log('已取得会话 cookie')

await fs.rm(USERDIR, { recursive: true, force: true }).catch(() => {})
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT_DEBUG, '--user-data-dir=' + USERDIR,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--window-size=420,900', 'about:blank'
], { stdio: 'ignore' })

async function waitDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT_DEBUG + '/json/list')).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch { /* not yet */ }
    await sleep(250)
  }
  throw new Error('Chrome 调试端口没起来')
}
const page = await waitDevtools()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let msgId = 0
const pending = new Map()
const errors = []
ws.addEventListener('message', (ev) => {
  let j
  try { j = JSON.parse(ev.data) } catch { return }
  if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); return }
  if (j.method === 'Runtime.exceptionThrown') errors.push((j.params.exceptionDetails.exception && j.params.exceptionDetails.exception.description) || j.params.exceptionDetails.text)
  if (j.method === 'Network.responseReceived' && j.params.response.status >= 400) errors.push('HTTP ' + j.params.response.status + ' ← ' + j.params.response.url)
})
function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || ''))
  return r.result ? r.result.value : undefined
}

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true })
await send('Network.setCookie', { name: 'mc_sid', value: sid, domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: APP })
await sleep(4500)

const results = []
const check = (ok, msg) => { results.push((ok ? '[OK] ' : '[FAIL] ') + msg); console.log((ok ? '  [OK] ' : '  [FAIL] ') + msg) }

// 1) 初始只有一个页面
const n0 = await ev(`document.querySelectorAll('#connList .conn-item').length`)
const first = await ev(`(document.querySelector('#connList .conn-item .conn-name')||{}).textContent`)
check(n0 <= 1, '初始页面数 ' + n0 + (n0 ? '（' + first + '）' : '（纯净部署：空）'))

// 2) 添加一个 OpenAI 兼容连接
await ev(`document.getElementById('app').classList.add('drawer-open')`)
await sleep(400)
await ev(`document.getElementById('addConn').click()`)
await sleep(600)
const sheetOpen = await ev(`document.getElementById('connSheet').classList.contains('open')`)
check(sheetOpen, '「＋ 添加」打开了添加面板')
// 会话型页面也能填地址/令牌（以前地址是隐藏的，只能连"默认"）
await ev(`document.querySelector('#connKindSeg button[data-kind=dsh]').click()`)
await sleep(200)
const dshForm = await ev(`(() => ({
  url: getComputedStyle(document.getElementById('connUrlRow')).display !== 'none',
  token: getComputedStyle(document.getElementById('connTokenRow')).display !== 'none',
  discover: getComputedStyle(document.getElementById('connDiscoverBtn')).display !== 'none'
}))()`)
check(dshForm.url && dshForm.token && dshForm.discover, '会话型页面能填地址 + 令牌 + 检测本机 DSH')
await ev(`document.getElementById('connName').value = '假模型'`)
await ev(`document.querySelector('#connKindSeg button[data-kind=openai]').click()`)
await sleep(200)
await ev(`document.getElementById('connUrl').value = ${JSON.stringify(MOCK)}`)
await ev(`document.getElementById('connModel').value = 'mock-small'`)
await ev(`document.getElementById('connTestBtn').click()`)
await sleep(2500)
const tOut = await ev(`document.getElementById('connTestOut').textContent`)
check(/✓/.test(String(tOut)), '测试连接：' + String(tOut).slice(0, 60))
await ev(`document.getElementById('connSave').click()`)
await sleep(2500)
const n1 = await ev(`document.querySelectorAll('#connList .conn-item').length`)
check(n1 === n0 + 1, '保存后页面数 ' + n0 + ' → ' + n1)

// 3) 切到新页面并发消息
const active = await ev(`(document.querySelector('#connList .conn-item.on .conn-name')||{}).textContent`)
check(active === '假模型', '自动切到新页面（' + active + '）')
await ev(`document.getElementById('input').value = '你好'`)
await ev(`document.getElementById('input').dispatchEvent(new Event('input'))`)
await ev(`document.getElementById('sendBtn').click()`)
let got = ''
for (let i = 0; i < 40; i++) {
  await sleep(400)
  got = await ev(`(() => { const a = document.querySelectorAll('#messages .msg.assistant'); const l = a[a.length-1]; return l ? l.textContent : '' })()`)
  if (got && got.includes('收到：')) break
}
check(String(got).includes('收到：'), '新页面能对话，回复：' + String(got).slice(0, 40))

// 4) 点当前页面应打开编辑
await ev(`document.getElementById('app').classList.add('drawer-open')`)
await sleep(300)
const hasItem = await ev(`!!document.querySelector('#connList .conn-item.on')`)
if (hasItem) {
  await ev(`document.querySelector('#connList .conn-item.on .conn-edit').click()`)
  await sleep(600)
  const editTitle = await ev(`document.getElementById('connSheetTitle').textContent`)
  check(editTitle === '编辑页面', '页面上的「编辑」= 打开编辑（' + editTitle + '）')
  await ev(`document.getElementById('closeConnSheet').click()`)
  await sleep(300)
} else {
  check(false, '没有当前页面（不该发生：刚添加过）')
}

// 截图
await fs.mkdir(OUTDIR, { recursive: true })
await ev(`document.getElementById('app').classList.add('drawer-open')`)
await sleep(600)
const shot = await send('Page.captureScreenshot', { format: 'png' })
const file = path.join(OUTDIR, NAME + '.png')
await fs.writeFile(file, Buffer.from(shot.data, 'base64'))

// 收尾：把测试加的连接删掉，别污染真实配置
try {
  const list = await (await fetch(APP + 'api/connections', { headers: { Cookie: 'mc_sid=' + sid } })).json()
  for (const c of (list.connections || [])) {
    if (c.name === '假模型') {
      await fetch(APP + 'api/connections/' + c.id, { method: 'DELETE', headers: { Cookie: 'mc_sid=' + sid } })
      console.log('已清理测试连接：' + c.name)
    }
  }
} catch { /* 清理失败不影响结论 */ }
console.log('\n截图：' + file)
console.log('JS/网络错误：' + (errors.length ? errors.slice(-5).join(' | ') : '无'))
console.log('结果：' + (results.every((r) => r.startsWith('[OK]')) ? '全部通过' : results.filter((r) => r.startsWith('[FAIL]')).length + ' 项失败'))
ws.close(); chrome.kill(); await fs.rm(TMP_HOME, { recursive: true, force: true }).catch(() => {})
process.exit(results.some((r) => r.startsWith('[FAIL]')) ? 1 : 0)