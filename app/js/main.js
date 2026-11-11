/* main.js — 启动装配 */

import { state, $, bus, h, toast, agentById, commander, messagesOf, activeProject, normalizeConversationMode, conversationIsTeam, soloAgent, superChatActive, syncMemoryProjectsNow } from './core.js'
import { applyTheme, currentTheme, bootTheme } from './effects.js'
import { mountStream, mountComposer } from './chat.js'
import { mountRoster, openMemberProfile, openConversationProfile } from './roster.js'
import { initProjects, mountProjectTree, currentWorkMode, switchProject } from './projects.js'
import { mountDock } from './dock.js'
import { mountQuickSwitch } from './quickswitch.js'
import { mountMessageRail } from './msgrail.js'
import { mountContextMeter } from './contextmeter.js'
import { mountPluginGuide } from './plugin-mode.js'
import { mountMessageTextColor } from './textcolor.js'
import { mountLayout, resetLayout } from './layout.js'
import { mountWindowTransition } from './wintransition.js'
import { mountBridge } from './bridge.js'
import { mountTriggers, emitEvent, approveEvent, ignoreEvent, listEvents, config as triggerConfig } from './triggers.js'
import { loadPlugins } from './plugins.js'
import { maybeAskKnowledgePlugin } from './knowledge-onboarding.js'
import { openSettings } from './settings.js'
import { openNewConversationDialog } from './newconversation.js'
import { openRenewDialog } from './renew.js'
import { clearSession, submit } from './orchestrator.js'
import { ROLE_LABEL } from './llm.js'
import { mountViewSwitch, currentView, setView } from './viewswitch.js'
import { setSplashStatus, dismissSplash, failSplash, shownAt } from './splash.js'
import { mountSfx, startSplashScore, play, playStartup, renderOffline, config as sfxConfig, setConfig as setSfxConfig, debug as sfxDebug } from './sfx.js'
import { refreshMcp } from './mcp.js'
import { mountRunRecovery } from './runrecovery.js'
import { loadJobs, maybeResumeJobs, startJobScheduler } from './jobs.js'
import { mountSearch } from './search.js'
import { initI18n, i18n } from './i18n.js'
import { autoCheckUpdate } from './updater.js'
import { roleInfo, isGuest } from './roles.js'
import { toggleSuperChat, leaveSuperChat, superProfile, superModelLabel, openSuperProfile } from './superagent.js'

let status = '待命中'

function paintRole () {
  const badge = $('#role-badge')
  if (!badge) return
  const role = roleInfo()
  badge.textContent = role.label
  badge.title = `${role.label} · ${role.desc}（点击查看边界）`
  badge.classList.toggle('role-member', role.id === 'member')
  badge.classList.toggle('role-guest', role.id === 'guest')
  const memoryBtn = $('#btn-memory')
  if (memoryBtn) {
    memoryBtn.disabled = isGuest()
    memoryBtn.title = isGuest()
      ? '游客不能打开记忆控制台'
      : '打开记忆库控制台（项目 · 事件 · 派发记录）'
  }
}

function paintSuper () {
  const el = $('#rail-super-name')
  if (!el) return
  const profile = superProfile()
  el.textContent = profile.name
  const btn = $('#btn-super')
  if (btn) {
    btn.title = `和「${profile.name}」说话（直连，不经过派单）`
    btn.classList.toggle('active', superChatActive())
    btn.setAttribute('aria-current', superChatActive() ? 'true' : 'false')
    const mark = btn.querySelector('.rail-super-mark')
    if (mark) {
      mark.textContent = ''
      if (profile.avatar) mark.append(h('img', { src: profile.avatar, alt: '' }))
      else mark.textContent = '✦'
    }
  }
  /* 直连只有一条线：顶栏的「用户 ↔ AI / AI ↔ AI」在这里没有意义 */
  document.body.classList.toggle('super-chat-mode', superChatActive())
}

