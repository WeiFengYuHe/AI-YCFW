/* ============================================================================
   Service Worker —— 只负责"能加到主屏 / 断网能开壳"，绝不缓存旧版本
   ---------------------------------------------------------------------------
   上一版的教训：外壳用 cache-first，结果改了 app.js/style.css 之后，
   访问过的浏览器一直跑旧代码（看起来像"改动没生效"）。
   现在改成：
     · 页面（document）和脚本/样式：network-first，失败才回退缓存
     · 图片：cache-first（很少变）
     · /api/*：完全不碰（聊天内容绝不落 SW 缓存）
     · 新版本装上后主动通知页面，页面自己刷新一次
   ========================================================================== */
const CACHE = 'mchat-shell-v2'
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((list) => list.forEach((c) => c.postMessage({ type: 'sw-activated', cache: CACHE })))
      .catch(() => {})
  )
})

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then((v) => { clearTimeout(t); resolve(v) }, (err) => { clearTimeout(t); reject(err) })
  })
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.includes('/api/')) return          // 接口永远走网络

  const isImage = /\.(png|jpe?g|svg|ico|webp)$/i.test(url.pathname)
  const isDoc = req.mode === 'navigate' || req.destination === 'document'
  const isCode = req.destination === 'script' || req.destination === 'style' || /\.(js|css)$/i.test(url.pathname)

  if (isDoc || isCode) {
    // network-first：保证改了代码立刻生效；网络差/断网才用缓存
    e.respondWith(
      withTimeout(fetch(req), 4000)
        .then((res) => {
          const cc = res && res.headers.get('cache-control')
          if (res && res.status === 200 && res.type === 'basic' && cc !== 'no-store') {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
          }
          return res
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./')))
    )
    return
  }

  if (isImage) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
        }
        return res
      }).catch(() => hit))
    )
    return
  }

  // 其它：直接走网络
})
