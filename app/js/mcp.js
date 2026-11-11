/* mcp.js — MCP 工具在渲染层的接入：工具目录、模型工具定义、审批与执行

   边界：
   - 工具是否可用由权限模型里的 `tools` 决定（完全授权同样放行）；
   - 主进程按 runId + runStart 下发的能力令牌校验工具调用，权限取 run 发起成员与执行成员的交集；
   - 审批在主进程：原生对话框确认后签发一次性令牌，绑定工具/参数/成员/项目/运行；
   - 执行端只认令牌，渲染层传 approved:true 或伪造 approvalToken 会被忽略并记入审计；
   - 主进程同时用 autoApprove 白名单和项目权限复核。 */

import { state, bus, h, toast, activeProject } from './core.js'
import { effectivePerms } from './permissions.js'
import { icon } from './icons.js'
import { askUserQuestion } from './ask.js'

const PREFIX = 'mcp__'
const MAX_RESULT = 12000
export const ASK_TOOL_NAME = 'ask_user_question'

/* 本地工具，不经过 MCP 传输。工具是否可见仍受成员的 tools 权限控制。 */
const ASK_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: ASK_TOOL_NAME,
    description: [
      '当缺少完成任务所需的关键信息、需求存在歧义，或需要用户在几个互斥方案中做选择时，向用户发起结构化提问。',
      '仅在确实无法从上下文推断、且答案会改变下一步行动时使用；信息已明确、可用合理默认值推进、或只是想让用户确认执行时不要调用。',
      '一次只问一个主题，优先提供 2–6 个可选项；用户也可以自由补充。',
      '调用后本轮会暂停，直到用户提交、跳过或关闭提问。',
      '返回 JSON：成功为 {"ok":true,"answer":"...","selected":[...],"freeform":"..."}；用户跳过为 {"ok":false,"cancelled":true,"error":"..."}；超时为 {"ok":false,"timeout":true,"error":"..."}。'
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要问用户的问题，必须具体、可回答，避免一次问多件事。'
        },
        context: {
          type: 'string',
          description: '可选。说明为什么需要这个信息、会影响什么决定，帮助用户理解问题背景。'
        },
        options: {
          type: 'array',
          maxItems: 8,
          description: '可选选项。存在明确备选时使用；每项包含 label，可选 value 和 description。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '展示给用户的选项文字' },
              value: { type: 'string', description: '回传给模型的稳定值；省略时使用 label' },
              description: { type: 'string', description: '选项的补充说明' }
            },
            required: ['label'],
            additionalProperties: false
          }
        },
        multiple: {
          type: 'boolean',
          description: '是否允许多选，默认 false。只有多个选项时生效。'
        },
        allowFreeform: {
          type: 'boolean',
          description: '是否允许用户自由输入，默认 true。没有 options 时必须为 true。'
        },
        placeholder: {
          type: 'string',
          description: '可选。自由输入框的占位提示。'
        }
      },
      required: ['question'],
      additionalProperties: false
    }
  }
}

let loaded = false
let inflight = null
let busBound = false
let activePainter = null
const registry = new Map()

function safeKey (text) {
  return String(text || '').replace(/[^a-zA-Z0-9_-]/g, '_')
}

/* 模型侧工具名有 64 字符上限；超长时用短哈希收尾，避免不同工具撞名 */
function toolKey (serverId, toolName) {
  const base = `${PREFIX}${safeKey(serverId)}__${safeKey(toolName)}`
  if (base.length <= 64) return base
  let hash = 0
  for (let i = 0; i < base.length; i++) hash = (hash * 31 + base.charCodeAt(i)) | 0
  return `${base.slice(0, 55)}_${(hash >>> 0).toString(36).slice(0, 6)}`
}

export function mcpCatalog () {
  if (!state.mcp) state.mcp = { servers: [], configPath: '' }
  return state.mcp
}

export async function refreshMcp (force = false) {
  if (inflight) return inflight
  if (loaded && !force) return mcpCatalog()
  inflight = (async () => {
    try {
      const res = force ? await window.astral.mcpReload() : await window.astral.mcpList()
      state.mcp = {
        servers: (res && res.servers) || [],
        configPath: (res && res.configPath) || '',
        error: res && res.ok === false ? res.error || '读取 MCP 配置失败' : ''
      }
      loaded = true
      rebuild()
      bus.emit('mcp:changed', mcpCatalog())
    } catch (err) {
      state.mcp = { servers: [], configPath: '', error: err.message }
      bus.emit('mcp:changed', mcpCatalog())
    } finally {
      inflight = null
    }
    return mcpCatalog()
  })()
  return inflight
}

