/* orchestrator.js — 编制调度：派单、执行、逐层汇总 */

import { state, bus, uid, agentById, commander, subordinatesOf, persist, toast, messagesOf, estimateTextTokens, providerById, makeMessageSummary, channelOf, conversationTitleFromMessage } from './core.js'
import { callModel, buildMessages, parsePlan, stripPlan, ROLE_LABEL, reasoningProfile, tierFor } from './llm.js'
import { runHook } from './plugins.js'
import { toolSchemasFor, refreshMcp, runToolCall, describeCall } from './mcp.js'
import { toolFingerprint, watchToolLoop } from './triggers-core.js'
import { compactTranscript, compactToolResult, contextTokenBudget, contextHistoryLimit } from './context.js'
import { beginRun, finishRun, recordRun, runCancelled, requestCancel } from './runs.js'
import { currentWorkMode } from './projects.js'
import { generateTeam, defaultPlanner, applyTeamToProject } from './team-runtime.js'
import { isGuest } from './roles.js'

/* 标准会话下的自述：默认独立完成。只有用户明确要求多人协作时才申请扩展，
   避免普通问答被模型自行升级成团队编排。扩展标记由编排层消费，不会出现在回复里。 */
const SOLO_PROMPT = [
  '## 标准会话',
  '本轮只有你一名智能体，默认独立完成，不要派单或输出 <astral:plan>。',
  '只有用户明确要求组建团队 / 多人协作时，才在末尾输出：',
  '<astral:expand>{"reason":"一句话说明为什么"}</astral:expand>',
  '除此之外不要输出任何 XML。'
].join('\n')

let turnSeq = 0
let callBudget = 0

function resetUsage () {
  state.usage = {
    input: 0,
    output: 0,
    total: 0,
    cost: 0,
    currency: '',
    priced: false,
    calls: 0,
    reported: false
  }
  bus.emit('usage:changed', state.usage)
}

function addUsage (agent, usage) {
  if (!state.usage) resetUsage()
  const current = state.usage
  if (usage) {
    const input = Math.max(0, Number(usage.input) || 0)
    const output = Math.max(0, Number(usage.output) || 0)
    current.input += input
    current.output += output
    current.total += Math.max(input + output, Number(usage.total) || 0)
    current.reported = current.reported || usage.reported !== false
    const provider = agent ? providerById(agent.providerId) : null
    const pricing = provider && provider.pricing
    const inputPrice = pricing ? Number(pricing.inputPerMillion) : NaN
    const outputPrice = pricing ? Number(pricing.outputPerMillion) : NaN
    if (Number.isFinite(inputPrice) && Number.isFinite(outputPrice)) {
      current.cost += (input / 1000000) * inputPrice + (output / 1000000) * outputPrice
      current.priced = true
      const currency = String(pricing.currency || 'USD').toUpperCase()
      if (!current.currency) current.currency = currency
      else if (current.currency !== currency) current.currency = 'MIXED'
    }
  }
  bus.emit('usage:changed', current)
}

function usageSnapshot () {
  return state.usage ? { ...state.usage } : null
}

/* 单条回复的用量采集：
   - 供应商上报的 usage 按「每次调用」累加；工具多轮时每轮都会重新计费。
   - 没有上报时，用字符数估个大概（CJK 1 字≈1 token，其他 4 字符≈1 token）。
   - 传输速率只算正文增量的 UTF-8 字节，并扣掉等待首字与工具往返的空白时间。 */
function estimatePromptTokens (messages) {
  let total = 0
  for (const message of messages || []) {
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content || '')
    total += 4 + estimateTextTokens(content)
    if (message.tool_calls) total += estimateTextTokens(JSON.stringify(message.tool_calls))
  }
  return total
}

function thinkingSnapshot (agent) {
  try {
    const provider = providerById(agent.providerId)
    const profile = reasoningProfile(provider, agent.model)
    const tier = tierFor(profile, state.settings.thinking)
    return {
      /* 档位文字与输入框下方的滑杆保持一致：模型没有推理参数时也照样有协作深度档 */
      label: tier.label,
      mode: profile.mode || 'none',
      param: tier.param === undefined ? null : tier.param,
      source: profile.source || 'guess',
      slider: Number(state.settings.thinking ?? 50)
    }
  } catch {
    return null
  }
}

let currentThread = 'commander'

function addMessage (patch) {
  const msg = {
    id: patch.id || uid('msg'),
    ts: Date.now(),
    thread: patch.thread || currentThread,
    /* 通道决定这条消息属于哪条会话线，落盘与上下文组装都按它走 */
    channel: patch.channel === 'agent' ? 'agent' : 'user',
    text: '',
    streaming: false,
    error: false,
    ...patch
  }
  state.messages.push(msg)
  if (!String(msg.summary || '').trim()) {
    msg.summary = makeMessageSummary(msg)
    msg.summarySource = 'first-line'
  }
  bus.emit('message:add', msg)
  return msg
}

function snapshotFiles (files) {
  return (files || []).filter(Boolean).map((file) => ({
    name: file.name || '未命名文件',
    path: file.path || '',
    size: Number(file.size) || 0,
    /* 保留正文用于重新生成与预览；二进制文件 text 为 null */
    text: typeof file.text === 'string' ? file.text : null,
    tokens: typeof file.text === 'string'
      ? estimateTextTokens(file.text)
      : Math.max(0, Math.ceil((Number(file.size) || 0) / 4))
  }))
}

function snapshot (agent) {
  return {
    agentId: agent.id,
    name: agent.name,
    short: agent.short || '',
    title: agent.title || ROLE_LABEL[agent.role] || '',
    glyph: agent.glyph || '◇',
    color: agent.color || 'var(--accent)'
    /* 头像不写进消息：渲染时按 agentId 回查编制，换头像后历史记录自动跟着变 */
  }
}

/* 革新的交接摘要：它只属于当前智能体的这条会话，作为「上一段会话」的
   背景注入，不伪装成用户发言，也不占用历史窗口的条数。 */
function handoffBlock (channel) {
  if (channel !== 'user') return ''
  const handoff = state.messages.find((m) => m.kind === 'handoff' &&
    channelOf(m) === 'user' && (m.thread || 'commander') === currentThread)
  const text = String((handoff && handoff.text) || '').trim()
  if (!text) return ''
  return `## 上一段会话的交接摘要\n${text}`
}

