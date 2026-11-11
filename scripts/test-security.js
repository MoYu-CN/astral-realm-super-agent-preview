'use strict'

/* 星界 · 安全边界自测：识别、放行、闸门、留痕、账本，全部纯 Node。 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createMemoryStore, ROLE } = require('../electron/memory/store.js')
const { createSecurity } = require('../electron/security/index.js')
const sensitivity = require('../electron/security/sensitivity.js')
const policy = require('../electron/security/policy.js')
const digest = require('../electron/security/digest.js')

const tests = []
let passed = 0
function test (name, fn) { tests.push({ name, fn }) }
const tempDirs = []

function tempDir () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astral-security-test-'))
  tempDirs.push(dir)
  return dir
}

function sweep (mark) {
  while (tempDirs.length > mark) {
    const dir = tempDirs.pop()
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 }) } catch { /* 留着下次清 */ }
  }
}

function fresh () {
  const dir = tempDir()
  const store = createMemoryStore({ configDir: dir })
  const security = createSecurity({ configDir: dir, store })
  return { dir, store, security }
}

/* 真样例（不是随机串）：长度与前缀都对得上，才说明规则是照真实格式写的 */
const OPENAI_KEY = 'sk-proj-AbCdEf1234567890GhIjKlMnOpQrStUvWxYz'
const GH_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const ID_CARD = '11010519491231002X'          // 校验位算得过的样例号
const ID_CARD_BAD = '110105194912310021'      // 校验位错一位
const BANK_CARD = '6222021234567890128'       // Luhn 通过
const PHONE = '13800138000'

/* ------------------------------------------------------------ 识别 */

test('识别：带前缀的密钥命中，普通英文与短词不误报', () => {
  const { hits, risk } = sensitivity.scan(`这是我的 key：${OPENAI_KEY}，别外传`)
  assert.equal(risk, 'critical')
  assert.ok(hits.some((hit) => hit.type === 'api-key'))
  assert.equal(sensitivity.scan('今天的会议纪要写在 docs/meeting.md 里').hits.length, 0)
  assert.equal(sensitivity.scan('the quick brown fox jumps over the lazy dog').hits.length, 0)
})

test('识别：身份证走校验位，假号不报', () => {
  const real = sensitivity.scan(`身份证 ${ID_CARD}`)
  assert.ok(real.hits.some((hit) => hit.type === 'id-card' && hit.level === 'high'))
  const fake = sensitivity.scan(`编号 ${ID_CARD_BAD}`)
  assert.ok(!fake.hits.some((hit) => hit.type === 'id-card'), '校验位不对的 18 位数字不该当成身份证')
})

test('识别：银行卡走 Luhn，订单号不报', () => {
  assert.ok(sensitivity.scan(`卡号 ${BANK_CARD}`).hits.some((hit) => hit.type === 'bank-card'))
  assert.ok(!sensitivity.scan('订单号 6222021234567890123').hits.some((hit) => hit.type === 'bank-card'))
})

test('识别：手机号与私钥', () => {
  assert.ok(sensitivity.scan(`联系 ${PHONE}`).hits.some((hit) => hit.type === 'phone' && hit.level === 'medium'))
  const pem = sensitivity.scan('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----')
  assert.equal(pem.risk, 'critical')
})

test('识别：git 哈希与 UUID 不当成密钥（误报控制）', () => {
  assert.equal(sensitivity.scan('commit 3f9a2b7c1d4e5f60718293a4b5c6d7e8f9012345').hits.length, 0)
  assert.equal(sensitivity.scan('uuid 550e8400-e29b-41d4-a716-446655440000').hits.length, 0)
  /* 同样的串，一旦贴到「token:」后面就得报 */
  assert.ok(sensitivity.scan('token: 3f9a2b7c1d4e5f60718293a4b5c6d7e8f9012345').hits.length > 0)
})

test('脱敏：样本只留头尾，整段预览里没有完整密钥', () => {
  const text = `配置如下\nOPENAI_KEY=${OPENAI_KEY}\n手机 ${PHONE}`
  const { hits } = sensitivity.scan(text)
  const apiHit = hits.find((hit) => hit.type === 'api-key')
  assert.ok(apiHit)
  assert.ok(!JSON.stringify(apiHit.samples).includes(OPENAI_KEY))
  const preview = sensitivity.redactText(text, 400)
  assert.ok(!preview.includes(OPENAI_KEY), '预览里不能出现完整密钥')
  assert.ok(!preview.includes(PHONE), '预览里不能出现完整手机号')
  assert.match(preview, /OPENAI_KEY=/)
})

