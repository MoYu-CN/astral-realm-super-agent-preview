'use strict'

/**
 * memory/inbox.js — 收件箱的读写（第五张表组，但它是入口不是网）
 *
 * 三条纪律：
 *   1. 原文只进 inbox_messages，永不进上下文；越界的只有摘要。
 *   2. 入库幂等：同一条消息重复到达只更新计数，不新增行。
 *   3. 只有 alert / observe 两档才写 observations —— 归档的东西不该影响
 *      时段习惯与进程阶段，那是「发生过什么」，不是「外面说了什么」。
 */

const CATALOG = require('../intake/catalog.js')
const NORMALIZE = require('../intake/normalize.js')

const MESSAGE_LIMIT = 4000
const OBSERVE_KEEP = 600

function now () {
  return new Date().toISOString()
}

function parseJson (value, fallback) {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function createInbox (db, options = {}) {
  /* 派活识别挂在入库之后：它要的是「这句话像不像在给你派活」，
     而不是「这条消息重不重要」。两条独立判断，互不背书。 */
  const onAlert = typeof options.onAlert === 'function' ? options.onAlert : null
  const stmt = {
    channelList: db.prepare('SELECT * FROM inbox_channels ORDER BY created_at ASC'),
    channelGet: db.prepare('SELECT * FROM inbox_channels WHERE id = ?'),
    channelInsert: db.prepare(`
      INSERT INTO inbox_channels (id, kind, label, enabled, config, status, cursor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    channelUpdate: db.prepare(`
      UPDATE inbox_channels SET kind = ?, label = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?
    `),
    channelRemove: db.prepare('DELETE FROM inbox_channels WHERE id = ?'),
    channelStatus: db.prepare('UPDATE inbox_channels SET status = ?, last_error = ?, last_at = COALESCE(?, last_at) WHERE id = ?'),
    channelCursor: db.prepare('UPDATE inbox_channels SET cursor = ? WHERE id = ?'),
    insertMessage: db.prepare(`
      INSERT OR IGNORE INTO inbox_messages
        (id, channel_id, kind, scope, chat_id, chat_name, sender_id, sender_name, msg_id, at,
         text, attachments, mentions_me, route, reason, score, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    threadUpsert: db.prepare(`
      INSERT INTO inbox_threads (id, channel_id, chat_id, name, scope, total, unread, alerts, last_text, last_at)
      VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(NULLIF(excluded.name, ''), inbox_threads.name),
        total = inbox_threads.total + 1,
        unread = inbox_threads.unread + 1,
        alerts = inbox_threads.alerts + excluded.alerts,
        last_text = excluded.last_text,
        last_at = excluded.last_at
    `),
    observe: db.prepare(`
      INSERT OR IGNORE INTO observations (id, at, source, kind, text, weight, meta)
      VALUES (?, ?, 'intake', ?, ?, ?, ?)
    `)
  }

  function rowToChannel (row) {
    const kind = CATALOG.get(row.kind)
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      enabled: Boolean(row.enabled),
      config: parseJson(row.config, {}),
      status: row.status || '待启动',
      lastAt: row.last_at || null,
      lastError: row.last_error || '',
      cursor: parseJson(row.cursor, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      catalog: kind ? { label: kind.label, risk: kind.risk, capabilities: kind.capabilities, transport: kind.transport } : null
    }
  }

  /* ---------------------------------------------------------- 渠道 */

  function listChannels () {
    return stmt.channelList.all().map(rowToChannel)
  }

  function getChannel (id) {
    const row = stmt.channelGet.get(String(id || ''))
    return row ? rowToChannel(row) : null
  }

  function saveChannel (input = {}) {
    const id = String(input.id || '').trim()
    const kind = CATALOG.get(input.kind)
    if (!id) return { ok: false, error: '缺少渠道 id' }
    if (!kind) return { ok: false, error: `未知渠道类型：${input.kind || '(空)'}` }
    const label = String(input.label || kind.label).trim().slice(0, 40)
    const at = now()
    const existing = stmt.channelGet.get(id)
    const config = JSON.stringify(input.config || {})
    if (existing) {
      stmt.channelUpdate.run(kind.id, label, input.enabled ? 1 : 0, config, at, id)
    } else {
      stmt.channelInsert.run(id, kind.id, label, input.enabled ? 1 : 0, config, '待启动', '{}', at, at)
    }
    return { ok: true, channel: getChannel(id) }
  }

  function removeChannel (id) {
    const row = stmt.channelGet.get(String(id || ''))
    if (!row) return { ok: false, error: '没有这个渠道' }
    stmt.channelRemove.run(row.id)
    db.prepare('DELETE FROM inbox_messages WHERE channel_id = ?').run(row.id)
    db.prepare('DELETE FROM inbox_threads WHERE channel_id = ?').run(row.id)
    return { ok: true, removed: row.id }
  }

  function setEnabled (id, enabled) {
    const row = stmt.channelGet.get(String(id || ''))
    if (!row) return { ok: false, error: '没有这个渠道' }
    db.prepare('UPDATE inbox_channels SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), row.id)
    return { ok: true, channel: getChannel(row.id) }
  }

  function setStatus (id, status, error = '') {
    stmt.channelStatus.run(String(status || ''), String(error || ''), status === '运行中' ? now() : null, String(id || ''))
    return { ok: true }
  }

  function saveCursor (id, cursor) {
    stmt.channelCursor.run(JSON.stringify(cursor || {}), String(id || ''))
    return { ok: true }
  }

  /* ---------------------------------------------------------- 入库 */

  /**
   * @param {object} channel `{ id, kind, label, config }`
   * @param {Array<object>} raws 适配器给的原始条目
   * @returns {{ok:boolean, inserted:number, duplicates:number, alerts:number, messages:Array}}
   */
  function ingest (channel, raws = []) {
    const list = Array.isArray(raws) ? raws : [raws]
    const keywords = Array.isArray(channel.config && channel.config.keywords) ? channel.config.keywords : []
    let inserted = 0
    let duplicates = 0
    let alerts = 0
    const kept = []

    for (const raw of list) {
      const norm = NORMALIZE.normalize(channel, raw)
      if (!norm.ok) continue
      const msg = norm.message
      const verdict = NORMALIZE.classify(msg, { keywords })
      const result = stmt.insertMessage.run(
        msg.id, msg.channelId, msg.kind, msg.scope, msg.chatId, msg.chatName,
        msg.senderId, msg.senderName, msg.msgId, msg.at, msg.text,
        msg.attachments, msg.mentionsMe ? 1 : 0,
        verdict.route, verdict.reason, verdict.score,
        msg.raw === undefined ? null : JSON.stringify(msg.raw).slice(0, 20000)
      )
      if (!result.changes) { duplicates += 1; continue }
      inserted += 1
      kept.push({ ...msg, route: verdict.route, reason: verdict.reason, score: verdict.score })

      stmt.threadUpsert.run(
        `${msg.channelId}:${msg.chatId}`, msg.channelId, msg.chatId, msg.chatName,
        msg.scope, verdict.route === 'alert' ? 1 : 0,
        (msg.text || '').slice(0, 120), msg.at
      )

      /* 只有该记的才写观察池：归档的群聊绝不能影响时段权重 */
      if (verdict.route === 'alert' || verdict.route === 'observe') {
        if (verdict.route === 'alert') alerts += 1
        stmt.observe.run(
          'inbox-' + msg.id,
          msg.at,
          verdict.route === 'alert' ? 'message' : 'mention',
          NORMALIZE.summarize(msg, 120),
          verdict.route === 'alert' ? 1.6 : 1,
          JSON.stringify({ channel: msg.channelId, chat: msg.chatId, route: verdict.route, reason: verdict.reason })
        )
      }

      /* 像派活的，留一条「要不要留痕」的候选；不写账本，等用户点头。
         带上渠道名称与类型：账本里写「wecom-1a2b」没人看得懂，写「企业微信」才看得懂。 */
      if (onAlert && verdict.route === 'alert') {
        try {
          onAlert({ ...msg, route: verdict.route, reason: verdict.reason, score: verdict.score, channelLabel: channel.label || '', channelKind: channel.kind || '' })
        } catch { /* 留痕失败不该丢消息 */ }
      }
    }

    if (inserted) {
      db.prepare('UPDATE inbox_channels SET last_at = ?, status = ?, last_error = ? WHERE id = ?')
        .run(kept[kept.length - 1].at, '运行中', '', channel.id)
      pruneObservations()
    }
    return { ok: true, inserted, duplicates, alerts, messages: kept }
  }

  /* 观察池是「最近在想什么」，不是档案馆：intake 来的留最近 600 条足够，
     再多会把饭点提醒与阶段判断挤成噪声。 */
  function pruneObservations () {
    const total = db.prepare("SELECT COUNT(*) AS n FROM observations WHERE source IN ('intake')").get().n
    if (total <= OBSERVE_KEEP) return
    db.prepare(`
      DELETE FROM observations WHERE id IN (
        SELECT id FROM observations WHERE source IN ('intake')
        ORDER BY at ASC LIMIT ?
      )
    `).run(total - OBSERVE_KEEP)
  }

  /* ---------------------------------------------------------- 查询 */

  function listMessages (input = {}) {
    const where = []
    const args = []
    if (input.channel) { where.push('channel_id = ?'); args.push(String(input.channel)) }
    if (input.chat) { where.push('chat_id = ?'); args.push(String(input.chat)) }
    if (input.route) { where.push('route = ?'); args.push(String(input.route)) }
    if (input.since) { where.push('at >= ?'); args.push(String(input.since)) }
    if (input.q) {
      where.push('(text LIKE ? OR sender_name LIKE ? OR chat_name LIKE ?)')
      const like = '%' + String(input.q).slice(0, 60) + '%'
      args.push(like, like, like)
    }
    const limit = Math.max(1, Math.min(500, Number(input.limit) || 60))
    const sql = `SELECT * FROM inbox_messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY at DESC LIMIT ${limit}`
    const rows = db.prepare(sql).all(...args)
    return rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      chatId: row.chat_id,
      chatName: row.chat_name,
      senderName: row.sender_name,
      scope: row.scope,
      at: row.at,
      text: row.text,
      attachments: row.attachments,
      mentionsMe: Boolean(row.mentions_me),
      route: row.route,
      reason: row.reason,
      score: row.score,
      handledAt: row.handled_at
    }))
  }

  function listThreads (input = {}) {
    const limit = Math.max(1, Math.min(200, Number(input.limit) || 40))
    const rows = db.prepare(`
      SELECT * FROM inbox_threads
      ${input.channel ? 'WHERE channel_id = ?' : ''}
      ORDER BY alerts DESC, last_at DESC LIMIT ${limit}
    `).all(...(input.channel ? [String(input.channel)] : []))
    return rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      chatId: row.chat_id,
      name: row.name,
      scope: row.scope,
      total: row.total,
      unread: row.unread,
      alerts: row.alerts,
      lastText: row.last_text,
      lastAt: row.last_at,
      muted: Boolean(row.muted)
    }))
  }

  function stats () {
    const total = db.prepare('SELECT COUNT(*) AS n FROM inbox_messages').get().n
    const byRoute = db.prepare('SELECT route, COUNT(*) AS n FROM inbox_messages GROUP BY route').all()
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayCount = db.prepare('SELECT COUNT(*) AS n FROM inbox_messages WHERE at >= ?').get(today.toISOString()).n
    const channels = listChannels()
    const routes = { alert: 0, observe: 0, knowledge: 0, archive: 0 }
    for (const row of byRoute) if (row.route in routes) routes[row.route] = row.n
    return {
      total,
      today: todayCount,
      routes,
      channels: channels.length,
      running: channels.filter((item) => item.enabled && item.status === '运行中').length,
      lastAt: channels.reduce((latest, item) => (item.lastAt && item.lastAt > latest ? item.lastAt : latest), '')
    }
  }

  function markHandled (ids = []) {
    const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean)
    if (!list.length) return { ok: true, updated: 0 }
    const at = now()
    const run = db.prepare('UPDATE inbox_messages SET handled_at = ? WHERE id = ?')
    let updated = 0
    for (const id of list) updated += run.run(at, id).changes || 0
    return { ok: true, updated }
  }

  function clearMessages (input = {}) {
    const before = input.before ? String(input.before) : now()
    const result = db.prepare('DELETE FROM inbox_messages WHERE at < ?').run(before)
    return { ok: true, removed: result.changes || 0 }
  }

  return {
    listChannels, getChannel, saveChannel, removeChannel, setEnabled, setStatus, saveCursor,
    ingest, listMessages, listThreads, stats, markHandled, clearMessages, MESSAGE_LIMIT
  }
}

module.exports = { createInbox }
