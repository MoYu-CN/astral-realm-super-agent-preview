'use strict'

/**
 * intake/adapters/wechat-local.js — 微信个人号（本地只读）
 *
 * 这条渠道的能力是「拿到全部历史与群聊」，代价是它必须读本机的加密库。
 * 这里刻意不自己实现解密：SQLCipher + WCDB 的细节随微信版本变，
 * 硬编一套进来只会变成「升级即失效且没人看得懂」的代码。
 *
 * 所以做成**桥接契约**，两种后端：
 *   command —— 任意程序，按约定往 stdout 打 JSONL，一行一条消息（首选，最可控）
 *   chatlog —— 本机已有 chatlog 的 HTTP 服务时，直接按它的接口拉
 *
 * 好处是：换了工具不用改这里；我们也不替用户打包任何来路不明的二进制。
 * 契约写在 docs/消息接入-适配器契约.md，谁都能写一个自己的桥。
 */

const { execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const MIN_INTERVAL = 15000

function run (cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : '' })
    })
  })
}

/** 微信 4.x 把库放在 Documents\xwechat_files\<wxid>\db_storage */
function findDbRoots () {
  const home = os.homedir()
  const candidates = [
    path.join(home, 'Documents', 'xwechat_files'),
    path.join(home, 'Documents', 'WeChat Files')
  ]
  const found = []
  for (const root of candidates) {
    if (!fs.existsSync(root)) continue
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const db = path.join(root, entry.name, 'db_storage')
      if (fs.existsSync(db)) found.push({ account: entry.name, dbRoot: db })
    }
  }
  return found
}

/** 把桥接输出的一条东西翻成统一形状；认不出字段就整条当正文。 */
function toRaw (item = {}) {
  const chatId = String(item.chatId ?? item.talker ?? item.roomId ?? item.conversationId ?? 'wechat')
  const isRoom = item.scope === 'group' || item.isChatRoom === true || /@chatroom$/.test(chatId)
  const text = String(item.text ?? item.content ?? item.body ?? '')
  return {
    text,
    attachments: Number(item.attachments) || (Array.isArray(item.files) ? item.files.length : 0),
    scope: isRoom ? 'group' : 'private',
    chatId,
    chatName: String(item.chatName ?? item.talkerName ?? item.roomName ?? chatId),
    senderId: String(item.senderId ?? item.sender ?? ''),
    senderName: String(item.senderName ?? item.nickname ?? item.sender ?? ''),
    msgId: String(item.msgId ?? item.id ?? item.localId ?? ''),
    at: item.at ?? item.time ?? item.createTime ?? Date.now(),
    mentionsMe: item.mentionsMe === true,
    raw: undefined
  }
}

