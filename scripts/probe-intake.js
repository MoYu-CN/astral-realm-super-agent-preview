#!/usr/bin/env node
'use strict'

/* probe-intake.js — 消息接入的端到端探针（真实 Electron）
 *
 * 查两件事：
 *   1. 数据面：六种渠道都能登记、能启停、能入库、能分流、能去重；
 *   2. 界面面：设置 → 消息接入 真的渲染出渠道卡片与收件箱（截图给人看）。
 *
 * 用法：node scripts/probe-intake.js
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TIMEOUT = 120000
const results = []

function check (name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

/* 用一次真窗口执行一段脚本。executeJavaScript 会等 Promise 兑现，
   所以「按掉引导 → 开设置 → 点标签」能排好序，不会和截图抢时间。 */
function runElectron (env, visible = false) {
  const electronPath = require('electron')
  return new Promise((resolve) => {
    const clean = { ...process.env, ...env }
    delete clean.ELECTRON_RUN_AS_NODE
    const child = spawn(electronPath, [ROOT], { cwd: ROOT, env: clean, windowsHide: !visible, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} resolve({ stderr, timeout: true }) }, TIMEOUT)
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.stdout.on('data', () => {})
    child.on('error', (err) => { clearTimeout(timer); resolve({ stderr: err.message }) })
    child.on('exit', () => { clearTimeout(timer); resolve({ stderr }) })
  })
}

