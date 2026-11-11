/* chat.js — 消息流渲染与输入区 */

import { state, bus, $, h, md, timeLabel, toast, commander, avatarNode, messagesOf, migrateToolLog, stripSummaryMarker, persist, conversationIsTeam, soloAgent, superChatActive, superMessages, findMsg } from './core.js'
import { submit, cancelCurrentTurn } from './orchestrator.js'
import { ROLE_LABEL } from './llm.js'
import { mountToolbar } from './toolbar.js'
import { playViewTransition } from './wintransition.js'
import { openMemberProfile } from './roster.js'
import { currentView, isReadonlyView, agentEmptyNode } from './viewswitch.js'
import { superSend, superEmptyNode, superProfile } from './superagent.js'
import { icon } from './icons.js'
import { normalizeFoldMessages } from './fold-state.js'
import { openArchive } from './renew.js'
import { isGuest } from './roles.js'
import { formatTokenCount } from './contextmeter.js'
import { createInlineAsk } from './ask-inline.js'
import { confirmAction } from './confirm.js'
import { baseName } from './filepreview.js'
import { openPreview } from './dock.js'
import { pluginModeOn, pluginPlaceholder } from './plugin-mode.js'
import { createImageThumb, enhanceMarkdownImages, isImageFile } from './imagepreview.js'
import { enhanceMarkdown } from './rich-markdown.js'
import {
  attachMessageActions, attachPlanTaskActions, openMessageViewer, attachmentRow
} from './message-actions.js'

const nodes = new Map()
const dirty = new Set()
let frame = null
let autoScroll = true

function streamEl () { return $('#stream') }

function nearBottom () {
  const el = streamEl()
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140
}

function pinScroll () {
  const el = streamEl()
  if (!el) return
  if (autoScroll) el.scrollTop = el.scrollHeight
}

/* ------------------------------------------------------------ 状态气泡

   仿编程助手的运行态提示：平时是一条带呼吸点的文字，思考阶段换成
   与输入区思考条一致的星空粒子（横向流动），回复阶段回到文字。
   它只是一个临时节点，不进 state.messages，也不参与存档。 */

let statusNode = null
let statusText = ''
let statusStars = null
let statusWantStars = false
let orchestrationBusy = false
const busyAgents = new Set()
let activeAsk = null

function stopStatusStars () {
  if (statusStars) {
    statusStars()
    statusStars = null
  }
}

/* 横向星流：一条等宽的粒子带，整体缓慢向右流动。
   粒子按格点铺满整条带后同速漂移，密度与带宽恒定，
   视觉上像一条缓慢流动的河，而不是从某点喷出的火。 */
function mountStatusStars (canvas) {
  const ctx = canvas.getContext('2d')
  const SPEED = 10            // px/s：更慢的漂移节奏
  const CELL = 11             // 格点间距：间距越大粒子越少
  let width = 0
  let height = 0
  let particles = []
  let raf = 0
  let lastT = 0

  /* 格点铺满整个文字行：密度均匀，且纵向恰好占满带高 */
  const refill = () => {
    const cols = Math.max(4, Math.round(width / CELL))
    const rows = Math.max(2, Math.round(height / CELL))
    const stepX = width / cols
    const stepY = height / rows
    const list = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        list.push({
          x: c * stepX + (Math.random() - 0.5) * stepX * 0.7,
          y: (r + 0.5) * stepY + (Math.random() - 0.5) * stepY * 0.34,
          r: 0.4 + Math.random() * 0.8,
          hot: Math.random() > 0.34,
          phase: Math.random() * Math.PI * 2,
          twinkle: 0.6 + Math.random() * 1.6
        })
      }
    }
    particles = list
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
    refill()
  }

  const paintStatic = () => {
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = 'rgba(200, 240, 255, 0.55)'
    for (const p of particles) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const frame = (time) => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(64, time - lastT) / 1000
    lastT = time
    if (!width || !height) return
    if (document.body.classList.contains('reduced-motion')) { paintStatic(); return }

    ctx.clearRect(0, 0, width, height)

    for (const p of particles) {
      /* 同速漂移 + 极轻的个体摆动：密度不会聚成团，也不会显得机械 */
      p.x += SPEED * dt
      if (p.x > width) p.x -= width
      const x = p.x + Math.sin(time * 0.00045 * p.twinkle + p.phase) * 2

      /* 两端淡入淡出：右边界就在文字末尾，粒子到此处即消失 */
      const fade = Math.min(14, width * 0.16)
      const edge = Math.min(1, x / fade, (width - x) / fade)
      if (edge <= 0) continue
      const twinkle = 0.74 + 0.26 * Math.sin(time * 0.0009 * p.twinkle + p.phase)
      const alpha = edge * twinkle * 0.9

      ctx.globalAlpha = alpha
      ctx.fillStyle = p.hot ? '#f2fbff' : '#9fe9ff'
      ctx.beginPath()
      ctx.arc(x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  resize()
  lastT = performance.now()
  raf = requestAnimationFrame(frame)
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  /* 调试钩子：便于采样粒子分布（与场景星野的 __sceneStars 一致） */
  canvas.__statusStars = () => particles.map((p) => ({ x: p.x, y: p.y, vx: SPEED }))
  return () => {
    cancelAnimationFrame(raf)
    observer.disconnect()
  }
}

function ensureStatusNode () {
  const el = streamEl()
  if (!el) return null
  if (!statusNode || !statusNode.isConnected) {
    statusNode = h('div', { class: 'stream-status', role: 'status', 'aria-live': 'polite' })
    el.append(statusNode)
  }
  return statusNode
}

function setStatus (text, stars = false) {
  if (!text) return clearStatus()
  const node = ensureStatusNode()
  if (!node) return
  if (text === statusText && stars === statusWantStars && node.childElementCount) return

  statusText = text
  statusWantStars = stars
  const head = h('div', { class: 'status-head' },
    h('i', { class: 'status-pulse', 'aria-hidden': 'true' }),
    h('span', { class: 'status-text', text })
  )
  node.textContent = ''
  node.append(head)
  stopStatusStars()
  if (stars) {
    /* 粒子带只铺满这一行文字：文字结束处即为右边界，随即淡出 */
    const canvas = h('canvas', { class: 'status-stars', 'aria-hidden': 'true' })
    head.prepend(canvas)
    statusStars = mountStatusStars(canvas)
  }
  streamEl().append(node)
  pinScroll()
}

function clearStatus () {
  statusText = ''
  statusWantStars = false
  stopStatusStars()
  if (statusNode) statusNode.remove()
  statusNode = null
  busyAgents.clear()
}

function agentLabel (id) {
  const agent = state.roster.agents.find((a) => a.id === id)
  return agent ? (agent.short || agent.name) : '成员'
}

const scheduleRender = (id) => {
  dirty.add(id)
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = null
    let scroll = false
    for (const key of dirty) {
      renderBody(key)
      /* 只有落在当前视图里的消息才驱动滚动，
         否则另一条线的流式输出会把用户正在看的位置拽走 */
      const msg = findMsg(key)
      if (msg && msg.channel === currentView()) scroll = true
      if (msg && msg.kind !== 'tool') applyFoldState(msg)
    }
    dirty.clear()
    if (scroll) pinScroll()
  })
}

