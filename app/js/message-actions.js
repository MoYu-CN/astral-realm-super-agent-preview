/* message-actions.js — 已发送消息的只读查看、复制、副本编辑、撤回、重新生成与附件 */

import {
  state, bus, h, md, toast, copyText, fileTypeLabel, timeLabel,
  activeProject, estimateTextTokens, persist, conversationIsTeam, findMsg, superChatActive,
  saveProjectSessionNow
} from './core.js'
import { openModal, closeModal, field } from './modal.js'
import { confirmAction } from './confirm.js'
import { enhanceMarkdown } from './rich-markdown.js'
import { icon } from './icons.js'
import { saveSuperHistoryNow, enterSuperChat } from './superagent.js'
import { toggleContextRelease } from './context-release.js'
import {
  isImageFile, createImageThumb, enhanceMarkdownImages, openImagePreview
} from './imagepreview.js'
import {
  canRegenerate, regenerateLatest, withdrawMessage, copyPlanTask
} from './orchestrator.js'

const CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'html', 'htm',
  'json', 'jsonc', 'md', 'markdown', 'py', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php', 'sql', 'sh', 'bash', 'zsh',
  'ps1', 'bat', 'cmd', 'yml', 'yaml', 'toml', 'ini', 'xml', 'vue', 'svelte'
])

