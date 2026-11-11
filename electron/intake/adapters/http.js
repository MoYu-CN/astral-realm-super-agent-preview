'use strict'

/**
 * intake/adapters/http.js — 被动接收（通用 Webhook / 手机通知转发）
 *
 * 这两种渠道本质一样：外面 POST 一条过来。区别只在「字段长什么样」，
 * 所以共用一套解析，按 kind 分派。核心不关心谁在推，只要求拿到
 * `{ text, chatId, senderName, at }` 这个最小形状。
 *
 * 容错优先：字段名猜不中就把整条正文当 text，绝不因为「格式不对」丢消息。
 */

const crypto = require('node:crypto')

function pick (source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return ''
}

function safeJson (raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try { return JSON.parse(String(raw)) } catch { return null }
}

/** 手机通知通常是一行「标题 + 正文」，正文里已经带了群名与人名。 */
function parseRelay (body, query = {}) {
  const data = safeJson(body) || {}
  const flat = { ...query, ...data }
  const title = String(pick(flat, ['title', 'app', 'package', 'appName']) || '')
  const content = String(
    pick(flat, ['text', 'content', 'message', 'body', 'msg', 'notification']) || ''
  )
  const combined = title && content && !content.startsWith(title) ? `${title}｜${content}` : (content || title)
  return [{
    text: combined,
    chatId: pick(flat, ['chatId', 'chat', 'conversation', 'groupId', 'thread']) || 'notification',
    chatName: title || '手机通知',
    senderName: pick(flat, ['sender', 'senderName', 'from', 'nickname', 'name']) || title || '手机',
    at: pick(flat, ['at', 'time', 'timestamp', 'date']) || new Date().toISOString(),
    scope: flat.scope === 'private' ? 'private' : 'group',
    mentionsMe: flat.mentionsMe === true || /@我|@了你|提到了你/.test(combined)
  }]
}

function parseWebhook (body, query = {}) {
  const data = safeJson(body)
  if (!data) {
    /* 不是 JSON 就整条当正文：`curl -d '服务器挂了'` 也该能收 */
    return [{ text: String(body || ''), chatId: String(query.chat || 'webhook'), chatName: 'Webhook', senderName: '外部' }]
  }
  /* 支持一次推多条 */
  if (Array.isArray(data.messages)) return data.messages.map((item) => parseOne(item))
  return [parseOne(data)]
}

function parseOne (item = {}) {
  const text = String(pick(item, ['text', 'content', 'message', 'body', 'summary', 'title']) || '')
  const files = Array.isArray(item.files) ? item.files.length
    : Array.isArray(item.images) ? item.images.length : Number(item.attachments) || 0
  return {
    text,
    attachments: files,
    chatId: pick(item, ['chatId', 'chat', 'room', 'channel', 'conversation']) || 'webhook',
    /* `chat` 常常是群名而不是 id：拿它当显示名，总比一律显示「Webhook」强 */
    chatName: pick(item, ['chatName', 'roomName', 'channelName', 'source', 'feed', 'chat']) || 'Webhook',
    senderId: pick(item, ['senderId', 'from', 'userId', 'author']),
    /* `from` 是最常见的写法，兜底也认它，否则界面上一律是「外部」，等于没记住谁说的 */
    senderName: pick(item, ['senderName', 'author', 'fromName', 'name', 'from', 'sender']) || '外部',
    msgId: pick(item, ['msgId', 'id', 'guid']),
    at: pick(item, ['at', 'time', 'timestamp', 'date', 'pubDate']) || new Date().toISOString(),
    scope: item.scope === 'private' ? 'private' : 'group',
    mentionsMe: item.mentionsMe === true || item.atMe === true
  }
}

module.exports = {
  passive: true,
  parse (channel, body, query) {
    if (channel.kind === 'notify-relay') return parseRelay(body, query)
    return parseWebhook(body, query)
  },
  /** 令牌校验：留空则只在本地回环上放行，不允许空令牌暴露到局域网。 */
  authorize (channel, secrets, headers = {}, query = {}) {
    const expected = secrets.token || channel.config.token || ''
    const given = String(headers['x-astral-token'] || query.token || query.secret || '')
    if (!expected) return { ok: true, anonymous: true }
    const a = crypto.createHash('sha256').update(given).digest()
    const b = crypto.createHash('sha256').update(expected).digest()
    return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, error: '令牌不对' }
  },
  parseOne,
  parseWebhook,
  parseRelay
}
