const CHROME = process.env.CHROME_PATH || 'chrome'
// 验证：Service Worker 是否在把旧版本发给已访问过的浏览器
//  1) 首次访问（安装 SW）
//  2) 改 app.js 加一个标记
//  3) 重新打开同一份 profile，检查页面里实际运行的 app.js 有没有那个标记
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ROOT = process.env.YCFW_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = 'http://127.0.0.1:8100/'
const PORT = 9350
const USERDIR = path.join(ROOT, '.chrome-swtest')
const APPJS = path.join(ROOT, 'public', 'app.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'))
const lr = await fetch(APP + 'api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: cfg.auth.password })
})
const sid = /mc_sid=([^;]+)/.exec(lr.headers.get('set-cookie') || '')?.[1]

await fs.rm(USERDIR, { recursive: true, force: true }).catch(() => {})

async function openProfile(stage) {
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + USERDIR,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=390,844', 'about:blank'
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
  const send = (m, p = {}) => new Promise((res, rej) => {
    const i = ++id
    pending.set(i, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result)))
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      console.log('  [eval error]', r.exceptionDetails.text, r.exceptionDetails.exception && r.exceptionDetails.exception.description)
      return undefined
    }
    return r.result ? r.result.value : undefined
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setCookie', { name: 'mc_sid', value: sid, domain: '127.0.0.1', path: '/' })
  if (stage > 1) {
    // 第二次之后：不要缓存禁用，模拟真实用户
  }
  return { chrome, send, ev, ws }
}

// 现在 app.js 是内联进首页的，所以要看"页面里实际执行的脚本"有没有标记
const probe = `(async () => {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller
  const inline = [...document.scripts].map(s => s.textContent || '').join(' ')
  return {
    controlled: !!sw,
    hasMarker: inline.includes('SW-STALE-MARKER'),
    groups: document.querySelectorAll('.ws-head').length,
    rows: document.querySelectorAll('#convList .conv').length,
    htmlBytes: document.documentElement.innerHTML.length
  }
})()`

// ---------- 第一次访问 ----------
let h = await openProfile(1)
await h.send('Page.navigate', { url: APP })
await sleep(4000)
console.log('第 1 次访问（安装 SW）:')
console.log('  ', JSON.stringify(await h.ev(probe)))
h.ws.close(); h.chrome.kill()
await sleep(600)

// ---------- 改文件 ----------
const original = await fs.readFile(APPJS, 'utf8')
await fs.writeFile(APPJS, original + '\n/* SW-STALE-MARKER */\n', 'utf8')
console.log('\n已在 public/app.js 末尾加上标记 SW-STALE-MARKER')

// ---------- 第二次访问（同一 profile，等价于用户刷新）----------
h = await openProfile(2)
await h.send('Page.navigate', { url: APP })
await sleep(4000)
const second = await h.ev(probe)
console.log('第 2 次访问（模拟用户刷新/重开）:')
console.log('  ', JSON.stringify(second))
h.ws.close(); h.chrome.kill()
await sleep(400)

// ---------- 第三次：reload ----------
h = await openProfile(3)
await h.send('Page.navigate', { url: APP })
await sleep(1500)
await h.send('Page.reload', { ignoreCache: false })
await sleep(3000)
const third = await h.ev(probe)
console.log('第 3 次访问（普通 reload）:')
console.log('  ', JSON.stringify(third))
h.ws.close(); h.chrome.kill()

// 还原文件
await fs.writeFile(APPJS, original, 'utf8')
await fs.rm(USERDIR, { recursive: true, force: true }).catch(() => {})
console.log('\n结论：hasMarker=false 就说明 SW 给的是旧文件（用户看到的不是最新版）')
console.log('  第二次 hasMarker =', second.hasMarker, ' 第三次 =', third.hasMarker)
console.log('  分组数 =', third.groups, '（0 表示旧版本没有工作区分组）')
process.exit(0)
