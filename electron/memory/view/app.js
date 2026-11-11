'use strict'

/* 星界 · 记忆库控制台（零外部依赖，结构 / 视觉对齐主界面） */

const state = {
  view: 'overview',
  table: 'events',
  q: '',
  offset: 0,
  limit: 50,
  snapshot: null,
  tableData: null,
  record: null,
  dockPane: 'fields',
  searchTimer: null,
  qTimer: null,
  /* 星图 */
  starmapMode: 'concept',
  starmap: null,
  nodeView: null,
  /* 时间 */
  time: null,
  timeMode: 'habit',
  /* 硬性上下文 */
  hard: null,
  hardSlot: 'identity',
  hardMode: 'edit',
  hardDrafts: {},
  hardDirty: {},
  info: null
}

const PALETTE = ['#8b9cff', '#b98bff', '#5eead4', '#ffcf6b', '#f09595', '#96beff', '#ffc46c', '#c0a0ff', '#9aa5c8']
const TABLE_ICONS = {
  projects: 'i-layers', events: 'i-activity', proposals: 'i-clock',
  dispatch_log: 'i-table', behavior_log: 'i-activity', knowledge: 'i-book',
  event_prefixes: 'i-table', diary_digest: 'i-book', archive_manifest: 'i-archive'
}
/* 星图节点配色：一种类型一个颜色，图例与节点共用 */
const NODE_STYLE = {
  super: { color: '#f2f5ff', ring: '#c0a0ff', label: '超级智能体' },
  hard: { color: '#ffcf6b', ring: '#b98bff', label: '硬性上下文' },
  master: { color: '#8b9cff', ring: '#5eead4', label: '项目总文档' },
  project: { color: '#96beff', ring: '#8b9cff', label: '项目' },
  event: { color: '#5eead4', ring: '#5eead4', label: '事件' },
  diary: { color: '#f09595', ring: '#f09595', label: '派发日记' },
  events: { color: '#b98bff', ring: '#b98bff', label: '事件记录' },
  archive: { color: '#9aa5c8', ring: '#9aa5c8', label: '封存清单' },
  behavior: { color: '#ffc46c', ring: '#ffc46c', label: '行为日记' },
  proposals: { color: '#c0a0ff', ring: '#c0a0ff', label: '提议' },
  knowledge: { color: '#b98bff', ring: '#b98bff', label: '知识库' },
  'knowledge-item': { color: '#c0a0ff', ring: '#b98bff', label: '知识条目' },
  block: { color: '#5eead4', ring: '#5eead4', label: '记忆块' },
  temp: { color: '#f09595', ring: '#f09595', label: '临时团队' }
}
const $ = (id) => document.getElementById(id)
function formatWhen (iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ')
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}
const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const icon = (name, cls) => '<svg' + (cls ? ' class="' + cls + '"' : '') + '><use href="#' + name + '"/></svg>'

function token () { return sessionStorage.getItem('astral_memory_token') || '' }

async function api (url, options = {}) {
  const headers = { ...(options.headers || {}) }
  const tk = token()
  if (tk) headers.Authorization = 'Bearer ' + tk
  const res = await fetch(url, { cache: 'no-store', ...options, headers })
  if (res.status === 401) { openToken(); throw new Error('TOKEN_REQUIRED') }
  let data
  try { data = await res.json() } catch { data = { ok: false, error: 'HTTP ' + res.status } }
  if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status))
  return data
}

async function copyText (text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg) }
  catch { toast('复制失败') }
}

function toast (text) {
  const el = $('toast')
  el.textContent = text
  el.classList.add('show')
  clearTimeout(el._t)
  el._t = setTimeout(() => el.classList.remove('show'), 1900)
}

/* ---------- 星野背景（与主界同款冷色粒子 + 极光 + 视差） ---------- */
const STAR_PALETTE = [
  [150, 190, 255], [104, 240, 214], [255, 194, 108],
  [255, 132, 166], [190, 148, 255], [255, 236, 178]
]

function mountStarfield () {
  const canvas = $('fx-stars')
  if (!canvas || !canvas.getContext) return
  const ctx = canvas.getContext('2d')
  let w = 0, h = 0, dpr = 1, stars = [], raf = 0
  const pointer = { x: 0, y: 0 }
  const drift = { x: 0, y: 0 }

  function spawn (initial) {
    const z = Math.random()
    const ang = Math.random() * Math.PI * 2
    const speed = (0.12 + Math.random() * 0.4) * (0.4 + z)
    return {
      x: Math.random() * w, y: Math.random() * h,
      vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
      z, r: 0.35 + z * 1.25,
      base: 0.16 + z * 0.4,
      phase: Math.random() * Math.PI * 2,
      tw: 0.0003 + Math.random() * 0.0008,
      color: STAR_PALETTE[(Math.random() * STAR_PALETTE.length) | 0],
      fade: initial ? 1 : 0
    }
  }

  function resize () {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = window.innerWidth
    h = window.innerHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const count = Math.max(60, Math.min(230, Math.round(w * h / 7000)))
    stars = Array.from({ length: count }, () => spawn(true))
  }

  function frame (t) {
    ctx.clearRect(0, 0, w, h)
    drift.x += (pointer.x - drift.x) * 0.04
    drift.y += (pointer.y - drift.y) * 0.04
    for (const s of stars) {
      s.x += s.vx
      s.y += s.vy
      if (s.x < -12 || s.x > w + 12 || s.y < -12 || s.y > h + 12) Object.assign(s, spawn(false))
      s.fade = Math.min(1, s.fade + 0.012)
      const twinkle = 0.65 + 0.35 * Math.sin(t * s.tw + s.phase)
      const alpha = s.base * twinkle * s.fade
      const c = s.color
      ctx.beginPath()
      ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha.toFixed(3) + ')'
      ctx.arc(s.x + drift.x * (0.3 + s.z * 1.2), s.y + drift.y * (0.3 + s.z * 1.2), s.r, 0, Math.PI * 2)
      ctx.fill()
    }
    raf = requestAnimationFrame(frame)
  }

  window.addEventListener('resize', resize)
  window.addEventListener('mousemove', (e) => {
    pointer.x = (e.clientX / Math.max(1, w) - 0.5) * 9
    pointer.y = (e.clientY / Math.max(1, h) - 0.5) * 9
  })
  resize()
  raf = requestAnimationFrame(frame)
}

let starfieldOn = localStorage.getItem('astral_memory_starfield') !== 'off'
function applyStarfield () {
  document.body.classList.toggle('no-stars', !starfieldOn)
  $('stars-toggle').classList.toggle('on', starfieldOn)
  $('stars-toggle').title = starfieldOn ? '关闭星野' : '开启星野'
  localStorage.setItem('astral_memory_starfield', starfieldOn ? 'on' : 'off')
}
$('stars-toggle').addEventListener('click', () => {
  starfieldOn = !starfieldOn
  applyStarfield()
})
applyStarfield()
mountStarfield()

/* ---------- 访问令牌 ---------- */
function openToken (msg) {
  $('token-modal').classList.remove('hidden')
  $('token-err').textContent = msg || ''
  $('token-input').focus()
}
$('token-save').addEventListener('click', async () => {
  const v = $('token-input').value.trim()
  if (!v) { $('token-err').textContent = '请输入令牌'; return }
  sessionStorage.setItem('astral_memory_token', v)
  try {
    await api('/api/snapshot')
    $('token-modal').classList.add('hidden')
    toast('已连接')
    refresh()
  } catch (err) {
    $('token-err').textContent = '令牌无效，请重试：' + err.message
  }
})
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('token-save').click() })

/* ---------- 导航 ---------- */
const VIEW_META = {
  overview: ['记忆库总览', '本地结构化记忆的实时快照 · 记录只读，硬性上下文可编辑', '实时'],
  starmap: ['星图', '文件关系与真实记录分布', '图谱'],
  time: ['时间', '按周记录 + 周几几点的习惯网', '时间网'],
  kb: ['知识网', '条目按自身权重排 · 检索只回摘要，正文按需取', '知识'],
  hard: ['硬性上下文', '每一轮都会进入系统提示词 · 可直接编辑', '常驻'],
  table: ['数据表', '点击任意一行预览完整内容', '数据表'],
  compare: ['工作流对比', '文本文件 / 数据库 / 一次聚合的步骤成本', '流程'],
  about: ['服务与安全', '连接信息、只读边界与云端部署说明', '安全']
}
const VIEWS = ['overview', 'starmap', 'time', 'kb', 'hard', 'table', 'compare', 'about']

function syncHash (view) {
  const next = view === 'table' ? '#table/' + state.table : '#' + view
  if (location.hash !== next) history.replaceState(null, '', next)
}

function setView (view, table) {
  if (!VIEWS.includes(view)) view = 'overview'
  state.view = view
  if (table) state.table = table
  if (view === 'table') { state.offset = 0; state.q = ''; $('local-q').value = '' }
  for (const v of VIEWS) $('view-' + v).classList.toggle('hidden', v !== view)
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view && (view !== 'table' || el.dataset.name === state.table))
  })
  document.querySelectorAll('.ghost-btn').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view)
  })
  const meta = VIEW_META[view]
  const label = view === 'table'
    ? ((state.snapshot && state.snapshot.tables.find((t) => t.name === state.table)) || {}).label || state.table
    : meta[0]
  $('channel-name').textContent = label
  $('channel-sub').textContent = view === 'table'
    ? '表「' + label + '」· 点击任意一行预览完整内容'
    : meta[1]
  $('channel-tag').textContent = meta[2]
  $('search-pop').classList.add('hidden')
  syncHash(view)
  if (view === 'table') loadTable()
  if (view === 'about') renderAbout()
  if (view === 'compare') renderCompare()
  if (view === 'starmap') loadStarMap()
  if (view === 'time') loadTime()
  if (view === 'kb') loadKb()
  if (view === 'hard') loadHard()
  /* 只有停在星图页才跑动画循环，切走就停，别让后台一直吃 GPU */
  if (starMap) {
    if (view === 'starmap') starMap.start()
    else starMap.stop()
  }
}

