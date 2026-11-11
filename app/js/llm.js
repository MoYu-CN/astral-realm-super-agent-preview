/* llm.js — 模型调用与提示词装配 */

import { state, providerById, skillById, subordinatesOf, activeProject, conversationIsTeam } from './core.js'
import { effectivePerms, grantedLabels, isFullAuth } from './permissions.js'
import { dataFileManifest } from './datafiles.js'
import { toolSchemasFor } from './mcp.js'

const pending = new Map()
let seq = 0

window.astral.onLLMEvent((ev) => {
  const entry = pending.get(ev.id)
  if (!entry) return
  if (ev.type === 'delta') {
    try { entry.onDelta(ev.text) } catch (err) { console.error(err) }
  } else if (ev.type === 'toolCalls') {
    try { entry.onToolCalls && entry.onToolCalls(ev.calls || []) } catch (err) { console.error(err) }
  } else if (ev.type === 'retry') {
    /* 主进程已丢弃上一轮的半截输出，这里同步清掉对应的气泡文本 */
    try { entry.onRetry && entry.onRetry(ev) } catch (err) { console.error(err) }
  } else if (ev.type === 'warning') {
    try { entry.onWarning && entry.onWarning(ev) } catch (err) { console.error(err) }
  } else if (ev.type === 'usage') {
    try { entry.onUsage && entry.onUsage(ev.usage || null) } catch (err) { console.error(err) }
  } else if (ev.type === 'done') {
    pending.delete(ev.id)
    entry.resolve(ev.text)
  } else if (ev.type === 'error') {
    pending.delete(ev.id)
    entry.reject(new Error(ev.message || '模型调用失败'))
  }
})

export const ROLE_LABEL = { commander: '总指挥', deputy: '副指挥', executor: '执行者' }

/* 职位的统一含义、职责与边界。所有成员共用同一份定义，
   具体到个人的汇报线、下属与负责领域由 buildSystemPrompt 动态拼接。 */
/* 插件制作模式：把官方规格压成速查表塞进提示词，
   模型就不容易凭空编接口。完整文档见 app/docs/plugin-guide.md。 */
const PLUGIN_MODE_PROMPT = [
  '## 当前模式：插件制作',
  '按官方规格写插件，只用下面列出的 API，不要臆造接口。完整文档见 app/docs/plugin-guide.md。',
  '',
  '目录：`config/plugins/<id>/plugin.json` + `plugin.js`（ES 模块，`export default function setup (astral) {}`，不支持 require）。',
  'plugin.json：`id`（小写连字符，必需）、`name`、`version`、`description`、`entry`、`runtime`（必须为 `"isolated"`）、`permissions`（最小权限数组）。',
  'permissions 可选：`ui.dock` / `hooks` / `skills` / `themes` / `messages` / `settings` / `knowledge` / `chat` / `clipboard`。',
  '',
  '隔离沙箱仅可用：',
  '- `astral.log/toast/h`、`astral.settings.get/set/onChange`、`astral.project.current/onChange`',
  '- `astral.chat.submit`、`astral.clipboard.write`、`astral.messages.inject`',
  '- `astral.skills.register`、`astral.themes.register`',
  "- `astral.on('before:request'|'after:reply'|'on:message', fn)`",
  '- `astral.ui.registerDockPane({id,label,order,render})` / `modal` / `confirm`；`astral.knowledge.call/pickDir`（需 knowledge 权限）',
  '',
  '不能 import/require、不能访问主界面 DOM、`window.Astral`、应用状态或 API Key；不要生成 `getState`/`bus`/网络请求。',
  '',
  '交付：先确认插件 id 与用途（信息不足先问）；给出两个文件完整内容与保存路径，不要省略；结尾写启用步骤（`config/plugins/<id>/` → `Ctrl+R` → 右侧「插件」面板）。',
  '没有对应 API 就直接说做不到并给替代方案，不要编造接口。'
].join('\n')

