/* memory-ui.js — 记忆档案界面：索引、原文、事件图、权重详情 */
import { h, toast } from './core.js'
import { openModal } from './modal.js'

const TABS = [
  { key: 'index', label: '索引' },
  { key: 'archive', label: '完整原文' },
  { key: 'graph', label: '事件图' },
  { key: 'weights', label: '权重详情' }
]

function fmtTime (value) {
  const text = String(value || '')
  return text ? text.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 19) : '—'
}

function fmtWeight (value) {
  return typeof value === 'number' ? value.toFixed(2) : '—'
}

function parseJson (value, fallback) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function svgEl (tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
  return el
}

export function openMemoryArchive () {
  const state = {
    tab: 'index',
    rows: [],
    graph: { nodes: [], edges: [] },
    selected: '',
    query: ''
  }
  let content = null
  let tabsEl = null
  let countsEl = null

  const api = window.astral

  async function loadRows () {
    try {
      const res = await api.messageDigests({ limit: 120 })
      state.rows = res && res.ok && Array.isArray(res.data) ? res.data : []
    } catch { state.rows = [] }
    if (countsEl) countsEl.textContent = `${state.rows.length} 条编号记录`
  }

  async function loadGraph () {
    try {
      const res = await api.messageGraph({ limit: 80 })
      state.graph = res && res.ok && res.data ? res.data : { nodes: [], edges: [] }
    } catch { state.graph = { nodes: [], edges: [] } }
  }

  function select (code) {
    state.selected = code || ''
    state.tab = 'archive'
    paint()
  }

  function paintTabs () {
    if (!tabsEl) return
    tabsEl.textContent = ''
    for (const tab of TABS) {
      tabsEl.append(h('button', {
        class: 'memory-tab' + (state.tab === tab.key ? ' active' : ''),
        type: 'button',
        onclick: async () => {
          state.tab = tab.key
          if (tab.key === 'graph') await loadGraph()
          paint()
        }
      }, tab.label))
    }
  }

  function visibleRows () {
    const q = state.query.trim().toLowerCase()
    if (!q) return state.rows
    return state.rows.filter((row) => [row.code, row.one_line, row.digest, row.created_at].join(' ').toLowerCase().includes(q))
  }

  function renderIndex () {
    const wrap = h('div', { class: 'memory-panel' })
    const rows = visibleRows()
    if (!rows.length) return h('div', { class: 'hint', text: '没有匹配的记忆。' })
    const table = h('div', { class: 'memory-table' })
    table.append(h('div', { class: 'memory-row memory-row-head' },
      h('span', {}, '编号'), h('span', {}, '时间'), h('span', {}, '一句话'), h('span', {}, '权重')
    ))
    for (const row of rows) {
      table.append(h('button', {
        class: 'memory-row',
        type: 'button',
        onclick: () => select(row.code)
      },
      h('span', { class: 'memory-code', text: row.code || '—' }),
      h('span', { class: 'memory-time', text: fmtTime(row.time_text || row.created_at) }),
      h('span', { class: 'memory-one', text: row.one_line || row.digest || '' }),
      h('span', { class: 'memory-weight', text: fmtWeight(row.total_weight) })
      ))
    }
    wrap.append(table)
    return wrap
  }

  async function renderArchive () {
    const wrap = h('div', { class: 'memory-panel' })
    if (!state.selected) return h('div', { class: 'hint', text: '先在索引或事件图里选择一条编号。' })
    const row = state.rows.find((item) => item.code === state.selected) || {}
    const title = h('div', { class: 'memory-archive-head' },
      h('span', { class: 'memory-code', text: state.selected }),
      h('span', { class: 'memory-time', text: fmtTime(row.time_text || row.created_at) }),
      h('span', { class: 'memory-weight', text: `总权重 ${fmtWeight(row.total_weight)}` })
    )
    const body = h('pre', { class: 'memory-original', text: '读取中…' })
    wrap.append(title, body)
    try {
      const res = await api.messageGet({ code: state.selected })
      body.textContent = res && res.ok && res.data ? res.data.text : '原文不可用'
    } catch (err) {
      body.textContent = '读取失败：' + (err.message || err)
    }
    return wrap
  }

  function renderGraph () {
    const wrap = h('div', { class: 'memory-panel' })
    const graph = state.graph
    if (!graph.nodes.length) return h('div', { class: 'hint', text: '还没有可画的事件节点。' })
    const board = h('div', { class: 'memory-graph' })
    const width = 860
    const height = 420
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'memory-graph-svg' })
    const positions = new Map()
    const cx = width / 2
    const cy = height / 2
    graph.nodes.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, graph.nodes.length)
      const radius = 130 + (index % 3) * 35
      positions.set(node.code, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius * 0.72 })
    })
    for (const edge of graph.edges) {
      const a = positions.get(edge.from_code)
      const b = positions.get(edge.to_code)
      if (!a || !b) continue
      svg.append(svgEl('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: `rgba(160,140,255,${Math.min(0.9, 0.12 + edge.relation_weight * 0.8)})`,
        'stroke-width': Math.max(1, edge.relation_weight * 3)
      }))
    }
    for (const node of graph.nodes) {
      const pos = positions.get(node.code)
      if (!pos) continue
      const group = svgEl('g', { class: 'memory-graph-node', role: 'button' })
      group.append(svgEl('circle', { cx: pos.x, cy: pos.y, r: 7, fill: '#b9a4ff' }))
      const label = svgEl('text', { x: pos.x + 10, y: pos.y + 3, fill: '#9d98b5', 'font-size': '9' })
      label.textContent = node.code
      group.append(label)
      group.addEventListener('click', () => select(node.code))
      svg.append(group)
    }
    board.append(svg)
    wrap.append(board)
    return wrap
  }

  function bar (value, cls = '') {
    const n = Math.max(0, Math.min(1, typeof value === 'number' ? value : 0))
    return h('span', { class: 'memory-bar ' + cls }, h('i', { style: { width: `${Math.round(n * 100)}%` } }))
  }

  function renderWeights () {
    const wrap = h('div', { class: 'memory-panel' })
    if (!state.rows.length) return h('div', { class: 'hint', text: '还没有权重记录。' })
    const table = h('div', { class: 'memory-table memory-weight-table' })
    table.append(h('div', { class: 'memory-row memory-row-head' },
      h('span', {}, '编号'), h('span', {}, '时间'), h('span', {}, '时间'), h('span', {}, '事件'),
      h('span', {}, '关联'), h('span', {}, '动态'), h('span', {}, '总')
    ))
    for (const row of state.rows.slice(0, 100)) {
      table.append(h('button', { class: 'memory-row', type: 'button', onclick: () => select(row.code) },
        h('span', { class: 'memory-code', text: row.code || '—' }),
        h('span', { class: 'memory-time', text: fmtTime(row.created_at) }),
        h('span', {}, bar(row.time_weight)),
        h('span', {}, bar(row.event_weight)),
        h('span', {}, bar(row.relation_weight)),
        h('span', {}, bar(row.dynamic_weight)),
        h('span', { class: 'memory-weight', text: fmtWeight(row.total_weight) })
      ))
    }
    wrap.append(table)
    return wrap
  }

  function paint () {
    paintTabs()
    if (!content) return
    content.textContent = ''
    if (state.tab === 'index') content.append(renderIndex())
    else if (state.tab === 'weights') content.append(renderWeights())
    else if (state.tab === 'graph') content.append(renderGraph())
    else {
      const pending = renderArchive()
      content.append(h('div', { class: 'hint', text: '读取原文…' }))
      pending.then((node) => { content.textContent = ''; content.append(node) })
    }
  }

  openModal({
    title: '记忆档案',
    sub: 'MEMORY ARCHIVE · INDEX / GRAPH / WEIGHTS',
    width: 980,
    render: (body) => {
      tabsEl = h('div', { class: 'memory-tabs' })
      countsEl = h('span', { class: 'memory-count', text: '读取中…' })
      const search = h('input', {
        class: 'input memory-search',
        placeholder: '搜索编号、一句话…',
        oninput: (event) => { state.query = event.target.value; if (state.tab === 'index') paint() }
      })
      const refresh = h('button', {
        class: 'btn ghost',
        type: 'button',
        onclick: async () => { await loadRows(); await loadGraph(); paint() }
      }, '刷新')
      content = h('div', { class: 'memory-content' })
      body.append(
        h('div', { class: 'memory-toolbar' },
          tabsEl,
          h('div', { class: 'memory-tools' }, search, countsEl, refresh)
        ),
        content
      )
      paintTabs()
      Promise.all([loadRows(), loadGraph()]).then(() => {
        if (countsEl) countsEl.textContent = `${state.rows.length} 条编号记录`
        paint()
      })
    }
  })
}