/* ------------------------------------------------------- 手动折叠 */

function truncated (text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function findFoldParent (msg) {
  const list = viewMessages()
  const index = list.findIndex((item) => item.id === msg.id)
  for (let i = index - 1; i >= 0; i--) {
    if (list[i].kind !== 'tool') return list[i]
  }
  return null
}

function toolContainerFor (parentNode) {
  let box = parentNode.querySelector(':scope > .msg-tools')
  if (box) return box
  box = h('div', { class: 'msg-tools' })
  const bar = parentNode.querySelector(':scope > .msg-fold-bar')
  if (bar) parentNode.insertBefore(box, bar)
  else parentNode.append(box)
  return box
}

/* 最近 3 条非工具消息强制展开；第 4 条起默认折叠，手动展开的保持。 */
function normalizeFoldState (list) {
  normalizeFoldMessages(list, 3)
}

function syncFoldStates () {
  const list = viewMessages()
  normalizeFoldState(list)
  for (const msg of list) {
    /* 交接卡片用 handoffFolded，不套用通用折叠类（那会隐藏整张卡片） */
    if (msg.kind !== 'tool' && msg.kind !== 'handoff') applyFoldState(msg)
  }
}

function applyFoldState (input) {
  const msg = typeof input === 'string'
    ? findMsg(input)
    : input
  if (!msg) return
  const node = nodes.get(msg.id)
  if (!node) return
  const folded = Boolean(msg.folded && !msg.streaming)
  node.classList.toggle('folded', folded)
  node.classList.toggle('fold-pinned', msg.foldPinned === true)
  const bar = node.querySelector('.msg-fold-bar')
  if (bar) {
    bar.setAttribute('aria-expanded', String(!folded))
    const text = bar.querySelector('.msg-fold-bar-text')
    if (text) text.textContent = truncated(msg.summary || '（无内容）', 160)
  }
  const toggle = node.querySelector('.msg-fold-toggle')
  if (toggle) {
    toggle.textContent = folded ? '⌄' : '⌃'
    toggle.title = folded ? '展开消息' : '折叠消息'
    toggle.setAttribute('aria-expanded', String(!folded))
    toggle.hidden = false
    toggle.disabled = false
  }
}

function toggleFold (id) {
  const msg = findMsg(id)
  if (!msg) return
  msg.folded = msg.streaming ? false : !msg.folded
  msg.foldManual = true
  applyFoldState(msg)
  persist.session()
}

function foldIdentity (msg) {
  if (msg.kind === 'user') {
    const profile = state.settings.profile || {}
    return {
      owner: profile,
      name: profile.name || '我',
      title: profile.short || '你',
      color: profile.color || 'var(--accent)'
    }
  }
  if (msg.kind === 'system') {
    return { owner: { glyph: '✧' }, name: '系统', title: '', color: 'var(--fg-2)' }
  }
  const live = msg.agentId ? state.roster.agents.find((agent) => agent.id === msg.agentId) : null
  const who = live || msg
  return {
    owner: who,
    name: who.short || who.name || '成员',
    /* 单独会话没有职位，消息折叠条上也不显示 */
    title: conversationIsTeam() ? (who.title || ROLE_LABEL[msg.role] || '') : '',
    color: who.color || 'var(--accent)'
  }
}

function paintFoldIdentity (bar, msg) {
  const person = bar.querySelector('.msg-fold-person')
  if (!person) return
  const info = foldIdentity(msg)
  const avatar = avatarNode(info.owner, 22, 'msg-fold-avatar')
  avatar.style.color = info.color
  const previous = person.querySelector('.msg-fold-avatar')
  if (previous) previous.replaceWith(avatar)
  else person.prepend(avatar)
  const name = person.querySelector('.msg-fold-name')
  const title = person.querySelector('.msg-fold-title')
  if (name) {
    name.textContent = info.name
    name.style.color = info.color
  }
  if (title) title.textContent = info.title
}

function attachFoldChrome (node, msg) {
  const bar = h('div', {
    class: 'msg-fold-bar',
    role: 'button',
    tabindex: '0',
    'aria-expanded': 'true',
    onclick: () => toggleFold(msg.id),
    onkeydown: (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggleFold(msg.id)
    }
  },
  h('span', { class: 'msg-fold-person' },
    h('span', { class: 'msg-fold-who' },
      h('span', { class: 'msg-fold-name' }),
      h('span', { class: 'msg-fold-title' })
    )
  ),
  h('span', { class: 'msg-fold-bar-label', text: '已折叠' }),
  h('span', { class: 'msg-fold-bar-text' }),
  h('span', { class: 'msg-fold-bar-hint', text: '点击展开' })
  )
  const toggle = h('button', {
    class: 'msg-fold-toggle',
    type: 'button',
    title: '折叠/展开消息',
    'aria-expanded': 'true',
    onclick: (event) => {
      event.stopPropagation()
      toggleFold(msg.id)
    }
  }, '⌃')
  node.append(bar, toggle)
  paintFoldIdentity(bar, msg)
  applyFoldState(msg)
}

/* 交接卡片的折叠只作用于卡片内部：保留标题、时间和一行摘要，
   不用通用 .msg.folded（那条规则会把整张卡片一起隐藏）。 */
function applyHandoffFold (card, toggle, msg) {
  const folded = Boolean(msg.handoffFolded)
  card.classList.toggle('is-collapsed', folded)
  toggle.textContent = folded ? '⌄' : '⌃'
  toggle.title = folded ? '展开摘要' : '折叠摘要'
  toggle.setAttribute('aria-label', folded ? '展开摘要' : '折叠摘要')
  toggle.setAttribute('aria-expanded', String(!folded))
}

/* 革新后的交接卡片：它是新会话里唯一的历史，不是普通回复，
   所以单独一种消息类型，样式上也要和对话气泡区分开。 */
function createHandoffNode (msg) {
  const live = msg.agentId ? state.roster.agents.find((a) => a.id === msg.agentId) : null
  const who = live || msg
  const color = who.color || 'var(--accent)'
  const meta = msg.meta || {}
  const folded = Boolean(msg.handoffFolded)
  const preview = String(msg.summary || msg.text || '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  const previewText = preview.length > 96 ? `${preview.slice(0, 96)}…` : preview

  const toggle = h('button', {
    class: 'msg-fold-toggle',
    type: 'button',
    'aria-expanded': String(!folded),
    'aria-label': folded ? '展开摘要' : '折叠摘要',
    title: folded ? '展开摘要' : '折叠摘要',
    onclick: (event) => {
      event.stopPropagation()
      msg.handoffFolded = !msg.handoffFolded
      applyHandoffFold(card, toggle, msg)
      persist.session()
    }
  }, folded ? '⌄' : '⌃')

  const card = h('div', { class: 'handoff-card' + (folded ? ' is-collapsed' : '') },
    h('div', { class: 'handoff-head' },
      h('div', { class: 'handoff-kicker' }, icon('chip', 13), h('span', { text: '会话交接' })),
      h('span', { class: 'handoff-time', text: timeLabel(msg.ts) })
    ),
    h('div', {
      class: 'handoff-meta',
      text: `已归档 ${meta.count || 0} 条消息 · 上一段约 ${formatTokenCount(meta.tokens || 0)} tokens · 新会话上下文从 0 开始`
    }),
    h('div', { class: 'handoff-preview', text: previewText }),
    h('div', { class: 'md handoff-md' }),
    h('div', { class: 'handoff-actions' },
      h('button', {
        class: 'msg-action',
        type: 'button',
        onclick: () => {
          navigator.clipboard.writeText(msg.text || '').then(
            () => toast('交接摘要已复制', 'ok'),
            () => toast('复制失败', 'err')
          )
        }
      }, '复制摘要'),
      meta.archiveId
        ? h('button', {
            class: 'msg-action',
            type: 'button',
            onclick: () => openArchive(meta.archiveId)
          }, '查看上一段会话')
        : null
    )
  )
  const node = h('article', {
    class: 'msg handoff',
    dataset: { id: msg.id },
    style: { '--msg-color': color }
  }, head(msg), card)
  /* 折叠提示与普通消息的「点击展开」保持一致，折叠时出现在卡片底部 */
  const hint = h('button', {
    class: 'handoff-fold-hint',
    type: 'button',
    onclick: (event) => {
      event.stopPropagation()
      msg.handoffFolded = false
      applyHandoffFold(card, toggle, msg)
      persist.session()
    }
  }, '点击展开')
  card.append(toggle, hint)
  const mdEl = card.querySelector('.handoff-md')
  mdEl.innerHTML = md(msg.text || '')
  enhanceMarkdownImages(mdEl)
  enhanceMarkdown(mdEl)
  linkifyFilePaths(mdEl)
  return node
}

function head (msg) {
  /* 头像/简称/配色都实时取编制里的成员，避免历史消息冻结旧头像 */
  const live = msg.agentId ? state.roster.agents.find((a) => a.id === msg.agentId) : null
  const who = live || msg
  const ava = avatarNode(who, 34, 'msg-ava')
  if (msg.streaming) ava.classList.add('busy')
  /* 职位只在团队会话里显示；单独会话就是一条人机对话，没有职级 */
  const teamMode = conversationIsTeam()
  const roleTitle = teamMode ? msg.title : ''

  return h('header', { class: 'msg-head' },
    ava,
    h('span', { class: 'name', text: who.short || who.name, style: { color: who.color } }),
    roleTitle ? h('span', { class: 'title', text: roleTitle }) : null,
    roleTitle ? h('span', { class: 'sep', text: '·' }) : null,
    h('span', { class: 'model', text: msg.meta && msg.meta.model ? msg.meta.model : (teamMode ? ROLE_LABEL[msg.role] || '' : '') }),
    h('span', { class: 'sep', text: '·' }),
    h('span', { class: 'time', text: timeLabel(msg.ts) })
  )
}

function renderBody (id) {
  const msg = findMsg(id)
  const node = nodes.get(id)
  if (!msg || !node) return

  if (msg.kind === 'user') {
    node.querySelectorAll(':scope > .user-head, :scope > .user-body, :scope > .msg-actions').forEach((child) => child.remove())
    const profile = state.settings.profile || {}
    const body = h('div', { class: 'user-body' },
      h('div', { class: 'user-text', text: msg.text })
    )
    const attachments = attachmentRow(msg.files, { msg })
    if (attachments) body.append(attachments)
    node.append(
      h('div', { class: 'user-head' },
        h('div', { class: 'user-id' },
          h('div', { class: 'user-line' },
            h('span', { class: 'u-short', text: profile.short || '你' }),
            h('span', { class: 'u-name', text: profile.name || '我' })
          ),
          h('div', { class: 'u-time', text: timeLabel(msg.ts) })
        ),
        avatarNode(profile, 34, 'user-ava')
      ),
      body
    )
    attachMessageActions(node, msg)
    return
  }

  if (msg.kind === 'system') {
    /* 旧格式的工具记录已经渲染成折叠组件，别再把它写回纯文本 */
    if (/^🔧/.test(String(msg.text || ''))) return
    let text = node.querySelector(':scope > .system-text')
    if (!text) {
      text = h('span', { class: 'system-text' })
      node.prepend(text)
    }
    text.textContent = msg.text
    return
  }

  /* 工具记录的展开/折叠由自身按钮管理，不参与流式重绘；
     交接卡片在创建时已经填好，也不走正文重绘 */
  if (msg.kind === 'tool' || msg.kind === 'handoff') return

  if (msg.kind === 'plan') {
    renderPlan(node, msg)
    return
  }

  const mdEl = node.querySelector('.md')
  if (mdEl) {
    const raw = msg.text || ''
    const streamingPlan = Boolean(msg.streaming &&
      /<astral:plan>/i.test(raw) && !/<\/astral:plan>/i.test(raw))
    let display = stripPlanText(stripSummaryMarker(raw))
    if (streamingPlan) {
      mdEl.innerHTML = '<p class="md-pending">正在编排任务…</p>'
    } else {
      if (!display && msg.interrupted) display = '本轮已中断'
      mdEl.innerHTML = display ? md(display) : ''
      enhanceMarkdownImages(mdEl)
      enhanceMarkdown(mdEl)
      linkifyFilePaths(mdEl)
    }
  }
  let note = node.querySelector('.msg-note')
  if (!note) {
    note = h('div', { class: 'msg-note', hidden: true })
    const body = node.querySelector('.msg-body')
    if (body) body.append(note)
  }
  const noteText = msg.interrupted
    ? '本轮已中断'
    : (msg.error ? '调用失败' : '')
  note.hidden = !noteText
  note.textContent = noteText
  node.classList.toggle('error', Boolean(msg.error))
  node.classList.toggle('interrupted', Boolean(msg.interrupted))
  node.classList.toggle('streaming', Boolean(msg.streaming))
}

/* 把消息里的绝对路径变成可点击的文件项：点一下就在右侧预览栏打开。
   路径允许含空格与中文目录（C://Astral Realm\…），靠「扩展名 + 其后是边界」判断结束。 */
const PATH_START = /[A-Za-z]:[\\/]/g
const PATH_BOUNDARY = /[\s，。、；：！？）】」』（【「『"'`)\]}>.,;:!?]/

function readPath (text, start) {
  let best = ''
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n' || ch === '<' || ch === '>' || ch === '"' || ch === '`' || ch === '|') break
    if (/[，。、；：！？）】」』（【「『]/.test(ch)) break
    best += ch
    if (best.length < 5) continue
    if (!/\.[A-Za-z0-9]{1,8}$/.test(best)) continue
    const next = text[i + 1]
    if (next === undefined) return best
    /* 点号后面紧跟字母数字时不算边界（区分 a.txt 与 a.txt.bak） */
    if (next === '.' && /[A-Za-z0-9]/.test(text[i + 2] || '')) continue
    if (PATH_BOUNDARY.test(next)) return best
  }
  return ''
}

function linkifyFilePaths (root) {
  if (!root) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('a, button, .file-path, pre, code, .md-diagram')) return NodeFilter.FILTER_REJECT
      return /[A-Za-z]:[\\/]/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    }
  })

  const targets = []
  while (walker.nextNode()) targets.push(walker.currentNode)

  for (const node of targets) {
    const text = node.nodeValue
    const frag = document.createDocumentFragment()
    let last = 0
    PATH_START.lastIndex = 0
    let match = PATH_START.exec(text)
    while (match) {
      const path = readPath(text, match.index)
      if (path) {
        if (match.index > last) frag.append(document.createTextNode(text.slice(last, match.index)))
        frag.append(h('button', {
          class: 'file-path',
          type: 'button',
          title: `在右侧预览 ${path}`,
          text: path,
          onclick: (event) => {
            event.stopPropagation()
            openPreview(path)
          }
        }))
        last = match.index + path.length
        PATH_START.lastIndex = last
      }
      match = PATH_START.exec(text)
    }
    if (!last) continue
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)))
    node.parentNode.replaceChild(frag, node)
  }
}

