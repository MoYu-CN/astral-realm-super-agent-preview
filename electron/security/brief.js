'use strict'

/**
 * security/brief.js — 「首流」里的那一小块安全状态
 *
 * 常驻上下文只该回答两件事：现在有没有事等着你决定、要问原委去哪儿问。
 * 其余全部留在设置页与账本里 —— 首流每多一行，都是每一轮都要付的成本。
 *
 * 独立成文件是为了让 hard-context 能直接读，不必把整个安全门面建起来。
 * 只读三张表，不写库、不调 adapter。
 */

const RISK = { critical: '密钥级', high: '高危', medium: '敏感', low: '轻微' }
const MAX_CHARS = 260

function clip (text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}

function statsOf (db, at = new Date().toISOString()) {
  const one = (sql, ...args) => {
    try { return Number(db.prepare(sql).get(...args).n || 0) } catch { return 0 }
  }
  return {
    pending: one("SELECT COUNT(*) AS n FROM security_gates WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > ?)", at),
    open: one("SELECT COUNT(*) AS n FROM security_tasks WHERE status = 'open'"),
    closed: one("SELECT COUNT(*) AS n FROM security_tasks WHERE status = 'closed'"),
    candidates: one("SELECT COUNT(*) AS n FROM security_tasks WHERE status = 'candidate'"),
    digested: one('SELECT COUNT(*) AS n FROM security_tasks WHERE event_code IS NOT NULL')
  }
}

function lines (db) {
  const at = new Date().toISOString()
  const stats = statsOf(db, at)
  const out = []

  /* 什么都没发生过就不占首流：安全状态只在「有事」时才值得每一轮都带着 */
  if (!stats.pending && !stats.open && !stats.closed && !stats.candidates) {
    return { text: '', stats }
  }

  if (stats.pending) {
    let gates = []
    try {
      gates = db.prepare(`
        SELECT risk, target FROM security_gates
        WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY at DESC LIMIT 3
      `).all(at)
    } catch { gates = [] }
    out.push(`- 待你点头 ${stats.pending} 件：` +
      gates.map((gate) => `${RISK[gate.risk] || '敏感'}·${clip(gate.target, 18) || '外部'}`).join('；'))
  } else {
    out.push('- 没有等你决定的外发')
  }

  if (stats.open) {
    let open = []
    try {
      open = db.prepare("SELECT id, title FROM security_tasks WHERE status = 'open' ORDER BY created_at DESC LIMIT 2").all()
    } catch { open = [] }
    out.push(`- 在办 ${stats.open} 条：` + open.map((task) => `${task.id} ${clip(task.title, 14)}`).join('；'))
  }

  if (stats.candidates) {
    let candidates = []
    try {
      candidates = db.prepare(`
        SELECT title, from_name FROM security_tasks
        WHERE status = 'candidate' ORDER BY created_at DESC LIMIT 2
      `).all()
    } catch { candidates = [] }
    out.push(`- 待你决定要不要留痕 ${stats.candidates} 条：` +
      candidates.map((task) => `${clip(task.from_name, 10) || '有人'} ${clip(task.title, 16)}`).join('；'))
  }

  if (stats.closed) out.push(`- 已归档 ${stats.closed} 条，进事件网 ${stats.digested} 条`)

  /* 给出一条可以直接照着调的入口，省得 AI 再去猜动作名 */
  if (stats.open || stats.closed) {
    let latest = null
    try {
      latest = db.prepare("SELECT id FROM security_tasks WHERE status IN ('open','closed') ORDER BY created_at DESC LIMIT 1").get()
    } catch { latest = null }
    if (latest) out.push(`- 问原委：security_ledger action=trace id=${latest.id}`)
    else out.push('- 问原委：security_ledger action=trace')
  }

  let text = out.join('\n')
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS - 1) + '…'
  return { text, stats }
}

module.exports = { lines, statsOf, MAX_CHARS }
