/* dock.js — 右侧面板：任务 / 上下文 / 插件 */

import { state, bus, h, $, persist, debounce, toast, normalizeConversationMode, soloAgent, activeProject, superChatActive } from './core.js'
import { ROLE_LABEL, CONTEXT_LAYERS, FIXED_CONTEXT_LAYERS, promptSections, buildSystemPrompt } from './llm.js'
import { openSettings } from './settings.js'
import { openModal, closeModal } from './modal.js'
import { confirmAction } from './confirm.js'
import { createTaskScene } from './taskscene.js'
import { renderPreview } from './filepreview.js'
import { pluginDockPanes, pluginEnabled, setPluginEnabledLive, pluginConfig, savePluginSettings, isLegacyRuntime } from './plugins.js'
import { jobStatusLabel, activeJobId, createJob, startJob, pauseJob, removeJob, decomposeGoal, startAllInterrupted } from './jobs.js'
import { openContextDistill } from './context-distill.js'

let pane = 'tasks'
let lastMode = ''
let taskScene = null
/* 预览栏状态：文件路径与是否已插入「预览」标签 */
let previewTarget = ''
let previewTab = null
let savedDockWidth = ''
let contextAgentId = ''
let skillScope = 'agent'
let skillStatusText = ''
/* 进直连会话前的右栏状态，离开时按原样还原 */
let superDock = null
const PREVIEW_WIDTH = 560

/* 直连会话只跟它说话，右栏不挂项目面板：任务、上下文、知识库都收起来，
   只留「插件」这一页。以后真有插件面板需要在直连里出现，把 id 加进来。 */
const SUPER_DOCK_PANES = new Set(['plugins'])

function paneAllowedIn (name, superMode) {
  /* 文件预览是用户点文件时临时开的一页，不参与模式裁剪 */
  if (name === 'preview') return true
  return superMode ? SUPER_DOCK_PANES.has(name) : true
}

function paneAllowed (name) {
  return paneAllowedIn(name, superChatActive())
}

function paneUsable (name) {
  if (!paneAllowed(name)) return false
  if (name === 'tasks' && currentDockMode() !== 'team') return false
  return true
}

function fallbackPane () {
  return superChatActive() ? 'plugins' : defaultPaneForMode(currentDockMode())
}

function dockCollapsed () {
  return document.body.classList.contains('dock-collapsed')
}

function setDockCollapsed (collapsed) {
  document.body.classList.toggle('dock-collapsed', collapsed)
  window.dispatchEvent(new Event('resize'))
}

function dockWidthPx () {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-w')) || 0
}

/* 打开预览时临时加宽，离开预览面板再还原，不动用户保存的宽度 */
function widenDock () {
  /* 窗口不够宽时按可用空间收窄，保证中间对话区至少留 460px */
  const rail = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-w')) || 252
  const room = window.innerWidth - rail - 10 - 460
  const target = Math.max(360, Math.min(PREVIEW_WIDTH, room))
  if (dockWidthPx() >= target) return
  savedDockWidth = `${Math.round(dockWidthPx())}px`
  document.documentElement.style.setProperty('--dock-w', `${target}px`)
}

function restoreDock () {
  if (!savedDockWidth) return
  document.documentElement.style.setProperty('--dock-w', savedDockWidth)
  savedDockWidth = ''
}

/* 打开右侧预览栏：没有「预览」标签就新建，收起状态就展开，太窄就临时加宽 */
export function openPreview (target) {
  const next = String(target || '').trim()
  if (!next) return
  previewTarget = next
  ensurePreviewTab()
  if (pane === 'preview') render()
  else selectPane('preview')
  document.body.classList.remove('dock-collapsed')
  widenDock()
}

export function closePreview () {
  previewTarget = ''
  if (previewTab) {
    previewTab.remove()
    previewTab = null
  }
  restoreDock()
  if (pane === 'preview') selectPane(defaultPaneForMode(currentDockMode()))
}

function ensurePreviewTab () {
  const tabs = $('#dock-tabs')
  if (!tabs) return
  if (previewTab && previewTab.isConnected) return
  previewTab = h('button', { dataset: { pane: 'preview' }, title: '文件预览' }, '预览')
  tabs.append(previewTab)
}

function selectPane (name) {
  if (name === 'preview') widenDock()
  else restoreDock()
  /* 先停掉上一轮的 dock-swap 3D 动画，再渲染并定位插件 surface；
     否则切换瞬间量到的 slot 是变换后的尺寸，插件面板会跳位/卡顿。 */
  const body = $('#dock-body')
  if (body) body.classList.remove('dock-swap')
  pane = name
  const tabs = $('#dock-tabs')
  if (tabs) [...tabs.children].forEach((b) => b.classList.toggle('active', b.dataset.pane === name))
  render()
  playDockSwap()
}

export function openDockPane (name) {
  /* 直连会话里项目面板不可达，调用方拿到 false 就知道没打开 */
  if (!paneUsable(name)) return false
  let tab = document.querySelector(`#dock-tabs button[data-pane="${name}"]`)
  if (!tab) {
    /* 插件面板的 pane id 是「插件 id:面板 id」；允许调用方只传插件 id。 */
    const pluginPane = pluginDockPanes().find((item) => item.pluginId === name || item.id === name)
    if (pluginPane) tab = document.querySelector(`#dock-tabs button[data-pane="${pluginPane.id}"]`)
  }
  if (!tab) return false
  selectPane(tab.dataset.pane)
  return true
}

function currentDockMode () {
  const project = state.projects.find((item) => item.id === state.activeProjectId) || state.projects[0]
  return normalizeConversationMode(state.conversationMode, project && project.workMode === 'team' ? 'team' : 'solo')
}

/* 团队会话默认任务轨迹；单独/插件会话默认上下文。
   用户在非默认面板（插件/知识库/预览）时切换模式不会被强行拉走。 */
