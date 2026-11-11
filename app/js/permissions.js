/* permissions.js — 权限模型（全局总闸 / 成员默认 / 成员自身 → 生效权限）

   三层关系：
   1) settings.permissions        全局授予，是总闸，含「完全授权」
   2) settings.agentDefaults.permissions  新建成员时套用的默认值
   3) agent.permissions           成员自身的权限，缺省时回落到默认值

   生效权限 = 全局 ∩（成员自身 ?? 默认值 ?? 全局）。
   全局一旦开「完全授权」，其余全部视为已授予，成员侧不再参与拦截。 */

import { state, persist } from './core.js'

export const PERMS = [
  { key: 'full', label: '完全授权', desc: '最高授权，覆盖其余所有权限项', master: true },
  { key: 'readFiles', label: '读取文件', desc: '成员可读取你上传的数据文件' },
  { key: 'writeFiles', label: '写入文件', desc: '产出可写回磁盘' },
  { key: 'runCommands', label: '执行命令', desc: '允许调用本机 shell / 脚本' },
  { key: 'network', label: '联网检索', desc: '允许成员发起网络请求' },
  { key: 'tools', label: '外部工具', desc: '通过 MCP 服务器操作本机软件（每次调用需确认）' },
  { key: 'memory', label: '写入记忆', desc: '结论可写入全局上下文' }
]

export const FULL_KEY = 'full'

/* 除「完全授权」之外的真实能力项 */
export const PERM_KEYS = PERMS.filter((p) => !p.master).map((p) => p.key)

export const PERM_LABELS = PERMS.map((p) => ({ key: p.key, label: p.label }))

export function permByKey (key) {
  return PERMS.find((p) => p.key === key) || null
}

/* ------------------------------------------------------------ 读写入口 */

export function globalPerms () {
  if (!state.settings.permissions) state.settings.permissions = {}
  return state.settings.permissions
}

export function setGlobalPerm (key, on) {
  const perms = globalPerms()
  perms[key] = Boolean(on)
  persist.settings()
}

export function agentDefaultPerms () {
  const box = state.settings.agentDefaults || (state.settings.agentDefaults = {})
  if (!box.permissions) box.permissions = {}
  return box.permissions
}

/* 默认值有没有被用户真正配置过——没配过就当不存在，避免误伤既有成员 */
export function hasAgentDefaults () {
  const box = state.settings.agentDefaults
  if (!box || !box.permissions) return false
  return Object.keys(box.permissions).length > 0
}

export function setAgentDefaultPerm (key, on) {
  const perms = agentDefaultPerms()
  perms[key] = Boolean(on)
  persist.settings()
}

export function agentOwnPerms (agent) {
  return (agent && agent.permissions) || null
}

/* 成员侧只保存具体能力项，「完全授权」是全局开关，不落到成员身上 */
export function ownPermsBase (agent) {
  const own = agentOwnPerms(agent) || (hasAgentDefaults() ? agentDefaultPerms() : globalPerms())
  const out = {}
  for (const key of PERM_KEYS) out[key] = Boolean(own[key])
  return out
}

export function setAgentPerm (agent, key, on) {
  if (!agent || key === FULL_KEY) return
  if (!agent.permissions) agent.permissions = ownPermsBase(agent)
  agent.permissions[key] = Boolean(on)
  persist.roster()
}

export function clearAgentPerms (agent) {
  if (!agent) return
  delete agent.permissions
  persist.roster()
}

/* ------------------------------------------------------------ 生效解析 */

export function effectivePerms (agent) {
  const g = globalPerms()
  const out = { [FULL_KEY]: Boolean(g[FULL_KEY]) }

  if (out[FULL_KEY]) {
    for (const key of PERM_KEYS) out[key] = true
    return out
  }

  const own = agentOwnPerms(agent) || (hasAgentDefaults() ? agentDefaultPerms() : g)
  for (const key of PERM_KEYS) out[key] = Boolean(g[key]) && Boolean(own[key])
  return out
}

export function isFullAuth (perms) {
  return Boolean(perms && perms[FULL_KEY])
}

/* 写进提示词的授予清单 */
export function grantedLabels (perms) {
  const p = perms || {}
  if (isFullAuth(p)) return ['全部能力（完全授权）']
  return PERMS.filter((x) => !x.master && p[x.key]).map((x) => x.label)
}

export function grantedCount (perms) {
  const p = perms || {}
  if (isFullAuth(p)) return PERM_KEYS.length
  return PERM_KEYS.filter((k) => p[k]).length
}

/* --------------------------------------------------------- 默认值落地 */

/* 新建成员时套用默认权限；没配过默认值就不写，保持「跟随全局」 */
export function applyDefaultPerms (agent) {
  if (!agent) return agent
  if (!hasAgentDefaults()) return agent
  agent.permissions = { ...agentDefaultPerms() }
  return agent
}

export function applyDefaultsToAll () {
  if (!hasAgentDefaults()) return 0
  for (const agent of state.roster.agents) applyDefaultPerms(agent)
  persist.roster()
  return state.roster.agents.length
}

export function clearAllAgentPerms () {
  for (const agent of state.roster.agents) delete agent.permissions
  persist.roster()
  return state.roster.agents.length
}

export function setAllAgentPerm (key, on) {
  for (const agent of state.roster.agents) {
    if (!agent.permissions) agent.permissions = {}
    agent.permissions[key] = Boolean(on)
  }
  persist.roster()
  return state.roster.agents.length
}
