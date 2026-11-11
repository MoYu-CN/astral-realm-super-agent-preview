/* super-memory.js — 超级智能体直连会话的“用户视图 / 模型视图”分离
 *
 * 用户视图：state.superChat.messages 里的完整消息，原样渲染、可回看。
 * 模型视图：只读取未被隐藏的消息；每个任务结束后用 memory 里的压缩记录
 *           代替原文，原文继续留给用户看，但不再进入下一轮请求。
 *
 * 这个模块保持纯函数，不碰 DOM，便于单测。
 */

export const MAX_MEMORY_ENTRIES = 64
export const MAX_MEMORY_CHARS = 8000
const MAX_ENTRY_CHARS = 2000

/* 本地事件索引：只保留事件精华；完整原文在 message_records，不在这里覆盖。 */
export function normalizeMemory (value, { maxEntries = MAX_MEMORY_ENTRIES, maxChars = MAX_MEMORY_CHARS } = {}) {
  const raw = (Array.isArray(value) ? value : [])
    .filter((item) => item && typeof item.text === 'string' && item.text.trim())
    .map((item) => ({
      ts: Number(item.ts) || Date.now(),
      text: String(item.text).trim().slice(0, MAX_ENTRY_CHARS)
    }))
  const out = []
  let used = 0
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const entry = raw[i]
    if (out.length && used + entry.text.length > maxChars) break
    out.push(entry)
    used += entry.text.length
  }
  return out.reverse().slice(-maxEntries)
}

/* 模型视图里能看到的对话消息：用户视图里的完整原文可以通过
   contextHidden 或手动 ctxReleased 被排除，不让它们重新灌进上下文。 */
export function modelHistory (messages, limit = 24) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m &&
      typeof m.text === 'string' && m.text.trim() &&
      !m.ctxReleased &&
      !m.contextHidden)
    .map((m) => ({
      role: (m.role === 'assistant' || m.kind === 'agent') ? 'assistant' : (m.role === 'user' || m.kind === 'user' ? 'user' : ''),
      content: m.text
    }))
    .filter((m) => m.role)
    .slice(-limit)
}

/* 任务完成后，把这一轮用户提问和回复从模型视图移除；用户界面不受影响。 */
export function hideExchange (messages, ids) {
  const wanted = new Set((ids || []).filter(Boolean))
  let changed = 0
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!wanted.has(msg.id) || msg.contextHidden) continue
    msg.contextHidden = true
    changed += 1
  }
  return changed
}

/* 用户说“昨天/今天/本周/上周”时，先化成明确的时间区间；
   没有时间词就返回 null，交给权重检索。 */
export function timeRangeForQuery (text, now = Date.now()) {
  const raw = String(text || '')
  const current = new Date(now)
  const startOfDay = (date) => {
    const d = new Date(date)
    d.setHours(0, 0, 0, 0)
    return d
  }
  const iso = (date) => date.toISOString()
  const today = startOfDay(current)
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const dayBefore = new Date(today); dayBefore.setDate(dayBefore.getDate() - 2)
  const label = (name, from, to) => ({ label: name, from: iso(from), to: iso(to) })

  if (/前天/.test(raw)) return label('前天', dayBefore, yesterday)
  if (/昨天|昨日/.test(raw)) return label('昨天', yesterday, today)
  if (/今天|今日/.test(raw)) return label('今天', today, tomorrow)
  if (/上周|上星期/.test(raw)) {
    const from = new Date(today)
    const offset = (from.getDay() + 6) % 7
    from.setDate(from.getDate() - offset - 7)
    const to = new Date(from); to.setDate(to.getDate() + 7)
    return label('上周', from, to)
  }
  if (/本周|这周|这星期/.test(raw)) {
    const from = new Date(today)
    const offset = (from.getDay() + 6) % 7
    from.setDate(from.getDate() - offset)
    const to = new Date(from); to.setDate(to.getDate() + 7)
    return label('本周', from, to)
  }
  if (/上个月|上月/.test(raw)) {
    const from = new Date(current.getFullYear(), current.getMonth() - 1, 1)
    const to = new Date(current.getFullYear(), current.getMonth(), 1)
    return label('上个月', from, to)
  }
  if (/这个月|本月/.test(raw)) {
    const from = new Date(current.getFullYear(), current.getMonth(), 1)
    const to = new Date(current.getFullYear(), current.getMonth() + 1, 1)
    return label('本月', from, to)
  }
  return null
}

function oneLine (value, max = 180) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

/* 把数据库查出来的事件压成“可放进当前上下文”的索引行；
   不替代原文，原文按需再取。 */
export function formatRecalledEvents (events, projects, timeRange = null, max = 10) {
  const list = Array.isArray(events) ? events : []
  if (!list.length) return ''
  const projectMap = new Map((Array.isArray(projects) ? projects : []).map((p) => [p.id, p.name || p.id]))
  const lines = ['## 相关记忆（时间 + 权重召回）']
  if (timeRange && timeRange.label) lines.push(`时间范围：${timeRange.label}`)
  for (const event of list.slice(0, max)) {
    const at = event.startedAt || event.started_at || event.at || ''
    const date = String(at).slice(0, 10)
    const project = event.project || projectMap.get(event.project_id) || event.project_id || ''
    const code = event.code || (event.prefix ? event.prefix + String(event.seq || '').padStart(3, '0') : '')
    const text = oneLine(event.summary || event.text || '', 220)
    if (!text) continue
    lines.push(`- ${date ? `[${date}] ` : ''}${project ? `${project}：` : ''}${text}${event.result ? `（${event.result}）` : ''}${code ? ` · ${code}` : ''}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

