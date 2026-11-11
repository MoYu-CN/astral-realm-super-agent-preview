'use strict'

/* 星界 · 记忆库与 MCP 服务雏形自测：不启动 Electron，纯 Node 验证。 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const net = require('node:net')
const { DatabaseSync } = require('node:sqlite')
const { createMemoryStore, ROLE } = require('../electron/memory/store.js')
const weights = require('../electron/memory/weights.js')
const { createIntake, memorySecretBox } = require('../electron/intake/index.js')
const catalog = require('../electron/intake/catalog.js')
const normalize = require('../electron/intake/normalize.js')
const httpAdapter = require('../electron/intake/adapters/http.js')

const tests = []
let passed = 0
function test (name, fn) { tests.push({ name, fn }) }
const tempDirs = []
function tempDir () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-memory-test-'))
  tempDirs.push(dir)
  return dir
}
/* 每个用例结束后清掉它自己造的临时库；Windows 上子进程可能还占着库文件，靠重试兜住。 */
function sweep (mark) {
  while (tempDirs.length > mark) {
    const dir = tempDirs.pop()
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
    } catch { /* 实在删不掉就留着，下次启动再清 */ }
  }
}
function fresh (opts = {}) {
  const dir = tempDir()
  return { dir, store: createMemoryStore({ configDir: dir, ...opts }) }
}
const EVENT = { action: 'event', project: '投票项目', prefix: 'BB', summary: '修复登录报错' }

test('建库：36 张表齐全（含原文/浓缩、权重边、团队工具箱），knowledge 表无项目外键', () => {
  const { store } = fresh()
  try {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all().map((r) => r.name).sort()
    assert.deepEqual(tables, [
      'archive_manifest', 'behavior_log', 'diary_digest', 'dispatch_log',
      'event_links', 'event_prefixes', 'event_terms', 'events',
      'hard_context', 'inbox_channels', 'inbox_messages', 'inbox_threads',
      'kb_hits', 'kb_links', 'kb_nodes', 'kb_terms',
      'knowledge', 'message_digests', 'message_records', 'observations', 'phase_events', 'phase_probs',
      'phase_transitions', 'project_links', 'project_terms',
      'projects', 'proposals', 'recall_log', 'security_gates', 'security_ledger',
      'security_tasks', 'team_toolboxes', 'time_slots', 'week_docs',
      'weight_dimensions', 'weight_edges'
    ].sort())
    const sql = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge'").get().sql
    assert.ok(!/project_id/i.test(sql), 'knowledge 表不应出现 project_id')
    assert.ok(fs.existsSync(store.file))
  } finally { store.close() }
})

test('写事件：一次调用完成编号分配与动态前缀表登记', () => {
  const { store } = fresh()
  try {
    const a = store.write({ actor: ROLE.SUPER, ...EVENT, series: '修复 bug' })
    assert.equal(a.ok, true)
    assert.equal(a.data.code, 'BB001')
    assert.equal(a.data.prefixCreated, true)
    const prefix = store.db.prepare("SELECT * FROM event_prefixes WHERE prefix = 'BB'").get()
    assert.equal(prefix.series, '修复 bug')

    const b = store.write({ actor: ROLE.SUPER, ...EVENT })
    assert.equal(b.data.code, 'BB002')
    assert.equal(b.data.prefixCreated, false)

    const other = store.write({ actor: ROLE.SUPER, ...EVENT, project: '另一个项目' })
    assert.equal(other.data.code, 'BB001', '序号默认项目内唯一')
  } finally { store.close() }
})

test('查询：一次取回事件 / 提议 / 派发，未完成的结束时间为空', () => {
  const { store } = fresh()
  try {
    store.write({ actor: ROLE.SUPER, ...EVENT, startedAt: '2026-11-09T14:20:00+08:00' })
    store.write({ actor: ROLE.SUPER, ...EVENT })
    store.write({ actor: ROLE.SUPER, action: 'proposal', project: '投票项目', result: '已下发任务' })
    store.write({ actor: ROLE.SUPER, action: 'dispatch', project: '投票项目', task: '修复 bug', toTeam: '投票团队' })
    const q = store.query({ actor: ROLE.SUPER, project: '投票项目', include: ['events', 'proposals', 'dispatch'] })
    assert.equal(q.ok, true)
    assert.equal(q.data.events.length, 2)
    assert.equal(q.data.proposals.length, 1)
    assert.equal(q.data.dispatch.length, 1)
    assert.ok(q.data.events.every((e) => e.ended_at === null))
  } finally { store.close() }
})

test('T5：用户改变主意后旧决定仍保留（只追加不覆盖）', () => {
  const { store } = fresh()
  try {
    store.write({ actor: ROLE.SUPER, action: 'proposal', project: '投票项目', result: '拒绝' })
    store.write({ actor: ROLE.SUPER, action: 'proposal', project: '投票项目', result: '接受' })
    const rows = store.db.prepare('SELECT * FROM proposals ORDER BY raised_at').all()
    assert.equal(rows.length, 2)
    assert.ok(rows.some((r) => r.result === '拒绝'))
    assert.ok(rows.some((r) => r.result === '接受'))
    const bad = store.write({ actor: ROLE.SUPER, action: 'proposal', project: '投票项目', result: '随便' })
    assert.equal(bad.ok, false)
  } finally { store.close() }
})

test('T3：同类事件合并衰减，合并后的记录不再出现在常规查询里', () => {
  const { store } = fresh()
  try {
    const a = store.write({ actor: ROLE.SUPER, ...EVENT })
    const b = store.write({ actor: ROLE.SUPER, ...EVENT })
    const m = store.mergeEvents({ actor: ROLE.SUPER, ids: [a.data.id, b.data.id] })
    assert.equal(m.ok, true)
    assert.equal(m.data.merged, 1)
    const q = store.query({ actor: ROLE.SUPER, include: ['events'] })
    assert.equal(q.data.events.length, 1)
    assert.equal(q.data.events[0].id, a.data.id)
  } finally { store.close() }
})

test('按角色分区：执行层智能体调用 memory_* 被拒', () => {
  const { store } = fresh()
  try {
    const r = store.write({ actor: ROLE.EXECUTOR, ...EVENT })
    assert.equal(r.ok, false)
    assert.match(r.error, /仅超级智能体/)
    const q = store.query({ actor: ROLE.EXECUTOR, include: ['events'] })
    assert.equal(q.ok, false)
  } finally { store.close() }
})

test('knowledge：执行层可读写，且与项目数据无关联', () => {
  const { store } = fresh()
  try {
    const k = store.knowledge({ actor: ROLE.EXECUTOR, action: 'upsert', domain: '前端', kind: '避错', body: '不要直接重装依赖' })
    assert.equal(k.ok, true)
    const q = store.knowledge({ actor: ROLE.EXECUTOR, action: 'query' })
    assert.equal(q.data.length, 1)
    assert.equal(q.data[0].project_id, undefined)
  } finally { store.close() }
})

test('外部直连：默认只读；显式放行后可写', () => {
  const a = fresh()
  try {
    const denied = a.store.knowledge({ actor: ROLE.EXTERNAL, action: 'upsert', body: 'x' })
    assert.equal(denied.ok, false)
    assert.match(denied.error, /只读/)
    assert.equal(a.store.knowledge({ actor: ROLE.EXTERNAL, action: 'query' }).ok, true)
  } finally { a.store.close() }
  const b = fresh({ allowExternalWrite: true })
  try {
    assert.equal(b.store.knowledge({ actor: ROLE.EXTERNAL, action: 'upsert', body: 'x' }).ok, true)
  } finally { b.store.close() }
})

test('C3：知识过期直接删除', () => {
  const { store } = fresh()
  try {
    const k = store.knowledge({ actor: ROLE.SUPER, action: 'upsert', body: 'x' })
    const e = store.knowledge({ actor: ROLE.SUPER, action: 'expire', id: k.data.id })
    assert.equal(e.data.deleted, 1)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM knowledge').get().n, 0)
  } finally { store.close() }
})

