#!/usr/bin/env node
'use strict'

/* probe-starmap.js — 记忆星图（三维）的交互探针
 *
 * 在真实 Electron 里打开记忆控制台的 #starmap 视图，检查：
 *   - 全景取景：所有星体都落在画布内；
 *   - 点击/聚焦：相机飞到星体的三维坐标，星体本身落在画面正中；
 *   - 「总览」：相机退回全景机位，焦点清空；
 *   - 滚轮推拉是否单步（监听若随重绘重复绑定，倍率会按次方放大）；
 *   - 拖拽只旋转视角，不会被误判成点击。
 *
 * 用法：npx electron scripts/probe-starmap.js
 * 说明：必须在 Electron 主进程里跑（需要 BrowserWindow）；窗口会短暂显示，
 *       因为隐藏窗口里 requestAnimationFrame 会被节流，补间不会推进。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const PORT = Number(process.env.PROBE_STARMAP_PORT || 45899)
const HOST = '127.0.0.1'
const WHEEL_DELTA = -200
const WHEEL_RATIO = Math.exp(WHEEL_DELTA * 0.0011)
const DRAG_PX = 120
const YAW_PER_PX = 0.0052

if (!process.versions.electron) {
  console.error('probe-starmap 需要 Electron 主进程：npx electron scripts/probe-starmap.js')
  process.exit(2)
}

let electronApi = null
try { electronApi = require('electron') } catch (_) { electronApi = null }
if (!electronApi || !electronApi.app) {
  console.error('probe-starmap 需要 GUI 主进程（当前是 ELECTRON_RUN_AS_NODE 模式）：' +
    'npx electron scripts/probe-starmap.js')
  process.exit(2)
}

const { app, BrowserWindow } = electronApi
app.disableHardwareAcceleration()

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function ping () {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/health', timeout: 800 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

async function startServer () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-starmap-probe-'))
  process.env.MEMORY_CONFIG_DIR = dir
  process.env.MEMORY_VIEW_PORT = String(PORT)
  process.env.MEMORY_VIEW_HOST = HOST
  process.env.MEMORY_VIEW_WRITE = '1'
  /* 先造两条相似的项目与事件：数据星图才有可显示的权重边 */
  const { createMemoryStore, ROLE } = require('../electron/memory/store.js')
  const seed = createMemoryStore({ configDir: dir })
  try {
    seed.write({ actor: ROLE.SUPER, action: 'project', name: '甲项目', summary: '记忆库权重网的项目连边' })
    /* 与甲高度相似 → 位图里的「权重近」；乙较弱 → 「权重远」 */
    seed.write({ actor: ROLE.SUPER, action: 'project', name: '甲项目镜像', summary: '记忆库权重网的项目连边' })
    seed.write({ actor: ROLE.SUPER, action: 'project', name: '乙项目', summary: '记忆库权重网的事件连边' })
    seed.write({ actor: ROLE.SUPER, action: 'event', project: '甲项目', prefix: 'P', summary: '修复登录报错：验证码顺序写反' })
    seed.write({ actor: ROLE.SUPER, action: 'event', project: '乙项目', prefix: 'P', summary: '修复登录报错：会话兜底缺失' })
  } finally { seed.close() }
  require('../electron/memory/view-server.js')
  for (let i = 0; i < 40; i++) {
    if (await ping()) return dir
    await wait(150)
  }
  throw new Error('记忆控制台未能在 http://' + HOST + ':' + PORT + ' 启动')
}

/* 页面内取数：__starmap.inspect() 是只读观测口 */
const READ = 'JSON.stringify(window.__starmap.inspect())'

