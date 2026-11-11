'use strict'

/* 星界核心单元测试：不启动 Electron，只验证主进程纯逻辑。 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createJobStore } = require('../electron/jobs.js')
const { createPermissionAuthority, intersectPermissions } = require('../electron/permission-authority.js')
const { normalizePluginManifest, LEGACY_RUNTIME_ERROR } = require('../electron/plugin-manifest.js')
const { createToolApprovals, fingerprint } = require('../electron/tool-approval.js')
const { createMcpRegistry, flattenContent, saveMcpImage } = require('../electron/mcp-client.js')
const { scanPlugin } = require('./migrate-plugins.js')
const { mergeUsage, costOf } = require('../electron/usage.js')

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'astral-test-'))
}

function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

const tests = []
let passed = 0
function test (name, fn) {
  tests.push({ name, fn })
}

test('job store persists steps and marks running as interrupted after restart', () => {
  const dir = tempDir()
  try {
    const store = createJobStore({ configDir: dir })
    const created = store.create({
      title: '测试任务',
      projectId: 'p1',
      steps: [{ prompt: '第一步' }, { prompt: '第二步' }]
    })
    assert.equal(created.ok, true)
    assert.equal(created.job.steps.length, 2)
    const steps = created.job.steps.map((step, index) => index === 0 ? { ...step, status: 'done', result: 'ok' } : step)
    store.update(created.job.id, { status: 'running', currentStep: 1, steps: steps.map((step, index) => index === 1 ? { ...step, status: 'running', attempts: 2 } : step) })
    const reopened = createJobStore({ configDir: dir })
    const job = reopened.get(created.job.id)
    assert.equal(job.status, 'interrupted')
    assert.equal(job.currentStep, 1)
    assert.deepEqual(job.steps.map((step) => step.status), ['done', 'cancelled'])
    assert.equal(job.steps[1].attempts, 2)
    reopened.update(job.id, { schedule: { repeat: 'daily', time: '09:00' }, nextRunAt: 1700000000000 })
    assert.deepEqual(reopened.get(job.id).schedule, { repeat: 'daily', time: '09:00', at: '' })
    assert.equal(reopened.get(job.id).nextRunAt, 1700000000000)
    assert.equal(reopened.list({ projectId: 'p1' }).jobs.length, 1)
    assert.equal(reopened.remove(job.id).ok, true)
    assert.equal(reopened.get(job.id), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('permission authority intersects global, agent and project permissions', () => {
  const dir = tempDir()
  try {
    writeJson(path.join(dir, 'settings.json'), {
      permissions: { tools: true, readFiles: true, writeFiles: false },
      agentDefaults: { permissions: { tools: true, readFiles: true } }
    })
    writeJson(path.join(dir, 'projects.json'), {
      version: 1,
      activeProjectId: 'p1',
      projects: [{
        id: 'p1',
        name: '项目一',
        rootPath: 'C:/project',
        roster: {
          agents: [{
            id: 'commander',
            name: '星枢',
            enabled: true,
            permissions: { tools: true, readFiles: false }
          }]
        }
      }]
    })
    const authority = createPermissionAuthority({ configDir: dir })
    const allowed = authority.resolve({ projectId: 'p1', agentId: 'commander' })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.permissions.tools, true)
    assert.equal(allowed.permissions.readFiles, false)
    assert.equal(allowed.permissions.writeFiles, false)
    assert.equal(allowed.project.rootPath, 'C:/project')
    assert.equal(authority.resolve({ projectId: 'other', agentId: 'commander' }).ok, false)
    assert.equal(authority.resolve({ projectId: 'p1', agentId: 'nobody' }).ok, false)

    writeJson(path.join(dir, 'settings.json'), { permissions: { full: true } })
    const full = createPermissionAuthority({ configDir: dir }).resolve({ projectId: 'p1', agentId: 'commander' })
    assert.equal(full.ok, true)
    assert.equal(full.permissions.full, true)
    assert.equal(full.permissions.writeFiles, true)

    const intersected = intersectPermissions(
      { full: false, tools: true, readFiles: true, writeFiles: false },
      { full: false, tools: true, readFiles: false, writeFiles: true }
    )
    assert.equal(intersected.full, false)
    assert.equal(intersected.tools, true)
    assert.equal(intersected.readFiles, false)
    assert.equal(intersected.writeFiles, false)
    const fullIntersected = intersectPermissions({ full: true }, { full: true })
    assert.equal(fullIntersected.full, true)
    assert.equal(fullIntersected.runCommands, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('knowledge browse returns counts and supports add/search/update/remove', async () => {
  const dir = tempDir()
  try {
    const { pathToFileURL } = require('node:url')
    const modulePath = path.join(__dirname, '..', 'electron', 'knowledge', 'service.mjs')
    const { createKnowledgeService } = await import(pathToFileURL(modulePath).href)
    const service = createKnowledgeService({ configDir: dir })
    const project = {
      projectId: 'p1',
      projectName: '测试项目',
      projectRoot: path.join(dir, 'projects', 'p1')
    }
    const init = await service.invoke('init', {}, project)
    assert.equal(init.ok, true)
    const add = await service.invoke('add', {
      kind: '避错',
      title: '测试条目',
      domain: '测试',
      trigger: '测试触发',
      steps: ['动作一', '动作二'],
      why: '测试依据',
      symptoms: '测试症状'
    }, project)
    assert.equal(add.ok, true)
    assert.equal(add.id, 'P-001')
    const browse = await service.invoke('browse', {}, project)
    assert.equal(browse.ok, true)
    assert.equal(browse.entries.length, 1)
    assert.deepEqual(browse.counts, { 方法: 0, 避错: 1, total: 1 })
    const search = await service.invoke('search', { text: '测试条目' }, project)
    assert.equal(search.ok, true)
    assert.equal(search.entries.length, 1)
    const update = await service.invoke('update', {
      id: 'P-001',
      kind: '避错',
      title: '测试条目（改）',
      trigger: '测试触发',
      steps: ['动作一'],
      why: '测试依据',
      symptoms: '测试症状'
    }, project)
    assert.equal(update.ok, true)
    const afterUpdate = await service.invoke('browse', {}, project)
    assert.equal(afterUpdate.entries[0].title, '测试条目（改）')
    const remove = await service.invoke('remove', { id: 'P-001' }, project)
    assert.equal(remove.ok, true)
    const empty = await service.invoke('browse', {}, project)
    assert.deepEqual(empty.counts, { 方法: 0, 避错: 0, total: 0 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tool approval tokens bind exact calls, expire and are single-use', () => {
  let clock = 1000000
  const approvals = createToolApprovals({ ttlMs: 5000, maxEntries: 2, now: () => clock })
  const call = {
    serverId: 'builtin',
    tool: 'write_text_file',
    args: { path: 'Desktop/a.txt', content: 'hello', overwrite: false },
    agentId: 'commander',
    projectId: 'p1',
    runId: 'r1'
  }

  /* 参数键顺序不影响指纹 */
  assert.equal(
    fingerprint(call),
    fingerprint({ ...call, args: { content: 'hello', overwrite: false, path: 'Desktop/a.txt' } })
  )

  const once = approvals.issue(call, { source: 'once' })
  assert.equal(once.source, 'once')
  assert.ok(once.token.length >= 40)

  /* 换参数 -> 不匹配；不匹配也会烧掉令牌，不能拿同一个令牌反复试探 */
  const mismatch = approvals.consume(once.token, { ...call, args: { ...call.args, content: 'evil' } })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.reason, 'mismatch')
  assert.equal(approvals.consume(once.token, call).reason, 'unknown')

  const auto = approvals.issue(call, { source: 'auto' })
  const consumed = approvals.consume(auto.token, call)
  assert.equal(consumed.ok, true)
  assert.equal(consumed.source, 'auto')
  assert.equal(consumed.id, auto.id)
  assert.equal(approvals.consume(auto.token, call).reason, 'unknown')

  const expired = approvals.issue(call, { source: 'once' })
  clock += 6000
  assert.equal(approvals.consume(expired.token, call).reason, 'expired')

  /* 容量上限：超过 maxEntries 时最旧的令牌被挤掉 */
  const first = approvals.issue(call, { source: 'once' })
  const second = approvals.issue(call, { source: 'once' })
  const third = approvals.issue(call, { source: 'once' })
  assert.equal(approvals.consume(first.token, call).reason, 'unknown')
  assert.equal(approvals.consume(second.token, call).ok, true)
  assert.equal(approvals.consume(third.token, call).ok, true)
  assert.equal(approvals.consume('forged-token', call).reason, 'unknown')
})

