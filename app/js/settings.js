/* settings.js — 设置面板 */

import { state, bus, h, persist, toast, debounce, pickAvatar, uid, activeProject } from './core.js'
import { openModal, field } from './modal.js'
import { confirmAction } from './confirm.js'
import { ROLES, roleId, roleInfo, roleMatrix } from './roles.js'
import { addAgent } from './roster.js'
import { renderTeamTemplates } from './team-templates.js'
import { openTeamFromDocument } from './team-builder.js'
import { testProvider } from './llm.js'
import { applyTheme, effectiveArt, currentTheme } from './effects.js'
import { applyUiScale } from './layout.js'
import { TRANSITIONS, playWindowEnter } from './wintransition.js'
import { renderTextColorSettings } from './textcolor-ui.js'
import {
  PERMS, PERM_KEYS, globalPerms, setGlobalPerm, agentDefaultPerms, setAgentDefaultPerm,
  isFullAuth, hasAgentDefaults, ownPermsBase, applyDefaultsToAll, clearAllAgentPerms, setAllAgentPerm, clearAgentPerms
} from './permissions.js'
import { dataFilesSection } from './datafiles.js'
import { speechSettings } from './speech.js'
import {
  speechModels, selectedSpeechModel, setSelectedSpeechModel,
  addSpeechModelFromDialog, removeSpeechModel, openSpeechModelPage,
  inspectSelectedSpeechModel
} from './speech-models.js'
import { mcpSettingsSection } from './mcp.js'
import {
  config as triggerConfig, listEvents, setMode, saveConfig, emitEvent,
  approveEvent, ignoreEvent, clearEvents, queueLength
} from './triggers.js'
import { MODES, MAX_EVENTS } from './triggers-core.js'
import { play as sfxPlay, config as sfxConfig, setConfig as setSfxConfig } from './sfx.js'
import { availableLocales, currentLocale, setLocale, t } from './i18n.js'
import { updateCard } from './updater.js'
import { renderIntake } from './intake.js'
import { renderSecurity } from './security.js'

export function openSettings (tab = 'providers') {
  const allTabs = [
    { id: 'profile', label: '个人资料' },
    { id: 'providers', label: '模型供应商' },
    { id: 'roster', label: '编制' },
    { id: 'templates', label: '团队模板' },
    { id: 'permissions', label: '权限与数据' },
    { id: 'intake', label: '消息接入' },
    { id: 'security', label: '安全边界' },
    { id: 'mcp', label: '工具（MCP）' },
    { id: 'appearance', label: '外观' },
    { id: 'run', label: '运行' },
    { id: 'bridge', label: '外部接口' },
    { id: 'about', label: '关于' }
  ]
  /* 非管理员只看得到资料、外观与关于：配置入口在渲染层就不出现，
     主进程还会对保存动作再拒一次。 */
  const tabs = roleId() === 'admin'
    ? allTabs
    : allTabs.filter((item) => ['profile', 'appearance', 'about'].includes(item.id))
  const initial = tabs.some((item) => item.id === tab) ? tab : 'profile'

  openModal({
    title: '设置',
    sub: 'ASTRAL REALM · CONFIG',
    width: 820,
    tab: initial,
    tabs,
    render: (body, id) => {
      if (id === 'profile') renderProfile(body)
      else if (id === 'providers') renderProviders(body)
      else if (id === 'roster') renderRosterConfig(body)
      else if (id === 'templates') renderTeamTemplates(body, { onGenerate: () => openTeamFromDocument({ onSaved: () => openSettings('templates') }) })
      else if (id === 'permissions') renderPermissions(body)
      else if (id === 'intake') renderIntake(body)
      else if (id === 'security') renderSecurity(body)
      else if (id === 'mcp') renderMcpTools(body)
      else if (id === 'appearance') renderAppearance(body)
      else if (id === 'run') renderRun(body)
      else if (id === 'bridge') renderBridge(body)
      else renderAbout(body)
    }
  })
  if (initial && initial !== 'providers') {
    const btn = document.querySelector(`.modal-tabs button[data-tab="${initial}"]`)
    if (btn) btn.click()
  }
}

/* --------------------------------------------------------- profile */

function askPin ({ title, sub }) {
  return new Promise((resolve) => {
    let value = ''
    openModal({
      title,
      sub,
      width: 440,
      onClose: () => resolve(null),
      render: (box) => {
        const input = h('input', {
          class: 'input',
          type: 'password',
          placeholder: '管理员口令',
          oninput: (e) => { value = e.target.value },
          onkeydown: (e) => { if (e.key === 'Enter') submit() }
        })
        const submit = () => {
          if (value.length < 4) { toast('口令至少 4 位', 'err'); return }
          closeModal()
          resolve(value)
        }
        box.append(
          field('口令', input, '只保存 SHA-256 哈希，不保存明文'),
          h('div', { class: 'btn-row', style: { marginTop: '12px' } },
            h('button', { class: 'btn primary', onclick: submit }, '确认'),
            h('button', { class: 'btn ghost', onclick: () => { closeModal(); resolve(null) } }, '取消')
          )
        )
        setTimeout(() => input.focus(), 60)
      }
    })
  })
}

async function switchRole (target) {
  const profile = state.settings.profile || (state.settings.profile = {})
  const current = roleId()
  if (target === current) return

  /* 降级前必须先有口令，否则切回来时没有任何凭据 */
  if (target !== 'admin' && !profile.hasPin) {
    toast('请先设置管理员口令：否则降级后本机无法切回管理员', 'err')
    return
  }

  let pin = ''
  if (target === 'admin') {
    if (!profile.hasPin) {
      toast('没有管理员口令：无法从成员/游客提升为管理员', 'err')
      return
    }
    const entered = await askPin({
      title: '切回管理员',
      sub: '成员/游客可以浏览，但不能改设置或写记忆。回到管理员需要口令。'
    })
    if (entered === null) return
    pin = entered
  } else {
    const ok = await confirmAction({
      title: `切换为${roleInfo(target).label}？`,
      message: `${roleInfo(target).desc}\n\n当前窗口会立即按新身份收窄按钮与输入框；切回管理员需要口令。`,
      confirmText: '切换'
    })
    if (!ok) return
  }

  const res = await window.astral.roleSwitch({ role: target, pin })
  if (!res || !res.ok) {
    toast('切换失败：' + ((res && res.error) || '未知错误'), 'err')
    return
  }
  profile.role = res.role
  bus.emit('role:changed')
  toast(`已切换为${roleInfo(res.role).label}`)
  openSettings('profile')
}

function roleSection () {
  const profile = state.settings.profile || (state.settings.profile = {})
  const current = roleId()
  const cards = ROLES.map((role) => h('button', {
    class: 'role-card' + (role.id === current ? ' on' : ''),
    type: 'button',
    onclick: () => switchRole(role.id)
  },
  h('div', { class: 'role-card-head' },
    h('strong', { text: role.label }),
    h('span', { class: 'role-card-rank', text: role.id === 'admin' ? '最高' : role.id === 'member' ? '中' : '只读' })
  ),
  h('p', { text: role.desc })
  ))

  const rows = roleMatrix().map((row) => h('div', { class: 'role-matrix-row' },
    h('span', { class: 'role-matrix-name', text: row.label }),
    h('span', { class: row.admin ? 'yes' : 'no', text: row.admin ? '✓' : '—' }),
    h('span', { class: row.member ? 'yes' : 'no', text: row.member ? '✓' : '—' }),
    h('span', { class: row.guest ? 'yes' : 'no', text: row.guest ? '✓' : '—' })
  ))

  return h('div', { class: 'role-section' },
    h('div', { class: 'label-main', style: { marginTop: '20px' }, text: '本机身份' }),
    h('div', { class: 'hint', text: '身份决定界面按钮与主进程 IPC 的放行范围。它是本机边界，不是登录认证：能改 settings.json 的人仍然能改角色。' }),
    h('div', { class: 'role-cards' }, ...cards),
    h('div', { class: 'role-matrix' },
      h('div', { class: 'role-matrix-row head' },
        h('span', { class: 'role-matrix-name', text: '能力' }),
        h('span', { text: '管理员' }),
        h('span', { text: '成员' }),
        h('span', { text: '游客' })
      ),
      ...rows
    ),
    h('div', { class: 'role-pin-row' },
      h('button', {
        class: 'btn ghost',
        onclick: async () => {
          const pin = await askPin({
            title: profile.hasPin ? '修改管理员口令' : '设置管理员口令',
            sub: '降级前必须先设置；切回管理员时要用它。'
          })
          if (pin === null) return
          const res = await window.astral.roleSetPin({ pin })
          if (!res || !res.ok) { toast('设置失败：' + ((res && res.error) || '未知错误'), 'err'); return }
          profile.hasPin = true
          toast('管理员口令已保存')
          openSettings('profile')
        }
      }, profile.hasPin ? '修改口令' : '设置口令'),
      profile.hasPin
        ? h('button', {
          class: 'btn ghost',
          onclick: async () => {
            const ok = await confirmAction({
              title: '清除管理员口令？',
              message: '清除后，从成员或游客身份将无法自助切回管理员；只能手动改 settings.json。',
              confirmText: '清除',
              danger: true
            })
            if (!ok) return
            const res = await window.astral.roleSetPin({ pin: '' })
            if (!res || !res.ok) { toast('清除失败', 'err'); return }
            profile.hasPin = false
            toast('已清除管理员口令')
            openSettings('profile')
          }
        }, '清除口令')
        : h('span', { class: 'hint', text: '尚未设置：当前不能在成员/游客之间切换' })
    )
  )
}