const ROLE_BRIEF = {
  commander: {
    meaning: '对目标与最终交付负总责。',
    duties: [
      '判断是否需要拆解，派给最合适的成员，写清交付物与验收标准。',
      '收束各线结果，对用户给出最终答复。'
    ],
    bounds: ['不替用户做不可逆决定；不把未完成说成已完成，不编造下属产出。']
  },
  deputy: {
    meaning: '把上级目标落成本线可执行的任务。',
    duties: [
      '承接派单，拆成具体任务交给直接下属。',
      '核对质量、合并重复、指出风险后再向上交付。'
    ],
    bounds: ['只给直接下属派单，不跨线调度，不越过上级直接对用户交付。']
  },
  executor: {
    meaning: '只对派到手上的这一件事负责。',
    duties: [
      '直接产出可用结果，不复述任务、不写开场白。',
      '信息不足时用 ask_user_question 确认；无工具则写明缺什么并给出能给的部分。'
    ],
    bounds: ['不派单、不收束、不代表团队表态；不越权使用未授予的能力。']
  }
}

/* 没填 duty、也没有头衔后缀与技能时的兜底领域 */
const ROLE_DOMAIN = {
  commander: '统筹与最终决策',
  deputy: '分线管理与结果把控',
  executor: '具体执行'
}

/* 负责领域：优先用成员自己填的 duty，否则由「职位后缀 + 技能名」推导 */
function domainOf (agent) {
  if (agent && typeof agent.duty === 'string' && agent.duty.trim()) return agent.duty.trim()
  const title = String((agent && agent.title) || '')
  const titlePart = title.includes('·') ? title.split('·').slice(1).join('·').trim() : ''
  const skillNames = ((agent && agent.skills) || [])
    .map((id) => (skillById(id) || {}).name)
    .filter(Boolean)
  const parts = [...new Set([titlePart, ...skillNames].filter(Boolean))]
  return parts.length ? parts.join('、') : (ROLE_DOMAIN[(agent && agent.role) || 'executor'] || '未指定')
}

/* 提示词变量：成员模板与成员编辑里都可以写 {{name}} 这类占位符，
   发送时按当前编制实时解析，改名/换职位不需要再改提示词。 */
export const PROMPT_VARS = [
  { key: 'name', desc: '成员名字' },
  { key: 'short', desc: '简称' },
  { key: 'title', desc: '头衔 / 职位' },
  { key: 'role', desc: '职级（总指挥 / 副指挥 / 执行者）' },
  { key: 'duty', desc: '职责范围' },
  { key: 'bio', desc: '简介' },
  { key: 'project', desc: '当前项目名' },
  { key: 'team', desc: '团队规模' }
]

export function resolvePromptVars (text, agent = {}) {
  const raw = String(text || '')
  if (!raw.includes('{{')) return raw
  const project = activeProject()
  const enabled = (state.roster.agents || []).filter((a) => a.enabled !== false)
  const duty = agent.duty && String(agent.duty).trim() ? String(agent.duty).trim() : domainOf(agent)
  /* 职位变量只在团队会话里成立：单独会话没有职级，
     写成「AI 助手」而不是留空，避免「你是「爻」，。」这种断句。 */
  const teamMode = conversationIsTeam()
  const map = {
    name: agent.name || '',
    short: agent.short || agent.name || '',
    title: teamMode ? (agent.title || ROLE_LABEL[agent.role] || '') : 'AI 助手',
    role: teamMode ? (ROLE_LABEL[agent.role] || '') : '',
    duty,
    bio: agent.bio || '',
    project: project ? project.name : '',
    team: enabled.length ? `${enabled.length} 位成员` : ''
  }
  return raw.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (all, key) => (key in map ? map[key] : all))
}

function positionBlock (agent) {
  const role = agent.role || 'executor'
  const brief = ROLE_BRIEF[role] || ROLE_BRIEF.executor
  const roleLabel = ROLE_LABEL[role] || '成员'
  const title = agent.title || roleLabel
  const titleText = title === roleLabel ? roleLabel : `${title}（${roleLabel}）`
  const boss = agent.reportsTo
    ? state.roster.agents.find((a) => a.id === agent.reportsTo) || null
    : null
  const subs = subordinatesOf(agent)

  const lines = [
    '## 你的职位与边界',
    `职位：${titleText}`,
    `名字：${agent.name}${agent.short ? `（简称「${agent.short}」）` : ''}。只用这个名字自称，不要用模型名或泛称。`,
    `含义：${brief.meaning}`,
    `负责领域：${domainOf(agent)}`,
    `汇报对象：${boss ? `「${boss.name}」` : '用户'}`,
    `直接下属：${subs.length ? subs.map((s) => `「${s.name}」`).join('、') : '无（你不派单）'}`,
    '',
    '职责：',
    ...brief.duties.map((d) => `- ${d}`),
    '',
    '权限边界：',
    ...brief.bounds.map((b) => `- ${b}`)
  ]

  if (subs.length) {
    lines.push(`- 你只能给以下成员派单：${subs.map((s) => s.name).join('、')}；其他人不在你的管辖范围内。`)
  }
  return lines.join('\n')
}

