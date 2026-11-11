'use strict'

/**
 * 星界 · 硬性上下文（常驻四块）
 *
 * 定位：每一轮都会进入超级智能体系统提示词的一小块固定内容，有字数硬上限。
 * 与按需检索的项目记忆、事件记录分开——后者不常驻上下文。
 *
 * 唯一来源：控制台、内置宿主、MCP 的 memory_context 都从这里读块定义与预算，
 * 避免「界面一套上限、服务端另一套」。
 */

const TOTAL_BUDGET = 3600
const securityBrief = require('../security/brief.js')
const intakeBrief = require('../intake/brief.js')

const SLOTS = [
  {
    key: 'identity',
    title: '身份与边界',
    hint: '它是谁、只做什么、明确不做什么',
    max: 900,
    order: 1,
    body: [
      '你是用户的超级智能体，长期驻留在星界中，负责三件事：记住用户做过的事、判断是否该主动做事、把任务派给执行层。',
      '',
      '- 你只与用户直接对话，具体开发由被派发的下级团队完成。',
      '- 你的记忆由完整原文库 `message_records` 与带编号的浓缩索引 `message_digests` 构成；默认只读浓缩索引，不读全库。',
      '- 默认上下文只带硬性上下文、本轮权重命中的浓缩索引和团队工具箱；需要原文时按编号回查。',
      '- 项目进度、计划书、任务详情、团队结构在团队工具箱；接管团队时自动读取。',
      '- 你不读取知识库正文，也不需要知道它是否存在；知识库属于执行层。',
      '- 不确定就说不确定；不编造事实、引用或执行结果。'
    ].join('\n')
  },
  {
    key: 'rules',
    title: '硬性规则',
    hint: '每一轮都必须遵守，不能被单个任务覆盖',
    max: 1200,
    order: 2,
    body: [
      '1. 上下文有硬上限：只装用户此刻在做的事；任务完成、事件解决或信息落实后，该事件立即移出上下文。',
      '2. 完整原文存 `message_records`，默认不进上下文；模型只拿 `message_digests` 的编号、时间、一句话和权重，需要细节时按编号回查。',
      '3. 权重由时间、事件、关联、动态四类组成，不按固定比例；权重决定取哪一条，不把整段原文拼进窗口。',
      '4. 每条消息保留完整原文，只追加不覆盖；不用摘要替代原文，不做日 / 周 / 月压缩。',
      '5. 消息编号形如 `M000001`，是右键引用和原文回查的唯一入口。',
      '6. 团队工具箱独立于会话，保存进度、计划书、任务详情、团队与接管来源；新团队进入项目先读工具箱。',
      '7. 临时团队结束回收会话与成员，只保留知识；项目团队工具箱随项目保留。',
      '8. 所有写入必须落库并留时间戳；资料与授权分开，出站动作先检查权限并留痕。',
      '9. 消息接入渠道开启时，上下文会出现「消息接入（实时）」；用 `memory_inbox` 获取摘要/线程，没有该块就不要声称自己在听或已收到外部消息。'
    ].join('\n')
  },
  {
    key: 'profile',
    title: '用户长期画像',
    hint: '跨项目成立的习性；一次性的要求不要写进来',
    max: 800,
    order: 3,
    body: [
      '- 母语：简体中文；交流与产出默认用简体中文。',
      '- 长期在做：星界（Electron 桌面工作台）。',
      '- 表达偏好：先给结论，再给必要依据；不复述问题、不写开场白。',
      '- 协作习惯：按轮次推进，每轮只解决一个明确问题；改动前先看现有实现。'
    ].join('\n')
  },
  {
    key: 'authorization',
    title: '默认授权',
    hint: '记忆读取、主动提问与派发的默认边界',
    max: 700,
    order: 4,
    body: [
      '- 默认只读取与当前任务相关的记忆索引；不主动扫描全库，不把原文批量拉进上下文。',
      '- 可以主动提问、主动建议；涉及删除、外部发送、付费或修改系统设置时，必须先问。',
      '- 向已有下级团队派发任务不需要每次确认；跨项目读取需要说明理由。',
      '- 用户关闭记忆或撤回授权后立即停止，并清空本轮临时上下文。'
    ].join('\n')
  }
]

const SLOT_MAP = new Map(SLOTS.map((s) => [s.key, s]))
const KEYS = new Set(SLOTS.map((s) => s.key))