function renderProfile (body) {
  const profile = state.settings.profile || (state.settings.profile = { name: '', short: '', avatar: '', likes: '' })
  const save = debounce(() => persist.settings(), 300)

  const preview = h('span', { class: 'ava', style: { width: '64px', height: '64px', fontSize: '24px' } })
  const paint = () => {
    preview.textContent = ''
    if (profile.avatar) preview.append(h('img', { src: profile.avatar, alt: '' }))
    else preview.textContent = (profile.name || '我').slice(0, 1)
  }
  paint()

  const nameInput = h('input', {
    class: 'input',
    value: profile.name || '',
    placeholder: '你的名字',
    oninput: (e) => { profile.name = e.target.value; paint(); save() }
  })

  const shortInput = h('input', {
    class: 'input',
    maxlength: '6',
    value: profile.short || '',
    placeholder: '消息里显示的简称',
    oninput: (e) => { profile.short = e.target.value; save() }
  })

  const likesArea = h('textarea', {
    class: 'textarea',
    placeholder: '例如：喜欢先看结论再展开；讨厌客套话；正在做一个 Stardew Valley 模组',
    oninput: (e) => { profile.likes = e.target.value; save() }
  })
  likesArea.value = profile.likes || ''

  body.append(
    h('div', { class: 'avatar-row' },
      preview,
      h('div', { class: 'avatar-actions' },
        h('div', { class: 'label-main', text: '头像' }),
        h('div', { class: 'hint', style: { marginTop: '2px' }, text: '显示在你每条消息的右侧，会等比裁成方形存进配置' }),
        h('div', { class: 'btn-row', style: { marginTop: '7px' } },
          h('button', { class: 'btn ghost', onclick: async () => {
            try {
              const url = await pickAvatar(128)
              if (url) { profile.avatar = url; paint(); save() }
            } catch (err) { toast(err.message, 'err') }
          } }, '上传头像'),
          profile.avatar
            ? h('button', { class: 'btn ghost', onclick: () => { delete profile.avatar; paint(); save() } }, '清除')
            : null
        )
      )
    ),
    h('div', { class: 'field-row' },
      field('名称', nameInput),
      field('简称', shortInput, '消息右侧显示')
    ),
    field('喜好与背景', likesArea, '会写进每个成员的系统提示词，让他们按你的习惯说话。'),
    h('div', { class: 'hint', text: '改完即时保存，下一轮对话生效。' }),
    roleSection()
  )
}

/* --------------------------------------------------------- providers */

/* 只维护「厂商 → 端点」，模型清单一律实时向服务端要 */
const VENDOR_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'moonshot', name: '月之暗面', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu', name: '智谱 GLM', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'siliconflow', name: '硅基流动', kind: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'ollama', name: '本地 Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }
]

const modelCache = new Map()

/* 让横向溢出的行也能用滚轮驱动（浏览器默认不会把纵向滚轮转成横向） */
function bindHorizontalWheel (el) {
  el.addEventListener('wheel', (event) => {
    const max = el.scrollWidth - el.clientWidth
    if (max <= 1) return

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (!delta) return

    const next = Math.max(0, Math.min(max, el.scrollLeft + delta))
    if (next === el.scrollLeft) return

    event.preventDefault()
    el.scrollLeft = next
    syncScrollHint(el)
  }, { passive: false })

  el.addEventListener('scroll', () => syncScrollHint(el), { passive: true })
}

function syncScrollHint (el) {
  const max = el.scrollWidth - el.clientWidth
  el.classList.toggle('scrollable', max > 2)
  el.classList.toggle('at-start', el.scrollLeft <= 2)
  el.classList.toggle('at-end', el.scrollLeft >= max - 2)
}

function cacheKey (vendor, key) {
  return `${vendor.baseUrl}::${key ? key.slice(-8) : 'nokey'}`
}

function createModelPicker ({ getKey, onChange }) {
  const box = h('div', { class: 'picker' })
  const valueEl = h('span', { class: 'picker-value', text: '选择模型' })
  const vendorEl = h('span', { class: 'picker-vendor', text: '未选择' })
  const trigger = h('button', {
    class: 'picker-trigger',
    type: 'button',
    onclick: () => toggle()
  },
  h('span', { class: 'picker-current' }, valueEl, vendorEl),
  h('span', { class: 'picker-caret', text: '▾' })
  )

  const vendorBar = h('div', { class: 'picker-vendors' })
  const search = h('input', { class: 'picker-search', placeholder: '搜索模型，或直接输入不存在的名字' })
  const list = h('div', { class: 'picker-list' })
  const footText = h('span', { class: 'picker-foot-text', text: '' })
  const refreshBtn = h('button', { class: 'picker-refresh', type: 'button', onclick: () => load(true) }, '刷新')
  const panel = h('div', { class: 'picker-panel', hidden: true },
    vendorBar,
    search,
    list,
    h('div', { class: 'picker-foot' }, footText, refreshBtn)
  )

  box.append(trigger, panel)
  bindHorizontalWheel(vendorBar)

  let vendor = VENDOR_PRESETS[0]
  let selected = ''
  let models = []
  let reasoning = {}
  let loading = false
  let error = ''
  let opened = false

  const renderVendors = () => {
    vendorBar.textContent = ''
    for (const item of VENDOR_PRESETS) {
      vendorBar.append(h('button', {
        class: 'picker-chip' + (item.id === vendor.id ? ' on' : ''),
        type: 'button',
        onclick: () => {
          if (vendor.id === item.id) return
          vendor = item
          selected = ''
          renderVendors()
          renderList()
          load(true)
        }
      }, item.name))
    }
    requestAnimationFrame(() => syncScrollHint(vendorBar))
  }

  const renderList = () => {
    list.textContent = ''
    const query = search.value.trim()
    const lower = query.toLowerCase()

    if (loading) {
      list.append(h('div', { class: 'picker-empty' }, '正在读取该服务提供的模型…'))
      return
    }

    const items = models.filter((m) => !lower || m.toLowerCase().includes(lower))

    if (query && !items.includes(query)) {
      list.append(h('button', {
        class: 'picker-item custom',
        type: 'button',
        onclick: () => pick(query)
      },
      h('span', { class: 'picker-item-name', text: `使用「${query}」` }),
      h('span', { class: 'picker-item-tag', text: '自定义' })
      ))
    }

    for (const model of items) {
      const declared = reasoning[model]
      list.append(h('button', {
        class: 'picker-item' + (model === selected ? ' on' : ''),
        type: 'button',
        onclick: () => pick(model),
        title: declared ? `服务端声明思考档位：${declared.tiers.map((t) => t.label).join(' / ')}` : ''
      },
      h('span', { class: 'picker-item-name', text: model }),
      declared ? h('span', { class: 'picker-item-tag', text: `思考 ${declared.tiers.map((t) => t.label).join('/')}` }) : null,
      model === selected ? h('span', { class: 'picker-item-check', text: '✓' }) : null
      ))
    }

    if (!items.length && !query && !error) {
      list.append(h('div', { class: 'picker-empty' },
        models.length ? '没有匹配的模型' : '还没拿到模型列表。填好 API Key 后点「刷新」，或直接在上面输入模型名。'))
    }

    if (error) {
      list.append(h('div', { class: 'picker-empty error' },
        h('div', { text: error }),
        h('div', { class: 'picker-hint', text: '仍然可以手动输入模型名，或换个 Key 再试。' })
      ))
    }
  }

  const renderFoot = () => {
    const noKey = !getKey() && vendor.kind !== 'ollama'
    footText.textContent = loading
      ? '读取中…'
      : error
        ? '读取失败'
        : models.length
          ? `${models.length} 个模型 · 来自 ${vendor.name}`
          : noKey
            ? `${vendor.name} · 需要 API Key`
            : `${vendor.name} · 尚未读取`
  }

  const pick = (model) => {
    selected = model
    valueEl.textContent = model
    vendorEl.textContent = vendor.name
    onChange({ vendor, model, models, reasoning })
    close()
  }

  const load = async (force = false) => {
    const key = getKey()

    /* 没有 Key 就不去撞 401，直接告诉用户怎么继续 */
    if (!key && vendor.kind !== 'ollama') {
      models = []
      reasoning = {}
      error = ''
      loading = false
      renderList()
      renderFoot()
      return
    }

    const cache = cacheKey(vendor, key)
    if (!force && modelCache.has(cache)) {
      const hit = modelCache.get(cache)
      models = hit.models || []
      reasoning = hit.reasoning || {}
      error = ''
      renderList()
      renderFoot()
      return
    }

    loading = true
    error = ''
    renderList()
    renderFoot()

    try {
      const res = await window.astral.listModels({ kind: vendor.kind, baseUrl: vendor.baseUrl, apiKey: key })
      if (res && res.ok) {
        models = res.models || []
        reasoning = res.reasoning || {}
        error = models.length ? '' : ''
        if (models.length) modelCache.set(cache, { models, reasoning })
      } else {
        models = []
        reasoning = {}
        error = `读取失败：${(res && res.error) || '未知错误'}`
      }
    } catch (err) {
      models = []
      reasoning = {}
      error = `读取失败：${err.message}`
    }

    loading = false
    renderList()
    renderFoot()
  }

  const place = () => {
    const rect = trigger.getBoundingClientRect()
    /* 宽度不跟着输入框撑满，太长的下拉反而难扫 */
    const width = Math.min(430, Math.max(300, Math.round(rect.width)))
    panel.style.width = `${width}px`
    panel.style.left = `${Math.round(Math.min(Math.max(12, rect.left), window.innerWidth - width - 12))}px`
    const height = panel.offsetHeight || 300
    const below = rect.bottom + 8
    const above = rect.top - height - 8
    panel.style.top = `${Math.round(below + height > window.innerHeight - 12 && above > 12 ? above : below)}px`
  }

  const open = () => {
    opened = true
    /* modal 带 transform，会变成 fixed 的包含块，必须挂到 body 才按视口定位 */
    if (panel.parentElement !== document.body) document.body.append(panel)
    panel.hidden = false
    place()
    box.classList.add('open')
    requestAnimationFrame(() => panel.classList.add('open'))
    renderVendors()
    renderList()
    renderFoot()
    load()
  }

  const close = () => {
    opened = false
    box.classList.remove('open')
    panel.classList.remove('open')
    setTimeout(() => { if (!opened) panel.hidden = true }, 160)
  }

  const toggle = () => (opened ? close() : open())

  search.addEventListener('input', renderList)

  document.addEventListener('pointerdown', (event) => {
    if (!opened) return
    if (box.contains(event.target) || panel.contains(event.target)) return
    close()
  }, true)

  window.addEventListener('resize', () => { if (opened) close() })
  document.addEventListener('scroll', (event) => {
    if (!opened) return
    /* 面板内部的横向滚动不算"外部滚动"，否则一滚就关 */
    if (panel.contains(event.target)) return
    close()
  }, true)

  renderVendors()
  renderList()
  renderFoot()

  return { element: box, getSelection: () => ({ vendor, model: selected, models, reasoning }) }
}

