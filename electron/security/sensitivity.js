'use strict'

/**
 * security/sensitivity.js — 敏感内容识别（纯函数）
 *
 * 只回答一个问题：这段东西里有没有「不该流出去」的字符。
 * 它不判断该不该发 —— 那是 policy.js 的事；它也不留正文 —— 只回脱敏片段。
 *
 * 误报比漏报更毁这件事：一天弹二十次「你确定要发吗」，第三天用户就会
 * 闭着眼睛点允许，边界等于没有。所以每条规则都要能用真实样本解释：
 *   · 身份证走校验位，不是「18 位数字」就算；
 *   · 银行卡走 Luhn，不是「16 位数字」就算；
 *   · 高熵串必须有 key / token / 密钥 这类上下文，且排除纯 hex ——
 *     否则每一次 git 提交里的 sha256 都会来敲一次门。
 */

const LEVEL_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }

/* 带固定前缀的密钥：几乎不会误报，命中即最高级 */
const API_KEY_RE = new RegExp([
  'sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}',
  'gh[pousr]_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{22,}',
  'glpat-[A-Za-z0-9_-]{16,}',
  'xox[abprs]-[A-Za-z0-9-]{10,}',
  '(?:AKIA|ASIA)[0-9A-Z]{16}',
  'AIza[0-9A-Za-z_-]{35}',
  'hf_[A-Za-z0-9]{20,}',
  'npm_[A-Za-z0-9]{20,}',
  'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
  'pypi-[A-Za-z0-9_-]{20,}',
  'dckr_pat_[A-Za-z0-9_-]{16,}',
  '(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}',
  'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}'
].join('|'), 'g')

const CREDENTIAL_RE = /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|app[_-]?secret|client[_-]?secret)\s*[:=：]\s*["']?([^\s"'，,;；]{6,})/gi
const CREDENTIAL_CN_RE = /(?:密码|口令|密钥|令牌|凭证)\s*[:：=]\s*([^\s，,；;]{6,})/g
const ID_CARD_RE = /\b\d{17}[\dXx]\b/g
const BANK_CARD_RE = /\b(?:\d[ -]?){15,19}\b/g
const PHONE_RE = /(?<![\d])1[3-9]\d{9}(?![\d])/g
const ENTROPY_RE = /\b[A-Za-z0-9_-]{24,80}\b/g
const LOCAL_PATH_RE = /(?:[A-Za-z]:\\Users\\[^\\\s"']+|\\Users\\[^\\\s"']+|\/Users\/[^/\s"']+|\/home\/[^/\s"']+)/g

const ENTROPY_CONTEXT = /(?:key|token|secret|password|passwd|credential|authorization|bearer|密钥|令牌|口令|凭证|密码)/i

/* ------------------------------------------------------------ 校验 */

function idCardOk (value) {
  const code = String(value || '').toUpperCase()
  if (!/^\d{17}[\dX]$/.test(code)) return false
  const factors = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  let sum = 0
  for (let i = 0; i < 17; i++) sum += Number(code[i]) * factors[i]
  return checks[sum % 11] === code[17]
}

function luhnOk (value) {
  const digits = String(value || '').replace(/[ -]/g, '')
  if (!/^\d{16,19}$/.test(digits)) return false
  if (/^(\d)\1+$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i])
    if (double) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    double = !double
  }
  return sum % 10 === 0
}

/* 高熵串：至少两类字符、不是纯 hex、不是路径 / URL，且附近有密钥上下文。
   这几条一起把 git 哈希、UUID、英文长单词、文件路径全挡在门外。 */
function entropyOk (value, text, index) {
  const raw = String(value || '')
  if (raw.length < 24) return false
  if (/[/\\:@.]/.test(raw)) return false
  const bare = raw.replace(/[-_]/g, '')
  if (/^[0-9a-f]+$/i.test(bare)) return false
  const classes = Number(/[a-z]/.test(raw)) + Number(/[A-Z]/.test(raw)) + Number(/\d/.test(raw))
  if (classes < 2) return false
  const from = Math.max(0, index - 48)
  const to = Math.min(text.length, index + raw.length + 48)
  return ENTROPY_CONTEXT.test(text.slice(from, to))
}

/* ------------------------------------------------------------ 规则表 */

const RULES = [
  {
    type: 'private-key',
    level: 'critical',
    label: '私钥',
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g
  },
  { type: 'api-key', level: 'critical', label: 'API 密钥', re: API_KEY_RE },
  {
    type: 'credential',
    level: 'high',
    label: '口令 / 密钥字段',
    re: CREDENTIAL_RE,
    group: 1,
    whole: true
  },
  {
    type: 'credential',
    level: 'high',
    label: '口令 / 密钥字段',
    re: CREDENTIAL_CN_RE,
    group: 1,
    whole: true
  },
  { type: 'id-card', level: 'high', label: '身份证号', re: ID_CARD_RE, validate: idCardOk },
  { type: 'bank-card', level: 'high', label: '银行卡号', re: BANK_CARD_RE, validate: luhnOk },
  { type: 'phone', level: 'medium', label: '手机号', re: PHONE_RE },
  { type: 'high-entropy', level: 'medium', label: '疑似密钥串', re: ENTROPY_RE, validate: entropyOk },
  { type: 'local-path', level: 'low', label: '本机路径', re: LOCAL_PATH_RE }
]

/* ------------------------------------------------------------ 脱敏 */

/** 只留「够认出来」的头尾：头 6 尾 2。用户看一眼能对上，别人捡到没用。 */
function redact (value) {
  const text = String(value === undefined || value === null ? '' : value)
  if (!text) return ''
  if (text.length <= 8) return text.slice(0, 2) + '***'
  return text.slice(0, 6) + '…' + text.slice(-2)
}

function cleanLine (value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

/* ------------------------------------------------------------ 扫描 */

/**
 * @param {string} input 要检查的正文
 * @param {{limit?:number, rules?:Array}} opts
 * @returns {{hits:Array, risk:string, total:number, chars:number}}
 */
function scan (input, opts = {}) {
  const body = typeof input === 'string' ? input : String(input === undefined || input === null ? '' : input)
  if (!body) return { hits: [], risk: 'none', total: 0, chars: 0 }

  const subject = body.length > 200000 ? body.slice(0, 200000) : body
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 8))
  const byType = new Map()

  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags)
    let match
    let guard = 0
    while ((match = re.exec(subject)) !== null && guard++ < 400) {
      if (!match[0]) { re.lastIndex += 1; continue }
      const raw = rule.group ? match[rule.group] : match[0]
      if (!raw) continue
      if (rule.validate && !rule.validate(raw, subject, match.index)) continue
      const key = rule.type + '|' + rule.label
      const item = byType.get(key) || { type: rule.type, level: rule.level, label: rule.label, count: 0, samples: [] }
      item.count += 1
      if (item.samples.length < 2) item.samples.push(redact(raw))
      byType.set(key, item)
    }
  }

  const hits = [...byType.values()]
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.count - a.count)
    .slice(0, limit)
  const risk = hits.reduce((worst, hit) => (LEVEL_RANK[hit.level] > LEVEL_RANK[worst] ? hit.level : worst), 'none')
  return { hits, risk, total: hits.reduce((n, hit) => n + hit.count, 0), chars: subject.length }
}

