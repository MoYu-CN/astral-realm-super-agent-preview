/* projects.js — 多项目：项目文件夹、团队归属、项目会话隔离与切换 */

import {
  state, bus, h, $, uid, toast, activeProject, loadMessages, normalizeContextSpec,
  syncActiveProject, saveProjectsNow, saveProjectSessionNow, sessionPayload,
  normalizeConversationMode, normalizeConversationTitle, superChatActive
} from './core.js'
import { openModal, closeModal, field } from './modal.js'
import { confirmAction } from './confirm.js'
import { icon } from './icons.js'
import { instantiateTemplate, templateSummary } from './team-templates.js'
import { leaveSuperChat } from './superagent.js'
import { openScout } from './scout.js'

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

function safeId (id) {
  return typeof id === 'string' && ID_RE.test(id) ? id : uid('project')
}

function normalizeRoster (roster) {
  const data = roster && typeof roster === 'object' ? roster : {}
  return {
    agents: Array.isArray(data.agents) ? data.agents.filter(Boolean).map((a) => ({ ...a })) : [],
    globalSkills: Array.isArray(data.globalSkills) ? [...data.globalSkills] : [],
    globalNotes: typeof data.globalNotes === 'string' ? data.globalNotes : ''
  }
}

function normalizeProject (project) {  const p = project && typeof project === 'object' ? project : {}
  const roster = normalizeRoster(p.roster)
  const enabled = roster.agents.filter((agent) => agent.enabled !== false)
  const fallbackMode = enabled.length <= 1 ? 'solo' : 'team'
  const workMode = p.workMode === 'solo' || p.workMode === 'team' ? p.workMode : fallbackMode
  const conversationMode = normalizeConversationMode(p.conversationMode, workMode)
  const soloAgentId = typeof p.soloAgentId === 'string' && p.soloAgentId
    ? p.soloAgentId
    : (workMode === 'solo' ? ((enabled[0] && enabled[0].id) || '') : '')
  return {
    id: safeId(p.id),
    name: String(p.name || '未命名会话').trim() || '未命名会话',
    rootPath: typeof p.rootPath === 'string' ? p.rootPath : '',
    description: typeof p.description === 'string' ? p.description : '',
    createdAt: Number(p.createdAt) || Date.now(),
    updatedAt: Number(p.updatedAt) || Date.now(),
    teamTemplateId: typeof p.teamTemplateId === 'string' ? p.teamTemplateId : '',
    workMode,
    conversationMode,
    autoName: p.autoName === true,
    archivedAt: Number(p.archivedAt) || 0,
    soloAgentId,
    roster
  }
}

function applySessionConversationMode (project, session) {
  if (!project) return
  const explicit = session && ['solo', 'team', 'plugin'].includes(session.conversationMode)
  if (explicit) {
    project.conversationMode = normalizeConversationMode(session.conversationMode)
    state.conversationMode = project.conversationMode
    return
  }
  if (project.conversationMode) {
    state.conversationMode = normalizeConversationMode(project.conversationMode)
    return
  }
  project.conversationMode = normalizeConversationMode(state.conversationMode,
    project.workMode === 'team' ? 'team' : 'solo')
}

function normalizeTemplates (value) {
  const raw = value && Array.isArray(value.templates) ? value.templates : Array.isArray(value) ? value : []
  return raw.filter(Boolean).map((t) => ({
    ...t,
    id: typeof t.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(t.id) ? t.id : uid('tpl'),
    name: String(t.name || '未命名团队模板'),
    description: String(t.description || ''),
    globalSkills: Array.isArray(t.globalSkills) ? [...t.globalSkills] : [],
    members: Array.isArray(t.members) ? t.members.filter(Boolean).map((m) => ({ ...m })) : []
  }))
}

/* 首次启动：把旧的全局编制与会话迁移成一个默认项目，旧数据不丢。 */
async function migrateLegacy (data) {
  let legacy = { messages: [] }
  try { legacy = await window.astral.loadSession() } catch { /* keep empty */ }
  loadMessages(legacy)
  state.contextSpec = normalizeContextSpec(legacy.contextSpec)

  const project = normalizeProject({
    id: uid('project'),
    name: '默认项目',
    rootPath: '',
    description: '由原有编制和会话迁移生成；可改名并绑定项目文件夹。',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    teamTemplateId: '',
    roster: data.roster
  })
  state.projects = [project]
  state.activeProjectId = project.id
  state.roster = project.roster
  syncActiveProject()
  await Promise.all([
    saveProjectsNow(),
    saveProjectSessionNow(project.id)
  ])
}

