'use strict'

/**
 * security/policy.js — 分档与话术（纯函数）
 *
 * sensitivity 说「有什么」，这里说「怎么办」。分开放的理由很简单：
 * 识别规则会随样本一直改，放行规则不能跟着一起改 —— 后者是承诺，前者是手艺。
 *
 * 三条立场（写进文档也写进代码）：
 *   1. 边界的目的不是替用户拒绝，是把决定权交回用户手上；
 *   2. 「完全授权」不等于「授权外泄密钥」：密钥级命中永远单独问一次；
 *   3. 批准绑在「这一份内容 + 这一个去处」上，改一个字就要重新问。
 */

const { LEVEL_RANK } = require('./sensitivity.js')

/* 能手把手把东西送出去的动作。名字不可全信，所以「认不出来」也按能发算。 */
const OUTBOUND_HINT = /(send|post|reply|upload|publish|share|push|message|mail|comment|forward|webhook|issue|pull_request|submit|notify|invite|create_|update_|write_|put_)/i
const READONLY_HINT = /^(?:get|list|read|search|query|fetch|download|status|describe|inspect|view|find|lookup|count|head|stat)/i

/** 这次调用会不会把数据带出本机：none（不出）/ pull（只取不送）/ send（可能送）/ unknown */
function exposureOf (serverId, tool) {
  if (!serverId || serverId === 'builtin') return 'none'
  const name = String(tool || '')
  /* 先看动词再看出名词：list_issues 是拉取，create_issue 才是往外写。
     名字里同时带 send 这类动词的，一律按「能送」算，宁可多问一次。 */
  if (READONLY_HINT.test(name) && !/(send|post|upload|publish|reply|forward|submit|push|invite)/i.test(name)) {
    return 'pull'
  }
  if (OUTBOUND_HINT.test(name)) return 'send'
  return 'unknown'
}

/** 只有中低风险能被「这类不再问」批量放行；密钥、身份证、银行卡永远逐次确认。 */
function whitelistable (hits) {
  if (!Array.isArray(hits) || !hits.length) return false
  return hits.every((hit) => LEVEL_RANK[hit.level] <= LEVEL_RANK.medium)
}

/**
 * @param {{risk:string, exposure:string, hits:Array, allowTypes?:object, now?:number}} input
 * @returns {{verdict:'allow'|'confirm', reason:string, whitelisted:boolean}}
 */
function decide (input = {}) {
  const risk = LEVEL_RANK[input.risk] ? input.risk : 'none'
  const exposure = input.exposure || 'send'
  const hits = Array.isArray(input.hits) ? input.hits : []

  if (risk === 'none' || !hits.length) {
    return { verdict: 'allow', reason: '没有命中敏感内容', whitelisted: false }
  }
  if (exposure === 'none') {
    return { verdict: 'allow', reason: '内容不会离开本机', whitelisted: false }
  }

  /* 只读语义（搜索、拉取）只在高危时拦：把身份证号当关键词发出去一样是泄露，
     但手机号出现在搜索词里更可能是正常工单号，不值得每次都问。 */
  if (exposure === 'pull' && LEVEL_RANK[risk] <= LEVEL_RANK.medium) {
    return { verdict: 'allow', reason: '这次调用只取不送', whitelisted: false }
  }

  if (whitelistable(hits)) {
    const allowTypes = input.allowTypes && typeof input.allowTypes === 'object' ? input.allowTypes : {}
    const now = Number.isFinite(input.now) ? input.now : Date.now()
    const all = hits.every((hit) => {
      const until = allowTypes[hit.type]
      return until && Date.parse(until) > now
    })
    if (all) {
      return { verdict: 'allow', reason: '这类内容你已经放行过', whitelisted: true }
    }
  }

  const reason = risk === 'critical'
    ? '这是密钥级内容，默认不发出'
    : risk === 'high'
      ? '这是身份 / 凭证级内容'
      : '这段内容里有个人信息'
  return { verdict: 'confirm', reason, whitelisted: false }
}

/** 主进程原生确认窗与界面共用同一套话术，避免「这边说密钥、那边说敏感词」。 */
function question (input = {}) {
  const hits = Array.isArray(input.hits) ? input.hits : []
  const where = input.target || input.channel || '外部'
  const what = hits.map((hit) => `${hit.label}${hit.count > 1 ? ' ×' + hit.count : ''}`).join('、') || '敏感内容'
  return {
    title: input.risk === 'critical' ? '这段内容里有密钥，真要发吗？' : '这段内容要发出去吗？',
    message: `要发往「${where}」，里面有 ${what}。`,
    detail: hits.map((hit) => {
      const sample = (hit.samples && hit.samples[0]) || ''
      const at = hit.where ? `（在 ${hit.where}）` : ''
      return `· ${hit.label}${at}：${sample}`
    }).join('\n'),
    sample: hits.slice(0, 3).map((hit) => (hit.samples && hit.samples[0]) || hit.label).join(' · ')
  }
}

/* ------------------------------------------------------------ 派活识别
   判断逻辑住在分流那一层（intake/normalize.js）：它本来就是「这条要不要
   打扰你」的一部分。这里只做转手，让安全边界不必知道消息长什么样。 */
const { detectAssignment, deadlineOf } = require('../intake/normalize.js')

module.exports = {
  exposureOf,
  whitelistable,
  decide,
  question,
  detectAssignment,
  deadlineOf
}