function renderQuickSetup (body) {
  const providers = state.providers.providers || (state.providers.providers = [])

  const baseInput = h('input', { class: 'input', readonly: 'readonly' })
  const keyInput = h('input', { class: 'input', type: 'password', placeholder: '粘贴 API Key' })
  const applyAll = h('input', { type: 'checkbox', checked: true })
  const status = h('div', { class: 'hint', text: '' })

  let current = null

  const picker = createModelPicker({
    getKey: () => keyInput.value.trim(),
    onChange: ({ vendor, model, models, reasoning }) => {
      current = { vendor, model, models, reasoning }
      baseInput.value = vendor.baseUrl
      status.textContent = `${vendor.name} · ${model}`
    }
  })

  const saveBtn = h('button', { class: 'btn', onclick: async () => {
    if (!current || !current.model) {
      toast('先选一个模型', 'err')
      return
    }
    const { vendor: v, model, models: list, reasoning: declared } = current
    const key = keyInput.value.trim()
    let provider = providers.find((p) => p.baseUrl === v.baseUrl && p.kind === v.kind)

    if (!provider) {
      provider = {
        id: v.id,
        name: v.name,
        kind: v.kind,
        baseUrl: v.baseUrl,
        hasKey: false,
        models: [],
        reasoning: {},
        enabled: true
      }
      providers.push(provider)
    }

    provider.enabled = true
    provider.kind = v.kind
    provider.models = [...new Set([model, ...(list || []), ...(provider.models || [])])]

    /* 只落盘服务端显式声明过的档位，且限个数量，避免把整份模型清单塞进配置 */
    const table = Object.assign({}, provider.reasoning || {})
    let kept = 0
    for (const id of provider.models) {
      const hit = declared && declared[id]
      if (!hit) continue
      if (!table[id]) kept += 1
      table[id] = hit
      if (kept >= 60) break
    }
    provider.reasoning = table

    if (key) {
      const saved = await window.astral.setProviderKey({ id: provider.id, key })
      if (!saved || saved.ok === false) {
        toast(`保存 Key 失败：${(saved && saved.error) || '未知错误'}`, 'err')
        return
      }
      provider.hasKey = true
      keyInput.value = ''
    }

    if (applyAll.checked) {
      for (const agent of state.roster.agents) {
        agent.providerId = provider.id
        agent.model = model
      }
      persist.roster()
      bus.emit('roster:changed')
    }

    persist.providers()
    toast(`已启用 ${model}`, 'ok')
    const declaredHit = declared && declared[model]
    const cap = declaredHit ? ` · 思考档位 ${declaredHit.tiers.map((t) => t.label).join(' / ')}` : ' · 服务端未声明思考档位'
    status.textContent = provider.hasKey ? `已保存 · ${v.name} / ${model}${cap}` : `已保存，但还没有保存 Key${cap}`
  } }, '保存并启用')

  const detectBtn = h('button', { class: 'btn ghost', onclick: async () => {
    const vendor = current ? current.vendor : VENDOR_PRESETS[0]
    detectBtn.textContent = '检测中…'
    detectBtn.disabled = true
    try {
      const res = await window.astral.listModels({
        kind: vendor.kind,
        baseUrl: vendor.baseUrl,
        apiKey: keyInput.value.trim()
      })
      if (!res || !res.ok) {
        status.textContent = `检测失败：${(res && res.error) || '未知错误'}`
      } else if (!res.models.length) {
        status.textContent = '连通，但服务端没有返回模型列表'
      } else {
        const hit = current && res.models.includes(current.model)
        status.textContent = `连通 · 服务端提供 ${res.models.length} 个模型${hit ? '' : '，其中不含你当前所选'}：${res.models.slice(0, 8).join(' / ')}`
      }
    } catch (err) {
      status.textContent = `检测失败：${err.message}`
    } finally {
      detectBtn.textContent = '检测连通性'
      detectBtn.disabled = false
    }
  } }, '检测连通性')

  body.append(h('div', { class: 'quick-setup' },
    h('div', { class: 'pane-title', style: { marginTop: '0' }, text: '快速接入' }),
    field('模型', picker.element, '清单来自服务端实时返回；带「思考 …」标签的是服务端显式声明了档位的模型，其余一律按模型名推断'),
    field('Base URL', baseInput, '由所选厂商自动生成，中转站可自行改成自己的地址'),
    field('API Key', keyInput, '加密保存在本机凭据库，providers.json 不再保存明文，不会上传'),
    h('div', { class: 'btn-row', style: { flexWrap: 'wrap' } },
      saveBtn,
      detectBtn,
      h('label', { class: 'checkline', style: { padding: '0 0 0 8px' } },
        applyAll,
        h('span', { text: '同时把编制成员切到这个模型' })
      )
    ),
    status
  ))
}

function renderProviders (body) {
  renderQuickSetup(body)

  body.append(h('div', { class: 'hint', style: { marginBottom: '12px' } },
    '支持 OpenAI 兼容协议（DeepSeek / 月之暗面 / 智谱 / 硅基流动 / 各类中转站）、Anthropic 原生协议、本地 Ollama。'))

  const list = state.providers.providers || []

  for (const provider of list) {
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', { class: 'card-title' }, provider.name, h('span', { class: 'tag' + (provider.enabled ? ' on' : ''), text: provider.enabled ? '启用' : '停用' })),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn ghost', onclick: async (e) => {
            const btn = e.currentTarget
            btn.textContent = '测试中'
            btn.disabled = true
            const model = (provider.models && provider.models[0]) || ''
            const res = await testProvider(provider, model)
            btn.textContent = '测试'
            btn.disabled = false
            toast(res.ok ? `连通 · ${res.text || 'ok'}` : `失败 · ${res.message}`, res.ok ? 'ok' : 'err')
          } }, '测试'),
          h('button', { class: 'btn ghost', onclick: async () => {
            await window.astral.clearProviderKey({ id: provider.id }).catch(() => {})
            state.providers.providers = state.providers.providers.filter((p) => p.id !== provider.id)
            persist.providers()
            bus.emit('roster:changed')
            body.textContent = ''
            renderProviders(body)
          } }, '移除')
        )
      ),
      h('div', { class: 'field-row-3' },
        field('名称', h('input', { class: 'input', value: provider.name || '', oninput: (e) => { provider.name = e.target.value; persist.providers() } })),
        field('协议', h('select', { class: 'select', onchange: (e) => { provider.kind = e.target.value; persist.providers() } },
          h('option', { value: 'openai', selected: provider.kind === 'openai' }, 'OpenAI 兼容'),
          h('option', { value: 'anthropic', selected: provider.kind === 'anthropic' }, 'Anthropic'),
          h('option', { value: 'ollama', selected: provider.kind === 'ollama' }, 'Ollama')
        )),
        field('状态', h('select', { class: 'select', onchange: (e) => { provider.enabled = e.target.value === 'on'; persist.providers() } },
          h('option', { value: 'on', selected: provider.enabled !== false }, '启用'),
          h('option', { value: 'off', selected: provider.enabled === false }, '停用')
        ))
      ),
      field('Base URL', h('input', { class: 'input', value: provider.baseUrl || '', oninput: (e) => { provider.baseUrl = e.target.value; persist.providers() } }),
        provider.kind === 'ollama' ? '如 http://127.0.0.1:11434' : '需包含 /v1，例如 https://api.deepseek.com/v1'),
      h('div', { class: 'field-row-3' },
        field('输入价 / 百万 token',
          h('input', {
            class: 'input',
            type: 'number',
            min: '0',
            step: '0.0001',
            value: provider.pricing && provider.pricing.inputPerMillion !== undefined ? String(provider.pricing.inputPerMillion) : '',
            placeholder: '留空 = 不估算',
            oninput: (e) => {
              provider.pricing = provider.pricing || {}
              const value = e.target.value.trim()
              provider.pricing.inputPerMillion = value === '' ? undefined : Number(value)
              persist.providers()
            }
          }),
          '用于「本轮用量」的成本估算'),
        field('输出价 / 百万 token',
          h('input', {
            class: 'input',
            type: 'number',
            min: '0',
            step: '0.0001',
            value: provider.pricing && provider.pricing.outputPerMillion !== undefined ? String(provider.pricing.outputPerMillion) : '',
            placeholder: '留空 = 不估算',
            oninput: (e) => {
              provider.pricing = provider.pricing || {}
              const value = e.target.value.trim()
              provider.pricing.outputPerMillion = value === '' ? undefined : Number(value)
              persist.providers()
            }
          }),
          'DeepSeek / OpenAI / Anthropic 均按此计价'),
        field('币种',
          h('select', {
            class: 'select',
            onchange: (e) => {
              provider.pricing = provider.pricing || {}
              provider.pricing.currency = e.target.value
              persist.providers()
            }
          },
          h('option', { value: 'USD', selected: (provider.pricing && provider.pricing.currency || 'USD') === 'USD' }, 'USD'),
          h('option', { value: 'CNY', selected: provider.pricing && provider.pricing.currency === 'CNY' }, 'CNY')
          ),
          '只影响展示，不做汇率换算')
      ),
      field('API Key',
        h('div', { class: 'btn-row', style: { flexWrap: 'wrap' } },
          h('input', {
            class: 'input',
            type: 'password',
            placeholder: provider.hasKey ? '已保存 · 输入新 Key 替换' : '未保存',
            onchange: async (e) => {
              const key = e.target.value.trim()
              if (!key) return
              const res = await window.astral.setProviderKey({ id: provider.id, key })
              if (!res || res.ok === false) {
                toast(`保存 Key 失败：${(res && res.error) || '未知错误'}`, 'err')
                return
              }
              provider.hasKey = true
              e.target.value = ''
              toast('API Key 已加密保存', 'ok')
            }
          }),
          provider.hasKey
            ? h('button', {
              class: 'btn ghost',
              type: 'button',
              onclick: async () => {
                const res = await window.astral.clearProviderKey({ id: provider.id })
                if (!res || res.ok === false) {
                  toast('清除 Key 失败', 'err')
                  return
                }
                provider.hasKey = false
                persist.providers()
                body.textContent = ''
                renderProviders(body)
                toast('API Key 已清除', 'ok')
              }
            }, '清除')
            : null
        ),
        '加密保存在本机凭据库，渲染层和插件都读不到明文。本地模型可留空。'),
      field('模型清单', h('input', { class: 'input', value: (provider.models || []).join(', '), onchange: (e) => {
        provider.models = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
        persist.providers()
        bus.emit('roster:changed')
      } }), '逗号分隔，第一个为该供应商的默认模型。')
    )
    body.append(card)
  }

  body.append(h('div', { class: 'btn-row', style: { marginTop: '6px' } },
    h('button', { class: 'btn ghost', onclick: () => {
      const id = `p${Date.now().toString(36)}`
      state.providers.providers.push({
        id,
        name: '新供应商',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        hasKey: false,
        models: ['model-name'],
        enabled: true
      })
      persist.providers()
      body.textContent = ''
      renderProviders(body)
    } }, '+ 新增供应商')
  ))

  renderRetryCard(body)
}

