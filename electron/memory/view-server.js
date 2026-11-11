#!/usr/bin/env node
'use strict'

/**
 * 星界 · 记忆库控制台服务（数据只读 · 硬性上下文可编辑 · 可本地 / 云端部署）
 *
 * 本地启动：
 *   npm run memory:view                        → http://127.0.0.1:45872
 * 云端部署：
 *   MEMORY_VIEW_HOST=0.0.0.0 MEMORY_VIEW_TOKEN=<令牌> MEMORY_CONFIG_DIR=/data \
 *     node electron/memory/view-server.js
 *
 * 环境变量：
 *   MEMORY_CONFIG_DIR    数据目录，默认仓库 config/
 *   MEMORY_VIEW_HOST     监听地址，默认 127.0.0.1（云端设 0.0.0.0）
 *   MEMORY_VIEW_PORT     端口，默认 45872（避开已有 bridge 的 45871）
 *   MEMORY_VIEW_TOKEN    可选；设置后 /api/* 需 Authorization: Bearer <令牌>
 *   MEMORY_VIEW_WRITE    0 = 关闭唯一写接口（硬性上下文保存）
 *   MEMORY_ENABLED       0 = 服务标记关闭，页面仍可只读查看
 *
 * 安全边界：
 *   - 记录表只读：除 POST /api/hard-context 外只接受 GET；所有表查询均为 SELECT；
 *   - 唯一写入口只改 hard_context 四块，slot 走白名单，正文有长度上限；
 *   - 对外监听（非 127.0.0.1）且未设令牌时，写接口自动关闭，避免裸奔；
 *   - 封存原文只能按 archive_manifest 的 id 回查，不接受任意路径；
 *   - 静态资源不含数据，/health 供健康检查。
 *   - 云端务必设置 MEMORY_VIEW_TOKEN，并套 HTTPS 反向代理。
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { createMemoryService, ROLE } = require('./index.js')
const weights = require('./weights.js')
const { TABLES, tableLabel, tableHint, columnLabels, columnLabel, valuesFor } = require('./labels.js')
const hardContext = require('./hard-context.js')

const CONFIG_DIR = process.env.MEMORY_CONFIG_DIR || path.join(__dirname, '..', '..', 'config')
const HOST = process.env.MEMORY_VIEW_HOST || '127.0.0.1'
const PORT = Number(process.env.MEMORY_VIEW_PORT || 45872)
const TOKEN = process.env.MEMORY_VIEW_TOKEN || ''
const ENABLED = process.env.MEMORY_ENABLED !== '0'
const VERSION = '0.4.0'
const VIEW_DIR = path.join(__dirname, 'view')
const MAX_CONTENT = 200000
const MAX_BUNDLE = 60000
const MAX_BODY = 65536
const LOOPBACK = /^(127\.0\.0\.1|localhost|::1)$/i.test(HOST)
/* 记录表永远只读；唯一写接口是硬性上下文。对外监听又没令牌时，写入自动关闭 */
const WRITE_ENABLED = ENABLED && process.env.MEMORY_VIEW_WRITE !== '0' && (LOOPBACK || Boolean(TOKEN))

const ALLOWED = new Set(TABLES.map((t) => t.name))

// 每张表的「正文」字段：决定「原文」标签页显示什么
const CONTENT_FIELDS = {
  projects: [['summary', '项目简介'], ['progress', '开发进度']],
  events: [['summary', '事件内容'], ['metadata', '附加数据']],
  proposals: [['result', '结果']],
  dispatch_log: [['task', '派发任务']],
  behavior_log: [['kind', '行为类型'], ['signal', '偏好信号']],
  knowledge: [['body', '知识正文'], ['applies_when', '适用条件']],
  event_prefixes: [['series', '系列名称']],
  diary_digest: [['body', '摘要正文']],
  archive_manifest: [['content', '封存原文']]
}

const service = createMemoryService({ configDir: CONFIG_DIR, enabled: ENABLED })
const db = service.db

function countOf (name) {
  return db.prepare('SELECT COUNT(*) AS n FROM ' + name).get().n
}

function columnsOf (name) {
  return db.prepare('PRAGMA table_info(' + name + ')').all().map((c) => c.name)
}

function labelOf (name) {
  return tableLabel(name)
}

function eventTrend () {
  const rows = db.prepare(
    "SELECT substr(started_at, 1, 10) AS date, COUNT(*) AS count FROM events WHERE merged_into IS NULL GROUP BY substr(started_at, 1, 10)"
  ).all()
  const map = Object.fromEntries(rows.map((r) => [r.date, r.count]))
  const out = []
  for (let i = 13; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    out.push({ date, count: map[date] || 0 })
  }
  return out
}

