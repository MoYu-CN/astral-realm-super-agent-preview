/* updater.js — 更新检查
 *
 * 两处入口共用同一份逻辑：
 *   1) 设置 → 关于 里的「软件更新」卡片，手动检查
 *   2) 启动后静默检查一次，有新版本时弹应用内确认框
 *
 * 真正的下载/替换不在应用内做：检查只负责告诉用户「GitHub 上有新版本」并给出链接。
 */

import { state, h, toast, persist } from './core.js'
import { confirmAction } from './confirm.js'
import { localeTag } from './i18n.js'

const REPO_URL = 'https://github.com/MoYu-CN/astral-realm'
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000

let lastResult = null
let inflight = null

function autoEnabled () {
  return state.settings.autoCheckUpdate !== false
}

function formatTime (value) {
  const ts = Number(value)
  if (!ts) return ''
  return new Date(ts).toLocaleString(localeTag(), { hour12: false })
}

function openRepo (url) {
  const target = url || REPO_URL
  if (window.astral && typeof window.astral.openExternal === 'function') {
    window.astral.openExternal(target)
  }
}

async function runCheck (force = false) {
  if (inflight) return inflight
  if (!window.astral || typeof window.astral.checkUpdate !== 'function') {
    return { ok: false, error: '当前运行环境不支持检查更新', current: state.version }
  }
  inflight = window.astral.checkUpdate({ force })
    .then((result) => {
      lastResult = result
      state.settings.updateLastCheck = result.checkedAt || Date.now()
      persist.settings()
      return result
    })
    .finally(() => { inflight = null })
  return inflight
}

/* --------------------------------------------------------------- 关于页卡片 */

export function updateCard () {
  const tag = h('span', { class: 'tag', text: '未检查' })
  const line = h('div', { class: 'hint' })
  const meta = h('div', { class: 'hint', style: { marginTop: '4px' } })
  const notes = h('div', { class: 'update-notes' })
  const actions = h('div', { class: 'btn-row', style: { marginTop: '11px' } })

  const checkBtn = h('button', { class: 'btn', text: '检查更新' })
  checkBtn.addEventListener('click', async () => {
    paint(null, true)
    const result = await runCheck(true)
    paint(result, false)
    if (result && result.ok) {
      toast(result.hasUpdate ? `发现新版本 v${result.latest}` : '已是最新版本', result.hasUpdate ? 'ok' : '')
    } else {
      toast((result && result.error) || '检查更新失败', 'err')
    }
  })

  const autoBox = h('input', { type: 'checkbox', checked: autoEnabled() })
  autoBox.addEventListener('change', () => {
    state.settings.autoCheckUpdate = autoBox.checked
    persist.settings()
  })

  function paint (result, checking) {
    tag.className = 'tag'
    tag.style.color = ''
    checkBtn.className = 'btn'
    checkBtn.disabled = Boolean(checking)
    checkBtn.textContent = checking ? '检查中…' : '检查更新'
    notes.textContent = ''
    actions.replaceChildren()

    if (checking) {
      tag.textContent = '查询中'
      line.textContent = `当前 v${state.version} · 正在查询 GitHub…`
      meta.textContent = ''
    } else if (!result) {
      tag.textContent = '未检查'
      line.textContent = `当前 v${state.version} · 仓库 MoYu-CN/astral-realm`
      const last = formatTime(state.settings.updateLastCheck)
      meta.textContent = last ? `上次检查：${last}` : '还没有检查过'
    } else if (!result.ok) {
      tag.textContent = '检查失败'
      tag.style.color = 'var(--warn)'
      line.textContent = `当前 v${state.version} · ${result.error || '未知错误'}`
      meta.textContent = `检查时间：${formatTime(result.checkedAt)}`
    } else if (result.hasUpdate) {
      const skipped = state.settings.updateSkippedVersion === result.latest
      /* 主色只留给「前往下载」：同一行出现两个实心按钮会抢注意力 */
      checkBtn.className = 'btn ghost'
      tag.textContent = skipped ? `v${result.latest} 已忽略` : `v${result.latest} 可用`
      tag.style.color = skipped ? '' : 'var(--accent)'
      line.textContent = `发现新版本 v${result.latest}，当前 v${result.current}`
      const bits = []
      if (result.publishedAt) bits.push(`发布于 ${String(result.publishedAt).slice(0, 10)}`)
      if (result.commit && result.commit.sha) bits.push(`最新提交 ${result.commit.sha}`)
      bits.push(`来源 ${result.source === 'release' ? 'Releases' : 'main 分支'}`)
      meta.textContent = bits.join(' · ')
      if (result.notes) notes.textContent = result.notes
      else if (result.commit && result.commit.message) notes.textContent = result.commit.message
      if (!skipped) {
        actions.append(h('button', { class: 'btn primary', text: '前往下载', onclick: () => openRepo(result.url) }))
      }
      actions.append(h('button', {
        class: 'btn ghost',
        text: skipped ? '恢复提示' : '忽略此版本',
        onclick: () => {
          state.settings.updateSkippedVersion = skipped ? '' : result.latest
          persist.settings()
          paint(result, false)
        }
      }))
    } else {
      tag.textContent = '已是最新'
      tag.style.color = 'var(--ok)'
      line.textContent = `当前 v${result.current} · 仓库最新 v${result.latest}`
      const bits = [`检查时间：${formatTime(result.checkedAt)}`]
      if (result.commit && result.commit.sha) bits.push(`最新提交 ${result.commit.sha}${result.commit.date ? ` · ${String(result.commit.date).slice(0, 10)}` : ''}`)
      meta.textContent = bits.join(' · ')
    }

    actions.append(checkBtn)
    actions.append(h('button', { class: 'btn ghost', text: '打开 GitHub', onclick: () => openRepo(REPO_URL) }))
  }

  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '软件更新'),
      tag),
    line,
    meta,
    notes,
    actions,
    h('label', { class: 'checkline', style: { marginTop: '9px' } },
      autoBox,
      h('span', {}, '启动时自动检查更新',
        h('small', { text: '只在发现新版本时提示一次；点「以后再说」会在 3 天后再提醒。' })))
  )

  paint(lastResult, false)
  return card
}

/* --------------------------------------------------------------- 启动时检查 */

export async function autoCheckUpdate () {
  if (!autoEnabled()) return
  let result = null
  try {
    result = await runCheck(false)
  } catch (err) {
    console.error('[update]', err)
    return
  }
  if (!result || !result.ok || !result.hasUpdate) return
  if (state.settings.updateSkippedVersion === result.latest) return
  const snoozed = state.settings.updateSnoozeVersion === result.latest &&
    Number(state.settings.updateSnoozeUntil) > Date.now()
  if (snoozed) return

  const go = await confirmAction({
    title: `发现新版本 v${result.latest}`,
    message: `当前 v${result.current}，GitHub 上已经有 v${result.latest}。要去看看吗？`,
    detail: String(result.notes || (result.commit && result.commit.message) || '').slice(0, 400),
    confirmText: '前往下载',
    cancelText: '以后再说'
  })

  if (go) {
    openRepo(result.url)
    return
  }
  state.settings.updateSnoozeVersion = result.latest
  state.settings.updateSnoozeUntil = Date.now() + SNOOZE_MS
  persist.settings()
}

