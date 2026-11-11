#!/usr/bin/env node
'use strict'

/* probe-security.js — 安全边界的端到端探针（真实 Electron）
 *
 * 查三件事：
 *   1. 数据面：命中就落闸门、批准才放行、账本只追加且能自校验；
 *   2. 界面面：设置 → 安全边界 真的渲染出待确认 / 留痕 / 账本（截图给人看）；
 *   3. 控制面：界面上的「允许这一次」走的是主进程 IPC，点完闸门真的会被消耗。
 *
 * 用法：node scripts/probe-security.js
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

/* 首启会弹知识库引导并占住弹层根节点；先按掉，再进设置点标签 */
const OPEN_SECURITY = `(async () => {
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
  const tab = document.querySelector('.modal-tabs button[data-tab="security"]')
  if (!tab) return { ok: false, error: '没有安全边界标签' }
  tab.click()
  for (let i = 0; i < 40; i++) {
    const text = document.querySelector('#modal-root .modal-body') ? document.querySelector('#modal-root .modal-body').innerText : ''
    if (text.indexOf('安全边界') >= 0 && text.length > 40) break
    await sleep(200)
  }
  await sleep(600)
  return { ok: true }
})()`

const OPENAI_KEY = 'sk-proj-AbCdEf1234567890GhIjKlMnOpQrStUvWxYz'
const PHONE = '13800138000'

