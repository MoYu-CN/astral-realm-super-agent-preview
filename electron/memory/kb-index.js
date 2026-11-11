'use strict'

/**
 * 星界 · 知识网（第四张网）
 *
 * 前三张网回答「做过什么 / 什么时候做 / 走到哪一步」，这张回答「这件事该怎么做」。
 *
 * ## 为什么不能只做关键词检索
 * 知识库会一直长。条目一多，两个问题同时出现：
 *   1. 全部塞进上下文 → 花不起；
 *   2. 只按关键词排 → 长条目、公共词占优，真正该先看的「踩过的坑」浮不上来。
 *
 * 所以这里给每条知识一个**自身权重**，与查询相关度相乘后排序：
 *   weight = trust × freshness × (0.55 + 0.45 × precision) × completeness
 *
 *   trust        谁写的：用户手写 1.0，全局知识 0.95，自动摘要 0.7；再按「有用/没用」反馈微调。
 *   freshness    多久没被用过：半衰 90 天；「避错」半衰 180 天 —— 踩过的坑不该那么快过期。
 *   precision    (opens+1)/(exposures+2)：被搜出来 20 次没人打开，说明它只是噪声；
 *                这条是权重能「自己学会沉底」的关键，也是曝光与消费必须分开记的原因。
 *   completeness 四段写全没有：写全的条目更可信，只有标题的条目不该排在前面。
 *
 * 权重**不替代**相关度：只按权重排会永远返回同一批老条目。
 * 两者相乘，相关度优先（0.75 次幂略压），权重决定同等相关时谁先。
 *
 * ## 为什么不引 embedding
 * 与项目网一致：中文二元组 + idf 已经能把「构建失败」和「打包报错」连上，
 * 不依赖网络与密钥、结果可解释。以后换向量模型只需替换 `vectorsFor()`，
 * 排序、扩散、去冗余都不用动。
 */

const { randomUUID, createHash } = require('node:crypto')
const weights = require('./weights.js')

/** 权重参数。集中在一处，便于用真实数据回调用。 */
const DEFAULTS = Object.freeze({
  /* 知识比事件衰减慢：一个做法三个月没用，不等于它错了 */
  halfLifeDays: 90,
  /* 「避错」是踩过的坑，过期更慢 */
  halfLifeDaysPitfall: 180,
  /* 相关度的幂次：<1 让弱相关也能进候选，不至于一条都不给 */
  relevancePower: 0.75,
  /* 权重对综合分的影响幅度：0.55 + 0.45×weight，即最多把分数砍掉 45% */
  weightFloor: 0.55,
  /* 邻居扩散强度 */
  diffuseAlpha: 0.2,
  /* MMR 去冗余：λ 越大越看重相关度，越小越强制多样 */
  mmrLambda: 0.7,
  /* 同领域但无连边时的固定相似度，避免一本书占满名额。
     不能设大：知识连线本身只有 0.03–0.3，0.2 会让同域条目互相压死。 */
  domainSim: 0.08,
  /* 候选上限：再大的库也只在这里面排 */
  maxCandidates: 400,
  /* 权重下限：永不归零，否则一条知识会彻底消失 */
  minWeight: 0.02
})

const MAX_DIGEST = 96

