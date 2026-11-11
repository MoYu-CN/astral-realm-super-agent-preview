/* core.js — 状态、事件总线、DOM 工具、极简 Markdown */

/* ------------------------------------------------------- 会话通道 */

/* 两条互不相通的会话线：
   user  = 用户 ↔ AI
   agent = AI ↔ AI（派单与交付的内部往来）
   两者的消息存储、上下文组装、接口调用全程分开，任一侧都读不到另一侧的内容。 */
export const CHANNELS = ['user', 'agent']

export function channelOf (msg) {
  if (!msg) return 'user'
  if (msg.channel === 'agent' || msg.channel === 'user') return msg.channel
  /* 旧存档没有 channel，按层级与类型派生，保证升级后不丢不混 */
  if (msg.kind === 'plan') return 'agent'
  if (msg.kind === 'agent' && Number(msg.depth) > 0) return 'agent'
  return 'user'
}

/* 组装上下文的唯一入口——任何地方要取历史都必须走它，避免越界 */
export function messagesOf (channel) {
  return state.messages.filter((m) => channelOf(m) === channel)
}

/* ------------------------------------------------- 超级智能体的直连会话 */

/* 它不挂在任何项目上：左侧独立成条，点进去主对话区就是一条普通会话。
   消息存自己的文件，切项目、换成员都不会带走或污染它。 */
export const SUPER_THREAD = 'super'

export function superChatActive () {
  return Boolean(state.superChat && state.superChat.active)
}

export function superMessages () {
  return (state.superChat && state.superChat.messages) || []
}

/* 消息 id 在两套会话里都可能有，统一从这里取；
   渲染层不必关心当前在哪条线上，重绘才能复用同一套 DOM 逻辑。 */
export function findMsg (id) {
  return state.messages.find((m) => m.id === id) || superMessages().find((m) => m.id === id) || null
}

/* 旧的工具记录是「🔧 服务器 · 工具\n完成：明细」的 system 消息。
   加载时迁移成 kind:'tool'，让历史记录和新记录共用同一套折叠展示。 */
export function migrateToolLog (msg) {
  if (!msg || msg.kind !== 'system' || typeof msg.text !== 'string') return msg
  if (!msg.text.startsWith('🔧')) return msg
  const lines = msg.text.split('\n')
  const toolLabel = lines[0].replace(/^🔧\s*/, '').trim() || '工具调用'
  const rest = lines.slice(1).join('\n')
  const hit = /^(完成|已拒绝|失败)[：:]\s*([\s\S]*)$/.exec(rest)
  return {
    ...msg,
    kind: 'tool',
    toolLabel,
    args: '',
    ok: hit ? hit[1] === '完成' : false,
    denied: hit ? hit[1] === '已拒绝' : false,
    detail: hit ? hit[2] : rest
  }
}

/* 对话标题：用户手填的名称按原样保留（只压空白、限长）；
   留空时由第一句话生成，取第一句并限得更短，避免顶栏被长段落撑坏。 */
export function normalizeConversationTitle (value, max = 60) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  return raw.length > max ? `${raw.slice(0, max)}…` : raw
}

export function conversationTitleFromMessage (text, max = 30) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  const first = (raw.split(/[。！？!?\n]/)[0] || raw).trim()
  const base = first || raw
  return base.length > max ? `${base.slice(0, max)}…` : base
}

/* 对话模式只在新对话创建时选择；plugin 不是输入区临时开关。 */
export const CONVERSATION_MODES = ['solo', 'team', 'plugin']

export function normalizeConversationMode (value, fallback = 'solo') {
  return CONVERSATION_MODES.includes(value) ? value : fallback
}

function projectDefaultConversationMode () {
  const project = state.projects.find((item) => item.id === state.activeProjectId) || state.projects[0]
  if (!project || project.workMode !== 'team') return 'solo'
  const enabled = ((project.roster && project.roster.agents) || []).filter((agent) => agent.enabled !== false)
  return enabled.length > 1 ? 'team' : 'solo'
}

