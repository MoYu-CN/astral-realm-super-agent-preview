'use strict'

/* mcp-client.js — MCP 客户端（stdio 传输）

   负责按 config/mcp.json 启动本机 MCP 服务器、完成 initialize 握手、
   拉取 tools/list，并把 tools/call 转发过去。只做传输与生命周期管理。

   权限与审批不在这里判断：主进程按 roster 重算权限、弹原生确认，然后签发
   一次性审批令牌；这里的 call() 只接受绑定到本次调用的令牌，不认 approved 布尔。

   协议要点：
   - stdio 上每行一个 JSON-RPC 2.0 消息；
   - 握手 protocolVersion 用 2024-11-05（当前服务端普遍兼容的版本）；
   - 服务端反向请求（sampling / roots 等）一律回 -32601，不做支持。 */

const { spawn } = require('node:child_process')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const PROTOCOL_VERSION = '2024-11-05'
const CLIENT_INFO = { name: 'astral-realm', version: '1.0.0' }
const INIT_TIMEOUT = 20000
const CALL_TIMEOUT = 120000
const MAX_TOOLS = 200
const BUILTIN_ID = 'builtin'

/* 内置工具：不依赖外部进程，开箱即可读写受控目录。
   这是「小任务立刻能干」的兜底，外部 MCP 服务器仍可照常接入。 */