async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-security-probe-'))
  fs.mkdirSync(dir, { recursive: true })

  /* ---------- 数据面：不启界面，先把闸门与账本点起来 ---------- */
  const { createMemoryStore } = require(path.join(ROOT, 'electron', 'memory', 'store.js'))
  const { createSecurity } = require(path.join(ROOT, 'electron', 'security', 'index.js'))

  const store = createMemoryStore({ configDir: dir, enabled: true })
  const security = createSecurity({ configDir: dir, store })

  /* 派活消息 → 候选 */
  store.inbox({ action: 'saveChannel', id: 'wecom-probe', kind: 'wecom', label: '企业微信', enabled: true, config: { keywords: ['小王'] } })
  store.inbox({
    action: 'ingest',
    id: 'wecom-probe',
    messages: [{
      chatId: 'g1',
      chatName: '产品群',
      senderName: '张经理',
      senderId: 'zhang',
      msgId: 'probe-1',
      text: '小王，麻烦你明天下午三点前把方案整理一份发我',
      at: new Date().toISOString(),
      mentionsMe: true
    }]
  })
  const candidates = security.tasks({ status: 'candidate' }).tasks
  check('派活：@ 你的消息自动进了候选', candidates.length === 1, candidates[0] && candidates[0].id)

  /* 候选 → 正式留痕 */
  const opened = security.openTask({ id: candidates[0] && candidates[0].id })
  check('留痕：点头之后才写账本', opened.ok === true && opened.task.status === 'open', opened.task && opened.task.id)

  /* 一次真实的外发检查：命中密钥 */
  const gate = security.screen({
    text: `对方让我把这个发过去：${OPENAI_KEY}`,
    target: '产品群',
    channel: 'wecom',
    purpose: '对方说要调试接口',
    taskId: opened.ok ? opened.task.id : null
  })
  check('闸门：密钥级内容被拦下', gate.verdict === 'confirm' && gate.risk === 'critical', gate.gateId)
  check('闸门：库里没有完整密钥',
    !JSON.stringify(store.db.prepare('SELECT * FROM security_gates').all()).includes(OPENAI_KEY))

  const second = security.screen({ text: `客户电话 ${PHONE}，回头发他`, target: '客户群' })
  check('闸门：手机号也要问一句', second.verdict === 'confirm', second.gateId)

  security.append({ taskId: opened.task.id, kind: 'action', title: '整理方案', body: { tool: 'write_text_file', target: '方案-v1.md' } })
  const verify = security.verify()
  check('账本：哈希链自校验通过', verify.ok === true, `${verify.count} 条 · ${String(verify.head).slice(0, 12)}`)
  check('账本：数据库层拒绝改写', (() => {
    try { store.db.prepare('UPDATE security_ledger SET title = ? WHERE seq = 1').run('x'); return false } catch { return true }
  })())

  const statsBefore = security.status().stats
  check('统计：两件等人点头', statsBefore.pending === 2, JSON.stringify({ pending: statsBefore.pending, open: statsBefore.openTasks }))

  /* 第二条：开 → 做 → 归档，验证「账本压成事件、事件能追原委」 */
  const docTask = security.openTask({
    ask: '下班前把这份合同发给法务确认',
    from: '陈总',
    channel: '微信个人号',
    chat: '陈总',
    deadline: '下班前'
  })
  security.append({ taskId: docTask.task.id, kind: 'action', title: '发给法务', body: { tool: 'send_mail', target: 'legal@example.com' } })
  const closed = security.closeTask({ id: docTask.task.id, outcome: '法务回复已收到' })
  check('压缩：归档即压成一条事件', Boolean(closed.digest && closed.digest.event && /^LZ\d{3}$/.test(closed.digest.event.code)),
    closed.digest && closed.digest.event ? closed.digest.event.code : '')

  const eventRow = store.db.prepare("SELECT * FROM events WHERE prefix = 'LZ'").get()
  check('压缩：事件只留一两行，账本没被搬走',
    Boolean(eventRow) && eventRow.summary.length <= 150 && eventRow.result.length <= 120 &&
      store.db.prepare('SELECT COUNT(*) AS n FROM security_ledger WHERE task_id = ?').get(docTask.task.id).n === 3,
    eventRow ? `${eventRow.summary.length} + ${eventRow.result.length} 字` : '')

  const trace = security.trace({ id: closed.task.id })
  check('原委：按时间给出说法、结果与证据',
    trace.found === true && /【来路】/.test(trace.text) && /【证据】/.test(trace.text) && /链完整/.test(trace.text),
    trace.timeline.length + ' 步')

  const brief = security.brief()
  check('首流：待办与进事件网压在一小段里',
    /待你点头 2 件/.test(brief.text) && /进事件网 1 条/.test(brief.text) && brief.text.length <= 260,
    brief.text.replace(/\n/g, ' | '))
  store.close()

  /* ---------- 界面面 ---------- */
  const shot = path.join(os.tmpdir(), 'astral-security-view.png')
  await runElectron({
    ASTRAL_CONFIG_DIR: dir,
    ASTRAL_SHOT: shot,
    ASTRAL_SHOT_JS: OPEN_SECURITY,
    ASTRAL_SHOT_JS_WAIT: '1500'
  }, true)
  check('界面：截图已生成', fs.existsSync(shot), shot)

  const dom = await runElectron({
    ASTRAL_CONFIG_DIR: dir,
    ASTRAL_EVAL: `(async () => {
      const base = await (${OPEN_SECURITY})
      if (!base.ok) return base
      const body = document.querySelector('#modal-root .modal-body')
      const text = body ? body.innerText : ''
      const before = await window.astral.securityPending()
      /* 点「允许这一次」：走主进程 IPC，渲染层不能自己批准 */
      const allow = [...document.querySelectorAll('#modal-root .btn')].find((b) => b.textContent.trim() === '允许这一次')
      if (allow) { allow.click() }
      await new Promise((r) => setTimeout(r, 900))
      const after = await window.astral.securityPending()
      const status = await window.astral.securityStatus()
      return {
        ok: true,
        mentionsPending: /等你点头/.test(text),
        mentionsLedger: /账本/.test(text),
        mentionsTrace: /留痕/.test(text),
        mentionsVerify: /校验通过/.test(text),
        mentionsEventNet: /进事件网/.test(text),
        traceButtons: [...document.querySelectorAll('#modal-root button')].filter((b) => b.textContent.trim() === '看原委').length,
        eventTags: [...document.querySelectorAll('#modal-root .tag')].filter((t) => /^LZ\\d{3}$/.test(t.textContent.trim())).length,
        gateRows: document.querySelectorAll('#modal-root .gate-row').length,
        ledgerRows: document.querySelectorAll('#modal-root .ledger-row').length,
        before: (before.gates || []).length,
        after: (after.gates || []).length,
        openTasks: (status.stats || {}).openTasks || 0,
        sample: text.slice(0, 160)
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
  check('界面：三块卡片都渲染出来', info.mentionsPending === true && info.mentionsLedger === true && info.mentionsTrace === true)
  check('界面：闸门与账本都有行', (info.gateRows || 0) >= 2 && (info.ledgerRows || 0) >= 2,
    `${info.gateRows || 0} 闸门 / ${info.ledgerRows || 0} 账本`)
  check('界面：显示校验通过', info.mentionsVerify === true)
  check('界面：留痕压进事件网后带编号', info.mentionsEventNet === true && (info.eventTags || 0) >= 1,
    `${info.eventTags || 0} 个事件编号`)
  check('界面：归档的留痕有「看原委」入口', (info.traceButtons || 0) >= 1, `${info.traceButtons || 0} 个入口`)
  check('控制面：点「允许这一次」后待确认从 ' + (info.before || 0) + ' 降到 ' + (info.after || 0),
    info.before === 2 && info.after === 1)
  check('控制面：留痕任务仍在进行中', info.openTasks === 1, String(info.openTasks))

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