function clamp (value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

/* ------------------------------------------------------------ 键与摘要 */

function keyOf (source, projectId, entryId) {
  const id = String(entryId || '').trim()
  if (source === 'global') return 'global:' + id
  return 'kb:' + String(projectId || 'default') + ':' + id
}

function splitKey (key) {
  const parts = String(key || '').split(':')
  if (parts[0] === 'global') return { source: 'global', projectId: null, entryId: parts.slice(1).join(':') }
  return { source: 'kb', projectId: parts[1] || 'default', entryId: parts.slice(2).join(':') }
}

/* 一行摘要：检索时只给这一行。优先触发条件——它回答的是「什么时候该看这条」。 */
function digestOf (entry, limit = MAX_DIGEST) {
  const text = String(
    entry?.trigger ||
    (Array.isArray(entry?.steps) && entry.steps[0]) ||
    entry?.why ||
    entry?.title ||
    ''
  ).replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}

/* 正文全文（用于建词向量与估算字数）。字段顺序固定，改顺序会让所有 hash 失效。 */
function bodyOf (entry) {
  if (!entry) return ''
  const steps = Array.isArray(entry.steps) ? entry.steps : []
  return [
    entry.title || '',
    entry.trigger || '',
    steps.join('\n'),
    entry.why || '',
    entry.symptoms || '',
    entry.verify || '',
    entry.boundaries || ''
  ].join('\n').trim()
}

/* 四段写全 → 1.0；缺一段扣一点，底线 0.4。只有标题的条目不该和写全的排在一起。
   权重合计正好 1.0：0.4 打底 = 「它在库里」，其余 0.6 按写全程度分。 */
function completenessOf (entry) {
  const has = (v) => typeof v === 'string' && v.trim().length > 0
  const steps = Array.isArray(entry?.steps) ? entry.steps.filter(has) : []
  let score = 0.4
  if (has(entry?.title)) score += 0.1
  if (has(entry?.trigger)) score += 0.15
  if (steps.length >= 1) score += 0.15
  if (steps.length >= 2) score += 0.05
  if (has(entry?.why)) score += 0.1
  if (has(entry?.symptoms) || has(entry?.verify)) score += 0.05
  return Number(clamp(score, 0.4, 1).toFixed(3))
}

function hashOf (text) {
  return createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16)
}

/* ------------------------------------------------------------ 权重 */

/**
 * 一条知识自身的权重（与查询无关）。
 * @param {object} node kb_nodes 行（snake_case）。
 * @param {number} at 参照时间戳（毫秒），便于测试固定时钟。
 * @returns {{weight:number, trust:number, freshness:number, precision:number, completeness:number, ageDays:number}}
 */
function weightOf (node, at = Date.now()) {
  const pitfall = node.kind === '避错'
  const half = pitfall ? DEFAULTS.halfLifeDaysPitfall : DEFAULTS.halfLifeDays
  const baseIso = node.last_use_at || node.last_open_at || node.updated_at || node.created_at
  const base = Date.parse(baseIso || '')
  const ageDays = Number.isFinite(base) ? Math.max(0, (at - base) / 86400000) : 365
  const freshness = Math.pow(0.5, ageDays / half)

  /* 「搜出来之后有没有真被用」是权重能自己学会沉底的关键。
   *
   * 但不能按「曝光一次扣一次」算：检索词不准是搜索方的问题，不是知识的错。
   * 规则是「每用过一次，允许它被多搜出来两次」—— 超出的才算噪声。
   *   零曝光            → 0.5（未知，中性，不奖不罚）
   *   曝 30 次、用 0 次 → 0.10（反复搜到没人要，沉底）
   *   曝 10 次、用 4 次 → 0.71（真在用的东西，升权）
   *
   * 系数 0.25 是刻意压小的：曝光只是「有机会被看见」，不是「被拒绝」。
   * 真正判死刑的只有明确反馈（feedback），不是搜了几次。
   */
  const exposures = Math.max(0, Number(node.exposures) || 0)
  const opens = Math.max(0, Number(node.opens) || 0)
  const uses = Math.max(0, Number(node.uses) || 0)
  const effective = opens + uses
  const noise = Math.max(0, exposures - effective * 2)
  const precision = clamp((effective + 1) / (effective + noise * 0.25 + 2), 0.05, 1)

  /* 反馈：有用/没用各记一次，最多 ±0.3 */
  const good = Math.max(0, Number(node.good) || 0)
  const bad = Math.max(0, Number(node.bad) || 0)
  const feedback = (good - bad) / (good + bad + 2)
  const trust = clamp((Number(node.trust) || 1) + feedback * 0.3, 0.3, 1.2)

  const completeness = clamp(Number(node.completeness) || 0.6, 0.4, 1)
  const weight = trust * freshness * (DEFAULTS.weightFloor + (1 - DEFAULTS.weightFloor) * precision) * completeness
  return {
    weight: clamp(weight, DEFAULTS.minWeight, 1),
    trust: Number(trust.toFixed(3)),
    freshness: Number(freshness.toFixed(3)),
    precision: Number(precision.toFixed(3)),
    completeness: Number(completeness.toFixed(3)),
    ageDays: Math.round(ageDays)
  }
}

