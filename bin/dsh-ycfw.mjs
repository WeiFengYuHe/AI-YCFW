#!/usr/bin/env node
// ============================================================================
//  dsh-ycfw —— 唯一的命令行入口（启动 / 停止 / 状态 / 开机自启）
//  ---------------------------------------------------------------------------
//  用法：
//    npx dsh-ycfw                  起服务并打开浏览器（= npm start）
//    dsh-ycfw --no-open            只起服务
//    dsh-ycfw --port 8200          换端口
//    dsh-ycfw --home D:\my-chat    配置/会话放这个目录（默认跟程序放一起）
//    dsh-ycfw stop                 停掉正在跑的那份（调 /api/shutdown，只认本机 + apiKey）
//    dsh-ycfw status               看现在跑没跑、自启开没开
//    dsh-ycfw autostart on|off     开关"登录时自动启动"（Windows 计划任务）
//
//  2026-11-18 晚：按用户要求把 PowerShell 那套（启动/停止/守护/控制/安装/隧道）
//  的职责全部收进这个入口 + 网页里的设置页，仓库里不再需要任何 .ps1。
// ============================================================================
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, accessSync, readFileSync, constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.join(HERE, '..')
const SERVER = path.join(PKG_ROOT, 'server', 'server.mjs')
const SELF = fileURLToPath(import.meta.url)
const TASK_NAME = 'DSH-YCFW'
const IS_WIN = process.platform === 'win32'

function parseArgs(argv) {
  const out = { open: true, cmd: 'start' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-open') out.open = false
    else if (a === '--open') out.open = true
    else if (a === '--port' || a === '-p') out.port = argv[++i]
    else if (a === '--host') out.host = argv[++i]
    else if (a === '--home' || a === '--data') out.home = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--version' || a === '-v') out.version = true
    else if (['start', 'stop', 'status', 'autostart'].includes(a)) {
      out.cmd = a
      out.rest = argv.slice(i + 1)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(`dsh-ycfw —— DSH 网页端（可手动添加页面 / OpenAI 兼容接口）

用法：
  dsh-ycfw [选项]              启动（npm start 等价）
  dsh-ycfw stop                 停掉正在跑的那份
  dsh-ycfw status               看运行状态与开机自启
  dsh-ycfw autostart on|off     开关登录自启（Windows 计划任务）

选项：
  -p, --port <n>     端口（默认 8100，也可写进 config.json）
      --host <ip>    监听地址（默认 0.0.0.0）
      --home <dir>   配置与会话放哪个目录（默认：程序目录；不可写时用 ~/.dsh-ycfw）
      --no-open      不要自动打开浏览器
  -v, --version      版本
  -h, --help         这段帮助

数据目录里的东西：
  config.json        端口、登录口令、页面（连接）列表
  data/              各连接的会话记录
  logs/              server.log
`);
  process.exit(0)
}
if (args.version) {
  const pkg = JSON.parse(intrinsicRead(path.join(PKG_ROOT, 'package.json')))
  console.log('dsh-ycfw ' + pkg.version)
  process.exit(0)
}

function intrinsicRead(p) { return readFileSync(p, 'utf8') }

if (!existsSync(SERVER)) {
  console.error('找不到 ' + SERVER + '，包可能不完整')
  process.exit(1)
}

// ---- 数据目录：显式 > 环境变量 > 程序目录（可写就用）> 用户目录 ----
function pickHome() {
  if (args.home) return path.resolve(args.home)
  if (process.env.DSH_YCFW_HOME) return path.resolve(process.env.DSH_YCFW_HOME)
  try {
    accessSync(PKG_ROOT, constants.W_OK)
    return PKG_ROOT
  } catch { /* 无写权限（npm i -g 常见） */ }
  return path.join(os.homedir(), '.dsh-ycfw')
}
const HOME = pickHome()
function readConfig() {
  try { return JSON.parse(intrinsicRead(path.join(HOME, 'config.json'))) } catch { return null }
}
function targetPort() {
  const cfg = readConfig() || {}
  return Number(args.port || process.env.MC_PORT || cfg.port || 8100)
}

// ---- 端口探测：free / ours / other ----
async function probePort(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(1500) })
    if (r.ok) {
      const j = await r.json().catch(() => null)
      if (j && j.ok === true) return 'ours'
    }
    return 'other'
  } catch { return 'free' }
}

function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const a = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    spawn(cmd, a, { detached: true, stdio: 'ignore' }).unref()
    console.log('[dsh-ycfw] 已在浏览器打开：' + url)
  } catch (e) { console.log('[dsh-ycfw] 打开浏览器失败：' + e.message) }
}

// ---------------- 开机自启（Windows 计划任务）----------------
function taskInstalled() {
  if (!IS_WIN) return false
  try {
    execFileSync('schtasks', ['/query', '/tn', TASK_NAME], { stdio: 'ignore', timeout: 8000, windowsHide: true })
    return true
  } catch { return false }
}

