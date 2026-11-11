'use strict'

/**
 * intake/adapters/qqbot.js — QQ 官方机器人
 *
 * 官方通道，形状由腾讯定死：先换 access_token，再拿网关地址，连 WS，
 * 收 op 0 的 dispatch 事件。群聊默认只有 @ 机器人才推（GROUP_AT_MESSAGE_CREATE），
 * 2026-06 起群主动推送需要群主手动开 —— 这是平台限制，不是我们没做。
 *
 * 与 onebot.js 刻意分成两个文件：一个是官方、一个是注入，
 * 生命周期相似但风险等级完全不同，混在一个适配器里会让「用户到底选了什么」变模糊。
 */

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API_BASE = 'https://api.sgroup.qq.com'
const INTENTS = (1 << 25) | (1 << 30) | (1 << 12)

function toRaw (eventName, d = {}) {
  const author = d.author || {}
  const group = String(eventName).startsWith('GROUP')
  const text = String(d.content || '').trim()
  /* 官方会带 <@!123> 这类标记，去掉但保留「叫了你」这个事实 */
  const mentionsMe = /<@!?\d+>/.test(text) || String(eventName).includes('AT_MESSAGE')
  const clean = text.replace(/<@!?\d+>/g, '').trim()
  return {
    text: clean || text,
    scope: group ? 'group' : 'private',
    chatId: String(d.group_openid || d.channel_id || author.id || 'qq'),
    chatName: group ? ('群 ' + String(d.group_openid || '').slice(0, 8)) : String(author.username || author.id || '私聊'),
    senderId: String(author.id || ''),
    senderName: String(author.username || author.id || ''),
    msgId: String(d.id || ''),
    at: d.timestamp ? Date.parse(d.timestamp) || Date.now() : Date.now(),
    mentionsMe,
    raw: { event: eventName }
  }
}

function createQqBotAdapter () {
  const sessions = new Map()

  async function fetchToken (channel, secrets) {
    const body = JSON.stringify({ appId: channel.config.appId, clientSecret: secrets.appSecret })
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data || !data.access_token) {
      throw new Error((data && (data.message || data.msg)) || `取 token 失败 HTTP ${res.status}`)
    }
    return { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000 }
  }

  async function fetchGateway (token) {
    const res = await fetch(API_BASE + '/gateway', { headers: { Authorization: 'QQBot ' + token } })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data || !data.url) {
      throw new Error((data && data.message) || `取网关失败 HTTP ${res.status}`)
    }
    return data.url
  }

  function closeSession (channelId) {
    const session = sessions.get(channelId)
    if (!session) return
    session.stopped = true
    if (session.heartbeat) clearInterval(session.heartbeat)
    if (session.reconnect) clearTimeout(session.reconnect)
    try { session.ws && session.ws.close() } catch { /* 忽略 */ }
    sessions.delete(channelId)
  }

  async function connect (ctx, channel, secrets) {
    const session = sessions.get(channel.id)
    if (!session || session.stopped) return
    try {
      const { token, expiresAt } = await fetchToken(channel, secrets)
      session.token = token
      session.expiresAt = expiresAt
      const url = await fetchGateway(token)
      if (session.stopped) return
      const ws = new WebSocket(url)
      session.ws = ws
      let seq = null

      ws.addEventListener('open', () => ctx.setStatus(channel.id, '运行中', ''))

      ws.addEventListener('message', (event) => {
        let payload
        try { payload = JSON.parse(String(event.data)) } catch { return }
        if (!payload || typeof payload !== 'object') return
        if (payload.s !== undefined && payload.s !== null) seq = payload.s

        if (payload.op === 10) {
          const interval = Number(payload.d && payload.d.heartbeat_interval) || 30000
          session.heartbeat = setInterval(() => {
            try {
              ws.send(JSON.stringify({ op: 1, d: seq }))
            } catch { /* 等 close 处理 */ }
          }, interval)
          if (session.heartbeat.unref) session.heartbeat.unref()
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: 'QQBot ' + token,
              intents: INTENTS,
              shard: [0, 1],
              properties: { $os: process.platform, $browser: 'astral', $device: 'desktop' }
            }
          }))
          return
        }
        if (payload.op === 7) {
          /* 服务端要求重连 */
          try { ws.close() } catch { /* 忽略 */ }
          return
        }
        if (payload.op === 9) {
          ctx.setStatus(channel.id, '鉴权失败', 'intents 或 token 不对，检查 AppID / AppSecret')
          return
        }
        if (payload.op !== 0 || !payload.t) return

        const name = payload.t
        if (!/MESSAGE_CREATE$/.test(name)) return
        const raw = toRaw(name, payload.d || {})
        if (!raw.text) return
        ctx.ingest(channel.id, [raw])
      })

      ws.addEventListener('close', () => {
        if (session.stopped) return
        ctx.setStatus(channel.id, '已断开', '网关连接关闭，正在重连')
        session.reconnect = setTimeout(() => connect(ctx, channel, secrets), 5000)
        if (session.reconnect.unref) session.reconnect.unref()
      })
      ws.addEventListener('error', () => { /* close 会紧随其后 */ })
    } catch (err) {
      ctx.setStatus(channel.id, '连接失败', err.message)
      session.reconnect = setTimeout(() => connect(ctx, channel, secrets), 15000)
      if (session.reconnect.unref) session.reconnect.unref()
    }
  }

  return {
    passive: false,

    async start (ctx, channel, secrets) {
      closeSession(channel.id)
      sessions.set(channel.id, { ws: null, heartbeat: null, reconnect: null, stopped: false })
      connect(ctx, channel, secrets)
      return { ok: true, status: '连接中' }
    },

    async stop (channelId) {
      closeSession(channelId)
      return { ok: true, status: '已停止' }
    },

    async send (ctx, channel, secrets, target = {}) {
      if (!channel.config.allowSend) return { ok: false, error: '这个渠道没有开启代发' }
      const session = sessions.get(channel.id)
      if (!session || !session.token) return { ok: false, error: '没有可用的 token' }
      const path = target.scope === 'private'
        ? `/v2/users/${target.chatId}/messages`
        : `/v2/groups/${target.chatId}/messages`
      const res = await fetch(API_BASE + path, {
        method: 'POST',
        headers: {
          Authorization: 'QQBot ' + session.token,
          'Content-Type': 'application/json',
          'X-Union-Appid': channel.config.appId
        },
        body: JSON.stringify({ content: String(target.text || ''), msg_type: 0 })
      })
      return res.ok ? { ok: true } : { ok: false, error: `发送失败 HTTP ${res.status}` }
    },

    status (channelId) {
      const session = sessions.get(channelId)
      if (!session) return { running: false }
      return { running: Boolean(session.ws && session.ws.readyState === 1), token: Boolean(session.token) }
    }
  }
}

module.exports = { createQqBotAdapter, toRaw, INTENTS }
