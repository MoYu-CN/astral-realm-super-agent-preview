/* context-distill.js — 上下文沉淀（把长期成立的东西从会话里提出来）
 *
 * ## 两个作用域，两种口气
 *   - 项目上下文（state.roster.globalNotes）：注入本项目**所有**成员，人人共享的长期前提。
 *     由总指挥来写最合适 —— 它是唯一看得到全局、且要为此负责的角色。
 *   - 专属上下文（agent.context.notes）：只进某一个成员自己的提示词。
 *     由那个成员自己写：它最清楚自己反复被纠正的是什么。
 *
 * ## 和「项目进度」的分工
 * 进度是"做到哪了"，会一直变；上下文是"换一个窗口也仍然成立的前提"，尽量不变。
 * 所以提示词里明确要求：不写进度、不写待办、不写过程。
 *
 * ## 不直接落盘
 * 模型给的是草稿，弹层里可以改，确认后才写进上下文。上下文每轮都要带上，
 * 写错了就是每一轮都错，值得多一次确认。
 */

import { state, bus, h, toast, agentById, commander, soloAgent, channelOf, estimateTextTokens, persist } from './core.js'
import { callModel } from './llm.js'
import { openModal, closeModal } from './modal.js'

/* 总结请求本身也要花上下文：从最近往前装，超了就不再塞。 */
const TRANSCRIPT_BUDGET = 24000
const ITEM_LIMIT = 2400

const SCOPES = {
  global: { key: 'global', label: '项目上下文', limit: 1200, maxTokens: 1500 },
  agent: { key: 'agent', label: '专属上下文', limit: 800, maxTokens: 1200 }
}

const GLOBAL_SYSTEM = [
  '你在为一个项目沉淀「项目上下文」。这份内容会注入本项目所有成员每一轮的系统提示词，',
  '是全体共享、且应当长期成立的前提。',
  '',
  '只写「换一个对话窗口之后依然成立」的东西：',
  '- 项目要做什么、做到什么算完成',
  '- 已经拍板、不再讨论的方案与取舍（可带一句理由）',
  '- 所有成员都必须遵守的约束：目录范围、命名、禁区、交付标准',
  '- 术语、关键文件与命令在哪',
  '- 用户明确表达过、需要长期照顾的偏好',
  '',
  '不要写：',
  '- 进度、待办、下一步（那属于项目进度，不在这里）',
  '- 过程叙述、谁在哪一轮说了什么',
  '- 一次性的调试细节、临时决定',
  '- 会话里没有出现过的信息',
  '',
  '格式：',
  '- 4–7 条，每条形如「- **标签**：一句话」，一行一条',
  '- 不要标题、不要前言、不要总结句',
  '- 总长 600–1200 字'
].join('\n')

function agentSystem (agent) {
  const title = agent.title ? `（${agent.title}）` : ''
  return [
    `你在为成员「${agent.name}」${title}沉淀「专属上下文」。这份内容只进入它自己的系统提示词，`,
    '是它跨会话都要记住的长期设定。',
    '',
    '只写只属于它的东西：',
    '- 它负责什么、不负责什么、和谁协作',
    '- 它的产出标准与工作习惯（例如先给结论、给路径与行号）',
    '- 用户对它提过的固定要求、纠正过的错误（改写成规则）',
    '- 它踩过的坑与对应的做法',
    '',
    '不要写：',
    '- 项目级的目标、约束、术语 —— 那些属于项目上下文，写在这里会重复',
    '- 进度、待办、这次会话的具体任务',
    '- 会话里没有出现过的信息',
    '',
    '格式：',
    '- 3–6 条，每条形如「- **标签**：一句话」，一行一条',
    '- 不要标题、不要前言、不要总结句',
    '- 总长 300–800 字'
  ].join('\n')
}

function roleLabel (msg) {
  if (msg.kind === 'handoff') return '上一段会话交接摘要'
  if (msg.kind === 'user') return '用户'
  if (msg.kind === 'system') return '系统'
  return msg.name || 'AI'
}

/* 取材范围：
   - 项目上下文：整条「用户 ↔ AI」会话（团队会话都记在总指挥那条线上）。
   - 专属上下文：它自己那条线；团队里执行者往往没有独立对话，
     所以把它收到过的派单与交付也补进来 —— 那才是它真正干过的活。 */
