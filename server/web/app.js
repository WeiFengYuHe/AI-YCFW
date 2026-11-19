/* ============================================================================
   AI 对话 · 网页版前端逻辑
   ---------------------------------------------------------------------------
   数据来源两条：
     dsh   —— 直连本机 DSH（与电脑上的 GUI 共用会话），实时性靠 /api/events（SSE）
     local —— 本机 llama.cpp 模型，会话存服务端 json
   两种来源在前端被归一成同一种「消息项」，渲染只写一套。
   ========================================================================== */
(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v } catch { return d } },
    set(k, v) { try { localStorage.setItem(k, v) } catch { /* 无痕模式下忽略 */ } },
    del(k) { try { localStorage.removeItem(k) } catch { /* ignore */ } }
  }

  // ------------------------------------------------------------------ 状态
  const CHIPS = [
    { t: '当前进度？', p: '现在进展到哪一步了？一句话说' },
    { t: '继续做', p: '接着刚才的活继续' },
    { t: '看下状态', p: '把当前状态/日志发我看下' },
    { t: '解释一下', p: '用三句话解释你刚才做了什么' }
  ]

  const S = {
    // 页面（连接）：可手动添加。S.conn 是当前页面的完整对象，
    // S.mode 保持 'dsh' | 'local' 只是为了让老代码的 if 判断还能用（由 conn.kind 推导）。
    conns: [],
    connId: LS.get('mc_conn', 'dsh'),
    conn: null,
    presets: [],
    mode: LS.get('mc_mode', 'dsh'),
    me: null,
    dshSessions: [],
    localConvs: [],
    currentId: null,
    currentTitle: '',
    items: [],
    itemNodes: new Map(),
    seenSeqs: new Set(),
    running: false,
    hasMore: false,
    firstSeq: 0,
    loadingOlder: false,
    search: '',
    unread: new Set(),
    evtSrc: null,
    dshStatus: null,
    rafPending: false,
    dshTimer: null,

    // —— 流畅性相关 ——
    histCache: new Map(),      // 会话历史内存缓存（切回来是瞬时的）
    openToken: 0,              // 切换令牌：慢响应回来时用来判断"是否已经切走"
    histAbort: null,           // 正在进行的 history 请求（切走就取消）
    renderToken: 0,            // 分帧渲染令牌
    loadingHistory: false,     // 正在加载历史（显示骨架屏而不是空欢迎页）
    esOpened: false,           // 事件流是否曾经连上过（判断这次是"重连"）
    connBad: false,            // 连接是否处于异常
    healthFails: 0,
    lastDshFrameAt: 0,
    lastHealthOkAt: 0,

    // 工作区分组
    workspaces: [],
    archivedCount: 0,
    archivedSessions: [],
    showArchived: false,
    menuConv: null,
    collapsedGroups: new Set(JSON.parse(LS.get('mc_collapsed', '[]') || '[]'))
  }

  // ------------------------------------------------------------------ 小工具
  // DSH 每轮注入的运行时上下文不是用户说的话，不显示
  function isRuntimeContext(text) {
    return /^\s*(Time sampled while preparing turn|Browser time zone for this request|Elapsed since the preceding model-visible message|Current runtime context)/i.test(String(text || ''))
  }

  function h(tag, cls, txt) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (txt !== undefined && txt !== null) e.textContent = txt
    return e
  }
  function svgIcon(path, size) {
    const ns = 'http://www.w3.org/2000/svg'
    const s = document.createElementNS(ns, 'svg')
    s.setAttribute('viewBox', '0 0 24 24')
    s.setAttribute('width', size || 16)
    s.setAttribute('height', size || 16)
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', path)
    p.setAttribute('fill', 'none')
    p.setAttribute('stroke', 'currentColor')
    p.setAttribute('stroke-width', '2')
    p.setAttribute('stroke-linecap', 'round')
    s.appendChild(p)
    return s
  }
  const CHEV = 'M9 6l6 6-6 6'
  function chevIcon(size) {
    const s = svgIcon(CHEV, size)
    s.setAttribute('class', 'chev')
    return s
  }

  let toastTimer = null
  function toast(msg, isErr) {
    const t = $('toast')
    t.textContent = msg
    t.className = 'toast show' + (isErr ? ' err' : '')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { t.className = 'toast' }, isErr ? 4200 : 2200)
  }

  function fmtTime(ms) {
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return p(d.getHours()) + ':' + p(d.getMinutes())
  }
  function relDay(ms) {
    const d = new Date(ms)
    const now = new Date()
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
    const diff = (startOf(now) - startOf(d)) / 86400000
    if (diff <= 0) return '今天'
    if (diff === 1) return '昨天'
    if (diff <= 7) return '近 7 天'
    if (diff <= 30) return '近 30 天'
    return '更早'
  }

  async function api(path, opts) {
    const o = opts || {}
    const init = { method: o.method || 'GET', headers: {}, credentials: 'same-origin' }
    // 会话型页面现在可以有多条：告诉服务端这条请求走哪个页面
    if (S.connId && /^\/dsh\//.test(path)) init.headers['X-DSH-Conn'] = S.connId
    if (o.signal) init.signal = o.signal
    if (o.body !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(o.body)
    }
    const r = await fetch('./api' + path, init)
    let j = null
    try { j = await r.json() } catch { /* 非 JSON */ }
    if (r.status === 401) { showLogin(); throw new Error('未登录') }
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status))
    return j
  }

  // ------------------------------------------------------------------ 登录
  function showLogin() {
    $('login').classList.remove('hidden')
    $('app').classList.add('hidden')
    setTimeout(() => $('pw').focus(), 120)
  }
  function hideLogin() {
    $('login').classList.add('hidden')
    $('app').classList.remove('hidden')
  }
  async function doLogin() {
    const pw = $('pw').value
    if (!pw) return
    $('loginBtn').disabled = true
    $('loginErr').textContent = ''
    try {
      const r = await fetch('./api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
        credentials: 'same-origin'
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || '登录失败')
      $('pw').value = ''
      hideLogin()
      await boot()
    } catch (e) {
      $('loginErr').textContent = e.message
    } finally {
      $('loginBtn').disabled = false
    }
  }
  $('loginBtn').onclick = doLogin
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin() })

  // ------------------------------------------------------------------ 主题
  function applyTheme(v) {
    const theme = v || LS.get('mc_theme', 'system')
    LS.set('mc_theme', theme)
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    const meta = document.querySelector('meta[name=theme-color]')
    if (meta) meta.setAttribute('content', dark ? '#191a1c' : '#4d6bfe')
    document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === theme))
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (LS.get('mc_theme', 'system') === 'system') applyTheme('system')
  })

  // ------------------------------------------------------------------ Markdown
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  function inlineMd(s) {
    let t = esc(s)
    t = t.replace(/`([^`\n]+)`/g, (m, c) => '<code class="inline">' + c + '</code>')
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    t = t.replace(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    return t
  }

  function codeBlock(lang, code) {
    const wrap = h('div', 'code-block')
    const head = h('div', 'code-head')
    head.appendChild(h('span', 'code-lang', lang || 'text'))
    const long = String(code).split('\n').length > 2 || String(code).length > 60
    if (long) wrap.classList.add('collapsed')
    const tg = h('button', 'code-toggle', long ? '展开' : '收起')
    tg.type = 'button'
    tg.onclick = () => {
      const collapsed = wrap.classList.toggle('collapsed')
      tg.textContent = collapsed ? '展开' : '收起'
    }
    head.appendChild(tg)
    const cp = h('button', 'code-copy', '复制')
    cp.type = 'button'
    head.appendChild(cp)
    wrap.appendChild(head)
    const pre = h('pre')
    pre.textContent = code
    wrap.appendChild(pre)
    return wrap
  }

  // 把一个 markdown 字符串渲染进容器
  function renderMd(container, text) {
    container.innerHTML = ''
    const src = String(text || '')
    const lines = src.split('\n')
    let i = 0
    let listStack = null // {tag, el}

    const flushList = () => { listStack = null }

    while (i < lines.length) {
      const line = lines[i]

      // 围栏代码块
      const fence = /^\s*```(\S*)\s*$/.exec(line)
      if (fence) {
        const lang = fence[1] || ''
        const buf = []
        i++
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++ }
        i++
        flushList()
        container.appendChild(codeBlock(lang, buf.join('\n')))
        continue
      }

      // 空行
      if (!line.trim()) { flushList(); i++; continue }

      // 分隔线
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushList(); container.appendChild(h('hr')); i++; continue }

      // 标题
      const hd = /^(#{1,6})\s+(.*)$/.exec(line)
      if (hd) {
        flushList()
        const level = Math.min(hd[1].length, 4)
        const el = h('h' + level)
        el.innerHTML = inlineMd(hd[2])
        container.appendChild(el)
        i++
        continue
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        flushList()
        const buf = []
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
        const bq = h('blockquote')
        bq.innerHTML = inlineMd(buf.join(' '))
        container.appendChild(bq)
        continue
      }

      // 列表
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
      if (li) {
        const ordered = /\d/.test(li[2])
        const depth = Math.floor(li[1].length / 2)
        if (!listStack || listStack.tag !== (ordered ? 'ol' : 'ul') || listStack.depth !== depth) {
          const l = h(ordered ? 'ol' : 'ul')
          if (listStack && depth > listStack.depth) {
            const parentLi = listStack.el.lastElementChild
            if (parentLi) parentLi.appendChild(l)
            else container.appendChild(l)
          } else {
            container.appendChild(l)
          }
          listStack = { tag: ordered ? 'ol' : 'ul', el: l, depth }
        }
        const item = h('li')
        item.innerHTML = inlineMd(li[3])
        listStack.el.appendChild(item)
        i++
        continue
      }

      // 表格（简单支持）
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[-: |]+\|\s*$/.test(lines[i + 1])) {
        flushList()
        const rows = []
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++ }
        const tbl = h('table')
        const thead = h('thead')
        const tr = h('tr')
        rows[0].split('|').slice(1, -1).forEach((c) => {
          const th = h('th')
          th.innerHTML = inlineMd(c.trim())
          tr.appendChild(th)
        })
        thead.appendChild(tr)
        tbl.appendChild(thead)
        const tbody = h('tbody')
        rows.slice(2).forEach((r) => {
          const rtr = h('tr')
          r.split('|').slice(1, -1).forEach((c) => {
            const td = h('td')
            td.innerHTML = inlineMd(c.trim())
            rtr.appendChild(td)
          })
          tbody.appendChild(rtr)
        })
        tbl.appendChild(tbody)
        const tblWrap = h('div', 'table-wrap')
        tblWrap.appendChild(tbl)
        container.appendChild(tblWrap)
        continue
      }

      // 段落（连续非空行合并）
      flushList()
      const buf = [line]
      i++
      while (i < lines.length && lines[i].trim() &&
             !/^\s*```/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) &&
             !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
             !/^\s*\|.*\|\s*$/.test(lines[i])) {
        buf.push(lines[i]); i++
      }
      const p = h('p')
      p.innerHTML = inlineMd(buf.join('\n'))
      container.appendChild(p)
    }
  }

  // ------------------------------------------------------------------ 消息渲染
  function toolCard(call) {
    const wrap = h('div', 'tool' + (call.isError ? ' err' : ''))
    const head = h('div', 'tool-head')
    head.appendChild(chevIcon(14))
    head.appendChild(h('span', 'tool-name', call.name || '工具'))
    let sum = ''
    try {
      const a = JSON.parse(call.args || '{}')
      const pick = ['command', 'file_path', 'path', 'pattern', 'query', 'queries', 'url', 'description', 'goal', 'prompt', 'text', 'job_id', 'name']
      let v = ''
      for (const k of pick) { if (a[k] !== undefined && a[k] !== null) { v = a[k]; break } }
      if (Array.isArray(v)) v = v.map((x) => String(x)).join(' / ')
      else if (v && typeof v === 'object') v = JSON.stringify(v)
      sum = String(v || '')
      if (!sum) sum = Object.keys(a).slice(0, 3).join(', ')
    } catch { sum = String(call.args || '').slice(0, 80) }
    head.appendChild(h('span', 'tool-sum', String(sum).replace(/\s+/g, ' ').slice(0, 120)))
    wrap.appendChild(head)

    const body = h('div', 'tool-body')
    if (call.args) {
      const sec = h('div', 'tool-sec')
      sec.appendChild(h('div', 'tool-label', '参数'))
      const pre = h('pre')
      try {
        const a = JSON.parse(call.args)
        pre.textContent = JSON.stringify(a, null, 2)
      } catch { pre.textContent = String(call.args) }
      sec.appendChild(pre)
      body.appendChild(sec)
    }
    if (call.resultText) {
      const sec = h('div', 'tool-sec')
      sec.appendChild(h('div', 'tool-label', call.isError ? '结果（出错）' : '结果'))
      const pre = h('pre')
      pre.textContent = call.resultText
      sec.appendChild(pre)
      body.appendChild(sec)
    }
    wrap.appendChild(body)
    head.onclick = () => wrap.classList.toggle('open')
    return wrap
  }

  // 只有工具调用、没有文字/思考的 assistant 条目，可以合并成一组折叠
  function isToolOnly(item) {
    // 有思考但正文为空、只调了工具的步骤也算"工具步骤"；整组折叠后不会铺满屏
    return item.kind === 'assistant' && !item.partial && !item.text &&
      !item.interrupted && !item.error && item.calls && item.calls.length > 0
  }

  function renderToolGroup(group) {
    const wrap = h('div', 'tool-group')
    const head = h('div', 'tool-group-head')
    head.appendChild(chevIcon(13))
    head.appendChild(h('span', 'tool-group-title', '工具调用 ' + group.length + ' 次'))
    const hint = h('span', 'tool-group-hint', '展开')
    head.appendChild(hint)
    const body = h('div', 'tool-group-body hidden')
    for (const item of group) {
      const node = renderItem(item)
      S.itemNodes.set(item, node)
      body.appendChild(node)
    }
    head.onclick = () => {
      const shown = !body.classList.toggle('hidden')
      hint.textContent = shown ? '收起' : '展开'
      head.classList.toggle('open', shown)
    }
    wrap.appendChild(head)
    wrap.appendChild(body)
    return wrap
  }

  function renderItem(item) {
    const node = h('div', 'msg ' + (item.kind === 'user' ? 'user' : item.kind === 'notice' ? 'notice' : item.kind === 'error' ? 'error' : 'assistant'))

    if (item.kind === 'notice') {
      node.textContent = item.text || ''
      return node
    }

    if (item.kind === 'error') {
      node.appendChild(h('div', 'err-bubble', '⚠️ ' + (item.text || '出错了')))
      return node
    }

    if (item.kind === 'user') {
      if (item.synthetic) {
        const line = h('div', 'synthetic-line')
        line.appendChild(chevIcon(12))
        line.appendChild(h('span', null, '系统提示（已折叠）'))
        node.appendChild(line)
        const body = h('div', 'synthetic-body hidden')
        body.textContent = item.text
        node.appendChild(body)
        line.onclick = () => {
          const open = body.classList.toggle('hidden') === false
          line.classList.toggle('open', open)
        }
        return node
      }
      const b = h('div', 'bubble')
      b.textContent = item.text
      if (item.images) {
        const im = h('div', 'tool-label', '（含 ' + item.images + ' 张图片）')
        b.appendChild(im)
      }
      node.appendChild(b)
      return node
    }

    // assistant
    const body = h('div', 'a-body')
    item._body = body
    item._thinkBody = null
    item._thinkNode = null
    item._thinkLen = 0

    // 思考块
    if (item.reasoning) { ensureThinkBlock(item); syncThinkBlock(item) }

    // 工具调用
    if (item.calls && item.calls.length) {
      const tools = h('div', 'tools')
      item.calls.forEach((c) => tools.appendChild(toolCard(c)))
      body.appendChild(tools)
      item._tools = tools
    } else {
      item._tools = null
    }

    // 正文：流式用 Text 节点（后面只往里追加，不整段重写），定稿再渲染 Markdown
    const md = h('div', 'md')
    if (item.partial) {
      md.classList.add('streaming', 'cursor')
      const tn = document.createTextNode(item.text || '')
      md.appendChild(tn)
      item._textNode = tn
      item._textLen = (item.text || '').length
    } else {
      renderMd(md, item.text || '')
      item._textNode = null
      item._textLen = 0
    }
    body.appendChild(md)
    item._md = md

    if (item.interrupted) body.appendChild(h('div', 'tool-label', '（已中断）'))
    if (item.error) body.appendChild(h('div', 'err-bubble', '⚠️ ' + item.error))

    // 操作（纯工具调用不显示"复制"，避免每个工具卡下面多一行）
    if (!item.partial && !isToolOnly(item)) {
      const acts = h('div', 'msg-actions')
      const cp = h('button', 'msg-act', '复制')
      cp.onclick = () => {
        navigator.clipboard.writeText(item.text || '').then(() => toast('已复制')).catch(() => toast('复制失败', true))
      }
      acts.appendChild(cp)
      if (S.mode === 'local') {
        const rg = h('button', 'msg-act', '重新生成')
        rg.onclick = () => regenerateLocal()
        acts.appendChild(rg)
      }
      body.appendChild(acts)
      item._acts = acts
    } else {
      item._acts = null
    }

    node.appendChild(body)
    return node
  }

  // 思考块：默认折叠；思考中显示转圈；点标题才展开。
  function ensureThinkBlock(item) {
    if (item._think) return
    const think = h('div', 'think')
    const head = h('div', 'think-head')
    head.appendChild(chevIcon(13))
    const spin = h('span', 'think-spinner')
    head.appendChild(spin)
    const title = h('span', 'think-title', item.partial ? '思考中…' : '已深度思考')
    head.appendChild(title)
    const time = h('span', 'think-time', item.durationMs ? (item.durationMs / 1000).toFixed(1) + 's' : '')
    head.appendChild(time)
    think.appendChild(head)
    const tb = h('div', 'think-body')
    const tn = document.createTextNode(item.reasoning || '')
    tb.appendChild(tn)
    think.appendChild(tb)
    head.onclick = () => think.classList.toggle('open')
    item._think = think
    item._thinkBody = tb
    item._thinkNode = tn
    item._thinkLen = (item.reasoning || '').length
    item._thinkTitle = title
    item._thinkSpin = spin
    item._thinkTime = time
    if (item._body) {
      if (item._body.firstChild) item._body.insertBefore(think, item._body.firstChild)
      else item._body.appendChild(think)
    }
    syncThinkBlock(item)
  }

  // partial 变化时只改 header 状态，不自动展开正文
  function syncThinkBlock(item) {
    if (!item._think) return
    const thinking = !!item.partial
    item._think.classList.toggle('thinking', thinking)
    if (item._thinkTitle) item._thinkTitle.textContent = thinking ? '思考中…' : '已深度思考'
    if (item._thinkSpin) item._thinkSpin.style.display = thinking ? '' : 'none'
    if (item._thinkTime) item._thinkTime.textContent = (!thinking && item.durationMs) ? (item.durationMs / 1000).toFixed(1) + 's' : ''
  }

  function nearBottom() {
    const m = $('messages')
    return m.scrollHeight - m.scrollTop - m.clientHeight < 140
  }
  function scrollBottom(smooth) {
    const m = $('messages')
    if (smooth) m.scrollTo({ top: m.scrollHeight, behavior: 'smooth' })
    else m.scrollTop = m.scrollHeight
  }

  // 空态欢迎页（每次重建，避免节点被 innerHTML 清掉后引用失效）
  function buildWelcome() {
    const d = h('div', 'welcome')
    d.innerHTML =
      '<div class="welcome-logo">' +
      '<svg viewBox="0 0 48 48" width="64" height="64" aria-hidden="true">' +
      '<rect x="2" y="2" width="44" height="44" rx="14" fill="url(#wg)"/>' +
      '<path d="M14 18h20a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H23l-6 5v-5h-3a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3z" fill="#fff"/>' +
      '<defs><linearGradient id="wg" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#5b78ff"/><stop offset="1" stop-color="#2f4ce0"/></linearGradient></defs></svg>' +
      '</div>' +
      '<h2>' + (S.mode === 'dsh' ? '今天想聊点什么？' : '本地模型待命') + '</h2>' +
      '<p class="welcome-sub">' +
      (S.mode === 'dsh'
        ? '这里可以连多个 AI：每个页面是一路连接，各聊各的，互不干扰。'
        : '本地模型的对话独立保存，不占用会话型服务的记录。') +
      '</p>'
    const chips = h('div', 'chips')
    CHIPS.forEach((c) => {
      const b = h('button', 'chip', c.t)
      b.onclick = () => {
        const inp = $('input')
        inp.value = c.p
        inp.dispatchEvent(new Event('input'))
        send()
      }
      chips.appendChild(b)
    })
    d.appendChild(chips)

    // 最近对话快捷入口（首次进来自动停在欢迎页，从这里一眼就能接着聊）
    const recent = sessionsForMode().slice(0, 3)
    if (recent.length) {
      const lab = h('div', 'welcome-recent-label', '最近对话')
      d.appendChild(lab)
      const rc = h('div', 'chips')
      recent.forEach((s) => {
        const b = h('button', 'chip recent', s.title || '（未命名会话）')
        b.onclick = () => openSession(s.id)
        rc.appendChild(b)
      })
      d.appendChild(rc)
    }
    return d
  }

  // 骨架屏：切换对话时别再"清空 → 白屏 → 蹦出来"
  function buildSkeleton() {
    const box = h('div', 'skeleton')
    for (let i = 0; i < 4; i++) {
      const row = h('div', 'sk-row' + (i % 2 ? ' sk-right' : ''))
      row.appendChild(h('div', 'sk-bar sk-w' + (40 + (i * 17) % 50)))
      box.appendChild(row)
    }
    return box
  }

  function setLoading(on) {
    const bar = $('loadingBar')
    if (bar) bar.classList.toggle('hidden', !on)
  }

  function renderMessages(opt) {
    const o = opt || {}
    const box = $('messages')
    const stick = o.scroll === 'bottom' || (o.scroll !== 'top' && nearBottom())
    const my = ++S.renderToken
    box.innerHTML = ''
    S.itemNodes.clear()

    // 历史还在路上：显示骨架屏（不是欢迎页，也不是空白）
    if (S.loadingHistory && !S.items.length) {
      box.appendChild(buildSkeleton())
      return
    }

    if (!S.items.length) {
      box.appendChild(buildWelcome())
      return
    }

    if (S.hasMore) {
      const more = h('div', 'notice')
      const btn = h('button', 'msg-act', S.loadingOlder ? '加载中…' : '加载更早的消息')
      btn.onclick = loadOlder
      more.appendChild(btn)
      box.appendChild(more)
    }

    // 分帧渲染：一次画 CHUNK 个单元，长对话切换也不会把主线程卡住。
    // 连续的"纯工具调用"消息合并成一个折叠组，避免几十张工具卡铺满一屏。
    const items = S.items
    const units = []
    for (let j = 0; j < items.length; j++) {
      if (isToolOnly(items[j])) {
        const group = [items[j]]
        while (j + 1 < items.length && isToolOnly(items[j + 1])) group.push(items[++j])
        units.push({ group })
      } else {
        units.push({ item: items[j] })
      }
    }
    const CHUNK = o.instant ? 60 : 8
    let i = 0
    const step = () => {
      if (my !== S.renderToken) return   // 期间又切换了，放弃这一批
      const end = Math.min(i + CHUNK, units.length)
      for (; i < end; i++) {
        const u = units[i]
        if (u.item) {
          const node = renderItem(u.item)
          S.itemNodes.set(u.item, node)
          box.appendChild(node)
        } else {
          box.appendChild(renderToolGroup(u.group))
        }
      }
      if (i < units.length) {
        if (stick) scrollBottom(false)
        requestAnimationFrame(step)
      } else if (stick) {
        scrollBottom(o.smooth !== false && !o.instant)
      }
    }
    step()
  }

  // ------------------------------------------------------------------ 会话列表
  function sessionsForMode() {
    return S.mode === 'dsh' ? S.dshSessions : S.localConvs
  }

  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''

  // 按工作区目录分组（不再把所有对话堆在一起）
  function workspaceGroups(list) {
    if (S.mode !== 'dsh') {
      return [{ key: 'local', title: '本地模型', path: '', sessions: list }]
    }
    const ws = S.workspaces || []
    const byId = new Map()
    for (const w of ws) byId.set(w.id, { key: 'ws:' + w.id, id: w.id, title: w.title || baseName(w.path), path: w.path || '', sessions: [] })
    const others = new Map()
    for (const s of list) {
      const g = s.workspaceId ? byId.get(s.workspaceId) : null
      if (g) { g.sessions.push(s); continue }
      const path = s.workspacePath || s.cwd || ''
      const key = path ? path.toLowerCase() : '__none'
      if (!others.has(key)) {
        others.set(key, {
          key: 'dir:' + key,
          id: '',
          title: path ? baseName(path) : '未指定目录',
          path,
          sessions: []
        })
      }
      others.get(key).sessions.push(s)
    }
    const groups = [...byId.values(), ...others.values()].filter((g) => g.sessions.length)
    for (const g of groups) {
      g.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    }
    groups.sort((a, b) => {
      const at = (g) => g.sessions[0] ? g.sessions[0].updatedAt || 0 : 0
      return at(b) - at(a)
    })
    return groups
  }

  function sessionRow(c) {
    const ms = typeof c.updatedAt === 'number' ? c.updatedAt : Date.parse(c.updatedAt)
    const row = h('div', 'conv' + (c.id === S.currentId ? ' on' : ''))
    const main = h('div', 'conv-main')
    main.appendChild(h('div', 'conv-title', c.title || '（未命名会话）'))
    const meta = h('div', 'conv-meta')
    if (c.running) {
      meta.appendChild(h('span', 'pulse'))
      meta.appendChild(h('span', null, '生成中'))
    } else {
      meta.appendChild(h('span', null, fmtTime(ms)))
    }
    if (S.unread.has(c.id)) meta.appendChild(h('span', null, '• 新'))
    meta.appendChild(h('span', null, relDay(ms)))
    main.appendChild(meta)
    row.appendChild(main)

    const act = h('button', 'conv-act')
    act.appendChild(svgIcon('M12 5h.01M12 12h.01M12 19h.01', 16))
    act.onclick = (e) => { e.stopPropagation(); convMenu(c) }
    row.appendChild(act)

    row.onclick = () => { openSession(c.id) }
    return row
  }

  function renderConvList() {
    const box = $('convList')
    box.innerHTML = ''

    // 已归档视图：单独一页，能取消归档 / 继续看历史
    if (S.mode === 'dsh' && S.showArchived) {
      const back = h('div', 'ws-head')
      back.appendChild(h('span', 'ws-title', '↩ 返回会话列表'))
      back.onclick = () => { S.showArchived = false; S.archivedSessions = []; renderConvList() }
      box.appendChild(back)
      box.appendChild(h('div', 'conv-group', '已归档（' + S.archivedSessions.length + '）'))
      if (!S.archivedSessions.length) {
        box.appendChild(h('div', 'notice', '没有已归档的对话'))
        return
      }
      for (const c of S.archivedSessions) box.appendChild(sessionRow({ ...c, archived: true }))
      return
    }

    const q = S.search.toLowerCase()
    const list = sessionsForMode().filter((c) => {
      // 已归档的永远不显示（服务端也会过滤，这里再兜一层）
      if (c.archived) return false
      if (!q) return true
      return String(c.title || '').toLowerCase().includes(q) || String(c.cwd || '').toLowerCase().includes(q)
    })
    if (!list.length) {
      box.appendChild(h('div', 'notice', S.search ? '没有匹配的对话' : '还没有对话'))
      return
    }

    const groups = workspaceGroups(list)
    const collapsed = S.collapsedGroups

    for (const g of groups) {
      // 本地模型只有一个隐含分组，不需要分组头
      if (S.mode !== 'dsh') {
        for (const c of g.sessions) box.appendChild(sessionRow(c))
        continue
      }
      const isCollapsed = !q && collapsed.has(g.key)
      const head = h('div', 'ws-head' + (isCollapsed ? ' collapsed' : ''))
      head.appendChild(chevIcon(13)).classList.add('ws-chev')
      head.appendChild(h('span', 'ws-title', g.title))
      head.appendChild(h('span', 'ws-count', String(g.sessions.length)))
      if (g.path) {
        const pth = h('span', 'ws-path', g.path)
        pth.title = g.path          // 悬浮看完整路径
        head.appendChild(pth)
      }
      if (S.mode === 'dsh') {
        const add = h('button', 'ws-add', '＋')
        add.title = '在这个目录新建对话'
        add.onclick = (e) => { e.stopPropagation(); createInDir(g.path) }
        head.appendChild(add)
      }
      head.onclick = () => {
        if (g.path && g.sessions.length === 0) return
        if (collapsed.has(g.key)) collapsed.delete(g.key)
        else collapsed.add(g.key)
        LS.set('mc_collapsed', JSON.stringify([...collapsed]))
        renderConvList()
      }
      box.appendChild(head)

      if (isCollapsed) continue
      for (const c of g.sessions) box.appendChild(sessionRow(c))
    }

    // 归档提示：点一下能看已归档的对话并取消归档
    if (S.mode === 'dsh' && S.archivedCount > 0 && !q) {
      const tip = h('div', 'conv-archived-tip', '已隐藏 ' + S.archivedCount + ' 个已归档对话 · 点这里查看')
      tip.onclick = () => { loadArchived() }
      box.appendChild(tip)
    }
  }

  // 在指定目录直接新建对话
  async function createInDir(path) {
    if (S.mode !== 'dsh') return
    try {
      toast('正在新建…')
      const r = await api('/dsh/sessions', { method: 'POST', body: { cwd: path || undefined } })
      await refreshSessions()
      await openSession(r.sessionId)
    } catch (e) { toast(e.message, true) }
  }

  // 会话操作：重命名 / 归档 / 取消归档 / 删除
  function convMenu(c) {
    S.menuConv = c
    const isDsh = S.mode === 'dsh'
    const canUnarchive = isDsh && S.conn && S.conn.api === 'dsh2'
    $('convSheetName').textContent = (c.title || '（未命名会话）') + (c.archived ? '（已归档）' : '')
    $('convArchive').style.display = (!c.archived) ? '' : 'none'
    $('convUnarchive').style.display = (c.archived && canUnarchive) ? '' : 'none'
    $('convDelete').textContent = isDsh ? '删除（归档：从列表隐藏，日志保留）' : '删除（不可恢复）'
    $('convDeleteHint').textContent = isDsh
      ? '会话型服务没有"彻底删除会话"的接口；这里的删除等于归档，DSH 桌面端 / 网页端也不会再显示。'
      : '会删掉这个会话在本地的记录文件，删了不能恢复。'
    openSheet('convSheet')
  }

  async function convRename() {
    const c = S.menuConv
    if (!c) return
    const action = prompt('重命名这个对话（留空=取消）\n\n当前：' + (c.title || ''), c.title || '')
    if (!action || action === c.title) return
    try {
      if (S.mode === 'dsh') {
        await api('/dsh/sessions/' + c.id + '/rename', { method: 'POST', body: { title: action } })
        c.title = action
      } else {
        await api('/conn/' + S.connId + '/conversations/' + c.id, { method: 'PATCH', body: { title: action } })
        c.title = action
      }
      if (c.id === S.currentId) { S.currentTitle = action; $('chatTitle').textContent = action }
      closeSheet('convSheet')
      renderConvList()
      toast('已重命名')
    } catch (e) { toast(e.message, true) }
  }

  async function convArchive() {
    const c = S.menuConv
    if (!c) return
    if (!confirm('归档「' + (c.title || '这个对话') + '」？\n\n它会从这个列表和 DSH 里隐藏，日志保留，之后可以取消归档。')) return
    try {
      if (S.mode === 'dsh') {
        await api('/dsh/sessions/' + c.id + '/archive', { method: 'POST', body: { stopActivity: !!c.running } })
      } else {
        throw new Error('这个页面不是会话型服务，不能归档；用删除')
      }
      if (c.id === S.currentId) { S.currentId = null; S.items = []; S.running = false; renderMessages(); updateSendBtn() }
      closeSheet('convSheet')
      await refreshSessions()
      toast('已归档')
    } catch (e) { toast(e.message, true) }
  }

  async function convUnarchive() {
    const c = S.menuConv
    if (!c) return
    try {
      await api('/dsh/sessions/' + c.id + '/unarchive', { method: 'POST', body: {} })
      closeSheet('convSheet')
      if (S.showArchived) await loadArchived()
      else await refreshSessions()
      toast('已取消归档')
    } catch (e) { toast(e.message, true) }
  }

  async function convDelete() {
    const c = S.menuConv
    if (!c) return
    const isDsh = S.mode === 'dsh'
    if (!confirm(isDsh
      ? '删除「' + (c.title || '这个对话') + '」？\n\n会话型服务只能归档：会从列表和 DSH 里隐藏，日志保留。'
      : '删除「' + (c.title || '这个对话') + '」？\n\n本地记录会被删掉，不能恢复。')) return
    try {
      if (isDsh) await api('/dsh/sessions/' + c.id, { method: 'DELETE' })
      else await api('/conn/' + S.connId + '/conversations/' + c.id, { method: 'DELETE' })
      if (c.id === S.currentId) { S.currentId = null; S.items = []; S.running = false; renderMessages(); updateSendBtn() }
      closeSheet('convSheet')
      if (isDsh) await refreshSessions()
      else {
        S.localConvs = S.localConvs.filter((x) => x.id !== c.id)
        renderConvList()
      }
      toast(isDsh ? '已归档（DSH 只支持归档）' : '已删除')
    } catch (e) { toast(e.message, true) }
  }

  async function loadArchived() {
    if (S.mode !== 'dsh') return
    try {
      const r = await api('/dsh/archived')
      S.archivedSessions = r.sessions || []
      S.showArchived = true
      renderConvList()
    } catch (e) { toast(e.message, true) }
  }

  // ------------------------------------------------------------------ 加载会话
  //  流畅性三招：①命中内存缓存立刻显示；②没命中显示骨架屏（不白屏）；
  //             ③切走就取消上一个请求，慢响应回来也不会覆盖新页面。
  function trimHistCache() {
    if (S.histCache.size <= 8) return
    const arr = [...S.histCache.entries()].sort((a, b) => a[1].at - b[1].at)
    for (let i = 0; i < arr.length - 8; i++) S.histCache.delete(arr[i][0])
  }

  function rememberCurrent() {
    if (!S.currentId) return
    S.histCache.set(S.currentId, {
      at: Date.now(),
      items: S.items,
      hasMore: S.hasMore,
      firstSeq: S.firstSeq,
      title: S.currentTitle
    })
    trimHistCache()
  }

  // 增量合并：把刚拉到的尾巴并进现有列表（只追加/刷新，不删已有）
  function mergeTail(items, hasMore, firstSeq) {
    let changed = false
    const idxOf = new Map()
    S.items.forEach((it, i) => { if (it.seq) idxOf.set(it.seq, i) })
    const lastKnown = S.items.length ? (S.items[S.items.length - 1].seq || 0) : 0
    for (const it of items) {
      if (!it.seq) {
        // 没有 seq 的（本地模式）走整体替换
        S.items.push(it)
        changed = true
        continue
      }
      if (it.seq > lastKnown) {
        S.items.push(it)
        S.seenSeqs.add(it.seq)
        changed = true
        continue
      }
      const idx = idxOf.get(it.seq)
      if (idx === undefined) continue
      const old = S.items[idx]
      const sameText = (old.text || '') === (it.text || '')
      const sameReason = (old.reasoning || '') === (it.reasoning || '')
      const sameCalls = JSON.stringify(old.calls || []) === JSON.stringify(it.calls || [])
      if (!sameText || !sameReason || !sameCalls || !!old.partial !== !!it.partial) {
        S.items[idx] = it
        changed = true
      }
    }
    if (typeof hasMore === 'boolean' && hasMore !== S.hasMore) { S.hasMore = hasMore; changed = true }
    if (firstSeq && S.items.length && (S.items[0].seq || 0) > firstSeq) S.firstSeq = firstSeq
    return changed
  }

  async function openSession(id, opt) {
    if (!id) return
    const o = opt || {}
    closeDrawer()
    if (S.currentId === id && !o.force) return

    const token = ++S.openToken
    if (S.histAbort) { try { S.histAbort.abort() } catch { /* ignore */ } S.histAbort = null }

    S.currentId = id
    S.seenSeqs = new Set()
    S.hasMore = false
    S.firstSeq = 0
    S.unread.delete(id)
    const found = sessionsForMode().find((c) => c.id === id)
    S.currentTitle = (found && found.title) || ''
    if (isDsh2() && found && found.running) startDsh2Poll()
    S.running = !!(found && found.running)
    $('chatTitle').textContent = S.currentTitle || '对话'
    $('chatSub').textContent = subtitleText()
    updateSendBtn()
    renderConvList()
    LS.set('mc_last_' + S.mode, id)

    // ① 有缓存：先把内容摆上去（切回老对话几乎是瞬时的）
    const cached = S.histCache.get(id)
    if (cached) {
      S.items = cached.items
      S.hasMore = cached.hasMore
      S.firstSeq = cached.firstSeq
      S.loadingHistory = false
      for (const it of S.items) if (it.seq) S.seenSeqs.add(it.seq)
      finishStreamingState()
      renderMessages({ scroll: 'bottom', smooth: false, instant: true })
      setLoading(true)          // 后台悄悄校验一次
    } else {
      S.items = []
      S.loadingHistory = true
      renderMessages({ scroll: 'bottom', instant: true })
      setLoading(true)
    }

    // ② 后台取数据（或校验缓存）
    const ctrl = new AbortController()
    S.histAbort = ctrl
    try {
      let items, hasMore, firstSeq, title
      if (S.mode === 'dsh') {
        const r = await api('/dsh/sessions/' + id + '/history?maxMessages=32', { signal: ctrl.signal })
        items = r.items || []
        hasMore = !!r.hasMore
        firstSeq = r.firstSeq || 0
        title = r.title
      } else {
        const r = await api('/conn/' + S.connId + '/conversations/' + id, { signal: ctrl.signal })
        items = localToItems(r.messages || [])
        hasMore = false
        firstSeq = 0
      }
      if (token !== S.openToken) return         // 用户已经切到别的对话了

      let changed = true
      if (cached) {
        // 命中缓存时用"合并"而不是"替换"：只追加新尾巴、刷新变了的那几条。
        // 这样①不会把已经加载的更早消息冲掉 ②没变化就不重绘（不闪）
        changed = mergeTail(items, hasMore, firstSeq)
      } else {
        S.items = items
        S.hasMore = hasMore
        S.firstSeq = firstSeq
        S.seenSeqs = new Set()
        for (const it of S.items) if (it.seq) S.seenSeqs.add(it.seq)
      }
      S.loadingHistory = false
      if (title && !S.currentTitle) { S.currentTitle = title; $('chatTitle').textContent = title }
      const last = S.items[S.items.length - 1]
      if (last && last.kind === 'assistant' && last.partial) S.running = true
      finishStreamingState()
      rememberCurrent()
      // 缓存没变就完全不动界面（避免"闪一下"）
      if (changed) renderMessages({ scroll: 'bottom', smooth: false, instant: true })
      updateSendBtn()
      $('chatSub').textContent = subtitleText()
    } catch (e) {
      if (token !== S.openToken) return
      if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) return
      S.loadingHistory = false
      toast(e.message, true)
      if (!cached) renderMessages({ scroll: 'bottom' })
    } finally {
      if (token === S.openToken) setLoading(false)
    }
  }

  function subtitleText() {
    if (!S.conn) return '先加一个页面'
    if (S.mode === 'local') return '标准接口（' + ((S.conn && S.conn.model) || 'OpenAI 兼容') + '）'
    const st = S.dshStatus
    if (!st) return '与本机 DSH 共用会话'
    if (st.reachable || st.mux === 'open') return '与本机 DSH 共用会话 · 已连接'
    return '与本机 DSH 共用会话 · 未连接'
  }

  async function loadOlder() {
    if (S.loadingOlder || S.mode !== 'dsh' || !S.currentId || !S.hasMore) return
    S.loadingOlder = true
    const box = $('messages')
    const oldHeight = box.scrollHeight
    const oldTop = box.scrollTop
    renderMessages()
    try {
      const r = await api('/dsh/sessions/' + S.currentId + '/history?maxMessages=30&beforeSeq=' + S.firstSeq)
      const older = (r.items || []).filter((it) => !it.seq || !S.seenSeqs.has(it.seq))
      for (const it of older) if (it.seq) S.seenSeqs.add(it.seq)
      S.items = older.concat(S.items)
      S.hasMore = !!r.hasMore
      if (r.firstSeq) S.firstSeq = r.firstSeq
      S.loadingOlder = false
      // 保持视觉位置：新增内容在顶部，把滚动位置按高度差下移
      renderMessages({ instant: true })
      box.scrollTop = box.scrollHeight - oldHeight + oldTop
      rememberCurrent()
    } catch (e) {
      S.loadingOlder = false
      toast(e.message, true)
      renderMessages()
    }
  }

  // 本地模式的 messages → 统一 item
  function localToItems(msgs) {
    const out = []
    for (const m of msgs) {
      if (m.role === 'user') out.push({ kind: 'user', text: m.content, seq: m.id })
      else if (m.role === 'assistant') {
        out.push({
          kind: 'assistant',
          text: m.content || '',
          reasoning: m.reasoning || '',
          calls: [],
          partial: m.status === 'streaming',
          durationMs: m.durationMs || 0
        })
      }
    }
    return out
  }

  // ------------------------------------------------------------------ 实时：DSH 事件
  function findOrCreateStepItem(turn, step) {
    for (let i = S.items.length - 1; i >= 0; i--) {
      const it = S.items[i]
      if (it.kind === 'assistant' && it.turn === turn && it.step === step) return it
    }
    const it = { kind: 'assistant', turn, step, text: '', reasoning: '', calls: [], partial: true }
    S.items.push(it)
    return it
  }

  // 流式增量：只往 Text 节点追加，不做整段重写（避免长回答越写越卡）
  const liveDirty = new Set()
  let liveRafQueued = false

  function patchLive(item, opt) {
    if (item) {
      liveDirty.add(item)
      if (opt && opt.tools) item._toolsDirty = true
    }
    if (liveRafQueued) return
    liveRafQueued = true
    requestAnimationFrame(() => {
      liveRafQueued = false
      const stick = nearBottom()
      for (const it of liveDirty) applyLivePatch(it)
      liveDirty.clear()
      if (stick) scrollBottom(false)
    })
  }

  function applyLivePatch(item) {
    if (!S.itemNodes.has(item)) { renderMessages(); return }

    // 思考内容
    if (item.reasoning) {
      if (!item._thinkNode) ensureThinkBlock(item)
      if (item._thinkNode) {
        const have = item._thinkLen || 0
        if (item.reasoning.length > have) {
          item._thinkNode.appendData(item.reasoning.slice(have))
          item._thinkLen = item.reasoning.length
        }
      }
      syncThinkBlock(item)
    }

    // 正文
    if (item._textNode) {
      const have = item._textLen || 0
      if ((item.text || '').length > have) {
        item._textNode.appendData(item.text.slice(have))
        item._textLen = item.text.length
      }
    } else if (item._md && !item.partial) {
      renderMd(item._md, item.text || '')
    }

    // 工具卡片（只在有变化时重建）
    if (item._toolsDirty) {
      item._toolsDirty = false
      if (!item._tools) {
        item._tools = h('div', 'tools')
        if (item._md && item._md.parentNode) item._md.parentNode.insertBefore(item._tools, item._md)
        else if (item._body) item._body.appendChild(item._tools)
      }
      item._tools.innerHTML = ''
      item.calls.forEach((c) => item._tools.appendChild(toolCard(c)))
    }
  }

  // 就地重画某一条消息（拿到定稿的 Markdown），不影响其它条目和滚动位置
  function rerenderItem(item) {
    const oldNode = S.itemNodes.get(item)
    if (!oldNode || !oldNode.parentNode) { renderMessages({ instant: true }); return }
    const stick = nearBottom()
    const newNode = renderItem(item)
    oldNode.parentNode.replaceChild(newNode, oldNode)
    S.itemNodes.set(item, newNode)
    if (stick) scrollBottom(false)
  }

  function fixFinishText(it) {
    if (!it.text && it.reasoning) it.text = '（只返回了思考内容，没给正式回答）'
    if (!it.text && !it.reasoning && (!it.calls || !it.calls.length)) it.text = '（这一步没有输出）'
  }

  function applySessionEvent(ev) {
    const d = ev.data || {}
    switch (ev.type) {
      case 'user/message': {
        const msg = d.message || d
        if (msg && msg.source && msg.source.kind === 'tool') return
        if (S.seenSeqs.has(ev.seq)) return
        const texts = []
        let images = 0
        for (const b of msg.content || []) {
          if (b.type === 'text') texts.push(b.text || '')
          else if (b.type === 'image') images++
        }
        const text = texts.join('\n')
        if (!text && !images) return
        if (isRuntimeContext(text)) { S.seenSeqs.add(ev.seq); return }
        const synthetic = /^\s*<system-reminder>/i.test(text) || text.includes('<system-reminder>')
        // 与本地乐观插入的消息去重
        const optIdx = S.items.findIndex((it) => it.kind === 'user' && it.optimistic && it.text.trim() === text.trim())
        const item = { kind: 'user', text, images, seq: ev.seq, synthetic }
        const replaced = optIdx >= 0 ? S.items[optIdx] : null
        if (replaced) S.items[optIdx] = item
        else S.items.push(item)
        S.seenSeqs.add(ev.seq)
        S.running = true
        updateSendBtn()
        // 局部更新：只动这一条，别整页重绘（长对话里整页重绘会明显卡顿）
        if ($('messages').querySelector('.welcome') || $('messages').querySelector('.skeleton')) {
          renderMessages({ scroll: 'bottom', instant: true })
        } else if (replaced) {
          const oldNode = S.itemNodes.get(replaced)
          if (oldNode && oldNode.parentNode) {
            const newNode = renderItem(item)
            oldNode.parentNode.replaceChild(newNode, oldNode)
            S.itemNodes.delete(replaced)
            S.itemNodes.set(item, newNode)
          } else renderMessages({ instant: true })
        } else {
          const stick = nearBottom()
          const node = renderItem(item)
          S.itemNodes.set(item, node)
          $('messages').appendChild(node)
          if (stick) scrollBottom(false)
        }
        break
      }
      case 'assistant/chunk': {
        const ch = d.chunk || {}
        const it = findOrCreateStepItem(d.turn, d.step)
        it.partial = true
        if (ch.type === 'text-delta') it.text += ch.text || ''
        else if (ch.type === 'reasoning-delta') it.reasoning += ch.text || ''
        else if (ch.type === 'tool-call-delta') {
          let c = it.calls.find((x) => x.id === ch.id)
          if (!c) { c = { id: ch.id, name: ch.name || '工具', args: '', resultText: '', isError: false }; it.calls.push(c) }
          if (ch.name) c.name = ch.name
          c.args += ch.argumentsDelta || ''
          patchLive(it, { tools: true })
          break
        }
        S.running = true
        updateSendBtn()
        patchLive(it)
        break
      }
      case 'assistant/message': {
        const it = findOrCreateStepItem(d.turn, d.step)
        it.text = ''
        it.reasoning = ''
        it.calls = []
        it.partial = false
        it.interrupted = !!d.interrupted
        for (const b of (d.message && d.message.content) || []) {
          if (b.type === 'text') it.text += b.text || ''
          else if (b.type === 'reasoning') it.reasoning += b.text || ''
          else if (b.type === 'tool-call') {
            it.calls.push({ id: b.id, name: b.name, args: b.arguments || '', resultText: '', isError: false })
          } else if (b.type === 'tool-result') {
            const c = it.calls.find((x) => x.id === b.toolCallId)
            if (c) { c.resultText = resultToText(b.content); c.isError = !!b.isError }
          }
        }
        rerenderItem(it)
        break
      }
      case 'tool/call': {
        const it = findOrCreateStepItem(d.turn, d.step)
        if (!it.calls.find((x) => x.id === d.callId)) {
          it.calls.push({ id: d.callId, name: d.name, args: d.arguments || '', resultText: '', isError: false })
        }
        patchLive(it, { tools: true })
        break
      }
      case 'tool/result': {
        const msg = d.message
        for (const b of (msg && msg.content) || []) {
          if (b.type !== 'tool-result') continue
          for (const it of S.items) {
            if (it.kind !== 'assistant') continue
            const c = (it.calls || []).find((x) => x.id === b.toolCallId)
            if (c) {
              c.resultText = resultToText(b.content)
              c.isError = !!b.isError
              patchLive(it, { tools: true })
            }
          }
        }
        break
      }
      case 'turn/end': {
        S.running = false
        updateSendBtn()
        // 把还在流式的条目就地定稿（Markdown 化），不整页重绘
        let any = false
        for (const it of S.items) {
          if (it.kind === 'assistant' && it.partial) {
            it.partial = false
            fixFinishText(it)
            rerenderItem(it)
            any = true
          }
        }
        if (!any) finishStreamingState()
        break
      }
      case 'session/title': {
        const t = d.title || d.value
        if (typeof t === 'string' && t.trim()) {
          S.currentTitle = t.trim()
          $('chatTitle').textContent = S.currentTitle
          const c = S.dshSessions.find((x) => x.id === S.currentId)
          if (c) c.title = S.currentTitle
          renderConvList()
        }
        break
      }
      default:
        break
    }
  }

  function resultToText(content) {
    if (!content) return ''
    if (typeof content === 'string') return content
    const parts = []
    for (const b of content) {
      if (!b) continue
      if (b.type === 'text') parts.push(b.text || '')
      else if (b.type === 'tool-result') parts.push(resultToText(b.content))
      else if (b.type === 'image') parts.push('[图片]')
    }
    const s = parts.join('')
    return s.length > 4000 ? s.slice(0, 4000) + '\n…（已截断）' : s
  }

  function finishStreamingState() {
    for (const it of S.items) {
      if (it.kind === 'assistant' && it.partial) {
        // 未收到定稿但这一轮已经结束 → 当作定稿渲染
        if (!S.running) it.partial = false
      }
    }
  }

  function onDshFrame(method, payload, rpcId) {
    switch (method) {
      case 'session/event': {
        const sid = payload.sessionId
        const ev = payload.event
        if (!ev) return
        if (sid !== S.currentId) {
          if (ev.type === 'turn/end') {
            const c = S.dshSessions.find((x) => x.id === sid)
            if (c) { c.running = false; renderConvList() }
          }
          if (ev.type === 'user/message' || ev.type === 'assistant/message') {
            const c = S.dshSessions.find((x) => x.id === sid)
            if (c) { c.updatedAt = Date.now() }
            if (sid !== S.currentId) S.unread.add(sid)
            renderConvList()
          }
          return
        }
        applySessionEvent(ev)
        break
      }
      case 'session/subscribed':
      case 'session/queue':
      case 'session/jobs':
        break
      case 'session/projection': {
        if (payload.key === 'title') {
          const sid = payload.sessionId
          const val = payload.value
          const c = S.dshSessions.find((x) => x.id === sid)
          if (c && typeof val === 'string' && val !== c.title) {
            c.title = val
            if (sid === S.currentId) { S.currentTitle = val; $('chatTitle').textContent = val }
            renderConvList()
          }
        }
        break
      }
      case 'host/session-status': {
        const c = S.dshSessions.find((x) => x.id === payload.sessionId)
        if (c) {
          c.running = !!payload.running
          if (c.id === S.currentId) { S.running = c.running; updateSendBtn() }
          renderConvList()
        }
        break
      }
      case 'host/session-added':
      case 'host/session-removed':
      case 'host/workspace-changed':
        scheduleSessionRefresh()
        break
      case 'approval/requested': {
        showLiveBanner('这个会话正在等待批准（' + (payload.toolName || '工具') + '）—— 请到 DSH 界面处理')
        break
      }
      case 'question/requested': {
        showLiveBanner('这个会话在等你回答问题 —— 请到 DSH 界面回答')
        break
      }
      case 'stream/error': {
        const msg = '事件流错误：' + (payload.error && payload.error.message || '未知')
        toast(msg, true)
        if (S.currentId) {
          S.items.push({ kind: 'error', text: msg })
          renderMessages({ scroll: 'bottom' })
        }
        break
      }
      default:
        break
    }
  }

  let bannerTimer = null
  function showLiveBanner(text) {
    const b = $('liveBanner')
    b.textContent = text
    b.classList.remove('hidden')
    clearTimeout(bannerTimer)
    bannerTimer = setTimeout(() => b.classList.add('hidden'), 12000)
  }

  function scheduleSessionRefresh() {
    clearTimeout(S.dshTimer)
    S.dshTimer = setTimeout(() => { refreshSessions().catch(() => {}) }, 600)
  }

  // ------------------------------------------------------------------ 本地模式事件
  function onLocalEvent(event, data) {
    if (data && data.connId && data.connId !== S.connId) return   // 别的页面的会话，不串台
    switch (event) {
      case 'conv-updated':
      case 'conv-title': {
        if (data.meta) {
          const i = S.localConvs.findIndex((c) => c.id === data.meta.id)
          if (i >= 0) S.localConvs[i] = data.meta
          else S.localConvs.unshift(data.meta)
          if (data.meta.id === S.currentId) {
            S.currentTitle = data.meta.title
            $('chatTitle').textContent = data.meta.title
          }
        } else if (data.id && data.title) {
          const c = S.localConvs.find((x) => x.id === data.id)
          if (c) c.title = data.title
          if (data.id === S.currentId) { S.currentTitle = data.title; $('chatTitle').textContent = data.title }
        }
        renderConvList()
        break
      }
      case 'conv-deleted': {
        S.localConvs = S.localConvs.filter((c) => c.id !== data.id)
        if (data.id === S.currentId) { S.currentId = null; S.items = []; renderMessages() }
        renderConvList()
        break
      }
      case 'msg-appended': {
        if (data.conversationId !== S.currentId) return
        if (data.message && data.message.role === 'user') {
          const idx = S.items.findIndex((it) => it.kind === 'user' && it.optimistic)
          const item = { kind: 'user', text: data.message.content }
          if (idx >= 0) S.items[idx] = item
          else S.items.push(item)
          S.running = true
          updateSendBtn()
          renderMessages()
        }
        break
      }
      case 'run-start': {
        if (data.conversationId !== S.currentId) return
        S.running = true
        updateSendBtn()
        S.items.push({ kind: 'assistant', text: '', reasoning: '', calls: [], partial: true })
        renderMessages()
        break
      }
      case 'run-delta': {
        if (data.conversationId !== S.currentId) return
        let it = null
        for (let i = S.items.length - 1; i >= 0; i--) {
          if (S.items[i].kind === 'assistant' && S.items[i].partial) { it = S.items[i]; break }
        }
        if (!it) {
          it = { kind: 'assistant', text: '', reasoning: '', calls: [], partial: true }
          S.items.push(it)
          renderMessages()
        }
        if (data.content) it.text += data.content
        if (data.reasoning) it.reasoning += data.reasoning
        patchLive(it)
        break
      }
      case 'run-end': {
        if (data.conversationId !== S.currentId) return
        S.running = false
        updateSendBtn()
        let it = null
        for (let i = S.items.length - 1; i >= 0; i--) {
          if (S.items[i].kind === 'assistant' && S.items[i].partial) { it = S.items[i]; break }
        }
        if (it) {
          it.partial = false
          if (data.message) {
            it.text = data.message.content || it.text
            it.reasoning = data.message.reasoning || it.reasoning
            it.durationMs = data.message.durationMs || 0
          }
          if (data.error) it.error = data.error
        }
        renderMessages()
        break
      }
      default:
        break
    }
  }

  // ------------------------------------------------------------------ SSE / 断线自愈
  function setConnBad(bad, why) {
    if (S.connBad === bad) return
    S.connBad = bad
    const b = $('connBanner')
    if (b) {
      b.textContent = bad ? ('连接中断，正在重连…' + (why ? '（' + why + '）' : '')) : ''
      b.classList.toggle('hidden', !bad)
    }
    if (!bad) toast('已重新连上')
  }

  let resyncTimer = null
  function scheduleResync(delay) {
    clearTimeout(resyncTimer)
    resyncTimer = setTimeout(() => { resyncAll().catch(() => {}) }, delay || 800)
  }

  // 重连后补一次全量对齐：漏掉的事件靠"重新拉一遍"补回来
  async function resyncAll() {
    if (S.connBad) return
    try { await refreshSessions() } catch { /* ignore */ }
    if (S.currentId) await revalidateCurrent()
  }

  async function revalidateCurrent() {
    if (S.mode !== 'dsh' || !S.currentId) return
    const id = S.currentId
    const token = S.openToken
    try {
      const r = await api('/dsh/sessions/' + id + '/history?maxMessages=40')
      if (token !== S.openToken || id !== S.currentId) return
      const items = r.items || []
      const stick = nearBottom()
      const changed = mergeTail(items, !!r.hasMore, r.firstSeq || 0)
      if (!changed) return
      const last = S.items[S.items.length - 1]
      if (last && last.kind === 'assistant' && last.partial) S.running = true
      finishStreamingState()
      rememberCurrent()
      renderMessages({ scroll: stick ? 'bottom' : undefined, instant: true })
      updateSendBtn()
    } catch { /* ignore */ }
  }

  // 0.2.x / 桌面软件没有 SSE 事件流（协议不同），用 1.5 秒一次的历史轮询补上。
  // 只在当前页面是 dsh2、并且有生成中的会话时跑，空闲 3 拍自动停。
  let dsh2Timer = null
  function isDsh2() {
    return S.mode === 'dsh' && S.conn && S.conn.api === 'dsh2'
  }
  function stopDsh2Poll() {
    if (dsh2Timer) clearInterval(dsh2Timer)
    dsh2Timer = null
  }
  function startDsh2Poll() {
    if (!isDsh2() || dsh2Timer) return
    let quiet = 0
    dsh2Timer = setInterval(async () => {
      if (S.mode !== 'dsh' || !S.currentId || !isDsh2()) { stopDsh2Poll(); return }
      if (document.visibilityState === 'hidden') return
      await revalidateCurrent()
      if (S.running) quiet = 0
      else if (++quiet >= 3) stopDsh2Poll()
    }, 1500)
  }

  function connectEvents() {
    if (S.evtSrc) { try { S.evtSrc.close() } catch { /* ignore */ } }
    const es = new EventSource('./api/events')
    S.evtSrc = es

    es.onopen = () => {
      const wasBad = S.connBad
      setConnBad(false)
      if (wasBad) scheduleResync(400)
    }

    es.addEventListener('hello', (e) => {
      let j = {}
      try { j = JSON.parse(e.data) } catch { /* ignore */ }
      S.dshStatus = (j.dshById && j.dshById[S.connId]) || j.dsh || null
      S.lastHealthOkAt = Date.now()
      updateHubUi()
      // 不是第一次连上 → 说明刚才断过，补一次对齐
      if (S.esOpened) scheduleResync(300)
      S.esOpened = true
      if (Array.isArray(j.running) && S.currentId && j.running.indexOf(S.currentId) >= 0) {
        S.running = true
        updateSendBtn()
      }
    })

    es.addEventListener('dsh', (e) => {
      let j
      try { j = JSON.parse(e.data) } catch { return }
      if (j.connId && j.connId !== S.connId) return   // 别的页面的会话，不混进来
      S.lastDshFrameAt = Date.now()
      if (j.channel === 'hub') {
        if (j.method === 'hub/open' || j.method === 'hub/close') { S.dshStatus = null; refreshMe().catch(() => {}) }
        return
      }
      onDshFrame(j.method, j.payload || {}, j.rpcId)
    })

    es.addEventListener('conn', (e) => {
      let j
      try { j = JSON.parse(e.data) } catch { return }
      onLocalEvent(j.event, j.data || {}, j.connId)
    })

    es.addEventListener('hub', (e) => {
      let j
      try { j = JSON.parse(e.data) } catch { return }
      if (j.connId && j.connId !== S.connId) return
      S.dshStatus = j.dsh
      updateHubUi()
    })

    // 会话型服务（0.2.x 轮询 / 0.1.x 归档变化）通知列表变了
    es.addEventListener('dsh-sync', (e) => {
      let j
      try { j = JSON.parse(e.data) } catch { return }
      if (j.connId && j.connId !== S.connId) return
      refreshSessions().catch(() => {})
      if (S.showArchived) loadArchived().catch(() => {})
    })

    es.onerror = () => {
      // EventSource 会自己重连（服务端已下发 retry: 2000）
      setConnBad(true, '事件流断开')
      updateHubUi()
      scheduleResync(3000)
    }
  }

  // 网络层的兜底：EventSource 在某些手机上（后台、切网）会"假活"，
  // 所以每 20 秒自己打一次健康检查；连续失败就重建事件流。
  let healthTimer = null
  function startWatchdog() {
    clearInterval(healthTimer)
    healthTimer = setInterval(async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const r = await fetch('./api/health', { signal: AbortSignal.timeout(6000), cache: 'no-store' })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        S.lastHealthOkAt = Date.now()
        if (S.healthFails) { S.healthFails = 0; setConnBad(false) }
        if (S.evtSrc && S.evtSrc.readyState === 2) connectEvents()
        // 明明在生成却很久没有帧 → 可能漏了 turn/end，主动对一次
        if (S.running && Date.now() - S.lastDshFrameAt > 30000) {
          refreshSessions().catch(() => {})
          revalidateCurrent().catch(() => {})
        }
      } catch {
        S.healthFails = (S.healthFails || 0) + 1
        if (S.healthFails >= 2) {
          setConnBad(true, '服务器无响应')
          if (S.evtSrc) { try { S.evtSrc.close() } catch { /* ignore */ } }
          connectEvents()
        }
      }
    }, 20000)
  }

  window.addEventListener('online', () => {
    setConnBad(false)
    if (S.evtSrc) { try { S.evtSrc.close() } catch { /* ignore */ } }
    connectEvents()
    scheduleResync(500)
  })
  window.addEventListener('offline', () => setConnBad(true, '设备离线'))

  function updateHubUi() {
    const dot = $('dshDot')
    const label = $('dshLabel')
    const st = S.dshStatus
    if (!st) { dot.className = 'dot bad'; label.textContent = '重连中…'; $('chatSub').textContent = subtitleText(); return }
    if (st.reachable || st.mux === 'open') {
      dot.className = 'dot ok'
      label.textContent = st.kind === 'dsh2' ? 'DSH 软件已连接' : 'DSH 已连接'
    } else {
      dot.className = 'dot bad'
      label.textContent = st.error ? 'DSH：' + String(st.error).slice(0, 22) : 'DSH 未连接'
    }
    $('chatSub').textContent = subtitleText()
  }

  // ------------------------------------------------------------------ 发送
  function updateSendBtn() {
    const b = $('sendBtn')
    if (S.running) b.classList.add('stop')
    else b.classList.remove('stop')
    if ($('runSpin')) $('runSpin').classList.toggle('hidden', !S.running)
    $('input').placeholder = S.running ? '继续输入可排队…' : '发消息…'
  }

  async function ensureSession() {
    if (S.currentId) return S.currentId
    if (S.mode !== 'dsh') {
      const r = await api('/conn/' + S.connId + '/conversations', { method: 'POST', body: {} })
      S.localConvs.unshift(r.conversation)
      S.currentId = r.conversation.id
      S.currentTitle = r.conversation.title
      LS.set('mc_last_local', S.currentId)
      return S.currentId
    }
    const cwd = LS.get('mc_cwd', (S.me && S.me.dsh.defaultCwd) || '')
    const r = await api('/dsh/sessions', { method: 'POST', body: { cwd: cwd || undefined } })
    S.currentId = r.sessionId
    S.currentTitle = '新对话'
    LS.set('mc_last_dsh', r.sessionId)
    $('chatTitle').textContent = '新对话'
    await refreshSessions()
    return r.sessionId
  }

  async function send() {
    const input = $('input')
    const text = input.value.trim()
    if (!text) return

    // 乐观上屏
    input.value = ''
    input.style.height = 'auto'

    try {
      if (S.mode === 'dsh') {
        const id = await ensureSession()
        const welcome = $('welcome')
        if (welcome) welcome.classList.add('hidden')
        S.items.push({ kind: 'user', text, optimistic: true })
        renderMessages({ scroll: 'bottom' })
        updateSendBtn()
        await api('/dsh/sessions/' + id + '/prompt', {
          method: 'POST',
          body: { text, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
        })
        S.running = true
        updateSendBtn()
        startDsh2Poll()
        if (!S.currentTitle || S.currentTitle === '新对话') {
          S.currentTitle = text.replace(/\s+/g, ' ').slice(0, 24)
          $('chatTitle').textContent = S.currentTitle
        }
      } else {
        const id = await ensureSession()
        S.items.push({ kind: 'user', text, optimistic: true })
        renderMessages({ scroll: 'bottom' })
        S.running = true
        updateSendBtn()
        await api('/conn/' + S.connId + '/chat', { method: 'POST', body: { conversationId: id, text } })
      }
    } catch (e) {
      // 回滚乐观消息，并在对话里留一条可见的错误
      S.items = S.items.filter((it) => !it.optimistic)
      S.items.push({ kind: 'error', text: e.message })
      renderMessages({ scroll: 'bottom' })
      S.running = false
      updateSendBtn()
      input.value = text
      toast(e.message, true)
    }
  }

  async function stopRun() {
    if (!S.currentId) return
    try {
      if (S.mode === 'dsh') await api('/dsh/sessions/' + S.currentId + '/cancel', { method: 'POST' })
      else await api('/conn/' + S.connId + '/stop', { method: 'POST', body: { conversationId: S.currentId } })
      toast('已请求停止')
    } catch (e) { toast(e.message, true) }
  }

  async function regenerateLocal() {
    if (S.mode !== 'local' || !S.currentId) return
    try {
      await api('/conn/' + S.connId + '/chat', { method: 'POST', body: { conversationId: S.currentId, regenerate: true } })
      S.running = true
      updateSendBtn()
    } catch (e) { toast(e.message, true) }
  }

  // ------------------------------------------------------------------ 加载数据
  async function refreshMe() {
    const me = await api('/me')
    applyMe(me)
    applyTheme()
    $('chatTitle').textContent = S.currentTitle || me.appName || 'AI 对话'
    return me
  }

  async function refreshSessions() {
    if (S.mode === 'dsh' && (!S.connId || !S.conn)) return
    if (S.mode === 'dsh') {
      const r = await api('/dsh/sessions')
      S.dshSessions = r.sessions || []
      S.workspaces = r.workspaces || []
      S.archivedCount = r.archivedCount || 0
      S.dshStatus = r.dsh || S.dshStatus
      const cur = S.dshSessions.find((c) => c.id === S.currentId)
      if (cur) { S.running = cur.running; S.currentTitle = cur.title; $('chatTitle').textContent = cur.title }
      updateHubUi()
      saveListCache()
    } else {
      const r = await api('/conn/' + S.connId + '/conversations')
      S.localConvs = r.conversations || []
    }
    renderConvList()
  }

  // ------------------------------------------------------------------ 抽屉 / 面板
  const app = $('app')
  function openDrawer() { app.classList.add('drawer-open') }
  function closeDrawer() { app.classList.remove('drawer-open') }
  $('menuBtn').onclick = () => app.classList.toggle('drawer-open')
  $('scrim').onclick = closeDrawer

  // ------------------------------------------------------------------ 页面（连接）
  function connKindLabel(c) {
    if (c.kind !== 'dsh') return '标准接口'
    return c.api === 'dsh2' ? 'DSH 软件' : '会话型'
  }

  function setActiveConn(id, { silent } = {}) {
    const c = S.conns.find((x) => x.id === id) || S.conns[0]
    if (!c) return
    S.conn = c
    S.connId = c.id
    S.mode = c.kind === 'dsh' ? 'dsh' : 'local'
    if (S.me && S.me.dshById && S.me.dshById[c.id]) S.dshStatus = S.me.dshById[c.id]
    LS.set('mc_conn', c.id)
    LS.set('mc_mode', S.mode)
    renderConnList()
  }

  function renderConnList() {
    const box = $('connList')
    if (!box) return
    box.innerHTML = ''
    for (const c of S.conns) {
      const b = h('button', 'conn-item' + (c.id === S.connId ? ' on' : ''))
      const dot = h('span', 'conn-dot ' + (c.kind === 'dsh' ? 'k-dsh' : 'k-api'))
      const name = h('span', 'conn-name', c.name || c.id)
      const tag = h('span', 'conn-tag', connKindLabel(c))
      const edit = h('button', 'conn-edit', '编辑')
      edit.title = '改地址 / 令牌 / 名称'
      edit.onclick = (e) => { e.stopPropagation(); openConnSheet(c) }
      b.appendChild(dot); b.appendChild(name); b.appendChild(tag); b.appendChild(edit)
      b.onclick = () => { switchConn(c.id) }
      box.appendChild(b)
    }
    if (!S.conns.length) {
      box.appendChild(h('div', 'conn-empty', '还没有页面，点上面的「＋ 添加」连一个 AI'))
    }
  }

  // 一条页面都不剩时的界面：别让用户对着一片空白不知道怎么办
  function showNoConn() {
    S.conn = null
    S.connId = ''
    S.currentId = null
    S.items = []
    renderConnList()
    renderConvList()
    renderMessages()
    updateSendBtn()
    showNoConnWelcome()
  }

  function showNoConnWelcome() {
    $('chatTitle').textContent = '还没有页面'
    $('chatSub').textContent = '点抽屉上方的「＋ 添加」，连本机 DSH 或任意 OpenAI 兼容服务'
    const box = $('messages')
    if (!box) return
    box.innerHTML = ''
    const wrap = h('div', 'welcome')
    wrap.appendChild(h('h2', null, '先加一个页面'))
    wrap.appendChild(h('p', null, '页面 = 一条连接。DSH 只要填地址；其它 AI 填 Base URL、密钥、模型名就能聊。'))
    const b = h('button', 'btn-primary', '＋ 添加页面')
    b.onclick = () => { editingConn = null; openConnSheet(null) }
    wrap.appendChild(b)
    box.appendChild(wrap)
  }

  function switchConn(id) {
    const c = S.conns.find((x) => x.id === id)
    if (!c) return
    setActiveConn(id)
    S.currentId = null
    S.items = []
    S.running = false
    S.showArchived = false
    S.archivedSessions = []
    stopDsh2Poll()
    renderMessages()
    updateSendBtn()
    $('chatTitle').textContent = c.name || 'AI 对话'
    $('chatSub').textContent = subtitleText()
    refreshSessions().then(() => {
      const last = LS.get('mc_last_' + S.mode, '')
      const list = sessionsForMode()
      if (last && list.some((x) => x.id === last)) openSession(last)
      else {
        renderMessages(); updateSendBtn()
        $('chatTitle').textContent = c.name || 'AI 对话'
        $('chatSub').textContent = subtitleText()
      }
    }).catch((err) => toast(err.message, true))
  }

  // ---- 添加 / 编辑页面 ----
  let editingConn = null
  let editingApi = ''
  function connFormKind(kind) {
    $('connKindSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.kind === kind))
    const isOpenAI = kind === 'openai'
    $('connUrlRow').style.display = ''
    $('connUrlLabel').textContent = isOpenAI ? 'Base URL' : '服务地址'
    $('connUrl').placeholder = isOpenAI ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:3080'
    $('connUrlHint').textContent = isOpenAI ? '末尾写到 /v1。' : '桌面软件端口每次启动可能不同。'
    $('connKeyRow').style.display = isOpenAI ? '' : 'none'
    $('connModelRow').style.display = isOpenAI ? '' : 'none'
    $('connTestRow').style.display = ''
    if ($('connLocalAuthRow')) $('connLocalAuthRow').style.display = isOpenAI ? 'none' : ''
    if ($('connDiscoverBtn')) $('connDiscoverBtn').style.display = isOpenAI ? 'none' : ''
    updateDshAuthRows()
  }

  // 只用本机凭据时，令牌/日志跟随/说明都不需要显示
  function updateDshAuthRows() {
    const isOpenAI = currentConnKind() === 'openai'
    const local = !!(($('connLocalAuth') || {}).checked)
    if ($('connTokenRow')) $('connTokenRow').style.display = (!isOpenAI && !local) ? '' : 'none'
    if ($('connAutoDesktopRow')) $('connAutoDesktopRow').style.display = (!isOpenAI && !local) ? '' : 'none'
    if ($('connLocalAuthHint')) $('connLocalAuthHint').style.display = (!isOpenAI && local) ? '' : 'none'
  }

  // 把用户粘进来的东西拆成：地址 / 令牌 / Cookie
  // 支持：带 ?token= 的完整地址、单独的令牌、dsh-auth-xxx=yyy Cookie
  function parseDshAuth(raw, baseUrl) {
    let s = String(raw || '').trim()
    let base = String(baseUrl || '').trim()
    let token = ''
    let cookie = ''
    if (!s) return { base, token, cookie }
    if (/^https?:\/\//i.test(s)) {
      try {
        const u = new URL(s)
        token = u.searchParams.get('token') || ''
        base = u.origin
        s = ''
      } catch { /* 当成普通字符串 */ }
    }
    if (s && /^dsh-auth-[^=]+=/.test(s)) cookie = s
    else if (s) token = s
    return { base, token, cookie }
  }
  function currentConnKind() {
    const on = $('connKindSeg').querySelector('button.on')
    return (on && on.dataset.kind) === 'openai' ? 'openai' : 'dsh'
  }
  function renderPresetChips() {
    const box = $('presetChips')
    box.innerHTML = ''
    for (const p of S.presets || []) {
      const b = h('button', 'chip', p.name)
      b.onclick = () => {
        $('connName').value = p.name
        connFormKind(p.kind || 'openai')
        $('connUrl').value = p.baseUrl || ''
        $('connModel').value = p.model || ''
        $('connKey').value = ''
        $('connKeyHint').textContent = p.note || ''
        editingApi = p.api || ''
        if (p.note && p.kind === 'dsh') $('connTokenHint').textContent = p.note
      }
      box.appendChild(b)
    }
  }
  function openConnSheet(conn) {
    editingConn = conn || null
    editingApi = conn ? (conn.api || '') : ''
    $('connSheetTitle').textContent = conn ? '编辑页面' : '添加页面'
    $('connName').value = conn ? conn.name : ''
    $('connUrl').value = conn ? (conn.baseUrl || '') : ''
    $('connModel').value = conn ? (conn.model || '') : ''
    $('connKey').value = ''
    $('connToken').value = ''
    const hasSecret = !!(conn && (conn.tokenSet || conn.cookieSet))
    $('connTokenHint').textContent = hasSecret
      ? '已保存' + (conn.cookieSet ? 'Cookie' : '令牌') + '（尾号 ' + (conn.tokenTail || '') + '），留空不改。'
      : '远程部署才需要；同机桌面软件用本机凭据。'
    $('connKeyHint').textContent = conn && conn.apiKeySet
      ? '已保存（尾号 ' + conn.apiKeyTail + '），留空不改。'
      : '留空用默认；云端必填。'
    $('connTestOut').textContent = ''
    $('connDelete').style.display = conn ? '' : 'none'
    $('connAutoOpen').checked = !!(conn && conn.autoOpen)
    if ($('connAutoDesktop')) $('connAutoDesktop').checked = !!(conn && conn.autoDesktop)
    if ($('connLocalAuth')) $('connLocalAuth').checked = !!(conn && conn.localAuth)
    connFormKind(conn ? conn.kind : 'openai')
    renderPresetChips()
    openSheet('connSheet')
  }
  async function saveConn() {
    const kind = currentConnKind()
    const body = {
      name: $('connName').value.trim() || (kind === 'dsh' ? '会话型服务' : '自定义 AI'),
      kind,
      baseUrl: $('connUrl').value.trim(),
      model: $('connModel').value.trim(),
      autoOpen: $('connAutoOpen').checked
    }
    const key = $('connKey').value.trim()
    if (key) body.apiKey = key
    if (kind === 'openai' && !body.baseUrl) { toast('OpenAI 兼容连接必须填 Base URL', true); return }
    if (kind === 'dsh') {
      const parsed = parseDshAuth($('connToken').value, body.baseUrl)
      if (parsed.base) body.baseUrl = parsed.base
      if (parsed.token) body.token = parsed.token
      if (parsed.cookie) body.cookie = parsed.cookie
      body.api = editingApi || (editingConn && editingConn.api) || ''
      body.autoDesktop = !!(($('connAutoDesktop') || {}).checked)
      body.localAuth = !!(($('connLocalAuth') || {}).checked)
      if (!body.baseUrl) { toast('会话型页面必须填服务地址', true); return }
    }
    try {
      if (editingConn) {
        const r = await api('/connections/' + editingConn.id, { method: 'PATCH', body })
        const i = S.conns.findIndex((c) => c.id === editingConn.id)
        if (i >= 0 && r.connection) S.conns[i] = r.connection
        toast('已保存')
      } else {
        const r = await api('/connections', { method: 'POST', body })
        S.conns.push(r.connection)
        toast('已添加页面')
        closeSheet('connSheet')
        switchConn(r.connection.id)
        return
      }
      closeSheet('connSheet')
      renderConnList()
    } catch (e) { toast(e.message, true) }
  }
  async function testConn() {
    const kind = currentConnKind()
    const out = $('connTestOut')
    const url = $('connUrl').value.trim()
    if (!url) { out.textContent = kind === 'dsh' ? '先填服务地址' : '先填 Base URL'; return }
    out.textContent = '测试中…'
    out.style.color = ''
    const id = editingConn ? editingConn.id : ''
    try {
      let r
      if (kind === 'dsh') {
        const parsed = parseDshAuth($('connToken').value, url)
        const body = {
          baseUrl: parsed.base || url,
          api: editingApi || (editingConn && editingConn.api) || '',
          localAuth: !!(($('connLocalAuth') || {}).checked)
        }
        if (parsed.token) body.token = parsed.token
        if (parsed.cookie) body.cookie = parsed.cookie
        if (id) {
          // 先把表单里的地址/令牌存一下再测（留空的令牌不会覆盖已保存的）
          await api('/connections/' + id, { method: 'PATCH', body })
          r = await api('/connections/' + id + '/test', { method: 'POST' })
        } else {
          r = await api('/connections/test', { method: 'POST', body: Object.assign({ kind: 'dsh' }, body) })
        }
        if (r.api) editingApi = r.api
        if (r.ok) {
          $('connTokenHint').textContent = r.api === 'dsh2'
            ? '✓ 已连上 DSH 软件（会话与桌面端共用）。Cookie 已保存，下次不用再填。'
            : '✓ 已连上会话型服务。这个版本不需要令牌。'
        }
      } else {
        if (id) {
          await api('/connections/' + id, { method: 'PATCH', body: { baseUrl: url, model: $('connModel').value.trim() } })
          r = await api('/connections/' + id + '/test', { method: 'POST' })
        } else {
          r = await api('/connections/test', { method: 'POST', body: { kind: 'openai', baseUrl: url, apiKey: $('connKey').value.trim(), model: $('connModel').value.trim() } })
        }
      }
      out.textContent = (r.ok ? '✓ ' : '✗ ') + (r.detail || '') + (r.models && r.models.length ? '　模型：' + r.models.slice(0, 4).join(', ') : '') + '　' + (r.ms || 0) + 'ms'
      out.style.color = r.ok ? '' : '#c0392b'
      if (!r.ok && r.code === 'auth-required') $('connTokenHint').textContent = '这个地址需要令牌：把带 ?token= 的地址整条粘贴到上面，或点「检测本机 DSH」自动找。'
    } catch (e) {
      out.textContent = '✗ ' + e.message
      out.style.color = '#c0392b'
    }
  }
  async function deleteConn() {
    if (!editingConn) return
    if (!confirm('删除页面「' + editingConn.name + '」？会话记录不会一起删。')) return
    try {
      await api('/connections/' + editingConn.id, { method: 'DELETE' })
      S.conns = S.conns.filter((c) => c.id !== editingConn.id)
      closeSheet('connSheet')
      toast('已删除')
      if (!S.conns.length) { showNoConn() }
      else if (S.connId === editingConn.id) switchConn(S.conns[0].id)
      else renderConnList()
    } catch (e) { toast(e.message, true) }
  }

  $('addConn').onclick = () => { editingConn = null; openConnSheet(null) }
  $('connKindSeg').onclick = (e) => {
    const b = e.target.closest('button')
    if (b) connFormKind(b.dataset.kind)
  }
  if ($('connLocalAuth')) $('connLocalAuth').addEventListener('change', updateDshAuthRows)
  $('connSave').onclick = saveConn
  $('connTestBtn').onclick = testConn
  if ($('connDiscoverBtn')) $('connDiscoverBtn').onclick = async () => {
    const out = $('connTestOut')
    out.textContent = '正在找本机 DSH…'
    out.style.color = ''
    try {
      const r = await api('/dsh/discover')
      if (!r.found) { out.textContent = '没找到：' + (r.detail || '本机 DSH 没在跑'); return }
      $('connUrl').value = r.baseUrl || ''
      if (r.token) $('connToken').value = r.token
      if (r.api) editingApi = r.api
      if (r.api === 'dsh2' && r.token && $('connAutoDesktop')) $('connAutoDesktop').checked = true
      if (r.localAuth) {
        editingApi = 'dsh2'
        if ($('connLocalAuth')) $('connLocalAuth').checked = true
        if ($('connAutoDesktop')) $('connAutoDesktop').checked = true
        updateDshAuthRows()
      }
      out.textContent = (r.api === 'dsh2' ? '找到 DSH 软件：' : '找到会话型服务：') + r.baseUrl
        + (r.localAuth ? '（用本机凭据自动登录）' : (r.token ? '（已填入令牌）' : (r.needAuth ? '（需要令牌/Cookie）' : '')))
      if (r.token || !r.needAuth) await testConn()
    } catch (e) {
      out.textContent = '✗ ' + e.message
      out.style.color = '#c0392b'
    }
  }
  $('connDelete').onclick = deleteConn
  $('closeConnSheet').onclick = () => closeSheet('connSheet')
  $('convRename').onclick = convRename
  $('convArchive').onclick = convArchive
  $('convUnarchive').onclick = convUnarchive
  $('convDelete').onclick = convDelete
  $('closeConvSheet').onclick = () => { closeSheet('convSheet'); S.menuConv = null }

  $('search').addEventListener('input', (e) => {
    S.search = e.target.value.trim()
    renderConvList()
  })

  // 新建对话
  function openNewSheet() {
    $('newCwd').value = LS.get('mc_cwd', (S.me && S.me.dsh.defaultCwd) || '')
    const box = $('newCwdChips')
    box.innerHTML = ''
    const add = (label, val) => {
      if (!val) return
      const b = h('button', 'chip', label)
      b.onclick = () => { $('newCwd').value = val }
      box.appendChild(b)
    }
    if (S.me && S.me.dsh.defaultCwd) add('默认目录', S.me.dsh.defaultCwd)
    S.dshSessions.slice(0, 5).forEach((c) => { if (c.cwd) add(c.cwd.replace(/^.*\\/, '…\\'), c.cwd) })
    api('/dsh/workspaces').then((r) => {
      (r.workspaces || []).slice(0, 6).forEach((w) => add(w.title || w.path || w.workspaceId, w.path))
    }).catch(() => {})
    openSheet('newSheet')
  }
  async function doCreate() {
    const cwd = $('newCwd').value.trim()
    LS.set('mc_cwd', cwd)
    closeSheet('newSheet')
    try {
      if (S.mode === 'dsh') {
        const r = await api('/dsh/sessions', { method: 'POST', body: { cwd: cwd || undefined, createDir: false } })
        await refreshSessions()
        await openSession(r.sessionId)
        toast('已新建对话')
      } else {
        const r = await api('/conn/' + S.connId + '/conversations', { method: 'POST', body: {} })
        S.localConvs.unshift(r.conversation)
        renderConvList()
        await openSession(r.conversation.id)
      }
    } catch (e) { toast(e.message, true) }
  }
  $('newChat').onclick = openNewSheet
  $('newChatTop').onclick = openNewSheet
  $('doCreate').onclick = doCreate
  $('closeNewSheet').onclick = () => closeSheet('newSheet')

  function openSheet(id) { closeDrawer(); $(id).classList.add('open') }
  function closeSheet(id) { $(id).classList.remove('open') }

  // 设置
  $('openSettings').onclick = async () => {
    try {
      const s = await api('/settings')
      $('setCwd').value = s.dsh.defaultCwd || ''
      $('setLocalOn').checked = !!s.local.enabled
      $('setLocalUrl').value = s.local.baseUrl || ''
      $('setLocalModel').value = s.local.model || ''
      $('setLocalMax').value = s.local.maxTokens || 4096
      $('setLocalTemp').value = s.local.temperature
      $('setLocalSys').value = s.local.systemPrompt || ''
      // ---- 自启动 ----
      const as = s.autostart || {}
      const boot = $('setAutoBoot')
      boot.checked = !!as.installed
      boot.disabled = !as.supported
      $('setAutoBootHint').textContent = as.supported
        ? (as.installed ? '已开启（计划任务 ' + (as.taskName || '') + '）' : '未开启')
        : '当前系统不支持'
      const cmd = $('setNpmCmd')
      if (cmd) cmd.textContent = as.npmCmd || 'npm start'
      // ---- 外网访问 ----
      const tu = s.tunnel || {}
      if ($('setPublicUrl')) $('setPublicUrl').value = (s.ui && s.ui.publicUrl) || ''
      const net = s.net || {}
      if ($('setNetHost')) $('setNetHost').value = (net.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1')
      if ($('setNetPort')) $('setNetPort').value = net.port || 8100
      // ---- 备份 ----
      const bk = s.backup || {}
      if (bk.localOnly !== undefined) applyBackupMode(bk.localOnly)
      if ($('setBackupOn')) $('setBackupOn').checked = bk.enabled !== false
      if ($('setBackupHours')) $('setBackupHours').value = bk.intervalHours || 6
      if ($('setBackupKeep')) $('setBackupKeep').value = bk.keep || 30
      if ($('setBackupDir')) $('setBackupDir').value = bk.dir || ''
      if ($('setDeployPw')) $('setDeployPw').value = ''
      loadBackupStatus().catch(() => {})
      const tools = []
      if (tu.tailscale) tools.push('Tailscale')
      if (tu.cloudflared) tools.push('cloudflared')
      if ($('setTunnelHint')) {
        $('setTunnelHint').textContent = tools.length ? '隧道目标要指向本机 ' + (net.port || 8100) + ' 端口；子路径要剥前缀。' : ''
        $('setTunnelHint').style.display = tools.length ? '' : 'none'
      }
      if ($('tunnelChips')) {
        const box = $('tunnelChips')
        box.innerHTML = ''
        const list = Array.isArray(tu.urls) ? tu.urls : []
        for (const u of list) {
          const b = h('button', 'chip', u)
          b.title = '点一下填入外网地址'
          b.onclick = () => {
            $('setPublicUrl').value = u
            $('setPublicUrl').dispatchEvent(new Event('change', { bubbles: true }))
          }
          box.appendChild(b)
        }
        if ($('tunnelUrlRow')) $('tunnelUrlRow').style.display = list.length ? '' : 'none'
      }
      const box = $('wsChips')
      box.innerHTML = ''
      if ($('wsChipsRow')) $('wsChipsRow').style.display = 'none'
      api('/dsh/workspaces').then((r) => {
        let n = 0
        ;(r.workspaces || []).slice(0, 8).forEach((w) => {
          const v = w.path || ''
          if (!v) return
          n++
          const b = h('button', 'chip', v.replace(/^.*\\/, '…\\'))
          b.onclick = () => { $('setCwd').value = v }
          box.appendChild(b)
        })
        if ($('wsChipsRow')) $('wsChipsRow').style.display = n ? '' : 'none'
      }).catch(() => {})
      openSheet('sheet')
    } catch (e) { toast(e.message, true) }
  }
  $('closeSheet').onclick = () => closeSheet('sheet')
  if ($('setNav')) $('setNav').onclick = (e) => {
    const b = e.target.closest('button[data-go]')
    if (!b) return
    const el = document.getElementById(b.dataset.go)
    if (!el) return
    const det = el.closest('details')
    if (det) det.open = true
    setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80)
  }
  if ($('openBackup')) $('openBackup').onclick = () => {
    $('openSettings').click()
    setTimeout(() => {
      const sec = $('setBackupSection')
      if (sec) sec.open = true
      const cfg = $('backupConfigRows')
      const el = (cfg && cfg.style.display !== 'none') ? $('setBackupOn') : $('backupExportBtn')
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      if ($('backupHint')) $('backupHint').style.outline = '2px solid var(--accent)'
    }, 700)
  }

  // 自启动开关：切换 Windows 计划任务（只有本机能操作，服务端会拒绝远程）
  $('setAutoBoot').addEventListener('change', async (e) => {
    const on = !!e.target.checked
    const hint = $('setAutoBootHint')
    hint.textContent = on ? '正在注册…' : '正在移除…'
    try {
      const r = await api('/settings/autostart', { method: 'POST', body: { enable: on } })
      if (!r.ok) throw new Error(r.error || '失败')
      hint.textContent = on ? '已注册：登录 Windows 自动启动网页端' : '已移除：登录不再自动启动'
      toast(on ? '已开启开机自启' : '已关闭开机自启')
    } catch (err) {
      e.target.checked = !on
      hint.textContent = '操作失败：' + err.message
      toast('操作失败：' + err.message, true)
    }
  })

  // 外网地址：改完就保存
  $('setPublicUrl').addEventListener('change', async (e) => {
    const v = String(e.target.value || '').trim()
    if (v && !/^https?:\/\//i.test(v)) { toast('外网地址要以 http:// 或 https:// 开头', true); return }
    try {
      await api('/settings', { method: 'PUT', body: { ui: { publicUrl: v } } })
      toast(v ? '外网地址已保存' : '已清空外网地址')
      refreshMe().catch(() => {})
    } catch (err) { toast(err.message, true) }
  })

  // ---- 监听地址 / 端口（改完要重启才生效）----
  async function saveNet() {
    try {
      const r = await api('/settings', {
        method: 'PUT',
        body: { net: { host: $('setNetHost').value, port: parseInt($('setNetPort').value, 10) } }
      })
      toast(r.restartRequired ? '已保存：需要重启服务才生效' : '已保存')
    } catch (err) { toast(err.message, true) }
  }
  if ($('setNetHost')) $('setNetHost').addEventListener('change', saveNet)
  if ($('setNetPort')) $('setNetPort').addEventListener('change', saveNet)

  // ---- 外网连通性自检：正常只显示"正常"；异常才列原因 ----
  if ($('netCheckBtn')) $('netCheckBtn').onclick = async () => {
    const out = $('netCheckOut')
    out.textContent = '正在自检…'
    out.style.color = ''
    try {
      const r = await api('/net/check')
      const problems = []
      if (r.listening.host === '127.0.0.1' || r.listening.host === 'localhost' || r.listening.host === '::1') {
        problems.push('只监听本机：把监听地址改成 0.0.0.0，改完重启服务')
      }
      if (!r.publicUrl) {
        problems.push('没有外网地址：先准备隧道，把隧道域名填到上面')
      } else {
        const d = r.dns || {}
        const pr = r.publicReachable || {}
        if (d.host && d.ok === false) problems.push('域名解析失败：' + (d.error || '检查域名拼写'))
        else if (!pr.ok) problems.push('外网地址打不开：检查隧道是否指向本机 ' + r.listening.port + ' 端口；用子路径的要剥掉前缀')
      }
      if (!r.connections) problems.push('还没有页面：先「＋ 添加」一个 AI 连接')
      if (!problems.length) {
        out.textContent = '正常'
        out.style.color = 'var(--ok)'
      } else {
        out.textContent = problems.map((p) => '· ' + p).join('\n')
        out.style.color = 'var(--danger)'
      }
    } catch (err) {
      out.textContent = '自检失败：' + err.message
      out.style.color = 'var(--danger)'
    }
  }

  // ---- 备份 ----
  // 部署端：完整备份设置 + 部署端密码。
  // 非部署端：不显示任何备份设置/密码框，只留一个「导出记录」，导出时再输入密码。
  let backupHasPassword = false
  let backupDeploySide = true
  let exportName = ''

  function applyBackupMode(local) {
    backupDeploySide = !!local
    if ($('backupConfigRows')) $('backupConfigRows').style.display = backupDeploySide ? '' : 'none'
    if ($('backupSummaryText')) $('backupSummaryText').textContent = backupDeploySide ? '备份（对话数据）' : '导出记录'
    if ($('backupList')) $('backupList').style.display = backupDeploySide ? '' : 'none'
    if ($('backupExportRow')) $('backupExportRow').style.display = ''
  }

  async function loadBackupStatus() {
    const r = await api('/backup')
    backupHasPassword = !!r.hasPassword
    applyBackupMode(r.localOnly)
    if ($('backupHint')) {
      const last = r.lastResult
      const parts = []
      parts.push(r.hasPassword ? '密码已设' : '未设密码')
      parts.push(r.enabled ? '自动备份：每 ' + r.intervalHours + 'h' : '自动备份：关')
      if (last) parts.push('上次：' + (last.ok ? '成功' : '失败'))
      $('backupHint').textContent = parts.join(' · ')
    }
    if ($('backupList')) {
      const box = $('backupList')
      box.innerHTML = ''
      const list = (r.snapshots || []).slice(0, 10)
      if (list.length) {
        for (const s of list) {
          const row = h('div', 'backup-item')
          row.appendChild(h('span', 'bk-name', s.name))
          row.appendChild(h('span', 'bk-meta', s.files + ' 个文件 · ' + (s.bytes / 1048576).toFixed(2) + ' MB'))
          const btn = h('button', null, '导出')
          btn.onclick = () => openExport(s.name)
          row.appendChild(btn)
          box.appendChild(row)
        }
      }
    }
  }

  function openExport(name) {
    exportName = name || ''
    if ($('exportName')) $('exportName').textContent = exportName ? ('快照：' + exportName) : '导出最新快照'
    if ($('exportPw')) $('exportPw').value = backupDeploySide && $('setDeployPw') ? ($('setDeployPw').value || '') : ''
    if ($('exportErr')) $('exportErr').textContent = ''
    openSheet('exportSheet')
    setTimeout(() => { const el = $('exportPw'); if (el) el.focus() }, 350)
  }

  async function downloadBackup(name, pw) {
    if (!pw) throw new Error('请输入部署端密码')
    toast('正在打包…')
    const r = await fetch('./api/backup/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: pw, name })
    })
    if (!r.ok) {
      let msg = 'HTTP ' + r.status
      try { const j = await r.json(); if (j && j.error) msg = j.error } catch { /* ignore */ }
      throw new Error(msg)
    }
    const blob = await r.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = (name || 'backup') + '.zip'
    document.body.appendChild(a)
    a.click()
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 4000)
    return a.download
  }

  if ($('backupExportBtn')) $('backupExportBtn').onclick = () => openExport('')
  if ($('closeExportSheet')) $('closeExportSheet').onclick = () => closeSheet('exportSheet')
  if ($('exportGo')) $('exportGo').onclick = async () => {
    const btn = $('exportGo')
    const err = $('exportErr')
    err.textContent = ''
    btn.disabled = true
    try {
      const name = await downloadBackup(exportName, $('exportPw').value)
      closeSheet('exportSheet')
      toast('已开始下载：' + name)
    } catch (e) {
      err.textContent = e.message
    } finally {
      btn.disabled = false
    }
  }
  window.__loadBackupStatus = loadBackupStatus
  if ($('backupSaveBtn')) $('backupSaveBtn').onclick = async () => {
    const pw = $('setDeployPw').value
    if (backupHasPassword && !pw) { toast('先填部署端密码（改备份设置要验证）', true); return }
    const body = {
      enabled: $('setBackupOn').checked,
      intervalHours: parseInt($('setBackupHours').value, 10),
      keep: parseInt($('setBackupKeep').value, 10),
      dir: $('setBackupDir').value.trim()
    }
    if (backupHasPassword) body.password = pw
    else body.newPassword = pw
    try {
      await api('/backup/config', { method: 'POST', body })
      toast('备份设置已保存')
      $('setDeployPw').value = ''
      await loadBackupStatus()
    } catch (err) { toast(err.message, true) }
  }
  if ($('backupRunBtn')) $('backupRunBtn').onclick = async () => {
    try {
      if (!backupHasPassword) throw new Error('先设置部署端密码')
      if (!$('setDeployPw').value) throw new Error('先填部署端密码')
      const r = await api('/backup/run', { method: 'POST', body: { password: $('setDeployPw').value } })
      toast('已备份：' + r.files + ' 个文件，' + (r.bytes / 1048576).toFixed(2) + ' MB')
      await loadBackupStatus()
    } catch (err) { toast(err.message, true) }
  }

  $('themeSeg').onclick = (e) => {
    const b = e.target.closest('button')
    if (b) applyTheme(b.dataset.theme)
  }
  $('logoutBtn').onclick = async () => {
    try { await api('/logout', { method: 'POST' }) } catch { /* ignore */ }
    closeSheet('sheet')
    showLogin()
  }

  $('sheet').addEventListener('change', async (e) => {
    // 自启动/备份/监听地址这些都有各自的处理，别在这里重复提交
    if (/^set(AutoBoot|Backup|DeployPw|Net)/.test(e.target.id || '')) return
    if (!e.target.closest('.sheet-body')) return
    const body = {
      dsh: { defaultCwd: $('setCwd').value.trim() },
      local: {
        enabled: $('setLocalOn').checked,
        baseUrl: $('setLocalUrl').value.trim(),
        model: $('setLocalModel').value.trim(),
        maxTokens: parseInt($('setLocalMax').value, 10) || 4096,
        temperature: parseFloat($('setLocalTemp').value),
        systemPrompt: $('setLocalSys').value
      }
    }
    try {
      await api('/settings', { method: 'PUT', body })
      toast('已保存')
      refreshMe().catch(() => {})
    } catch (err) { toast(err.message, true) }
  })

  // 输入框
  const input = $('input')
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 132) + 'px'
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      if (!S.running) send()
      else send()
    }
  })
  $('sendBtn').onclick = () => {
    if (S.running) stopRun()
    else send()
  }

  // 代码复制
  $('messages').addEventListener('click', (e) => {
    const btn = e.target.closest('.code-copy')
    if (!btn) return
    const pre = btn.closest('.code-block').querySelector('pre')
    navigator.clipboard.writeText(pre.textContent).then(() => {
      btn.textContent = '已复制'
      setTimeout(() => { btn.textContent = '复制' }, 1400)
    }).catch(() => toast('复制失败', true))
  })

  // 滚动到底部时加载更早
  $('messages').addEventListener('scroll', () => {
    const m = $('messages')
    if (m.scrollTop < 40 && S.hasMore && !S.loadingOlder) loadOlder()
  })

  // 切回来时刷新（手机后台回来、锁屏解锁）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshSessions().catch(() => {})
      if (S.evtSrc && S.evtSrc.readyState === 2) connectEvents()
    }
  })

  // ------------------------------------------------------------------ 启动
  //  登录/打开速度的三个要点：
  //   1. /api/me 只请求一次（init 拿到的结果直接喂给 boot，别重复请求）
  //   2. 事件流先连上（不等接口），/api/me 与列表并行拉
  //   3. 先把上次的会话列表从 localStorage 画出来 → 首屏 0 延迟，网络回来再校正
  function applyMe(me) {
    S.me = me
    if (me.build) {
      S.build = me.build
      const v = document.getElementById('buildVer')
      if (v) v.textContent = 'AI 对话 网页版 · 构建 ' + me.build
    }
    S.dshStatus = (me.dshById && me.dshById[S.connId]) || me.dsh || null
    updateHubUi()
    if (me.appName && (!S.currentTitle || S.currentId === null)) {
      $('chatTitle').textContent = S.currentTitle || me.appName
    }
    // 页面（连接）来自服务端；落在上次用的那个上；没有就显示"先加一个页面"
    S.conns = me.connections || []
    S.presets = me.presets || []
    if (!S.conns.length) { showNoConn(); return }
    if (!S.conns.some((c) => c.id === S.connId)) {
      // 优先落到"启动时默认打开"的那一页
      const auto = S.conns.find((c) => c.autoOpen)
      S.connId = (auto && auto.id) || S.conns[0].id
    }
    setActiveConn(S.connId)
  }

  function saveListCache() {
    try {
      const payload = {
        at: Date.now(),
        mode: S.mode,
        sessions: S.dshSessions.slice(0, 120),
        workspaces: S.workspaces || []
      }
      LS.set('mc_list_' + S.mode, JSON.stringify(payload))
    } catch { /* 存不下不影响 */ }
  }

  function paintCachedList() {
    try {
      const raw = LS.get('mc_list_' + S.mode, '')
      if (!raw) return false
      const j = JSON.parse(raw)
      if (!j || !Array.isArray(j.sessions)) return false
      if (Date.now() - (j.at || 0) > 7 * 86400000) return false
      if (S.mode === 'dsh') {
        S.dshSessions = j.sessions
        S.workspaces = j.workspaces || []
      }
      renderConvList()
      return true
    } catch { return false }
  }

  async function boot(prefetched, opts) {
    const o = opts || {}
    applyTheme()
    renderConnList()
    if (!o.sessions) paintCachedList()   // ① 没内嵌数据时先画本地缓存（0 延迟）
    connectEvents()                      // ② 事件流先连（不阻塞）
    startWatchdog()
    if (prefetched) applyMe(prefetched)
    else { try { await refreshMe() } catch { /* ignore */ } }

    if (o.sessions) {
      renderConvList()
      saveListCache()
      refreshSessions().catch(() => {})   // 后台校正，不阻塞首屏
    } else {
      try { await refreshSessions() } catch (e) { toast(e.message, true) }
    }
    renderMessages(); updateSendBtn(); $('chatSub').textContent = subtitleText()

    // 上次开过的对话才自动续上；第一次进来停在欢迎页
    const last = LS.get('mc_last_' + S.mode, '')
    const list = sessionsForMode()
    if (last && list.some((c) => c.id === last)) await openSession(last)
  }

  // 服务端可能已经把首屏数据内嵌进来了（省掉 /api/me 与会话列表两个往返）
  const BOOT = window.__MC_BOOT__ || null;

  ;(async function init() {
    if (BOOT && BOOT.me) {
      try {
        S.dshSessions = BOOT.sessions || []
        S.workspaces = BOOT.workspaces || []
        S.archivedCount = BOOT.archivedCount || 0
        S.build = BOOT.build || ''
        hideLogin()
        await boot(BOOT.me, { sessions: true })
        return
      } catch (e) {
        console.error('[mchat boot-data]', e)
      }
    }
    // 兜底（未登录时页面没有内嵌数据，走这里）：问一次 /api/me
    try {
      const r = await fetch('./api/me', { credentials: 'same-origin', cache: 'no-store' })
      if (r.status === 401) return showLogin()
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const me = await r.json()
      hideLogin()
      await boot(me)
    } catch (e) {
      console.error('[mchat init]', e)
      showLogin()
    }
  })()

  // 调试钩子：无头测试/排查用，不暴露任何凭据
  window.__mc = { S, openSession, send, refreshSessions, api, hideLogin, showLogin, boot, BOOT, applyMe }

  // 注册 service worker（只为"加到主屏/断网开壳"）
  // 必须能自己发现新版本并刷新，否则会一直跑旧缓存（之前踩过这个坑）
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller
    let reloading = false
    const reloadOnce = (why) => {
      if (reloading || !hadController) return
      reloading = true
      console.log('[sw] 检测到新版本（' + why + '），刷新一次')
      setTimeout(() => location.reload(), 150)
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => reloadOnce('controllerchange'))
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'sw-activated') reloadOnce('sw-activated')
    })
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
        setTimeout(() => { try { reg.update() } catch { /* ignore */ } }, 1500)
        setInterval(() => { try { reg.update() } catch { /* ignore */ } }, 10 * 60000)
      }).catch(() => {})
    })
  }
})()