/* 上下文组装的唯一入口：agent 通道不给 thread 限制（内部协作跨成员互通），
   user 通道必须同 thread；两个通道的消息永远不会出现在彼此的结果里。 */
function transcriptBlock (excludeId, limit = 8, channel = 'user') {
  const recent = messagesOf(channel)
    .filter((m) => m.id !== excludeId &&
      !m.ctxReleased &&
      (channel !== 'user' || (m.thread || 'commander') === currentThread) &&
      m.kind !== 'system' && m.kind !== 'plan' && m.kind !== 'handoff' && m.text && m.text.trim())
    .map((m) => ({
      who: m.kind === 'user' ? '用户' : (m.name || 'Agent'),
      text: m.text
    }))
  const handoff = handoffBlock(channel)
  if (!recent.length) return handoff
  const budget = contextTokenBudget(state.settings)
  const history = compactTranscript(recent, {
    budgetTokens: budget,
    /* 不设上限时连历史条数一起放开，否则老消息还是会被压成摘要 */
    maxRecent: budget === Number.POSITIVE_INFINITY
      ? recent.length
      : Math.max(limit, contextHistoryLimit(state.settings)),
    channel
  })
  return [handoff, history].filter(Boolean).join('\n\n')
}

function attachmentBlock (files) {
  const usable = (files || []).filter((f) => f && typeof f.text === 'string' && f.text.trim())
  if (!usable.length) return ''
  const blocks = usable.map((f) => `### ${f.name}\n\`\`\`\n${f.text.slice(0, 8000)}\n\`\`\``)
  return `【附件】共 ${usable.length} 个，全文如下\n${blocks.join('\n\n')}`
}

function resolveTarget (text) {
  const match = /^@([^\s，,：:]+)/.exec(text)
  if (match) {
    const name = match[1]
    const hit = state.roster.agents.find((a) => a.name === name || a.id === name)
    if (hit) return { agent: hit, text: text.replace(/^@[^\s，,：:]+\s*/, '') }
  }
  const active = state.activeAgentId ? agentById(state.activeAgentId) : null
  const project = (state.projects || []).find((p) => p.id === state.activeProjectId)
  const solo = project && currentWorkMode() === 'solo' && project.soloAgentId
    ? agentById(project.soloAgentId)
    : null
  return { agent: active || solo || commander(), text }
}

function canTask (supervisor, target) {  if (!target) return false
  if (supervisor.role === 'commander') return target.id !== supervisor.id
  return target.reportsTo === supervisor.id
}

/* ------------------------------------------------------- 单个 Agent 回合 */

