import { existsSync } from 'node:fs'
// 切换对话耗时实测（无头 Chrome + CDP）
// 分别测：首次打开(冷) / 再次打开(命中内存缓存) / 大对话
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
const PORT = 9335
const USERDIR = path.join(ROOT, '.chrome-perf')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'))
const AUTH = { Authorization: 'Bearer ' + cfg.auth.apiKey }

const list = await fetch(APP + 'api/dsh/sessions', { headers: AUTH }).then((r) => r.json())
const sessions = list.sessions || []
const big = sessions.find((s) => /KVMem|部署指南/.test(s.title)) || sessions[1]
const mid = sessions.find((s) => s.id !== big.id && /树洞/.test(s.title)) || sessions[2]
console.log('测试对象：\n  A =', big.title, '\n  B =', mid.title)

const loginRes = await fetch(APP + 'api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: cfg.auth.password })
})
const sid = /mc_sid=([^;]+)/.exec(loginRes.headers.get('set-cookie') || '')?.[1]

await fs.rm(USERDIR, { recursive: true, force: true }).catch(() => {})
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + USERDIR,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--window-size=390,844', 'about:blank'
], { stdio: 'ignore' })

async function waitDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
      const p = l.find((t) => t.type === 'page')
      if (p) return p
    } catch { /* wait */ }
    await sleep(250)
  }
  throw new Error('devtools 未就绪')
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
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || '') }
  return r.result ? r.result.value : undefined
}

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Network.setCookie', { name: 'mc_sid', value: sid, domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: APP })
await sleep(4200)

// 关键指标：从"点击"到"屏幕上出现内容"要多久（不是等接口返回）
const measure = async (sidTarget) => ev(`(async () => {
  const box = document.getElementById('messages')
  const before = box.querySelectorAll('.msg').length
  const t0 = performance.now()
  const p = window.__mc.openSession(${JSON.stringify(sidTarget)})
  // 先看内容什么时候出现（这一步不受接口影响）
  let firstPaint = null
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => requestAnimationFrame(r))
    if (box.querySelectorAll('.msg').length > 0 || box.querySelector('.skeleton')) { firstPaint = performance.now() - t0; break }
  }
  await p
  const done = performance.now() - t0
  await new Promise((r) => requestAnimationFrame(r))
  return {
    firstPaint: firstPaint === null ? null : Math.round(firstPaint),
    settled: Math.round(done),
    msgs: box.querySelectorAll('.msg').length,
    nodes: box.querySelectorAll('*').length
  }
})()`)

console.log('\n--- 冷启动：第一次打开 A（走网络 + 折叠）---')
const r1 = await measure(big.id)
console.log('  ', JSON.stringify(r1))

console.log('\n--- 切到 B（冷）---')
const r2 = await measure(mid.id)
console.log('  ', JSON.stringify(r2))

console.log('\n--- 切回 A（命中浏览器内存缓存）---')
const r3 = await measure(big.id)
console.log('  ', JSON.stringify(r3))

console.log('\n--- 再切回 B（命中缓存）---')
const r4 = await measure(mid.id)
console.log('  ', JSON.stringify(r4))

console.log('\n--- 连续快速切换 10 次（抖动测试）---')
const t0 = Date.now()
await ev(`(async () => {
  const ids = ${JSON.stringify([big.id, mid.id])}
  for (let i = 0; i < 10; i++) { window.__mc.openSession(ids[i % 2]) ; await new Promise(r => setTimeout(r, 60)) }
  return true
})()`)
await sleep(1500)
const finalState = await ev(`({ msgs: document.querySelectorAll('.msg').length, title: document.getElementById('chatTitle').textContent, skeleton: !!document.querySelector('.skeleton') })`)
console.log('  10 次快速切换总耗时(发放):', Date.now() - t0, 'ms  最终状态:', JSON.stringify(finalState))

ws.close()
chrome.kill()
console.log('\n结论：api = 等数据的时间；painted = 到真的画出来；命中缓存时应该在个位数毫秒')
process.exit(0)