test('识别：嵌套工具参数能标出是哪一段命中的', () => {
  const result = sensitivity.scanFields({
    to: 'zhangsan@example.com',
    messages: [{ role: 'user', content: `key 是 ${GH_TOKEN}` }]
  })
  const hit = result.hits.find((item) => item.type === 'api-key')
  assert.ok(hit)
  assert.match(hit.where, /messages\[0\]\.content/)
})

/* ------------------------------------------------------------ 放行规则 */

test('放行：内置工具不出本机，一律放行', () => {
  assert.equal(policy.exposureOf('builtin', 'write_text_file'), 'none')
  const verdict = policy.decide({ risk: 'critical', exposure: 'none', hits: [{ level: 'critical', type: 'api-key' }] })
  assert.equal(verdict.verdict, 'allow')
})

test('放行：外部发送命中密钥必须问，只读查询命中手机号可以放', () => {
  assert.equal(policy.exposureOf('wecom-mcp', 'send_message'), 'send')
  assert.equal(policy.exposureOf('github', 'list_issues'), 'pull')
  assert.equal(policy.exposureOf('unknown-server', 'do_something'), 'unknown')

  const send = policy.decide({ risk: 'critical', exposure: 'send', hits: [{ level: 'critical', type: 'api-key' }] })
  assert.equal(send.verdict, 'confirm')

  const pull = policy.decide({ risk: 'medium', exposure: 'pull', hits: [{ level: 'medium', type: 'phone' }] })
  assert.equal(pull.verdict, 'allow')

  const unknown = policy.decide({ risk: 'high', exposure: 'unknown', hits: [{ level: 'high', type: 'id-card' }] })
  assert.equal(unknown.verdict, 'confirm')
})

test('放行：只有中低风险能吃「这类不再问」，密钥永远逐次确认', () => {
  const until = new Date(Date.now() + 3600 * 1000).toISOString()
  const medium = policy.decide({
    risk: 'medium',
    exposure: 'send',
    hits: [{ level: 'medium', type: 'phone' }],
    allowTypes: { phone: until }
  })
  assert.equal(medium.verdict, 'allow')
  assert.equal(medium.whitelisted, true)

  const critical = policy.decide({
    risk: 'critical',
    exposure: 'send',
    hits: [{ level: 'critical', type: 'api-key' }],
    allowTypes: { 'api-key': until }
  })
  assert.equal(critical.verdict, 'confirm', '密钥级内容不能被「这类不再问」放行')
})

test('派活识别：@ 你 + 派活词才算，闲聊与别人的活不算', () => {
  const work = policy.detectAssignment({
    text: '小王，麻烦你明天下午三点前把方案整理一份发我',
    scope: 'group',
    mentionsMe: true
  })
  assert.equal(work.isAssignment, true)
  assert.ok(work.deadline)
  assert.match(work.reasons.join(' '), /@ 你/)

  const chat = policy.detectAssignment({ text: '哈哈哈这也太好笑了', scope: 'group', mentionsMe: true })
  assert.equal(chat.isAssignment, false)

  const others = policy.detectAssignment({ text: '小李明天把周报交一下', scope: 'group', mentionsMe: false })
  assert.equal(others.isAssignment, false, '群里没点你的活不是你的活')

  const life = policy.detectAssignment({ text: '帮我带一份外卖上来', scope: 'private', mentionsMe: false })
  assert.equal(life.isAssignment, false, '带饭不值得留痕')
})

/* ------------------------------------------------------------ 闸门 */