function defaultPaneForMode (mode) {
  return mode === 'team' ? 'tasks' : 'context'
}

/* 页签可见性只有一处判断：
   - 任务轨迹只对团队会话有意义，单独/插件会话隐藏；
   - 直连会话只留「插件」，任务 / 上下文 / 知识库这些项目面板一律不出现。 */
function syncModeTabs () {
  const mode = currentDockMode()
  const tabs = $('#dock-tabs')
  if (!tabs) return
  const superMode = superChatActive()
  for (const btn of tabs.children) {
    const name = btn.dataset && btn.dataset.pane
    if (!name) continue
    if (superMode) btn.hidden = !paneAllowedIn(name, true)
    else if (name === 'tasks') btn.hidden = mode !== 'team'
    else btn.hidden = false
  }
}

function syncModePane () {
  const mode = currentDockMode()
  const desired = fallbackPane()
  const modeChanged = lastMode && mode !== lastMode
  const onDefaultPane = pane === 'tasks' || pane === 'context'
  lastMode = mode
  syncModeTabs()
  if (!paneAllowed(pane)) {
    selectPane(desired)
    return
  }
  if (modeChanged && onDefaultPane && pane !== desired) {
    selectPane(desired)
    return
  }
  render()
}

function syncPluginTabs () {
  const tabs = $('#dock-tabs')
  if (!tabs) return
  for (const btn of [...tabs.querySelectorAll('button[data-plugin-pane]')]) btn.remove()
  const pluginTab = tabs.querySelector('button[data-pane="plugins"]')
  for (const pluginPane of pluginDockPanes()) {
    const tab = h('button', { dataset: { pane: pluginPane.id, pluginPane: pluginPane.pluginId || '' }, title: pluginPane.label }, pluginPane.label)
    if (pluginTab) tabs.insertBefore(tab, pluginTab)
    else tabs.append(tab)
  }
  if (!tabs.querySelector(`button[data-pane="${pane}"]`)) {
    pane = fallbackPane()
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane))
  }
  syncModeTabs()
}

export function mountDock () {
  const tabs = $('#dock-tabs')
  lastMode = currentDockMode()
  pane = defaultPaneForMode(lastMode)
  syncPluginTabs()
  syncModeTabs()
  if (tabs) [...tabs.children].forEach((b) => b.classList.toggle('active', b.dataset.pane === pane))
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pane]')
    if (!btn) return
    if (pane === btn.dataset.pane) return
    selectPane(btn.dataset.pane)
  })

  bus.on('task:update', () => {
    if (pane !== 'tasks') return
    queueMicrotask(() => {
      if (pane !== 'tasks') return
      if (!taskScene) render()
      else taskScene.update()
    })
  })
  bus.on('message:add', (msg) => {
    if (pane !== 'tasks' || msg.kind !== 'plan') return
    queueMicrotask(() => {
      if (pane !== 'tasks') return
      if (!taskScene) render()
      else taskScene.update()
    })
  })
  bus.on('session:clear', () => {
    if (pane === 'tasks' && taskScene) taskScene.update()
    else render()
  })
  bus.on('project:changed', () => {
    contextAgentId = ''
    syncModePane()
  })
  bus.on('conversation:mode', () => syncModePane())
  bus.on('active:agent', (id) => {
    if (id) contextAgentId = id
    if (pane === 'context') render()
  })
  bus.on('messages:reload', () => render())
  bus.on('roster:changed', () => { if (pane !== 'tasks') render() })
  bus.on('skills:changed', () => { if (pane === 'context') render() })
  bus.on('plugins:changed', () => { if (pane === 'plugins') render() })
  bus.on('jobs:changed', () => { if (pane === 'tasks') render() })
  bus.on('usage:changed', () => { if (pane === 'context') render() })
  bus.on('dock:refresh', () => { if (pane === 'context') render() })
  bus.on('dock:panes:changed', () => { syncPluginTabs(); render() })

  /* 直连会话里右栏没有可看的东西：进去先收起，点开也只剩「插件」。
     离开时还原进去前的页签与展开状态；用户在直连里自己点开过就不再替他收起。 */
  bus.on('super:enter', () => {
    superDock = { collapsed: dockCollapsed(), pane }
    if (!superDock.collapsed) setDockCollapsed(true)
    syncModeTabs()
    if (!paneAllowed(pane)) selectPane(fallbackPane())
  })
  bus.on('super:leave', () => {
    const saved = superDock
    superDock = null
    syncModeTabs()
    const target = saved && saved.pane && document.querySelector(`#dock-tabs button[data-pane="${saved.pane}"]`)
      ? saved.pane
      : fallbackPane()
    const next = paneUsable(target) ? target : fallbackPane()
    if (next !== pane) selectPane(next)
    else render()
    if (saved && !saved.collapsed && dockCollapsed()) setDockCollapsed(false)
  })

  render()
}

function playDockSwap () {
  const body = $('#dock-body')
  if (!body) return
  if (document.body.classList.contains('reduced-motion')) return
  body.classList.remove('dock-swap')
  void body.offsetWidth
  body.classList.add('dock-swap')
  setTimeout(() => body.classList.remove('dock-swap'), 440)
}

function render () {
  const body = $('#dock-body')
  if (!body) return
  /* 兜底：模式变了但还有别处直接调 render，别让整栏留白 */
  if (!paneUsable(pane)) {
    pane = fallbackPane()
    const tabs = $('#dock-tabs')
    if (tabs) [...tabs.children].forEach((b) => b.classList.toggle('active', b.dataset.pane === pane))
  }
  if (taskScene) {
    taskScene.destroy()
    taskScene = null
  }
  const scroll = body.scrollTop
  const pluginPane = pluginDockPanes().find((item) => item.id === pane)
  body.classList.toggle('tasks-mode', pane === 'tasks')
  body.classList.toggle('preview-mode', pane === 'preview')
  body.classList.toggle('plugin-pane-mode', Boolean(pluginPane))
  body.textContent = ''
  if (pane === 'tasks') renderTasks(body)
  else if (pane === 'context') renderContext(body)
  else if (pane === 'preview') renderPreviewPane(body)
  else if (pluginPane) pluginPane.render(body)
  else renderPlugins(body)
  body.scrollTop = pane === 'tasks' ? 0 : scroll
  /* 隔离插件用它判断自己的 surface 是否该显示、该贴到哪个槽位。 */
  bus.emit('dock:pane:changed', pane)
}

