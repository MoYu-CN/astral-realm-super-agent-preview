/* superagent.js — 超级智能体的直连会话
 *
 * 它不是第二个窗口，也不是第二个编排入口：左侧独立成条，点进去就是主对话区
 * 里的一条普通会话，和跟某个成员说话一模一样（同一条消息流、同一个输入框）。
 *
 * 区别只在内部：
 *   - 不经过派单、监听或团队编排，直接把消息发给模型；
 *   - 历史写自己的文件（config/super-agent/session.json），不进项目会话；
 *   - 硬性上下文是它的常驻身份与规则，来自记忆库那四块。
 *
 * 它没有专属面板：右栏在直连会话里只留「插件」，任务进度回项目会话里看。
 */

import {
  state, bus, h, md, avatarNode, persist, toast, commander, pickAvatar, uid,
  superChatActive, activeProject
} from './core.js'
import { openModal, field } from './modal.js'
import { callModel } from './llm.js'
import { isGuest } from './roles.js'
import { setView } from './viewswitch.js'
import {
  formatRecalledEvents, hideExchange, modelHistory, normalizeMemory, timeRangeForQuery
} from './super-memory.js'

const MAX_MESSAGES = 120
let sending = false

const EVENT_SYSTEM = [
  '你是事件记录员，不是聊天助手。把这一轮用户与超级智能体的交流整理成一条可以入库的事件精华。',
  '',
  '只写事实：涉及的项目或对象、用户要做什么、已经做出的决定/派发/完成情况、结果和待跟进。',
  '不要写寒暄、过程废话、完整原文、代码、工具输出。',
  '',
  '只输出一个 JSON 对象，不要 Markdown：',
  '{"digest":"60-160字中文事件精华","weight":0.0到1.0,"factors":{"time":0.0,"project":0.0,"trigger":0.0,"usage":0.0,"result":0.0}}',
  'weight 由你根据时间近远、项目阶段、触发人、使用频率、结果综合决定，不要套固定比例；factors 是本次判断依据。'
].join('\n')

export function superProfile () {
  const box = state.settings.superAgent || (state.settings.superAgent = {})
  return {
    name: box.name || '星核',
    short: box.short || '核',
    avatar: box.avatar || '',
    color: box.color || '#c0a0ff',
    bio: box.bio || '常驻星界的超级智能体：记住做过的事、判断是否该主动做事、把任务派给执行层。',
    providerId: box.providerId || '',
    model: box.model || '',
    temperature: typeof box.temperature === 'number' ? box.temperature : 0.6
  }
}

function saveSuper (patch) {
  const box = state.settings.superAgent || (state.settings.superAgent = {})
  Object.assign(box, patch)
  persist.settings()
  bus.emit('super:changed')
}

/* 模型：优先用超级智能体自己的配置，否则跟随总指挥。
   编制里记着的供应商可能已经被删掉，所以每个候选都要在供应商表里核对一次，
   否则会出现「有供应商、却报未配置模型」。 */
function resolveAgent () {
  const profile = superProfile()
  const base = commander() || (state.roster.agents || []).find((a) => a.enabled !== false) || null
  const providers = (state.providers && state.providers.providers) || []
  if (!providers.length) return null
  const providerId = [profile.providerId, base && base.providerId, providers[0] && providers[0].id]
    .filter(Boolean)
    .find((id) => providers.some((p) => p.id === id)) || ''
  const provider = providers.find((p) => p.id === providerId) || null
  if (!provider) return null
  const inherited = base && base.providerId === providerId ? base.model : ''
  const model = profile.model || inherited || (provider.models && provider.models[0]) || ''
  if (!model) return null
  return {
    id: 'super',
    name: profile.name,
    role: 'super',
    providerId,
    model,
    temperature: profile.temperature
  }
}

export function superModelLabel () {
  const agent = resolveAgent()
  return agent ? agent.model : '未配置模型'
}

/* 用量环在直连会话里也要数对系统提示词，所以导出给 contextmeter 用 */
export function superSystemPrompt () {
  return systemPrompt()
}