export function loadMessages (session) {
  const data = session || {}
  state.conversationTitle = normalizeConversationTitle(data.title, 60)
  state.conversationMode = normalizeConversationMode(data.conversationMode, projectDefaultConversationMode())
  /* 革新归档只用于回看，不参与上下文组装；最多保留两份，防止会话文件无限膨胀 */
  state.archives = Array.isArray(data.archives)
    ? data.archives.filter(Boolean).slice(0, 2).map((item) => ({
        ...item,
        messages: Array.isArray(item.messages) ? item.messages.slice(-120) : []
      }))
    : []
  const raw = Array.isArray(data.messages)
    ? data.messages
    : [...(data.user || []), ...(data.agent || [])]
  state.messages = raw
    .filter(Boolean)
    .map((m) => migrateToolLog(m))
    .map((m) => ({ ...m, channel: channelOf(m) }))
    .map((m) => ({
      ...m,
      summary: makeMessageSummary(m),
      summarySource: 'first-line'
    }))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
}

/* 旧消息可能残留模型摘要标记；渲染/加载时剔除，避免露在正文里。 */
export function stripSummaryMarker (text) {
  return String(text || '')
    .replace(/<astral:summary>[\s\S]*?<\/astral:summary>/gi, '')
    .replace(/<astral:summary>[\s\S]*$/i, '')
    .trim()
}

/* 折叠条只用消息正文第一句，不调用模型生成摘要。 */
export function makeMessageSummary (message) {
  if (!message) return ''
  if (message.kind === 'tool') {
    const label = String(message.toolLabel || '工具调用')
    return `${label} ${message.denied ? '已拒绝' : message.ok ? '完成' : '失败'}`
  }
  if (message.kind === 'plan') {
    const brief = String(message.brief || '').replace(/\s+/g, ' ').trim()
    if (brief) return brief.slice(0, 160)
    const tasks = Array.isArray(message.tasks) ? message.tasks : []
    if (tasks.length) return `派单 ${tasks.length} 项：${tasks.slice(0, 2).map((task) => task.name || task.to || '').filter(Boolean).join('、')}`
    return '任务派单'
  }
  const raw = String(message.text || '')
    .replace(/<astral:plan>[\s\S]*?<\/astral:plan>/gi, '')
    .replace(/<astral:summary>[\s\S]*?<\/astral:summary>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!raw) {
    if (message.kind === 'agent') return '（无回复）'
    if (message.kind === 'user') return '（空消息）'
    return '（无内容）'
  }
  const first = (raw.split(/[。！？!?\n]/)[0] || raw).trim()
  return (first.length > 80 ? `${first.slice(0, 80)}…` : first)
}

export const state = {
  settings: {},
  providers: { providers: [] },
  roster: { agents: [], globalSkills: [], globalNotes: '' },
  projects: [],
  activeProjectId: null,
  teamTemplates: [],
  skills: [],
  themes: [],
  plugins: [],
  messages: [],
  archives: [],
  conversationTitle: '',
  conversationMode: 'solo',
  tasks: [],
  jobs: [],
  pendingFiles: [],
  activeAgentId: null,
  view: 'user',
  busy: false,
  currentRunId: '',
  currentRunCapability: '',
  usage: null,
  contextSpec: 'auto',
  hardContext: null,
  /* 超级智能体的直连会话：不挂在任何项目上，切项目也不影响它。
     active 为真时主对话区显示的是这一条线，而不是项目会话。 */
  superChat: { active: false, loaded: false, messages: [], memory: [] },
  bridge: { port: 0, token: '', running: false },
  dirs: {},
  version: '0.0.0'
}

/* ------------------------------------------------------------- bus */

const listeners = new Map()

export const bus = {
  on (event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(fn)
    return () => bus.off(event, fn)
  },
  off (event, fn) {
    const set = listeners.get(event)
    if (set) set.delete(fn)
  },
  emit (event, payload) {
    const set = listeners.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try { fn(payload) } catch (err) { console.error(`[bus:${event}]`, err) }
    }
  }
}