/* 支持从主界面或外部链接直达 #starmap / #hard */
function applyHash () {
  const raw = String(location.hash || '').replace(/^#/, '')
  if (!raw) return false
  const [view, table] = raw.split('/')
  if (!VIEWS.includes(view)) return false
  setView(view, table || undefined)
  return true
}
window.addEventListener('hashchange', () => applyHash())

function navClick (e) {
  const btn = e.target.closest('.nav-item, .ghost-btn')
  if (!btn) return
  setView(btn.dataset.view, btn.dataset.name)
}
$('nav').addEventListener('click', navClick)
document.querySelector('.rail-foot').addEventListener('click', navClick)

/* ---------- 概览 ---------- */
function renderNav (snap) {
  $('nav-count').textContent = snap.tables.length
  $('map-count').textContent = snap.total
  if (snap.hardContext) $('hard-count').textContent = snap.hardContext.filled + '/' + snap.hardContext.totalBlocks
  $('nav-tables').innerHTML = snap.tables.map((t) =>
    '<button class="nav-item' + (state.view === 'table' && state.table === t.name ? ' active' : '') +
    '" data-view="table" data-name="' + t.name + '">' + icon(TABLE_ICONS[t.name] || 'i-table') +
    '<span>' + esc(t.label) + '</span><span class="cnt">' + t.count + '</span></button>'
  ).join('')
}

function renderKpis (snap) {
  const byName = (n) => (snap.tables.find((t) => t.name === n) || {}).count || 0
  const items = [
    { label: '总记录', value: snap.total, foot: '9 张数据表', icon: 'i-database', tint: 'var(--brand-soft)', ink: 'var(--brand)' },
    { label: '项目', value: byName('projects'), foot: '按项目组织的记忆', icon: 'i-layers', tint: 'var(--teal-soft)', ink: 'var(--teal)' },
    { label: '事件', value: byName('events'), foot: '操作即事件', icon: 'i-activity', tint: 'var(--amber-soft)', ink: 'var(--amber)' },
    { label: '知识条目', value: byName('knowledge'), foot: '纯工具 · 与项目无关联', icon: 'i-book', tint: 'var(--rose-soft)', ink: 'var(--rose)' }
  ]
  $('kpis').innerHTML = items.map((it, i) =>
    '<div class="kpi" style="--tint:' + it.tint + ';--ink:' + it.ink + ';animation-delay:' + (i * 45) + 'ms">' +
    '<div class="kpi-top"><span class="kpi-label">' + it.label + '</span><span class="kpi-icon">' + icon(it.icon) + '</span></div>' +
    '<div class="kpi-num">' + it.value + '</div><div class="kpi-foot">' + it.foot + '</div></div>'
  ).join('')
}

function renderTrend (trend) {
  const el = $('trend')
  const vals = (trend || []).map((d) => d.count)
  const max = Math.max(1, ...vals)
  if (!vals.length || vals.every((v) => v === 0)) {
    el.innerHTML = '<span class="chart-empty">近 14 天还没有事件</span>'
    return
  }
  const W = 520, H = 178, PAD = 22, n = vals.length
  const step = (W - PAD * 2) / Math.max(1, n - 1)
  const pts = vals.map((v, i) => [PAD + i * step, H - 26 - (v / max) * (H - 52)])
  const line = pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')
  const area = 'M' + pts[0][0] + ',' + (H - 26) + ' L' + pts.map((p) => p.join(',')).join(' L') + ' L' + pts[n - 1][0] + ',' + (H - 26) + ' Z'
  const grid = [0.25, 0.5, 0.75, 1].map((r) => {
    const y = (H - 26) - r * (H - 52)
    return '<line x1="' + PAD + '" y1="' + y + '" x2="' + (W - PAD) + '" y2="' + y + '" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4"/>'
  }).join('')
  const dots = pts.map((p, i) => vals[i] ? '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3" fill="var(--brand)" stroke="var(--surface)" stroke-width="2"/>' : '').join('')
  const labels = (trend || []).map((d, i) => (i % Math.ceil(n / 5) === 0 || i === n - 1)
    ? '<text x="' + pts[i][0] + '" y="' + (H - 7) + '" fill="var(--text-3)" font-size="10" text-anchor="middle">' + esc(d.date.slice(5)) + '</text>' : '').join('')
  el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
    '<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#8b9cff" stop-opacity=".34"/><stop offset="100%" stop-color="#8b9cff" stop-opacity="0"/>' +
    '</linearGradient></defs>' + grid +
    '<path d="' + area + '" fill="url(#areaGrad)" stroke="none"/>' +
    '<polyline points="' + line + '" fill="none" stroke="#8b9cff" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>' +
    dots + labels + '</svg>'
}

function renderShare (snap) {
  const el = $('share')
  const parts = snap.tables.filter((t) => t.count > 0)
  if (!parts.length) { el.innerHTML = '<span class="chart-empty">暂无数据</span>'; return }
  const total = parts.reduce((n, t) => n + t.count, 0)
  const R = 52, C = 2 * Math.PI * R
  let acc = 0
  const rings = parts.slice(0, 9).map((t, i) => {
    const len = (t.count / total) * C
    const seg = '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + PALETTE[i % PALETTE.length] +
      '" stroke-width="15" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) +
      '" stroke-dashoffset="' + (-acc).toFixed(2) + '" transform="rotate(-90 70 70)"/>'
    acc += len
    return seg
  }).join('')
  const legend = parts.slice(0, 7).map((t, i) =>
    '<div class="legend-row"><span class="legend-dot" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' +
    '<span class="legend-name">' + esc(t.label) + '</span><span class="legend-val">' + t.count + '</span></div>'
  ).join('')
  el.innerHTML = '<svg viewBox="0 0 140 140" style="width:140px;height:140px;flex:none">' + rings +
    '<text x="70" y="66" text-anchor="middle" fill="var(--text)" font-size="21" font-weight="650">' + total + '</text>' +
    '<text x="70" y="84" text-anchor="middle" fill="var(--text-3)" font-size="10">条记录</text></svg>' +
    '<div class="legend">' + legend + '</div>'
}

function renderBars (list) {
  const el = $('prefix-bars')
  if (!list || !list.length) { el.innerHTML = '<div class="empty">' + icon('i-activity') + '暂无事件</div>'; return }
  const max = Math.max(...list.map((x) => x.count))
  el.innerHTML = list.map((x) =>
    '<div class="bar-row"><span class="bar-name">' + esc(x.prefix) + '</span>' +
    '<span class="bar-track"><span class="bar-fill" style="width:' + Math.max(4, Math.round(x.count / max * 100)) + '%"></span></span>' +
    '<span class="bar-val">' + x.count + '</span></div>'
  ).join('')
}

function renderRecent (list) {
  const el = $('recent')
  if (!list || !list.length) { el.innerHTML = '<div class="empty">' + icon('i-clock') + '暂无事件</div>'; return }
  el.innerHTML = list.map((e) =>
    '<div class="tl-row" data-table="events" data-id="' + esc(e.id) + '"><span class="tl-dot"></span><span class="tl-text"><b>' + esc(e.prefix) + String(e.seq).padStart(3, '0') +
    '</b>' + esc(e.summary || '（无摘要）') + '</span><span class="tl-time">' + esc(String(e.started_at || '').slice(0, 16).replace('T', ' ')) + '</span></div>'
  ).join('')
  el.querySelectorAll('.tl-row').forEach((row) => {
    row.addEventListener('click', () => openRecord('events', row.dataset.id))
  })
}

function renderAbout () {
  const s = state.snapshot
  if (!s) return
  const info = [
    ['数据库', s.file], ['运行状态', s.enabled ? '运行中' : '已关闭'],
    ['监听地址', s.host + ':' + s.port], ['版本', s.version],
    ['数据表', s.tables.length + ' 张'], ['总记录', s.total + ' 条'],
    ['鉴权', s.auth ? 'Bearer 令牌已启用' : '未启用（仅本机）'],
    ['写接口', s.writeEnabled ? '仅硬性上下文可编辑' : '已关闭（只读部署）'],
    ['更新时间', new Date(s.at).toLocaleString('zh-CN')]
  ]
  $('about-grid').innerHTML =
    '<div class="about-card"><h3>' + icon('i-database') + '连接信息</h3>' +
    info.slice(0, 4).map(([k, v]) => '<div class="kv"><dt>' + k + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</div>' +
    '<div class="about-card"><h3>' + icon('i-shield') + '读写边界</h3>' +
    '<div class="kv"><dt>写入接口</dt><dd>仅 <code>POST /api/hard-context</code>（硬性上下文四块）；其余方法一律 405</dd></div>' +
    '<div class="kv"><dt>记录表</dt><dd>全部为 SELECT，表名白名单，关键词与 id 参数化</dd></div>' +
    '<div class="kv"><dt>对外监听</dt><dd>非 127.0.0.1 且未设令牌时，写接口自动关闭</dd></div>' +
    '<div class="kv"><dt>知识库</dt><dd>独立表，与项目数据无外键、无引用</dd></div>' +
    '<div class="kv"><dt>封存文件</dt><dd>永久保留、只读回查，只能按清单 id 读取</dd></div></div>' +
    '<div class="about-card" style="grid-column:1/-1"><h3>' + icon('i-cloud') + '云端部署</h3>' +
    '<div class="cloud-note">本地默认只绑 <strong>127.0.0.1</strong>。部署到云端时设置 <strong>MEMORY_VIEW_HOST=0.0.0.0</strong>、<strong>MEMORY_VIEW_TOKEN=&lt;令牌&gt;</strong>，并把 <strong>MEMORY_CONFIG_DIR</strong> 指向持久化数据目录；建议再套一层 HTTPS 反向代理。页面检测到 401 会弹出令牌输入框。<br>硬性上下文是唯一写接口：对外监听且没有令牌时，它会自动关闭；也可以用 <strong>MEMORY_VIEW_WRITE=0</strong> 显式关掉写入。</div></div>'
  $('api-list').innerHTML = [
    ['GET /api/snapshot', '库概览、9 表行数、事件趋势、前缀分布、最近事件、硬性上下文摘要'],
    ['GET /api/table', '指定表数据：name / limit / offset / q'],
    ['GET /api/record', '单条完整记录 + 正文 + 关联 + 封存原文 + 上下文包（一次聚合）'],
    ['GET /api/archive', '按清单 id 只读回查封存文件原文'],
    ['GET /api/search', '跨表全局搜索：q'],
    ['GET /api/starmap', '星图节点与边：项目、事件、知识岛、文件关系数据'],
    ['GET /api/hard-context', '常驻四块正文、字数、上限与修订号'],
    ['POST /api/hard-context', '保存单块（唯一写接口）：{ slot, body }，需 application/json'],
    ['GET /health', '健康检查（无需令牌）']
  ].map(([a, b]) => '<div class="api-row"><code>' + a + '</code><span>' + b + '</span></div>').join('')
}

/* ---------- 工作流对比 ---------- */
const COMPARE = [
  {
    tag: '原始方式', num: '12–13', unit: '轮', name: '手写文本文件',
    sub: '每查一件事都要顺着索引逐层打开文件',
    cls: '',
    steps: [
      '<b>找目录</b>：定位项目文件夹',
      '<b>开总文档</b>：找到项目与事件编号',
      '<b>开项目文件</b>：翻到第 3 块任务开发记录',
      '<b>查编号表</b>：解析 <code>BB001</code> / <code>P001</code> 的含义',
      '<b>开派发日记</b>：先读顶部浓缩区，再翻正文',
      '<b>人工合并</b>：把几处时间线拼成一条',
      '<b>回查封存</b>：查清单 → 打开旧文件 → 摘出内容',
      '<b>拼上下文</b>：手动整理成可喂给 AI 的文本',
      '<b>写入</b>：同步改编号表 + 总文档 + 项目文件 + 日记（≥4 处）'
    ],
    note: '索引靠人维护，漏改一处就对不上；长正文没有结构化字段，只能整篇读。'
  },
  {
    tag: '当前方案', num: '3', unit: '轮', name: '数据库 + 聚合工具',
    sub: '索引、编号、事务由库负责',
    cls: '',
    steps: [
      '<b>memory_query</b>：按项目 / 时间 / 前缀一次查回事件、提议、派发',
      '<b>memory_write</b>：一个事务内完成编号分配、前缀登记、事件落库、留痕',
      '<b>source: "archive"</b>：复用同一入口回查封存文件，不新增工具'
    ],
    note: '索引由数据库维护，不会漏写；SQL 条件过滤代替通读全文；写入要么全成功要么回滚。'
  },
  {
    tag: '本轮新增', num: '1', unit: '轮', name: '一次聚合 · /api/record',
    sub: '点一行 → 看全文 → 复制上下文包',
    cls: 'win',
    steps: [
      '<b>一次 GET</b> 同时返回：完整字段、记录正文、同一项目关联记录、封存文件原文',
      '<b>顺带生成上下文包</b>：已拼好可直接喂给 AI 的文本，不用再整理',
      '<b>用户侧</b>：点一行即预览全文，点「复制上下文包」即交给智能体'
    ],
    note: '把「查 → 找 → 打开 → 合并 → 整理」压成一次调用；封存原文也在同一份结果里，不必再开编辑器。'
  }
]

function renderCompare () {
  $('compare-hero').innerHTML = COMPARE.map((c, i) =>
    '<div class="hero-card ' + c.cls + '" style="animation-delay:' + (i * 55) + 'ms">' +
    '<span class="hero-tag">' + c.tag + '</span>' +
    '<div class="hero-num">' + c.num + '<small>' + c.unit + '</small></div>' +
    '<div class="hero-name">' + c.name + '</div>' +
    '<div class="hero-sub">' + c.sub + '</div></div>'
  ).join('')
  $('compare-grid').innerHTML = COMPARE.map((c) =>
    '<div class="compare-card ' + c.cls + '"><h3>' + icon(c.cls === 'win' ? 'i-spark' : 'i-flow') + c.name + '</h3>' +
    '<ol>' + c.steps.map((s) => '<li>' + s + '</li>').join('') + '</ol>' +
    '<div class="card-note">' + c.note + '</div></div>'
  ).join('')
  $('bundle-note').innerHTML =
    '调用 <code>GET /api/record?name=events&amp;id=&lt;记录ID&gt;</code>，一次返回：' +
    '<strong>完整字段</strong>（不再被表格截断）、<strong>记录正文</strong>（Markdown 渲染）、' +
    '<strong>同一项目的关联事件 / 提议 / 派发</strong>、<strong>封存文件原文</strong>，' +
    '以及已拼好的 <strong>上下文包</strong>。' +
    '<br>还能再省一步：把这个聚合结果注册成 MCP 工具 <code>memory_get_record</code>，让智能体侧也只需一次调用（属 P1 接线）。' +
    '<br><strong>为什么数据库更省</strong>：索引、编号、关联、事务都在库内完成，AI 不必顺着「总文档 → 项目文件 → 编号表 → 日记 → 封存清单」逐层打开文件；条件过滤由 SQL 承担，返回的就是结构化结果。'
}

/* ================================================================
   硬性上下文：查看 / 编辑
   ================================================================ */
const HARD_COLORS = ['#8b9cff', '#ffcf6b', '#5eead4', '#f09595']
let hardSaving = false

function hardBlock (key) {
  return state.hard && state.hard.blocks.find((b) => b.key === key)
}

function hardBody (block) {
  if (!block) return ''
  return state.hardDrafts[block.key] !== undefined ? state.hardDrafts[block.key] : block.body
}

function hardDirty (key) {
  const block = hardBlock(key)
  if (!block) return false
  return state.hardDrafts[key] !== undefined && state.hardDrafts[key] !== block.body
}

function hardColor (key) {
  const list = (state.hard && state.hard.blocks) || []
  const i = Math.max(0, list.findIndex((b) => b.key === key))
  return HARD_COLORS[i % HARD_COLORS.length]
}

async function loadHard () {
  const list = $('hard-list')
  if (!state.hard && list) list.innerHTML = '<div class="skeleton" style="height:300px"></div>'
  try {
    const data = await api('/api/hard-context')
    state.hard = data
    if (!data.blocks.some((b) => b.key === state.hardSlot)) state.hardSlot = data.blocks[0].key
    $('hard-count').textContent = data.filled + '/' + data.blocks.length
    $('map-count').textContent = state.snapshot ? state.snapshot.total : $('map-count').textContent
    renderHardList()
    renderHardEditor()
    renderHardBudget()
  } catch (err) {
    if (err.message === 'TOKEN_REQUIRED') return
    if (list) list.innerHTML = '<div class="empty">' + icon('i-close') + esc(err.message) + '</div>'
    toast('硬性上下文读取失败：' + err.message)
  }
}

function renderHardList () {
  const el = $('hard-list')
  if (!el || !state.hard) return
  el.innerHTML = state.hard.blocks.map((b, i) => {
    const body = hardBody(b)
    const pct = Math.min(100, Math.round(body.length / b.max * 100))
    const dirty = hardDirty(b.key)
    return '<button class="hard-item' + (b.key === state.hardSlot ? ' active' : '') + '" data-key="' + esc(b.key) + '">' +
      '<span class="hard-item-top"><b><em>' + (i + 1) + '</em>' + esc(b.title) + '</b>' +
      '<span class="hard-item-count">' + body.length + ' / ' + b.max + '</span></span>' +
      '<span class="hard-item-hint">' + esc(b.hint) + '</span>' +
      '<span class="hard-item-bar"><i style="width:' + pct + '%;background:' + hardColor(b.key) + '"></i></span>' +
      (dirty ? '<span class="hard-dot">未保存</span>' : '') +
      '</button>'
  }).join('')
  el.querySelectorAll('.hard-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.hardSlot = btn.dataset.key
      renderHardList()
      renderHardEditor()
    })
  })
}

