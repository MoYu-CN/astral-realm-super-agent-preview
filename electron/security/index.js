'use strict'

/**
 * security/index.js — 安全边界门面
 *
 * 做三件事，别的一概不管：
 *   1. 读设置（守卫开不开、哪类内容在放行期内）；
 *   2. 把「一次工具调用」翻译成「一次出站检查」；
 *   3. 给界面和主进程提供同一套接口，避免两边各判一次、判得还不一样。
 *
 * 关键的一条：这里没有 approve 的自动路径。批准只能来自主进程校验过的
 * 用户操作（原生确认窗 / 设置页按钮），agent 自己调不到。
 */

const fs = require('node:fs')
const path = require('node:path')
const policy = require('./policy.js')

const DEFAULTS = {
  guard: true,     // 出站守卫：命中敏感内容先问
  ledger: true,    // 留痕：派活消息给候选，用户点头才记账
  allowTypes: {}   // { phone: '2026-11-11T20:00:00.000Z' } 只对中低风险有效
}

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function createSecurity ({ configDir, store, logger = () => {} } = {}) {
  if (!store) throw new Error('createSecurity 需要 store')
  const file = path.join(configDir || '.', 'settings.json')

  function read () {
    const settings = readJson(file, {})
    const current = settings.security && typeof settings.security === 'object' ? settings.security : {}
    return {
      guard: current.guard !== false,
      ledger: current.ledger !== false,
      allowTypes: current.allowTypes && typeof current.allowTypes === 'object' ? current.allowTypes : {}
    }
  }

  function write (patch = {}) {
    const settings = readJson(file, {})
    const current = read()
    const next = {
      ...current,
      ...patch
    }
    /* allowTypes 整张替换：调用方给的是「删完之后的全集」，
       合并写会让删掉的那一项又长回来。 */
    if (!patch.allowTypes || typeof patch.allowTypes !== 'object') next.allowTypes = current.allowTypes
    settings.security = next
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      logger('安全设置写入失败：' + err.message)
      return { ok: false, error: err.message }
    }
    return { ok: true, settings: read() }
  }

  /* 放行期只对中低风险生效，且到点自动作废：不需要谁去清理。 */
  function allowTypes () {
    const settings = read()
    const at = Date.now()
    const live = {}
    for (const [type, until] of Object.entries(settings.allowTypes || {})) {
      const ts = Date.parse(until)
      if (Number.isFinite(ts) && ts > at) live[type] = until
    }
    return live
  }

  function guardOn () {
    return read().guard !== false
  }

  function ledgerOn () {
    return read().ledger !== false
  }

  function call (input) {
    const result = store.security({ ...input, guard: guardOn(), allowTypes: allowTypes() })
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, ...(result.data || {}) }
  }

  /**
   * 出站检查（agent 主动调，或主进程代它调）。
   * @returns {{verdict:'allow'|'confirm', risk, hits, gateId?, question?}}
   */
  function screen (input = {}) {
    return call({ action: 'screen', ...input })
  }

  /**
   * 把一次外部工具调用翻译成出站检查。
   * 内置工具不出本机，直接放行 —— 否则写个文件也要过闸门，纯属自找麻烦。
   */
  function screenToolCall (input = {}) {
    const exposure = policy.exposureOf(input.serverId, input.tool)
    if (exposure === 'none') {
      return { verdict: 'allow', risk: 'none', hits: [], exposure, reason: '内置工具，内容不出本机' }
    }
    const target = [input.serverName || input.serverId || '外部工具', input.tool].filter(Boolean).join(' · ')
    return {
      ...call({
        action: 'screen',
        exposure,
        kind: 'tool',
        target,
        channel: input.serverId || '',
        purpose: input.purpose || '',
        taskId: input.taskId || null,
        runId: input.runId || '',
        projectId: input.projectId || '',
        args: input.args || {}
      }),
      exposure,
      target
    }
  }

  function status () {
    const stats = call({ action: 'stats' })
    const settings = read()
    return {
      ok: true,
      ...settings,
      stats,
      file
    }
  }

  return {
    read,
    write,
    guardOn,
    ledgerOn,
    allowTypes,
    screen,
    screenToolCall,
    status,
    pending: () => call({ action: 'pending' }),
    gates: (input) => call({ action: 'gates', ...input }),
    approve: (input) => call({ action: 'approve', ...input }),
    deny: (input) => call({ action: 'deny', ...input }),
    tasks: (input) => call({ action: 'tasks', ...input }),
    openTask: (input) => call({ action: 'openTask', ...input }),
    closeTask: (input) => call({ action: 'closeTask', ...input }),
    dropTask: (input) => call({ action: 'dropTask', ...input }),
    append: (input) => call({ action: 'append', ...input }),
    ledger: (input) => call({ action: 'ledger', ...input }),
    verify: () => call({ action: 'verify' }),
    exportTask: (input) => call({ action: 'export', ...input }),
    digestTask: (input) => call({ action: 'digest', ...input }),
    trace: (input) => call({ action: 'trace', ...input }),
    search: (input) => call({ action: 'search', ...input }).hits || [],
    brief: () => call({ action: 'brief' }),
    stats: () => call({ action: 'stats' })
  }
}

module.exports = { createSecurity, DEFAULTS }