function collectMaterial (scope, agent) {
  const items = []
  const push = (role, text, ts) => {
    const body = String(text || '').trim()
    if (body) items.push({ role, text: body, ts: Number(ts) || 0 })
  }

  if (scope !== 'agent' || !agent) {
    for (const msg of state.messages) {
      if (channelOf(msg) !== 'user') continue
      if (msg.kind === 'system' || msg.kind === 'tool') continue
      push(roleLabel(msg), msg.text, msg.ts)
    }
    return items.sort((a, b) => a.ts - b.ts)
  }

  const thread = agent.id || 'commander'
  for (const msg of state.messages) {
    if (channelOf(msg) !== 'user') continue
    if ((msg.thread || 'commander') !== thread) continue
    if (msg.kind === 'system' || msg.kind === 'tool') continue
    push(roleLabel(msg), msg.text, msg.ts)
  }
  for (const msg of state.messages) {
    if (channelOf(msg) !== 'agent' || msg.kind !== 'plan') continue
    for (const task of msg.tasks || []) {
      if (!task || task.to !== agent.id) continue
      const text = [task.text, task.result ? `交付：${task.result}` : ''].filter(Boolean).join('\n\n')
      push(`派给「${agent.name}」的任务`, text, msg.ts)
    }
  }
  return items.sort((a, b) => a.ts - b.ts)
}

function transcriptOf (items) {
  const picked = []
  let used = 0
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    const text = String(item.text || '').trim()
    if (!text) continue
    const body = text.length > ITEM_LIMIT ? `${text.slice(0, ITEM_LIMIT)}…（后略）` : text
    if (used + body.length > TRANSCRIPT_BUDGET && picked.length) break
    picked.push(`### ${item.role}\n${body}`)
    used += body.length
  }
  return picked.reverse().join('\n\n')
}

function compact (text) {
  return String(text || '')
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

function countChars (text) {
  return [...String(text || '').replace(/\s+/g, '')].length
}

function resolveGlobalScribe () {
  const boss = commander()
  if (boss) return { agent: boss, fallback: false }
  const current = (state.activeAgentId && agentById(state.activeAgentId)) || soloAgent()
  return current ? { agent: current, fallback: true } : { agent: null, fallback: true }
}

function notesOf (scope, agent) {
  if (scope === 'global') return String(state.roster.globalNotes || '')
  return String((agent && agent.context && agent.context.notes) || '')
}

function writeNotes (scope, agent, mode, text) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: '内容为空' }
  const previous = notesOf(scope, agent).trim()
  const next = mode === 'append' && previous ? `${previous}\n${body}` : body
  if (scope === 'global') {
    state.roster.globalNotes = next
  } else {
    agent.context = agent.context || { notes: '', historyLimit: 16 }
    agent.context.notes = next
  }
  persist.roster()
  bus.emit('roster:changed')
  return { ok: true, chars: countChars(next) }
}

/* ---------------------------------------------------------------- 弹层 */