/* ------------------------------------------------------------ 词向量 */

/* 全量重建：一次统计 df，所有条目共用同一套 idf。
   增量重建会拿到不同的 idf，跨条目不可比 —— 这是刻意选全量的原因。 */
function vectorsFor (docs) {
  const list = (docs || []).filter((doc) => doc && doc.key)
  const freqs = list.map((doc) => weights.termFreq(weights.tokenize(doc.text)))
  const df = new Map()
  for (const freq of freqs) for (const term of freq.keys()) df.set(term, (df.get(term) || 0) + 1)
  const n = list.length || 1
  const idf = new Map()
  for (const [term, count] of df) idf.set(term, Math.log((n + 1) / (count + 1)) + 1)

  const vectors = new Map()
  list.forEach((doc, i) => {
    const vec = new Map()
    for (const [term, tf] of freqs[i]) vec.set(term, weights.tfWeight(tf) * (idf.get(term) || 1))
    let norm = 0
    for (const w of vec.values()) norm += w * w
    norm = Math.sqrt(norm) || 1
    for (const [term, w] of vec) vec.set(term, w / norm)
    vectors.set(doc.key, vec)
  })
  return { idf, vectors, size: list.length }
}

/* ------------------------------------------------------------ 同步 */

/**
 * 把一批知识条目同步进索引。
 *
 * **按作用域对齐，不是全库覆盖**：一个项目一个作用域（全局知识算另一个），
 * 只删「本作用域内有、但这次没给」的条目，别的项目不会被连带清掉。
 *
 * **按 hash 短路**：正文没变就不重建词向量；全部没变时连连线都不重算。
 * 调用方需要传完整条目（含 body 字段），否则 idf 会失真。
 *
 * @param {object} db node:sqlite DatabaseSync
 * @param {Array<object>} entries `[{ source, projectId, entryId, kind, domain, entry, trust, createdAt }]`
 * @param {object} [opts] `{ rebuildLinks=true }`
 * @returns {{added:number, updated:number, removed:number, unchanged:number, terms:number, links:number}}
 */