/* 调用重试：断线 / 超时后的自动恢复策略 */
const RETRY_DEFAULTS = { enabled: true, maxAttempts: 3, timeoutSec: 60, baseDelayMs: 1000, maxDelayMs: 8000 }

function retrySettings () {
  if (!state.settings.retry) state.settings.retry = { ...RETRY_DEFAULTS }
  return state.settings.retry
}

function renderRetryCard (body) {
  const cfg = retrySettings()
  const numberInput = (key, min, max, step) => h('input', {
    class: 'input',
    type: 'number',
    min,
    max,
    step,
    value: cfg[key],
    onchange: (e) => {
      const n = Number(e.target.value)
      if (Number.isFinite(n)) cfg[key] = Math.min(max, Math.max(min, Math.round(n)))
      e.target.value = cfg[key]
      persist.settings()
    }
  })

  const master = h('div', {
    class: 'switch' + (cfg.enabled !== false ? ' on' : ''),
    onclick: (event) => {
      const on = !event.currentTarget.classList.contains('on')
      event.currentTarget.classList.toggle('on', on)
      cfg.enabled = on
      persist.settings()
    }
  })

  body.append(h('div', { class: 'card', style: { marginTop: '14px' } },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '调用重试',
        h('span', { class: 'tag' + (cfg.enabled !== false ? ' on' : ''), text: cfg.enabled !== false ? '启用' : '停用' })
      )
    ),
    h('div', { class: 'hint', style: { marginBottom: '10px' } },
      '模型连接中断、长时间无响应或返回 429/5xx 时自动重试；等待时间从「首次等待」起每次翻倍，并带 ±20% 抖动。'),
    h('div', { class: 'field-row-2' },
      field('自动重试', master, '关闭后失败即报错，不再重试'),
      field('最大尝试次数', numberInput('maxAttempts', 1, 6, 1), '含第一次调用；3 表示最多重试 2 次')
    ),
    h('div', { class: 'field-row-3' },
      field('空闲超时（秒）', numberInput('timeoutSec', 5, 600, 5), '超过这么久没收到任何数据就判定断线'),
      field('首次等待（毫秒）', numberInput('baseDelayMs', 200, 30000, 100), '第一次重试前的等待'),
      field('最大等待（毫秒）', numberInput('maxDelayMs', 500, 60000, 500), '退避上限，避免等待过久')
    )
  ))
}

/* ------------------------------------------------------------ roster */

function renderRosterConfig (body) {
  const project = activeProject()
  body.append(
    h('div', { class: 'settings-project-banner' },
      h('span', { class: 'settings-project-tag', text: '当前项目' }),
      h('b', { text: project ? project.name : '未选择项目' }),
      h('span', { class: 'hint', text: '成员与角色只属于这个项目；切换项目后，编制会跟着切换。' })
    )
  )
  body.append(h('div', { class: 'pane-title', text: '协作策略' }))
  body.append(h('div', { class: 'hint', style: { marginBottom: '10px' }, text: '工作模式：顶栏的「标准会话 / 团队」按钮随时切换。标准会话是你与当前助手的一对一对话，不派单、不做多智能体编排，也不显示职位（职位只在团队会话里生效）；团队按编制分工，成员不足 2 人时自动按标准会话运行。「革新」只重置当前成员的这条会话，不影响其他线程。' }))
  const orch = state.settings.orchestration || (state.settings.orchestration = { maxRounds: 2, parallel: true })
  const contextCfg = state.settings.context || (state.settings.context = {})
  const budgetRaw = Number(contextCfg.maxTokens ?? 12000)
  const budgetUnlimited = budgetRaw === 0 || budgetRaw > 64000
  const budgetInput = h('input', {
    class: 'input',
    type: 'number',
    min: '2000',
    max: '64000',
    step: '1000',
    value: budgetUnlimited ? '' : String(Math.round(budgetRaw)),
    placeholder: budgetUnlimited ? '不设上限' : '12000',
    disabled: budgetUnlimited,
    oninput: (e) => {
      contextCfg.maxTokens = Number(e.target.value)
      persist.settings()
    }
  })
  const budgetSwitch = h('div', {
    class: 'switch' + (budgetUnlimited ? ' on' : ''),
    title: '开启后不再压缩历史，全部原文发送'
  })
  const setBudgetUnlimited = (on) => {
    budgetSwitch.classList.toggle('on', on)
    if (on) {
      contextCfg.maxTokens = 0
      budgetInput.value = ''
      budgetInput.placeholder = '不设上限'
      budgetInput.disabled = true
    } else {
      contextCfg.maxTokens = 12000
      budgetInput.value = '12000'
      budgetInput.placeholder = ''
      budgetInput.disabled = false
    }
    persist.settings()
  }
  budgetSwitch.addEventListener('click', () => {
    setBudgetUnlimited(!budgetSwitch.classList.contains('on'))
  })

  body.append(
    h('div', { class: 'field-row-3' },
      field('最大派单轮次', h('input', { class: 'input', type: 'number', min: '0', max: '4', value: String(orch.maxRounds ?? 2), oninput: (e) => {
        orch.maxRounds = Number(e.target.value)
        persist.settings()
      } }), '总指挥 → 副指挥 → 执行者的最大下探层数'),
      field('派单方式', h('select', { class: 'select', onchange: (e) => {
        orch.parallel = e.target.value === 'parallel'
        persist.settings()
      } },
      h('option', { value: 'parallel', selected: orch.parallel !== false }, '并行'),
      h('option', { value: 'serial', selected: orch.parallel === false }, '串行')
      ), '并行更快，串行更省 token'),
      field('历史窗口', h('input', { class: 'input', type: 'number', min: '2', max: '60', value: String(contextCfg.historyLimit ?? 24), oninput: (e) => {
        contextCfg.historyLimit = Number(e.target.value)
        persist.settings()
      } }), '近期消息最多保留条数；更早的消息会压成摘要，不直接丢弃'),
      field('上下文预算（tokens）', budgetInput, '近期对话与工具结果共用的预算；超出后只保留开头、结尾和较早消息摘要')
    ),
    h('div', { class: 'mini-row', style: { marginTop: '2px' } },
      h('div', {},
        h('div', { text: '上下文不设上限' }),
        h('div', { class: 'hint', text: '开启后不再压缩历史，也会忽略「历史窗口」条数；长会话可能超出模型的上下文长度。' })
      ),
      budgetSwitch
    )
  )

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '项目通用技能规范（本项目成员共享）' }))
  const globalSkills = h('div', {})
  for (const skill of state.skills) {
    globalSkills.append(h('label', { class: 'checkline' },
      h('input', { type: 'checkbox', checked: (state.roster.globalSkills || []).includes(skill.id), onchange: (e) => {
        const set = new Set(state.roster.globalSkills || [])
        if (e.target.checked) set.add(skill.id)
        else set.delete(skill.id)
        state.roster.globalSkills = [...set]
        persist.roster()
      } }),
      h('span', {}, h('b', { text: skill.name }), h('small', { text: skill.desc || skill.id }))
    ))
  }
  body.append(globalSkills)

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '项目上下文' }))
  const notes = h('textarea', { class: 'textarea', style: { minHeight: '110px' } })
  notes.value = state.roster.globalNotes || ''
  notes.addEventListener('input', debounce(() => {
    state.roster.globalNotes = notes.value
    persist.roster()
  }, 500))
  body.append(notes, h('div', { class: 'hint', text: '这里写的内容只会注入到当前项目成员的提示词里，适合放项目背景、术语表、硬性约束。也可以在右侧「上下文」面板点「✦ 沉淀」，让总指挥从会话里提炼。' }))

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '成员管理' }))
  const counts = { commander: 0, deputy: 0, executor: 0 }
  for (const a of state.roster.agents) counts[a.role] = (counts[a.role] || 0) + 1
  body.append(h('div', { class: 'hint', text: `当前项目编制：总指挥 ${counts.commander} · 副指挥 ${counts.deputy} · AI 成员 ${counts.executor}` }))
  body.append(h('div', { class: 'hint', text: '总指挥和副指挥都可以为空；即使只有 AI 成员，项目也能直接运行。' }))
  body.append(h('div', { class: 'btn-row', style: { marginTop: '10px', flexWrap: 'wrap' } },
    h('button', { class: 'btn ghost', onclick: () => addAgent('commander') }, '+ 总指挥'),
    h('button', { class: 'btn ghost', onclick: () => addAgent('deputy') }, '+ 副指挥'),
    h('button', { class: 'btn ghost', onclick: () => addAgent('executor') }, '+ AI 成员'),
    h('button', { class: 'btn ghost', style: { marginLeft: 'auto' }, onclick: async () => {
      const ok = await confirmAction({
        title: '恢复默认编制？',
        message: '用内置默认编制覆盖当前项目的成员？现有成员会被清空。',
        confirmText: '恢复默认',
        danger: true
      })
      if (!ok) return
      try {
        const res = await fetch('astral://app/defaults/roster.json')
        const data = await res.json()
        state.roster.agents = data.agents
        state.roster.globalSkills = data.globalSkills || []
        state.roster.globalNotes = data.globalNotes || ''
        persist.roster()
        bus.emit('roster:changed')
        toast('已恢复默认编制', 'ok')
        body.textContent = ''
        renderRosterConfig(body)
      } catch (err) {
        toast('恢复失败：' + err.message, 'err')
      }
    } }, '恢复默认')
  ))
}

/* ------------------------------------------------------- 权限与数据 */

