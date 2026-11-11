#!/usr/bin/env node
'use strict'

/* probe-net.js — 三张网的端到端探针（真实 Electron + 真实记忆库）
 *
 * test-memory 验的是纯 Node 下的算法；这里验的是接进星界之后的那几段：
 *   - 启动时把界面项目镜像进记忆库，成为项目网的节点；
 *   - 渲染层能按 query 回忆，返回最相关的项目而不是全库；
 *   - 项目网 / 事件网 / 时间网分开返回，周记与时段习惯能经 preload 读到；
 *   - 记忆工具的 schema 里有 memory_recall 与 memory_time。
 *
 * 用法：node scripts/probe-net.js
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createMemoryStore, ROLE } = require('../electron/memory/store.js')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 120000

function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function evalScript (timeAt, scoutRoot, mealAt) {
  const at = JSON.stringify(timeAt)
  const root = JSON.stringify(scoutRoot)
  const meal = JSON.stringify(mealAt)
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 80; i++) {
      if (window.Astral && window.astral) break
      await sleep(250)
    }
    if (!window.astral) return { ok: false, error: 'preload 未就绪' }

    const sync = await window.astral.memorySyncProjects({
      projects: [{ name: '星界', rootPath: 'C:/Astral', summary: '桌面端记忆与协作' }]
    })
    const recall = await window.astral.memoryRecall({ query: '投票项目登录报错那次怎么修的' })
    const net = await window.astral.memoryNet()
    const habit = await window.astral.memoryTime({ action: 'habit', at: ${at} })
    const suggest = await window.astral.memoryTime({ action: 'suggest', at: ${at} })
    const weeks = await window.astral.memoryTime({ action: 'weeks' })
    const phase = await window.astral.memoryTime({ action: 'phase' })
    const phases = await window.astral.memoryTime({ action: 'phases' })
    const status = await window.astral.memoryStatus()
    const mcp = await window.astral.mcpList()
    /* 探子链路：只读扫描 → 摘要入库 → 近期观察 → 到饭点询问 */
    const scan = await window.astral.scoutScan({ rootPath: ${root} })
    const commit = await window.astral.memoryCommitScout({
      project: '探子项目', text: '探子扫描：登录模块与投票页面', rootPath: ${root}
    })
    const observe = await window.astral.memoryTime({
      action: 'observe', text: '今天想吃火锅', kind: 'meal', source: 'chat', at: ${meal}
    })
    const mealSuggest = await window.astral.memoryTime({ action: 'suggest', at: ${meal} })

    let hasTool = false
    let hasTimeTool = false
    for (const server of (mcp.servers || [])) {
      for (const tool of (server.tools || [])) {
        if (tool.name === 'memory_recall') hasTool = true
        if (tool.name === 'memory_time') hasTimeTool = true
      }
    }
    return {
      ok: true,
      sync: sync && { ok: sync.ok, added: sync.data && sync.data.added, updated: sync.data && sync.data.updated },
      recall: recall && {
        ok: recall.ok,
        projects: (recall.data && recall.data.projects) || [],
        events: (recall.data && recall.data.events) || [],
        text: (recall.data && recall.data.text) || '',
        stats: recall.stats || null
      },
      net: net && {
        ok: net.ok, stats: net.data && net.data.stats,
        links: net.data && net.data.links,
        eventLinks: net.data && net.data.eventLinks,
        time: net.data && net.data.time
      },
      habit: habit && habit.data,
      suggest: suggest && suggest.data,
      weeks: weeks && weeks.data,
      phase: phase && {
        ok: phase.ok,
        found: phase.data && phase.data.found,
        stage: phase.data && phase.data.phase,
        events: phases && phases.data && phases.data.events
      },
      tables: (status.tables || []).map((t) => t.name),
      hasTool,
      hasTimeTool,
      scout: {
        scanOk: Boolean(scan && scan.ok),
        scanned: scan && scan.stats && scan.stats.scanned,
        commit: commit && { ok: commit.ok, projects: commit.data && commit.data.projects, events: commit.data && commit.data.events },
        observeOk: Boolean(observe && observe.ok),
        meal: mealSuggest && mealSuggest.data && {
          found: mealSuggest.data.found,
          via: mealSuggest.data.via,
          text: mealSuggest.data.text
        }
      }
    }
  })()`
}

function runElectron (dir, timeAt, scoutRoot, mealAt) {
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ASTRAL_EVAL = evalScript(timeAt, scoutRoot, mealAt)
    env.ASTRAL_EVAL_DELAY = '2600'
    env.ASTRAL_TRUST_RUN_OWNER = '1'
    env.ASTRAL_MULTI = '1'
    const child = spawn(require('electron'), ['.'], {
      cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill(); resolve({ stderr, timedOut: true }) }, TIMEOUT)
    child.on('error', (err) => { clearTimeout(timer); resolve({ stderr, error: err.message }) })
    child.on('exit', () => { clearTimeout(timer); resolve({ stderr }) })
  })
}

function parseEval (stderr) {
  const matches = [...stderr.matchAll(/\[eval\]\s+(\{[\s\S]*?\})\s*$/gm)]
  if (!matches.length) return null
  try { return JSON.parse(matches[matches.length - 1][1]) } catch { return null }
}

async function main () {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-probe-net-'))
  try {
    fs.cpSync(path.join(ROOT, 'app'), path.join(temp, 'app'), { recursive: true })
    fs.cpSync(path.join(ROOT, 'electron'), path.join(temp, 'electron'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(temp, 'package.json'))

    writeJson(path.join(temp, 'config', 'settings.json'), {
      theme: 'astral',
      onboarding: { knowledgePrompted: true },
      plugins: { knowledge: { enabled: false }, stardust: { enabled: false } },
      app: { closeToTray: false },
      bridge: { enabled: false },
      profile: { name: '探针', short: '探针', role: 'admin' }
    })
    writeJson(path.join(temp, 'config', 'mcp.json'), { version: 1, servers: [] })

    /* 先造一段历史：三个项目、各一条事件，关系明确；
       再往连续三个周一的 21 点各塞一条，时间网才有足够样本开口。 */
    const habitStamps = [
      new Date(2026, 9, 26, 21, 10),
      new Date(2026, 10, 2, 21, 20),
      new Date(2026, 10, 9, 21, 30)
    ].map((date) => date.toISOString())
    const timeAt = new Date(2026, 10, 9, 21, 0).toISOString()
    const store = createMemoryStore({ configDir: path.join(temp, 'config') })
    try {
      store.write({ actor: ROLE.SUPER, action: 'project', name: '投票项目', summary: '投票系统的登录与权限' })
      store.write({ actor: ROLE.SUPER, action: 'project', name: '记忆库重构', summary: '记忆模块的项目权重网' })
      store.write({ actor: ROLE.SUPER, action: 'project', name: '官网改版', summary: '首页视觉与配色' })
      store.write({ actor: ROLE.SUPER, action: 'event', project: '投票项目', prefix: 'BB', summary: '修复登录报错：验证码校验顺序写反了' })
      store.write({ actor: ROLE.SUPER, action: 'event', project: '记忆库重构', prefix: 'P', summary: '项目权重网落地：tf-idf 与图扩散' })
      store.write({ actor: ROLE.SUPER, action: 'event', project: '官网改版', prefix: 'UI', summary: '首页换成深空配色' })
      habitStamps.forEach((stamp, i) => {
        store.write({
          actor: ROLE.SUPER, action: 'event', project: '记忆库重构', prefix: 'P',
          summary: '周一晚上推进时间网与周记 ' + i, startedAt: stamp
        })
      })
    } finally { store.close() }

    const run = await runElectron(
      temp, timeAt,
      path.join(temp, 'app', 'js'),
      new Date(2026, 10, 10, 12, 0).toISOString()
    )
    const r = parseEval(run.stderr)
    if (!r) {
      console.error('✗ 未拿到 eval 结果')
      console.error(String(run.stderr || '').split('\n').slice(-14).join('\n'))
      return 1
    }
    if (!r.ok) { console.error('✗ ' + r.error); return 1 }

    const failures = []
    if (!r.sync || !r.sync.ok) failures.push('项目镜像失败：' + JSON.stringify(r.sync))
    if (!r.recall || !r.recall.ok) failures.push('回忆失败：' + JSON.stringify(r.recall))
    else {
      const top = r.recall.projects[0]
      if (!top || top.id !== '投票项目') failures.push('没有优先命中投票项目：' + JSON.stringify(r.recall.projects))
      if (!r.recall.events.length) failures.push('没有取回相关事件')
      if (r.recall.events.some((e) => e.project !== '投票项目')) failures.push('带回了无关项目的事件：' + JSON.stringify(r.recall.events))
      if (/配色/.test(r.recall.text)) failures.push('无关项目内容出现在回忆文本里')
      if (!/相关项目/.test(r.recall.text)) failures.push('回忆文本缺少分区标题')
      if (!r.recall.stats || r.recall.stats.chars > 900) failures.push('回忆没有守住字数预算')
    }
    if (!r.net || !r.net.ok) failures.push('权重网读取失败')
    else {
      if (r.net.stats.nodes < 4) failures.push('节点数不对（3 个历史项目 + 镜像的星界）：' + JSON.stringify(r.net.stats))
      if (!Array.isArray(r.net.links)) failures.push('连边没有返回')
    }
    if (!r.hasTool) failures.push('记忆工具里没有 memory_recall（模型无法主动回忆）')
    if (!r.hasTimeTool) failures.push('记忆工具里没有 memory_time（模型答不了作息类问题）')
    if (!r.net || !r.net.stats || !r.net.stats.recalls) failures.push('回忆没有落进 recall_log')
    if (!Array.isArray(r.net && r.net.eventLinks)) failures.push('事件网连边没有返回')
    if (!r.net || !r.net.time || r.net.time.weeks < 3) failures.push('时间网没有按周生成周记')
    if (!r.habit || !r.habit.found || !r.habit.rows.length || r.habit.rows[0].percent <= 0) {
      failures.push('周一 21 点的时段习惯没读到：' + JSON.stringify(r.habit))
    } else {
      if (r.habit.rows[0].weeks !== 3) failures.push('时间权重没按跨周重复算：' + JSON.stringify(r.habit.rows[0]))
      if (r.habit.rows[0].percent >= 100) failures.push('三周样本不该报 100% 时间置信')
    }
    if (!r.suggest || !r.suggest.found) failures.push('时间建议没生成：' + JSON.stringify(r.suggest))
    else {
      if (!/要不要我先起个头/.test(r.suggest.text || '')) failures.push('时间建议缺少「要不要帮你做」的措辞')
      if (!/连续 3 周/.test(r.suggest.text || '')) failures.push('时间建议没有说明跨了几周')
    }
    if (!Array.isArray(r.weeks) || r.weeks.length < 3) failures.push('时间文档列表没按周返回')
    if (!r.phase || !r.phase.ok) failures.push('进程阶段判断没返回')
    else if (!r.phase.events || r.phase.events < 6) failures.push('进程轨迹没覆盖全部事件：' + JSON.stringify(r.phase))
    if (!r.scout || !r.scout.scanOk) failures.push('探子扫描没成功')
    else {
      if (!r.scout.scanned) failures.push('探子没有读到文本文件')
      if (!r.scout.commit || !r.scout.commit.ok) failures.push('探子摘要没写进权重网')
      if (!r.scout.observeOk) failures.push('近期观察没写入')
      if (!r.scout.meal || r.scout.meal.via !== 'observation') failures.push('到饭点没生成观察询问')
    }

    console.log('--- 镜像 ---')
    console.log(JSON.stringify(r.sync))
    console.log('--- 回忆 ---')
    console.log(JSON.stringify(r.recall))
    console.log('--- 三张网 ---')
    console.log(JSON.stringify({
      project: r.net && r.net.stats,
      events: (r.net && r.net.eventLinks || []).length,
      time: r.net && r.net.time
    }))
    console.log('--- 时间建议 ---')
    console.log(JSON.stringify(r.suggest))
    console.log('--- 进程阶段 ---')
    console.log(JSON.stringify(r.phase))
    console.log('--- 探子与观察 ---')
    console.log(JSON.stringify(r.scout))

    if (failures.length) {
      console.log('--- 结论 ---')
      for (const failure of failures) console.log('✗ ' + failure)
      return 1
    }
    console.log('--- 结论 ---')
    console.log('✓ 启动后项目镜像进记忆库，权重网节点与左侧一致')
    console.log('✓ 回忆按权重只取相关项目与事件，无关内容不出现，字数受预算约束')
    console.log('✓ 项目网 / 事件网 / 时间网分别返回，周记与时段习惯能经 preload 读到')
    console.log('✓ 进程阶段按事件轨迹重建，phase / phases 两个动作都能从渲染层调用')
    console.log('✓ 探子只读扫描 → 摘要入库 → 近期观察 → 到饭点生成具体询问，全链路可经 preload 调用')
    console.log('✓ memory_recall 与 memory_time 已进入工具清单，模型可自行调用')
    return 0
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 }) } catch { /* Windows 下可能 EBUSY */ }
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