test('mcp registry refuses execution without a valid approval token', async () => {
  const dir = tempDir()
  const approvals = createToolApprovals({ ttlMs: 5000 })
  const registry = createMcpRegistry({
    configDir: dir,
    allowedRoots: [],
    captureScreenshot: async () => ({ ok: false, error: '测试环境没有截图能力' }),
    knowledge: async () => '{}',
    knowledgeEnabled: () => true,
    verifyApproval: (token, call) => approvals.consume(token, call)
  })
  try {
    await registry.reload()
    const call = {
      serverId: 'builtin',
      tool: 'get_current_timestamp',
      args: { timezone: 'UTC' },
      agentId: 'commander',
      projectId: 'p1',
      runId: 'r1'
    }

    const denied = await registry.call(call)
    assert.equal(denied.ok, false)
    assert.equal(denied.approvalDenied, true)

    const issued = approvals.issue(call, { source: 'once' })
    const executed = await registry.call({ ...call, approvalToken: issued.token })
    assert.equal(executed.ok, true)
    assert.match(executed.text, /Unix 秒/)
    assert.equal(executed.approvalId, issued.id)

    /* 重放同一个令牌 */
    const replay = await registry.call({ ...call, approvalToken: issued.token })
    assert.equal(replay.ok, false)

    /* 换参数使用令牌 */
    const tampered = approvals.issue(call, { source: 'once' })
    const wrong = await registry.call({ ...call, args: { timezone: 'Asia/Tokyo' }, approvalToken: tampered.token })
    assert.equal(wrong.ok, false)

    /* 内置工具的「始终允许」也要能写入 autoApprove */
    const allowed = await registry.allowAlways('builtin', 'get_current_timestamp')
    assert.equal(allowed.ok, true)
    assert.ok(allowed.autoApprove.includes('get_current_timestamp'))
    assert.equal(registry.isAutoApproved('builtin', 'get_current_timestamp'), true)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'))
    const builtin = saved.servers.find((server) => server.id === 'builtin')
    assert.ok(builtin.autoApprove.includes('get_current_timestamp'))
  } finally {
    await registry.shutdown().catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('usage merge handles OpenAI, Anthropic and Ollama payloads', () => {
  const openai = mergeUsage(null, { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }, 'openai')
  assert.deepEqual({ input: openai.input, output: openai.output, total: openai.total, reported: openai.reported }, {
    input: 100, output: 20, total: 120, reported: true
  })

  let anthropic = mergeUsage(null, { message: { usage: { input_tokens: 80, output_tokens: 1 } } }, 'anthropic')
  anthropic = mergeUsage(anthropic, { usage: { output_tokens: 30 } }, 'anthropic')
  assert.equal(anthropic.input, 80)
  assert.equal(anthropic.output, 30)
  assert.equal(anthropic.total, 110)

  const ollama = mergeUsage(null, { prompt_eval_count: 50, eval_count: 10, done: true }, 'ollama')
  assert.equal(ollama.input, 50)
  assert.equal(ollama.output, 10)
  assert.equal(ollama.total, 60)
  assert.equal(mergeUsage(null, { choices: [] }, 'openai'), null)

  const cost = costOf({ input: 1000000, output: 1000000 }, { inputPerMillion: 1, outputPerMillion: 2, currency: 'CNY' })
  assert.equal(cost.priced, true)
  assert.equal(cost.currency, 'CNY')
  assert.equal(cost.cost, 3)
  assert.equal(costOf({ input: 1, output: 1 }, null).priced, false)
})

test('mcp image and resource content are saved and exposed as paths', async () => {
  const dir = tempDir()
  try {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
    const imagePath = await saveMcpImage(dir, png, 'image/png')
    assert.ok(imagePath.endsWith('.png'))
    assert.equal(fs.existsSync(imagePath), true)
    assert.ok(fs.statSync(imagePath).size > 0)

    const text = await flattenContent({
      content: [
        { type: 'text', text: '工具返回：' },
        { type: 'image', data: png, mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///x.txt', text: '资源正文' } }
      ]
    }, (data, mimeType) => saveMcpImage(dir, data, mimeType))
    assert.match(text, /图片已保存/)
    assert.match(text, /资源正文/)
    const paths = text.match(/[A-Za-z]:\\[^\n\r"'<>|*?]+/g) || []
    assert.ok(paths.some((item) => item.includes('mcp-images')))
    assert.ok(paths.some((item) => item.endsWith('.png')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('message summaries use the first sentence and ignore stored model summaries', async () => {
  const tmp = path.join(os.tmpdir(), `astral-core-${process.pid}.mjs`)
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'app', 'js', 'core.js'), tmp)
    const { pathToFileURL } = require('node:url')
    const core = await import(pathToFileURL(tmp).href)

    assert.equal(core.stripSummaryMarker('正文<astral:summary>旧标记</astral:summary>'), '正文')
    assert.equal(core.makeMessageSummary({ kind: 'tool', toolLabel: '读取文件', ok: true }), '读取文件 完成')
    assert.equal(core.makeMessageSummary({ kind: 'plan', brief: '先查资料再汇总' }), '先查资料再汇总')
    assert.equal(core.makeMessageSummary({ kind: 'agent', text: '第一句话。第二句话。' }), '第一句话')

    core.loadMessages({
      user: [{
        kind: 'user',
        channel: 'user',
        text: '第一步需要先确认目标。第二步再执行。',
        summary: '这是旧模型生成的摘要，不应再显示',
        summarySource: 'model'
      }]
    })
    assert.equal(core.state.messages[0].summary, '第一步需要先确认目标')
    assert.equal(core.state.messages[0].summarySource, 'first-line')
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
})

test('plugin migration scanner flags legacy renderer APIs and accepts isolated plugins', () => {
  const dir = tempDir()
  try {
    const legacyDir = path.join(dir, 'legacy')
    fs.mkdirSync(legacyDir, { recursive: true })
    writeJson(path.join(legacyDir, 'plugin.json'), { id: 'legacy', name: '旧插件', entry: 'plugin.js' })
    fs.writeFileSync(path.join(legacyDir, 'plugin.js'), [
      "import { state, h } from '../../js/core.js'",
      "export default function setup () { window.Astral.submit('x'); document.body.append(h('div')) }"
    ].join('\n'), 'utf8')
    const legacy = scanPlugin(legacyDir, 'user')
    assert.equal(legacy.ok, true)
    assert.equal(legacy.legacy, true)
    assert.ok(legacy.flags.includes('导入主界面模块'))
    assert.ok(legacy.flags.includes('window.Astral'))
    assert.ok(legacy.flags.includes('主界面 DOM'))

    const isolatedDir = path.join(dir, 'isolated')
    fs.mkdirSync(isolatedDir, { recursive: true })
    writeJson(path.join(isolatedDir, 'plugin.json'), { id: 'isolated', runtime: 'isolated', entry: 'plugin.js' })
    fs.writeFileSync(path.join(isolatedDir, 'plugin.js'), 'export default function setup (astral) { astral.log("ok") }\n', 'utf8')
    const isolated = scanPlugin(isolatedDir, 'user')
    assert.equal(isolated.ok, true)
    assert.equal(isolated.legacy, false)
    assert.deepEqual(isolated.flags, [])

    const brokenDir = path.join(dir, 'broken')
    fs.mkdirSync(brokenDir, { recursive: true })
    fs.writeFileSync(path.join(brokenDir, 'plugin.json'), '{', 'utf8')
    const broken = scanPlugin(brokenDir, 'user')
    assert.equal(broken.ok, false)
    assert.match(broken.error, /plugin\.json/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy runtime is restricted while external isolated plugins are allowed', () => {
  const legacy = normalizePluginManifest({ id: 'old-plugin', name: '旧插件' }, 'user', 'old-plugin')
  assert.equal(legacy.runtime, 'legacy')
  assert.equal(legacy.isolated, false)
  assert.equal(legacy.manifestError, LEGACY_RUNTIME_ERROR)
  assert.deepEqual(legacy.permissions, ['*'])
  assert.equal(legacy.legacyPermissions, true)

  const explicitLegacy = normalizePluginManifest({ id: 'old-explicit', runtime: 'legacy' }, 'user', 'old-explicit')
  assert.equal(explicitLegacy.runtime, 'legacy')
  assert.equal(explicitLegacy.manifestError, LEGACY_RUNTIME_ERROR)

  const isolated = normalizePluginManifest({ id: 'new-plugin', runtime: 'isolated', permissions: ['ui.dock'] }, 'app', 'new-plugin')
  assert.equal(isolated.runtime, 'isolated')
  assert.equal(isolated.isolated, true)
  assert.equal(isolated.manifestError, '')
  assert.equal(isolated.legacyPermissions, false)

  /* 外部插件（scope=user）不受来源限制，只要用 isolated 就能加载。 */
  const external = normalizePluginManifest({ id: 'external-plugin', runtime: 'isolated' }, 'user', 'external-plugin')
  assert.equal(external.scope, 'user')
  assert.equal(external.isolated, true)
  assert.equal(external.manifestError, '')
  assert.deepEqual(external.permissions, ['*'])

  const broken = normalizePluginManifest({ id: 'bad-plugin', runtime: 'worker' }, 'user', 'bad-plugin')
  assert.equal(broken.runtime, 'legacy')
  assert.match(broken.manifestError, /不支持的插件运行时/)

  const badEntry = normalizePluginManifest({ id: 'entry-plugin', entry: '../escape.js' }, 'user', 'entry-plugin')
  assert.match(badEntry.manifestError, /entry/)
})

test('built-in knowledge plugin runs isolated without legacy shim', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'plugins', 'knowledge', 'plugin.json'), 'utf8'))
  assert.equal(manifest.runtime, 'isolated')
  assert.equal(manifest.legacyShim, undefined)
  assert.ok(manifest.permissions.includes('knowledge'))
  const normalized = normalizePluginManifest(manifest, 'app', 'knowledge')
  assert.equal(normalized.manifestError, '')
  assert.equal(normalized.isolated, true)
})

test('ask tool normalizes options, deduplicates values and caps the list', async () => {
  const tmp = path.join(os.tmpdir(), `astral-ask-spec-${process.pid}.mjs`)
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'app', 'js', 'ask-spec.js'), tmp)
    const { pathToFileURL } = require('node:url')
    const spec = await import(pathToFileURL(tmp).href)
    const options = spec.normalizeOptions([
      '测试环境',
      { label: '生产环境', value: 'prod', description: '会短暂断线' },
      { label: '测试环境', value: '测试环境', description: '重复值只保留第一个' },
      { label: '' },
      ...Array.from({ length: 10 }, (_, index) => ({ label: `选项 ${index}`, value: `v${index}` }))
    ])
    assert.equal(options.length, 8)
    assert.deepEqual(options[0], { label: '测试环境', value: '测试环境', description: '' })
    assert.deepEqual(options[1], { label: '生产环境', value: 'prod', description: '会短暂断线' })
    assert.equal(options.filter((option) => option.value === '测试环境').length, 1)
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
})

test('conversation auto-fold keeps the latest three pinned and folds older ones', async () => {
  const tmp = path.join(os.tmpdir(), `astral-fold-${process.pid}.mjs`)
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'app', 'js', 'fold-state.js'), tmp)
    const { pathToFileURL } = require('node:url')
    const { normalizeFoldMessages } = await import(pathToFileURL(tmp).href)
    const messages = Array.from({ length: 6 }, (_, index) => ({
      id: `m${index + 1}`,
      kind: index % 2 === 0 ? 'user' : 'agent',
      folded: false
    }))
    normalizeFoldMessages(messages, 3)
    assert.deepEqual(messages.slice(0, 3).map((msg) => msg.folded), [true, true, true])
    assert.deepEqual(messages.slice(3).map((msg) => msg.foldPinned), [true, true, true])
    assert.deepEqual(messages.slice(3).map((msg) => msg.folded), [false, false, false])

    messages[0].foldManual = true
    messages[0].folded = false
    normalizeFoldMessages(messages, 3)
    assert.equal(messages[0].folded, false)

    /* 最近三条也允许手动折叠；新消息不能把用户的手动折叠重新展开。 */
    messages[5].foldManual = true
    messages[5].folded = true
    normalizeFoldMessages(messages, 3)
    assert.equal(messages[5].folded, true)

    messages.push({ id: 'm7', kind: 'agent', folded: true })
    normalizeFoldMessages(messages, 3)
    assert.deepEqual(messages.slice(-3).map((msg) => msg.foldPinned), [true, true, true])
    assert.equal(messages[3].folded, true)
    assert.equal(messages[5].folded, true)
    assert.equal(messages[0].folded, false)
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
})

test('运行中释放：被释放的消息退出模型上下文，可恢复，标记随消息持久化', async () => {
  const tmp = path.join(os.tmpdir(), `astral-release-${process.pid}.mjs`)
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'app', 'js', 'context-release.js'), tmp)
    const { pathToFileURL } = require('node:url')
    const { isContextReleased, toggleContextRelease, liveMessages, releasedStats } =
      await import(pathToFileURL(tmp).href)

    const messages = [
      { id: 'm1', kind: 'user', text: '第一问' },
      { id: 'm2', kind: 'agent', text: '第一答，比较长的回复内容' },
      { id: 'm3', kind: 'user', text: '第二问' },
      { id: 'm4', kind: 'agent', text: '第二答' }
    ]

    /* 默认全在上下文里 */
    assert.equal(liveMessages(messages).length, 4)
    assert.deepEqual(releasedStats(messages, (m) => m.text.length), { count: 0, tokens: 0 })

    /* 释放单条：反转语义 */
    assert.equal(toggleContextRelease(messages[0]), true)
    assert.equal(isContextReleased(messages[0]), true)
    assert.equal(liveMessages(messages).length, 3)
    assert.ok(!liveMessages(messages).some((m) => m.id === 'm1'))

    /* 指定释放/恢复：批量路径用同一个入口 */
    toggleContextRelease(messages[1], true)
    toggleContextRelease(messages[2], true)
    assert.equal(liveMessages(messages).length, 1)
    const stats = releasedStats(messages, (m) => m.text.length)
    assert.equal(stats.count, 3)
    assert.equal(stats.tokens, '第一问'.length + '第一答，比较长的回复内容'.length + '第二问'.length)

    toggleContextRelease(messages[1], false)
    assert.equal(isContextReleased(messages[1]), false)
    assert.equal(liveMessages(messages).length, 2)

    /* 序列化往返：ctxReleased 作为普通字段随会话存档，重载后仍然生效 */
    const saved = JSON.parse(JSON.stringify(messages))
    assert.equal(saved[0].ctxReleased, true)
    assert.equal(saved[3].ctxReleased, undefined)
    assert.equal(liveMessages(saved).length, 2)

    /* 空值不炸 */
    assert.equal(isContextReleased(null), false)
    assert.equal(toggleContextRelease(null), false)
    assert.deepEqual(liveMessages(null), [])
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
})

test('build info detects a stale running process after files change on disk', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'app.js')
    fs.writeFileSync(file, '// build', 'utf8')
    const startedAt = Date.now() - 10000
    fs.utimesSync(file, new Date(startedAt - 1000), new Date(startedAt - 1000))
    const fresh = require('../electron/build-info.js').buildInfo({ appDir: dir, startedAt, version: '1.0.0', files: ['app.js'] })
    assert.equal(fresh.stale, false)
    const changed = Date.now()
    fs.utimesSync(file, new Date(changed), new Date(changed))
    const stale = require('../electron/build-info.js').buildInfo({ appDir: dir, startedAt, version: '1.0.0', files: ['app.js'] })
    assert.equal(stale.stale, true)
    assert.equal(stale.latestFile, 'app.js')
    assert.ok(stale.latestAt > startedAt)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* app/js 是浏览器 ES 模块（项目 type=commonjs），这里剥离 export 后加载纯逻辑模块 */
function loadBrowserModule (rel, names) {
  const file = path.join(__dirname, '..', 'app', 'js', rel)
  const src = fs.readFileSync(file, 'utf8').replace(/^export\s+/gm, '')
  const mod = { exports: {} }
  const expose = names.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')
  new Function('module', 'exports', `${src}\nmodule.exports = { ${expose} }`)(mod, mod.exports)
  return mod.exports
}

const TC = loadBrowserModule('triggers-core.js', [
  'normalizeConfig', 'normalizeParams', 'evaluateEvent', 'makeEvent', 'makeMandate',
  'capEvents', 'toolFingerprint', 'inQuietHours', 'MODES', 'MAX_EVENTS',
  'mergeIntoThread', 'threadBlock', 'MAX_THREAD_ITEMS', 'watchToolLoop'
])

const DAY = new Date(2026, 10, 4, 12, 0).getTime()
const NIGHT = new Date(2026, 10, 4, 23, 30).getTime()

test('事件触发器：默认配置为观察模式、空白名单、Watchdog 3 次', () => {
  const c = TC.normalizeConfig(null)
  assert.equal(c.mode, 'observe')
  assert.deepEqual(c.sources, [])
  assert.equal(c.dedupe, true)
  assert.deepEqual(c.watchdog, { enabled: true, threshold: 3 })
  assert.equal(TC.MODES.includes(c.mode), true)
})

test('事件触发器：默认空白名单拒绝外部事件，界面测试事件仍可进候选', () => {
  const c = TC.normalizeConfig(null)
  const outside = TC.evaluateEvent({ cfg: c, params: { source: 'ci', eventId: 'b1', text: '构建失败' }, now: DAY })
  assert.equal(outside.status, 'rejected')
  assert.match(outside.reason, /白名单/)
  const inside = TC.evaluateEvent({ cfg: c, params: { source: 'test', eventId: 't1', text: '试一下' }, now: DAY, isTest: true })
  assert.equal(inside.status, 'observed')
})

test('事件触发器：观察 / 自动 / 关闭三档与忙时排队', () => {
  const p = { source: 'ci', eventId: 'b2', text: 'CI 失败' }
  assert.equal(TC.evaluateEvent({ cfg: TC.normalizeConfig({ mode: 'observe', sources: ['ci'] }), params: p, now: DAY }).status, 'observed')
  assert.equal(TC.evaluateEvent({ cfg: TC.normalizeConfig({ mode: 'off', sources: ['ci'] }), params: p, now: DAY }).status, 'rejected')
  const auto = TC.normalizeConfig({ mode: 'auto', sources: ['ci'] })
  assert.equal(TC.evaluateEvent({ cfg: auto, params: p, now: DAY }).status, 'auto')
  assert.equal(TC.evaluateEvent({ cfg: auto, params: p, now: DAY, busy: true }).status, 'queued')
})

test('事件触发器：去重、关键词、静默时段均在调用模型前拦下', () => {
  const c = TC.normalizeConfig({ mode: 'auto', sources: ['ci'], keywords: ['失败'], quietHours: { from: '22:00', to: '08:00', enabled: true } })
  const p = { source: 'ci', eventId: 'b3', text: 'CI 构建失败' }
  assert.equal(TC.evaluateEvent({ cfg: c, params: p, now: DAY, seen: new Set(['b3']) }).status, 'ignored')
  assert.equal(TC.evaluateEvent({ cfg: c, params: { ...p, text: '一切正常' }, now: DAY }).reason, '未命中关键词')
  assert.equal(TC.inQuietHours(c.quietHours, NIGHT), true)
  assert.equal(TC.evaluateEvent({ cfg: c, params: p, now: NIGHT }).reason, '静默时段')
})

test('事件触发器：任务单不可变、记录环形裁剪、工具指纹稳定', () => {
  const p = TC.normalizeParams({ source: 'ci', eventId: 'b4', text: 'CI 失败' })
  const ev = TC.makeEvent({ params: p, status: 'observed', reason: '等待批准', id: 'ev_1' })
  const md = TC.makeMandate(ev)
  assert.equal(Object.isFrozen(md), true)
  try { md.scope = '改范围' } catch { /* 冻结对象赋值应被拒绝 */ }
  assert.equal(md.scope, 'CI 失败')
  assert.equal(md.eventId, 'b4')
  assert.equal(TC.makeMandate({ ...ev, id: 'ev_2' }).id, 'md_ev_2')
  const big = Array.from({ length: 250 }, (_, i) => ({ i }))
  assert.equal(TC.capEvents(big).length, TC.MAX_EVENTS)
  assert.equal(TC.capEvents(big)[0].i, 50)
  assert.equal(TC.toolFingerprint('read', '{"path":"a"}'), TC.toolFingerprint('read', '{"path":"a"}'))
  assert.notEqual(TC.toolFingerprint('read', '{"path":"a"}'), TC.toolFingerprint('write', '{"path":"a"}'))
})

/* 注入式加载渲染层编排模块：验证批准 → 队列 → submit 的完整链路，不启动 Electron */
function loadTriggersRuntime () {
  const file = path.join(__dirname, '..', 'app', 'js', 'triggers.js')
  const src = fs.readFileSync(file, 'utf8')
    .replace(/^import\s+[\s\S]*?from\s+'[^']+'\s*$/gm, '')
    .replace(/^export\s+/gm, '')
  let seq = 0
  const calls = []
  const listeners = {}
  const state = { settings: {}, busy: false }
  const deps = {
    state,
    bus: {
      on: (k, fn) => { (listeners[k] || (listeners[k] = [])).push(fn) },
      emit: (k, ...args) => (listeners[k] || []).forEach((fn) => fn(...args))
    },
    persist: { settings: () => {} },
    toast: () => {},
    uid: (prefix) => `${prefix}_${++seq}`,
    submit: async (text) => { calls.push(text); return { ok: true } },
    MAX_EVENTS: TC.MAX_EVENTS,
    MODES: TC.MODES,
    normalizeConfig: TC.normalizeConfig,
    evaluateEvent: TC.evaluateEvent,
    makeEvent: TC.makeEvent,
    makeMandate: TC.makeMandate,
    capEvents: TC.capEvents,
    mergeIntoThread: TC.mergeIntoThread,
    threadBlock: TC.threadBlock
  }
  const names = Object.keys(deps)
  const api = new Function(...names,
    `${src}\nreturn { emitEvent, approveEvent, listEvents, config, saveConfig, mountTriggers, queueLength }`
  )(...names.map((n) => deps[n]))
  return { api, calls, listeners, state }
}

test('事件触发器：观察态零 submit，批准后只放行一张单，忙时排队不并发', async () => {
  const rt = loadTriggersRuntime()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  rt.api.mountTriggers()
  rt.api.saveConfig({ mode: 'observe', sources: ['ci'] })

  const e1 = rt.api.emitEvent({ source: 'ci', eventId: 'x1', text: '构建失败', now: DAY })
  assert.equal(e1.status, 'observed')
  assert.equal(rt.calls.length, 0)

  const first = rt.api.listEvents()[0]
  const approved = rt.api.approveEvent(first.id)
  assert.equal(approved.ok, true)
  assert.equal(Object.isFrozen(approved.mandate), true)
  await sleep(40)
  assert.equal(rt.calls.length, 1)
  assert.match(rt.calls[0], /\[事件单 md_/)
  assert.equal(rt.api.listEvents()[0].status, 'executed')

  /* 忙时：auto 事件只入队，不能并发第二个 submit */
  rt.state.busy = true
  rt.api.saveConfig({ mode: 'auto' })
  const e2 = rt.api.emitEvent({ source: 'ci', eventId: 'x2', text: '第二次' })
  assert.equal(e2.status, 'queued')
  await sleep(40)
  assert.equal(rt.calls.length, 1)
  assert.equal(rt.api.queueLength(), 1)

  rt.state.busy = false
  for (const fn of (rt.listeners.busy || [])) fn(false)
  await sleep(40)
  assert.equal(rt.calls.length, 2)
  assert.equal(rt.api.listEvents().find((e) => e.eventId === 'x2').status, 'executed')
})

test('事件触发器：同线索事件合并计数、截断并生成线索块', () => {
  const p1 = TC.normalizeParams({ source: 'ci', eventId: 't1', threadId: 'pr-7', text: 'CI 失败' })
  const base = TC.makeEvent({ params: p1, status: 'observed', reason: '等待批准', id: 'ev_t' })
  let ev = base
  for (let i = 2; i <= 25; i++) {
    Object.assign(ev, TC.mergeIntoThread(ev, TC.normalizeParams({
      source: 'ci', eventId: `t${i}`, threadId: 'pr-7', text: `第 ${i} 条`
    })))
  }
  assert.equal(ev.threadCount, 25)
  assert.equal(ev.threadItems.length, TC.MAX_THREAD_ITEMS)
  assert.equal(ev.text, '第 25 条')
  assert.equal(ev.threadId, 'pr-7')
  assert.match(TC.threadBlock(ev), /## 该线索的连续事件/)
  assert.match(TC.threadBlock(ev), /第 25 条/)
  assert.equal(TC.threadBlock(TC.makeEvent({ params: p1, status: 'observed', reason: '', id: 'one' })), '')
})

test('事件触发器：同一线索只生成一张单，批准一次把整条线索一起提交', async () => {
  const rt = loadTriggersRuntime()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  rt.api.mountTriggers()
  rt.api.saveConfig({ mode: 'observe', sources: ['ci'] })
  rt.api.emitEvent({ source: 'ci', eventId: 'th-1', threadId: 'pr-7', text: 'CI 首次失败' })
  const second = rt.api.emitEvent({ source: 'ci', eventId: 'th-2', threadId: 'pr-7', text: 'CI 仍然失败' })
  assert.equal(second.merged, true)
  const list = rt.api.listEvents()
  assert.equal(list.length, 1)
  assert.equal(list[0].threadCount, 2)
  const dup = rt.api.emitEvent({ source: 'ci', eventId: 'th-1', threadId: 'pr-7', text: 'CI 首次失败' })
  assert.equal(dup.status, 'ignored')
  rt.api.approveEvent(list[0].id)
  await sleep(50)
  assert.equal(rt.calls.length, 1)
  assert.match(rt.calls[0], /CI 首次失败/)
  assert.match(rt.calls[0], /CI 仍然失败/)
  assert.equal(rt.api.listEvents()[0].status, 'executed')
})

test('事件触发器：Watchdog 只在同指纹累计到阈值时中断，且可整体关闭', () => {
  const seen = new Map()
  const fp = TC.toolFingerprint('read_text_file', '{"path":"a.txt"}')
  assert.equal(TC.watchToolLoop(seen, fp, true, 3).stop, false)
  assert.equal(TC.watchToolLoop(seen, fp, true, 3).stop, false)
  const third = TC.watchToolLoop(seen, fp, true, 3)
  assert.equal(third.stop, true)
  assert.equal(third.count, 3)
  const off = new Map()
  for (let i = 0; i < 10; i++) assert.equal(TC.watchToolLoop(off, fp, false, 3).stop, false)
  assert.equal(off.size, 0)
  const mixed = new Map()
  const other = TC.toolFingerprint('write_text_file', '{"path":"a.txt"}')
  TC.watchToolLoop(mixed, fp, true, 2)
  TC.watchToolLoop(mixed, other, true, 2)
  assert.equal(TC.watchToolLoop(mixed, fp, true, 2).stop, true)
})

test('默认提示词保持精简，实证与底线约束不丢失', () => {
  const appJs = (rel) => path.join(__dirname, '..', 'app', 'js', rel)
  const llm = fs.readFileSync(appJs('llm.js'), 'utf8')
  const m = /export const CORE_PROMPT = (\[[\s\S]*?\])\.join\('\\n'\)/.exec(llm)
  assert.ok(m, '未找到 CORE_PROMPT 常量')
  const core = new Function('return ' + m[1])().join('\n')
  assert.ok(core.length < 300, `CORE_PROMPT 又膨胀了：${core.length} 字符`)
  for (const key of ['不编造', '不确定', '反编译', 'ask_user_question', 'mermaid']) {
    assert.ok(core.includes(key) || llm.includes(key), `缺少底线约束：${key}`)
  }
  const orch = fs.readFileSync(appJs('orchestrator.js'), 'utf8')
  assert.match(orch, /<astral:expand>/, '标准会话的扩展标记不能删')
  const skill = fs.readFileSync(path.join(__dirname, '..', 'app', 'skills', 'empirical.md'), 'utf8')
  assert.match(skill, /反编译目标 API/)
  assert.match(skill, /路径\/行号/)
})

test('启动动画配色跟随主题：色板由 token 派生，且启动前预置主题', () => {
  const root = path.join(__dirname, '..')
  const css = fs.readFileSync(path.join(root, 'app', 'css', 'app.css'), 'utf8')
  const start = css.indexOf('.splash {')
  const end = css.indexOf('---------------- 字标')
  assert.ok(start > 0 && end > start, '未找到启动动画样式段')
  /* 注释里会提到旧配色，先剥掉再查 */
  const splash = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(splash, /--sp-hot:\s*color-mix/, '启动动画色板必须由主题 token 派生')
  assert.match(splash, /--sp-main:\s*color-mix/, '缺少主色派生变量')
  for (const hard of ['rgba(172, 138, 234', 'rgba(199, 171, 255', 'rgba(150, 190, 255', '#ac8aea', '#c7abff']) {
    assert.ok(!splash.toLowerCase().includes(hard.toLowerCase()), `启动动画又写死了固定配色：${hard}`)
  }
  const html = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8')
  const pre = html.indexOf('js/pretheme.js')
  const splashTag = html.indexOf('id="splash"')
  assert.ok(pre > 0 && splashTag > pre, 'pretheme.js 必须排在 splash 之前，否则首帧仍是默认主题')
  const effects = fs.readFileSync(path.join(root, 'app', 'js', 'effects.js'), 'utf8')
  assert.match(effects, /astral\.theme\.snapshot/, '主题快照没有写入 localStorage')
  assert.match(effects, /export function bootTheme/, '启动时应使用 bootTheme 接住插件主题')
})

test('界面语言包可扩展，英文覆盖核心界面且缺词回退中文', () => {
  const dir = path.join(__dirname, '..', 'app', 'locales')
  const zh = JSON.parse(fs.readFileSync(path.join(dir, 'zh-CN.json'), 'utf8'))
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en-US.json'), 'utf8'))
  assert.equal(zh.code, 'zh-CN')
  assert.equal(en.code, 'en-US')
  assert.equal(zh.messages && Object.keys(zh.messages).length, 0)
  for (const key of ['设置', '新对话', '发送', '任务', '界面语言', '新会话']) {
    assert.ok(en.messages[key], `英文语言包缺少：${key}`)
  }
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'i18n.js'), 'utf8')
  assert.match(i18n, /registerLocale/)
  assert.match(i18n, /setLocales/)
  assert.match(i18n, /config\/locales/)
})

test('更新检查：版本比较与「发布 / 分支」两种来源', async () => {
  const { compareVersions, checkForUpdate } = require('../electron/update-check.js')

  assert.equal(compareVersions('0.1.0', 'v0.2.0'), -1)
  assert.equal(compareVersions('0.2.0', '0.2'), 0)
  assert.equal(compareVersions('v0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.2.0-beta'), 1, '正式版应高于同号预发布')

  const releaseFetch = async (url) => {
    if (url.endsWith('/releases/latest')) {
      return {
        status: 200,
        data: {
          tag_name: 'v0.3.0',
          html_url: 'https://github.com/MoYu-CN/astral-realm/releases/tag/v0.3.0',
          body: '修了一些问题',
          published_at: '2026-11-01T00:00:00Z'
        }
      }
    }
    return { status: 404, data: null }
  }
  const byRelease = await checkForUpdate({ currentVersion: '0.1.0', fetchJson: releaseFetch, force: true })
  assert.equal(byRelease.ok, true)
  assert.equal(byRelease.source, 'release')
  assert.equal(byRelease.latest, '0.3.0')
  assert.equal(byRelease.hasUpdate, true)
  assert.match(byRelease.url, /releases\/tag\/v0\.3\.0$/)

  const pkg = Buffer.from(JSON.stringify({ name: 'astral-realm', version: '0.2.0' }), 'utf8').toString('base64')
  const mainFetch = async (url) => {
    if (url.endsWith('/releases/latest')) return { status: 404, data: null }
    if (url.includes('/contents/package.json')) return { status: 200, data: { content: pkg, encoding: 'base64' } }
    if (url.includes('/commits/main')) {
      return {
        status: 200,
        data: { sha: 'abcdef1234567890', commit: { message: 'feat: 更新检查\n\n细节', author: { date: '2026-11-04T10:00:00Z' } } }
      }
    }
    return { status: 404, data: null }
  }
  const byMain = await checkForUpdate({ currentVersion: '0.1.0', fetchJson: mainFetch, force: true })
  assert.equal(byMain.ok, true)
  assert.equal(byMain.source, 'main')
  assert.equal(byMain.latest, '0.2.0')
  assert.equal(byMain.commit.sha, 'abcdef1', '提交 SHA 应截断成 7 位')

  const upToDate = await checkForUpdate({ currentVersion: '0.2.0', fetchJson: mainFetch, force: true })
  assert.equal(upToDate.hasUpdate, false)

  const limited = await checkForUpdate({ currentVersion: '0.1.0', force: true, fetchJson: async () => ({ status: 403, data: {} }) })
  assert.equal(limited.ok, false)
  assert.match(limited.error, /限流/)
})

test('关于页挂载更新卡片，IPC 通道与 preload 对齐', () => {
  const root = path.join(__dirname, '..')
  const settings = fs.readFileSync(path.join(root, 'app', 'js', 'settings.js'), 'utf8')
  assert.match(settings, /import \{ updateCard \} from '\.\/updater\.js'/)
  assert.match(settings, /updateCard\(\)/)
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  assert.match(preload, /checkUpdate: .*'astral:update:check'/)
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  assert.match(main, /ipcMain\.handle\('astral:update:check'/)
})

test('探子：只读扫描项目目录，跳过依赖与隐藏文件，拒绝整个个人目录', async () => {
  const scout = require('../electron/scout.js')
  const dir = tempDir()
  try {
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'README.md'), '# 投票项目\n登录模块')
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1')
    fs.mkdirSync(path.join(dir, 'node_modules'))
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'skip me')
    fs.writeFileSync(path.join(dir, '.hidden.md'), 'skip me too')
    const res = await scout.scan({ rootPath: dir })
    assert.equal(res.ok, true)
    assert.equal(res.stats.scanned, 2)
    assert.ok(res.files.some((file) => file.path === 'README.md'))
    assert.ok(!res.files.some((file) => file.path.includes('node_modules')))
    assert.match(res.digest, /投票项目/)
    assert.equal((await scout.scan({ rootPath: '' })).ok, false)
    assert.equal((await scout.scan({ rootPath: path.join(dir, 'no-such') })).ok, false)
    /* 只读：源文件原样保留 */
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# 投票项目\n登录模块')
    const desktop = path.join(os.homedir(), 'Desktop')
    if (fs.existsSync(desktop)) {
      const denied = await scout.scan({ rootPath: desktop })
      assert.equal(denied.ok, false)
      assert.match(denied.error, /个人目录/)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
  }
})

