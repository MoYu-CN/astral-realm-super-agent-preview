'use strict'

/**
 * 星界 · 记忆服务宿主（主进程内嵌）
 *
 * 三件事：
 *   1. 数据：主进程直接读写 SQLite（config/memory/memory.db），不经过 HTTP，也不经子进程；
 *   2. 工具：给 mcp-client 的 memory_* 内置工具提供执行入口；
 *   3. 控制台：需要看界面时，按需拉起 view-server 子进程并复用同一个窗口。
 *
 * 开关：settings.json → memory.enabled（缺省视为开）。关闭后：
 *   - 内置工具返回明确错误；
 *   - 控制台子进程停止，但数据库文件与封存文件原样保留。
 */

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { createMemoryService, ROLE } = require('./index.js')
const hardContext = require('./hard-context.js')
const scout = require('../scout.js')
const { createSecurity } = require('../security/index.js')

const DEFAULT_PORT = 45872

function createMemoryHost ({ configDir, viewServerPath, port = DEFAULT_PORT, logger = () => {} } = {}) {
  if (!configDir) throw new Error('createMemoryHost 需要 configDir')

  let service = null
  let child = null
  let consoleStarting = null
  let consoleWrite = null

  const settingsFile = path.join(configDir, 'settings.json')

  function readSettings () {
    try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } catch { return {} }
  }

  function writeSettings (next) {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8')
  }

  function enabled () {
    const settings = readSettings()
    return !settings.memory || settings.memory.enabled !== false
  }

  function setEnabled (on) {
    const settings = readSettings()
    settings.memory = { ...(settings.memory || {}), enabled: Boolean(on) }
    writeSettings(settings)
    if (!on) {
      stop()
    } else {
      /* 重新打开时不预热：等第一次调用或打开控制台时再建连接 */
      ensureService()
    }
    return status()
  }

  /* 数据服务：懒创建，关闭开关后不再持有连接 */
  function ensureService () {
    if (!enabled()) return null
    if (!service) {
      service = createMemoryService({ configDir, enabled: true })
    }
    return service
  }

  /* 给渲染层装配系统提示词用：只返回文本与块信息，不暴露数据库句柄 */
  function prompt () {
    if (!enabled()) {
      return { ok: false, enabled: false, text: '', blocks: [], total: 0, budget: 0, reason: '记忆库已关闭' }
    }
    try {
      const s = ensureService()
      const data = hardContext.readAll(s.db)
      return {
        ok: true,
        enabled: true,
        text: hardContext.promptText(s.db),
        blocks: data.blocks,
        total: data.total,
        budget: data.budget,
        filled: data.filled,
        updatedAt: data.updatedAt
      }
    } catch (err) {
      return { ok: false, enabled: true, text: '', blocks: [], total: 0, budget: 0, reason: err.message }
    }
  }

  function status () {
    const on = enabled()
    let tables = []
    let total = 0
    let hard = null
    let file = path.join(configDir, 'memory', 'memory.db')
    if (on) {
      try {
        const s = ensureService()
        file = s.file
        const names = [
          'projects', 'events', 'proposals', 'dispatch_log', 'behavior_log',
          'knowledge', 'event_prefixes', 'diary_digest', 'archive_manifest',
          'kb_nodes', 'kb_links', 'message_records', 'message_digests', 'weight_dimensions', 'team_toolboxes'
        ]
        tables = names.map((name) => ({
          name,
          count: s.db.prepare('SELECT COUNT(*) AS n FROM ' + name).get().n
        }))
        total = tables.reduce((n, t) => n + t.count, 0)
        hard = hardContext.summary(s.db)
      } catch (err) {
        return { ok: false, enabled: on, error: err.message, file, consoleUrl: null, tables, total, hardContext: hard }
      }
    }
    return {
      ok: true,
      enabled: on,
      file,
      tables,
      total,
      hardContext: hard,
      port,
      consoleUrl: 'http://127.0.0.1:' + port,
      consoleRunning: Boolean(child && !child.killed),
      version: '0.4.0'
    }
  }

  /* 工具入口：memory_* 只允许超级智能体；knowledge 由执行层使用 */
  function runTool (tool, args = {}) {
    const name = String(tool || '')
    if (!name.startsWith('memory_') && !name.startsWith('security_') && name !== 'knowledge') {
      return { ok: false, error: '未知的记忆工具：' + name }
    }
    if (!enabled()) {
      return { ok: false, error: '记忆服务已关闭（设置 → 记忆库 → 启用记忆库）' }
    }
    let s
    try {
      s = ensureService()
    } catch (err) {
      return { ok: false, error: '记忆库打开失败：' + err.message }
    }
    if (!s) return { ok: false, error: '记忆服务已关闭' }

    if (name === 'memory_query') return s.query({ ...args, actor: ROLE.SUPER, source: args.source === 'archive' ? 'archive' : undefined })
    if (name === 'memory_write') return s.write({ ...args, actor: ROLE.SUPER })
    if (name === 'memory_context') return s.getContext({ ...args, actor: ROLE.SUPER })
    if (name === 'memory_recall') return s.recall({ ...args, actor: ROLE.SUPER })
    if (name === 'memory_time') return s.time({ ...args, actor: ROLE.SUPER })
    if (name === 'memory_observe') {
      return s.time({ ...args, action: 'observe', source: args.source || 'chat', actor: ROLE.SUPER })
    }
    if (name === 'memory_knowledge') return s.knowledge({ ...args, actor: ROLE.EXECUTOR })
    /* 知识网：只查索引不读正文，正文由项目知识库的 kb_get 提供 */
    if (name === 'memory_kb') return s.kb({ ...args, actor: ROLE.SUPER })
    /* 收件箱：只看摘要与分流结果，原文留在库里 —— 群聊再多也不涨上下文 */
    if (name === 'memory_inbox') {
      const action = String(args.action || 'recent')
      if (action === 'recent') return s.inbox({ action: 'messages', limit: args.limit || 20, route: args.route, channel: args.channel })
      if (action === 'search') return s.inbox({ action: 'messages', q: args.query || args.q, limit: args.limit || 20 })
      if (action === 'threads') return s.inbox({ action: 'threads', limit: args.limit || 20 })
      if (action === 'stats') return s.inbox({ action: 'stats' })
      if (action === 'handled') return s.inbox({ action: 'handled', ids: args.ids || [] })
      /* 首流同款摘要：让 AI 一眼知道「我在听什么」，不必先拉一整页消息 */
      if (action === 'brief') return s.inbox({ action: 'brief' })
      if (action === 'channels') {
        const res = s.inbox({ action: 'channels' })
        if (!res.ok) return res
        /* 渠道配置里可能有路径、URL，工具层只回「哪条、开没开、跑到哪」 */
        return {
          ok: true,
          data: (res.data || []).map((c) => ({
            id: c.id, kind: c.kind, label: c.label, enabled: Boolean(c.enabled),
            status: c.status || '', lastAt: c.lastAt || '', error: c.lastError || ''
          }))
        }
      }
      return { ok: false, error: '未知的收件箱动作：' + action }
    }

    /* 安全边界：agent 只能「问」和「记」，不能自己批准自己。
       approve / deny 只在主进程的 IPC 里，工具层根本够不到。 */
    if (name === 'security_check') {
      const box = createSecurity({ configDir, store: s, logger })
      const action = String(args.action || 'screen')
      if (action === 'pending') return { ok: true, data: box.pending() }
      if (action === 'stats') return { ok: true, data: box.stats() }
      if (action === 'brief') return { ok: true, data: box.brief() }
      if (action === 'policy') return { ok: true, data: box.read() }
      return {
        ok: true,
        data: box.screen({
          text: args.text || args.content || '',
          args: args.args && typeof args.args === 'object' ? args.args : undefined,
          target: args.target || '',
          channel: args.channel || '',
          purpose: args.purpose || '',
          taskId: args.taskId || null,
          exposure: args.exposure || 'send'
        })
      }
    }

    if (name === 'security_ledger') {
      const box = createSecurity({ configDir, store: s, logger })
      const action = String(args.action || 'tasks')
      if (action === 'tasks') return { ok: true, data: box.tasks({ status: args.status || 'all', limit: args.limit }) }
      if (action === 'open') {
        const result = box.openTask({
          id: args.id,
          title: args.title,
          ask: args.ask || args.text,
          from: args.from,
          fromId: args.fromId,
          channel: args.channel,
          chat: args.chat,
          messageId: args.messageId,
          deadline: args.deadline,
          expect: args.expect
        })
        if (!result.ok) return result
        /* 开留痕是用户的决定：agent 只能建议，不能替用户把「已留痕」写进账本。 */
        return { ok: true, data: result, note: '留痕已开。之后每一步动作都用 append 记进去。' }
      }
      if (action === 'close') {
        const result = box.closeTask({ id: args.id, outcome: args.outcome, evidence: args.evidence, actor: 'agent' })
        return result.ok ? { ok: true, data: result } : result
      }
      if (action === 'append') {
        const result = box.append({
          kind: args.kind || 'action',
          taskId: args.taskId,
          actor: 'agent',
          title: args.title || '',
          body: args.body || (args.text ? { text: args.text } : {}),
          refs: args.refs || {}
        })
        return { ok: true, data: result }
      }
      if (action === 'ledger') return { ok: true, data: box.ledger({ taskId: args.taskId, limit: args.limit }) }
      if (action === 'verify') return { ok: true, data: box.verify() }
      if (action === 'digest') {
        if (!args.id) return { ok: false, error: 'digest 需要 id：把哪条留痕压进事件网' }
        const result = box.digestTask({ id: args.id, force: args.force })
        return result.ok ? { ok: true, data: result } : result
      }
      if (action === 'trace') {
        /* 追原委是用户发起的回查：这一条会把原话和整条时间线取出来，
           只用于回答「这件事到底怎么来的」，不要拿它当日常上下文。 */
        const result = box.trace({ id: args.id, query: args.query, days: args.days, related: args.related })
        return result.ok ? { ok: true, data: result } : result
      }
      if (action === 'export') {
        const result = box.exportTask({ id: args.id })
        return result.ok ? { ok: true, data: result } : result
      }
      return { ok: false, error: '未知的留痕动作：' + action }
    }

    return { ok: false, error: '未知的记忆工具：' + name }
  }

  /* 按权重网回忆：给一句要回顾的事，只取最相关的少数项目与条目 */
  function recall (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭（设置 → 记忆库 → 启用记忆库）' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.recall({ ...input, actor: ROLE.SUPER })
  }

  /* 时间网：周记与时段习惯。默认动作是「这个点通常做什么」。 */
  function time (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭（设置 → 记忆库 → 启用记忆库）' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.time({ ...input, actor: ROLE.SUPER })
  }

  /* 把界面上的项目镜像进记忆库，保证权重网里的节点与左侧一致 */
  function syncProjects (projects) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.syncProjects({ projects, actor: ROLE.SUPER })
  }

  /* 知识网：索引与权重。starmap / digest / search / feedback 都走这里 */
  function kb (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.kb({ ...input, actor: ROLE.SUPER })
  }

  /* 探子：只读扫描用户明确指定的项目目录，产出可编辑摘要 */
  function scan (input = {}) {
    return scout.scan(input)
  }

  /* 超级智能体整理后的摘要 → 项目节点 + 事件 → 三张网自动重建 */
  function commitScout (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.commitScout({ ...input, actor: ROLE.SUPER })
  }

  /* 消息原文 / 浓缩记忆：原文只追加，浓缩只链接，不覆盖原文 */
  function messageRecord (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.writeMessageRecord({ ...input, actor: ROLE.SUPER })
  }

  function messageDigest (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.writeMessageDigest({ ...input, actor: ROLE.SUPER })
  }

  function messageGet (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.getMessageRecord({ ...input, actor: ROLE.SUPER })
  }

  function messageDigests (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.queryMessageDigests({ ...input, actor: ROLE.SUPER })
  }

  function messageWeight (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.adjustMessageWeight({ ...input, actor: ROLE.SUPER })
  }

  function messageEdges (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.weightEdges({ ...input, actor: ROLE.SUPER })
  }

  function messageDimensions (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.weightDimensions({ ...input, actor: ROLE.SUPER })
  }

  function messageGraph (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.messageGraph({ ...input, actor: ROLE.SUPER })
  }

  function teamToolboxSave (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.writeTeamToolbox({ ...input, actor: ROLE.SUPER })
  }

  function teamToolboxGet (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.getTeamToolbox({ ...input, actor: ROLE.SUPER })
  }

  function teamToolboxFind (input = {}) {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.findTeamToolbox({ ...input, actor: ROLE.SUPER })
  }

  function weightNet () {
    if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
    const s = ensureService()
    if (!s) return { ok: false, error: '记忆服务已关闭' }
    return s.net()
  }

  function portOpen (target) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: target })
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        socket.destroy()
        resolve(value)
      }
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
      socket.setTimeout(700, () => finish(false))
    })
  }

  function waitForPort (target, timeout = 6000) {
    const started = Date.now()
    return new Promise((resolve) => {
      const tick = async () => {
        if (await portOpen(target)) return resolve(true)
        if (Date.now() - started > timeout) return resolve(false)
        setTimeout(tick, 120)
      }
      tick()
    })
  }

  /* 控制台：复用已有的 view-server 子进程；本机端口已被占用时直接复用 */
  async function startConsole (options = {}) {
    if (!enabled()) {
      return { ok: false, error: '记忆服务已关闭，先在设置里启用记忆库' }
    }
    ensureService()
    const write = options.write !== false
    /* 同一个端口只能有一种写权限：管理员写完再切成员查看时，
       不能复用那个还开着写接口的旧进程。 */
    if (consoleWrite !== null && consoleWrite !== write) stopConsole()
    if (await portOpen(port)) {
      return { ok: true, url: 'http://127.0.0.1:' + port, reused: true, write }
    }
    if (consoleStarting) return consoleStarting

    const script = viewServerPath || path.join(__dirname, 'view-server.js')
    consoleStarting = new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        consoleStarting = null
        resolve(value)
      }

      const proc = spawn(process.execPath, [script], {
        env: {
          ...process.env,
          /* Electron 可执行文件以纯 Node 模式运行这个脚本，打包后同样适用 */
          ELECTRON_RUN_AS_NODE: '1',
          MEMORY_CONFIG_DIR: configDir,
          MEMORY_VIEW_PORT: String(port),
          MEMORY_ENABLED: enabled() ? '1' : '0',
          /* 成员 / 游客打开控制台时只读；写接口完全由主进程身份决定，
             不依赖页面上的按钮是否被禁用。 */
          MEMORY_VIEW_WRITE: write ? '1' : '0'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      child = proc
      proc.once('error', (err) => {
        logger('记忆库控制台启动失败：' + err.message)
        child = null
        finish({ ok: false, error: err.message })
      })
      proc.stdout.on('data', (buf) => logger('[memory-view] ' + String(buf).trim()))
      proc.stderr.on('data', (buf) => logger('[memory-view] ' + String(buf).trim()))
      proc.once('exit', (code) => {
        if (child === proc) child = null
        logger('记忆库控制台退出（code=' + code + '）')
      })

      waitForPort(port).then((ready) => {
        if (!ready) {
          finish({ ok: false, error: '控制台启动超时' })
          return
        }
        consoleWrite = write
        finish({ ok: true, url: 'http://127.0.0.1:' + port, reused: false, write })
      })
    })
    return consoleStarting
  }

  function stopConsole () {
    if (child && !child.killed) {
      try { child.kill() } catch { /* 已退出 */ }
    }
    child = null
    consoleWrite = null
  }

  function stop () {
    stopConsole()
    if (service) {
      try { service.close() } catch { /* 已关闭 */ }
      service = null
    }
  }

  return {
    enabled,
    setEnabled,
    status,
    prompt,
    recall,
    messageRecord,
    messageDigest,
    messageGet,
    messageDigests,
    messageWeight,
    messageEdges,
    messageDimensions,
    messageGraph,
    teamToolboxSave,
    teamToolboxGet,
    teamToolboxFind,
    time,
    kb,
    inbox (input = {}) {
      if (!enabled()) return { ok: false, error: '记忆服务已关闭' }
      const s = ensureService()
      if (!s) return { ok: false, error: '记忆服务已关闭' }
      return s.inbox({ ...input })
    },
    /* 安全边界门面：无状态，每次现建；记忆服务关掉时返回 null（闸门也一起关） */
    security () {
      if (!enabled()) return null
      const s = ensureService()
      if (!s) return null
      return createSecurity({ configDir, store: s, logger })
    },
    scan,
    commitScout,
    syncProjects,
    net: weightNet,
    runTool,
    startConsole,
    stopConsole,
    stop,
    ensureService,
    getService: () => ensureService(),
    consoleUrl: () => 'http://127.0.0.1:' + port,
    port
  }
}

module.exports = { createMemoryHost }