function systemPrompt (recalled = '') {
  const profile = superProfile()
  const user = state.settings.profile || {}
  const layers = (state.settings.context && state.settings.context.layers) || {}
  const parts = []

  if (layers.hard !== false && state.hardContext && state.hardContext.text) {
    parts.push(state.hardContext.text.trim())
  }

  if (recalled) parts.push(recalled)

  parts.push([
    '## 身份',
    `你是「${profile.name}」${profile.short ? `（简称「${profile.short}」）` : ''}，用户长期驻留在星界里的超级智能体。`,
    profile.bio || ''
  ].filter(Boolean).join('\n'))

  if (layers.profile !== false && (user.name || user.likes)) {
    const lines = ['## 用户']
    if (user.name) lines.push(`- 称呼：${user.name}${user.short ? `（也可以叫他「${user.short}」）` : ''}`)
    if (user.likes && user.likes.trim()) lines.push(`- 偏好与背景：${user.likes.trim()}`)
    lines.push('照顾这些偏好，但不要复述、不要点出「根据你的偏好」。')
    parts.push(lines.join('\n'))
  }

  parts.push([
    '## 这条会话的边界',
    '- 这是用户与你的直连会话：不经过任务派发、不经过监听、不进入项目会话历史。',
    '- 你可以回答问题、给判断、提建议；但不要假装已经派发了任务、已经读过文件或已经执行了命令。',
    '- 需要执行时，明确说明「这一步要交给执行层」以及需要什么授权，不要用文字代替真实动作。',
    '- 不确定就说不确定；不编造事件编号、记录内容或执行结果。'
  ].join('\n'))

  parts.push('## 输出要求\n用简体中文回复。先给结论，再给必要依据；不要写开场白，不要复述问题。')
  return parts.join('\n\n')
}

/* ------------------------------------------------------------ 进入 / 离开 */

async function loadHistory () {
  if (state.superChat.loaded) return
  try {
    const data = await window.astral.loadSuperSession()
    const list = Array.isArray(data && data.messages) ? data.messages : []
    state.superChat.messages = list.filter((m) => m && typeof m.text === 'string' && m.text.trim())
    state.superChat.memory = normalizeMemory(data && data.memory)
  } catch {
    state.superChat.messages = []
    state.superChat.memory = []
  }
  state.superChat.loaded = true
}

function persistHistory () {
  const messages = (state.superChat.messages || []).slice(-MAX_MESSAGES)
  const memory = normalizeMemory(state.superChat.memory)
  state.superChat.messages = messages
  state.superChat.memory = memory
  /* 会话完整原文保留；浓缩只出现在模型上下文和记忆表中。 */
  return window.astral.saveSuperSession({ messages, memory }).catch(() => {})
}

/* 释放/恢复直连会话消息的上下文标记后，由界面层调用立即落盘 */
export function saveSuperHistoryNow () {
  persistHistory()
}

export async function enterSuperChat () {
  if (superChatActive()) {
    const input = document.querySelector('#input')
    if (input) input.focus()
    return
  }
  await loadHistory()
  state.superChat.active = true
  /* 直连只有一条线：AI ↔ AI 在这里没有意义，先切回用户视图 */
  setView('user')
  bus.emit('super:enter')
  bus.emit('super:changed')
  setTimeout(() => {
    const input = document.querySelector('#input')
    if (input) input.focus()
  }, 40)
}

export function leaveSuperChat () {
  if (!superChatActive()) return
  persistHistory()
  state.superChat.active = false
  bus.emit('super:leave')
  bus.emit('super:changed')
}

export function toggleSuperChat () {
  if (superChatActive()) leaveSuperChat()
  else enterSuperChat().catch((err) => toast(String(err.message || err), 'err'))
}

/* ------------------------------------------------------------- 发消息 */

function profileOwner () {
  const profile = superProfile()
  return {
    name: profile.name,
    short: profile.short,
    avatar: profile.avatar,
    glyph: '✦',
    color: profile.color
  }
}

function fallbackEssence (ask, reply) {
  const project = activeProject()
  const userText = String((ask && ask.text) || '').replace(/\s+/g, ' ').trim()
  const replyText = String((reply && reply.text) || '').replace(/\s+/g, ' ').trim()
  return {
    text: [
      project ? `项目：${project.name}` : '',
      `用户：${userText.slice(0, 100)}`,
      `结果：${replyText.slice(0, 180)}`
    ].filter(Boolean).join('；').slice(0, 360),
    weight: null,
    factors: {},
    scorer: 'fallback'
  }
}

function parseEssence (raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const data = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim())
    if (data && typeof data.digest === 'string' && data.digest.trim()) {
      return {
        text: data.digest.trim().slice(0, 600),
        weight: typeof data.weight === 'number' ? Math.max(0, Math.min(1, data.weight)) : null,
        factors: data.factors && typeof data.factors === 'object' ? data.factors : {},
        scorer: 'main'
      }
    }
  } catch { /* 模型没有按 JSON 输出时，退回纯文本精华 */ }
  return { text: text.slice(0, 600), weight: null, factors: {}, scorer: 'main-text' }
}