test('闸门：命中即落一行 pending，库里不留明文', () => {
  const { store, security, dir } = fresh()
  try {
    const result = security.screen({
      text: `帮我把这个 key 发到群里：${OPENAI_KEY}`,
      target: '产品群',
      channel: 'wecom',
      purpose: '对方说要调试'
    })
    assert.equal(result.verdict, 'confirm')
    assert.ok(result.gateId)
    assert.equal(result.risk, 'critical')

    const pending = security.pending().gates
    assert.equal(pending.length, 1)
    assert.equal(pending[0].target, '产品群')

    const raw = JSON.stringify(store.db.prepare('SELECT * FROM security_gates').all())
    assert.ok(!raw.includes(OPENAI_KEY), '闸门表里不能出现完整密钥')
    assert.ok(raw.includes('sk-pro'), '脱敏后的头几位要留着，方便用户对上号')

    /* 设置文件里也不该出现密钥 */
    const settingsFile = path.join(dir, 'settings.json')
    if (fs.existsSync(settingsFile)) {
      assert.ok(!fs.readFileSync(settingsFile, 'utf8').includes(OPENAI_KEY))
    }
  } finally { sweep(tempDirs.length - 1) }
})

test('闸门：批准之后同一份内容放行，改一个字就重新问', () => {
  const { security } = fresh()
  const text = `key 是 ${OPENAI_KEY}`
  const first = security.screen({ text, target: '产品群' })
  assert.equal(first.verdict, 'confirm')

  /* 没批准之前再查一次，仍然是「要确认」，而且复用同一道闸门——
     不能因为查了两次就让用户在设置页里看到两条一样的待确认 */
  const again = security.screen({ text, target: '产品群' })
  assert.equal(again.verdict, 'confirm')
  assert.equal(again.gateId, first.gateId)
  assert.equal(security.pending().gates.length, 1)

  const approved = security.approve({ id: first.gateId, scope: 'once' })
  assert.equal(approved.ok, true)

  const reused = security.screen({ text, target: '产品群' })
  assert.equal(reused.verdict, 'allow')
  assert.equal(reused.reused, true)

  /* 批准绑在内容指纹上：换一个字、换一个去处，都要重新问 */
  assert.equal(security.screen({ text: `key 是 ${OPENAI_KEY} `, target: '产品群' }).verdict, 'confirm')
  assert.equal(security.screen({ text, target: '技术群' }).verdict, 'confirm')
})

test('闸门：拒绝之后不会自动放行，一次批准只能用一次', () => {
  const { security } = fresh()
  const text = `卡号 ${BANK_CARD}`
  const gate = security.screen({ text, target: '财务群' })
  security.deny({ id: gate.gateId })
  assert.equal(security.pending().gates.length, 0)
  assert.equal(security.screen({ text, target: '财务群' }).verdict, 'confirm')

  const second = security.screen({ text, target: '财务群' })
  security.approve({ id: second.gateId })
  assert.equal(security.screen({ text, target: '财务群' }).verdict, 'allow')
  /* 用掉之后再发同一份，必须重新问 */
  assert.equal(security.screen({ text, target: '财务群' }).verdict, 'confirm')
})

test('闸门：守卫关掉时不再拦，但会明说命中了什么', () => {
  const { security } = fresh()
  security.write({ guard: false })
  const result = security.screen({ text: `key ${OPENAI_KEY}`, target: '群' })
  assert.equal(result.verdict, 'allow')
  assert.match(result.note, /守卫关闭/)
  assert.ok(result.hits.length > 0)
})

test('闸门：没有敏感内容的出站不留闸门记录', () => {
  const { store, security } = fresh()
  const result = security.screen({ text: '明天下午三点开会，会议室 A', target: '产品群' })
  assert.equal(result.verdict, 'allow')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM security_gates').get().n, 0)
})

