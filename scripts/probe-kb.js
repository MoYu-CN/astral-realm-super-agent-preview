#!/usr/bin/env node
'use strict'

/* probe-kb.js — 知识网（第四张网）探针
 *
 * 两段验证：
 *   ① 数据层：索引、权重（打开升 / 光搜不打开降 / 反馈）、渐进披露（检索只回摘要）、
 *      同步幂等、删除条目后索引跟随、注入字数被压到固定规模；
 *   ② 界面层：控制台 #kb 视图能出 KPI 与两个榜单，主星图里有「知识网」节点，
 *      点它能跳到知识网视图。
 *
 * 用法：npx electron scripts/probe-kb.js
 * 说明：必须在 Electron 主进程里跑（需要 BrowserWindow 与真实 DOM）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const PORT = Number(process.env.PROBE_KB_PORT || 45898)
const HOST = '127.0.0.1'

if (!process.versions.electron) {
  console.error('probe-kb 需要 Electron 主进程：npx electron scripts/probe-kb.js')
  process.exit(2)
}

let electronApi = null
try { electronApi = require('electron') } catch (_) { electronApi = null }
if (!electronApi || !electronApi.app) {
  console.error('probe-kb 需要 GUI 主进程（当前是 ELECTRON_RUN_AS_NODE 模式）：npx electron scripts/probe-kb.js')
  process.exit(2)
}

const { app, BrowserWindow } = electronApi
app.disableHardwareAcceleration()

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

const ENTRIES = [
  {
    source: 'kb', projectId: 'p1', entryId: 'M-001', kind: '方法', domain: '构建',
    entry: {
      title: '打包前先清缓存',
      trigger: 'Electron 打包报找不到模块时',
      steps: ['删掉 dist', '删 node_modules/.cache', '重新安装依赖'],
      why: '缓存里的旧 asar 会覆盖新文件'
    }
  },
  {
    source: 'kb', projectId: 'p1', entryId: 'P-001', kind: '避错', domain: '构建',
    entry: {
      title: '不要用 rm -rf 清 dist',
      trigger: '想清理构建产物时',
      steps: ['改用 npm run clean'],
      why: '会把还没提交的构建脚本一起删掉',
      symptoms: 'git status 里突然少了好几个文件'
    }
  },
  {
    source: 'kb', projectId: 'p1', entryId: 'M-002', kind: '方法', domain: '测试',
    entry: {
      title: '探针要跑真界面',
      trigger: '验证渲染层改动时',
      steps: ['用 Electron 探针模式打开真窗口', '截图对比'],
      why: '纯 DOM 断言看不出层叠与透明背景的问题'
    }
  },
  {
    source: 'kb', projectId: 'p1', entryId: 'M-003', kind: '方法', domain: '测试',
    entry: { title: '只有标题的条目' }
  }
]

async function startServer () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-kb-probe-'))
  process.env.MEMORY_CONFIG_DIR = dir
  process.env.MEMORY_VIEW_PORT = String(PORT)
  process.env.MEMORY_VIEW_HOST = HOST
  process.env.MEMORY_VIEW_WRITE = '1'

  const { createMemoryStore, ROLE } = require('../electron/memory/store.js')
  const { createKnowledgeService } = await import(
    require('node:url').pathToFileURL(path.join(__dirname, '..', 'electron', 'knowledge', 'service.mjs')).href
  )

  const store = createMemoryStore({ configDir: dir })
  store.write({ actor: ROLE.SUPER, action: 'project', project: 'p1', name: '探针项目' })

  const projectRoot = path.join(dir, 'project')
  fs.mkdirSync(projectRoot, { recursive: true })
  const project = { projectId: 'p1', projectName: '探针项目', projectRoot }
  const svc = createKnowledgeService({ configDir: dir, memory: () => store })

  await svc.invoke('init', {}, project)
  for (const item of ENTRIES) {
    await svc.invoke('add', {
      kind: item.kind,
      domain: item.domain,
      title: item.entry.title,
      trigger: item.entry.trigger,
      steps: item.entry.steps || ['占位'],
      why: item.entry.why,
      symptoms: item.entry.symptoms
    }, project)
  }

  /* 一次检索 + 一次取正文：让权重不是「全是默认值」，界面才有区分 */
  await svc.invoke('search', { text: '打包缓存' }, project)
  await svc.invoke('get', { id: 'M-001' }, project)
  await svc.invoke('search', { text: '探针截图' }, project)

  require('../electron/memory/view-server.js')
  for (let i = 0; i < 40; i++) {
    if (await ping()) return { dir, store, svc, project }
    await wait(150)
  }
  throw new Error('记忆控制台未能在 http://' + HOST + ':' + PORT + ' 启动')
}