function rebuild () {
  registry.clear()
  for (const server of mcpCatalog().servers) {
    if (server.status !== 'ready' || server.enabled === false) continue
    for (const tool of server.tools || []) {
      registry.set(toolKey(server.id, tool.name), {
        serverId: server.id,
        serverName: server.name || server.id,
        autoApprove: server.autoApprove || [],
        tool
      })
    }
  }
}

/* 当前生效的工具定义（OpenAI function 格式），没权限时返回空数组 */
export function toolSchemasFor (agent) {
  const perms = effectivePerms(agent)
  if (!perms || (!perms.tools && !perms.full)) return []
  rebuild()
  const out = [ASK_TOOL_SCHEMA]
  for (const [name, entry] of registry) {
    const schema = entry.tool.inputSchema || { type: 'object', properties: {} }
    out.push({
      type: 'function',
      function: {
        name,
        description: `[${entry.serverName}] ${entry.tool.description || entry.tool.name}`.slice(0, 900),
        parameters: {
          type: 'object',
          properties: schema.properties || {},
          ...(Array.isArray(schema.required) && schema.required.length ? { required: schema.required } : {})
        }
      }
    })
  }
  return out
}

export function mcpToolCount (agent) {
  const perms = effectivePerms(agent)
  if (!perms || (!perms.tools && !perms.full)) return 0
  rebuild()
  return registry.size + 1
}

/* ------------------------------------------------------------ 审批与执行 */

export function describeCall (call) {
  const name = (call && call.function && call.function.name) || ''
  if (name === ASK_TOOL_NAME) return '星界 · 向用户提问'
  const entry = registry.get(name)
  if (!entry) return name || '未知工具'
  return `${entry.serverName} · ${entry.tool.name}`
}

export async function runToolCall (call, agent) {
  const name = call && call.function && call.function.name
  const rawArgs = (call.function && call.function.arguments) || '{}'
  let args = {}
  try {
    args = JSON.parse(rawArgs || '{}')
  } catch {
    return { ok: false, text: `工具参数不是合法 JSON：${String(rawArgs).slice(0, 200)}` }
  }

  const perms = effectivePerms(agent)
  if (name === ASK_TOOL_NAME) {
    if (!perms || (!perms.tools && !perms.full)) {
      return { ok: false, text: '当前成员没有工具权限，不能向用户提问' }
    }
    try {
      const result = await askUserQuestion(args, agent)
      return {
        ok: Boolean(result && result.ok),
        cancelled: Boolean(result && result.cancelled),
        timeout: Boolean(result && result.timeout),
        text: JSON.stringify(result || { ok: false, error: '提问没有返回结果' })
      }
    } catch (err) {
      return { ok: false, text: `提问失败：${err.message}` }
    }
  }

  const entry = registry.get(name)
  if (!entry) return { ok: false, text: `工具不可用：${name || '未命名'}` }

  const project = activeProject()
  /* 只提交调用意图；run 能力令牌、审批与审批令牌都由主进程处理，
     这里没有 approved 可传，传了也会被忽略并记入审计。 */
  const request = {
    serverId: entry.serverId,
    tool: entry.tool.name,
    args,
    permissions: perms,
    agentId: agent ? agent.id : '',
    runId: state.currentRunId || '',
    runCapability: state.currentRunCapability || '',
    projectId: project ? project.id : '',
    projectName: project ? project.name : '',
    projectRoot: project ? project.rootPath || '' : ''
  }

  let res = await window.astral.mcpCall(request)
  if (!res || res.ok === false) {
    return { ok: false, denied: Boolean(res && res.denied), text: `调用失败：${(res && res.error) || '未知错误'}` }
  }
  let text = String(res.text || '').trim()
  if (!text) text = '（工具没有返回可读内容）'
  if (text.length > MAX_RESULT) text = `${text.slice(0, MAX_RESULT)}\n…（结果过长，已截断）`
  return { ok: true, text }
}

/* -------------------------------------------------------------- 设置面板 */