async function runAgent (agent, instruction, ctx = {}) {
  if (runCancelled()) return { ok: false, cancelled: true, error: '用户已取消本轮', text: '', raw: '' }
  const depth = ctx.depth || 0
  const override = ctx.primary && state.settings.chatModel ? state.settings.chatModel : null
  const effective = override
    ? { ...agent, providerId: override.providerId, model: override.model }
    : agent

  const channel = ctx.channel === 'agent' ? 'agent' : 'user'
  recordRun('agent_start', { agentId: agent.id, agentName: agent.name, depth, channel })

  /* 工具目录是 boot 时异步加载的。这里再确保一次，
     避免启动后立刻发指令时提示词里有权限、但工具列表还没就绪。 */
  try { await refreshMcp() } catch { /* 工具不可用时按空列表继续 */ }

  const msg = addMessage({
    kind: 'agent',
    channel,
    ...snapshot(agent),
    streaming: true,
    depth,
    meta: { providerId: effective.providerId, model: effective.model }
  })

  bus.emit('agent:busy', { id: agent.id, busy: true })
  bus.emit('status', `${agent.name} 正在思考`)

  const parts = []
  if (ctx.transcript) parts.push(ctx.transcript)
  parts.push(instruction)
  if (ctx.solo) parts.push(SOLO_PROMPT)
  /* 本轮不允许派单时必须明说：否则模型仍会输出 <astral:plan>，
     正文被 strip 掉后就成了空回复，看起来像模型没有产出。 */
  if (ctx.noDelegate) {
    parts.push('## 直接回答\n本轮不派单：不要输出 <astral:plan> 或任何派单块，不要等待下属，直接自己完成并给出完整答复。')
  }
  if (ctx.final) {
    parts.push('## 收束\n这是本层最后一步：基于已有信息给出最终答复，不要再派单，不要输出 astral:plan。')
  }
  if (callBudget <= 0) {
    parts.push('（提示：本轮协作预算已用尽，请直接给出你目前能给出的最好结果。）')
  }

  let messages = buildMessages(effective, parts.filter(Boolean).join('\n\n'), [], { channel })
  let useAgent = effective
  const pre = await runHook('before:request', { agent: effective, messages })
  if (pre) {
    useAgent = pre.agent || effective
    messages = pre.messages || messages
  }
  callBudget--

  /* 快照放在请求前：回复途中拖滑杆不该改写这条消息的历史档位 */
  const thinkingAtStart = thinkingSnapshot(useAgent)

  /* 工具：只在有 MCP 服务器且成员拿到 tools 权限时下发；每轮最多 3 次追加调用，
     防止模型反复调工具把预算烧光。每次调用都要过审批（autoApprove 除外）。 */
  const tools = toolSchemasFor(useAgent)
  recordRun('request_meta', {
    agentId: useAgent.id,
    providerId: useAgent.providerId,
    model: useAgent.model,
    toolCount: tools.length,
    tools: tools.map((tool) => tool.function && tool.function.name).filter(Boolean)
  })
  const TOOL_ROUNDS = 3
  /* Watchdog：同一「工具 + 参数」在一轮内重复到阈值即判无进展，提前收口，
     避免事件自动触发后把预算烧在无效循环里。可在 设置 → 外部接口 关闭。 */
  const wdCfg = (state.settings.triggers || {}).watchdog || {}
  const watchdogEnabled = wdCfg.enabled !== false
  const watchdogLimit = Math.max(2, Math.min(10, Math.round(Number(wdCfg.threshold) || 3)))
  const toolSeen = new Map()
  let watchdogStopped = false
  let accumulated = ''
  let toolRound = 0
  let full = ''

  /* 本条回复的统计口径：从第一次请求前开始，到最后一个字符收口。
     含重试与工具往返，不含排队等待；字节只算正文流式增量。 */
  const startedAt = Date.now()
  const stats = {
    bytes: 0,
    streamMs: 0,
    firstTokenAt: 0,
    inputEstimate: 0,
    rounds: 0,
    reportedRounds: 0,
    reported: { input: 0, output: 0, total: 0 }
  }
  const encoder = new TextEncoder()

  try {
    for (;;) {
      if (runCancelled()) throw new Error('用户已取消本轮')
      const pendingCalls = []
      if (state.usage) state.usage.calls += 1
      let roundFirst = 0
      let roundLast = 0
      let roundBytes = 0
      /* 断线重试会丢弃上一段输出，本轮计数直接清零；
         已经结算进 stats 的历史轮次不受影响 */
      const dropRound = () => {
        roundFirst = 0
        roundLast = 0
        roundBytes = 0
      }
      stats.rounds += 1
      stats.inputEstimate += estimatePromptTokens(messages)
      const roundText = await callModel(useAgent, messages, {
        channel,
        tools,
        onUsage: (usage) => {
          addUsage(useAgent, usage)
          if (!usage) return
          const input = Math.max(0, Number(usage.input) || 0)
          const output = Math.max(0, Number(usage.output) || 0)
          stats.reported.input += input
          stats.reported.output += output
          stats.reported.total += Math.max(input + output, Number(usage.total) || 0)
          if (usage.reported !== false) stats.reportedRounds += 1
        },
        onDelta: (delta) => {
          const now = Date.now()
          if (!roundFirst) roundFirst = now
          roundLast = now
          roundBytes += encoder.encode(delta).length
          accumulated += delta
          bus.emit('message:delta', { id: msg.id, text: delta })
          bus.emit('message:update', { id: msg.id })
        },
        /* 断线重试：主进程丢弃了上一轮输出，这里把气泡里的半截文本也清掉，
           否则重试后的内容会接在半截话后面 */
        onRetry: (info) => {
          if (info.reset) {
            dropRound()
            accumulated = ''
            full = ''
            msg.text = ''
            bus.emit('message:update', { id: msg.id, patch: { text: '' } })
          }
          const seconds = Math.max(1, Math.round((info.delay || 0) / 1000))
          bus.emit('status', `${useAgent.name} 连接中断，${seconds}s 后重试（${info.next}/${info.max}）`)
        },
        onWarning: (info) => {
          bus.emit('status', info.message || '响应可能不完整')
        },
        onToolCalls: (calls) => pendingCalls.push(...calls)
      })

      /* 这一轮正常收口才入总账；中途被重试丢弃的片段不计入吞吐 */
      stats.bytes += roundBytes
      if (roundFirst && roundLast > roundFirst) stats.streamMs += roundLast - roundFirst
      if (!stats.firstTokenAt && roundFirst) stats.firstTokenAt = roundFirst
      roundFirst = 0
      roundLast = 0
      roundBytes = 0

      if (runCancelled()) throw new Error('用户已取消本轮')
      if (pendingCalls.length) {
        recordRun('tool_calls_received', {
          calls: pendingCalls.map((call) => ({
            id: call.id || '',
            name: call.function && call.function.name,
            args: String((call.function && call.function.arguments) || '').slice(0, 800)
          }))
        })
      }
      if (watchdogStopped || !pendingCalls.length || !tools.length || toolRound >= TOOL_ROUNDS || callBudget <= 0) break

      toolRound++
      messages = [...messages, {
        role: 'assistant',
        content: roundText || '',
        tool_calls: pendingCalls
      }]

      for (const call of pendingCalls.slice(0, 6)) {
        if (runCancelled()) throw new Error('用户已取消本轮')
        const label = describeCall(call)
        const fpArgs = String((call.function && call.function.arguments) || '')
        const fp = toolFingerprint(label, fpArgs)
        const hit = watchToolLoop(toolSeen, fp, watchdogEnabled, watchdogLimit)
        if (hit.stop) {
          watchdogStopped = true
          addMessage({ kind: 'system', channel, text: `Watchdog：检测到「${label}」重复调用 ${hit.count} 次，已停止本轮工具循环。` })
          bus.emit('status', 'Watchdog 已停止重复工具调用')
          break
        }
        recordRun('tool_call', {
          label,
          args: String((call.function && call.function.arguments) || '').slice(0, 1200)
        })
        bus.emit('status', `${agent.name} 调用工具：${label}`)
        const result = await runToolCall(call, useAgent)
        const resultForModel = compactToolResult(result.text, {
          budgetTokens: Math.min(6000, Math.floor(contextTokenBudget(state.settings) * 0.5))
        })
        recordRun('tool_result', {
          label,
          ok: Boolean(result.ok),
          denied: Boolean(result.denied),
          detail: String(result.text || '').slice(0, 500)
        })
        messages.push({ role: 'tool', tool_call_id: call.id || '', content: resultForModel })
        /* 工具记录用独立 kind，界面默认折叠成一行摘要；参数与结果留在字段里供展开 */
        addMessage({
          kind: 'tool',
          channel,
          toolLabel: label,
          args: String((call.function && call.function.arguments) || '').slice(0, 1200),
          ok: Boolean(result.ok),
          denied: Boolean(result.denied),
          cancelled: Boolean(result.cancelled),
          timeout: Boolean(result.timeout),
          detail: String(result.text || '').slice(0, 3000)
        })
        callBudget--
        if (callBudget <= 0) break
      }
      bus.emit('status', `${agent.name} 正在整理工具结果`)
    }
    full = accumulated
  } catch (err) {
    const cancelled = runCancelled()
    bus.emit('message:update', {
      id: msg.id,
      patch: {
        streaming: false,
        error: !cancelled,
        interrupted: cancelled,
        phase: cancelled ? 'cancelled' : 'error',
        text: cancelled ? (String(msg.text || '').trim() || '本轮已取消') : `调用失败：${err.message}`,
        summary: cancelled ? '本轮已取消' : `调用失败：${String(err.message || '').slice(0, 80)}`,
        summarySource: 'first-line'
      }
    })
    bus.emit('message:done', { id: msg.id })
    bus.emit('agent:busy', { id: agent.id, busy: false })
    recordRun('agent_error', { agentId: agent.id, cancelled, error: err.message })
    return {
      ok: false,
      cancelled,
      text: '',
      raw: '',
      error: cancelled ? '用户已取消本轮' : err.message,
      msgId: msg.id
    }
  }

  const post = await runHook('after:reply', { agent: useAgent, text: full })
  if (post && typeof post.text === 'string' && post.text !== full) {
    full = post.text
  }

  const clean = stripPlan(full)
  const summary = makeMessageSummary({ kind: 'agent', text: clean })

  /* 用量收口：全部轮次都有供应商上报才算精确，否则退回字符估算并标 ~ */
  const outputEstimate = estimateTextTokens(clean)
  const exact = stats.rounds > 0 && stats.reportedRounds === stats.rounds
  const tokens = exact
    ? {
        input: stats.reported.input,
        output: stats.reported.output,
        total: Math.max(stats.reported.total, stats.reported.input + stats.reported.output),
        reported: true
      }
    : {
        input: Math.max(stats.reported.input, stats.inputEstimate),
        output: Math.max(stats.reported.output, outputEstimate),
        total: Math.max(stats.reported.total, stats.inputEstimate + outputEstimate),
        reported: false
      }
  const endedAt = Date.now()
  if (!msg.meta) msg.meta = {}
  msg.meta.stats = {
    ms: endedAt - startedAt,
    firstTokenMs: stats.firstTokenAt ? stats.firstTokenAt - startedAt : null,
    bytes: stats.bytes,
    streamMs: Math.round(stats.streamMs),
    tokens,
    model: useAgent.model || '',
    provider: (providerById(useAgent.providerId) || {}).name || '',
    thinking: thinkingAtStart,
    at: endedAt
  }
  bus.emit('message:stats', { id: msg.id })

  /* 关键：无论正文有没有变化，都要把 streaming 收口并重绘。
     之前仅在 clean !== full 时发 update，导致流式末尾的
     「正在编排任务…」可能留在气泡里。 */
  bus.emit('message:update', {
    id: msg.id,
    patch: {
      streaming: false,
      error: false,
      phase: 'done',
      text: clean,
      summary,
      summarySource: 'first-line'
    }
  })
  bus.emit('message:done', { id: msg.id })
  bus.emit('agent:busy', { id: agent.id, busy: false })
  recordRun('agent_done', { agentId: agent.id, depth, text: clean.slice(0, 500) })
  return { ok: true, text: clean, raw: full, msgId: msg.id }
}

