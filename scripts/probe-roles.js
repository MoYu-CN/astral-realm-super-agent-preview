#!/usr/bin/env node
'use strict'

/* probe-roles.js — 身份边界的端到端探针（真实 Electron，不调用任何模型）
 *
 * 验证的是**主进程的边界**，不是界面上的隐藏：
 *   - 启动载荷不下发口令哈希；
 *   - 没设口令不能降级（防止把自己锁在门外）；
 *   - 成员保存 settings 无法自我提权，敏感段被磁盘值锁死；
 *   - 错口令升级被拒、对口令才回管理员；
 *   - 游客读记忆 / 发起模型调用 / 写会话 / 写文件 / 开控制台全部被拒；
 *   - 游客重启后界面确实是只读态（徽标 + 输入框）。
 *
 * 两次启动：第一次跑完整切换链路并把身份停在游客，第二次复用它验证重启后的界面。
 *
 * 用法：node scripts/probe-roles.js
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 120000
const PIN = '2468'

function copyDir (src, dest) { fs.cpSync(src, dest, { recursive: true }) }
function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

/* ---------------- 第一程：切换链路与越权矩阵 ---------------- */

function evalSwitch () {
  return `(async () => {
    const A = window.astral
    if (!A) return { ok: false, error: 'preload 未注入' }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const role = async () => {
      try { return (await A.boot()).settings.profile.role } catch (_) { return 'boot-failed' }
    }
    const call = async (fn) => {
      try { return await fn() } catch (err) { return { ok: false, thrown: true, error: String((err && err.message) || err) } }
    }
    const out = {}

    const boot0 = await A.boot()
    out.bootRole = boot0.settings.profile.role
    out.bootLeaksPin = Object.prototype.hasOwnProperty.call(boot0.settings.profile, 'rolePin')
    out.bootHasPin = boot0.settings.profile.hasPin === true

    /* 1. 没有口令时降级：必须被拒 */
    out.noPinDowngrade = await call(() => A.roleSwitch({ role: 'member' }))
    out.roleAfterNoPin = await role()

    /* 2. 设口令 */
    out.setPin = await call(() => A.roleSetPin({ pin: '${PIN}' }))

    /* 3. 降为成员 */
    out.toMember = await call(() => A.roleSwitch({ role: 'member' }))
    out.roleAsMember = await role()

    /* 4. 成员不能设口令 */
    out.memberSetPin = await call(() => A.roleSetPin({ pin: '9999' }))

    /* 5. 成员不能切其他身份 */
    out.memberSwitch = await call(() => A.roleSwitch({ role: 'guest' }))

    /* 6. 成员保存 settings 尝试自我提权 + 改权限段 */
    const snapshot = (await A.boot()).settings
    out.permsBefore = snapshot.permissions
    const evil = JSON.parse(JSON.stringify(snapshot))
    evil.profile = Object.assign({}, evil.profile, { role: 'admin' })
    evil.permissions = Object.assign({}, evil.permissions, { allowShell: true, allowNetwork: true })
    evil.superAgent = Object.assign({}, evil.superAgent, { model: 'hijacked' })
    out.memberSave = await call(() => A.saveConfig('settings.json', evil))
    const afterEvil = (await A.boot()).settings
    out.roleAfterEvil = afterEvil.profile.role
    out.permsAfterEvil = afterEvil.permissions
    out.superModelAfterEvil = afterEvil.superAgent && afterEvil.superAgent.model

    /* 7. 错口令升级 */
    out.wrongPin = await call(() => A.roleSwitch({ role: 'admin', pin: '0000' }))
    out.roleAfterWrongPin = await role()

    /* 8. 对口令升级 */
    out.rightPin = await call(() => A.roleSwitch({ role: 'admin', pin: '${PIN}' }))
    out.roleAfterRightPin = await role()

    /* 9. 管理员降为游客，并逐个验证越权面 */
    out.toGuest = await call(() => A.roleSwitch({ role: 'guest' }))
    out.roleAsGuest = await role()

    out.guestMemory = await call(() => A.memoryPrompt())
    out.guestConsole = await call(() => A.memoryOpenConsole({ view: 'hard' }))
    out.guestLlm = await call(() => A.startLLM({
      id: 'probe', providerId: 'none', model: 'none',
      messages: [{ role: 'user', content: 'ping' }]
    }))
    out.guestSession = await call(() => A.saveSession({ messages: [{ kind: 'user', text: 'x' }] }))
    out.guestWriteFile = await call(() => A.writeProjectFile({ rootPath: '.', filePath: 'probe.txt', text: 'x' }))
    out.guestSaveSettings = await call(() => A.saveConfig('settings.json', { profile: { role: 'admin' } }))
    out.roleAfterGuestWrites = await role()

    out.ok = true
    return out
  })()`
}

/* ---------------- 第二程：以游客身份重启，看界面 ---------------- */

