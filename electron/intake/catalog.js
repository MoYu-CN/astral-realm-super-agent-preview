'use strict'

/**
 * intake/catalog.js — 消息渠道目录（唯一契约）
 *
 * 这里只描述「有哪些渠道、每个渠道能做什么、要配什么」，不含任何实现。
 * 新增一种渠道 = 在这里加一条 + adapters/ 下加一个实现，核心与界面都不改。
 *
 * 能力位刻意拆细：能不能收、能不能发、有没有历史、是不是实时、能不能拿到 @。
 * 界面按能力位渲染，用户一眼能看出「这条渠道能给我什么」，而不是被文案糊住。
 *
 * 风险等级不是免责声明，是排序依据：
 *   safe    —— 官方接口，封号风险为零
 *   caution —— 不联网、只读本机数据；违反用户协议，但不会触发风控
 *   risky   —— 以你的账号身份连服务器，有封号可能
 */

const RISK = {
  safe: { level: 'safe', label: '官方', hint: '走官方接口，不影响账号' },
  caution: { level: 'caution', label: '只读', hint: '读本机数据，不联网、不发消息；属逆向，版本升级可能失效' },
  risky: { level: 'risky', label: '有风险', hint: '以账号身份登录协议，可能被封；只建议用小号' }
}

/* 字段类型：text / password / number / boolean / select / path
   secret: true 的字段落盘时走加密存储，界面上只显示「已设置」。 */
const KINDS = [
  {
    id: 'wechat-personal',
    label: '微信 · 个人号',
    vendor: '微信',
    summary: '读本机微信的聊天库，拿到全部历史与群聊；只读、不登录、不发消息。',
    transport: 'local-db',
    risk: 'caution',
    scope: ['private', 'group'],
    capabilities: { receive: true, send: false, history: true, realtime: false, mentions: true },
    timing: '每 60 秒增量拉一次',
    note: '微信 4.x 的库是 SQLCipher 加密的，密钥在进程内存里。我们只解密到自己的副本，原件一个字节不动。图片目前无公开解法，只存占位。',
    fields: [
      { key: 'backend', label: '读取方式', type: 'select', default: 'auto', options: [
        { value: 'auto', label: '自动（有命令用命令，否则用 chatlog）' },
        { value: 'command', label: '自定义桥接命令' },
        { value: 'chatlog', label: '本机 chatlog 服务' }
      ], hint: '我们不打包任何解密工具：要么给一个输出 JSONL 的命令，要么指向你已经跑起来的 chatlog' },
      { key: 'bridgeCmd', label: '外部桥接命令', type: 'text', placeholder: '留空使用 chatlog 服务', hint: '约定：`<命令> --since <ISO 或 0>`，stdout 每行一条 JSON' },
      { key: 'chatlogUrl', label: 'chatlog 服务地址', type: 'text', placeholder: 'http://127.0.0.1:5030' },
      { key: 'dbRoot', label: '微信数据目录', type: 'path', placeholder: '留空自动探测 Documents\\xwechat_files', hint: '指向 db_storage；不确定就留空' },
      { key: 'pollSeconds', label: '拉取间隔（秒）', type: 'number', default: 60, hint: '最小 15 秒。太密没有意义，微信自己也是懒加载' },
      { key: 'includeGroups', label: '包含群聊', type: 'boolean', default: true, hint: '关掉只收单聊' }
    ]
  },
  {
    id: 'wecom',
    label: '企业微信',
    vendor: '企业微信',
    summary: '官方自建应用回调，收同事与应用的单聊；群聊需另开会话内容存档。',
    transport: 'callback',
    risk: 'safe',
    scope: ['private', 'group'],
    capabilities: { receive: true, send: true, history: false, realtime: true, mentions: false },
    timing: '实时（微信服务器推过来）',
    note: '群聊要走「会话内容存档」，需要企业认证与按坐席付费，且成员要同意。先配单聊就够用。',
    fields: [
      { key: 'corpId', label: '企业 ID', type: 'text', required: true, placeholder: 'ww开头的一串' },
      { key: 'agentId', label: '应用 AgentId', type: 'text', required: true },
      { key: 'secret', label: '应用 Secret', type: 'password', required: true, secret: true },
      { key: 'callbackToken', label: '回调 Token', type: 'password', secret: true, hint: '应用详情 → 接收消息 → API 接收' },
      { key: 'aesKey', label: '回调 EncodingAESKey', type: 'password', secret: true, hint: '43 位，同上位置' },
      { key: 'archive', label: '启用会话存档', type: 'boolean', default: false, hint: '需要企业已开通该功能并完成认证' }
    ]
  },
  {
    id: 'qq-personal',
    label: 'QQ · 个人号',
    vendor: 'QQ',
    summary: '通过 OneBot 协议接个人 QQ，实时收到全部群消息；能发消息。',
    transport: 'websocket',
    risk: 'risky',
    scope: ['private', 'group'],
    capabilities: { receive: true, send: true, history: false, realtime: true, mentions: true },
    timing: '实时（WebSocket 长连接）',
    note: '底层是 NTQQ 客户端注入，腾讯视为外挂。社区统计封号概率很高，务必用小号。主号不要用。',
    fields: [
      { key: 'wsUrl', label: 'OneBot 地址', type: 'text', required: true, placeholder: 'ws://127.0.0.1:3001', hint: 'NapCat / Lagrange / LLOneBot 的「正向 WebSocket」服务端' },
      { key: 'accessToken', label: 'Access Token', type: 'password', secret: true, hint: '在 OneBot 端配置了才填' },
      { key: 'selfId', label: '机器人 QQ 号', type: 'text', hint: '留空则从连接信息里取' },
      { key: 'allowSend', label: '允许代发消息', type: 'boolean', default: false, hint: '默认关。发出去收不回来，建议一直关着' }
    ]
  },
  {
    id: 'qq-official',
    label: 'QQ · 官方机器人',
    vendor: 'QQ',
    summary: '官方开放平台机器人，群内 @ 才推送；无封号风险。',
    transport: 'websocket',
    risk: 'safe',
    scope: ['private', 'group'],
    capabilities: { receive: true, send: true, history: false, realtime: true, mentions: true },
    timing: '实时（官方网关）',
    note: '一个 QQ 号最多建 5 个机器人。2026-06 起群主动推送需要群主手动开启，默认只能被动应答 @。',
    fields: [
      { key: 'appId', label: 'AppID', type: 'text', required: true },
      { key: 'appSecret', label: 'AppSecret', type: 'password', required: true, secret: true },
      { key: 'sandbox', label: '沙箱环境', type: 'boolean', default: false },
      { key: 'allowSend', label: '允许代发消息', type: 'boolean', default: false }
    ]
  },
  {
    id: 'notify-relay',
    label: '手机通知转发',
    vendor: '通用',
    summary: '手机把通知栏内容 POST 过来，覆盖「电脑没登录、只有手机收到」的场景。',
    transport: 'http',
    risk: 'safe',
    scope: ['private', 'group'],
    capabilities: { receive: true, send: false, history: false, realtime: true, mentions: false },
    timing: '实时（手机推过来）',
    note: '拿不到上下文，只有那一行通知。适合当触发器：先记「谁在哪个群说了什么」，真要看再回读库或读屏。',
    fields: [
      { key: 'token', label: '接收令牌', type: 'password', secret: true, hint: '留空自动生成；手机端把它放在 URL 或 X-Astral-Token 头里' },
      { key: 'allowLan', label: '允许局域网访问', type: 'boolean', default: false, hint: '关着只有本机能推；开了手机才能直连，注意同一网络' }
    ]
  },
  {
    id: 'webhook',
    label: '通用 Webhook',
    vendor: '通用',
    summary: '任何能发 HTTP 请求的东西都能接进来：RSS 转推、IFTTT、脚本、其它机器人。',
    transport: 'http',
    risk: 'safe',
    scope: ['private', 'group'],
    capabilities: { receive: true, send: false, history: false, realtime: true, mentions: false },
    timing: '实时',
    note: '最省事的一种：`curl -X POST .../hook/<渠道id> -d \'{"text":"..."}\'`。字段能认出 text/chat/sender 就按语义存，认不出就整条当正文。',
    fields: [
      { key: 'token', label: '接收令牌', type: 'password', secret: true, hint: '留空自动生成' },
      { key: 'allowLan', label: '允许局域网访问', type: 'boolean', default: false },
      { key: 'defaultScope', label: '默认归类', type: 'select', default: 'group', options: [
        { value: 'group', label: '群聊' },
        { value: 'private', label: '单聊' }
      ] }
    ]
  }
]

