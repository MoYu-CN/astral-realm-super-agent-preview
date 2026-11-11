/* toolbar.js — 输入框下方功能条 */

import { state, $, h, persist, toast, agentById, commander, bus, providerById, activeProject } from './core.js'
import { icon } from './icons.js'
import { togglePopover, closePopover, popoverSection, popoverItem } from './popover.js'
import { reasoningProfile, tierFor } from './llm.js'
import { PERMS, globalPerms, setGlobalPerm, isFullAuth, grantedCount } from './permissions.js'
import { mountDataTool, dataFiles } from './datafiles.js'
import { mountVoice as mountVoiceTool } from './speech.js'
import { mountEnhance } from './enhance.js'
import { onWindowActivity, windowActive } from './activity.js'

/* ------------------------------------------------------------- 工具条 */

export function mountToolbar () {
  for (const btn of document.querySelectorAll('.tool[data-icon]')) {
    btn.prepend(icon(btn.dataset.icon, 15))
  }

  mountThink()
  mountPermissions()
  mountFiles()
  mountDataTool(toolBtn('tool-data'))
  mountModelPicker()
  mountVoiceTool(toolBtn('tool-voice'))
  mountEnhance(toolBtn('tool-enhance'))

  bus.on('attachments:changed', () => {
    renderAttachments()
    syncToolState()
  })
  bus.on('datafiles:changed', syncToolState)
  bus.on('permissions:changed', syncToolState)
  bus.on('roster:changed', syncToolState)
  bus.on('project:changed', () => {
    updateThinkMeta()
    renderAttachments()
    syncToolState()
  })
  bus.on('active:agent', updateThinkMeta)

  renderAttachments()
  syncToolState()
}

function toolBtn (id) {
  return document.getElementById(id)
}

export function syncToolState () {
  const perms = globalPerms()
  const full = isFullAuth(perms)
  const granted = grantedCount(perms)
  const permBtn = toolBtn('tool-perm')
  if (permBtn) {
    permBtn.classList.toggle('on', granted > 0 || full)
    permBtn.classList.toggle('full', full)
    permBtn.title = full
      ? '权限授予 · 完全授权（覆盖全部权限项）'
      : granted ? `权限授予 · 已开 ${granted} 项` : '权限授予 · 全部关闭'
  }

  const fileBtn = toolBtn('tool-file')
  if (fileBtn) {
    const count = (state.pendingFiles || []).length
    const label = fileBtn.querySelector('.tool-label')
    label.textContent = count ? `文件 ${count}` : '文件'
    fileBtn.classList.toggle('on', count > 0)
  }

  const dataBtn = toolBtn('tool-data')
  if (dataBtn) {
    const label = dataBtn.querySelector('.tool-label')
    const count = (dataFiles() || []).length
    label.textContent = count ? `数据 ${count}` : '数据'
    dataBtn.classList.toggle('on', count > 0)
    dataBtn.title = count ? `已上传 ${count} 个数据权限文件` : '上传数据权限文件并绑定权限'
  }

  const modelBtn = toolBtn('tool-model')
  if (modelBtn) {
    const label = modelBtn.querySelector('.tool-label')
    const cm = state.settings.chatModel
    label.textContent = cm ? cm.model : '模型'
    modelBtn.classList.toggle('on', Boolean(cm))
    modelBtn.title = cm ? `本轮指定模型：${cm.model}` : '模型选择 · 跟随成员设定'
  }
}

/* ------------------------------------------------------------ 思考强度 */

let thinkIntensity = 0.5