function updateChannel () {
  const project = activeProject()
  const selected = state.activeAgentId ? agentById(state.activeAgentId) : null
  const boss = commander()
  const hasCommander = state.roster.agents.some((a) => a.role === 'commander' && a.enabled !== false)
  const nameEl = $('#channel-name')
  const subEl = $('#channel-sub')
  if (!nameEl || !subEl) return

  /* 直连会话：标题就是它的名字，右边给「资料」而不是「成员资料」 */
  if (superChatActive()) {
    const profile = superProfile()
    nameEl.textContent = profile.name
    subEl.textContent = [
      status,
      '直连会话 · 不经过派单',
      superModelLabel(),
      '上下文与项目会话隔离'
    ].join(' · ')
    const editBtn = $('#channel-edit')
    if (editBtn) {
      editBtn.hidden = false
      editBtn.textContent = '资料'
      editBtn.title = '编辑它的头像、名字、简称与模型'
      editBtn.onclick = () => openSuperProfile()
      editBtn.style.setProperty('--agent-color', profile.color)
    }
    return
  }

  if (currentView() === 'agent') {
    /* 协作区的标题要说明这是另一条线，避免和上面的对话混淆 */
    const count = messagesOf('agent').length
    nameEl.textContent = `${project ? project.name + ' · ' : ''}AI ↔ AI`
    subEl.textContent = [
      status,
      `${count} 条往来记录`,
      '只读 · 与「用户 ↔ AI」上下文隔离'
    ].filter(Boolean).join(' · ')
    const editBtn = $('#channel-edit')
    if (editBtn) editBtn.hidden = true
    return
  }

  const conversation = String(state.conversationTitle || '').trim()
  const teamMode = conversationIsTeam()
  /* 单独/插件会话里没有「成员」可选：没点选时就是当前绑定的那一位，
     否则顶栏会既看不到名字、也拿不到编辑入口。 */
  const target = selected || (teamMode ? null : soloAgent())
  nameEl.textContent = conversation || (target
    ? `与 ${target.name} 的会话`
    : (project ? `${project.name} · 协作频道` : '协作频道'))

  const theme = currentTheme()
  const parts = [status]
  if (project) parts.push(`项目 ${project.name}`)
  /* 标题已经占用了对话名，这里补上成员，避免只剩一个名字看不出在和谁说话 */
  if (conversation && target) parts.push(`与 ${target.name} 的会话`)
  if (target) {
    /* 单独会话没有职位：只说明用哪个模型，不写职级与头衔 */
    parts.push(teamMode
      ? `${target.title || ROLE_LABEL[target.role]} · ${target.model || '未绑定模型'}`
      : (target.model || '未绑定模型'))
    if (!teamMode) parts.push(state.conversationMode === 'plugin' ? '插件制作 · 上下文独立' : '标准会话 · 上下文独立')
  } else {
    parts.push(`编制 ${state.roster.agents.length} 人`)
    if (hasCommander && boss) parts.push(`总指挥 ${boss.name}`)
    else parts.push('无总指挥')
  }
  if (theme) parts.push(theme.name)
  subEl.textContent = parts.join(' · ')

  const editBtn = $('#channel-edit')
  if (editBtn) {
    editBtn.hidden = !target
    /* 两种会话都有编辑，只是可编辑项不同：团队编的是成员，单独编的是会话本身 */
    editBtn.textContent = teamMode ? '成员资料' : '编辑会话'
    editBtn.title = teamMode ? '查看并编辑这个成员的资料' : '编辑会话名称与这位助手的提示词'
    editBtn.onclick = target
      ? () => (teamMode ? openMemberProfile(target.id) : openConversationProfile())
      : null
    editBtn.style.setProperty('--agent-color', (target && target.color) || 'var(--accent)')
  }
}

function updateBridgeBadge () {
  const badge = $('#bridge-badge')
  if (!badge) return
  const on = Boolean(state.bridge && state.bridge.port)
  const label = badge.querySelector('.bridge-label')
  badge.classList.toggle('on', on)
  if (label) label.textContent = 'MCP'
  badge.title = on
    ? `MCP 桥已监听 127.0.0.1:${state.bridge.port} · 光效强度跟随思考强度`
    : 'MCP 桥未启动'
}

function cycleTheme () {
  if (!state.themes.length) return
  const idx = state.themes.findIndex((t) => t.id === (state.settings.theme || 'astral'))
  const next = state.themes[(idx + 1) % state.themes.length]
  state.settings.theme = next.id
  applyTheme(next, state.settings)
  window.astral.saveConfig('settings.json', state.settings)
  toast(`主题 · ${next.name}`)
  updateChannel()
}