function snapshot () {
  const tables = TABLES.map((t) => ({ name: t.name, label: t.label, hint: t.hint || '', count: countOf(t.name) }))
  return {
    ok: true,
    file: service.file,
    enabled: ENABLED,
    host: HOST,
    port: PORT,
    version: VERSION,
    auth: Boolean(TOKEN),
    writeEnabled: WRITE_ENABLED,
    hardContext: hardContext.summary(db),
    at: new Date().toISOString(),
    tables,
    total: tables.reduce((n, t) => n + t.count, 0),
    eventByPrefix: db.prepare(
      'SELECT prefix, COUNT(*) AS count FROM events WHERE merged_into IS NULL GROUP BY prefix ORDER BY count DESC'
    ).all(),
    eventTrend: eventTrend(),
    recentEvents: db.prepare(
      'SELECT id, project_id, prefix, seq, summary, started_at FROM events WHERE merged_into IS NULL ORDER BY started_at DESC LIMIT 8'
    ).all()
  }
}

function tableData (name, limit, offset, q) {
  if (!ALLOWED.has(name)) throw new Error('不允许访问的表：' + name)
  const max = Math.min(Math.max(Number(limit) || 50, 1), 500)
  const skip = Math.max(Number(offset) || 0, 0)
  const columns = columnsOf(name)
  const where = q ? columns.map((c) => 'CAST(' + c + ' AS TEXT) LIKE ?').join(' OR ') : ''
  const args = q ? columns.map(() => '%' + q + '%') : []
  const total = q
    ? db.prepare('SELECT COUNT(*) AS n FROM ' + name + ' WHERE ' + where).get(...args).n
    : countOf(name)
  const rows = db.prepare(
    'SELECT * FROM ' + name + (where ? ' WHERE ' + where : '') + ' ORDER BY rowid DESC LIMIT ? OFFSET ?'
  ).all(...args, max, skip)
  return {
    ok: true,
    name,
    label: labelOf(name),
    hint: tableHint(name),
    columns,
    columnLabels: columnLabels(name),
    valueLabels: valuesFor(name),
    rows,
    total,
    offset: skip,
    limit: max,
    truncated: skip + rows.length < total
  }
}

function globalSearch (q) {
  if (!q) return { ok: true, results: [], q }
  const needle = '%' + q + '%'
  const lower = q.toLowerCase()
  const results = []
  for (const t of TABLES) {
    const cols = columnsOf(t.name)
    const where = cols.map((c) => 'CAST(' + c + ' AS TEXT) LIKE ?').join(' OR ')
    const rows = db.prepare('SELECT * FROM ' + t.name + ' WHERE ' + where + ' LIMIT 3')
      .all(...cols.map(() => needle))
    for (const row of rows) {
      const matched = cols.filter((c) => String(row[c] === null ? '' : row[c]).toLowerCase().includes(lower)).slice(0, 2)
      results.push({
        table: t.name,
        label: t.label,
        id: row.id,
        text: matched.map((c) => columnLabel(t.name, c) + '：' + row[c]).join(' · ') || '（匹配）'
      })
      if (results.length >= 12) break
    }
    if (results.length >= 12) break
  }
  return { ok: true, results, q }
}

/* ---------- 记录完整内容：一次调用取回全文 + 关联 + 封存原文 + 上下文包 ---------- */

function relatedFor (name, row) {
  // G7：知识库与项目文件无任何关联，刻意不查关联
  if (name === 'knowledge') return []
  const pid = row.project_id || (name === 'projects' ? row.id : row.project_hint)
  const out = []
  if (pid) {
    for (const r of db.prepare(
      'SELECT id, prefix, seq, summary, started_at FROM events WHERE project_id = ? AND merged_into IS NULL ORDER BY started_at DESC LIMIT 6'
    ).all(pid)) {
      out.push({ table: 'events', label: tableLabel('events'), id: r.id, text: r.prefix + String(r.seq).padStart(3, '0') + ' · ' + (r.summary || '（无摘要）') })
    }
    for (const r of db.prepare(
      'SELECT id, result, raised_at FROM proposals WHERE project_id = ? ORDER BY raised_at DESC LIMIT 3'
    ).all(pid)) {
      out.push({ table: 'proposals', label: tableLabel('proposals'), id: r.id, text: '提议 ' + r.result })
    }
    for (const r of db.prepare(
      'SELECT id, task, to_team FROM dispatch_log WHERE project_id = ? ORDER BY occurred_at DESC LIMIT 3'
    ).all(pid)) {
      out.push({ table: 'dispatch_log', label: tableLabel('dispatch_log'), id: r.id, text: '派发 ' + (r.task || '') + (r.to_team ? ' → ' + r.to_team : '') })
    }
    const p = db.prepare('SELECT id, name, summary FROM projects WHERE id = ?').get(pid)
    if (p && p.id !== row.id) out.push({ table: 'projects', label: tableLabel('projects'), id: p.id, text: '项目 ' + p.name })
  }
  return out
}