/* --------------------------------------------------------------- 派单 */

async function dispatch (supervisor, plan, ctx) {
  const tasks = plan.tasks.slice(0, 6).map((t) => {
    const target = agentById(t.to)
    const allowed = canTask(supervisor, target)
    return {
      id: uid('task'),
      to: t.to,
      name: target ? target.name : t.to,
      title: target ? target.title : '未知成员',
      color: target ? target.color : 'var(--err)',
      text: t.task,
      state: allowed ? 'queued' : 'error',
      result: allowed ? '' : '不在其管辖范围内'
    }
  })

  const planMsg = addMessage({
    kind: 'plan',
    channel: 'agent',
    ...snapshot(supervisor),
    brief: plan.brief,
    depth: ctx.depth || 0,
    tasks
  })
  bus.emit('status', `${supervisor.name} 派出 ${tasks.length} 项任务`)
  recordRun('plan', {
    agentId: supervisor.id,
    brief: String(plan.brief || '').slice(0, 500),
    tasks: tasks.map((task) => ({ id: task.id, to: task.to, name: task.name, text: String(task.text || '').slice(0, 300) }))
  })

  const runOne = async (task) => {
    if (runCancelled()) return { ok: false, cancelled: true, error: '用户已取消本轮' }
    const target = agentById(task.to)
    if (!target || !canTask(supervisor, target)) {
      bus.emit('task:update', {
        msgId: planMsg.id,
        taskId: task.id,
        patch: { state: 'error', result: task.result || '不在其管辖范围内' }
      })
      return { ok: false, error: task.result || '无效的派单对象' }
    }

    bus.emit('task:update', { msgId: planMsg.id, taskId: task.id, patch: { state: 'running' } })
    recordRun('task_start', { taskId: task.id, to: task.to, name: task.name })

    /* 隔离红线：这里只能带协作区（AI↔AI）自己的内容。
       用户的原始需求、用户↔AI 的历史、附件一律不往下传——
       上级需要下级知道什么，必须自己写进派单文本。 */
    const peer = transcriptBlock(planMsg.id, 6, 'agent')
    /* 注意字段名：任务对象上存的是 text（parsePlan 解析出来的字段叫 task），
       这里曾经读错了字段，导致下级收到 undefined、拿不到任务正文。 */
    const brief = String(task.text || '').trim()
    const instruction = [
      brief
        ? `## 派单\n${brief}`
        : '## 派单\n（上级这次没有写明任务正文。不要猜测任务内容，直接回复你缺少任务说明，等待补充。）',
      `## 你的上级\n${supervisor.name}（${supervisor.title || ROLE_LABEL[supervisor.role]}）`,
      peer || ''
    ].filter(Boolean).join('\n\n')

    const res = await runWithDelegation(target, instruction, {
      depth: (ctx.depth || 0) + 1,
      maxDepth: ctx.maxDepth,
      channel: 'agent',
      upstream: supervisor.id
    })

    bus.emit('task:update', {
      msgId: planMsg.id,
      taskId: task.id,
      patch: { state: res.ok ? 'done' : 'error', result: (res.text || res.error || '').slice(0, 400) }
    })
    recordRun('task_done', { taskId: task.id, ok: Boolean(res.ok), cancelled: Boolean(res.cancelled) })
    return res
  }

  const parallel = state.settings.orchestration && state.settings.orchestration.parallel !== false
  let results = []
  if (parallel) {
    results = await Promise.all(tasks.map(runOne))
  } else {
    for (const task of tasks) results.push(await runOne(task))
  }

  const delivered = tasks
    .map((task, i) => {
      const res = results[i]
      if (!res || !res.ok) return `### ${task.name}\n未完成：${(res && res.error) || '无结果'}`
      return `### ${task.name}（${task.title}）\n${res.text}`
    })
    .join('\n\n')

  return { planMsg, delivered }
}

