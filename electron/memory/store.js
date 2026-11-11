'use strict'

/**
 * 星界 · 记忆服务 Store（P0 雏形）
 * 规则来源：docs/记忆数据库与MCP工具-实施计划书.md
 *  - 一次 write 在事务内完成：编号分配 + 前缀表对照 + 事件/提议/派发落库
 *  - 按角色分区：memory_* 仅超级智能体；knowledge 开放执行层，外部直连默认只读
 *  - T3 同类事件合并、T5 旧决定只追加不覆盖、C3 知识过期即删
 */

const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { createDb } = require('./db.js')
const { createArchive } = require('./archive.js')
const hardContextLib = require('./hard-context.js')
const weights = require('./weights.js')
const kbIndex = require('./kb-index.js')
const { createInbox } = require('./inbox.js')
const { createSecurityStore } = require('./security.js')
const inboxBrief = require('../intake/brief.js')

const ROLE = Object.freeze({ SUPER: 'super', EXECUTOR: 'executor', EXTERNAL: 'external' })
const PROPOSAL_RESULTS = ['接受', '拒绝', '已下发任务']

function ok (data, extra) { return { ok: true, data, ...(extra || {}) } }
function fail (error) { return { ok: false, error } }
function now () { return new Date().toISOString() }

/* ------------------------------------------------------------ 时间帮手
   全部按本机时区算：用户说「周一晚上九点」指的是他自己的钟，不是 UTC。 */
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const EVENT_DOC_LIMIT = 600
/* 时间网按「周」计：13 周≈91 天半衰期。规律是跨周重复出来的，
   所以衰减的单位是周，不是事件条数、也不是天数。 */
const TIME_HALF_LIFE_WEEKS = 13
const TIME_FRESH_MS = 5 * 60 * 1000

function pad2 (n) { return String(n).padStart(2, '0') }
function dayStr (date) { return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) }

/* 触发时间按本机时区显示：用户看到的是自己的钟，不是 UTC */
function triggerTime (iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso).slice(0, 16).replace('T', ' ')
  return dayStr(date) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/* 周一为一周之始：周日晚上做的事算这一周，不算下一周 */
function mondayOf (value) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return date
}

/* ISO 周编号（2026-W45）：跨年那周按「属于哪一年的周四」算 */
function weekKeyOf (monday) {
  const probe = new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()))
  const offset = (probe.getUTCDay() + 6) % 7
  probe.setUTCDate(probe.getUTCDate() - offset + 3)
  const year = probe.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(year, 0, 4))
  const week = 1 + Math.round((probe.getTime() - firstThursday.getTime()) / (7 * 86400000))
  return year + '-W' + pad2(week)
}

function weekdayOf (value) { return ((new Date(value).getDay() + 6) % 7) + 1 }
function oneLine (text, max = 90) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}
function linkWeight (lexical, cooccur) {
  return Math.min(1, 0.75 * (Number(lexical) || 0) + 0.25 * (Number(cooccur) || 0))
}

/* ------------------------------------------------------------ 进程层帮手
   阶段不是外部流程，是用户自己的进程：累计走到第几条、隔了多久没动。
   指令类型从「前缀系列名 + 事件内容」判，具体词优先、宽泛词垫底。 */
const WEEK_MS = 7 * 86400000
const PHASE_HALF_LIFE_WEEKS = 8
const PHASE_TREND_WEEKS = 4
const PHASE_SHRINK = 3
/* 权重近 / 远的分界：词法权重的上限约 0.75，0.25 能把「明显同类」与「只是沾边」分开 */
const DEFAULT_NEAR = 0.25
const INTENT_RULES = [
  ['修复', /修复|报错|bug|异常|失败|校验|崩溃|兜底|排障|500|error/i],
  ['验证', /验证|回归|测试|检查|复测|验收|自检/i],
  ['发布', /发布|上线|部署|打包|发版|构建|交付/i],
  ['回顾', /回顾|总结|复盘|查一下|为什么|分析|梳理|回忆|看看/i],
  ['新增', /新增|实现|接入|添加|加上|搭建|新建|支持/i],
  ['改动', /改|调整|重构|优化|替换|迁移|升级|换/i]
]

function intentOf (text, series) {
  const source = String(series || '') + ' ' + String(text || '')
  for (const [name, re] of INTENT_RULES) if (re.test(source)) return name
  return '其他'
}

function phaseOf (seqNo, spanDays, gapDays) {
  if (gapDays >= 14) return '回归'
  if (seqNo <= 2 || spanDays < 2) return '启动'
  if (seqNo >= 10 && gapDays >= 3) return '收尾'
  if (seqNo >= 6) return '打磨'
  return '推进'
}

