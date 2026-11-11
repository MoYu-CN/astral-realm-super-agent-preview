#!/usr/bin/env node
'use strict'

/**
 * 星界 · 记忆服务 stdio MCP server（P0 雏形）
 *
 * 独立启动：
 *   npm run memory
 *   MEMORY_CONFIG_DIR=<目录> MEMORY_ACTOR=super node electron/memory/server.js
 *
 * 环境变量：
 *   MEMORY_CONFIG_DIR   数据目录，默认仓库 config/
 *   MEMORY_ACTOR        super（默认）/ executor / external
 *   MEMORY_ENABLED      0 = 关闭，memory_* 返回 disabled
 *   MEMORY_ALLOW_WRITE  1 = 允许外部直连写入（默认只读）
 *
 * 客户端接入示例（config/mcp.json 的 servers 里加一项）：
 *   { "id": "memory", "name": "星界记忆", "command": "node",
 *     "args": ["<星界目录>/electron/memory/server.js"], "enabled": true }
 */

const path = require('node:path')
const { createMemoryService, ROLE } = require('./index.js')

const CONFIG_DIR = process.env.MEMORY_CONFIG_DIR || path.join(__dirname, '..', '..', 'config')
const ACTOR = process.env.MEMORY_ACTOR || ROLE.SUPER
const ENABLED = process.env.MEMORY_ENABLED !== '0'
const ALLOW_EXTERNAL_WRITE = process.env.MEMORY_ALLOW_WRITE === '1'

const SERVER_INFO = { name: 'astral-memory', version: '0.1.0' }
const PROTOCOL_VERSION = '2024-11-05'

const TOOLS = [
  {
    name: 'memory_query',
    description: '一次查回事件 / 提议 / 派发记录；source=archive 时只读回查封存的旧文件。仅超级智能体可调用。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目 id' },
        prefix: { type: 'string', description: '事件编号前缀，如 BB' },
        time_range: { type: 'object', description: '{ from, to }，ISO 时间字符串' },
        keyword: { type: 'string' },
        include: { type: 'array', items: { type: 'string' }, description: 'events / proposals / dispatch' },
        source: { type: 'string', enum: ['live', 'archive'], description: '默认 live' },
        id: { type: 'string', description: 'source=archive 时按清单 id 取文件正文' },
        limit: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'memory_write',
    description: '一次事务内完成写入：编号分配、前缀表对照、事件/提议/派发/行为/项目落库。仅超级智能体可调用。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['event', 'proposal', 'dispatch', 'behavior', 'project'] },
        project: { type: 'string' },
        prefix: { type: 'string' },
        series: { type: 'string', description: '新系列名称，前缀不存在时自动登记' },
        startedAt: { type: 'string' },
        endedAt: { type: 'string', description: '未完成留空（T1 / T2）' },
        raisedAt: { type: 'string' },
        occurredAt: { type: 'string' },
        result: { type: 'string', description: 'proposal 用：接受 / 拒绝 / 已下发任务' },
        summary: { type: 'string' },
        task: { type: 'string' },
        toTeam: { type: 'string' },
        kind: { type: 'string' },
        signal: { type: 'string', description: '是 / 否' },
        count: { type: 'number' },
        name: { type: 'string' },
        folderPath: { type: 'string' },
        mainAgentId: { type: 'string' },
        metadata: { type: 'object' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_get_context',
    description: '已由权重网接管：只给常驻硬性上下文、最近活跃的少数项目、权重近/远邻居与最近触发时间，不再组装全量事件正文。',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, limit: { type: 'number' } },
      additionalProperties: false
    }
  },
  {
    name: 'knowledge',
    description: '纯知识读写，与项目数据无关联。action: upsert / query / expire；外部直连默认只读。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['upsert', 'query', 'expire'] },
        id: { type: 'string' },
        domain: { type: 'string' },
        kind: { type: 'string' },
        body: { type: 'string' },
        appliesWhen: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_recall',
    description: '按权重网回忆：默认只给命中项目的权重、最近触发时间与权重近/远邻居，不拉事件正文；mode=full 才拼正文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        project: { type: 'string' },
        budget: { type: 'number' },
        limit: { type: 'number' },
        mode: { type: 'string', enum: ['brief', 'full'] },
        near: { type: 'number' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_observe',
    description: '记一条近期观察（用户说出的打算或偏好），只记录不执行；到点由时间网生成具体询问。敏感内容必须由用户明确给出。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        kind: { type: 'string', enum: ['meal', 'task', 'preference', 'note'] },
        source: { type: 'string', enum: ['chat', 'manual', 'scout'] },
        at: { type: 'string' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_time',
    description: '时间网 + 进程层：时段与阶段共同决定「这个阶段该做什么」，概率由历史轨迹与变化学出。action=phase 给当前阶段的条件概率与询问，phases 给全量概率表。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['suggest', 'habit', 'phase', 'phases', 'weeks', 'week', 'sync'] },
        at: { type: 'string' },
        project: { type: 'string' },
        hour: { type: 'number' },
        week: { type: 'string' },
        limit: { type: 'number' },
        minHits: { type: 'number' },
        minWeeks: { type: 'number' },
        minWeight: { type: 'number' },
        minShare: { type: 'number' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_compress',
    description: '日 / 周 / 月摘要压缩。压缩规则未定，当前返回 not_implemented。',
    inputSchema: {
      type: 'object',
      properties: { level: { type: 'string', enum: ['day', 'week', 'month'] } },
      additionalProperties: false
    }
  }
]

const service = createMemoryService({
  configDir: CONFIG_DIR,
  enabled: ENABLED,
  allowExternalWrite: ALLOW_EXTERNAL_WRITE
})

function withActor (args) {
  return { ...(args || {}), actor: (args && args.actor) || ACTOR }
}

function callTool (name, args) {
  switch (name) {
    case 'memory_query': return service.query(withActor(args))
    case 'memory_write': return service.write(withActor(args))
    case 'memory_get_context': return service.getContext(withActor(args))
    case 'memory_recall': return service.recall(withActor(args))
    case 'memory_time': return service.time(withActor(args))
    case 'memory_observe': return service.time(withActor({ ...args, action: 'observe', source: args.source || 'chat' }))
    case 'knowledge': return service.knowledge(withActor(args))
    case 'memory_compress': return service.compress()
    default: throw new Error('未知工具：' + name)
  }
}

function reply (id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n')
}

function handle (msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, {
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      }
    })
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, { result: {} })
  if (method === 'tools/list') return reply(id, { result: { tools: TOOLS } })
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    try {
      const result = callTool(name, args)
      return reply(id, {
        result: {
          isError: result.ok === false,
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        }
      })
    } catch (err) {
      return reply(id, {
        result: { isError: true, content: [{ type: 'text', text: err.message }] }
      })
    }
  }
  return reply(id, { error: { code: -32601, message: '未知方法：' + method } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch {
      process.stderr.write('[astral-memory] 无法解析：' + line.slice(0, 120) + '\n')
    }
  }
})
process.stdin.on('end', () => { service.close() })
process.on('SIGINT', () => { service.close(); process.exit(0) })
process.on('SIGTERM', () => { service.close(); process.exit(0) })
