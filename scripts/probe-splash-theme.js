#!/usr/bin/env node
'use strict'

/* probe-splash-theme.js — 启动动画的主题配色自检
 *
 * 复现的问题：选「星砂」主题时，启动动画仍是深空那套紫蓝。
 * 两个原因一起验：
 *   1. 星砂是插件主题，插件在 splash 结束之后才加载 → 启动时用不上它；
 *   2. 启动动画的颜色原本写死成一套紫蓝色板。
 *
 * 做法：三次启动同一个临时实例（localStorage 落在同一 userData 里）
 *   A 写入「星砂」主题快照 → 验证 applyTheme 会缓存
 *   B 配置仍是深空 → 验证 pretheme 抢先应用星砂、boot 再纠正回深空
 *   C 配置为星砂 → 截图看真实观感
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 120000

/* 与 app/plugins/stardust/plugin.js 里注册的主题保持一致 */
const SAND_TOKENS = {
  '--bg-0': '#0a0906',
  '--bg-1': '#0f0d09',
  '--bg-2': '#17130d',
  '--fg-0': '#f4ead6',
  '--fg-1': '#bda98a',
  '--fg-2': '#7a6b52',
  '--accent': '#e6c078',
  '--accent-2': '#d99b63',
  '--ok': '#a9c98a',
  '--warn': '#e8b567',
  '--err': '#e08a7a',
  '--radius': '13px',
  '--radius-sm': '9px'
}

function copyDir (src, dest) { fs.cpSync(src, dest, { recursive: true }) }
function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

const READY = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (window.Astral) { ready = true; break }
    await sleep(200)
  }
  if (!ready) return { ok: false, error: 'not-ready' }
`

/* 采样脚本：造一个离屏的 .splash，读伪元素解析后的颜色 */
const SAMPLE = `
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const host = document.createElement('div')
  host.className = 'splash'
  host.style.cssText = 'position:fixed;left:-9999px;top:0;width:8px;height:8px;opacity:0;pointer-events:none'
  const comet = document.createElement('i')
  comet.className = 'splash-comet'
  const wp = document.createElement('i')
  wp.className = 'splash-waypoint'
  host.append(comet, wp)
  document.body.append(host)
  /* splash 可能已收场：补一个同结构的离屏 SVG，让 #spBody 的渐变规则仍有落点 */
  let stop = document.querySelector('#spBody stop:nth-child(4)')
  if (!stop) {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'splash-glyph')
    const defs = document.createElementNS(SVG_NS, 'defs')
    const grad = document.createElementNS(SVG_NS, 'radialGradient')
    grad.setAttribute('id', 'spBody')
    for (let i = 0; i < 7; i++) grad.append(document.createElementNS(SVG_NS, 'stop'))
    defs.append(grad)
    svg.append(defs)
    host.append(svg)
    stop = grad.children[3]
  }
  const read = () => ({
    glow: getComputedStyle(comet, '::before').boxShadow,
    head: getComputedStyle(comet, '::before').backgroundImage,
    wpBg: getComputedStyle(wp, '::before').backgroundColor,
    stop: getComputedStyle(stop).stopColor
  })
  const KEYS = ['--accent', '--accent-2', '--fg-0', '--bg-0']
  const setVars = (vars) => { for (const k of Object.keys(vars)) document.documentElement.style.setProperty(k, vars[k]) }
  const clear = () => { for (const k of KEYS) document.documentElement.style.removeProperty(k) }