function taskInstall() {
  if (!IS_WIN) throw new Error('自启动目前只支持 Windows（用计划任务实现）')
  const node = process.execPath
  const tr = '"' + node + '" "' + SELF + '" --no-open'
  // /sc onlogon：登录时启动；不给 /ru 就用当前用户、只在登录会话里跑（不会要密码）
  execFileSync('schtasks', ['/create', '/f', '/tn', TASK_NAME, '/tr', tr, '/sc', 'onlogon', '/rl', 'LIMITED'], { timeout: 60000, windowsHide: true })
}

function taskRemove() {
  if (!IS_WIN) return
  try {
    execFileSync('schtasks', ['/delete', '/f', '/tn', TASK_NAME], { timeout: 30000, windowsHide: true })
  } catch { /* 本来就没有 */ }
}

// ---------------- 子命令 ----------------
if (args.cmd === 'status') {
  const port = targetPort()
  const probe = await probePort(port)
  console.log('[dsh-ycfw] 数据目录：' + HOME)
  console.log('  服务：' + (probe === 'ours' ? '运行中 → http://127.0.0.1:' + port + '/' : probe === 'other' ? '端口被别的程序占用' : '没在跑'))
  console.log('  自启动：' + (IS_WIN ? (taskInstalled() ? '已开启（计划任务 ' + TASK_NAME + '）' : '未开启') : '仅 Windows 支持'))
  process.exit(probe === 'ours' ? 0 : 1)
}

if (args.cmd === 'autostart') {
  const v = String((args.rest || [])[0] || '').toLowerCase()
  if (v !== 'on' && v !== 'off') {
    console.error('用法：dsh-ycfw autostart on|off')
    process.exit(2)
  }
  try {
    if (v === 'on') { taskInstall(); console.log('[dsh-ycfw] 已开启：登录 Windows 时自动启动（计划任务 ' + TASK_NAME + '）') }
    else { taskRemove(); console.log('[dsh-ycfw] 已关闭登录自启（当前正在跑的服务不受影响）') }
    process.exit(taskInstalled() === (v === 'on') ? 0 : 1)
  } catch (e) {
    console.error('[dsh-ycfw] 设置自启失败：' + e.message)
    process.exit(1)
  }
}

if (args.cmd === 'stop') {
  const cfg = readConfig()
  const port = targetPort()
  const key = cfg && cfg.auth && cfg.auth.apiKey
  const probe = await probePort(port)
  if (probe !== 'ours') {
    console.log('[dsh-ycfw] 没有在跑的实例（或端口被别的程序占着）')
    process.exit(probe === 'other' ? 2 : 0)
  }
  if (!key) {
    console.error('[dsh-ycfw] 找不到 config.json 里的 auth.apiKey，没法优雅停止')
    process.exit(1)
  }
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/shutdown', {
      method: 'POST',
      headers: { 'X-Api-Key': key },
      signal: AbortSignal.timeout(5000)
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    for (let i = 0; i < 30; i++) {
      if ((await probePort(port)) !== 'ours') { console.log('[dsh-ycfw] 已停止'); process.exit(0) }
      await new Promise((r2) => setTimeout(r2, 200))
    }
    console.error('[dsh-ycfw] 请求已发出，但端口还在；可能是别的进程占着')
    process.exit(1)
  } catch (e) {
    console.error('[dsh-ycfw] 停止失败：' + e.message)
    process.exit(1)
  }
}

// ---------------- 默认：启动 ----------------
try { mkdirSync(path.join(HOME, 'data'), { recursive: true }); mkdirSync(path.join(HOME, 'logs'), { recursive: true }) } catch (e) {
  console.error('数据目录建不出来：' + HOME + ' — ' + e.message)
  process.exit(1)
}
console.log('[dsh-ycfw] 数据目录：' + HOME)

const port = targetPort()
const probe = await probePort(port)
if (probe === 'ours') {
  const url = 'http://127.0.0.1:' + port + '/'
  console.log('[dsh-ycfw] 端口 ' + port + ' 上已经有一个本项目的实例在跑（可能是登录自启起的）。')
  console.log('         直接用它即可：' + url)
  console.log('         想停掉：dsh-ycfw stop　｜　想再起一个：--port 8200')
  if (args.open) openBrowser(url)
  process.exit(0)
}
if (probe === 'other') {
  console.error('[dsh-ycfw] 端口 ' + port + ' 被别的程序占用了，换一个：--port 8200')
  process.exit(2)
}

const env = Object.assign({}, process.env, {
  DSH_YCFW_HOME: HOME,
  MC_PORT: args.port ? String(args.port) : (process.env.MC_PORT || ''),
  MC_HOST: args.host ? String(args.host) : (process.env.MC_HOST || ''),
  YCFW_OPEN: args.open ? '1' : '0'
})
if (!env.MC_PORT) delete env.MC_PORT
if (!env.MC_HOST) delete env.MC_HOST

const child = spawn(process.execPath, [SERVER], { env, stdio: 'inherit', windowsHide: false })
child.on('exit', (code) => process.exit(code == null ? 0 : code))
for (const sig of ['SIGINT', 'SIGTERM']) {
  try { process.on(sig, () => { try { child.kill(sig) } catch { /* ignore */ } }) } catch { /* ignore */ }
}