export function mcpSettingsSection () {
  const box = h('div', { class: 'mcp-panel' })
  const list = h('div', { class: 'mcp-list' })
  const status = h('div', { class: 'mcp-status', text: '正在读取 MCP 配置…' })

  const paint = () => {
    const catalog = mcpCatalog()
    list.textContent = ''
    const servers = catalog.servers || []
    const ready = servers.filter((s) => s.status === 'ready').length
    const tools = servers.reduce((n, s) => n + (s.tools || []).length, 0)
    status.className = 'mcp-status' + (catalog.error ? ' error' : '')
    status.textContent = catalog.error
      ? `读取失败：${catalog.error}`
      : `${servers.length} 个服务器 · ${ready} 个就绪 · 共 ${tools} 个工具`

    if (!servers.length) {
      list.append(h('div', { class: 'mcp-empty' },
        h('div', { class: 'mcp-empty-title', text: '还没有配置 MCP 服务器' }),
        h('div', { class: 'mcp-empty-desc', text: '编辑 config/mcp.json 添加服务器，然后用「重新连接」加载。每个服务器就是一个能在本机执行操作的工具进程。' }),
        h('pre', { class: 'mcp-sample', text: JSON.stringify({
          servers: [{
            id: 'filesystem',
            name: '文件系统',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\\\Users\\\\你\\\\Documents'],
            enabled: true,
            autoApprove: []
          }]
        }, null, 2) })
      ))
      return
    }

    for (const server of servers) {
      const badge = h('span', { class: `mcp-badge ${server.status}` , text: server.status === 'ready' ? '就绪' : server.status === 'starting' ? '启动中' : server.status === 'error' ? '错误' : '已停用' })
      const toggle = h('button', {
        class: 'switch' + (server.enabled ? ' on' : ''),
        type: 'button',
        title: server.enabled ? '停用这个服务器' : '启用这个服务器',
        onclick: async () => {
          toggle.disabled = true
          const res = await window.astral.mcpSetEnabled({ serverId: server.id, enabled: !server.enabled })
          toggle.disabled = false
          if (res && res.ok === false) toast(res.error || '切换失败', 'err')
          await refreshMcp(true)
          paint()
        }
      })

      const card = h('div', { class: 'mcp-server' },
        h('div', { class: 'mcp-server-head' },
          h('span', { class: 'mcp-server-name', text: server.name || server.id }),
          badge,
          toggle
        ),
        h('div', { class: 'mcp-cmd', text: [server.command, ...(server.args || [])].join(' ') }),
        server.error ? h('div', { class: 'mcp-err', text: server.error }) : null,
        h('div', { class: 'mcp-tools' },
          (server.tools || []).length
            ? (server.tools || []).slice(0, 40).map((tool) => h('span', {
              class: 'mcp-tool',
              title: tool.description || tool.name,
              text: tool.name
            }))
            : h('span', { class: 'mcp-tool-empty', text: server.enabled ? '没有暴露工具' : '未启用' })
        )
      )
      list.append(card)
    }
  }

  const actions = h('div', { class: 'mcp-actions' },
    h('button', {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        status.textContent = '正在重新连接…'
        await refreshMcp(true)
        paint()
      }
    }, '重新连接'),
    h('button', {
      class: 'btn ghost',
      type: 'button',
      onclick: () => window.astral.mcpOpenConfig()
    }, '打开配置文件')
  )

  box.append(
    h('div', { class: 'mcp-head' },
      h('div', {},
        h('div', { class: 'mcp-title', text: 'MCP 工具服务器' }),
        h('div', { class: 'mcp-sub', text: '接入本机 MCP 服务器后，成员可以在得到你允许的前提下调用它们的工具，真正操作文件、浏览器、Office 等软件。开启「完全授权」后不再逐次询问。' })
      ),
      actions
    ),
    status,
    list
  )

  /* 权限没开时给出明确提示，避免用户以为配置坏了 */
  if (!(state.settings.permissions || {}).tools && !(state.settings.permissions || {}).full) {
    box.insertBefore(
      h('div', { class: 'mcp-warn', text: '还没有开启「外部工具」权限：到「权限」页勾选后，成员才会带上这些工具。' }),
      status
    )
  }

  refreshMcp().then(paint)
  activePainter = () => { if (box.isConnected) paint() }
  if (!busBound) {
    busBound = true
    bus.on('mcp:changed', () => { if (activePainter) activePainter() })
  }
  return box
}