function mountThinkParticles () {
  const canvas = document.getElementById('think-stars-canvas')
  if (!canvas) return null

  const ctx = canvas.getContext('2d')
  let width = 0
  let height = 0
  let particles = []
  let raf = null
  let lastT = 0
  let paused = !windowActive()

  const reduced = () => document.body.classList.contains('reduced-motion')

  const spawn = (x) => {
    const big = Math.random() > 0.82
    return {
      x,
      y: 1 + Math.random() * (height - 2),
      vx: -(18 + Math.random() * 24),
      r: big ? 1.1 + Math.random() * 0.7 : 0.35 + Math.random() * 0.5,
      a: big ? 0.85 + Math.random() * 0.15 : 0.3 + Math.random() * 0.45,
      phase: Math.random() * Math.PI * 2,
      big
    }
  }

  const seed = () => {
    const count = Math.max(14, Math.round(width / 3.4))
    particles = Array.from({ length: count }, () => spawn(Math.random() * width))
  }

  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    width = Math.round(rect.width)
    height = Math.round(rect.height)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    seed()
  }

  const paint = (time) => {
    ctx.clearRect(0, 0, width, height)
    for (const p of particles) {
      const twinkle = 0.5 + 0.5 * Math.sin(time * 0.0032 + p.phase)
      ctx.globalAlpha = Math.min(1, p.a * (0.45 + twinkle * 0.75))
      ctx.beginPath()
      ctx.fillStyle = p.big ? '#eaf6ff' : '#ffffff'
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()

      if (p.big) {
        ctx.globalAlpha = p.a * twinkle * 0.2
        ctx.beginPath()
        ctx.fillStyle = '#8fe9ff'
        ctx.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  const frame = (time) => {
    if (paused) return
    raf = requestAnimationFrame(frame)
    if (reduced()) {
      paint(time)
      cancelAnimationFrame(raf)
      raf = null
      return
    }
    const dt = Math.min(64, time - lastT) / 1000
    lastT = time
    const speed = 0.55 + thinkIntensity * 1.6

    for (const p of particles) {
      p.x += p.vx * speed * dt
      if (p.x < -4) Object.assign(p, spawn(width + 2 + Math.random() * 10))
    }
    paint(time)
  }

  resize()
  lastT = performance.now()
  if (!paused) raf = requestAnimationFrame(frame)

  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(raf)
    raf = null
    resize()
    lastT = performance.now()
    if (!paused) raf = requestAnimationFrame(frame)
  })
  observer.observe(canvas)

  /* 收起窗口后停帧；回来再点着，背景不空转 */
  const offActivity = onWindowActivity((activeNow) => {
    if (!activeNow) {
      paused = true
      if (raf) cancelAnimationFrame(raf)
      raf = null
      return
    }
    if (!paused) return
    paused = false
    if (!raf) {
      lastT = performance.now()
      raf = requestAnimationFrame(frame)
    }
  })

  return {
    stop: () => {
      paused = true
      if (raf) cancelAnimationFrame(raf)
      raf = null
      offActivity()
      observer.disconnect()
    }
  }
}

let thinkCtl = null

function currentThinkProfile () {
  const override = state.settings.chatModel
  const agent = agentById(state.activeAgentId) || commander()
  const providerId = override ? override.providerId : agent && agent.providerId
  const model = override ? override.model : agent && agent.model
  const provider = providerId ? providerById(providerId) : null
  return { profile: reasoningProfile(provider, model), model: model || '未绑定模型' }
}