/* 团队全貌：所有成员都拿到同一份名单，知道彼此的存在、领域与汇报关系。
   只描述组织结构，不含任何用户侧对话内容，因此两条通道都安全。 */
function teamBlock (agent) {
  const all = state.roster.agents || []
  if (!all.length) return ''
  const enabled = all.filter((a) => a.enabled !== false)
  const lines = [`## 团队编制（共 ${all.length} 位成员，启用 ${enabled.length} 位）`]

  for (const member of all) {
    const self = member.id === agent.id ? '（你）' : ''
    const status = member.enabled === false ? ' · 未启用' : ''
    const boss = member.reportsTo
      ? all.find((a) => a.id === member.reportsTo)
      : null
    const report = boss ? `向「${boss.name}」汇报` : '直接向用户负责'
    const roleLabel = ROLE_LABEL[member.role] || '成员'
    const title = member.title || roleLabel
    lines.push(
      `- ${member.name}${self} · ${title === roleLabel ? title : `${title}（${roleLabel}）`}｜负责：${domainOf(member)}｜${report}${status}`
    )
  }

  lines.push('不要假设名单外成员，不要冒充他人；协作按汇报线走。')
  return lines.join('\n')
}

/* 内置默认规范：所有成员、两条通道都会带上。
   只写行为底线，不写身份与分工；身份提示词由成员自己的 prompt 叠加。
   保持简短，避免每次请求都浪费上下文。 */
export const CORE_PROMPT = [
  '## 默认规范',
  '1. 先给结论，再给必要依据；不奉承、不写套话、不复述用户。',
  '2. 只讲有依据的内容；不确定就说不确定，不编造事实、引用、文件内容或执行结果。',
  '3. 信息不足先问清楚；必须假设时明确标出，不替用户补前提。',
  '4. 保留原意，不擅自扩大范围；区分事实、推断和建议。',
  '5. 没做到、做错或不确定是否做到，直接说明，不粉饰。',
  '6. 涉及代码或接口时先读源码或反编译产物确认；结论给路径或行号。',
  '7. 结构化内容用表格；代码用带语言标记的代码块；示意图用 mermaid。'
].join('\n')

const THINK_MODE = (value) => (value < 34 ? '快速' : value > 66 ? '深度' : '均衡')

const THINK_HINT = {
  快速: '直接给结论，最多三条要点，不展开推演。',
  均衡: '先给结论，再用必要证据支撑；不写成报告。',
  深度: '列假设、边界与反例，讲透风险，标明不确定处。'
}

/* 档位由模型自己决定：这里给的是「模型真实支持的几档」，不是 0-100 的连续区间 */
export const DEPTH_TIERS = [
  { value: 0, label: '快速', param: 'none' },
  { value: 50, label: '均衡', param: 'none' },
  { value: 100, label: '深度', param: 'none' }
]

/* 档位来源：api = /models 里显式声明过 supported_efforts；guess = 只能按模型名推断 */
export function reasoningProfile (provider, model) {
  const declared = declaredReasoning(provider, model)
  if (declared) {
    return {
      mode: 'effort',
      style: declared.style || 'object',
      label: 'reasoning.effort',
      source: 'api',
      mandatory: Boolean(declared.mandatory),
      tiers: (declared.tiers || []).map((t) => ({ value: t.value, label: t.label, param: t.param }))
    }
  }

  const id = String(model || '').toLowerCase()
  const kind = (provider && provider.kind) || 'openai'

  if (kind === 'anthropic') {
    return {
      mode: 'budget',
      source: 'guess',
      label: 'thinking.budget_tokens',
      tiers: [
        { value: 34, label: '1K', param: 1024 },
        { value: 56, label: '2K', param: 2048 },
        { value: 78, label: '4K', param: 4096 },
        { value: 100, label: '8K', param: 8192 }
      ]
    }
  }

  if (kind === 'ollama') {
    return { mode: 'none', source: 'guess', label: '本地模型不暴露档位', tiers: DEPTH_TIERS }
  }

  /* GPT-5 系比 o 系多一档 minimal */
  if (/^(gpt-5|gpt-6)/.test(id)) {
    return {
      mode: 'effort',
      style: 'top',
      source: 'guess',
      label: 'reasoning_effort',
      tiers: [
        { value: 0, label: '关', param: 'none' },
        { value: 34, label: '最小', param: 'minimal' },
        { value: 67, label: '中', param: 'medium' },
        { value: 100, label: '高', param: 'high' }
      ]
    }
  }

  if (/^o[1-4]|reasoning/.test(id)) {
    return {
      mode: 'effort',
      style: 'top',
      source: 'guess',
      label: 'reasoning_effort',
      tiers: [
        { value: 0, label: '关', param: 'none' },
        { value: 40, label: '低', param: 'low' },
        { value: 70, label: '中', param: 'medium' },
        { value: 100, label: '高', param: 'high' }
      ]
    }
  }

  return { mode: 'none', source: 'guess', label: '服务端未声明思考档位', tiers: DEPTH_TIERS }
}

