// 测试接口.mjs —— 纯 Node 的接口层测试（不需要 PowerShell）
//   1) 用临时数据目录 + 临时端口起一份服务（不碰正式配置）
//   2) 登录 → 连接 CRUD → 测试连接（假 OpenAI）→ 发消息 → 读到回复 → 删除
//   3) 自启动：读状态 → 关 → 开（Windows 计划任务，测完恢复原状）
// 用法：node tools\测试接口.mjs
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const SERVER = path.join(ROOT, 'server', 'server.mjs')
const MOCK = path.join(HERE, '模拟OpenAI.mjs')
const PORT = 8123
const MOCK_PORT = 8199
const HOME = path.join(os.tmpdir(), 'ycfw-api-test-' + Date.now())

let pass = 0, fail = 0
const check = (ok, msg) => { if (ok) { pass++; console.log('  [OK] ' + msg) } else { fail++; console.log('  [FAIL] ' + msg) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, ms = 30000, step = 300) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(step) }
  return false
}

let server, mock
try {
  await fs.mkdir(HOME, { recursive: true })
  mock = spawn(process.execPath, [MOCK, String(MOCK_PORT)], { stdio: 'ignore' })
  check(await waitFor(async () => { try { const r = await fetch('http://127.0.0.1:' + MOCK_PORT + '/v1/models'); return r.ok } catch { return false } }), '假上游已起')

  server = spawn(process.execPath, [SERVER], { cwd: ROOT, env: { ...process.env, DSH_YCFW_HOME: HOME, MC_PORT: String(PORT) }, stdio: 'ignore' })
  check(await waitFor(async () => { try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/health'); return r.ok } catch { return false } }), '网页端已起')

  const cfg = JSON.parse(await fs.readFile(path.join(HOME, 'config.json'), 'utf8'))
  const login = await fetch('http://127.0.0.1:' + PORT + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: cfg.auth.password }) })
  const cookie = /mc_sid=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1]
  check(!!cookie, '登录成功')

  const api = async (p, opt = {}) => {
    const r = await fetch('http://127.0.0.1:' + PORT + '/api' + p, {
      method: opt.method || 'GET',
      headers: { Cookie: 'mc_sid=' + cookie, ...(opt.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opt.body ? JSON.stringify(opt.body) : undefined
    })
    return r.json()
  }

  // 初始只有内置页面
  const me0 = await api('/me')
  check(me0.connections.length === 0, '纯净部署初始没有页面（剩 ' + me0.connections.length + ' 个）')
  check(Array.isArray(me0.presets) && me0.presets.length >= 5, '自带 ' + (me0.presets || []).length + ' 个预设')

  // 添加 openai 连接 + 测试
  const add = await api('/connections', { method: 'POST', body: { name: '测试模型', kind: 'openai', baseUrl: 'http://127.0.0.1:' + MOCK_PORT + '/v1', model: 'mock-small', autoOpen: true } })
  check(add.ok === true && add.connection.autoOpen === true, '添加 openai 页面（autoOpen 保存）')
  const t = await api('/connections/' + add.connection.id + '/test', { method: 'POST' })
  check(t.ok === true, '测试连接：' + String(t.detail).slice(0, 40))

  // 发消息 → 等回复
  const chat = await api('/conn/' + add.connection.id + '/chat', { method: 'POST', body: { text: '你好' } })
  check(chat.ok === true, '发消息（会话 ' + chat.conversationId + '）')
  let content = ''
  await waitFor(async () => {
    const d = await api('/conn/' + add.connection.id + '/conversations/' + chat.conversationId)
    const last = d.messages && d.messages[d.messages.length - 1]
    if (last && last.role === 'assistant' && last.status === 'done') { content = String(last.content); return true }
    return false
  }, 30000)
  check(content.includes('收到'), '拿到回复：' + content.slice(0, 30))

  // 老路径兼容
  const legacy = await api('/local/conversations')
  check(Array.isArray(legacy.conversations) && legacy.conversations.length >= 1, '/api/local/* 老路径仍可用')

  // 本地页面：会话可以真正删除
  const delConv = await api('/conn/' + add.connection.id + '/conversations/' + chat.conversationId, { method: 'DELETE' })
  check(delConv.ok === true, '本地会话可删除')

  // 会话型页面必须填地址（不再偷偷用"默认"）
  const noAddr = await api('/connections', { method: 'POST', body: { name: '没有地址', kind: 'dsh' } })
  check(!!noAddr.error, '会话型页面缺地址会被拒绝：' + String(noAddr.error || '').slice(0, 30))

  // 删除连接
  await api('/connections/' + add.connection.id, { method: 'DELETE' })
  const me2 = await api('/me')
  check(me2.connections.length === 0, '删除后回到 0 个页面')

  // 备份：设部署端密码 → 立即备份 → 下载 ZIP（多一层密码）
  const bkDir = path.join(HOME, 'bk-out')
  const bc = await api('/backup/config', { method: 'POST', body: { newPassword: 'deploypass123', dir: bkDir, enabled: true } })
  check(bc.ok === true && bc.hasPassword === true, '备份设置 + 部署端密码')
  const br = await api('/backup/run', { method: 'POST', body: { password: 'deploypass123' } })
  check(br.ok === true && br.files >= 1, '立即备份（' + br.files + ' 个文件）')
  const dl = await fetch('http://127.0.0.1:' + PORT + '/api/backup/download', {
    method: 'POST',
    headers: { Cookie: 'mc_sid=' + cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'deploypass123' })
  })
  const zip = Buffer.from(await dl.arrayBuffer())
  check(dl.ok && dl.headers.get('content-type') === 'application/zip' && zip.length > 100 && zip[0] === 0x50 && zip[1] === 0x4b, '下载备份 ZIP（' + zip.length + ' 字节）')
  const badPw = await fetch('http://127.0.0.1:' + PORT + '/api/backup/download', {
    method: 'POST',
    headers: { Cookie: 'mc_sid=' + cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-pass' })
  })
  check(badPw.status === 401, '错误的部署端密码拿不到备份')

  // 自启动：读状态 → 关 → 开（恢复）
  const st0 = await api('/settings')
  check(st0.autostart && st0.autostart.supported === true, '自启动状态可读（installed=' + st0.autostart.installed + '）')
  const off = await api('/settings/autostart', { method: 'POST', body: { enable: false } })
  check(off.ok === true && off.autostart.installed === false, '关闭自启动')
  const on = await api('/settings/autostart', { method: 'POST', body: { enable: true } })
  check(on.ok === true && on.autostart.installed === true, '开启自启动（恢复原状）')
} catch (e) {
  fail++
  console.log('  [FAIL] 异常：' + e.message)
} finally {
  try { server?.kill() } catch { }
  try { mock?.kill() } catch { }
  await fs.rm(HOME, { recursive: true, force: true }).catch(() => { })
  console.log('\n==== 通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  process.exit(fail ? 1 : 0)
}