async function run (win) {
  const page = (code) => win.webContents.executeJavaScript(code)
  const inspect = async () => JSON.parse(await page(READ))

  await wait(900)
  if (!(await page('Boolean(window.__starmap)'))) throw new Error('星图引擎没有挂载到 window.__starmap')

  const home = await inspect()
  if (!home.nodes) throw new Error('星图为空')

  /* 1) 全景：每颗星的投影都要在画布内 */
  const framing = await page(`(() => {
    const s = window.__starmap.inspect()
    const list = window.__starmap.nodesScreen()
    const out = list.filter((n) => n.x - n.rad < 0 || n.x + n.rad > s.size.w || n.y - n.rad < 0 || n.y + n.rad > s.size.h)
    return JSON.stringify({ total: list.length, outside: out.map((n) => n.id) })
  })()`)
  const box = JSON.parse(framing)

  /* 2) 聚焦：相机目标 = 星体坐标，星体落在画面正中 */
  await page(`window.__starmap.focus('master')`)
  await wait(1100)
  const focused = await inspect()
  const target = await page(`(() => {
    const n = conceptGraph().nodes.find((x) => x.id === 'master')
    return JSON.stringify({ x: n.x, y: n.y, z: n.z })
  })()`)
  const want = JSON.parse(target)
  const targetErr = Math.max(
    Math.abs(focused.target.x - want.x),
    Math.abs(focused.target.y - want.y),
    Math.abs(focused.target.z - want.z)
  )
  const centerDx = focused.focusScreen ? Math.abs(focused.focusScreen.x - focused.size.w / 2) : 999
  const centerDy = focused.focusScreen ? Math.abs(focused.focusScreen.y - focused.size.h / 2) : 999

  /* 3) 总览：退回全景机位，焦点清空 */
  await page(`document.getElementById('map-zoom-reset').click()`)
  await wait(1200)
  const back = await inspect()

  /* 4) 滚轮单步：先量一次，再切模式触发重绘，再量一次 */
  const wheelOnce = async () => {
    const before = (await inspect()).dist
    await page(`(() => {
      const c = document.getElementById('starmap')
      const r = c.getBoundingClientRect()
      c.dispatchEvent(new WheelEvent('wheel', {
        deltaY: ${WHEEL_DELTA}, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true
      }))
    })()`)
    await wait(160)
    const after = (await inspect()).dist
    return after / before
  }
  const ratioFresh = await wheelOnce()
  await page(`document.getElementById('map-zoom-reset').click()`)
  await wait(1000)

  const switches = await page(`(async () => {
    const btns = [...document.querySelectorAll('#map-modes button')]
    let n = 0
    for (let i = 0; i < 4; i++) {
      btns[i % 2 === 0 ? 1 : 0].click()
      await new Promise((r) => setTimeout(r, 260))
      n++
    }
    btns[0].click()
    await new Promise((r) => setTimeout(r, 500))
    return n
  })()`)
  await wait(600)
  const ratioAfter = await wheelOnce()

  /* 5) 拖拽只旋转，不触发选择 */
  await page(`document.getElementById('map-zoom-reset').click()`)
  await wait(1000)
  const beforeDrag = await inspect()
  await page(`(() => {
    const c = document.getElementById('starmap')
    const r = c.getBoundingClientRect()
    const y = r.top + r.height / 2
    const x = r.left + r.width / 2
    c.setPointerCapture = () => {}
    c.releasePointerCapture = () => {}
    c.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: x, clientY: y, bubbles: true }))
    for (let i = 1; i <= 6; i++) {
      c.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x + i * ${DRAG_PX / 6}, clientY: y, bubbles: true }))
    }
    c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: x + ${DRAG_PX}, clientY: y, bubbles: true }))
  })()`)
  await wait(240)
  const afterDrag = await inspect()

  /* 6) 点击命中：回到全景后，按全景下的投影坐标点一下 超级智能体 */
  await page(`document.getElementById('map-zoom-reset').click()`)
  await wait(1200)
  const superPos = await page(`(() => {
    const n = window.__starmap.nodesScreen().find((x) => x.id === 'super')
    return JSON.stringify(n ? { x: n.x, y: n.y } : null)
  })()`)
  const sp = JSON.parse(superPos)
  if (!sp) throw new Error('全景下找不到 超级智能体 的投影坐标')
  await page(`(() => {
    const c = document.getElementById('starmap')
    const r = c.getBoundingClientRect()
    const x = r.left + ${sp.x}
    const y = r.top + ${sp.y}
    c.setPointerCapture = () => {}
    c.releasePointerCapture = () => {}
    c.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 2, clientX: x, clientY: y, bubbles: true }))
    c.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: x, clientY: y, bubbles: true }))
    c.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 2, clientX: x, clientY: y, bubbles: true }))
  })()`)
  await wait(900)
  const clicked = await inspect()

  /* 7) 数据星图：聚焦项目星后，权重连线上必须真的画出百分比标签 */
  await page(`document.querySelector('#map-modes button[data-mode="data"]').click()`)
  await wait(1100)
  const projectIds = JSON.parse(await page(`JSON.stringify(
    window.__starmap.nodesScreen().filter((n) => n.id.indexOf('p:') === 0).map((n) => n.id)
  )`))
  if (projectIds.length) await page(`window.__starmap.focus(${JSON.stringify(projectIds[0])})`)
  await wait(1000)
  const weighted = await inspect()
  const eventIds = JSON.parse(await page(`JSON.stringify(
    window.__starmap.nodesScreen().filter((n) => n.id.indexOf('e:') === 0).map((n) => n.id)
  )`))
  if (eventIds.length) await page(`window.__starmap.focus(${JSON.stringify(eventIds[0])})`)
  await wait(1000)
  const eventFocus = await inspect()

  /* 7.5) 单星位图：记录预览里的「权重位图」入口，近/远分开、线上写百分比 */
  const single = JSON.parse(await page(`(async () => {
    const btn = document.getElementById('dock-nodeview')
    btn.dataset.kind = 'project'
    btn.dataset.id = '甲项目'
    btn.click()
    await new Promise((r) => setTimeout(r, 900))
    const s = window.__starmap.inspect()
    return JSON.stringify({
      mode: s.mode, nodes: s.nodes, edges: s.edges,
      weightEdges: s.weightEdges, edgeLabels: s.edgeLabels,
      summary: document.getElementById('map-summary').textContent || '',
      backShown: !document.getElementById('map-back-main').hidden
    })
  })()`))
  const backMode = await page(`(async () => {
    document.getElementById('map-back-main').click()
    await new Promise((r) => setTimeout(r, 400))
    return window.__starmap.inspect().mode
  })()`)

  /* 8) 时间视图：7×24 热力格、周记与提醒都真的渲染出来 */
  await page(`location.hash = '#time'`)
  await wait(1400)
  const timeView = JSON.parse(await page(`JSON.stringify({
    grid: document.querySelectorAll('#time-grid .heat-cell').length,
    lit: document.querySelectorAll('#time-grid .heat-cell.has').length,
    weeks: document.querySelectorAll('#week-list .week-chip').length,
    body: (document.getElementById('week-body').textContent || '').slice(0, 120),
    suggest: document.getElementById('time-suggest-title').textContent || '',
    count: document.getElementById('time-count').textContent || '',
    phaseAsk: document.getElementById('phase-ask').textContent || '',
    phaseGroups: document.querySelectorAll('#phase-table .phase-group').length
  })`))

  return {
    home: { dist: home.dist, nodes: home.nodes, edges: home.edges, size: home.size },
    framing: box,
    focus: { targetErr: targetErr, centerDx: centerDx, centerDy: centerDy, dist: focused.dist, homeDist: home.dist },
    overview: { focus: back.focus, dist: back.dist, homeDist: back.home.dist },
    wheel: { ratioFresh: ratioFresh, ratioAfter: ratioAfter, expected: WHEEL_RATIO, switches: switches },
    drag: { dYaw: afterDrag.yaw - beforeDrag.yaw, expected: -DRAG_PX * YAW_PER_PX, focus: afterDrag.focus },
    click: { focus: clicked.focus, at: sp },
    percent: {
      focus: weighted.focus,
      projectStars: projectIds.length,
      weightEdges: weighted.weightEdges,
      edgeLabels: weighted.edgeLabels,
      eventStars: eventIds.length,
      eventLabels: eventFocus.edgeLabels,
      mode: weighted.mode
    },
    single,
    backMode,
    time: timeView
  }
}