test('闸门：超时未决自动作废，重新发要重新问', () => {
  const { store, security } = fresh()
  const gate = security.screen({ text: `手机 ${PHONE}`, target: '客户群' })
  store.db.prepare('UPDATE security_gates SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), gate.gateId)
  assert.equal(security.pending().gates.length, 0)
  const row = store.db.prepare('SELECT status FROM security_gates WHERE id = ?').get(gate.gateId)
  assert.equal(row.status, 'expired')
  assert.equal(security.approve({ id: gate.gateId }).ok, false)
})

/* ------------------------------------------------------------ 留痕 */

test('留痕：开一条 → 记动作 → 归档，账本逐条长出哈希链', () => {
  const { store, security } = fresh()
  const opened = security.openTask({
    ask: '明天下午三点前把方案整理一份发我',
    from: '张经理',
    channel: '企业微信',
    chat: '产品群',
    deadline: '明天下午三点'
  })
  assert.equal(opened.ok, true)
  const taskId = opened.task.id
  assert.match(taskId, /^A-\d{8}-01$/)
  assert.equal(opened.task.status, 'open')

  security.append({ taskId, kind: 'action', title: '整理方案', body: { tool: 'write_text_file', target: '方案-v1.md' } })
  const gate = security.screen({ text: `方案链接，联系 ${PHONE}`, target: '产品群', taskId })
  assert.equal(gate.verdict, 'confirm')
  security.approve({ id: gate.gateId })

  const closed = security.closeTask({ id: taskId, outcome: '方案已发出，对方回复收到' })
  assert.equal(closed.task.status, 'closed')

  const entries = security.ledger({ taskId }).entries
  assert.ok(entries.length >= 4, '任务 + 动作 + 拦下 + 批准 + 归档')
  const kinds = entries.map((entry) => entry.kind)
  for (const kind of ['task', 'action', 'gate', 'approval', 'close']) {
    assert.ok(kinds.includes(kind), '缺了 ' + kind)
  }

  const verify = security.verify()
  assert.equal(verify.ok, true)
  assert.equal(verify.count, entries.length)
  assert.equal(verify.head, entries[0].hash, '最新一条的哈希就是链头')
})

test('账本：数据库层禁止修改与删除', () => {
  const { store, security } = fresh()
  security.openTask({ ask: '把接口文档补一下', from: '李工' })
  assert.throws(() => {
    store.db.prepare('UPDATE security_ledger SET title = ? WHERE seq = 1').run('改过了')
  }, /只追加/)
  assert.throws(() => {
    store.db.prepare('DELETE FROM security_ledger WHERE seq = 1').run()
  }, /只追加/)
  assert.equal(security.verify().ok, true)
})

test('账本：真被改了，verify 会在那一条断掉', () => {
  const { store, security } = fresh()
  security.openTask({ ask: '出一版预算表', from: '王总' })
  security.append({ taskId: 'A-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-01', kind: 'action', title: '拉数据' })
  /* 绕过触发器（模拟有人直接改文件），校验必须发现 */
  store.db.exec('DROP TRIGGER security_ledger_no_update')
  store.db.prepare('UPDATE security_ledger SET title = ? WHERE seq = 2').run('偷改的标题')
  const verify = security.verify()
  assert.equal(verify.ok, false)
  assert.equal(verify.brokenAt, 2)
  assert.match(verify.reason, /对不上/)
})

test('留痕：候选不写账本，用户点头之后才进链', () => {
  const { store, security } = fresh()
  store.inbox({
    action: 'saveChannel',
    id: 'wecom-1',
    kind: 'wecom',
    label: '企业微信',
    enabled: true,
    config: { keywords: ['小王'] }
  })
  const result = store.inbox({
    action: 'ingest',
    id: 'wecom-1',
    messages: [{
      chatId: 'g1',
      chatName: '产品群',
      senderName: '张经理',
      senderId: 'zhang',
      msgId: 'm1',
      text: '小王，麻烦你明天下午三点前把方案整理一份发我',
      at: new Date().toISOString(),
      mentionsMe: true
    }]
  })
  assert.equal(result.ok, true)
  const candidates = security.tasks({ status: 'candidate' }).tasks
  assert.equal(candidates.length, 1)
  assert.match(candidates[0].ask, /方案/)
  assert.equal(security.ledger().entries.length, 0, '候选阶段账本必须是空的')

  const opened = security.openTask({ id: candidates[0].id })
  assert.equal(opened.ok, true)
  assert.equal(security.tasks({ status: 'open' }).tasks.length, 1)
  const entries = security.ledger({ taskId: candidates[0].id }).entries
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'task')
  assert.equal(entries[0].body.from, '张经理')
})