/* 只认 /models 里显式带回来的声明，没有就返回 null 让上层回落启发式 */
function declaredReasoning (provider, model) {
  if (!provider || !model || !provider.reasoning) return null
  const table = provider.reasoning
  const exact = table[model]
  if (exact && Array.isArray(exact.tiers) && exact.tiers.length) return exact

  /* 某些网关会把模型 id 写成带前缀的形式，做一次后缀匹配 */
  for (const key of Object.keys(table)) {
    if (key === model) continue
    if (key.endsWith(`/${model}`) || model.endsWith(`/${key}`)) {
      const hit = table[key]
      if (hit && Array.isArray(hit.tiers) && hit.tiers.length) return hit
    }
  }
  return null
}

/* 把任意数值吸附到最接近的真实档位 */
export function tierFor (profile, value) {
  const tiers = (profile && profile.tiers && profile.tiers.length) ? profile.tiers : DEPTH_TIERS
  const v = Number(value ?? 50)
  let best = tiers[0]
  for (const tier of tiers) {
    if (Math.abs(tier.value - v) < Math.abs(best.value - v)) best = tier
  }
  return best
}

/* 重试配置：读设置页的值，缺省沿用主进程的默认档 */
export function retryConfig () {
  const src = (state.settings && state.settings.retry) || {}
  return {
    enabled: src.enabled !== false,
    maxAttempts: src.maxAttempts,
    timeoutSec: src.timeoutSec,
    baseDelayMs: src.baseDelayMs,
    maxDelayMs: src.maxDelayMs
  }
}

export function providerSupportsTools (provider) {
  const kind = provider && provider.kind ? provider.kind : 'openai'
  /* 三家都走原生 function/tool 协议；主进程负责各家的请求/回传格式转换。 */
  return kind === 'openai' || kind === 'anthropic' || kind === 'ollama'
}

export function callModel (agent, messages, opts = {}) {
  const provider = providerById(agent.providerId)
  if (!provider) return Promise.reject(new Error(`未找到供应商「${agent.providerId}」，请在设置中检查`))
  const model = agent.model || (provider.models && provider.models[0])
  if (!model) return Promise.reject(new Error(`供应商「${provider.name}」尚未配置模型`))
  if (provider.kind !== 'ollama' && provider.hasKey === false) {
    return Promise.reject(new Error(`「${provider.name}」还没有保存 API Key，请到设置 → 模型供应商填写`))
  }

  const id = `req_${++seq}`
  const onDelta = opts.onDelta || (() => {})
  const onToolCalls = opts.onToolCalls || (() => {})
  const profile = reasoningProfile(provider, model)
  const tier = tierFor(profile, state.settings.thinking)
  let reasoning = null
  if (profile.mode === 'effort' && tier.param && tier.param !== 'none') {
    reasoning = { mode: 'effort', value: tier.param, style: profile.style || 'top' }
  } else if (profile.mode === 'budget') {
    reasoning = { mode: 'budget', value: tier.param }
  }

  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve,
      reject,
      onDelta,
      onToolCalls,
      onUsage: opts.onUsage,
      onRetry: opts.onRetry,
      onWarning: opts.onWarning
    })
    window.astral.startLLM({
      id,
      provider: {
        id: provider.id,
        kind: provider.kind,
        baseUrl: provider.baseUrl
      },
      model,
      messages,
      temperature: typeof agent.temperature === 'number' ? agent.temperature : 0.7,
      maxTokens: opts.maxTokens,
      /* 通道随请求一起下发，便于将来按会话线分流模型与配额 */
      channel: opts.channel === 'agent' ? 'agent' : 'user',
      /* 断线重试：次数、空闲超时与退避由设置页决定 */
      retry: retryConfig(),
      /* 三家协议都支持工具；具体转换由主进程 buildRequest 负责 */
      tools: providerSupportsTools(provider) ? (Array.isArray(opts.tools) && opts.tools.length ? opts.tools : undefined) : undefined,
      reasoning
    }).catch((err) => {
      pending.delete(id)
      reject(err)
    })
  })
}