test('硬性上下文：默认四块、字数上限、保存后修订号递增、清空不重新种回', () => {
  const { dir, store } = fresh()
  try {
    const r = store.hardContext.read()
    assert.equal(r.ok, true)
    assert.equal(r.data.blocks.length, 4)
    assert.equal(r.data.budget, 3600)
    assert.ok(r.data.blocks.every((b) => b.body.length > 0), '四块应有初始内容')
    assert.equal(r.data.total, r.data.blocks.reduce((n, b) => n + b.chars, 0))

    const saved = store.hardContext.save({ slot: 'identity', body: '新的身份与边界' })
    assert.equal(saved.ok, true)
    assert.equal(saved.data.saved.body, '新的身份与边界')
    assert.equal(saved.data.saved.revision, 2)
    assert.equal(store.hardContext.read().data.blocks.find((b) => b.key === 'identity').body, '新的身份与边界')

    const bad = store.hardContext.save({ slot: 'nope', body: 'x' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /未知的硬性上下文块/)
    const long = store.hardContext.save({ slot: 'identity', body: 'x'.repeat(901) })
    assert.equal(long.ok, false)
    assert.match(long.error, /最多 900 字/)

    const ctx = store.getContext({ actor: ROLE.SUPER })
    assert.equal(ctx.data.hardContext.blocks.length, 4, 'memory_context 应带常驻四块')
    assert.match(store.hardContext.prompt().data.text, /硬性上下文（常驻）/)
    assert.match(store.hardContext.prompt().data.text, /新的身份与边界/)

    store.hardContext.save({ slot: 'profile', body: '' })
  } finally { store.close() }

  /* 重新打开同一库：用户清空的块不能被默认内容重新塞回 */
  const again = createMemoryStore({ configDir: dir })
  try {
    const blocks = again.hardContext.read().data.blocks
    assert.equal(blocks.find((b) => b.key === 'profile').body, '')
    assert.equal(blocks.find((b) => b.key === 'identity').body, '新的身份与边界')
    assert.equal(again.hardContext.read().data.filled, 3)
  } finally { again.close() }
})

test('封存：复制登记、只读回查、源文件不被改写', () => {
  const { dir, store } = fresh()
  try {
    const src = path.join(dir, 'old-diary.md')
    fs.writeFileSync(src, '旧日记内容', 'utf8')
    const before = fs.readFileSync(src, 'utf8')
    const reg = store.archive.register({ sourcePath: src, kind: '日记', projectHint: '投票项目' })
    assert.ok(fs.existsSync(reg.path))
    assert.equal(store.archive.read(reg.id).content, '旧日记内容')
    assert.equal(fs.readFileSync(src, 'utf8'), before)
    const q = store.query({ actor: ROLE.SUPER, source: 'archive', id: reg.id })
    assert.equal(q.ok, true)
    assert.equal(q.data.content, '旧日记内容')
  } finally { store.close() }
})

test('压缩与开关：压缩返回 not_implemented，关闭时 memory_* 明确报错', () => {
  const on = fresh()
  try {
    assert.equal(on.store.compress({ level: 'day' }).data.status, 'not_implemented')
  } finally { on.store.close() }
  const off = fresh({ enabled: false })
  try {
    const r = off.store.write({ actor: ROLE.SUPER, ...EVENT })
    assert.equal(r.ok, false)
    assert.match(r.error, /关闭/)
  } finally { off.store.close() }
})

function mcpProbe (dir, messages) {
  return new Promise((resolve, reject) => {
    const server = path.join(__dirname, '..', 'electron', 'memory', 'server.js')
    const child = spawn(process.execPath, [server], {
      env: {
        ...process.env,
        MEMORY_CONFIG_DIR: dir,
        MEMORY_ACTOR: ROLE.SUPER,
        MEMORY_ENABLED: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let buf = ''
    const replies = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('MCP 响应超时'))
    }, 10000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try { replies.push(JSON.parse(line)) } catch {}
        if (replies.length >= messages.length) {
          clearTimeout(timer)
          child.kill()
          resolve(replies)
        }
      }
    })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    for (const msg of messages) child.stdin.write(JSON.stringify(msg) + '\n')
  })
}

test('stdio server 可独立启动并响应 initialize / tools/list / tools/call', async () => {
  const dir = tempDir()
  const replies = await mcpProbe(dir, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'memory_write', arguments: { action: 'event', project: '投票项目', prefix: 'BB', summary: 'MCP 写入' } }
    }
  ])
  assert.equal(replies.length, 3)
  assert.equal(replies[0].result.serverInfo.name, 'astral-memory')
  assert.equal(replies[0].result.protocolVersion, '2024-11-05')
  assert.equal(replies[1].result.tools.length, 8, 'stdio 应含 recall / time / observe 与原文回查工具')
  const timeTool = replies[1].result.tools.find((t) => t.name === 'memory_time')
  assert.ok(timeTool)
  assert.ok(timeTool.inputSchema.properties.action.enum.includes('phase'))
  assert.ok(timeTool.inputSchema.properties.project, 'phase 需要能指定项目')
  assert.ok(replies[1].result.tools.some((t) => t.name === 'message_get'), '应能按编号回查原文')
  assert.ok(!replies[1].result.tools.some((t) => t.name === 'memory_compress'), '不应再暴露摘要压缩工具')
  const payload = JSON.parse(replies[2].result.content[0].text)
  assert.equal(payload.ok, true)
  assert.equal(payload.data.code, 'BB001')
})

function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

async function waitFor (fn, timeout = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { if (await fn()) return } catch {}
    await new Promise((r) => setTimeout(r, 80))
  }
  throw new Error('服务启动超时')
}

test('应用端控制台：静态资源、概览、图表数据、表分页、全局搜索、只读边界', async () => {
  const { dir, store } = fresh()
  try {
    store.write({ actor: ROLE.SUPER, action: 'project', id: '投票项目', name: '投票项目', summary: '星图测试项目' })
    store.write({ actor: ROLE.SUPER, action: 'event', project: '投票项目', prefix: 'BB', summary: '可视化测试' })
    store.write({ actor: ROLE.SUPER, action: 'event', project: '投票项目', prefix: 'P', summary: '一次改动' })
  } finally { store.close() }

  const port = await freePort()
  const viewServer = path.join(__dirname, '..', 'electron', 'memory', 'view-server.js')
  const child = spawn(process.execPath, [viewServer], {
    env: { ...process.env, MEMORY_CONFIG_DIR: dir, MEMORY_VIEW_PORT: String(port), MEMORY_ENABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const base = 'http://127.0.0.1:' + port
  try {
    await waitFor(async () => (await fetch(base + '/health')).ok)
    const health = await (await fetch(base + '/health')).json()
    assert.equal(health.ok, true)
    assert.equal(health.auth, false)

    const snap = await (await fetch(base + '/api/snapshot')).json()
    assert.equal(snap.tables.length, 20, '9 张记录表 + 11 张派生表')
    assert.equal(snap.enabled, true)
    assert.equal(snap.tables.find((x) => x.name === 'events').count, 2)
    assert.equal(snap.eventByPrefix.length, 2)
    assert.equal(snap.eventTrend.length, 14)
    assert.equal(snap.recentEvents.length, 2)

    const html = await (await fetch(base + '/')).text()
    assert.match(html, /星界 · 记忆库控制台/)
    assert.match(html, /ASTRAL REALM/, '品牌应与星界一致')
    assert.match(html, /class="rail"/, '应为星界 rail / stage / dock 三栏结构')
    assert.match(html, /class="dock"/, '应带右侧预览 dock')
    assert.match(html, /class="bridge/, '应带 MCP bridge 徽标')
    assert.match(html, /id="fx-stars"/, '页面应带星界星野画布')
    assert.match(html, /id="stars-toggle"/, '页面应带星野开关')
    assert.equal((await fetch(base + '/app.css')).status, 200)
    assert.equal((await fetch(base + '/app.js')).status, 200)

    const tbl = await (await fetch(base + '/api/table?name=events&limit=10')).json()
    assert.equal(tbl.rows.length, 2)
    assert.ok(tbl.columns.includes('prefix'))
    assert.equal(tbl.offset, 0)
    assert.equal(tbl.columnLabels.prefix, '动作前缀', '表头应为中文')
    assert.equal(tbl.columnLabels.project_id, '所属项目')
    assert.equal(tbl.label, '事件', '表名应为中文')
    assert.ok(tbl.valueLabels && typeof tbl.valueLabels === 'object')
    const filtered = await (await fetch(base + '/api/table?name=events&q=' + encodeURIComponent('可视化'))).json()
    assert.equal(filtered.rows.length, 1)
    const paged = await (await fetch(base + '/api/table?name=events&limit=1&offset=1')).json()
    assert.equal(paged.rows.length, 1)
    assert.equal(paged.offset, 1)

    const search = await (await fetch(base + '/api/search?q=' + encodeURIComponent('可视化'))).json()
    assert.ok(search.results.length >= 1)
    assert.ok(search.results[0].id, '搜索结果需带记录 id 以便直接预览')

    const rowId = tbl.rows.find((r) => String(r.summary).includes('可视化')).id
    const rec = await (await fetch(base + '/api/record?name=events&id=' + encodeURIComponent(rowId))).json()
    assert.equal(rec.ok, true)
    assert.equal(rec.row.id, rowId)
    assert.match(rec.content.text, /可视化测试/)
    assert.match(rec.bundle.text, /星界记忆 · 上下文包/)

    /* 硬性上下文：可查看、可保存，且是唯一写接口 */
    const hc = await (await fetch(base + '/api/hard-context')).json()
    assert.equal(hc.ok, true)
    assert.equal(hc.blocks.length, 4)
    assert.equal(hc.budget, 3600)
    assert.equal(hc.writeEnabled, true)
    const hs = await fetch(base + '/api/hard-context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'identity', body: '控制台改写的身份与边界' })
    })
    assert.equal(hs.status, 200)
    const hsData = await hs.json()
    assert.equal(hsData.saved.revision, 2)
    const hc2 = await (await fetch(base + '/api/hard-context')).json()
    assert.equal(hc2.blocks.find((b) => b.key === 'identity').body, '控制台改写的身份与边界')
    assert.equal(hc2.filled, 4)
    const hsBad = await fetch(base + '/api/hard-context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'nope', body: 'x' })
    })
    assert.equal(hsBad.status, 400)
    const hsType = await fetch(base + '/api/hard-context', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}'
    })
    assert.equal(hsType.status, 415)

    /* 星图：项目 / 事件 / 知识岛，知识库节点刻意没有任何边 */
    const map = await (await fetch(base + '/api/starmap')).json()
    assert.equal(map.ok, true)
    assert.ok(map.nodes.some((n) => n.kind === 'project'), '应包含项目星')
    assert.ok(map.nodes.some((n) => n.kind === 'event'), '应包含事件星')
    assert.ok(map.nodes.some((n) => n.id === 'knowledge' && n.isolated), '知识库应为独立岛')
    assert.ok(!map.edges.some((e) => e.from === 'knowledge' || e.to === 'knowledge'), 'G7：知识库不能连任何节点')
    assert.ok(map.stats.projects >= 1 && map.stats.events >= 2)

    const bad = await (await fetch(base + '/api/table?name=sqlite_master')).json()
    assert.equal(bad.ok, false)
    const badRec = await (await fetch(base + '/api/record?name=sqlite_master&id=1')).json()
    assert.equal(badRec.ok, false)
    const post = await fetch(base + '/api/snapshot', { method: 'POST' })
    assert.equal(post.status, 405)
  } finally { child.kill() }
})