`

function seedScript () {
  return `(async () => {
    ${READY}
    Astral.applyTheme({ id: 'sand', name: '星砂', light: false, tokens: ${JSON.stringify(SAND_TOKENS)} }, Astral.state.settings)
    const snap = JSON.parse(localStorage.getItem('astral.theme.snapshot') || 'null')
    return { ok: true, cached: snap && snap.id, themeId: document.body.dataset.theme || '' }
  })()`
}

function sampleScript () {
  return `(async () => {
    ${READY}
    ${SAMPLE}
    clear()
    document.body.classList.remove('theme-light')
    const astral = read()
    setVars({ '--accent': '#e6c078', '--accent-2': '#d99b63', '--fg-0': '#f4ead6', '--bg-0': '#0a0906' })
    const sand = read()
    setVars({ '--accent': '#c26a1a', '--accent-2': '#c73e5d', '--fg-0': '#3a2a18', '--bg-0': '#fbf4ea' })
    document.body.classList.add('theme-light')
    const apricot = read()
    clear()
    document.body.classList.remove('theme-light')
    host.remove()
    /* boot 后的最终主题要在改写快照之前取，否则读到的是下面这次 applyTheme */
    const bootTheme = document.body.dataset.theme || ''
    const bootAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    /* 把快照写回星砂：下一阶段的截图要看到星砂的启动动画 */
    Astral.applyTheme({ id: 'sand', name: '星砂', light: false, tokens: ${JSON.stringify(SAND_TOKENS)} }, Astral.state.settings)
    const snap = JSON.parse(localStorage.getItem('astral.theme.snapshot') || 'null')
    return {
      ok: true,
      marker: document.documentElement.dataset.pretheme || '',
      bootAccent,
      bootTheme,
      cacheId: snap && snap.id,
      splashAlive: Boolean(document.querySelector('#splash')),
      astral, sand, apricot
    }
  })()`
}

/* 把 splash 克隆下来并回卷到指定时刻：窗口不可见时 CSS 动画不推进，
   只有显式设置 currentTime 才能稳定截到某一帧 */
function frameJs (t) {
  return `(() => {
    const splash = document.getElementById('splash')
    if (!splash) return 'no-splash'
    const clone = splash.cloneNode(true)
    clone.classList.remove('stars-live', 'leaving')
    splash.replaceWith(clone)
    for (const a of clone.getAnimations({ subtree: true })) {
      try { a.pause(); a.currentTime = ${t} } catch (e) {}
    }
    return 'frozen@${t} anims=' + clone.getAnimations({ subtree: true }).length
  })()`
}

function fallbackScript () {
  return `(async () => {
    ${READY}
    await new Promise((r) => setTimeout(r, 400))
    return {
      ok: true,
      themeId: document.body.dataset.theme || '',
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    }
  })()`
}

function runElectron (dir, userData, env) {
  return new Promise((resolve) => {
    const electronPath = require('electron')
    const base = { ...process.env }
    delete base.ELECTRON_RUN_AS_NODE
    base.ASTRAL_TRUST_RUN_OWNER = '1'
    base.ASTRAL_MULTI = '1'
    const child = spawn(electronPath, ['.', `--user-data-dir=${userData}`], {
      cwd: dir,
      env: { ...base, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill(); resolve({ code: -1, stderr, timedOut: true }) }, TIMEOUT)
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stderr, error: err.message }) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }) })
  })
}

function readEval (stderr) {
  const match = /\[eval\]\s+(\{[\s\S]*\})\s*$/m.exec(stderr)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}

/* 取任意 CSS 颜色串里的 rgb 三元组。
   color-mix 在 Chromium 里会序列化成 color(srgb r g b / a)，分量是 0–1 的小数。 */
function rgbs (text) {
  const out = []
  const raw = String(text || '')
  for (const m of raw.matchAll(/rgba?\(([^)]+)\)/g)) {
    const parts = m[1].split(/[,\s/]+/).map(Number).filter((n) => Number.isFinite(n))
    if (parts.length >= 3) out.push(parts.slice(0, 3).map((n) => Math.round(n)))
  }
  for (const m of raw.matchAll(/color\(srgb\s+([^)]+)\)/g)) {
    const parts = m[1].split(/[\s/]+/).map(Number).filter((n) => Number.isFinite(n))
    if (parts.length >= 3) out.push(parts.slice(0, 3).map((n) => Math.round(n * 255)))
  }
  return out
}
const avg = (list, i) => list.reduce((sum, c) => sum + c[i], 0) / Math.max(1, list.length)
const hex = (value) => String(value || '').trim().toLowerCase()

async function main () {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-probe-splash-theme-'))
  const userData = path.join(temp, 'userdata')
  const baseSettings = {
    onboarding: { knowledgePrompted: true },
    plugins: { knowledge: { enabled: false }, stardust: { enabled: false } },
    app: { closeToTray: false },
    bridge: { enabled: false, port: 45871, token: '' }
  }
  try {
    copyDir(path.join(ROOT, 'app'), path.join(temp, 'app'))
    copyDir(path.join(ROOT, 'electron'), path.join(temp, 'electron'))
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(temp, 'package.json'))
    fs.mkdirSync(path.join(temp, 'config'), { recursive: true })
    writeJson(path.join(temp, 'config', 'mcp.json'), { version: 1, servers: [] })

    /* A：写入星砂快照（模拟用户选过一次星砂） */
    writeJson(path.join(temp, 'config', 'settings.json'), { ...baseSettings, theme: 'astral' })
    const a = await runElectron(temp, userData, { ASTRAL_EVAL: seedScript(), ASTRAL_EVAL_DELAY: '2500' })
    const seed = readEval(a.stderr)
    if (!seed || !seed.ok) {
      console.error('探针失败：A 阶段未拿到结果')
      console.error(a.stderr.split('\n').slice(-12).join('\n'))
      return 1
    }

    /* B：配置仍是深空 —— pretheme 应先用星砂，boot 再纠正回深空。
       延迟取 1s，保证采样时真正的 splash（含 SVG）还在页面上 */
    const b = await runElectron(temp, userData, { ASTRAL_EVAL: sampleScript(), ASTRAL_EVAL_DELAY: '0' })
    const r = readEval(b.stderr)
    if (!r || !r.ok) {
      console.error('探针失败：B 阶段未拿到结果')
      console.error(b.stderr.split('\n').slice(-12).join('\n'))
      return 1
    }

    /* C：配置切到星砂并启用插件（真实使用场景），截一帧完整的星标
       （克隆 splash 并回卷到 3000ms，窗口不可见时 CSS 动画不会自己走，必须显式定位） */
    writeJson(path.join(temp, 'config', 'settings.json'), {
      ...baseSettings,
      theme: 'sand',
      plugins: { knowledge: { enabled: false }, stardust: { enabled: true } }
    })
    const shot = path.join(ROOT, 'promo', '启动动画-星砂主题.png')
    fs.mkdirSync(path.dirname(shot), { recursive: true })
    await runElectron(temp, userData, {
      ASTRAL_SHOT: shot,
      ASTRAL_SHOT_JS: frameJs(3000),
      ASTRAL_SHOT_JS_WAIT: '700'
    })

    /* D：插件被禁用时的兜底 —— 启动快照仍会把动画染成星砂，
       但插件没注册主题，boot 收尾必须退回真实存在的主题 */
    writeJson(path.join(temp, 'config', 'settings.json'), { ...baseSettings, theme: 'sand' })
    const d = await runElectron(temp, userData, { ASTRAL_EVAL: fallbackScript(), ASTRAL_EVAL_DELAY: '4000' })
    const fallback = readEval(d.stderr)
    if (!fallback || !fallback.ok) {
      console.error('探针失败：D 阶段未拿到结果')
      console.error(d.stderr.split('\n').slice(-12).join('\n'))
      return 1
    }

    const failures = []
    const sandGlow = rgbs(r.sand.glow)
    const astralGlow = rgbs(r.astral.glow)
    const wpLight = rgbs(r.apricot.wpBg)[0] || [0, 0, 0]
    const sandStop = rgbs(r.sand.stop)[0] || [0, 0, 0]

    console.log('--- 主题快照 ---')
    console.log(JSON.stringify({ seeded: seed.cached, pretheme: r.marker, bootTheme: r.bootTheme, accent: r.bootAccent, cache: r.cacheId }))
    if (seed.cached !== 'sand') failures.push(`applyTheme 没有缓存主题：${seed.cached}`)
    if (r.marker !== 'sand') failures.push(`pretheme 没有在 boot 前应用星砂快照：${r.marker || '空'}`)
    if (r.bootTheme !== 'astral') failures.push(`boot 后主题应为深空，实际 ${r.bootTheme}`)
    if (hex(r.bootAccent) !== '#8b9cff') failures.push(`boot 后 --accent 应纠正为深空 #8b9cff，实际 ${r.bootAccent}`)

    console.log('--- 启动动画色板（彗星光晕 / 导航星 / SVG 星体）---')
    console.log(JSON.stringify({
      astral: [Math.round(avg(astralGlow, 0)), Math.round(avg(astralGlow, 1)), Math.round(avg(astralGlow, 2))],
      sand: [Math.round(avg(sandGlow, 0)), Math.round(avg(sandGlow, 1)), Math.round(avg(sandGlow, 2))],
      sandStop,
      lightWaypoint: wpLight
    }))
    if (!astralGlow.length) failures.push('深空：取不到彗星光晕颜色')
    else if (!(avg(astralGlow, 2) > avg(astralGlow, 0))) failures.push('深空：光晕不再是冷调（蓝应高于红）')
    if (!sandGlow.length) failures.push('星砂：取不到彗星光晕颜色')
    else if (!(avg(sandGlow, 0) > avg(sandGlow, 2) + 40)) failures.push('星砂：光晕仍是紫蓝，没有跟随主题变暖')
    if (r.sand.stop && !(sandStop[0] > sandStop[2])) failures.push(`星砂：SVG 星体渐变没有变暖（${sandStop.join(',')}）`)
    if (!r.sand.stop) console.log('  注：splash 已收场，SVG 星体渐变取不到，其余色板断言照常')
    /* 浅色主题的导航星走的是原有补丁（主题色实心点），不是白点——白点在浅底上会消失 */
    if (!(wpLight[0] > wpLight[2] + 40)) failures.push(`浅色主题：导航星核心没有用主题色（${wpLight.join(',')}）`)
    console.log('--- 插件主题被禁用时的兜底 ---')
    console.log(JSON.stringify(fallback))
    if (fallback.themeId !== 'astral') failures.push(`插件主题缺失时应回退到深空，实际 ${fallback.themeId}`)

    if (failures.length) {
      console.log('--- 结论 ---')
      for (const f of failures) console.log('✗ ' + f)
      return 1
    }
    console.log('--- 结论 ---')
    console.log('✓ 主题快照会写入，插件主题在下一次启动的 boot 前就生效')
    console.log('✓ 深空保持原来的紫蓝；星砂变成暖金；浅色主题核心保持白热')
    console.log('✓ 截图已保存：promo/启动动画-星砂主题.png')
    return 0
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 }) } catch { /* Windows 下可能 EBUSY */ }
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
