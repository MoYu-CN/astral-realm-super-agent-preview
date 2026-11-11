#!/usr/bin/env node
'use strict'

/**
 * 星界自检：不启动窗口，检查配置、语法、资源完整性。
 * 用法：node scripts/doctor.js
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const APP = path.join(ROOT, 'app')
const CONFIG = path.join(ROOT, 'config')

let errors = 0
let warns = 0

const ok = (msg) => console.log(`  \u001b[32m✓\u001b[0m ${msg}`)
const bad = (msg) => { errors++; console.log(`  \u001b[31m✗\u001b[0m ${msg}`) }
const warn = (msg) => { warns++; console.log(`  \u001b[33m!\u001b[0m ${msg}`) }
const head = (msg) => console.log(`\n\u001b[1m${msg}\u001b[0m`)

head('运行时')
ok(`node ${process.version}`)
if (Number(process.versions.node.split('.')[0]) < 20) bad('建议 Node 20 以上')
let electronVersion = null
try {
  electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version
  ok(`electron ${electronVersion}`)
} catch {
  bad('未安装 electron，先执行 npm install')
}

head('语法检查')
const pluginTargets = []
try {
  for (const entry of fs.readdirSync(path.join(APP, 'plugins'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(APP, 'plugins', entry.name, 'plugin.json')
    let manifest = null
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { continue }
    const file = path.join(APP, 'plugins', entry.name, String(manifest.entry || 'plugin.js'))
    if (fs.existsSync(file)) pluginTargets.push(file)
  }
} catch { /* ignore */ }
const targets = [
  ...fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => path.join(APP, 'js', f)),
  ...pluginTargets,
  ...fs.readdirSync(path.join(ROOT, 'electron')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'electron', f))
]
const tmp = path.join(os.tmpdir(), `astral-check-${process.pid}.mjs`)
for (const file of targets) {
  try {
    const src = fs.readFileSync(file, 'utf8')
    const plain = file.includes(`${path.sep}electron${path.sep}`) && !file.endsWith('astral-mcp.js')
    if (plain) {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } else {
      fs.writeFileSync(tmp, src, 'utf8')
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
    }
    ok(path.relative(ROOT, file))
  } catch (err) {
    bad(`${path.relative(ROOT, file)} — ${String(err.stderr || err.message).split('\n').slice(0, 3).join(' ')}`)
  }
}
/* 沙箱宿主是 HTML，内联脚本单独做语法检查，避免只改 HTML 时漏掉。 */
try {
  const html = fs.readFileSync(path.join(APP, 'plugin-host.html'), 'utf8')
  const match = /<script>([\s\S]*?)<\/script>/.exec(html)
  if (!match) throw new Error('找不到内联脚本')
  fs.writeFileSync(tmp, match[1], 'utf8')
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
  ok('app/plugin-host.html 内联脚本')
} catch (err) {
  bad(`app/plugin-host.html — ${String(err.stderr || err.message).split('\n').slice(0, 3).join(' ')}`)
}
try { fs.unlinkSync(tmp) } catch { /* ignore */ }

head('配置文件')
if (!fs.existsSync(CONFIG)) {
  warn('config/ 尚未生成，首次 npm start 时会自动创建')
} else {
  for (const file of ['settings.json', 'providers.json', 'roster.json']) {
    const p = path.join(CONFIG, file)
    if (!fs.existsSync(p)) { warn(`${file} 缺失`); continue }
    try {
      JSON.parse(fs.readFileSync(p, 'utf8'))
      ok(file)
    } catch (err) {
      bad(`${file} 不是合法 JSON：${err.message}`)
    }
  }
}

head('资源')
const count = (dir, ext) => {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).length } catch { return 0 }
}
ok(`主题 ${count(path.join(APP, 'themes'), '.json')} 套`)
ok(`技能 ${count(path.join(APP, 'skills'), '.md')} 个`)
let pluginCount = 0
try {
  pluginCount = fs.readdirSync(path.join(APP, 'plugins'), { withFileTypes: true }).filter((d) => d.isDirectory()).length
} catch { /* ignore */ }
ok(`内置插件 ${pluginCount} 个`)