function wireWindowControls () {
  const maxBtn = $('#win-max')
  const minBtn = $('#win-min')
  const closeBtn = $('#win-close')
  if (!maxBtn || !window.astral.winToggleMaximize) return

  minBtn.addEventListener('click', () => window.astral.winMinimize())
  maxBtn.addEventListener('click', () => window.astral.winToggleMaximize())
  closeBtn.addEventListener('click', () => window.astral.winClose())

  window.astral.onMaximizeChange((max) => {
    maxBtn.textContent = max ? '❐' : '□'
    maxBtn.title = max ? '还原' : '最大化'
    document.body.classList.toggle('maximized', max)
  })

  const topbar = document.querySelector('.topbar')
  if (topbar) {
    topbar.addEventListener('dblclick', (e) => {
      if (!e.target.closest('button')) window.astral.winToggleMaximize()
    })
  }
}

function wireChrome () {
  $('#btn-settings').addEventListener('click', () => openSettings('providers'))
  $('#btn-theme').addEventListener('click', cycleTheme)
  const roleBtn = $('#role-badge')
  if (roleBtn) roleBtn.addEventListener('click', () => openSettings('profile'))
  const superBtn = $('#btn-super')
  if (superBtn) superBtn.addEventListener('click', () => toggleSuperChat())
  /* 占位提示由 chat.js 的 syncComposer 统一处理，这里只重画身份徽标 */
  bus.on('role:changed', () => paintRole())
  bus.on('super:changed', () => {
    paintSuper()
    updateChannel()
  })
  const memoryBtn = $('#btn-memory')
  if (memoryBtn) {
    memoryBtn.addEventListener('click', async () => {
      const res = await window.astral.memoryOpenConsole()
      if (!res || res.ok === false) toast('记忆库打不开：' + ((res && res.error) || '未知原因'))
    })
  }
  $('#btn-dock').addEventListener('click', () => {
    document.body.classList.toggle('dock-collapsed')
    window.dispatchEvent(new Event('resize'))
  })
  $('#bridge-badge').addEventListener('click', () => openSettings('bridge'))
  $('#btn-clear').addEventListener('click', () => {
    leaveSuperChat()
    openNewConversationDialog()
  })
  bus.on('newconversation:open', (options) => {
    leaveSuperChat()
    openNewConversationDialog(options || {})
  })

  const renewBtn = $('#btn-renew')
  if (renewBtn) {
    renewBtn.addEventListener('click', () => {
      leaveSuperChat()
      openRenewDialog()
    })
    const paintRenew = (busy = state.busy) => {
      renewBtn.disabled = Boolean(busy)
      renewBtn.title = busy
        ? '协作进行中，等这一轮结束后再革新'
        : '把当前会话总结成交接摘要，清空上下文并开启新会话'
    }
    bus.on('busy', paintRenew)
    paintRenew()
  }

  const modeBtn = $('#btn-mode')
  const paintMode = () => {
    if (!modeBtn) return
    const mode = normalizeConversationMode(state.conversationMode, currentWorkMode())
    const enabled = ((activeProject() && activeProject().roster && activeProject().roster.agents) || [])
      .filter((agent) => agent.enabled !== false).length
    modeBtn.textContent = mode === 'team' ? `团队 · ${enabled}` : mode === 'plugin' ? '插件制作' : '单独会话'
    modeBtn.classList.toggle('mode-solo', mode !== 'team')
    modeBtn.title = mode === 'team'
      ? '团队会话：按编制分工与派单。点击切换到同工作目录的单独会话，或新建一个'
      : mode === 'plugin'
        ? '插件制作会话：使用插件提示词。点击切换到同工作目录的团队会话'
        : '单独会话：你与当前成员直接对话。点击切换到同工作目录的团队会话，或新建一个'
  }
  if (modeBtn) {
    modeBtn.addEventListener('click', async () => {
      if (state.busy) { toast('协作进行中，暂时不能切换会话模式', 'err'); return }
      const current = normalizeConversationMode(state.conversationMode, currentWorkMode())
      const target = current === 'team' ? 'solo' : 'team'
      const project = activeProject()
      const rootPath = (project && project.rootPath) || ''
      const candidate = [...state.projects]
        .filter((item) => !item.archivedAt && item.id !== (project && project.id) &&
          normalizeConversationMode(item.conversationMode, item.workMode === 'team' ? 'team' : 'solo') === target &&
          String(item.rootPath || '') === rootPath)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
      if (candidate) {
        const ok = await switchProject(candidate.id)
        if (!ok) toast('切换会话失败', 'err')
        return
      }
      /* 没有同目录的同类会话：打开新会话，绝不覆盖当前会话。 */
      openNewConversationDialog({ mode: target, workDir: rootPath })
    })
    bus.on('project:changed', paintMode)
    bus.on('project:mode', paintMode)
    bus.on('roster:changed', paintMode)
    bus.on('conversation:mode', paintMode)
    paintMode()
  }

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key === ',') { e.preventDefault(); openSettings('providers') }
    if (mod && e.key === 'k') { e.preventDefault(); $('#input').focus() }
  })

  bus.on('status', (text) => { status = text; updateChannel() })
  bus.on('active:agent', updateChannel)
  bus.on('conversation:title', updateChannel)
  /* 切模式后顶栏要跟着换文案：团队是「成员资料」，单独是「编辑会话」 */
  bus.on('conversation:mode', updateChannel)
  bus.on('project:changed', updateChannel)
  bus.on('projects:changed', updateChannel)
  bus.on('roster:changed', updateChannel)
  bus.on('view:changed', updateChannel)
  bus.on('busy', (busy) => { status = busy ? '协作进行中' : '待命中'; updateChannel() })
}