const BUILTIN_TOOLS = [
  {
    name: 'write_text_file',
    description: '写入文本文件（UTF-8），自动创建父目录。path 支持相对用户主目录的写法，例如 Desktop/hello.txt。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标路径，如 Desktop/hello.txt 或 C:\\Users\\你\\Desktop\\hello.txt' },
        content: { type: 'string', description: '要写入的文本内容' },
        overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'read_text_file',
    description: '读取文本文件内容（UTF-8），最大 200KB。path 支持相对用户主目录的写法。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '要读取的文件路径' } },
      required: ['path']
    }
  },
  {
    name: 'list_directory',
    description: '列出目录下的文件与子目录（最多 200 项）。path 支持相对用户主目录的写法，例如 Desktop。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径，默认用户主目录' } }
    }
  },
  {
    name: 'get_current_timestamp',
    description: '获取当前日期、时间、星期、ISO 时间和 Unix 时间戳。可选传入 IANA 时区（如 Asia/Shanghai），默认使用本机时区。',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: '可选，IANA 时区名，如 Asia/Shanghai；默认本机时区' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'take_screenshot',
    description: '截取当前主屏幕或星界窗口，保存为 PNG 并返回可预览的绝对路径。截图属于敏感操作，调用前需要用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['screen', 'window'],
          description: 'screen = 主屏幕（默认）；window = 星界窗口'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'kb_guide',
    description: '按正在做的事（工序）检索知识库，按「权重 × 相关度」排序。默认只回「编号 + 标题 + 一行摘要 + 权重百分比」，要正文再 kb_get —— 库大也不涨上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '正在做的工序，例如：给插件加配置项、排查构建失败' },
        stage: { type: 'string', enum: ['设计', '动手前', '写码中', '提交前', '排障'] },
        kind: { type: 'string', enum: ['方法', '避错'] },
        limit: { type: 'number', description: '最多返回几条，默认 5，硬上限 20' },
        detail: { type: 'boolean', description: 'true 时连正文一起返回（默认 false，只回摘要）' }
      },
      required: ['task']
    }
  },
  {
    name: 'kb_search',
    description: '关键词检索知识库，回答「这个项目以前提过这个词吗」。默认只回摘要（编号 / 标题 / 权重），要看正文传 detail 或再调 kb_get。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '检索关键词' },
        kind: { type: 'string', enum: ['方法', '避错'] },
        domain: { type: 'string', description: '只查某个领域' },
        limit: { type: 'number', description: '最多返回几条，默认取设置里的检索条数' },
        detail: { type: 'boolean', description: 'true 时连正文一起返回（默认 false）' }
      },
      required: ['text']
    }
  },
  {
    name: 'kb_add',
    description: '往当前项目的知识库写一条。「避错」必须有触发条件、先做、为什么、违规症状；「方法」必须有步骤。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['方法', '避错'] },
        domain: { type: 'string', description: '领域名；空则归入未分类' },
        title: { type: 'string' },
        trigger: { type: 'string', description: '触发条件 / 适用场景' },
        steps: { type: 'array', items: { type: 'string' }, description: '可执行步骤；避错里叫「先做」' },
        why: { type: 'string', description: '依据' },
        symptoms: { type: 'string', description: '违规症状（避错必填）：怎么判断没做' },
        verify: { type: 'string', description: '验证方式' },
        boundaries: { type: 'string', description: '已知边界' },
        id: { type: 'string', description: '可选；更新已有条目时传编号' }
      },
      required: ['kind', 'title', 'steps']
    }
  },
  {
    name: 'kb_list',
    description: '列出当前项目知识库的全部条目摘要（编号 / 类别 / 领域 / 标题）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'kb_digest',
    description: '知识库目录概览：一共几条、各领域分布、权重最高的几条、长期没人打开的冷条目。只回统计与标题，不回正文——用来判断「该不该查、查什么」。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'kb_feedback',
    description: '给一条知识记反馈：有用 / 没用。这是权重唯一的人工入口，会直接抬高或压低它以后的排序。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '如 M-001' },
        useful: { type: 'boolean', description: 'true 有用（默认）/ false 没用' }
      },
      required: ['id']
    }
  },
  {
    name: 'kb_get',
    description: '按编号读取知识库的一条全文。读一次会记一次「打开」，这条计数直接影响它在知识网里的权重。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '如 M-001 或 P-003' } },
      required: ['id']
    }
  },
  {
    name: 'kb_remove',
    description: '删除一条知识库条目。不可撤销，调用前必须问用户确认。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删除的编号' } },
      required: ['id']
    }
  },
  {
    name: 'kb_prune',
    description: '把知识库清理到不超过 keep 条，只删最旧的。不可撤销，调用前必须问用户确认。',
    inputSchema: {
      type: 'object',
      properties: { keep: { type: 'number', description: '保留条数（两类合计）' } },
      required: ['keep']
    }
  },
  {
    name: 'kb_init',
    description: '为当前项目建出知识库骨架（总纲 + 方法/避错主体索引）。不会覆盖已有文件。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'memory_query',
    description: '查询星界记忆库：按项目 / 时间段 / 动作前缀 / 关键词，一次取回事件、提议与派发记录。source="archive" 时回查封存文件。一次调用即可，不要逐层翻文件。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名或项目编号；省略则查全部' },
        prefix: { type: 'string', description: '动作前缀，如 BB（修 bug）、P（改动）' },
        keyword: { type: 'string', description: '在事件内容里模糊匹配' },
        time_range: {
          type: 'object',
          description: '时间范围（ISO 时间，可选）',
          properties: { from: { type: 'string' }, to: { type: 'string' } }
        },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['events', 'proposals', 'dispatch'] },
          description: '要取回哪几类，默认三类都取'
        },
        source: { type: 'string', enum: ['live', 'archive'], description: 'live=活跃库（默认）；archive=封存文件回查' },
        id: { type: 'string', description: 'source=archive 时按封存编号取原文' },
        limit: { type: 'number', description: '每类最多几条，默认 20，上限 200' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'memory_write',
    description: '向记忆库写一条记录。一次调用内完成编号分配、前缀表对照与落库，不要分多次写。action=project / event / proposal / dispatch / behavior。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['project', 'event', 'proposal', 'dispatch', 'behavior'], description: '写哪一类' },
        project: { type: 'string', description: '所属项目（event / proposal / dispatch 用）' },
        prefix: { type: 'string', description: 'event 必填：动作前缀；新系列会自动登记进编号表' },
        series: { type: 'string', description: 'event 可选：这个前缀代表什么系列，如「修复 bug」' },
        summary: { type: 'string', description: 'event / project：一句话摘要' },
        result: { type: 'string', description: 'proposal 必填：接受 / 拒绝 / 已下发任务；event 可选结果' },
        task: { type: 'string', description: 'dispatch 必填：派发了什么任务' },
        toTeam: { type: 'string', description: 'dispatch：交给谁' },
        kind: { type: 'string', description: 'behavior：行为类型' },
        signal: { type: 'string', description: 'behavior：偏好信号，如 是 / 否' },
        name: { type: 'string', description: 'project：项目名' },
        id: { type: 'string', description: 'project：项目编号，省略则自动生成' },
        startedAt: { type: 'string', description: '可选：发生时间（ISO），省略取当前时间' },
        endedAt: { type: 'string', description: '可选：结束时间；未完成留空表示持续中' },
        metadata: { type: 'object', description: '可选附加数据' }
      },
      required: ['action']
    }
  },
  {
    name: 'memory_context',
    description: '已由权重网接管，不再是「全量回忆文件」：只返回常驻硬性上下文、最近活跃的少数项目、权重近/远邻居与最近触发时间，不组装事件正文。常驻块末尾带一小段实时安全状态（有没有外发等你点头、在办几条留痕、问原委去哪儿问）。需要具体内容请用 memory_recall 或数据表。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '只看某个项目；省略则取全部项目' },
        limit: { type: 'number', description: '事件条数，默认 20，上限 200' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'memory_recall',
    description: '按权重网回忆，不再拉繁杂的记忆文件。默认 brief 只给命中项目的权重、最近一次触发时间，以及权重近/远邻居，不拼事件与做法的正文；需要细节才传 mode=full。回答涉及过去的项目、做过的决定、踩过的坑之前先调用它，不要凭印象编，也不要改去调用 memory_context 拿全量正文。问「谁让我做的 / 有没有留痕 / 出了事怎么说得清」时也会带出相关责任链（按权重排，不是全量）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要回顾的事，自然语言即可，例如「上次投票项目的登录报错怎么修的」' },
        project: { type: 'string', description: '可选：当前项目名，作为软加权；不会强行只查它' },
        budget: { type: 'number', description: '返回文本的字数上限，默认 900' },
        limit: { type: 'number', description: '最多命中几个项目，默认 3，上限 8' },
        mode: { type: 'string', enum: ['brief', 'full'], description: 'brief=只给权重与最近触发时间（默认，不拉正文）；full=额外拼事件与做法正文' },
        near: { type: 'number', description: '权重近 / 远的分界 0–1，默认 0.25' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_observe',
    description: '记一条「近期观察」：用户在对话里说出的打算或偏好（例如「今天想吃火锅」「待会要交周报」）。只记录、不执行；时间网会在合适的时间点据此生成具体询问。聊天记录等敏感内容必须由用户明确给出，不要自己去翻文件。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '用户原话或一句话概括' },
        kind: {
          type: 'string',
          enum: ['meal', 'task', 'preference', 'note'],
          description: 'meal=吃饭打算 / task=待办 / preference=偏好 / note=其他'
        },
        source: { type: 'string', enum: ['chat', 'manual', 'scout'], description: '来源，默认 chat' },
        at: { type: 'string', description: '可选：发生时间 ISO，默认现在' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_time',
    description: '时间网 + 进程层：时段（周几 + 小时）与阶段（项目走到哪一步）共同决定「这个阶段该做什么」。action=phase 返回当前阶段、各类指令的条件概率、近期漂移、阶段迁移的起始点，以及一句可转述的询问；phases 返回全量阶段概率表。概率由历史轨迹与平时的变化学出，不看内容相似度、不读项目网。问到「项目现在该做什么 / 这个阶段常收到什么指令 / 走到什么时候开始需要这类工作」时用 phase；问作息时用 suggest/habit。样本不足就直说，不要凭印象编作息或阶段。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['suggest', 'habit', 'phase', 'phases', 'weeks', 'week', 'sync'],
          description: 'suggest=按跨周时段提醒；habit=某时段在做什么；phase=当前阶段该做什么并给出询问；phases=全量阶段概率表；weeks/week=时间文档；sync=立刻重算'
        },
        at: { type: 'string', description: '可选：指定时间（ISO），默认现在' },
        project: { type: 'string', description: 'phase：指定项目；省略取最近活跃项目' },
        hour: { type: 'number', description: 'habit：只看某个小时（0-23）' },
        week: { type: 'string', description: 'week 必填：周编号，如 2026-W45' },
        limit: { type: 'number', description: 'weeks：取几周，默认 12' },
        minHits: { type: 'number', description: 'suggest：同一时段至少几条事件，默认 1（不作为习惯主门槛）' },
        minWeeks: { type: 'number', description: 'suggest：至少在多少个不同的周、同一时段重复，默认 3' },
        minWeight: { type: 'number', description: 'suggest：时间置信门槛 0–1，默认 0.4' },
        minShare: { type: 'number', description: '旧参数名，等同 minWeight' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_knowledge',
    description: '知识库工具（纯工具，与项目文件、事件记录无任何关联）。action=query 检索；action=upsert 写入最本质的做法；action=expire 直接删除已过时 / 无效的条目。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['query', 'upsert', 'expire'], description: '做什么' },
        id: { type: 'string', description: 'upsert 更新已有条目 / expire 要删除的编号' },
        domain: { type: 'string', description: '领域，如 前端 / 后端' },
        kind: { type: 'string', description: '类型，如 修复 / 诊断 / 避错 / 决策' },
        body: { type: 'string', description: 'upsert 必填：只写「这件事该怎么做」' },
        appliesWhen: { type: 'string', description: '适用条件' },
        status: { type: 'string', enum: ['可用', '已过时', '无效'], description: '后两者会被直接删除' },
        limit: { type: 'number', description: 'query 条数，默认 20' }
      },
      required: ['action']
    }
  },
  {
    name: 'memory_kb',
    description: '知识网（第四张网）：在越来越大的知识库里按「权重 × 相关度」找该怎么做，且不把正文塞进上下文。先 action=digest 看库里有什么，再 action=search 拿「编号 + 标题 + 一行摘要 + 权重」，确认要看细节时才用项目知识库的 kb_get 取正文。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['digest', 'search', 'get', 'use', 'feedback', 'map'],
          description: 'digest=目录概览；search=按权重检索摘要；get=取单条元信息并记一次打开；use=标记被引用；feedback=有用/没用；map=整张知识网'
        },
        query: { type: 'string', description: 'search 必填：要查的做法 / 症状' },
        project: { type: 'string', description: '项目 id；不传则查全部项目 + 全局知识' },
        id: { type: 'string', description: '条目编号，如 M-001 / P-003' },
        key: { type: 'string', description: '索引键（形如 kb:<项目>:<编号>），search 结果里带回来' },
        kind: { type: 'string', description: '方法 / 避错' },
        domain: { type: 'string', description: '领域' },
        limit: { type: 'number', description: 'search 条数，默认 5' },
        useful: { type: 'boolean', description: 'feedback：true 有用 / false 没用' },
        keys: { type: 'array', items: { type: 'string' }, description: 'use：被引用进上下文的索引键' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_inbox',
    description: '收件箱（微信 / 企业微信 / QQ / 通知转发统一入口）：看「外面发生了什么」。每条都带分流结果——alert 该问你、observe 该记、knowledge 该沉、archive 该忘。默认只回摘要与来源，原文留在库里：群聊再多也不会把上下文撑爆，要细节再按 chat 追。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['recent', 'search', 'threads', 'stats', 'handled'],
          description: 'recent=最近消息；search=按关键词找；threads=看哪个群最热；stats=总量与分流分布；handled=标记已处理'
        },
        route: { type: 'string', enum: ['alert', 'observe', 'knowledge', 'archive'], description: 'recent 只看某一档' },
        channel: { type: 'string', description: '只查某个渠道 id' },
        query: { type: 'string', description: 'search 必填：关键词' },
        limit: { type: 'number', description: '条数，默认 20，上限 200' },
        ids: { type: 'array', items: { type: 'string' }, description: 'handled：要标记的消息 id' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'security_check',
    description: '安全边界 / 出站闸门：要往外部发东西之前先过这里。干净就放行；命中 API 密钥、私钥、身份证、银行卡、手机号这类内容会返回 verdict=confirm 和一个 gateId —— 这时不要发送，把命中项和目标原样告诉用户，等用户在「设置 → 安全边界」里点头。用户批准后，同一目标 + 同一份内容再查一次会直接放行（批准绑死在内容指纹上，改一个字就要重新问）。agent 自己无法批准。如果这次外发最终交给外部工具（MCP）执行，主进程在真正调用时还会再确认一次——那是最后一道，不能省。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screen', 'pending', 'stats', 'policy', 'brief'],
          description: 'screen=检查一段要发出去的内容；pending=看还有哪些在等用户点头；stats=边界概况；policy=当前开关；brief=首流那种两三行状态'
        },
        text: { type: 'string', description: '要发出去的正文（纯文本）' },
        args: { type: 'object', description: '也可以传工具参数对象，会逐字段扫一遍并标出是哪一段命中的' },
        target: { type: 'string', description: '发到哪：群名 / 人名 / 地址 / 接口' },
        channel: { type: 'string', description: '走哪条渠道或哪个外部工具' },
        purpose: { type: 'string', description: '为什么发：一句话，会原样记进闸门，给用户判断用' },
        taskId: { type: 'string', description: '如果这次外发属于某条留痕任务，带上编号' },
        exposure: { type: 'string', enum: ['send', 'pull', 'none'], description: 'send=会送出去（默认）；pull=只查询不发送' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'security_ledger',
    description: '工作留痕：把「谁派的活、原话是什么、我做了什么、谁批准的」记成一条不可改的链。收到派活时先问用户要不要留痕，用户同意后再 open（收件箱里像派活的消息已经生成了候选，用 tasks 能看到）。之后每做一步 append 一次，做完 close（close 会自动压成一条事件进事件网）。export 给出带哈希链校验的 Markdown 存证——真出问题，这份东西能说清「我是被要求这么做的」。要追原委（「这件事到底谁让我做的、中间发生了什么」）用 trace：按内容与权重找到那条留痕，按时间给出完整说法、同一时间前后的相关事件，以及记录里有哪些缺口。账本只追加，数据库层禁止修改删除。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['tasks', 'open', 'append', 'close', 'ledger', 'verify', 'export', 'digest', 'trace'],
          description: 'tasks=看候选与进行中的留痕；open=开一条；append=记一步；close=归档并自动压进事件网；ledger=看账本；verify=校验哈希链；export=导出存证；digest=手动把在办的压成事件；trace=按编号或一句话追这件事的原委'
        },
        id: { type: 'string', description: 'open/close/ledger/export/digest/trace 用：留痕编号或候选编号，如 A-20261111-01' },
        query: { type: 'string', description: 'trace：不记得编号时用一句话问，如「谁让我改合同的」；会按内容与权重找最近的那条' },
        days: { type: 'number', description: 'trace：前后各看多少天的事件，默认 0.5 天（12 小时）' },
        force: { type: 'boolean', description: 'digest：账本没新增也强制再压一条' },
        status: { type: 'string', enum: ['all', 'candidate', 'open', 'closed', 'dropped'], description: 'tasks：筛状态，默认 all' },
        title: { type: 'string', description: 'append：一句话说明这一步做了什么' },
        ask: { type: 'string', description: 'open：对方的原话（一字不改地抄下来，这是留痕的关键）' },
        text: { type: 'string', description: 'open：原话；append：补充说明' },
        from: { type: 'string', description: 'open：谁派的活' },
        channel: { type: 'string', description: 'open：来源渠道，如 企业微信 / 微信个人号' },
        chat: { type: 'string', description: 'open：哪个群 / 会话' },
        messageId: { type: 'string', description: 'open：来源消息 id（候选里带着）' },
        deadline: { type: 'string', description: 'open：对方说的时限，用原话，别换算' },
        expect: { type: 'string', description: 'open：对方期待的结果' },
        kind: { type: 'string', enum: ['action', 'outbound', 'note', 'understand', 'correct'], description: 'append：这一步属于什么' },
        body: { type: 'object', description: 'append：结构化细节，如 {tool,target,summary}' },
        refs: { type: 'object', description: 'append：关联对象，如 {gate,run,inbox}' },
        taskId: { type: 'string', description: 'append：记到哪条留痕下' },
        outcome: { type: 'string', description: 'close：结果如何' },
        evidence: { type: 'string', description: 'close：证据位置（文件 / 链接 / 提交号）' }
      },
      required: ['action'],
      additionalProperties: false
    }
  }
]