test('留痕：导出存证带原话、时间线、链头与校验结论', () => {
  const { security } = fresh()
  const opened = security.openTask({
    ask: '下班前把这份合同发给法务确认',
    from: '陈总',
    channel: '微信个人号',
    chat: '陈总',
    deadline: '下班前'
  })
  security.append({ taskId: opened.task.id, kind: 'action', title: '发给法务', body: { tool: 'send_mail', target: 'legal@example.com' } })
  const result = security.exportTask({ id: opened.task.id })
  assert.equal(result.ok, true)
  assert.match(result.markdown, /工作留痕 · A-/)
  assert.match(result.markdown, /下班前把这份合同发给法务确认/)
  assert.match(result.markdown, /链头哈希/)
  assert.match(result.markdown, /校验结果：通过/)
  assert.match(result.markdown, /数据库触发器禁止修改与删除/)
})

test('留痕：归档之后不能重开，候选可以丢掉', () => {
  const { store, security } = fresh()
  const opened = security.openTask({ ask: '把服务器巡检做一遍', from: '运维群' })
  security.closeTask({ id: opened.task.id })
  assert.equal(security.openTask({ id: opened.task.id }).ok, false)

  store.inbox({ action: 'saveChannel', id: 'q1', kind: 'webhook', label: 'Webhook', enabled: true, config: {} })
  store.inbox({
    action: 'ingest',
    id: 'q1',
    messages: [{ chatId: 'c1', senderName: '赵六', text: '你负责跟进一下这个客户的合同', at: new Date().toISOString(), scope: 'private' }]
  })
  const candidate = security.tasks({ status: 'candidate' }).tasks[0]
  assert.ok(candidate)
  assert.equal(security.dropTask({ id: candidate.id }).ok, true)
  assert.equal(security.tasks({ status: 'candidate' }).tasks.length, 0)
  assert.equal(security.ledger().entries.length, 2, '丢掉的候选不进账本（此时只有上一条的 task + close）')
})

/* ------------------------------------------------------------ 门面 */

test('门面：设置落在 settings.json，版本与开关都能读回', () => {
  const { security, dir } = fresh()
  assert.equal(security.read().guard, true, '默认开着')
  security.write({ guard: false })
  assert.equal(security.read().guard, false)
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  assert.equal(raw.security.guard, false)
  const status = security.status()
  assert.equal(status.ok, true)
  assert.equal(status.guard, false)
  assert.ok(status.stats)
})

test('门面：screenToolCall 把外部工具翻成出站检查，内置工具直接放行', () => {
  const { security } = fresh()
  const builtin = security.screenToolCall({ serverId: 'builtin', tool: 'write_text_file', args: { content: OPENAI_KEY } })
  assert.equal(builtin.verdict, 'allow')
  assert.equal(builtin.exposure, 'none')

  const external = security.screenToolCall({
    serverId: 'wecom-mcp',
    serverName: '企业微信',
    tool: 'send_message',
    args: { to: '产品群', content: `这是 key：${OPENAI_KEY}` }
  })
  assert.equal(external.verdict, 'confirm')
  assert.equal(external.exposure, 'send')
  assert.match(external.target, /企业微信/)
})

test('门面：记忆库关掉时闸门不假装还在工作', () => {
  const dir = tempDir()
  const store = createMemoryStore({ configDir: dir })
  store.close()
  const security = createSecurity({ configDir: dir, store })
  /* store 已关闭：调用应当报错而不是静默放行 */
  const result = security.screen({ text: `key ${OPENAI_KEY}`, target: '群' })
  assert.equal(result.ok, false)
  assert.ok(result.error)
})

test('工具层：security_check / security_ledger 走 memory 权限，未授权时被拒', () => {
  const gateway = require('../electron/tool-gateway.js')
  assert.deepEqual(gateway.capabilitiesFor('builtin', 'security_check'), ['memory'])
  assert.deepEqual(gateway.capabilitiesFor('builtin', 'security_ledger'), ['memory'])
  const denied = gateway.createToolGateway({ configDir: tempDir() }).evaluate({
    serverId: 'builtin',
    tool: 'security_ledger',
    permissions: { readFiles: true }
  })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /记忆/)
})

/* ------------------------------------------------------------ 压缩进事件网 / 首流 / 追原委 */

function openFor (security, overrides = {}) {
  const opened = security.openTask({
    ask: '明天下午三点前把方案整理一份发我',
    from: '张经理',
    channel: '企业微信',
    chat: '产品群',
    deadline: '明天下午三点',
    ...overrides
  })
  return opened.task.id
}