function evalGuestUi () {
  return `(async () => {
    const wait = async (fn, tries = 60) => {
      for (let i = 0; i < tries; i++) {
        try { const v = fn(); if (v) return v } catch (_) {}
        await new Promise((r) => setTimeout(r, 250))
      }
      return null
    }
    const badge = await wait(() => document.querySelector('#role-badge'))
    const input = await wait(() => document.querySelector('#input'))
    const superBtn = await wait(() => document.querySelector('#btn-super'))
    const A = window.astral
    const boot = await A.boot()
    /* 游客进直连会话：入口能点开，但发不出去，页面上要写清楚原因 */
    if (superBtn) superBtn.click()
    await new Promise((r) => setTimeout(r, 600))
    const superInput = document.querySelector('#input')
    return {
      ok: true,
      role: boot.settings.profile.role,
      badgeText: badge ? badge.textContent.trim() : '',
      badgeClass: badge ? badge.className : '',
      inputDisabled: input ? input.disabled === true : null,
      inputPlaceholder: input ? input.placeholder : '',
      superEntry: Boolean(superBtn),
      sidebarName: (document.querySelector('#rail-super-name') || {}).textContent || '',
      superTitle: (document.querySelector('#channel-name') || {}).textContent || '',
      superInputDisabled: superInput ? superInput.disabled === true : null,
      superNotice: (document.querySelector('#stream') || {}).textContent || ''
    }
  })()`
}

function runElectron (dir, script) {
  return new Promise((resolve) => {
    const electronPath = require('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.ASTRAL_EVAL = script
    env.ASTRAL_EVAL_DELAY = '2600'
    env.ASTRAL_TRUST_RUN_OWNER = '1'
    env.ASTRAL_MULTI = '1'
    const child = spawn(electronPath, ['.'], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill(); resolve({ code: -1, stderr, timedOut: true }) }, TIMEOUT)
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stderr, error: err.message }) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }) })
  })
}

function parseEval (stderr) {
  const matches = [...stderr.matchAll(/\[eval\]\s+(\{[\s\S]*?\})\s*$/gm)]
  if (!matches.length) return null
  try { return JSON.parse(matches[matches.length - 1][1]) } catch { return null }
}

function fail (msg, stderr) {
  console.error('✗ ' + msg)
  if (stderr) console.error(stderr.split('\n').slice(-12).join('\n'))
  return 1
}

