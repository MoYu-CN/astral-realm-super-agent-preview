'use strict'

/**
 * memory/security.js — 安全边界的存储层（第六张表组，但它不是网，是闸门与账本）
 *
 * 两件事，各自独立：
 *
 *   闸门（security_gates）
 *     每一次「可能把东西送出去」先过这里。干净的出站不留痕，命中的才落一行；
 *     落的那一行只存指纹和脱敏片段，不存正文 —— 为了安全先把密钥收一遍，
 *     是这类功能最容易闹的笑话。批准绑死在「这一份内容 + 这一个去处」的指纹上，
 *     改一个字就要重新问。
 *
 *   账本（security_ledger）
 *     只追加的哈希链。每一条把上一条的哈希算进自己，改任何一行后面全对不上，
 *     删一行就断在删除的位置。数据库层用触发器禁掉 UPDATE / DELETE，不靠自觉。
 *     它记的是事实：谁在什么时候、通过哪条渠道、说了什么，谁点头、做了什么。
 *
 * 原文只进 security_tasks.ask（留痕的本意就是「他当时确实是这么说的」），
 * 且永不主动进上下文 —— 要导出时整段取，不进检索、不进摘要。
 */

const crypto = require('node:crypto')
const policy = require('../security/policy.js')
const sensitivity = require('../security/sensitivity.js')
const digestLib = require('../security/digest.js')
const briefLib = require('../security/brief.js')

const GENESIS = '0'.repeat(64)
const GATE_TTL_MS = 30 * 60 * 1000
const CANDIDATE_LIMIT = 200

function now () {
  return new Date().toISOString()
}

function pad2 (n) {
  return String(n).padStart(2, '0')
}

function dayKey (value) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return dayKey(null)
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
}

function parseJson (value, fallback) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/** 键排序后再序列化：同一条记录在任何机器上算出的哈希必须一致。 */
function canonical (value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function clip (value, max) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\u0000/g, '')
  return text.length > max ? text.slice(0, max) : text
}

function riskLabel (risk) {
  return { critical: '密钥级', high: '高危', medium: '敏感', low: '轻微', none: '干净' }[risk] || '干净'
}