function canonicalPath (value) {
  return String(value || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

function projectRootPath () {
  const project = activeProject()
  return project && project.rootPath ? project.rootPath : ''
}

function isInsideProject (file) {
  const root = canonicalPath(projectRootPath())
  const target = canonicalPath(file && file.path)
  if (!root || !target) return false
  return target.startsWith(`${root}\\`) && !target.includes('\\..\\')
}

function isCodeFile (file) {
  if (!file) return false
  const name = file.path || file.name || ''
  const idx = String(name).lastIndexOf('.')
  if (idx < 0) return false
  return CODE_EXT.has(String(name).slice(idx + 1).toLowerCase())
}

function canEditProjectCode (file) {
  return Boolean(file && file.path && isCodeFile(file) && isInsideProject(file))
}

function formatSize (bytes) {
  const n = Number(bytes || 0)
  if (!n) return '0B'
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function roleText (msg) {
  if (msg.kind === 'user') return '你'
  if (msg.kind === 'plan') return msg.name || '派单'
  return msg.name || 'Agent'
}

function planText (msg) {
  const lines = [msg.brief || '']
  for (const task of msg.tasks || []) {
    lines.push(`- ${task.name}｜${taskStateLabel(task)}：${task.text || ''}`)
    if (task.result) lines.push(`  结果：${task.result}`)
  }
  return lines.filter(Boolean).join('\n')
}

function fullText (msg) {
  if (msg.kind === 'plan') return planText(msg)
  return String(msg.text || '')
}

function taskStateLabel (task) {
  if (!task) return ''
  if (task.interrupted) return '中断'
  return { queued: '排队', running: '进行中', done: '已完成', error: '失败' }[task.state] || task.state
}

async function copyToClipboard (value, label = '已复制') {
  const ok = await copyText(value)
  toast(ok ? label : '复制失败', ok ? 'ok' : 'err')
  return ok
}

function fileMetaLine (file) {
  return [fileTypeLabel(file.name, file.path), formatSize(file.size)].filter(Boolean).join(' · ')
}

export function sentAttachmentChip (file, opts = {}) {
  if (!file) return null
  if (isImageFile(file) && file.path) {
    return createImageThumb(file.path, {
      alt: file.name || '图片',
      caption: file.name || '',
      className: 'attach-image-thumb'
    })
  }
  return h('button', {
    class: 'attach-chip sent-attach' + (opts.compact ? ' compact' : ''),
    type: 'button',
    title: file.path || file.name,
    onclick: (e) => {
      e.stopPropagation()
      openAttachmentViewer(file, opts.msg || null)
    },
    ondblclick: (e) => e.stopPropagation()
  },
  icon('file', 13),
  h('span', { class: 'attach-main' },
    h('span', { class: 'name', text: file.name }),
    h('span', { class: 'attach-sub', text: fileMetaLine(file) })
  )
  )
}

export function attachmentRow (files, opts = {}) {
  const list = (files || []).filter(Boolean)
  if (!list.length) return null
  return h('div', { class: 'attach-row attached-file-row' },
    ...list.map((file) => sentAttachmentChip(file, opts))
  )
}

export function openAttachmentViewer (file, ownerMsg = null) {
  if (!file) return
  if (isImageFile(file) && file.path) {
    openImagePreview(file.path, { alt: file.name || '图片' })
    return
  }
  const editable = canEditProjectCode(file)
  openModal({
    title: file.name || '附件',
    sub: editable ? '项目代码文件 · 可编辑' : '只读附件',
    width: 720,
    render: (body) => {
      const text = typeof file.text === 'string' ? file.text : ''
      const preview = text ? text.slice(0, 20000) : ''
      const truncated = text.length > 20000
      body.append(
        h('div', { class: 'ro-file-meta' },
          h('span', { text: file.path || '未记录原文件路径' }),
          h('span', { class: 'ro-file-access ' + (editable ? 'editable' : 'readonly'), text: editable ? '可编辑项目文件' : '只读' })
        ),
        h('div', { class: 'ro-file-rule', text: editable
          ? '这个文件属于当前项目目录，编辑会直接写回原文件；它所在的 AI 回复文本仍然只读。'
          : '这个文件不在当前项目目录内，或不是代码文件，因此只提供只读预览。' }),
        text
          ? h('pre', { class: 'ro-pre' }, preview + (truncated ? '\n\n…（预览只显示前 20000 字符，完整内容请打开原文件）' : ''))
          : h('div', { class: 'ro-empty', text: '这个附件没有可内联预览的文本内容。你可以打开原文件查看。' }),
        h('div', { class: 'btn-row', style: { marginTop: '16px', flexWrap: 'wrap' } },
          editable
            ? h('button', { class: 'btn-primary', onclick: () => { closeModal(); openProjectCodeEditor(file, ownerMsg) } }, '编辑项目文件')
            : null,
          h('button', { class: 'btn ghost', disabled: !file.path, onclick: async () => {
            if (!file.path || !window.astral.openFile) return
            const res = await window.astral.openFile(file.path)
            if (res && res.ok === false) toast(res.error || '打开失败', 'err')
          } }, '打开原文件'),
          h('button', { class: 'btn ghost', disabled: !file.path, onclick: () => copyToClipboard(file.path, '文件路径已复制') }, '复制路径'),
          text ? h('button', { class: 'btn ghost', onclick: () => copyToClipboard(text, '附件正文已复制') }, '复制正文') : null,
          h('button', { class: 'btn ghost', style: { marginLeft: 'auto' }, onclick: () => closeModal() }, '关闭')
        )
      )
    }
  })
}

async function openProjectCodeEditor (file, ownerMsg) {
  if (!canEditProjectCode(file)) {
    toast('只有当前项目范围内的代码文件可以编辑', 'err')
    return
  }
  const rootPath = projectRootPath()
  if (!window.astral.readProjectFile || !window.astral.writeProjectFile) {
    toast('当前环境不支持项目文件编辑', 'err')
    return
  }
  let text = typeof file.text === 'string' ? file.text : ''
  try {
    const res = await window.astral.readProjectFile({ rootPath, filePath: file.path })
    if (!res || !res.ok) {
      toast((res && res.error) || '读取项目文件失败', 'err')
      return
    }
    text = res.text
  } catch (err) {
    toast('读取项目文件失败：' + err.message, 'err')
    return
  }

  openModal({
    title: '编辑项目文件',
    sub: '只读边界：AI 回复本身不可编辑；这里修改的是项目文件',
    width: 820,
    render: (body) => {
      const area = h('textarea', { class: 'code-editor', spellcheck: 'false' })
      area.value = text
      body.append(
        h('div', { class: 'ro-file-meta' },
          h('span', { text: file.path }),
          h('span', { class: 'ro-file-access editable', text: '可编辑项目文件' })
        ),
        area,
        h('div', { class: 'hint', text: '保存会直接写回原文件。消息里的 AI 回复和参考示例代码仍然只读。' }),
        h('div', { class: 'btn-row', style: { marginTop: '14px' } },
          h('button', { class: 'btn-primary', onclick: async () => {
            const next = area.value
            const res = await window.astral.writeProjectFile({ rootPath, filePath: file.path, text: next })
            if (!res || !res.ok) {
              toast((res && res.error) || '保存失败', 'err')
              return
            }
            file.text = next
            file.size = Number(res.size) || next.length
            file.tokens = estimateTextTokens(next)
            if (ownerMsg && state.messages.includes(ownerMsg)) {
              bus.emit('message:update', { id: ownerMsg.id })
            }
            persist.session()
            closeModal()
            toast('项目文件已保存', 'ok')
          } }, '保存到项目文件'),
          h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消')
        )
      )
    }
  })
}

function statusNote (msg) {
  if (msg.interrupted) return '本轮已中断'
  if (msg.error) return '调用失败'
  if (msg.streaming) return '正在生成'
  return ''
}

function viewerHead (msg) {
  const when = timeLabel(msg.ts)
  const state = statusNote(msg)
  return h('div', { class: 'ro-meta' },
    h('span', { class: 'ro-role', text: roleText(msg) }),
    /* 单独会话没有职位，只读查看里也不带 */
    conversationIsTeam() && msg.title ? h('span', { text: msg.title }) : null,
    h('span', { text: when }),
    state ? h('span', { class: 'ro-state', text: state }) : null,
    h('span', { class: 'ro-readonly', text: '只读' })
  )
}

export function openMessageViewer (msgId, taskId = null) {
  const msg = findMsg(msgId)
  if (!msg) return
  if (taskId && msg.kind === 'plan') {
    const task = (msg.tasks || []).find((t) => t.id === taskId)
    if (task) { openTaskViewer(msg, task); return }
  }

  openModal({
    title: '查看内容',
    sub: msg.kind === 'user' ? '只读查看 · 修改提问需先撤回本轮' : '只读视图 · 原始内容不会被修改',
    width: 760,
    render: (body) => {
      body.append(viewerHead(msg))
      if (msg.kind === 'plan') {
        body.append(
          h('div', { class: 'ro-brief', text: msg.brief || '（无摘要）' }),
          h('div', { class: 'ro-task-list' },
            ...(msg.tasks || []).map((task) => h('div', { class: 'ro-task' },
              h('div', { class: 'ro-task-head' },
                h('b', { text: task.name || '未知成员' }),
                h('span', { class: 'ro-task-state', text: taskStateLabel(task) })
              ),
              h('div', { class: 'ro-task-text', text: task.text || '' }),
              task.result ? h('div', { class: 'ro-task-result', text: task.result }) : null
            ))
          )
        )
      } else if (msg.kind === 'agent') {
        body.append(h('div', { class: 'ro-md md' }))
        body.lastElementChild.innerHTML = md(msg.text || '')
        enhanceMarkdownImages(body.lastElementChild)
        enhanceMarkdown(body.lastElementChild)
      } else {
        body.append(h('div', { class: 'ro-text', text: msg.text || '' }))
      }

      if (msg.files && msg.files.length) {
        body.append(h('div', { class: 'ro-section-label', text: '附件' }), attachmentRow(msg.files, { msg }))
      }

      body.append(h('div', { class: 'btn-row', style: { marginTop: '16px', flexWrap: 'wrap' } },
        h('button', { class: 'btn ghost', onclick: () => copyToClipboard(fullText(msg)) }, '复制内容'),
        msg.kind === 'user'
          ? h('button', { class: 'btn ghost', onclick: () => { closeModal(); editQuestion(msg.id) } }, '修改提问')
          : null,
        h('button', { class: 'btn ghost', style: { marginLeft: 'auto' }, onclick: () => closeModal() }, '关闭')
      ))
    }
  })
}

async function editQuestion (msgId) {
  if (state.busy) { toast('协作进行中，暂时不能修改提问', 'err'); return false }
  const msg = findMsg(msgId)
  if (!msg || msg.kind !== 'user') return false
  const tail = state.messages.length - state.messages.indexOf(msg) - 1
  const ok = await confirmAction({
    title: '修改这条提问？',
    message: `修改提问会先撤回这条提问，并删除之后同线程的 ${tail} 条回复/任务，然后把原文放回输入框。继续？`,
    confirmText: '继续修改',
    danger: true
  })
  if (!ok) return false
  const text = msg.text || ''
  const files = (msg.files || []).map((file) => ({
    name: file.name,
    path: file.path || '',
    size: file.size || 0,
    text: typeof file.text === 'string' ? file.text : null
  }))
  const removed = withdrawMessage(msg.id)
  if (!removed) return false
  bus.emit('composer:edit-question', { text, files })
  toast('提问已撤回，请在输入框修改后重新发送', 'ok')
  return true
}

export function openTaskViewer (planMsg, task) {
  openModal({
    title: '查看任务',
    sub: '只读视图 · 原始任务不会被修改',
    width: 700,
    render: (body) => {
      body.append(
        h('div', { class: 'ro-meta' },
          h('span', { class: 'ro-role', text: planMsg.name || '派单' }),
          h('span', { text: task.name || '未知成员' }),
          h('span', { class: 'ro-task-state', text: taskStateLabel(task) }),
          h('span', { class: 'ro-readonly', text: '只读' })
        ),
        h('div', { class: 'ro-section-label', text: '任务指令' }),
        h('div', { class: 'ro-text', text: task.text || '' }),
        task.result ? h('div', { class: 'ro-section-label', text: '结果' }) : null,
        task.result ? h('div', { class: 'ro-text', text: task.result }) : null,
        h('div', { class: 'btn-row', style: { marginTop: '16px', flexWrap: 'wrap' } },
          h('button', { class: 'btn ghost', onclick: () => copyToClipboard(task.text || '', '任务指令已复制') }, '复制指令'),
          h('button', { class: 'btn ghost', onclick: () => { closeModal(); openTaskCopyEditor(planMsg, task) } }, '创建任务副本并编辑'),
          h('button', { class: 'btn ghost', style: { marginLeft: 'auto' }, onclick: () => closeModal() }, '关闭')
        )
      )
    }
  })
}

export function openTaskCopyEditor (planMsg, task) {
  openModal({
    title: '编辑任务副本',
    sub: '原始任务保持不变 · 副本会追加到同一派单并单独执行',
    width: 700,
    render: (body) => {
      const area = h('textarea', { class: 'textarea', style: { minHeight: '190px' } })
      area.value = task.text || ''
      body.append(
        h('div', { class: 'ro-meta' },
          h('span', { class: 'ro-role', text: planMsg.name || '派单' }),
          h('span', { text: `交给 ${task.name || '成员'}` }),
          h('span', { class: 'ro-readonly', text: '原任务不变' })
        ),
        field('任务副本指令', area, '保存后会在同一派单里追加一个新任务，原任务和原结果不会被覆盖。'),
        h('div', { class: 'btn-row', style: { marginTop: '16px' } },
          h('button', { class: 'btn-primary', onclick: async () => {
            const text = area.value.trim()
            if (!text) { toast('任务指令不能为空', 'err'); return }
            closeModal()
            const res = await copyPlanTask(planMsg.id, task.id, text)
            if (res && res.ok === false) toast(res.error || '任务副本执行失败', 'err')
            else toast('任务副本已追加并开始执行', 'ok')
          } }, '创建副本并执行'),
          h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消')
        )
      )
    }
  })
}

function actionButton (label, title, onClick, className = '') {
  return h('button', {
    class: 'msg-action' + (className ? ' ' + className : ''),
    type: 'button',
    title,
    onclick: (e) => { e.stopPropagation(); onClick() },
    ondblclick: (e) => e.stopPropagation()
  }, label)
}

/* ------------------------------------------------- 用时与用量 */

function formatDuration (ms) {
  const value = Math.max(0, Number(ms) || 0)
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`
  const minutes = Math.floor(value / 60000)
  const seconds = Math.round((value % 60000) / 1000)
  return seconds ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`
}

function formatTokenCount (value) {
  const n = Math.max(0, Number(value) || 0)
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function formatBytes (bytes) {
  const n = Math.max(0, Number(bytes) || 0)
  if (n < 1024) return `${Math.round(n)}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function formatRate (bytes, ms) {
  const n = Math.max(0, Number(bytes) || 0)
  const seconds = Number(ms) / 1000
  if (!n || !(seconds > 0.05)) return ''
  const rate = n / seconds
  if (rate >= 1024 * 1024) return `${(rate / 1024 / 1024).toFixed(1)}MB/s`
  if (rate >= 1024) return `${(rate / 1024).toFixed(rate >= 10240 ? 0 : 1)}KB/s`
  return `${Math.round(rate)}B/s`
}

function formatCount (value) {
  return Math.round(Math.max(0, Number(value) || 0)).toLocaleString('zh-CN')
}

function statItem (text, title, extra = '') {
  return h('span', {
    class: 'msg-stat' + (extra ? ` ${extra}` : ''),
    title,
    text
  })
}

function messageStatsNode (msg) {
  const stats = msg && msg.meta && msg.meta.stats
  if (!stats) return null

  const box = h('div', { class: 'msg-stats' })

  const duration = formatDuration(stats.ms)
  const first = stats.firstTokenMs ? `，首字 ${formatDuration(stats.firstTokenMs)}` : ''
  box.append(statItem(duration, `本次响应 ${duration}${first}（含重试与工具往返）`))

  const tokens = stats.tokens || {}
  const approx = tokens.reported ? '' : '~'
  const tokenTitle = tokens.reported
    ? `供应商上报：输入 ${formatCount(tokens.input)} · 输出 ${formatCount(tokens.output)}`
    : `按字符估算（CJK 1 字≈1 token，其他约 4 字符≈1 token）：输入 ${formatCount(tokens.input)} · 输出 ${formatCount(tokens.output)}`
  box.append(statItem(`${approx}${formatTokenCount(tokens.total)} tok`, tokenTitle))

  const rate = formatRate(stats.bytes, stats.streamMs)
  if (rate) {
    box.append(statItem(rate, `正文流式 ${formatBytes(stats.bytes)} / ${formatDuration(stats.streamMs)}，不含等待首字与工具执行`))
  }

  if (stats.model) {
    box.append(statItem(stats.model, `模型：${stats.model}${stats.provider ? ` · ${stats.provider}` : ''}`, 'model'))
  }

  const thinking = stats.thinking
  if (thinking) {
    const label = thinking.label || '—'
    const source = thinking.source === 'api' ? '模型声明' : '按模型名推断'
    const detail = thinking.mode === 'none'
      ? `档位 ${label}：该模型不映射思考参数，只影响协作深度与轮次`
      : `${thinking.mode === 'budget' ? 'thinking.budget_tokens' : 'reasoning effort'} · ${label}${thinking.param != null ? `（${thinking.param}）` : ''} · 来源：${source}`
    box.append(statItem(`思考 ${label}`, detail))
  }

  return box
}

/* 释放上下文：这条不再发给模型（界面保留、可恢复）。
   与「撤回」不同：不删历史；与预算压缩不同：连摘要都不带。 */
function releaseButton (msg) {
  if (msg.contextHidden) {
    return actionButton('已压缩', '完整记录仅供查看；需要让智能体看原文，请用「引用原文」', () => {}, 'release-on')
  }
  const released = () => Boolean(msg.ctxReleased)
  const paint = (btn) => {
    const on = released()
    btn.textContent = on ? '恢复' : '释放'
    btn.title = on
      ? '这条已不占用上下文；点恢复后下一轮重新发给模型'
      : '释放上下文：这条不再发给模型，界面保留、可随时恢复'
    btn.classList.toggle('release-on', on)
  }
  const btn = actionButton(released() ? '恢复' : '释放', '', async () => {
    toggleContextRelease(msg)
    bus.emit('message:update', { id: msg.id, patch: { ctxReleased: Boolean(msg.ctxReleased) } })
    bus.emit('context:released')
    toast(msg.ctxReleased ? '已释放：下一轮起不再发给模型' : '已恢复：下一轮重新带上这条', 'ok')
    paint(btn)
    try {
      if (msg.thread === 'super' || superChatActive()) saveSuperHistoryNow()
      else await saveProjectSessionNow()
    } catch { /* 存档失败时本次内存选择仍生效 */ }
  }, 'release')
  paint(btn)
  return btn
}

/* 气泡右键：优先按编号回查数据库原文；数据库不可用时回退当前会话副本。
   只把原文放进输入框，不改动消息、不自动恢复上下文。 */
async function quoteOriginalForTarget (msg) {
  const input = document.querySelector('#input')
  if (!input || !msg) return
  let text = String(msg.text || '').trim()
  if (msg.code && window.astral && window.astral.messageGet) {
    try {
      const res = await window.astral.messageGet({ code: msg.code })
      if (res && res.ok && res.data && res.data.text) text = String(res.data.text).trim()
    } catch { /* 回退当前副本 */ }
  }
  if (!text) return
  const block = `【引用原文${msg.code ? ` · ${msg.code}` : ''}】\n${text}`
  input.value = [String(input.value || '').trim(), block].filter(Boolean).join('\n\n')
  input.focus()
  toast(msg.code ? `已按 ${msg.code} 引用原文` : '已引用原文；发送后会交给当前对话', 'ok')
}

let contextMenu = null
function closeContextMenu () {
  if (contextMenu) { contextMenu.remove(); contextMenu = null }
}

async function messageOriginalForMenu (msg) {
  let text = String((msg && msg.text) || '').trim()
  if (msg && msg.code && window.astral && window.astral.messageGet) {
    try {
      const res = await window.astral.messageGet({ code: msg.code })
      if (res && res.ok && res.data && res.data.text) text = String(res.data.text).trim()
    } catch { /* fallback */ }
  }
  return text
}

async function quoteToTarget (msg, target) {
  const text = await messageOriginalForMenu(msg)
  if (!text) { toast('没有可引用的原文', 'err'); return }
  if (target && target.kind === 'super') await enterSuperChat()
  const input = document.querySelector('#input')
  if (!input) return
  const prefix = target && target.kind === 'agent' && target.agent ? `@${target.agent.name}` : ''
  const header = msg.code ? `【引用原文 · ${msg.code}】` : '【引用原文】'
  const block = [prefix, header, text].filter(Boolean).join('\n')
  input.value = [String(input.value || '').trim(), block].filter(Boolean).join('\n\n')
  input.focus()
  closeContextMenu()
  toast(target && target.kind === 'super' ? '已引用给超级智能体' : (target && target.kind === 'agent' ? `已引用给 ${target.agent.name}` : '已引用给当前会话'), 'ok')
}

async function adjustDigestWeight (msg, delta) {
  if (!msg || !msg.code || !window.astral || !window.astral.messageWeight) return
  try {
    const list = await window.astral.messageDigests({ code: msg.code, limit: 1 })
    const row = list && list.ok && list.data ? list.data[0] : null
    if (!row) { toast('没有这个浓缩索引', 'err'); return }
    const current = typeof row.dynamic_weight === 'number' ? row.dynamic_weight : (row.total_weight || 0.5)
    const next = Math.max(0, Math.min(1, current + delta))
    await window.astral.messageWeight({ code: msg.code, dynamicWeight: next, dimensions: { feedback: delta > 0 ? 1 : -1 }, scorer: 'user-feedback' })
    toast(delta > 0 ? '已提高这条记忆的权重' : '已降低这条记忆的权重', 'ok')
  } catch (err) { toast(err.message || '权重调整失败', 'err') }
  closeContextMenu()
}

function openMessageContextMenu (event, msg) {
  closeContextMenu()
  const menu = h('div', {
    class: 'msg-context-menu',
    style: {
      left: `${Math.min(event.clientX, window.innerWidth - 260)}px`,
      top: `${Math.min(event.clientY, window.innerHeight - 360)}px`
    },
    onclick: (e) => e.stopPropagation()
  })
  const item = (label, hint, onClick, cls = '') => h('button', {
    class: 'msg-context-item' + (cls ? ' ' + cls : ''),
    type: 'button',
    onclick: onClick
  },
  h('span', { class: 'msg-context-label', text: label }),
  hint ? h('span', { class: 'msg-context-hint', text: hint }) : null
  )
  menu.append(
    h('div', { class: 'msg-context-head' },
      h('span', { class: 'msg-context-code', text: msg.code || '未编号' }),
      h('span', { text: msg.kind === 'user' ? '用户消息' : 'AI 回复' })
    ),
    item('查看原文', '只读完整内容', () => { closeContextMenu(); openMessageViewer(msg.id) }),
    item('复制原文', '复制未修改的完整文本', () => { closeContextMenu(); copyToClipboard(msg.text || '', '原文已复制') }),
    h('div', { class: 'msg-context-sep' }),
    item('引用给当前会话', '作为新消息发给当前对话', () => quoteToTarget(msg, { kind: 'current' })),
    item('引用给超级智能体', '切到超级智能体并带入原文', () => quoteToTarget(msg, { kind: 'super' }))
  )
  const agents = ((state.roster && state.roster.agents) || [])
    .filter((agent) => agent && agent.enabled !== false && agent.id !== state.activeAgentId)
    .slice(0, 6)
  if (agents.length) {
    menu.append(h('div', { class: 'msg-context-sep' }))
    menu.append(h('div', { class: 'msg-context-group', text: '引用给其他会话 / 成员' }))
    for (const agent of agents) {
      menu.append(item(agent.name, agent.title || '成员', () => quoteToTarget(msg, { kind: 'agent', agent })))
    }
  }
  menu.append(
    h('div', { class: 'msg-context-sep' }),
    item(msg.ctxReleased ? '恢复上下文' : '释放上下文', '只影响下一轮模型上下文', async () => {
      toggleContextRelease(msg)
      bus.emit('message:update', { id: msg.id, patch: { ctxReleased: Boolean(msg.ctxReleased) } })
      bus.emit('context:released')
      closeContextMenu()
      toast(msg.ctxReleased ? '已释放：下一轮起不再发给模型' : '已恢复：下一轮重新带上这条', 'ok')
      try {
        if (msg.thread === 'super' || superChatActive()) saveSuperHistoryNow()
        else await saveProjectSessionNow()
      } catch { /* 内存选择仍生效 */ }
    })
  )
  if (msg.code) {
    menu.append(
      item('标记有用', '提高这条记忆的权重', () => adjustDigestWeight(msg, 0.08)),
      item('标记无用', '降低这条记忆的权重', () => adjustDigestWeight(msg, -0.12))
    )
  }
  document.body.append(menu)
  contextMenu = menu
  setTimeout(() => {
    const close = (e) => {
      if (!menu.contains(e.target)) { closeContextMenu(); document.removeEventListener('pointerdown', close) }
    }
    document.addEventListener('pointerdown', close)
  }, 0)
}

export function attachMessageActions (node, msg) {
  if (!msg || msg.kind === 'system') return
  if (node) {
    node.addEventListener('contextmenu', (event) => {
      if (event.target.closest('button, a, input, textarea, select, .msg-actions')) return
      event.preventDefault()
      openMessageContextMenu(event, msg)
    })
  }
  /* 直连会话不参与协作编排：撤回、改写、重新生成都只对项目会话有意义，
     在这里给按钮只会让人以为能改动作，所以只留查看、复制、引用与释放。 */
  const direct = msg.thread === 'super'
  const bar = h('div', { class: 'msg-actions', onclick: (e) => e.stopPropagation() })
  bar.append(actionButton('查看', '只读查看完整内容', () => openMessageViewer(msg.id)))
  if (msg.kind === 'user') {
    bar.append(actionButton('复制', '复制消息文本', () => copyToClipboard(msg.text || '', '消息已复制')))
    if (direct) {
      bar.append(
        actionButton('引用原文', '把这条原文作为新消息引用给当前对话', () => quoteOriginalForTarget(msg)),
        releaseButton(msg)
      )
      node.append(bar)
      return
    }
    bar.append(
      actionButton('引用原文', '把这条原文作为新消息引用给当前对话', () => quoteOriginalForTarget(msg)),
      releaseButton(msg),
      actionButton('修改提问', '撤回这条提问及后续回复，再把原文放回输入框修改', () => editQuestion(msg.id)),
      actionButton('撤回', '删除这条消息及之后同线程的回复/任务', async () => {
        if (state.busy) { toast('协作进行中，暂时不能撤回', 'err'); return }
        const tail = state.messages.length - state.messages.indexOf(msg) - 1
        const ok = await confirmAction({
          title: '撤回这条消息？',
          message: `会删除之后同线程的 ${tail} 条回复/任务，此操作不可撤销。`,
          confirmText: '撤回',
          danger: true
        })
        if (!ok) return
        const count = withdrawMessage(msg.id)
        if (count) toast(`已撤回 ${count} 条记录`, 'ok')
      }, 'danger')
    )
  } else if (msg.kind === 'agent') {
    bar.append(actionButton('复制', '复制原始回复（Markdown）', () => copyToClipboard(msg.text || '', '回复已复制')))
    bar.append(actionButton('引用原文', '把这条回复原文作为新消息引用给当前对话', () => quoteOriginalForTarget(msg)))
    bar.append(releaseButton(msg))
    if (msg.channel === 'user' && !direct) {
      bar.append(actionButton('重新生成', '重新生成最新一轮回复；保留用户消息与附件', () => {
        if (!canRegenerate(msg.id)) {
          toast('只能重新生成最新一条 AI 回复', 'err')
          return
        }
        regenerateLatest(msg.thread)
      }))
    }
  } else if (msg.kind === 'plan') {
    bar.append(actionButton('复制', '复制派单摘要与任务', () => copyToClipboard(fullText(msg), '派单内容已复制')))
  }
  /* 只有模型回复带用量；用户消息与派单没有单次调用可言 */
  if (msg.kind === 'agent') {
    const stats = messageStatsNode(msg)
    if (stats) bar.append(stats)
  }
  node.append(bar)
}

/* 回复收口时补统计：消息节点是复用的，不能靠整条重绘把这一行刷出来 */
bus.on('message:stats', ({ id } = {}) => {
  const msg = findMsg(id)
  if (!msg) return
  const escaped = window.CSS && CSS.escape ? CSS.escape(String(id)) : String(id)
  const node = document.querySelector(`.msg[data-id="${escaped}"]`)
  const bar = node && node.querySelector('.msg-actions')
  if (!bar) return
  const old = bar.querySelector('.msg-stats')
  if (old) old.remove()
  const stats = messageStatsNode(msg)
  if (stats) bar.append(stats)
})

export function attachPlanTaskActions (row, planMsg, task) {
  const box = h('div', { class: 'plan-task-actions', onclick: (e) => e.stopPropagation() })
  box.append(
    actionButton('查看', '只读查看任务详情', () => openTaskViewer(planMsg, task)),
    actionButton('复制', '复制任务完整指令', () => copyToClipboard(task.text || '', '任务指令已复制')),
    actionButton('重新编辑', '创建任务副本；原任务不变', () => openTaskCopyEditor(planMsg, task))
  )
  row.append(box)
}