test('压缩：归档即压成一条事件，账本一条不动', () => {
  const { store, security } = fresh()
  const id = openFor(security)
  security.append({ taskId: id, kind: 'action', title: '整理方案', body: { tool: 'write_text_file', target: '方案-v1.md' } })
  const closed = security.closeTask({ id, outcome: '方案已发出，对方回复收到' })

  assert.equal(closed.ok, true)
  assert.equal(closed.digest.ok, true)
  assert.match(closed.digest.event.code, /^LZ\d{3}$/)

  const row = store.db.prepare("SELECT * FROM events WHERE prefix = 'LZ'").get()
  assert.ok(row)
  assert.equal(row.project_id, null, '留痕是跨项目的，不挂到某个项目下')
  assert.ok(row.summary.length <= digest.SUMMARY_MAX)
  assert.ok(row.result.length <= digest.RESULT_MAX)
  assert.match(row.summary, /张经理/)
  assert.match(row.summary, /方案已发出/)
  assert.equal(JSON.parse(row.metadata).taskId, id)

  assert.equal(security.ledger({ taskId: id }).entries.length, 3, '事件是压缩件，账本还是原来三条')
  assert.equal(security.tasks({ status: 'closed' }).tasks[0].eventCode, closed.digest.event.code)
})

test('压缩：账本没新增就不重复写，长出新的条目才追加下一条', () => {
  const { security } = fresh()
  const id = openFor(security)
  const first = security.digestTask({ id })
  assert.equal(first.ok, true)
  const again = security.digestTask({ id })
  assert.equal(again.already, true)
  assert.equal(again.event.id, first.event.id)

  security.append({ taskId: id, kind: 'action', title: '补一步' })
  const next = security.digestTask({ id })
  assert.notEqual(next.event.id, first.event.id)
  assert.equal(next.event.code, 'LZ002')
})

test('压缩：原话里的密钥先脱敏，留痕不能反过来成为泄露渠道', () => {
  const { store, security } = fresh()
  const id = openFor(security, { ask: `把这个密钥发过去：${OPENAI_KEY}`, from: '李工' })
  security.closeTask({ id, outcome: '已处理' })
  const raw = JSON.stringify(store.db.prepare("SELECT * FROM events WHERE prefix = 'LZ'").all())
  assert.ok(!raw.includes(OPENAI_KEY), '事件网里不能出现完整密钥')
  assert.match(raw, /sk-pro/, '脱敏后仍留头几位，方便对上号')
})

test('首流：安全状态进常驻上下文，只给待办与查法，长度受控', () => {
  const { store, security } = fresh()
  security.screen({ text: `key ${OPENAI_KEY}`, target: '产品群' })
  const id = openFor(security)
  security.closeTask({ id, outcome: '发出去了' })

  const brief = security.brief()
  assert.match(brief.text, /待你点头 1 件/)
  assert.match(brief.text, /进事件网 1 条/)
  assert.match(brief.text, /问原委：security_ledger action=trace/)
  assert.ok(brief.text.length <= 260, '首流每多一行都是每一轮的成本')

  const prompt = store.hardContext.prompt()
  assert.equal(prompt.ok, true)
  assert.match(prompt.data.text, /### 安全状态（实时）/)
  assert.match(prompt.data.text, /问原委：security_ledger action=trace id=A-/)
})

test('权重：证据越多、越完整、越严重、越近，越该先被翻出来', () => {
  const at = new Date().toISOString()
  const entries = Array.from({ length: 6 }, (_, i) => ({ kind: 'action', title: '第 ' + i + ' 步', at }))
  const rich = digest.weightOf({
    task: { status: 'closed', outcome: '做完了', eventCode: 'LZ001', createdAt: at },
    entries
  })
  const emptyTask = digest.weightOf({ task: { status: 'candidate', createdAt: at }, entries: [] })
  const old = digest.weightOf({
    task: {
      status: 'closed',
      outcome: '做完了',
      eventCode: 'LZ002',
      createdAt: new Date(Date.now() - 240 * 86400000).toISOString()
    },
    entries
  })

  assert.ok(rich.weight > emptyTask.weight, '有账本有结论的，排在空候选前面')
  assert.ok(rich.weight > old.weight, '同样的记录，240 天前的排在后面')
  assert.ok(rich.percent > 0 && rich.percent <= 98)
  assert.equal(rich.factors.entries, 6)
  assert.equal(rich.factors.days, 0)
})

test('搜索：问原委按权重与时间，不要求字面重合；普通问法只认内容', () => {
  const { security } = fresh()
  const contract = openFor(security, { ask: '下班前把这份合同发给法务确认', from: '陈总', channel: '微信个人号', chat: '陈总' })
  security.closeTask({ id: contract, outcome: '已发法务' })
  const server = openFor(security, { ask: '把服务器巡检做一遍', from: '运维群', channel: '企业微信', chat: '运维群' })
  security.closeTask({ id: server, outcome: '巡检完成' })

  const hits = security.search({ query: '谁让我把合同发给法务的' })
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].id, contract)
  assert.match(hits[0].why, /原委/)

  assert.equal(security.search({ query: '量子色动力学' }).length, 0, '不相关的问法不该把所有留痕都翻出来')
})

