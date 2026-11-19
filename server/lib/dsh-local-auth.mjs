// ============================================================================
//  lib/dsh-local-auth.mjs —— 本机 DSH 的"免令牌"登录（仅 loopback）
//  ---------------------------------------------------------------------------
//  DSH 0.2.x 的浏览器认证有两个入口：
//    · ?token= 启动令牌（每次启动都变，只在启动输出里打印一次）
//    · 用 ~/.dsh/.credentials.yaml 里 client-connection/browser-session 的
//      secret 签名的 dsh-auth Cookie（有效期 30 天，绑定 host:port）
//
//  桌面软件正常双击启动时拿不到 ?token=；但 YCFW 跟它在同一台机器、同一个
//  用户下，可以读这个 secret 并在本地签一个等价的 Cookie。这样不用重启桌面
//  软件、也不用复制令牌就能连上。密钥只在本进程内存里用，不回传、不写日志。
//
//  仅当目标是 loopback 地址时才启用；远程部署仍然走 ?token= / Cookie。
// ============================================================================

import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const B64 = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

export function isLoopbackUrl(raw) {
  try {
    const u = new URL(String(raw || ''))
    const h = u.hostname.replace(/^\[|\]$/g, '')
    return h === '127.0.0.1' || h === 'localhost' || h === '::1'
  } catch { return false }
}

// 极简 YAML 读取：只找 client-connection/browser-session 下面的 secret。
// 不引依赖，也不解析别的记录。
export function readBrowserSessionSecret(homeDir = path.join(os.homedir(), '.dsh')) {
  let text
  try { text = readFileSync(path.join(homeDir, '.credentials.yaml'), 'utf8') } catch { return '' }
  const lines = text.replace(/\r/g, '').split('\n')
  let inRecord = false
  for (const line of lines) {
    if (/^\s{2}client-connection\/browser-session:\s*$/.test(line)) { inRecord = true; continue }
    if (inRecord && /^\s{2}\S/.test(line)) break
    if (!inRecord) continue
    const m = /^\s+secret:\s*(\S+)\s*$/.exec(line)
    if (m) return m[1]
  }
  return ''
}

export function mintBrowserCookie(baseUrl, secretRaw, days = 30) {
  let u
  try { u = new URL(baseUrl) } catch { throw new Error('地址不合法：' + baseUrl) }
  const authority = u.host
  const secret = Buffer.from(String(secretRaw).replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (secret.length !== 32) throw new Error('本机 DSH 的 browser-session secret 格式不对')
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + days * 86400000 }
  const body = B64(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = B64(crypto.createHmac('sha256', secret).update(body).digest())
  const name = 'dsh-auth-' + B64(crypto.createHash('sha256').update(authority).digest())
  return `${name}=v1.${body}.${sig}`
}

// 给一个本机 DSH 地址签 Cookie；拿不到 secret 就返回空串。
export function localAuthCookie(baseUrl) {
  if (!isLoopbackUrl(baseUrl)) return ''
  const secret = readBrowserSessionSecret()
  if (!secret) return ''
  try { return mintBrowserCookie(baseUrl, secret) } catch { return '' }
}

// 找出本机正在监听的 DSH 桌面软件端口（只认进程名含 DeepSeek Harness 的 loopback 端口）。
// 返回 [{ port, baseUrl }]，按端口升序。用于桌面软件重启换端口后自动跟随。
export function findDesktopDshPorts() {
  if (process.platform !== 'win32') return []
  let out = ''
  try {
    out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  } catch { return [] }
  const byPid = new Map()
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(127\.0\.0\.1|\[::1\]):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (!m) continue
    const port = parseInt(m[2], 10)
    if (!port) continue
    const pid = m[3]
    if (!byPid.has(pid)) byPid.set(pid, [])
    byPid.get(pid).push(port)
  }
  const ports = []
  for (const [pid, list] of byPid) {
    let name = ''
    try {
      name = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'latin1', windowsHide: true, timeout: 3000 })
    } catch { continue }
    if (!/deepseek\s*harness/i.test(name)) continue
    for (const p of list) ports.push(p)
  }
  return [...new Set(ports)].sort((a, b) => a - b).map((port) => ({ port, baseUrl: 'http://127.0.0.1:' + port }))
}

export async function probeDshWeb(baseUrl, timeoutMs = 1500) {
  try {
    const r = await fetch(baseUrl + '/', { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    const text = r.status === 401 ? await r.text().catch(() => '') : ''
    if (r.status === 401 && /authentication required|dsh web/i.test(text)) return true
    if (r.status === 200) {
      const h = await r.text().catch(() => '')
      if (/<title>\s*DeepSeek Harness|AI 对话|dsh/i.test(h)) return true
    }
  } catch { /* not a dsh web */ }
  return false
}