function paneTitle (text, top = 18) {
  return h('div', { class: 'pane-title', style: { marginTop: `${top}px` }, text })
}

/* 一组权限开关：full 打开时其余项锁定为已授予 */
function permGrid (opts) {
  const box = h('div', { class: 'perm-grid' })
  const paint = () => {
    box.textContent = ''
    const values = opts.values() || {}
    const full = opts.allowFull !== false && isFullAuth(values)
    for (const perm of PERMS) {
      if (perm.master && opts.skipFull) continue
      const on = perm.master ? Boolean(values[perm.key]) : (full || Boolean(values[perm.key]))
      const locked = !perm.master && full
      box.append(h('div', { class: 'perm-row' + (locked ? ' locked' : '') },
        h('div', {},
          h('div', { class: 'label-main', text: perm.label }),
          h('div', { class: 'hint', text: locked ? '已被「完全授权」覆盖' : perm.desc })
        ),
        h('div', {
          class: 'switch' + (on ? ' on' : '') + (locked ? ' disabled' : ''),
          onclick: () => {
            if (locked) return
            opts.toggle(perm.key, !on)
            paint()
            if (opts.onChange) opts.onChange()
          }
        })
      ))
    }
  }
  paint()
  return box
}

function renderMcpTools (body) {
  body.append(paneTitle('MCP 工具服务器', 0))
  body.append(h('div', { class: 'hint', text: 'MCP（Model Context Protocol）让成员调用本机工具进程。服务器由你配置、由你启用；每次实际调用都会先弹确认，除非把它加入该服务器的 autoApprove。' }))
  body.append(mcpSettingsSection())
}

function renderPermissions (body) {
  const repaint = () => { body.textContent = ''; renderPermissions(body) }

  /* 1. 全局总闸 */
  body.append(paneTitle('全局权限（总闸）', 0))
  body.append(h('div', { class: 'hint', text: '开启「完全授权」后其余权限项全部视为已授予；关闭时才逐项判断。成员侧的权限只在这个范围内生效。' }))
  body.append(permGrid({
    values: () => globalPerms(),
    toggle: (key, on) => setGlobalPerm(key, on),
    onChange: () => bus.emit('permissions:changed')
  }))

  /* 2. 智能体默认权限 */
  body.append(paneTitle('智能体默认权限'))
  body.append(h('div', { class: 'hint', text: '新建成员时自动套用这套默认值；已存在的成员可以一键应用，也可以随时改。' }))
  body.append(permGrid({
    values: () => agentDefaultPerms(),
    toggle: (key, on) => setAgentDefaultPerm(key, on),
    skipFull: true,
    allowFull: false
  }))
  body.append(h('div', { class: 'btn-row', style: { marginTop: '10px' } },
    h('button', { class: 'btn ghost', onclick: () => {
      const n = applyDefaultsToAll()
      if (!n && !hasAgentDefaults()) { toast('还没勾选任何默认权限', 'err'); return }
      bus.emit('roster:changed')
      toast(`已把默认权限应用到 ${n} 个成员`, 'ok')
    } }, '应用到全部成员'),
    h('button', { class: 'btn ghost', onclick: () => {
      const n = clearAllAgentPerms()
      bus.emit('roster:changed')
      toast(`已清空 ${n} 个成员的独立权限，改为跟随全局`, 'ok')
    } }, '清空成员独立权限')
  ))

  /* 3. 逐成员权限 */
  body.append(paneTitle('成员权限'))
  body.append(h('div', { class: 'hint', text: '生效权限 = 全局 ∩ 成员自身（未单独配置则跟随上面的默认值）。' }))

  const agents = state.roster.agents
  if (!agents.length) {
    body.append(h('div', { class: 'hint', text: '编制为空，先到「编制」页添加成员。' }))
  } else {
    for (const agent of agents) {
      const own = agent.permissions || null
      const base = ownPermsBase(agent)
      const chips = h('div', { class: 'perm-chips' })
      for (const key of PERM_KEYS) {
        const perm = PERMS.find((p) => p.key === key)
        const on = Boolean(base[key])
        chips.append(h('button', {
          class: 'perm-chip' + (on ? ' on' : ''),
          type: 'button',
          title: perm ? perm.desc : '',
          onclick: () => {
            if (!agent.permissions) agent.permissions = { ...base }
            agent.permissions[key] = !on
            persist.roster()
            bus.emit('roster:changed')
            repaint()
          }
        }, perm ? perm.label : key))
      }
      body.append(h('div', { class: 'perm-agent' },
        h('div', { class: 'perm-agent-head' },
          h('span', { class: 'perm-agent-name', text: agent.short || agent.name }),
          h('span', { class: 'tag' + (own ? ' on' : ''), text: own ? '自定义' : '跟随默认' }),
          own
            ? h('button', {
              class: 'btn ghost',
              style: { marginLeft: 'auto', padding: '2px 8px', fontSize: '11px' },
              onclick: () => { clearAgentPerms(agent); bus.emit('roster:changed'); repaint() }
            }, '恢复默认')
            : null
        ),
        chips
      ))
    }

    const pick = h('select', { class: 'select' },
      ...PERM_KEYS.map((key) => {
        const perm = PERMS.find((p) => p.key === key)
        return h('option', { value: key, text: perm ? perm.label : key })
      })
    )
    body.append(h('div', { class: 'btn-row', style: { marginTop: '10px' } },
      h('span', { class: 'hint', text: '批量：' }),
      pick,
      h('button', { class: 'btn ghost', onclick: () => {
        const n = setAllAgentPerm(pick.value, true)
        bus.emit('roster:changed')
        toast(`已为 ${n} 个成员开启「${PERMS.find((p) => p.key === pick.value).label}」`, 'ok')
        repaint()
      } }, '全部开启'),
      h('button', { class: 'btn ghost', onclick: () => {
        const n = setAllAgentPerm(pick.value, false)
        bus.emit('roster:changed')
        toast(`已为 ${n} 个成员关闭「${PERMS.find((p) => p.key === pick.value).label}」`, 'ok')
        repaint()
      } }, '全部关闭')
    ))
  }

  /* 4. 数据权限文件 */
  body.append(paneTitle('数据权限文件'))
  body.append(h('div', { class: 'hint', text: '上传后勾选它对应的权限：只有拿到该权限的成员才会在提示词里看到这个文件。' }))
  body.append(dataFilesSection())

  /* 5. 语音转写 */
  body.append(paneTitle('语音转写'))
  const speech = speechSettings()
  const providers = (state.providers.providers || []).filter((p) => p.enabled !== false)
  body.append(
    h('div', { class: 'field-row-3' },
      field('引擎', h('select', { class: 'select', onchange: (e) => {
        speech.engine = e.target.value
        persist.settings()
      } },
      h('option', { value: 'auto', selected: speech.engine === 'auto' }, '自动（优先 SenseVoice 本机）'),
      h('option', { value: 'sensevoice', selected: speech.engine === 'sensevoice' }, 'SenseVoice 本机（高质量）'),
      h('option', { value: 'windows', selected: speech.engine === 'windows' }, 'Windows 本机识别'),
      h('option', { value: 'browser', selected: speech.engine === 'browser' }, '浏览器识别'),
      h('option', { value: 'server', selected: speech.engine === 'server' }, '服务端转写')
      ), '默认优先 SenseVoice 本机；首次使用前请先在下方安装本地模型'),
      field('转写供应商', h('select', { class: 'select', onchange: (e) => {
        speech.providerId = e.target.value || ''
        persist.settings()
      } },
      h('option', { value: '', selected: !speech.providerId }, '自动选择'),
      ...providers.map((p) => h('option', { value: p.id, selected: speech.providerId === p.id }, p.name))
      ), '仅服务端转写需要；需要 OpenAI 兼容的 /audio/transcriptions'),
      field('转写模型', h('input', { class: 'input', value: speech.model || 'whisper-1', oninput: (e) => {
        speech.model = e.target.value
        persist.settings()
      } }), '常用 whisper-1 / whisper-large-v3')
    )
  )

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: 'SenseVoice 本地模型' }))
  const modelsBox = h('div', { class: 'speech-model-box' })
  body.append(modelsBox)

  function paintModels () {
    modelsBox.textContent = ''
    const models = speechModels()
    const selected = selectedSpeechModel()
    const status = h('div', { class: 'hint', style: { marginTop: '2px' }, text: '正在检查模型…' })
    modelsBox.append(
      h('div', { class: 'hint', text: '应用不内置语音模型。请自行下载 SenseVoice，并选择包含 model.int8.onnx（或 model.onnx）与 tokens.txt 的文件夹。' }),
      h('div', { class: 'btn-row', style: { marginTop: '8px', flexWrap: 'wrap' } },
        h('button', {
          class: 'btn ghost',
          type: 'button',
          onclick: async () => {
            const record = await addSpeechModelFromDialog()
            if (record) paintModels()
          }
        }, '添加模型文件夹'),
        h('button', {
          class: 'btn ghost',
          type: 'button',
          onclick: () => openSpeechModelPage()
        }, '打开模型下载页')
      )
    )

    if (!models.length) {
      modelsBox.append(h('div', { class: 'speech-model-empty', text: '尚未安装本地模型。语音按钮会先提示安装。' }))
    } else {
      for (const model of models) {
        const active = selected && selected.id === model.id
        modelsBox.append(h('div', { class: 'speech-model-row' },
          h('div', { class: 'speech-model-main' },
            h('div', { class: 'speech-model-name' }, model.name || 'SenseVoice', active ? h('span', { class: 'tag on', text: '当前使用' }) : null),
            h('div', { class: 'hint', text: `${model.dir}${model.size ? ` · ${(model.size / 1024 / 1024).toFixed(0)}MB` : ''}` })
          ),
          h('div', { class: 'speech-model-actions' },
            h('button', {
              class: 'btn ghost',
              type: 'button',
              disabled: active,
              onclick: () => {
                setSelectedSpeechModel(model.id)
                paintModels()
              }
            }, active ? '使用中' : '使用'),
            h('button', {
              class: 'btn ghost',
              type: 'button',
              onclick: async () => {
                const ok = await confirmAction({
                  title: '移除语音模型？',
                  message: `从列表移除「${model.name || model.dir}」？不会删除模型文件。`,
                  confirmText: '移除',
                  danger: true
                })
                if (!ok) return
                removeSpeechModel(model.id)
                paintModels()
              }
            }, '移除')
          )
        ))
      }
    }
    modelsBox.append(status)

    if (!selected) {
      status.textContent = '未安装本地模型。点击「语音」会提示先完成安装。'
      return
    }
    inspectSelectedSpeechModel().then((info) => {
      if (!status.isConnected) return
      if (info && info.available) {
        status.textContent = '模型可用。录音在本地完成，不上传。'
        status.style.color = 'var(--ok)'
      } else {
        status.textContent = `模型不可用：${(info && info.error) || '请检查目录是否完整'}`
        status.style.color = 'var(--err)'
      }
    }).catch(() => {
      if (status.isConnected) status.textContent = '无法检查模型目录'
    })
  }
  paintModels()

  body.append(h('div', { class: 'hint', text: 'SenseVoice 识别使用应用内置的 sherpa-onnx 运行时；模型由用户自行安装，录音不上传。Windows 模式为系统备用；服务端模式会上传录音到你选择的供应商。' }))

  /* 6. 工具调用审计 */
  body.append(paneTitle('工具调用审计'))
  body.append(auditSection())

  /* 7. 诊断包 */
  body.append(paneTitle('诊断'))
  const diagBtn = h('button', {
    class: 'btn ghost',
    type: 'button',
    text: '导出诊断包',
    onclick: async () => {
      diagBtn.disabled = true
      try {
        const res = await window.astral.exportDiagnostics()
        if (!res || res.ok === false) {
          toast(`诊断包导出失败：${(res && res.error) || '未知错误'}`, 'err')
          return
        }
        toast(`诊断包已导出：${res.path}`, 'ok')
      } catch (err) {
        toast(`诊断包导出失败：${err.message}`, 'err')
      } finally {
        diagBtn.disabled = false
      }
    }
  })
  body.append(h('div', { class: 'hint', text: '导出 JSON 运行快照：版本、文件大小、插件清单、任务/运行状态、审计摘要。不会包含 API Key、bridge token、会话正文或插件源码。' }))
  body.append(h('div', { class: 'btn-row', style: { marginTop: '8px' } }, diagBtn))
}

