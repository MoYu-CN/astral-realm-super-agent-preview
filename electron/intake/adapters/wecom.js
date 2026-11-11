'use strict'

/**
 * intake/adapters/wecom.js — 企业微信（官方自建应用回调）
 *
 * 官方通道里最"正规"的一条：微信服务器把加密事件 POST 到我们的回调地址，
 * 我们验签、解密、回 success。全程不需要登录，也不碰任何客户端。
 *
 * 加密方式是企业微信/公众号通用的 WXBizMsgCrypt：
 *   AES-256-CBC，key = Base64(EncodingAESKey + '=')，IV = key 前 16 字节，
 *   明文 = 随机16字节 + 长度(4, 大端) + 正文 + receiveid，PKCS7 补到 32 字节。
 *
 * 一个坑：补位块大小是 32，不是 16。用 Node 默认的 PKCS7 会解出乱码，
 * 所以这里关掉自动补位、自己剥。
 */

const crypto = require('node:crypto')

const TOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken'

function signature (token, timestamp, nonce, encrypt) {
  const raw = [token, timestamp, nonce, encrypt].map(String).sort().join('')
  return crypto.createHash('sha1').update(raw).digest('hex')
}

function aesKeyOf (encodingAesKey) {
  const key = Buffer.from(String(encodingAesKey || '') + '=', 'base64')
  if (key.length !== 32) throw new Error('EncodingAESKey 必须是 43 位')
  return key
}

function decrypt (encodingAesKey, encryptBase64) {
  const key = aesKeyOf(encodingAesKey)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  let buf = Buffer.concat([decipher.update(Buffer.from(String(encryptBase64), 'base64')), decipher.final()])
  const pad = buf[buf.length - 1]
  if (pad < 1 || pad > 32) throw new Error('解密填充不合法')
  buf = buf.subarray(0, buf.length - pad)
  if (buf.length < 20) throw new Error('解密内容过短')
  const len = buf.readUInt32BE(16)
  return buf.subarray(20, 20 + len).toString('utf8')
}

function encrypt (encodingAesKey, text, receiveId = '') {
  const key = aesKeyOf(encodingAesKey)
  const random = crypto.randomBytes(16)
  const body = Buffer.from(String(text), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length, 0)
  let buf = Buffer.concat([random, len, body, Buffer.from(String(receiveId), 'utf8')])
  const pad = 32 - (buf.length % 32)
  buf = Buffer.concat([buf, Buffer.alloc(pad, pad)])
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(buf), cipher.final()]).toString('base64')
}

function tag (xml, name) {
  const match = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(String(xml || ''))
  return match ? match[1].trim() : ''
}

function toRaw (xml) {
  const msgType = tag(xml, 'MsgType')
  const from = tag(xml, 'FromUserName')
  const to = tag(xml, 'ToUserName')
  const agentId = tag(xml, 'AgentID')
  const text = msgType === 'text'
    ? tag(xml, 'Content')
    : msgType === 'event'
      ? `[事件] ${tag(xml, 'Event')}${tag(xml, 'EventKey') ? ' ' + tag(xml, 'EventKey') : ''}`
      : `[${msgType || '未知'}]`
  const seconds = Number(tag(xml, 'CreateTime')) || Math.floor(Date.now() / 1000)
  return {
    text,
    scope: 'private',
    /* 企业微信单聊没有群 id：以「谁发给这个应用」做会话 */
    chatId: from || 'wecom',
    chatName: '企业微信 · ' + (from || agentId || '应用'),
    senderId: from,
    senderName: from,
    msgId: tag(xml, 'MsgId'),
    at: seconds * 1000,
    raw: { msgType, agentId, to }
  }
}

function createWeComAdapter () {
  const tokens = new Map()

  async function accessToken (channel, secrets) {
    const cached = tokens.get(channel.id)
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.token
    const url = `${TOKEN_URL}?corpid=${encodeURIComponent(channel.config.corpId || '')}&corpsecret=${encodeURIComponent(secrets.secret || '')}`
    const res = await fetch(url)
    const data = await res.json().catch(() => null)
    if (!data || !data.access_token) throw new Error((data && data.errmsg) || '取 access_token 失败')
    tokens.set(channel.id, { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000 })
    return data.access_token
  }

  return {
    passive: true,

    /** 回调入口：GET 是配置时的 URL 校验，POST 是真实消息。 */
    async callback (ctx, channel, secrets, req) {
      const query = req.query || {}
      const token = secrets.callbackToken || ''
      const aesKey = secrets.aesKey || ''

      if (req.method === 'GET') {
        const echo = query.echostr || ''
        if (!aesKey) return { status: 200, body: echo }
        const expect = signature(token, query.timestamp, query.nonce, echo)
        if (expect !== query.msg_signature) return { status: 403, body: 'signature mismatch' }
        try { return { status: 200, body: decrypt(aesKey, echo) } } catch (err) { return { status: 500, body: err.message } }
      }

      const encrypt = tag(req.body, 'Encrypt')
      if (!encrypt) {
        /* 明文模式（没配加密）也能收，虽然不推荐 */
        const raw = toRaw(req.body)
        if (raw.text) ctx.ingest(channel.id, [raw])
        return { status: 200, body: 'success' }
      }
      const expect = signature(token, query.timestamp, query.nonce, encrypt)
      if (expect !== query.msg_signature) return { status: 403, body: 'signature mismatch' }
      try {
        const xml = decrypt(aesKey, encrypt)
        const raw = toRaw(xml)
        if (raw.text) ctx.ingest(channel.id, [raw])
        return { status: 200, body: 'success' }
      } catch (err) {
        ctx.setStatus(channel.id, '解密失败', err.message)
        return { status: 500, body: 'decrypt failed' }
      }
    },

    async start (ctx, channel, secrets) {
      /* 被动接收：没有长连接，只验证配置能否换到 token */
      try {
        await accessToken(channel, secrets)
        ctx.setStatus(channel.id, '运行中', '')
        return { ok: true, status: '运行中' }
      } catch (err) {
        ctx.setStatus(channel.id, '配置不全', err.message)
        return { ok: false, error: err.message }
      }
    },

    async stop (channelId) {
      tokens.delete(channelId)
      return { ok: true, status: '已停止' }
    },

    async send (ctx, channel, secrets, target = {}) {
      const token = await accessToken(channel, secrets)
      const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: target.chatId || '@all',
          msgtype: 'text',
          agentid: Number(channel.config.agentId) || 0,
          text: { content: String(target.text || '') }
        })
      })
      const data = await res.json().catch(() => null)
      return data && data.errcode === 0 ? { ok: true } : { ok: false, error: (data && data.errmsg) || '发送失败' }
    },

    verifyCallback (channel, secrets, query = {}) {
      const token = secrets.callbackToken || ''
      const aesKey = secrets.aesKey || ''
      if (!aesKey) return { ok: true, plain: true }
      const echo = query.echostr || ''
      return signature(token, query.timestamp, query.nonce, echo) === query.msg_signature
        ? { ok: true }
        : { ok: false, error: '签名不匹配：Token 或 EncodingAESKey 不对' }
    }
  }
}

module.exports = { createWeComAdapter, signature, encrypt, decrypt, toRaw, tag }
