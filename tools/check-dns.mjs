// 用 DoH（阿里/腾讯）查公网 DNS 里这个 Funnel 域名到底有没有记录
// 本机 hosts 把域名写死了，普通 Resolve-DnsName 只会返回 100.112.141.105（假象）
const NAME = (process.env.YCFW_HOST || 'example.com')

async function doh(url) {
  try {
    const r = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10000) })
    const j = await r.json()
    const answers = (j.Answer || []).map((a) => a.type + ' ' + a.data)
    return { status: j.Status, answers }
  } catch (e) {
    return { error: e.message }
  }
}

console.log('域名:', NAME)
console.log('\n--- 阿里 DoH ---')
console.log('AAAA:', JSON.stringify(await doh('https://dns.alidns.com/resolve?name=' + NAME + '&type=AAAA')))
console.log('A   :', JSON.stringify(await doh('https://dns.alidns.com/resolve?name=' + NAME + '&type=A')))
console.log('\n--- 腾讯 DoH ---')
console.log('AAAA:', JSON.stringify(await doh('https://doh.pub/dns-query?name=' + NAME + '&type=AAAA')))
console.log('A   :', JSON.stringify(await doh('https://doh.pub/dns-query?name=' + NAME + '&type=A')))
