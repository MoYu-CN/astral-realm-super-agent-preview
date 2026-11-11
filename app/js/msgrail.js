/* msgrail.js — 会话内的消息快切导轨

   消息流右缘一条刻度轨：每条消息一根刻度，悬停出预览卡，
   点击 / 拖动直接滚到那一条。只读 DOM 顺序，不另存一份消息状态。

   定位全部走 offsetTop / offsetHeight（布局坐标），不用 getBoundingClientRect，
   这样启动动画给 .shell 加 transform 时也不会把导轨算歪。 */

import { state, bus, h, timeLabel } from './core.js'

const KINDS = new Set(['user', 'agent', 'plan'])
const MIN_ENTRIES = 4          // 少于四条没有导航意义
const KIND_LABEL = { user: '指令', agent: '回复', plan: '派单' }
const PITCH = 16               // 每条消息占的刻度高度上限：消息够多时轨道自然铺满整个高度

let root = null
let rail = null
let ticksBox = null
let card = null
let cardDot = null
let cardBadge = null
let cardWho = null
let cardTime = null
let cardText = null
let cardIdx = null

let entries = []
let current = -1
let hovered = -1
/* 用户点/键跳到某条后，白色高亮先钉在这一条上。
   最后一屏的内容没法把它顶到视口顶端，贴底规则会把高亮抢到最后一条，
   看起来像点错了；等目标滚出视口、或用户自己滚动，再交还自动判定。 */
let pinnedIndex = -1
let scrubbing = false
let railTop = 0
let railHeight = 0
let streamTop = 0
let streamHeight = 0
let scheduleTimer = 0
let paintedSignature = ''
let scrollRaf = 0
let observer = null

const streamEl = () => document.querySelector('#stream')

function plain (text, max) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<astral:[^>]*>[\s\S]*?<\/astral:[^>]*>/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function ensureDom () {
  if (root) return
  ticksBox = h('div', { class: 'mg-ticks' })
  rail = h('div', {
    class: 'mg-rail',
    role: 'group',
    'aria-label': '消息快切，上下移动预览，点击跳转'
  },
  ticksBox
  )

  cardDot = h('i', { class: 'mg-dot' })
  cardBadge = h('span', { class: 'mg-badge' })
  cardWho = h('span', { class: 'mg-who' })
  cardTime = h('span', { class: 'mg-time' })
  cardText = h('div', { class: 'mg-text' })
  cardIdx = h('span', { class: 'mg-idx' })
  card = h('div', { class: 'mg-card', 'aria-hidden': 'true' },
    h('div', { class: 'mg-head' }, cardDot, cardBadge, cardWho, cardTime),
    cardText,
    h('div', { class: 'mg-foot' }, cardIdx, h('span', { class: 'mg-hint', text: '点击跳转' }))
  )

  root = h('div', { class: 'mg-root' }, rail, card)
  const stage = document.querySelector('.stage')
  ;(stage || document.body).append(root)
  bind()
}

/* 只量布局尺寸：offsetTop / offsetHeight 不受祖先 transform 影响 */
function place () {
  const stream = streamEl()
  if (!stream || !root) return false
  if (stream.offsetHeight < 200 || stream.offsetWidth < 320) { root.hidden = true; return false }
  root.hidden = false

  streamTop = stream.offsetTop
  streamHeight = stream.offsetHeight
  /* 消息多时轨道理所当然铺满整个高度；消息少时收短并居中，不摆一排稀疏的点 */
  const wanted = entries.length * PITCH + 8
  railHeight = Math.max(150, Math.min(streamHeight - 20, wanted))
  railTop = streamTop + (streamHeight - railHeight) / 2
  rail.style.top = `${railTop}px`
  rail.style.height = `${railHeight}px`
  return true
}

/* 一次布局测量：DOM 顺序即阅读顺序，tool / system 不占刻度 */
function measure () {
  const stream = streamEl()
  const byId = new Map(state.messages.map((m) => [m.id, m]))
  const base = stream.offsetTop          // 布局坐标：offsetTop 与滚动无关
  const next = []
  for (const node of stream.children) {
    const id = node.dataset ? node.dataset.id : ''
    if (!id || !node.classList.contains('msg')) continue
    const msg = byId.get(id)
    if (!msg || !KINDS.has(msg.kind)) continue
    next.push({
      id,
      msg,
      kind: msg.kind,
      node,
      color: msg.color || 'var(--accent)',
      contentY: node.offsetTop - base
    })
  }
  entries = next
}