/* 每条消息的完整原文都写入知识库；这里只负责“原样记录”，
   不做摘要、不改正文。超级会话另有链接到浓缩记忆的逻辑。 */
function persistMessageRecord (msg) {
  if (!msg || !msg.id || !msg.text || !window.astral || !window.astral.messageRecord) return
  window.astral.messageRecord({
    id: msg.id,
    conversationId: msg.thread || 'commander',
    thread: msg.thread || 'commander',
    role: msg.role || (msg.kind === 'user' ? 'user' : 'assistant'),
    sender: msg.kind === 'user' ? '用户' : (msg.name || 'AI'),
    createdAt: new Date(msg.ts || Date.now()).toISOString(),
    text: msg.text,
    meta: { kind: msg.kind, channel: msg.channel || '', agentId: msg.agentId || '' }
  }).catch(() => {})
}

bus.on('message:add', (msg) => {
  if (msg && msg.kind === 'user') persistMessageRecord(msg)
})
bus.on('message:done', ({ id } = {}) => {
  persistMessageRecord(findMsg(id))
})

/* ------------------------------------------------------------- dom */

export function $(sel, root = document) { return root.querySelector(sel) }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)] }

export function h (tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key === 'html') el.innerHTML = value
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value)
    else if (key === 'dataset') Object.assign(el.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value)
    else el.setAttribute(key, value === true ? '' : value)
  }
  append(el, children)
  return el
}