export async function testProvider (provider, model) {
  return window.astral.testLLM({
    provider: {
      id: provider.id,
      kind: provider.kind,
      baseUrl: provider.baseUrl
    },
    model
  })
}

/* 用户取消时立刻断掉所有正在流式的模型请求。
   主进程的 AbortController 负责停止网络读；这里同时把 Promise 收口，
   避免编排层因为等待事件而卡住。 */
export async function cancelAllModels () {
  const ids = [...pending.keys()]
  for (const id of ids) {
    const entry = pending.get(id)
    if (!entry) continue
    try { await window.astral.stopLLM({ id }) } catch { /* ignore */ }
    pending.delete(id)
    try { entry.reject(new Error('用户已取消本轮')) } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------- prompt 装配 */

function skillBlock (ids) {
  const list = (ids || []).map(skillById).filter(Boolean)
  if (!list.length) return ''
  return list.map((s) => `### ${s.name}\n${s.body}`).join('\n\n')
}

function roleProtocol (agent) {
  const role = agent.role || 'executor'
  if (role === 'executor') {
    return [
      '你是本编制中的**执行者**，不接受下属也不派单。',
      '直接产出结果正文，不复述任务、不写开场白；信息不足时用 ask_user_question 确认，无工具则写明缺什么并给出能给的部分。'
    ].join('\n')
  }
  const subs = subordinatesOf(agent)
  const lines = []
  lines.push(`你是本编制中的**${ROLE_LABEL[role]}**。`)

  if (subs.length) {
    lines.push('')
    lines.push('你直接领导：')
    for (const sub of subs) {
      const skills = (sub.skills || []).map((id) => (skillById(id) || {}).name).filter(Boolean).join('、')
      lines.push(`- ${sub.name}（id: \`${sub.id}\`）${sub.title || ROLE_LABEL[sub.role]}${skills ? '，擅长 ' + skills : ''}`)
    }
    lines.push('')
    lines.push('需要把工作分派出去时，**只输出一个** astral:plan 块，不要附带其他文字：')
    lines.push('')
    lines.push('<astral:plan>')
    lines.push('{"brief":"一句话说明你的判断","tasks":[{"to":"上面列出的某个 id","task":"给对方的完整指令：目标、输入、交付标准、约束"}]}')
    lines.push('</astral:plan>')
    lines.push('')
    lines.push('硬性规则：')
    lines.push(`- \`to\` 必须是上面列出的 id；一次最多派 ${Math.max(1, subs.length)} 个，能合并就别拆。`)
    lines.push('- 不派单或已收齐交付时直接输出正文，同一条回复不要既派单又给答案。')
  } else {
    lines.push('你暂时没有下属，因此不要派单，直接自己产出结果。')
  }

  return lines.join('\n')
}

/* 单独会话的协议：这条线上只有用户和它，没有组织关系可讲。
   职位、汇报、派单都不适用，避免模型把团队话术带进单聊。 */
const SOLO_ROLE_PROTOCOL = [
  '你只和用户直接对话：不派单、不输出 astral:plan、不扮演上级或下属，也不要说「我去安排」「已交给某位成员」。',
  '直接产出结果正文，不复述任务、不写开场白；信息不足时直接问清楚，或写明缺什么并给出能给的部分。'
].join('\n')

/* 单独会话的默认提示词（成员没填 soloPrompt 时用它）。
   只管「一个人怎么和用户说话」，不含任何编制、派单、汇报内容。 */
export const SOLO_DEFAULT_PROMPT = [
  '你是一个可靠的 AI 助手，直接与用户对话。',
  '- 直接回答，先给结论再给必要依据；不复述问题、不写开场白。',
  '- 有工具就真调用；没有就说清楚缺什么，并给出能给的部分。',
  '- 不确定就说不确定，不编造事实、引用或执行结果。'
].join('\n')

/* 上下文分层：每一层都可以在「面板 → 上下文」里单独关掉。
   core / permissions / tools / output 是固定层，不提供开关：
   它们要么是诚实性与安全底座，要么必须和真实授权保持一致——
   在提示词里「关掉」权限说明，并不会收回实际能力，只会让模型误判。 */
export const CONTEXT_LAYERS = [
  { key: 'persona', label: '角色设定', hint: '成员的角色提示词或单独对话提示词' },
  { key: 'identity', label: '身份与职位', hint: '名字、职位、汇报线与团队全貌' },
  { key: 'project', label: '当前项目', hint: '项目名与文件范围' },
  { key: 'profile', label: '用户画像', hint: '称呼、简称与长期偏好' },
  { key: 'hard', label: '硬性上下文', hint: '记忆库常驻四块，只用于超级智能体窗口' },
  { key: 'bio', label: '简介与说话风格', hint: '成员简介、性格与口吻' },
  { key: 'skills', label: '技能规范', hint: '通用技能与成员专属技能' },
  { key: 'notes', label: '项目 / 专属上下文', hint: '项目共享前提与该成员的专属笔记' },
  { key: 'protocol', label: '协作协议', hint: '汇报、交付与边界规则' },
  { key: 'data', label: '数据文件清单', hint: '本轮可用的数据文件与字段' },
  { key: 'thinking', label: '思考强度', hint: '本轮思考档位与展开程度' }
]

export const FIXED_CONTEXT_LAYERS = [
  { key: 'core', label: '系统底座', hint: '诚实、依据与格式规范；不可关闭' },
  { key: 'permissions', label: '权限与工具', hint: '必须与真实授权一致；请在「设置 → 权限与数据」调整' },
  { key: 'output', label: '输出要求', hint: '语言与文风底线；不可关闭' }
]

export function contextLayerOn (key) {
  if (FIXED_CONTEXT_LAYERS.some((layer) => layer.key === key)) return true
  const box = (state.settings && state.settings.context && state.settings.context.layers) || {}
  return box[key] !== false
}

/* 分层装配。返回完整段落，由 buildSystemPrompt 按策略过滤；
   控制台与上下文面板也读同一份，避免「界面显示一套、实际注入另一套」。 */
export function promptSections (agent, opts = {}) {
  const channel = opts.channel === 'agent' ? 'agent' : 'user'
  const role = agent.role || 'executor'
  const boss = agent.reportsTo ? (state.roster.agents.find((a) => a.id === agent.reportsTo) || null) : null
  const hasCommander = state.roster.agents.some((a) => a.role === 'commander' && a.enabled !== false)
  const project = activeProject()
  const teamMode = conversationIsTeam()
  const sections = []

  const push = (key, label, text, fixed = false) => {
    if (!text) return
    sections.push({ key, label, text, fixed })
  }

  push('core', '系统底座', CORE_PROMPT, true)

  /* 两套提示词严格分开，互不回退：
     团队会话读角色提示词（agent.prompt），单独会话读单独对话提示词（agent.soloPrompt）。
     单独会话即使角色提示词写了满篇「你是副指挥、你手下有执行者」，也一个字都不会带进来。 */
  const persona = teamMode
    ? (agent.prompt || '你是一个可靠的协作助手。')
    : (agent.soloPrompt || SOLO_DEFAULT_PROMPT)
  push('persona', '角色设定', [
    resolvePromptVars(persona, agent),
    state.conversationMode === 'plugin' ? PLUGIN_MODE_PROMPT : ''
  ].filter(Boolean).join('\n\n'))

  if (teamMode) {
    const roleLine = boss
      ? `你向「${boss.name}」汇报。`
      : role === 'commander'
        ? '你是本项目的总指挥，直接向用户负责。'
        : hasCommander
          ? '你在本项目中直接向用户负责。'
          : '你在本项目中独立向用户负责。'
    const team = teamBlock(agent)
    push('identity', '身份与职位', [
      `## 身份\n你是「${agent.name}」，${agent.title || ROLE_LABEL[role]}。${roleLine}`,
      /* 职位定义与团队全貌：所有成员共享同一份组织信息，
         确保彼此知道对方是谁、负责什么、向谁汇报。 */
      positionBlock(agent),
      team
    ].filter(Boolean).join('\n\n'))
  } else {
    /* 单独会话没有编制：不写职位、汇报线、下属与成员名单。
       这里也不引用角色提示词——那份只在团队会话里生效。 */
    push('identity', '身份与职位', [
      '## 身份',
      `你是「${agent.name}」，用户直接对话的 AI 助手。`,
      '这条会话里没有编制、职位、上级或下属：不要用「总指挥 / 副指挥 / 执行者」自称，也不要假装把任务交给了谁。'
    ].join('\n'))
  }

  if (project) {
    push('project', '当前项目', [
      '## 当前项目',
      `项目：${project.name}`,
      project.rootPath
        ? `项目文件范围：${project.rootPath}。只能使用该目录范围内的文件；不要引用或假设范围外的文件内容。`
        : '项目文件范围：未限定。'
    ].join('\n'))
  }

  /* 隔离红线：用户画像属于「用户 ↔ AI」那条线的内容，
     参与 AI↔AI 会话的成员拿不到，也不需要知道。 */
  if (channel === 'user') {
    const profile = state.settings.profile || {}
    if (profile.name || profile.likes) {
      const lines = ['## 用户画像']
      if (profile.name) {
        lines.push(`- 用户称呼：${profile.name}${profile.short ? `（也可以叫他「${profile.short}」）` : ''}`)
      }
      if (profile.likes && profile.likes.trim()) {
        lines.push(`- 偏好与背景：${profile.likes.trim()}`)
      }
      lines.push('照顾这些偏好，不要复述、不要点出「根据你的偏好」。')
      push('profile', '用户画像', lines.join('\n'))
    }
  } else {
    push('boundary', '会话边界', '## 会话边界\n你在「AI ↔ AI」协作区，只处理上级派单。你看不到用户与 AI 的对话、历史与附件，不要假设或编造；缺什么直接在结果里写明。', true)
  }

  /* 硬性上下文只进超级智能体窗口：它里面写的是「你是超级智能体」，
     塞给编制里的指挥或执行者会直接造成身份冲突。 */
  if (opts.hard === true) {
    const hard = opts.hardContext || (state.hardContext && state.hardContext.text) || ''
    if (hard.trim()) push('hard', '硬性上下文', hard.trim())
  }

  const bio = []
  if (agent.bio && agent.bio.trim()) bio.push(`## 你的简介\n${agent.bio.trim()}`)
  if ((agent.traits && agent.traits.length) || (agent.traitNote && agent.traitNote.trim())) {
    const bits = []
    if (agent.traits && agent.traits.length) bits.push(`性格：${agent.traits.join('、')}。`)
    if (agent.traitNote && agent.traitNote.trim()) bits.push(agent.traitNote.trim())
    bits.push('这些只影响说话方式，不要念出来。')
    bio.push(`## 说话风格\n${bits.join('\n')}`)
  }
  push('bio', '简介与说话风格', bio.join('\n\n'))

  const globalSkills = skillBlock(state.roster.globalSkills)
  const own = skillBlock(agent.skills)
  push('skills', '技能规范', [
    globalSkills ? `## 通用技能规范（全体适用）\n${globalSkills}` : '',
    own ? `## 你的专属技能\n${own}` : ''
  ].filter(Boolean).join('\n\n'))

  const notes = agent.context && agent.context.notes
  push('notes', '项目 / 专属上下文', [
    state.roster.globalNotes && state.roster.globalNotes.trim()
      ? `## 项目上下文\n${state.roster.globalNotes.trim()}`
      : '',
    notes && notes.trim() ? `## 你的专属上下文\n${notes.trim()}` : ''
  ].filter(Boolean).join('\n\n'))

  push('protocol', '协作协议', `## 协作协议\n${teamMode ? roleProtocol(agent) : SOLO_ROLE_PROTOCOL}`)

  /* 权限按「全局 ∩ 成员（或默认）」生效，完全授权时全部放行 */
  const perms = effectivePerms(agent)
  const granted = grantedLabels(perms)
  push('permissions', '权限与工具', [
    '## 可用能力',
    granted.length
      ? `用户已授予：${granted.join('、')}。`
      : '用户未授予任何外部能力：你不能读写文件、执行命令或联网。不要声称自己做过这些事。',
    isFullAuth(perms) ? '完全授权下你可以使用全部能力，但仍不得声称做过实际未做的事。' : ''
  ].filter(Boolean).join('\n'), true)

  /* 数据文件属于用户侧内容，只在 user 通道出现；AI↔AI 需要就由上级写进派单 */
  const dataBlock = dataFileManifest(agent)
  if (dataBlock && channel === 'user') push('data', '数据文件清单', dataBlock)

  /* 工具清单：让成员明确知道自己有哪些工具、叫什么名字、能做什么。
     真正的调用通过函数调用（tool call）完成，这里只负责「告知」。
     没有权限、没有工具，或供应商协议不支持工具时不写这一段，避免暗示不存在的能力。 */
  const toolProvider = providerById(agent.providerId)
  const toolSchemas = toolProvider && providerSupportsTools(toolProvider) ? toolSchemasFor(agent) : []
  if (toolSchemas.length) {
    push('tools', '工具清单', [
      '## 可用工具',
      `当前有 ${toolSchemas.length} 个工具。要执行操作就直接发起 tool call，不要用文字假装调用，也不要编造结果。`,
      '缺少会改变方案的关键信息、需求有歧义或需用户在互斥方案中做选择时，调用 ask_user_question 一次问一个主题；信息已明确时不要问，工具不可用时才写进正文。用户说「测试提问工具」时立即真实调用。',
      ...(toolSchemas.some((t) => t.function.name === 'memory_recall')
        ? ['回忆过去的项目、做过的决定、踩过的坑之前，先用 memory_recall 查一次：默认只返回权重、最近触发时间与权重近/远邻居，不拉正文，需要细节才传 mode=full。不要改去用 memory_context 取全量回忆文件，也不要凭印象编。']
        : []),
      ...(toolSchemas.some((t) => t.function.name === 'memory_time')
        ? [
          '问到「现在该做什么 / 我这个点通常干嘛 / 这周做了什么」时，先用 memory_time 取真实记录；它的权重按「周几 + 小时」的跨周重复计算，跨周样本不足就直说，不要拿一次爆发当规律、也不要替用户编作息。',
          '问到「项目现在该做什么 / 这个阶段常收到什么指令 / 走到什么时候开始需要这类工作」时，用 memory_time 的 action=phase：阶段由用户自己的事件进程决定，概率会随近期变化漂移；样本不足就直说，不要按通用开发流程替他推断。'
        ]
        : []),
      ...(toolSchemas.some((t) => t.function.name === 'memory_observe')
        ? ['用户说出打算或偏好（想吃什么、待会要做什么、喜欢什么）时，用 memory_observe 记一条近期观察：只记录、不立刻替他执行；到合适的时间点由时间网生成具体询问。聊天记录等敏感内容必须由用户明确给出，不要自己去翻文件。']
        : []),
      '',
      ...toolSchemas.slice(0, 24).map((t) => `- ${t.function.name}：${t.function.description}`)
    ].join('\n'), true)
  }

  const think = Number(state.settings.thinking ?? 50)
  const mode = THINK_MODE(think)
  push('thinking', '思考强度', `## 本轮思考强度：${mode}\n${THINK_HINT[mode]}`)

  push('output', '输出要求', '## 输出要求\n用简体中文回复。不要输出角色扮演式的旁白，不要用「好的，我来……」开头。', true)

  return sections
}

export function buildSystemPrompt (agent, opts = {}) {
  return promptSections(agent, opts)
    .filter((section) => section.fixed || contextLayerOn(section.key))
    .map((section) => section.text)
    .join('\n\n')
}

export function buildMessages (agent, userContent, history = [], opts = {}) {
  const messages = [{ role: 'system', content: buildSystemPrompt(agent, opts) }]
  for (const item of history) messages.push(item)
  messages.push({ role: 'user', content: userContent })
  return messages
}

/* ------------------------------------------------------- plan 解析 */

export function parsePlan (text) {
  const match = /<astral:plan>([\s\S]*?)<\/astral:plan>/i.exec(text || '')
  if (!match) return null
  let raw = match[1].trim()
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try {
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.tasks) || !data.tasks.length) return null
    const tasks = data.tasks
      .filter((t) => t && t.to && t.task)
      .map((t) => ({ to: String(t.to).trim(), task: String(t.task).trim() }))
    if (!tasks.length) return null
    return { brief: data.brief ? String(data.brief) : '', tasks }
  } catch {
    return null
  }
}

export function stripPlan (text) {
  return String(text || '').replace(/<astral:plan>[\s\S]*?<\/astral:plan>/gi, '').trim()
}
