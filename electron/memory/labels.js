'use strict'

/**
 * 星界 · 记忆库字段中文元数据
 *
 * 一处定义，服务端（view-server / 主进程 host）与前端（控制台）共用：
 *   - 表名 → 中文
 *   - 列名 → 中文（按表区分，同名列可有不同说法）
 *   - 枚举值 → 中文（库内仍存英文/原值，只在展示层翻译）
 *
 * 原则：只做展示翻译，不改变数据本身，也不参与任何检索条件。
 */

const TABLES = [
  { name: 'projects', label: '项目', hint: '项目档案：简介与开发进度' },
  { name: 'events', label: '事件', hint: '操作即事件，按编号前缀分系列' },
  { name: 'proposals', label: '提议', hint: '向用户提出的建议及结果' },
  { name: 'dispatch_log', label: '派发记录', hint: '派给哪个团队、派了什么' },
  { name: 'behavior_log', label: '行为日记', hint: '主动性信号：喜欢 / 不喜欢' },
  { name: 'knowledge', label: '知识库', hint: '纯工具，与项目无关联' },
  { name: 'event_prefixes', label: '编号前缀表', hint: '超级智能体自行维护的系列表' },
  { name: 'diary_digest', label: '摘要', hint: '日 / 周 / 月压缩结果' },
  { name: 'archive_manifest', label: '封存清单', hint: '封存文件的位置与元数据' },
  { name: 'project_terms', label: '权重 · 词向量', hint: '每个项目的关键词与 tf-idf 分量' },
  { name: 'project_links', label: '权重 · 连边', hint: '项目两两之间的近似度与共现次数' },
  { name: 'event_terms', label: '事件网 · 词向量', hint: '每条事件的关键词与 tf-idf 分量' },
  { name: 'event_links', label: '事件网 · 连边', hint: '事件两两之间的近似度（与项目网分开）' },
  { name: 'week_docs', label: '时间文档 · 周记', hint: '按周记录这一周实际做了什么' },
  { name: 'time_slots', label: '时间网 · 时段', hint: '周几几点通常在做哪个项目' },
  { name: 'phase_events', label: '进程 · 轨迹', hint: '每条事件发生时，项目走到哪一步、给的是什么指令' },
  { name: 'phase_probs', label: '进程 · 条件概率', hint: '某个阶段 + 时段下，各类指令的概率与起始点' },
  { name: 'phase_transitions', label: '进程 · 阶段迁移', hint: '项目走到第几条 / 第几天会进入下一阶段' },
  { name: 'observations', label: '时间网 · 近期观察', hint: '用户明确记下的打算，到点据此生成具体询问' },
  { name: 'recall_log', label: '回忆记录', hint: '每次按权重网回忆查了什么、动了哪几个项目' }
]

/* 同名列在不同表里的说法不一样，所以按表写；缺省回落到 COMMON */
const COMMON = {
  id: '编号',
  created_at: '创建时间',
  metadata: '附加数据'
}