app.whenReady().then(async () => {
  let dir = null
  try {
    dir = await startServer()
    const win = new BrowserWindow({
      width: 1480,
      height: 920,
      show: true,
      backgroundColor: '#05060d',
      webPreferences: { backgroundThrottling: false }
    })
    await win.loadURL('http://' + HOST + ':' + PORT + '/#starmap')
    await wait(1400)

    const r = await run(win)
    const near = (a, b, tol) => Math.abs(a - b) <= tol

    const checks = [
      ['星图挂载并出图', r.home.nodes > 0 && r.home.edges > 0, r.home.nodes + ' 星 / ' + r.home.edges + ' 边'],
      ['全景装得下所有星体', r.framing.outside.length === 0,
        r.framing.total + ' 颗，越界 ' + (r.framing.outside.length ? r.framing.outside.join('、') : '0')],
      ['聚焦目标等于星体三维坐标', r.focus.targetErr < 0.5, '偏差 ' + r.focus.targetErr.toFixed(3)],
      ['聚焦后星体落在画面正中', r.focus.centerDx < 2 && r.focus.centerDy < 2,
        '偏移 ' + r.focus.centerDx.toFixed(1) + ' / ' + r.focus.centerDy.toFixed(1) + ' px'],
      ['聚焦距离小于全景', r.focus.dist < r.home.dist, r.focus.dist.toFixed(0) + ' < ' + r.home.dist.toFixed(0)],
      ['总览清空焦点并退回全景', r.overview.focus === null && near(r.overview.dist, r.overview.homeDist, 1),
        '焦点 ' + r.overview.focus + ' · 距离 ' + r.overview.dist.toFixed(1)],
      ['滚轮单步推拉', near(r.wheel.ratioFresh, r.wheel.expected, 0.02), r.wheel.ratioFresh.toFixed(3) + ' / 期望 ' + r.wheel.expected.toFixed(3)],
      ['重绘后滚轮不叠加', near(r.wheel.ratioAfter, r.wheel.expected, 0.02), r.wheel.ratioAfter.toFixed(3) + '（切换 ' + r.wheel.switches + ' 次）'],
      ['拖拽只旋转视角', near(r.drag.dYaw, r.drag.expected, 0.02) && r.drag.focus === null,
        'Δyaw ' + r.drag.dYaw.toFixed(3) + ' / 期望 ' + r.drag.expected.toFixed(3)],
      ['点击星体命中并聚焦', r.click.focus === 'super', '焦点 ' + r.click.focus],
      ['聚焦后连线上出现百分比', r.percent.mode === 'data' && r.percent.weightEdges > 0 && r.percent.edgeLabels > 0,
        r.percent.projectStars + ' 个项目星 · ' + r.percent.weightEdges + ' 条权重边 · 项目连线画出 ' +
        r.percent.edgeLabels + ' 个百分比 · 焦点 ' + r.percent.focus + ' · ' + r.percent.mode],
      ['事件星也带自己的相关度', r.percent.eventStars > 0 && r.percent.eventLabels > 0,
        r.percent.eventStars + ' 个事件星 · 事件连线画出 ' + r.percent.eventLabels + ' 个百分比'],
      ['单星位图：单独一张近/远权重图', r.single.mode === 'node' && r.single.nodes >= 2 &&
        r.single.weightEdges >= 1 && r.single.edgeLabels >= 1,
        r.single.nodes + ' 星 · ' + r.single.weightEdges + ' 条权重边 · 画出 ' + r.single.edgeLabels + ' 个百分比'],
      ['单星位图：可返回主星图', r.single.backShown && /单星位图/.test(r.single.summary) && r.backMode === 'data',
        r.single.summary.slice(0, 40) + ' → ' + r.backMode],
      ['时间视图：一周热力格与周记', r.time.grid === 168 && r.time.lit > 0 && r.time.weeks >= 1 && /条记录/.test(r.time.body),
        r.time.grid + ' 格 · ' + r.time.lit + ' 格有数据 · ' + r.time.weeks + ' 篇周记'],
      ['时间视图：当前时段提示', /还没有|通常在|这个时段/.test(r.time.suggest), r.time.suggest.slice(0, 42)],
      ['时间视图：进程阶段面板', r.time.phaseAsk.length > 0 && r.time.phaseGroups >= 1,
        r.time.phaseGroups + ' 组阶段概率 · ' + r.time.phaseAsk.slice(0, 36)]
    ]

    let failed = 0
    for (const [name, ok, detail] of checks) {
      if (!ok) failed++
      console.log((ok ? '  ✓ ' : '  ✗ ') + name + ' · ' + detail)
    }
    console.log(failed === 0 ? '\n星图探针通过（' + checks.length + ' 项）' : '\n星图探针失败 ' + failed + ' 项')
    app.exit(failed === 0 ? 0 : 1)
  } catch (err) {
    console.error('  ✗ ' + (err && err.message))
    app.exit(1)
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {} }
  }
}).catch((err) => {
  console.error('  ✗ ' + (err && err.message))
  app.exit(1)
})
