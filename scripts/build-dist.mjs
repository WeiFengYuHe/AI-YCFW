// 打包纯净部署包：dist/<包名>-<版本>/ 和 .zip
// 只带运行必需的东西；config.json / data / logs / 测试工具 / 截图 一律不进包。
// 用法：node scripts\build-dist.mjs
//
// 重要：本文件不允许写入任何真实凭据、真实主机名或本机绝对路径字面量——
// 之前它曾把真实口令当"检测样本"写死，等于把 config.json 抄进源码。
// 现在只用**通用形式**的检测规则（不指向任何具体密钥）。
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
const DIST = path.join(ROOT, 'dist')
const NAME = pkg.name + '-' + pkg.version
const OUT = path.join(DIST, NAME)

// 部署包里必须有：运行代码 + 示例配置 + 文档
const FILES = [
  'bin',
  'server',
  'config.example.json',
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'SECURITY.md',
  'CONTRIBUTING.md'
]

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else out.push(p)
  }
  return out
}

// 只在项目自己的 dist/ 下清理（不碰任何用户目录）
await fs.rm(DIST, { recursive: true, force: true })
await fs.mkdir(OUT, { recursive: true })
for (const f of FILES) {
  const s = path.join(ROOT, f)
  try { await fs.cp(s, path.join(OUT, f), { recursive: true }) } catch (e) { console.warn('跳过 ' + f + '：' + e.message) }
}

// ---- 纯净性检查：通用规则，不含任何具体凭据 ----
const RULES = [
  { re: /[A-Za-z]:\\+Users\\+/i, name: 'Windows 用户目录绝对路径' },
  { re: /[A-Za-z]:\\+(?:AI工作区|QWBD)\\+/i, name: '本机项目根路径' },
  { re: /tail[a-z0-9]{6,}\.ts\.net/i, name: '个人私有域名（tailnet）' },
  { re: /\bmc_[0-9a-f]{24,}\b/i, name: '形似本机生成的对外 API Key' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, name: '形似 OpenAI 风格密钥' },
  { re: /"apiKey"\s*:\s*"[^"]{8,}"/, name: '配置里的非空 apiKey' },
  { re: /"password"\s*:\s*"[^"]{4,}"/, name: '配置里的非空口令' }
]

const files = await walk(OUT)
const leaks = []
for (const f of files) {
  if (/\.(png|jpe?g|ico|exe|zip|webmanifest)$/i.test(f)) continue
  const txt = await fs.readFile(f, 'utf8').catch(() => '')
  for (const r of RULES) {
    if (r.re.test(txt)) leaks.push(path.relative(OUT, f) + ' → ' + r.name)
  }
}

// 示例配置必须是"空"的：没有预置口令/密钥/地址
const exPath = path.join(OUT, 'config.example.json')
let exOk = true
try {
  const ex = JSON.parse(await fs.readFile(exPath, 'utf8'))
  const bad = []
  if (ex.auth && (ex.auth.password || ex.auth.apiKey)) bad.push('auth.password/auth.apiKey')
  if (ex.dsh && ex.dsh.baseUrl) bad.push('dsh.baseUrl')
  if (ex.local && (ex.local.enabled || ex.local.baseUrl || ex.local.apiKey)) bad.push('local.*')
  if (Array.isArray(ex.connections) && ex.connections.length) bad.push('connections')
  if (ex.backup && (ex.backup.passwordHash || ex.backup.passwordSalt)) bad.push('backup.password*')
  if (bad.length) { exOk = false; leaks.push('config.example.json → 示例配置里仍有预置值：' + bad.join(', ')) }
} catch (e) {
  exOk = false
  leaks.push('config.example.json → 读不出来：' + e.message)
}

// 打 zip（Windows 自带 tar 支持 -a 自动选格式）
const zip = path.join(DIST, NAME + '.zip')
try {
  execFileSync('tar', ['-a', '-c', '-f', zip, '-C', DIST, NAME], { stdio: 'ignore', timeout: 120000 })
} catch { console.warn('打 zip 失败（不影响文件夹形式的包）') }

let total = 0
for (const f of files) total += (await fs.stat(f).catch(() => ({ size: 0 }))).size
console.log('部署包：' + OUT)
console.log('  文件数：' + files.length + '，约 ' + (total / 1024).toFixed(0) + ' KB')
console.log('  压缩包：' + (await fs.stat(zip).then(() => zip).catch(() => '（未生成）')))
console.log('  示例配置：' + (exOk ? '干净（无预置口令/密钥/地址/连接）' : '不合格'))
if (leaks.length) {
  console.log('  ⚠ 发现 ' + leaks.length + ' 处可能泄露本机信息的文本：')
  for (const l of leaks) console.log('    - ' + l)
  process.exit(1)
}
console.log('  纯净性检查：通过')