function nowIso () { return new Date().toISOString() }

function clampText (value) {
  return value === null || value === undefined ? '' : String(value)
}

function slotOf (key) {
  const slot = SLOT_MAP.get(String(key || ''))
  if (!slot) throw new Error('未知的硬性上下文块：' + String(key || ''))
  return slot
}

/* 首次建库 / v1 升级到 v2 时写入默认四块；之后用户清空也不会重新塞回 */
function seed (db) {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO hard_context (slot, body, updated_at, revision) VALUES (?, ?, ?, 1)'
  )
  const at = nowIso()
  db.exec('BEGIN')
  try {
    for (const slot of SLOTS) stmt.run(slot.key, slot.body, at)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw err
  }
}

function rowsBySlot (db) {
  const rows = db.prepare('SELECT slot, body, updated_at, revision FROM hard_context').all()
  return new Map(rows.map((r) => [String(r.slot), r]))
}

function blockOf (slot, row) {
  const body = row ? clampText(row.body) : slot.body
  return {
    key: slot.key,
    title: slot.title,
    hint: slot.hint,
    max: slot.max,
    order: slot.order,
    body,
    chars: body.length,
    filled: Boolean(body.trim()),
    updatedAt: row && row.updated_at ? row.updated_at : null,
    revision: row && row.revision ? Number(row.revision) : 1,
    seeded: !row
  }
}

function readAll (db) {
  const rows = rowsBySlot(db)
  const blocks = SLOTS.map((slot) => blockOf(slot, rows.get(slot.key)))
  const total = blocks.reduce((n, b) => n + b.chars, 0)
  const updatedAt = blocks.map((b) => b.updatedAt).filter(Boolean).sort().slice(-1)[0] || null
  return {
    blocks,
    total,
    budget: TOTAL_BUDGET,
    remaining: Math.max(0, TOTAL_BUDGET - total),
    filled: blocks.filter((b) => b.filled).length,
    updatedAt
  }
}

function save (db, key, body) {
  const slot = slotOf(key)
  const text = clampText(body).replace(/\r\n/g, '\n')
  if (text.length > slot.max) {
    throw new Error('「' + slot.title + '」最多 ' + slot.max + ' 字，当前 ' + text.length + ' 字')
  }
  const at = nowIso()
  db.prepare(`
    INSERT INTO hard_context (slot, body, updated_at, revision)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(slot) DO UPDATE SET
      body = excluded.body,
      updated_at = excluded.updated_at,
      revision = hard_context.revision + 1
  `).run(slot.key, text, at)
  const data = readAll(db)
  return {
    ...data,
    saved: data.blocks.find((b) => b.key === slot.key)
  }
}

/* 给智能体用的常驻文本：顺序固定，空块跳过。
   末尾附两段实时状态（各约 100–240 字，不计入四块预算）：
   「消息接入」回答「我在听什么、外面有没有事」，「安全状态」回答
   「有没有外发等我点头、问原委去哪儿问」。两块都没内容时都不占位。 */
function promptText (db) {
  const data = readAll(db)
  const lines = ['## 硬性上下文（常驻）']
  for (const block of data.blocks) {
    const body = block.body.trim()
    if (!body) continue
    lines.push('', '### ' + block.title, body)
  }
  try {
    const inbox = intakeBrief.lines(db)
    if (inbox.text) lines.push('', '### 消息接入（实时）', inbox.text)
  } catch { /* 收件箱表还没建好时不影响其余四块 */ }
  try {
    const brief = securityBrief.lines(db)
    if (brief.text) lines.push('', '### 安全状态（实时）', brief.text)
  } catch { /* 安全表还没建好时不影响其余四块 */ }
  if (lines.length === 1) return ''
  lines.push('', '以上内容每一轮都生效；不要向用户复述这份清单，也不要自行改写。')
  return lines.join('\n')
}

function summary (db) {
  const data = readAll(db)
  return {
    filled: data.filled,
    totalBlocks: data.blocks.length,
    chars: data.total,
    budget: data.budget,
    remaining: data.remaining,
    updatedAt: data.updatedAt
  }
}

module.exports = {
  SLOTS,
  KEYS,
  TOTAL_BUDGET,
  seed,
  readAll,
  save,
  promptText,
  summary,
  slotOf
}
