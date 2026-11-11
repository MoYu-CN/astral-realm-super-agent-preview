'use strict'

/* tool-gateway.js — 工具能力校验与审计
 *
 * 渲染层负责发起审批，主进程负责最后一道能力校验，并把每一次
 * 工具调用（允许或拒绝）写进 config/logs/tools.jsonl。
 *
 * 权限键来自 app/js/permissions.js：
 *   full / readFiles / writeFiles / runCommands / network / tools / memory
 */

const fs = require('node:fs')
const path = require('node:path')

const CAPABILITY_PERMISSION = {
  'fs.read': 'readFiles',
  'fs.write': 'writeFiles',
  exec: 'runCommands',
  network: 'network',
  memory: 'memory',
  external: 'tools',
  'screen.capture': 'tools',
  'knowledge.read': 'tools',
  'knowledge.write': 'tools'
}

const CAPABILITY_LABEL = {
  'fs.read': '读取文件',
  'fs.write': '写入文件',
  exec: '执行命令',
  network: '联网',
  memory: '写入记忆',
  external: '外部工具',
  'screen.capture': '截屏',
  'knowledge.read': '读取知识库',
  'knowledge.write': '写入知识库'
}

function capabilitiesFor (serverId, tool) {
  if (serverId !== 'builtin') return ['external']
  switch (tool) {
    case 'get_current_timestamp':
      return []
    case 'read_text_file':
    case 'list_directory':
      return ['fs.read']
    case 'write_text_file':
      return ['fs.write']
    case 'take_screenshot':
      return ['screen.capture']
    case 'kb_list':
    case 'kb_search':
    case 'kb_guide':
    case 'kb_get':
      return ['knowledge.read']
    case 'kb_add':
    case 'kb_remove':
    case 'kb_prune':
    case 'kb_init':
      return ['knowledge.write']
    case 'memory_query':
    case 'memory_context':
    case 'memory_recall':
    case 'memory_time':
    case 'memory_observe':
    case 'memory_kb':
    case 'memory_inbox':
      return ['memory']
    case 'memory_write':
    case 'memory_knowledge':
      return ['memory']
    case 'security_check':
    case 'security_ledger':
      return ['memory']
    default:
      return ['external']
  }
}

function redactArgs (args) {
  if (args === null || typeof args !== 'object') return String(args ?? '').slice(0, 300)
  const sensitive = /(api[-_]?key|token|secret|password|authorization|content)/i
  const out = {}
  for (const [key, value] of Object.entries(args)) {
    if (sensitive.test(key)) {
      out[key] = '[redacted]'
    } else if (typeof value === 'string') {
      out[key] = value.length > 180 ? `${value.slice(0, 180)}…` : value
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 8).map((item) => typeof item === 'string' ? item.slice(0, 80) : item)
    } else if (value && typeof value === 'object') {
      out[key] = '[object]'
    } else {
      out[key] = value
    }
  }
  return JSON.stringify(out).slice(0, 600)
}

function createToolGateway ({ configDir }) {
  const dir = path.join(configDir, 'logs')
  const file = path.join(dir, 'tools.jsonl')

  function rotate () {
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size < 2 * 1024 * 1024) return
      fs.renameSync(file, `${file}.1`)
    } catch { /* ignore */ }
  }

  function audit (entry) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      rotate()
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch { /* 审计失败不阻塞工具调用 */ }
  }

  function evaluate (payload = {}) {
    const serverId = String(payload.serverId || '')
    const tool = String(payload.tool || '')
    const capabilities = capabilitiesFor(serverId, tool)
    const permissions = payload.permissions
    if (!permissions || typeof permissions !== 'object') {
      return { ok: true, capabilities, policy: 'legacy', reason: '' }
    }
    if (permissions.full === true) {
      return { ok: true, capabilities, policy: 'full', reason: '' }
    }
    const missing = []
    for (const capability of capabilities) {
      const key = CAPABILITY_PERMISSION[capability]
      if (key && permissions[key] !== true) missing.push({ capability, key })
    }
    if (missing.length) {
      const labels = [...new Set(missing.map((item) => CAPABILITY_LABEL[item.capability] || item.capability))]
      return {
        ok: false,
        capabilities,
        policy: 'enforced',
        error: `工具需要「${labels.join('、')}」权限，当前成员未获授权`,
        missing
      }
    }
    return { ok: true, capabilities, policy: 'enforced', reason: '' }
  }

  function record ({ payload = {}, result = null, decision = null, durationMs = 0, approval = null } = {}) {
    const capabilities = decision && decision.capabilities
      ? decision.capabilities
      : capabilitiesFor(payload.serverId, payload.tool)
    audit({
      ts: Date.now(),
      runId: String(payload.runId || ''),
      runAgentId: String(payload.runAgentId || ''),
      projectId: String(payload.projectId || ''),
      projectName: String(payload.projectName || ''),
      agentId: String(payload.agentId || ''),
      permissionScope: String(payload.permissionScope || ''),
      serverId: String(payload.serverId || ''),
      serverName: String(payload.serverName || ''),
      tool: String(payload.tool || ''),
      capabilities,
      policy: decision ? decision.policy : 'unknown',
      allowed: Boolean(decision && decision.ok),
      reason: String((decision && decision.error) || '').slice(0, 500),
      /* 只有主进程签发并消费过的审批令牌才算 approved；
         渲染层传来的 approved 布尔值不会进入这里，只会被记成尝试记录。 */
      approved: Boolean(approval && approval.ok !== false && approval.source),
      approvalSource: approval ? String(approval.source || '') : '',
      approvalId: approval ? String(approval.id || '') : '',
      /* 出站闸门编号：把「工具被允许」和「内容被批准」两条记录对起来 */
      securityGate: String(payload.securityGate || ''),
      clientApprovalIgnored: Boolean(payload.clientApprovalIgnored),
      ok: result ? Boolean(result.ok) : false,
      error: result && result.error ? String(result.error).slice(0, 500) : '',
      durationMs: Math.max(0, Number(durationMs) || 0),
      args: redactArgs(payload.args || {})
    })
  }

  function list ({ limit = 50 } = {}) {
    try {
      if (!fs.existsSync(file)) return { ok: true, entries: [] }
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      const entries = []
      for (let i = lines.length - 1; i >= 0 && entries.length < Math.min(200, Math.max(1, Number(limit) || 50)); i--) {
        try { entries.push(JSON.parse(lines[i])) } catch { /* ignore broken line */ }
      }
      return { ok: true, entries, file }
    } catch (err) {
      return { ok: false, error: err.message, entries: [] }
    }
  }

  function describeCapabilities () {
    return { permission: CAPABILITY_PERMISSION, label: CAPABILITY_LABEL }
  }

  return { evaluate, record, list, capabilitiesFor, describeCapabilities, file }
}

module.exports = { createToolGateway, capabilitiesFor }