export async function initProjects (data) {
  state.teamTemplates = normalizeTemplates(data && data.teamTemplates)
  const file = (data && data.projects) || {}
  const rawProjects = Array.isArray(file.projects) ? file.projects.filter(Boolean) : []

  if (!rawProjects.length) {
    await migrateLegacy(data || {})
    return activeProject()
  }

  state.projects = []
  for (const project of rawProjects) {
    const normalized = normalizeProject(project)
    if (state.projects.some((p) => p.id === normalized.id)) normalized.id = uid('project')
    state.projects.push(normalized)
  }

  const wanted = state.projects.find((project) => project.id === file.activeProjectId)
  const active = (wanted && !wanted.archivedAt ? wanted : null) ||
    state.projects.find((project) => !project.archivedAt) ||
    state.projects[0]
  state.activeProjectId = active.id
  state.roster = active.roster
  const soloId = currentWorkMode() === 'solo'
    ? (active.soloAgentId || ((active.roster.agents.find((agent) => agent.enabled !== false) || {}).id) || '')
    : ''
  state.activeAgentId = soloId && (active.roster.agents || []).some((agent) => agent.id === soloId)
    ? soloId
    : null

  try {
    const session = await window.astral.loadProjectSession(active.id)
    loadMessages(session)
    applySessionConversationMode(active, session)
    state.contextSpec = normalizeContextSpec(session && session.contextSpec)
  } catch {
    state.messages = []
    applySessionConversationMode(active, null)
    state.contextSpec = 'auto'
  }

  if (!wanted || wanted.id !== state.activeProjectId) await saveProjectsNow()
  return active
}

/* ------------------------------------------------------------ 项目切换 */

let switching = false

export async function switchProject (id) {
  if (state.busy) {
    toast('协作进行中，暂时不能切换项目', 'err')
    return false
  }
  if (switching) return false
  /* 直连会话是叠在当前项目上的一条线：点任何项目都先回到项目会话 */
  if (superChatActive()) leaveSuperChat()
  if (id === state.activeProjectId) return true
  const target = state.projects.find((p) => p.id === id)
  if (!target || target.archivedAt) return false

  switching = true
  try {
    const oldId = state.activeProjectId
    syncActiveProject()
    if (oldId) {
      await saveProjectsNow()
      await saveProjectSessionNow(oldId)
    }

    let session = { version: 2, user: [], agent: [] }
    try {
      session = await window.astral.loadProjectSession(id)
    } catch {
      session = { version: 2, user: [], agent: [] }
    }

    state.activeProjectId = target.id
    state.roster = target.roster || { agents: [], globalSkills: [], globalNotes: '' }
    loadMessages(session)
    applySessionConversationMode(target, session)
    state.contextSpec = normalizeContextSpec(session && session.contextSpec)
    const soloId = currentWorkMode() === 'solo'
      ? (target.soloAgentId || ((target.roster.agents.find((agent) => agent.enabled !== false) || {}).id) || '')
      : ''
    state.activeAgentId = soloId && (target.roster.agents || []).some((agent) => agent.id === soloId)
      ? soloId
      : null
    state.pendingFiles = []
    state.tasks = []
    syncActiveProject()
    await saveProjectsNow()

    bus.emit('project:changed', target)
    bus.emit('roster:changed')
    bus.emit('attachments:changed')
    return true
  } finally {
    switching = false
  }
}

/* ------------------------------------------------------------ 新增项目 */