function append (parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

export function esc (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* -------------------------------------------------------- markdown */

function imageHtml (image) {
  const alt = esc((image && image.alt) || '图片')
  const src = esc((image && image.src) || '')
  return `<span class="md-image" data-src="${src}" data-alt="${alt}" role="button" tabindex="0"><span class="md-image-state">图片</span></span>`
}

function inline (s, images = []) {
  return s
    .replace(/\u0000I(\d+)\u0000/g, (_m, index) => imageHtml(images[Number(index)]))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
}

function tableCells (line) {
  let s = String(line || '').trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function tableAlignments (line) {
  return tableCells(line).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return ''
  })
}

function isTableSeparator (line) {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function tableHtml (header, separator, rows, images) {
  const aligns = tableAlignments(separator)
  const head = header.map((cell, index) => {
    const align = aligns[index]
    return `<th${align ? ` style="text-align:${align}"` : ''}>${inline(cell, images)}</th>`
  }).join('')
  const body = rows.map((row) => {
    const cells = header.map((_, index) => {
      const align = aligns[index]
      return `<td${align ? ` style="text-align:${align}"` : ''}>${inline(row[index] || '', images)}</td>`
    }).join('')
    return `<tr>${cells}</tr>`
  }).join('')
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

export function md (src) {
  const blocks = []
  const images = []
  let text = String(src || '').replace(/\r\n/g, '\n')
  text = text.replace(/```([\w+#-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = blocks.length
    blocks.push(`<pre><code data-lang="${esc(lang)}">${esc(code.replace(/\n$/, ''))}</code></pre>`)
    return `\u0000B${idx}\u0000`
  })
  text = text.replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g, (_m, alt, raw) => {
    let source = String(raw || '').trim()
    if (source.startsWith('<')) {
      const end = source.indexOf('>')
      if (end > 0) source = source.slice(1, end)
    } else {
      const titleAt = source.search(/\s+["']/)
      if (titleAt >= 0) source = source.slice(0, titleAt)
    }
    const idx = images.length
    images.push({ alt: String(alt || '').trim(), src: source.trim() })
    return `\u0000I${idx}\u0000`
  })
  text = esc(text)
  const out = []
  let list = null
  let para = []
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'), images)}</p>`); para = [] } }
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null } }
  const lines = text.split('\n')

  for (let li = 0; li < lines.length; li += 1) {
    const raw = lines[li]
    const line = raw.trim()
    if (!line) { flushPara(); flushList(); continue }

    if (li + 1 < lines.length && isTableSeparator(lines[li + 1]) &&
      tableCells(line).length === tableCells(lines[li + 1]).length) {
      flushPara(); flushList()
      const header = tableCells(line)
      const separator = lines[li + 1]
      const rows = []
      let next = li + 2
      while (next < lines.length && lines[next].trim() && lines[next].includes('|')) {
        rows.push(tableCells(lines[next]))
        next += 1
      }
      out.push(tableHtml(header, separator, rows, images))
      li = next - 1
      continue
    }

    const ph = /^\u0000B(\d+)\u0000$/.exec(line)
    if (ph) { flushPara(); flushList(); out.push(blocks[Number(ph[1])]); continue }

    let m
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      flushPara(); flushList()
      const level = m[1].length
      out.push(`<h${level}>${inline(m[2], images)}</h${level}>`)
      continue
    }
    if (/^(---+|\*\*\*+)$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue }
    if ((m = /^[-*+]\s+(.*)$/.exec(line))) {
      flushPara()
      if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul' }
      out.push(`<li>${inline(m[1], images)}</li>`)
      continue
    }
    if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara()
      if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol' }
      out.push(`<li>${inline(m[1], images)}</li>`)
      continue
    }
    if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1], images)}</blockquote>`); continue }
    para.push(line)
  }
  flushPara(); flushList()
  return out.join('')
}

/* ------------------------------------------------------------ misc */

let seq = 0
export function uid (prefix = 'id') { return `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}` }

export function timeLabel (ts = Date.now()) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/* 轻量 token 估算：中文/日文/韩文按 1 字 1 token，拉丁字符按 4 字符 1 token。
   这是给上下文环与用量提示用的估算值，不是供应商账单。 */
export function estimateTextTokens (text) {
  const source = String(text || '')
  let tokens = 0
  for (const ch of source) {
    const code = ch.codePointAt(0)
    const cjk = (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    tokens += cjk ? 1 : 0.25
  }
  return Math.ceil(tokens)
}

export function normalizeContextSpec (value) {
  if (value === '300k' || value === '1m') return value
  return 'auto'
}

export function fileTypeLabel (name, filePath = '') {
  const source = String(filePath || name || '')
  const idx = source.lastIndexOf('.')
  if (idx < 0 || idx === source.length - 1) return 'FILE'
  return source.slice(idx + 1).toUpperCase().slice(0, 8)
}

export async function copyText (text) {
  const value = String(text ?? '')
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = value
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.append(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

export function debounce (fn, wait = 400) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
}

export function agentById (id) {
  return state.roster.agents.find((a) => a.id === id) || null
}

export function agentByRole (role) {
  return state.roster.agents.filter((a) => a.role === role && a.enabled !== false)
}

export function commander () {
  return agentByRole('commander')[0] || state.roster.agents.find((a) => a.enabled !== false) || null
}

export function subordinatesOf (agent) {
  if (!agent) return []
  return state.roster.agents.filter((a) => a.reportsTo === agent.id && a.enabled !== false)
}

/* ------------------------------------------------------- 项目上下文 */

export function activeProject () {
  return state.projects.find((p) => p.id === state.activeProjectId) || state.projects[0] || null
}

/* 当前这条会话是不是「团队」。
   职位、职级、汇报线只属于团队；单独会话就是一个 AI 助手，
   界面上不该出现「副指挥」这类称谓，提示词里也不该自称职位。 */
export function conversationIsTeam () {
  const project = activeProject()
  const fallback = project && project.workMode === 'team' ? 'team' : 'solo'
  return normalizeConversationMode(state.conversationMode, fallback) === 'team'
}

/* 单独会话里真正在对话的那一位：优先当前选中，其次项目绑定的成员，
   最后退回第一位可用成员（与派单目标 resolveTarget 的取值顺序一致）。 */
export function soloAgent () {
  const project = activeProject()
  const enabled = (state.roster.agents || []).filter((a) => a && a.enabled !== false)
  const id = state.activeAgentId || (project && project.soloAgentId) || ''
  return enabled.find((a) => a.id === id) || enabled[0] || null
}

/* 项目对象只保存团队与元数据；消息按项目单独落盘，避免互相污染。 */
export function syncActiveProject () {
  const project = activeProject()
  if (!project) return null
  project.roster = state.roster
  project.updatedAt = Date.now()
  return project
}

function projectRecord (project) {
  const roster = project.roster || { agents: [], globalSkills: [], globalNotes: '' }
  return {
    id: project.id,
    name: project.name || '未命名项目',
    rootPath: project.rootPath || '',
    description: project.description || '',
    createdAt: project.createdAt || 0,
    updatedAt: project.updatedAt || 0,
    teamTemplateId: project.teamTemplateId || '',
    workMode: project.workMode === 'solo' ? 'solo' : 'team',
    conversationMode: normalizeConversationMode(project.conversationMode, project.workMode === 'solo' ? 'solo' : 'team'),
    autoName: project.autoName === true,
    archivedAt: Number(project.archivedAt) || 0,
    soloAgentId: typeof project.soloAgentId === 'string' ? project.soloAgentId : '',
    roster: {
      agents: roster.agents || [],
      globalSkills: roster.globalSkills || [],
      globalNotes: roster.globalNotes || ''
    }
  }
}

export function projectsPayload () {
  return {
    version: 1,
    activeProjectId: state.activeProjectId || null,
    projects: state.projects.map(projectRecord)
  }
}

export function saveProjectsNow () {
  syncActiveProject()
  const res = window.astral.saveConfig('projects.json', projectsPayload())
  syncMemoryProjects()
  return res
}

/* 项目名就是权重网的节点名：项目结构一变就镜像一次。
   只是元数据（名字 / 目录 / 摘要），不涉及会话正文；失败不影响保存。 */
let syncedProjectSig = ''
function syncMemoryProjects () {
  if (!window.astral || typeof window.astral.memorySyncProjects !== 'function') return
  const list = (state.projects || []).map((p) => ({
    name: p.name,
    rootPath: p.rootPath || '',
    summary: p.notes || ''
  }))
  const sig = list.map((p) => `${p.name}|${p.rootPath}|${p.summary.length}`).join('\u0000')
  if (sig === syncedProjectSig) return
  syncedProjectSig = sig
  Promise.resolve(window.astral.memorySyncProjects({ projects: list })).catch(() => {
    syncedProjectSig = ''
  })
}

export function syncMemoryProjectsNow () { syncMemoryProjects() }

export function sessionPayload () {
  const user = []
  const agent = []
  for (const m of state.messages) {
    const channel = channelOf(m)
    const copy = { ...m, channel }
    if (channel === 'agent') agent.push(copy)
    else user.push(copy)
  }
  return {
    version: 2,
    title: state.conversationTitle || '',
    conversationMode: normalizeConversationMode(state.conversationMode, 'solo'),
    contextSpec: normalizeContextSpec(state.contextSpec),
    user: user.slice(-300),
    agent: agent.slice(-300),
    archives: (state.archives || []).slice(0, 2).map(archiveRecord)
  }
}

/* 归档只保留回看需要的最小字段：正文截断、附件只留名称与大小，
   避免把整份附件正文再复制一次，把会话文件撑大。 */
function archiveRecord (archive) {
  const source = archive && typeof archive === 'object' ? archive : {}
  return {
    id: source.id || uid('archive'),
    ts: Number(source.ts) || Date.now(),
    thread: source.thread || 'commander',
    agentId: source.agentId || '',
    agentName: source.agentName || '',
    model: source.model || '',
    count: Number(source.count) || (Array.isArray(source.messages) ? source.messages.length : 0),
    tokens: Number(source.tokens) || 0,
    reason: source.reason || '',
    messages: (Array.isArray(source.messages) ? source.messages : []).slice(-120).map((msg) => ({
      id: msg.id,
      ts: msg.ts,
      kind: msg.kind,
      name: msg.name || '',
      title: msg.title || '',
      glyph: msg.glyph || '',
      color: msg.color || '',
      text: String(msg.text || '').slice(0, 2000),
      files: (msg.files || []).map((file) => ({
        name: file.name || '',
        size: Number(file.size) || 0,
        tokens: Number(file.tokens) || 0
      }))
    }))
  }
}

export function saveProjectSessionNow (projectId = state.activeProjectId) {
  if (!projectId) return Promise.resolve({ ok: false, message: 'no active project' })
  return window.astral.saveProjectSession(projectId, sessionPayload())
}

export function saveTemplatesNow () {
  return window.astral.saveConfig('team-templates.json', {
    version: 1,
    templates: state.teamTemplates
  })
}

export function skillById (id) {
  return state.skills.find((s) => s.id === id) || null
}

export function providerById (id) {
  return (state.providers.providers || []).find((p) => p.id === id) || null
}

export function toast (message, kind = '') {
  const root = $('#toast-root')
  if (!root) return
  const node = h('div', { class: `toast ${kind}`, text: message })
  root.append(node)
  setTimeout(() => {
    node.style.transition = 'opacity 200ms, transform 200ms'
    node.style.opacity = '0'
    node.style.transform = 'translateY(6px)'
    setTimeout(() => node.remove(), 220)
  }, 2600)
}

export const persist = {
  roster: debounce(() => {
    syncActiveProject()
    window.astral.saveConfig('projects.json', projectsPayload())
  }, 500),

  providers: debounce(() => {
    window.astral.saveConfig('providers.json', { providers: state.providers.providers })
  }, 500),

  settings: debounce(() => {
    window.astral.saveConfig('settings.json', state.settings)
  }, 300),

  /* 每个项目单独一份会话文件；切换项目时由 projects.js 显式冲刷。 */
  session: debounce(() => {
    if (state.activeProjectId) window.astral.saveProjectSession(state.activeProjectId, sessionPayload())
    else window.astral.saveSession(sessionPayload())
  }, 900),

  templates: debounce(() => {
    window.astral.saveConfig('team-templates.json', { version: 1, templates: state.teamTemplates })
  }, 400)
}

/* ------------------------------------------------------- 头像工具 */

function shrinkImage (dataUrl, size) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      const side = Math.min(img.width, img.height)
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('图片无法解析'))
    img.src = dataUrl
  })
}

export async function pickAvatar (size = 96) {
  if (!window.astral.pickImage) throw new Error('当前环境不支持选图')
  const raw = await window.astral.pickImage()
  if (!raw) return null
  return await shrinkImage(raw, size)
}

export function avatarNode (owner, size = 32, className = '') {
  const el = document.createElement('span')
  el.className = 'ava' + (className ? ` ${className}` : '')
  el.style.width = `${size}px`
  el.style.height = `${size}px`
  el.style.fontSize = `${Math.round(size * 0.44)}px`
  if (owner && owner.avatar) {
    const img = document.createElement('img')
    img.src = owner.avatar
    img.alt = ''
    el.append(img)
  } else {
    el.textContent = (owner && (owner.glyph || (owner.name || '').slice(0, 1))) || '◇'
  }
  return el
}

/* --------------------------------------------------- 数字输入的自绘步进 */

/* 原生 spinner 已由 CSS 隐藏（它的白底在深色主题里太扎眼），这里补回点击行为：
   输入框右侧 18px 为热区，上半步进 +1、下半步进 -1，和原生手感一致。 */
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (event) => {
    const target = event.target
    const input = target && target.closest ? target.closest('input[type="number"]') : null
    if (!input || input.disabled || input.readOnly) return
    const rect = input.getBoundingClientRect()
    if (!rect.width || event.clientX < rect.right - 18) return
    event.preventDefault()
    input.focus({ preventScroll: true })
    try {
      if (event.clientY < rect.top + rect.height / 2) input.stepUp()
      else input.stepDown()
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    } catch { /* step="any" 之类没有固定步长时静默跳过 */ }
  })
}