function mountThink () {
  const range = $('#think-range')
  const wrap = $('#think')
  const valueEl = $('#think-value')
  const slider = $('.think-slider')
  if (!range) return

  mountThinkParticles()

  const ticks = h('div', { class: 'think-ticks' })
  if (slider) slider.append(ticks)

  let profile = currentThinkProfile().profile
  let modelLabel = currentThinkProfile().model

  const paintTicks = () => {
    ticks.textContent = ''
    for (const tier of profile.tiers) {
      ticks.append(h('i', { style: { left: `${tier.value}%` }, dataset: { label: tier.label } }))
    }
  }

  const apply = (raw, save) => {
    const tier = tierFor(profile, raw)
    const v = tier.value

    range.value = String(v)
    range.style.setProperty('--fill', `${v}%`)
    valueEl.textContent = tier.label
    wrap.classList.toggle('strong', v > 66)
    wrap.classList.toggle('prompt-only', profile.mode === 'none')

    thinkIntensity = Math.max(0, Math.min(1, v / 100))

    /* 桥面粒子流强度：30 以下完全静默，往上渐显，100 满强度 */
    const glowRaw = Math.max(0, Math.min(1, (v - 30) / 70))
    const glow = Math.pow(glowRaw, 0.65)
    document.documentElement.style.setProperty('--glow', glow.toFixed(3))

    const bridge = document.getElementById('bridge-badge')
    if (bridge) bridge.classList.toggle('hot', glow > 0.75)

    const levels = profile.tiers.map((t) => t.label).join(' / ')
    const origin = profile.source === 'api'
      ? '服务端 /models 显式声明'
      : '服务端未声明，按模型名推断'
    const tip = profile.mode === 'none'
      ? `思考强度：${tier.label} · ${modelLabel} ${profile.label}，只影响派单深度（${origin}）`
      : `思考强度：${tier.label} · ${modelLabel} 支持 ${levels}（${profile.label} · ${origin}）`
    wrap.title = tip
    range.title = tip

    if (save) {
      state.settings.thinking = v
      persist.settings()
    }
    return v
  }

  const refresh = () => {
    const info = currentThinkProfile()
    profile = info.profile
    modelLabel = info.model
    paintTicks()
    /* 换模型后档位会变，吸附结果必须写回，否则界面显示与实际下发不一致 */
    const v = apply(state.settings.thinking ?? 50, false)
    if (v !== state.settings.thinking) {
      state.settings.thinking = v
      persist.settings()
    }
  }

  thinkCtl = { refresh }

  paintTicks()
  apply(state.settings.thinking ?? 50, false)

  /* 拖动时吸附到模型真实档位 */
  range.addEventListener('input', () => apply(Number(range.value), false))
  range.addEventListener('change', () => apply(Number(range.value), true))
}

/* 模型变化时重算档位 */
export function updateThinkMeta () {
  if (thinkCtl) thinkCtl.refresh()
}

/* -------------------------------------------------------------- 权限 */

function mountPermissions () {
  const btn = toolBtn('tool-perm')
  if (!btn) return
  btn.addEventListener('click', () => {
    togglePopover({
      anchor: btn,
      id: 'perm',
      width: 300,
      content: permissionsContent()
    })
  })
}

function permissionsContent () {
  const box = h('div', {})
  box.append(popoverSection('权限授予'))
  box.append(h('div', { class: 'label-sub', style: { padding: '0 9px 6px', color: 'var(--fg-2)' } },
    '这些开关会写进成员的提示词，未授予的能力成员不应声称可用。'))

  const repaint = () => {
    box.textContent = ''
    box.append(popoverSection('权限授予'))
    const perms = globalPerms()
    const full = isFullAuth(perms)

    box.append(h('div', { class: 'popover-row' },
      h('div', {},
        h('div', { class: 'label-main', text: '完全授权' }),
        h('div', { class: 'label-sub', text: '最高授权，开启后覆盖其余所有权限项' })
      ),
      h('div', {
        class: 'switch master' + (full ? ' on' : ''),
        onclick: () => {
          setGlobalPerm('full', !full)
          repaint()
          syncToolState()
        }
      })
    ))

    for (const perm of PERMS) {
      if (perm.master) continue
      const on = full || Boolean(globalPerms()[perm.key])
      box.append(h('div', { class: 'popover-row' + (full ? ' locked' : '') },
        h('div', {},
          h('div', { class: 'label-main', text: perm.label }),
          h('div', { class: 'label-sub', text: full ? '已被「完全授权」覆盖' : perm.desc })
        ),
        h('div', {
          class: 'switch' + (on ? ' on' : '') + (full ? ' disabled' : ''),
          onclick: () => {
            if (isFullAuth(globalPerms())) return
            setGlobalPerm(perm.key, !on)
            repaint()
            syncToolState()
          }
        })
      ))
    }

    box.append(h('div', { class: 'label-sub', style: { padding: '6px 9px 2px', color: 'var(--fg-2)' } },
      '每个成员的默认权限在「设置 → 权限与数据」里配置。'))
  }

  repaint()
  return box
}

