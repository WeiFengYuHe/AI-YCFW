// 真·公网验证：直连公网边缘 IP（208.111.34.11），TLS SNI + Host 用正式域名
// 这样完全绕开本机 hosts 里写死的 100.112.141.105，测的就是"外面的人能不能连进来"
import https from 'node:https'

const HOST = (process.env.YCFW_HOST || 'example.com')
const EDGE_IPS = ['208.111.34.11', '208.111.35.209']

function get(ip, path, extraHeaders = {}) {
  return new Promise((resolve) => {
    const req = https.request({
      host: ip,
      port: 443,
      servername: HOST,          // SNI 必须是域名，证书才对得上
      headers: { Host: HOST, 'User-Agent': 'mchat-probe', ...extraHeaders },
      path,
      method: 'GET',
      timeout: 15000,
      rejectUnauthorized: true   // 证书链必须真的有效
    }, (res) => {
      let body = ''
      res.on('data', (c) => { if (body.length < 4000) body += c })
      res.on('end', () => resolve({
        status: res.statusCode,
        ct: res.headers['content-type'],
        head: body.slice(0, 90).replace(/\s+/g, ' ')
      }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }) })
    req.on('error', (e) => resolve({ error: e.code || e.message }))
    req.end()
  })
}

for (const ip of EDGE_IPS) {
  console.log('\n=== 边缘 IP ' + ip + ' ===')
  for (const [label, path] of [
    ['App 页面 /chat/', '/chat/'],
    ['App 静态 /chat/app.js', '/chat/app.js'],
    ['App 接口 /chat/api/health（应 401）', '/chat/api/health'],
    ['登录页 /chat/api/me（应 401）', '/chat/api/me'],
    ['原控制台 /（应 302/200）', '/']
  ]) {
    const r = await get(ip, path)
    console.log('  ' + label.padEnd(34) + ' → ' + JSON.stringify(r))
  }
}