/* 首启会弹知识库引导并占住弹层根节点；先把这步按掉，再进设置点标签 */
const OPEN_SETTINGS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 30; i++) {
    const skip = [...document.querySelectorAll('button')].find((b) => b.textContent && b.textContent.indexOf('暂不启用') >= 0)
    if (skip) { skip.click(); await sleep(700); break }
    await sleep(200)
  }
  const btn = document.querySelector('#btn-settings')
  if (!btn) return { ok: false, error: '找不到设置按钮' }
  btn.click()
  await sleep(800)
  const tab = document.querySelector('.modal-tabs button[data-tab="intake"]')
  if (!tab) return { ok: false, error: '没有消息接入标签' }
  tab.click()
  /* 等卡片真的挂上去再交回控制权，否则截图可能拍到空面板 */
  for (let i = 0; i < 40; i++) {
    if (document.querySelector('#modal-root .mini-row')) break
    await sleep(200)
  }
  await sleep(800)
  return { ok: true }
})()`

async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-intake-probe-'))
  fs.mkdirSync(dir, { recursive: true })

  /* 应用本身可能正在跑，默认 45890 已被它占着：探针另找一个空端口。
     否则「端口被占」会被误读成「入口起不来」。 */
  const freePort = await new Promise((resolve) => {
    const probe = require('node:net').createServer()
    probe.once('error', () => resolve(0))
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  if (freePort) fs.writeFileSync(path.join(dir, 'intake.json'), JSON.stringify({ port: freePort }), 'utf8')

  /* ---------- 数据面：不启界面，先把库点满 ---------- */
  const { createMemoryStore } = require(path.join(ROOT, 'electron', 'memory', 'store.js'))
  const { createIntake, memorySecretBox } = require(path.join(ROOT, 'electron', 'intake', 'index.js'))

  const store = createMemoryStore({ configDir: dir, enabled: true })
  const intake = createIntake({
    configDir: dir,
    secretBox: memorySecretBox(),
    store: { inbox: (input) => store.inbox(input) }
  })

  const kinds = intake.catalog()
  check('目录：六种渠道都在', kinds.length === 6, kinds.map((k) => k.id).join(', '))
  check('目录：每种都声明了风险与能力',
    kinds.every((k) => k.risk && k.capabilities && k.fields.length > 0))

  const wx = intake.saveChannel({ kind: 'wechat-personal', label: '微信（个人）', enabled: false, values: { pollSeconds: 60 } })
  const qq = intake.saveChannel({ kind: 'qq-personal', label: 'QQ（个人）', enabled: false, values: { wsUrl: 'ws://127.0.0.1:3001' } })
  const hook = intake.saveChannel({ kind: 'webhook', label: 'CI 告警', enabled: true })
  check('登记：三种渠道都能存下来', wx.ok && qq.ok && hook.ok, [wx.ok, qq.ok, hook.ok].join('/'))
  check('登记：密钥与配置分开', hook.channel.config.token === undefined && hook.channel.secretsSet.includes('token'))
  check('地址：Webhook 带令牌', /token=/.test(intake.hookUrl(hook.channel.id)))

  const written = intake.ingest(wx.channel.id, [
    { text: '在吗？明天的方案发我一下', chatId: 'g1', chatName: '项目群', senderName: '老张', mentionsMe: true },
    { text: '今晚一起吃饭吗', chatId: 'g1', chatName: '项目群', senderName: '老张' },
    { text: '这个打包报错是缓存问题，删 dist 就好', chatId: 'g2', chatName: '技术群', senderName: '小李' },
    { text: '收', chatId: 'g1', chatName: '项目群', senderName: '老王' }
  ])
  check('入库：四条都进来了', written.inserted === 4, String(written.inserted))
  check('入库：分流出四档', written.messages.map((m) => m.route).sort().join(',') === 'alert,archive,knowledge,observe',
    written.messages.map((m) => m.route).join(','))

  const dup = intake.ingest(wx.channel.id, [
    { text: '在吗？明天的方案发我一下', chatId: 'g1', chatName: '项目群', senderName: '老张', mentionsMe: true }
  ])
  check('去重：重复到达不新增', dup.inserted === 0 && dup.duplicates === 1)

  const stats = store.inbox({ action: 'stats' }).data
  check('统计：三条渠道、今日有数', stats.channels === 3 && stats.today >= 4, JSON.stringify(stats.routes))

  /* 关键一条：开关打开后，超级智能体的常驻上下文里必须看得到「我在听什么」 */
  const ctx = store.hardContext.prompt().data.text
  const block = ((ctx.split('### 消息接入（实时）')[1] || '').split('\n### ')[0] || '')
  check('首流：接入状态写进常驻上下文', /### 消息接入（实时）/.test(ctx) && /已接 \d+ 条渠道/.test(block),
    (block.split('\n').filter(Boolean)[0] || '').slice(0, 60))
  check('首流：告诉 AI 外面有没有人等它', /条在等你|今日 \d+ 条/.test(block), (block.split('\n').filter(Boolean)[1] || '').slice(0, 60))
  const viaTool = store.inbox({ action: 'brief' }).data
  check('首流：工具和上下文是同一段', viaTool.text === block.trim(), String((viaTool.text || '').length) + ' 字')

  const server = await intake.startServer()
  check('入口：本地 HTTP 起来了', server.ok === true, '127.0.0.1:' + server.port)
  if (server.ok) {
    const url = intake.hookUrl(hook.channel.id)
    const res = await fetch(url, { method: 'POST', body: '构建失败：缺少 main.js' })
    const body = await res.json().catch(() => ({}))
    check('入口：推一条能落库', res.status === 200 && body.inserted === 1, JSON.stringify(body))
    const denied = await fetch(url.replace(/token=[^&]+/, 'token=bad'), { method: 'POST', body: 'x' })
    check('入口：错令牌 401', denied.status === 401, String(denied.status))
  }
  await intake.shutdown()
  store.close()

  /* ---------- 界面面 ---------- */
  const shot = path.join(os.tmpdir(), 'astral-intake-view.png')
  await runElectron({
    ASTRAL_CONFIG_DIR: dir,
    ASTRAL_SHOT: shot,
    ASTRAL_SHOT_JS: OPEN_SETTINGS,
    ASTRAL_SHOT_JS_WAIT: '1500'
  }, true)
  check('界面：截图已生成', fs.existsSync(shot), shot)

  const dom = await runElectron({
    ASTRAL_CONFIG_DIR: dir,
    ASTRAL_EVAL: `(async () => {
      const base = await (${OPEN_SETTINGS})
      if (!base.ok) return base
      const body = document.querySelector('#modal-root .modal-body')
      const text = body ? body.innerText : ''
      /* 真窗口里再问一次主进程：常驻上下文是不是真的带上了接入那一块 */
      let ctx = ''
      try { const res = await window.astral.memoryPrompt(); ctx = (res && res.text) || '' } catch {}
      return {
        ok: true,
        ctxHasIntake: /### 消息接入（实时）/.test(ctx),
        rows: document.querySelectorAll('#modal-root .mini-row').length,
        mentionsHook: /CI 告警/.test(text),
        mentionsWechat: /微信/.test(text),
        mentionsRisk: /只读|官方|有风险/.test(text),
        mentionsInbox: /收件箱/.test(text),
        mentionsContext: /常驻上下文/.test(text),
        sample: text.slice(0, 120)
      }
    })()`,
    ASTRAL_EVAL_DELAY: '3000'
  })
  const line = String(dom.stderr || '').split(/\r?\n/).filter((row) => row.includes('[eval]')).pop() || ''
  let info = { ok: false, error: '没有拿到界面数据' }
  if (line) {
    try { info = JSON.parse(line.slice(line.indexOf('[eval]') + 6).trim()) } catch (err) { info = { ok: false, error: err.message } }
  }
  check('界面：标签能打开', info.ok === true, info.error || '')
  check('界面：渠道卡片渲染出来', (info.rows || 0) >= 8, (info.rows || 0) + ' 行')
  check('界面：认得出已接入的渠道', info.mentionsHook === true && info.mentionsWechat === true)
  check('界面：风险标签与收件箱都在', info.mentionsRisk === true && info.mentionsInbox === true)
  check('界面：告诉用户已写进常驻上下文', info.mentionsContext === true)
  check('界面：真窗口取到的提示词里带接入块', info.ctxHasIntake === true)

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
  if (failed.length) {
    console.log('失败：' + failed.map((item) => item.name).join('、'))
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