export async function createProject ({ name, rootPath = '', description = '', templateId = '', roster = null, workMode = '', conversationMode = '', autoName = false, archivedAt = 0, silent = false }) {
  if (state.busy || switching) {
    toast('协作进行中，暂时不能新建项目', 'err')
    return null
  }
  const title = String(name || '').trim()
  if (!title) {
    toast('项目名称不能为空', 'err')
    return null
  }
  const template = state.teamTemplates.find((t) => t.id === templateId) || null
  /* roster 优先：AI 组队会直接给出一份完整团队，不经过模板文件 */
  const team = roster && Array.isArray(roster.agents)
    ? normalizeRoster(roster)
    : template
      ? instantiateTemplate(template)
      : { agents: [], globalSkills: [], globalNotes: '' }
  const enabled = team.agents.filter((agent) => agent.enabled !== false)
  /* 新项目默认标准会话；只有明确要求组队（模板/AI 组队）时才进团队模式 */
  const mode = workMode === 'solo' || workMode === 'team' ? workMode : 'solo'
  const convMode = conversationMode === 'plugin'
    ? 'plugin'
    : (conversationMode === 'solo' || conversationMode === 'team' ? conversationMode : mode)
  const project = normalizeProject({
    id: uid('project'),
    name: title,
    rootPath: String(rootPath || '').trim(),
    description: String(description || '').trim(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    teamTemplateId: template ? template.id : '',
    workMode: convMode === 'team' ? 'team' : 'solo',
    conversationMode: convMode,
    autoName: Boolean(autoName),
    archivedAt: Number(archivedAt) || 0,
    soloAgentId: convMode === 'team' ? '' : ((enabled[0] && enabled[0].id) || ''),
    roster: team
  })
  state.projects.push(project)
  const ok = await switchProject(project.id)
  if (!ok) return null
  if (!silent) toast(`项目「${project.name}」已创建`, 'ok')
  return project
}

/* 当前项目的有效工作模式：团队模式至少要有 2 名可用成员，否则退回单智能体 */
export function currentWorkMode () {
  const project = activeProject()
  if (!project) return 'solo'
  if (project.workMode === 'solo') return 'solo'
  const enabled = ((project.roster && project.roster.agents) || []).filter((agent) => agent.enabled !== false)
  return enabled.length > 1 ? 'team' : 'solo'
}

export function setProjectWorkMode (mode) {
  const project = activeProject()
  if (!project) return { ok: false, error: '当前没有活动项目' }
  const next = mode === 'solo' ? 'solo' : 'team'
  const enabled = ((project.roster && project.roster.agents) || []).filter((agent) => agent.enabled !== false)
  if (next === 'team' && enabled.length < 2) {
    return { ok: false, error: '团队模式至少需要 2 名可用成员' }
  }
  if (project.workMode === next) return { ok: true, mode: next }
  if (next === 'solo') {
    project.soloAgentId = state.activeAgentId ||
      project.soloAgentId ||
      ((enabled[0] && enabled[0].id) || '')
  }
  project.workMode = next
  project.updatedAt = Date.now()
  saveProjectsNow()
  bus.emit('project:mode', next)
  bus.emit('projects:changed', project)
  return { ok: true, mode: next }
}

/* 会话归档只从左侧活动列表移走，项目记录与会话文件都保留，可恢复。 */
export async function archiveProject (id) {
  if (state.busy || switching) return { ok: false, error: '当前有任务在运行，暂时不能归档' }
  const project = state.projects.find((item) => item.id === id)
  if (!project || project.archivedAt) return { ok: false, error: '会话不存在或已归档' }
  const active = id === state.activeProjectId
  const fallback = state.projects.find((item) => item.id !== id && !item.archivedAt) || null
  if (active && !fallback) return { ok: false, error: '至少保留一个未归档会话，请先新建一个' }
  project.archivedAt = Date.now()
  project.updatedAt = Date.now()
  if (active) {
    await saveProjectsNow()
    const ok = await switchProject(fallback.id)
    if (!ok) {
      project.archivedAt = 0
      await saveProjectsNow()
      return { ok: false, error: '切换会话失败，未归档' }
    }
  } else {
    await saveProjectsNow()
    bus.emit('projects:changed', project)
  }
  renderProjectTree()
  return { ok: true }
}

export async function restoreProject (id) {
  const project = state.projects.find((item) => item.id === id)
  if (!project) return false
  project.archivedAt = 0
  project.updatedAt = Date.now()
  await saveProjectsNow()
  bus.emit('projects:changed', project)
  renderProjectTree()
  return true
}

export function openArchivedProjects () {
  const archived = state.projects.filter((project) => project.archivedAt)
  openModal({
    title: '已归档会话',
    sub: 'ARCHIVED CONVERSATIONS · 可恢复，不会被删除',
    width: 560,
    render: (body) => {
      if (!archived.length) {
        body.append(h('div', { class: 'hint', text: '还没有归档会话。' }))
        return
      }
      for (const project of archived) {
        body.append(h('div', { class: 'archived-row' },
          h('div', { class: 'archived-main' },
            h('div', { class: 'archived-name', text: project.name }),
            h('div', { class: 'hint', text: `${project.rootPath || '未限定工作目录'} · ${conversationModeLabel(project)}` })
          ),
          h('button', {
            class: 'btn ghost',
            type: 'button',
            onclick: async () => {
              await restoreProject(project.id)
              closeModal()
              toast(`已恢复「${project.name}」`, 'ok')
            }
          }, '恢复')
        ))
      }
    }
  })
}

/* 项目设置里顺手把权重网里和它相连的项目列出来：
   星图上看连线与百分比，这里给出可复制的名字与排序。 */
async function loadProjectRelations (name, root) {
  if (!window.astral || typeof window.astral.memoryNet !== 'function') return
  let result
  try { result = await window.astral.memoryNet() } catch { return }
  const data = result && result.data
  if (!data || !Array.isArray(data.links)) return
  const nodes = new Map((data.nodes || []).map((node) => [node.id, node.name || node.id]))
  const related = data.links
    .map((link) => {
      const other = link.a === name ? link.b : (link.b === name ? link.a : null)
      if (!other) return null
      return {
        name: nodes.get(other) || other,
        percent: Math.round((link.weight || 0) * 100),
        hits: link.hits || 0
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 5)
  root.textContent = ''
  if (!related.length) {
    root.append(h('div', { class: 'hint', text: '这张网里还没有与它相连的项目；一起被回忆几次后会自动连上。' }))
    return
  }
  for (const item of related) {
    root.append(h('div', { class: 'project-rel-row', title: `一起被回忆 ${item.hits} 次` },
      h('span', { class: 'project-rel-name', text: item.name }),
      h('div', { class: 'project-rel-bar' }, h('i', { style: { width: item.percent + '%' } })),
      h('span', { class: 'project-rel-pct', text: item.percent + '%' })
    ))
  }
}

function conversationModeLabel (project) {
  const mode = normalizeConversationMode(project && project.conversationMode,
    project && project.workMode === 'team' ? 'team' : 'solo')
  if (mode === 'plugin') return '插件制作'
  return mode === 'team' ? '团队' : '单独'
}

export async function updateProject (id, patch = {}) {  const project = state.projects.find((p) => p.id === id)
  if (!project) return false
  if (typeof patch.name === 'string' && patch.name.trim()) project.name = patch.name.trim()
  if (typeof patch.rootPath === 'string') project.rootPath = patch.rootPath.trim()
  if (typeof patch.description === 'string') project.description = patch.description.trim()
  project.updatedAt = Date.now()
  await saveProjectsNow()
  bus.emit('projects:changed', project)
  return true
}

/* ---------------------------------------------------------- 项目文件夹 UI */

let mounted = false

export function mountProjectTree () {
  if (mounted) return
  mounted = true
  bus.on('project:changed', renderProjectTree)
  bus.on('projects:changed', renderProjectTree)
  bus.on('roster:changed', renderProjectTree)
  bus.on('conversation:mode', renderProjectTree)
  bus.on('conversation:title', (title) => {
    const project = activeProject()
    if (!project || !project.autoName) return
    const clean = normalizeConversationTitle(title, 60)
    if (!clean) return
    project.name = clean
    project.autoName = false
    project.updatedAt = Date.now()
    saveProjectsNow()
    bus.emit('projects:changed', project)
    renderProjectTree()
  })
  renderProjectTree()
}

export function renderProjectTree () {
  const root = $('#project-tree')
  if (!root) return
  root.textContent = ''
  const activeProjects = state.projects.filter((project) => !project.archivedAt)
  const archived = state.projects.filter((project) => project.archivedAt)

  root.append(h('div', { class: 'pt-head' },
    h('span', { class: 'pt-title' }, icon('folder', 12), h('span', { text: '会话 / 工作目录' })),
    h('button', {
      class: 'pt-add',
      title: '新建会话',
      onclick: () => bus.emit('newconversation:open')
    }, '＋')
  ))
  const activeForWorkdir = state.projects.find((project) => project.id === state.activeProjectId)
  root.append(h('div', {
    class: 'pt-workdir',
    title: (activeForWorkdir && activeForWorkdir.rootPath) || '未限定工作目录',
    text: (activeForWorkdir && activeForWorkdir.rootPath) || '未限定工作目录'
  }))

  const modeOrder = [
    ['team', '团队会话'],
    ['solo', '单独会话'],
    ['plugin', '插件制作']
  ]
  for (const [mode, label] of modeOrder) {
    const group = activeProjects.filter((project) => normalizeConversationMode(project.conversationMode,
      project.workMode === 'team' ? 'team' : 'solo') === mode)
    if (!group.length) continue
    const list = h('div', { class: 'pt-list pt-mode-group' },
      h('div', { class: 'pt-group-head' },
        h('span', { text: label }),
        h('small', { text: String(group.length) })
      )
    )
    for (const project of group) {
      const active = project.id === state.activeProjectId
      const count = (project.roster && project.roster.agents && project.roster.agents.length) || 0
      const scope = project.rootPath || '未限定工作目录'
      list.append(h('div', {
        class: 'project-folder' + (active ? ' active' : '') + ' mode-' + mode,
        dataset: { id: project.id },
        title: `工作目录：${scope}`,
        onclick: () => switchProject(project.id)
      },
      h('span', { class: 'pf-caret', text: active ? '▾' : '▸' }),
      h('span', { class: 'pf-mode', text: conversationModeLabel(project) }),
      h('span', { class: 'pf-name', text: project.name }),
      h('span', { class: 'pf-count', text: String(mode === 'team' ? count : 1) }),
      h('button', {
        class: 'pf-edit',
        title: '会话设置',
        onclick: (e) => { e.stopPropagation(); openProjectDialog(project) }
      }, '✎'),
      h('button', {
        class: 'pf-archive',
        title: '归档这个会话',
        onclick: async (e) => {
          e.stopPropagation()
          const ok = await confirmAction({
            title: '归档这个会话？',
            message: `归档会话「${project.name}」？归档后仍可在“已归档”中恢复。`,
            confirmText: '归档'
          })
          if (!ok) return
          const res = await archiveProject(project.id)
          if (!res.ok) toast(res.error || '归档失败', 'err')
        }
      }, '归')
      ))
    }
    root.append(list)
  }

  if (!activeProjects.length) {
    root.append(h('div', { class: 'dock-empty', text: '还没有会话。点击上方 ＋ 新建。' }))
  }

  if (archived.length) {
    root.append(h('button', {
      class: 'pt-archived',
      type: 'button',
      onclick: () => openArchivedProjects()
    }, `已归档 · ${archived.length}`))
  }
}

/* ---------------------------------------------------------- 新增/编辑弹层 */

export function openProjectDialog (project = null) {
  const editing = Boolean(project)
  const draft = editing
    ? { name: project.name, rootPath: project.rootPath || '', description: project.description || '' }
    : { name: '', rootPath: '', description: '' }

  let templateId = ''
  if (editing) templateId = project.teamTemplateId || ''

  openModal({
    title: editing ? '项目设置' : '新增项目文件夹',
    sub: editing ? 'PROJECT FOLDER · 独立团队与会话' : 'NEW PROJECT · 每个文件夹是一个项目',
    width: 620,
    render: (body) => {
      const pathInput = h('input', {
        class: 'input',
        value: draft.rootPath,
        placeholder: '可选：选择这个项目允许使用的文件目录',
        oninput: (e) => { draft.rootPath = e.target.value }
      })
      const chooseBtn = h('button', {
        class: 'btn ghost',
        onclick: async () => {
          if (!window.astral.pickFolder) return
          try {
            const picked = await window.astral.pickFolder()
            if (picked) {
              pathInput.value = picked
              draft.rootPath = picked
            }
          } catch (err) {
            toast('选择文件夹失败：' + err.message, 'err')
          }
        }
      }, '选择文件夹')

      const rows = [
        field('项目名称', h('input', {
          class: 'input',
          value: draft.name,
          placeholder: '例如：星界 · 界面重构',
          oninput: (e) => { draft.name = e.target.value }
        })),
        field('项目文件夹 / 文件范围', h('div', { class: 'input-with-btn' }, pathInput, chooseBtn),
          '绑定后，添加文件时只能从该目录选择；不绑定则暂不限制。'),
        field('项目说明（可选）', h('input', {
          class: 'input',
          value: draft.description,
          placeholder: '一句话说明这个项目',
          oninput: (e) => { draft.description = e.target.value }
        }))
      ]

      if (!editing) {
        const templates = state.teamTemplates || []
        const summary = h('div', { class: 'project-template-summary' })
        const select = h('select', {
          class: 'select',
          onchange: (e) => { templateId = e.target.value; paintTemplate() }
        },
        h('option', { value: '', selected: !templateId }, '空白团队（不预置成员）'),
        ...templates.map((t) => h('option', { value: t.id, selected: templateId === t.id }, t.name))
        )
        const paintTemplate = () => {
          const tpl = state.teamTemplates.find((t) => t.id === templateId)
          summary.textContent = ''
          summary.append(
            h('div', { class: 'project-template-title', text: tpl ? tpl.name : '空白团队' }),
            h('div', { class: 'hint', text: tpl ? templateSummary(tpl) : '新项目先不带成员；创建后可在 设置 → 编制 里添加总指挥、副指挥或 AI 成员。' })
          )
          if (tpl && tpl.members && tpl.members.length) {
            summary.append(h('div', { class: 'project-template-members' },
              tpl.members.map((m) => h('span', { class: 'template-chip' },
                h('i', { style: { background: m.color || 'var(--accent)' } }),
                `${m.name}${m.role === 'executor' ? '' : ` · ${m.role === 'commander' ? '总指挥' : '副指挥'}`}`
              ))
            ))
          }
        }
        rows.push(field('团队模板', select, '模板会被复制成该项目独有的成员，不会和其他项目共享。'))
        rows.push(summary)
        paintTemplate()
      } else {
        const roster = project.roster || { agents: [] }
        const counts = { commander: 0, deputy: 0, executor: 0 }
        for (const a of roster.agents || []) counts[a.role] = (counts[a.role] || 0) + 1
        const template = state.teamTemplates.find((t) => t.id === project.teamTemplateId)
        rows.push(
          field('当前团队', h('div', { class: 'project-team-summary' },
            h('div', { text: `总指挥 ${counts.commander} · 副指挥 ${counts.deputy} · AI 成员 ${counts.executor}` }),
            h('div', { class: 'hint', text: template ? `来源模板：${template.name}` : '未使用模板；成员可在 设置 → 编制 中维护。' }),
            (roster.agents || []).length
              ? h('div', { class: 'project-template-members' }, roster.agents.map((a) => h('span', { class: 'template-chip' },
                h('i', { style: { background: a.color || 'var(--accent)' } }),
                a.name
              )))
              : h('div', { class: 'hint', text: '这个项目还没有成员。' })
          ), '成员与总指挥/副指挥角色在切换到该项目后，到 设置 → 编制 中调整。')
        )
        const relatedBox = h('div', { class: 'project-related' })
        rows.push(field('相关项目 · 权重网', relatedBox,
          '按内容近似与一起回忆的次数算；控制台「星图」里点开这个项目，连线上会写出同样的百分比。'))
        loadProjectRelations(project.name, relatedBox)
        rows.push(field('探子 · 快速搭建权重网',
          h('button', {
            class: 'btn ghost',
            type: 'button',
            onclick: () => { closeModal(); setTimeout(() => openScout(project), 0) }
          }, '扫描项目文件'),
          '只读扫描项目目录 → 摘要 → 超级智能体整理 → 写入权重网；不改动任何文件。'))
      }

      body.append(
        h('div', { class: 'hint', text: '每个项目有独立的成员、会话与任务记录；切换项目不会把成员或消息带过去。' }),
        h('div', { style: { marginTop: '14px' } }, ...rows),
        h('div', { class: 'btn-row', style: { marginTop: '18px' } },
          h('button', { class: 'btn-primary', onclick: async () => {
            if (!draft.name.trim()) { toast('项目名称不能为空', 'err'); return }
            if (editing) {
              const ok = await updateProject(project.id, draft)
              if (ok) {
                closeModal()
                toast('项目已更新', 'ok')
              }
              return
            }
            const created = await createProject({ ...draft, templateId, workMode: templateId ? 'team' : 'solo' })
            if (created) closeModal()
          } }, editing ? '保存项目' : '创建项目'),
          h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消')
        )
      )
    }
  })
}