async function main () {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-probe-roles-'))
  try {
    copyDir(path.join(ROOT, 'app'), path.join(temp, 'app'))
    copyDir(path.join(ROOT, 'electron'), path.join(temp, 'electron'))
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(temp, 'package.json'))
    writeJson(path.join(temp, 'config', 'settings.json'), {
      theme: 'astral',
      onboarding: { knowledgePrompted: true },
      plugins: { knowledge: { enabled: false }, stardust: { enabled: false } },
      app: { closeToTray: false },
      thinking: 0,
      bridge: { enabled: false, port: 45872, token: '' },
      profile: { name: '探针', short: '探针', role: 'admin' },
      superAgent: { name: '星核', short: '核', model: 'default' }
    })
    writeJson(path.join(temp, 'config', 'mcp.json'), { version: 1, servers: [] })
    writeJson(path.join(temp, 'config', 'providers.json'), { providers: [] })
    if (fs.existsSync(path.join(ROOT, 'config', 'projects.json'))) {
      fs.copyFileSync(path.join(ROOT, 'config', 'projects.json'), path.join(temp, 'config', 'projects.json'))
    }

    /* --- 第一程 --- */
    const a = await runElectron(temp, evalSwitch())
    const r = parseEval(a.stderr)
    if (!r) return fail('第一程未拿到 eval 结果', a.stderr)
    if (!r.ok) return fail('第一程失败：' + r.error, a.stderr)

    const failures = []
    const expectDeny = (name, res, cap) => {
      if (!res || res.ok !== false || res.denied !== true) failures.push(`${name} 未被拒绝：${JSON.stringify(res)}`)
      else if (cap && !String(res.error || '').includes(cap)) failures.push(`${name} 的拒绝理由未提到 ${cap}：${res.error}`)
    }

    if (r.bootRole !== 'admin') failures.push(`初始身份应为 admin，实际 ${r.bootRole}`)
    if (r.bootLeaksPin) failures.push('启动载荷下发了 rolePin（口令哈希泄漏）')
    if (r.bootHasPin !== false) failures.push('未设口令时 hasPin 应为 false')

    if (!r.noPinDowngrade || r.noPinDowngrade.ok !== false) failures.push('没设口令却允许降级')
    else if (!/口令/.test(String(r.noPinDowngrade.error || ''))) failures.push('无口令降级的提示未说明原因')
    if (r.roleAfterNoPin !== 'admin') failures.push(`被拒后身份不应变化，实际 ${r.roleAfterNoPin}`)

    if (!r.setPin || r.setPin.ok !== true || r.setPin.hasPin !== true) failures.push('设口令失败：' + JSON.stringify(r.setPin))

    if (!r.toMember || r.toMember.ok !== true) failures.push('管理员降成员失败：' + JSON.stringify(r.toMember))
    if (r.roleAsMember !== 'member') failures.push(`降级后身份应为 member，实际 ${r.roleAsMember}`)

    expectDeny('成员设口令', r.memberSetPin, 'role.manage')
    expectDeny('成员切身份', r.memberSwitch)

    if (r.roleAfterEvil !== 'member') failures.push(`成员保存 settings 后身份被改成 ${r.roleAfterEvil}（自我提权成功）`)
    if (JSON.stringify(r.permsAfterEvil) !== JSON.stringify(r.permsBefore)) {
      failures.push('成员的保存改动了 permissions：' + JSON.stringify(r.permsAfterEvil))
    }
    if (r.superModelAfterEvil === 'hijacked') failures.push('成员的保存改动了 superAgent.model')

    if (!r.wrongPin || r.wrongPin.ok !== false) failures.push('错口令居然升级成功')
    if (r.roleAfterWrongPin !== 'member') failures.push(`错口令后身份不应变化，实际 ${r.roleAfterWrongPin}`)

    if (!r.rightPin || r.rightPin.ok !== true) failures.push('对口令升级失败：' + JSON.stringify(r.rightPin))
    if (r.roleAfterRightPin !== 'admin') failures.push(`升级后身份应为 admin，实际 ${r.roleAfterRightPin}`)

    if (!r.toGuest || r.toGuest.ok !== true) failures.push('管理员降游客失败：' + JSON.stringify(r.toGuest))
    if (r.roleAsGuest !== 'guest') failures.push(`降级后身份应为 guest，实际 ${r.roleAsGuest}`)

    expectDeny('游客读记忆', r.guestMemory, 'memory.read')
    expectDeny('游客开控制台', r.guestConsole, 'memory.console')
    if (!r.guestLlm || r.guestLlm.ok !== false) failures.push('游客居然能发起模型调用')
    else if (!/chat/.test(String(r.guestLlm.error || ''))) failures.push('游客发起模型调用的拒绝理由未提到 chat')
    expectDeny('游客写会话', r.guestSession, 'chat')
    expectDeny('游客写项目文件', r.guestWriteFile, 'files.write')
    expectDeny('游客保存 settings', r.guestSaveSettings, 'settings')
    if (r.roleAfterGuestWrites !== 'guest') failures.push(`游客尝试写入后身份变成 ${r.roleAfterGuestWrites}`)

    console.log('--- 身份切换链路 ---')
    console.log(JSON.stringify({
      初始: r.bootRole,
      无口令降级: r.noPinDowngrade && r.noPinDowngrade.error,
      设口令: r.setPin && r.setPin.hasPin,
      降成员: r.roleAsMember,
      成员设口令: r.memberSetPin && r.memberSetPin.error,
      成员切身份: r.memberSwitch && r.memberSwitch.error,
      成员保存后身份: r.roleAfterEvil,
      错口令: r.wrongPin && r.wrongPin.error,
      对口令后: r.roleAfterRightPin,
      降游客: r.roleAsGuest
    }, null, 0))

    /* --- 第二程：游客身份重启 --- */
    const b = await runElectron(temp, evalGuestUi())
    const g = parseEval(b.stderr)
    if (!g) return fail('第二程未拿到 eval 结果', b.stderr)
    if (!g.ok) return fail('第二程失败：' + g.error, b.stderr)

    if (g.role !== 'guest') failures.push(`重启后身份应为 guest，实际 ${g.role}`)
    if (!g.badgeText) failures.push('未渲染身份徽标')
    else if (!/游客/.test(g.badgeText)) failures.push(`徽标应为「游客」，实际「${g.badgeText}」`)
    if (!/role-guest/.test(g.badgeClass || '')) failures.push(`徽标缺少游客样式：${g.badgeClass}`)
    if (g.inputDisabled !== true) failures.push('游客的输入框未禁用')
    if (!/游客/.test(g.inputPlaceholder || '')) failures.push(`游客的占位提示未说明只读：${g.inputPlaceholder}`)
    if (!g.superEntry) failures.push('侧栏缺少超级智能体入口')
    if (g.superTitle !== '星核') failures.push(`游客点入口后标题未切到直连会话：${g.superTitle}`)
    if (g.superInputDisabled !== true) failures.push('游客在直连会话里的输入框未禁用')
    if (!/游客/.test(g.superNotice || '')) failures.push('游客进直连会话时没有说明原因')

    console.log('--- 游客重启后的界面 ---')
    console.log(JSON.stringify(g))

    if (failures.length) {
      console.log('--- 结论 ---')
      for (const f of failures) console.log('✗ ' + f)
      return 1
    }
    console.log('--- 结论 ---')
    console.log('✓ 启动载荷不含口令哈希，未设口令时拒绝降级')
    console.log('✓ 成员：不能设口令、不能切身份、保存 settings 无法提权（role / permissions / superAgent 全锁）')
    console.log('✓ 升级：错口令被拒，对口令才回管理员')
    console.log('✓ 游客：读记忆 / 开控制台 / 发起模型调用 / 写会话 / 写文件 / 存 settings 六项全拒')
    console.log('✓ 游客重启：徽标「游客」、输入框禁用、占位提示只读、超级智能体入口仍在')
    return 0
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 }) } catch { /* Windows 下可能 EBUSY */ }
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
