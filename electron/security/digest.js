'use strict'

/**
 * security/digest.js — 把账本压成事件，把事件算成权重（纯函数，不碰数据库）
 *
 * 账本是给追责用的原始材料，一条不留；事件网是给回忆用的索引，一条任务只留
 * 一两行。两者不是同一份东西：账本可以导出成存证，事件只回答「这件事是什么、
 * 什么时候、结果如何、值不值得先看」。
 *
 * 压缩的底线：原话只留开头，正文一个字都不进事件；疑似密钥先脱敏再落库 ——
 * 事件会被注入上下文、会被检索，不能让留痕反过来成为泄露渠道。
 */

const sensitivity = require('./sensitivity.js')
const weights = require('../memory/weights.js')

const SUMMARY_MAX = 150
const RESULT_MAX = 120

function clip (value, max) {
  const text = String(value === undefined || value === null ? '' : value)
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function oneLine (value, max) {
  return clip(String(value || '').replace(/\s+/g, ' ').trim(), max)
}

function countOf (entries = []) {
  const get = (kind) => entries.filter((entry) => entry.kind === kind)
  const approvals = get('approval')
  const outbounds = get('outbound')
  const gates = get('gate')
  return {
    entries: entries.length,
    actions: get('action').length,
    outbounds: outbounds.length,
    approvals: approvals.filter((entry) => String(entry.title || '').includes('批准')).length,
    denies: approvals.filter((entry) => String(entry.title || '').includes('拒绝')).length,
    gates: gates.length,
    critical: gates.filter((entry) => (entry.body || {}).risk === 'critical').length,
    corrections: get('correct').length,
    lastAt: entries.length ? entries[entries.length - 1].at : ''
  }
}

/**
 * 一条任务压缩成两行：
 *   summary —— 谁、在哪、要什么、最后怎样（进事件网，参与检索）
 *   result  —— 做了多少、批没批、证据编号（给人扫一眼）
 */
function summarize ({ task = {}, entries = [] } = {}) {
  const metrics = countOf(entries)
  const who = oneLine(task.fromName, 24)
  const where = [task.channel, task.chat].filter(Boolean).map((item) => oneLine(item, 20)).join('·')
  const ask = oneLine(task.ask, 62)
  const outcome = oneLine(task.outcome, 42)
  const lastAction = [...entries].reverse().find((entry) => entry.kind === 'action' || entry.kind === 'outbound')

  const head = who ? `${who}${where ? `（${where}）` : ''}` : (where || '未记录来源')
  let tail = ''
  if (outcome) tail = ' → ' + outcome
  else if (task.status === 'closed') tail = ' → 已归档，没有写结论'
  else if (task.status === 'open') {
    tail = ` → 在办：${metrics.actions + metrics.outbounds} 步` +
      (lastAction ? `，最近：${oneLine(lastAction.title, 24)}` : '')
  } else if (task.status === 'candidate') tail = ' → 还没决定要不要留痕'
  else if (task.status === 'dropped') tail = ' → 没有采用'

  /* 原话里可能夹着密钥或身份证：事件会被检索、会进上下文，必须先脱敏 */
  const summary = sensitivity.redactText(clip(`${head}：${ask}${tail}`, SUMMARY_MAX), SUMMARY_MAX)

  const parts = []
  if (metrics.actions) parts.push(`动作 ${metrics.actions}`)
  if (metrics.outbounds) parts.push(`外发 ${metrics.outbounds}`)
  if (metrics.approvals) parts.push(`批准 ${metrics.approvals}`)
  if (metrics.gates) parts.push(`拦下 ${metrics.gates}`)
  parts.push(`账本 ${metrics.entries} 条`)
  if (task.id) parts.push(`证据 ${task.id}`)
  const result = sensitivity.redactText(clip(parts.join(' · '), RESULT_MAX), RESULT_MAX)

  return { summary, result, metrics, gaps: gapsOf({ task, entries, metrics }) }
}

/** 记录本身说不清的地方，宁可明说，也不替它圆场。 */
function gapsOf ({ task = {}, entries = [], metrics = countOf(entries) } = {}) {
  const gaps = []
  if (!entries.length) gaps.push('账本是空的：这条没有开留痕，只能证明消息存在')
  if (task.status === 'open') gaps.push('还没归档：没有结论，也没有收尾')
  if (task.status === 'candidate') gaps.push('还没决定要不要留痕')
  if (metrics.outbounds > metrics.approvals) {
    gaps.push(`外发 ${metrics.outbounds} 次、批准 ${metrics.approvals} 次，对不上，需要人工核对`)
  }
  if (metrics.denies > 0 && metrics.outbounds > 0) {
    gaps.push('有被拒绝的外发，确认后来没有换一条路发出去')
  }
  if (metrics.corrections > 0) gaps.push('账本里有更正条目，以更正后的说法为准')
  if (task.status === 'closed' && !oneLine(task.outcome, 4)) gaps.push('归档时没有写结果')
  return gaps
}

const DAY = 86400000

/**
 * 一件留痕该有多重：证据越多、越完整、越严重、越近，越该先被翻出来。
 * 四个因子相乘，与知识网同一套写法 —— 任何时候都能说清「为什么是 62%」。
 */
function weightOf ({ task = {}, entries = [], now = Date.now() } = {}) {
  const metrics = countOf(entries)
  const evidence = 1 - Math.pow(0.5, Math.max(0, metrics.entries) / 5)      // 0 → 0，5 条 → 0.5，15 条 → 0.87
  const days = task.createdAt ? Math.max(0, (now - Date.parse(task.createdAt)) / DAY) : 0
  const freshness = Math.pow(0.5, (Number.isFinite(days) ? days : 0) / 120) // 责任追溯衰减慢：120 天减半
  const coverage = metrics.outbounds
    ? Math.min(1, metrics.approvals / metrics.outbounds)
    : (task.status === 'closed' ? 1 : 0.5)
  const integrity = Math.min(1, 0.35 + 0.35 * coverage + 0.2 * (task.status === 'closed' && task.outcome ? 1 : 0) + 0.1 * (task.eventCode ? 1 : 0))
  const severity = Math.min(1, 0.25 + 0.18 * Math.min(2, metrics.gates) + 0.25 * (metrics.critical ? 1 : 0))

  const weight = Math.max(0.1, Math.min(0.98,
    (0.42 + 0.58 * evidence) * (0.6 + 0.4 * integrity) * (0.65 + 0.35 * severity) * (0.7 + 0.3 * freshness)
  ))

  return {
    weight: Number(weight.toFixed(3)),
    percent: Math.round(weight * 100),
    factors: {
      evidence: Number(evidence.toFixed(2)),
      freshness: Number(freshness.toFixed(2)),
      integrity: Number(integrity.toFixed(2)),
      severity: Number(severity.toFixed(2)),
      entries: metrics.entries,
      days: Math.round(days)
    }
  }
}

/* ------------------------------------------------------------ 检索 */

function termSet (text) {
  const set = new Set()
  for (const token of weights.tokenize(text)) {
    if (token.length >= 2) set.add(token)
  }
  return set
}

/** 二元余弦：只用来判断「这两段说的是不是同一件事」，不做语义。 */
function overlap (a, b) {
  const left = termSet(a)
  const right = termSet(b)
  if (!left.size || !right.size) return 0
  let hit = 0
  for (const token of left) if (right.has(token)) hit += 1
  return hit / Math.sqrt(left.size * right.size)
}

/* 「问原委」和「找项目」是两种意图：前者靠权重和时间，后者靠内容。 */
const TRACE_INTENT = /追责|问责|谁让|谁派|谁批准|谁同意|甩锅|背锅|责任|原委|来龙去脉|怎么回事|怎么来的|留痕|证据|存证|当时是|谁说的/

function wantsTrace (query) {
  return TRACE_INTENT.test(String(query || ''))
}

module.exports = {
  summarize,
  weightOf,
  countOf,
  gapsOf,
  overlap,
  wantsTrace,
  oneLine,
  SUMMARY_MAX,
  RESULT_MAX
}
