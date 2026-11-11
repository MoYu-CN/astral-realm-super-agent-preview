'use strict'

/**
 * 星界 · 项目权重网（纯计算层）
 *
 * 记忆库里的项目不是一排孤立的条目：它们之间有一张带权的近似网。
 * 这个文件只做四件事，不碰数据库、不读配置，方便单测与主进程复用：
 *
 *   1. tokenize   —— 中文按二元组切（不引分词库），英文 / 数字按词切；
 *   2. buildIndex —— 语料级 tf-idf，把每个项目压成单位向量；
 *   3. similarity —— 余弦，得到项目两两之间的「近似度」；
 *   4. diffuse    —— 沿权重网做一跳扩散，让相邻项目也能被带出来。
 *
 * 为什么不引 embedding：这里要的是「名字 + 摘要 + 最近事件」级别的近似，
 * 中文二元组 + idf 已经能把「记忆库重构」和「记忆模块权重网」连上，而且
 * 不依赖网络与密钥、结果可解释。以后要接向量模型，只需在 buildIndex 里
 * 换掉向量来源，网的结构与扩散逻辑不变。
 */

/* 高频虚词：切出来只会把无关项目拉到一起，直接丢掉 */
const STOP = new Set([
  '的', '了', '和', '与', '及', '或', '在', '是', '有', '把', '被', '就', '都', '而',
  '一个', '这个', '那个', '我们', '你们', '他们', '什么', '怎么', '可以', '需要',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'this', 'that', 'it', 'as', 'by', 'at', 'be', 'from'
])

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const TOKEN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[a-z0-9][a-z0-9_+#.-]*/g

function normalize (text) {
  return String(text == null ? '' : text).normalize('NFKC').toLowerCase()
}

/* 中文二元组：长句切 bigram，短名（≤6 字）额外保留整个词，
   这样「投票项目」既能被「投票」命中，也能被完整名字命中。 */
function tokenize (text) {
  const raw = normalize(text)
  const tokens = []
  let m
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(raw))) {
    const piece = m[0].replace(/[.+#-]+$/, '')
    if (!piece) continue
    if (CJK_RE.test(piece[0])) {
      if (piece.length === 1) { tokens.push(piece); continue }
      for (let i = 0; i < piece.length - 1; i++) tokens.push(piece.slice(i, i + 2))
      if (piece.length <= 6) tokens.push(piece)
    } else if (piece.length >= 2 && !STOP.has(piece)) {
      tokens.push(piece)
    }
  }
  return tokens
}

function termFreq (tokens) {
  const out = new Map()
  for (const token of tokens) out.set(token, (out.get(token) || 0) + 1)
  return out
}

/* 词频取 1 + ln(tf)，避免长摘要靠重复堆词压过别人 */
function tfWeight (tf) { return 1 + Math.log(tf) }

/**
 * 建索引：docs = [{ id, text }]
 * 返回 { idf, vectors, size }，vectors 里是**已归一化**的权重，点积即余弦。
 */
function buildIndex (docs) {
  const list = (docs || []).filter((doc) => doc && doc.id)
  const freqs = list.map((doc) => termFreq(tokenize(doc.text)))
  const df = new Map()
  for (const freq of freqs) for (const term of freq.keys()) df.set(term, (df.get(term) || 0) + 1)
  const n = list.length || 1
  const idf = new Map()
  for (const [term, count] of df) idf.set(term, Math.log((n + 1) / (count + 1)) + 1)

  const vectors = new Map()
  list.forEach((doc, i) => {
    const vec = new Map()
    for (const [term, tf] of freqs[i]) vec.set(term, tfWeight(tf) * (idf.get(term) || 1))
    let norm = 0
    for (const w of vec.values()) norm += w * w
    norm = Math.sqrt(norm) || 1
    for (const [term, w] of vec) vec.set(term, w / norm)
    vectors.set(doc.id, vec)
  })
  return { idf, vectors, size: list.length }
}

function cosine (a, b) {
  if (!a || !b) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let dot = 0
  for (const [term, w] of small) {
    const other = large.get(term)
    if (other) dot += w * other
  }
  return dot
}

/* 两两近似度；min 以下不连线，避免网被「都是中文」这种噪声连满 */
function pairwise (index, min = 0.05) {
  const ids = [...index.vectors.keys()]
  const out = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const w = cosine(index.vectors.get(ids[i]), index.vectors.get(ids[j]))
      if (w >= min) out.push({ a: ids[i], b: ids[j], lexical: Number(w.toFixed(4)) })
    }
  }
  return out
}

