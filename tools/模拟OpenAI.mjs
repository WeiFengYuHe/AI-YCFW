// 模拟OpenAI.mjs —— 测试用的假 OpenAI 兼容服务（不占显存、不联网）
// 支持 GET /models 和 POST /chat/completions（流式/非流式），用来验证"标准接口连接"这条链路。
// 用法：node 模拟OpenAI.mjs [port]
import http from 'node:http'

const port = Number(process.argv[2] || 8199)
const MODELS = ['mock-small', 'mock-large']

function body(req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => { s += c })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch { resolve({}) } })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.endsWith('/models') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }))
  }
  if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
    const j = await body(req)
    const lastMsg = (j.messages || []).filter((m) => m.role === 'user').pop()
    const q = String((lastMsg && lastMsg.content) || '')
    const answer = '收到：' + q.slice(0, 40) + '（这是假模型的回复）'
    if (j.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
      const parts = answer.match(/.{1,6}/g) || []
      let i = 0
      const timer = setInterval(() => {
        if (i >= parts.length) {
          clearInterval(timer)
          res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
          res.write('data: [DONE]\n\n')
          return res.end()
        }
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: parts[i++] }, finish_reason: null }] }) + '\n\n')
      }, 30)
      req.on('close', () => clearInterval(timer))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      id: 'mock', object: 'chat.completion', model: j.model || 'mock-small',
      choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    }))
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(port, '127.0.0.1', () => console.log('mock openai on http://127.0.0.1:' + port + '/v1'))
