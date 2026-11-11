#!/usr/bin/env node
'use strict'

/* probe-super.js — 超级智能体「直连会话」的端到端探针（真实 Electron + 本地假模型）
 *
 * 验证的是它已经变成主对话区里的一条普通会话，而不是另一个窗口：
 *   - 左侧入口点一下就进，不需要任何弹层；
 *   - 顶栏标题、副标题、资料入口、视图切换都跟着换；
 *   - 消息走同一条 #stream 与同一个 composer，发出去能收到流式回复；
 *   - 会话写自己的文件，重启后还在；
 *   - 点别的项目 / 成员就离开这条线，回到项目会话；
 *   - 右栏在直连会话里收起，只剩「插件」，任务 / 上下文 / 知识库都不出现。
 *
 * 用法：node scripts/probe-super.js
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 120000
const MOCK_PORT = 46002

function copyDir (src, dest) { fs.cpSync(src, dest, { recursive: true }) }
function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}
function sleepNode (ms) { return new Promise((r) => setTimeout(r, ms)) }

function startMock (capture) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_CAPTURE: capture, MOCK_DELAY: '2' }
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-llm.js')], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
    })
    let buf = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('mock-llm 启动超时')) }, 10000)
    child.stderr.on('data', (chunk) => {
      buf += chunk
      if (buf.includes('[mock-llm]')) { clearTimeout(timer); resolve(child) }
    })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/* ---------------- 第一程：进入 → 发消息 → 退出 ---------------- */