export function openContextDistill ({ scope = 'global', agentId = '' } = {}) {
  const config = SCOPES[scope] || SCOPES.global
  if (state.busy) {
    toast('协作进行中，等这一轮结束后再沉淀上下文', 'err')
    return
  }

  let target = null
  let scribe = null
  let fallback = false
  if (config.key === 'global') {
    const resolved = resolveGlobalScribe()
    scribe = resolved.agent
    fallback = resolved.fallback
    target = scribe
  } else {
    target = (agentId && agentById(agentId)) || soloAgent() || (state.activeAgentId && agentById(state.activeAgentId))
    scribe = target
  }
  if (!target || !scribe) {
    toast(config.key === 'global' ? '当前项目没有可用的智能体' : '这条会话还没有绑定智能体', 'err')
    return
  }

  const material = collectMaterial(config.key, config.key === 'agent' ? target : null)
  if (!transcriptOf(material)) {
    toast(config.key === 'agent'
      ? '这位成员还没有对话或派单记录，先让它干一轮活再沉淀'
      : '还没有可用来沉淀的会话内容', 'err')
    return
  }

  const draft = {
    step: 'running',
    text: '',
    received: 0,
    error: '',
    closed: false,
    active: false,
    progressEl: null
  }
  let paint = () => {}

  const run = async () => {
    /* 重新沉淀按住不放不该发出两次请求：一次只允许一个在飞 */
    if (draft.active) return
    draft.active = true
    draft.step = 'running'
    draft.text = ''
    draft.received = 0
    draft.error = ''
    if (!draft.closed) paint()
    try {
      const transcript = transcriptOf(material)
      const existing = notesOf(config.key, target).trim()
      let streamed = ''
      const result = await callModel(
        { ...scribe, temperature: 0.2 },
        [
          { role: 'system', content: config.key === 'global' ? GLOBAL_SYSTEM : agentSystem(target) },
          {
            role: 'user',
            content: [
              existing ? `已有的${config.label}（保留其中仍然成立的部分，过时的删掉）：\n${existing}` : `已有的${config.label}：无`,
              '',
              '以下是需要沉淀的会话原文：',
              '',
              transcript
            ].join('\n')
          }
        ],
        {
          maxTokens: config.maxTokens,
          channel: 'user',
          onDelta: (delta) => {
            streamed += delta
            draft.received = streamed.length
            if (draft.closed) return
            if (draft.progressEl && draft.progressEl.isConnected) {
              draft.progressEl.textContent = `正在沉淀… 已接收 ${draft.received} 字`
            }
          }
        }
      )
      const clean = compact(result || streamed)
      if (!clean) throw new Error('模型没有返回内容')
      draft.text = clean
      draft.step = 'preview'
    } catch (err) {
      draft.error = err.message || '沉淀失败'
      draft.step = 'error'
    } finally {
      draft.active = false
      if (!draft.closed) paint()
    }
  }

  const runningPanel = (body) => {
    body.textContent = ''
    const failed = draft.step === 'error'
    const progressText = h('span', { text: failed ? '沉淀失败' : '正在阅读会话…' })
    draft.progressEl = failed ? null : progressText
    body.append(
      h('div', { class: 'renew-head' },
        h('div', {},
          h('div', { class: 'renew-title', text: `${config.label} · ${target.name}` }),
          h('div', { class: 'renew-meta', text: `${material.length} 条素材 · 由 ${scribe.name}${scribe.model ? ` · ${scribe.model}` : ''} 生成` })
        ),
        h('span', { class: 'renew-badge', text: failed ? '未完成' : '沉淀中' })
      ),
      h('div', { class: 'renew-bounds' },
        h('div', { class: 'renew-bounds-title', text: '这份内容会去哪' }),
        h('div', { class: 'hint', text: config.key === 'global'
          ? '写进「项目上下文」，注入本项目所有成员的每一轮提示词。'
          : `写进「${target.name}」的专属上下文，只影响它自己的提示词。` }),
        h('div', { class: 'hint', text: '只写长期成立的前提：进度与待办留在项目进度里。' }),
        fallback ? h('div', { class: 'hint', text: `本项目没有总指挥，由「${scribe.name}」代拟。` }) : null
      )
    )
    if (failed) {
      body.append(h('div', { class: 'newconvo-error', text: draft.error || '沉淀失败' }))
    } else {
      body.append(h('div', { class: 'renew-progress' }, h('i', { class: 'renew-spin', 'aria-hidden': 'true' }), progressText))
    }
    body.append(h('div', { class: 'renew-actions' },
      h('button', { class: 'btn ghost', onclick: () => { draft.closed = true; closeModal() } }, '取消'),
      h('button', {
        class: 'btn-primary',
        disabled: draft.active,
        onclick: run
      }, draft.active ? '沉淀中…' : (failed ? '重试' : '重新沉淀'))
    ))
  }

  const previewPanel = (body) => {
    body.textContent = ''
    draft.progressEl = null
    const area = h('textarea', {
      class: 'input renew-summary',
      spellcheck: 'false',
      oninput: (e) => { draft.text = e.target.value; paintMeta() }
    })
    area.value = draft.text

    const meta = h('div', { class: 'renew-meta' })
    const paintMeta = () => {
      const chars = countChars(draft.text)
      const over = chars > config.limit
      meta.textContent = `${chars} 字 · 建议 ≤ ${config.limit} 字 · 约 ${estimateTextTokens(draft.text)} tokens`
      meta.style.color = over ? 'var(--err)' : ''
    }
    paintMeta()

    const previous = notesOf(config.key, target).trim()
    const apply = (mode) => {
      const res = writeNotes(config.key, target, mode, draft.text)
      if (!res.ok) {
        toast(res.error, 'err')
        return
      }
      draft.closed = true
      closeModal()
      toast(`${config.label}已${mode === 'append' ? '追加' : '更新'} · ${res.chars} 字`, 'ok')
    }

    body.append(
      h('div', { class: 'renew-head' },
        h('div', {},
          h('div', { class: 'renew-title', text: `${config.label}草稿` }),
          meta
        ),
        h('span', { class: 'renew-badge ok', text: '待确认' })
      ),
      area,
      h('div', { class: 'renew-bounds' },
        h('div', { class: 'renew-bounds-title', text: '确认前' }),
        h('div', { class: 'hint', text: '这一段每轮都会带上，越长越贵；删掉不该长期成立的行再保存。' }),
        previous ? h('div', { class: 'hint', text: '「替换」会覆盖现有内容；「追加」会接在末尾，适合新旧互补。' }) : null
      ),
      h('div', { class: 'renew-actions' },
        h('button', { class: 'btn ghost', onclick: () => { draft.closed = true; closeModal() } }, '取消'),
        h('button', { class: 'btn ghost', onclick: run }, '重新沉淀'),
        previous ? h('button', { class: 'btn ghost', onclick: () => apply('append') }, '追加到末尾') : null,
        h('button', { class: 'btn-primary', onclick: () => apply('replace') }, previous ? '替换原内容' : '写入上下文')
      )
    )
    area.style.height = 'min(44vh, 380px)'
    area.focus({ preventScroll: true })
  }

  openModal({
    title: '沉淀上下文',
    sub: 'CONTEXT DISTILL · 只保留换窗口之后仍然成立的前提',
    width: 760,
    onClose: () => { draft.closed = true },
    render: (body) => {
      paint = () => {
        if (draft.closed) return
        if (draft.step === 'preview') previewPanel(body)
        else runningPanel(body)
      }
      paint()
      run()
    }
  })
}