function archiveFor (name, row) {
  if (name !== 'archive_manifest') return null
  try {
    const a = service.archive.read(row.id)
    const content = String(a.content || '').slice(0, MAX_CONTENT)
    return {
      id: a.id,
      path: a.path,
      ext: path.extname(a.path || ''),
      size: Buffer.byteLength(content, 'utf8'),
      lines: content.split('\n').length,
      truncated: String(a.content || '').length > MAX_CONTENT,
      content
    }
  } catch (err) {
    return { error: err.message, content: '' }
  }
}

function contentFor (name, row, archiveInfo) {
  if (archiveInfo) {
    return { format: 'text', title: '封存原文', text: archiveInfo.content, source: 'archive_manifest' }
  }
  const fields = CONTENT_FIELDS[name] || []
  const chunks = []
  for (const [key, title] of fields) {
    const v = row[key]
    if (v === null || v === undefined || v === '') continue
    chunks.push('## ' + title + '\n\n' + String(v))
  }
  if (!chunks.length) {
    return { format: 'text', title: '字段内容', text: Object.entries(row)
      .filter(([, v]) => v !== null && v !== '')
      .map(([k, v]) => columnLabel(name, k) + '：' + v).join('\n'), source: name }
  }
  return { format: 'markdown', title: '记录正文', text: chunks.join('\n\n'), source: name }
}

function bundleFor (name, row, content, related, archiveInfo) {
  const L = []
  L.push('# 星界记忆 · 上下文包')
  L.push('')
  L.push('- 生成时间：' + new Date().toISOString())
  L.push('- 数据表：' + labelOf(name) + '（' + name + '）')
  L.push('- 记录 ID：' + (row.id || '—'))
  L.push('')
  L.push('## 记录字段')
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === '') continue
    L.push('- ' + columnLabel(name, k) + '（' + k + '）：' + String(v))
  }
  if (content.text && content.text.trim()) {
    L.push('')
    L.push('## 具体内容')
    L.push(content.text)
  }
  if (related.length) {
    L.push('')
    L.push('## 关联记录（同一项目）')
    for (const r of related) L.push('- [' + labelOf(r.table) + '] ' + r.text)
  }
  if (archiveInfo && archiveInfo.content) {
    L.push('')
    L.push('## 封存文件原文')
    L.push(archiveInfo.content)
  }
  L.push('')
  L.push('---')
  L.push('说明：本包由一次 GET /api/record 聚合生成，不落盘；用完即从上下文清除（G4）。')
  if (name === 'knowledge') L.push('知识库是纯工具，与项目文件、事件记录无任何关联（G7），故不提供关联记录。')
  return L.join('\n').slice(0, MAX_BUNDLE)
}

function recordData (name, id) {
  if (!ALLOWED.has(name)) throw new Error('不允许访问的表：' + name)
  if (!id) throw new Error('记录预览需要 id')
  const row = db.prepare('SELECT * FROM ' + name + ' WHERE id = ?').get(String(id))
  if (!row) throw new Error('记录不存在：' + id)
  const archiveInfo = archiveFor(name, row)
  const content = contentFor(name, row, archiveInfo)
  const related = relatedFor(name, row)
  const bundle = bundleFor(name, row, content, related, archiveInfo)
  return {
    ok: true,
    table: name,
    label: labelOf(name),
    hint: tableHint(name),
    id: row.id,
    columns: columnsOf(name),
    columnLabels: columnLabels(name),
    fieldLabels: columnLabels(name),
    valueLabels: valuesFor(name),
    row,
    content,
    related,
    archive: archiveInfo,
    bundle: { text: bundle, chars: bundle.length, truncated: bundle.length >= MAX_BUNDLE }
  }
}

function archiveData (id) {
  if (!id) throw new Error('封存回查需要 id')
  const a = service.archive.read(String(id))
  const content = String(a.content || '').slice(0, MAX_CONTENT)
  return {
    ok: true,
    id: a.id,
    path: a.path,
    ext: path.extname(a.path || ''),
    size: Buffer.byteLength(content, 'utf8'),
    lines: content.split('\n').length,
    truncated: String(a.content || '').length > MAX_CONTENT,
    content
  }
}