function auditSection () {
  const box = h('div', { class: 'audit-box' })
  const list = h('div', { class: 'audit-list' })
  const pathHint = h('div', { class: 'hint' })
  const refresh = h('button', {
    class: 'btn ghost',
    type: 'button',
    text: '刷新',
    onclick: () => load()
  })

  const paint = (entries) => {
    list.textContent = ''
    if (!entries.length) {
      list.append(h('div', { class: 'dock-empty', text: '还没有工具调用记录。' }))
      return
    }
    for (const entry of entries) {
      const time = new Date(entry.ts || 0)
      const label = entry.allowed === false ? '拒绝' : (entry.ok ? '完成' : '失败')
      list.append(h('div', { class: 'audit-row' },
        h('div', { class: 'audit-main' },
          h('div', { class: 'audit-title' },
            h('span', { class: 'audit-tool', text: entry.tool || '(unknown)' }),
            h('span', { class: `audit-badge ${entry.allowed === false ? 'deny' : (entry.ok ? 'ok' : 'err')}`, text: label }),
            h('span', { class: 'audit-time', text: Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString('zh-CN', { hour12: false }) })
          ),
          h('div', { class: 'audit-meta', text: [entry.agentId, entry.runId, (entry.capabilities || []).join('/')].filter(Boolean).join(' · ') }),
          (entry.reason || entry.error) ? h('div', { class: 'audit-reason', text: entry.reason || entry.error }) : null
        ),
        h('span', { class: 'audit-ms', text: `${entry.durationMs || 0}ms` })
      ))
    }
  }

  async function load () {
    refresh.disabled = true
    try {
      const res = await window.astral.auditList({ limit: 50 })
      if (!res || res.ok === false) {
        list.textContent = ''
        list.append(h('div', { class: 'dock-empty', text: (res && res.error) || '读取审计失败' }))
        return
      }
      pathHint.textContent = res.file ? `日志：${res.file}` : ''
      paint(Array.isArray(res.entries) ? res.entries : [])
    } finally {
      refresh.disabled = false
    }
  }

  box.append(
    h('div', { class: 'hint', text: '主进程会记录每次工具调用的权限判定、审批、结果与耗时；参数中的密钥和正文会被脱敏。' }),
    h('div', { class: 'btn-row', style: { marginTop: '8px' } }, refresh),
    pathHint,
    list
  )
  load()
  return box
}

/* -------------------------------------------------------- appearance */

function renderAppearance (body) {
  const settings = state.settings
  const apply = state.settings.appearance || (state.settings.appearance = {})
  body.append(h('div', { class: 'pane-title', text: '语言' }))
  const language = h('select', { class: 'select', 'data-i18n-skip': '' },
    ...availableLocales().map((item) => h('option', {
      value: item.code,
      selected: item.code === currentLocale()
    }, item.nativeName))
  )
  language.addEventListener('change', async () => {
    const code = language.value
    state.settings.language = code
    persist.settings()
    setLocale(code)
    if (window.astral.setLanguage) await window.astral.setLanguage(code).catch(() => {})
    toast(t('界面语言已切换'))
  })
  body.append(field('界面语言', language,
    '其他语言可放入 config/locales/<code>.json；界面会读取 code、nativeName 和 messages。'))

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '主题' }))
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px', marginBottom: '6px' } })
  for (const theme of state.themes) {
    const active = (settings.theme || 'astral') === theme.id
    const t = theme.tokens || {}
    grid.append(h('div', {
      class: 'card',
      style: {
        marginBottom: '0',
        cursor: 'pointer',
        borderColor: active ? 'color-mix(in srgb, var(--accent) 55%, transparent)' : '',
        background: active ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : ''
      },
      onclick: () => {
        settings.theme = theme.id
        persist.settings()
        applyTheme(theme, settings)
        body.textContent = ''
        renderAppearance(body)
      }
    },
    h('div', { class: 'card-title' }, theme.name, active ? h('span', { class: 'tag on', text: '当前' }) : null),
    h('div', { class: 'hint', text: theme.desc || '' }),
    h('div', { style: { display: 'flex', gap: '5px', marginTop: '9px' } },
      ...['--accent', '--accent-2', '--ok', '--warn'].map((k) =>
        h('span', { style: { width: '16px', height: '16px', borderRadius: '5px', background: t[k] || '#666', border: '1px solid rgba(255,255,255,.15)' } })
      )
    )
    ))
  }
  body.append(grid, h('div', { class: 'hint', text: '主题文件在 app/themes/ 与 config/themes/，新增一个 JSON 即出现在这里。字体、圆角、动效速度都能改。' }))

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '背景与动效' }))
  const toggles = [
    ['starfield', '星野粒子', '缓慢漂移的背景星点'],
    ['aurora', '极光层', '三团缓慢呼吸的光雾'],
    ['grain', '颗粒质感', '轻微噪点，减轻纯色背景的塑料感'],
    ['reducedMotion', '减弱动效', '关闭入场动画与循环动画，适合长时间专注']
  ]
  const art = effectiveArt()
  for (const [key, label, hint] of toggles) {
    const on = key === 'reducedMotion' ? Boolean(art.reducedMotion) : art[key] !== false
    body.append(h('div', { class: 'mini-row' },
      h('div', {}, h('div', { text: label }), h('div', { class: 'hint', text: hint })),
      h('div', { class: 'switch' + (on ? ' on' : ''), onclick: (e) => {
        const el = e.currentTarget
        el.classList.toggle('on')
        apply[key] = el.classList.contains('on')
        persist.settings()
        applyTheme(currentTheme(), settings)
      } })
    ))
  }

  renderTextColorSettings(body)

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '界面缩放' }))
  const scaleRow = h('div', { class: 'btn-row' })
  const options = [
    { label: '自动', value: 0 },
    { label: '85%', value: 0.85 },
    { label: '95%', value: 0.95 },
    { label: '100%', value: 1 },
    { label: '110%', value: 1.1 }
  ]
  for (const option of options) {
    const active = (Number(settings.uiScale) || 0) === option.value
    scaleRow.append(h('button', {
      class: 'btn ghost',
      style: active
        ? { borderColor: 'color-mix(in srgb, var(--accent) 55%, transparent)', color: 'var(--fg-0)' }
        : {},
      onclick: () => {
        if (option.value) settings.uiScale = option.value
        else delete settings.uiScale
        persist.settings()
        applyUiScale()
        body.textContent = ''
        renderAppearance(body)
      }
    }, option.label))
  }
  body.append(scaleRow, h('div', { class: 'hint', text: '「自动」按窗口宽度换算：1600px 约 95%，1200px 约 89%，1000px 以下收到 86%。' }))

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '星空转速' }))
  const spinValue = Number((settings.appearance && settings.appearance.starSpin) ?? 0.25)
  const spinLabel = h('span', { class: 'hint', style: { marginTop: '0', whiteSpace: 'nowrap' }, text: '' })
  const spinRange = h('input', {
    class: 'range',
    type: 'range',
    min: '0',
    max: '100',
    step: '1',
    value: String(Math.round(spinValue / 0.006))
  })
  const paintSpin = (v) => {
    const rad = v * 0.006
    spinRange.style.setProperty('--fill', `${v}%`)
    spinLabel.textContent = rad <= 0
      ? '静止'
      : `${rad.toFixed(2)} rad/s · ${Math.round((Math.PI * 2) / rad)} 秒一圈`
  }
  paintSpin(Number(spinRange.value))
  spinRange.addEventListener('input', () => {
    const v = Number(spinRange.value)
    paintSpin(v)
    state.settings.appearance = { ...(state.settings.appearance || {}), starSpin: v * 0.006 }
  })
  spinRange.addEventListener('change', () => persist.settings())
  body.append(
    h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center' } }, spinRange, spinLabel),
    h('div', { class: 'hint', text: '0 = 完全静止。拖动即时生效，不用关设置就能看到星野在转。' })
  )

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '窗口切换动效' }))
  const winRow = h('div', { class: 'btn-row', style: { flexWrap: 'wrap', gap: '7px' } })
  const winCurrent = (settings.appearance && settings.appearance.winTransition) || 'fade'
  for (const item of TRANSITIONS) {
    const active = winCurrent === item.id
    winRow.append(h('button', {
      class: 'btn ghost',
      title: item.desc,
      style: active
        ? { borderColor: 'color-mix(in srgb, var(--accent) 55%, transparent)', color: 'var(--fg-0)' }
        : {},
      onclick: () => {
        state.settings.appearance = { ...(state.settings.appearance || {}), winTransition: item.id }
        persist.settings()
        playWindowEnter(item.id)
        body.textContent = ''
        renderAppearance(body)
      }
    }, item.label))
  }
  body.append(winRow, h('div', { class: 'hint', text: '切回星界窗口时播放；点上面的按钮可以直接预览。' }))

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '动效速度' }))
  const speed = h('input', { class: 'input', type: 'range', min: '0.4', max: '2', step: '0.05', value: String(settings.motion ? settings.motion.speed : 1) })
  speed.addEventListener('input', () => {
    settings.motion = settings.motion || {}
    settings.motion.speed = Number(speed.value)
    document.documentElement.style.setProperty('--speed', String(settings.motion.speed))
    persist.settings()
  })
  body.append(speed, h('div', { class: 'hint', text: '数值越大动效越快。0.4 近乎静止，2 相当急促。' }))
  sfxSettingsSection(body)
}