function sync (db, entries, opts = {}) {
  const at = new Date().toISOString()
  const list = (entries || []).filter((item) => item && item.entryId)
  const scopes = new Set(list.map((item) => item.source === 'global'
    ? 'global'
    : 'kb:' + String(item.projectId || 'default')))

  /* 只取本次涉及的作用域：别的项目的索引不动 */
  const existing = new Map()
  for (const scope of scopes) {
    const rows = scope === 'global'
      ? db.prepare("SELECT key, hash FROM kb_nodes WHERE source = 'global'").all()
      : db.prepare("SELECT key, hash FROM kb_nodes WHERE source = 'kb' AND project_id = ?").all(scope.slice(3))
    for (const row of rows) existing.set(row.key, row)
  }

  const seen = new Set()
  const changed = []
  let added = 0
  let updated = 0
  let unchanged = 0

  const insert = db.prepare(`
    INSERT INTO kb_nodes (key, source, project_id, entry_id, kind, domain, title, digest, chars, hash,
      trust, completeness, created_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '可用')
  `)
  const update = db.prepare(`
    UPDATE kb_nodes SET source = ?, project_id = ?, entry_id = ?, kind = ?, domain = ?, title = ?,
      digest = ?, chars = ?, hash = ?, trust = ?, completeness = ?, updated_at = ?
    WHERE key = ?
  `)

  for (const item of list) {
    const key = item.key || keyOf(item.source, item.projectId, item.entryId)
    seen.add(key)
    const entry = item.entry || {}
    const body = bodyOf(entry)
    const hash = hashOf(body)
    const title = String(entry.title || item.entryId).slice(0, 120)
    const digest = digestOf(entry, MAX_DIGEST)
    const row = existing.get(key)

    if (row && row.hash === hash) {
      /* 正文没变，但标题 / 领域可能改过 —— 只补元数据，不动计数 */
      db.prepare('UPDATE kb_nodes SET title = ?, domain = ?, digest = ?, kind = ?, status = ? WHERE key = ?')
        .run(title, item.domain || '', digest, item.kind || '', item.status || '可用', key)
      unchanged += 1
      continue
    }
    const trust = Number.isFinite(item.trust) ? item.trust : 1
    const completeness = completenessOf(entry)
    const chars = body.length
    if (row) {
      update.run(
        item.source || 'kb', item.projectId ?? null, item.entryId, item.kind || '',
        item.domain || '', title, digest, chars, hash, trust, completeness, at, key
      )
      updated += 1
    } else {
      insert.run(
        key, item.source || 'kb', item.projectId ?? null, item.entryId, item.kind || '',
        item.domain || '', title, digest, chars, hash, trust, completeness,
        item.createdAt || at, at
      )
      added += 1
    }
    changed.push({ key, text: body })
  }

  /* 作用域内已删掉的条目：索引必须跟着删，否则会推荐一条打开就 404 的知识 */
  let removed = 0
  for (const key of existing.keys()) {
    if (seen.has(key)) continue
    db.prepare('DELETE FROM kb_nodes WHERE key = ?').run(key)
    db.prepare('DELETE FROM kb_terms WHERE key = ?').run(key)
    removed += 1
  }

  /* 词向量：有变更就重建**本作用域**（idf 在作用域内一致即可，检索也按作用域走） */
  let termCount = 0
  if (changed.length) {
    const docs = list
      .filter((item) => seen.has(item.key || keyOf(item.source, item.projectId, item.entryId)))
      .map((item) => ({ key: item.key || keyOf(item.source, item.projectId, item.entryId), text: bodyOf(item.entry) }))
    const { vectors } = vectorsFor(docs)
    const del = db.prepare('DELETE FROM kb_terms WHERE key = ?')
    const ins = db.prepare('INSERT OR REPLACE INTO kb_terms (key, term, weight) VALUES (?, ?, ?)')
    for (const [key, vec] of vectors) {
      del.run(key)
      for (const [term, w] of vec) {
        ins.run(key, term, w)
        termCount += 1
      }
    }
  }

  const links = changed.length === 0 || opts.rebuildLinks === false
    ? 0
    : rebuildLinks(db, [...scopes])
  return { added, updated, removed, unchanged, terms: termCount, links }
}

/**
 * 重建条目间的连线：只在同一作用域内两两比较（全局知识算一个作用域）。
 * 跨项目不连边 —— 一个「构建」会把所有项目的构建条目连成一团。
 * @param {object} db
 * @param {string[]} [scopes] 只重建这些作用域；不传则全量
 */