/* --------------------------------------------- 一个 Agent 的完整决策回合 */

async function runWithDelegation (agent, instruction, ctx) {
  const depth = ctx.depth || 0
  const maxDepth = ctx.maxDepth ?? 2
  const channel = ctx.channel === 'agent' ? 'agent' : 'user'
  const canDelegate = subordinatesOf(agent).length > 0 && depth < maxDepth && callBudget > 0

  const res = await runAgent(agent, instruction, {
    depth,
    channel,
    transcript: ctx.transcript,
    final: false,
    noDelegate: !canDelegate,
    primary: ctx.primary
  })

  if (!res.ok) return res
  if (runCancelled()) return { ...res, ok: false, cancelled: true, error: '用户已取消本轮' }

  /* 空回复兜底：模型只吐派单块（但本轮不允许派单）或干脆没正文时，
     插件会把空气泡填成提示文案，用户看到的就是「没有产出」。
     这里自动再要一次直接回答，避免把问题甩给用户。 */
  const raw = String(res.raw || '')
  const stripped = stripPlan(raw).trim()
  const planOnly = !canDelegate && !stripped && Boolean(parsePlan(raw))
  if (!raw.trim() || planOnly) {
    const retry = await runAgent(agent, [
      instruction,
      '',
      '## 直接回答（重要）',
      '上一轮没有产生可交付正文。这一轮禁止派单、禁止输出 <astral:plan>、禁止只写思考或计划；',
      '请直接给出完整答复，不要询问确认，也不要提及这是重试。'
    ].join('\n'), { depth, channel, final: true, noDelegate: true, primary: ctx.primary })
    if (retry.ok) {
      if (!stripPlan(String(retry.raw || '')).trim()) {
        addMessage({
          kind: 'system',
          channel,
          text: '模型这次只返回了空正文或思考内容；已自动重试一次。可检查模型是否支持当前参数，或上下文是否超出限制。'
        })
      }
      bus.emit('message:remove', { id: res.msgId })
      return retry
    }
    return res
  }

  const plan = canDelegate ? parsePlan(res.raw) : null
  if (!plan) {
    /* 深度不够时模型仍可能吐出派单块：正文被 strip 掉后会留下一条空消息，
       协作区里看着像"有人发了条空白"，直接撤掉 */
    if (!String(res.text || '').trim()) bus.emit('message:remove', { id: res.msgId })
    return res
  }

  if (!String(res.text || '').trim()) bus.emit('message:remove', { id: res.msgId })

  const { delivered } = await dispatch(agent, plan, {
    depth,
    maxDepth,
    upstream: ctx.upstream
  })
  if (runCancelled()) return { ok: false, cancelled: true, error: '用户已取消本轮', text: '' }

  const synth = await runAgent(agent, [
    '## 收束',
    '下面是你派出的任务及其交付结果。请基于这些内容给出你这一层的最终答复。',
    '合并重复信息，指出仍然存在的分歧或风险；不要复述派单过程，不要提及内部称呼。',
    '',
    delivered
  ].join('\n'), { depth, channel, final: true, primary: ctx.primary })

  return synth.ok ? synth : res
}

/* --------------------------------------------------------------- 回合 */

function currentMaxDepth () {
  const configured = Math.max(0, Number((state.settings.orchestration || {}).maxRounds ?? 2))
  const think = Number(state.settings.thinking ?? 50)
  const base = think < 34 ? 0 : think < 67 ? Math.min(1, configured) : configured
  /* 团队模式至少允许一层派单，否则「团队」只是名义上的；
     单智能体模式不经过这里（直接 noDelegate）。 */
  const ready = ((state.roster && state.roster.agents) || []).filter((agent) => agent.enabled !== false)
  const teamReady = currentWorkMode() === 'team' && ready.length > 1
  return teamReady ? Math.max(1, base) : base
}

function latestUserMessage (thread = currentThread) {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (msg.kind === 'user' && msg.channel === 'user' && (msg.thread || 'commander') === thread) return msg
  }
  return null
}

function latestAiMessage (thread = currentThread) {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (msg.kind === 'agent' && msg.channel === 'user' && (msg.thread || 'commander') === thread) return msg
  }
  return null
}

/* 同一线程、同一项目内从某条用户消息开始向后滚回。
   计划、任务、AI 回复都带同一个 thread，因此会一起被移除。 */
function removeAfter (userMsg, include = false) {
  const index = state.messages.indexOf(userMsg)
  if (index < 0) return []
  const thread = userMsg.thread || 'commander'
  const removed = []
  const kept = []
  for (let i = 0; i < state.messages.length; i++) {
    const msg = state.messages[i]
    const sameThread = (msg.thread || 'commander') === thread
    if ((i === index && include) || (i > index && sameThread)) removed.push(msg)
    else kept.push(msg)
  }
  state.messages = kept
  return removed
}

/* 一轮结束后兜底收口：任何仍处于流式/排队/进行中的内容，
   统一标记为中断，避免 UI 永远停在“正在编排/进行中”。 */
function settleInterruptedTurn () {
  let changed = false
  for (const msg of state.messages) {
    if (msg.streaming) {
      msg.streaming = false
      msg.interrupted = true
      msg.phase = 'interrupted'
      if (!String(msg.text || '').trim()) msg.text = '本轮已中断'
      bus.emit('message:update', {
        id: msg.id,
        patch: {
          streaming: false,
          interrupted: true,
          phase: 'interrupted',
          text: msg.text
        }
      })
      bus.emit('message:done', { id: msg.id })
      changed = true
    }
    if (msg.kind === 'plan' && Array.isArray(msg.tasks)) {
      let planChanged = false
      for (const task of msg.tasks) {
        if (task.state !== 'running' && task.state !== 'queued') continue
        task.state = 'error'
        task.interrupted = true
        task.result = task.result || '本轮中断'
        bus.emit('task:update', {
          msgId: msg.id,
          taskId: task.id,
          patch: { state: 'error', interrupted: true, result: task.result }
        })
        planChanged = true
        changed = true
      }
      if (planChanged) {
        msg.interrupted = true
        bus.emit('message:update', { id: msg.id })
      }
    }
  }
  return changed
}