/* -------------------------------------------------------------- 文件 */

async function mountFiles () {
  const btn = toolBtn('tool-file')
  if (!btn || !window.astral.pickFiles) {
    if (btn) btn.disabled = true
    return
  }
  btn.addEventListener('click', async () => {
    try {
      const project = activeProject()
      const result = await window.astral.pickFiles(project ? project.rootPath : '')
      const files = (result && result.files) || []
      const rejected = (result && result.rejected) || 0
      if (result && result.message) {
        toast(result.message, 'err')
        return
      }
      if (!files.length && !rejected) return
      if (files.length) {
        state.pendingFiles = [...(state.pendingFiles || []), ...files]
        renderAttachments()
        syncToolState()
      }
      const skipped = files.filter((f) => f.text === null).length
      if (rejected) {
        toast(`有 ${rejected} 个文件不在当前项目文件范围内，已跳过`, 'err')
      } else if (files.length) {
        toast(skipped ? `已添加 ${files.length - skipped} 个，${skipped} 个非文本已跳过` : `已添加 ${files.length} 个文件`, 'ok')
      }
    } catch (err) {
      toast(`添加失败：${err.message}`, 'err')
    }
  })
}

export function renderAttachments () {
  const row = $('#attach-row')
  if (!row) return
  const files = state.pendingFiles || []
  row.textContent = ''
  row.hidden = files.length === 0

  files.forEach((file, index) => {
    row.append(h('div', { class: 'attach-chip' },
      icon('file', 13),
      h('span', { class: 'name', text: file.name }),
      h('span', { class: 'size', text: formatSize(file.size) }),
      h('button', {
        title: '移除',
        onclick: () => {
          state.pendingFiles.splice(index, 1)
          renderAttachments()
          syncToolState()
        }
      }, icon('close', 11))
    ))
  })
}

function formatSize (bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/* -------------------------------------------------------------- 模型 */

function mountModelPicker () {
  const btn = toolBtn('tool-model')
  if (!btn) return
  btn.addEventListener('click', () => {
    togglePopover({ anchor: btn, id: 'model', width: 306, content: modelContent() })
  })
}

function modelContent () {
  const box = h('div', {})
  const current = state.settings.chatModel

  box.append(popoverSection('本轮模型'))
  box.append(popoverItem({
    label: '跟随成员设定',
    desc: '按编制里每个成员自己的模型走',
    active: !current,
    onClick: () => {
      delete state.settings.chatModel
      persist.settings()
      bus.emit('model:changed')
      syncToolState()
      updateThinkMeta()
      closePopover()
      toast('已恢复跟随成员设定')
    }
  }))

  const providers = (state.providers.providers || []).filter((p) => p.enabled !== false)
  for (const provider of providers) {
    if (!provider.models || !provider.models.length) continue
    box.append(popoverSection(provider.name))
    for (const model of provider.models) {
      const active = current && current.providerId === provider.id && current.model === model
      const profile = reasoningProfile(provider, model)
      const levels = (profile.tiers || []).map((t) => t.label).join(' / ')
      const cap = profile.mode === 'none'
        ? '无思考档位'
        : `档位 ${levels}${profile.source === 'api' ? '（服务端声明）' : '（按模型名推断）'}`
      box.append(popoverItem({
        label: model,
        desc: `${provider.name} · ${cap}`,
        active,
        onClick: () => {
          state.settings.chatModel = { providerId: provider.id, model }
          persist.settings()
          bus.emit('model:changed')
          syncToolState()
          updateThinkMeta()
          closePopover()
          toast(`本轮模型 · ${model}`, 'ok')
        }
      }))
    }
  }

  if (!providers.length) {
    box.append(h('div', { class: 'label-sub', style: { padding: '8px 9px' } }, '还没有可用的供应商，先到设置里添加。'))
  }
  return box
}