/* ---------------------------------------------------------------- 预览 */

function renderPreviewPane (body) {
  if (!previewTarget) {
    body.append(h('div', { class: 'dock-empty' },
      h('div', { text: '还没有打开文件。' }),
      h('div', { style: { marginTop: '6px', opacity: '.75' } },
        '点击对话里的文件路径，或工具记录里的文件名，就会在这里预览。')
    ))
    return
  }
  const host = h('div', { class: 'preview-pane' })
  body.append(host)
  renderPreview(host, previewTarget, { onClose: closePreview })
}

/* ------------------------------------------------------------------ 任务 */

function renderTasks (body) {
  renderTaskFolder(body)
  taskScene = createTaskScene()
  body.append(taskScene.root)
  renderJobs(body)
}

/* 任务产生的文件都落在项目文件夹里：给一行直达入口就够，不铺成卡片 */
function renderTaskFolder (body) {
  const project = activeProject()
  if (!project || !project.rootPath) return
  body.append(h('div', { class: 'dock-folder' },
    h('span', { class: 'txt', text: project.rootPath }),
    h('button', {
      class: 'chip',
      type: 'button',
      onclick: () => window.astral.openFile(project.rootPath)
    }, '在文件夹中打开')
  ))
}

function openNewJob () {
  const title = h('input', { class: 'input', placeholder: '例如：整理本周研究资料' })
  const objective = h('textarea', {
    class: 'note-area',
    style: { minHeight: '70px' },
    placeholder: '只写目标，点「自动拆解」，由模型生成步骤；也可以直接手写下面的步骤。'
  })
  const steps = h('textarea', {
    class: 'note-area',
    style: { minHeight: '150px' },
    placeholder: '每一步一行，按顺序执行。\n例如：\n先检索最近的资料\n再按主题整理成提纲\n最后写成简报'
  })
  const auto = h('button', { class: 'btn ghost', type: 'button', text: '自动拆解' })
  const scheduleAt = h('input', { class: 'input', type: 'datetime-local' })
  const repeat = h('select', { class: 'select' },
    h('option', { value: 'none' }, '只执行一次'),
    h('option', { value: 'daily' }, '每天重复')
  )
  auto.addEventListener('click', async () => {
    const goal = objective.value.trim()
    if (!goal) {
      toast('先写一个目标', 'err')
      return
    }
    auto.disabled = true
    auto.textContent = '拆解中…'
    try {
      const generated = await decomposeGoal(goal)
      steps.value = generated.map((step) => step.prompt).join('\n')
      if (!title.value.trim()) title.value = goal.slice(0, 40)
      toast(`已生成 ${generated.length} 个步骤，可继续编辑`, 'ok')
    } catch (err) {
      toast(`自动拆解失败：${err.message}`, 'err')
    } finally {
      auto.disabled = false
      auto.textContent = '自动拆解'
    }
  })
  const create = async (runNow) => {
    let schedule = null
    let nextRunAt = 0
    if (scheduleAt.value) {
      const at = new Date(scheduleAt.value)
      if (Number.isNaN(at.getTime())) {
        toast('定时时间无效', 'err')
        return
      }
      if (repeat.value === 'daily') {
        const hh = String(at.getHours()).padStart(2, '0')
        const mm = String(at.getMinutes()).padStart(2, '0')
        schedule = { repeat: 'daily', time: `${hh}:${mm}` }
      } else {
        schedule = { repeat: 'none', at: at.toISOString() }
        nextRunAt = at.getTime()
      }
    }
    const job = await createJob({
      title: title.value,
      steps: steps.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      schedule,
      nextRunAt
    })
    if (!job) return
    closeModal()
    if (runNow && !schedule) startJob(job.id)
    if (schedule) toast('长任务已定时', 'ok')
  }
  openModal({
    title: '新建长任务',
    sub: '步骤会按顺序各跑一轮，状态会保存到本机；应用重启后可继续。',
    width: 680,
    render: (body) => {
      body.append(
        h('div', { class: 'field' }, h('label', { class: 'label', text: '任务名称' }), title),
        h('div', { class: 'field', style: { marginTop: '12px' } },
          h('label', { class: 'label', text: '目标（用于自动拆解）' }), objective,
          h('div', { class: 'btn-row', style: { marginTop: '8px' } }, auto)),
        h('div', { class: 'field', style: { marginTop: '12px' } },
          h('label', { class: 'label', text: '定时执行（可选）' }),
          h('div', { class: 'btn-row', style: { flexWrap: 'wrap' } }, scheduleAt, repeat)),
        h('div', { class: 'field', style: { marginTop: '12px' } },
          h('label', { class: 'label', text: '步骤（一行一条）' }), steps),
        h('div', { class: 'hint', style: { marginTop: '10px' }, text: '自动拆解会调用当前模型，生成后仍可编辑。长任务会占用当前会话；执行期间可以暂停，暂停会取消当前这一步，继续时从这一步重试。定时任务只在应用运行时触发。' }),
        h('div', { class: 'btn-row', style: { marginTop: '16px', justifyContent: 'flex-end' } },
          h('button', { class: 'btn ghost', type: 'button', onclick: () => closeModal() }, '取消'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => create(false) }, '仅创建'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => create(true) }, '创建并开始')
        )
      )
    }
  })
}