/* --------------------------------------------------------------- 音效 */
function sfxSettingsSection (body) {
  const cfg = sfxConfig()
  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '音效' }))
  const card = h('div', { class: 'card' })
  card.append(
    h('div', { class: 'card-title' }, '程序化音效'),
    h('div', { class: 'hint', text: '启动动画只有三声清脆的铃：导航星①、导航星②、第三颗星（Logo 落点）。Logo 飞到左上角时不发声。' })
  )
  const rows = [
    ['enabled', '总开关', '关闭后完全静音'],
    ['startup', '启动动画', '只在彗星航程里响三声，收场与界面操作都安静']
  ]
  for (const [key, label, desc] of rows) {
    const box = h('input', { type: 'checkbox', checked: Boolean(cfg[key]) })
    box.addEventListener('change', () => setSfxConfig({ [key]: box.checked }))
    card.append(h('div', { class: 'mini-row', style: { marginTop: '8px' } },
      h('span', {}, label, h('span', { class: 'hint', text: ' · ' + desc })), box))
  }
  const vol = h('input', { class: 'input', type: 'range', min: '0', max: '1', step: '0.05', value: String(cfg.volume) })
  const volLabel = h('span', { class: 'hint', text: Math.round(cfg.volume * 100) + '%' })
  vol.addEventListener('input', () => {
    const v = Number(vol.value)
    volLabel.textContent = Math.round(v * 100) + '%'
    setSfxConfig({ volume: v })
  })
  card.append(h('div', { class: 'mini-row', style: { marginTop: '10px' } },
    h('span', {}, '音量 ', volLabel), vol))
  const tryRow = h('div', { class: 'btn-row', style: { marginTop: '12px' } })
  for (const [name, label] of [
    ['waypoint1', '第一声 · 导航星①'],
    ['waypoint2', '第二声 · 导航星②'],
    ['merge', '第三声 · 第三颗星']
  ]) {
    tryRow.append(h('button', { class: 'btn ghost', onclick: () => sfxPlay(name) }, label))
  }
  card.append(tryRow, h('div', { class: 'hint', style: { marginTop: '8px' },
    text: '下次启动按彗星的三个落点依次响这三声；之后收场全程安静。上面的按钮可以单独试听。' }))
  body.append(card)
}

/* --------------------------------------------------------- 运行 / 后台 */

function renderRunOwnerTrust (host) {
  const list = h('div', { class: 'run-owner-list' })
  const paint = async () => {
    const res = await window.astral.runOwners().catch(() => ({ ok: false, owners: {} }))
    list.textContent = ''
    if (!res || res.ok === false) {
      list.append(h('div', { class: 'hint', text: (res && res.error) || '读取发起成员信任失败' }))
      return
    }
    const entries = Object.entries(res.owners || {})
    if (!entries.length) {
      list.append(h('div', { class: 'hint', text: '还没有信任记录：每个项目第一次协作、或换发起成员时，主进程会弹窗确认。' }))
      return
    }
    for (const [projectId, agentId] of entries) {
      const project = (state.projects || []).find((item) => item.id === projectId)
      const agent = project && project.roster && Array.isArray(project.roster.agents)
        ? project.roster.agents.find((item) => item.id === agentId)
        : null
      list.append(h('div', { class: 'run-owner-row' },
        h('div', {},
          h('div', { text: project ? project.name : projectId }),
          h('div', { class: 'hint', text: `发起成员：${agent ? agent.name : agentId}（${agentId}）` })
        ),
        h('button', {
          class: 'btn ghost',
          type: 'button',
          onclick: async () => {
            const result = await window.astral.resetRunOwners({ projectId }).catch(() => null)
            if (!result || result.ok === false) {
              toast((result && result.error) || '清除失败', 'err')
              return
            }
            paint()
          }
        }, '清除')
      ))
    }
  }
  host.append(h('div', { class: 'card', style: { marginTop: '14px' } },
    h('div', { class: 'card-title' }, '协作发起成员信任'),
    h('div', { class: 'hint', text: '工具权限以本轮发起成员为上限，子成员不会超过它。这里只保存「信任并记住」的项目；清除后下次协作会重新确认。' }),
    list,
    h('div', { class: 'btn-row', style: { marginTop: '10px' } },
      h('button', {
        class: 'btn ghost',
        type: 'button',
        onclick: async () => {
          const result = await window.astral.resetRunOwners({}).catch(() => null)
          if (!result || result.ok === false) {
            toast((result && result.error) || '清除失败', 'err')
            return
          }
          toast('已清除全部发起成员信任', 'ok')
          paint()
        }
      }, '清除全部信任'))
  ))
  paint()
}

function renderRun (body) {
  const settings = state.settings
  const cfg = settings.app || (settings.app = {})
  const enabled = cfg.closeToTray !== false

  body.append(h('div', { class: 'pane-title', text: '后台运行' }))
  body.append(h('div', { class: 'mini-row' },
    h('div', {},
      h('div', { text: '关闭窗口后驻留后台' }),
      h('div', { class: 'hint', text: '右上角关闭只是把界面收进系统托盘：正在跑的对话、派单任务和 MCP 桥都不会中断。' })
    ),
    h('div', { class: 'switch' + (enabled ? ' on' : ''), onclick: (e) => {
      const el = e.currentTarget
      el.classList.toggle('on')
      cfg.closeToTray = el.classList.contains('on')
      persist.settings()
      window.astral.setBackgroundPref(cfg.closeToTray).catch(() => {})
      toast(cfg.closeToTray ? '关闭窗口将收进托盘，后台继续运行' : '关闭窗口将退出星界')
      body.textContent = ''
      renderRun(body)
    } })
  ))

  body.append(h('div', { class: 'card', style: { marginTop: '14px' } },
    h('div', { class: 'card-title' }, '收起后仍在做的事'),
    h('div', { class: 'hint', text: '· 智能体派单与工具调用继续推进，不依赖窗口可见。' }),
    h('div', { class: 'hint', text: '· 渲染进程已关闭后台节流，定时器保持原节奏。' }),
    h('div', { class: 'hint', text: '· MCP 桥继续监听本机端口，外部客户端随时能调。' }),
    h('div', { class: 'hint', text: '· 托盘图标单击唤回窗口，右键菜单可以退出。' })
  ))

  body.append(h('div', { class: 'pane-title', style: { marginTop: '18px' }, text: '手动控制' }))
  body.append(h('div', { class: 'btn-row' },
    h('button', { class: 'btn ghost', onclick: async () => {
      const res = await window.astral.hideToTray().catch((err) => ({ ok: false, error: err.message }))
      if (!res || !res.ok) toast((res && res.error) || '收进托盘失败', 'err')
    } }, '现在收进托盘'),
    h('button', { class: 'btn danger', onclick: async () => {
      const ok = await confirmAction({
        title: '彻底退出星界？',
        message: '正在运行的任务会中断，后台的 MCP 桥也会关闭。',
        confirmText: '彻底退出',
        danger: true
      })
      if (!ok) return
      window.astral.quitApp()
    } }, '彻底退出星界')
  ))
  body.append(h('div', { class: 'hint', text: '「现在收进托盘」等同于点窗口右上角的关闭；真正退出只能从这里或托盘右键菜单走。' }))

  renderRunOwnerTrust(body)
}

/* ------------------------------------------------------------ bridge */

function renderBridge (body) {
  const cfg = state.bridge || {}
  const running = cfg.running
  body.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, 'MCP 桥接', h('span', { class: 'tag' + (running ? ' on' : ''), text: running ? `监听 ${cfg.port}` : '未启动' })),
      h('button', { class: 'btn ghost', onclick: () => window.astral.openDir('config') }, '打开配置目录')
    ),
    h('div', { class: 'hint', text: '星界在本机暴露一个 JSON-RPC 桥，外部 AI 客户端可据此列举成员、下达指令、读取对话。' })
  ))

  const snippet = JSON.stringify({
    mcpServers: {
      'astral-realm': {
        command: 'node',
        args: [`${state.dirs.root || ''}\\electron\\astral-mcp.js`],
        env: { ASTRAL_PORT: String(cfg.port || 45871), ASTRAL_TOKEN: cfg.token || '' }
      }
    }
  }, null, 2)

  body.append(h('div', { class: 'pane-title', style: { marginTop: '16px' }, text: 'MCP 客户端配置' }))
  const pre = h('pre', { style: {
    background: 'rgba(0,0,0,.42)',
    border: '1px solid var(--line)',
    borderRadius: '10px',
    padding: '12px 14px',
    overflowX: 'auto',
    fontFamily: 'var(--mono)',
    fontSize: '11px',
    lineHeight: '1.7',
    margin: '0 0 10px'
  } })
  pre.textContent = snippet
  body.append(pre)

  body.append(h('div', { class: 'btn-row' },
    h('button', { class: 'btn', onclick: async () => {
      try {
        await navigator.clipboard.writeText(snippet)
        toast('已复制到剪贴板', 'ok')
      } catch {
        toast('复制失败，请手动选择文本', 'err')
      }
    } }, '复制配置'),
    h('button', { class: 'btn ghost', onclick: () => window.astral.openDir('root') }, '打开程序目录')
  ))

  body.append(h('div', { class: 'pane-title', style: { marginTop: '16px' }, text: '令牌' }))
  body.append(h('div', { class: 'hint', text: `当前令牌：${cfg.token || '（无）'}` }))
  body.append(h('div', { class: 'hint', text: '令牌写在本机 config/settings.json 的 bridge.token。清空该字段可关闭校验（不建议）。' }))
  renderTriggers(body)
}