function evalStage () {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const wait = async (fn, tries = 80) => {
      for (let i = 0; i < tries; i++) {
        try { const v = fn(); if (v) return v } catch (_) {}
        await sleep(250)
      }
      return null
    }
    if (!await wait(() => window.Astral)) return { ok: false, error: '应用未就绪' }

    const $ = (sel) => document.querySelector(sel)
    const shown = (el) => Boolean(el) && getComputedStyle(el).display !== 'none'
    const out = { ok: true }

    out.before = {
      title: $('#channel-name').textContent,
      superActive: $('#btn-super').classList.contains('active'),
      viewSwitchShown: shown($('#view-switch')),
      pane: ($('#dock-tabs button.active') || {}).dataset ? $('#dock-tabs button.active').dataset.pane : '',
      dockCollapsed: document.body.classList.contains('dock-collapsed')
    }

    /* 1. 点左侧入口 —— 这就是全部动作，没有弹层 */
    $('#btn-super').click()
    await sleep(700)
    const visibleTabs = () => [...document.querySelectorAll('#dock-tabs button')]
      .filter((b) => getComputedStyle(b).display !== 'none')
      .map((b) => b.textContent.trim())
    out.enter = {
      title: $('#channel-name').textContent,
      sub: $('#channel-sub').textContent,
      superActive: $('#btn-super').classList.contains('active'),
      railName: $('#rail-super-name').textContent.trim(),
      bodyMode: document.body.classList.contains('super-chat-mode'),
      viewSwitchShown: shown($('#view-switch')),
      modalOpen: Boolean($('#modal-root .modal')),
      emptyShown: Boolean($('#stream .super-empty-stage')),
      editBtn: $('#channel-edit').textContent,
      editBtnShown: !$('#channel-edit').hidden,
      placeholder: $('#input').placeholder,
      hint: $('#composer-hints').textContent.trim(),
      dockCollapsed: document.body.classList.contains('dock-collapsed'),
      dockTabs: visibleTabs(),
      knowledgeTab: Boolean([...document.querySelectorAll('#dock-tabs button')].find((b) => /知识库/.test(b.textContent)))
    }

    /* 1b. 「资料」打开的是普通编辑弹窗，不是三标签窗口 */
    $('#channel-edit').click()
    await sleep(450)
    out.profile = {
      open: Boolean($('#modal-root .modal')),
      title: ($('#modal-root .modal-head h2') || {}).textContent || '',
      tabs: document.querySelectorAll('#modal-root .modal-tabs button').length,
      inputs: document.querySelectorAll('#modal-root input, #modal-root textarea, #modal-root select').length
    }
    const closeBtn = $('#modal-root .close-btn')
    if (closeBtn) closeBtn.click()
    await sleep(250)

    /* 2. 用同一个输入框发一句 */
    const input = $('#input')
    input.value = '你好，报个到'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    let agentText = ''
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      const md = document.querySelectorAll('#stream .msg.agent .md')
      agentText = md.length ? md[md.length - 1].textContent.trim() : ''
      if (agentText && !document.querySelector('#stream .msg.agent.streaming')) break
    }
    out.send = {
      userText: ($('#stream .msg.user .user-text') || {}).textContent || '',
      agentText,
      userCount: document.querySelectorAll('#stream .msg.user').length,
      agentCount: document.querySelectorAll('#stream .msg.agent').length,
      agentName: ($('#stream .msg.agent .msg-head .name') || {}).textContent || '',
      sendLabel: $('#btn-send').textContent
    }

    /* 3. 右栏：直连会话里只剩「插件」，项目面板一个都不出现 */
    const dockBtn = $('#btn-dock')
    if (document.body.classList.contains('dock-collapsed') && dockBtn) dockBtn.click()
    await sleep(500)
    const dockText = $('#dock-body').textContent || ''
    out.dock = {
      collapsed: document.body.classList.contains('dock-collapsed'),
      tabs: visibleTabs(),
      activeText: (($('#dock-tabs button.active') || {}).textContent || '').trim(),
      note: dockText.includes('直连会话只保留这一页'),
      pluginItems: document.querySelectorAll('#dock-body .task-item').length,
      leaked: ['本轮任务进度', '任务文件夹', '上下文注入控制'].filter((t) => dockText.includes(t))
    }

    /* 4. 点当前项目 = 离开这条线，回到项目会话 */
    const projectBtn = document.querySelector('#project-tree .proj-item, #project-tree button')
    if (projectBtn) projectBtn.click()
    await sleep(700)
    out.leave = {
      title: $('#channel-name').textContent,
      superActive: $('#btn-super').classList.contains('active'),
      bodyMode: document.body.classList.contains('super-chat-mode'),
      viewSwitchShown: shown($('#view-switch')),
      pane: ($('#dock-tabs button.active') || {}).dataset ? $('#dock-tabs button.active').dataset.pane : '',
      dockCollapsed: document.body.classList.contains('dock-collapsed')
    }

    return out
  })()`
}

/* ---------------- 第二程：重启后历史还在 ---------------- */

function evalRestore () {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const wait = async (fn, tries = 60) => {
      for (let i = 0; i < tries; i++) {
        try { const v = fn(); if (v) return v } catch (_) {}
        await sleep(250)
      }
      return null
    }
    if (!await wait(() => window.Astral)) return { ok: false, error: '应用未就绪' }
    document.querySelector('#btn-super').click()
    await sleep(800)
    const users = [...document.querySelectorAll('#stream .msg.user .user-text')].map((n) => n.textContent.trim())
    const agents = [...document.querySelectorAll('#stream .msg.agent .md')].map((n) => n.textContent.trim())
    return {
      ok: true,
      title: document.querySelector('#channel-name').textContent,
      users,
      agentCount: agents.length,
      agentFirst: agents[0] || '',
      emptyShown: Boolean(document.querySelector('#stream .super-empty-stage'))
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

async function main () {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-probe-super-'))
  let mock = null
  try {
    mock = await startMock(path.join(temp, 'mock-capture.json'))
    copyDir(path.join(ROOT, 'app'), path.join(temp, 'app'))
    copyDir(path.join(ROOT, 'electron'), path.join(temp, 'electron'))
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(temp, 'package.json'))
    writeJson(path.join(temp, 'config', 'settings.json'), {
      theme: 'astral',
      onboarding: { knowledgePrompted: true },
      /* 打开知识库插件，是为了验「它的面板在直连会话里也必须消失」 */
      plugins: { knowledge: { enabled: true }, stardust: { enabled: false } },
      app: { closeToTray: false },
      thinking: 0,
      bridge: { enabled: false, port: 45873, token: '' },
      profile: { name: '探针', short: '探针', role: 'admin' },
      superAgent: { name: '星核', short: '核', model: 'mock-1' }
    })
    writeJson(path.join(temp, 'config', 'mcp.json'), { version: 1, servers: [] })
    writeJson(path.join(temp, 'config', 'providers.json'), {
      providers: [{
        id: 'mock', name: 'Mock', kind: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'test-key',
        models: ['mock-1'], enabled: true
      }]
    })
    if (fs.existsSync(path.join(ROOT, 'config', 'projects.json'))) {
      fs.copyFileSync(path.join(ROOT, 'config', 'projects.json'), path.join(temp, 'config', 'projects.json'))
    }

    const a = await runElectron(temp, evalStage())
    const r = parseEval(a.stderr)
    if (!r) {
      console.error('✗ 第一程未拿到 eval 结果')
      console.error(a.stderr.split('\n').slice(-14).join('\n'))
      return 1
    }
    if (!r.ok) return fail(r.error, a.stderr)

    const failures = []
    if (r.before.superActive) failures.push('启动时不应停在直连会话')
    if (r.enter.modalOpen) failures.push('点入口弹出了窗口（应该直接进主对话区）')
    if (!r.enter.superActive) failures.push('左侧入口没有进入选中态')
    if (!r.enter.bodyMode) failures.push('body 未进入直连模式')
    if (r.enter.viewSwitchShown) failures.push('直连会话里仍在显示两视图切换')
    if (!r.enter.emptyShown) failures.push('空态没有渲染')
    if (r.enter.title === r.before.title) failures.push('顶栏标题没有换成它的名字')
    if (!r.enter.editBtnShown || r.enter.editBtn !== '资料') failures.push(`资料入口不对：${r.enter.editBtn} / ${r.enter.editBtnShown}`)
    if (!/星核/.test(r.enter.placeholder)) failures.push(`输入框占位没有指向它：${r.enter.placeholder}`)
    if (!/直连/.test(r.enter.hint)) failures.push(`输入对象提示不对：${r.enter.hint}`)
    if (!r.enter.dockCollapsed) failures.push('进直连会话时右栏没有收起')
    if (r.enter.dockTabs.length !== 1 || r.enter.dockTabs[0] !== '插件') failures.push('直连会话右栏页签不对：' + JSON.stringify(r.enter.dockTabs))
    if (!r.enter.knowledgeTab) failures.push('知识库面板没有注册，这一项没验到')
    if (!r.profile || !r.profile.open) failures.push('「资料」没有打开编辑弹窗')
    else if (r.profile.tabs !== 0) failures.push('资料弹窗仍带标签栏（应该是单页表单）：' + r.profile.tabs)
    if (r.profile && r.profile.title !== '超级智能体') failures.push('资料弹窗标题不对：' + r.profile.title)
    if (r.profile && r.profile.inputs < 4) failures.push('资料弹窗缺少字段：' + r.profile.inputs)

    if (!/你好，报个到/.test(r.send.userText)) failures.push('用户消息没有进主消息流：' + r.send.userText)
    if (!r.send.agentText) failures.push('没有收到模型回复')
    if (r.send.agentCount < 1) failures.push('回复不是一条普通消息节点')
    if (!r.send.agentName) failures.push('回复缺少消息头（没有走通用渲染）')
    if (r.send.sendLabel !== '发送') failures.push(`发送按钮没有复位：${r.send.sendLabel}`)

    if (r.dock.collapsed) failures.push('点开右栏后仍处于收起状态')
    if (r.dock.activeText !== '插件') failures.push('右栏落点不是插件页：' + r.dock.activeText)
    if (!r.dock.note) failures.push('插件页缺少「直连会话只保留这一页」的说明')
    if (r.dock.leaked.length) failures.push('直连会话右栏漏出项目面板内容：' + JSON.stringify(r.dock.leaked))

    if (r.leave.superActive) failures.push('点项目后没有离开直连会话')
    if (r.leave.bodyMode) failures.push('点项目后 body 仍在直连模式')
    if (!r.leave.viewSwitchShown) failures.push('回到项目会话后视图切换没有恢复')
    if (r.leave.pane !== r.before.pane) failures.push(`离开后右栏页签没有还原：${r.before.pane} → ${r.leave.pane}`)

    console.log('--- 进入 ---')
    console.log(JSON.stringify(r.enter))
    console.log('--- 发送 ---')
    console.log(JSON.stringify(r.send))
    console.log('--- 右栏 ---')
    console.log(JSON.stringify(r.dock))
    console.log('--- 离开 ---')
    console.log(JSON.stringify(r.leave))

    /* 第二程：重启后历史还在 */
    await sleepNode(400)
    const b = await runElectron(temp, evalRestore())
    const g = parseEval(b.stderr)
    if (!g) return fail('第二程未拿到 eval 结果', b.stderr)
    if (!g.ok) return fail(g.error, b.stderr)
    if (!g.users.includes('你好，报个到')) failures.push('重启后直连历史丢了：' + JSON.stringify(g.users))
    if (g.emptyShown) failures.push('重启后仍显示空态')
    console.log('--- 重启后 ---')
    console.log(JSON.stringify(g))

    let saved = null
    try { saved = JSON.parse(fs.readFileSync(path.join(temp, 'config', 'super-agent', 'session.json'), 'utf8')) } catch { saved = null }
    if (!saved || !Array.isArray(saved.messages) || !saved.messages.length) failures.push('没有写入 config/super-agent/session.json')

    let captured = null
    try { captured = JSON.parse(fs.readFileSync(path.join(temp, 'mock-capture.json'), 'utf8')) } catch { captured = null }
    const system = captured ? String(captured.system || '') : ''
    if (!/硬性上下文|身份/.test(system)) failures.push('直连请求的 system 里没有身份段')
    if (!/星核/.test(system)) failures.push('直连请求的 system 里没有它的名字')

    if (failures.length) {
      console.log('--- 结论 ---')
      for (const f of failures) console.log('✗ ' + f)
      return 1
    }
    console.log('--- 结论 ---')
    console.log('✓ 左侧入口直接进主对话区：无弹窗、标题/资料入口/视图切换都跟着换')
    console.log('✓ 同一个输入框与消息流：发出、流式收口、消息头都走通用渲染')
    console.log('✓ 会话独立落盘 config/super-agent/session.json，重启后历史还在')
    console.log('✓ 右栏在直连会话里收起，点开只剩「插件」：任务 / 上下文 / 知识库都不出现')
    console.log('✓ 点项目即离开这条线，回到项目会话，右栏页签按原样还原')
    return 0
  } finally {
    if (mock) { try { mock.kill() } catch { /* 已退出 */ } }
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 }) } catch { /* Windows 下可能 EBUSY */ }
  }
}

function fail (msg, stderr) {
  console.error('✗ ' + msg)
  if (stderr) console.error(stderr.split('\n').slice(-14).join('\n'))
  return 1
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