test('探子与观察链路：IPC / preload / 工具对齐', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  const mcp = fs.readFileSync(path.join(root, 'electron', 'mcp-client.js'), 'utf8')
  const gateway = fs.readFileSync(path.join(root, 'electron', 'tool-gateway.js'), 'utf8')
  assert.match(main, /ipcMain\.handle\('astral:scout:scan'/)
  assert.match(main, /ipcMain\.handle\('astral:memory:commitScout'/)
  assert.match(preload, /scoutScan: .*'astral:scout:scan'/)
  assert.match(preload, /memoryCommitScout: .*'astral:memory:commitScout'/)
  assert.match(mcp, /name: 'memory_observe'/)
  assert.match(gateway, /case 'memory_observe'/)
})

test('超级会话：用户保留完整记录，模型只读取未隐藏消息与事件精华', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'super-memory.js'), 'utf8')
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
  const messages = [
    { id: 'u1', role: 'user', text: '完整提问一' },
    { id: 'a1', role: 'assistant', text: '完整回复一' },
    { id: 'u2', role: 'user', text: '完整提问二', contextHidden: true },
    { id: 'a2', role: 'assistant', text: '完整回复二', contextHidden: true },
    { id: 'u3', role: 'user', text: '手动释放', ctxReleased: true }
  ]
  assert.deepEqual(mod.modelHistory(messages), [
    { role: 'user', content: '完整提问一' },
    { role: 'assistant', content: '完整回复一' }
  ])
  assert.equal(mod.hideExchange(messages, ['u1', 'a1']), 2)
  assert.equal(messages[0].contextHidden, true)
  assert.equal(mod.modelHistory(messages).length, 0)
  assert.equal(messages[2].text, '完整提问二', '用户视图的完整消息不能被删除')

  const memory = mod.normalizeMemory([
    { ts: 0, text: '旧记忆' },
    { ts: 1, text: '新记忆' }
  ], { maxChars: 4 })
  assert.deepEqual(memory.map((item) => item.text), ['新记忆'])

  const range = mod.timeRangeForQuery('昨天那个项目到哪了', new Date(2026, 10, 11, 12, 0, 0).getTime())
  assert.equal(range.label, '昨天')
  assert.ok(new Date(range.from) < new Date(range.to))
  const recalled = mod.formatRecalledEvents([
    { project: '示例项目', summary: '完成登录修复', result: '完成', startedAt: range.from }
  ], [], range)
  assert.match(recalled, /时间范围：昨天/)
  assert.match(recalled, /示例项目：完成登录修复/)
})