function paint () {
  if (entries.length < MIN_ENTRIES) {
    root.hidden = true
    hideCard()
    return
  }
  const pitch = railHeight / entries.length
  /* 短横统一 2px，密到挤不下时再收薄，避免连成一条实线 */
  const tickH = Math.max(1, Math.min(2, pitch * 0.24))

  /* 流式输出时条目没变，只更新高亮，不重建整排刻度 */
  const signature = `${Math.round(railHeight)}:${entries.map((entry) => entry.id).join('|')}`
  if (signature === paintedSignature) {
    root.hidden = false
    /* measure() 每次都生成新对象，要把旧刻度按位置接回去，否则高亮改不到 */
    const existing = [...ticksBox.children]
    if (existing.length === entries.length) {
      entries.forEach((entry, index) => { entry.tick = existing[index] })
    } else {
      paintedSignature = ''
    }
    paintCurrent()
    return
  }
  paintedSignature = signature

  ticksBox.textContent = ''
  entries.forEach((entry, index) => {
    const tick = h('i', { class: `mg-tick kind-${entry.kind}`, 'data-id': entry.id, 'aria-hidden': 'true' })
    tick.style.top = `${((index + 0.5) / entries.length) * 100}%`
    tick.style.height = `${tickH}px`
    entry.tick = tick
    ticksBox.append(tick)
  })
  root.hidden = false
  paintCurrent()
}

function entryInView (index) {
  const stream = streamEl()
  const entry = entries[index]
  if (!stream || !entry || !entry.node) return false
  const top = entry.contentY - stream.scrollTop
  return top + entry.node.offsetHeight > 0 && top < stream.clientHeight
}

function paintCurrent () {
  const stream = streamEl()
  if (!stream || !entries.length) return
  if (pinnedIndex >= entries.length) pinnedIndex = -1
  /* 用户已经滚到别处了，把高亮还给自动判定 */
  if (pinnedIndex >= 0 && !entryInView(pinnedIndex)) pinnedIndex = -1

  let index
  if (pinnedIndex >= 0) {
    index = pinnedIndex
  } else {
    /* 贴底时当前条就是最后一条：长回复会把最后一条推得很高，
       单看滚动位置会误判成中间某条 */
    const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 8
    const head = stream.scrollTop + 24
    index = atBottom ? entries.length - 1 : 0
    if (!atBottom) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].contentY <= head) index = i
      }
    }
  }
  current = index
  entries.forEach((entry, i) => {
    if (entry.tick) entry.tick.classList.toggle('on', i === index)
  })
  if (hovered >= 0) showCard(hovered)
}

function showCard (index) {
  const entry = entries[index]
  if (!entry) return
  hovered = index
  entries.forEach((item, i) => {
    if (item.tick) item.tick.classList.toggle('hot', i === index)
  })
  cardDot.style.background = entry.kind === 'user' ? 'var(--accent)' : entry.color
  cardBadge.textContent = KIND_LABEL[entry.kind] || '消息'
  cardBadge.dataset.kind = entry.kind
  cardWho.textContent = entry.kind === 'user' ? '你' : (entry.msg.name || '未命名成员')
  cardTime.textContent = timeLabel(entry.msg.ts)
  cardText.textContent = plain(entry.msg.summary || entry.msg.text, 150) || '（无正文）'
  cardIdx.textContent = `第 ${index + 1} / ${entries.length} 条`

  card.classList.add('show')
  card.setAttribute('aria-hidden', 'false')
  /* 卡片贴在被指的那根刻度旁边，超出消息区就收回来 */
  const wanted = railTop + ((index + 0.5) / entries.length) * railHeight - card.offsetHeight / 2
  const min = streamTop + 8
  const max = streamTop + streamHeight - card.offsetHeight - 8
  const top = max > min ? Math.min(max, Math.max(min, wanted)) : min
  card.style.top = `${Math.round(top)}px`
}

function hideCard () {
  hovered = -1
  if (!card) return
  card.classList.remove('show')
  card.setAttribute('aria-hidden', 'true')
  for (const entry of entries) {
    if (entry.tick) entry.tick.classList.remove('hot')
  }
}

/* 键盘跳转时把预览卡短暂亮一下，免得不知道落到了哪条 */
let peekTimer = 0
function peek (index) {
  showCard(index)
  if (peekTimer) clearTimeout(peekTimer)
  peekTimer = setTimeout(() => {
    peekTimer = 0
    if (!scrubbing && !rail.matches(':hover')) hideCard()
  }, 1400)
}

function indexAt (clientY) {
  if (!entries.length) return -1
  const rect = rail.getBoundingClientRect()
  if (!rect.height) return -1
  const ratio = (clientY - rect.top) / rect.height
  return Math.max(0, Math.min(entries.length - 1, Math.floor(ratio * entries.length)))
}