/* 只做事件精华，不做“摘要替代历史”。失败时用可读的兜底事件。 */
async function extractEssence (agent, ask, reply) {
  const userText = String((ask && ask.text) || '').trim()
  const replyText = String((reply && reply.text) || '').trim()
  if (!userText || !replyText || (reply && reply.error)) return null
  const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit)}…（后略）` : text
  try {
    const raw = await callModel(agent, [
      { role: 'system', content: EVENT_SYSTEM },
      {
        role: 'user',
        content: [
          '这一轮交流：',
          '',
          `用户：${clip(userText, 6000)}`,
          '',
          `超级智能体：${clip(replyText, 6000)}`
        ].join('\n')
      }
    ], {
      channel: 'user',
      temperature: 0.2,
      maxTokens: 500
    })
    return parseEssence(raw) || fallbackEssence(ask, reply)
  } catch (err) {
    console.warn('[super memory] 事件精华提取失败，使用兜底事件：', err && err.message ? err.message : err)
    return fallbackEssence(ask, reply)
  }
}

/* 每条消息先写完整原文；记录只追加，不覆盖历史。 */
async function saveMessageRecord (msg) {
  if (!msg || !msg.id || !window.astral.messageRecord) return false
  try {
    const res = await window.astral.messageRecord({
      id: msg.id,
      conversationId: msg.thread || 'super',
      thread: msg.thread || 'super',
      role: msg.role || (msg.kind === 'user' ? 'user' : 'assistant'),
      sender: msg.kind === 'user' ? '用户' : (msg.name || '超级智能体'),
      createdAt: new Date(msg.ts || Date.now()).toISOString(),
      text: msg.text || '',
      meta: { kind: msg.kind, agentId: msg.agentId || '' }
    })
    return Boolean(res && res.ok)
  } catch (err) {
    console.warn('[super memory] 原文入库失败：', err && err.message ? err.message : err)
    return false
  }
}

/* 任务结束写一条结构化事件；完整原文与浓缩版本分表并通过消息 ID 链接。 */
async function writeEssenceEvent (ask, reply, essence) {
  const project = activeProject()
  const event = {
    action: 'event',
    prefix: 'SUP',
    series: '超级智能体直连',
    project: project ? project.id : null,
    startedAt: new Date(ask.ts).toISOString(),
    endedAt: new Date(reply.ts).toISOString(),
    result: '完成',
    summary: essence.text,
    metadata: {
      trigger: '用户',
      triggerType: '对话',
      messageIds: [ask.id, reply.id],
      weight: essence.weight,
      factors: essence.factors
    }
  }
  let saved = false
  let code = ''
  try {
    if (window.astral.memoryWrite) {
      const res = await window.astral.memoryWrite(event)
      saved = Boolean(res && res.ok)
      code = (res && res.data && res.data.code) || ''
    }
  } catch (err) {
    console.warn('[super memory] 事件入库失败，使用本地记忆：', err && err.message ? err.message : err)
  }
  try {
    if (window.astral.messageDigest) {
      await window.astral.messageDigest({
        messageId: ask.id,
        conversationId: ask.thread || 'super',
        projectId: project ? project.id : null,
        digest: essence.text,
        weight: essence.weight,
        weightJson: essence.factors,
        scorer: essence.scorer || 'main',
        metadata: { replyId: reply.id, eventCode: code, trigger: '用户', triggerType: '对话' }
      })
    }
  } catch (err) {
    console.warn('[super memory] 浓缩记忆入库失败：', err && err.message ? err.message : err)
  }
  /* 本地事件索引作为数据库不可用时的兜底。 */
  state.superChat.memory = normalizeMemory([
    ...state.superChat.memory,
    { ts: Date.now(), text: essence.text }
  ])
  return { saved, code }
}

/* 当前问题先看时间，再看权重；只把命中的事件精华交给本轮模型。 */
async function recallForMessage (text) {
  const range = timeRangeForQuery(text)
  let projects = []
  let events = []
  try {
    if (range && window.astral.memoryQuery) {
      const query = await window.astral.memoryQuery({
        time_range: { from: range.from, to: range.to },
        limit: 30
      })
      if (query && query.ok && query.data) events = query.data.events || []
    }
    if (window.astral.memoryRecall) {
      const recall = await window.astral.memoryRecall({
        query: text,
        limit: 3,
        mode: 'brief'
      })
      if (recall && recall.ok !== false) {
        projects = Array.isArray(recall.projects) ? recall.projects : []
        if (!events.length) events = Array.isArray(recall.events) ? recall.events : []
      }
    }
  } catch (err) {
    console.warn('[super memory] 记忆召回失败：', err && err.message ? err.message : err)
  }

  /* 有时间条件时，先严格收窄时间，再做项目/权重过滤；
     不允许“权重命中”把时间范围外的事件带回来。 */
  if (range) {
    const from = Date.parse(range.from)
    const to = Date.parse(range.to)
    events = events.filter((event) => {
      const at = Date.parse(event.startedAt || event.started_at || event.at || '') || 0
      return at >= from && at < to
    })
  }
  if (projects.length) {
    const ids = new Set(projects.map((project) => project.id).filter(Boolean))
    const names = new Set(projects.map((project) => project.name).filter(Boolean))
    events = events.filter((event) => ids.has(event.project_id) || ids.has(event.project))
  }

  /* 数据库关闭或不可用时，退回本地事件缓存；时间条件仍然先过滤。 */
  if (!events.length && state.superChat.memory.length) {
    const from = range ? Date.parse(range.from) : 0
    const to = range ? Date.parse(range.to) : Number.POSITIVE_INFINITY
    events = state.superChat.memory
      .filter((item) => {
        const at = Number(item.ts) || 0
        return at >= from && at < to
      })
      .map((item) => ({ summary: item.text, startedAt: new Date(item.ts).toISOString() }))
  }

  const block = formatRecalledEvents(events, projects, range)
  if (!block) return ''
  if (!range && projects.length > 1) {
    return [
      block,
      '',
      '## 记忆歧义',
      '以上命中多个项目。如果用户没有明确项目，先询问是哪个项目，不要自行猜测。'
    ].join('\n')
  }
  return block
}

export async function superSend (rawText) {
  if (isGuest()) {
    toast('游客是只读身份：可以浏览，但不能发起模型调用', 'err')
    return { ok: false, message: '游客只读' }
  }
  const text = String(rawText || '').trim()
  if (!text || sending) return { ok: false, message: '' }
  if (!superChatActive()) await enterSuperChat()

  const agent = resolveAgent()
  if (!agent) {
    toast('还没有可用的模型：先在 设置 → 模型供应商 里配置并填 Key', 'err')
    return { ok: false, message: '' }
  }

  const recalled = await recallForMessage(text)
  const history = modelHistory(state.superChat.messages)

  const ask = {
    id: uid('msg'),
    kind: 'user',
    channel: 'user',
    thread: 'super',
    role: 'user',
    text,
    ts: Date.now()
  }
  const reply = {
    id: uid('msg'),
    kind: 'agent',
    channel: 'user',
    thread: 'super',
    role: 'assistant',
    agentId: 'super',
    name: agent.name,
    short: superProfile().short,
    color: superProfile().color,
    glyph: '✦',
    avatar: superProfile().avatar,
    text: '',
    ts: Date.now(),
    streaming: true,
    meta: { model: agent.model }
  }
  state.superChat.messages.push(ask, reply)
  state.superChat.busy = true
  bus.emit('messages:reload')
  bus.emit('super:busy', true)
  await saveMessageRecord(ask)

  sending = true
  let essence = null
  try {
    const finalText = await callModel(agent, [
      { role: 'system', content: systemPrompt(recalled) },
      ...history,
      { role: 'user', content: text }
    ], {
      channel: 'user',
      onDelta: (chunk) => {
        if (reply.text === '（正在思考…）') reply.text = ''
        reply.text += chunk
        bus.emit('message:update', { id: reply.id })
      }
    })
    if (!reply.text) reply.text = String(finalText || '')
    if (!reply.text) reply.text = '（模型没有返回内容）'
    await saveMessageRecord(reply)
    essence = await extractEssence(agent, ask, reply)
    if (essence) await writeEssenceEvent(ask, reply, essence)
  } catch (err) {
    reply.error = true
    reply.text = reply.text || '调用失败：' + ((err && err.message) || err)
  } finally {
    if (essence && !reply.error) {
      hideExchange(state.superChat.messages, [ask.id, reply.id])
    }
    reply.streaming = false
    reply.ts = Date.now()
    sending = false
    state.superChat.busy = false
    persistHistory()
    bus.emit('message:update', { id: reply.id })
    bus.emit('super:busy', false)
  }
  return { ok: true }
}

/* ------------------------------------------------------------- 资料编辑 */

export function openSuperProfile () {
  const profile = superProfile()
  const preview = h('span', { class: 'ava', style: { width: '54px', height: '54px', fontSize: '20px' } })
  const paint = () => {
    preview.textContent = ''
    if (profile.avatar) preview.append(h('img', { src: profile.avatar, alt: '' }))
    else preview.textContent = (profile.name || '核').slice(0, 1)
  }
  paint()

  const name = h('input', {
    class: 'input',
    value: profile.name,
    placeholder: '它的名字',
    oninput: (e) => { profile.name = e.target.value; paint(); saveSuper({ name: e.target.value }) }
  })
  const short = h('input', {
    class: 'input',
    maxlength: '4',
    value: profile.short,
    placeholder: '消息里的简称',
    oninput: (e) => { profile.short = e.target.value; saveSuper({ short: e.target.value }) }
  })
  const bio = h('textarea', {
    class: 'textarea',
    placeholder: '它是谁、负责什么',
    oninput: (e) => { profile.bio = e.target.value; saveSuper({ bio: e.target.value }) }
  })
  bio.value = profile.bio

  const providers = (state.providers && state.providers.providers) || []
  const provider = h('select', {
    class: 'select',
    onchange: (e) => saveSuper({ providerId: e.target.value })
  },
  h('option', { value: '', text: '跟随总指挥' }),
  ...providers.map((p) => h('option', { value: p.id, selected: p.id === profile.providerId, text: p.name }))
  )
  provider.value = profile.providerId || ''

  const model = h('input', {
    class: 'input',
    value: profile.model,
    placeholder: '留空跟随总指挥的模型',
    oninput: (e) => saveSuper({ model: e.target.value.trim() })
  })

  openModal({
    title: '超级智能体',
    sub: 'SUPER AGENT · 资料',
    width: 640,
    render: (body) => {
      body.append(
        h('div', { class: 'super-profile-head' },
          preview,
          h('div', { class: 'super-profile-actions' },
            h('div', { class: 'hint', text: '头像与简称会显示在左侧入口、消息头与星图里' }),
            h('div', { class: 'btn-row', style: { marginTop: '6px' } },
              h('button', {
                class: 'btn ghost',
                onclick: async () => {
                  try {
                    const url = await pickAvatar(128)
                    if (url) { profile.avatar = url; paint(); saveSuper({ avatar: url }) }
                  } catch (err) { toast(err.message, 'err') }
                }
              }, '上传头像'),
              profile.avatar
                ? h('button', {
                  class: 'btn ghost',
                  onclick: () => { profile.avatar = ''; paint(); saveSuper({ avatar: '' }) }
                }, '清除')
                : null
            )
          )
        ),
        h('div', { class: 'field-row' }, field('名字', name), field('简称', short, '最多 4 个字')),
        field('简介', bio, '会写进它的系统提示词'),
        h('div', { class: 'field-row' },
          field('模型供应商', provider, '留空则跟随总指挥'),
          field('模型', model, '留空则跟随总指挥')
        ),
        h('div', { class: 'super-profile-foot' },
          h('button', {
            class: 'ctx-distill',
            type: 'button',
            onclick: async () => {
              const res = await window.astral.memoryOpenConsole({ view: 'hard' })
              if (!res || res.ok === false) toast('打开失败：' + ((res && res.error) || '未知错误'), 'err')
            }
          }, '编辑硬性上下文'),
          h('span', { class: 'hint', text: '身份、规则、用户画像与默认授权四块；保存后下一轮生效。' })
        )
      )
    }
  })
}

/* 空态与消息头都从这几个入口取，避免各处再自己拼一次。 */
export function superEmptyNode () {
  const profile = superProfile()
  const owner = profileOwner()
  return h('div', { class: 'stream-empty super-empty-stage' },
    h('div', { class: 'glyph' }, avatarNode(owner, 46, 'super-empty-ava')),
    h('h2', { text: `与 ${profile.name} 的会话` }),
    h('p', { class: 'solo-bio', text: profile.bio }),
    h('p', {
      text: isGuest()
        ? '游客不能与它对话。切回管理员或成员后，这里的输入框就可以用了。'
        : '这条会话只在你和它之间：不经过派单、不经过监听，也不会进入项目会话历史。直接说即可。'
    }),
    h('div', { class: 'empty-actions' },
      h('button', { class: 'btn ghost', onclick: () => openSuperProfile() }, '编辑它的资料')
    )
  )
}