const BY_ID = new Map(KINDS.map((kind) => [kind.id, kind]))

function get (id) {
  return BY_ID.get(String(id || '')) || null
}

function list () {
  return KINDS.map((kind) => ({
    ...kind,
    risk: RISK[kind.risk] ? { ...RISK[kind.risk] } : RISK.caution
  }))
}

/** 能力位合并成一句人话，界面用来做副标题。 */
function capabilityText (kind) {
  const cap = kind.capabilities || {}
  const parts = []
  parts.push(cap.receive ? '能收' : '不能收')
  if (cap.history) parts.push('含历史')
  if (cap.send) parts.push('能发')
  if (cap.realtime) parts.push('实时')
  return parts.join(' · ')
}

/** 按字段定义把用户输入清洗成可落盘的配置；secret 字段单独返回。 */
function splitConfig (kind, input = {}) {
  const config = {}
  const secrets = {}
  for (const field of kind.fields || []) {
    const raw = input[field.key]
    if (raw === undefined || raw === null || raw === '') {
      if (field.default !== undefined) config[field.key] = field.default
      continue
    }
    let value = raw
    if (field.type === 'number') {
      value = Number(raw)
      if (!Number.isFinite(value)) value = field.default
    } else if (field.type === 'boolean') {
      value = raw === true || raw === 'true' || raw === 'on' || raw === 1
    } else {
      value = String(raw).trim()
    }
    if (field.secret) secrets[field.key] = value
    else config[field.key] = value
  }
  return { config, secrets }
}

/** 必填校验：只查 required 且没给值的。 */
function validate (kind, config = {}, secrets = {}) {
  const missing = []
  for (const field of kind.fields || []) {
    if (!field.required) continue
    const value = field.secret ? secrets[field.key] : config[field.key]
    if (value === undefined || value === null || String(value).trim() === '') missing.push(field.label || field.key)
  }
  return missing.length ? { ok: false, error: '还缺：' + missing.join('、'), missing } : { ok: true }
}

module.exports = { KINDS, RISK, get, list, capabilityText, splitConfig, validate }