function rebuildLinks (db, scopes = null) {
  const rows = db.prepare("SELECT key, project_id, source FROM kb_nodes WHERE status = '可用'").all()
  const buckets = new Map()
  for (const row of rows) {
    const bucket = row.source === 'global' ? 'global' : 'kb:' + String(row.project_id || 'default')
    if (scopes && !scopes.includes(bucket)) continue
    if (!buckets.has(bucket)) buckets.set(bucket, [])
    buckets.get(bucket).push(row.key)
  }
  const terms = new Map()
  for (const row of db.prepare('SELECT key, term, weight FROM kb_terms').all()) {
    if (!terms.has(row.key)) terms.set(row.key, new Map())
    terms.get(row.key).set(row.term, row.weight)
  }

  const at = new Date().toISOString()
  const out = []
  for (const keys of buckets.values()) {
    /* 同桶超过 600 条时不再两两比较：O(n²) 会把同步拖成秒级，
       而知识条目到这个量级时，同域邻近已经足够代替全量连线。 */
    if (keys.length > 600) continue
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const lex = weights.cosine(terms.get(keys[i]), terms.get(keys[j]))
        /* 知识条目普遍偏短，余弦天然低于长文本：0.08 会把整张网连成空的 */
        if (lex >= 0.03) out.push({ a: keys[i], b: keys[j], lexical: Number(lex.toFixed(4)) })
      }
    }
  }
  const kept = weights.trimLinks(out, 4)
  const ins = db.prepare(`
    INSERT OR REPLACE INTO kb_links (a, b, weight, lexical, cooccur, hits, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, ?)
  `)
  /* 按作用域清旧边：a 一定是桶内下标较小者，按 a 删就能清干净，
     不用逐条比对（600 条时逐条删要跑十几万次）。 */
  for (const keys of buckets.values()) {
    if (keys.length > 600) continue
    const chunk = 200
    for (let i = 0; i < keys.length; i += chunk) {
      const part = keys.slice(i, i + chunk)
      const marks = part.map(() => '?').join(',')
      db.prepare(`DELETE FROM kb_links WHERE a IN (${marks})`).run(...part)
    }
  }
  for (const link of kept) ins.run(link.a, link.b, link.lexical, link.lexical, at)
  return kept.length
}

/* ------------------------------------------------------------ 检索 */