function renderHardEditor () {
  const block = hardBlock(state.hardSlot)
  if (!block) return
  const body = hardBody(block)
  const dirty = hardDirty(block.key)
  const edit = state.hardMode === 'edit'
  $('hard-title').textContent = block.title
  $('hard-hint').textContent = block.hint + ' · 上限 ' + block.max + ' 字'
  $('hard-rev').textContent = 'v' + block.revision + (block.updatedAt ? ' · ' + fmtTime(block.updatedAt) : '')
  $('hard-text').classList.toggle('hidden', !edit)
  $('hard-preview').classList.toggle('hidden', edit)
  $('hard-text').value = body
  $('hard-text').readOnly = !state.hard.writeEnabled
  $('hard-preview').innerHTML = body.trim()
    ? renderMarkdown(body)
    : '<p class="val-null">这一块还是空的；空块不会进入系统提示词。</p>'
  $('hard-chars').textContent = body.length + ' / ' + block.max + ' 字'
  $('hard-bar').style.width = Math.min(100, Math.round(body.length / block.max * 100)) + '%'
  $('hard-bar').style.background = body.length > block.max ? 'var(--err)' : hardColor(block.key)
  $('hard-dirty').textContent = dirty ? '● 未保存' : (block.updatedAt ? '已保存' : '初始内容')
  $('hard-dirty').classList.toggle('on', dirty)
  $('hard-save').disabled = !dirty || hardSaving || !state.hard.writeEnabled
  $('hard-reset').disabled = !dirty
  if (!state.hard.writeEnabled) {
    $('hard-dirty').textContent = '当前部署只读'
    $('hard-dirty').classList.add('on')
  }
}

function renderHardBudget () {
  if (!state.hard) return
  const blocks = state.hard.blocks
  const budget = state.hard.budget
  const total = blocks.reduce((n, b) => n + hardBody(b).length, 0)
  let offset = 0
  $('hard-budget-bar').innerHTML = blocks.map((b) => {
    const len = hardBody(b).length
    const w = Math.min(100, len / budget * 100)
    const seg = '<i style="left:' + offset + '%;width:' + w + '%;background:' + hardColor(b.key) + '" title="' + esc(b.title) + ' ' + len + ' 字"></i>'
    offset += w
    return seg
  }).join('') + (total < budget
    ? '<i class="rest" style="left:' + offset + '%;width:' + (100 - offset) + '%"></i>'
    : '')
  $('hard-budget-legend').innerHTML = blocks.map((b) => {
    const len = hardBody(b).length
    return '<div class="hard-legend-row"><span class="legend-dot" style="background:' + hardColor(b.key) + '"></span>' +
      '<span class="hard-legend-name">' + esc(b.title) + '</span>' +
      '<span class="hard-legend-num">' + len + ' / ' + b.max + '</span></div>'
  }).join('')
  $('hard-flow').innerHTML =
    '<span class="flow-label">注入顺序</span>' +
    blocks.map((b) => '<span class="flow-chip" style="--c:' + hardColor(b.key) + '">' + esc(b.title) + '</span>').join('<span class="flow-arrow">→</span>') +
    '<span class="flow-arrow">→</span><span class="flow-chip end">系统提示词</span>' +
    '<span class="flow-total">' + total + ' / ' + budget + ' 字 · 剩余 ' + Math.max(0, budget - total) + '</span>'
}

async function saveHard () {
  const block = hardBlock(state.hardSlot)
  if (!block || hardSaving) return
  const body = hardBody(block)
  if (body.length > block.max) {
    toast('「' + block.title + '」超出上限 ' + (body.length - block.max) + ' 字')
    return
  }
  hardSaving = true
  $('hard-save').disabled = true
  try {
    const data = await api('/api/hard-context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: block.key, body })
    })
    state.hard = data
    delete state.hardDrafts[block.key]
    $('hard-count').textContent = data.filled + '/' + data.blocks.length
    renderHardList()
    renderHardEditor()
    renderHardBudget()
    toast('已保存「' + block.title + '」· 修订 v' + (data.saved ? data.saved.revision : block.revision + 1))
    loadOverview()
  } catch (err) {
    if (err.message !== 'TOKEN_REQUIRED') toast('保存失败：' + err.message)
  } finally {
    hardSaving = false
    renderHardEditor()
  }
}

function bindHard () {
  const text = $('hard-text')
  text.addEventListener('input', () => {
    const block = hardBlock(state.hardSlot)
    if (!block) return
    state.hardDrafts[block.key] = text.value
    $('hard-chars').textContent = text.value.length + ' / ' + block.max + ' 字'
    $('hard-bar').style.width = Math.min(100, Math.round(text.value.length / block.max * 100)) + '%'
    const dirty = hardDirty(block.key)
    $('hard-dirty').textContent = dirty ? '● 未保存' : (block.updatedAt ? '已保存' : '初始内容')
    $('hard-dirty').classList.toggle('on', dirty)
    $('hard-save').disabled = !dirty || hardSaving || !state.hard.writeEnabled
    $('hard-reset').disabled = !dirty
    if (state.hardMode === 'view') $('hard-preview').innerHTML = renderMarkdown(text.value)
    renderHardBudget()
    renderHardList()
  })
  $('hard-save').addEventListener('click', saveHard)
  $('hard-reset').addEventListener('click', () => {
    const block = hardBlock(state.hardSlot)
    if (!block) return
    delete state.hardDrafts[block.key]
    renderHardList()
    renderHardEditor()
    renderHardBudget()
    toast('已还原到上次保存的内容')
  })
  $('hard-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    state.hardMode = btn.dataset.mode
    document.querySelectorAll('#hard-mode button').forEach((b) => b.classList.toggle('on', b === btn))
    renderHardEditor()
  })
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.view === 'hard') {
      e.preventDefault()
      if (!e.repeat) saveHard()
    }
  })
}

