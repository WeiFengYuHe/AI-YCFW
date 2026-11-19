// ============================================================================
//  lib/store.mjs —— 「本地模型」模式的会话存储 + 流式转发
//  ---------------------------------------------------------------------------
//  这是可选的第二个对话来源：直接接本机 llama.cpp 的 OpenAI 兼容网关
//  （默认 127.0.0.1:8080/v1，模型 本机模型），会话历史存在本地 json 文件里。
//  与 DSH 模式（跟电脑上这个 GUI 共用会话）互不干扰，界面上可切换。
// ============================================================================

import { promises as fs } from 'node:fs'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const now = () => new Date().toISOString()
const newId = (p = 'c') => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex')

export function createStore(options) {
  const { convDir, getUpstream, emit, guessKey } = options
  const conversations = new Map()
  const runs = new Map()
  const writeChains = new Map()

  const convPath = (id) => path.join(convDir, id + '.json')

  function saveConversation(conv) {
    const prev = writeChains.get(conv.id) || Promise.resolve()
    const next = prev.then(async () => {
      const tmp = convPath(conv.id) + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(conv), 'utf8')
      await fs.rename(tmp, convPath(conv.id))
    }).catch((e) => console.error('[store save]', conv.id, e.message))
    writeChains.set(conv.id, next)
    return next
  }

  async function init() {
    await fs.mkdir(convDir, { recursive: true })
    const files = await fs.readdir(convDir).catch(() => [])
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const obj = JSON.parse(readFileSync(path.join(convDir, f), 'utf8'))
        if (obj && obj.id) {
          if (!Array.isArray(obj.messages)) obj.messages = []
          conversations.set(obj.id, obj)
        }
      } catch { /* 坏文件跳过 */ }
    }
    return conversations.size
  }

  function meta(conv) {
    const last = conv.messages.length ? conv.messages[conv.messages.length - 1] : null
    return {
      id: conv.id,
      title: conv.title || '新对话',
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      messageCount: conv.messages.length,
      pinned: !!conv.pinned,
      preview: last ? String(last.content || last.reasoning || '').replace(/\s+/g, ' ').slice(0, 80) : '',
      running: runs.has(conv.id)
    }
  }

  function create(title) {
    const c = {
      id: newId('L'),
      title: title || '新对话',
      createdAt: now(),
      updatedAt: now(),
      pinned: false,
      messages: []
    }
    conversations.set(c.id, c)
    saveConversation(c)
    return c
  }

  function publicMessage(m) {
    return {
      id: m.id,
      role: m.role,
      content: m.content || '',
      reasoning: m.reasoning || '',
      createdAt: m.createdAt,
      status: m.status || 'done',
      error: m.error || '',
      durationMs: m.durationMs || 0
    }
  }

  function list() {
    return [...conversations.values()]
      .map(meta)
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  const get = (id) => conversations.get(id)

  function patch(id, { title, pinned }) {
    const conv = conversations.get(id)
    if (!conv) return null
    if (typeof title === 'string') conv.title = title.slice(0, 120) || '新对话'
    if (typeof pinned === 'boolean') conv.pinned = pinned
    conv.updatedAt = now()
    saveConversation(conv)
    return conv
  }

  async function remove(id) {
    const run = runs.get(id)
    if (run) { try { run.abort.abort() } catch { /* ignore */ } runs.delete(id) }
    conversations.delete(id)
    await fs.unlink(convPath(id)).catch(() => {})
    return true
  }

  function upstreamUrl(p) {
    const up = getUpstream()
    const base = String(up.baseUrl || '').replace(/\/+$/, '')
    return base + p
  }

  function historyMessages(conv) {
    const up = getUpstream()
    const budget = Math.max(1000, Number(up.historyCharBudget) || 24000)
    const list = []
    let used = 0
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i]
      if (!m.content) continue
      used += m.content.length
      if (used > budget && list.length) break
      list.push({ role: m.role, content: m.content })
    }
    list.reverse()
    return list
  }

  async function fetchModels() {
    try {
      const up = getUpstream()
      const key = up.apiKey || (guessKey ? guessKey() : '')
      const r = await fetch(upstreamUrl('/models'), {
        headers: { Authorization: 'Bearer ' + (key || '') },
        signal: AbortSignal.timeout(8000)
      })
      if (!r.ok) return { error: 'HTTP ' + r.status }
      const j = await r.json()
      return { models: Array.isArray(j.data) ? j.data.map((d) => d.id).filter(Boolean) : [] }
    } catch (e) {
      return { error: e.message }
    }
  }

  // 发消息 / 重新生成：进度全部通过 emit 广播（多端同步）
  function startRun(conv, { regenerate, text }) {
    const up = getUpstream()
    const runId = newId('r')
    const abort = new AbortController()

    if (regenerate) {
      while (conv.messages.length && conv.messages[conv.messages.length - 1].role === 'assistant') conv.messages.pop()
      if (!conv.messages.some((m) => m.role === 'user')) throw new Error('没有可重新生成的内容')
    } else {
      conv.messages.push({ id: newId('m'), role: 'user', content: text, createdAt: now(), status: 'done' })
      if (!conv.title || conv.title === '新对话') {
        conv.title = String(text).replace(/\s+/g, ' ').slice(0, 24)
        emit('conv-title', { id: conv.id, title: conv.title })
      }
      emit('msg-appended', {
        conversationId: conv.id,
        message: publicMessage(conv.messages[conv.messages.length - 1]),
        meta: meta(conv)
      })
    }

    const assistant = { id: newId('m'), role: 'assistant', content: '', reasoning: '', createdAt: now(), status: 'streaming' }
    conv.messages.push(assistant)
    conv.updatedAt = now()
    runs.set(conv.id, { runId, abort, startedAt: Date.now() })
    saveConversation(conv)

    emit('run-start', { conversationId: conv.id, runId, message: publicMessage(assistant), meta: meta(conv) })

    const saver = setInterval(() => saveConversation(conv), 2500)
    saver.unref?.()
    const started = Date.now()

    ;(async () => {
      try {
        const messages = []
        if (up.systemPrompt) messages.push({ role: 'system', content: up.systemPrompt })
        messages.push(...historyMessages(conv))
        const body = {
          model: up.model,
          messages,
          max_tokens: Number(up.maxTokens) || 4096,
          temperature: Number.isFinite(Number(up.temperature)) ? Number(up.temperature) : 0.7,
          stream: true
        }
        const resp = await fetch(upstreamUrl('/chat/completions'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: 'Bearer ' + (up.apiKey || (guessKey ? guessKey() : ''))
          },
          body: JSON.stringify(body),
          signal: abort.signal
        })
        if (!resp.ok) {
          const t = await resp.text().catch(() => '')
          throw new Error('上游 HTTP ' + resp.status + (t ? ' — ' + t.slice(0, 300) : ''))
        }
        const reader = resp.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        let firstTokenAt = 0
        let finishReason = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop()
          for (const line of lines) {
            const s = line.trim()
            if (!s.startsWith('data:')) continue
            const payload = s.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            let j
            try { j = JSON.parse(payload) } catch { continue }
            const ch = (j.choices && j.choices[0]) || {}
            if (ch.finish_reason) finishReason = ch.finish_reason
            const delta = ch.delta || {}
            const dr = delta.reasoning_content || delta.reasoning || ''
            const dc = delta.content || ''
            if (!dr && !dc) continue
            if (!firstTokenAt) firstTokenAt = Date.now()
            if (dr) {
              assistant.reasoning += dr
              emit('run-delta', { conversationId: conv.id, runId, reasoning: dr })
            }
            if (dc) {
              assistant.content += dc
              emit('run-delta', { conversationId: conv.id, runId, content: dc })
            }
          }
        }
        clearInterval(saver)
        assistant.status = 'done'
        assistant.durationMs = Date.now() - started
        if (!assistant.content && !assistant.reasoning) {
          assistant.content = finishReason === 'length'
            ? '（模型没返回内容：max_tokens 可能被思考过程吃光了，去设置里调到 4096 以上）'
            : '（模型没有返回内容）'
        }
        conv.updatedAt = now()
        saveConversation(conv)
        runs.delete(conv.id)
        emit('run-end', { conversationId: conv.id, runId, message: publicMessage(assistant), meta: meta(conv), finishReason })
      } catch (e) {
        clearInterval(saver)
        const aborted = e && (e.name === 'AbortError' || abort.signal.aborted)
        assistant.status = aborted ? 'stopped' : 'error'
        assistant.durationMs = Date.now() - started
        if (!aborted) assistant.error = e.message || String(e)
        if (!assistant.content && !assistant.reasoning && !aborted) assistant.content = '⚠️ 生成失败：' + (e.message || String(e))
        conv.updatedAt = now()
        saveConversation(conv)
        runs.delete(conv.id)
        emit('run-end', { conversationId: conv.id, runId, message: publicMessage(assistant), meta: meta(conv), error: aborted ? '' : (e.message || String(e)), aborted })
      }
    })()
  }

  function stop(id) {
    const run = runs.get(id)
    if (!run) return false
    try { run.abort.abort() } catch { /* ignore */ }
    return true
  }

  return {
    init, list, get, create, patch, remove, meta, publicMessage,
    startRun, stop, fetchModels,
    isRunning: (id) => runs.has(id),
    size: () => conversations.size
  }
}