function expandUserPath (input, home) {
  let p = String(input || '').trim()
  if (!p) p = home
  if (p === '~') p = home
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(2))
  if (!path.isAbsolute(p)) p = path.join(home, p)
  return path.resolve(p)
}

function insideRoots (target, roots) {
  const norm = target.toLowerCase()
  return roots.some((root) => {
    const base = path.resolve(root).toLowerCase()
    return norm === base || norm.startsWith(`${base}${path.sep}`)
  })
}

async function runBuiltinTool (tool, args, roots, helpers = {}) {
  const home = os.homedir()

  if (String(tool).startsWith('kb_')) {
    if (typeof helpers.knowledge !== 'function') throw new Error('知识库插件当前不可用')
    return await helpers.knowledge(tool, args || {}, helpers.project || {})
  }

  if (String(tool).startsWith('memory_') || String(tool).startsWith('security_')) {
    if (typeof helpers.memory !== 'function') throw new Error('记忆服务当前不可用')
    const res = await helpers.memory(tool, args || {})
    if (!res || res.ok === false) throw new Error((res && res.error) || '记忆操作失败')
    return JSON.stringify(res.data === undefined ? res : res.data, null, 2)
  }

  if (tool === 'get_current_timestamp') {
    const now = new Date()
    const requested = String(args.timezone || '').trim()
    const timezone = requested || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    let local
    try {
      local = new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'long'
      }).format(now)
    } catch {
      throw new Error(`无效的时区：${timezone}`)
    }
    return [
      `当前时间：${local}`,
      `时区：${timezone}`,
      `ISO 8601：${now.toISOString()}`,
      `Unix 秒：${Math.floor(now.getTime() / 1000)}`,
      `Unix 毫秒：${now.getTime()}`
    ].join('\n')
  }

  if (tool === 'take_screenshot') {
    if (typeof helpers.captureScreenshot !== 'function') {
      throw new Error('当前环境没有接入截图能力')
    }
    const target = args.target === 'window' ? 'window' : 'screen'
    const shot = await helpers.captureScreenshot({ target })
    if (!shot || shot.ok === false) throw new Error((shot && shot.error) || '截图失败')
    return [
      `截图已保存：${shot.path}`,
      `范围：${shot.label || (target === 'window' ? '星界窗口' : '主屏幕')}`,
      `尺寸：${shot.width} × ${shot.height}`,
      `时间：${shot.capturedAt}`,
      '可在对话中的图片预览里查看。'
    ].join('\n')
  }

  if (tool === 'write_text_file') {
    const target = expandUserPath(args.path, home)
    if (!insideRoots(target, roots)) {
      throw new Error(`只能写入这些目录：${roots.join('、')}。收到的是 ${target}`)
    }
    const content = String(args.content ?? '')
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new Error('内容超过 2MB 上限')
    await fsp.mkdir(path.dirname(target), { recursive: true })
    if (!args.overwrite) {
      try {
        await fsp.access(target)
        throw new Error('目标已存在；如需覆盖请把 overwrite 设为 true')
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
    await fsp.writeFile(target, content, 'utf8')
    return `已写入 ${target}（${Buffer.byteLength(content, 'utf8')} 字节）`
  }

  if (tool === 'read_text_file') {
    const target = expandUserPath(args.path, home)
    if (!insideRoots(target, roots)) throw new Error(`只能读取这些目录：${roots.join('、')}`)
    const stat = await fsp.stat(target)
    if (stat.size > 200 * 1024) throw new Error('文件超过 200KB，暂不支持读取')
    return await fsp.readFile(target, 'utf8')
  }

  if (tool === 'list_directory') {
    const target = expandUserPath(args.path, home)
    if (!insideRoots(target, roots)) throw new Error(`只能列出这些目录：${roots.join('、')}`)
    const entries = await fsp.readdir(target, { withFileTypes: true })
    return entries.slice(0, 200).map((e) => `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}`).join('\n') || '（空目录）'
  }

  throw new Error(`未知的内置工具 ${tool}`)
}

const DEFAULT_CONFIG = {
  version: 1,
  servers: []
}

function okText (text) {
  return { ok: true, text }
}

class McpServer {
  constructor (cfg, onStatus) {
    this.cfg = cfg
    this.onStatus = onStatus
    this.child = null
    this.status = 'stopped'
    this.error = ''
    this.tools = []
    this.pending = new Map()
    this.seq = 0
    this.buffer = ''
    this.stderr = []
    this.stopping = false
  }

  snapshot () {
    return {
      id: this.cfg.id,
      name: this.cfg.name || this.cfg.id,
      command: this.cfg.command || '',
      args: this.cfg.args || [],
      enabled: this.cfg.enabled !== false,
      autoApprove: Array.isArray(this.cfg.autoApprove) ? this.cfg.autoApprove : [],
      status: this.status,
      error: this.error,
      tools: this.tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} }
      }))
    }
  }

  setStatus (status, error = '') {
    this.status = status
    this.error = error
    if (this.onStatus) this.onStatus(this.snapshot())
  }

  /* ------------------------------------------------------------ 生命周期 */

  async start () {
    if (!this.cfg.command) {
      this.setStatus('error', '缺少 command 配置')
      return
    }
    await this.stop()
    this.stopping = false
    this.setStatus('starting')

    let child
    try {
      child = spawn(this.cfg.command, this.cfg.args || [], {
        cwd: this.cfg.cwd || undefined,
        env: { ...process.env, ...(this.cfg.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true
      })
    } catch (err) {
      this.setStatus('error', `启动失败：${err.message}`)
      return
    }

    this.child = child
    this.buffer = ''
    this.stderr = []

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr.push(String(chunk).trim())
      if (this.stderr.length > 30) this.stderr.shift()
    })
    child.on('error', (err) => {
      this.setStatus('error', `进程错误：${err.message}`)
    })
    child.on('exit', (code, signal) => {
      this.child = null
      if (this.stopping) return
      const tail = this.stderr.slice(-3).join(' | ')
      this.setStatus('error', `进程退出（code=${code}${signal ? ` signal=${signal}` : ''}）${tail ? ` · ${tail}` : ''}`)
      this.rejectAll(new Error('MCP 服务器已退出'))
    })

    try {
      await this.initialize()
      this.tools = await this.listTools()
      this.setStatus('ready')
    } catch (err) {
      this.setStatus('error', err.message)
      await this.stop()
    }
  }

  async stop () {
    this.stopping = true
    this.rejectAll(new Error('MCP 服务器已停止'))
    const child = this.child
    this.child = null
    if (!child) return
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 120))
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    this.tools = []
    this.setStatus('stopped')
  }

  rejectAll (err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }

  /* -------------------------------------------------------------- 传输 */

  write (message) {
    if (!this.child || !this.child.stdin.writable) throw new Error('MCP 服务器未连接')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request (method, params, timeout = CALL_TIMEOUT) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${Math.round(timeout / 1000)}s）`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  notify (method, params) {
    try {
      this.write({ jsonrpc: '2.0', method, params })
    } catch { /* 连接已断，忽略通知失败 */ }
  }

  onData (chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      this.handleMessage(msg)
    }
  }

  handleMessage (msg) {
    if (!msg || typeof msg !== 'object') return

    /* 服务端发来的请求：明确拒绝，避免对方一直等 */
    if (msg.method && msg.id !== undefined) {
      try {
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `星界不支持 ${msg.method}` } })
      } catch { /* ignore */ }
      return
    }

    if (msg.id === undefined) return /* 通知，忽略 */
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) entry.reject(new Error(msg.error.message || `MCP 错误 ${msg.error.code}`))
    else entry.resolve(msg.result)
  }

  /* ------------------------------------------------------------ 协议方法 */

  async initialize () {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: CLIENT_INFO
    }, INIT_TIMEOUT)
    this.notify('notifications/initialized')
    return result
  }

  async listTools () {
    const tools = []
    let cursor
    for (let page = 0; page < 10; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, INIT_TIMEOUT)
      for (const tool of (result && result.tools) || []) {
        if (!tool || !tool.name) continue
        tools.push({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} }
        })
        if (tools.length >= MAX_TOOLS) return tools
      }
      cursor = result && result.nextCursor
      if (!cursor) break
    }
    return tools
  }

  async callTool (name, args) {
    const result = await this.request('tools/call', { name, arguments: args || {} })
    return { result, isError: Boolean(result && result.isError) }
  }
}

const IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}
const MAX_TOOL_IMAGE = 8 * 1024 * 1024

async function saveMcpImage (configDir, data, mimeType) {
  const ext = IMAGE_EXT[String(mimeType || '').toLowerCase()]
  if (!ext || !data) return ''
  let buffer
  try {
    buffer = Buffer.from(String(data), 'base64')
  } catch {
    return ''
  }
  if (!buffer.length || buffer.length > MAX_TOOL_IMAGE) return ''
  const dir = path.join(configDir, 'data', 'mcp-images')
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`)
  await fsp.writeFile(file, buffer)
  /* 只保留最近 50 张，避免工具图片无限堆积 */
  try {
    const files = (await fsp.readdir(dir)).filter((name) => !name.startsWith('.')).sort()
    for (const name of files.slice(0, Math.max(0, files.length - 50))) {
      await fsp.rm(path.join(dir, name), { force: true }).catch(() => {})
    }
  } catch { /* ignore */ }
  return file
}