test('原委：按时间给出谁说的、做了什么、结果与证据', () => {
  const { security } = fresh()
  const id = openFor(security)
  security.append({ taskId: id, kind: 'action', title: '整理方案', body: { tool: 'write_text_file', target: '方案-v1.md' } })
  security.closeTask({ id, outcome: '方案已发出，对方回复收到' })

  const result = security.trace({ id })
  assert.equal(result.ok, true)
  assert.match(result.text, /【来路】/)
  assert.match(result.text, /张经理/)
  assert.match(result.text, /明天下午三点前把方案整理一份发我/)
  assert.match(result.text, /【做了什么】/)
  assert.match(result.text, /【结果】/)
  assert.match(result.text, /【证据】/)
  assert.match(result.text, /链完整/)
  assert.equal(result.verify.ok, true)
  assert.ok(result.timeline.length >= 2)
})

test('原委：没开留痕的候选不编故事，缺口照实说', () => {
  const { store, security } = fresh()
  store.inbox({ action: 'saveChannel', id: 'w1', kind: 'wecom', label: '企业微信', enabled: true, config: { keywords: ['小王'] } })
  store.inbox({
    action: 'ingest',
    id: 'w1',
    messages: [{
      chatId: 'g1',
      chatName: '产品群',
      senderName: '张经理',
      msgId: 'm1',
      text: '小王，麻烦你明天下午三点前把方案整理一份发我',
      at: new Date().toISOString(),
      mentionsMe: true
    }]
  })
  const candidate = security.tasks({ status: 'candidate' }).tasks[0]
  const result = security.trace({ id: candidate.id })
  assert.equal(result.found, true)
  assert.match(result.text, /没有开留痕/)
  assert.ok(result.gaps.some((gap) => /账本是空的/.test(gap)))
  assert.equal(result.timeline.length, 0)
})

test('回忆：留痕按权重带出来，并说明是「原委」还是「内容」', () => {
  const { store, security } = fresh()
  const id = openFor(security, { ask: '下班前把这份合同发给法务确认', from: '陈总' })
  security.closeTask({ id, outcome: '已发法务' })

  const res = store.recall({ query: '谁让我把合同发给法务', actor: ROLE.SUPER })
  assert.equal(res.ok, true)
  assert.ok(res.data.security.length >= 1)
  assert.match(res.data.text, /【留痕 · 按权重】/)
  assert.equal(res.stats.security, res.data.security.length)
  assert.match(res.data.security[0].summary, /陈总/)
})

test('时间网：留痕事件不进作息，避免「只在出事时才出现的系列」', () => {
  const { store, security } = fresh()
  const id = openFor(security)
  security.closeTask({ id, outcome: '完成' })
  store.syncTime()
  const keys = store.db.prepare('SELECT DISTINCT key FROM time_slots').all().map((row) => row.key)
  assert.ok(!keys.includes('工作留痕'))
})

;(async () => {
  for (const item of tests) {
    const mark = tempDirs.length
    try {
      await item.fn()
    } finally {
      sweep(mark)
    }
    passed += 1
    console.log(`ok ${passed} - ${item.name}`)
  }
  console.log(`\n${passed} tests passed`)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