function createWeChatLocalAdapter () {
  const pollers = new Map()

  function stopPoll (channelId) {
    const poller = pollers.get(channelId)
    if (!poller) return
    poller.stopped = true
    if (poller.timer) clearInterval(poller.timer)
    pollers.delete(channelId)
  }

  async function detect (channel) {
    const dbRoots = channel && channel.config.dbRoot
      ? [{ account: '自定义', dbRoot: path.resolve(channel.config.dbRoot) }]
      : findDbRoots()
    const process = await run('tasklist', ['/FI', 'IMAGENAME eq Weixin.exe', '/NH'])
    const running = /weixin\.exe/i.test(process.stdout)
    const bridge = channel && channel.config.bridgeCmd ? String(channel.config.bridgeCmd).trim() : ''
    return {
      accounts: dbRoots,
      wechatRunning: running,
      bridge: bridge || '',
      backend: backendOf(channel),
      ready: Boolean(dbRoots.length) && (Boolean(bridge) || backendOf(channel) === 'chatlog')
    }
  }

  function backendOf (channel) {
    const explicit = channel && channel.config.backend
    if (explicit && explicit !== 'auto') return explicit
    if (channel && channel.config.bridgeCmd) return 'command'
    return 'chatlog'
  }

  async function pullCommand (ctx, channel, cursor) {
    const cmd = String(channel.config.bridgeCmd || '').trim()
    if (!cmd) return []
    const since = cursor && cursor.since ? String(cursor.since) : ''
    /* 约定：`<bridge> --since <ISO 或 0>`，stdout 每行一条 JSON。
       用 shell:false + 手拆参数，避免把用户配置当命令执行。 */
    const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || []
    const bin = (parts.shift() || '').replace(/^"|"$/g, '')
    if (!bin) return []
    const result = await run(bin, [...parts, '--since', since || '0'], 30000)
    if (!result.ok) {
      ctx.setStatus(channel.id, '读取失败', result.stderr || result.error)
      return []
    }
    const out = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed[0] !== '{') continue
      try { out.push(toRaw(JSON.parse(trimmed))) } catch { /* 半行就跳过 */ }
    }
    return out
  }

  async function pullChatlog (ctx, channel, cursor) {
    const base = String(channel.config.chatlogUrl || 'http://127.0.0.1:5030').replace(/\/+$/, '')
    const since = (cursor && cursor.since) || new Date(Date.now() - 86400000).toISOString()
    const day = since.slice(0, 10)
    const out = []
    let sessions = []
    try {
      const res = await fetch(`${base}/api/v1/session`, { signal: AbortSignal.timeout(8000) })
      const data = await res.json()
      sessions = (Array.isArray(data) ? data : (data && data.sessions) || []).slice(0, 60)
    } catch (err) {
      ctx.setStatus(channel.id, '桥接不可达', `连不上 ${base}：${err.message}`)
      return []
    }
    for (const session of sessions) {
      const talker = session.talker || session.id || session.userName
      if (!talker) continue
      try {
        const url = `${base}/api/v1/chatlog?time=${encodeURIComponent(day)}&talker=${encodeURIComponent(talker)}&format=json&limit=200`
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
        const data = await res.json()
        const list = Array.isArray(data) ? data : (data && data.messages) || []
        for (const item of list) {
          const at = item.time || item.createTime || item.timestamp
          if (since && at && new Date(at).getTime() < new Date(since).getTime()) continue
          out.push(toRaw({ ...item, talker }))
        }
      } catch { /* 单个会话失败不拖垮整轮 */ }
    }
    return out
  }

  async function tick (ctx, channel, secrets, poller) {
    if (poller.running) return
    poller.running = true
    try {
      const cursor = poller.cursor || {}
      const backend = backendOf(channel)
      const raws = backend === 'command'
        ? await pullCommand(ctx, channel, cursor)
        : await pullChatlog(ctx, channel, cursor)
      if (!raws.length) {
        if (poller.status !== '运行中') ctx.setStatus(channel.id, '运行中', '')
        return
      }
      ctx.ingest(channel.id, raws)
      const latest = raws.reduce((max, item) => {
        const at = new Date(item.at).getTime()
        return Number.isFinite(at) && at > max ? at : max
      }, new Date(cursor.since || 0).getTime())
      poller.cursor = { since: new Date(latest + 1).toISOString() }
      ctx.saveCursor(channel.id, poller.cursor)
      ctx.setStatus(channel.id, '运行中', '')
    } catch (err) {
      ctx.setStatus(channel.id, '读取失败', err.message)
    } finally {
      poller.running = false
    }
  }

  return {
    passive: false,
    detect,

    async start (ctx, channel, secrets) {
      stopPoll(channel.id)
      const env = await detect(channel)
      if (!env.ready) {
        const why = !env.accounts.length
          ? '没找到微信数据目录：先在电脑微信里登录并同步聊天记录'
          : '没有可用的桥接：填「外部桥接命令」，或在本机跑一个 chatlog 服务'
        ctx.setStatus(channel.id, '缺条件', why)
        return { ok: false, error: why, env }
      }
      const seconds = Math.max(MIN_INTERVAL / 1000, Number(channel.config.pollSeconds) || 60)
      const poller = {
        timer: null, running: false, stopped: false,
        cursor: (channel.cursor && channel.cursor.since) ? channel.cursor : { since: new Date(Date.now() - 300000).toISOString() }
      }
      pollers.set(channel.id, poller)
      ctx.setStatus(channel.id, '运行中', '')
      tick(ctx, channel, secrets, poller)
      poller.timer = setInterval(() => tick(ctx, channel, secrets, poller), seconds * 1000)
      if (poller.timer.unref) poller.timer.unref()
      return { ok: true, status: '运行中', env }
    },

    async stop (channelId) {
      stopPoll(channelId)
      return { ok: true, status: '已停止' }
    },

    status (channelId) {
      const poller = pollers.get(channelId)
      return { running: Boolean(poller && !poller.stopped), cursor: poller ? poller.cursor : null }
    }
  }
}

module.exports = { createWeChatLocalAdapter, toRaw, findDbRoots }