/* 把 MCP 的 content 数组压成一段可读文本；图片落盘后把绝对路径写进结果，
   对话里的工具卡片会自动把该路径渲染成缩略图。 */
async function flattenContent (result, saveImage) {
  const content = (result && result.content) || []
  const parts = []
  for (const item of content) {
    if (!item) continue
    if (item.type === 'text') {
      parts.push(String(item.text || ''))
    } else if (item.type === 'image') {
      const saved = typeof saveImage === 'function' ? await saveImage(item.data, item.mimeType) : ''
      parts.push(saved ? `图片已保存：${saved}` : `[图片内容 ${item.mimeType || 'image'}，已省略]`)
    } else if (item.type === 'resource') {
      const resource = item.resource || {}
      const uri = resource.uri || ''
      if (resource.text) parts.push(`[资源 ${uri}]\n${String(resource.text).slice(0, 4000)}`)
      else if (resource.blob && String(resource.mimeType || '').startsWith('image/')) {
        const saved = typeof saveImage === 'function' ? await saveImage(resource.blob, resource.mimeType) : ''
        parts.push(saved ? `图片已保存：${saved}` : `[资源图片 ${uri || resource.mimeType}，已省略]`)
      } else {
        parts.push(`[资源 ${uri || resource.mimeType || ''}]`)
      }
    } else {
      parts.push(JSON.stringify(item).slice(0, 2000))
    }
  }
  if (!parts.length && result && result.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent).slice(0, 4000))
  }
  return parts.join('\n').trim()
}