/** 把对象里的字符串摊平：工具参数是嵌套的，只扫一层会漏掉 content / messages。 */
function flatten (value, prefix = '', out = [], depth = 0) {
  if (depth > 4 || out.length > 60) return out
  if (typeof value === 'string') {
    if (value) out.push({ path: prefix || 'text', text: value })
    return out
  }
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item, index) => flatten(item, `${prefix}[${index}]`, out, depth + 1))
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      flatten(item, prefix ? `${prefix}.${key}` : key, out, depth + 1)
    }
  }
  return out
}

/** 扫一组字段：命中会带上「在哪一段」，方便界面告诉用户到底哪一行有问题。 */
function scanFields (value) {
  const fields = flatten(value)
  const merged = new Map()
  for (const field of fields) {
    const result = scan(field.text)
    for (const hit of result.hits) {
      const key = hit.type + '|' + hit.label
      const item = merged.get(key) || {
        type: hit.type,
        level: hit.level,
        label: hit.label,
        count: 0,
        samples: [],
        where: field.path
      }
      item.count += hit.count
      for (const sample of hit.samples) {
        if (item.samples.length < 2 && !item.samples.includes(sample)) item.samples.push(sample)
      }
      merged.set(key, item)
    }
  }
  const hits = [...merged.values()].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level])
  const risk = hits.reduce((worst, hit) => (LEVEL_RANK[hit.level] > LEVEL_RANK[worst] ? hit.level : worst), 'none')
  return { hits, risk, total: hits.reduce((n, hit) => n + hit.count, 0) }
}

/** 一句话说清命中了什么：「API 密钥 1 处、手机号 2 处」。 */
function describe (hits, limit = 3) {
  if (!Array.isArray(hits) || !hits.length) return ''
  return hits.slice(0, limit)
    .map((hit) => `${hit.label}${hit.count > 1 ? ' ' + hit.count + ' 处' : ''}`)
    .join('、')
}

/** 给界面看的样本：每类取第一条脱敏值。 */
function sampleText (hits, limit = 3) {
  if (!Array.isArray(hits) || !hits.length) return ''
  return hits.slice(0, limit)
    .map((hit) => (hit.samples && hit.samples[0]) || hit.label)
    .join(' · ')
}

/**
 * 把正文里的敏感片段就地打码，用于「预览」。
 *
 * 闸门要存一段让人能判断的摘要，但摘要本身不能成为第二次泄露 ——
 * 所以存之前先按同一套规则替换一遍，库里永远不会有完整密钥。
 */
function redactText (input, max = 160) {
  let body = typeof input === 'string' ? input : String(input === undefined || input === null ? '' : input)
  if (!body) return ''
  const ranges = []
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags + 'd')
    let match
    let guard = 0
    while ((match = re.exec(body)) !== null && guard++ < 400) {
      if (!match[0]) { re.lastIndex += 1; continue }
      let raw = rule.group ? match[rule.group] : match[0]
      let span = match.indices && match.indices[rule.group || 0]
      if (!raw || !span) continue
      if (rule.validate && !rule.validate(raw, body, span[0])) continue
      ranges.push({ start: span[0], end: span[1] })
    }
  }
  ranges.sort((a, b) => b.start - a.start)
  let last = Infinity
  for (const range of ranges) {
    if (range.end > last) continue
    body = body.slice(0, range.start) + redact(body.slice(range.start, range.end)) + body.slice(range.end)
    last = range.start
  }
  body = body.replace(/\s+/g, ' ').trim()
  return body.length > max ? body.slice(0, max) + '…' : body
}

module.exports = {
  scan,
  scanFields,
  describe,
  sampleText,
  redact,
  redactText,
  cleanLine,
  flatten,
  idCardOk,
  luhnOk,
  entropyOk,
  LEVEL_RANK,
  RULES
}
