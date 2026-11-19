// 生成 App 图标（纯 Node，手写 PNG 编码，不依赖任何图形库）
// 图形：蓝色渐变圆角方块 + 白色对话气泡，中间三个点
import zlib from 'node:zlib'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'server', 'web', 'icons')

// ---------------- PNG 编码 ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // RGBA
  ihdr[10] = 0     // deflate
  ihdr[11] = 0     // filter
  ihdr[12] = 0     // no interlace
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---------------- 绘制 ----------------
const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

// 圆角矩形的有向距离（<0 在内部）
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r)
  const qy = Math.abs(y - cy) - (hh - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

function render(size, { maskable }) {
  const rgba = Buffer.alloc(size * size * 4)
  const S = size
  // maskable 版本：图形缩小到安全区（约 62%），背景铺满
  const scale = maskable ? 0.62 : 0.80
  const bgRadius = maskable ? 0 : S * 0.235

  const bubbleW = S * scale
  const bubbleH = bubbleW * 0.72
  const bx = S / 2
  const by = S / 2 - bubbleH * 0.06
  const tailW = bubbleW * 0.20
  const tailH = bubbleW * 0.16
  const dotR = bubbleW * 0.058

  const SS = 3 // 超采样
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS

          // 背景：渐变圆角方块（maskable 时铺满整张）
          let inside = maskable
            ? 1
            : clamp01(0.5 - sdRoundRect(px, py, S / 2, S / 2, S / 2, S / 2, bgRadius) / 1.5)
          if (inside <= 0) { continue }

          const t = clamp01((px / S) * 0.45 + (py / S) * 0.55)
          let cr = lerp(0x5b, 0x2f, t)
          let cg = lerp(0x78, 0x4c, t)
          let cb = lerp(0xff, 0xe0, t)
          let ca = inside

          // 气泡（圆角矩形）
          const d = sdRoundRect(px, py, bx, by, bubbleW / 2, bubbleH / 2, bubbleH * 0.34)
          let white = clamp01(0.5 - d / 1.5)
          // 尾巴
          if (pointInTriangle(px, py,
            bx - bubbleW * 0.20, by + bubbleH * 0.34,
            bx - bubbleW * 0.02, by + bubbleH * 0.34,
            bx - bubbleW * 0.24, by + bubbleH * 0.34 + tailH)) {
            white = Math.max(white, 1)
          }
          if (white > 0) {
            cr = lerp(cr, 255, white)
            cg = lerp(cg, 255, white)
            cb = lerp(cb, 255, white)
          }

          // 三个点（用背景色挖出来）
          for (let k = -1; k <= 1; k++) {
            const dx = px - (bx + k * dotR * 2.6)
            const dy = py - (by - dotR * 0.15)
            const dd = Math.sqrt(dx * dx + dy * dy) - dotR
            const dot = clamp01(0.5 - dd / 1.2)
            if (dot > 0) {
              cr = lerp(cr, 0x3e, dot)
              cg = lerp(cg, 0x5c, dot)
              cb = lerp(cb, 0xf5, dot)
            }
          }

          r += cr; g += cg; b += cb; a += ca * 255
        }
      }
      const n = SS * SS
      const i = (y * S + x) * 4
      const alpha = a / n
      // 预乘还原：颜色按有效样本平均
      const eff = alpha > 0 ? a / 255 : 0
      rgba[i] = Math.round(eff > 0 ? r / eff : 0)
      rgba[i + 1] = Math.round(eff > 0 ? g / eff : 0)
      rgba[i + 2] = Math.round(eff > 0 ? b / eff : 0)
      rgba[i + 3] = Math.round(alpha)
    }
  }
  return encodePng(S, S, rgba)
}

await fs.mkdir(OUT, { recursive: true })
await fs.writeFile(path.join(OUT, 'icon-192.png'), render(192, { maskable: false }))
await fs.writeFile(path.join(OUT, 'icon-512.png'), render(512, { maskable: false }))
await fs.writeFile(path.join(OUT, 'maskable-512.png'), render(512, { maskable: true }))
console.log('图标已生成 →', OUT)
