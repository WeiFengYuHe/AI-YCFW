// 探针 v4：WebSocket 事件流
const URL = 'ws://127.0.0.1:3080/api/events.mux'
const ws = new WebSocket(URL)
const frames = []
let opened = false

ws.addEventListener('open', () => { opened = true; console.log('OPEN ok') })
ws.addEventListener('error', (e) => console.log('ERROR', e.message || e.type || String(e)))
ws.addEventListener('close', (e) => console.log('CLOSE', e.code, e.reason))
ws.addEventListener('message', (ev) => {
  frames.push(typeof ev.data === 'string' ? ev.data : '[binary ' + ev.data.size + ']')
})

setTimeout(() => {
  console.log('opened=', opened, ' frames=', frames.length)
  const seen = new Map()
  for (const f of frames) {
    let j
    try { j = JSON.parse(f) } catch { console.log('  raw:', String(f).slice(0, 120)); continue }
    const t = j.method || j.type || '(?)'
    const s = seen.get(t) || { n: 0, sample: null }
    s.n++
    if (!s.sample) s.sample = j
    seen.set(t, s)
  }
  for (const [t, s] of seen) {
    const str = JSON.stringify(s.sample)
    console.log('\n### ' + t + '  ×' + s.n)
    console.log('   ' + (str.length > 600 ? str.slice(0, 600) + '…' : str))
  }
  try { ws.close() } catch { }
  process.exit(0)
}, 3000)