/* ---------- 硬性上下文：查看 / 编辑 ---------- */

function hardContextData () {
  return { ok: true, ...hardContext.readAll(db), writeEnabled: WRITE_ENABLED, at: new Date().toISOString() }
}

function saveHardContext (slot, body) {
  if (!WRITE_ENABLED) {
    throw new Error('当前部署未开启写入：检查记忆库开关、MEMORY_VIEW_WRITE=0，以及对外监听是否设置了 MEMORY_VIEW_TOKEN')
  }
  const saved = hardContext.save(db, slot, body)
  return { ok: true, ...saved, writeEnabled: true, at: new Date().toISOString() }
}

/* ---------- 星图：真实记录之间的关系 ---------- */

/* 星图显示上限：星体再多也只用来看关系，不是全量浏览器。
   超过上限的部分不取、不画、不进 DOM，避免记录变多后拖慢旋转与命中。 */
const MAP_LIMITS = Object.freeze({
  projects: 6,
  eventsPerProject: 6,
  looseEvents: 6,
  knowledge: 12,
  maxNodes: 220
})

function starMapData () {
  const hard = hardContext.readAll(db)
  const count = (sql) => db.prepare(sql).get().n
  const allProjects = db.prepare('SELECT id, name, status, summary, created_at FROM projects ORDER BY created_at').all()
  const eventCount = count('SELECT COUNT(*) AS n FROM events WHERE merged_into IS NULL')
  const knowledgeCount = count('SELECT COUNT(*) AS n FROM knowledge')
  const nodes = []
  const edges = []
  const shown = { projects: 0, events: 0, knowledge: 0, looseEvents: 0 }
  const projectNode = new Map()
  const eventNode = new Map()
  const addNode = (node) => { nodes.push(node); return node.id }
  const addEdge = (from, to, kind = 'solid', label = '', extra = null) =>
    edges.push({ from, to, kind, label, ...(extra || {}) })

  addNode({ id: 'super', kind: 'super', label: '超级智能体', meta: '常驻', weight: 40 })
  addNode({
    id: 'hard',
    kind: 'hard',
    label: '硬性上下文',
    meta: `${hard.filled}/${hard.blocks.length} 块 · ${hard.total}/${hard.budget} 字`,
    weight: 22,
    action: { type: 'view', view: 'hard' }
  })
  addNode({
    id: 'master',
    kind: 'master',
    label: '项目总文档',
    meta: `${allProjects.length} 个项目索引`,
    weight: 24,
    action: { type: 'view', view: 'table', table: 'projects' }
  })
  addNode({
    id: 'diary',
    kind: 'diary',
    label: '派发日记',
    meta: `${count('SELECT COUNT(*) AS n FROM dispatch_log')} 条 · 独立于项目记忆`,
    weight: 18,
    action: { type: 'view', view: 'table', table: 'dispatch_log' }
  })
  addNode({
    id: 'events',
    kind: 'events',
    label: '事件记录',
    meta: `${eventCount} 条事件`,
    weight: 20,
    action: { type: 'view', view: 'table', table: 'events' }
  })
  addNode({
    id: 'archive',
    kind: 'archive',
    label: '封存清单',
    meta: `${count('SELECT COUNT(*) AS n FROM archive_manifest')} 份旧文件 · 只读回查`,
    weight: 15,
    action: { type: 'view', view: 'table', table: 'archive_manifest' }
  })
  addNode({
    id: 'behavior',
    kind: 'behavior',
    label: '行为日记',
    meta: `${count('SELECT COUNT(*) AS n FROM behavior_log')} 条习性信号`,
    weight: 15,
    action: { type: 'view', view: 'table', table: 'behavior_log' }
  })
  addNode({
    id: 'proposals',
    kind: 'proposals',
    label: '提议',
    meta: `${count('SELECT COUNT(*) AS n FROM proposals')} 条结果`,
    weight: 15,
    action: { type: 'view', view: 'table', table: 'proposals' }
  })
  addNode({
    id: 'knowledge',
    kind: 'knowledge',
    label: '知识库',
    meta: `${knowledgeCount} 条 · 独立体系`,
    weight: 22,
    isolated: true,
    action: { type: 'view', view: 'table', table: 'knowledge' }
  })

  /* 第四张网：项目知识库的条目本身也有权重（用得多升、光搜不用降、放久了降）。
     独立成节点，点进去是知识网自己的星图 —— 不跟项目网混在一起，
     因为知识回答的是「怎么做」，项目回答的是「做过什么」。 */
  const kbCounts = db.prepare(
    "SELECT COUNT(*) AS total, AVG(NULLIF(chars, 0)) AS avg_chars FROM kb_nodes WHERE status = '可用'"
  ).get()
  const kbEdges = db.prepare('SELECT COUNT(*) AS n FROM kb_links').get().n
  addNode({
    id: 'kbnet',
    kind: 'kbnet',
    label: '知识网',
    meta: `${kbCounts.total || 0} 条知识 · ${kbEdges} 条近似 · 按权重排`,
    weight: 24,
    action: { type: 'view', view: 'kb' }
  })

  addEdge('super', 'hard', 'solid', '每轮常驻')
  addEdge('super', 'master', 'solid', '持有索引')
  addEdge('super', 'diary', 'solid', '自己的行为流水')
  addEdge('super', 'events', 'dashed', '写入时间 + 结果')
  addEdge('super', 'proposals', 'solid', '提议结果')
  addEdge('super', 'behavior', 'solid', '习性信号')
  addEdge('super', 'kbnet', 'dashed', '按权重取用')
  addEdge('master', 'archive', 'dashed', '旧文件封存')

  const perProject = new Map(
    db.prepare(
      'SELECT project_id, COUNT(*) AS n FROM events WHERE merged_into IS NULL GROUP BY project_id'
    ).all().map((r) => [String(r.project_id), r.n])
  )
  const statusLabel = { active: '进行中', paused: '已暂停', done: '已完成', archived: '已归档' }

  /* 项目按最近一次事件排序，取前 N 个；长期没动静的项目不该占满星图 */
  const lastEventAt = new Map(
    db.prepare(
      'SELECT project_id, MAX(started_at) AS last FROM events WHERE merged_into IS NULL GROUP BY project_id'
    ).all().map((r) => [String(r.project_id), String(r.last || '')])
  )
  const ranked = allProjects.slice().sort((a, b) => {
    const ka = lastEventAt.get(String(a.id)) || String(a.created_at || '')
    const kb = lastEventAt.get(String(b.id)) || String(b.created_at || '')
    return ka < kb ? 1 : ka > kb ? -1 : 0
  })
  const projects = ranked.slice(0, MAP_LIMITS.projects)

  for (const p of projects) {
    const pid = 'p:' + p.id
    const n = perProject.get(String(p.id)) || 0
    addNode({
      id: pid,
      kind: 'project',
      label: p.name,
      meta: `${n} 个事件 · ${statusLabel[p.status] || p.status || '进行中'}`,
      weight: 18 + Math.min(10, n),
      parent: 'master',
      record: { table: 'projects', id: p.id }
    })
    addEdge('master', pid, 'solid', '索引')
    projectNode.set(String(p.id), pid)
    shown.projects += 1
    const rows = db.prepare(
      'SELECT id, prefix, seq, summary, started_at, result FROM events WHERE project_id = ? AND merged_into IS NULL ORDER BY started_at DESC LIMIT ?'
    ).all(p.id, MAP_LIMITS.eventsPerProject + 1)
    for (const e of rows.slice(0, MAP_LIMITS.eventsPerProject)) {
      addNode({
        id: 'e:' + e.id,
        kind: 'event',
        label: e.prefix + String(e.seq).padStart(3, '0'),
        meta: String(e.summary || '（无摘要）').replace(/\s+/g, ' ').slice(0, 70),
        weight: 7,
        parent: pid,
        record: { table: 'events', id: e.id }
      })
      addEdge(pid, 'e:' + e.id, 'solid', '')
      eventNode.set(e.id, 'e:' + e.id)
      shown.events += 1
    }
  }

  const loose = db.prepare(
    'SELECT id, prefix, seq, summary, started_at FROM events WHERE merged_into IS NULL AND project_id IS NULL ORDER BY started_at DESC LIMIT ?'
  ).all(MAP_LIMITS.looseEvents)
  for (const e of loose) {
    addNode({
      id: 'e:' + e.id,
      kind: 'event',
      label: e.prefix + String(e.seq).padStart(3, '0'),
      meta: String(e.summary || '（无摘要）').replace(/\s+/g, ' ').slice(0, 70),
      weight: 7,
      parent: 'events',
      record: { table: 'events', id: e.id }
    })
    addEdge('events', 'e:' + e.id, 'dashed', '')
    eventNode.set(e.id, 'e:' + e.id)
    shown.looseEvents += 1
  }

  const knowledgeRows = db.prepare(
    'SELECT id, domain, kind, body, status FROM knowledge ORDER BY rowid DESC LIMIT ?'
  ).all(MAP_LIMITS.knowledge)
  for (const k of knowledgeRows) {
    addNode({
      id: 'k:' + k.id,
      kind: 'knowledge-item',
      label: k.domain || k.kind || '知识',
      meta: String(k.body || '').replace(/\s+/g, ' ').slice(0, 60),
      weight: 6,
      parent: 'knowledge',
      record: { table: 'knowledge', id: k.id }
    })
    shown.knowledge += 1
  }

  /* 项目之间的真实近似度：只连星图上已经显示的项目，避免指向不存在的星。
     线上写百分比；聚焦时与其他边一起亮起（默认不画，免得盖住结构边）。 */
  let projectLinkCount = 0
  for (const link of db.prepare('SELECT a, b, weight FROM project_links ORDER BY weight DESC LIMIT 200').all()) {
    const from = projectNode.get(String(link.a))
    const to = projectNode.get(String(link.b))
    if (!from || !to) continue
    const percent = weights.pct(link.weight)
    if (percent < 20) continue
    addEdge(from, to, 'weight', percent + '%', { percent, weight: link.weight })
    projectLinkCount += 1
    if (projectLinkCount >= 24) break
  }

  /* 事件网与项目网分开建表，这里也只在事件星之间连线：
     事件之间的相关度回答「这两件事说的是不是同一件事」，不经过项目名。 */
  let eventLinkCount = 0
  for (const link of db.prepare('SELECT a, b, weight FROM event_links ORDER BY weight DESC LIMIT 400').all()) {
    const from = eventNode.get(link.a)
    const to = eventNode.get(link.b)
    if (!from || !to) continue
    const percent = weights.pct(link.weight)
    if (percent < 20) continue
    addEdge(from, to, 'weight', percent + '%', { percent, weight: link.weight })
    eventLinkCount += 1
    if (eventLinkCount >= 40) break
  }
  shown.projectLinks = projectLinkCount
  shown.eventLinks = eventLinkCount

  const huge = nodes.length > MAP_LIMITS.maxNodes
  if (huge) {
    /* 兜底：任何未预料的增长都不能把渲染层拖垮，先砍小星体 */
    const excess = nodes.length - MAP_LIMITS.maxNodes
    const drop = new Set(
      nodes.filter((n) => n.kind === 'event' || n.kind === 'knowledge-item')
        .slice(0, excess)
        .map((n) => n.id)
    )
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (drop.has(nodes[i].id)) nodes.splice(i, 1)
    }
    for (let i = edges.length - 1; i >= 0; i--) {
      if (drop.has(edges[i].from) || drop.has(edges[i].to)) edges.splice(i, 1)
    }
  }

  return {
    ok: true,
    at: new Date().toISOString(),
    mode: 'data',
    nodes,
    edges,
    limits: { ...MAP_LIMITS },
    shown: { ...shown, nodes: nodes.length },
    truncation: {
      projects: allProjects.length > shown.projects,
      events: eventCount > shown.events + shown.looseEvents,
      knowledge: knowledgeCount > shown.knowledge,
      any: allProjects.length > shown.projects || eventCount > shown.events + shown.looseEvents || knowledgeCount > shown.knowledge || huge
    },
    stats: {
      projects: allProjects.length,
      projectTotal: allProjects.length,
      events: eventCount,
      knowledge: knowledgeCount,
      proposals: count('SELECT COUNT(*) AS n FROM proposals'),
      dispatch: count('SELECT COUNT(*) AS n FROM dispatch_log'),
      behavior: count('SELECT COUNT(*) AS n FROM behavior_log'),
      archive: count('SELECT COUNT(*) AS n FROM archive_manifest'),
      hardChars: hard.total,
      hardBudget: hard.budget,
      projectLinks: projectLinkCount,
      eventLinks: eventLinkCount
    },
    truncated: allProjects.length > shown.projects || eventCount > shown.events + shown.looseEvents || knowledgeCount > shown.knowledge || huge
  }
}