/* --------------------------------------------------- 单智能体 / 团队扩展 */

function parseExpandDirective (raw) {
  const match = /<astral:expand>([\s\S]*?)<\/astral:expand>/i.exec(String(raw || ''))
  if (!match) return null
  let reason = ''
  try {
    const data = JSON.parse(match[1].trim())
    reason = String((data && data.reason) || '').trim()
  } catch { /* 只写标记也允许，按通用理由扩展 */ }
  return { reason }
}

function stripExpand (text) {
  return String(text || '').replace(/<astral:expand>[\s\S]*?<\/astral:expand>/gi, '').trim()
}

/* 扩展标记不该出现在用户看到的气泡里；正文为空时直接撤掉空气泡 */
function settleSoloDirective (res) {
  const clean = stripPlan(stripExpand(res.raw || res.text))
  if (clean) {
    const summary = makeMessageSummary({ kind: 'agent', text: clean })
    bus.emit('message:update', {
      id: res.msgId,
      patch: { text: clean, summary, summarySource: 'first-line' }
    })
    res.text = clean
    res.raw = clean
  } else {
    bus.emit('message:remove', { id: res.msgId })
    res.text = ''
    res.raw = ''
  }
}

async function expandSoloToTeam (agent, userMsg, instruction, soloRes, directive) {
  const planText = [
    `用户任务：\n${instruction}`,
    directive.reason ? `标准会话判断需要团队：${directive.reason}` : '单智能体判断需要团队接手。',
    soloRes.text ? `标准会话已完成的分析：\n${stripExpand(String(soloRes.text)).slice(0, 4000)}` : '',
    transcriptBlock(userMsg.id, 6, 'user'),
    '请据此设计一个能接手并完成该任务的团队。'
  ].filter(Boolean).join('\n\n')

  const planner = agent && agent.providerId && agent.model
    ? { providerId: agent.providerId, model: agent.model }
    : defaultPlanner()
  bus.emit('status', '标准会话申请扩展，正在组建团队…')
  let team
  try {
    team = await generateTeam(planText, planner)
  } catch (err) {
    addMessage({
      kind: 'system',
      channel: 'user',
      text: `标准会话申请扩展团队，但生成失败：${err.message}`
    })
    return null
  }
  const applied = applyTeamToProject(team, { soloAgent: agent })
  if (!applied) {
    addMessage({ kind: 'system', channel: 'user', text: '标准会话申请扩展团队，但当前没有活动项目。' })
    return null
  }
  addMessage({
    kind: 'system',
    channel: 'user',
    text: `标准会话判断需要团队协作，已扩展为 ${applied.agents.length} 人团队：${applied.agents.map((member) => member.name).join('、')}。`
  })
  recordRun('team_expand', {
    reason: directive.reason,
    members: applied.agents.map((member) => ({ name: member.name, role: member.role, model: member.model }))
  })
  currentThread = (commander() && commander().id) || currentThread
  return applied
}

/* 单智能体回合：一次独立回答；若模型申请扩展，则生成团队并在同一回合交接 */
async function runSoloTurn (agent, userMsg, instruction) {
  const res = await runAgent(agent, instruction, {
    depth: 0,
    channel: 'user',
    transcript: transcriptBlock(userMsg.id, 8, 'user'),
    final: false,
    noDelegate: true,
    solo: true,
    primary: true
  })
  if (!res.ok || runCancelled()) return res

  const directive = parseExpandDirective(res.raw)
  if (!directive) return res

  settleSoloDirective(res)
  const applied = await expandSoloToTeam(agent, userMsg, instruction, res, directive)
  if (!applied) return res

  bus.emit('status', '团队已接手，正在协作')
  return runWithDelegation(commander() || agent, instruction, {
    depth: 0,
    maxDepth: currentMaxDepth(),
    channel: 'user',
    transcript: transcriptBlock(userMsg.id, 8, 'user'),
    primary: true
  })
}

async function runTurn ({ userMsg, resolved, files, target }) {
  state.busy = true
  resetUsage()
  turnSeq++
  /* 每次用户回合都重新发放本轮协作预算；否则第一次回合扣完后，
     后续回合会一直处于「预算已用尽」，工具调用会被直接丢弃。 */
  callBudget = 14
  currentThread = target.id
  const soloMode = currentWorkMode() === 'solo'
  bus.emit('busy', true)
  bus.emit('status', `${target.name} ${soloMode ? '正在思考' : '正在协作'}`)

  const run = await beginRun({
    agentId: target.id,
    agentName: target.name,
    thread: target.id,
    prompt: resolved.text,
    channel: 'user'
  })
  if (run) {
    userMsg.runId = run.id
    recordRun('turn_start', {
      targetId: target.id,
      targetName: target.name,
      prompt: String(resolved.text || '').slice(0, 2000),
      files: (files || []).length
    })
  } else {
    /* 主进程拒绝了本轮启动（例如用户取消发起成员确认）；不要把消息继续跑下去。 */
    state.busy = false
    bus.emit('busy', false)
    bus.emit('status', '待命中')
    toast('本轮协作未启动：发起成员未确认或运行不可用', 'err')
    return
  }

  const fullInstruction = [
    resolved.text,
    attachmentBlock(files)
  ].filter(Boolean).join('\n\n')

  let finalText = ''
  let runStatus = 'completed'
  let runError = ''
  try {
    const res = soloMode
      ? await runSoloTurn(target, userMsg, fullInstruction)
      : await runWithDelegation(target, fullInstruction, {
          depth: 0,
          maxDepth: currentMaxDepth(),
          channel: 'user',
          transcript: transcriptBlock(userMsg.id, 8, 'user'),
          primary: true
        })
    finalText = res.text || ''
    if (runCancelled() || res.cancelled) {
      runStatus = 'cancelled'
      finalText = ''
      addMessage({ kind: 'system', channel: 'user', text: '本轮已取消。' })
    } else if (!res.ok) {
      runStatus = 'failed'
      runError = res.error || '未知错误'
      addMessage({ kind: 'system', channel: 'user', text: `本轮中断：${runError}` })
    }
  } catch (err) {
    if (runCancelled()) {
      runStatus = 'cancelled'
      finalText = ''
      addMessage({ kind: 'system', channel: 'user', text: '本轮已取消。' })
    } else {
      runStatus = 'failed'
      runError = err.message || String(err)
      finalText = `协作中断：${runError}`
      addMessage({ kind: 'system', channel: 'user', text: finalText })
    }
  } finally {
    settleInterruptedTurn()
    state.busy = false
    bus.emit('busy', false)
    bus.emit('status', '待命中')
    if (state.usage) recordRun('usage', usageSnapshot())
    recordRun('turn_end', { status: runStatus, error: runError })
    await finishRun(runStatus, { error: runError })
    persist.session()
  }

  return { ok: true, text: finalText, turn: turnSeq, status: runStatus }
}