function stripPlanText (raw) {
  let display = String(raw || '').replace(/<astral:plan>[\s\S]*?<\/astral:plan>/gi, '')
  if (/<astral:plan>/i.test(display)) display = display.replace(/<astral:plan>[\s\S]*$/i, '')
  return display.trim()
}

function taskLabel (taskOrState) {
  const task = taskOrState && typeof taskOrState === 'object' ? taskOrState : { state: taskOrState }
  if (task.interrupted) return '中断'
  return { queued: '排队', running: '进行中', done: '已完成', error: '失败' }[task.state] || task.state || ''
}

function planStats (msg) {
  const tasks = msg.tasks || []
  const counts = { queued: 0, running: 0, done: 0, error: 0, interrupted: 0 }
  for (const task of tasks) {
    if (task.interrupted) counts.interrupted++
    if (counts[task.state] !== undefined) counts[task.state]++
  }
  const interrupted = Boolean(msg.interrupted) || counts.interrupted > 0
  let label = '排队中'
  let cls = 'is-queued'
  if (interrupted) { label = '已中断'; cls = 'is-interrupted' }
  else if (counts.error) { label = '部分失败'; cls = 'is-error' }
  else if (counts.running) { label = '进行中'; cls = 'is-running' }
  else if (tasks.length && counts.done === tasks.length) { label = '已完成'; cls = 'is-done' }
  return { tasks, counts, interrupted, label, cls, done: counts.done, total: tasks.length }
}

