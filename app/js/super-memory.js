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
  const weekdayMap = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }
  const dayStart = (date) => {
    const d = new Date(date)
    d.setHours(0, 0, 0, 0)
    return d
  }
  const parseToken = (token) => {
    const value = String(token || '').trim()
    if (!value) return null
    const isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value)
    if (isoMatch) return dayStart(new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])))
    const cnMatch = /^(\d{1,2})月(\d{1,2})[日号]$/.exec(value)
    if (cnMatch) return dayStart(new Date(current.getFullYear(), Number(cnMatch[1]) - 1, Number(cnMatch[2])))
    if (/今天|今日/.test(value)) return new Date(today)
    if (/昨天|昨日/.test(value)) return new Date(yesterday)
    if (/前天/.test(value)) return new Date(dayBefore)
    const week = /(上|本|这)(?:周|星期)([一二三四五六日天])/.exec(value)
    if (week) {
      const d = new Date(today)
      const mondayOffset = (d.getDay() + 6) % 7
      d.setDate(d.getDate() - mondayOffset + weekdayMap[week[2]] - (week[1] === '上' ? 7 : 0))
      return d
    }
    return null
  }
  const addDay = (date, n) => {
    const d = new Date(date)
    d.setDate(d.getDate() + n)
    return d
  }

  /* 具体时间段：今天下午 3 点、昨天晚上、昨天 15:00。 */
  const dayWord = /(今天|今日|昨天|昨日|前天)/.exec(raw)
  const period = /(凌晨|上午|中午|下午|傍晚|晚上|夜里)/.exec(raw)
  const clock = /(?:凌晨|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2})\s*(?:点|时)(半)?/.exec(raw)
  if (dayWord && (clock || period)) {
    const base = dayStart(parseToken(dayWord[1]) || today)
    let hour = clock ? Number(clock[1]) : null
    if (hour != null) {
      if (period && /下午|傍晚|晚上|夜里/.test(period[1]) && hour < 12) hour += 12
      if (period && /凌晨|上午/.test(period[1]) && hour === 12) hour = 0
    } else if (period) {
      hour = /凌晨/.test(period[1]) ? 0 : /上午/.test(period[1]) ? 6 : /中午/.test(period[1]) ? 11 : /下午/.test(period[1]) ? 12 : /傍晚/.test(period[1]) ? 17 : 18
    }
    if (hour != null) {
      const from = new Date(base); from.setHours(hour, clock && clock[2] ? 30 : 0, 0, 0)
      const to = new Date(from); to.setHours(from.getHours() + (period && !clock ? (period[1] === '上午' ? 3 : period[1] === '下午' ? 6 : 4) : 1))
      return label(`${dayWord[1]}${clock ? `${clock[1]}点${clock[2] ? '半' : ''}` : period[1]}`, from, to)
    }
  }
  /* 只说“下午三点/15点”时默认今天。 */
  if (!dayWord && clock) {
    let hour = Number(clock[1])
    const p = period ? period[1] : ''
    if (/下午|傍晚|晚上|夜里/.test(p) && hour < 12) hour += 12
    if (/凌晨|上午/.test(p) && hour === 12) hour = 0
    const from = new Date(today); from.setHours(hour, clock[2] ? 30 : 0, 0, 0)
    const to = new Date(from); to.setHours(from.getHours() + 1)
    return label(`今天${clock[1]}点${clock[2] ? '半' : ''}`, from, to)
  }

  /* 日期区间：1月1日到1月5日、2026-01-01 至 2026-01-05。 */
  const rangeMatch =
    /(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*(?:到|至|~|—|－)\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/.exec(raw) ||
    /(\d{1,2}月\d{1,2}[日号])\s*(?:到|至|~|—|－)\s*(\d{1,2}月\d{1,2}[日号])/.exec(raw)
  if (rangeMatch) {
    const from = parseToken(rangeMatch[1])
    const end = parseToken(rangeMatch[2])
    if (from && end) return label(`${rangeMatch[1]} 至 ${rangeMatch[2]}`, from, addDay(end, 1))
  }

  /* 最近 N 周 / 前 N 周。 */
  const earlyCn = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const earlyNumber = (value) => {
    const text = String(value || '')
    if (/^\d+$/.test(text)) return Number(text)
    if (text === '十') return 10
    if (text.includes('十')) {
      const [left, right] = text.split('十')
      return (earlyCn[left] || 1) * 10 + (earlyCn[right] || 0)
    }
    return earlyCn[text] || 0
  }
  const weeks = /(前|过去|最近|近)\s*([一二三四五六七八九十两\d]+)\s*周/.exec(raw)
  if (weeks) {
    const n = Math.max(1, earlyNumber(weeks[2]) || 1)
    const monday = new Date(today)
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    if (weeks[1] === '前' || weeks[1] === '过去') {
      const to = new Date(monday)
      const from = new Date(monday); from.setDate(from.getDate() - n * 7)
      return label(`${weeks[1]}${n}周`, from, to)
    }
    const from = new Date(monday); from.setDate(from.getDate() - (n - 1) * 7)
    const to = new Date(monday); to.setDate(to.getDate() + 7)
    return label(`最近${n}周`, from, to)
  }

  /* 最近 N 个月；用于跨月区间。 */
  const months = /(最近|近|过去)\s*([一二三四五六七八九十两\d]+)\s*个月/.exec(raw)
  if (months) {
    const n = Math.max(1, earlyNumber(months[2]) || 1)
    const from = new Date(today); from.setMonth(from.getMonth() - n)
    return label(`${months[1]}${n}个月`, from, tomorrow)
  }

  /* 月边界：本月初、上个月底。 */
  if (/上个月底|上月底/.test(raw)) {
    const from = new Date(current.getFullYear(), current.getMonth(), 0)
    return label('上个月底', from, addDay(from, 1))
  }
  if (/这个月初|本月初/.test(raw)) {
    const from = new Date(current.getFullYear(), current.getMonth(), 1)
    return label('本月初', from, addDay(from, 1))
  }
  if (/这个月底|本月底/.test(raw)) {
    const from = new Date(current.getFullYear(), current.getMonth() + 1, 0)
    return label('本月底', from, addDay(from, 1))
  }

  /* 年 / 季度。 */
  if (/今年|本年度|这一年/.test(raw)) {
    const from = new Date(current.getFullYear(), 0, 1)
    const to = new Date(current.getFullYear() + 1, 0, 1)
    return label('今年', from, to)
  }
  if (/去年|上一年/.test(raw)) {
    const from = new Date(current.getFullYear() - 1, 0, 1)
    const to = new Date(current.getFullYear(), 0, 1)
    return label('去年', from, to)
  }
  if (/本季度|这个季度/.test(raw)) {
    const q = Math.floor(current.getMonth() / 3)
    const from = new Date(current.getFullYear(), q * 3, 1)
    const to = new Date(current.getFullYear(), q * 3 + 3, 1)
    return label('本季度', from, to)
  }
  if (/上季度|上个季度/.test(raw)) {
    const q = Math.floor(current.getMonth() / 3) - 1
    const from = new Date(current.getFullYear(), q * 3, 1)
    const to = new Date(current.getFullYear(), q * 3 + 3, 1)
    return label('上季度', from, to)
  }

  /* “前三天”按用户给出的反推口径：从昨天再往前推三天。
     例：1 月 1 日 → 起点 12 月 28 日，覆盖 12/28–12/30。 */
  const cn = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const cnNumber = (value) => {
    const rawValue = String(value || '')
    if (/^\d+$/.test(rawValue)) return Number(rawValue)
    if (rawValue === '十') return 10
    if (rawValue.includes('十')) {
      const [left, right] = rawValue.split('十')
      return (cn[left] || 1) * 10 + (cn[right] || 0)
    }
    return cn[rawValue] || 0
  }
  const relative = /(前|过去|最近|近)\s*([一二三四五六七八九十两\d]+)\s*天/.exec(raw)
  if (relative) {
    const n = Math.max(1, cnNumber(relative[2]) || 1)
    if (relative[1] === '前' || relative[1] === '过去') {
      const to = new Date(yesterday)
      const from = new Date(to); from.setDate(from.getDate() - n)
      return label(`${relative[1]}${n}天`, from, to)
    }
    const from = new Date(today); from.setDate(from.getDate() - (n - 1))
    return label(`最近${n}天`, from, tomorrow)
  }

  if (/前天/.test(raw)) return label('前天', dayBefore, yesterday)
  if (/昨天|昨日/.test(raw)) return label('昨天', yesterday, today)
  if (/今天|今日/.test(raw)) return label('今天', today, tomorrow)

  /* 明确的日期：2026-01-01 / 1月1日；仍按本机时区取整日边界。 */
  const isoDate = /(?:^|\D)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\D|$)/.exec(raw)
  const cnDate = /(?:^|\D)(\d{1,2})月(\d{1,2})[日号]/.exec(raw)
  const yearDate = /(?:^|\D)(\d{4})年(\d{1,2})月(\d{1,2})[日号]/.exec(raw)
  if (isoDate || cnDate || yearDate) {
    const year = isoDate ? Number(isoDate[1]) : (yearDate ? Number(yearDate[1]) : current.getFullYear())
    const month = Number((isoDate || yearDate || cnDate)[isoDate ? 2 : (yearDate ? 2 : 1)]) - 1
    const day = Number((isoDate || yearDate || cnDate)[isoDate ? 3 : (yearDate ? 3 : 2)])
    const from = new Date(year, month, day)
    if (!Number.isNaN(from.getTime())) {
      const to = new Date(from); to.setDate(to.getDate() + 1)
      return label(from.toLocaleDateString('zh-CN'), from, to)
    }
  }

  /* 本周三 / 上周三：周一是起点。 */
  const weekday = /(上|本|这)(?:周|星期)([一二三四五六日天])/.exec(raw)
  if (weekday) {
    const map = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }
    const from = new Date(today)
    const mondayOffset = (from.getDay() + 6) % 7
    from.setDate(from.getDate() - mondayOffset + map[weekday[2]] - (weekday[1] === '上' ? 7 : 0))
    const to = new Date(from); to.setDate(to.getDate() + 1)
    return label(`${weekday[1]}周${weekday[2]}`, from, to)
  }

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

/* 带编号的浓缩索引：主智能体只拿编号、时间、一句话和权重；
   需要原文时再按编号回查。 */
export function formatRecalledDigests (rows, max = 6) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && row.code && row.digest)
  if (!list.length) return ''
  const lines = ['## 浓缩记忆索引']
  for (const row of list.slice(0, max)) {
    const at = row.time_text || row.created_at || ''
    const text = oneLine(row.one_line || row.digest, 140)
    const weight = typeof row.total_weight === 'number' ? ` · w=${row.total_weight.toFixed(2)}` : ''
    lines.push(`- ${row.code}${at ? ` [${String(at).slice(0, 16).replace('T', ' ')}]` : ''}${weight} ${text}`)
  }
  return lines.join('\n')
}