export async function submit (input) {
  const raw = String(input || '').trim()
  if (!raw) return { ok: false, message: '空指令' }
  if (isGuest()) {
    toast('游客是只读身份：可以浏览，但不能发起模型调用', 'err')
    return { ok: false, message: '游客只读' }
  }
  if (state.busy) return { ok: false, message: '上一轮尚未结束' }
  /* AI↔AI 视图是只读的：哪怕绕过界面也不允许从那条线发起会话 */
  if (state.view === 'agent') return { ok: false, message: '协作区只读，请切回「用户 ↔ AI」再发言' }

  const resolved = resolveTarget(raw)
  const target = resolved.agent
  if (!target) {
    toast('编制里没有可用的 Agent，请先到设置里恢复默认编制', 'err')
    return { ok: false, message: '没有可用 Agent' }
  }

  const files = (state.pendingFiles || []).slice()
  const firstUser = !state.messages.some((m) => m.kind === 'user' && m.channel === 'user')
  const userMsg = addMessage({
    kind: 'user',
    channel: 'user',
    thread: target.id,
    targetId: target.id,
    instructionText: resolved.text,
    text: raw,
    files: snapshotFiles(files)
  })

  /* 新对话留空名称时，用第一句话命名；只在还没有任何用户消息时触发，
     之后的消息不会改写标题。团队模式创建时直接分配团队，不要求也不自动生成
     对话名称；单独对话和插件制作模式仍按首句命名。@ 指定对象不算标题内容。 */
  if (firstUser && state.conversationMode !== 'team' && !String(state.conversationTitle || '').trim()) {
    const title = conversationTitleFromMessage(raw.replace(/^@[^\s，,：:]+\s*/, ''))
    if (title) {
      state.conversationTitle = title
      bus.emit('conversation:title', title)
      persist.session()
    }
  }

  if (files.length) {
    state.pendingFiles = []
    bus.emit('attachments:changed')
  }

  return runTurn({ userMsg, resolved, files: userMsg.files, target })
}

export function cancelCurrentTurn () {
  if (!state.busy) return false
  return requestCancel()
}

export function canRegenerate (msgId) {
  if (state.busy) return false
  const target = state.messages.find((m) => m.id === msgId)
  if (!target || target.kind !== 'agent' || target.channel !== 'user') return false
  const thread = target.thread || 'commander'
  const user = latestUserMessage(thread)
  const latest = latestAiMessage(thread)
  return Boolean(user && latest && latest.id === target.id)
}

/* 重新生成最新一轮：保留最新用户消息与附件，移除该轮产生的
   AI 文本、计划、任务和系统提示，然后按原目标/原附件重跑。 */
export async function regenerateLatest (threadArg) {
  if (state.busy) { toast('上一轮尚未结束', 'err'); return { ok: false } }
  if (state.view === 'agent') { toast('协作区只读，切回「用户 ↔ AI」再重新生成', 'err'); return { ok: false } }
  const thread = threadArg || state.activeAgentId || (commander() ? commander().id : 'commander')
  const userMsg = latestUserMessage(thread)
  const aiMsg = latestAiMessage(thread)
  if (!userMsg || !aiMsg || state.messages.indexOf(aiMsg) <= state.messages.indexOf(userMsg)) {
    toast('没有可重新生成的回复', 'err')
    return { ok: false }
  }

  const target = (userMsg.targetId && agentById(userMsg.targetId)) || resolveTarget(userMsg.text).agent
  if (!target) {
    toast('原消息的接收成员已不在当前项目，无法重新生成', 'err')
    return { ok: false }
  }

  const files = userMsg.files || []
  if (files.some((f) => !f || typeof f.text !== 'string')) {
    toast('部分旧附件没有保存正文，本轮将只带上可用内容', 'err')
  }

  removeAfter(userMsg, false)
  bus.emit('messages:reload')
  persist.session()

  const resolved = {
    agent: target,
    text: userMsg.instructionText || userMsg.text
  }
  return runTurn({ userMsg, resolved, files, target })
}

/* 撤回用户消息：该消息及其之后同线程的消息、计划、任务一起删除。 */
export function withdrawMessage (msgId) {
  if (state.busy) { toast('协作进行中，暂时不能撤回', 'err'); return 0 }
  const msg = state.messages.find((m) => m.id === msgId)
  if (!msg || msg.kind !== 'user' || msg.channel !== 'user') return 0
  const removed = removeAfter(msg, true)
  bus.emit('messages:reload')
  persist.session()
  bus.emit('status', '待命中')
  return removed.length
}

/* 派单任务的统一执行入口：任务副本与失败重试都走这里，负责 busy 标记、
   运行记录、状态回写与结算，避免两套流程在取消 / 中断 / 清理上走偏。 */