function renderJobs (body) {
  body.append(h('div', { class: 'pane-title', style: { marginTop: '22px' }, text: `长任务${state.jobs.length ? `（${state.jobs.length}）` : ''}` }))
  body.append(h('div', { class: 'hint', text: '多步骤任务会按顺序执行，步骤状态持久化；重启后显示「上次中断」，可手动继续。' }))
  body.append(h('div', { class: 'btn-row', style: { marginTop: '10px', flexWrap: 'wrap' } },
    h('button', { class: 'btn ghost', type: 'button', onclick: openNewJob }, '新建长任务'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => startAllInterrupted() }, '继续全部'),
    h('label', { class: 'checkline', style: { padding: '0 0 0 8px' } },
      h('input', {
        type: 'checkbox',
        checked: Boolean(state.settings.jobs && state.settings.jobs.autoResume),
        onchange: (event) => {
          if (!state.settings.jobs) state.settings.jobs = {}
          state.settings.jobs.autoResume = event.target.checked
          persist.settings()
        }
      }),
      h('span', { text: '启动时自动继续中断任务' })
    ),
    h('label', { class: 'hint', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
      h('span', { text: '单步最多尝试' }),
      h('input', {
        class: 'input',
        type: 'number',
        min: '1',
        max: '5',
        style: { width: '64px' },
        value: String((state.settings.jobs && state.settings.jobs.stepAttempts) || 2),
        onchange: (event) => {
          if (!state.settings.jobs) state.settings.jobs = {}
          state.settings.jobs.stepAttempts = Math.max(1, Math.min(5, Number(event.target.value) || 2))
          event.target.value = String(state.settings.jobs.stepAttempts)
          persist.settings()
        }
      })
    )
  ))
  if (!state.jobs.length) {
    body.append(h('div', { class: 'dock-empty', style: { marginTop: '8px' }, text: '还没有长任务。新建后可以按步骤连续执行。' }))
    return
  }
  for (const job of state.jobs) {
    const done = (job.steps || []).filter((step) => step.status === 'done').length
    const active = activeJobId() === job.id
    const current = job.steps && job.steps[job.currentStep]
    const actions = h('div', { class: 'btn-row', style: { marginTop: '8px', flexWrap: 'wrap' } })
    if (job.status === 'running' || active) {
      actions.append(h('button', { class: 'btn ghost', type: 'button', onclick: () => pauseJob(job.id) }, '暂停'))
    } else if (job.status !== 'completed') {
      actions.append(h('button', { class: 'btn primary', type: 'button', onclick: () => startJob(job.id) }, job.status === 'scheduled' ? '立即执行' : (job.status === 'idle' ? '开始' : '继续')))
    }
    actions.append(h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
      const ok = await confirmAction({
        title: '删除长任务？',
        message: `删除长任务「${job.title}」？`,
        confirmText: '删除',
        danger: true
      })
      if (!ok) return
      await removeJob(job.id)
    } }, '删除'))
    body.append(h('div', { class: 'task-item job-item', dataset: { state: job.status === 'failed' ? 'error' : (job.status === 'completed' ? 'done' : (active ? 'running' : 'idle')) } },
      h('div', { class: 't-mark' }),
      h('div', { class: 't-body' },
        h('div', { class: 't-who' },
          h('span', { text: job.title || '未命名长任务' }),
          h('small', { text: `${jobStatusLabel(job.status)} · ${done}/${(job.steps || []).length}` })
        ),
        h('div', { class: 't-text', text: current && job.status !== 'completed' ? `当前：${current.title || current.prompt}` : (job.status === 'completed' ? '全部步骤已完成' : '等待开始') }),
        job.status === 'scheduled' && job.nextRunAt
          ? h('div', { class: 'hint', text: `下次执行：${new Date(job.nextRunAt).toLocaleString('zh-CN', { hour12: false })}` })
          : null,
        actions
      )
    ))
  }
}

/* ---------------------------------------------------------------- 上下文 */

function mergeSkillCatalog (fileSkills) {
  const plugins = (state.skills || []).filter((skill) => skill && skill.from)
  const seen = new Set()
  state.skills = [...(Array.isArray(fileSkills) ? fileSkills : []), ...plugins]
    .filter((skill) => {
      if (!skill || !skill.id || seen.has(skill.id)) return false
      seen.add(skill.id)
      return true
    })
  bus.emit('skills:changed')
}

