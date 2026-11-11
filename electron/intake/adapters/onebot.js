'use strict'

/**
 * intake/adapters/onebot.js — QQ 个人号（OneBot v11）
 *
 * 走「正向 WebSocket」：我们主动连 NapCat / Lagrange / LLOneBot 暴露的 ws 服务，
 * 不在自己这边开 ws 服务端 —— 少一个对外端口，也少一份被扫的风险。
 *
 * 只做两件事：把事件翻成统一消息、按配置决定能不能代发。
 * 默认 allowSend=false：发出去的东西收不回来，默认就不给这个能力。
 * （send 留在这里是为了「接口齐」，不是鼓励打开。）
 */

const BACKOFF_MS = [2000, 5000, 15000, 30000, 60000]

function textOf (segments, selfId) {
  if (typeof segments === 'string') return { text: segments, mentionsMe: false }
  if (!Array.isArray(segments)) return { text: '', mentionsMe: false }
  let text = ''
  let mentionsMe = false
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue
    if (seg.type === 'text') text += String((seg.data && seg.data.text) || '')
    else if (seg.type === 'at') {
      const qq = String((seg.data && seg.data.qq) || '')
      if (qq === 'all') text += '@全体成员'
      else if (selfId && qq === String(selfId)) { mentionsMe = true; text += '@你' }
      else text += '@' + (seg.data && (seg.data.name || seg.data.qq) || '某人')
    } else if (seg.type === 'image') text += '[图片]'
    else if (seg.type === 'face') text += '[表情]'
    else if (seg.type === 'reply') continue
    else if (seg.type === 'file') text += '[文件]'
    else if (seg.type === 'record') text += '[语音]'
    else if (seg.type === 'video') text += '[视频]'
  }
  return { text: text.trim(), mentionsMe }
}

function attachCount (segments) {
  if (!Array.isArray(segments)) return 0
  return segments.filter((seg) => seg && ['image', 'file', 'video', 'record'].includes(seg.type)).length
}

function toRaw (event, selfId) {
  const messageType = event.message_type === 'private' ? 'private' : 'group'
  const { text, mentionsMe } = textOf(event.message ?? event.raw_message, selfId)
  const sender = event.sender || {}
  return {
    text,
    attachments: attachCount(event.message),
    scope: messageType,
    chatId: String(messageType === 'group' ? event.group_id : event.user_id),
    chatName: messageType === 'group'
      ? String(event.group_name || ('群 ' + event.group_id))
      : String(sender.card || sender.nickname || event.user_id),
    senderId: String(event.user_id || ''),
    senderName: String(sender.card || sender.nickname || event.user_id || ''),
    msgId: String(event.message_id || ''),
    at: event.time ? Number(event.time) * 1000 : Date.now(),
    mentionsMe,
    raw: { sub_type: event.sub_type, message_type: event.message_type }
  }
}

function createOneBotAdapter () {
  const sessions = new Map()

  function closeSession (channelId) {
    const session = sessions.get(channelId)
    if (!session) return
    session.stopped = true
    if (session.timer) clearTimeout(session.timer)
    try { session.ws && session.ws.close() } catch { /* 已经断了 */ }
    sessions.delete(channelId)
  }

  function scheduleReconnect (ctx, channel, secrets) {
    const session = sessions.get(channel.id)
    if (!session || session.stopped) return
    const delay = BACKOFF_MS[Math.min(session.attempts, BACKOFF_MS.length - 1)]
    session.attempts += 1
    session.timer = setTimeout(() => connect(ctx, channel, secrets), delay)
    if (session.timer.unref) session.timer.unref()
  }

  function connect (ctx, channel, secrets) {
    const session = sessions.get(channel.id)
    if (!session || session.stopped) return
    const url = String(channel.config.wsUrl || '').trim()
    if (!url) {
      ctx.setStatus(channel.id, '配置不全', '缺少 OneBot 地址')
      return
    }
    let ws
    try {
      /* 全局 WebSocket 只在 Node 22+ 有；Electron 45 自带，够用 */
      ws = new WebSocket(url, {
        headers: secrets.accessToken ? { Authorization: 'Bearer ' + secrets.accessToken } : undefined
      })
    } catch (err) {
      ctx.setStatus(channel.id, '连接失败', err.message)
      scheduleReconnect(ctx, channel, secrets)
      return
    }
    session.ws = ws

    ws.addEventListener('open', () => {
      session.attempts = 0
      ctx.setStatus(channel.id, '运行中', '')
    })

    ws.addEventListener('message', (event) => {
      let payload
      try { payload = JSON.parse(String(event.data)) } catch { return }
      if (!payload || typeof payload !== 'object') return
      if (payload.post_type !== 'message' && payload.post_type !== 'message_sent') return
      /* 自己发出去的消息默认不收：会把「我说话」当成「别人说话」记进权重 */
      if (payload.post_type === 'message_sent') return
      const selfId = channel.config.selfId || payload.self_id
      const raw = toRaw(payload, selfId)
      if (!raw.text && !raw.attachments) return
      ctx.ingest(channel.id, [raw])
    })

    ws.addEventListener('error', () => {
      /* error 之后一定会 close，重连交给 close 处理，避免双触发 */
    })

    ws.addEventListener('close', () => {
      if (session.stopped) return
      ctx.setStatus(channel.id, '已断开', '连接关闭，正在重连')
      scheduleReconnect(ctx, channel, secrets)
    })
  }

  return {
    passive: false,

    async start (ctx, channel, secrets) {
      closeSession(channel.id)
      sessions.set(channel.id, { ws: null, attempts: 0, timer: null, stopped: false })
      connect(ctx, channel, secrets)
      return { ok: true, status: '连接中' }
    },

    async stop (channelId) {
      closeSession(channelId)
      return { ok: true, status: '已停止' }
    },

    /** 代发：默认不开放，配置里 allowSend 打开才走这里。 */
    async send (ctx, channel, secrets, target = {}) {
      if (!channel.config.allowSend) return { ok: false, error: '这个渠道没有开启代发' }
      const session = sessions.get(channel.id)
      if (!session || !session.ws || session.ws.readyState !== 1) return { ok: false, error: '没有连接' }
      const action = target.scope === 'private' ? 'send_private_msg' : 'send_group_msg'
      const params = target.scope === 'private'
        ? { user_id: target.chatId, message: String(target.text || '') }
        : { group_id: target.chatId, message: String(target.text || '') }
      session.ws.send(JSON.stringify({ action, params, echo: Date.now() }))
      return { ok: true }
    },

    status (channelId) {
      const session = sessions.get(channelId)
      if (!session) return { running: false }
      const ready = session.ws ? session.ws.readyState : 3
      return { running: ready === 1, ready, attempts: session.attempts }
    }
  }
}

module.exports = { createOneBotAdapter, toRaw, textOf }