test('超级会话接线：原文入库、事件精华入库、消息链接、可引用原文', () => {
  const root = path.join(__dirname, '..')
  const superSrc = fs.readFileSync(path.join(root, 'app', 'js', 'superagent.js'), 'utf8')
  assert.match(superSrc, /extractEssence/)
  assert.match(superSrc, /writeEssenceEvent/)
  assert.match(superSrc, /saveMessageRecord/)
  assert.match(superSrc, /messageDigest/)
  assert.match(superSrc, /memoryQuery/)
  assert.match(superSrc, /hideExchange/)
  assert.match(superSrc, /saveSuperSession\(\{ messages, memory \}\)/)
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  assert.match(main, /ipcMain\.handle\('astral:memory:query'/)
  assert.match(main, /ipcMain\.handle\('astral:message:record'/)
  assert.match(main, /ipcMain\.handle\('astral:message:digest'/)
  assert.match(main, /message-fallback\.jsonl/)
  assert.match(main, /memory: \(Array\.isArray\(data && data\.memory\)/)
  assert.match(main, /version: 2, updatedAt: Date\.now\(\), messages, memory/)
  const actions = fs.readFileSync(path.join(root, 'app', 'js', 'message-actions.js'), 'utf8')
  assert.match(actions, /quoteOriginalForTarget/)
  assert.match(actions, /引用原文/)
})

test('消息原文只追加、浓缩记忆链接原文，权重可由打分方动态写入', () => {
  const dir = tempDir()
  try {
    const { createMemoryService, ROLE } = require('../electron/memory/index.js')
    const service = createMemoryService({ configDir: dir, enabled: true })
    try {
      const first = service.writeMessageRecord({
        actor: ROLE.SUPER, id: 'm1', conversationId: 'c1', role: 'user', text: '完整原文一'
      })
      assert.equal(first.ok, true)
      service.writeMessageRecord({
        actor: ROLE.SUPER, id: 'm1', conversationId: 'c1', role: 'user', text: '试图篡改'
      })
      const original = service.getMessageRecord({ actor: ROLE.SUPER, id: 'm1' })
      assert.equal(original.data.text, '完整原文一', '原文不允许被覆盖')
      const digest = service.writeMessageDigest({
        actor: ROLE.SUPER, messageId: 'm1', conversationId: 'c1', digest: '浓缩版本',
        weight: 0.62, weightJson: { time: 0.8, result: 0.4 }, scorer: 'main'
      })
      assert.equal(digest.ok, true)
      assert.equal(digest.data.message_id, 'm1')
      assert.equal(digest.data.weight, 0.62)
      const list = service.queryMessageDigests({ actor: ROLE.SUPER, conversationId: 'c1' })
      assert.equal(list.data.length, 1)
      assert.equal(list.data[0].digest, '浓缩版本')
    } finally { service.close() }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
  }
})

;(async () => {
  for (const item of tests) {
    await item.fn()
    passed += 1
    console.log(`ok ${passed} - ${item.name}`)
  }
  console.log(`\n${passed} tests passed`)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})