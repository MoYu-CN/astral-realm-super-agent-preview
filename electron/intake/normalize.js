'use strict'

/**
 * intake/normalize.js — 归一化与分流（纯函数，可单测）
 *
 * 所有渠道吐出来的东西长得都不一样：企业微信是 XML、OneBot 是 JSON、
 * 通知转发是一行文本。这里是唯一把它们压成同一形状的地方。
 *
 * 分流不写在适配器里，也不写在界面上：适配器只负责「拿到」，这里负责「怎么办」。
 * 这样换渠道不影响分流规则，调分流规则也不用碰适配器。
 */

const crypto = require('node:crypto')

/* ------------------------------------------------------------ 归一化 */

function text (value, max = 4000) {
  if (value === undefined || value === null) return ''
  const str = String(value).replace(/\u0000/g, '').trim()
  return str.length > max ? str.slice(0, max) : str
}

function iso (value) {
  if (!value) return new Date().toISOString()
  if (typeof value === 'number') {
    /* 秒级与毫秒级都可能来：小于 1e12 的当秒 */
    const ms = value < 1e12 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

/** 同一条消息可能从手机转发和桌面库各来一次，键必须稳定且与到达顺序无关。 */
function dedupeKey (channelId, msg) {
  /* 有消息 id 就用 id；没有 id（转发、告警）时把时间压到分钟 ——
     否则「同一分钟重复推」会各算一条，权重被自己刷高。 */
  const stamp = msg.msgId ? '' : String(msg.at || '').slice(0, 16)
  const base = [
    channelId,
    msg.chatId || '',
    msg.msgId || '',
    stamp,
    msg.senderId || '',
    (msg.text || '').slice(0, 64)
  ].join('\u0000')
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 20)
}

/**
 * @param {object} channel `{ id, kind, label }`
 * @param {object} raw 各渠道自己的形状
 * @returns {{ok:boolean, message?:object, error?:string}}
 */
function normalize (channel, raw = {}) {
  const body = text(raw.text ?? raw.content ?? raw.body, 8000)
  const attachments = Number(raw.attachments) || (Array.isArray(raw.files) ? raw.files.length : 0)
  /* 纯图片 / 纯表情也值得进收件箱：它至少说明「这个群在动」，
     只是正文为空、要在摘要里标出来。整条完全空才丢弃。 */
  if (!body && !attachments) return { ok: false, error: '空消息' }

  const msg = {
    channelId: channel.id,
    kind: channel.kind,
    scope: raw.scope === 'private' ? 'private' : 'group',
    chatId: text(raw.chatId ?? raw.roomId ?? raw.conversationId ?? 'default', 120) || 'default',
    chatName: text(raw.chatName ?? raw.roomName ?? raw.conversationName, 120),
    senderId: text(raw.senderId ?? raw.userId ?? raw.from, 120),
    senderName: text(raw.senderName ?? raw.nickname ?? raw.fromName, 60),
    msgId: text(raw.msgId ?? raw.messageId ?? raw.id, 120),
    at: iso(raw.at ?? raw.time ?? raw.timestamp),
    text: body,
    attachments,
    mentionsMe: raw.mentionsMe === true || raw.atMe === true || raw.mentioned === true,
    raw: raw.raw === undefined ? undefined : raw.raw
  }
  if (!msg.chatName) msg.chatName = msg.scope === 'private' ? (msg.senderName || '单聊') : msg.chatId
  msg.id = dedupeKey(channel.id, msg)
  return { ok: true, message: msg }
}

/* ------------------------------------------------------------ 分流 */

/* 这几组词是「用户真的需要现在知道」的信号，不是情感分析：
   只收能落到行动的（约时间、要东西、出问题了）。 */
const RULES = [
  {
    route: 'alert',
    score: 34,
    label: '在叫你',
    words: ['在吗', '在么', '回我', '看到回', '紧急', '急事', '马上', '尽快', '速回', '等你']
  },
  {
    route: 'observe',
    score: 22,
    label: '约了时间',
    words: ['明天', '后天', '明早', '明晚', '今早', '今晚', '中午', '下午', '上午', '几点', '点前', '之前', '截止', 'deadline', 'ddl', '下周', '这周', '月底', '周一到']
  },
  {
    route: 'observe',
    score: 18,
    label: '托你办事',
    words: ['帮我', '帮忙', '麻烦你', '记得', '别忘了', '提醒', '发我', '给我', '带一份', '订', '买']
  },
  {
    route: 'observe',
    score: 20,
    label: '提到吃喝',
    words: ['想吃', '想喝', '点外卖', '外卖', '聚餐', '约饭', '喝一杯', '订个', '订一', '带一份']
  },
  {
    route: 'knowledge',
    score: 16,
    label: '像是经验',
    words: ['踩坑', '踩到', '报错', '失败', '注意', '坑', '解决方法', '绕过去', '配置', '参数', '别用', '不要用']
  },
  {
    route: 'observe',
    score: 8,
    label: '在问你',
    words: ['？', '?', '怎么', '为什么', '是不是', '能不能', '有没有']
  }
]

const DEFAULT_KEYWORDS = []

/* ------------------------------------------------------------ 派活识别
   和「在叫你」同一条判断线：都是「有人对着你安排了一件事」。
   所以它放在分流这一层，而不是安全边界那一层 —— 分流的责任就是
   决定「这条要不要打扰你」，而派活恰恰是最该打扰的那一类。
   安全边界只是拿它的结果去问「要不要留痕」。 */
/* 「帮你带一份饭」和「你负责这个客户」用的是同一批字，但只有后者是活。
   所以词分强弱：弱词命中只是「像在托你办事」，强词才是「这件事归你了」。 */
const STRONG_WORK = [
  '你来做', '你来弄', '你负责', '交给你', '跟进', '对接', '整理', '汇总', '出一版',
  '写一份', '做一份', '处理一下', '落实', '推进', '确认一下', '发我', '发给我', '提交',
  '安排', '出一份', '排期', '评审', '核对'
]
const WORK_WORDS = [
  ...STRONG_WORK,
  '帮我', '帮忙', '麻烦你', '做个', '做一下', '改一下', '改一版',
  '看一下', '看下', '准备', '拉个', '过一下'
]
const DEADLINE_WORDS = [
  '今天', '明天', '后天', '本周', '下周', '这周', '月底', '月初', '下班前', '上午', '下午',
  '晚上', '尽快', '马上', '截止', 'deadline', 'ddl', '之前', '点前', '周一到', '周一前'
]
const LIFE_WORDS = ['外卖', '吃饭', '聚餐', '约饭', '奶茶', '咖啡', '带一份', '带个', '买', '订个', '喝酒', '电影', '快递', '取一下']

function deadlineOf (text) {
  const body = String(text || '')
  const hit = DEADLINE_WORDS.find((word) => body.includes(word))
  /* 不换算成绝对时间：说「明天」的人自己心里有数，猜错比不猜更糟。
     原词留在留痕里，让用户自己认。 */
  return hit || ''
}

/**
 * @param {object} msg 归一化后的消息
 * @returns {{isAssignment:boolean, score:number, reasons:string[], deadline:string, kind:'work'|'life'}}
 */
function detectAssignment (msg = {}) {
  const body = String(msg.text || '')
  const reasons = []
  let score = 0

  const addressed = msg.mentionsMe === true || msg.scope === 'private'
  if (!addressed) {
    return { isAssignment: false, score: 0, reasons: ['没有点名叫你'], deadline: '', kind: 'work' }
  }

  if (msg.mentionsMe) { score += 45; reasons.push('@ 你') }
  if (msg.scope === 'private') { score += 20; reasons.push('单聊') }

  const work = WORK_WORDS.filter((word) => body.includes(word))
  const strong = work.filter((word) => STRONG_WORK.includes(word))
  if (work.length) { score += 28; reasons.push('派活：' + work.slice(0, 2).join(' / ')) }

  const deadline = deadlineOf(body)
  if (deadline) { score += 20; reasons.push('有时限：' + deadline) }

  const life = LIFE_WORDS.filter((word) => body.includes(word))
  if (life.length && !strong.length) {
    score = Math.round(score * 0.35)
    reasons.push('更像生活琐事')
  }

  /* 一句话全是问号、没有动作的，是聊天不是派活 */
  if (/[?？]\s*$/.test(body) && !work.length) {
    score -= 15
    reasons.push('只是在问')
  }

  /* 有动作词、又确实对着你说，才算派活；只有称呼和时限的，是通知不是活。
     弱词（帮我 / 看一下）单独出现不算 —— 那多半是顺手帮个忙。 */
  const isAssignment = (work.length > 0 && score >= 45) || (Boolean(deadline) && score >= 55)

  return {
    isAssignment,
    score: Math.max(0, Math.min(100, score)),
    reasons,
    deadline,
    kind: life.length && !strong.length ? 'life' : 'work'
  }
}

/**
 * 分四档：alert（该弹）/ observe（该记）/ knowledge（该沉）/ archive（该忘）。
 * 返回 route、reason、score，界面与日志都用同一套解释，避免「为什么提醒我」说不清。
 */
function classify (msg, opts = {}) {
  const haystack = String(msg.text || '').toLowerCase()
  const keywords = Array.isArray(opts.keywords) && opts.keywords.length ? opts.keywords : DEFAULT_KEYWORDS
  let score = 0
  const reasons = []
  let called = false          // 「有人在叫你」：@、点了名、或命中你自己设的关键词
  let knowledge = false       // 「像是一条经验」：只沉进知识，不该打扰
  if (msg.scope === 'private') {
    score += 40
    reasons.push('单聊')
  }
  if (msg.mentionsMe) {
    score += 40
    reasons.push('@ 你')
    called = true
  }
  for (const word of keywords) {
    const needle = String(word || '').trim().toLowerCase()
    if (!needle || !haystack.includes(needle)) continue
    score += 45
    reasons.push('关键词「' + word + '」')
    called = true
    break
  }
  for (const rule of RULES) {
    if (!rule.words.some((word) => haystack.includes(word.toLowerCase()))) continue
    score += rule.score
    reasons.push(rule.label)
    if (rule.route === 'alert') called = true
    if (rule.route === 'knowledge') knowledge = true
  }

  /* 派活也要算「有人在叫你」：单聊里一句「你负责跟进这个客户」，
     没有「在吗」也没有问号，但它是这堆消息里唯一需要今天动手的。 */
  const assignment = detectAssignment(msg)
  if (assignment.isAssignment) {
    called = true
    score += 25
    reasons.push('像是派活')
  }

  /* 分档的关键不是分数，是「有没有人在叫你」。
     一堆聊天凑到高分也不该弹窗；没人叫你，再热闹也最多进观察池。 */
  let route = 'archive'
  if (called && score >= 60) route = 'alert'
  else if (score >= 22) route = 'observe'
  else if (knowledge && score >= 12) route = 'knowledge'
  else if (score > 0 && msg.scope === 'private') route = 'observe'

  return {
    route,
    reason: reasons.length ? reasons.join(' · ') : '没有信号',
    score: Math.min(100, score),
    assignment
  }
}

/** 一行摘要：给观察池与提醒用，正文永远留在收件箱。 */
function summarize (msg, limit = 80) {
  const who = msg.senderName || msg.senderId || '某人'
  const where = msg.scope === 'private' ? '' : `（${msg.chatName || msg.chatId}）`
  const body = (msg.text || (msg.attachments ? `[${msg.attachments} 个附件]` : '')).replace(/\s+/g, ' ')
  const clipped = body.length > limit ? body.slice(0, limit) + '…' : body
  return `${who}${where}：${clipped}`
}

module.exports = {
  normalize, classify, summarize, dedupeKey, detectAssignment, deadlineOf,
  RULES, DEFAULT_KEYWORDS, WORK_WORDS, DEADLINE_WORDS, LIFE_WORDS
}