function injectCustomCss () {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = 'astral://user/custom.css'
  link.onerror = () => link.remove()
  document.head.append(link)
}

async function refreshHardContext () {
  if (!window.astral.memoryPrompt) { state.hardContext = null; return }
  try {
    const res = await window.astral.memoryPrompt()
    state.hardContext = res && res.ok ? res : null
  } catch {
    state.hardContext = null
  }
  bus.emit('context:hard', state.hardContext)
}

/* ---------------------------------------------------------- 时间提醒
   时间网给出「这个点通常在做什么」后，只在样本足够时轻轻提一句；
   接受只是把任务写好放进输入框，不会自动替用户发出去。 */

function localDayKey (date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate())
}

function timeNudgeDismissed () {
  try { return localStorage.getItem('astral.timeNudge.dismissed') === localDayKey() } catch { return false }
}

async function maybeTimeNudge () {
  if (!window.astral || typeof window.astral.memoryTime !== 'function') return
  if (timeNudgeDismissed()) return
  /* 近期观察最具体（例如「今天想吃火锅」到饭点），优先于阶段与时段；
     其次问阶段，最后才退回纯时段习惯。 */
  let data = null
  let fromPhase = false
  let suggestion = null
  try {
    const res = await window.astral.memoryTime({ action: 'suggest' })
    suggestion = res && res.data ? res.data : res
  } catch { /* 时间网不可用时仍可走阶段 */ }
  if (suggestion && suggestion.found && suggestion.via === 'observation') {
    data = suggestion
  } else {
    try {
      const current = activeProject()
      const res = await window.astral.memoryTime({
        action: 'phase',
        project: current ? current.name : ''
      })
      const phase = res && res.data ? res.data : res
      if (phase && phase.found) { data = phase; fromPhase = true }
    } catch { /* 阶段层不可用时仍可走时段提醒 */ }
    if (!data && suggestion && suggestion.found) data = suggestion
  }
  if (!data || !data.found) return
  const strip = $('#time-nudge')
  if (!strip) return
  const fromObservation = data.via === 'observation'
  const top = fromPhase && data.intents && data.intents[0]
  $('#time-nudge-title').textContent = fromPhase ? data.ask : data.text
  $('#time-nudge-sub').textContent = fromObservation
    ? '来自你最近的打算 · 只询问，不会自动下单或发送'
    : fromPhase
      ? `阶段「${data.phase}」· 这个阶段 ${top.percent}% 是「${top.intent}」类指令（${top.drift}）` +
        (data.arrival ? ` · ${data.arrival.text}` : (data.transition ? ` · ${data.transition.text}` : ''))
      : `连续 ${data.weeks || 0} 周的同一时段 · 时段占比 ${data.sharePercent || 0}% · 最近：${data.lastSummary || '还没有记录'}`
  strip.dataset.prompt = data.prompt || ''
  strip.hidden = false
}

function mountTimeNudge () {
  const strip = $('#time-nudge')
  if (!strip) return
  $('#time-nudge-off').addEventListener('click', () => {
    strip.hidden = true
    try { localStorage.setItem('astral.timeNudge.dismissed', localDayKey()) } catch { /* 隐私模式 */ }
    toast('今天不再提醒', '')
  })
  $('#time-nudge-go').addEventListener('click', () => {
    const input = $('#input')
    const text = strip.dataset.prompt || ''
    strip.hidden = true
    if (!input || !text) return
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
    toast('已写进输入框，确认后发送', 'ok')
  })
}