function flash (node) {
  if (!node) return
  node.classList.remove('mg-hit')
  void node.offsetWidth
  node.classList.add('mg-hit')
  setTimeout(() => node.classList.remove('mg-hit'), 1500)
}

function jump (index, smooth = true) {
  const entry = entries[index]
  const stream = streamEl()
  if (!entry || !stream || !entry.node.isConnected) return
  pinnedIndex = index
  stream.scrollTo({ top: Math.max(0, entry.contentY - 12), behavior: smooth ? 'smooth' : 'auto' })
  flash(entry.node)
  if (index !== current) {
    current = index
    entries.forEach((item, i) => {
      if (item.tick) item.tick.classList.toggle('on', i === index)
    })
  }
}

function bind () {
  rail.addEventListener('pointerenter', (event) => {
    refresh()
    const index = indexAt(event.clientY)
    if (index >= 0) showCard(index)
  })

  rail.addEventListener('pointermove', (event) => {
    if (!entries.length) return
    const index = indexAt(event.clientY)
    if (index !== hovered) showCard(index)
    if (scrubbing) jump(index, false)
  })

  rail.addEventListener('pointerleave', () => {
    if (scrubbing) return
    hideCard()
  })

  rail.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const index = indexAt(event.clientY)
    if (index < 0) return
    scrubbing = true
    try { rail.setPointerCapture(event.pointerId) } catch { /* ignore */ }
    showCard(index)
    jump(index, false)
  })

  const endScrub = (event) => {
    if (!scrubbing) return
    scrubbing = false
    try { rail.releasePointerCapture(event.pointerId) } catch { /* ignore */ }
    if (!rail.matches(':hover')) hideCard()
  }
  rail.addEventListener('pointerup', endScrub)
  rail.addEventListener('pointercancel', endScrub)

  /* 在轨道上滚轮就是逐条翻消息，不再让外层消息流跟着滚 */
  rail.addEventListener('wheel', (event) => {
    event.preventDefault()
    if (!entries.length) return
    const base = hovered >= 0 ? hovered : current
    const next = Math.max(0, Math.min(entries.length - 1, base + (event.deltaY > 0 ? 1 : -1)))
    showCard(next)
    jump(next, true)
  }, { passive: false })

  /* 用户自己在消息区滚动 / 按键翻页时解除钉住 */
  const unpin = () => { pinnedIndex = -1 }
  const stream = streamEl()
  if (stream) {
    stream.addEventListener('wheel', unpin, { passive: true })
    stream.addEventListener('touchstart', unpin, { passive: true })
    stream.addEventListener('pointerdown', unpin)
  }
  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (!['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) return
    unpin()
  })
}

/* 任何会改变消息序列或页面高度的动作都重排刻度 */
function schedule (delay = 140) {
  if (scheduleTimer) return
  scheduleTimer = setTimeout(() => {
    scheduleTimer = 0
    refresh()
  }, delay)
}

export function refresh () {
  if (!root) return
  measure()
  if (!place()) return
  paint()
}

export function mountMessageRail () {
  ensureDom()
  refresh()

  const stream = streamEl()
  if (stream) {
    stream.addEventListener('scroll', () => {
      if (scrollRaf) return
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0
        paintCurrent()
      })
    }, { passive: true })
    observer = new ResizeObserver(() => refresh())
    observer.observe(stream)
  }
  window.addEventListener('resize', () => refresh())
  /* 入场动画完成后布局才最终定形，再校一次 */
  setTimeout(() => refresh(), 900)
  setTimeout(() => refresh(), 1800)

  /* Alt+↑ / Alt+↓：上一条 / 下一条消息（Alt+1/2 已被视图切换占用） */
  document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (!entries.length) return
    event.preventDefault()
    const next = Math.max(0, Math.min(entries.length - 1,
      current + (event.key === 'ArrowDown' ? 1 : -1)))
    jump(next, true)
    peek(next)
  })

  const events = [
    ['message:add', 90],
    ['message:remove', 90],
    ['messages:reload', 90],
    ['session:clear', 60],
    ['message:done', 120],
    ['message:update', 600],
    ['project:changed', 60],
    ['view:changed', 60],
    ['active:agent', 60],
    ['roster:changed', 200]
  ]
  for (const [name, delay] of events) {
    bus.on(name, () => {
      if (name === 'session:clear' || name === 'project:changed' || name === 'messages:reload') pinnedIndex = -1
      schedule(delay)
    })
  }
}