function readNodes (db, keys) {
  if (!keys.length) return new Map()
  const marks = keys.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT * FROM kb_nodes WHERE key IN (${marks}) AND status = '可用'`
  ).all(...keys)
  return new Map(rows.map((row) => [row.key, row]))
}

/**
 * 加权检索。
 *
 * @param {object} db
 * @param {object} input
 * @param {string} input.query        查什么
 * @param {string} [input.projectId]  只查这个项目（默认全部项目 + 全局知识）
 * @param {string} [input.kind]       方法 / 避错
 * @param {string} [input.domain]
 * @param {number} [input.limit]
 * @param {boolean} [input.includeGlobal=true]
 * @param {number} [input.minScore]
 * @param {number} [input.now]        参照时间（毫秒），测试用
 * @returns {{entries:Array<object>, scanned:number, candidates:number, ms:number}}
 */
function search (db, input = {}) {
  const started = Date.now()
  const query = String(input.query || '').trim()
  const limit = Math.max(1, Math.min(Number(input.limit) || 5, 20))
  const at = Number.isFinite(input.now) ? input.now : Date.now()
  const out = { entries: [], scanned: 0, candidates: 0, ms: 0 }
  if (!query) return out

  const where = ["status = '可用'"]
  const args = []
  if (input.projectId) {
    if (input.includeGlobal === false) {
      where.push('project_id = ?')
      args.push(String(input.projectId))
    } else {
      where.push("(project_id = ? OR source = 'global')")
      args.push(String(input.projectId))
    }
  } else if (input.includeGlobal === false) {
    where.push("source = 'kb'")
  }
  if (input.kind) { where.push('kind = ?'); args.push(String(input.kind)) }
  if (input.domain) { where.push('domain = ?'); args.push(String(input.domain)) }

  const total = db.prepare(`SELECT COUNT(*) AS n FROM kb_nodes WHERE ${where.join(' AND ')}`).get(...args).n || 0
  out.scanned = total
  if (!total) return out

  /* ① 查询向量：只留索引里出现过的词 */
  const freq = weights.termFreq(weights.tokenize(query))
  const qvec = new Map()
  let qnorm = 0
  const dfStmt = db.prepare('SELECT COUNT(*) AS n FROM kb_terms WHERE term = ?')
  for (const [term, tf] of freq) {
    const df = dfStmt.get(term).n || 0
    if (!df) continue
    const idf = Math.log((total + 1) / (df + 1)) + 1
    const w = weights.tfWeight(tf) * idf
    qvec.set(term, w)
    qnorm += w * w
  }
  qnorm = Math.sqrt(qnorm) || 1

  /* ② 倒排取候选：只碰命中词的行，不扫全表 */
  const scores = new Map()
  const matched = new Map()
  const termStmt = db.prepare(`
    SELECT t.key, t.weight FROM kb_terms t
    JOIN kb_nodes n ON n.key = t.key
    WHERE t.term = ? AND ${where.map((w) => w.replace(/\b(status|project_id|kind|domain|source)\b/g, 'n.$1')).join(' AND ')}
  `)
  for (const [term, w] of qvec) {
    for (const row of termStmt.all(term, ...args)) {
      scores.set(row.key, (scores.get(row.key) || 0) + (w / qnorm) * row.weight)
      if (!matched.has(row.key)) matched.set(row.key, [])
      matched.get(row.key).push(term)
    }
  }
  if (!scores.size) return out

  /* ③ 相关度 → 综合分：相关度优先，权重调节次序 */
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, DEFAULTS.maxCandidates)
  out.candidates = ranked.length
  const nodes = readNodes(db, ranked.map(([key]) => key))
  const normQuery = weights.normalize(query)

  const pool = []
  for (const [key, raw] of ranked) {
    const node = nodes.get(key)
    if (!node) continue
    const title = weights.normalize(node.title)
    const digest = weights.normalize(node.digest)
    const terms = matched.get(key) || []
    /* 标题 / 摘要命中是强信号：一条知识的标题就是它的适用场景 */
    const titleHits = terms.filter((term) => title.includes(term)).length
    const digestHits = terms.filter((term) => digest.includes(term)).length
    const fieldBoost = 1 + 0.3 * clamp(titleHits / Math.max(1, terms.length), 0, 1) +
      0.15 * clamp(digestHits / Math.max(1, terms.length), 0, 1)
    const relevance = clamp(raw, 0, 1)
    const self = weightOf(node, at)
    const score = Math.pow(relevance, DEFAULTS.relevancePower) *
      (DEFAULTS.weightFloor + (1 - DEFAULTS.weightFloor) * self.weight) *
      fieldBoost
    pool.push({
      key,
      node,
      self,
      relevance,
      score,
      terms,
      titleHits,
      via: titleHits > 0 ? '标题命中' : '正文命中',
      neighbour: 0
    })
  }

  /* ④ 邻居扩散：直接命中的条目把「说的是同一件事」的邻居也带上来。
        只带一跳，且只带强边，避免枢纽条目把整本书拖出来。 */
  if (pool.length) {
    const topKeys = pool.slice(0, 12).map((item) => item.key)
    const marks = topKeys.map(() => '?').join(',')
    const links = db.prepare(
      `SELECT a, b, weight FROM kb_links WHERE a IN (${marks}) OR b IN (${marks})`
    ).all(...topKeys, ...topKeys)
    const byKey = new Map(pool.map((item) => [item.key, item]))
    for (const link of links) {
      if (link.weight < 0.05) continue
      const from = byKey.get(link.a)
      const to = byKey.get(link.b) || null
      const src = from || byKey.get(link.b)
      if (!src) continue
      const otherKey = from ? link.b : link.a
      let target = to || byKey.get(otherKey)
      if (!target) {
        /* 邻居没进候选：从库里补一条，只补分数够的 */
        const row = nodes.get(otherKey) || db.prepare("SELECT * FROM kb_nodes WHERE key = ? AND status = '可用'").get(otherKey)
        if (!row) continue
        const self = weightOf(row, at)
        const rel = clamp(src.relevance * link.weight * 0.8, 0, 1)
        target = {
          key: otherKey,
          node: row,
          self,
          relevance: rel,
          score: Math.pow(rel, DEFAULTS.relevancePower) *
            (DEFAULTS.weightFloor + (1 - DEFAULTS.weightFloor) * self.weight),
          terms: [],
          titleHits: 0,
          via: '同网邻居',
          neighbour: 0
        }
        pool.push(target)
        byKey.set(otherKey, target)
      }
      if (target === src) continue
      const boost = DEFAULTS.diffuseAlpha * link.weight * src.score
      if (boost > target.neighbour) target.neighbour = boost
    }
    for (const item of pool) {
      if (item.neighbour > 0) item.score += item.neighbour
    }
  }

  /* ⑤ 排序 + MMR 去冗余：同一本书 / 同一领域的条目不该占满名额 */
  pool.sort((a, b) => b.score - a.score)
  const linkSim = new Map()
  for (const item of pool) linkSim.set(item.key, new Map())
  if (pool.length > 1) {
    const keys = pool.map((item) => item.key)
    const marks = keys.map(() => '?').join(',')
    for (const link of db.prepare(`SELECT a, b, weight FROM kb_links WHERE a IN (${marks}) AND b IN (${marks})`).all(...keys, ...keys)) {
      if (!linkSim.has(link.a) || !linkSim.has(link.b)) continue
      linkSim.get(link.a).set(link.b, link.weight)
      linkSim.get(link.b).set(link.a, link.weight)
    }
  }

  const minScore = Number.isFinite(input.minScore) ? input.minScore : 0.05
  const picked = []
  const used = new Set()
  const maxScore = pool.length ? pool[0].score : 1
  while (picked.length < limit) {
    let best = null
    let bestScore = -Infinity
    for (const item of pool) {
      if (used.has(item.key)) continue
      if (item.score < minScore) continue
      let sim = 0
      for (const chosen of picked) {
        const link = linkSim.get(item.key)?.get(chosen.key) || 0
        const sameDomain = item.node.domain && item.node.domain === chosen.node.domain ? DEFAULTS.domainSim : 0
        sim = Math.max(sim, link, sameDomain)
      }
      const mmr = DEFAULTS.mmrLambda * (item.score / (maxScore || 1)) -
        (1 - DEFAULTS.mmrLambda) * sim
      if (mmr > bestScore) { bestScore = mmr; best = item }
    }
    if (!best) break
    used.add(best.key)
    picked.push(best)
  }

  out.entries = picked.map((item) => {
    const id = splitKey(item.key)
    return {
      key: item.key,
      id: item.node.entry_id,
      source: item.node.source,
      projectId: id.projectId,
      kind: item.node.kind,
      domain: item.node.domain,
      title: item.node.title,
      digest: item.node.digest,
      chars: item.node.chars,
      weight: Number(item.self.weight.toFixed(3)),
      percent: weights.pct(item.self.weight),
      score: Number(item.score.toFixed(3)),
      relevance: Number(item.relevance.toFixed(3)),
      why: item.via,
      matchedTerms: item.terms.slice(0, 8),
      freshness: item.self.freshness,
      precision: item.self.precision,
      ageDays: item.self.ageDays,
      opens: item.node.opens,
      exposures: item.node.exposures
    }
  })
  out.ms = Date.now() - started
  return out
}

/* ------------------------------------------------------------ 计数与反馈 */

/* 曝光：被检索出来就算一次。与打开分开记，才能算出「搜出来没人看」。 */
function recordExposure (db, keys) {
  if (!keys || !keys.length) return 0
  const stmt = db.prepare('UPDATE kb_nodes SET exposures = exposures + 1 WHERE key = ?')
  let n = 0
  for (const key of keys) n += stmt.run(key).changes || 0
  return n
}

function recordOpen (db, key) {
  const r = db.prepare('UPDATE kb_nodes SET opens = opens + 1, last_open_at = ? WHERE key = ?')
    .run(new Date().toISOString(), key)
  return r.changes || 0
}

function recordUse (db, keys) {
  if (!keys || !keys.length) return 0
  const stmt = db.prepare('UPDATE kb_nodes SET uses = uses + 1, last_use_at = ? WHERE key = ?')
  const at = new Date().toISOString()
  let n = 0
  for (const key of keys) n += stmt.run(at, key).changes || 0
  return n
}

/* 明确反馈：有用的抬高、没用的压低。这是权重唯一的人工干预入口。 */
function recordFeedback (db, key, useful) {
  const field = useful ? 'good' : 'bad'
  const r = db.prepare(`UPDATE kb_nodes SET ${field} = ${field} + 1 WHERE key = ?`).run(key)
  return r.changes || 0
}

function logHit (db, { query, keys, chars, ms }) {
  try {
    db.prepare('INSERT INTO kb_hits (id, at, query, picked, chars, ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), new Date().toISOString(), String(query || '').slice(0, 200),
        JSON.stringify(keys || []), Number(chars) || 0, Number(ms) || 0)
    /* 只留最近 500 条：日志是回看用的，不该无限增长 */
    db.prepare("DELETE FROM kb_hits WHERE id NOT IN (SELECT id FROM kb_hits ORDER BY at DESC LIMIT 500)").run()
  } catch { /* 日志失败不影响检索 */ }
}

/* ------------------------------------------------------------ 概览

   digest 是「渐进披露」的第一层：先告诉模型库里有什么、哪些权重最高，
   一条正文都不给。模型判断需要哪条，再 search / get。 */

function digest (db, input = {}) {
  const at = Number.isFinite(input.now) ? input.now : Date.now()
  const where = ["status = '可用'"]
  const args = []
  if (input.projectId) {
    where.push("(project_id = ? OR source = 'global')")
    args.push(String(input.projectId))
  }
  const rows = db.prepare(`SELECT * FROM kb_nodes WHERE ${where.join(' AND ')}`).all(...args)
  if (!rows.length) return { total: 0, chars: 0, kinds: {}, domains: [], top: [], cold: [] }

  const scored = rows.map((row) => ({ row, self: weightOf(row, at) }))
  const byKind = {}
  const byDomain = new Map()
  for (const item of scored) {
    const kind = item.row.kind || '未分类'
    byKind[kind] = (byKind[kind] || 0) + 1
    const domain = item.row.domain || '未分类'
    if (!byDomain.has(domain)) byDomain.set(domain, { domain, count: 0, weight: 0 })
    const acc = byDomain.get(domain)
    acc.count += 1
    acc.weight += item.self.weight
  }

  scored.sort((a, b) => b.self.weight - a.self.weight)
  const top = scored.slice(0, 8).map((item) => ({
    key: item.row.key,
    id: item.row.entry_id,
    kind: item.row.kind,
    title: item.row.title,
    percent: weights.pct(item.self.weight),
    opens: item.row.opens,
    ageDays: item.self.ageDays
  }))
  /* 冷条目：权重最低、且从来没被打开过 —— 不是让模型删，而是让它知道「这些可能已经没用」 */
  const cold = scored
    .filter((item) => item.row.opens === 0 && item.self.ageDays >= 30)
    .slice(-5)
    .reverse()
    .map((item) => ({ id: item.row.entry_id, title: item.row.title, ageDays: item.self.ageDays }))

  return {
    total: rows.length,
    chars: rows.reduce((sum, row) => sum + (row.chars || 0), 0),
    kinds: byKind,
    domains: [...byDomain.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 12)
      .map((item) => ({ domain: item.domain, count: item.count, percent: weights.pct(item.weight / item.count) })),
    top,
    cold
  }
}

module.exports = {
  DEFAULTS,
  keyOf,
  splitKey,
  digestOf,
  bodyOf,
  completenessOf,
  hashOf,
  weightOf,
  vectorsFor,
  sync,
  rebuildLinks,
  search,
  digest,
  recordExposure,
  recordOpen,
  recordUse,
  recordFeedback,
  logHit
}