/* ================================================================
   星图：文件关系 / 数据星图（三维，渲染交给 starmap3d.js）
   ================================================================ */

const FILE_CARDS = {
  super: {
    kind: '常驻核心', title: '超级智能体',
    summary: '只做三件事：记住用户做过的事、判断是否该主动做事、把任务派给执行层。',
    facts: [
      ['直接对话', '只与用户直接对话，具体开发交给下级团队'],
      ['不碰知识库', '甚至不需要知道它是否存在（3.2.1）'],
      ['常驻内容', '只有硬性上下文；项目正文不常驻（3.7）']
    ],
    action: { label: '查看硬性上下文', view: 'hard' }
  },
  hard: {
    kind: '常驻块', title: '硬性上下文',
    summary: '每一轮都进入系统提示词的一小块固定内容，四块合计上限 3600 字。',
    facts: [
      ['四块', '身份与边界 / 硬性规则 / 用户长期画像 / 默认授权'],
      ['可直接改', '在「硬性上下文」页编辑，保存即生效'],
      ['不审计', '只保留当前版本与修订号，不存历史正文']
    ],
    action: { label: '去编辑', view: 'hard' }
  },
  master: {
    kind: '索引', title: '项目总文档',
    summary: '全局唯一一份，只存项目索引：创立时间 + 时间点 + 项目 + 事件编号。',
    facts: [
      ['不存正文', '项目详情仍在项目专属记忆文件里'],
      ['按需取用', '平时不加载，需要时按编号定位（3.7）'],
      ['维护方', '超级智能体单独持有']
    ],
    action: { label: '打开项目表', view: 'table', table: 'projects' }
  },
  file: {
    kind: '项目文件', title: '项目专属记忆文件',
    summary: '每个项目一份，放在对应项目文件夹里，固定三块。',
    facts: [
      ['位置', '跟随项目文件夹，不另设集中存放处'],
      ['维护方', '超级智能体 + 执行层共同维护'],
      ['取用', '正文不进上下文；只在任务真正需要时按编号回查']
    ]
  },
  block1: {
    kind: '第 1 块', title: '项目简介',
    summary: '项目有什么作用、简要信息、重要内容，精简后写入。',
    facts: [['维护方', '底层执行模型 + 超级智能体共同负责'], ['写法', '只留精简后的介绍，不贴原始方案']]
  },
  block2: {
    kind: '第 2 块', title: '开发进度',
    summary: '开发过程中的进度记录。',
    facts: [['维护方', '底层执行模型'], ['超级智能体', '不改写这一块，只读取']]
  },
  block3: {
    kind: '第 3 块', title: '任务开发记录',
    summary: '当前时间点在这个项目里做了什么事、有哪些 bug 未修复等事件记录。',
    facts: [
      ['维护方', '超级智能体单独管控'],
      ['写法', '时间点 + 做了什么事 + 事件编号'],
      ['与事件记录', '是否同一份仍待确认（3.8）']
    ],
    action: { label: '打开事件表', view: 'table', table: 'events' }
  },
  diary: {
    kind: '时间维度', title: '派发日记',
    summary: '超级智能体自己的行为流水：今天动了哪些项目、今天干了什么。',
    facts: [
      ['与项目记忆', '互不相干，不互相压缩、不以对方为源（G1）'],
      ['取用', '扫描每日记忆时只看顶部浓缩区'],
      ['不深究', '任务背后的东西去项目文件里查']
    ],
    action: { label: '打开派发记录', view: 'table', table: 'dispatch_log' }
  },
  events: {
    kind: '外挂库', title: '事件记录',
    summary: '独立于知识体系与智能体体系之外的精简记录，只记「时间 + 结果」。',
    facts: [
      ['结果', '接受 / 拒绝 / 已下发任务'],
      ['不记', '原始消息全文、聊天过程、任务内容、计划书正文'],
      ['上报权', '只有项目主智能体有上报权（3.8）']
    ],
    action: { label: '打开事件表', view: 'table', table: 'events' }
  },
  archive: {
    kind: '只读回查', title: '封存清单',
    summary: '旧文件封存后的位置与元数据；文件永久保留、内容只读。',
    facts: [
      ['旧文件', '封存不删除，越过期越完整'],
      ['回查', '只能按清单 id 读取，不接受任意路径'],
      ['与控制台', '封存原文可在记录预览里直接看']
    ],
    action: { label: '打开封存清单', view: 'table', table: 'archive_manifest' }
  },
  behavior: {
    kind: '主动性', title: '行为日记',
    summary: '修 bug 次数、通话次数、某项工作次数等行为统计，用来分析用户习性。',
    facts: [
      ['用途', '更新主动性上下文，不进入项目记忆'],
      ['粒度', '只记信号与次数，不存聊天原文'],
      ['来源', '超级智能体自己的行为流水']
    ],
    action: { label: '打开行为日记', view: 'table', table: 'behavior_log' }
  },
  proposals: {
    kind: '主动性', title: '提议',
    summary: '向用户提出的建议及结果：接受 / 拒绝 / 已下发任务。',
    facts: [
      ['两层拒绝', '任务层整份丢弃；行为层只记「是否」'],
      ['只追加', '用户改变主意时旧决定仍保留（T5）'],
      ['用途', '避免重复问同一件事']
    ],
    action: { label: '打开提议表', view: 'table', table: 'proposals' }
  },
  knowledge: {
    kind: '独立体系', title: '知识库',
    summary: '字面意思的纯工具：只有最纯粹的知识，例如前端代码知识、容易错的知识点。',
    facts: [
      ['与项目', '无任何关联：不互相引用、不互相索引（G7）'],
      ['与主智能体', '不进主智能体上下文，超级智能体不需要知道它存在'],
      ['生命周期', '只判定是否过时/无效，成立即删除，不留负证据']
    ],
    action: { label: '打开知识库', view: 'table', table: 'knowledge' }
  },
  prefix: {
    kind: '编号', title: '编号前缀表',
    summary: '动作前缀 + 序号的系列表，由超级智能体动态自维护。',
    facts: [
      ['用法', '每次记录前先对照：已有系列沿用，没有才新建'],
      ['示例', 'BB = 修复 bug，P = 改动'],
      ['规则', '一个前缀只对应一个系列，不复用']
    ],
    action: { label: '打开前缀表', view: 'table', table: 'event_prefixes' }
  }
}

function conceptGraph () {
  const snap = state.snapshot || { tables: [], hardContext: {} }
  const by = (n) => (snap.tables.find((t) => t.name === n) || {}).count || 0
  const hard = state.hard || snap.hardContext || { filled: 4, totalBlocks: 4, chars: 0, budget: 3600 }
  const totalProjects = by('projects')
  const nodes = [
    /* 核心在原点；治理层在上方，项目体系在 +X，记录体系在 -X，知识岛孤立在远端 */
    { id: 'super', kind: 'super', label: '超级智能体', meta: '常驻核心 · 只做三件事', x: 0, y: 0, z: 0, r: 34, info: 'super' },
    { id: 'hard', kind: 'hard', label: '硬性上下文', meta: hard.filled + '/' + (hard.totalBlocks || 4) + ' 块 · 每轮常驻', x: 0, y: 168, z: 58, r: 25, info: 'hard' },
    { id: 'master', kind: 'master', label: '项目总文档', meta: totalProjects + ' 个项目索引 · 不存正文', x: 208, y: 78, z: 132, r: 27, info: 'master' },
    { id: 'file', kind: 'project', label: '项目专属记忆文件', meta: '放在项目文件夹里 · 固定三块', x: 250, y: -70, z: 40, r: 29, info: 'file' },
    { id: 'block1', kind: 'block', label: '项目简介', meta: '共同维护', x: 372, y: 34, z: 168, r: 14, info: 'block1' },
    { id: 'block2', kind: 'block', label: '开发进度', meta: '执行层维护', x: 398, y: -184, z: 86, r: 14, info: 'block2' },
    { id: 'block3', kind: 'block', label: '任务开发记录', meta: '超级智能体管控', x: 366, y: -152, z: -78, r: 14, info: 'block3' },
    { id: 'diary', kind: 'diary', label: '派发日记', meta: '自己的行为流水 · 与项目记忆互不相干', x: -246, y: -86, z: 66, r: 21, info: 'diary' },
    { id: 'events', kind: 'events', label: '事件记录', meta: '独立外挂库 · 只记时间 + 结果', x: -226, y: 126, z: -72, r: 23, info: 'events' },
    { id: 'archive', kind: 'archive', label: '封存清单', meta: '旧文件只读回查', x: -346, y: -162, z: -36, r: 15, info: 'archive' },
    { id: 'behavior', kind: 'behavior', label: '行为日记', meta: '主动性信号', x: -56, y: 208, z: -66, r: 15, info: 'behavior' },
    { id: 'proposals', kind: 'proposals', label: '提议', meta: '接受 / 拒绝 / 已下发', x: 166, y: 192, z: -112, r: 15, info: 'proposals' },
    { id: 'knowledge', kind: 'knowledge', label: '知识库', meta: '纯工具 · 与项目无任何关联', x: 402, y: 176, z: -332, r: 27, info: 'knowledge', isolated: true },
    { id: 'prefix', kind: 'block', label: '编号前缀表', meta: '超级智能体自维护', x: -136, y: 6, z: -228, r: 12, info: 'prefix' }
  ]
  const edges = [
    { from: 'super', to: 'hard', kind: 'solid', label: '每轮常驻' },
    { from: 'super', to: 'master', kind: 'solid', label: '持有索引' },
    { from: 'master', to: 'file', kind: 'dashed', label: '按编号回查' },
    { from: 'file', to: 'block1', kind: 'solid', label: '' },
    { from: 'file', to: 'block2', kind: 'solid', label: '' },
    { from: 'file', to: 'block3', kind: 'solid', label: '' },
    { from: 'super', to: 'diary', kind: 'solid', label: '自己写' },
    { from: 'super', to: 'events', kind: 'dashed', label: '写入时间 + 结果' },
    { from: 'super', to: 'proposals', kind: 'solid', label: '' },
    { from: 'super', to: 'behavior', kind: 'solid', label: '' },
    { from: 'events', to: 'prefix', kind: 'solid', label: '编号' },
    { from: 'diary', to: 'archive', kind: 'dashed', label: '旧文件封存' }
  ]
  return { mode: 'concept', nodes, edges, stats: { hard: hard, projects: totalProjects, knowledge: by('knowledge') } }
}

