'use strict'

/**
 * intake/index.js — 消息接入核心
 *
 * 它不认任何具体平台，只做四件事：
 *   1. 管渠道（谁能收、开没开）
 *   2. 起停适配器（长连接 / 轮询 / 回调）
 *   3. 提供一个本地 HTTP 入口，被动渠道都从这里进
 *   4. 把收到的统一交给收件箱（归一化、去重、分流都在那一层）
 *
 * 「留接口」的具体含义就在 ADAPTERS 这张表：加一种渠道 = 加一个 kind + 一个适配器，
 * 核心逻辑、数据库、界面都不用改。用户看到的永远是同一套卡片和同一个开关。
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const CATALOG = require('./catalog.js')

const DEFAULT_PORT = 45890
const LOCAL_HOST = '127.0.0.1'

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** 令牌留空时自动生成一个：默认空令牌 + 局域网开放 = 谁都能往里灌消息。 */
function ensureToken (kind, config, secrets) {
  if (!['webhook', 'notify-relay'].includes(kind)) return { config, secrets }
  if (secrets.token) return { config, secrets }
  return { config, secrets: { ...secrets, token: require('node:crypto').randomBytes(16).toString('hex') } }
}

function createIntake ({ store, configDir, secretBox, log, onIngest } = {}) {
  if (!store) throw new Error('createIntake 需要 store')
  const cfgFile = path.join(configDir || '.', 'intake.json')
  const config = Object.assign({ port: DEFAULT_PORT }, readJson(cfgFile, {}))
  const logger = typeof log === 'function' ? log : () => {}

  const box = secretBox || memorySecretBox()
  const adapters = {
    'qq-personal': require('./adapters/onebot.js').createOneBotAdapter(),
    'qq-official': require('./adapters/qqbot.js').createQqBotAdapter(),
    'wecom': require('./adapters/wecom.js').createWeComAdapter(),
    'wechat-personal': require('./adapters/wechat-local.js').createWeChatLocalAdapter()
  }
  const httpAdapter = require('./adapters/http.js')
  const wechatLocal = adapters['wechat-personal']

  let server = null
  let started = false
  const state = new Map()

  function adapterFor (kind) {
    if (kind === 'webhook' || kind === 'notify-relay') return httpAdapter
    return adapters[kind] || null
  }

  function ctx () {
    return {
      ingest: (channelId, raws) => ingest(channelId, raws),
      setStatus: (channelId, status, error) => {
        store.inbox({ action: 'status', id: channelId, status, error })
      },
      saveCursor: (channelId, cursor) => {
        store.inbox({ action: 'cursor', id: channelId, cursor })
      },
      log: logger
    }
  }

  /* ---------------------------------------------------------- 渠道 */

  function channels () {
    const rows = store.inbox({ action: 'channels' })
    const list = rows.ok ? rows.data : []
    return list.map((channel) => {
      const adapter = adapterFor(channel.kind)
      let live = { running: false }
      if (adapter && typeof adapter.status === 'function') {
        try { live = adapter.status(channel.id) || live } catch { /* 适配器自己炸了不该拖垮列表 */ }
      }
      return { ...channel, live, secretsSet: Object.keys(box.get(channel.id) || {}) }
    })
  }

  function getChannel (id) {
    return channels().find((item) => item.id === id) || null
  }

  function saveChannel (input = {}) {
    const kind = CATALOG.get(input.kind)
    if (!kind) return { ok: false, error: '未知渠道类型' }
    const id = String(input.id || '').trim() || `${input.kind}-${Date.now().toString(36)}`
    const split = CATALOG.splitConfig(kind, input.values || input.config || {})
    const existingSecrets = box.get(id) || {}
    /* 密码类字段留空 = 沿用旧值：不能让「打开配置页什么都没改就保存」把 token 抹掉 */
    const mergedSecrets = { ...existingSecrets }
    for (const [key, value] of Object.entries(split.secrets)) {
      if (value !== '' && value !== undefined) mergedSecrets[key] = value
    }
    const withToken = ensureToken(kind.id, split.config, mergedSecrets)
    const check = CATALOG.validate(kind, withToken.config, withToken.secrets)
    if (!check.ok) return { ok: false, error: check.error, missing: check.missing }
    box.set(id, withToken.secrets)
    const saved = store.inbox({
      action: 'saveChannel',
      id,
      kind: kind.id,
      label: input.label || kind.label,
      enabled: input.enabled === true,
      config: withToken.config
    })
    if (!saved.ok) return { ok: false, error: saved.error }
    return { ok: true, channel: getChannel(id) }
  }

  function removeChannel (id) {
    stopChannel(id)
    box.set(id, {})
    return store.inbox({ action: 'removeChannel', id })
  }

  /* ---------------------------------------------------------- 生命周期 */

  async function startChannel (id) {
    const channel = getChannel(id)
    if (!channel) return { ok: false, error: '没有这个渠道' }
    const adapter = adapterFor(channel.kind)
    if (!adapter) return { ok: false, error: '这个渠道类型还没有实现' }
    if (!adapter.start) {
      store.inbox({ action: 'status', id, status: '运行中', error: '' })
      return { ok: true, status: '运行中' }
    }
    try {
      const result = await adapter.start(ctx(), channel, box.get(id) || {})
      state.set(id, { running: Boolean(result && result.ok) })
      return { ok: Boolean(result && result.ok), status: result && result.status, error: result && result.error, env: result && result.env }
    } catch (err) {
      store.inbox({ action: 'status', id, status: '启动失败', error: err.message })
      return { ok: false, error: err.message }
    }
  }

  async function stopChannel (id) {
    const adapter = adapterFor((getChannel(id) || {}).kind)
    if (adapter && typeof adapter.stop === 'function') {
      try { await adapter.stop(id) } catch { /* 停不下也得继续 */ }
    }
    state.delete(id)
    store.inbox({ action: 'status', id, status: '已停止', error: '' })
    return { ok: true }
  }

  async function setEnabled (id, enabled) {
    const channel = getChannel(id)
    if (!channel) return { ok: false, error: '没有这个渠道' }
    store.inbox({ action: 'enable', id, enabled })
    if (enabled) return startChannel(id)
    return stopChannel(id)
  }

  async function startAll () {
    const list = (store.inbox({ action: 'channels' }).data || []).filter((item) => item.enabled)
    const results = []
    for (const channel of list) results.push({ id: channel.id, ...(await startChannel(channel.id)) })
    started = true
    return results
  }

  async function stopAll () {
    for (const channel of (store.inbox({ action: 'channels' }).data || [])) {
      await stopChannel(channel.id)
    }
    started = false
  }

  function ingest (channelId, raws) {
    const result = store.inbox({ action: 'ingest', id: channelId, messages: raws })
    if (!result.ok) return { ok: false, error: result.error }
    /* 有新消息就喊一声：渲染层要拿它去刷新常驻上下文，
       否则「外面有人找你」要等切窗口才进提示词 —— 那已经不叫实时了。 */
    if (typeof onIngest === 'function' && Number(result.data.inserted) > 0) {
      try { onIngest({ channelId, ...result.data }) } catch { /* 通知失败不该丢消息 */ }
    }
    return result.data
  }

  /* ---------------------------------------------------------- HTTP 入口 */

  function listenHost () {
    const rows = store.inbox({ action: 'channels' }).data || []
    const lan = rows.some((channel) => channel.enabled && channel.config && channel.config.allowLan)
    return lan ? '0.0.0.0' : LOCAL_HOST
  }

  function readBody (req, limit = 1024 * 512) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) { resolve(''); req.destroy(); return }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
  }

  function send (res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(body === undefined ? '' : body)
  }

  async function handleHook (req, res, channelId) {
    const channel = getChannel(channelId)
    if (!channel) return send(res, 404, 'no such channel')
    if (!channel.enabled) return send(res, 403, 'channel disabled')
    const url = new URL(req.url, 'http://127.0.0.1')
    const query = Object.fromEntries(url.searchParams.entries())

    /* 企业微信是「回调」，有自己的验签与解密；其余走令牌 + 通用解析 */
    if (channel.kind === 'wecom') {
      if (!req.headers['x-forwarded-for'] && req.socket.remoteAddress && !isLocal(req.socket.remoteAddress) && !channel.config.allowLan) {
        return send(res, 403, 'lan not allowed')
      }
      const body = await readBody(req, 1024 * 1024)
      const out = await adapters.wecom.callback(ctx(), channel, box.get(channel.id) || {}, {
        method: req.method, query, body, headers: req.headers
      })
      return send(res, out.status || 200, out.body || 'success')
    }

    if (!isLocal(req.socket.remoteAddress) && !channel.config.allowLan) {
      return send(res, 403, 'lan not allowed')
    }
    const adapter = adapterFor(channel.kind)
    if (!adapter || typeof adapter.parse !== 'function') return send(res, 400, 'this channel is not http')
    const auth = adapter.authorize(channel, box.get(channel.id) || {}, req.headers, query)
    if (!auth.ok) return send(res, 401, auth.error || 'unauthorized')

    const body = await readBody(req)
    let raws = []
    try { raws = adapter.parse(channel, body, query) } catch (err) { return send(res, 400, 'bad payload: ' + err.message) }
    const result = ingest(channel.id, raws)
    send(res, 200, JSON.stringify({ ok: true, inserted: result.inserted || 0, duplicates: result.duplicates || 0, alerts: result.alerts || 0 }), 'application/json')
  }

  function isLocal (address) {
    return !address || address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1'
  }

  async function startServer () {
    if (server) return { ok: true, port: config.port }
    const port = Number(config.port) || DEFAULT_PORT
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        if (url.pathname === '/health') {
          return send(res, 200, JSON.stringify({ ok: true, uptime: process.uptime() }), 'application/json')
        }
        const match = /^\/hook\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)
        if (match) return handleHook(req, res, match[1])
        send(res, 404, 'not found')
      } catch (err) {
        send(res, 500, 'error: ' + err.message)
      }
    })
    await new Promise((resolve) => {
      server.once('error', () => resolve())
      server.listen(port, listenHost(), () => resolve())
    })
    return { ok: Boolean(server.listening), port, host: listenHost() }
  }

  async function stopServer () {
    if (!server) return
    await new Promise((resolve) => server.close(() => resolve()))
    server = null
  }

  function hookUrl (id) {
    const token = (box.get(id) || {}).token || ''
    const query = token ? `?token=${encodeURIComponent(token)}` : ''
    return `http://${LOCAL_HOST}:${config.port}/hook/${id}${query}`
  }

  function setPort (port) {
    const next = Number(port)
    if (!Number.isFinite(next) || next < 1024 || next > 65535) return { ok: false, error: '端口要在 1024–65535 之间' }
    config.port = next
    writeJson(cfgFile, config)
    return { ok: true, port: next }
  }

  return {
    list: channels,
    get: getChannel,
    catalog: () => CATALOG.list(),
    saveChannel,
    removeChannel,
    setEnabled,
    startChannel,
    stopChannel,
    startAll,
    stopAll,
    ingest,
    startServer,
    stopServer,
    hookUrl,
    setPort,
    port () { return config.port },
    started () { return started },
    /** 代发：只有渠道声明了 send 且适配器实现了才会真的发出去。 */
    async send (id, target = {}) {
      const channel = getChannel(id)
      if (!channel) return { ok: false, error: '没有这个渠道' }
      const adapter = adapterFor(channel.kind)
      if (!adapter || typeof adapter.send !== 'function') return { ok: false, error: '这条渠道不支持代发' }
      try {
        return await adapter.send(ctx(), channel, box.get(id) || {}, target)
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
    async detect (id) {
      const channel = getChannel(id)
      if (!channel) return { ok: false, error: '没有这个渠道' }
      if (channel.kind === 'wechat-personal' && wechatLocal.detect) {
        return { ok: true, env: await wechatLocal.detect(channel) }
      }
      return { ok: true, env: { ready: true, note: '这条渠道不需要本机环境检测' } }
    },
    async shutdown () {
      await stopAll()
      await stopServer()
    }
  }
}

/** 没有 Electron safeStorage 时（测试 / 纯 Node）用内存箱，绝不落盘明文。 */
function memorySecretBox () {
  const map = new Map()
  return {
    get (id) { return map.get(String(id)) || {} },
    set (id, value) { map.set(String(id), value || {}) }
  }
}

module.exports = { createIntake, memorySecretBox, ensureToken }