function median (values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function createMemoryStore ({
  configDir,
  dbPath,
  archiveDir,
  enabled = true,
  allowExternalWrite = false
} = {}) {
  if (!configDir && !dbPath) throw new Error('createMemoryStore 需要 configDir 或 dbPath')
  const { db, file, close } = createDb({ configDir, dbPath })
  const archive = createArchive({
    configDir: configDir || path.dirname(dbPath),
    archiveDir,
    db
  })

  function requireSuper (actor) {
    if (actor !== ROLE.SUPER) {
      throw new Error('权限拒绝：memory_* 仅超级智能体可调用（actor=' + String(actor) + '）')
    }
  }

  function ensurePrefix (prefix, series, actor) {
    const found = db.prepare('SELECT prefix FROM event_prefixes WHERE prefix = ?').get(prefix)
    if (found) return false
    db.prepare('INSERT INTO event_prefixes (prefix, series, created_at, owner) VALUES (?, ?, ?, ?)')
      .run(prefix, series || prefix, now(), actor || ROLE.SUPER)
    return true
  }

  function nextSeq (projectId, prefix) {
    const row = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE project_id IS ? AND prefix = ?'
    ).get(projectId || null, prefix)
    return row.next
  }

  function writeProject (i) {
    /* 记忆库以「项目名」为自然键：调用方常常只给名字，
       先按名字找一次，避免同一个项目因为一次没带 id 就多出一个节点。 */
    const named = i.name ? db.prepare('SELECT id FROM projects WHERE name = ? LIMIT 1').get(i.name) : null
    const id = i.id || (named && named.id) || i.name || randomUUID()
    db.prepare(`
      INSERT INTO projects (id, name, folder_path, created_at, status, summary, progress, main_agent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, summary = excluded.summary, progress = excluded.progress
    `).run(id, i.name || id, i.folderPath || null, i.createdAt || now(), 'active',
      i.summary || null, i.progress || null, i.mainAgentId || null)
    return { id }
  }

  function writeEvent (i) {
    if (!i.prefix) throw new Error('event 需要 prefix')
    const prefixCreated = ensurePrefix(i.prefix, i.series, ROLE.SUPER)
    const seq = nextSeq(i.project || null, i.prefix)
    const id = randomUUID()
    db.prepare(`
      INSERT INTO events (id, project_id, prefix, seq, started_at, ended_at, result, actor, summary, merged_into, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(id, i.project || null, i.prefix, seq, i.startedAt || now(), i.endedAt || null,
      i.result || null, ROLE.SUPER, i.summary || null,
      i.metadata ? JSON.stringify(i.metadata) : null)
    return { id, code: i.prefix + String(seq).padStart(3, '0'), seq, prefixCreated }
  }

  function writeProposal (i) {
    if (!PROPOSAL_RESULTS.includes(i.result)) {
      throw new Error('proposal.result 必须是 接受 / 拒绝 / 已下发任务')
    }
    const id = randomUUID()
    db.prepare('INSERT INTO proposals (id, project_id, raised_at, result) VALUES (?, ?, ?, ?)')
      .run(id, i.project || null, i.raisedAt || now(), i.result)
    return { id }
  }

  function writeDispatch (i) {
    if (!i.task) throw new Error('dispatch 需要 task')
    const id = randomUUID()
    db.prepare('INSERT INTO dispatch_log (id, project_id, occurred_at, task, to_team) VALUES (?, ?, ?, ?, ?)')
      .run(id, i.project || null, i.occurredAt || now(), i.task, i.toTeam || null)
    return { id }
  }

  function writeBehavior (i) {
    const id = randomUUID()
    db.prepare('INSERT INTO behavior_log (id, occurred_at, kind, signal, count) VALUES (?, ?, ?, ?, ?)')
      .run(id, i.occurredAt || now(), i.kind || null, i.signal || null, i.count || 1)
    return { id }
  }

  function write (input) {
    if (!enabled) return fail('记忆服务已关闭（memory.enabled=false）')
    try {
      requireSuper(input.actor)
      db.exec('BEGIN IMMEDIATE')
      let result
      switch (input.action) {
        case 'project': result = writeProject(input); break
        case 'event': result = writeEvent(input); break
        case 'proposal': result = writeProposal(input); break
        case 'dispatch': result = writeDispatch(input); break
        case 'behavior': result = writeBehavior(input); break
        default: throw new Error('未知 action：' + String(input.action))
      }
      db.exec('COMMIT')
      /* 项目 / 事件一变，项目档案的文本就变了，词向量与连边要跟着重算。
         不放在事务里：索引失败不该把已经写成功的记录一并回滚。 */
      if (input.action === 'project' || input.action === 'event') {
        try { reindex() } catch { /* 下次回忆前还会重算 */ }
        /* 时间网跟着事件时间走：改名也会改时段里的键，所以两类写入都重算 */
        try { syncTime({ weeks: 6 }) } catch { timeSyncedAt = 0 }
      }
      return ok(result)
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      return fail(err.message)
    }
  }

  function query (input) {
    requireSuper(input.actor)
    if (input.source === 'archive') {
      if (input.id) return ok(archive.read(input.id), { source: 'archive' })
      const rows = archive.list({ kind: input.kind, projectHint: input.project })
      return ok(rows, { count: rows.length, source: 'archive' })
    }
    const include = input.include || ['events', 'proposals', 'dispatch']
    const range = input.time_range || input.timeRange || {}
    const limit = Math.min(Number(input.limit) || 20, 200)
    const data = {}

    if (include.includes('events')) {
      const clauses = ['merged_into IS NULL']
      const args = []
      if (input.project) { clauses.push('project_id = ?'); args.push(input.project) }
      if (input.prefix) { clauses.push('prefix = ?'); args.push(input.prefix) }
      if (range.from) { clauses.push('started_at >= ?'); args.push(range.from) }
      if (range.to) { clauses.push('started_at <= ?'); args.push(range.to) }
      if (input.keyword) { clauses.push('summary LIKE ?'); args.push('%' + input.keyword + '%') }
      data.events = db.prepare(
        'SELECT * FROM events WHERE ' + clauses.join(' AND ') + ' ORDER BY started_at DESC LIMIT ?'
      ).all(...args, limit)
    }
    if (include.includes('proposals')) {
      data.proposals = input.project
        ? db.prepare('SELECT * FROM proposals WHERE project_id = ? ORDER BY raised_at DESC LIMIT ?').all(input.project, limit)
        : db.prepare('SELECT * FROM proposals ORDER BY raised_at DESC LIMIT ?').all(limit)
    }
    if (include.includes('dispatch')) {
      data.dispatch = input.project
        ? db.prepare('SELECT * FROM dispatch_log WHERE project_id = ? ORDER BY occurred_at DESC LIMIT ?').all(input.project, limit)
        : db.prepare('SELECT * FROM dispatch_log ORDER BY occurred_at DESC LIMIT ?').all(limit)
    }
    const count = Object.values(data).reduce((n, rows) => n + rows.length, 0)
    return ok(data, { count, truncated: (data.events || []).length === limit })
  }

  function getContext (input) {
    requireSuper(input.actor)
    const limit = Math.min(Number(input.limit) || 3, 8)
    /* 不再把全库项目 + 最近 20 条事件正文拼成「回忆文件」：
       只取权重网里最近活跃的少数节点，附权重近/远邻居与触发时间。 */
    const projects = input.project
      ? db.prepare('SELECT * FROM projects WHERE id = ? OR name = ? LIMIT 1').all(input.project, input.project)
      : db.prepare(`
          SELECT p.* FROM projects p
          LEFT JOIN (
            SELECT project_id, MAX(started_at) AS last_at FROM events
            WHERE merged_into IS NULL GROUP BY project_id
          ) e ON e.project_id = p.id
          ORDER BY COALESCE(e.last_at, p.created_at) DESC LIMIT ?
        `).all(limit)
    const hard = hardContextLib.readAll(db)
    const net = projects.map((row) => {
      const neighbours = weightNeighbours('project', row.id, DEFAULT_NEAR)
      return {
        id: row.id,
        name: row.name,
        lastTrigger: lastTriggerFor('project', row.id),
        near: neighbours.near.slice(0, 4),
        far: neighbours.far.slice(0, 4)
      }
    })
    return ok({
      hardContext: {
        blocks: hard.blocks,
        total: hard.total,
        budget: hard.budget,
        text: hardContextLib.promptText(db)
      },
      projects,
      events: [],
      net
    }, {
      note: '已由权重网接管：只给最相关节点、权重近/远邻居与最近触发时间，不再组装全量事件正文；需要细节用 memory_recall(query) 或数据表'
    })
  }

  function mergeEvents (input) {
    requireSuper(input.actor)
    const ids = input.ids || []
    if (ids.length < 2) throw new Error('mergeEvents 至少需要 2 个事件 id')
    try {
      db.exec('BEGIN IMMEDIATE')
      const stmt = db.prepare('UPDATE events SET merged_into = ? WHERE id = ?')
      for (const id of ids.slice(1)) stmt.run(ids[0], id)
      db.exec('COMMIT')
      /* 合并后事件不再参与检索：两张网与时段表都要把它们剔掉 */
      try { reindex() } catch {}
      try { syncTime({ weeks: 6 }) } catch { timeSyncedAt = 0 }
      return ok({ kept: ids[0], merged: ids.length - 1 })
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      return fail(err.message)
    }
  }

  /* ------------------------------------------------------------ 权重网 */

  /* 一个项目的「档案文本」：名字 + 摘要 + 进度 + 最近 20 条事件摘要。
     只用最近 20 条是刻意的——更早的事已经被后来的覆盖，全量会把噪音也带进向量。 */
  function buildDocs () {
    const rows = db.prepare('SELECT id, name, summary, progress FROM projects').all()
    const meta = new Map(rows.map((row) => [row.id, row]))
    const ids = new Set(rows.map((row) => row.id))
    for (const row of db.prepare(
      "SELECT DISTINCT project_id AS id FROM events WHERE project_id IS NOT NULL AND project_id <> ''"
    ).all()) ids.add(row.id)

    const recent = db.prepare(
      'SELECT summary FROM events WHERE project_id = ? AND merged_into IS NULL ORDER BY started_at DESC LIMIT 20'
    )
    const docs = []
    for (const id of ids) {
      const row = meta.get(id) || {}
      const events = recent.all(id).map((e) => e.summary || '').filter(Boolean)
      docs.push({
        id,
        name: row.name || id,
        text: [row.name || id, row.summary || '', row.progress || '', ...events].join('\n')
      })
    }
    return docs
  }

  /* 事件网的节点文本：系列名 + 前缀 + 事件内容。
     刻意不放项目名：事件网回答的是「这两件事说的是不是同一件事」，
     放了项目名会让同一个项目下的所有事件先连成一团，网就退化成项目分组。 */
  function buildEventDocs () {
    const rows = db.prepare(`
      SELECT id, prefix, summary, result
      FROM events
      WHERE merged_into IS NULL AND summary IS NOT NULL AND summary <> ''
      ORDER BY started_at DESC LIMIT ?
    `).all(EVENT_DOC_LIMIT)
    const series = new Map(db.prepare('SELECT prefix, series FROM event_prefixes').all().map((row) => [row.prefix, row.series]))
    return rows.map((row) => ({
      id: row.id,
      text: [series.get(row.prefix) || '', row.prefix || '', row.summary || ''].join('\n')
    }))
  }

  /**
   * 重建两张网：项目网 + 事件网（另有时间网，由 syncTime 单独重建）。
   * hits / cooccur 是唯一跨重建保留的量——它们记的是「这两个节点一起被回忆过几次」，
   * 一旦跟着重算清零，网就永远学不会用户的联想习惯。
   */
  function reindex () {
    const docs = buildDocs()
    const index = weights.buildIndex(docs)
    const previous = new Map()
    for (const row of db.prepare('SELECT a, b, cooccur, hits FROM project_links').all()) {
      previous.set(row.a + '\u0000' + row.b, row)
    }

    const links = weights.pairwise(index, 0.05)
    const eventIndex = weights.buildIndex(buildEventDocs())
    const previousEvents = new Map()
    for (const row of db.prepare('SELECT a, b, cooccur, hits FROM event_links').all()) {
      previousEvents.set(row.a + '\u0000' + row.b, row)
    }
    const eventLinks = weights.trimLinks(weights.pairwise(eventIndex, 0.06), 4)

    let termCount = 0
    let eventTermCount = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM project_terms')
      const insertTerm = db.prepare('INSERT INTO project_terms (project_id, term, weight) VALUES (?, ?, ?)')
      for (const [id, vec] of index.vectors) {
        const top = [...vec].sort((a, b) => b[1] - a[1]).slice(0, 120)
        for (const [term, weight] of top) { insertTerm.run(id, term, weight); termCount += 1 }
      }

      db.exec('DELETE FROM project_links')
      const insertLink = db.prepare(`
        INSERT INTO project_links (a, b, weight, lexical, cooccur, hits, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      for (const link of links) {
        /* 边的键必须是无序的：A→B 与 B→A 是同一条，
           否则共现计数会写到另一行，看起来像「权重没涨」。 */
        const [a, b] = [link.a, link.b].sort()
        const old = previous.get(a + '\u0000' + b) ||
          previous.get(b + '\u0000' + a) || {}
        const hits = old.hits || 0
        const cooccur = old.cooccur || 0
        insertLink.run(a, b, linkWeight(link.lexical, cooccur), link.lexical, cooccur, hits, now())
      }

      db.exec('DELETE FROM event_terms')
      const insertEventTerm = db.prepare('INSERT INTO event_terms (event_id, term, weight) VALUES (?, ?, ?)')
      for (const [id, vec] of eventIndex.vectors) {
        const top = [...vec].sort((a, b) => b[1] - a[1]).slice(0, 60)
        for (const [term, weight] of top) { insertEventTerm.run(id, term, weight); eventTermCount += 1 }
      }

      db.exec('DELETE FROM event_links')
      const insertEventLink = db.prepare(`
        INSERT INTO event_links (a, b, weight, lexical, cooccur, hits, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      for (const link of eventLinks) {
        const [a, b] = [link.a, link.b].sort()
        const old = previousEvents.get(a + '\u0000' + b) ||
          previousEvents.get(b + '\u0000' + a) || {}
        const hits = old.hits || 0
        const cooccur = old.cooccur || 0
        insertEventLink.run(a, b, linkWeight(link.lexical, cooccur), link.lexical, cooccur, hits, now())
      }
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
    return {
      projects: index.size,
      terms: termCount,
      links: links.length,
      events: eventIndex.size,
      eventTerms: eventTermCount,
      eventLinks: eventLinks.length
    }
  }

  /* 一起被回忆出来，就把这对项目的边加重一点。命中 2 次以内几乎不抬分，
     要反复共现才形成稳定联想——避免一次误召回把网带偏。 */
  function reinforce (ids) {
    const pairs = []
    const sorted = [...new Set(ids)].sort()
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) pairs.push([sorted[i], sorted[j]])
    }
    if (!pairs.length) return 0
    const find = db.prepare('SELECT a, b, cooccur, hits, lexical FROM project_links WHERE a = ? AND b = ?')
    const update = db.prepare('UPDATE project_links SET weight = ?, cooccur = ?, hits = ?, updated_at = ? WHERE a = ? AND b = ?')
    const insert = db.prepare(`
      INSERT INTO project_links (a, b, weight, lexical, cooccur, hits, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `)
    let touched = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [a, b] of pairs) {
        const row = find.get(a, b) || find.get(b, a)
        const hits = (row ? row.hits : 0) + 1
        const cooccur = hits / (hits + 2)
        const lexical = row ? row.lexical : 0
        const weight = linkWeight(lexical, cooccur)
        if (row) update.run(weight, cooccur, hits, now(), row.a, row.b)
        else insert.run(a, b, weight, cooccur, hits, now())
        touched += 1
      }
      db.exec('COMMIT')
    } catch {
      try { db.exec('ROLLBACK') } catch {}
      return 0
    }
    return touched
  }

  /* 事件网只加重已有连边，不凭空造边：
     同一批被回忆出来不等于两件事真的相关，凭空连边会把事件网变成「本次结果清单」。 */
  function reinforceEvents (ids) {
    const sorted = [...new Set(ids)].sort()
    if (sorted.length < 2) return 0
    const find = db.prepare('SELECT a, b, cooccur, hits, lexical FROM event_links WHERE a = ? AND b = ?')
    const update = db.prepare('UPDATE event_links SET weight = ?, cooccur = ?, hits = ?, updated_at = ? WHERE a = ? AND b = ?')
    let touched = 0
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const row = find.get(sorted[i], sorted[j]) || find.get(sorted[j], sorted[i])
        if (!row) continue
        const hits = row.hits + 1
        const cooccur = hits / (hits + 2)
        update.run(linkWeight(row.lexical, cooccur), cooccur, hits, now(), row.a, row.b)
        touched += 1
      }
    }
    return touched
  }

  /**
   * 按权重网回忆。
   *
   * 顺序：查询向量 → 项目打分（词向量 + 名字命中）→ 沿网扩散一跳 →
   * 取前 k 个项目 → 只在它们内部排事件与做法 → 按字数预算拼成一段文本。
   *
   * 关键是「先选项目、再选条目」：项目层挡掉了绝大部分无关内容，
   * 事件层再做一次精排，所以不会一次性把整库搬给模型。
   */
  /* ------------------------------------------------------------ 探子与观察
   * 探子只负责采集；整理成什么、是否入库，由超级智能体与用户决定。
   * 观察是独立的近期打算通道，绝不混进 events——事件条数会污染时段习惯与周记。
   */
  function commitScout (input = {}) {
    requireSuper(input.actor)
    const name = String(input.project || '').trim()
    if (!name) return fail('需要项目名')
    const raw = String(input.text || '').trim()
    if (!raw) return fail('摘要为空，先扫描或让超级智能体整理')
    let plan = null
    try {
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.nodes)) plan = parsed
    } catch { /* 纯文本按单项目处理 */ }
    const nodes = (plan ? plan.nodes : [{ name, summary: raw }]).slice(0, 12)
    const events = []
    if (plan) {
      for (const node of nodes) {
        const nodeName = String(node.name || '').trim() || name
        for (const item of (Array.isArray(node.events) ? node.events : []).slice(0, 8)) {
          events.push({
            project: nodeName,
            prefix: String(item.prefix || 'S').slice(0, 8),
            summary: String(item.summary || '').slice(0, 600),
            startedAt: item.startedAt || undefined
          })
        }
      }
    }
    if (!events.length) {
      events.push({ project: name, prefix: 'S', summary: '探子扫描：' + oneLine(raw, 120) })
    }
    let projects = 0
    let writtenEvents = 0
    for (const node of nodes) {
      const res = write({
        actor: ROLE.SUPER, action: 'project',
        name: String(node.name || '').trim() || name,
        summary: String(node.summary || '').slice(0, 900),
        folderPath: input.rootPath || undefined
      })
      if (res.ok) projects += 1
    }
    for (const item of events.slice(0, 40)) {
      if (!String(item.summary || '').trim()) continue
      const res = write({
        actor: ROLE.SUPER, action: 'event', project: item.project,
        prefix: item.prefix, summary: item.summary, startedAt: item.startedAt
      })
      if (res.ok) writtenEvents += 1
    }
    /* write 内部已触发 reindex + syncTime + syncPhase，三张网随之重建 */
    return ok({
      project: name, projects, events: writtenEvents, plan: Boolean(plan),
      note: '节点与事件已写入，项目网 / 事件网 / 时间网已自动重建'
    })
  }

  function writeObservation (input = {}) {
    requireSuper(input.actor)
    const text = String(input.text || '').trim().slice(0, 400)
    if (!text) return fail('观察内容为空')
    const id = randomUUID()
    const at = input.at || now()
    const weight = Math.max(0, Math.min(1, Number(input.weight) || 1))
    db.prepare(`
      INSERT INTO observations (id, at, source, kind, text, weight, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, at, String(input.source || 'manual').slice(0, 20),
      String(input.kind || 'note').slice(0, 20), text, weight,
      input.meta ? JSON.stringify(input.meta) : null)
    return ok({ id, at })
  }

  function recentObservations (atIso, hours = 24) {
    const stamp = Date.parse(atIso) || Date.now()
    const since = new Date(stamp - Math.max(1, Number(hours) || 24) * 3600000).toISOString()
    return db.prepare(`
      SELECT id, at, source, kind, text, weight, meta FROM observations
      WHERE at >= ? AND used_at IS NULL ORDER BY at DESC LIMIT 8
    `).all(since).map((row) => ({ ...row, meta: parseStats(row.meta) }))
  }

  const MEAL_HOURS = new Set([11, 12, 17, 18])
  function observationAsk (observations, hour) {
    const meal = observations.find((item) => item.kind === 'meal')
    if (meal && MEAL_HOURS.has(hour)) {
      return '你今天提到「' + oneLine(meal.text, 40) + '」，要不要提前帮你点一份？这样到饭点就能先拿到。'
    }
    const task = observations.find((item) => item.kind === 'task')
    if (task) return '你今天提到「' + oneLine(task.text, 40) + '」，要不要我先起个头？'
    return null
  }

  /* ------------------------------------------------------------ 权重网视图
   * 回忆不再靠整包文件：给权重 + 最近一次「被触发」的时间就够了。
   * 触发来源按新到旧取：回忆命中 / 时段到点 / 进程推进 / 事件发生。
   */
  function lastTriggerFor (kind, id) {
    let best = null
    const consider = (at, source, label) => {
      if (!at) return
      if (!best || String(at) > String(best.at)) best = { at: String(at), source, label }
    }
    if (kind === 'event') {
      const row = db.prepare('SELECT started_at FROM events WHERE id = ?').get(id)
      consider(row && row.started_at, '事件', '发生时间')
      return best
    }
    for (const log of db.prepare(
      'SELECT queried_at, projects FROM recall_log ORDER BY queried_at DESC LIMIT 50'
    ).all()) {
      let ids = []
      try { ids = JSON.parse(log.projects || '[]') } catch { ids = [] }
      if (ids.includes(id)) { consider(log.queried_at, '回忆', '上次被回忆命中'); break }
    }
    const slot = db.prepare(
      "SELECT last_at FROM time_slots WHERE key = ? AND kind = 'project' ORDER BY last_at DESC LIMIT 1"
    ).get(id)
    consider(slot && slot.last_at, '时段', '这个时段被触发')
    const phase = db.prepare(
      'SELECT at FROM phase_events WHERE project_id = ? ORDER BY at DESC LIMIT 1'
    ).get(id)
    consider(phase && phase.at, '进程', '上次推进')
    const event = db.prepare(
      'SELECT started_at FROM events WHERE project_id = ? AND merged_into IS NULL ORDER BY started_at DESC LIMIT 1'
    ).get(id)
    consider(event && event.started_at, '事件', '最近一条事件')
    return best
  }

  function linkTable (kind) {
    return kind === 'event' ? 'event_links' : 'project_links'
  }

  /* 一个节点的直接邻居，按权重分「近 / 远」两档 */
  function weightNeighbours (kind, id, nearThreshold = DEFAULT_NEAR) {
    const links = db.prepare(
      'SELECT a, b, weight, lexical, cooccur, hits FROM ' + linkTable(kind) +
      ' WHERE a = ? OR b = ? ORDER BY weight DESC LIMIT 60'
    ).all(id, id)
    const near = []
    const far = []
    for (const link of links) {
      const item = {
        id: link.a === id ? link.b : link.a,
        weight: link.weight,
        percent: weights.pct(link.weight),
        lexical: link.lexical,
        hits: link.hits
      }
      if (link.weight >= nearThreshold) near.push(item)
      else far.push(item)
    }
    return { near, far, threshold: nearThreshold, links }
  }

  /** 以单个项目 / 事件为中心的权重位图：近邻、远邻、两跳，以及触发时间 */
  function nodeView (input = {}) {
    const kind = input.kind === 'event' ? 'event' : 'project'
    const id = String(input.id || '')
    if (!id) return fail('nodeView 需要 id')
    const threshold = typeof input.near === 'number' ? input.near : DEFAULT_NEAR
    const table = linkTable(kind)
    const labelOf = (nodeId) => {
      if (kind === 'event') {
        const row = db.prepare('SELECT prefix, seq, summary, started_at FROM events WHERE id = ?').get(nodeId)
        return row
          ? { label: row.prefix + String(row.seq).padStart(3, '0'), meta: oneLine(row.summary, 46), at: row.started_at }
          : { label: nodeId, meta: '', at: null }
      }
      const row = db.prepare('SELECT name FROM projects WHERE id = ? OR name = ? LIMIT 1').get(nodeId, nodeId)
      const count = db.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND merged_into IS NULL').get(nodeId).n
      return { label: row ? row.name : nodeId, meta: count + ' 个事件', at: null }
    }
    const direct = new Map()
    for (const link of db.prepare(
      'SELECT a, b, weight, lexical, hits FROM ' + table + ' WHERE a = ? OR b = ? ORDER BY weight DESC LIMIT 60'
    ).all(id, id)) {
      const other = link.a === id ? link.b : link.a
      if (!direct.has(other)) direct.set(other, link)
    }
    const items = []
    for (const [other, link] of direct) {
      items.push({
        id: other, weight: link.weight, lexical: link.lexical, hits: link.hits,
        hops: 1, group: link.weight >= threshold ? 'near' : 'far'
      })
    }
    /* 直接邻居太少时补一层「经谁才连上」的两跳节点，一律算权重远 */
    if (items.length < 6) {
      const seen = new Set([id, ...direct.keys()])
      for (const [other, link] of direct) {
        if (items.length >= 10) break
        const second = db.prepare(
          'SELECT a, b, weight FROM ' + table + ' WHERE a = ? OR b = ? ORDER BY weight DESC LIMIT 5'
        ).all(other, other)
        for (const s of second) {
          const nodeId = s.a === other ? s.b : s.a
          if (seen.has(nodeId)) continue
          seen.add(nodeId)
          items.push({
            id: nodeId, weight: link.weight * s.weight, lexical: 0, hits: 0,
            hops: 2, via: other, group: 'far'
          })
          if (items.length >= 10) break
        }
      }
    }
    items.sort((a, b) => b.weight - a.weight)
    const near = items.filter((item) => item.group === 'near').slice(0, 8)
    const far = items.filter((item) => item.group === 'far').slice(0, 10)
    const shown = [...near, ...far]
    const center = labelOf(id)
    const nodes = [{
      id: 'center', label: center.label, meta: center.meta,
      group: 'center', percent: 100, weight: 1
    }]
    const edges = []
    for (const item of shown) {
      const info = labelOf(item.id)
      const nodeId = (item.group === 'near' ? 'n:' : 'f:') + item.id
      const percent = weights.pct(item.weight)
      nodes.push({
        id: nodeId,
        label: info.label,
        meta: item.hops === 2 ? '两跳 · 经 ' + labelOf(item.via).label : info.meta,
        group: item.group,
        weight: item.weight,
        percent,
        hops: item.hops,
        record: kind === 'event'
          ? { table: 'events', id: item.id }
          : { table: 'projects', id: item.id }
      })
      edges.push({
        from: 'center', to: nodeId, kind: 'weight',
        label: percent + '%', percent, weight: item.weight, hops: item.hops
      })
    }
    return ok({
      kind, id,
      center: { id, label: center.label, meta: center.meta, at: center.at },
      trigger: lastTriggerFor(kind, id),
      nodes, edges, near, far,
      stats: {
        near: near.length, far: far.length,
        direct: direct.size, threshold,
        maxPercent: shown.length ? shown[0].percent : 0
      }
    })
  }

  function recall (input = {}) {
    requireSuper(input.actor)
    const started = Date.now()
    const query = String(input.query || '').trim()
    const budget = Math.max(200, Math.min(Number(input.budget) || 900, 4000))
    const limit = Math.max(1, Math.min(Number(input.limit) || 3, 8))
    /* 阈值不能太低：只有一个「项目」这种公共词重合时余弦也有 0.1 左右，
       放进候选就会把无关项目带回来。0.15 是「至少有一段实质重合」的下限。 */
    const minScore = typeof input.minScore === 'number' ? input.minScore : 0.15
    const base = { query, projects: [], events: [], knowledge: [], text: '' }

    if (!query) {
      return ok(base, { note: 'query 为空：说一句要回顾什么，权重网才能定位', budget })
    }

    const nameRows = db.prepare('SELECT id, name FROM projects').all()
    const names = new Map(nameRows.map((row) => [row.id, row.name]))
    const total = db.prepare('SELECT COUNT(DISTINCT project_id) AS n FROM project_terms').get().n || 0

    const freq = weights.termFreq(weights.tokenize(query))
    const qvec = new Map()
    let qnorm = 0
    const dfStmt = db.prepare('SELECT COUNT(*) AS n FROM project_terms WHERE term = ?')
    for (const [term, tf] of freq) {
      const df = dfStmt.get(term).n
      if (!df) continue
      const idf = Math.log((total + 1) / (df + 1)) + 1
      const w = (1 + Math.log(tf)) * idf
      qvec.set(term, w)
      qnorm += w * w
    }
    qnorm = Math.sqrt(qnorm) || 1

    /* 词向量打分：project_terms 里存的是已归一化的 tf-idf 分量，这里只做点积。
       同时记下每个项目命中了多少「查询权重」——只靠一个「项目」这种公共词
       命中时，余弦也能到 0.16，必须靠覆盖率把它挡在门外。 */
    const lexicalScores = new Map()
    const matchedWeight = new Map()
    const termStmt = db.prepare('SELECT project_id, weight FROM project_terms WHERE term = ?')
    for (const [term, w] of qvec) {
      for (const row of termStmt.all(term)) {
        lexicalScores.set(row.project_id, (lexicalScores.get(row.project_id) || 0) + (w / qnorm) * row.weight)
        matchedWeight.set(row.project_id, (matchedWeight.get(row.project_id) || 0) + w * w)
      }
    }
    const queryWeight = [...qvec.values()].reduce((sum, w) => sum + w * w, 0) || 1
    const coverage = new Map()
    for (const [id, matched] of matchedWeight) coverage.set(id, matched / queryWeight)

    /* 名字命中直接抬分：项目名往往只有两三个词，纯 tf-idf 会被长摘要压过去 */
    const nameHits = new Set()
    for (const [id, name] of names) {
      const boost = weights.nameBoost(name, query)
      if (boost > 0) {
        nameHits.add(id)
        lexicalScores.set(id, Math.min(1, (lexicalScores.get(id) || 0) + boost))
      }
    }
    /* 当前项目是软加权，不是强制命中：问别的事时不该被它拖回来看 */
    if (input.project) {
      lexicalScores.set(input.project, Math.min(1, (lexicalScores.get(input.project) || 0) + 0.12))
    }

    const links = db.prepare('SELECT a, b, weight, hits FROM project_links').all()
    const diffused = weights.diffuse(lexicalScores, links, 0.35)

    /* 两道门：
       1. 名字命中，或命中了至少 30% 的查询权重（内容确实相关）；
       2. 否则只能靠「学出来的关联」——两个项目一起被回忆过至少两次、
          且边够强，才允许被邻居带进来。一次误召回不该形成联想。 */
    const strong = new Set()
    for (const [id, score] of diffused) {
      if (score < minScore) continue
      if (nameHits.has(id) || (coverage.get(id) || 0) >= 0.3) strong.add(id)
    }
    const allowed = new Set(strong)
    for (const link of links) {
      if (link.hits < 2 || link.weight < 0.4) continue
      if (strong.has(link.a) && !strong.has(link.b)) allowed.add(link.b)
      if (strong.has(link.b) && !strong.has(link.a)) allowed.add(link.a)
    }

    const picked = [...diffused]
      .filter(([id, score]) => score >= minScore && allowed.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => {
        const own = lexicalScores.get(id) || 0
        const direct = (coverage.get(id) || 0) >= 0.3
        return {
          id,
          name: names.get(id) || id,
          score: Number(score.toFixed(3)),
          direct: Number(own.toFixed(3)),
          /* 说清楚它为什么被选中，出问题时能一眼看出是名字、内容还是关联 */
          why: nameHits.has(id) && own >= 0.3
            ? '按名命中'
            : (direct ? '内容相近' : '关联项目')
        }
      })

    const events = []
    if (picked.length) {
      const eventStmt = db.prepare(`
        SELECT id, project_id, prefix, seq, started_at, result, summary
        FROM events WHERE project_id = ? AND merged_into IS NULL
        ORDER BY started_at DESC LIMIT 20
      `)
      for (const project of picked) {
        const rows = eventStmt.all(project.id).map((row) => {
          const text = [row.summary || '', row.prefix || '', row.result || ''].join(' ')
          const hits = weights.scoreText(qvec, qnorm, text)
          const at = Date.parse(row.started_at) || 0
          const days = at ? Math.max(0, (Date.now() - at) / 86400000) : 365
          return {
            id: row.id,
            project: project.name,
            code: row.prefix + String(row.seq).padStart(3, '0'),
            summary: row.summary || '',
            result: row.result || '',
            at: row.started_at,
            score: hits + 0.12 / (1 + days / 30),
            via: '内容命中'
          }
        })
        rows.sort((a, b) => b.score - a.score)
        events.push(...rows.slice(0, 2))
      }
      events.sort((a, b) => b.score - a.score)

      /* 事件网：强事件把它网里的邻居带出来一两个。
         只在已命中的项目内扩散——事件网独立，但回忆仍不该跳到无关项目。 */
      const pickedIds = new Set(picked.map((project) => project.id))
      const topEvents = events.slice(0, 6)
      if (topEvents.length) {
        const ids = topEvents.map((event) => event.id)
        const marks = ids.map(() => '?').join(',')
        const nets = db.prepare(
          'SELECT a, b, weight FROM event_links WHERE a IN (' + marks + ') OR b IN (' + marks + ') ORDER BY weight DESC LIMIT 60'
        ).all(...ids, ...ids)
        const byId = new Map(topEvents.map((event) => [event.id, event]))
        const have = new Set(ids)
        const extra = []
        for (const link of nets) {
          const from = byId.get(link.a) || byId.get(link.b)
          const otherId = byId.has(link.a) ? link.b : link.a
          if (!from || have.has(otherId)) continue
          const row = db.prepare(
            'SELECT id, project_id, prefix, seq, started_at, result, summary FROM events WHERE id = ? AND merged_into IS NULL'
          ).get(otherId)
          if (!row || !row.project_id || !pickedIds.has(row.project_id)) continue
          const project = picked.find((item) => item.id === row.project_id)
          const at = Date.parse(row.started_at) || 0
          const days = at ? Math.max(0, (Date.now() - at) / 86400000) : 365
          extra.push({
            id: row.id,
            project: project ? project.name : row.project_id,
            code: row.prefix + String(row.seq).padStart(3, '0'),
            summary: row.summary || '',
            result: row.result || '',
            at: row.started_at,
            score: from.score * link.weight * 0.8 + 0.12 / (1 + days / 30),
            via: '关联事件'
          })
          have.add(otherId)
          if (extra.length >= 2) break
        }
        if (extra.length) {
          events.push(...extra)
          events.sort((a, b) => b.score - a.score)
        }
      }
    }
    const eventOut = events.slice(0, 6).map((event) => ({
      id: event.id,
      project: event.project,
      code: event.code,
      summary: event.summary,
      result: event.result,
      startedAt: event.at,
      date: String(event.at || '').slice(0, 10),
      score: Number(event.score.toFixed(3)),
      via: event.via || '内容命中'
    }))

    /* 知识改走第四张网（kb_nodes）：给「哪条 + 自身权重 + 一行摘要」，
       正文不在这里拼。库越大越能看出差别 —— 回忆只负责指路，
       要细节由调用方按 id 取，一次只取真正要看的那条。 */
    const kbHits = kbIndex.search(db, {
      query,
      projectId: input.project || null,
      limit: 4
    })
    kbIndex.recordExposure(db, kbHits.entries.map((item) => item.key))
    const knowledgeOut = kbHits.entries.map((item) => ({
      key: item.key,
      id: item.id,
      kind: item.kind,
      domain: item.domain,
      title: item.title,
      digest: item.digest,
      chars: item.chars,
      weight: item.weight,
      percent: item.percent,
      why: item.why,
      source: item.source
    }))

    /* 默认只给权重 + 最近触发时间 + 近/远邻居，不再把事件与做法的正文
       拼进上下文。需要细节时显式传 mode=full。 */
    const mode = input.mode === 'full' ? 'full' : 'brief'
    /* 留痕也按权重排：问「谁让我做的」时，内容重合往往很低，
       真正管用的是「哪条责任链最重、最近」。 */
    const securityHits = securityBox.search({ query, limit: mode === 'brief' ? 2 : 4 })
    const nearThreshold = typeof input.near === 'number' ? input.near : DEFAULT_NEAR
    for (const project of picked) {
      project.lastTrigger = lastTriggerFor('project', project.id)
      project.weightPct = weights.pct(project.score)
    }
    const focus = picked[0]
    const neighbours = focus
      ? weightNeighbours('project', focus.id, nearThreshold)
      : { near: [], far: [], threshold: nearThreshold }
    const named = (nodeId) => names.get(nodeId) || nodeId
    const net = {
      focus: focus ? focus.id : null,
      threshold: nearThreshold,
      near: neighbours.near.slice(0, 6).map((item) => ({
        id: item.id, name: named(item.id), percent: item.percent, hits: item.hits
      })),
      far: neighbours.far.slice(0, 6).map((item) => ({
        id: item.id, name: named(item.id), percent: item.percent, hits: item.hits
      })),
      trigger: focus ? focus.lastTrigger : null
    }

    const lines = []
    if (mode === 'brief') {
      if (picked.length) {
        lines.push('【相关项目 · 权重网】')
        for (const project of picked) {
          const trigger = project.lastTrigger
          const when = trigger
            ? ' · 最近触发 ' + triggerTime(trigger.at) + ' ' + trigger.source
            : ''
          lines.push(`- ${project.name}（权重 ${project.score.toFixed(2)} · ${project.why}${when}）`)
        }
      }
      if (net.near.length) {
        lines.push('【权重近】')
        for (const item of net.near) lines.push(`- ${item.name} ${item.percent}%`)
      }
      if (net.far.length) {
        lines.push('【权重远】')
        for (const item of net.far) lines.push(`- ${item.name} ${item.percent}%`)
      }
    } else {
      if (picked.length) {
        lines.push('【相关项目】')
        for (const project of picked) {
          lines.push(`- ${project.name}（相关度 ${project.score.toFixed(2)} · ${project.why}）`)
        }
      }
      if (eventOut.length) {
        lines.push('【相关事件】')
        for (const event of eventOut) {
          lines.push(`- ${event.code} ${event.summary}${event.date ? `（${event.date}）` : ''}${event.via === '关联事件' ? ' · 关联' : ''}`)
        }
      }
    }

    /* 问原委时留痕是主结果，不是补充：放到最前面，免得被项目行挤掉预算。
       普通问法仍然排在项目与事件之后，只当补充线索。 */
    if (securityHits.length) {
      const block = [mode === 'brief' ? '【留痕 · 按权重】' : '【留痕 · 按权重（原委用 security_ledger trace）】']
      for (const item of securityHits) {
        const meta = `权重 ${item.weight}%` + (item.code ? ` · ${item.code}` : '')
        block.push(`- ${item.id} ${item.summary}（${meta}）`)
      }
      if (securityHits.some((item) => item.why !== '内容相近')) lines.unshift(...block)
      else lines.push(...block)
    }

    /* 知识两种模式都给，但 brief 只给两条标题。
       原因：用户问「这个怎么做」时，项目名往往一个字都不重合，
       只按项目网回忆会一条都命中不了，知识反而是唯一有用的结果。 */
    const kbShown = mode === 'brief' ? knowledgeOut.slice(0, 2) : knowledgeOut
    if (kbShown.length) {
      lines.push(mode === 'brief' ? '【相关知识】' : '【相关知识 · 只给摘要，要正文用 memory_kb get】')
      for (const item of kbShown) {
        const meta = `权重 ${item.percent}%` + (item.chars ? ` · ${item.chars} 字` : '')
        if (mode === 'brief') {
          lines.push(`- ${item.title}（${meta}）`)
        } else {
          lines.push(`- ${item.id} ${item.title}（${meta}）`)
          if (item.digest) lines.push(`  ${item.digest}`)
        }
      }
    }

    let text = ''
    for (const line of lines) {
      if (text.length + line.length + 1 > budget) break
      text += (text ? '\n' : '') + line
    }
    if (!text) text = '没有找到相关记忆。可以换一种说法，或先写一条事件再回忆。'

    try {
      db.prepare('INSERT INTO recall_log (id, queried_at, query, projects, chars) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), now(), query, JSON.stringify(picked.map((p) => p.id)), text.length)
    } catch { /* 记日志失败不影响回忆结果 */ }

    if (picked.length >= 2) reinforce(picked.map((p) => p.id))
    if (eventOut.length >= 2) reinforceEvents(eventOut.map((event) => event.id))

    return ok(
      { query, projects: picked, events: eventOut, knowledge: knowledgeOut, security: securityHits, net, mode, text },
      {
        budget,
        stats: {
          candidates: diffused.size,
          selected: picked.length,
          events: eventOut.length,
          knowledge: knowledgeOut.length,
          security: securityHits.length,
          chars: text.length,
          ms: Date.now() - started
        }
      }
    )
  }

  /* ------------------------------------------------------------ 时间网
   *
   * 两张派生表：
   *   time_slots —— 周几 + 小时 → 当时在做的事（项目名 / 事件系列），weight 是
   *                 「这个时段里做这件事的占比」，也就是界面上看到的置信度；
   *   week_docs  —— 一周一篇的时间文档，按事件时间戳汇总，用户可改成 manual。
   *
   * 时间网独立于项目网与事件网：它不参与项目打分，只回答「这个时间点通常干什么」。
   * 置信度带 90 天半衰期：最近三个月的行为比去年更能代表现在的习惯。
   */

  let timeSyncedAt = 0

  function parseStats (text) {
    try { return JSON.parse(text || '{}') } catch { return {} }
  }

  function buildWeekBody (week, from, to, rows, byProject) {
    const activeDays = new Set(rows.map((row) => dayStr(new Date(row.started_at)))).size
    const lines = [
      week + ' · ' + dayStr(from) + ' ~ ' + dayStr(to),
      rows.length + ' 条记录 · ' + byProject.length + ' 个项目 · 活跃 ' + activeDays + ' 天',
      ''
    ]
    for (const group of byProject) {
      lines.push('· ' + group.name + '（' + group.rows.length + ' 条）')
      for (const row of group.rows.slice(0, 4)) {
        lines.push('  - ' + row.prefix + String(row.seq).padStart(3, '0') + ' ' + oneLine(row.summary, 70))
      }
      if (group.rows.length > 4) lines.push('  - …另有 ' + (group.rows.length - 4) + ' 条')
    }
    const slots = new Map()
    for (const row of rows) {
      const at = new Date(row.started_at)
      const key = weekdayOf(at) + '|' + at.getHours()
      slots.set(key, (slots.get(key) || 0) + 1)
    }
    const top = [...slots].sort((a, b) => b[1] - a[1])[0]
    if (top) {
      const [weekday, hour] = top[0].split('|').map(Number)
      lines.push('')
      lines.push('最集中的时段：' + WEEKDAY_LABELS[weekday - 1] + ' ' + pad2(hour) + ' 点（' + top[1] + ' 条）')
    }
    return lines.join('\n')
  }

  /**
   * 从事件时间戳重建时间网与周记。
   * 可重复调用：时段表整体重算，周记只覆盖 auto 行，manual 行原样保留。
   */
  function syncTime (input = {}) {
    const limitWeeks = Math.max(1, Math.min(Number(input.weeks) || 12, 52))
    /* 留痕事件不进时间网：它是「被派活之后发生的事」，不是作息习惯本身。
       混进去会让「这个点通常在做什么」多出一个只在出事时才出现的系列。 */
    const rows = db.prepare(`
      SELECT id, project_id, prefix, seq, started_at, summary
      FROM events
      WHERE merged_into IS NULL AND started_at IS NOT NULL AND prefix <> 'LZ'
      ORDER BY started_at DESC LIMIT 4000
    `).all()
    const projects = new Map(db.prepare('SELECT id, name FROM projects').all().map((row) => [row.id, row.name]))
    const series = new Map(db.prepare('SELECT prefix, series FROM event_prefixes').all().map((row) => [row.prefix, row.series]))

    const buckets = new Map()
    const slotTotals = new Map()
    const weekRows = new Map()
    const nowMonday = mondayOf(Date.now()).getTime()

    for (const row of rows) {
      const at = new Date(row.started_at)
      if (Number.isNaN(at.getTime())) continue
      const weekday = weekdayOf(at)
      const hour = at.getHours()
      const key = row.project_id
        ? (projects.get(row.project_id) || row.project_id)
        : (series.get(row.prefix) || row.prefix || '未归类')
      const kind = row.project_id ? 'project' : 'series'
      const monday = mondayOf(at)
      const week = weekKeyOf(monday)
      /* 规律按「周」衰减：13 周半衰期，同一周的多条事件只贡献一份 */
      const weeksAgo = Math.max(0, Math.round((nowMonday - monday.getTime()) / (7 * 86400000)))
      const weekWeight = Math.pow(0.5, weeksAgo / TIME_HALF_LIFE_WEEKS)
      const bucketKey = weekday + '|' + hour + '|' + key + '|' + kind
      const bucket = buckets.get(bucketKey) || {
        weekday, hour, key, kind, raw: 0, weekSet: new Set(), hits: 0, lastAt: ''
      }
      if (!bucket.weekSet.has(week)) {
        bucket.weekSet.add(week)
        bucket.raw += weekWeight
        const totalKey = weekday + '|' + hour
        slotTotals.set(totalKey, (slotTotals.get(totalKey) || 0) + weekWeight)
      }
      bucket.hits += 1
      if (row.started_at > bucket.lastAt) bucket.lastAt = row.started_at
      buckets.set(bucketKey, bucket)

      const group = weekRows.get(week) || { week, from: monday, rows: [] }
      group.rows.push(row)
      weekRows.set(week, group)
    }

    let slots = 0
    let weeks = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM time_slots')
      const insertSlot = db.prepare(`
        INSERT INTO time_slots (weekday, hour, key, kind, weight, share, reliability, weeks, hits, last_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const bucket of buckets.values()) {
        const total = slotTotals.get(bucket.weekday + '|' + bucket.hour) || 1
        const share = bucket.raw / total
        const span = bucket.weekSet.size
        /* 跨周可靠度：只出现过 1 周 → 0.33，2 周 → 0.5，3 周 → 0.6，
           再久也只趋近 1。样本少时宁可给低分，不假装「100% 会做」。 */
        const reliability = span / (span + 2)
        insertSlot.run(bucket.weekday, bucket.hour, bucket.key, bucket.kind,
          Number((share * reliability).toFixed(4)),
          Number(share.toFixed(4)),
          Number(reliability.toFixed(4)),
          span, bucket.hits, bucket.lastAt || null)
        slots += 1
      }

      const upsertWeek = db.prepare(`
        INSERT INTO week_docs (week, from_at, to_at, body, stats, source, updated_at)
        VALUES (?, ?, ?, ?, ?, 'auto', ?)
        ON CONFLICT(week) DO UPDATE SET
          body = excluded.body, stats = excluded.stats, updated_at = excluded.updated_at
        WHERE week_docs.source = 'auto'
      `)
      const ordered = [...weekRows.values()].sort((a, b) => b.from - a.from).slice(0, limitWeeks)
      for (const group of ordered) {
        const to = new Date(group.from.getTime() + 6 * 86400000)
        const byName = new Map()
        for (const row of group.rows) {
          const name = row.project_id
            ? (projects.get(row.project_id) || row.project_id)
            : (series.get(row.prefix) || row.prefix || '未归类')
          const list = byName.get(name) || []
          list.push(row)
          byName.set(name, list)
        }
        const sorted = [...byName].map(([name, list]) => ({ name, rows: list }))
          .sort((a, b) => b.rows.length - a.rows.length)
        const body = buildWeekBody(group.week, group.from, to, group.rows, sorted)
        const stats = {
          events: group.rows.length,
          projects: sorted.map((item) => ({ name: item.name, count: item.rows.length })),
          days: new Set(group.rows.map((row) => dayStr(new Date(row.started_at)))).size
        }
        upsertWeek.run(group.week, dayStr(group.from), dayStr(to), body, JSON.stringify(stats), now())
        weeks += 1
      }
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
    /* 进程层的输入同样是事件序列：时段一变，阶段与迁移也要跟着重算 */
    try { syncPhase() } catch { phaseSyncedAt = 0 }
    timeSyncedAt = Date.now()
    return { events: rows.length, slots, weeks }
  }

  function ensureTimeFresh () {
    if (timeSyncedAt && Date.now() - timeSyncedAt < TIME_FRESH_MS) return
    try { syncTime({ weeks: 12 }) } catch { timeSyncedAt = Date.now() }
  }

  function timeSummary () {
    const at = new Date()
    const weekday = weekdayOf(at)
    const hour = at.getHours()
    const top = db.prepare(
      "SELECT key, weight, share, weeks, hits FROM time_slots WHERE weekday = ? AND hour = ? AND kind = 'project' ORDER BY weight DESC, hits DESC LIMIT 1"
    ).get(weekday, hour)
    return {
      slots: db.prepare('SELECT COUNT(*) AS n FROM time_slots').get().n,
      weeks: db.prepare('SELECT COUNT(*) AS n FROM week_docs').get().n,
      now: { weekday, hour, day: WEEKDAY_LABELS[weekday - 1] },
      top: top
        ? { key: top.key, weight: top.weight, share: top.share, weeks: top.weeks, hits: top.hits, percent: weights.pct(top.weight) }
        : null,
      phaseEvents: db.prepare('SELECT COUNT(*) AS n FROM phase_events').get().n,
      phaseProbs: db.prepare('SELECT COUNT(*) AS n FROM phase_probs').get().n,
      transitions: db.prepare('SELECT COUNT(*) AS n FROM phase_transitions').get().n
    }
  }

  function habitAt (input = {}) {
    ensureTimeFresh()
    const at = input.at ? new Date(input.at) : new Date()
    const weekday = weekdayOf(at)
    const hour = Number.isInteger(input.hour) ? input.hour : at.getHours()
    const rows = db.prepare(
      'SELECT key, kind, weight, share, reliability, weeks, hits, last_at FROM time_slots WHERE weekday = ? AND hour = ? ORDER BY weight DESC, hits DESC'
    ).all(weekday, hour)
    return {
      weekday,
      hour,
      day: WEEKDAY_LABELS[weekday - 1],
      /* 这个时段一共出现过多少条事件 / 覆盖多少周（周数按活动的并集近似取最大） */
      total: rows.reduce((sum, row) => sum + row.hits, 0),
      span: rows.reduce((max, row) => Math.max(max, row.weeks), 0),
      found: rows.length > 0,
      rows: rows.map((row) => ({ ...row, sharePercent: weights.pct(row.share), percent: weights.pct(row.weight) }))
    }
  }

  /**
   * 「这个时间点要不要我帮你把事做了？」
   * 权重的键是时段本身：只有同一时段在**不同周**反复出现同一件事，
   * 才算「到这个点该干这件事」。同一晚连写十条不构成习惯。
   */
  function suggestAt (input = {}) {
    const habit = habitAt(input)
    const minWeeks = Math.max(1, Number(input.minWeeks) || 3)
    const minHits = Math.max(1, Number(input.minHits) || 1)
    /* 兼容旧参数名：minShare 曾用来卡 weight，现在改叫 minWeight */
    const minWeight = typeof input.minWeight === 'number'
      ? input.minWeight
      : (typeof input.minShare === 'number' ? input.minShare : 0.4)
    /* 近期观察是独立通道：到饭点问「要不要提前点一份」不需要三周时段样本 */
    const observations = recentObservations((input.at ? new Date(input.at) : new Date()).toISOString(), 24)
    const ask = observationAsk(observations, habit.hour)
    const base = {
      weekday: habit.weekday,
      hour: habit.hour,
      day: habit.day,
      slot: habit.day + ' ' + pad2(habit.hour) + ' 点',
      percent: 0,
      weeks: 0,
      share: 0,
      reliability: 0,
      hits: 0,
      total: habit.total,
      observations,
      observationAsk: ask
    }
    const top = habit.rows.find((row) => row.kind === 'project')
    if (!top || top.weeks < minWeeks || top.hits < minHits || top.weight < minWeight) {
      if (ask) {
        return {
          ...base,
          found: true,
          via: 'observation',
          text: ask,
          prompt: '就「' + (observations.find((o) => o.kind === 'meal' || o.kind === 'task') || {}).text +
            '」给出可执行的下一步；不要自动下单、发送或改动任何文件。'
        }
      }
      return {
        ...base,
        found: false,
        reason: habit.total
          ? '这个时段还没形成跨周规律（至少 ' + minWeeks + ' 个不同的周，且时间置信过 ' + Math.round(minWeight * 100) + '%）'
          : '这个时段还没有记录',
        candidates: habit.rows.slice(0, 3)
      }
    }
    const project = db.prepare('SELECT id, name FROM projects WHERE name = ? LIMIT 1').get(top.key)
    const last = db.prepare(`
      SELECT summary, prefix, seq, started_at FROM events
      WHERE project_id IS ? AND merged_into IS NULL
      ORDER BY started_at DESC LIMIT 1
    `).get(project ? project.id : top.key)
    const summary = oneLine(last ? last.summary : '', 60)
    const text = base.slot + ' · 连续 ' + top.weeks + ' 周你都在推进「' + top.key + '」' +
      '（这个时段占 ' + top.sharePercent + '%，时间置信 ' + top.percent + '%）。要不要我先起个头？'
    const prompt = '接着「' + top.key + '」往下做：' +
      (summary ? '上次停在“' + summary + '”。' : '') +
      '把下一步完成，结束时记一条事件。'
    return {
      ...base,
      found: true,
      key: top.key,
      project: project ? project.id : top.key,
      projectName: project ? project.name : top.key,
      confidence: top.weight,
      percent: top.percent,
      weeks: top.weeks,
      share: top.share,
      sharePercent: top.sharePercent,
      reliability: top.reliability,
      hits: top.hits,
      lastAt: top.last_at || (last ? last.started_at : null),
      lastSummary: summary,
      via: ask ? 'observation' : 'time',
      text: ask || text,
      prompt: ask
        ? '就「' + (observations.find((o) => o.kind === 'meal' || o.kind === 'task') || {}).text +
          '」给出可执行的下一步；不要自动下单、发送或改动任何文件。'
        : prompt
    }
  }

  /* ------------------------------------------------------------ 进程层
   *
   * 时段回答「什么时候」，阶段回答「走到哪了」。阶段不是外部流程，
   * 是用户自己的进程：项目累计到第几条、距首次多久、隔了多久没动。
   * 三张表都从事件序列与时间戳重建，不读词向量、不改项目网 / 事件网。
   */
  let phaseSyncedAt = 0

  function syncPhase () {
    const rows = db.prepare(`
      SELECT id, project_id, prefix, started_at, summary
      FROM events
      WHERE merged_into IS NULL AND started_at IS NOT NULL
      ORDER BY started_at ASC LIMIT 8000
    `).all()
    const series = new Map(db.prepare('SELECT prefix, series FROM event_prefixes').all().map((r) => [r.prefix, r.series]))
    const byProject = new Map()
    for (const row of rows) {
      const at = new Date(row.started_at)
      if (Number.isNaN(at.getTime())) continue
      const pid = row.project_id || '__loose__'
      const list = byProject.get(pid) || []
      list.push(row)
      byProject.set(pid, list)
    }

    const nowMonday = mondayOf(Date.now()).getTime()
    const samples = []
    const transitions = new Map()
    for (const [pid, list] of byProject) {
      list.sort((a, b) => new Date(a.started_at) - new Date(b.started_at))
      const first = new Date(list[0].started_at).getTime()
      let prev = first
      let lastPhase = ''
      list.forEach((row, i) => {
        const at = new Date(row.started_at)
        const atMs = at.getTime()
        const spanDays = Math.max(0, (atMs - first) / 86400000)
        const gapDays = i === 0 ? 0 : Math.max(0, (atMs - prev) / 86400000)
        const seqNo = i + 1
        const phase = phaseOf(seqNo, spanDays, gapDays)
        const intent = intentOf(row.summary, series.get(row.prefix))
        const weekday = weekdayOf(at)
        const hour = at.getHours()
        const weeksAgo = Math.max(0, Math.round((nowMonday - mondayOf(at).getTime()) / WEEK_MS))
        const recency = Math.pow(0.5, weeksAgo / PHASE_HALF_LIFE_WEEKS)
        samples.push({
          id: row.id,
          project_id: pid === '__loose__' ? null : pid,
          at: row.started_at, weekday, hour, phase, intent,
          seq_no: seqNo, span_days: spanDays, gap_days: gapDays,
          recency, weeksAgo
        })
        if (lastPhase && lastPhase !== phase) {
          const key = lastPhase + '\u0000' + phase
          const trans = transitions.get(key) || { from: lastPhase, to: phase, hits: 0, seqs: [], days: [] }
          trans.hits += 1
          trans.seqs.push(seqNo)
          trans.days.push(spanDays)
          transitions.set(key, trans)
        }
        lastPhase = phase
        prev = atMs
      })
    }

    /* 两份统计：不限时段的阶段基线，以及精确到「周几 + 小时」的条件行 */
    const baselines = new Map()
    const slots = new Map()
    for (const s of samples) {
      const base = baselines.get(s.phase) || { total: 0, intents: new Map() }
      base.total += s.recency
      const bi = base.intents.get(s.intent) || { raw: 0, recent: 0, hits: 0, seqs: [], days: [] }
      bi.raw += s.recency
      if (s.weeksAgo <= PHASE_TREND_WEEKS) bi.recent += s.recency
      bi.hits += 1
      bi.seqs.push(s.seq_no)
      bi.days.push(s.span_days)
      base.intents.set(s.intent, bi)
      baselines.set(s.phase, base)

      const slotKey = s.phase + '|' + s.weekday + '|' + s.hour
      const slot = slots.get(slotKey) || {
        phase: s.phase, weekday: s.weekday, hour: s.hour, total: 0, intents: new Map()
      }
      slot.total += s.recency
      const si = slot.intents.get(s.intent) || { raw: 0, hits: 0 }
      si.raw += s.recency
      si.hits += 1
      slot.intents.set(s.intent, si)
      slots.set(slotKey, slot)
    }

    const stamp = now()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM phase_events')
      const insEvent = db.prepare(`
        INSERT INTO phase_events (id, project_id, at, weekday, hour, phase, intent, seq_no, span_days, gap_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const s of samples) {
        insEvent.run(s.id, s.project_id, s.at, s.weekday, s.hour, s.phase, s.intent,
          s.seq_no, Number(s.span_days.toFixed(2)), Number(s.gap_days.toFixed(2)))
      }

      db.exec('DELETE FROM phase_probs')
      const insProb = db.prepare(`
        INSERT INTO phase_probs (phase, intent, weekday, hour, weight, hits, raw, trend, onset_seq, onset_days, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const [phase, base] of baselines) {
        const recentTotal = [...base.intents.values()].reduce((n, i) => n + i.recent, 0)
        for (const [intent, item] of base.intents) {
          const probability = base.total ? item.raw / base.total : 0
          const recentShare = recentTotal ? item.recent / recentTotal : 0
          item.trend = Number((recentShare - probability).toFixed(4))
          insProb.run(phase, intent, -1, -1,
            Number(probability.toFixed(4)), item.hits, Number(item.raw.toFixed(4)),
            item.trend,
            median(item.seqs), median(item.days), stamp)
        }
      }
      for (const slot of slots.values()) {
        const base = baselines.get(slot.phase)
        if (!base) continue
        for (const [intent, item] of slot.intents) {
          const prior = base.total ? ((base.intents.get(intent) || {}).raw || 0) / base.total : 0
          /* 时段样本少时向阶段基线收缩：不拿两三条规定当「这个点必做」 */
          const weight = (item.raw + PHASE_SHRINK * prior) / (slot.total + PHASE_SHRINK)
          const bi = base.intents.get(intent) || {}
          insProb.run(slot.phase, intent, slot.weekday, slot.hour,
            Number(weight.toFixed(4)), item.hits, Number(item.raw.toFixed(4)), bi.trend || 0,
            bi.seqs ? median(bi.seqs) : null, bi.days ? median(bi.days) : null, stamp)
        }
      }

      db.exec('DELETE FROM phase_transitions')
      const insTrans = db.prepare(`
        INSERT INTO phase_transitions (from_phase, to_phase, hits, weight, avg_seq, avg_days, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      const outCount = new Map()
      for (const t of transitions.values()) outCount.set(t.from, (outCount.get(t.from) || 0) + t.hits)
      for (const t of transitions.values()) {
        const avg = (list) => list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0
        insTrans.run(t.from, t.to, t.hits,
          Number((t.hits / (outCount.get(t.from) || 1)).toFixed(4)),
          Number(avg(t.seqs).toFixed(1)), Number(avg(t.days).toFixed(1)), stamp)
      }
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
    phaseSyncedAt = Date.now()
    return {
      samples: samples.length,
      probs: db.prepare('SELECT COUNT(*) AS n FROM phase_probs').get().n,
      transitions: transitions.size
    }
  }

  function ensurePhaseFresh () {
    if (phaseSyncedAt && Date.now() - phaseSyncedAt < TIME_FRESH_MS) return
    try { syncPhase() } catch { phaseSyncedAt = Date.now() }
  }

  /**
   * 「这个阶段，用户有多大概率在做什么？可以问他了吗？」
   * 条件 = 阶段（主轴）+ 时段（软加权）。概率来自历史轨迹，
   * trend 是近 4 周占比与长期占比之差，能反映习惯正在怎么变。
   */
  function phaseAt (input = {}) {
    ensurePhaseFresh()
    const at = input.at ? new Date(input.at) : new Date()
    const weekday = weekdayOf(at)
    const hour = at.getHours()
    let project = input.project ? String(input.project) : ''
    if (!project) {
      const last = db.prepare(
        'SELECT project_id FROM phase_events WHERE project_id IS NOT NULL ORDER BY at DESC LIMIT 1'
      ).get()
      project = last ? last.project_id : ''
    }
    const scope = project
      ? db.prepare('SELECT * FROM phase_events WHERE project_id = ? ORDER BY at DESC LIMIT 1').get(project)
      : db.prepare('SELECT * FROM phase_events ORDER BY at DESC LIMIT 1').get()
    const base = {
      at: at.toISOString(), weekday, hour,
      day: WEEKDAY_LABELS[weekday - 1],
      slot: WEEKDAY_LABELS[weekday - 1] + ' ' + pad2(hour) + ' 点',
      project: project || null,
      phase: scope ? scope.phase : null,
      found: false, intents: [], transition: null
    }
    if (!scope) return { ...base, reason: '还没有事件轨迹，谈不上进程阶段' }
    const phase = scope.phase
    let rows = db.prepare(`
      SELECT intent, weight, hits, trend, onset_seq, onset_days
      FROM phase_probs WHERE phase = ? AND weekday = ? AND hour = ? ORDER BY weight DESC
    `).all(phase, weekday, hour)
    let scoped = true
    if (!rows.length || rows.reduce((n, r) => n + r.hits, 0) < 3) {
      rows = db.prepare(`
        SELECT intent, weight, hits, trend, onset_seq, onset_days
        FROM phase_probs WHERE phase = ? AND weekday = -1 AND hour = -1 ORDER BY weight DESC
      `).all(phase)
      scoped = false
    }
    const sampleHits = rows.reduce((n, r) => n + r.hits, 0)
    if (!rows.length || sampleHits < 3) {
      return { ...base, phase, found: false, scoped, sampleHits,
        reason: '这个阶段的样本还不够，先不打扰', intents: rows.slice(0, 3) }
    }

    /* 时段是软条件：有证据就加权，没有也不阻断阶段判断 */
    const timeRow = db.prepare(
      'SELECT weight, key FROM time_slots WHERE weekday = ? AND hour = ? ORDER BY weight DESC LIMIT 1'
    ).get(weekday, hour)
    const timeWeight = timeRow ? timeRow.weight : 0
    const timeBoost = 0.6 + 0.4 * timeWeight
    const intents = rows.slice(0, 4).map((row) => ({
      intent: row.intent,
      probability: Number(row.weight.toFixed(4)),
      percent: weights.pct(row.weight * timeBoost),
      trend: row.trend,
      drift: row.trend > 0.08 ? '正在变多' : (row.trend < -0.08 ? '正在变少' : '稳定'),
      onsetSeq: row.onset_seq,
      onsetDays: row.onset_days,
      hits: row.hits
    }))
    const trans = db.prepare(`
      SELECT to_phase, weight, avg_seq, avg_days, hits FROM phase_transitions
      WHERE from_phase = ? ORDER BY weight DESC, hits DESC LIMIT 1
    `).get(phase)
    const incoming = db.prepare(`
      SELECT from_phase, weight, avg_seq, avg_days, hits FROM phase_transitions
      WHERE to_phase = ? ORDER BY weight DESC, hits DESC LIMIT 1
    `).get(phase)
    const transition = trans ? {
      to: trans.to_phase,
      weight: trans.weight,
      percent: weights.pct(trans.weight),
      avgSeq: trans.avg_seq,
      avgDays: trans.avg_days,
      hits: trans.hits,
      text: '项目平均走到第 ' + trans.avg_seq + ' 条 / 第 ' + trans.avg_days + ' 天，会进入「' + trans.to_phase + '」'
    } : null
    /* 「项目到什么时候开始需要这类工作」：回看是怎么进入当前阶段的 */
    const arrival = incoming ? {
      from: incoming.from_phase,
      weight: incoming.weight,
      percent: weights.pct(incoming.weight),
      avgSeq: incoming.avg_seq,
      avgDays: incoming.avg_days,
      text: '项目平均走到第 ' + incoming.avg_seq + ' 条 / 第 ' + incoming.avg_days +
        ' 天，从「' + incoming.from_phase + '」进入「' + phase + '」'
    } : null

    const named = project
      ? (db.prepare('SELECT name FROM projects WHERE id = ? OR name = ? LIMIT 1').get(project, project) || {}).name || project
      : '当前工作'
    const top = intents[0]
    const probabilityPct = Math.round(top.probability * 100)
    const driftText = top.drift === '稳定' ? '' : '，近几周' + top.drift
    const onsetText = top.onsetSeq
      ? '；这类指令通常从项目第 ' + Math.round(top.onsetSeq) + ' 条 / 第 ' + Math.round(top.onsetDays) + ' 天开始'
      : ''
    const timeText = timeWeight > 0
      ? '，当前时段也支持（时间置信 ' + weights.pct(timeWeight) + '%）'
      : ''
    const ask = '「' + named + '」已经走到「' + phase + '」阶段，这个阶段 ' + probabilityPct +
      '% 是「' + top.intent + '」类指令' + driftText + onsetText + timeText + '。要不要我先按这个方向起个头？'
    const last = project ? db.prepare(
      'SELECT summary FROM events WHERE project_id = ? AND merged_into IS NULL ORDER BY started_at DESC LIMIT 1'
    ).get(project) : null
    const prompt = '接着「' + named + '」当前阶段往下做：这个阶段常见的是「' + top.intent + '」类工作。' +
      (last && last.summary ? '上次停在“' + oneLine(last.summary, 60) + '”。' : '') +
      '把下一步完成，结束时记一条事件。'

    return {
      ...base,
      found: true,
      scoped,
      sampleHits,
      projectName: named,
      timeWeight,
      intents,
      transition,
      arrival,
      ask,
      prompt,
      lastSummary: last ? oneLine(last.summary, 60) : ''
    }
  }

  function time (input = {}) {
    requireSuper(input.actor)
    const action = String(input.action || 'suggest')
    if (action === 'sync') return ok(syncTime(input))
    ensureTimeFresh()
    if (action === 'weeks') {
      const limit = Math.max(1, Math.min(Number(input.limit) || 12, 52))
      const rows = db.prepare(
        'SELECT week, from_at, to_at, stats, source, updated_at FROM week_docs ORDER BY week DESC LIMIT ?'
      ).all(limit)
      return ok(rows.map((row) => ({ ...row, stats: parseStats(row.stats) })), { count: rows.length })
    }
    if (action === 'week') {
      const week = String(input.week || '')
      const row = week ? db.prepare('SELECT * FROM week_docs WHERE week = ?').get(week) : null
      if (!row) return fail('没有这一周的时间文档：' + (week || '（未指定周）'))
      return ok({ ...row, stats: parseStats(row.stats) })
    }
    if (action === 'habit') return ok(habitAt(input))
    if (action === 'suggest') return ok(suggestAt(input))
    if (action === 'observe') return writeObservation(input)
    if (action === 'observations') {
      return ok(recentObservations(input.at || new Date().toISOString(), Number(input.hours) || 24))
    }
    if (action === 'phase') return ok(phaseAt(input))
    if (action === 'phases') {
      ensurePhaseFresh()
      const probs = db.prepare(`
        SELECT phase, intent, weight, hits, trend, onset_seq, onset_days
        FROM phase_probs WHERE weekday = -1 AND hour = -1 ORDER BY phase, weight DESC
      `).all()
      const transitions = db.prepare(
        'SELECT * FROM phase_transitions ORDER BY weight DESC, hits DESC'
      ).all()
      const events = db.prepare('SELECT COUNT(*) AS n FROM phase_events').get().n
      return ok({ probs, transitions, events })
    }
    if (action === 'summary') return ok(timeSummary())
    return fail('未知 time action：' + action)
  }

  /* 网的体检：节点、连边、最强的几对关系，给控制台与调试用。
     三张网一起报，但各报各的：项目是项目、事件是事件、时间是时间。 */
  function net () {
    const nodes = db.prepare(`
      SELECT p.id, p.name, COUNT(e.id) AS events
      FROM projects p LEFT JOIN events e ON e.project_id = p.id AND e.merged_into IS NULL
      GROUP BY p.id ORDER BY events DESC
    `).all()
    const known = new Set(nodes.map((row) => row.id))
    for (const row of db.prepare(
      "SELECT DISTINCT project_id AS id FROM events WHERE project_id IS NOT NULL AND project_id <> ''"
    ).all()) {
      if (known.has(row.id)) continue
      const count = db.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND merged_into IS NULL').get(row.id).n
      nodes.push({ id: row.id, name: row.id, events: count })
      known.add(row.id)
    }
    const links = db.prepare(
      'SELECT a, b, weight, lexical, cooccur, hits, updated_at FROM project_links ORDER BY weight DESC'
    ).all()
    const avg = links.length ? links.reduce((sum, row) => sum + row.weight, 0) / links.length : 0

    const events = db.prepare(`
      SELECT e.id, e.project_id, e.prefix, e.seq, e.started_at, e.summary
      FROM events e WHERE e.merged_into IS NULL
      ORDER BY e.started_at DESC LIMIT 120
    `).all().map((row) => ({
      id: row.id,
      project: row.project_id || '',
      code: row.prefix + String(row.seq).padStart(3, '0'),
      summary: oneLine(row.summary, 80),
      at: row.started_at
    }))
    const eventLinks = db.prepare(
      'SELECT a, b, weight, lexical, cooccur, hits FROM event_links ORDER BY weight DESC LIMIT 300'
    ).all()
    const avgEvent = eventLinks.length
      ? eventLinks.reduce((sum, row) => sum + row.weight, 0) / eventLinks.length
      : 0

    ensureTimeFresh()
    const time = timeSummary()
    const recallCount = db.prepare('SELECT COUNT(*) AS n FROM recall_log').get().n
    return ok({
      nodes,
      links,
      events,
      eventLinks,
      time,
      stats: {
        nodes: nodes.length,
        links: links.length,
        avgWeight: Number(avg.toFixed(3)),
        events: events.length,
        eventLinks: eventLinks.length,
        avgEventWeight: Number(avgEvent.toFixed(3)),
        timeSlots: time.slots,
        weeks: time.weeks,
        phaseEvents: time.phaseEvents,
        phaseProbs: time.phaseProbs,
        transitions: time.transitions,
        recalls: recallCount
      }
    })
  }

  /**
   * 把界面上的项目镜像进记忆库。
   * 以项目名为 id（记忆库一贯用名字当自然键），这样历史事件里记的 project
   * 能直接对上节点；已经有同名节点的，沿用它的 id，不再造第二个。
   */
  function syncProjects (input = {}) {
    if (input.actor !== ROLE.SUPER && input.actor !== ROLE.EXECUTOR) {
      return fail('权限拒绝：同步项目只接受内部调用')
    }
    const list = Array.isArray(input.projects) ? input.projects : []
    let added = 0
    let updated = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of list) {
        const name = String(item.name || '').trim()
        if (!name) continue
        const found = db.prepare('SELECT id FROM projects WHERE name = ? LIMIT 1').get(name)
        if (found) {
          db.prepare('UPDATE projects SET folder_path = COALESCE(?, folder_path), summary = COALESCE(?, summary) WHERE id = ?')
            .run(item.rootPath || null, item.summary || null, found.id)
          updated += 1
        } else {
          db.prepare(`
            INSERT INTO projects (id, name, folder_path, created_at, status, summary, progress, main_agent_id)
            VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL)
          `).run(name, name, item.rootPath || null, now(), item.summary || null)
          added += 1
        }
      }
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      return fail(err.message)
    }
    if (added || updated) {
      try { reindex() } catch { /* 下次回忆前还会重算 */ }
      try { syncTime({ weeks: 6 }) } catch { timeSyncedAt = 0 }
    }
    return ok({ added, updated, total: list.length })
  }

  function knowledge (input) {
    const role = input.actor || ROLE.EXTERNAL
    const external = role === ROLE.EXTERNAL || input.external === true
    if (external && input.action !== 'query' && !allowExternalWrite) {
      return fail('外部直连默认只读；写入需 MEMORY_ALLOW_WRITE=1')
    }
    if (input.action === 'upsert') {
      const id = input.id || randomUUID()
      db.prepare(`
        INSERT INTO knowledge (id, domain, kind, body, applies_when, status) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          domain = excluded.domain, kind = excluded.kind, body = excluded.body,
          applies_when = excluded.applies_when, status = excluded.status
      `).run(id, input.domain || null, input.kind || null, input.body || '',
        input.appliesWhen || null, input.status || '可用')
      return ok({ id })
    }
    if (input.action === 'query') {
      const clauses = []
      const args = []
      if (input.domain) { clauses.push('domain = ?'); args.push(input.domain) }
      if (input.kind) { clauses.push('kind = ?'); args.push(input.kind) }
      if (input.status) { clauses.push('status = ?'); args.push(input.status) }
      const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
      const limit = Math.min(Number(input.limit) || 20, 200)
      const rows = db.prepare('SELECT * FROM knowledge ' + where + ' LIMIT ?').all(...args, limit)
      return ok(rows, { count: rows.length })
    }
    if (input.action === 'expire') {
      const r = db.prepare('DELETE FROM knowledge WHERE id = ?').run(input.id)
      return ok({ deleted: r.changes })
    }
    return fail('未知 knowledge action：' + String(input.action))
  }

  function compress () {
    return ok({ status: 'not_implemented' }, { note: '日 / 周 / 月压缩规则未定（D5）' })
  }

  /* ------------------------------------------------------------ 知识网
   *
   * 第四张网。与 knowledge() 的分工：
   *   knowledge() —— 全局知识的原始读写（id / domain / body），不做权重；
   *   kb()        —— 索引与权重层：有哪些、哪条该先看、被用过几次、要花多少字。
   *
   * 正文永远不从这里返回：它属于文件（项目知识库）或 knowledge 表。
   * 这一层只负责「指路」，不负责「搬运」—— 搬运一次就是一次上下文开销。
   */
  function kb (input = {}) {
    const action = String(input.action || 'digest')
    const projectId = input.project || input.projectId || null
    const at = Number.isFinite(input.now) ? input.now : Date.now()

    if (action === 'sync') {
      const result = kbIndex.sync(db, input.entries || [], { rebuildLinks: input.rebuildLinks !== false })
      const touched = result.added + result.updated + result.removed
      return ok(result, { note: touched ? `索引已更新 ${touched} 条` : '索引已是最新' })
    }

    if (action === 'digest') {
      const data = kbIndex.digest(db, { projectId, now: at })
      return ok({ ...data, project: projectId })
    }

    if (action === 'search') {
      const result = kbIndex.search(db, {
        query: input.query || input.text || '',
        projectId,
        kind: input.kind,
        domain: input.domain,
        limit: input.limit,
        includeGlobal: input.includeGlobal !== false,
        minScore: input.minScore,
        now: at
      })
      /* 曝光在这里记：检索出来就算一次「被看见」。
         与 opens 分开，才能算出「搜出来但没人打开」的比例 —— 那是权重能自动沉底的关键。 */
      kbIndex.recordExposure(db, result.entries.map((item) => item.key))
      kbIndex.logHit(db, {
        query: input.query || input.text,
        keys: result.entries.map((item) => item.key),
        chars: result.entries.reduce((sum, item) => sum + String(item.digest || '').length, 0),
        ms: result.ms
      })
      return ok(result, {
        scanned: result.scanned,
        note: result.entries.length
          ? `给了 ${result.entries.length} 条摘要（共 ${result.scanned} 条在库）；要正文再按 id 取`
          : '没有匹配的知识'
      })
    }

    if (action === 'get') {
      const key = kbKeyOf(input, projectId)
      if (!key) return fail('需要 key，或 id + project')
      const row = db.prepare("SELECT * FROM kb_nodes WHERE key = ? AND status = '可用'").get(key)
      if (!row) return fail('索引里没有这条：' + key)
      kbIndex.recordOpen(db, key)
      const self = kbIndex.weightOf(row, at)
      return ok({
        key,
        id: row.entry_id,
        source: row.source,
        projectId: row.project_id,
        kind: row.kind,
        domain: row.domain,
        title: row.title,
        digest: row.digest,
        chars: row.chars,
        weight: Number(self.weight.toFixed(3)),
        percent: weights.pct(self.weight),
        opens: row.opens + 1,
        uses: row.uses,
        freshness: self.freshness,
        precision: self.precision,
        ageDays: self.ageDays
      })
    }

    if (action === 'use') {
      const keys = Array.isArray(input.keys) ? input.keys : (input.key ? [input.key] : [])
      if (!keys.length) return fail('需要 keys')
      return ok({ used: kbIndex.recordUse(db, keys) })
    }

    if (action === 'feedback') {
      const key = kbKeyOf(input, projectId)
      if (!key) return fail('需要 key，或 id + project')
      const useful = input.useful !== false
      const changed = kbIndex.recordFeedback(db, key, useful)
      if (!changed) return fail('索引里没有这条：' + key)
      const row = db.prepare('SELECT * FROM kb_nodes WHERE key = ?').get(key)
      return ok({
        key,
        useful,
        weight: Number(kbIndex.weightOf(row, at).weight.toFixed(3)),
        percent: weights.pct(kbIndex.weightOf(row, at).weight)
      }, { note: useful ? '已记为有用' : '已记为没用，下次同等相关时会往后排' })
    }

    /* 星图用：节点大小 = 自身权重，连线 = 「说的是同一件事」 */
    if (action === 'map') {
      const rows = db.prepare("SELECT * FROM kb_nodes WHERE status = '可用'").all()
      const live = new Set(rows.map((row) => row.key))
      const nodes = rows.map((row) => {
        const self = kbIndex.weightOf(row, at)
        return {
          key: row.key,
          id: row.entry_id,
          source: row.source,
          projectId: row.project_id,
          kind: row.kind,
          domain: row.domain,
          title: row.title,
          weight: Number(self.weight.toFixed(3)),
          percent: weights.pct(self.weight),
          /* 权重由四项乘出来，拆开展示才能解释「为什么它排这里」 */
          trust: self.trust,
          freshness: self.freshness,
          precision: self.precision,
          completeness: self.completeness,
          opens: row.opens,
          exposures: row.exposures,
          uses: row.uses,
          good: row.good,
          bad: row.bad,
          chars: row.chars,
          ageDays: self.ageDays,
          lastOpenAt: row.last_open_at,
          lastUseAt: row.last_use_at
        }
      })
      const edges = db.prepare('SELECT a, b, weight FROM kb_links ORDER BY weight DESC').all()
        .filter((link) => live.has(link.a) && live.has(link.b))
        .map((link) => ({ a: link.a, b: link.b, weight: Number(link.weight.toFixed(3)), percent: weights.pct(link.weight) }))
      const totalChars = rows.reduce((sum, row) => sum + (row.chars || 0), 0)
      return ok({
        nodes,
        edges,
        stats: {
          total: nodes.length,
          edges: edges.length,
          chars: totalChars,
          avgWeight: nodes.length ? Number((nodes.reduce((s, n) => s + n.weight, 0) / nodes.length).toFixed(3)) : 0,
          neverOpened: rows.filter((row) => !row.opens).length,
          global: rows.filter((row) => row.source === 'global').length
        }
      })
    }

    /* 索引重建：只清本作用域，别的项目不受影响 */
    if (action === 'reset') {
      const scope = projectId ? ['kb:?', projectId] : null
      if (scope) {
        const keys = db.prepare('SELECT key FROM kb_nodes WHERE project_id = ?').all(projectId).map((row) => row.key)
        for (const key of keys) {
          db.prepare('DELETE FROM kb_nodes WHERE key = ?').run(key)
          db.prepare('DELETE FROM kb_terms WHERE key = ?').run(key)
        }
        return ok({ removed: keys.length })
      }
      db.prepare('DELETE FROM kb_nodes').run()
      db.prepare('DELETE FROM kb_terms').run()
      db.prepare('DELETE FROM kb_links').run()
      return ok({ removed: 'all' })
    }

    return fail('未知知识网 action：' + action)
  }

  function kbKeyOf (input, projectId) {
    if (input.key) return String(input.key)
    const id = String(input.id || '').trim()
    if (!id) return ''
    const source = input.source === 'global' || (!projectId && !input.source) ? 'global' : 'kb'
    return kbIndex.keyOf(source, projectId, id)
  }

  const safe = (fn) => (input = {}) => {
    if (!enabled && fn !== compress && fn !== knowledge) {
      return fail('记忆服务已关闭（memory.enabled=false）')
    }
    try { return fn(input) } catch (err) { return fail(err.message) }
  }

  /* 硬性上下文由用户直接在控制台编辑；这里只暴露同一套读写，保证预算与校验一致 */
  const hardContext = {
    read () { return ok(hardContextLib.readAll(db)) },
    save (input = {}) {
      try { return ok(hardContextLib.save(db, input.slot, input.body)) } catch (err) { return fail(err.message) }
    },
    prompt () {
      return ok({ text: hardContextLib.promptText(db), ...hardContextLib.summary(db) })
    }
  }

  /* 安全边界：闸门 + 留痕账本。放在收件箱之前创建，是因为收件箱入库时
     要把「像派活的消息」交给它做候选 —— 先有闸门，才谈得上拦。 */
  const securityBox = createSecurityStore(db)

  /* 收件箱：渠道管理 + 入库 + 查询。适配器只负责「拿到」，这里负责「记下」。
     记忆服务关掉时仍然可用 —— 用户要能管自己的渠道，哪怕暂时不想让记忆参与。 */
  const inboxBox = createInbox(db, {
    onAlert: (msg) => securityBox.considerAssignment(msg)
  })

  function inbox (input = {}) {
    const action = String(input.action || '')
    const args = input
    switch (action) {
      case 'channels': return ok(inboxBox.listChannels())
      case 'channel': {
        const channel = inboxBox.getChannel(args.id)
        return channel ? ok(channel) : fail('没有这个渠道')
      }
      case 'saveChannel': {
        const saved = inboxBox.saveChannel(args)
        return saved.ok ? ok(saved.channel) : fail(saved.error)
      }
      case 'removeChannel': {
        const removed = inboxBox.removeChannel(args.id)
        return removed.ok ? ok(removed) : fail(removed.error)
      }
      case 'enable': {
        const changed = inboxBox.setEnabled(args.id, args.enabled !== false)
        return changed.ok ? ok(changed.channel) : fail(changed.error)
      }
      case 'status':
        return ok(inboxBox.setStatus(args.id, args.status, args.error))
      case 'cursor':
        return ok(inboxBox.saveCursor(args.id, args.cursor))
      case 'ingest': {
        const channel = args.channel && args.channel.id
          ? args.channel
          : inboxBox.getChannel(args.id)
        if (!channel) return fail('没有这个渠道')
        return ok(inboxBox.ingest({ ...channel, config: channel.config || {} }, args.messages || args.raws || []))
      }
      case 'messages': return ok(inboxBox.listMessages(args))
      case 'threads': return ok(inboxBox.listThreads(args))
      case 'stats': return ok({ ...inboxBox.stats(), security: securityBox.stats() })
      /* 首流那一小块：开了哪些渠道、外面有几条在等、怎么取全文。
         和常驻上下文里「消息接入（实时）」是同一段文本，不从两处各写一遍。 */
      case 'brief': return ok(inboxBrief.lines(db))
      case 'handled': return ok(inboxBox.markHandled(args.ids))
      case 'clear': return ok(inboxBox.clearMessages(args))
      default: return fail('未知的收件箱动作：' + (action || '(空)'))
    }
  }

  /**
   * 安全边界：
   *   screen  —— 出站前过一道，干净就放行，命中的开一道闸门等人点头；
   *   decide  —— 只有界面能调用（主进程校验 sender），agent 调不到；
   *   task*   —— 留痕；账本只追加，导出带链头。
   */
  function security (input = {}) {
    const action = String(input.action || '')
    const args = input
    try {
      switch (action) {
        case 'screen': {
          /* screen 的 ok 永远为 true：闸门「开没开」是 verdict 的事，
             不是调用失败。否则工具层会把「需要确认」当成错误抛出去。 */
          const result = securityBox.screen(args)
          return ok({ ...result, ok: true })
        }
        case 'approve': {
          const result = securityBox.approve(args)
          return result.ok ? ok(result) : fail(result.error)
        }
        case 'deny': {
          const result = securityBox.deny(args)
          return result.ok ? ok(result) : fail(result.error)
        }
        case 'pending': return ok({ gates: securityBox.pending() })
        case 'gates': return ok({ gates: securityBox.gates(args) })
        case 'tasks': return ok({ tasks: securityBox.tasks(args) })
        case 'openTask': {
          const result = securityBox.openTask(args)
          return result.ok ? ok(result) : fail(result.error)
        }
        case 'closeTask': {
          const result = securityBox.closeTask(args)
          if (!result.ok) return fail(result.error)
          /* 归档即压缩：账本一条不动，事件网里多一行。压不成也不该让归档失败，
             留痕已经写进链里了，下次 digest 还能补。 */
          let digest = null
          try {
            digest = securityBox.digestTask({ id: args.id })
            if (digest && digest.ok && !digest.already) reindex()
          } catch (err) {
            digest = { ok: false, error: err.message }
          }
          return ok({ ...result, digest })
        }
        case 'digest': {
          const result = securityBox.digestTask(args)
          if (!result.ok) return fail(result.error)
          if (!result.already) {
            try { reindex() } catch { /* 下次回忆前还会重算 */ }
          }
          return ok(result)
        }
        case 'trace': {
          const result = securityBox.trace(args)
          return result.ok ? ok(result) : fail(result.error)
        }
        case 'search': return ok({ hits: securityBox.search(args) })
        case 'brief': return ok(securityBox.brief())
        case 'dropTask': {
          const result = securityBox.dropTask(args)
          return result.ok ? ok(result) : fail(result.error)
        }
        case 'append': {
          if (!args.taskId && !args.title) return fail('要么给 taskId，要么给一句标题')
          return ok(securityBox.append({
            kind: args.kind || 'action',
            taskId: args.taskId || null,
            actor: args.actor === 'user' ? 'user' : 'agent',
            title: args.title || '',
            body: args.body || (args.text ? { text: args.text } : {}),
            refs: args.refs || {}
          }))
        }
        case 'ledger': return ok({ entries: securityBox.ledger(args), verify: securityBox.verify() })
        case 'verify': return ok(securityBox.verify())
        case 'export': {
          const result = securityBox.exportTask(args)
          return result.ok ? ok(result) : fail(result.error)
        }
        case 'stats': return ok(securityBox.stats())
        default: return fail('未知的安全动作：' + (action || '(空)'))
      }
    } catch (err) {
      return fail(err.message)
    }
  }

  /* --------------------------------------------------------- 消息原文 / 浓缩
     原文表只追加：即使同一个 id 再写，也不会覆盖历史正文。
     浓缩表可以更新权重与内容，但通过 message_id 永远指回原文。 */
  function nextMessageCode () {
    const a = db.prepare("SELECT MAX(CAST(SUBSTR(code, 2) AS INTEGER)) AS n FROM message_records WHERE code LIKE 'M%'").get()
    const b = db.prepare("SELECT MAX(CAST(SUBSTR(code, 2) AS INTEGER)) AS n FROM message_digests WHERE code LIKE 'M%'").get()
    return 'M' + String(Math.max(Number(a.n) || 0, Number(b.n) || 0) + 1).padStart(6, '0')
  }

  function oneLineOf (text, max = 120) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim()
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
  }

  function relationTokens (text) {
    const clean = String(text || '').toLowerCase().replace(/\s+/g, '')
    const set = new Set()
    for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2))
    return set
  }

  function relationScore (a, b) {
    const left = relationTokens(a)
    const right = relationTokens(b)
    if (!left.size || !right.size) return 0
    let hit = 0
    for (const token of left) if (right.has(token)) hit += 1
    return Math.max(0, Math.min(1, hit / Math.max(1, left.size + right.size - hit)))
  }

  function timeWeightOf (iso) {
    const at = Date.parse(iso || '')
    if (!at) return 0
    const days = Math.max(0, (Date.now() - at) / 86400000)
    return Math.max(0, Math.min(1, Math.exp(-days / 30)))
  }

  /* 动态维度不写死：模型/主智能体给出什么因子，就登记什么因子。 */
  function registerDimensions (dimensions, at = now()) {
    if (!dimensions || typeof dimensions !== 'object') return
    for (const [name, value] of Object.entries(dimensions)) {
      const key = String(name || '').trim()
      if (!key) continue
      db.prepare(`
        INSERT INTO weight_dimensions (name, first_seen, last_seen, uses, meta)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(name) DO UPDATE SET
          last_seen = excluded.last_seen,
          uses = uses + 1,
          meta = excluded.meta
      `).run(key, at, at, JSON.stringify({ lastValue: value }))
    }
  }

  function weightDimensions (input = {}) {
    requireSuper(input.actor)
    const rows = db.prepare('SELECT * FROM weight_dimensions ORDER BY uses DESC, last_seen DESC LIMIT ?')
      .all(Math.max(1, Math.min(Number(input.limit) || 100, 200)))
    return ok(rows)
  }

  function messageGraph (input = {}) {
    requireSuper(input.actor)
    const limit = Math.max(1, Math.min(Number(input.limit) || 80, 200))
    const nodes = db.prepare(`
      SELECT code, message_id, one_line, digest, created_at, total_weight, relation_weight, edge_weight
      FROM (
        SELECT d.*, COALESCE((SELECT SUM(e.relation_weight) FROM weight_edges e
          WHERE e.from_code = d.code OR e.to_code = d.code), 0) AS edge_weight
        FROM message_digests d WHERE d.code IS NOT NULL
      )
      ORDER BY created_at DESC LIMIT ?
    `).all(limit)
    const codes = new Set(nodes.map((node) => node.code))
    const edges = db.prepare('SELECT from_code, to_code, relation_weight, reason FROM weight_edges ORDER BY relation_weight DESC LIMIT 500')
      .all()
      .filter((edge) => codes.has(edge.from_code) && codes.has(edge.to_code))
    return ok({ nodes, edges })
  }

  function writeMessageRecord (input = {}) {
    requireSuper(input.actor)
    const id = String(input.id || randomUUID())
    const text = String(input.text == null ? '' : input.text)
    if (!text.trim()) throw new Error('message_record 需要 text')
    const existing = db.prepare('SELECT * FROM message_records WHERE id = ?').get(id)
    if (existing) return ok(existing, { inserted: false })
    const code = String(input.code || '').trim() || nextMessageCode()
    const info = db.prepare(`
      INSERT INTO message_records
        (id, code, conversation_id, thread, role, sender, created_at, text, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      code,
      input.conversationId || input.conversation_id || null,
      input.thread || null,
      input.role || 'user',
      input.sender || null,
      input.createdAt || input.created_at || now(),
      text,
      input.meta && typeof input.meta === 'object' ? JSON.stringify(input.meta) : null
    )
    const row = db.prepare('SELECT * FROM message_records WHERE id = ?').get(id)
    return ok(row, { inserted: info.changes > 0 })
  }

  function writeMessageDigest (input = {}) {
    requireSuper(input.actor)
    const messageId = String(input.messageId || input.message_id || '').trim()
    const digest = String(input.digest || '').trim()
    if (!messageId || !digest) throw new Error('message_digest 需要 messageId 和 digest')
    const record = db.prepare('SELECT * FROM message_records WHERE id = ?').get(messageId)
    if (!record) throw new Error('message_digest 找不到对应原文：' + messageId)
    const code = String(input.code || record.code || '').trim() || nextMessageCode()
    const at = now()
    const createdAt = input.createdAt || record.created_at || at
    const conversationId = input.conversationId || input.conversation_id || record.conversation_id || null
    const eventWeight = typeof input.eventWeight === 'number' ? input.eventWeight : 1
    const previousRows = db.prepare(`
      SELECT code, digest FROM message_digests
      WHERE conversation_id = ?
        AND message_id <> ?
        AND code IS NOT NULL
      ORDER BY created_at DESC LIMIT 6
    `).all(conversationId, messageId)
    const autoRelation = previousRows.reduce((max, row) => Math.max(max, relationScore(digest, row.digest)), 0)
    const relationWeight = typeof input.relationWeight === 'number' ? input.relationWeight : autoRelation
    const dynamicWeight = typeof input.dynamicWeight === 'number'
      ? input.dynamicWeight
      : (typeof input.weight === 'number' ? input.weight : null)
    const totalWeight = typeof input.totalWeight === 'number' ? input.totalWeight : dynamicWeight
    const dimensions = input.dimensions && typeof input.dimensions === 'object'
      ? input.dimensions
      : (input.dimensionsJson && typeof input.dimensionsJson === 'object' ? input.dimensionsJson : {})
    const weightJson = {
      time: timeWeightOf(createdAt),
      event: eventWeight,
      relation: relationWeight,
      dynamic: dynamicWeight,
      ...(input.weightJson && typeof input.weightJson === 'object' ? input.weightJson : {}),
      ...dimensions
    }
    registerDimensions(dimensions, at)
    const oneLine = input.oneLine || input.one_line || oneLineOf(digest, 120)
    const timeText = input.timeText || input.time_text || createdAt
    const metadata = input.metadata && typeof input.metadata === 'object'
      ? JSON.stringify(input.metadata)
      : (input.metadata || null)

    db.prepare(`
      INSERT INTO message_digests
        (id, code, message_id, conversation_id, project_id, digest, one_line, time_text,
         weight, weight_json, time_weight, event_weight, relation_weight, dynamic_weight,
         total_weight, dimensions_json, scorer, status, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        code = excluded.code,
        conversation_id = excluded.conversation_id,
        project_id = excluded.project_id,
        digest = excluded.digest,
        one_line = excluded.one_line,
        time_text = excluded.time_text,
        weight = excluded.weight,
        weight_json = excluded.weight_json,
        time_weight = excluded.time_weight,
        event_weight = excluded.event_weight,
        relation_weight = excluded.relation_weight,
        dynamic_weight = excluded.dynamic_weight,
        total_weight = excluded.total_weight,
        dimensions_json = excluded.dimensions_json,
        scorer = excluded.scorer,
        status = excluded.status,
        updated_at = excluded.updated_at,
        metadata = excluded.metadata
    `).run(
      String(input.id || randomUUID()),
      code,
      messageId,
      conversationId,
      input.projectId || input.project_id || null,
      digest,
      oneLine,
      timeText,
      typeof input.weight === 'number' ? input.weight : dynamicWeight,
      JSON.stringify(weightJson),
      timeWeightOf(createdAt),
      eventWeight,
      relationWeight,
      dynamicWeight,
      totalWeight,
      JSON.stringify(dimensions),
      input.scorer || null,
      input.status || 'active',
      createdAt,
      at,
      metadata
    )
    /* 编号也要回写到原文表，右键用气泡编号即可回查。 */
    if (!record.code) db.prepare('UPDATE message_records SET code = ? WHERE id = ?').run(code, messageId)

    /* 与最近同会话的少量事件建立动态关联边。 */
    for (const row of previousRows) {
      const relation = relationScore(digest, row.digest)
      if (relation <= 0) continue
      const edgeId = `${code}->${row.code}`
      const edge = db.prepare('SELECT relation_weight FROM weight_edges WHERE from_code = ? AND to_code = ?').get(code, row.code)
      const next = edge ? Math.max(edge.relation_weight, relation) : relation
      db.prepare(`
        INSERT INTO weight_edges (id, from_code, to_code, relation_weight, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(from_code, to_code) DO UPDATE SET
          relation_weight = excluded.relation_weight,
          updated_at = excluded.updated_at
      `).run(edgeId, code, row.code, next, '同会话内容关联', at, at)
    }

    const result = db.prepare('SELECT * FROM message_digests WHERE message_id = ?').get(messageId)
    return ok(result)
  }

  function getMessageRecord (input = {}) {
    requireSuper(input.actor)
    const id = String(input.id || input.messageId || input.message_id || '').trim()
    const code = String(input.code || '').trim()
    if (!id && !code) throw new Error('getMessage 需要 id 或 code')
    let row
    if (id) row = db.prepare('SELECT * FROM message_records WHERE id = ?').get(id)
    if (!row && code) {
      const digest = db.prepare('SELECT message_id FROM message_digests WHERE code = ?').get(code)
      const messageId = digest ? digest.message_id : ''
      if (messageId) row = db.prepare('SELECT * FROM message_records WHERE id = ?').get(messageId)
      if (!row) row = db.prepare('SELECT * FROM message_records WHERE code = ?').get(code)
    }
    return row ? ok(row) : fail('没有这条消息原文：' + (id || code))
  }

  function queryMessageDigests (input = {}) {
    requireSuper(input.actor)
    const clauses = []
    const args = []
    if (input.conversationId || input.conversation_id) {
      clauses.push('conversation_id = ?')
      args.push(input.conversationId || input.conversation_id)
    }
    if (input.projectId || input.project_id) {
      clauses.push('project_id = ?')
      args.push(input.projectId || input.project_id)
    }
    if (input.messageId || input.message_id) {
      clauses.push('message_id = ?')
      args.push(input.messageId || input.message_id)
    }
    if (input.code) {
      clauses.push('code = ?')
      args.push(input.code)
    }
    if (input.keyword) {
      clauses.push('(digest LIKE ? OR one_line LIKE ?)')
      args.push('%' + input.keyword + '%', '%' + input.keyword + '%')
    }
    if (input.from) {
      clauses.push('created_at >= ?')
      args.push(input.from)
    }
    if (input.to) {
      clauses.push('created_at <= ?')
      args.push(input.to)
    }
    if (input.status) {
      clauses.push('status = ?')
      args.push(input.status)
    }
    const limit = Math.max(1, Math.min(Number(input.limit) || 20, 100))
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
    const rows = db.prepare(
      'SELECT d.*, COALESCE((SELECT SUM(e.relation_weight) FROM weight_edges e WHERE e.from_code = d.code OR e.to_code = d.code), 0) AS edge_weight ' +
      'FROM message_digests d' + where +
      ' ORDER BY COALESCE(d.total_weight, -1) DESC, edge_weight DESC, d.created_at DESC LIMIT ?'
    ).all(...args, limit)
    return ok(rows)
  }

  function adjustMessageWeight (input = {}) {
    requireSuper(input.actor)
    const code = String(input.code || '').trim()
    if (!code) throw new Error('adjustMessageWeight 需要 code')
    const row = db.prepare('SELECT * FROM message_digests WHERE code = ?').get(code)
    if (!row) throw new Error('没有这个浓缩编号：' + code)
    let previous = {}
    try { previous = row.dimensions_json ? JSON.parse(row.dimensions_json) : {} } catch { previous = {} }
    const dimensions = input.dimensions && typeof input.dimensions === 'object'
      ? { ...previous, ...input.dimensions }
      : (input.dimensionsJson && typeof input.dimensionsJson === 'object' ? { ...previous, ...input.dimensionsJson } : previous)
    registerDimensions(dimensions)
    const dynamic = typeof input.dynamicWeight === 'number' ? input.dynamicWeight : row.dynamic_weight
    const total = typeof input.totalWeight === 'number' ? input.totalWeight : dynamic
    db.prepare(`
      UPDATE message_digests SET
        dynamic_weight = ?, total_weight = ?, dimensions_json = ?, weight_json = ?,
        scorer = ?, updated_at = ?
      WHERE code = ?
    `).run(
      dynamic,
      total,
      JSON.stringify(dimensions),
      JSON.stringify({ ...(row.weight_json ? JSON.parse(row.weight_json) : {}), ...dimensions, dynamic }),
      input.scorer || row.scorer || 'main',
      now(),
      code
    )
    return ok(db.prepare('SELECT * FROM message_digests WHERE code = ?').get(code))
  }

  function weightEdges (input = {}) {
    requireSuper(input.actor)
    const code = String(input.code || '').trim()
    if (!code) throw new Error('weightEdges 需要 code')
    const rows = db.prepare(`
      SELECT * FROM weight_edges
      WHERE from_code = ? OR to_code = ?
      ORDER BY relation_weight DESC LIMIT ?
    `).all(code, code, Math.max(1, Math.min(Number(input.limit) || 20, 100)))
    return ok(rows)
  }

  /* 团队工具箱：项目、进度、团队结构、知识索引与决策独立于会话保存。 */
  function writeTeamToolbox (input = {}) {
    requireSuper(input.actor)
    const projects = Array.isArray(input.projects) ? input.projects : [input]
    const at = now()
    for (const project of projects) {
      const projectId = String(project.projectId || project.project_id || project.id || '').trim()
      if (!projectId) continue
      db.prepare(`
        INSERT INTO team_toolboxes
          (project_id, name, root_path, progress, plan, task_json, takeover_from,
           team_json, knowledge_json, decisions_json, plan_updated_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          progress = excluded.progress,
          plan = excluded.plan,
          task_json = excluded.task_json,
          takeover_from = excluded.takeover_from,
          team_json = excluded.team_json,
          knowledge_json = excluded.knowledge_json,
          decisions_json = excluded.decisions_json,
          plan_updated_at = excluded.plan_updated_at,
          updated_at = excluded.updated_at
      `).run(
        projectId,
        project.name || null,
        project.rootPath || project.root_path || null,
        project.progress || null,
        project.plan || null,
        JSON.stringify(project.task || project.taskBrief || project.taskJson || {}),
        project.takeoverFrom || project.takeover_from || null,
        JSON.stringify(project.team || project.teamJson || {}),
        JSON.stringify(project.knowledge || project.knowledgeJson || []),
        JSON.stringify(project.decisions || project.decisionsJson || []),
        at,
        at
      )
    }
    return ok({ count: projects.length })
  }

  function findTeamToolbox (input = {}) {
    requireSuper(input.actor)
    const rootPath = String(input.rootPath || input.root_path || '').trim()
    if (!rootPath) return fail('findTeamToolbox 需要 rootPath')
    const row = db.prepare('SELECT * FROM team_toolboxes WHERE root_path = ? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1').get(rootPath)
    return ok(row || null)
  }

  function getTeamToolbox (input = {}) {
    requireSuper(input.actor)
    const projectId = String(input.projectId || input.project_id || input.id || '').trim()
    if (!projectId) throw new Error('getTeamToolbox 需要 projectId')
    const row = db.prepare('SELECT * FROM team_toolboxes WHERE project_id = ?').get(projectId)
    return row ? ok(row) : fail('没有这个团队工具箱：' + projectId)
  }

  return {
    write: safe(write),
    query: safe(query),
    getContext: safe(getContext),
    mergeEvents: safe(mergeEvents),
    knowledge: safe(knowledge),
    writeMessageRecord: safe(writeMessageRecord),
    writeMessageDigest: safe(writeMessageDigest),
    getMessageRecord: safe(getMessageRecord),
    queryMessageDigests: safe(queryMessageDigests),
    adjustMessageWeight: safe(adjustMessageWeight),
    weightEdges: safe(weightEdges),
    weightDimensions: safe(weightDimensions),
    messageGraph: safe(messageGraph),
    writeTeamToolbox: safe(writeTeamToolbox),
    findTeamToolbox: safe(findTeamToolbox),
    getTeamToolbox: safe(getTeamToolbox),
    kb: safe(kb),
    inbox,
    security,
    compress: safe(compress),
    recall: safe(recall),
    nodeView: safe(nodeView),
    commitScout: safe(commitScout),
    time: safe(time),
    reindex () {
      try { return ok(reindex()) } catch (err) { return fail(err.message) }
    },
    syncTime () {
      try { return ok(syncTime({ weeks: 52 })) } catch (err) { return fail(err.message) }
    },
    net: safe(net),
    syncProjects: safe(syncProjects),
    hardContext,
    archive,
    db,
    file,
    close
  }
}

module.exports = { createMemoryStore, ROLE }