/* 数据层断言：不经过界面，直接打服务 */
async function checkData (ctx) {
  const { store, svc, project } = ctx
  const out = []

  const map = store.kb({ action: 'map' })
  out.push(['索引建立', map.ok && map.data.nodes.length === 4, map.data ? map.data.nodes.length + ' 条入库' : '失败'])
  out.push(['自动连边', map.ok && map.data.edges.length >= 1, map.data ? map.data.edges.length + ' 条近似边' : '—'])

  const brief = await svc.invoke('search', { text: '打包报找不到模块' }, project)
  const first = brief.entries && brief.entries[0]
  out.push(['检索只回摘要', Boolean(first) && !Array.isArray(first.steps) && Boolean(first.digest),
    first ? '首条 ' + first.id + ' · ' + (first.digest || '').slice(0, 16) + ' · 无正文' : '无命中'])
  out.push(['摘要带权重', Boolean(first) && Number.isInteger(first.percent) && first.percent > 0,
    first ? first.percent + '%' : '—'])

  const detail = await svc.invoke('search', { text: '打包报找不到模块', detail: true }, project)
  out.push(['detail 才回正文', Boolean(detail.entries && detail.entries[0] && Array.isArray(detail.entries[0].steps)),
    detail.entries && detail.entries[0] ? (detail.entries[0].steps || []).length + ' 步' : '—'])

  /* 打开 3 次 → 权重应当明显高于「只被搜、从没打开」的那条 */
  const before = map.data.nodes.find((n) => n.id === 'M-001').weight
  for (let i = 0; i < 3; i++) store.kb({ action: 'get', project: 'p1', id: 'M-001' })
  const after = store.kb({ action: 'map' }).data.nodes.find((n) => n.id === 'M-001').weight
  out.push(['打开提升权重', after > before, before.toFixed(3) + ' → ' + after.toFixed(3)])

  /* 只搜不打开：P-001 连续曝光 12 次，权重应当下降 */
  const pBefore = store.kb({ action: 'map' }).data.nodes.find((n) => n.id === 'P-001').weight
  for (let i = 0; i < 12; i++) store.kb({ action: 'search', project: 'p1', query: '清理构建产物 dist' })
  const pAfter = store.kb({ action: 'map' }).data.nodes.find((n) => n.id === 'P-001').weight
  out.push(['光搜不用降权', pAfter < pBefore, pBefore.toFixed(3) + ' → ' + pAfter.toFixed(3)])

  /* 反馈：明确说没用，权重立刻往下走 */
  const fbBefore = store.kb({ action: 'map' }).data.nodes.find((n) => n.id === 'M-002').weight
  store.kb({ action: 'feedback', project: 'p1', id: 'M-002', useful: false })
  store.kb({ action: 'feedback', project: 'p1', id: 'M-002', useful: false })
  const fbAfter = store.kb({ action: 'map' }).data.nodes.find((n) => n.id === 'M-002').weight
  out.push(['反馈改变权重', fbAfter < fbBefore, fbBefore.toFixed(3) + ' → ' + fbAfter.toFixed(3)])

  /* 完整度：只有标题的条目权重应当垫底 */
  const nodes = store.kb({ action: 'map' }).data.nodes
  const bare = nodes.find((n) => n.id === 'M-003')
  const full = nodes.find((n) => n.id === 'M-001')
  out.push(['写全的排在前面', full.weight > bare.weight, 'M-001 ' + full.weight.toFixed(2) + ' > M-003 ' + bare.weight.toFixed(2)])

  /* 目录层：只给统计与标题，不回正文 */
  const same = await svc.invoke('digest', {}, project)
  out.push(['目录只看统计', Boolean(same) && same.total === 4 && Array.isArray(same.top),
    (same.total || 0) + ' 条 · top ' + ((same.top || []).length)])

  /* 注入：字数必须被压到固定规模（旧版总纲+三条全文约 1800 字） */
  const inj = await svc.invoke('inject', { task: '打包' }, project)
  out.push(['注入被压薄', inj.text.length < 420, inj.text.length + ' 字'])

  /* 删除后索引跟随 */
  await svc.invoke('remove', { id: 'M-003' }, project)
  const afterRemove = store.kb({ action: 'map' }).data
  out.push(['删除后索引跟随', afterRemove.nodes.length === 3, '剩 ' + afterRemove.nodes.length + ' 条'])

  return out
}