const COLUMNS = {
  projects: {
    id: '项目编号',
    name: '项目名称',
    folder_path: '项目目录',
    created_at: '创建时间',
    status: '状态',
    summary: '项目简介',
    progress: '开发进度',
    main_agent_id: '主智能体'
  },
  events: {
    id: '事件编号',
    project_id: '所属项目',
    prefix: '动作前缀',
    seq: '序号',
    started_at: '开始时间',
    ended_at: '结束时间',
    result: '结果',
    actor: '上报者',
    summary: '事件内容',
    merged_into: '合并到',
    metadata: '附加数据'
  },
  proposals: {
    id: '提议编号',
    project_id: '所属项目',
    raised_at: '提出时间',
    result: '结果'
  },
  dispatch_log: {
    id: '派发编号',
    project_id: '所属项目',
    occurred_at: '派发时间',
    task: '派发任务',
    to_team: '接手团队'
  },
  behavior_log: {
    id: '记录编号',
    occurred_at: '发生时间',
    kind: '行为类型',
    signal: '偏好信号',
    count: '次数'
  },
  knowledge: {
    id: '知识编号',
    domain: '领域',
    kind: '类型',
    body: '知识正文',
    applies_when: '适用条件',
    status: '状态'
  },
  event_prefixes: {
    prefix: '动作前缀',
    series: '系列名称',
    created_at: '创建时间',
    owner: '维护者'
  },
  diary_digest: {
    id: '摘要编号',
    level: '层级',
    period: '周期',
    body: '摘要正文',
    source_from: '起始来源',
    source_to: '截止来源'
  },
  archive_manifest: {
    id: '封存编号',
    path: '文件路径',
    kind: '类型',
    period: '时期',
    archived_at: '封存时间',
    project_hint: '所属项目线索'
  },
  project_terms: {
    project_id: '所属项目',
    term: '关键词',
    weight: '权重'
  },
  project_links: {
    a: '项目 A',
    b: '项目 B',
    weight: '综合权重',
    lexical: '内容近似',
    cooccur: '共现权重',
    hits: '一起回忆次数',
    updated_at: '更新时间'
  },
  event_terms: {
    event_id: '所属事件',
    term: '关键词',
    weight: '权重'
  },
  event_links: {
    a: '事件 A',
    b: '事件 B',
    weight: '综合权重',
    lexical: '内容近似',
    cooccur: '共现权重',
    hits: '一起回忆次数',
    updated_at: '更新时间'
  },
  week_docs: {
    week: '周编号',
    from_at: '周一',
    to_at: '周日',
    body: '周记正文',
    stats: '统计',
    source: '来源',
    updated_at: '更新时间'
  },
  time_slots: {
    weekday: '周几',
    hour: '小时',
    key: '当时在做',
    kind: '类型',
    weight: '时间置信度',
    share: '时段内占比',
    reliability: '跨周可靠度',
    weeks: '跨了几周',
    hits: '事件条数',
    last_at: '最近一次'
  },
  phase_events: {
    id: '事件编号',
    project_id: '所属项目',
    at: '发生时间',
    weekday: '周几',
    hour: '小时',
    phase: '当时阶段',
    intent: '指令类型',
    seq_no: '项目内第几条',
    span_days: '距首次天数',
    gap_days: '距上条天数'
  },
  phase_probs: {
    phase: '阶段',
    intent: '指令类型',
    weekday: '周几（-1 不限）',
    hour: '小时（-1 不限）',
    weight: '条件概率',
    hits: '样本数',
    raw: '近因权重',
    trend: '近期漂移',
    onset_seq: '通常第几条开始',
    onset_days: '通常第几天开始',
    updated_at: '更新时间'
  },
  phase_transitions: {
    from_phase: '从阶段',
    to_phase: '到阶段',
    hits: '迁移次数',
    weight: '迁移概率',
    avg_seq: '平均第几条',
    avg_days: '平均第几天',
    updated_at: '更新时间'
  },
  observations: {
    id: '编号',
    at: '记录时间',
    source: '来源',
    kind: '类型',
    text: '内容',
    weight: '新鲜度',
    meta: '附加数据',
    used_at: '已用时间'
  },
  recall_log: {
    id: '编号',
    queried_at: '回忆时间',
    query: '查询内容',
    projects: '命中的项目',
    chars: '返回字数'
  }
}

/* 枚举值翻译：库内保留原值，展示时翻译。键为「表.列」。 */
const WEEKDAYS = {
  1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日'
}
const VALUES = {
  'projects.status': {
    active: '进行中',
    paused: '已暂停',
    done: '已完成',
    archived: '已归档'
  },
  'events.actor': {
    super: '超级智能体',
    executor: '执行层智能体',
    external: '外部调用'
  },
  'diary_digest.level': {
    day: '日摘要',
    week: '周摘要',
    month: '月摘要'
  },
  'time_slots.weekday': WEEKDAYS,
  'phase_events.weekday': WEEKDAYS,
  'phase_probs.weekday': WEEKDAYS,
  'time_slots.kind': {
    project: '项目',
    series: '事件系列',
    other: '其他'
  },
  'observations.source': {
    chat: '聊天',
    manual: '手动',
    scout: '探子'
  },
  'observations.kind': {
    meal: '吃饭打算',
    task: '待办',
    preference: '偏好',
    note: '其他'
  },
  'week_docs.source': {
    auto: '自动生成',
    manual: '手动改写'
  }
}

const TIME_COLUMNS = new Set([
  'created_at', 'started_at', 'ended_at', 'raised_at',
  'occurred_at', 'archived_at', 'source_from', 'source_to'
])

function tableLabel (name) {
  const t = TABLES.find((x) => x.name === name)
  return t ? t.label : String(name || '')
}

function tableHint (name) {
  const t = TABLES.find((x) => x.name === name)
  return t ? t.hint : ''
}

function columnLabel (name, column) {
  const byTable = COLUMNS[name] || {}
  return byTable[column] || COMMON[column] || String(column || '')
}

function columnLabels (name) {
  const byTable = COLUMNS[name] || {}
  const out = {}
  for (const key of Object.keys(byTable)) out[key] = byTable[key]
  return out
}

function isTimeColumn (column) {
  return TIME_COLUMNS.has(String(column || ''))
}

function valueLabel (name, column, value) {
  if (value === null || value === undefined || value === '') return value
  const dict = VALUES[name + '.' + column]
  if (!dict) return value
  return dict[String(value)] || value
}

/* 某张表用到的枚举字典：{ 列名: { 原值: 中文 } }，供前端展示层翻译 */
function valuesFor (name) {
  const out = {}
  const prefix = String(name || '') + '.'
  for (const key of Object.keys(VALUES)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = VALUES[key]
  }
  return out
}

module.exports = {
  TABLES,
  COLUMNS,
  VALUES,
  COMMON,
  tableLabel,
  tableHint,
  columnLabel,
  columnLabels,
  isTimeColumn,
  valueLabel,
  valuesFor
}
