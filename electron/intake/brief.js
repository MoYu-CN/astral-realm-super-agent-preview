'use strict'

/**
 * intake/brief.js — 「消息接入」进首流的那一小块
 *
 * 用户把渠道打开以后，超级智能体必须**知道自己在听**，否则工具摆在那儿也不会用。
 * 这一块只回答三件事，多一个字都不写：
 *   1. 开了哪几条、几死几活（起不来的要能说出来，不能装作在听）；
 *   2. 外面有几条在等你（alert 且未处理），最多带两条一句话；
 *   3. 怎么取全文、看哪个群最热。
 *
 * 没开任何渠道时返回空串 —— 不开就不该每一轮付这段成本。
 * 原文一律不进这里：群聊再热闹，首流也只是一行摘要。
 */

const MAX_CHARS = 240

function all (db, sql, ...args) {
  try { return db.prepare(sql).all(...args) } catch { return [] }
}

function one (db, sql, ...args) {
  try { return db.prepare(sql).get(...args) || null } catch { return null }
}

function clip (text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}

function todayStart () {
  const at = new Date()
  at.setHours(0, 0, 0, 0)
  return at.toISOString()
}

function statsOf (db) {
  const channels = all(db, 'SELECT id, label, kind, status, enabled FROM inbox_channels ORDER BY last_at DESC')
  const on = channels.filter((c) => Number(c.enabled) === 1)
  const live = on.filter((c) => c.status === '运行中')
  /* 「待启动」不算故障：被动渠道刚存下来、还没轮到启动时就是它。
     真故障是启动失败 / 配置不全 / 已停止 / 解密失败这一类。 */
  const broken = on.filter((c) => c.status && c.status !== '运行中' && c.status !== '待启动')
  const pending = Number((one(db, "SELECT COUNT(*) AS n FROM inbox_messages WHERE route = 'alert' AND handled_at IS NULL") || {}).n || 0)
  const today = Number((one(db, 'SELECT COUNT(*) AS n FROM inbox_messages WHERE at >= ?', todayStart()) || {}).n || 0)
  const routes = { alert: 0, observe: 0, knowledge: 0, archive: 0 }
  for (const row of all(db, 'SELECT route, COUNT(*) AS n FROM inbox_messages GROUP BY route')) {
    if (row.route in routes) routes[row.route] = Number(row.n) || 0
  }
  return { channels, on, live, broken, pending, today, routes, total: Object.values(routes).reduce((a, b) => a + b, 0) }
}

function lines (db) {
  const stats = statsOf(db)
  /* 一条都没开：不进首流。这里连「未开启」都不说，那是设置页的事 */
  if (!stats.on.length) return { text: '', stats }

  const out = []
  const names = stats.on.slice(0, 3).map((c) => clip(c.label || c.kind, 10)).join('、')
  const more = stats.on.length > 3 ? ` 等 ${stats.on.length} 条` : ''
  out.push(`- 已接 ${stats.on.length} 条渠道：${names}${more}（运行中 ${stats.live.length}）`)

  if (stats.broken.length) {
    const dead = stats.broken.slice(0, 2).map((c) => `${clip(c.label || c.kind, 8)}·${clip(c.status, 8)}`).join('；')
    out.push(`- 有 ${stats.broken.length} 条没起来：${dead} —— 用户问「怎么没收到」时先看这个`)
  }

  if (stats.pending) {
    const rows = all(db, `
      SELECT sender_name, chat_name, text FROM inbox_messages
      WHERE route = 'alert' AND handled_at IS NULL
      ORDER BY at DESC LIMIT 2
    `)
    const sample = rows.map((m) => `${clip(m.sender_name, 8) || '有人'} ${clip(m.text, 24)}`).join('；')
    out.push(`- 外面有 ${stats.pending} 条在等你：${sample}`)
  }

  if (stats.today) {
    out.push(`- 今日 ${stats.today} 条（提醒 ${stats.routes.alert} · 观察 ${stats.routes.observe} · 知识 ${stats.routes.knowledge} · 归档 ${stats.routes.archive}）`)
  }

  out.push('- 取全文：memory_inbox action=recent route=alert；哪个群最热：action=threads')

  let text = out.join('\n')
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS - 1) + '…'
  return { text, stats }
}

module.exports = { lines, statsOf, MAX_CHARS }