function renderPlan (node, msg) {
  const plan = node.querySelector('.plan')
  if (!plan) return
  const stats = planStats(msg)
  plan.textContent = ''
  plan.append(
    h('div', { class: 'plan-head' },
      h('span', { class: 'plan-title', text: `◈ 派单 · ${stats.total} 项` }),
      h('span', { class: `plan-status ${stats.cls}`, text: stats.label })
    ),
    h('div', { class: 'plan-brief', text: msg.brief || '' }),
    ...stats.tasks.map((task) => {
      const row = h('div', {
        class: 'plan-task' + (task.interrupted ? ' interrupted' : ''),
        dataset: { task: task.id, state: task.state },
        title: '双击查看任务完整内容'
      },
      h('span', { class: 'who', text: task.name, style: { '--task-color': task.color } }),
      h('span', { class: 'what', text: task.text }),
      h('span', { class: 'state', text: taskLabel(task) })
      )
      attachPlanTaskActions(row, msg, task)
      return row
    }),
    h('div', { class: 'plan-foot' },
      h('div', { class: 'plan-progress' },
        h('i', { style: { width: `${stats.total ? Math.round((stats.done / stats.total) * 100) : 0}%` } })
      ),
      h('span', { class: 'plan-progress-text', text: `已完成 ${stats.done} / ${stats.total}` })
    )
  )
}

