/* roles.js — 本机用户角色与能力边界
 *
 * 角色保存在 settings.json → profile.role，默认 admin（老配置升级后仍是管理员）。
 * 这里只做「界面该不该给」；真正的拒绝在主进程里按同一份角色表再判一次，
 * 因为渲染层的按钮可以被绕过，安全边界不能只靠隐藏。
 */

import { state } from './core.js'

export const ROLES = [
  {
    id: 'admin',
    label: '管理员',
    rank: 3,
    desc: '可改设置、模型、权限、记忆与上下文；可打开控制台的写接口。'
  },
  {
    id: 'member',
    label: '成员',
    rank: 2,
    desc: '可对话、使用已授权工具、维护项目与知识；不能改系统设置或记忆写接口。'
  },
  {
    id: 'guest',
    label: '游客',
    rank: 1,
    desc: '只读：可浏览界面与记录，不能发起模型调用、写文件或改设置。'
  }
]

const BY_ID = new Map(ROLES.map((role) => [role.id, role]))

const CAPS = {
  'chat': ['admin', 'member'],
  'tools': ['admin', 'member'],
  'files.write': ['admin', 'member'],
  'project.manage': ['admin', 'member'],
  'job.manage': ['admin', 'member'],
  'knowledge.write': ['admin', 'member'],
  'memory.read': ['admin', 'member'],
  'memory.console': ['admin', 'member'],
  'memory.write': ['admin'],
  'settings': ['admin'],
  'providers': ['admin'],
  'roster': ['admin'],
  'plugins.manage': ['admin'],
  'role.manage': ['admin']
}

export function roleId () {
  const id = state.settings && state.settings.profile ? state.settings.profile.role : ''
  return BY_ID.has(id) ? id : 'admin'
}

export function roleInfo (id = roleId()) {
  return BY_ID.get(id) || BY_ID.get('admin')
}

export function can (cap) {
  const allowed = CAPS[cap]
  if (!allowed) return false
  return allowed.includes(roleId())
}

export function isGuest () {
  return roleId() === 'guest'
}

export function isAdmin () {
  return roleId() === 'admin'
}

/* 给设置页画一张矩阵，避免用户靠猜 */
export function roleMatrix () {
  const caps = [
    ['对话与调用模型', 'chat'],
    ['使用已授权工具', 'tools'],
    ['写项目文件 / 数据', 'files.write'],
    ['管理项目与长任务', 'job.manage'],
    ['写知识条目', 'knowledge.write'],
    ['查看记忆控制台', 'memory.console'],
    ['编辑硬性上下文', 'memory.write'],
    ['改系统设置 / 模型 / 编制', 'settings']
  ]
  return caps.map(([label, cap]) => ({
    label,
    admin: canFor('admin', cap),
    member: canFor('member', cap),
    guest: canFor('guest', cap)
  }))
}

function canFor (role, cap) {
  const allowed = CAPS[cap] || []
  return allowed.includes(role)
}