function dataGraph () {
  const data = state.starmap
  if (!data || !data.nodes) return null
  const limits = data.limits || { projects: 6, eventsPerProject: 6, knowledge: 12 }
  const nodes = data.nodes.map((n) => ({ ...n }))
  const edges = (data.edges || []).map((e) => ({ ...e }))
  const pos = new Map()
  /* 与概念图共用同一套机位：核心在原点，治理层在上，记录体系在 -X，知识岛孤立在远端 */
  const fixed = {
    super: [0, 0, 0],
    hard: [0, 168, 58],
    master: [208, 78, 132],
    diary: [-246, -86, 66],
    events: [-226, 126, -72],
    archive: [-346, -162, -36],
    behavior: [-56, 208, -66],
    proposals: [166, 192, -112],
    knowledge: [402, 176, -332]
  }
  for (const n of nodes) {
    if (fixed[n.id]) pos.set(n.id, fixed[n.id])
  }
  const projects = nodes.filter((n) => n.kind === 'project')
  const shown = projects.slice(0, limits.projects)
  const count = shown.length
  const RING = count > 4 ? 372 : 348
  shown.forEach((p, i) => {
    /* 项目均匀落在三维圆环上，高度轻微起伏，避免排成一条线 */
    const angle = -Math.PI / 2 + (i / Math.max(1, count)) * Math.PI * 2
    const y = -8 + Math.sin(i * 1.9) * 46
    const px = Math.cos(angle) * RING
    const pz = Math.sin(angle) * RING
    pos.set(p.id, [px, y, pz])
    const kids = nodes.filter((n) => n.parent === p.id).slice(0, limits.eventsPerProject)
    kids.forEach((k, j) => {
      /* 球面黄金角排布，事件绕项目成一个小星团 */
      const t = (j + 0.5) / Math.max(1, kids.length)
      const phi = Math.acos(1 - 2 * t)
      const theta = j * 2.399963 + i * 1.2
      const rr = 48 + (j % 3) * 9
      pos.set(k.id, [
        px + rr * Math.sin(phi) * Math.cos(theta),
        y + rr * Math.cos(phi),
        pz + rr * Math.sin(phi) * Math.sin(theta)
      ])
    })
  })
  const island = fixed.knowledge
  const kitems = nodes.filter((n) => n.parent === 'knowledge').slice(0, limits.knowledge)
  kitems.forEach((k, j) => {
    const t = (j + 0.5) / Math.max(1, kitems.length)
    const phi = Math.acos(1 - 2 * t)
    const theta = j * 2.399963
    const rr = 62 + (j % 3) * 10
    pos.set(k.id, [
      island[0] + rr * Math.sin(phi) * Math.cos(theta),
      island[1] + rr * Math.cos(phi),
      island[2] + rr * Math.sin(phi) * Math.sin(theta)
    ])
  })
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (p) { n.x = p[0]; n.y = p[1]; n.z = p[2] }
    else if (n.parent && pos.get(n.parent)) {
      const base = pos.get(n.parent)
      n.x = base[0] + 22
      n.y = base[1] + 18
      n.z = base[2] + 22
    } else { n.x = 0; n.y = 0; n.z = 0 }
    if (n.kind === 'super') n.r = 32
    else if (n.kind === 'event') n.r = 7
    else if (n.kind === 'knowledge-item') n.r = 6
    else if (n.kind === 'project') n.r = 20
    else if (n.kind === 'knowledge') n.r = 26
    else n.r = Math.max(12, Math.min(24, 6 + Math.sqrt(n.weight || 8) * 2.6))
  }
  const visible = new Set(nodes.map((n) => n.id))
  return {
    mode: 'data',
    nodes,
    edges: edges.filter((e) => visible.has(e.from) && visible.has(e.to)),
    stats: data.stats,
    truncated: data.truncated,
    truncation: data.truncation || null,
    limits,
    shown: data.shown || null,
    totalProjects: projects.length
  }
}

/* 单星位图：以某个项目 / 事件为中心，距离反映权重——近的靠中心、远的在外圈 */
function nodeGraph () {
  const view = state.nodeView
  if (!view || !view.nodes) return null
  const nodes = view.nodes.map((n) => ({ ...n, kind: n.group }))
  const edges = (view.edges || []).map((e) => ({ ...e }))
  const center = nodes.find((n) => n.id === 'center')
  if (center) {
    center.x = 0
    center.y = 0
    center.z = 0
    center.r = 30
    center.color = '#f2f5ff'
    center.ring = '#b98bff'
  }
  const place = (list, radius, phase) => {
    list.forEach((n, i) => {
      const angle = phase + (i / Math.max(1, list.length)) * Math.PI * 2
      const r = radius + (1 - (n.weight || 0)) * 80
      n.x = Math.cos(angle) * r
      n.y = Math.sin(i * 1.7) * 40
      n.z = Math.sin(angle) * r
      n.r = n.group === 'near' ? 15 : 10
      n.color = n.group === 'near' ? '#5eead4' : '#8b9cff'
      n.ring = n.color
    })
  }
  place(nodes.filter((n) => n.group === 'near'), 190, -Math.PI / 2)
  place(nodes.filter((n) => n.group === 'far'), 390, -Math.PI / 2 + 0.45)
  return { mode: 'node', nodes, edges, stats: view.stats, center: view.center, trigger: view.trigger }
}

/* 星体外观取自 NODE_STYLE，颜色与环色交给 3D 引擎生成光芒 sprite */
function paintNodes (graph) {
  for (const n of graph.nodes) {
    if (n.color) continue
    const style = NODE_STYLE[n.kind] || NODE_STYLE.event
    n.color = style.color
    n.ring = style.ring
  }
  return graph
}

let starMap = null
let mapFocusNode = null

function ensureStarMap () {
  if (starMap) return starMap
  const canvas = $('starmap')
  if (!canvas || !window.AstralStarMap) return null
  starMap = window.AstralStarMap.create({
    canvas: canvas,
    tip: $('map-tip'),
    onSelect: onStarSelect,
    onFocusChange: renderMapFocus
  })
  /* 只读观测口：自检脚本与调试用，不改变任何状态 */
  window.__starmap = starMap
  return starMap
}

function onStarSelect (node) {
  if (node.record) openRecord(node.record.table, node.record.id)
  else if (node.info) openFileCard(node.info)
  else if (node.action && node.action.type === 'view') setView(node.action.view, node.action.table)
}

/* 聚焦后顶栏显示「聚焦 · 名字」，同时点亮「总览」提示可以退回来 */
function renderMapFocus (node) {
  mapFocusNode = node || null
  const badge = $('map-focus')
  if (!badge) return
  badge.classList.toggle('hidden', !node)
  if (node) $('map-focus-name').textContent = node.label || ''
  const back = $('map-zoom-reset')
  if (back) back.classList.toggle('attn', Boolean(node))
}

function applyNodeMode () {
  document.querySelectorAll('#map-modes button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.mode === state.starmapMode)
  })
  const back = $('map-back-main')
  if (back) back.hidden = state.starmapMode !== 'node'
}

function renderStarMap () {
  const graph = state.starmapMode === 'node'
    ? nodeGraph()
    : (state.starmapMode === 'data' ? dataGraph() : conceptGraph())
  if (!graph) return
  const map = ensureStarMap()
  if (!map) return
  paintNodes(graph)
  map.setGraph(graph)
  renderMapChrome(graph)
  applyNodeMode()
  if (state.view === 'starmap') map.start()
}

function renderMapChrome (graph) {
  if (graph.mode === 'node') {
    const s = graph.stats || {}
    const t = graph.trigger
    $('map-legend').innerHTML =
      '<span class="map-legend-item"><i style="background:#f2f5ff"></i>中心</span>' +
      '<span class="map-legend-item"><i style="background:#5eead4"></i>权重近 <b>' + (s.near || 0) + '</b></span>' +
      '<span class="map-legend-item"><i style="background:#8b9cff"></i>权重远 <b>' + (s.far || 0) + '</b></span>'
    $('map-summary').textContent = '单星位图 · ' + ((graph.center && graph.center.label) || '—') +
      ' · 近 ' + (s.near || 0) + ' / 远 ' + (s.far || 0) +
      ' · 分界 ' + Math.round((s.threshold === undefined ? 0.25 : s.threshold) * 100) + '%' +
      (t ? ' · 最近触发 ' + formatWhen(t.at) + ' ' + t.source : '')
    return
  }
  const kinds = []
  const seen = new Set()
  for (const n of graph.nodes) {
    if (seen.has(n.kind)) continue
    seen.add(n.kind)
    kinds.push({ kind: n.kind, count: graph.nodes.filter((x) => x.kind === n.kind).length })
  }
  $('map-legend').innerHTML = kinds.map((k) => {
    const style = NODE_STYLE[k.kind] || NODE_STYLE.event
    return '<span class="map-legend-item"><i style="background:' + style.color + '"></i>' + esc(style.label) + (k.count > 1 ? ' <b>' + k.count + '</b>' : '') + '</span>'
  }).join('')
  const s = graph.stats || {}
  if (graph.mode === 'concept') {
    $('map-summary').textContent = '文件关系 · ' + (s.projects || 0) + ' 个项目索引 · 知识库独立、不连线'
  } else {
    const lim = graph.limits || { projects: 6, eventsPerProject: 6, knowledge: 12 }
    const shown = graph.shown || {}
    const projectTxt = (s.projects || 0) > (shown.projects || 0)
      ? (s.projects || 0) + ' 个项目（显示 ' + (shown.projects || 0) + '）'
      : (s.projects || 0) + ' 个项目'
    const eventShown = (shown.events || 0) + (shown.looseEvents || 0)
    const eventTxt = (s.events || 0) > eventShown
      ? (s.events || 0) + ' 个事件（显示 ' + eventShown + '）'
      : (s.events || 0) + ' 个事件'
    const knowledgeTxt = (s.knowledge || 0) > (shown.knowledge || 0)
      ? (s.knowledge || 0) + ' 条知识（显示 ' + (shown.knowledge || 0) + '）'
      : (s.knowledge || 0) + ' 条知识'
    const linkTxt = (s.projectLinks || 0) + (s.eventLinks || 0)
      ? ' · ' + (s.projectLinks || 0) + ' 条项目连线 / ' + (s.eventLinks || 0) + ' 条事件连线（聚焦时线上显示百分比）'
      : ' · 还没有形成连线'
    $('map-summary').textContent = '数据星图 · ' + projectTxt + ' · ' + eventTxt + ' · ' + knowledgeTxt +
      '（不连任何节点）' + linkTxt + ' · 显示上限 ' + lim.projects + ' 项目 / 每项目 ' + lim.eventsPerProject + ' 事件 / ' + lim.knowledge + ' 知识'
  }
}

function openFileCard (key) {
  const card = FILE_CARDS[key]
  if (!card) return
  state.info = { key, card }
  document.body.classList.add('dock-open', 'dock-info')
  $('dock-eyebrow').textContent = '文件档案'
  $('dock-title').textContent = card.title
  renderInfoDock()
}