/* 每条边只留最强的几个邻居：事件多起来以后，一张连满的网既画不清、
   也会让「相关的两件事」被平均值淹没。项目网不裁剪，节点本来就少。 */
function trimLinks (links, perNode = 4) {
  const sorted = [...(links || [])].sort((a, b) => b.lexical - a.lexical)
  const count = new Map()
  const out = []
  for (const link of sorted) {
    const ca = count.get(link.a) || 0
    const cb = count.get(link.b) || 0
    if (ca >= perNode || cb >= perNode) continue
    count.set(link.a, ca + 1)
    count.set(link.b, cb + 1)
    out.push(link)
  }
  return out
}

/* 权重 → 百分比：界面上一条线写 75%，比写 0.75 好认 */
function pct (weight) {
  return Math.round(Math.max(0, Math.min(1, Number(weight) || 0)) * 100)
}

/**
 * 查询向量：只保留语料里出现过的词，没见过的词连不到任何项目，
 * 留着只会稀释权重。
 */
function queryVector (index, text) {
  const freq = termFreq(tokenize(text))
  const vec = new Map()
  if (!freq.size) return { vec, norm: 1 }
  let norm = 0
  for (const [term, tf] of freq) {
    const idf = index.idf.get(term)
    if (idf === undefined) continue
    const w = tfWeight(tf) * idf
    vec.set(term, w)
    norm += w * w
  }
  return { vec, norm: Math.sqrt(norm) || 1 }
}

function scoreIndex (index, query) {
  const { vec, norm } = queryVector(index, query)
  const scores = new Map()
  if (!vec.size) return scores
  for (const [id, docVec] of index.vectors) {
    let dot = 0
    for (const [term, w] of vec) {
      const hit = docVec.get(term)
      if (hit) dot += (w / norm) * hit
    }
    if (dot > 0) scores.set(id, dot)
  }
  return scores
}

/* 单条文本对查询的匹配度：只用于事件 / 知识条目内部的排序，
   不做归一化——它们的长度不代表相关度。 */
function scoreText (qvec, qnorm, text) {
  if (!qvec || !qvec.size) return 0
  const freq = termFreq(tokenize(text))
  let dot = 0
  for (const [term, tf] of freq) {
    const w = qvec.get(term)
    if (w) dot += (w / qnorm) * tfWeight(tf)
  }
  return dot
}

/**
 * 沿网扩散一跳：一个项目即使自身分数不高，只要它与高分项目强相关，
 * 也会被抬起来。取「最大的那条边」而不是求和，避免枢纽节点把全网带偏。
 */
function diffuse (scores, links, alpha = 0.35) {
  const best = new Map()
  for (const link of links || []) {
    const a = scores.get(link.a) || 0
    const b = scores.get(link.b) || 0
    const wa = link.weight * b
    const wb = link.weight * a
    if (wa > (best.get(link.a) || 0)) best.set(link.a, wa)
    if (wb > (best.get(link.b) || 0)) best.set(link.b, wb)
  }
  const out = new Map(scores)
  for (const [id, boost] of best) out.set(id, (out.get(id) || 0) + alpha * boost)
  return out
}

/* 名字命中是强信号：「投票项目」这四个字出现在问题里，比任何词频都直接 */
function nameBoost (name, query) {
  const n = normalize(name).replace(/\s+/g, '')
  const q = normalize(query).replace(/\s+/g, '')
  if (!n || !q) return 0
  if (q.includes(n)) return n.length >= 2 ? 0.5 : 0.2
  if (n.includes(q) && q.length >= 2) return 0.35
  const tokens = tokenize(name).filter((t) => t.length >= 2)
  if (!tokens.length) return 0
  const hit = tokens.filter((t) => q.includes(t)).length
  /* 至少一半的名字片段命中才算「按名命中」：
     「默认项目」只重合一个「项目」就加分的话，所有项目名都会被拉进来。 */
  const ratio = hit / tokens.length
  return ratio >= 0.5 ? ratio * 0.25 : 0
}

module.exports = {
  tokenize,
  termFreq,
  tfWeight,
  buildIndex,
  cosine,
  pairwise,
  trimLinks,
  pct,
  queryVector,
  scoreIndex,
  scoreText,
  diffuse,
  nameBoost,
  normalize
}