function renderContext (body) {
  const roster = state.roster

  body.append(h('div', { class: 'pane-title' },
    h('span', { text: '项目上下文' }),
    h('button', {
      class: 'ctx-distill',
      type: 'button',
      title: '让总指挥把这段会话里长期成立的结论沉淀成项目上下文',
      onclick: () => openContextDistill({ scope: 'global' })
    }, '✦ 沉淀')
  ))

  const usage = state.usage
  body.append(h('div', { class: 'usage-card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '本轮用量'),
      h('span', { class: 'tag', text: usage && usage.calls ? `${usage.calls} 次调用` : '尚无调用' })
    ),
    usage && usage.calls
      ? h('div', { class: 'usage-grid' },
        h('div', {}, h('span', { text: '输入' }), h('b', { text: String(usage.input || 0) })),
        h('div', {}, h('span', { text: '输出' }), h('b', { text: String(usage.output || 0) })),
        h('div', {}, h('span', { text: '合计' }), h('b', { text: String(usage.total || 0) })),
        h('div', {}, h('span', { text: '成本' }), h('b', {
          text: usage.priced
            ? `${Number(usage.cost || 0).toFixed(4)} ${usage.currency === 'MIXED' ? '（混合币种）' : usage.currency}`
            : '未配置单价'
        }))
      )
      : h('div', { class: 'hint', text: '发起一轮协作后，这里显示供应商返回的 token 用量；成本需要在 设置 → 模型供应商 填输入/输出单价。' }),
    usage && usage.calls && !usage.reported
      ? h('div', { class: 'hint', text: '供应商没有返回 usage，只记录到调用次数。' })
      : null
  ))

  const global = h('textarea', { class: 'note-area', placeholder: '给本项目全体成员的项目背景、术语表、硬性约束…' })
  global.value = roster.globalNotes || ''
  global.addEventListener('input', debounce(() => {
    roster.globalNotes = global.value
    persist.roster()
  }, 500))
  body.append(global)

  /* 硬性上下文不在这条会话的提示词里，而是超级智能体的常驻块；
     入口放到记忆控制台，避免用户把「项目上下文」和它混成一份。 */
  body.append(h('div', { class: 'ctx-hard-link' },
    h('button', {
      class: 'ctx-distill',
      type: 'button',
      title: '每一轮都会进入超级智能体系统提示词的常驻四块',
      onclick: async () => {
        if (!window.astral.memoryOpenConsole) { toast('当前版本不支持打开记忆控制台'); return }
        const res = await window.astral.memoryOpenConsole({ view: 'hard' })
        if (!res || res.ok === false) toast('打开失败：' + ((res && res.error) || '未知错误'))
      }
    }, '硬性上下文'),
    h('span', { class: 'hint', text: '每轮注入的系统提示词，可在记忆控制台查看和编辑' })
  ))

  /* 标准会话只属于「你 + 当前成员」，把整个编制资料摆在这里既不对也没用：
     其他成员的专属上下文根本不会进这条会话的提示词。只有团队（协作区）才需要全编制切换。 */
  const agents = state.roster.agents
  const mode = currentDockMode()
  /* 非团队会话只有一条线：就是这条会话绑定的那一位（与派单目标一致） */
  const currentAgent = mode === 'team' ? null : soloAgent()

  function memberTitle (text, action = null) {
    return h('div', { class: 'pane-title', style: { marginTop: '16px' } },
      h('span', { text }),
      action
    )
  }

  const distillButton = (agentGetter, hint) => h('button', {
    class: 'ctx-distill',
    type: 'button',
    title: hint,
    onclick: () => openContextDistill({ scope: 'agent', agentId: agentGetter() })
  }, '✦ 沉淀')

  function notesEditor (agent, placeholder) {
    const area = h('textarea', { class: 'note-area', placeholder })
    area.value = (agent.context && agent.context.notes) || ''
    area.addEventListener('input', debounce(() => {
      const target = state.roster.agents.find((a) => a.id === agent.id)
      if (!target) return
      target.context = target.context || { notes: '', historyLimit: 16 }
      target.context.notes = area.value
      persist.roster()
    }, 500))
    return area
  }

  if (mode === 'team') {
    body.append(memberTitle('成员专属上下文', distillButton(() => contextAgentId,
      '让选中的这位成员把自己的长期设定沉淀成专属上下文')))
    if (!agents.length) {
      body.append(h('div', { class: 'dock-empty', text: '编制为空；通用技能仍可预先配置，新增成员后自动生效。' }))
    }

    if (agents.length) {
      if (!agents.some((agent) => agent.id === contextAgentId)) {
        contextAgentId = (state.activeAgentId && agents.some((agent) => agent.id === state.activeAgentId))
          ? state.activeAgentId
          : agents[0].id
      }

      const select = h('select', { class: 'select', style: { marginBottom: '8px' } },
        ...agents.map((a) => h('option', { value: a.id, selected: a.id === contextAgentId },
          `${a.name} · ${a.title || ROLE_LABEL[a.role]}`))
      )

      const area = notesEditor(agents.find((a) => a.id === contextAgentId) || agents[0], '只喂给这个成员的资料…')
      select.addEventListener('change', () => {
        contextAgentId = select.value
        const agent = state.roster.agents.find((a) => a.id === contextAgentId)
        area.value = (agent && agent.context && agent.context.notes) || ''
        paintSkills()
      })

      body.append(select, area)
    }
  } else {
    /* 单独会话与插件制作都是一人一线：只能编辑当前对话对象的资料，没有下拉、也看不到别人 */
    body.append(memberTitle('当前助手专属上下文', distillButton(() => currentAgent && currentAgent.id,
      '让这位助手把自己的长期设定沉淀成专属上下文')))
    if (!currentAgent) {
      body.append(h('div', { class: 'dock-empty', text: '这个会话还没有绑定智能体，先在左栏选一位再写专属资料。' }))
    } else {
      contextAgentId = currentAgent.id
      body.append(
        h('div', { class: 'hint' },
          `这条会话只有你和「${currentAgent.name}」，这里写的内容只进它自己的系统提示词。`),
        notesEditor(currentAgent, `只喂给「${currentAgent.name}」的资料…`)
      )
    }
  }

  /* ------------------------------------------------------------ 上下文注入控制 */
  /* 这里显示的就是这一轮真正会进系统提示词的层，不是另一份说明文案：
     字符数由 promptSections 现算，开关直接落到 settings.context.layers。 */
  const layerAgent = mode === 'team'
    ? (state.roster.agents.find((a) => a.id === contextAgentId) || state.roster.agents[0] || null)
    : currentAgent
  const channel = state.view === 'agent' ? 'agent' : 'user'
  const sections = layerAgent ? promptSections(layerAgent, { channel }) : []
  const byKey = new Map(sections.map((s) => [s.key, s]))
  const layers = state.settings.context && state.settings.context.layers
    ? state.settings.context.layers
    : (state.settings.context.layers = {})
  const layerOn = (key) => layers[key] !== false
  const hardChars = state.hardContext && state.hardContext.total ? state.hardContext.total : 0
  const activeChars = sections
    .filter((s) => s.fixed || layerOn(s.key))
    .reduce((n, s) => n + s.text.length, 0)

  body.append(memberTitle('上下文注入控制', h('span', {
    class: 'hint',
    text: layerAgent ? `当前约 ${activeChars} 字（硬性上下文另计）` : '未绑定智能体'
  })))

  const layerList = h('div', { class: 'layer-list' })
  const rows = [
    ...CONTEXT_LAYERS.map((layer) => ({ ...layer, fixed: false })),
    ...FIXED_CONTEXT_LAYERS.map((layer) => ({ ...layer, fixed: true }))
  ]
  for (const layer of rows) {
    const section = byKey.get(layer.key)
    const chars = layer.key === 'hard' ? hardChars : (section ? section.text.length : 0)
    const on = layer.fixed ? true : layerOn(layer.key)
    const row = h('div', { class: 'layer-row' + (on ? ' on' : '') + (chars ? '' : ' empty') },
      h('div', { class: 'layer-main' },
        h('div', { class: 'layer-name' }, layer.label,
          layer.fixed ? h('span', { class: 'layer-tag', text: '固定' }) : null,
          layer.key === 'hard' ? h('span', { class: 'layer-tag', text: '超级智能体' }) : null),
        h('div', { class: 'layer-hint', text: layer.hint })
      ),
      h('div', { class: 'layer-side' },
        h('span', { class: 'layer-chars', text: chars ? chars + ' 字' : '空' }),
        h('div', {
          class: 'switch' + (on ? ' on' : '') + (layer.fixed || !layerAgent ? ' disabled' : ''),
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': layer.label,
          title: layer.fixed ? '固定层，不可关闭' : (layerAgent ? '点击开关这一层' : '先绑定智能体'),
          onclick: () => {
            if (layer.fixed || !layerAgent) return
            layers[layer.key] = !on
            persist.settings()
            bus.emit('dock:refresh')
          }
        })
      )
    )
    layerList.append(row)
  }
  body.append(layerList)

  body.append(h('div', { class: 'layer-actions' },
    h('button', {
      class: 'ctx-distill',
      type: 'button',
      onclick: () => {
        if (!layerAgent) return
        const text = buildSystemPrompt(layerAgent, { channel })
        openModal({
          title: '这一轮会注入什么',
          sub: `${layerAgent.name} · ${channel === 'user' ? '用户 ↔ AI' : 'AI ↔ AI'} · 关闭的层不会出现在这里`,
          width: 820,
          render: (box) => {
            box.append(
              h('div', { class: 'hint', text: `系统提示词共 ${text.length} 字；硬性上下文只进超级智能体窗口，不计入这段。` }),
              h('pre', { class: 'prompt-preview', text })
            )
          }
        })
      }
    }, '查看完整提示词'),
    h('button', {
      class: 'ctx-distill',
      type: 'button',
      onclick: () => openSettings('run')
    }, '历史与预算')
  ))
  body.append(h('div', {
    class: 'hint',
    text: '关闭只影响这一轮之后的注入，不删除任何内容；权限与工具清单必须和真实授权一致，所以不提供开关。'
  }))

  /* ---------------------------------------------------------------- 技能窗口 */
  const skillWindow = h('div', { class: 'skill-window' })
  const skillStatus = h('span', { class: 'skill-status', text: skillStatusText })
  const uploadButton = h('button', {
    class: 'btn ghost skill-upload',
    type: 'button',
    text: '＋ 上传技能'
  })
  const skillTabs = h('div', { class: 'skill-tabs', role: 'tablist', 'aria-label': '技能作用范围' })
  const agentTabCount = h('small')
  const globalTabCount = h('small')
  const agentTab = h('button', {
    class: 'skill-tab',
    type: 'button',
    role: 'tab',
    onclick: () => { skillScope = 'agent'; paintSkills() }
  }, h('span', { text: '专用技能' }), agentTabCount)
  const globalTab = h('button', {
    class: 'skill-tab',
    type: 'button',
    role: 'tab',
    onclick: () => { skillScope = 'global'; paintSkills() }
  }, h('span', { text: '通用技能' }), globalTabCount)
  skillTabs.append(agentTab, globalTab)
  const skillScopeNote = h('div', { class: 'skill-scope-note' })
  const skillList = h('div', { class: 'skill-list', role: 'list' })

  function selectedAgent () {
    return state.roster.agents.find((agent) => agent.id === contextAgentId) ||
      state.roster.agents[0] || null
  }

  function toggleSkill (skillId) {
    if (skillScope === 'global') {
      const set = new Set(state.roster.globalSkills || [])
      if (set.has(skillId)) set.delete(skillId)
      else set.add(skillId)
      state.roster.globalSkills = [...set]
      persist.roster()
      bus.emit('roster:changed')
      return
    }
    const agent = selectedAgent()
    if (!agent) return
    const set = new Set(agent.skills || [])
    if (set.has(skillId)) set.delete(skillId)
    else set.add(skillId)
    agent.skills = [...set]
    persist.roster()
    bus.emit('roster:changed')
  }

  async function uploadSkill () {
    if (!window.astral.uploadSkill) {
      skillStatusText = '当前版本不支持上传技能文件'
      skillStatus.textContent = skillStatusText
      return
    }
    uploadButton.disabled = true
    skillStatusText = '正在读取技能文件…'
    skillStatus.textContent = skillStatusText
    try {
      const res = await window.astral.uploadSkill()
      if (res && res.canceled) {
        skillStatusText = ''
        skillStatus.textContent = ''
        return
      }
      if (!res || !res.ok) {
        skillStatusText = `上传失败：${(res && res.error) || '未知错误'}`
        skillStatus.textContent = skillStatusText
        return
      }
      skillStatusText = `已上传「${res.name || res.id}」`
      mergeSkillCatalog(res.skills)
    } catch (err) {
      skillStatusText = `上传失败：${(err && err.message) || err}`
      skillStatus.textContent = skillStatusText
    } finally {
      uploadButton.disabled = false
    }
  }

  async function deleteCustomSkill (skill) {
    const ok = await confirmAction({
      title: '删除自定义技能？',
      message: `删除「${skill.name || skill.id}」后，会同时从所有成员和通用技能中移除，且不可撤销。`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    try {
      const res = await window.astral.deleteSkill({ id: skill.id })
      if (!res || !res.ok) {
        skillStatusText = `删除失败：${(res && res.error) || '未知错误'}`
        skillStatus.textContent = skillStatusText
        return
      }
      for (const agent of state.roster.agents) {
        agent.skills = (agent.skills || []).filter((id) => id !== skill.id)
      }
      state.roster.globalSkills = (state.roster.globalSkills || []).filter((id) => id !== skill.id)
      persist.roster()
      skillStatusText = `已删除「${skill.name || skill.id}」`
      mergeSkillCatalog(res.skills)
      bus.emit('roster:changed')
    } catch (err) {
      skillStatusText = `删除失败：${(err && err.message) || err}`
      skillStatus.textContent = skillStatusText
    }
  }

  uploadButton.onclick = uploadSkill

  function paintSkills () {
    const agent = selectedAgent()
    const agentSkills = new Set((agent && agent.skills) || [])
    const globalSkills = new Set(state.roster.globalSkills || [])
    agentTab.classList.toggle('active', skillScope === 'agent')
    globalTab.classList.toggle('active', skillScope === 'global')
    agentTab.setAttribute('aria-selected', String(skillScope === 'agent'))
    globalTab.setAttribute('aria-selected', String(skillScope === 'global'))
    agentTabCount.textContent = String(agentSkills.size)
    globalTabCount.textContent = String(globalSkills.size)

    if (skillScope === 'global') {
      skillScopeNote.textContent = `作用于当前项目全部 ${state.roster.agents.length} 位成员；新增成员也会自动继承。`
    } else if (agent) {
      skillScopeNote.textContent = `只作用于当前选中的「${agent.name}」，不影响其他成员。`
    } else {
      skillScopeNote.textContent = '当前项目还没有成员，专用技能暂不可绑定。'
    }

    skillList.textContent = ''
    if (!state.skills.length) {
      skillList.append(h('div', { class: 'dock-empty' }, '还没有可用技能文件。'))
      return
    }

    for (const skill of state.skills) {
      const active = skillScope === 'global' ? globalSkills.has(skill.id) : agentSkills.has(skill.id)
      const source = skill.builtin ? '内置' : (skill.from ? `插件 · ${skill.from}` : '自定义')
      const row = h('button', {
        class: 'skill-row' + (active ? ' on' : ''),
        type: 'button',
        role: 'listitem',
        'aria-pressed': String(active),
        onclick: () => toggleSkill(skill.id)
      },
      h('span', { class: 'skill-check', text: active ? '✓' : '+' }),
      h('span', { class: 'skill-copy' },
        h('span', { class: 'skill-name', text: skill.name || skill.id }),
        h('span', { class: 'skill-desc', text: skill.desc || skill.id }),
        h('span', { class: 'skill-tags' },
          h('i', { text: source }),
          ...(Array.isArray(skill.tags) ? skill.tags.slice(0, 4).map((tag) => h('i', { text: tag })) : [])
        )
      ),
      h('span', { class: 'skill-state', text: active ? '已启用' : '启用' })
      )
      const canDelete = skill.source === 'config' || (!skill.builtin && !skill.from)
      const item = h('div', { class: 'skill-item' + (canDelete ? '' : ' no-delete') }, row)
      if (canDelete) {
        item.append(h('button', {
          class: 'skill-del',
          type: 'button',
          text: '删',
          title: '删除这个自定义技能文件',
          'aria-label': `删除技能 ${skill.name || skill.id}`,
          onclick: (event) => {
            event.stopPropagation()
            deleteCustomSkill(skill)
          }
        }))
      }
      skillList.append(item)
    }
  }

  skillWindow.append(
    h('div', { class: 'pane-title', style: { marginTop: '16px' }, text: '技能' }),
    h('div', { class: 'hint', text: '技能会被写入对应智能体的系统提示词；这里只改绑定和文件，不改技能正文。' }),
    h('div', { class: 'skill-actions' },
      uploadButton,
      h('span', { class: 'skill-file-hint', text: '支持 .md，front matter 可写 id / name / desc' }),
      skillStatus
    ),
    skillTabs,
    skillScopeNote,
    skillList
  )
  body.append(skillWindow)
  paintSkills()
}

/* ------------------------------------------------------------------ 插件 */

function openPluginSettings (plugin) {
  const config = pluginConfig(plugin)
  const inputs = new Map()
  const body = h('div', { class: 'plugin-settings-form' })

  for (const field of plugin.settings || []) {
    let input
    const value = config[field.key] !== undefined ? config[field.key] : field.default
    if (field.type === 'boolean') {
      input = h('input', { type: 'checkbox', checked: Boolean(value) })
    } else if (field.type === 'select') {
      input = h('select', { class: 'select' },
        ...(field.options || []).map((option) => h('option', { value: option.value, selected: String(value) === option.value }, option.label))
      )
    } else if (field.type === 'number') {
      input = h('input', { class: 'input', type: 'number', value: String(value ?? '') })
    } else {
      input = h('input', { class: 'input', value: String(value ?? '') })
    }
    inputs.set(field.key, { input, field })
    body.append(h('div', { class: 'field' },
      h('label', { class: 'label', text: field.label || field.key }),
      input,
      field.hint ? h('div', { class: 'hint', text: field.hint }) : null
    ))
  }

  const collect = () => {
    const patch = {}
    for (const [key, { input, field }] of inputs) {
      if (field.type === 'boolean') patch[key] = input.checked
      else if (field.type === 'number') patch[key] = Number(input.value)
      else patch[key] = input.value
    }
    return patch
  }

  const save = h('button', {
    class: 'btn primary',
    type: 'button',
    text: '保存并生效',
    onclick: async () => {
      savePluginSettings(plugin, collect())
      const saved = await window.astral.saveConfig('settings.json', state.settings).catch(() => null)
      if (!saved || saved.ok === false) {
        toast('插件配置保存失败', 'err')
        return
      }
      closeModal()
      toast('插件配置已保存并生效', 'ok')
    }
  })
  const reset = h('button', {
    class: 'btn ghost',
    type: 'button',
    text: '恢复默认',
    onclick: () => {
      const defaults = {}
      for (const field of plugin.settings || []) defaults[field.key] = field.default
      savePluginSettings(plugin, defaults)
      window.astral.saveConfig('settings.json', state.settings).catch(() => {})
      closeModal()
      toast('已恢复插件默认配置', 'ok')
    }
  })

  openModal({
    title: `${plugin.name || plugin.id} · 设置`,
    sub: `插件 v${plugin.version || '0.0.0'} · ${plugin.scope === 'user' ? '用户插件' : '内置插件'}`,
    width: 620,
    render: (host) => {
      host.append(
        body,
        h('div', { class: 'hint', style: { marginTop: '10px' }, text: '保存后立即作用于插件；不需要重载界面。' }),
        h('div', { class: 'btn-row', style: { marginTop: '16px', justifyContent: 'flex-end' } }, save, reset,
          h('button', { class: 'btn ghost', type: 'button', onclick: () => closeModal() }, '取消'))
      )
    }
  })
}

function renderPlugins (body) {
  /* 直连会话里这是唯一保留的一页，先说清楚别的页去哪了 */
  if (superChatActive()) {
    body.append(h('div', { class: 'dock-note' },
      '直连会话只保留这一页：任务、上下文、知识库都在项目会话里，回到任意项目就能看到。'))
  }
  if (!state.plugins.length) {
    body.append(h('div', { class: 'dock-empty' },
      h('div', {}, '没有加载任何插件。'),
      h('div', { style: { marginTop: '6px', opacity: '.75' } }, '把插件目录放进 config/plugins/ 或 app/plugins/，每个目录含 plugin.json 与入口 JS。')
    ))
  } else {
    for (const plugin of state.plugins) {
      const on = pluginEnabled(plugin)
      const legacy = isLegacyRuntime(plugin)
      const status = legacy ? '运行时已限制' : plugin.error ? '加载失败' : (on ? (plugin.loaded ? '已启用' : '启用中') : '已关闭')
      const hasSchema = !legacy && on && plugin.loaded && Array.isArray(plugin.settings) && plugin.settings.length > 0
      const meta = [
        `v${plugin.version || '0.0.0'}`,
        plugin.scope === 'user' ? '用户' : '内置',
        legacy ? '旧版 · 已限制' : '隔离沙箱',
        status,
        plugin.legacyPermissions ? '旧版权限' : ''
      ].filter(Boolean).join(' · ')
      const text = legacy
        ? (plugin.error || '旧版插件运行时已限制。改用 runtime: "isolated" 后，外部插件不受限制。')
        : plugin.error || plugin.description || ''
      body.append(h('div', { class: 'task-item plugin-item', dataset: { state: legacy || plugin.error ? 'error' : (on ? 'done' : 'idle'), runtime: legacy ? 'legacy' : 'isolated' } },
        h('div', { class: 't-mark' }),
        h('div', { class: 't-body' },
          h('div', { class: 't-who' },
            h('span', { text: plugin.name || plugin.id }),
            h('small', { text: meta })
          ),
          h('div', { class: 't-text', text })
        ),
        h('div', { class: 'plugin-actions' },
          hasSchema
            ? h('button', { class: 'btn ghost plugin-settings-btn', type: 'button', onclick: () => openPluginSettings(plugin) }, '设置')
            : null,
          legacy
            ? h('div', { class: 'switch disabled', role: 'switch', 'aria-disabled': 'true', 'aria-checked': 'false', title: '旧版插件运行时已限制' })
            : h('div', {
              class: 'switch' + (on ? ' on' : ''),
              role: 'switch',
              'aria-checked': on,
              title: on ? '关闭插件' : '启用插件',
              onclick: async () => {
                const result = await setPluginEnabledLive(plugin, !on)
                if (!result || result.ok === false) {
                  toast(`插件${on ? '关闭' : '启用'}失败：${(result && result.error) || '未知错误'}`, 'err')
                  return
                }
                toast(`${plugin.name || plugin.id} 已${on ? '关闭' : '启用'}`, 'ok')
              }
            })
        )
      ))
    }
  }

  body.append(h('div', { class: 'hint', text: '插件开关会立即加载或卸载插件；关闭后其面板、钩子和注册项会一并移除，无需重载界面。' }))

  const legacyPlugins = state.plugins.filter(isLegacyRuntime)
  if (legacyPlugins.length) {
    body.append(h('div', { class: 'plugin-legacy-note' },
      h('strong', { text: '只限制旧版运行时，不限制外部插件' }),
      h('div', { class: 'hint', text: '旧版渲染层插件没有沙箱，已停止执行。外部插件不受来源限制：放进 config/plugins，manifest 写 "runtime": "isolated"，重载窗口即可正常加载。' })
    ))
  }

  body.append(h('div', { class: 'btn-row', style: { marginTop: '14px' } },
    h('button', { class: 'btn ghost', onclick: () => bus.emit('newconversation:open', { mode: 'plugin' }) }, '制作插件'),
    h('button', { class: 'btn ghost', onclick: () => bus.emit('plugin:open-guide') }, '插件开发文档'),
    h('button', { class: 'btn ghost', onclick: () => window.astral.openDir('config') }, '打开 config 目录'),
    h('button', { class: 'btn ghost', onclick: () => openSettings('bridge') }, '外部接口')
  ))

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '可用钩子' }))
  body.append(h('div', { class: 'dock-empty' },
    h('div', { text: 'before:request — 修改发给模型的 messages' }),
    h('div', { text: 'after:reply — 改写成员回复' }),
    h('div', { text: 'on:message — 监听每条消息' })
  ))
}