function renderInfoDock () {
  if (!state.info) return
  const card = state.info.card
  document.querySelectorAll('#dock-tabs button').forEach((b) => b.classList.remove('active'))
  $('dock-body').innerHTML =
    '<div class="meta-row"><span class="meta-chip hl">' + esc(card.kind) + '</span><span class="meta-chip">记忆文件</span></div>' +
    '<div class="info-lead">' + esc(card.summary) + '</div>' +
    '<div class="sec-title" style="margin-top:18px">关系与规则</div>' +
    '<dl class="info-facts">' + (card.facts || []).map(([k, v]) => '<div class="kv"><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</dl>' +
    (card.action ? '<div class="info-actions"><button class="chip primary" id="info-action">' + esc(card.action.label) + '</button></div>' : '')
  const act = $('info-action')
  if (act) {
    act.addEventListener('click', () => {
      const action = card.action
      closeDock()
      if (action.view === 'table') setView('table', action.table)
      else setView(action.view)
    })
  }
}

function closeDock () {
  document.body.classList.remove('dock-open', 'dock-info')
  state.record = null
  state.info = null
  $('dock-eyebrow').textContent = '记录预览'
  $('dock-title').textContent = '选择一条记录'
  if (state.view === 'table' && state.tableData) renderGrid(state.tableData)
  if (state.view === 'starmap') renderStarMap()
}

/* 只看档案卡时用这个收起：不重绘星图，避免把相机打回全景 */
function closeInfoDock () {
  if (!document.body.classList.contains('dock-info')) return
  document.body.classList.remove('dock-open', 'dock-info')
  state.info = null
}

async function loadStarMap () {
  const loading = $('map-loading')
  if (loading) loading.classList.remove('hidden')
  if (!state.snapshot) await loadOverview()
  try {
    state.starmap = await api('/api/starmap')
  } catch (err) {
    if (err.message === 'TOKEN_REQUIRED') return
    state.starmap = null
    if (!state.snapshot) toast('星图读取失败：' + err.message)
  }
  if (loading) loading.classList.add('hidden')
  renderStarMap()
}

/* ---------- 时间：周记 + 时段习惯 ---------- */

const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/* ---------- 知识网（第四张网） ---------- */

async function loadKb () {
  try {
    const data = await api('/api/kb')
    state.kb = data
    renderKb(data)
  } catch (err) {
    if (err.message === 'TOKEN_REQUIRED') return
    toast('知识网读取失败：' + err.message)
  }
}

function fmtChars (n) {
  const v = Number(n) || 0
  if (v < 1000) return v + ' 字'
  if (v < 1000000) return (v / 1000).toFixed(1) + 'k 字'
  return (v / 1000000).toFixed(1) + 'M 字'
}

function kbRow (node, maxWeight) {
  const pct = node.percent || 0
  const width = Math.max(2, Math.round((node.weight / (maxWeight || 1)) * 100))
  const meta = [
    node.domain || '未分类',
    node.kind || '未分类',
    '曝 ' + (node.exposures || 0),
    '开 ' + (node.opens || 0),
    node.ageDays !== undefined ? node.ageDays + ' 天前' : ''
  ].filter(Boolean).join(' · ')
  return '<div class="kb-row">' +
    '<span class="kb-id">' + esc(node.id || '') + '</span>' +
    '<div class="kb-main">' +
      '<div class="kb-title">' + esc(node.title || '(无标题)') + '</div>' +
      '<div class="kb-meta">' + esc(meta) + '</div>' +
    '</div>' +
    '<div class="kb-weight"><i style="width:' + width + '%"></i><b>' + pct + '%</b></div>' +
  '</div>'
}

function renderKb (data) {
  if (!data) return
  const stats = data.stats || {}
  const kinds = data.kinds || {}
  const nodes = data.nodes || []
  if ($('kb-count')) $('kb-count').textContent = String(stats.total || 0)
  if ($('kb-updated')) $('kb-updated').textContent = fmtTime(new Date().toISOString())

  const maxWeight = nodes.reduce((m, n) => Math.max(m, n.weight || 0), 0.01)
  /* 四个 KPI：第五个「正文总量」并进第一条的脚注 ——
     五列在这个宽度下会把说明文字挤成两行，反而更难读。 */
  const kpis = [
    { label: '条目', value: stats.total || 0, foot: (kinds.方法 || 0) + ' 方法 · ' + (kinds.避错 || 0) + ' 避错 · 全文 ' + fmtChars(stats.chars), icon: 'i-layers', tint: 'var(--teal-soft)', ink: 'var(--teal)' },
    { label: '平均权重', value: Math.round((stats.avgWeight || 0) * 100) + '%', foot: '自身权重，不含查询相关度', icon: 'i-target', tint: 'var(--brand-soft)', ink: 'var(--brand)' },
    { label: '近似连线', value: stats.edges || 0, foot: '「说的是同一件事」的边', icon: 'i-orbit', tint: 'var(--amber-soft)', ink: 'var(--amber)' },
    { label: '从没打开', value: stats.neverOpened || 0, foot: '搜到过但没人取正文', icon: 'i-eye', tint: 'var(--rose-soft)', ink: 'var(--rose)' }
  ]
  $('kb-kpis').innerHTML = kpis.map((it, i) =>
    '<div class="kpi" style="--tint:' + it.tint + ';--ink:' + it.ink + ';animation-delay:' + (i * 45) + 'ms">' +
    '<div class="kpi-top"><span class="kpi-label">' + it.label + '</span><span class="kpi-icon">' + icon(it.icon) + '</span></div>' +
    '<div class="kpi-num">' + it.value + '</div><div class="kpi-foot">' + it.foot + '</div></div>'
  ).join('')

  const top = (data.top || []).map((n) => kbRow(n, maxWeight)).join('') ||
    '<div class="kb-empty">还没有条目。项目里调用 kb_add 沉淀第一条后，这里会按权重排出来。</div>'
  $('kb-top').innerHTML = top

  const cold = (data.cold || []).map((n) => kbRow(n, maxWeight)).join('') ||
    '<div class="kb-empty">没有长期没人打开的条目 —— 要么都在用，要么还没放够半个月。</div>'
  $('kb-cold').innerHTML = cold

  const hits = (data.recent || [])
  $('kb-hits').innerHTML = hits.length
    ? hits.map((hit) => {
        const ids = (hit.picked || []).map((key) => {
          const node = nodes.find((n) => n.key === key)
          return node ? node.id : String(key).split(':').pop()
        })
        return '<div class="kb-hit">' +
          '<span class="kb-hit-time">' + esc(fmtTime(hit.at)) + '</span>' +
          '<span class="kb-hit-query">' + esc(hit.query || '(空查询)') + '</span>' +
          '<span class="kb-hit-ids">' + esc(ids.join(' · ') || '无命中') + '</span>' +
          '<span class="kb-hit-chars">' + (hit.chars || 0) + ' 字</span>' +
        '</div>'
      }).join('')
    : '<div class="kb-empty">还没有检索记录。模型开始查知识后，这里会显示每次给几条、花多少字。</div>'
}

/* ---------- 时间网 ---------- */

async function loadTime (week) {
  try {
    const data = await api('/api/time' + (week ? '?week=' + encodeURIComponent(week) : ''))
    if (!week) state.time = data
    else if (state.time) state.time.week = data.week
    renderTime(state.time)
  } catch (err) {
    if (err.message === 'TOKEN_REQUIRED') return
    toast('时间网读取失败：' + err.message)
  }
}

function applyTimeMode () {
  const root = $('view-time')
  if (!root) return
  root.classList.toggle('time-week-mode', state.timeMode === 'week')
  document.querySelectorAll('#time-modes button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.mode === state.timeMode)
  })
}

function renderTime (data) {
  if (!data) return
  const stats = data.stats || {}
  if ($('time-count')) $('time-count').textContent = String(stats.slots || 0)

  const suggest = data.suggest || {}
  const title = $('time-suggest-title')
  const sub = $('time-suggest-sub')
  const pct = $('time-suggest-pct')
  if (suggest.found) {
    title.textContent = suggest.text
    sub.textContent = '权重只按时段算：连续 ' + (suggest.weeks || 0) +
      ' 周在同一时段重复；不看内容相似度，接受时也不会自动执行。'
    pct.textContent = suggest.percent + '%'
    pct.classList.add('on')
  } else {
    title.textContent = (suggest.slot || '现在') + ' 还没有形成固定习惯'
    sub.textContent = suggest.reason || '等积累几次事件后，这里会告诉你「这个点通常在做什么」。'
    pct.textContent = suggest.total ? suggest.total + ' 次' : '—'
    pct.classList.remove('on')
  }

  const grid = data.grid || []
  const byKey = new Map(grid.map((cell) => [cell.weekday + '|' + cell.hour, cell]))
  const cells = ['<div class="heat-corner"></div>']
  for (let hour = 0; hour < 24; hour++) {
    cells.push('<div class="heat-hour">' + (hour % 3 === 0 ? String(hour) : '') + '</div>')
  }
  for (let weekday = 1; weekday <= 7; weekday++) {
    cells.push('<div class="heat-day">' + DAY_LABELS[weekday - 1] + '</div>')
    for (let hour = 0; hour < 24; hour++) {
      const cell = byKey.get(weekday + '|' + hour) || { count: 0, top: null }
      const top = cell.top
      const share = top ? top.percent / 100 : 0
      const background = cell.count
        ? 'rgba(94,234,212,' + (0.08 + share * 0.52).toFixed(3) + ')'
        : 'rgba(255,255,255,.028)'
      const label = DAY_LABELS[weekday - 1] + ' ' + String(hour).padStart(2, '0') + ':00 · ' +
        (top ? top.key + ' · 时段占比 ' + top.share + '% / 时间置信 ' + top.percent +
          '% · 跨 ' + top.weeks + ' 周' : '无记录')
      cells.push('<button class="heat-cell' + (cell.count ? ' has' : '') + '" type="button"' +
        ' style="background:' + background + '"' +
        ' data-wd="' + weekday + '" data-hour="' + hour + '"' +
        ' data-key="' + esc(top ? top.key : '') + '" data-pct="' + (top ? top.percent : 0) + '"' +
        ' data-share="' + (top ? top.share : 0) + '" data-weeks="' + (top ? top.weeks : 0) + '"' +
        ' data-hits="' + (top ? top.hits : 0) + '" data-kind="' + esc(top ? top.kind : '') + '"' +
        ' title="' + esc(label) + '"></button>')
    }
  }
  $('time-grid').innerHTML = cells.join('')

  const weeks = data.weeks || []
  $('week-sub').textContent = weeks.length ? weeks.length + ' 周 · 最新 ' + weeks[0].week : '还没有周记'
  $('week-list').innerHTML = weeks.map((row) => {
    const events = (row.stats && row.stats.events) || 0
    const on = data.week && data.week.week === row.week
    return '<button class="week-chip' + (on ? ' on' : '') + '" type="button" data-week="' + esc(row.week) + '">' +
      '<b>' + esc(String(row.week).replace(/^\d+-/, '')) + '</b>' +
      '<span>' + esc(String(row.from_at || '').slice(5)) + ' 起 · ' + events + ' 条</span></button>'
  }).join('')
  $('week-body').textContent = data.week ? data.week.body : '还没有周记。先去记录几条事件，这里会按周自动生成。'
  renderPhase(data.phase, data.phases)
  applyTimeMode()
}

