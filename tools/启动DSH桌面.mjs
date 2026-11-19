// ============================================================================
//  tools/启动DSH桌面.mjs —— 启动 DSH 桌面软件，并把它的启动地址记到日志里
//  ---------------------------------------------------------------------------
//  为什么需要这个：DSH 0.2.x（桌面软件）每次启动会生成一个随机令牌，只在
//  它自己的启动输出里打印一次（dsh web: http://127.0.0.1:<端口>/?token=...）。
//  正常双击启动时这段输出没人接住，网页端就永远拿不到令牌。
//
//  用法（先完全退出 DSH 桌面软件，包括托盘）：
//    node tools/启动DSH桌面.mjs "<安装目录>\DeepSeek Harness.exe"
//
//  它会把 stdout 写到 ~/.dsh/logs/dsh-desktop.out.log；
//  网页端「添加页面 → 检测本机 DSH」会从这个日志里读地址和令牌。
// ============================================================================

import { spawn } from 'node:child_process'
import { openSync, mkdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exe = process.argv[2] || process.env.DSH_DESKTOP_EXE || ''
if (!exe) {
  console.error('用法：node tools/启动DSH桌面.mjs "<DeepSeek Harness.exe 的完整路径>"')
  console.error('例如：node tools/启动DSH桌面.mjs "F:\\DSH\\DSH-EXE\\DeepSeek Harness.exe"')
  process.exit(2)
}
if (!existsSync(exe)) {
  console.error('找不到这个文件：' + exe)
  process.exit(2)
}

const logDir = path.join(os.homedir(), '.dsh', 'logs')
mkdirSync(logDir, { recursive: true })
const out = path.join(logDir, 'dsh-desktop.out.log')
const err = path.join(logDir, 'dsh-desktop.err.log')

console.log('启动：' + exe)
console.log('地址日志：' + out)
console.log('提示：如果 DSH 桌面软件已经在运行，请先从托盘完全退出，再运行本命令。')

const child = spawn(exe, [], {
  detached: true,
  // 追加而不是覆盖：万一这次没起来，上一份能用的地址还在，网页端不会跟着变空
  stdio: ['ignore', openSync(out, 'a'), openSync(err, 'a')],
  windowsHide: false
})
child.unref()
console.log('已启动（PID ' + child.pid + '）。等几秒后到网页里点「检测本机 DSH」。')