async function runPlanTask (planMsg, task, options = {}) {
  const supervisor = agentById(planMsg.agentId) || commander()
  const target = agentById(task.to)
  const text = String(task.text || '').trim()
  const label = options.label || '任务副本'

  if (!supervisor || !target || !text) {
    const reason = !supervisor
      ? '发起成员已不在编制中'
      : !target ? '接收成员已不在编制中' : '任务没有指令正文'
    bus.emit('task:update', {
      msgId: planMsg.id,
      taskId: task.id,
      patch: { state: 'error', interrupted: false, result: reason }
    })
    persist.session()
    return { ok: false, error: reason }
  }

  if (!canTask(supervisor, target)) {
    bus.emit('task:update', {
      msgId: planMsg.id,
      taskId: task.id,
      patch: { state: 'error', interrupted: false, result: '不在其管辖范围内' }
    })
    persist.session()
    return { ok: false, error: '不在其管辖范围内' }
  }

  state.busy = true
  resetUsage()
  turnSeq++
  callBudget = 14
  currentThread = planMsg.thread || currentThread
  bus.emit('busy', true)
  bus.emit('status', `${supervisor.name} 正在${options.statusVerb || '执行任务副本'}`)
  /* 重试时要先把上一次的失败结果擦掉，否则旧错误会跟到新一轮里 */
  bus.emit('task:update', {
    msgId: planMsg.id,
    taskId: task.id,
    patch: { state: 'running', result: '', interrupted: false }
  })

  const run = await beginRun({
    agentId: target.id,
    agentName: target.name,
    thread: planMsg.thread || currentThread,
    prompt: text,
    channel: 'agent'
  })
  if (!run) {
    bus.emit('task:update', {
      msgId: planMsg.id,
      taskId: task.id,
      patch: { state: 'error', interrupted: true, result: `${label}未启动：发起成员未确认或运行不可用` }
    })
    planMsg.interrupted = true
    settleInterruptedTurn()
    state.busy = false
    bus.emit('busy', false)
    bus.emit('status', '待命中')
    persist.session()
    return { ok: false, error: `${label}未启动` }
  }

  let runStatus = 'completed'
  let runError = ''
  try {
    const peer = transcriptBlock(planMsg.id, 6, 'agent')
    const instruction = [
      `## 派单\n${text}`,
      `## 你的上级\n${supervisor.name}（${supervisor.title || ROLE_LABEL[supervisor.role]}）`,
      peer || ''
    ].filter(Boolean).join('\n\n')
    const res = await runWithDelegation(target, instruction, {
      depth: (planMsg.depth || 0) + 1,
      maxDepth: currentMaxDepth(),
      channel: 'agent',
      upstream: supervisor.id
    })
    bus.emit('task:update', {
      msgId: planMsg.id,
      taskId: task.id,
      patch: { state: res.ok ? 'done' : 'error', interrupted: false, result: (res.text || res.error || '').slice(0, 400) }
    })
    return { ok: res.ok, text: res.text || '' }
  } catch (err) {
    runStatus = 'failed'
    runError = err.message
    bus.emit('task:update', {
      msgId: planMsg.id,
      taskId: task.id,
      patch: { state: 'error', interrupted: true, result: `${label}中断：${err.message}` }
    })
    planMsg.interrupted = true
    return { ok: false, error: err.message }
  } finally {
    if (state.usage) recordRun('usage', usageSnapshot())
    recordRun('turn_end', { status: runStatus, error: runError })
    await finishRun(runStatus, { error: runError })
    settleInterruptedTurn()
    state.busy = false
    bus.emit('busy', false)
    bus.emit('status', '待命中')
    persist.session()
  }
}

/* 把派单任务复制成同一计划中的新任务并单独执行；原任务不动。 */
export async function copyPlanTask (planMsgId, taskId, newText) {
  if (state.busy) { toast('协作进行中，暂时不能执行任务副本', 'err'); return { ok: false } }
  const planMsg = state.messages.find((m) => m.id === planMsgId)
  const source = planMsg && Array.isArray(planMsg.tasks) ? planMsg.tasks.find((t) => t.id === taskId) : null
  if (!planMsg || !source) return { ok: false }
  const supervisor = agentById(planMsg.agentId) || commander()
  const text = String(newText || source.text || '').trim()
  if (!supervisor || !text) return { ok: false }

  const task = {
    id: uid('task'),
    to: source.to,
    name: source.name,
    title: source.title,
    color: source.color,
    text,
    state: 'queued',
    result: ''
  }
  planMsg.tasks.push(task)
  planMsg.interrupted = false
  bus.emit('message:update', { id: planMsg.id })
  bus.emit('task:update', { msgId: planMsg.id, taskId: task.id, patch: { state: 'queued' } })
  return runPlanTask(planMsg, task, { label: '任务副本', statusVerb: '执行任务副本' })
}

/* 重试一条失败的任务：沿用原任务、原接收成员与原指令就地重跑。
   不追加副本，失败的卡片自己变回进行中；再次失败仍可继续重试。 */
export async function retryPlanTask (planMsgId, taskId) {
  if (state.busy) { toast('协作进行中，暂时不能重试任务', 'err'); return { ok: false, error: 'busy' } }
  const planMsg = state.messages.find((m) => m.id === planMsgId)
  const task = planMsg && Array.isArray(planMsg.tasks) ? planMsg.tasks.find((t) => t.id === taskId) : null
  if (!planMsg || !task) return { ok: false, error: '任务已不在当前会话里' }
  if (task.state === 'running' || task.state === 'queued') return { ok: false, error: '这个任务还在进行中' }
  if (!String(task.text || '').trim()) {
    toast('这条任务没有指令正文，无法重试；可以改用任务副本补一条指令', 'err')
    return { ok: false, error: '任务没有指令正文' }
  }

  task.attempts = (Number(task.attempts) || 0) + 1
  task.state = 'queued'
  task.result = ''
  task.interrupted = false
  planMsg.interrupted = false
  bus.emit('task:update', {
    msgId: planMsg.id,
    taskId: task.id,
    patch: { state: 'queued', result: '', interrupted: false, attempts: task.attempts }
  })
  return runPlanTask(planMsg, task, { label: '重试', statusVerb: '重试任务' })
}

export function clearSession () {
  state.messages = []
  state.archives = []
  state.conversationTitle = ''
  state.tasks = []
  state.usage = null
  state.pendingFiles = []
  bus.emit('session:clear')
  bus.emit('conversation:title', '')
  bus.emit('usage:changed', null)
  bus.emit('attachments:changed')
  persist.session()
  bus.emit('status', '待命中')
}

/* 项目切换时，默认线程跟着新项目的第一位可用成员走，避免沿用上一个项目的成员 id。 */
bus.on('project:changed', () => {
  currentThread = commander() ? commander().id : 'commander'
})
