import { existsSync } from 'node:fs'
// 烟测-设置与删除.mjs —— 无头 Chrome 验证：
//   1) 设置面板出现「自启动」分组（随系统登录自启 / 上游策略 / 手动启动命令）
//   2) 页面可以真正删除（删到 0 个时显示"先加一个页面"）
//   3) 删掉后能重新添加回来
// 用法：node dev\tools\烟测-设置与删除.mjs [端口=8100]
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
const DEBUG_PORT = 9335
const APP_PORT = Number(process.argv[2] || 8130)
const APP = 'http://127.0.0.1:' + APP_PORT + '/'
const USERDIR = path.join(ROOT, '.chrome-settings')
const OUTDIR = path.join(ROOT, 'docs', 'screenshots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 自带一份临时服务（独立端口 + 临时数据目录），不碰正式 config.json
const TMP_HOME = path.join(os.tmpdir(), 'ycfw-ui-test-' + Date.now())
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
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: cfg.auth.password })
})
const sid = /mc_sid=([^;]+)/.exec(loginRes.headers.get('set-cookie') || '')?.[1]
if (!sid) throw new Error('拿不到 cookie')

await fs.rm(USERDIR, { recursive: true, force: true }).catch(() => {})
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + USERDIR,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--window-size=420,900', 'about:blank'
], { stdio: 'ignore' })

async function waitDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list')).json()
      const p = list.find((t) => t.type === 'page')
      if (p) return p
    } catch { /* wait */ }
    await sleep(250)
  }
  throw new Error('chrome 没起来')
}
const page = await waitDevtools()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let id = 0
const pending = new Map()
const errors = []
ws.addEventListener('message', (ev) => {
  let j; try { j = JSON.parse(ev.data) } catch { return }
  if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); return }
  if (j.method === 'Runtime.exceptionThrown') errors.push('JS异常: ' + (j.params.exceptionDetails.text || ''))
  if (j.method === 'Network.responseReceived' && j.params.response.status >= 400) errors.push('HTTP ' + j.params.response.status + ' ← ' + j.params.response.url)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id
  pending.set(mid, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)))
  ws.send(JSON.stringify({ id: mid, method, params }))
})
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
// confirm() 一律返回 true（删除确认框）
await ev(`window.confirm = () => true`)

let pass = 0, fail = 0
const check = (ok, msg) => { if (ok) { pass++; console.log('  [OK] ' + msg) } else { fail++; console.log('  [FAIL] ' + msg) } }

// ---------- 1) 设置面板：自启动 ----------
await ev(`document.getElementById('openSettings').click()`)
await sleep(1200)
const hasAuto = await ev(`!!document.getElementById('setAutoBoot') && !!document.getElementById('setNpmCmd')`)
check(hasAuto, '设置面板里有「自启动」：登录自启开关 + 手动启动命令')
const hasBackup = await ev(`!!document.getElementById('setBackupOn') && !!document.getElementById('backupExportBtn') && !!document.getElementById('backupList')`)
check(hasBackup, '设置面板里有「备份」：自动备份 + 部署端密码 + 导出记录')
const navBackup = await ev(`!!document.querySelector('#setNav button[data-go="setBackupSection"]')`)
check(navBackup, '设置顶部有分区导航（能直接跳到备份）')
const bootState = await ev(`(() => { const b = document.getElementById('setAutoBoot'); const h = document.getElementById('setAutoBootHint'); return { boot: b.checked, disabled: b.disabled, hint: (h.textContent||'').slice(0,40), cmd: document.getElementById('setNpmCmd').textContent } })()`)
check(typeof bootState.boot === 'boolean', '自启开关可读：' + JSON.stringify(bootState))
check(bootState.cmd === 'npm start', '手动启动命令显示为 npm start')
// 设置面板开着的时候截一张（滚到自启动那一块）
await ev(`document.getElementById('setAutoBoot').scrollIntoView({ block: 'center' })`)
await sleep(600)
await fs.mkdir(OUTDIR, { recursive: true })
{
  const s1 = await send('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(path.join(OUTDIR, '设置-自启动.png'), Buffer.from(s1.data, 'base64'))
}
await ev(`document.getElementById('closeSheet').click()`)
await sleep(400)

// ---------- 2) 删除页面（删到 0）----------
const n0 = await ev(`document.querySelectorAll('#connList .conn-item').length`)
for (let i = 0; i < 5; i++) {
  const n = await ev(`document.querySelectorAll('#connList .conn-item').length`)
  if (!n) break
  await ev(`document.querySelector('#connList .conn-item').click()`)
  await sleep(700)
  await ev(`document.getElementById('connDelete').click()`)
  await sleep(1500)
}
const n1 = await ev(`document.querySelectorAll('#connList .conn-item').length`)
const emptyText = await ev(`(document.querySelector('.conn-empty')||{}).textContent || ''`)
const welcome = await ev(`(() => { const w = document.querySelector('.welcome'); return w ? w.textContent.slice(0,30) : '' })()`)
check(n1 === 0, '页面能删光（' + n0 + ' → ' + n1 + ' 个）')
check(/还没有页面/.test(emptyText) || /先加一个页面/.test(welcome), '删光后有空状态引导（' + (emptyText || welcome) + '）')

// ---------- 3) 再加回来 ----------
await ev(`document.getElementById('app').classList.add('drawer-open')`)
await sleep(300)
await ev(`document.getElementById('addConn').click()`)
await sleep(700)
await ev(`document.querySelector('#connKindSeg button[data-kind=dsh]').click()`)
await sleep(200)
await ev(`document.getElementById('connName').value = '电脑端 DSH'`)
await ev(`document.getElementById('connUrl').value = 'http://127.0.0.1:3080'`)
await ev(`document.getElementById('connAutoOpen').checked = true`)
await ev(`document.getElementById('connSave').click()`)
await sleep(1800)
const n2 = await ev(`document.querySelectorAll('#connList .conn-item').length`)
const autoOpen = await ev(`(() => { const c = (window.__mc && window.__mc.S && window.__mc.S.conns || []).find(x => x.autoOpen); return c ? c.name : '' })()`)
check(n2 === 1, '重新添加页面成功（现在 ' + n2 + ' 个）')
check(!!autoOpen, '「启动时默认打开」已保存（' + autoOpen + '）')

await fs.mkdir(OUTDIR, { recursive: true })
const shot = await send('Page.captureScreenshot', { format: 'png' })
await fs.writeFile(path.join(OUTDIR, '设置与删除.png'), Buffer.from(shot.data, 'base64'))
console.log('\n截图：' + path.join(OUTDIR, '设置与删除.png'))
console.log('JS/网络错误：' + (errors.length ? errors.slice(-4).join(' | ') : '无'))
console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项')
ws.close(); chrome.kill(); await fs.rm(TMP_HOME, { recursive: true, force: true }).catch(() => {})
process.exit(fail ? 1 : 0)