test('只读部署：MEMORY_VIEW_WRITE=0 时硬性上下文可看不可改', async () => {
  const { dir, store } = fresh()
  store.close()
  const port = await freePort()
  const viewServer = path.join(__dirname, '..', 'electron', 'memory', 'view-server.js')
  const child = spawn(process.execPath, [viewServer], {
    env: { ...process.env, MEMORY_CONFIG_DIR: dir, MEMORY_VIEW_PORT: String(port), MEMORY_ENABLED: '1', MEMORY_VIEW_WRITE: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const base = 'http://127.0.0.1:' + port
  try {
    await waitFor(async () => (await fetch(base + '/health')).ok)
    const health = await (await fetch(base + '/health')).json()
    assert.equal(health.writeEnabled, false)
    const hc = await (await fetch(base + '/api/hard-context')).json()
    assert.equal(hc.ok, true)
    assert.equal(hc.writeEnabled, false)
    assert.equal(hc.blocks.length, 4, '只读仍可查看四块')
    const post = await fetch(base + '/api/hard-context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'identity', body: '只读部署不应写进去' })
    })
    assert.equal(post.status, 403)
    const hc2 = await (await fetch(base + '/api/hard-context')).json()
    assert.notEqual(hc2.blocks.find((b) => b.key === 'identity').body, '只读部署不应写进去')
  } finally { child.kill() }
})

test('星图显示上限：项目 / 事件 / 知识按上限截断，并报告总量', async () => {
  const { dir, store } = fresh()
  try {
    for (let i = 0; i < 8; i++) {
      const name = '上限项目' + i
      store.write({ actor: ROLE.SUPER, action: 'project', id: name, name, summary: '用于验证星图上限' })
      for (let j = 0; j < 8; j++) {
        store.write({ actor: ROLE.SUPER, action: 'event', project: name, prefix: 'L' + i, summary: '事件 ' + j })
      }
    }
    for (let i = 0; i < 20; i++) {
      store.knowledge({ actor: ROLE.EXECUTOR, action: 'upsert', domain: '上限域' + i, kind: '做法', body: '知识 ' + i })
    }
  } finally { store.close() }

  const port = await freePort()
  const viewServer = path.join(__dirname, '..', 'electron', 'memory', 'view-server.js')
  const child = spawn(process.execPath, [viewServer], {
    env: { ...process.env, MEMORY_CONFIG_DIR: dir, MEMORY_VIEW_PORT: String(port), MEMORY_ENABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const base = 'http://127.0.0.1:' + port
  try {
    await waitFor(async () => (await fetch(base + '/health')).ok)
    const map = await (await fetch(base + '/api/starmap')).json()
    assert.equal(map.limits.projects, 6)
    assert.equal(map.limits.eventsPerProject, 6)
    assert.equal(map.limits.knowledge, 12)
    assert.equal(map.nodes.filter((n) => n.kind === 'project').length, 6, '项目最多显示 6 个')
    assert.ok(map.nodes.filter((n) => n.kind === 'event').length <= 6 * 6 + 6, '事件按每项目 6 条 + 游离 6 条封顶')
    assert.equal(map.nodes.filter((n) => n.kind === 'knowledge-item').length, 12, '知识最多显示 12 条')
    assert.equal(map.stats.projects, 8, '总量仍要报告真实项目数')
    assert.equal(map.stats.events, 64)
    assert.equal(map.stats.knowledge, 20)
    assert.equal(map.shown.projects, 6)
    assert.equal(map.truncation.projects, true)
    assert.equal(map.truncation.events, true)
    assert.equal(map.truncation.knowledge, true)
    assert.equal(map.truncated, true)
    assert.ok(map.nodes.length <= map.limits.maxNodes)
  } finally { child.kill() }
})

test('云端鉴权：设置令牌后 API 返回 401，带令牌可访问，静态资源与健康检查不设限', async () => {
  const { dir, store } = fresh()
  store.close()
  const port = await freePort()
  const viewServer = path.join(__dirname, '..', 'electron', 'memory', 'view-server.js')
  const child = spawn(process.execPath, [viewServer], {
    env: { ...process.env, MEMORY_CONFIG_DIR: dir, MEMORY_VIEW_PORT: String(port), MEMORY_VIEW_TOKEN: 'secret-token' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const base = 'http://127.0.0.1:' + port
  try {
    await waitFor(async () => (await fetch(base + '/health')).ok)
    assert.equal((await fetch(base + '/api/snapshot')).status, 401)
    assert.equal((await fetch(base + '/')).status, 200)
    const okRes = await fetch(base + '/api/snapshot', { headers: { Authorization: 'Bearer secret-token' } })
    assert.equal(okRes.status, 200)
    assert.equal((await okRes.json()).auth, true)
  } finally { child.kill() }
})

test('记录预览：一次调用返回完整字段 / 具体内容 / 关联 / 封存原文 / 上下文包', async () => {
  const { dir, store } = fresh()
  const longText = [
    '# 登录报错排查',
    '',
    '## 现象',
    '用户提交投票后返回 500，日志显示 `session undefined`。',
    '',
    '## 处理',
    '- 检查网关注入的会话头',
    '- 补齐空会话兜底分支',
    '```js',
    'if (!session) return fallback()',
    '```'
  ].join('\n')
  let eventId, archiveId, knowledgeId
  try {
    const r1 = store.write({ actor: ROLE.SUPER, action: 'event', project: '投票项目', prefix: 'BB', series: '修复 bug', summary: longText, result: '已下发任务' })
    eventId = r1.data.id
    store.write({ actor: ROLE.SUPER, action: 'event', project: '投票项目', prefix: 'P', summary: '调整投票页布局' })
    store.write({ actor: ROLE.SUPER, action: 'proposal', project: '投票项目', result: '已下发任务' })
    store.write({ actor: ROLE.SUPER, action: 'dispatch', project: '投票项目', task: '修复登录报错', toTeam: '投票团队' })
    const rk = store.knowledge({ actor: 'executor', action: 'upsert', domain: '前端', kind: '避错', body: '## 会话兜底\n\n不要直接删除空会话，会导致二次 500。' })
    knowledgeId = rk.data.id
    const src = path.join(dir, 'old-diary.md')
    fs.writeFileSync(src, '# 2026-11-09 旧日记\n\n- 项目启动\n- 完成基础框架\n- 待补：登录态兜底\n', 'utf8')
    const ra = store.archive.register({ sourcePath: src, kind: '日记', projectHint: '投票项目' })
    archiveId = ra.id
  } finally { store.close() }

  const port = await freePort()
  const viewServer = path.join(__dirname, '..', 'electron', 'memory', 'view-server.js')
  const child = spawn(process.execPath, [viewServer], {
    env: { ...process.env, MEMORY_CONFIG_DIR: dir, MEMORY_VIEW_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const base = 'http://127.0.0.1:' + port
  try {
    await waitFor(async () => (await fetch(base + '/health')).ok)

    const rec = await (await fetch(base + '/api/record?name=events&id=' + encodeURIComponent(eventId))).json()
    assert.equal(rec.ok, true)
    assert.equal(rec.row.id, eventId)
    assert.ok(rec.columns.includes('summary'))
    assert.equal(rec.label, '事件')
    assert.equal(rec.fieldLabels.summary, '事件内容', '详情字段应为中文')
    assert.equal(rec.fieldLabels.started_at, '开始时间')
    assert.ok(rec.related.length > 0 && rec.related.every((r) => r.label), '关联记录应带中文表名')
    assert.match(rec.content.text, /登录报错排查/, '具体内容应保留完整长文本')
    assert.match(rec.content.text, /fallback\(\)/, '代码块内容不能被截断')
    assert.equal(rec.content.format, 'markdown')
    assert.ok(rec.related.some((r) => r.table === 'events'), '应带同项目关联事件')
    assert.ok(rec.related.some((r) => r.table === 'proposals'), '应带关联提议')
    assert.ok(rec.related.some((r) => r.table === 'dispatch_log'), '应带关联派发记录')
    assert.match(rec.bundle.text, /星界记忆 · 上下文包/)
    assert.match(rec.bundle.text, /## 具体内容/)
    assert.match(rec.bundle.text, /## 关联记录/)
    assert.ok(rec.bundle.chars > 200)

    const ar = await (await fetch(base + '/api/record?name=archive_manifest&id=' + encodeURIComponent(archiveId))).json()
    assert.equal(ar.ok, true)
    assert.equal(ar.content.format, 'text')
    assert.match(ar.archive.content, /2026-11-09 旧日记/)
    assert.ok(ar.archive.lines >= 4, '封存原文应保留多行')
    assert.match(ar.bundle.text, /## 封存文件原文/)
    const direct = await (await fetch(base + '/api/archive?id=' + encodeURIComponent(archiveId))).json()
    assert.equal(direct.ok, true)
    assert.equal(direct.content, ar.archive.content)

    const kn = await (await fetch(base + '/api/record?name=knowledge&id=' + encodeURIComponent(knowledgeId))).json()
    assert.equal(kn.ok, true)
    assert.equal(kn.related.length, 0, 'G7：知识库与项目无任何关联')
    assert.match(kn.bundle.text, /无任何关联/)

    const missing = await (await fetch(base + '/api/record?name=events&id=not-exist')).json()
    assert.equal(missing.ok, false)
    const badArchive = await (await fetch(base + '/api/archive?id=not-exist')).json()
    assert.equal(badArchive.ok, false)
    const post = await fetch(base + '/api/record', { method: 'POST' })
    assert.equal(post.status, 405, '只读接口不接受写入')
  } finally { child.kill() }
})

test('中文字段映射：表名 / 列名 / 枚举值 / 时间列', () => {
  const labels = require('../electron/memory/labels.js')
  assert.equal(labels.tableLabel('projects'), '项目')
  assert.equal(labels.tableLabel('dispatch_log'), '派发记录')
  assert.equal(labels.tableLabel('archive_manifest'), '封存清单')
  assert.equal(labels.columnLabel('projects', 'name'), '项目名称')
  assert.equal(labels.columnLabel('events', 'project_id'), '所属项目')
  assert.equal(labels.columnLabel('knowledge', 'body'), '知识正文')
  assert.equal(labels.columnLabel('events', 'unknown_col'), 'unknown_col', '未登记的列回落到原列名')
  assert.equal(labels.valueLabel('projects', 'status', 'active'), '进行中')
  assert.equal(labels.valueLabel('events', 'actor', 'super'), '超级智能体')
  assert.equal(labels.valueLabel('diary_digest', 'level', 'week'), '周摘要')
  assert.equal(labels.valueLabel('projects', 'status', 'whatever'), 'whatever')
  assert.deepEqual(labels.valuesFor('projects'), { status: { active: '进行中', paused: '已暂停', done: '已完成', archived: '已归档' } })
  assert.equal(labels.isTimeColumn('started_at'), true)
  assert.equal(labels.isTimeColumn('summary'), false)
})

test('内置宿主：状态、工具分发、中文表名、关闭开关后拒写、控制台可拉起', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ memory: { enabled: true } }, null, 2), 'utf8')
  const { createMemoryHost } = require('../electron/memory/host.js')
  const port = await freePort()
  const host = createMemoryHost({
    configDir: dir,
    viewServerPath: path.join(__dirname, '..', 'electron', 'memory', 'view-server.js'),
    port
  })
  try {
    const st = host.status()
    assert.equal(st.ok, true)
    assert.equal(st.enabled, true)
    assert.equal(st.total, 0)
    assert.equal(st.consoleRunning, false)

    const w = host.runTool('memory_write', { action: 'project', id: '投票项目', name: '投票项目', summary: '内置宿主测试' })
    assert.equal(w.ok, true)
    const ev = host.runTool('memory_write', { action: 'event', project: '投票项目', prefix: 'BB', series: '修复 bug', summary: '内置写入' })
    assert.equal(ev.ok, true)
    assert.equal(ev.data.code, 'BB001')

    const q = host.runTool('memory_query', { project: '投票项目' })
    assert.equal(q.ok, true)
    assert.equal(q.data.events.length, 1)
    assert.equal(q.data.events[0].prefix, 'BB')

    const ctx = host.runTool('memory_context', { project: '投票项目' })
    assert.equal(ctx.ok, true)
    assert.equal(ctx.data.projects.length, 1)

    const recalled = host.runTool('memory_recall', { query: '投票项目上次修复的问题' })
    assert.equal(recalled.ok, true)
    assert.equal(recalled.data.projects[0].id, '投票项目')
    assert.ok(/相关项目/.test(recalled.data.text))

    const k = host.runTool('memory_knowledge', { action: 'upsert', domain: '前端', kind: '避错', body: '不要直接重装依赖' })
    assert.equal(k.ok, true)
    const kq = host.runTool('memory_knowledge', { action: 'query', domain: '前端' })
    assert.equal(kq.data.length, 1)

    const st2 = host.status()
    assert.equal(st2.total, 4, '项目 + 事件 + 知识 + 前缀表各一条')

    const started = await host.startConsole()
    assert.equal(started.ok, true, started.error || '')
    const health = await (await fetch(started.url + '/health')).json()
    assert.equal(health.ok, true)
    const snap = await (await fetch(started.url + '/api/snapshot')).json()
    assert.equal(snap.tables.find((x) => x.name === 'events').label, '事件')
    host.stopConsole()

    const off = host.setEnabled(false)
    assert.equal(off.enabled, false)
    const denied = host.runTool('memory_write', { action: 'event', prefix: 'P' })
    assert.equal(denied.ok, false)
    assert.match(denied.error, /已关闭/)
    const deniedQuery = host.runTool('memory_query', {})
    assert.equal(deniedQuery.ok, false)
  } finally {
    host.stop()
  }
})

/* ---------------------------------------------------------------- 权重网 */

test('权重网：中文按二元组切，近似度对称且自比为 1', () => {
  const tokens = weights.tokenize('投票项目的登录报错')
  assert.ok(tokens.includes('投票'), '中文应切出二元组')
  assert.ok(tokens.includes('登录'))
  assert.ok(!tokens.includes('的'), '虚词应被丢掉')

  const index = weights.buildIndex([
    { id: '投票项目', text: '投票项目 登录 报错 修复' },
    { id: '投票系统', text: '投票 系统 登录 权限' },
    { id: '记忆库', text: '记忆库 权重网 召回 项目' }
  ])
  const self = weights.cosine(index.vectors.get('投票项目'), index.vectors.get('投票项目'))
  assert.ok(Math.abs(self - 1) < 1e-9, '自比应为 1')
  const ab = weights.cosine(index.vectors.get('投票项目'), index.vectors.get('投票系统'))
  const ba = weights.cosine(index.vectors.get('投票系统'), index.vectors.get('投票项目'))
  assert.equal(ab, ba, '余弦应对称')
  const ac = weights.cosine(index.vectors.get('投票项目'), index.vectors.get('记忆库'))
  assert.ok(ab > ac, '共享「投票 / 登录」的应比只共享「项目」的更近')
})

test('权重网回忆：只取相关项目与事件，不把整库搬回来', () => {
  const { store } = fresh()
  try {
    store.write({ actor: ROLE.SUPER, action: 'project', name: '投票项目', summary: '投票系统的登录与权限' })
    store.write({ actor: ROLE.SUPER, action: 'project', name: '记忆库重构', summary: '记忆模块的项目权重网' })
    store.write({ actor: ROLE.SUPER, action: 'project', name: '官网改版', summary: '首页视觉与配色' })
    store.write({ actor: ROLE.SUPER, action: 'event', project: '投票项目', prefix: 'BB', summary: '修复登录报错：验证码校验顺序写反了' })
    store.write({ actor: ROLE.SUPER, action: 'event', project: '记忆库重构', prefix: 'P', summary: '项目权重网落地：tf-idf 与图扩散' })
    store.write({ actor: ROLE.SUPER, action: 'event', project: '官网改版', prefix: 'UI', summary: '首页换成深空配色' })

    const r = store.recall({ actor: ROLE.SUPER, query: '投票项目登录报错那次怎么修的' })
    assert.equal(r.ok, true)
    assert.equal(r.data.projects[0].id, '投票项目', '应优先命中投票项目')
    assert.ok(r.data.events.length >= 1)
    assert.ok(r.data.events.every((e) => e.project === '投票项目'), '事件应只来自命中的项目：' + JSON.stringify(r.data.events))
    assert.ok(!/配色/.test(r.data.text), '无关项目的内容不应出现')
    assert.ok(/相关项目/.test(r.data.text))
    assert.ok(r.stats.chars <= 900)

    /* 预算收紧时截断，而不是把剩下的硬塞进去 */
    const tight = store.recall({ actor: ROLE.SUPER, query: '投票项目登录报错', budget: 200 })
    assert.ok(tight.data.text.length <= 200, '应遵守字数预算：' + tight.data.text.length)
  } finally { store.close() }
})

test('权重网回忆：对不上就返回空，并把这次回忆记下来', () => {
  const { store } = fresh()
  try {
    store.write({ actor: ROLE.SUPER, action: 'project', name: '投票项目', summary: '投票系统' })
    store.write({ actor: ROLE.SUPER, action: 'event', project: '投票项目', prefix: 'BB', summary: '修复登录报错' })

    const r = store.recall({ actor: ROLE.SUPER, query: '量子计算芯片流片良率' })
    assert.equal(r.ok, true)
    assert.equal(r.data.projects.length, 0, '无关问题不应硬凑项目')
    assert.match(r.data.text, /没有找到/)

    const logged = store.db.prepare('SELECT COUNT(*) AS n FROM recall_log').get().n
    assert.equal(logged, 1, '每次回忆都应留一行记录')
  } finally { store.close() }
})

test('权重网：一起被回忆的两个项目会连边，共现越多权重越高', () => {
  const { store } = fresh()
  try {
    store.write({ actor: ROLE.SUPER, action: 'project', name: '甲项目', summary: '记忆 权重 召回' })
    store.write({ actor: ROLE.SUPER, action: 'project', name: '乙项目', summary: '记忆 权重 扩散' })
    const query = '记忆权重怎么召回'
    const pick = () => store.db.prepare(
      "SELECT * FROM project_links WHERE (a = '甲项目' AND b = '乙项目') OR (a = '乙项目' AND b = '甲项目')"
    ).get()

    const first = store.recall({ actor: ROLE.SUPER, query, limit: 2, minScore: 0.05 })
    assert.equal(first.data.projects.length, 2, '两个都应命中')
    const one = pick()
    assert.ok(one, '共现后应有一条边')
    assert.equal(one.hits, 1)
    const w1 = one.weight

    store.recall({ actor: ROLE.SUPER, query, limit: 2, minScore: 0.05 })
    const two = pick()
    assert.equal(two.hits, 2)
    assert.ok(two.weight > w1, `共现后权重应上升：${w1} → ${two.weight}`)
    assert.ok(two.cooccur > one.cooccur)
  } finally { store.close() }
})

test('项目镜像：同名不新建节点，重复同步只更新元数据', () => {
  const { store } = fresh()
  try {
    const a = store.syncProjects({ actor: ROLE.SUPER, projects: [{ name: '星界', rootPath: 'C:/Astral' }] })
    assert.equal(a.ok, true)
    assert.equal(a.data.added, 1)
    const b = store.syncProjects({
      actor: ROLE.SUPER,
      projects: [{ name: '星界', rootPath: 'C:/Astral2', summary: '桌面端' }]
    })
    assert.equal(b.data.added, 0)
    assert.equal(b.data.updated, 1)

    const rows = store.db.prepare('SELECT * FROM projects').all()
    assert.equal(rows.length, 1, '同名项目不应多出节点')
    assert.equal(rows[0].id, '星界')
    assert.equal(rows[0].folder_path, 'C:/Astral2')
    assert.equal(store.net().data.stats.nodes, 1)
  } finally { store.close() }
})

/* ---------------------------------------------------------------- 事件网 / 时间网 */

test('事件网：独立建表，相似事件连边、无关事件不连，项目名不参与打分', () => {
  const { store } = fresh()
  try {
    store.write({ actor: ROLE.SUPER, action: 'project', name: '甲项目', summary: '投票系统 登录' })
    store.write({ actor: ROLE.SUPER, action: 'project', name: '乙项目', summary: '官网视觉 配色' })
    store.write({ actor: ROLE.SUPER, action: 'event', project: '甲项目', prefix: 'BB', summary: '修复登录报错：验证码校验顺序写反' })
    store.write({ actor: ROLE.SUPER, action: 'event', project: '乙项目', prefix: 'BB', summary: '修复登录报错：会话兜底缺失' })
    store.write({ actor: ROLE.SUPER, action: 'event', project: '乙项目', prefix: 'UI', summary: '首页换成深空配色' })

    const net = store.net().data
    const events = store.db.prepare('SELECT id, summary FROM events').all()
    const similar = events.find((row) => /验证码/.test(row.summary))
    const unrelated = events.find((row) => /深空配色/.test(row.summary))
    assert.ok(net.eventLinks.length >= 1, '相似事件应该连边')
    assert.ok(net.eventLinks.some((link) => link.a === similar.id || link.b === similar.id))
    assert.ok(!net.eventLinks.some((link) => link.a === unrelated.id || link.b === unrelated.id),
      '不相关的事件不该连边')
    assert.ok(net.eventLinks.some((link) => link.lexical > 0), '事件边应记下内容近似度')

    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%links'")
      .all().map((row) => row.name).sort()
    assert.deepEqual(tables, ['event_links', 'kb_links', 'project_links'],
      '项目网 / 事件网 / 知识网各一张表，互不共用')
    assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM event_terms').get().n > 0)
    assert.ok(net.links.every((link) => !events.some((row) => row.id === link.a || row.id === link.b)),
      '项目网里不能出现事件 id')
    assert.ok(net.eventLinks.every((link) => events.some((row) => row.id === link.a)),
      '事件网里不能出现项目 id')
    assert.ok(net.events.length === 3 && net.stats.eventLinks >= 1)
  } finally { store.close() }
})

test('时间网：权重按时段的跨周重复计算，周记与提醒独立于两张权重网', () => {
  const { store } = fresh()
  try {
    const at = (month, day, hour) => new Date(2026, month, day, hour, 10).toISOString()
    store.write({ actor: ROLE.SUPER, action: 'project', name: '星界', summary: '桌面工作台' })
    /* 连续三个周一的 21 点，才是「到这个点该做这件事」的规律 */
    for (const stamp of [at(9, 26, 21), at(10, 2, 21), at(10, 9, 21)]) {
      store.write({
        actor: ROLE.SUPER, action: 'event', project: '星界', prefix: 'P',
        summary: '推进记忆库重构', startedAt: stamp
      })
    }

    const weeks = store.time({ actor: ROLE.SUPER, action: 'weeks' })
    assert.ok(weeks.data.length >= 3, '三周各一篇时间文档')
    assert.ok(weeks.data[0].week !== weeks.data[1].week)
    const doc = store.time({ actor: ROLE.SUPER, action: 'week', week: weeks.data[0].week })
    assert.match(doc.data.body, /条记录/)
    assert.match(doc.data.body, /星界/)
    assert.match(doc.data.body, /最集中的时段/)
    assert.ok(doc.data.stats.events >= 1)
    assert.equal(store.time({ actor: ROLE.SUPER, action: 'week', week: '1900-W01' }).ok, false)

    const habit = store.time({ actor: ROLE.SUPER, action: 'habit', at: at(10, 9, 21) })
    assert.equal(habit.data.weekday, 1)
    assert.equal(habit.data.hour, 21)
    assert.equal(habit.data.rows[0].key, '星界')
    assert.equal(habit.data.rows[0].sharePercent, 100, '时段内它占满')
    assert.equal(habit.data.rows[0].weeks, 3, '跨了三个不同的周')
    /* 3 周 → 可靠度 3/5 = 0.6，时间置信 60%，不能因为只有一次爆发就报 100% */
    assert.equal(habit.data.rows[0].percent, 60)
    assert.equal(habit.data.rows[0].reliability, 0.6)
    assert.equal(habit.data.found, true)

    const suggest = store.time({ actor: ROLE.SUPER, action: 'suggest', at: at(10, 9, 21) })
    assert.equal(suggest.data.found, true)
    assert.equal(suggest.data.weeks, 3)
    assert.match(suggest.data.text, /连续 3 周/)
    assert.match(suggest.data.text, /要不要我先起个头/)
    assert.match(suggest.data.prompt, /星界/)
    assert.ok(suggest.data.percent >= 50)

    const quiet = store.time({ actor: ROLE.SUPER, action: 'suggest', at: at(10, 11, 3) })
    assert.equal(quiet.data.found, false, '没有样本的时段不该硬编一条提醒')

    /* 时间文档读的是事件时间戳，不是项目网 / 事件网的打分结果 */
    const net = store.net().data
    assert.ok(net.time.slots >= 1 && net.time.weeks >= 3)
    assert.equal(net.stats.timeSlots, net.time.slots)
    assert.ok(net.stats.weeks >= 3)
  } finally { store.close() }
})

test('时间网：同一时段、同一周刷十条也不算习惯（权重强相关于时间）', () => {
  const { store } = fresh()
  try {
    const stamp = new Date(2026, 10, 9, 21, 10).toISOString()
    store.write({ actor: ROLE.SUPER, action: 'project', name: '星界', summary: '桌面工作台' })
    for (let i = 0; i < 6; i++) {
      store.write({
        actor: ROLE.SUPER, action: 'event', project: '星界', prefix: 'P',
        summary: '连着写第 ' + i + ' 条', startedAt: stamp
      })
    }
    const habit = store.time({ actor: ROLE.SUPER, action: 'habit', at: stamp })
    assert.equal(habit.data.rows[0].hits, 6, '事件条数照实记')
    assert.equal(habit.data.rows[0].weeks, 1, '但只覆盖了一周')
    assert.equal(habit.data.rows[0].reliability, 0.3333)
    assert.ok(habit.data.rows[0].percent < 40, '一次爆发不该拿到高时间置信：' + habit.data.rows[0].percent)
    const suggest = store.time({ actor: ROLE.SUPER, action: 'suggest', at: stamp })
    assert.equal(suggest.data.found, false, '跨周样本不足，不提醒')
    assert.match(suggest.data.reason, /跨周规律/)
  } finally { store.close() }
})

test('控制台：星图连线写百分比，/api/time 给出周记与 7×24 时段格', async () => {
  const { dir, store } = fresh()
  try {
    store.write({ actor: ROLE.SUPER, action: 'project', name: '甲项目', summary: '记忆库权重网的项目连边' })
    store.write({ actor: ROLE.SUPER, action: 'project', name: '乙项目', summary: '记忆库权重网的事件连边' })
    store.write({ actor: ROLE.SUPER, action: 'event', project: '甲项目', prefix: 'P', summary: '修复登录报错：验证码校验顺序写反' })
    store.write({ actor: ROLE.SUPER, action: 'event', project: '乙项目', prefix: 'P', summary: '修复登录报错：会话兜底缺失' })
  } finally { store.close() }

  const port = await freePort()
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'electron', 'memory', 'view-server.js')], {
    env: { ...process.env, MEMORY_CONFIG_DIR: dir, MEMORY_VIEW_PORT: String(port), MEMORY_ENABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const base = 'http://127.0.0.1:' + port
  try {
    await waitFor(async () => (await fetch(base + '/health')).ok)
    const map = await (await fetch(base + '/api/starmap')).json()
    const weighted = map.edges.filter((edge) => edge.kind === 'weight')
    assert.ok(weighted.length >= 2, '项目边与事件边都应该画出来：' + JSON.stringify(weighted))
    assert.ok(weighted.every((edge) => edge.label === edge.percent + '%' && edge.percent > 0 &&
      typeof edge.weight === 'number'), '连线上要写清百分比与权重')
    assert.ok(weighted.some((edge) => edge.from.startsWith('p:') && edge.to.startsWith('p:')))
    assert.ok(weighted.some((edge) => edge.from.startsWith('e:') && edge.to.startsWith('e:')))
    assert.equal(map.stats.projectLinks + map.stats.eventLinks, weighted.length)

    const time = await (await fetch(base + '/api/time')).json()
    assert.equal(time.ok, true)
    assert.equal(time.grid.length, 168, '7 天 × 24 小时')
    assert.ok(time.grid.some((cell) => cell.count > 0 && cell.top && cell.top.percent > 0))
    assert.ok(time.weeks.length >= 1)
    assert.ok(time.week && /条记录/.test(time.week.body))
    assert.ok(time.suggest && typeof time.suggest.found === 'boolean')
    assert.ok(time.phase && typeof time.phase.found === 'boolean', '/api/time 应带当前阶段判断')
    assert.ok(time.phases && Array.isArray(time.phases.probs), '/api/time 应带阶段概率表')
    const picked = await (await fetch(base + '/api/time?week=' + encodeURIComponent(time.weeks[0].week))).json()
    assert.equal(picked.week.week, time.weeks[0].week)
    assert.equal((await fetch(base + '/api/time', { method: 'POST' })).status, 405, '时间接口只读')
    const view = await (await fetch(base + '/api/nodeview?kind=project&id=' + encodeURIComponent('甲项目'))).json()
    assert.equal(view.ok, true)
    assert.ok(Array.isArray(view.data.nodes) && view.data.nodes.length >= 1)
    assert.ok(view.data.nodes[0].group === 'center', '单星位图要有中心节点')
    assert.ok(Array.isArray(view.data.edges), '位图要带权重连边')
  } finally { child.kill() }
})

test('内置工具：memory_time 与三网体检可经宿主调用', async () => {
  const dir = tempDir()
  const { createMemoryHost } = require('../electron/memory/host.js')
  const host = createMemoryHost({ configDir: dir })
  try {
    host.runTool('memory_write', { action: 'project', name: '星界', summary: '记忆库' })
    const mondayStamps = [
      new Date(2026, 9, 26, 21, 10),
      new Date(2026, 10, 2, 21, 10),
      new Date(2026, 10, 9, 21, 10)
    ].map((date) => date.toISOString())
    for (const startedAt of mondayStamps) {
      host.runTool('memory_write', {
        action: 'event', project: '星界', prefix: 'P', summary: '推进时间网', startedAt
      })
    }
    const at = new Date(2026, 10, 9, 21, 0).toISOString()
    const habit = host.runTool('memory_time', { action: 'habit', at })
    assert.equal(habit.ok, true)
    assert.equal(habit.data.found, true)
    assert.equal(habit.data.rows[0].weeks, 3, '三条事件要落在三个不同的周')
    const suggest = host.time({ action: 'suggest', at })
    assert.equal(suggest.data.found, true)
    assert.equal(suggest.data.weeks, 3)
    assert.equal(suggest.data.projectName, '星界')
    const phaseRes = host.runTool('memory_time', { action: 'phase' })
    assert.equal(phaseRes.ok, true)
    assert.ok(typeof phaseRes.data.found === 'boolean')
    const phasesRes = host.runTool('memory_time', { action: 'phases' })
    assert.ok(Array.isArray(phasesRes.data.probs))
    const net = host.net()
    assert.ok(net.data.eventLinks !== undefined && net.data.events.length === 3)
    assert.ok(net.data.time.phaseEvents >= 3, '三网体检应带上进程轨迹计数')
    assert.ok(net.data.time.slots >= 1 && net.data.time.weeks >= 1)
    assert.equal(net.data.stats.timeSlots, net.data.time.slots)
  } finally {
    host.stop()
  }
})

test('时间网升级：v4 的时段表补列后可重建，旧缓存行不残留', () => {
  const dir = tempDir()
  const file = path.join(dir, 'memory', 'memory.db')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE time_slots (
    weekday INTEGER NOT NULL, hour INTEGER NOT NULL, key TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'project', weight REAL NOT NULL,
    hits INTEGER NOT NULL, last_at TEXT, PRIMARY KEY (weekday, hour, key)
  )`)
  old.exec("INSERT INTO time_slots (weekday, hour, key, kind, weight, hits) VALUES (1, 21, '旧缓存', 'project', 0.9, 3)")
  old.exec('PRAGMA user_version = 4')
  old.close()

  const store = createMemoryStore({ configDir: dir })
  try {
    const cols = store.db.prepare('PRAGMA table_info(time_slots)').all().map((row) => row.name)
    assert.ok(['share', 'reliability', 'weeks'].every((col) => cols.includes(col)), '升级应补齐三列')
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 15)
    store.write({ actor: ROLE.SUPER, action: 'project', name: '星界', summary: '升级验证' })
    store.write({
      actor: ROLE.SUPER, action: 'event', project: '星界', prefix: 'P', summary: '写一条',
      startedAt: new Date(2026, 10, 9, 21, 10).toISOString()
    })
    const habit = store.time({ actor: ROLE.SUPER, action: 'habit', at: new Date(2026, 10, 9, 21, 0).toISOString() })
    assert.equal(habit.data.rows[0].weeks, 1)
    assert.equal(habit.data.rows[0].percent, 33, '单周样本不该继承旧表的 90% 置信')
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM time_slots WHERE key = '旧缓存'").get().n, 0,
      '派生缓存整体重算，旧行不残留')
  } finally { store.close() }
})

test('进程层：阶段由事件进程判定，指令类型带条件概率与起始点', () => {
  const { store } = fresh()
  try {
    store.write({ actor: ROLE.SUPER, action: 'project', name: '星界', summary: '桌面工作台' })
    /* 8 周、每周一 21 点各一条：前 3 周新增，后 5 周修复 */
    for (let w = 0; w < 8; w++) {
      store.write({
        actor: ROLE.SUPER, action: 'event', project: '星界', prefix: 'P',
        summary: w < 3 ? '新增登录页' : '修复登录报错',
        startedAt: new Date(2026, 8, 14 + w * 7, 21, 10).toISOString()
      })
    }
    const phase = store.time({
      actor: ROLE.SUPER, action: 'phase', at: new Date(2026, 10, 9, 21, 0).toISOString()
    }).data
    assert.equal(phase.found, true)
    assert.equal(phase.phase, '打磨', '第 8 条应走到打磨阶段')
    assert.equal(phase.intents[0].intent, '修复')
    assert.equal(phase.intents[0].probability, 1)
    assert.ok(phase.intents[0].onsetSeq >= 6, '应记下这类指令从项目第几条开始')
    assert.ok(phase.arrival && /进入「打磨」/.test(phase.arrival.text), '应回答怎么走到这一步')
    assert.match(phase.ask, /这个阶段 100% 是「修复」类指令/)
    assert.match(phase.ask, /要不要我先按这个方向起个头/)

    const all = store.time({ actor: ROLE.SUPER, action: 'phases' }).data
    assert.equal(all.events, 8)
    assert.ok(all.probs.some((row) => row.phase === '启动' && row.intent === '新增'))
    assert.ok(all.transitions.some((row) => row.from_phase === '启动' && row.to_phase === '推进'))
    const scoped = store.db.prepare('SELECT * FROM phase_probs WHERE weekday <> -1').all()
    assert.ok(scoped.length > 0, '应有精确到时段的条件行')
    assert.ok(scoped.every((row) => row.weight > 0 && row.weight <= 1), '时段概率应向基线收缩')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM phase_events').get().n, 8)

    /* 事件网不受进程层影响：仍只有事件之间的连边 */
    const net = store.net().data
    assert.ok(net.eventLinks.every((link) => !['启动', '打磨'].includes(link.a)))
  } finally { store.close() }
})

test('进程层：概率随近期变化漂移，阶段样本不足不开口', () => {
  const { store } = fresh()
  try {
    /* 6 个项目各 5 条；每个项目的第 3–5 条都落在「推进」阶段。
       前 3 个项目（8–10 周前）推进阶段只做新增，后 3 个（近 3 周）只做修复。 */
    const starts = [
      new Date(2026, 6, 27), new Date(2026, 7, 11), new Date(2026, 7, 25),
      new Date(2026, 9, 12), new Date(2026, 9, 26), new Date(2026, 10, 2)
    ]
    starts.forEach((start, index) => {
      const name = '进程项目' + index
      store.write({ actor: ROLE.SUPER, action: 'project', name, summary: '进程验证' })
      for (let i = 0; i < 5; i++) {
        const at = new Date(start.getTime() + i * 86400000)
        at.setHours(21, 10, 0, 0)
        store.write({
          actor: ROLE.SUPER, action: 'event', project: name, prefix: 'P',
          summary: i < 2 ? '搭建基础框架' : (index < 3 ? '新增登录页' : '修复登录报错'),
          startedAt: at.toISOString()
        })
      }
    })
    const all = store.time({ actor: ROLE.SUPER, action: 'phases' }).data
    const advancing = all.probs.filter((row) => row.phase === '推进')
    const fix = advancing.find((row) => row.intent === '修复')
    const add = advancing.find((row) => row.intent === '新增')
    assert.ok(fix && add, '推进阶段应同时见过两类指令')
    assert.ok(fix.weight > add.weight, '近因加权后，近期习惯应占更高概率')
    assert.ok(fix.trend > 0.05, '修复类指令应显示正在变多：' + fix.trend)
    assert.ok(add.trend < -0.05, '新增类指令应显示正在变少：' + add.trend)
  } finally { store.close() }

  const sparse = fresh()
  try {
    sparse.store.write({ actor: ROLE.SUPER, action: 'project', name: '小项目', summary: '样本不足' })
    sparse.store.write({ actor: ROLE.SUPER, action: 'event', project: '小项目', prefix: 'P', summary: '新增登录页' })
    const phase = sparse.store.time({ actor: ROLE.SUPER, action: 'phase' }).data
    assert.equal(phase.found, false, '阶段样本不足时不该硬编一条询问')
    assert.match(phase.reason, /样本/)
  } finally { sparse.store.close() }
})

test('回忆走权重网：上下文不再带正文，brief 只给权重与最近触发时间', () => {
  const { store } = fresh()
  try {
    for (const [name, summary] of [
      ['甲项目', '记忆库权重网项目连边'],
      ['乙项目', '记忆库权重网项目连边'],
      ['丙项目', '记忆库权重网首页配色']
    ]) store.write({ actor: ROLE.SUPER, action: 'project', name, summary })
    store.write({
      actor: ROLE.SUPER, action: 'event', project: '甲项目', prefix: 'BB',
      summary: '修复登录报错：验证码顺序写反'
    })

    const ctx = store.getContext({ actor: ROLE.SUPER })
    assert.equal(ctx.data.events.length, 0, '不再组装全量事件正文')
    assert.equal(ctx.data.hardContext.blocks.length, 4, '常驻四块仍在')
    assert.ok(Array.isArray(ctx.data.net) && ctx.data.net.length > 0)
    assert.ok(ctx.data.net.some((node) => node.lastTrigger && node.lastTrigger.at))

    const brief = store.recall({ actor: ROLE.SUPER, query: '记忆库权重网项目连边怎么改的' })
    assert.equal(brief.data.mode, 'brief')
    assert.match(brief.data.text, /权重/)
    assert.match(brief.data.text, /最近触发/)
    assert.ok(!/验证码顺序写反/.test(brief.data.text), 'brief 不拼事件正文')
    assert.ok(brief.data.events.length >= 1, '结构化结果仍可按需取用')
    assert.ok(Array.isArray(brief.data.net.near) && Array.isArray(brief.data.net.far))

    const full = store.recall({
      actor: ROLE.SUPER, query: '记忆库权重网项目连边怎么改的', mode: 'full'
    })
    assert.equal(full.data.mode, 'full')
    assert.match(full.data.text, /【相关事件】/, '显式 full 才拼正文')
  } finally { store.close() }
})

test('单节点权重位图：近/远分组、线上百分比与最近触发时间', () => {
  const { store } = fresh()
  try {
    for (const [name, summary] of [
      ['甲项目', '记忆库权重网项目连边'],
      ['乙项目', '记忆库权重网项目连边'],
      ['丙项目', '记忆库权重网首页配色']
    ]) store.write({ actor: ROLE.SUPER, action: 'project', name, summary })
    store.write({
      actor: ROLE.SUPER, action: 'event', project: '甲项目', prefix: 'BB',
      summary: '修复登录报错：验证码顺序写反'
    })

    const view = store.nodeView({ kind: 'project', id: '甲项目', near: 0.25 })
    assert.equal(view.ok, true)
    assert.equal(view.data.center.label, '甲项目')
    assert.equal(view.data.stats.near, 1)
    assert.ok(view.data.stats.far >= 1)
    assert.ok(view.data.nodes.some((n) => n.group === 'near'))
    assert.ok(view.data.nodes.some((n) => n.group === 'far'))
    assert.ok(view.data.edges.length >= 2)
    assert.ok(view.data.edges.every((e) => e.label === e.percent + '%' && e.percent > 0))
    assert.ok(view.data.trigger && view.data.trigger.at, '位图要带上最近一次触发时间')

    const ev = store.db.prepare('SELECT id FROM events LIMIT 1').get()
    const evView = store.nodeView({ kind: 'event', id: ev.id })
    assert.equal(evView.ok, true)
    assert.equal(evView.data.kind, 'event')
    assert.equal(evView.data.nodes[0].group, 'center')
    assert.equal(store.nodeView({ kind: 'project' }).ok, false, '缺 id 应明确拒绝')
  } finally { store.close() }
})

test('探子摘要写权重网：纯文本与 JSON 两种，写入后三张网自动重建', () => {
  const { store } = fresh()
  try {
    const plain = store.commitScout({
      actor: ROLE.SUPER, project: '星界', text: '# 摘要\n桌面工作台，记忆与协作', rootPath: 'C:/Astral'
    })
    assert.equal(plain.ok, true)
    assert.equal(plain.data.plan, false)
    assert.equal(plain.data.projects, 1)
    assert.equal(plain.data.events, 1)
    const row = store.db.prepare("SELECT * FROM projects WHERE name = '星界'").get()
    assert.ok(row && /桌面工作台/.test(row.summary))
    assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM project_terms').get().n > 0, '写入后应重建词向量')

    const plan = JSON.stringify({
      nodes: [
        { name: '投票项目', summary: '投票系统登录与权限', events: [{ prefix: 'BB', summary: '修复登录报错' }] },
        { name: '官网改版', summary: '首页视觉与配色', events: [{ prefix: 'UI', summary: '首页换成深空配色' }] }
      ]
    })
    const planned = store.commitScout({ actor: ROLE.SUPER, project: '星界', text: plan })
    assert.equal(planned.ok, true)
    assert.equal(planned.data.plan, true)
    assert.equal(planned.data.projects, 2)
    assert.equal(planned.data.events, 2)
    assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n >= 3)
    const net = store.net().data
    assert.ok(net.stats.nodes >= 3, '项目网应含三个节点')
    assert.ok(net.time.phaseEvents >= 3, '进程轨迹应随事件重建')
    assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM event_links').get().n >= 0)
  } finally { store.close() }
})

test('近期观察：到饭点生成具体询问，且不污染事件与时段权重', () => {
  const { store } = fresh()
  try {
    store.write({ actor: ROLE.SUPER, action: 'project', name: '星界', summary: '桌面工作台' })
    const eventsBefore = store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n
    const slotsBefore = store.db.prepare('SELECT COUNT(*) AS n FROM time_slots').get().n
    const at = new Date(2026, 10, 10, 12, 0).toISOString()
    const wrote = store.time({
      actor: ROLE.SUPER, action: 'observe',
      text: '今天想吃火锅', kind: 'meal', source: 'chat', at
    })
    assert.equal(wrote.ok, true)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, eventsBefore, '观察不能进 events')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM time_slots').get().n, slotsBefore, '观察不能改时段权重')

    const suggest = store.time({ actor: ROLE.SUPER, action: 'suggest', at }).data
    assert.equal(suggest.found, true)
    assert.equal(suggest.via, 'observation')
    assert.match(suggest.text, /要不要提前帮你点一份/)
    assert.equal(suggest.observations.length, 1)
    assert.match(suggest.prompt, /不要自动下单/)

    const list = store.time({ actor: ROLE.SUPER, action: 'observations', at }).data
    assert.equal(list.length, 1)
    assert.equal(list[0].kind, 'meal')
    assert.equal(list[0].source, 'chat')

    const night = store.time({
      actor: ROLE.SUPER, action: 'suggest', at: new Date(2026, 10, 10, 3, 0).toISOString()
    }).data
    assert.equal(night.found, false, '非饭点不该因吃饭打算开口')
    assert.equal(store.time({ actor: ROLE.SUPER, action: 'observe', text: '' }).ok, false)
  } finally { store.close() }
})

test('知识网：索引只回摘要、正文按需取，打开会抬高权重', () => {
  const { store } = fresh()
  try {
    const entries = [
      {
        source: 'kb', projectId: 'p1', entryId: 'M-001', kind: '方法', domain: '构建',
        entry: {
          title: '打包前先清缓存',
          trigger: 'Electron 打包报找不到模块时',
          steps: ['删 dist', '删 node_modules/.cache', '重装'],
          why: '缓存里的旧 asar 会覆盖新文件'
        }
      },
      {
        source: 'kb', projectId: 'p1', entryId: 'P-001', kind: '避错', domain: '构建',
        entry: {
          title: '不要用 rm -rf 清 dist',
          trigger: '想清理构建产物时',
          steps: ['改用 npm run clean'],
          why: '会把未提交的构建脚本一起删掉',
          symptoms: 'git status 里突然少文件'
        }
      },
      { source: 'kb', projectId: 'p1', entryId: 'M-002', kind: '方法', domain: '测试', entry: { title: '只有标题的条目' } }
    ]
    const sync = store.kb({ action: 'sync', entries })
    assert.equal(sync.data.added, 3)
    assert.ok(sync.data.terms > 0, '应当建立词向量')

    /* 检索只回摘要：正文四段一个都不该出现 */
    const hit = store.kb({ action: 'search', project: 'p1', query: '打包报找不到模块' })
    assert.ok(hit.data.entries.length >= 1)
    const first = hit.data.entries[0]
    assert.equal(first.id, 'M-001')
    assert.equal(first.steps, undefined, '检索不该带回正文')
    assert.ok(first.digest.length > 0, '应当带一行摘要')
    assert.ok(first.percent > 0 && first.percent <= 100, '权重应换算成百分比')

    /* 打开 4 次 → 权重上升；只有标题的条目权重垫底 */
    const before = store.kb({ action: 'map' }).data.nodes.find((n) => n.id === 'M-001').weight
    for (let i = 0; i < 4; i++) store.kb({ action: 'get', project: 'p1', id: 'M-001' })
    const after = store.kb({ action: 'map' }).data.nodes.find((n) => n.id === 'M-001').weight
    assert.ok(after > before, '打开应当抬高权重')
    const bare = store.kb({ action: 'map' }).data.nodes.find((n) => n.id === 'M-002')
    assert.ok(bare.weight < after, '只有标题的条目不该排在全写的上面')
    assert.ok(bare.completeness < 0.6, '完整度要如实反映缺段')
  } finally { store.close() }
})

test('知识网：光搜不用会降权，明确反馈立刻改权重', () => {
  const { store } = fresh()
  try {
    store.kb({
      action: 'sync',
      entries: [{
        source: 'kb', projectId: 'p1', entryId: 'P-001', kind: '避错', domain: '构建',
        entry: {
          title: '不要用 rm -rf 清 dist',
          trigger: '想清理构建产物时',
          steps: ['改用 npm run clean'],
          why: '会把未提交的构建脚本一起删掉',
          symptoms: 'git status 里突然少文件'
        }
      }]
    })
    const start = store.kb({ action: 'map' }).data.nodes[0].weight
    for (let i = 0; i < 12; i++) store.kb({ action: 'search', project: 'p1', query: '清理构建产物 dist' })
    const noisy = store.kb({ action: 'map' }).data.nodes[0].weight
    assert.ok(noisy < start, '反复被搜到却没人打开，权重应当下降')

    /* 明确说没用：再降一档 */
    store.kb({ action: 'feedback', project: 'p1', id: 'P-001', useful: false })
    store.kb({ action: 'feedback', project: 'p1', id: 'P-001', useful: false })
    const bad = store.kb({ action: 'map' }).data.nodes[0].weight
    assert.ok(bad < noisy, '明确说没用应当再降')

    /* 反过来：说有用会抬回来 */
    for (let i = 0; i < 4; i++) store.kb({ action: 'feedback', project: 'p1', id: 'P-001', useful: true })
    const good = store.kb({ action: 'map' }).data.nodes[0].weight
    assert.ok(good > bad, '说有用应当抬回来')
  } finally { store.close() }
})

test('知识网：按作用域同步，删条目后索引跟着删', () => {
  const { store } = fresh()
  try {
    const A = (id, title) => ({ source: 'kb', projectId: 'p1', entryId: id, kind: '方法', domain: '构建', entry: { title, trigger: '打包时', steps: ['先清缓存'], why: '避免旧产物' } })
    const B = (id, title) => ({ source: 'kb', projectId: 'p2', entryId: id, kind: '方法', domain: '测试', entry: { title, trigger: '验证时', steps: ['跑探针'], why: '真界面才算数' } })
    store.kb({ action: 'sync', entries: [A('M-001', '清缓存'), A('M-002', '别删 dist')] })
    store.kb({ action: 'sync', entries: [B('M-001', '跑探针'), B('M-002', '截图对比')] })
    assert.equal(store.kb({ action: 'map' }).data.nodes.length, 4, '两个项目各两条')

    /* 只同步 p1 的一条：p1 的 M-002 该消失，p2 的两条必须原样保留 */
    store.kb({ action: 'sync', entries: [A('M-001', '清缓存')] })
    const nodes = store.kb({ action: 'map' }).data.nodes
    assert.equal(nodes.length, 3)
    assert.equal(nodes.filter((n) => n.projectId === 'p2').length, 2, '别的项目不该被连带清掉')
    assert.ok(!nodes.some((n) => n.projectId === 'p1' && n.id === 'M-002'))

    /* 全局知识单独一个作用域，能与项目知识共存 */
    store.kb({
      action: 'sync',
      entries: [{ source: 'global', entryId: 'g-1', kind: '决策', domain: '产品', entry: { title: '默认用中文回答', steps: ['先中文'], why: '用户环境' } }]
    })
    const all = store.kb({ action: 'map' }).data.nodes
    assert.equal(all.length, 4)
    assert.equal(all.filter((n) => n.source === 'global').length, 1)
  } finally { store.close() }
})

test('收件箱：入库幂等、四档分流，只有该记的才进观察池', () => {
  const { store } = fresh()
  try {
    store.inbox({ action: 'saveChannel', id: 'wx1', kind: 'wechat-personal', label: '微信', enabled: true, config: {} })
    const first = store.inbox({
      action: 'ingest',
      id: 'wx1',
      messages: [
        { text: '在吗？有个事找你', chatId: 'g1', chatName: '三人群', senderName: '老张', mentionsMe: true, at: '2026-11-11T10:00:00Z' },
        { text: '今晚一起吃饭吗？我订个位子', chatId: 'g1', chatName: '三人群', senderName: '老张', at: '2026-11-11T10:01:00Z' },
        { text: '这个打包报错是缓存问题，删 dist 就好', chatId: 'g2', chatName: '技术群', senderName: '小李', at: '2026-11-11T10:02:00Z' },
        { text: '哈哈', chatId: 'g1', chatName: '三人群', senderName: '老王', at: '2026-11-11T10:03:00Z' }
      ]
    })
    assert.equal(first.data.inserted, 4)
    const routes = store.inbox({ action: 'messages', limit: 10 }).data.map((m) => m.route)
    assert.deepEqual(routes.sort(), ['alert', 'archive', 'knowledge', 'observe'].sort())

    /* 再来一次同样的批量：一条都不该新增 */
    const again = store.inbox({
      action: 'ingest',
      id: 'wx1',
      messages: [{ text: '在吗？有个事找你', chatId: 'g1', chatName: '三人群', senderName: '老张', mentionsMe: true, at: '2026-11-11T10:00:00Z' }]
    })
    assert.equal(again.data.inserted, 0, '同一条消息重复到达不该新增')
    assert.equal(again.data.duplicates, 1)

    /* 观察池只该有 alert + observe 两条；归档与技术讨论不许影响时段权重 */
    const obs = store.db.prepare("SELECT text FROM observations WHERE source = 'intake'").all()
    assert.equal(obs.length, 2)
    assert.ok(obs.some((row) => row.text.includes('三人群')))
    assert.ok(!obs.some((row) => row.text.includes('删 dist')))

    const threads = store.inbox({ action: 'threads' }).data
    assert.equal(threads.length, 2, '两个会话各一行')
    assert.equal(threads.find((t) => t.name === '三人群').total, 3)
  } finally { store.close() }
})

test('渠道契约：所有类型共用一套能力位与字段，必填拦住、密钥不被清空', async () => {
  const kinds = catalog.list()
  assert.ok(kinds.length >= 6, '至少覆盖微信个人 / 企业微信 / QQ 个人 / QQ 官方 / 转发 / Webhook')
  for (const kind of kinds) {
    assert.ok(kind.id && kind.label, '每种渠道都要有 id 与名字')
    assert.ok(kind.capabilities && typeof kind.capabilities.receive === 'boolean', kind.id + ' 要声明能不能收')
    assert.ok(Array.isArray(kind.fields), kind.id + ' 要有配置项定义')
    assert.ok(kind.risk && kind.risk.level, kind.id + ' 要有风险等级')
  }

  const { store, dir } = fresh()
  const intake = createIntake({
    configDir: dir,
    secretBox: memorySecretBox(),
    store: { inbox: (input) => store.inbox(input) }
  })
  try {
    const missing = intake.saveChannel({ kind: 'wecom', label: '企业微信' })
    assert.equal(missing.ok, false, '缺必填不该保存成功')
    assert.match(missing.error, /还缺/)

    const saved = intake.saveChannel({
      kind: 'wecom', label: '企业微信', values: {
        corpId: 'ww123', agentId: '1000002', secret: 's3cret', callbackToken: 'tok', aesKey: 'k'.repeat(43)
      }
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.channel.config.corpId, 'ww123')
    assert.ok(saved.channel.secretsSet.includes('secret'), '密钥应当单独记着，不混进 config')
    assert.equal(saved.channel.config.secret, undefined, 'config 里不能出现密钥')

    /* 再保存一次、密码留空：旧密钥必须还在 */
    const again = intake.saveChannel({
      id: saved.channel.id,
      kind: 'wecom', label: '企业微信', values: { corpId: 'ww123', agentId: '1000002', secret: '', callbackToken: '', aesKey: '' }
    })
    assert.equal(again.ok, true)
    assert.ok(again.channel.secretsSet.includes('secret'), '留空保存不该抹掉已设置的密钥')

    /* Webhook 留空令牌要自动生成，否则谁都能往里灌 */
    const hook = intake.saveChannel({ kind: 'webhook', label: '事件' })
    assert.ok(hook.channel.secretsSet.includes('token'))
    assert.match(intake.hookUrl(hook.channel.id), /token=/)
  } finally {
    await intake.shutdown()
    store.close()
  }
})

test('接入解析：字段认不出就整条当正文，错令牌被拒', () => {
  const parsed = httpAdapter.parse({ kind: 'webhook' }, '服务器挂了', {})
  assert.equal(parsed[0].text, '服务器挂了')

  const json = httpAdapter.parse({ kind: 'webhook' }, JSON.stringify({
    messages: [{ text: 'a', chat: 'c1' }, { text: 'b', chat: 'c2' }]
  }), {})
  assert.equal(json.length, 2, '一次推多条要能拆开')

  const relay = httpAdapter.parse({ kind: 'notify-relay' }, JSON.stringify({ title: '微信', text: '张三: 在吗' }), {})
  assert.match(relay[0].text, /微信｜张三: 在吗/)

  const channel = { kind: 'webhook', config: {} }
  const secrets = { token: 'abc123' }
  assert.equal(httpAdapter.authorize(channel, secrets, { 'x-astral-token': 'abc123' }, {}).ok, true)
  assert.equal(httpAdapter.authorize(channel, secrets, {}, { token: 'nope' }).ok, false)

  const verdict = normalize.classify({ text: '在吗？这个必须今天处理', scope: 'group', mentionsMe: true })
  assert.equal(verdict.route, 'alert')
  const quiet = normalize.classify({ text: '哈哈哈', scope: 'group', mentionsMe: false })
  assert.equal(quiet.route, 'archive', '群里闲聊一律归档')
})

test('消息接入：一开渠道就进首流，AI 不必猜也知道自己在听什么', () => {
  const { store } = fresh()
  try {
    /* 没开渠道：一段都不占，省下每一轮的成本 */
    assert.equal(store.inbox({ action: 'brief' }).data.text, '')
    assert.ok(!store.hardContext.prompt().data.text.includes('### 消息接入（实时）'))

    store.inbox({ action: 'saveChannel', id: 'w1', kind: 'wecom', label: '企业微信', enabled: true, config: {} })
    const opened = store.inbox({ action: 'brief' }).data
    assert.match(opened.text, /已接 1 条渠道：企业微信/)
    assert.ok(opened.text.length <= 240, '首流这一段必须压得住：' + opened.text.length)

    store.inbox({
      action: 'ingest',
      id: 'w1',
      messages: [{
        text: '小王，明天下午三点前把方案整理一份发我',
        chatId: 'g1', chatName: '产品群', senderName: '张经理', mentionsMe: true,
        at: new Date().toISOString()
      }]
    })
    const brief = store.inbox({ action: 'brief' }).data
    assert.match(brief.text, /外面有 1 条在等你：张经理/)
    assert.match(brief.text, /memory_inbox action=recent route=alert/, '要告诉 AI 从哪个动作取全文')

    /* 真进得到常驻上下文，而且排在安全状态前面 */
    const prompt = store.hardContext.prompt().data.text
    assert.match(prompt, /### 消息接入（实时）/)
    const at = prompt.indexOf('### 消息接入（实时）')
    const sec = prompt.indexOf('### 安全状态（实时）')
    if (sec >= 0) assert.ok(at < sec, '接入状态在前，安全状态在后')
  } finally { store.close() }
})

;(async () => {
  for (const item of tests) {
    const mark = tempDirs.length
    try {
      await item.fn()
    } finally {
      sweep(mark)
    }
    passed += 1
    console.log(`ok ${passed} - ${item.name}`)
  }
  console.log(`\n${passed} tests passed`)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