async function boot () {
  setSplashStatus('连接星核…')
    const data = await window.astral.boot()

  state.settings = data.settings || {}
  paintRole()
  paintSuper()
  initI18n(data.locales || [], state.settings.language || 'zh-CN')
  /* 配置就绪后才启动音效：用户关掉音效时本次启动就不会响；
     组曲按 shownAt 对齐 CSS 动画，已错过的节拍自动跳过 */
  mountSfx()
  startSplashScore(shownAt)
  state.providers = data.providers || { providers: [] }
  state.roster = data.roster || { agents: [], globalSkills: [], globalNotes: '' }
  state.themes = data.themes || []
  state.skills = data.skills || []
  state.plugins = data.plugins || []
  state.bridge = data.bridge || {}
  state.dirs = data.dirs || {}
  state.version = data.version || '0.0.0'
  state.bridge.running = Boolean(state.bridge.port)

  /* 硬性上下文只在主进程里，启动时取一次；用户改完保存后焦点回到窗口会再刷新。
     取不到不影响聊天，只是提示词里没有这一层。 */
  await refreshHardContext()

  setSplashStatus('唤醒会话…')
    await initProjects(data)

  /* 项目列表是权重网的节点来源：启动时镜像一次，之后随保存自动同步 */
  syncMemoryProjectsNow()

  setSplashStatus('点亮星野…')
  /* bootTheme 而非 currentTheme：插件主题此刻还没注册，用启动快照接上，
     否则会回退成默认主题，启动动画演到一半突然换色 */
  applyTheme(bootTheme(), state.settings)
  injectCustomCss()
  mountMessageTextColor()

  setSplashStatus('装配星阵…')
  mountRoster()
  mountProjectTree()
  mountViewSwitch()
  mountSearch()
  mountStream()
  mountComposer()
  mountContextMeter()
  mountPluginGuide()
  mountDock()
  mountQuickSwitch()
  mountMessageRail()
  mountLayout()
  mountBridge()
  mountTriggers()
  wireChrome()
  wireWindowControls()
  mountWindowTransition()

  /* 记忆控制台在另一个窗口里改硬性上下文，主窗口拿不到保存事件：
     回到窗口时重新取一次，避免继续用旧的常驻文本。 */
  let hardRefreshAt = 0
  window.addEventListener('focus', () => {
    const now = Date.now()
    if (now - hardRefreshAt < 4000) return
    hardRefreshAt = now
    refreshHardContext().catch(() => {})
  })

    await dismissSplash()
    await maybeAskKnowledgePlugin()
    await loadPlugins()
    await loadJobs()

    /* 主题由插件提供时，插件可能被禁用或删掉：不能一直停在启动快照的配色上，
       这里回退到现有主题。settings.theme 保留原值，插件恢复后仍会回到那套主题。 */
    if (!state.themes.some((t) => t.id === (state.settings.theme || 'astral'))) {
      applyTheme(currentTheme(), state.settings)
    }

  /* 右侧面板的首个默认页由 dock.js 按当前会话模式决定：
     团队会话 → 任务轨迹；单独/插件会话 → 上下文。 */

  /* 工具目录随后台加载：boot 时统一重连一次，不阻塞界面 */
  refreshMcp(true).catch((err) => console.error('[mcp]', err))

  updateBridgeBadge()
  updateChannel()

  window.Astral = {
    version: state.version,
    state,
    bus,
    submit,
    clearSession,
    openSettings,
    applyTheme,
    triggers: { emitEvent, approveEvent, ignoreEvent, listEvents, config: triggerConfig },
    sfx: { play, playStartup, renderOffline, config: sfxConfig, setConfig: setSfxConfig, debug: sfxDebug },
    i18n,
    resetLayout,
    setView
  }

  mountRunRecovery().catch((err) => console.error('[run recovery]', err))
  startJobScheduler()
  mountTimeNudge()
  setTimeout(() => maybeTimeNudge().catch(() => {}), 2200)
  setTimeout(() => maybeResumeJobs().catch((err) => console.error('[jobs]', err)), 300)
  /* 更新检查放到启动动画与首屏之后：先让界面可用，再去问 GitHub */
  setTimeout(() => autoCheckUpdate().catch((err) => console.error('[update]', err)), 4000)
  setTimeout(() => $('#input').focus(), 120)
}

boot().catch((err) => {
  console.error(err)
  failSplash(err)
  const stream = $('#stream')
  if (stream) {
    stream.textContent = ''
    stream.append(h('div', { class: 'stream-empty' },
      h('div', { class: 'glyph' }, '⚠'),
      h('h2', {}, '启动失败'),
      h('p', { text: err.message || String(err) })
    ))
  }
})