/* ---------- 单节点权重位图 ---------- */

function nodeViewData (params) {
  const kind = params && params.get('kind') === 'event' ? 'event' : 'project'
  const id = (params && params.get('id')) || ''
  const raw = params && params.get('near')
  const near = raw === null || raw === '' ? undefined : Number(raw)
  return service.nodeView({
    actor: ROLE.SUPER,
    kind,
    id,
    ...(Number.isFinite(near) ? { near } : {})
  })
}

/* ---------- 知识网：第四张网 ---------- */

/* 库里的知识条目：节点大小 = 自身权重，连线 = 「说的是同一件事」。
   只读：不记曝光、不记打开 —— 控制台里看一眼不该改变任何一条知识的权重。 */
function kbData () {
  const res = service.kb({ action: 'map' })
  if (!res || !res.ok) {
    return { ok: false, error: (res && res.error) || '知识网不可用', nodes: [], edges: [], stats: {}, top: [], cold: [] }
  }
  const names = new Map(service.db.prepare('SELECT id, name FROM projects').all().map((row) => [row.id, row.name]))
  const nodes = res.data.nodes.map((node) => ({
    ...node,
    projectName: node.projectId ? (names.get(node.projectId) || node.projectId) : '全局'
  }))
  const byWeight = [...nodes].sort((a, b) => b.weight - a.weight)
  const recent = service.db.prepare(
    "SELECT id, at, query, picked, chars FROM kb_hits ORDER BY at DESC LIMIT 12"
  ).all().map((row) => ({
    at: row.at,
    query: row.query,
    chars: row.chars,
    picked: (() => { try { return JSON.parse(row.picked || '[]') } catch { return [] } })()
  }))
  return {
    ok: true,
    nodes,
    edges: res.data.edges,
    stats: res.data.stats,
    kinds: {
      方法: nodes.filter((n) => n.kind === '方法').length,
      避错: nodes.filter((n) => n.kind === '避错').length,
      其他: nodes.filter((n) => n.kind !== '方法' && n.kind !== '避错').length
    },
    top: byWeight.slice(0, 12),
    /* 「从没打开过、且已经放了半个月」—— 不是让界面替他删，是让他看见 */
    cold: byWeight
      .filter((n) => !n.opens && n.ageDays >= 14)
      .sort((a, b) => b.ageDays - a.ageDays)
      .slice(0, 12),
    recent
  }
}