function createSecurityStore (db) {
  const stmt = {
    gateInsert: db.prepare(`
      INSERT INTO security_gates
        (id, at, kind, exposure, target, channel, purpose, task_id, run_id, project_id,
         verdict, status, risk, hits, digest, preview, chars, expires_at, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    gateGet: db.prepare('SELECT * FROM security_gates WHERE id = ?'),
    gatePending: db.prepare("SELECT * FROM security_gates WHERE status = 'pending' ORDER BY at DESC LIMIT ?"),
    gateByDigest: db.prepare(`
      SELECT * FROM security_gates
      WHERE digest = ? AND status = 'approved' AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY at DESC LIMIT 1
    `),
    gatePendingByDigest: db.prepare(`
      SELECT * FROM security_gates
      WHERE digest = ? AND status = 'pending' AND expires_at > ?
      ORDER BY at DESC LIMIT 1
    `),
    gateStatus: db.prepare('UPDATE security_gates SET status = ?, decided_at = ?, decided_by = ?, decision_scope = ?, note = ? WHERE id = ?'),
    gateUse: db.prepare("UPDATE security_gates SET status = 'used', used_at = ? WHERE id = ?"),
    gateExpire: db.prepare("UPDATE security_gates SET status = 'expired', decided_by = 'timeout' WHERE status = 'pending' AND expires_at <= ?"),
    gateList: db.prepare('SELECT * FROM security_gates ORDER BY at DESC LIMIT ?'),

    taskInsert: db.prepare(`
      INSERT INTO security_tasks
        (id, status, created_at, opened_at, title, ask, from_name, from_id, channel, chat, message_id, deadline, expect, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    taskGet: db.prepare('SELECT * FROM security_tasks WHERE id = ?'),
    taskList: db.prepare('SELECT * FROM security_tasks WHERE (? = \'\' OR status = ?) ORDER BY created_at DESC LIMIT ?'),
    taskByMessage: db.prepare('SELECT * FROM security_tasks WHERE message_id = ?'),
    taskStatus: db.prepare('UPDATE security_tasks SET status = ?, opened_at = COALESCE(?, opened_at), closed_at = ?, outcome = COALESCE(?, outcome) WHERE id = ?'),
    taskTouch: db.prepare('UPDATE security_tasks SET entries = ?, head_hash = ? WHERE id = ?'),
    taskCount: db.prepare("SELECT COUNT(*) AS n FROM security_tasks WHERE id LIKE ?"),
    taskSetEvent: db.prepare(`
      UPDATE security_tasks SET event_id = ?, event_code = ?, digested_at = ?, last_digest_seq = ?
      WHERE id = ?
    `),
    taskLive: db.prepare("SELECT * FROM security_tasks WHERE status <> 'dropped' ORDER BY created_at DESC LIMIT ?"),

    eventInsert: db.prepare(`
      INSERT INTO events (id, project_id, prefix, seq, started_at, ended_at, result, actor, summary, merged_into, metadata)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'super', ?, NULL, ?)
    `),
    eventByPrefix: db.prepare("SELECT * FROM events WHERE prefix = 'LZ' AND merged_into IS NULL ORDER BY started_at DESC LIMIT ?"),
    eventBetween: db.prepare(`
      SELECT * FROM events
      WHERE merged_into IS NULL AND prefix <> 'LZ' AND started_at >= ? AND started_at <= ?
      ORDER BY started_at DESC LIMIT ?
    `),
    eventLinks: db.prepare('SELECT a, b, weight FROM event_links ORDER BY weight DESC LIMIT 4000'),

    ledgerLast: db.prepare('SELECT hash FROM security_ledger ORDER BY seq DESC LIMIT 1'),
    ledgerInsert: db.prepare(`
      INSERT INTO security_ledger (id, at, kind, task_id, actor, title, body, refs, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    ledgerList: db.prepare('SELECT * FROM security_ledger WHERE (? = \'\' OR task_id = ?) ORDER BY seq DESC LIMIT ?'),
    ledgerByTask: db.prepare('SELECT * FROM security_ledger WHERE task_id = ? ORDER BY seq ASC'),
    ledgerAll: db.prepare('SELECT * FROM security_ledger ORDER BY seq ASC'),
    ledgerCount: db.prepare('SELECT COUNT(*) AS n FROM security_ledger')
  }

  /* ---------------------------------------------------------- 账本（只追加） */

  function append (input = {}) {
    const at = input.at || now()
    const kind = clip(input.kind || 'note', 24)
    const taskId = input.taskId ? String(input.taskId) : null
    const actor = clip(input.actor || 'user', 60)
    const title = clip(input.title || '', 200)
    const body = input.body === undefined ? {} : input.body
    const refs = input.refs === undefined ? {} : input.refs
    const last = stmt.ledgerLast.get()
    const prev = last ? last.hash : GENESIS
    const payload = { at, kind, taskId: taskId || '', actor, title, body, refs }
    const hash = sha256(prev + '|' + canonical(payload))
    const id = 'E-' + hash.slice(0, 12)
    const info = stmt.ledgerInsert.run(id, at, kind, taskId, actor, title, JSON.stringify(body), JSON.stringify(refs), prev, hash)
    if (taskId) {
      const task = stmt.taskGet.get(taskId)
      if (task) stmt.taskTouch.run((task.entries || 0) + 1, hash, taskId)
    }
    return { id, seq: Number(info.lastInsertRowid), hash, prev, at, kind, taskId, actor, title }
  }

  /**
   * 从头重算整条链。不抽样、不信任索引：
   * 只要有一行的 prev 接不上，或者重算的 hash 对不上，就报出断点。
   */
  function verify () {
    const rows = stmt.ledgerAll.all()
    let prev = GENESIS
    for (const row of rows) {
      if (row.prev_hash !== prev) {
        return { ok: false, count: rows.length, brokenAt: row.seq, reason: '这一条接不上上一条（中间被删或被插入了东西）' }
      }
      const expected = sha256(prev + '|' + canonical({
        at: row.at,
        kind: row.kind,
        taskId: row.task_id || '',
        actor: row.actor,
        title: row.title,
        body: parseJson(row.body, {}),
        refs: parseJson(row.refs, {})
      }))
      if (expected !== row.hash) {
        return { ok: false, count: rows.length, brokenAt: row.seq, reason: '这一条的内容和它的哈希对不上（被改过）' }
      }
      prev = row.hash
    }
    return { ok: true, count: rows.length, head: prev, brokenAt: null, reason: '' }
  }

  function ledger (input = {}) {
    const limit = Math.max(1, Math.min(500, Number(input.limit) || 60))
    const taskId = input.taskId ? String(input.taskId) : ''
    const rows = stmt.ledgerList.all(taskId, taskId, limit)
    return rows.map((row) => ({
      seq: row.seq,
      id: row.id,
      at: row.at,
      kind: row.kind,
      taskId: row.task_id,
      actor: row.actor,
      title: row.title,
      body: parseJson(row.body, {}),
      refs: parseJson(row.refs, {}),
      hash: row.hash,
      prevHash: row.prev_hash
    }))
  }

  function stats () {
    expireStale()
    const pending = db.prepare("SELECT COUNT(*) AS n FROM security_gates WHERE status = 'pending'").get().n
    const denied = db.prepare("SELECT COUNT(*) AS n FROM security_gates WHERE status = 'denied'").get().n
    const approved = db.prepare("SELECT COUNT(*) AS n FROM security_gates WHERE status IN ('approved','used')").get().n
    const openTasks = db.prepare("SELECT COUNT(*) AS n FROM security_tasks WHERE status = 'open'").get().n
    const candidates = db.prepare("SELECT COUNT(*) AS n FROM security_tasks WHERE status = 'candidate'").get().n
    const closedTasks = db.prepare("SELECT COUNT(*) AS n FROM security_tasks WHERE status = 'closed'").get().n
    const entries = stmt.ledgerCount.get().n
    const digested = db.prepare('SELECT COUNT(*) AS n FROM security_tasks WHERE event_code IS NOT NULL').get().n
    const events = db.prepare("SELECT COUNT(*) AS n FROM events WHERE prefix = 'LZ' AND merged_into IS NULL").get().n
    return {
      pending, denied, approved, openTasks, closedTasks, candidates, entries, digested, events,
      head: (stmt.ledgerLast.get() || {}).hash || GENESIS
    }
  }

  /* ---------------------------------------------------------- 闸门 */

  function expireStale () {
    const result = stmt.gateExpire.run(now())
    return result.changes || 0
  }

  function rowToGate (row) {
    if (!row) return null
    return {
      id: row.id,
      at: row.at,
      kind: row.kind,
      exposure: row.exposure,
      target: row.target,
      channel: row.channel,
      purpose: row.purpose,
      taskId: row.task_id,
      runId: row.run_id,
      projectId: row.project_id,
      verdict: row.verdict,
      status: row.status,
      risk: row.risk,
      riskLabel: riskLabel(row.risk),
      hits: parseJson(row.hits, []),
      digest: row.digest,
      preview: row.preview,
      chars: row.chars,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      decisionScope: row.decision_scope,
      usedAt: row.used_at,
      note: row.note
    }
  }

  function digestOf (input) {
    const material = [
      String(input.kind || 'outbound'),
      String(input.target || ''),
      input.args ? canonical(input.args) : String(input.text || '')
    ].join('\u0000')
    return sha256(material)
  }

  /**
   * 出站前过一道。
   *
   * @param {object} input
   * @param {string} [input.text] 纯文本正文
   * @param {object} [input.args] 工具参数（会摊平后逐段扫）
   * @param {string} [input.exposure] none / pull / send / unknown
   * @returns {{verdict:'allow'|'confirm', risk, hits, gateId?, question?, note}}
   */
  function screen (input = {}) {
    const exposure = input.exposure || 'send'
    const scanned = input.args && typeof input.args === 'object'
      ? sensitivity.scanFields(input.args)
      : sensitivity.scan(input.text)
    const hits = scanned.hits || []
    const risk = scanned.risk || 'none'

    if (!hits.length) {
      return { ok: true, verdict: 'allow', risk: 'none', hits: [], reason: '没有命中敏感内容', note: '' }
    }
    if (input.guard === false) {
      /* 守卫关掉时仍然把结果告诉调用方：它可以选择自己收敛，只是不再强制。 */
      return {
        ok: true,
        verdict: 'allow',
        risk,
        hits,
        reason: '外发守卫已关闭',
        note: `守卫关闭中，命中了 ${sensitivity.describe(hits)}`
      }
    }

    const verdict = policy.decide({ risk, exposure, hits, allowTypes: input.allowTypes })
    if (verdict.verdict === 'allow') {
      return {
        ok: true,
        verdict: 'allow',
        risk,
        hits,
        reason: verdict.reason,
        whitelisted: verdict.whitelisted,
        note: verdict.whitelisted ? '这类内容在放行期内' : ''
      }
    }

    const digest = digestOf(input)
    expireStale()
    const reusable = stmt.gateByDigest.get(digest, now())
    if (reusable) {
      stmt.gateUse.run(now(), reusable.id)
      if (reusable.task_id) {
        append({
          kind: 'approval',
          taskId: reusable.task_id,
          actor: 'user',
          title: '批准外发（复用）',
          body: { gate: reusable.id, target: reusable.target, risk: reusable.risk },
          refs: { gate: reusable.id }
        })
      }
      return {
        ok: true,
        verdict: 'allow',
        risk,
        hits,
        gateId: reusable.id,
        reason: '你已经批准过同一份内容',
        reused: true,
        note: ''
      }
    }

    const at = new Date()
    const id = `G-${dayKey(at)}-${crypto.randomBytes(3).toString('hex')}`
    const expiresAt = new Date(at.getTime() + GATE_TTL_MS).toISOString()
    const preview = sensitivity.redactText(input.args ? JSON.stringify(input.args) : input.text, 160)
    const question = policy.question({ hits, risk, target: input.target, channel: input.channel })

    /* AI 自己查过一次、用户还没点，主进程又替它查一次：同一份内容只该有一道闸门。
       否则设置页里会出现两条一模一样的待确认，用户点完一条还剩一条。 */
    const waiting = stmt.gatePendingByDigest.get(digest, at.toISOString())
    if (waiting) {
      return {
        ok: false,
        verdict: 'confirm',
        risk,
        riskLabel: riskLabel(risk),
        hits,
        gateId: waiting.id,
        expiresAt: waiting.expires_at,
        question,
        reason: verdict.reason,
        reusedPending: true,
        note: '这道闸门已经在等用户确认了；确认前不要发送'
      }
    }

    stmt.gateInsert.run(
      id, at.toISOString(), clip(input.kind || 'outbound', 24), exposure,
      clip(input.target || input.channel || '', 200), clip(input.channel || '', 120),
      clip(input.purpose || '', 400), input.taskId || null, input.runId || null, input.projectId || null,
      'confirm', 'pending', risk, JSON.stringify(hits.map((hit) => ({
        type: hit.type, level: hit.level, label: hit.label, count: hit.count, samples: hit.samples, where: hit.where || ''
      }))),
      digest, preview, Number(input.text ? String(input.text).length : 0), expiresAt,
      clip(input.note || '', 400)
    )

    /* 留痕任务里记一笔「被拦下过」：事后回看，「当时我为什么没发」和「我发了什么」同样重要。 */
    if (input.taskId) {
      append({
        kind: 'gate',
        taskId: input.taskId,
        actor: 'agent',
        title: '外发前被拦下',
        body: { gate: id, risk, target: input.target || '', hits: hits.map((hit) => hit.label) },
        refs: { gate: id }
      })
    }

    return {
      ok: false,
      verdict: 'confirm',
      risk,
      riskLabel: riskLabel(risk),
      hits,
      gateId: id,
      expiresAt,
      question,
      reason: verdict.reason,
      note: '需要用户本人确认；确认前不要发送'
    }
  }

  function approve (input = {}) {
    const row = stmt.gateGet.get(String(input.id || ''))
    if (!row) return { ok: false, error: '没有这道闸门' }
    if (row.status === 'used') return { ok: false, error: '这一次已经用掉了' }
    if (row.status === 'denied') return { ok: false, error: '这道闸门已经被拒绝，要重发得重新检查' }
    if (row.status === 'expired' || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
      stmt.gateStatus.run('expired', now(), 'timeout', null, '超时未决', row.id)
      return { ok: false, error: '这道闸门已经超时，重新发一次会重新问' }
    }
    const scope = input.scope === 'type' ? 'type' : 'once'
    stmt.gateStatus.run('approved', now(), 'user', scope, clip(input.note || '', 200), row.id)
    if (row.task_id) {
      append({
        kind: 'approval',
        taskId: row.task_id,
        actor: 'user',
        title: '用户批准外发',
        body: { gate: row.id, risk: row.risk, target: row.target, scope },
        refs: { gate: row.id }
      })
    }
    return { ok: true, gate: rowToGate(stmt.gateGet.get(row.id)) }
  }

  function deny (input = {}) {
    const row = stmt.gateGet.get(String(input.id || ''))
    if (!row) return { ok: false, error: '没有这道闸门' }
    stmt.gateStatus.run('denied', now(), 'user', null, clip(input.note || '', 200), row.id)
    if (row.task_id) {
      append({
        kind: 'approval',
        taskId: row.task_id,
        actor: 'user',
        title: '用户拒绝外发',
        body: { gate: row.id, risk: row.risk, target: row.target, note: clip(input.note || '', 200) },
        refs: { gate: row.id }
      })
    }
    return { ok: true, gate: rowToGate(stmt.gateGet.get(row.id)) }
  }

  function pending () {
    expireStale()
    return stmt.gatePending.all(50).map(rowToGate)
  }

  function gates (input = {}) {
    const limit = Math.max(1, Math.min(200, Number(input.limit) || 40))
    return stmt.gateList.all(limit).map(rowToGate)
  }

  /* ---------------------------------------------------------- 留痕任务 */

  function nextTaskId () {
    const day = dayKey()
    const used = stmt.taskCount.get(`A-${day}-%`).n
    return `A-${day}-${pad2(used + 1)}`
  }

  function rowToTask (row) {
    if (!row) return null
    return {
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      title: row.title,
      ask: row.ask,
      fromName: row.from_name,
      fromId: row.from_id,
      channel: row.channel,
      chat: row.chat,
      messageId: row.message_id,
      deadline: row.deadline,
      expect: row.expect,
      outcome: row.outcome,
      entries: row.entries,
      head: row.head_hash,
      eventId: row.event_id || null,
      eventCode: row.event_code || null,
      digestedAt: row.digested_at || null,
      lastDigestSeq: row.last_digest_seq || 0,
      note: row.note
    }
  }

  function rowToEntry (row) {
    return {
      seq: row.seq,
      id: row.id,
      at: row.at,
      kind: row.kind,
      taskId: row.task_id,
      actor: row.actor,
      title: row.title,
      body: parseJson(row.body, {}),
      refs: parseJson(row.refs, {}),
      hash: row.hash,
      prevHash: row.prev_hash
    }
  }

  /**
   * 派活候选：不写账本，只在索引里留一行「要不要留痕」。
   * 用户点头之前，账本里不该出现任何东西 —— 留痕是用户的决定，不是系统的。
   */
  function considerAssignment (msg = {}) {
    if (!msg || !msg.id) return null
    const existing = stmt.taskByMessage.get(msg.id)
    if (existing) return null
    const verdict = policy.detectAssignment(msg)
    if (!verdict.isAssignment) return null
    const candidates = db.prepare("SELECT COUNT(*) AS n FROM security_tasks WHERE status = 'candidate'").get().n
    if (candidates >= CANDIDATE_LIMIT) return null
    const at = now()
    const id = nextTaskId()
    const text = clip(msg.text, 500)
    stmt.taskInsert.run(
      id, 'candidate', at, null, clip(text, 80), text,
      msg.senderName || '', msg.senderId || '', msg.channelLabel || msg.channelId || '', msg.chatName || msg.chatId || '',
      msg.id, verdict.deadline || '', '', JSON.stringify({ score: verdict.score, reasons: verdict.reasons, kind: msg.channelKind || '' })
    )
    return { id, reasons: verdict.reasons, deadline: verdict.deadline }
  }

  /**
   * 正式留痕：写进索引 + 账本的第一条。
   * 这条账本条目是整条责任链的锚 —— 后面所有动作都挂在它下面。
   */
  function openTask (input = {}) {
    if (input.id) {
      const row = stmt.taskGet.get(String(input.id))
      if (!row) return { ok: false, error: '没有这条留痕' }
      if (row.status === 'open') return { ok: true, task: rowToTask(row), head: row.head_hash }
      if (row.status === 'closed') return { ok: false, error: '这条已经归档了；要重新记请另开一条' }
      stmt.taskStatus.run('open', now(), null, null, row.id)
      const entry = append({
        kind: 'task',
        taskId: row.id,
        actor: 'user',
        title: '开一条留痕',
        body: {
          ask: row.ask,
          from: row.from_name,
          channel: row.channel,
          chat: row.chat,
          deadline: row.deadline,
          messageId: row.message_id,
          candidate: parseJson(row.note, {})
        },
        refs: { inbox: row.message_id, channel: row.channel }
      })
      return { ok: true, task: rowToTask(stmt.taskGet.get(row.id)), entry }
    }

    const at = now()
    const id = nextTaskId()
    const ask = clip(input.ask || input.text || '', 4000)
    if (!ask) return { ok: false, error: '留痕至少要留下一句「他要求你做什么」' }
    const title = clip(input.title || ask, 80)
    stmt.taskInsert.run(
      id, 'open', at, at, title, ask,
      clip(input.from || '', 60), clip(input.fromId || '', 120), clip(input.channel || '', 120),
      clip(input.chat || '', 120), clip(input.messageId || '', 120), clip(input.deadline || '', 60),
      clip(input.expect || '', 200), clip(input.note || '', 200)
    )
    const entry = append({
      kind: 'task',
      taskId: id,
      actor: 'user',
      title: '开一条留痕',
      body: {
        ask,
        from: clip(input.from || '', 60),
        channel: clip(input.channel || '', 120),
        chat: clip(input.chat || '', 120),
        deadline: clip(input.deadline || '', 60),
        expect: clip(input.expect || '', 200)
      },
      refs: { inbox: input.messageId || '', channel: input.channel || '' }
    })
    return { ok: true, task: rowToTask(stmt.taskGet.get(id)), entry }
  }

  function closeTask (input = {}) {
    const row = stmt.taskGet.get(String(input.id || ''))
    if (!row) return { ok: false, error: '没有这条留痕' }
    if (row.status === 'closed') return { ok: true, task: rowToTask(row), already: true }
    const outcome = clip(input.outcome || '', 1000)
    stmt.taskStatus.run('closed', null, now(), outcome, row.id)
    const entry = append({
      kind: 'close',
      taskId: row.id,
      actor: input.actor === 'agent' ? 'agent' : 'user',
      title: '归档',
      body: { outcome, evidence: clip(input.evidence || '', 600) },
      refs: {}
    })
    return { ok: true, task: rowToTask(stmt.taskGet.get(row.id)), entry }
  }

  function dropTask (input = {}) {
    const row = stmt.taskGet.get(String(input.id || ''))
    if (!row) return { ok: false, error: '没有这条留痕' }
    if (row.status !== 'candidate') return { ok: false, error: '只有候选可以这样丢掉；已开的需要归档' }
    stmt.taskStatus.run('dropped', null, now(), null, row.id)
    return { ok: true, task: rowToTask(stmt.taskGet.get(row.id)) }
  }

  function tasks (input = {}) {
    const status = input.status && input.status !== 'all' ? String(input.status) : ''
    const limit = Math.max(1, Math.min(200, Number(input.limit) || 40))
    return stmt.taskList.all(status, status, limit).map(rowToTask)
  }

  /* ---------------------------------------------------------- 压缩进事件网
   *
   * 账本一条不留，事件只留一两行。压缩不是把正文摘要一遍，是给「回忆」做索引：
   *   summary —— 谁、从哪来、要什么、最后怎样（进事件网，参与检索）
   *   result  —— 做了多少、批没批、证据编号（给人扫一眼）
   * 原话只留开头并先脱敏；完整原话仍然只住在 security_tasks.ask 与导出件里。
   */

  function entriesOf (taskId) {
    return stmt.ledgerByTask.all(taskId).map(rowToEntry)
  }

  function weightOfTask (task, entries) {
    return digestLib.weightOf({ task, entries, now: Date.now() })
  }

  function nextEventSeq () {
    return db.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE project_id IS NULL AND prefix = 'LZ'"
    ).get().next
  }

  /**
   * 把一条留痕压成一条事件。
   * 幂等：账本没长出新的条目就不重复写；加了新条目再压，会追加下一条（同一任务可有多条）。
   */
  function digestTask (input = {}) {
    const row = stmt.taskGet.get(String(input.id || ''))
    if (!row) return { ok: false, error: '没有这条留痕' }
    const entries = entriesOf(row.id)
    const lastSeq = entries.length ? entries[entries.length - 1].seq : 0
    if (!input.force && row.event_code && lastSeq <= (row.last_digest_seq || 0)) {
      return {
        ok: true,
        already: true,
        task: rowToTask(row),
        event: { id: row.event_id, code: row.event_code }
      }
    }

    const task = rowToTask(row)
    const { summary, result, metrics, gaps } = digestLib.summarize({ task, entries })
    const at = row.opened_at || row.created_at || now()
    const stamp = now()
    db.prepare('INSERT OR IGNORE INTO event_prefixes (prefix, series, created_at, owner) VALUES (?, ?, ?, ?)')
      .run('LZ', '工作留痕', stamp, 'super')
    const seq = nextEventSeq()
    const id = crypto.randomUUID()
    const code = 'LZ' + String(seq).padStart(3, '0')
    /* 权重按「压完之后」的状态算：完整性里含「有没有进事件网」这一项，
       否则事件里写的 57% 和列表里的 60% 会对不上。 */
    const weight = weightOfTask({ ...task, eventCode: code }, entries)

    stmt.eventInsert.run(
      id, 'LZ', seq, at, row.closed_at || null, result, summary,
      JSON.stringify({
        taskId: row.id,
        kind: 'security-digest',
        status: row.status,
        metrics,
        weight: weight.percent,
        gaps: gaps.length
      })
    )
    stmt.taskSetEvent.run(id, code, stamp, lastSeq, row.id)

    return {
      ok: true,
      task: rowToTask(stmt.taskGet.get(row.id)),
      event: { id, code, at, summary, result },
      metrics,
      gaps,
      weight,
      compressed: `${entries.length} 条账本 → ${summary.length + result.length} 字`
    }
  }

  function eventsOfTask (taskId) {
    return stmt.eventByPrefix.all(400)
      .filter((row) => parseJson(row.metadata, {}).taskId === taskId)
      .map((row) => ({
        id: row.id,
        code: row.prefix + String(row.seq).padStart(3, '0'),
        at: row.started_at,
        summary: row.summary || '',
        result: row.result || '',
        metadata: parseJson(row.metadata, {})
      }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
  }

  /**
   * 同一时间前后发生的事：靠事件网的连边、内容重合、时间接近三样加权。
   * 追原委时最有用的一句往往是「那会儿你也在改另一个项目」——账本里没有，网里有。
   */
  function relatedEvents (task, entries, ownEvents, input = {}) {
    if (!entries.length) return []
    const times = entries.map((entry) => Date.parse(entry.at)).filter(Number.isFinite)
    if (!times.length) return []
    const start = Math.min(...times)
    const end = Math.max(...times)
    const span = Number(input.days) > 0 ? Number(input.days) * 86400000 : 12 * 3600000
    const from = new Date(start - span).toISOString()
    const to = new Date(end + span).toISOString()
    const rows = stmt.eventBetween.all(from, to, 80)
    if (!rows.length) return []

    const own = new Set(ownEvents.map((event) => event.id))
    const linked = new Map()
    for (const link of stmt.eventLinks.all()) {
      if (own.has(link.a)) linked.set(link.b, Math.max(linked.get(link.b) || 0, link.weight))
      if (own.has(link.b)) linked.set(link.a, Math.max(linked.get(link.a) || 0, link.weight))
    }

    const hay = [task.title, task.ask, task.outcome, task.fromName, task.chat].filter(Boolean).join(' ')
    const scored = []
    for (const row of rows) {
      const text = [row.summary || '', row.result || ''].join(' ')
      const link = linked.get(row.id) || 0
      const content = digestLib.overlap(hay, text)
      const at = Date.parse(row.started_at)
      const closeness = Number.isFinite(at)
        ? Math.max(0, 1 - Math.min(Math.abs(at - start), Math.abs(at - end)) / span)
        : 0
      const score = link * 0.5 + content * 0.3 + closeness * 0.2
      if (score < 0.12) continue
      scored.push({
        id: row.id,
        code: row.prefix + String(row.seq).padStart(3, '0'),
        at: row.started_at,
        summary: row.summary || '',
        result: row.result || '',
        project: row.project_id || '',
        score: Number(score.toFixed(3)),
        via: link >= Math.max(0.2, content) ? '同网' : (content >= 0.12 ? '内容' : '同时段')
      })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, Math.max(1, Math.min(10, Number(input.limit) || 5)))
  }

  /** 按内容与权重找留痕。问「原委」时不要求字面重合，30 天以后降权但不硬砍。 */
  function search (input = {}) {
    const query = String(input.query || '').trim()
    if (!query) return []
    const limit = Math.max(1, Math.min(20, Number(input.limit) || 5))
    const intent = digestLib.wantsTrace(query)

    /* 先做便宜的：只读任务行、算字面重合，不碰账本。
       留痕是长期账，几百条时每条都去数账本，回忆会变慢；先筛出十来个再看细节。 */
    const base = stmt.taskLive.all(120).map((row) => {
      const task = rowToTask(row)
      const hay = [task.title, task.ask, task.outcome, task.fromName, task.channel, task.chat, task.deadline]
        .filter(Boolean).join(' ')
      return { task, content: digestLib.overlap(query, hay) }
    })

    let shortlist
    if (intent) {
      /* 问原委：内容最像的 + 最近的。用户可能只记得「合同的活」，原话里也就这两个字。 */
      const byContent = [...base].sort((a, b) => b.content - a.content).slice(0, 8)
      const byTime = base.slice(0, 8)
      shortlist = [...new Map([...byContent, ...byTime].map((item) => [item.task.id, item])).values()]
    } else {
      shortlist = base.filter((item) => item.content > 0)
        .sort((a, b) => b.content - a.content).slice(0, 10)
    }

    const out = []
    for (const { task, content } of shortlist) {
      const entries = entriesOf(task.id)
      const weight = weightOfTask(task, entries)
      const days = task.createdAt ? (Date.now() - Date.parse(task.createdAt)) / 86400000 : 999
      const recent = Number.isFinite(days) && days <= 30 ? 1 : 0.55
      const score = intent
        ? (0.3 + 0.7 * content) * (0.45 + 0.55 * weight.weight) * recent
        : content * (0.55 + 0.45 * weight.weight)
      if (score < (intent ? 0.1 : 0.08)) continue
      out.push({
        id: task.id,
        code: task.eventCode || '',
        status: task.status,
        at: task.createdAt,
        title: digestLib.oneLine(task.title, 60),
        from: task.fromName || '',
        channel: task.channel || '',
        chat: task.chat || '',
        summary: digestLib.summarize({ task, entries }).summary,
        weight: weight.percent,
        score: Number(score.toFixed(3)),
        why: intent
          ? (content >= 0.12 ? '原委 + 内容' : '按权重与时间')
          : '内容相近'
      })
    }
    out.sort((a, b) => b.score - a.score || b.weight - a.weight)
    return out.slice(0, limit)
  }

  /** 一句可转述的原委，按时间排，不是按重要度排 —— 追责看的是先后。 */
  function traceText ({ task, entries, events, related, chain, weight, metrics, gaps }) {
    const lines = []
    const first = entries.find((entry) => entry.kind === 'task') || entries[0]
    lines.push('【来路】')
    if (first) {
      const from = task.fromName || '对方'
      const where = [task.channel, task.chat].filter(Boolean).join('·')
      lines.push(`- ${timeText(first.at)} ${from}${where ? `（${where}）` : ''}说：「${digestLib.oneLine(first.body.ask || task.ask, 180)}」`)
      if (task.deadline) lines.push(`- 时限：${task.deadline}`)
    } else {
      lines.push(`- 这条没有开留痕，只有消息本身：「${digestLib.oneLine(task.ask, 180)}」`)
    }

    lines.push('【做了什么】')
    const steps = entries.filter((entry) => entry.kind !== 'task' && entry.kind !== 'close')
    if (!steps.length) lines.push('- 账本里没有动作记录。')
    /* 长账本给「开头 + 结尾」：开头决定事情怎么来的，结尾决定最后怎么收的，
       中间省掉的部分要明确标出，不能悄悄跳过。 */
    const shown = steps.length <= 14
      ? steps
      : [...steps.slice(0, 8), { skipped: steps.length - 13 }, ...steps.slice(-5)]
    for (const entry of shown) {
      if (entry.skipped) {
        lines.push(`- ……中间 ${entry.skipped} 步，见账本`)
        continue
      }
      const who = entry.actor === 'user' ? '你' : entry.actor === 'agent' ? 'AI' : entry.actor
      const what = entryLine(entry) || entry.title
      lines.push(`- ${timeText(entry.at)} ${who} · ${KIND_LABEL[entry.kind] || entry.kind}：${what}`)
    }

    lines.push('【结果】')
    if (task.outcome) lines.push('- ' + task.outcome)
    else if (task.status === 'open') lines.push('- 还没归档，事情仍在进行。')
    else lines.push('- 归档时没有写结果。')

    const latest = events[events.length - 1]
    lines.push('【证据】')
    lines.push(`- 留痕 ${task.id}${latest ? ` · 事件 ${latest.code}` : ' · 还没压进事件网'} · 账本 ${metrics.entries} 条 · 权重 ${weight.percent}%`)
    lines.push(`- 链${chain.ok ? '完整：从头重算全部一致' : `在第 ${chain.brokenAt} 条断了（${chain.reason}）`}，链头 ${String(chain.head || '').slice(0, 12)}`)

    if (related.length) {
      lines.push('【同一时间前后】')
      for (const item of related.slice(0, 4)) {
        lines.push(`- ${item.code} ${digestLib.oneLine(item.summary, 90)}（${timeText(item.at)} · ${item.via}）`)
      }
    }

    lines.push('【要留意】')
    if (!gaps.length) lines.push('- 记录对得上，没有明显缺口。')
    for (const gap of gaps.slice(0, 4)) lines.push('- ' + gap)
    return lines.join('\n')
  }

  function trace (input = {}) {
    let row = null
    if (input.id) {
      row = stmt.taskGet.get(String(input.id))
      if (!row) return { ok: false, error: '没有这条留痕：' + String(input.id) }
    } else {
      const hits = search({ query: input.query, limit: 1 })
      if (!hits.length) {
        return {
          ok: true,
          found: false,
          task: null,
          text: '没有找到相关的留痕。可能这件事当时没有开留痕 —— 那就没有账本可查，不能假装有。'
        }
      }
      row = stmt.taskGet.get(hits[0].id)
    }

    const task = rowToTask(row)
    const entries = entriesOf(task.id)
    const metrics = digestLib.countOf(entries)
    const weight = weightOfTask(task, entries)
    const events = eventsOfTask(task.id)
    const related = relatedEvents(task, entries, events, { days: input.days, limit: input.related })
    const chain = verify()
    const gaps = digestLib.gapsOf({ task, entries, metrics })
    const text = traceText({ task, entries, events, related, chain, weight, metrics, gaps })

    return {
      ok: true,
      found: true,
      task,
      event: events[events.length - 1] || null,
      weight,
      metrics,
      gaps,
      verify: chain,
      related,
      /* 只给一行一行的说法，不把 body 整包丢出去：要看原始细节用 export */
      timeline: entries.slice(-60).map((entry) => ({
        seq: entry.seq,
        at: entry.at,
        kind: entry.kind,
        actor: entry.actor,
        title: entry.title,
        line: entryLine(entry)
      })),
      text
    }
  }

  /** 首流用的一小段：只回答「有没有事等着你」和「去哪问原委」。 */
  function brief () {
    return briefLib.lines(db)
  }

  /* ---------------------------------------------------------- 导出 */

  function timeText (iso) {
    if (!iso) return ''
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  }

  const KIND_LABEL = {
    task: '任务来源',
    understand: '理解',
    action: '动作',
    outbound: '外发',
    approval: '批准',
    gate: '拦下',
    close: '归档',
    correct: '更正',
    note: '备注'
  }

  function entryLine (entry) {
    const body = entry.body || {}
    const parts = []
    if (entry.kind === 'task') {
      if (body.from) parts.push('来自 ' + body.from)
      if (body.deadline) parts.push('时限 ' + body.deadline)
      if (body.ask) parts.push('原话：' + clip(body.ask, 200))
    } else if (entry.kind === 'action') {
      if (body.tool) parts.push(body.tool)
      if (body.target) parts.push('→ ' + body.target)
      if (body.summary) parts.push(clip(body.summary, 160))
    } else if (entry.kind === 'outbound') {
      if (body.target) parts.push('发往 ' + body.target)
      if (body.risk) parts.push('风险 ' + riskLabel(body.risk))
      if (body.gate) parts.push('闸门 ' + body.gate)
    } else if (entry.kind === 'approval' || entry.kind === 'gate') {
      if (body.target) parts.push(body.target)
      if (body.risk) parts.push(riskLabel(body.risk))
      if (body.gate) parts.push('闸门 ' + body.gate)
    } else if (entry.kind === 'close') {
      if (body.outcome) parts.push(clip(body.outcome, 200))
    } else if (body.text) {
      parts.push(clip(body.text, 160))
    }
    return parts.join(' · ')
  }

  /** 存证包：一份能直接贴进邮件的 Markdown，带链头与校验结论。 */
  function exportTask (input = {}) {
    const row = stmt.taskGet.get(String(input.id || ''))
    if (!row) return { ok: false, error: '没有这条留痕' }
    const task = rowToTask(row)
    const entries = stmt.ledgerByTask.all(row.id).map((item) => ({
      seq: item.seq,
      at: item.at,
      kind: item.kind,
      actor: item.actor,
      title: item.title,
      body: parseJson(item.body, {}),
      refs: parseJson(item.refs, {}),
      hash: item.hash
    }))
    const chain = verify()
    const broken = chain.ok ? '' : `\n> ⚠ 整条账本在第 ${chain.brokenAt} 条断了：${chain.reason}。这份记录不能作为完整证据。`

    const lines = []
    lines.push(`# 工作留痕 · ${task.id}`)
    lines.push('')
    lines.push(`- 留痕编号：${task.id}`)
    lines.push(`- 建立时间：${timeText(task.createdAt)}`)
    lines.push(`- 任务来源：${[...new Set([task.channel, task.chat, task.fromName].filter(Boolean))].join(' · ') || '未记录'}`)
    lines.push(`- 时限：${task.deadline || '未提及'}`)
    lines.push(`- 状态：${{ open: '进行中', closed: '已归档', candidate: '待确认', dropped: '未采用' }[task.status] || task.status}`)
    if (task.eventCode) lines.push(`- 事件编号：${task.eventCode}（已压缩进事件网）`)
    if (task.outcome) lines.push(`- 结论：${clip(task.outcome, 400)}`)
    lines.push('')
    lines.push('## 原始要求')
    lines.push('')
    lines.push('> ' + String(task.ask || '').split('\n').join('\n> '))
    lines.push('')
    lines.push('## 时间线')
    lines.push('')
    lines.push('| 时间 | 类型 | 谁 | 内容 | 哈希 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const entry of entries) {
      const who = entry.actor === 'user' ? '用户本人' : entry.actor === 'agent' ? 'AI' : entry.actor
      lines.push(`| ${timeText(entry.at)} | ${KIND_LABEL[entry.kind] || entry.kind} | ${who} | ${entryLine(entry).replace(/\|/g, '／')} | ${entry.hash.slice(0, 10)} |`)
    }
    lines.push('')
    lines.push('## 责任链')
    lines.push('')
    const first = entries[0]
    const outbounds = entries.filter((entry) => entry.kind === 'outbound')
    const approvals = entries.filter((entry) => entry.kind === 'approval')
    const actions = entries.filter((entry) => entry.kind === 'action')
    lines.push(`- 这件事是 ${first ? first.body.from || '对方' : '对方'} 在 ${first ? timeText(first.at) : '—'} 提出的，原话见上。`)
    lines.push(`- 期间执行动作 ${actions.length} 次，外发 ${outbounds.length} 次，用户批准 ${approvals.filter((entry) => entry.title.includes('批准')).length} 次。`)
    if (approvals.length) {
      lines.push('- 每一次外发都对应一次明确批准，批准绑在具体内容与具体去处上：')
      for (const entry of approvals) {
        lines.push(`  - ${timeText(entry.at)}：${entry.title}（${entry.body.target || ''}）`)
      }
    } else if (outbounds.length) {
      lines.push('- 有外发但没有批准记录，这一点需要人工核对。')
    } else {
      lines.push('- 没有发生外发。')
    }
    lines.push('')
    lines.push('## 完整性')
    lines.push('')
    lines.push(`- 账本条目：${chain.count}`)
    lines.push(`- 本任务条目：${entries.length}`)
    lines.push(`- 链头哈希：\`${chain.head}\``)
    lines.push(`- 校验结果：${chain.ok ? '通过（从头逐条重算，全部一致）' : '未通过'}`)
    lines.push('- 校验方法：第 n 条的 hash = sha256(第 n-1 条的 hash + "|" + 本条规范化 JSON)。任何一条被修改、删除或插入，后续哈希都对不上。')
    lines.push('- 账本由数据库触发器禁止修改与删除，只允许追加。')
    if (broken) lines.push(broken)
    lines.push('')
    lines.push('> 本记录用于说明「这件事是怎么来的、谁批准的、做到了哪一步」，')
    lines.push('> 不构成法律责任划分的依据。它证明记录没被改过，不证明所有事都被记下来了。')
    lines.push('')
    lines.push(`> 导出时间：${timeText(now())}　·　导出工具：星界 ASTRAL REALM`)

    return {
      ok: true,
      task,
      entries,
      verify: chain,
      markdown: lines.join('\n')
    }
  }

  return {
    screen,
    approve,
    deny,
    pending,
    gates,
    considerAssignment,
    openTask,
    closeTask,
    dropTask,
    tasks,
    append,
    ledger,
    verify,
    exportTask,
    digestTask,
    trace,
    search,
    brief,
    stats,
    riskLabel,
    GENESIS
  }
}

module.exports = { createSecurityStore, GENESIS, canonical, sha256 }