function createMcpRegistry ({ configDir, allowedRoots, captureScreenshot, knowledge, knowledgeEnabled, memory, memoryEnabled, verifyApproval }) {
  const file = path.join(configDir, 'mcp.json')
  const roots = typeof allowedRoots === 'function' ? allowedRoots : () => (allowedRoots || [])
  let servers = []
  let builtinCfg = null
  const byId = new Map()

  function ensureBuiltin (list) {
    if (!list.some((s) => s.id === BUILTIN_ID)) {
      list.unshift({
        id: BUILTIN_ID,
        name: '本机工具',
        command: '',
        args: [],
        env: {},
        cwd: '',
        enabled: true,
        autoApprove: []
      })
    }
    return list
  }

  async function readConfig () {
    try {
      const raw = await fsp.readFile(file, 'utf8')
      const data = JSON.parse(raw)
      const list = Array.isArray(data && data.servers) ? data.servers : []
      return ensureBuiltin(list
        .filter((s) => s && typeof s.id === 'string' && s.id.trim())
        .map((s) => ({
          id: s.id.trim(),
          name: String(s.name || s.id).trim(),
          command: String(s.command || '').trim(),
          args: Array.isArray(s.args) ? s.args.map(String) : [],
          env: s.env && typeof s.env === 'object' ? s.env : {},
          cwd: typeof s.cwd === 'string' ? s.cwd : '',
          enabled: s.enabled !== false,
          autoApprove: Array.isArray(s.autoApprove) ? s.autoApprove.map(String) : []
        })))
    } catch {
      await fsp.mkdir(configDir, { recursive: true })
      await fsp.writeFile(file, JSON.stringify({ version: 1, servers: ensureBuiltin([]) }, null, 2), 'utf8')
      return ensureBuiltin([])
    }
  }

  async function writeConfig (list) {
    await fsp.mkdir(configDir, { recursive: true })
    await fsp.writeFile(file, JSON.stringify({ version: 1, servers: list }, null, 2), 'utf8')
  }

  async function reload () {
    for (const server of servers) await server.stop()
    servers = []
    byId.clear()

    const list = await readConfig()
    for (const cfg of list) {
      if (cfg.id === BUILTIN_ID) {
        builtinCfg = cfg
        continue
      }
      const server = new McpServer(cfg, () => {})
      servers.push(server)
      byId.set(cfg.id, server)
    }

    await Promise.all(servers.map((server) => (server.cfg.enabled === false ? Promise.resolve() : server.start())))
    return snapshot()
  }

  function builtinSnapshot () {
    const cfg = builtinCfg || { id: BUILTIN_ID, name: '本机工具', enabled: true, autoApprove: [] }
    const enabled = cfg.enabled !== false
    const allowKnowledge = typeof knowledgeEnabled !== 'function' || knowledgeEnabled()
    const allowMemory = typeof memoryEnabled !== 'function' || memoryEnabled()
    const tools = BUILTIN_TOOLS.filter((t) =>
      (!t.name.startsWith('kb_') || allowKnowledge) &&
      (!t.name.startsWith('memory_') || allowMemory) &&
      (!t.name.startsWith('security_') || allowMemory))
    return {
      id: BUILTIN_ID,
      name: cfg.name || '本机工具',
      command: '（内置）',
      args: [],
      enabled,
      autoApprove: cfg.autoApprove || [],
      status: enabled ? 'ready' : 'stopped',
      error: '',
      tools: enabled ? tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      })) : []
    }
  }

  function snapshot () {
    return {
      ok: true,
      configPath: file,
      servers: [builtinSnapshot(), ...servers.map((s) => s.snapshot())]
    }
  }

  async function call (request = {}) {
    const { serverId, tool, args, approvalToken, projectId, projectName, projectRoot } = request
    /* 只认主进程签发的令牌；缺失、过期、参数不一致、重复使用一律拒绝。
       渲染层传来的 approved:true 不会进入这里，也不会被当作授权。 */
    const approval = typeof verifyApproval === 'function'
      ? verifyApproval(approvalToken, request)
      : { ok: false, error: '审批校验器不可用' }
    if (!approval || approval.ok !== true) {
      return {
        ok: false,
        error: (approval && approval.error) || 'needs-approval',
        approvalDenied: true
      }
    }

    if (serverId === BUILTIN_ID) {
      const cfg = builtinCfg || { name: '本机工具', enabled: true, autoApprove: [] }
      if (cfg.enabled === false) return { ok: false, error: '内置文件工具已停用' }
      if (String(tool).startsWith('kb_') && typeof knowledgeEnabled === 'function' && !knowledgeEnabled()) {
        return { ok: false, error: '知识库插件当前未启用' }
      }
      if (String(tool).startsWith('memory_') && typeof memoryEnabled === 'function' && !memoryEnabled()) {
        return { ok: false, error: '记忆服务当前未启用（设置 → 记忆库）' }
      }
      if (String(tool).startsWith('security_') && typeof memoryEnabled === 'function' && !memoryEnabled()) {
        return { ok: false, error: '安全边界当前未启用（设置 → 记忆库）' }
      }
      if (!BUILTIN_TOOLS.some((t) => t.name === tool)) {
        return { ok: false, error: `内置工具没有「${tool}」` }
      }
      try {
        const text = await runBuiltinTool(tool, args || {}, roots(), {
          captureScreenshot,
          knowledge,
          memory,
          project: { projectId, projectName, projectRoot }
        })
        return { ok: true, text, server: cfg.name || '本机工具', tool, approvalId: approval.id }
      } catch (err) {
        return { ok: false, error: err.message, approvalId: approval.id }
      }
    }

    const server = byId.get(String(serverId || ''))
    if (!server) return { ok: false, error: '没有这个 MCP 服务器' }
    if (server.cfg.enabled === false) return { ok: false, error: `${server.cfg.name} 已停用` }
    if (server.status !== 'ready') return { ok: false, error: `服务器未就绪：${server.error || server.status}` }
    if (!server.tools.some((t) => t.name === tool)) return { ok: false, error: `服务器没有暴露工具「${tool}」` }

    try {
      const { result, isError } = await server.callTool(tool, args)
      const text = await flattenContent(result, (data, mimeType) => saveMcpImage(configDir, data, mimeType))
      return { ok: !isError, isError, text, server: server.cfg.name, tool, approvalId: approval.id }
    } catch (err) {
      return { ok: false, error: err.message, approvalId: approval.id }
    }
  }

  function isAutoApproved (serverId, tool) {
    if (serverId === BUILTIN_ID) {
      const cfg = builtinCfg || { autoApprove: [] }
      return (cfg.autoApprove || []).includes(tool)
    }
    const server = byId.get(String(serverId || ''))
    return Boolean(server && (server.cfg.autoApprove || []).includes(tool))
  }

  async function allowAlways (serverId, tool) {
    const id = String(serverId || '')
    const list = await readConfig()
    const cfg = list.find((s) => s.id === id)
    if (!cfg) return { ok: false, error: '没有这个 MCP 服务器' }
    if (!Array.isArray(cfg.autoApprove)) cfg.autoApprove = []
    if (!cfg.autoApprove.includes(tool)) cfg.autoApprove.push(tool)
    await writeConfig(list)
    if (id === BUILTIN_ID) {
      builtinCfg = cfg
    } else {
      const server = byId.get(id)
      if (server) server.cfg.autoApprove = cfg.autoApprove
    }
    return { ok: true, autoApprove: cfg.autoApprove }
  }

  async function setEnabled (serverId, enabled) {
    const list = await readConfig()
    const cfg = list.find((s) => s.id === serverId)
    if (!cfg) return { ok: false, error: '配置里找不到该服务器' }
    cfg.enabled = Boolean(enabled)
    await writeConfig(list)
    await reload()
    return snapshot()
  }

  async function shutdown () {
    await Promise.all(servers.map((s) => s.stop()))
  }

  return { reload, snapshot, call, isAutoApproved, allowAlways, setEnabled, shutdown, configPath: file }
}

module.exports = { createMcpRegistry, flattenContent, saveMcpImage }