/* 进程阶段：当前该做什么、概率怎么漂移、项目走到哪一步会换阶段 */
function renderPhase (phase, phases) {
  const ask = $('phase-ask')
  const box = $('phase-intents')
  const trans = $('phase-transition')
  const table = $('phase-table')
  if (!ask || !box || !table) return
  if (!phase || !phase.found) {
    ask.textContent = phase ? (phase.reason || '这个阶段的样本还不够，先不打扰。') : '还没有足够的进程轨迹。'
    box.innerHTML = ''
    if (trans) trans.textContent = ''
  } else {
    ask.textContent = phase.ask
    box.innerHTML = phase.intents.map((item) =>
      '<div class="phase-intent-row">' +
      '<span class="phase-intent-name">' + esc(item.intent) + '</span>' +
      '<div class="phase-intent-bar"><i style="width:' + item.percent + '%"></i></div>' +
      '<span class="phase-intent-pct">' + item.percent + '%</span>' +
      '<span class="phase-intent-drift' + (item.trend > 0.08 ? ' up' : (item.trend < -0.08 ? ' down' : '')) + '">' +
      esc(item.drift) + '</span></div>'
    ).join('')
    if (trans) {
      const bits = []
      if (phase.arrival) bits.push('<b>怎么走到这一步</b> ' + esc(phase.arrival.text))
      if (phase.transition) bits.push('<b>下一步</b> ' + esc(phase.transition.text) + '（' + phase.transition.percent + '%）')
      trans.innerHTML = bits.length ? bits.join('<br>') : '<b>阶段迁移</b> 还没有观察到这个阶段的迁移。'
    }
  }

  const probs = (phases && phases.probs) || []
  const byPhase = new Map()
  for (const row of probs) {
    const list = byPhase.get(row.phase) || []
    list.push(row)
    byPhase.set(row.phase, list)
  }
  const transRows = (phases && phases.transitions) || []
  if (!probs.length) {
    table.innerHTML = '<div class="hint">还没有阶段概率，先记录几条事件。</div>'
    return
  }
  table.innerHTML = '<div class="phase-table-title">阶段 → 常见指令（基线概率）</div>' +
    [...byPhase].map(([name, list]) =>
      '<div class="phase-group"><b>' + esc(name) + '</b><span>' +
      list.slice(0, 3).map((row) => esc(row.intent) + ' ' + Math.round(row.weight * 100) + '%').join(' · ') +
      '</span></div>'
    ).join('') +
    (transRows.length
      ? '<div class="phase-table-title">阶段迁移</div>' + transRows.slice(0, 6).map((row) =>
          '<div class="phase-group"><b>' + esc(row.from_phase) + ' → ' + esc(row.to_phase) + '</b><span>' +
          Math.round(row.weight * 100) + '% · 平均第 ' + row.avg_seq + ' 条 / 第 ' + row.avg_days + ' 天</span></div>'
        ).join('')
      : '')
}

function bindTime () {
  const modes = $('time-modes')
  if (modes) {
    modes.addEventListener('click', (e) => {
      const btn = e.target.closest('button')
      if (!btn || btn.dataset.mode === state.timeMode) return
      state.timeMode = btn.dataset.mode
      applyTimeMode()
    })
  }
  const grid = $('time-grid')
  if (grid) {
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.heat-cell')
      if (!cell) return
      const weekday = Number(cell.dataset.wd)
      const hour = Number(cell.dataset.hour)
      const key = cell.dataset.key
      const label = DAY_LABELS[weekday - 1] + ' ' + String(hour).padStart(2, '0') + ':00'
      const pick = $('time-pick')
      if (!key) {
        pick.innerHTML = '<b>' + label + '</b> 没有记录。'
        return
      }
      const kind = cell.dataset.kind === 'project' ? '项目' : '事件系列'
      const confidence = Number(cell.dataset.pct)
      const span = Number(cell.dataset.weeks)
      pick.innerHTML = '<b>' + label + '</b> 这个时段通常在做「' + esc(key) + '」（' + kind + '）· ' +
        '时段占比 ' + cell.dataset.share + '% · 跨 ' + span + ' 周 · 时间置信 ' + confidence + '%' +
        (span >= 3 && confidence >= 40 ? '。规律已经比较固定，到点会提醒。' : '。跨周样本还不够，暂不提醒。')
    })
  }
  const list = $('week-list')
  if (list) {
    list.addEventListener('click', (e) => {
      const chip = e.target.closest('.week-chip')
      if (!chip) return
      loadTime(chip.dataset.week)
    })
  }
}

async function openNodeView (kind, id) {
  try {
    const data = await api('/api/nodeview?kind=' + encodeURIComponent(kind) + '&id=' + encodeURIComponent(id))
    if (!data.ok) { toast(data.error || '这张位图暂时打不开'); return }
    /* api 拿到的是 { ok, data }，位图内容在 data.data 里 */
    const payload = data.data || data
    if (!payload.nodes) { toast('这张位图还没有可画的节点'); return }
    state.nodeView = payload
    state.starmapMode = 'node'
    setView('starmap')
    toast('已切到「' + payload.center.label + '」的权重位图')
  } catch (err) {
    if (err.message === 'TOKEN_REQUIRED') return
    toast('位图读取失败：' + err.message)
  }
}

function bindStarMap () {
  $('map-modes').addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    if (!btn || btn.dataset.mode === state.starmapMode) return
    state.starmapMode = btn.dataset.mode
    state.nodeView = null
    closeInfoDock()
    renderStarMap()
    /* 换模式回到全景机位，否则会停在上一张图的某个角落 */
    if (starMap) starMap.overview()
  })
  $('map-back-main').addEventListener('click', () => {
    state.starmapMode = 'data'
    state.nodeView = null
    renderStarMap()
    if (starMap) starMap.overview()
  })
  $('dock-nodeview').addEventListener('click', (e) => {
    const btn = e.currentTarget
    openNodeView(btn.dataset.kind, btn.dataset.id)
  })
  $('map-zoom-in').addEventListener('click', () => { if (starMap) starMap.zoom(1.25) })
  $('map-zoom-out').addEventListener('click', () => { if (starMap) starMap.zoom(1 / 1.25) })
  $('map-zoom-reset').addEventListener('click', () => {
    closeInfoDock()
    if (starMap) starMap.overview()
  })
}

let overviewPromise = null

async function loadOverview () {
  if (overviewPromise) return overviewPromise
  overviewPromise = (async () => {
    try {
      const snap = await api('/api/snapshot')
      state.snapshot = snap
      renderNav(snap)
      renderKpis(snap)
      renderTrend(snap.eventTrend)
      renderShare(snap)
      renderBars(snap.eventByPrefix)
      renderRecent(snap.recentEvents)
      $('updated-at').textContent = new Date(snap.at).toLocaleString('zh-CN')
      const br = $('bridge')
      br.classList.toggle('on', snap.enabled)
      br.classList.toggle('off', !snap.enabled)
      br.title = snap.enabled
        ? (snap.writeEnabled ? '记忆服务运行中 · 硬性上下文可编辑' : '记忆服务运行中 · 只读')
        : '记忆服务已关闭'
      if (state.view === 'about') renderAbout()
      if (state.view === 'compare') renderCompare()
      if (state.view === 'starmap' && !state.starmap) renderStarMap()
    } catch (err) {
      if (err.message === 'TOKEN_REQUIRED') return
      const br = $('bridge')
      br.classList.remove('on')
      br.classList.add('off')
      br.title = '连接失败：' + err.message
      toast('连接失败：' + err.message)
    }
  })()
  try { return await overviewPromise } finally { overviewPromise = null }
}

/* ---------- 数据表 ---------- */
const TIME_COLUMNS = new Set(['created_at', 'started_at', 'ended_at', 'raised_at', 'occurred_at', 'archived_at', 'source_from', 'source_to'])

/* ISO 时间 → 本地「YYYY-MM-DD HH:mm」；非时间原样返回 */
function fmtTime (v) {
  const s = String(v)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return s
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/* 展示值：枚举翻中文、时间格式化；库内原值不变 */
function displayValue (col, v, valueLabels) {
  if (v === null || v === undefined || v === '') return v
  const dict = (valueLabels || {})[col]
  if (dict && dict[String(v)]) return dict[String(v)]
  if (TIME_COLUMNS.has(col)) return fmtTime(v)
  if (col === 'seq') return String(v).padStart(3, '0')
  return v
}

function tagFor (col, shown, raw) {
  const s = String(raw === null || raw === undefined ? shown : raw)
  if (['result', 'status', 'signal'].includes(col) && s) {
    const cls = /拒绝|无效|已过时|否|paused|archived/.test(s) ? 'rose' : /接受|可用|已下发|是|active|done/.test(s) ? 'teal' : ''
    return '<span class="tag ' + cls + '">' + esc(shown) + '</span>'
  }
  return esc(shown)
}

function renderGrid (data) {
  const label = data.label || data.name
  $('table-title').textContent = label
  $('table-desc').textContent = (data.hint || '表 ' + data.name) + ' · 点击任意一行预览完整内容'
  $('table-total').textContent = data.total + ' 条记录'
  $('row-hint').textContent = '显示 ' + (data.rows.length ? data.offset + 1 : 0) + '–' + (data.offset + data.rows.length) + ' / ' + data.total
  $('page-num').textContent = Math.floor(data.offset / data.limit) + 1
  $('prev').disabled = data.offset === 0
  $('next').disabled = data.offset + data.limit >= data.total
  const grid = $('grid')
  if (!data.rows.length) {
    grid.innerHTML = '<div class="empty">' + icon('i-table') + (state.q ? '没有匹配的记录' : '这张表还是空的') + '</div>'
    return
  }
  const labels = data.columnLabels || {}
  const head = '<thead><tr><th style="width:38px"></th>' + data.columns.map((c) => '<th title="' + esc(c) + '">' + esc(labels[c] || c) + '</th>').join('') + '</tr></thead>'
  const body = '<tbody>' + data.rows.map((row, i) =>
    '<tr data-i="' + i + '"' + (state.record && state.record.id === row.id && state.record.table === data.name ? ' class="active"' : '') + '>' +
    '<td class="row-eye">' + icon('i-eye') + '</td>' +
    data.columns.map((c) => {
      const shown = displayValue(c, row[c], data.valueLabels)
      return '<td' + (c === 'prefix' || c === 'id' ? ' class="cell-code"' : '') + ' title="' + esc(shown) + '">' + tagFor(c, shown, row[c]) + '</td>'
    }).join('') + '</tr>'
  ).join('') + '</tbody>'
  grid.innerHTML = '<table>' + head + body + '</table>'
  grid.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => openRecord(data.name, data.rows[Number(tr.dataset.i)].id))
  })
}