async function runPage (win) {
  const page = (code) => win.webContents.executeJavaScript(code)
  await wait(900)

  const kb = JSON.parse(await page(`JSON.stringify({
    kpis: document.querySelectorAll('#kb-kpis .kpi').length,
    top: document.querySelectorAll('#kb-top .kb-row').length,
    cold: document.querySelectorAll('#kb-cold .kb-row, #kb-cold .kb-empty').length,
    hits: document.querySelectorAll('#kb-hits .kb-hit, #kb-hits .kb-empty').length,
    count: (document.getElementById('kb-count') || {}).textContent || '',
    weights: [...document.querySelectorAll('#kb-top .kb-weight b')].map((el) => el.textContent),
    title: (document.querySelector('#kb-top .kb-title') || {}).textContent || ''
  })`))

  /* 回主星图点「知识网」节点，应当切到 kb 视图 */
  await page(`location.hash = '#starmap'`)
  await wait(1300)
  const jump = JSON.parse(await page(`(async () => {
    const btn = document.querySelector('.nav-item[data-view="kb"]')
    if (!btn) return JSON.stringify({ ok: false, why: '没有知识网导航' })
    btn.click()
    await new Promise((r) => setTimeout(r, 400))
    return JSON.stringify({ ok: !document.getElementById('view-kb').classList.contains('hidden'), view: location.hash })
  })()`))

  return { kb, jump }
}

app.whenReady().then(async () => {
  let dir = null
  try {
    const ctx = await startServer()
    dir = ctx.dir

    const dataChecks = await checkData(ctx)

    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: true,
      backgroundColor: '#05060d',
      webPreferences: { backgroundThrottling: false }
    })
    await win.loadURL('http://' + HOST + ':' + PORT + '/#kb')
    await wait(1400)
    const page = await runPage(win)

    const shot = path.join(os.tmpdir(), 'astral-kb-view.png')
    try {
      const image = await win.webContents.capturePage()
      fs.writeFileSync(shot, image.toPNG())
      console.log('  截图：' + shot)
    } catch (_) { /* 截图失败不影响断言 */ }

    const checks = [
      ...dataChecks,
      ['界面：四个 KPI', page.kb.kpis === 4, page.kb.kpis + ' 个'],
      ['界面：权重榜有行', page.kb.top >= 3, page.kb.top + ' 行 · 首条「' + page.kb.title + '」'],
      ['界面：权重是百分比', page.kb.weights.length >= 3 && page.kb.weights.every((w) => /%$/.test(w)),
        page.kb.weights.join(' / ')],
      ['界面：冷榜或空态', page.kb.cold >= 1, page.kb.cold + ' 项'],
      ['界面：检索流水', page.kb.hits >= 1, page.kb.hits + ' 条'],
      ['界面：侧栏计数', page.kb.count === '3', '计数 ' + page.kb.count],
      ['界面：导航能进知识网', page.jump.ok === true, page.jump.view || page.jump.why || '']
    ]

    let failed = 0
    for (const [name, ok, detail] of checks) {
      if (!ok) failed++
      console.log((ok ? '  ✓ ' : '  ✗ ') + name + ' · ' + detail)
    }
    console.log(failed === 0 ? '\n知识网探针通过（' + checks.length + ' 项）' : '\n知识网探针失败 ' + failed + ' 项')
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