/* ---------- 时间：周记 + 时段习惯 ---------- */

/* 读的时候顺手把派生表更新到最新：周记与时段都是从事件算出来的缓存，
   不写任何记录表。控制台只读的边界没有变。 */
function timeData (params) {
  const at = params && params.get('at') ? params.get('at') : new Date().toISOString()
  const habit = service.time({ actor: ROLE.SUPER, action: 'habit', at })
  if (!habit.ok) return { ok: false, error: habit.error }
  const suggest = service.time({ actor: ROLE.SUPER, action: 'suggest', at })
  const phase = service.time({ actor: ROLE.SUPER, action: 'phase', at })
  const phases = service.time({ actor: ROLE.SUPER, action: 'phases' })
  const weeks = service.time({ actor: ROLE.SUPER, action: 'weeks', limit: 24 })
  const wanted = params && params.get('week') ? params.get('week') : ''
  const latest = weeks.ok && weeks.data.length
    ? (wanted
        ? service.time({ actor: ROLE.SUPER, action: 'week', week: wanted })
        : service.time({ actor: ROLE.SUPER, action: 'week', week: weeks.data[0].week }))
    : null
  const slots = db.prepare(
    'SELECT weekday, hour, key, kind, weight, share, reliability, weeks, hits FROM time_slots ORDER BY weekday, hour, weight DESC'
  ).all()
  const grouped = new Map()
  for (const row of slots) {
    const key = row.weekday + '|' + row.hour
    const list = grouped.get(key) || []
    list.push(row)
    grouped.set(key, list)
  }
  const grid = []
  for (let weekday = 1; weekday <= 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const rows = grouped.get(weekday + '|' + hour) || []
      const top = rows.find((row) => row.kind === 'project') || rows[0] || null
      grid.push({
        weekday,
        hour,
        count: rows.reduce((sum, row) => sum + row.hits, 0),
        top: top ? {
          key: top.key,
          kind: top.kind,
          percent: weights.pct(top.weight),
          share: weights.pct(top.share),
          reliability: weights.pct(top.reliability),
          weeks: top.weeks,
          hits: top.hits
        } : null
      })
    }
  }
  return {
    ok: true,
    at,
    now: habit.data,
    suggest: suggest.ok ? suggest.data : null,
    phase: phase.ok ? phase.data : null,
    phases: phases.ok ? phases.data : { probs: [], transitions: [], events: 0 },
    grid,
    weeks: weeks.ok ? weeks.data : [],
    week: latest && latest.ok ? latest.data : null,
    stats: { slots: slots.length, weeks: weeks.ok ? weeks.data.length : 0 }
  }
}