/* ------------------------------------------- 事件触发器（外部接口） */

const TRIG_MODE_LABEL = { off: '关闭', observe: '观察（默认）', auto: '自动执行' }
const TRIG_STATUS_LABEL = {
  rejected: '已拒绝', ignored: '已忽略', observed: '待批准', queued: '排队中',
  auto: '等待执行', executing: '执行中', executed: '已执行', failed: '失败', interrupted: '上次中断'
}

function renderTriggers (body) {
  body.append(h('div', { class: 'pane-title', style: { marginTop: '16px' } }, '事件触发器'))
  const host = h('div', {})
  body.append(host)
  const refresh = () => { host.replaceChildren(); drawTriggers(host, refresh) }
  refresh()
}

function drawTriggers (host, refresh) {
  const cfg = triggerConfig()
  const wd = cfg.watchdog || { enabled: true, threshold: 3 }
  const all = listEvents(MAX_EVENTS).slice().reverse()
  const pending = all.filter((e) => e.status === 'observed').length
  const modeHint = {
    off: '关闭：外部事件直接被拒绝，不记录、不执行。',
    observe: '观察：候选事件只记录在本页，需要你逐条点「批准执行」才会启动一轮。此模式下 0 次模型调用、对话流 0 条消息。',
    auto: '自动执行：白名单内事件自动启动一轮；工具调用仍走原有权限与审批弹窗。'
  }[cfg.mode]

  host.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '事件模式',
        h('span', { class: 'tag' + (cfg.mode === 'observe' ? ' on' : ''), text: cfg.mode })),
      h('span', { class: 'hint', text: `队列 ${queueLength()} 张待执行` })
    ),
    h('div', { class: 'btn-row' }, MODES.map((m) => h('button', {
      class: 'btn' + (cfg.mode === m ? '' : ' ghost'),
      onclick: () => { setMode(m); refresh() }
    }, TRIG_MODE_LABEL[m]))),
    h('div', { class: 'hint', style: { marginTop: '10px' }, text: modeHint })
  ))

  const sources = h('input', { class: 'input', value: cfg.sources.join(', '), placeholder: '例如 ci, local-script' })
  const keywords = h('input', { class: 'input', value: cfg.keywords.join(', '), placeholder: '可选，逗号分隔' })
  const dedupe = h('input', { type: 'checkbox', checked: cfg.dedupe })
  const quietOn = h('input', { type: 'checkbox', checked: Boolean(cfg.quietHours) })
  const quietFrom = h('input', { class: 'input', type: 'time', value: (cfg.quietHours && cfg.quietHours.from) || '22:00' })
  const quietTo = h('input', { class: 'input', type: 'time', value: (cfg.quietHours && cfg.quietHours.to) || '08:00' })
  const wdOn = h('input', { type: 'checkbox', checked: wd.enabled })
  const wdNum = h('input', { class: 'input trig-num', type: 'number', min: '2', max: '10', value: String(wd.threshold) })

  const saveRules = () => {
    saveConfig({
      sources: sources.value.split(/[,，\s]+/),
      keywords: keywords.value.split(/[,，\s]+/),
      dedupe: dedupe.checked,
      quietHours: quietOn.checked ? { from: quietFrom.value, to: quietTo.value, enabled: true } : null,
      watchdog: { enabled: wdOn.checked, threshold: Number(wdNum.value) }
    })
    toast('事件规则已保存', 'ok')
    refresh()
  }
  for (const box of [dedupe, quietOn, wdOn]) box.addEventListener('change', saveRules)
  wdNum.addEventListener('change', saveRules)

  host.append(h('div', { class: 'card', style: { marginTop: '12px' } },
    h('div', { class: 'card-title' }, '规则（程序级过滤，不调用模型）'),
    h('div', { class: 'hint', text: '外部事件先过来源白名单、重复去重、静默时段与关键词；界面内的测试事件不受白名单限制。' }),
    h('div', { class: 'trig-row' }, h('span', { text: '来源白名单' }), sources),
    h('div', { class: 'trig-row' }, h('span', { text: '关键词' }), keywords),
    h('div', { class: 'trig-row' }, h('span', { text: '重复事件去重' }), dedupe),
    h('div', { class: 'trig-row' }, h('span', { text: '静默时段' }),
      h('span', { class: 'trig-inline' }, quietOn, quietFrom, h('span', { class: 'hint', text: '至' }), quietTo)),
    h('div', { class: 'trig-row' }, h('span', { text: 'Watchdog（重复工具调用）' }),
      h('span', { class: 'trig-inline' }, wdOn, wdNum, h('span', { class: 'hint', text: '次后停止' }))),
    h('div', { class: 'btn-row', style: { marginTop: '10px' } },
      h('button', { class: 'btn', onclick: saveRules }, '保存规则'))
  ))

  const testInput = h('input', { class: 'input', placeholder: '输入一条测试事件正文…' })
  host.append(h('div', { class: 'card', style: { marginTop: '12px' } },
    h('div', { class: 'card-title' }, '投一条测试事件'),
    h('div', { class: 'hint', text: '不写脚本也能试跑：测试事件永远只进候选，不会自动执行。' }),
    h('div', { class: 'trig-row' }, testInput,
      h('button', { class: 'btn', onclick: () => {
        const res = emitEvent({ source: 'test', type: 'manual', text: testInput.value }, { isTest: true })
        toast(res.ok ? `已加入候选：${res.status}` : `被拒绝：${res.reason}`, res.ok ? 'ok' : 'err')
        refresh()
      } }, '投入候选')),
    h('div', { class: 'hint', style: { marginTop: '8px' },
      text: `外部程序可 POST 到 http://127.0.0.1:${(state.bridge && state.bridge.port) || 45871}/rpc，method 为 astral.emit_event，令牌见上方。` })
  ))

  host.append(h('div', { class: 'pane-title', style: { marginTop: '16px' } },
    '事件记录', h('span', { class: 'hint', text: ` ${all.length} 条 · ${pending} 条待批准` })))

  if (!all.length) {
    host.append(h('div', { class: 'hint', text: '还没有事件。保持「观察」不会影响任何现有对话。' }))
  } else {
    for (const ev of all.slice(0, 30)) {
      host.append(h('div', { class: 'trig-event' + (ev.status === 'observed' ? ' pending' : '') },
        h('div', { class: 'trig-meta' },
          h('span', { text: `${ev.source} · ${new Date(ev.ts).toLocaleTimeString('zh-CN', { hour12: false })} · ${ev.eventId}${ev.threadCount > 1 ? ` · 线索 ${ev.threadCount} 条` : ''}` }),
          h('span', { class: 'trig-status', text: TRIG_STATUS_LABEL[ev.status] || ev.status })),
        h('div', { class: 'trig-text', text: ev.text }),
        h('div', { class: 'hint', text: ev.reason }),
        ev.threadItems && ev.threadItems.length > 1
          ? h('div', { class: 'hint', text: `已把 ${ev.threadItems.length} 条同线索事件归到这一张单，批准后会一起提交。` })
          : null,
        ev.status === 'observed'
          ? h('div', { class: 'btn-row', style: { marginTop: '8px' } },
              h('button', { class: 'btn', onclick: () => {
                const r = approveEvent(ev.id)
                toast(r.ok ? '已批准，等待执行' : r.error, r.ok ? 'ok' : 'err')
                refresh()
              } }, '批准执行'),
              h('button', { class: 'btn ghost', onclick: () => { ignoreEvent(ev.id); refresh() } }, '忽略'))
          : null
      ))
    }
  }
  host.append(h('div', { class: 'btn-row', style: { marginTop: '12px' } },
    h('button', { class: 'btn ghost', onclick: () => { clearEvents(); refresh() } }, '清空记录')))
}

/* ------------------------------------------------------------- about */

function renderAbout (body) {
  const buildLine = h('div', { class: 'hint', text: '正在读取构建信息…' })
  body.append(
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '星界 Astral Realm v' + state.version),
      h('div', { class: 'hint', text: '多 Agent 协作工作台。前端零依赖、无打包步骤，改文件即改行为。' })
    ),
    updateCard(),
    h('div', { class: 'mini-row' }, h('span', {}, '程序目录'), h('span', { class: 'hint', text: state.dirs.app || '' })),
    h('div', { class: 'mini-row' }, h('span', {}, '配置目录'), h('span', { class: 'hint', text: state.dirs.config || '' })),
    h('div', { class: 'mini-row' }, h('span', {}, '节点'), h('span', { class: 'hint', text: navigator.userAgent.split(' ').slice(-2).join(' ') })),
    h('div', { class: 'mini-row' }, h('span', {}, '构建'), buildLine),
    h('div', { class: 'btn-row', style: { marginTop: '14px' } },
      h('button', { class: 'btn ghost', onclick: () => window.astral.openDir('app') }, '打开 app 目录'),
      h('button', { class: 'btn ghost', onclick: () => window.astral.openDir('config') }, '打开 config 目录'),
      h('button', { class: 'btn', onclick: () => window.astral.reload() }, '刷新界面（F5）')
    ),
    h('div', { class: 'hint', text: '刷新会重新读盘：头像、配置、已保存的对话都会回到最新状态。' })
  )
  if (window.astral && typeof window.astral.buildInfo === 'function') {
    window.astral.buildInfo().then((info) => {
      if (!info) return
      const started = new Date(info.startedAt).toLocaleString('zh-CN', { hour12: false })
      const latest = info.latestAt ? new Date(info.latestAt).toLocaleString('zh-CN', { hour12: false }) : ''
      buildLine.textContent = info.stale
        ? `磁盘构建比当前进程新（${info.latestFile || '应用文件'} ${latest}）；请完全退出后重新打开星界。`
        : `当前进程已加载最新构建 · ${started}`
      buildLine.style.color = info.stale ? 'var(--warn)' : ''
    }).catch(() => {
      buildLine.textContent = '无法读取构建信息'
    })
  }
}