function wireMessageDblClick (node, msg) {
  node.addEventListener('dblclick', (event) => {
    if (event.target.closest('button, a, input, textarea, select, .msg-actions, .plan-task-actions, .image-thumb, .md-image')) return
    event.preventDefault()
    const taskRow = event.target.closest('.plan-task')
    openMessageViewer(msg.id, taskRow ? taskRow.dataset.task : null)
  })
}

/* 从参数与结果里收集可预览的文件路径（有扩展名才算） */
function collectToolPaths (msg) {
  const out = []
  const seen = new Set()
  const add = (raw) => {
    const value = String(raw || '').trim().replace(/[）)，,。；;]+$/, '')
    if (!value || !/\.[A-Za-z0-9]{1,8}$/.test(value)) return
    const key = value.toLowerCase().replace(/\//g, '\\')
    if (seen.has(key)) return
    seen.add(key)
    out.push(value)
  }

  try {
    const args = JSON.parse(msg.args || '{}')
    for (const key of ['path', 'file', 'filePath', 'target', 'filename']) {
      if (typeof args[key] === 'string') add(args[key])
    }
  } catch { /* 参数不是 JSON 时只从结果文本里找 */ }

  const text = `${msg.detail || ''}\n${msg.args || ''}`
  for (const hit of text.match(/[A-Za-z]:\\[^\n\r"'<>|*?]+/g) || []) add(hit)
  for (const hit of text.match(/(?:^|\s)(\/[^\s"'<>|*?]+)/g) || []) add(hit)
  return out.slice(0, 4)
}

/* 工具调用：默认只留一行摘要，点开才看参数与完整结果。
   默认折叠是刻意的：一次协作可能调十几次工具，全展开会把对话冲掉。 */
function createToolNode (msg) {
  const stateText = msg.cancelled ? '已取消' : msg.timeout ? '超时' : msg.denied ? '已拒绝' : msg.ok ? '完成' : '失败'
  const cls = msg.cancelled || msg.timeout || msg.denied ? 'denied' : msg.ok ? 'ok' : 'err'

  const detail = h('div', { class: 'tool-detail', hidden: true })
  if (msg.args) {
    detail.append(
      h('div', { class: 'tool-section-title', text: '参数' }),
      h('pre', { class: 'tool-pre', text: msg.args })
    )
  }
  detail.append(
    h('div', { class: 'tool-section-title', text: '结果' }),
    h('pre', { class: 'tool-pre', text: msg.detail || msg.text || '（无返回内容）' })
  )

  /* 写文件类调用：给出可点击的文件项，点开直接预览改动结果。
     图片单独放到折叠区外面，截图结果不用展开就能看到。 */
  const paths = collectToolPaths(msg)
  const imagePaths = paths.filter((filePath) => isImageFile(filePath))
  const filePaths = paths.filter((filePath) => !isImageFile(filePath))
  if (filePaths.length) {
    detail.append(h('div', { class: 'tool-section-title', text: '文件' }))
    const row = h('div', { class: 'tool-files' })
    for (const filePath of filePaths) {
      row.append(h('button', {
        class: 'tool-file',
        type: 'button',
        title: `预览 ${filePath}`,
        onclick: (event) => {
          event.stopPropagation()
          openPreview(filePath)
        }
      },
      icon('file', 12),
      h('span', { text: baseName(filePath) })
      ))
    }
    detail.append(row)
  }

  const imageRow = imagePaths.length
    ? h('div', { class: 'tool-image-row' },
      ...imagePaths.map((filePath) => createImageThumb(filePath, {
        alt: baseName(filePath),
        className: 'tool-image-thumb'
      }))
    )
    : null

  const headBtn = h('button', {
    class: 'tool-head',
    type: 'button',
    'aria-expanded': 'false'
  },
  h('span', { class: 'tool-ico' }, icon('chip', 13)),
  h('span', { class: 'tool-label', text: msg.toolLabel || '工具调用' }),
  h('span', { class: `tool-state ${cls}`, text: stateText }),
  h('i', { class: 'tool-chevron', 'aria-hidden': 'true' })
  )

  const wrap = h('div', { class: 'msg tool-log', dataset: { id: msg.id } }, headBtn, imageRow, detail)
  headBtn.addEventListener('click', () => {
    const open = detail.hidden
    detail.hidden = !open
    headBtn.setAttribute('aria-expanded', String(open))
    wrap.classList.toggle('open', open)
  })
  return wrap
}

function createNode (msg) {
  let node
  const releasedCls = msg.ctxReleased ? ' released' : ''
  if (msg.kind === 'user') {
    node = h('article', { class: 'msg user' + releasedCls, dataset: { id: msg.id } })
  } else if (msg.kind === 'handoff') {
    node = createHandoffNode(msg)
  } else if (msg.kind === 'tool') {
    node = createToolNode(msg)
  } else if (msg.kind === 'system') {
    /* 旧存档里的工具记录没迁移到的（例如运行中残留）也按折叠展示 */
    node = /^🔧/.test(String(msg.text || ''))
      ? createToolNode(migrateToolLog(msg))
      : h('div', { class: 'msg system' })
  } else if (msg.kind === 'plan') {
    /* 协作区里要能一眼看出是谁派的单，所以派单卡补一个发言者头部 */
    const showHead = msg.channel === 'agent'
    node = h('article', { class: 'msg plan', dataset: { id: msg.id, depth: msg.depth || 0 } },
      showHead ? head(msg) : null,
      h('div', { class: 'plan' })
    )
    attachMessageActions(node, msg)
  } else {
    const live = msg.agentId ? state.roster.agents.find((a) => a.id === msg.agentId) : null
    const color = (live && live.color) || msg.color || 'var(--accent)'
    node = h('article', {
      class: 'msg agent' + releasedCls,
      dataset: { id: msg.id, depth: msg.depth || 0 },
      style: { '--msg-color': color }
    },
    head(msg),
    h('div', { class: 'msg-body' },
      h('div', { class: 'md' }),
      h('div', { class: 'msg-note', hidden: true })
    )
    )
    attachMessageActions(node, msg)
  }
  if (msg.kind !== 'system' && msg.kind !== 'tool') wireMessageDblClick(node, msg)
  /* 点击消息本身只聚焦，不打断按钮/输入；聚焦的区块即使滚出视口也保持展开。 */
  node.setAttribute('tabindex', '-1')
  node.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, a, input, textarea, select, .msg-actions, .tool-head')) return
    try { node.focus({ preventScroll: true }) } catch { /* ignore */ }
  })
  nodes.set(msg.id, node)
  if (msg.kind !== 'tool' && msg.kind !== 'handoff') attachFoldChrome(node, msg)
  return node
}

function clearEmpty () {
  const empty = $('#stream .stream-empty')
  if (empty) empty.remove()
}

function activeThread () {
  /* 直连会话只有一条线，和项目会话的线程完全隔开 */
  if (superChatActive()) return 'super'
  /* 单独会话只有一条线程：没点选时就是这条会话绑定的那一位。
     团队里没有总指挥的扁平编制落到第一个可用成员，不能固定成不存在的 'commander'。 */
  const fallback = conversationIsTeam() ? commander() : soloAgent()
  return state.activeAgentId || (fallback ? fallback.id : 'commander')
}

/* 当前视图能看到哪些消息：
   - 超级智能体：它自己的那条线，和项目消息互不相干
   - 用户 ↔ AI：本线程内、且只属于 user 通道
   - AI ↔ AI：所有 agent 通道消息，跨成员按时间顺序
   三者互不交叉，任一侧都取不到另一侧的一条消息。 */
function viewMessages () {
  if (superChatActive()) return superMessages()
  if (currentView() === 'agent') return messagesOf('agent')
  const thread = activeThread()
  return messagesOf('user').filter((m) => (m.thread || 'commander') === thread)
}

function showEmpty () {
  const el = streamEl()
  if (viewMessages().length) return
  if (superChatActive()) {
    el.append(superEmptyNode())
    return
  }
  if (currentView() === 'agent') {
    el.append(agentEmptyNode())
    return
  }
  if (!state.roster.agents.length) {
    el.append(h('div', { class: 'stream-empty' },
      h('div', { class: 'glyph' }, '✦'),
      h('h2', {}, '项目还没有成员'),
      h('p', { text: '当前项目没有可用成员。打开 设置 → 编制 添加 AI 成员；总指挥和副指挥都可以不设。' })
    ))
    return
  }
  const agent = state.roster.agents.find((a) => a.id === activeThread())
  const hasCommander = state.roster.agents.some((a) => a.role === 'commander' && a.enabled !== false)
  const solo = Boolean(agent) && !conversationIsTeam()
  const soloLabel = state.conversationMode === 'plugin' ? '插件制作会话' : '标准会话'
  el.append(h('div', { class: 'stream-empty' },
    h('div', { class: 'glyph' }, solo ? (agent.glyph || '✦') : '✦'),
    h('h2', {}, solo ? `与 ${agent.name} 的会话` : '编队就绪'),
    solo && agent.bio
      ? h('p', { class: 'solo-bio', text: agent.bio })
      : null,
    h('p', {
      text: solo
        ? `这是一条${soloLabel}，上下文只属于你和 ${agent.name}。直接提问即可，不会派单；需要多人协作时，明确说「组建团队」或点顶栏切到团队。`
        : (hasCommander
            ? '直接下达指令，总指挥会拆解任务并派给对应成员。也可以在左侧选中某个 Agent，单独跟它对话。'
            : '直接下达指令，当前项目没有设置总指挥，默认由第一位可用成员直接处理。也可以在左侧选中某个成员，或新建团队模板来调整结构。')
    }),
    /* 入口放在空态里：新对话第一眼就能看到「制作插件」 */
    h('div', { class: 'empty-actions' },
      h('button', {
        class: 'btn ghost',
        onclick: () => bus.emit('newconversation:open', { mode: 'plugin' })
      }, '制作插件'),
      solo
        ? h('button', { class: 'btn ghost', onclick: () => openMemberProfile(agent.id) }, '编辑它的资料')
        : null
    )
  ))
}

function renderThread () {
  const el = streamEl()
  el.textContent = ''
  nodes.clear()
  el.dataset.view = currentView()
  const list = viewMessages()
  normalizeFoldState(list)
  let lastConversation = null
  for (const msg of list) {
    const node = createNode(msg)
    node.style.animation = 'none'
    if (msg.kind === 'tool' && lastConversation && nodes.get(lastConversation.id)) {
      toolContainerFor(nodes.get(lastConversation.id)).append(node)
    } else {
      el.append(node)
    }
    renderBody(msg.id)
    if (msg.kind !== 'tool') {
      if (msg.kind !== 'handoff') applyFoldState(msg)
      lastConversation = msg
    }
  }
  if (!list.length) showEmpty()
  /* 切换视图/项目会清空 DOM：运行态气泡要按原状态重建 */
  if (statusText) {
    const text = statusText
    const stars = statusWantStars
    statusText = ''
    stopStatusStars()
    statusNode = null
    setStatus(text, stars)
  }
  if (activeAsk) el.append(activeAsk.node)
  el.scrollTop = el.scrollHeight
}

function refreshHeads () {
  for (const [id, node] of nodes) {
    const msg = findMsg(id)
    if (!msg) continue
    if (node.classList.contains('agent')) {
      const current = node.querySelector('.msg-head')
      if (current) current.replaceWith(head(msg))
    }
    const bar = node.querySelector(':scope > .msg-fold-bar')
    if (bar) paintFoldIdentity(bar, msg)
  }
}

export function mountStream () {
  const el = streamEl()
  renderThread()

  el.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) autoScroll = false
    else if (nearBottom()) autoScroll = true
  }, { passive: true })
  el.addEventListener('scroll', () => {
    /* 自动贴底只跟真实位置走：滚轮、拖滚动条、键盘翻页都会更新 */
    autoScroll = nearBottom()
  })

  bus.on('active:agent', () => {
    /* 协作区是跨成员的全局时间线，换选中成员不该重排它 */
    if (currentView() === 'agent') return
    renderThread()
    playViewTransition(el)
  })

  bus.on('project:changed', () => {
    autoScroll = true
    renderThread()
    playViewTransition(el)
  })

  /* 进出直连会话：同一条消息流换一条线，转场和切项目一致 */
  bus.on('super:enter', () => {
    autoScroll = true
    renderThread()
    playViewTransition(el)
  })

  bus.on('super:leave', () => {
    autoScroll = true
    renderThread()
    playViewTransition(el)
  })

  bus.on('roster:changed', () => {
    refreshHeads()
    if (!viewMessages().length) renderThread()
  })

  /* 切视图：只换渲染目标，编排任务照跑不受影响 */
  bus.on('view:changed', () => {
    autoScroll = true
    renderThread()
  })

  bus.on('message:add', (msg) => {
    /* 不属于当前视图的消息不进 DOM，也就不可能混进另一条线的界面 */
    if (msg.channel !== currentView()) return
    if (currentView() === 'user' && (msg.thread || 'commander') !== activeThread()) return
    const isTool = msg.kind === 'tool'
    clearEmpty()
    const node = createNode(msg)
    if (isTool) {
      /* 工具调用挂到上一条对话消息下面，跟随它的折叠状态。 */
      const parent = findFoldParent(msg)
      const parentNode = parent && nodes.get(parent.id)
      if (parentNode) {
        toolContainerFor(parentNode).append(node)
        applyFoldState(parent)
      } else {
        el.append(node)
      }
    } else {
      el.append(node)
    }
    renderBody(msg.id)
    if (!isTool) syncFoldStates()
    /* 状态气泡永远跟在最后一条消息之后 */
    if (statusNode && statusNode.isConnected) el.append(statusNode)
    pinScroll()
  })

  /* ---- 运行态：启动 / 思考（星空粒子）/ 回复 / 工具 ---- */
  bus.on('busy', (busy) => {
    orchestrationBusy = Boolean(busy)
    if (!busy) clearStatus()
    else if (!busyAgents.size) setStatus('正在启动…')
  })

  bus.on('agent:busy', ({ id, busy }) => {
    if (busy) {
      busyAgents.add(id)
      setStatus(`「${agentLabel(id)}」正在思考`, true)
    } else {
      busyAgents.delete(id)
      if (!orchestrationBusy) return
      if (!busyAgents.size) setStatus('正在整理结果…')
    }
  })

  bus.on('status', (text) => {
    if (!orchestrationBusy || !text) return
    if (text.includes('调用工具')) setStatus(String(text).replace(/\s+/g, ' '), false)
    else if (text.includes('整理工具结果')) setStatus('正在整理工具结果…', true)
  })

  bus.on('message:delta', ({ id }) => {
    const msg = findMsg(id)
    if (!msg || msg.kind !== 'agent') return
    setStatus(`「${agentLabel(msg.agentId)}」正在回复`, false)
  })

  bus.on('message:delta', ({ id, text }) => {
    const msg = findMsg(id)
    if (!msg) return
    msg.text = stripSummaryMarker((msg.text || '') + text)
    scheduleRender(id)
  })

  bus.on('message:update', ({ id, patch }) => {
    const msg = findMsg(id)
    if (!msg) return
    if (patch) Object.assign(msg, patch)
    const node = nodes.get(id)
    const ava = node && node.querySelector('.msg-ava')
    if (ava) ava.classList.toggle('busy', Boolean(msg.streaming))
    /* 释放/恢复只改样式标记，不需要整条重绘 */
    if (node) node.classList.toggle('released', Boolean(msg.ctxReleased))
    applyFoldState(msg)
    scheduleRender(id)
  })

  bus.on('message:done', ({ id }) => {
    const msg = findMsg(id)
    const node = nodes.get(id)
    if (!msg || !node) return
    msg.streaming = false
    node.classList.remove('streaming')
    renderBody(id)
    syncFoldStates()
  })

  bus.on('task:update', ({ msgId, taskId, patch }) => {
    const msg = findMsg(msgId)
    if (!msg || !msg.tasks) return
    const task = msg.tasks.find((t) => t.id === taskId)
    if (!task) return
    Object.assign(task, patch)
    scheduleRender(msgId)
  })

  bus.on('message:remove', ({ id }) => {
    const node = nodes.get(id)
    const toolBox = node && node.parentElement && node.parentElement.classList.contains('msg-tools')
      ? node.parentElement
      : null
    if (node) node.remove()
    if (toolBox && !toolBox.children.length) toolBox.remove()
    nodes.delete(id)
    state.messages = state.messages.filter((m) => m.id !== id)
    syncFoldStates()
    pinScroll()
  })

  bus.on('messages:reload', () => {
    autoScroll = true
    renderThread()
  })

  bus.on('ask:show', (payload) => {
    if (!payload || !payload.id) return
    const stream = streamEl()
    if (!stream) {
      payload.resolve({ ok: false, error: '对话流不可用，无法显示提问' })
      return
    }
    if (activeAsk) {
      payload.resolve({ ok: false, error: '已经有一个待回答的问题，请先处理当前问题' })
      return
    }
    const card = createInlineAsk(payload)
    activeAsk = card
    stream.append(card.node)
    if (statusNode && statusNode.isConnected) stream.append(statusNode)
    autoScroll = true
    requestAnimationFrame(() => {
      card.node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  })

  bus.on('ask:close', ({ id, result }) => {
    if (!activeAsk || activeAsk.id !== id) return
    activeAsk.close(result)
    activeAsk = null
  })

  bus.on('session:clear', () => {
    clearStatus()
    nodes.clear()
    renderThread()
  })
}

/* ------------------------------------------------------------- composer */

function autoResize (el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 190) + 'px'
}

function renderHints () {
  const hints = $('#composer-hints')
  if (!hints || !hints.parentElement) return
  const input = $('#input')
  const value = (input.value || '').trim()
  /* 直连会话的发送对象是它自己，和编制无关 */
  if (superChatActive()) {
    const profile = superProfile()
    hints.textContent = ''
    hints.append(h('span', { class: 'hint-target', style: { '--target-color': profile.color } },
      '▸ ', h('b', {}, profile.name), ' 直连 · 不派单'))
    return
  }
  const match = /^@([^\s，,：:]+)/.exec(value)
  /* 单独会话默认就是那一位，不要退回总指挥，否则提示的名字和实际发送对象会不一致 */
  let target = conversationIsTeam() ? commander() : soloAgent()
  if (match) {
    const hit = state.roster.agents.find((a) => a.name === match[1] || a.id === match[1])
    if (hit) target = hit
  }
  if (state.activeAgentId) {
    const active = state.roster.agents.find((a) => a.id === state.activeAgentId)
    if (active) target = active
  }
  hints.textContent = ''
  if (target) {
    /* 单独会话不显示职位：只写名字，团队会话才带职级 */
    const roleText = conversationIsTeam() ? (target.title || ROLE_LABEL[target.role] || '') : ''
    hints.append(h('span', { class: 'hint-target', style: { '--target-color': target.color || 'var(--accent)' } },
      '▸ ', h('b', {}, target.name), roleText ? ' ' + roleText : ''))
  }
}

/* 协作区只读：输入区整体让位，发送入口一起收掉（不再额外弹出提示文案） */
export function syncComposer () {
  const readonly = isReadonlyView()
  const guest = isGuest()
  const locked = readonly || guest
  const composer = $('.composer')
  const input = $('#input')
  const send = $('#btn-send')
  const toolbar = $('#toolbar')

  if (composer) composer.classList.toggle('readonly', locked)
  if (input) {
    input.disabled = locked
    if (readonly) input.value = ''
    input.placeholder = readonly
      ? ''
      : guest
        ? '游客为只读身份 · 请到「设置 → 个人资料」切换为管理员或成员'
        : (superChatActive()
            ? `和${superProfile().name}说话…（Enter 发送，Shift + Enter 换行）`
            : (pluginModeOn() ? pluginPlaceholder() : '下达指令…（Enter 发送，Shift + Enter 换行）'))
    autoResize(input)
  }
  if (send) {
    /* 直连发送没有可中断的编排，忙的时候只能说「思考中」，不能说「停止」 */
    const superBusy = Boolean(state.superChat.busy)
    send.disabled = locked || superBusy
    if (!locked) send.textContent = superBusy ? '思考中…' : (state.busy ? '停止' : '发送')
    send.classList.toggle('busy', !locked && Boolean(state.busy))
    send.title = guest ? '游客不能发起模型调用' : (state.busy ? '停止本轮协作' : '发送')
  }
  if (toolbar) toolbar.classList.toggle('dimmed', locked)
}

export function mountComposer () {
  const input = $('#input')
  const send = $('#btn-send')
  const draftBar = $('#copy-draft')
  const draftCancel = $('#copy-draft-cancel')
  const draftLabel = $('#copy-draft-label')
  let editingQuestion = false

  const setBusy = (busy) => {
    send.disabled = isReadonlyView() || isGuest()
    send.textContent = busy ? '停止' : '发送'
    send.classList.toggle('busy', busy)
    send.title = busy ? '停止本轮协作' : '发送'
    renderHints()
  }

  function clearEditDraft (opts = {}) {
    const clearInput = opts.clearInput !== false
    const clearFiles = opts.clearFiles !== false
    editingQuestion = false
    if (draftBar) draftBar.hidden = true
    if (draftLabel) draftLabel.textContent = '正在修改提问 · 原提问已撤回'
    if (clearInput) {
      input.value = ''
      autoResize(input)
    }
    if (clearFiles) {
      state.pendingFiles = []
      bus.emit('attachments:changed')
    }
    renderHints()
  }

  async function startQuestionEdit ({ text = '', files = [] } = {}) {
    if (state.busy || isReadonlyView()) {
      toast('协作进行中，暂时不能修改提问', 'err')
      return
    }
    if (input.value.trim() || (state.pendingFiles || []).length) {
      const ok = await confirmAction({
        title: '覆盖输入框内容？',
        message: '输入框里已有文字或附件，要用撤回的提问覆盖它吗？',
        confirmText: '覆盖',
        danger: true
      })
      if (!ok) return
    }
    editingQuestion = true
    input.value = text
    state.pendingFiles = (files || []).map((file) => ({
      name: file.name,
      path: file.path || '',
      size: file.size || 0,
      text: typeof file.text === 'string' ? file.text : null
    }))
    bus.emit('attachments:changed')
    if (draftBar) draftBar.hidden = false
    if (draftLabel) draftLabel.textContent = '正在修改提问 · 原提问已撤回，可编辑后重新发送'
    autoResize(input)
    renderHints()
    input.focus()
    autoScroll = true
  }

  input.addEventListener('input', () => { autoResize(input); renderHints() })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      fire()
    }
  })

  async function fire () {
    const text = input.value.trim()
    if (isReadonlyView()) {
      toast('协作区只读，切回「用户 ↔ AI」再发言', 'err')
      return
    }
    if (!text || state.busy || state.superChat.busy) return
    send.classList.add('sent')
    setTimeout(() => send.classList.remove('sent'), 460)
    input.value = ''
    autoResize(input)
    renderHints()
    autoScroll = true
    /* 直连会话不进编排：同样一个输入框，发出去的是「跟它说话」而不是派单 */
    const res = superChatActive() ? await superSend(text) : await submit(text)
    if (res && res.ok === false) {
      if (editingQuestion) {
        input.value = text
        autoResize(input)
        renderHints()
      }
      if (res.message) toast(res.message, 'err')
      return
    }
    if (editingQuestion) clearEditDraft({ clearInput: false, clearFiles: false })
  }

  if (draftCancel) draftCancel.addEventListener('click', () => clearEditDraft())

  send.addEventListener('click', () => {
    if (state.busy) {
      cancelCurrentTurn()
      return
    }
    fire()
  })
  bus.on('run:cancelling', () => {
    if (!state.busy) return
    send.textContent = '取消中…'
    send.disabled = true
  })
  bus.on('busy', setBusy)
  bus.on('roster:changed', renderHints)
  bus.on('active:agent', renderHints)
  bus.on('composer:edit-question', (payload) => startQuestionEdit(payload))
  bus.on('view:changed', () => {
    syncComposer()
    renderHints()
    if (isReadonlyView() && editingQuestion) clearEditDraft()
  })
  bus.on('session:clear', () => {
    autoScroll = true
    if (editingQuestion) clearEditDraft()
    renderHints()
    syncComposer()
  })
  bus.on('conversation:mode', () => syncComposer())
  bus.on('role:changed', () => syncComposer())
  bus.on('project:changed', () => {
    if (editingQuestion) clearEditDraft()
    syncComposer()
  })
  bus.on('super:enter', () => {
    if (editingQuestion) clearEditDraft()
    syncComposer()
    renderHints()
  })
  bus.on('super:leave', () => {
    syncComposer()
    renderHints()
  })
  bus.on('super:busy', () => syncComposer())

  mountToolbar()
  autoResize(input)
  renderHints()
  syncComposer()
}

export { renderHints }