for (const file of ['index.html', 'plugin-host.html', 'css/tokens.css', 'css/app.css', 'js/main.js', 'docs/plugin-guide.md', 'defaults/roster.json']) {
  if (fs.existsSync(path.join(APP, file))) ok(file)
  else bad(`缺失 app/${file}`)
}

head('插件运行时')
const { normalizePluginManifest } = require(path.join(ROOT, 'electron', 'plugin-manifest.js'))
try {
  for (const entry of fs.readdirSync(path.join(APP, 'plugins'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(path.join(APP, 'plugins', entry.name, 'plugin.json'), 'utf8'))
    } catch (err) {
      bad(`app/plugins/${entry.name}/plugin.json 读取失败：${err.message}`)
      continue
    }
    const manifest = normalizePluginManifest(raw, 'app', entry.name)
    if (manifest.manifestError) {
      bad(`${entry.name} — ${manifest.manifestError}`)
      continue
    }
    if (manifest.legacyShim) bad(`${entry.name} 仍声明 legacyShim，应使用原生沙箱 UI`)
    if (manifest.runtime === 'isolated') ok(`${entry.name} · 隔离沙箱`)
    else bad(`${entry.name} · 旧版渲染层运行时已不再支持`)
  }
} catch (err) {
  bad(`插件清单检查失败：${err.message}`)
}

head('编制')
const rosterPath = fs.existsSync(path.join(CONFIG, 'roster.json'))
  ? path.join(CONFIG, 'roster.json')
  : path.join(APP, 'defaults', 'roster.json')
try {
  const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'))
  const byId = new Map(roster.agents.map((a) => [a.id, a]))
  const counts = { commander: 0, deputy: 0, executor: 0 }
  for (const agent of roster.agents) {
    counts[agent.role] = (counts[agent.role] || 0) + 1
    if (agent.reportsTo && !byId.has(agent.reportsTo)) bad(`${agent.name} 的汇报对象 ${agent.reportsTo} 不存在`)
    if (agent.role === 'commander' && agent.reportsTo) warn(`${agent.name} 是总指挥却设置了汇报对象`)
    const provider = agent.providerId
    if (!provider) bad(`${agent.name} 没有绑定供应商`)
  }
  ok(`总指挥 ${counts.commander} · 副指挥 ${counts.deputy} · 执行者 ${counts.executor}`)
  if (counts.commander === 0) warn('没有总指挥，主频道无法协作')
} catch (err) {
  bad(`编制读取失败：${err.message}`)
}

head('打包版一致性')

/* 打包版是整份复制过去的，漏同步会让 exe 用旧代码启动（曾因此白屏）*/
const DIST = path.join(ROOT, 'dist', '星界-win32-x64', 'resources', 'app')
if (!fs.existsSync(DIST)) {
  warn('未找到 dist 打包目录，跳过一致性检查')
} else {
  const walk = (dir, prefix = '') => fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? walk(dir, path.join(prefix, entry.name)) : [path.join(prefix, entry.name)])
  const stale = []
  let checked = 0
  for (const dir of [APP, path.join(ROOT, 'electron')]) {
    const base = path.dirname(dir) === ROOT ? path.basename(dir) : dir
    for (const rel of walk(dir)) {
      if (/\.(log|tmp)$/i.test(rel)) continue
      const source = path.join(dir, rel)
      const target = path.join(DIST, base, rel)
      checked++
      if (!fs.existsSync(target)) stale.push(`缺失 ${base}/${rel}`)
      else if (!fs.readFileSync(source).equals(fs.readFileSync(target))) stale.push(`过期 ${base}/${rel}`)
    }
  }
  if (stale.length) {
    bad(`打包版与源码不一致 ${stale.length} 处（运行 npm run pack 或手动同步）`)
    for (const line of stale.slice(0, 8)) console.log(`  · ${line}`)
    if (stale.length > 8) console.log(`  · …另有 ${stale.length - 8} 处`)
  } else {
    ok(`app / electron 共 ${checked} 个文件与打包版一致`)
  }
}

head('结果')
if (errors) {
  console.log(`\u001b[31m${errors} 个错误\u001b[0m${warns ? `，${warns} 个警告` : ''}`)
  process.exitCode = 1
} else {
  console.log(`\u001b[32m通过\u001b[0m${warns ? `，${warns} 个警告` : ''}`)
}