async function loadTable () {
  $('grid').innerHTML = '<div class="skeleton skeleton-table"></div>'
  const url = '/api/table?name=' + encodeURIComponent(state.table) +
    '&limit=' + state.limit + '&offset=' + state.offset +
    (state.q ? '&q=' + encodeURIComponent(state.q) : '')
  try {
    const data = await api(url)
    state.tableData = data
    renderGrid(data)
  } catch (err) {
    if (err.message === 'TOKEN_REQUIRED') return
    $('grid').innerHTML = '<div class="empty">' + icon('i-close') + esc(err.message) + '</div>'
  }
}

$('local-q').addEventListener('input', (e) => {
  clearTimeout(state.qTimer)
  state.qTimer = setTimeout(() => { state.q = e.target.value.trim(); state.offset = 0; loadTable() }, 220)
})
$('prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadTable() })
$('next').addEventListener('click', () => { state.offset += state.limit; loadTable() })

/* ---------- 右侧 dock：记录完整内容预览 ---------- */

// 轻量 Markdown（先转义再解析，不接受原始 HTML，避免注入）
function inlineMd (s) {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function renderMarkdown (src) {
  const lines = String(src || '').split('\n')
  let out = ''
  let inCode = false
  let codeBuf = []
  let inList = false
  function closeList () { if (inList) { out += '</ul>'; inList = false } }
  for (const raw of lines) {
    const line = esc(raw)
    if (/^```/.test(raw.trim())) {
      if (inCode) { out += '<pre><code>' + codeBuf.join('\n') + '</code></pre>'; codeBuf = []; inCode = false }
      else { closeList(); inCode = true }
      continue
    }
    if (inCode) { codeBuf.push(line); continue }
    if (/^\s*$/.test(raw)) { closeList(); continue }
    let m
    if ((m = raw.match(/^(#{1,3})\s+(.*)$/))) {
      closeList()
      const lvl = m[1].length
      out += '<h' + lvl + '>' + inlineMd(line.slice(lvl + 1)) + '</h' + lvl + '>'
    } else if (/^\s*[-*]\s+/.test(raw) || /^\s*\d+\.\s+/.test(raw)) {
      if (!inList) { out += '<ul>'; inList = true }
      out += '<li>' + inlineMd(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')) + '</li>'
    } else if (/^>\s?/.test(raw)) {
      closeList()
      out += '<blockquote>' + inlineMd(line.replace(/^>\s?/, '')) + '</blockquote>'
    } else {
      closeList()
      out += '<p>' + inlineMd(line) + '</p>'
    }
  }
  if (inCode && codeBuf.length) out += '<pre><code>' + codeBuf.join('\n') + '</code></pre>'
  closeList()
  return out
}

function renderSourceLines (text) {
  const lines = String(text || '').split('\n')
  return '<div class="src-lines">' + lines.map((l, i) =>
    '<div class="src-line"><span class="src-no">' + (i + 1) + '</span><span class="src-tx">' + esc(l) + '</span></div>'
  ).join('') + '</div>'
}

/* 详情标题：优先项目名 / 摘要 / 正文首句，其次编号 */
function recordTitle (d) {
  const r = d.row || {}
  const raw = r.name || r.summary || r.body || r.task || r.series || r.path || d.id
  return String(raw || '记录').replace(/\s+/g, ' ').slice(0, 32)
}

async function openRecord (name, id) {
  if (!id) { toast('这条记录没有可预览的 ID'); return }
  state.info = null
  document.body.classList.remove('dock-info')
  document.body.classList.add('dock-open')
  $('dock-eyebrow').textContent = '记录预览'
  $('dock-title').textContent = '载入中…'
  $('dock-body').innerHTML = '<div class="skeleton" style="height:180px"></div>'
  try {
    const data = await api('/api/record?name=' + encodeURIComponent(name) + '&id=' + encodeURIComponent(id))
    state.record = data
    $('dock-title').textContent = data.label + ' · ' + recordTitle(data)
    const nodeBtn = $('dock-nodeview')
    if (nodeBtn) {
      const canView = name === 'projects' || name === 'events'
      nodeBtn.hidden = !canView
      if (canView) {
        nodeBtn.dataset.kind = name === 'events' ? 'event' : 'project'
        nodeBtn.dataset.id = id
      }
    }
    renderDock()
    if (state.view === 'table' && state.table === name && state.tableData) renderGrid(state.tableData)
  } catch (err) {
    if (err.message === 'TOKEN_REQUIRED') return
    $('dock-title').textContent = '预览失败'
    $('dock-body').innerHTML = '<div class="dock-empty">' + icon('i-close') + '<p>' + esc(err.message) + '</p></div>'
  }
}

function renderDock () {
  if (state.info) return renderInfoDock()
  const d = state.record
  if (!d) return
  document.body.classList.remove('dock-info')
  const pane = state.dockPane
  const body = $('dock-body')
  document.querySelectorAll('#dock-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane))

  if (pane === 'fields') {
    const labels = d.fieldLabels || {}
    body.innerHTML = '<div class="sec-title">完整字段 · ' + d.columns.length + ' 列</div><dl>' +
      d.columns.map((k) => {
        const raw = d.row[k]
        const shown = displayValue(k, raw, d.valueLabels)
        const isLong = shown !== null && shown !== undefined && (String(shown).length > 60 || String(shown).includes('\n'))
        const val = shown === null || shown === undefined || shown === ''
          ? '<span class="val-null">（空）</span>'
          : isLong ? '<span class="val-long">' + esc(shown) + '</span>' : esc(shown)
        return '<div class="kv"><dt title="' + esc(k) + '">' + esc(labels[k] || k) + '</dt><dd>' + val + '</dd></div>'
      }).join('') + '</dl>'
    return
  }

  if (pane === 'content') {
    const a = d.archive
    const head = '<div class="meta-row">' +
      '<span class="meta-chip hl">' + esc(d.label) + '</span>' +
      '<span class="meta-chip">' + esc(d.content.source) + '</span>' +
      (a ? '<span class="meta-chip">' + esc(a.ext || 'txt') + ' · ' + a.lines + ' 行 · ' + a.size + ' B</span>' : '') +
      (a && a.truncated ? '<span class="meta-chip">已截断</span>' : '') +
      '</div>'
    const doc = a
      ? '<div class="sec-title">封存文件原文（只读）</div>' + (a.error ? '<div class="empty">' + esc(a.error) + '</div>' : renderSourceLines(a.content))
      : '<div class="sec-title">' + esc(d.content.title) + '</div><div class="doc">' + renderMarkdown(d.content.text) + '</div>'
    const rel = d.related.length
      ? '<div class="sec-title" style="margin-top:18px">关联记录 · ' + d.related.length + ' 条</div>' +
        d.related.map((r) => '<div class="rel-row" data-table="' + esc(r.table) + '" data-id="' + esc(r.id) + '">' +
          '<b>' + esc(r.label || r.table) + '</b><span>' + esc(r.text) + '</span></div>').join('')
      : (d.table === 'knowledge' ? '<div class="sec-title" style="margin-top:18px">关联</div><p class="bundle-tip">知识库是纯工具，与项目文件、事件记录无任何关联（G7），故不提供关联记录。</p>' : '')
    body.innerHTML = head + doc + rel
    body.querySelectorAll('.rel-row').forEach((el) => {
      el.addEventListener('click', () => openRecord(el.dataset.table, el.dataset.id))
    })
    return
  }

  if (pane === 'bundle') {
    body.innerHTML = '<p class="bundle-tip"><strong>一次调用已拼好。</strong>下面是可直接交给智能体的上下文包：包含这条记录的完整字段、具体内容、同一项目关联记录' +
      (d.archive ? '、封存文件原文' : '') + '。点底部「复制上下文包」即可，不用再逐层打开文件、也不用手动整理。</p>' +
      '<div class="sec-title">上下文包 · ' + d.bundle.chars + ' 字符' + (d.bundle.truncated ? '（已截断）' : '') + '</div>' +
      '<div class="bundle-box">' + esc(d.bundle.text) + '</div>'
  }
}

$('dock-tabs').addEventListener('click', (e) => {
  if (state.info) return
  const b = e.target.closest('button')
  if (!b) return
  state.dockPane = b.dataset.pane
  renderDock()
})
$('dock-close').addEventListener('click', closeDock)
$('copy-record').addEventListener('click', () => {
  if (state.info) return
  if (state.record) copyText(JSON.stringify(state.record.row, null, 2), '已复制记录 JSON')
})
$('copy-bundle').addEventListener('click', () => {
  if (state.info) return
  if (state.record) copyText(state.record.bundle.text, '已复制上下文包')
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('search-pop').classList.add('hidden')
    if (document.body.classList.contains('dock-open')) $('dock-close').click()
  }
})

/* ---------- 全局搜索 ---------- */
const pop = $('search-pop')
const gq = $('global-q')
gq.addEventListener('input', () => {
  clearTimeout(state.searchTimer)
  const q = gq.value.trim()
  if (!q) { pop.classList.add('hidden'); return }
  state.searchTimer = setTimeout(async () => {
    try {
      const data = await api('/api/search?q=' + encodeURIComponent(q))
      if (!data.results.length) { pop.classList.add('hidden'); return }
      const r = gq.getBoundingClientRect()
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 390)) + 'px'
      pop.style.top = (r.bottom + 8) + 'px'
      pop.innerHTML = data.results.map((x) =>
        '<div class="sp-item" data-table="' + esc(x.table) + '" data-id="' + esc(x.id || '') + '">' +
        '<span class="sp-tag">' + esc(x.label) + '</span><span class="sp-text">' + esc(x.text) + '</span></div>'
      ).join('')
      pop.classList.remove('hidden')
      pop.querySelectorAll('.sp-item').forEach((el) => {
        el.addEventListener('click', () => {
          pop.classList.add('hidden')
          gq.value = ''
          if (el.dataset.id) openRecord(el.dataset.table, el.dataset.id)
          else setView('table', el.dataset.table)
        })
      })
    } catch { pop.classList.add('hidden') }
  }, 260)
})
document.addEventListener('click', (e) => { if (!pop.contains(e.target) && e.target !== gq) pop.classList.add('hidden') })

/* ---------- 刷新 ---------- */
function refresh () {
  loadOverview()
  if (state.view === 'table') loadTable()
  if (state.view === 'compare') renderCompare()
  if (state.view === 'about') renderAbout()
  if (state.view === 'starmap') loadStarMap()
  if (state.view === 'time') loadTime()
  if (state.view === 'hard') loadHard()
}
$('refresh').addEventListener('click', () => {
  if (state.view === 'starmap') state.starmap = null
  refresh()
  toast('已刷新')
})
setInterval(() => { if (state.view === 'overview') loadOverview() }, 15000)

bindHard()
bindStarMap()
bindTime()
renderCompare()
refresh()
if (!applyHash()) setView('overview')