function send (res, status, body, type) {
  const payload = type ? body : JSON.stringify(body)
  const mime = type === 'html' ? 'text/html; charset=utf-8'
    : type === 'css' ? 'text/css; charset=utf-8'
      : type === 'js' ? 'application/javascript; charset=utf-8'
        : 'application/json; charset=utf-8'
  res.writeHead(status, {
    'content-type': mime,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function authOk (req) {
  if (!TOKEN) return true
  return (req.headers.authorization || '') === 'Bearer ' + TOKEN
}

function readJsonBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (fn, value) => {
      if (done) return
      done = true
      fn(value)
    }
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > MAX_BODY) {
        finish(reject, new Error('请求体超过 ' + MAX_BODY + ' 字节'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return finish(resolve, {})
      try { finish(resolve, JSON.parse(raw)) } catch { finish(reject, new Error('请求体不是合法 JSON')) }
    })
    req.on('error', (err) => finish(reject, err))
  })
}

const server = http.createServer(async (req, res) => {
  let url
  try { url = new URL(req.url, 'http://127.0.0.1') } catch {
    return send(res, 400, { ok: false, error: '无效请求' })
  }
  const p = url.pathname
  if (p === '/health') {
    return send(res, 200, {
      ok: true,
      enabled: ENABLED,
      writeEnabled: WRITE_ENABLED,
      version: VERSION,
      auth: Boolean(TOKEN)
    })
  }

  const isWrite = req.method === 'POST' && p === '/api/hard-context'
  if (req.method !== 'GET' && !isWrite) {
    return send(res, 405, { ok: false, error: '记录表只读；唯一写接口是 POST /api/hard-context' })
  }
  if (p.startsWith('/api/') && !authOk(req)) {
    return send(res, 401, { ok: false, error: '需要访问令牌：Authorization: Bearer <MEMORY_VIEW_TOKEN>' })
  }

  if (isWrite) {
    if (!WRITE_ENABLED) {
      return send(res, 403, { ok: false, error: '写入已关闭：对外监听需设置 MEMORY_VIEW_TOKEN，或移除 MEMORY_VIEW_WRITE=0' })
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      return send(res, 415, { ok: false, error: '保存需要 Content-Type: application/json' })
    }
    try {
      const body = await readJsonBody(req)
      return send(res, 200, saveHardContext(body.slot, body.body))
    } catch (err) {
      return send(res, 400, { ok: false, error: err.message })
    }
  }

  try {
    if (p === '/' || p === '/index.html') return send(res, 200, fs.readFileSync(path.join(VIEW_DIR, 'index.html'), 'utf8'), 'html')
    if (p === '/app.css') return send(res, 200, fs.readFileSync(path.join(VIEW_DIR, 'app.css'), 'utf8'), 'css')
    if (p === '/app.js') return send(res, 200, fs.readFileSync(path.join(VIEW_DIR, 'app.js'), 'utf8'), 'js')
    if (p === '/starmap3d.js') return send(res, 200, fs.readFileSync(path.join(VIEW_DIR, 'starmap3d.js'), 'utf8'), 'js')
    if (p === '/api/snapshot') return send(res, 200, snapshot())
    if (p === '/api/table') {
      return send(res, 200, tableData(
        url.searchParams.get('name') || '',
        url.searchParams.get('limit'),
        url.searchParams.get('offset'),
        (url.searchParams.get('q') || '').trim()
      ))
    }
    if (p === '/api/record') return send(res, 200, recordData(url.searchParams.get('name') || '', url.searchParams.get('id') || ''))
    if (p === '/api/archive') return send(res, 200, archiveData(url.searchParams.get('id') || ''))
    if (p === '/api/search') return send(res, 200, globalSearch((url.searchParams.get('q') || '').trim()))
    if (p === '/api/hard-context') return send(res, 200, hardContextData())
    if (p === '/api/starmap') return send(res, 200, starMapData())
    if (p === '/api/nodeview') return send(res, 200, nodeViewData(url.searchParams))
    if (p === '/api/time') return send(res, 200, timeData(url.searchParams))
    if (p === '/api/kb') return send(res, 200, kbData())
    return send(res, 404, { ok: false, error: '未找到：' + p })
  } catch (err) {
    return send(res, 400, { ok: false, error: err.message })
  }
})

server.listen(PORT, HOST, () => {
  process.stderr.write(
    '[astral-memory-view] http://' + HOST + ':' + PORT +
    ' （记录只读 · 硬性上下文' + (WRITE_ENABLED ? '可编辑' : '写入关闭') +
    (TOKEN ? ' · 需令牌' : '') + '）\n'
  )
})

function shutdown () {
  server.close(() => {
    service.close()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
