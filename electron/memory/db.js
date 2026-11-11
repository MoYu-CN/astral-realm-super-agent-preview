'use strict'

/**
 * 星界 · 记忆库存储层（P0 雏形）
 * 单文件 SQLite，位于 CONFIG_DIR/memory/memory.db。
 * 驱动用 Node 内置 node:sqlite；若打包 Electron 内不可用，只换本文件，上层接口不变。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const hardContext = require('./hard-context.js')

const SCHEMA_VERSION = 12

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_path TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  progress TEXT,
  main_agent_id TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  prefix TEXT NOT NULL,
  seq INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result TEXT,
  actor TEXT,
  summary TEXT,
  merged_into TEXT,
  metadata TEXT,
  UNIQUE (project_id, prefix, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_project_time ON events (project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_events_prefix ON events (prefix, seq);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  raised_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('接受', '拒绝', '已下发任务'))
);

CREATE TABLE IF NOT EXISTS dispatch_log (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  occurred_at TEXT NOT NULL,
  task TEXT NOT NULL,
  to_team TEXT
);

CREATE TABLE IF NOT EXISTS behavior_log (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  kind TEXT,
  signal TEXT,
  count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  domain TEXT,
  kind TEXT,
  body TEXT NOT NULL,
  applies_when TEXT,
  status TEXT NOT NULL DEFAULT '可用'
);

CREATE TABLE IF NOT EXISTS event_prefixes (
  prefix TEXT PRIMARY KEY,
  series TEXT NOT NULL,
  created_at TEXT NOT NULL,
  owner TEXT
);

CREATE TABLE IF NOT EXISTS diary_digest (
  id TEXT PRIMARY KEY,
  level TEXT,
  period TEXT,
  body TEXT,
  source_from TEXT,
  source_to TEXT
);

CREATE TABLE IF NOT EXISTS archive_manifest (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT,
  period TEXT,
  archived_at TEXT NOT NULL,
  project_hint TEXT
);

/* 完整原文：用户界面回看、显式引用和审计的唯一真相来源。
   写入后不可修改；上层摘要/浓缩版本只能引用它，不能覆盖它。 */
CREATE TABLE IF NOT EXISTS message_records (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  thread TEXT,
  role TEXT NOT NULL,
  sender TEXT,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_message_records_conversation ON message_records (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_records_created ON message_records (created_at);

/* 浓缩记忆：主智能体默认只看这里；它链接回 message_records.id。
   weight 不是固定常量，由主智能体或独立打分智能体动态写入。 */
CREATE TABLE IF NOT EXISTS message_digests (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  conversation_id TEXT,
  project_id TEXT,
  digest TEXT NOT NULL,
  weight REAL,
  weight_json TEXT,
  scorer TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_digests_message ON message_digests (message_id);
CREATE INDEX IF NOT EXISTS idx_message_digests_created ON message_digests (created_at);

/* 硬性上下文：每一轮都进入系统提示词的常驻四块。只保留当前版本 + 修订号，
   不存历史正文（历史版本属于审计，不在本库范围）。 */
CREATE TABLE IF NOT EXISTS hard_context (
  slot TEXT PRIMARY KEY,
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

/* ---------------------------------------------------------------- 权重网
   projects 只是节点表；真正决定「回忆谁」的是这两张表：
   project_terms 是每个项目的词向量（已按语料 idf 归一化），
   project_links 是项目两两之间的近似度。两者都由 reindex() 重算，
   只有 hits（一起被回忆的次数）是随时间累积、不会被重算覆盖的。 */
CREATE TABLE IF NOT EXISTS project_terms (
  project_id TEXT NOT NULL,
  term TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (project_id, term)
);
CREATE INDEX IF NOT EXISTS idx_terms_term ON project_terms (term);

CREATE TABLE IF NOT EXISTS project_links (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  weight REAL NOT NULL,
  lexical REAL NOT NULL DEFAULT 0,
  cooccur REAL NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_links_a ON project_links (a);
CREATE INDEX IF NOT EXISTS idx_links_b ON project_links (b);

/* 每次回忆留一行：查了什么、动了哪几个项目、花了多少字。
   只用于回看与调参，不参与打分。 */
CREATE TABLE IF NOT EXISTS recall_log (
  id TEXT PRIMARY KEY,
  queried_at TEXT NOT NULL,
  query TEXT NOT NULL,
  projects TEXT,
  chars INTEGER NOT NULL DEFAULT 0
);

/* ---------------------------------------------------------------- 事件网
   与项目网完全分开：项目与项目看「做的是不是同一件事」，
   事件与事件看「说的是不是同一件事」。各建各的索引、互不引用，
   避免一个项目名把同一项目下所有事件都连成一团。 */
CREATE TABLE IF NOT EXISTS event_terms (
  event_id TEXT NOT NULL,
  term TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (event_id, term)
);
CREATE INDEX IF NOT EXISTS idx_event_terms_term ON event_terms (term);

CREATE TABLE IF NOT EXISTS event_links (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  weight REAL NOT NULL,
  lexical REAL NOT NULL DEFAULT 0,
  cooccur REAL NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_event_links_a ON event_links (a);
CREATE INDEX IF NOT EXISTS idx_event_links_b ON event_links (b);

/* ---------------------------------------------------------------- 时间网
   week_docs 是「时间文档」：一周一篇，记录这一周实际发生了什么；
   time_slots 是按「周几 + 小时」切的习惯权重：周一 21 点通常在做哪个项目。
   两者都由事件时间戳派生，但独立成表，不参与项目网 / 事件网的打分。 */
CREATE TABLE IF NOT EXISTS week_docs (
  week TEXT PRIMARY KEY,
  from_at TEXT NOT NULL,
  to_at TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  stats TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  updated_at TEXT NOT NULL
);

/* 权重的键是「周几 + 小时」，活动只是这个时段下的候选：
   share   —— 在同一时段的历史里，这件事占多少（时段内的相对份额）；
   weeks   —— 它在多少个不同的周里、于同一时段重复出现（时间规律本身）；
   weight  —— share × 跨周可靠度，即「到这个点了，这件事有多确定」。
   同一晚写十条事件只算一周，不会把置信度刷成 100%。 */
CREATE TABLE IF NOT EXISTS time_slots (
  weekday INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'project',
  weight REAL NOT NULL,
  share REAL NOT NULL DEFAULT 0,
  reliability REAL NOT NULL DEFAULT 0,
  weeks INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL,
  last_at TEXT,
  PRIMARY KEY (weekday, hour, key)
);
CREATE INDEX IF NOT EXISTS idx_time_slots_slot ON time_slots (weekday, hour);

/* ---------------------------------------------------------------- 进程层
   时间网的第二条坐标：用户 / 项目在时间轴上走到哪一步。
   三张表都只从事件时间戳与事件内容派生，不参与项目网 / 事件网打分。
   时段回答「什么时候」，阶段回答「走到哪了」，两者一起决定该做什么。 */
CREATE TABLE IF NOT EXISTS phase_events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  at TEXT NOT NULL,
  weekday INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  phase TEXT NOT NULL,
  intent TEXT NOT NULL,
  seq_no INTEGER NOT NULL,
  span_days REAL NOT NULL,
  gap_days REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phase_events_project ON phase_events (project_id, at);

/* P(指令类型 | 阶段, 时段)。weekday=-1 / hour=-1 是不限时段的基线行；
   精确时段行的 weight 会向基线收缩，样本少时不硬编。 */
CREATE TABLE IF NOT EXISTS phase_probs (
  phase TEXT NOT NULL,
  intent TEXT NOT NULL,
  weekday INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  weight REAL NOT NULL,
  hits INTEGER NOT NULL,
  raw REAL NOT NULL,
  trend REAL NOT NULL DEFAULT 0,
  onset_seq REAL,
  onset_days REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (phase, intent, weekday, hour)
);
CREATE INDEX IF NOT EXISTS idx_phase_probs_lookup ON phase_probs (phase, weekday, hour);

/* 阶段迁移：项目走到第几条 / 第几天，开始需要下一类工作 */
CREATE TABLE IF NOT EXISTS phase_transitions (
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  hits INTEGER NOT NULL,
  weight REAL NOT NULL,
  avg_seq REAL NOT NULL DEFAULT 0,
  avg_days REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (from_phase, to_phase)
);

/* ---------------------------------------------------------------- 观察
   用户 / 超级智能体在对话里明确记下的「近期打算」，例如「今天想吃火锅」。
   它不进 events：事件条数会污染时段习惯与周记，观察只用于到点生成具体询问。
   聊天记录等敏感来源不会被自动抓取，只能经显式调用写入。 */
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  kind TEXT NOT NULL DEFAULT 'note',
  text TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  meta TEXT,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_observations_at ON observations (at DESC);

/* ---------------------------------------------------------------- 知识网
   第四张网。前三张网回答「做过什么、什么时候做、走到哪一步」，
   这张回答「这件事该怎么做」。

   知识正文仍是项目里的 Markdown（人可读、可随 git 提交），
   这里只存**索引与权重**：正文改了才重建词向量，其余时候只读这张表。

   weight 不是检索相关度，而是「这条知识本身值不值得先看」：
   trust（谁写的）× freshness（多久没用）× precision（被搜出来之后真被打开的比例）
   × completeness（四段是否写全）。检索时再乘查询相关度，两者不可互相替代：
   只按权重排会永远返回同一批老条目，只按相关度排则「用过很多次的坑」沉不下去。 */
CREATE TABLE IF NOT EXISTS kb_nodes (
  key TEXT PRIMARY KEY,              -- kb:<projectId>:<entryId> / global:<id>
  source TEXT NOT NULL DEFAULT 'kb', -- kb（项目知识库）/ global（knowledge 表）
  project_id TEXT,
  entry_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  digest TEXT NOT NULL DEFAULT '',   -- 一行摘要：检索时只给这一行，要正文再取
  chars INTEGER NOT NULL DEFAULT 0,  -- 正文长度：估算「取全量」要花多少上下文
  hash TEXT NOT NULL DEFAULT '',     -- 正文指纹：没变就不重建词向量
  trust REAL NOT NULL DEFAULT 1,
  completeness REAL NOT NULL DEFAULT 0.6,
  exposures INTEGER NOT NULL DEFAULT 0, -- 被检索出来的次数
  opens INTEGER NOT NULL DEFAULT 0,     -- 被真正打开的次数
  uses INTEGER NOT NULL DEFAULT 0,      -- 被引用进上下文的次数
  good INTEGER NOT NULL DEFAULT 0,      -- 明确说「有用」
  bad INTEGER NOT NULL DEFAULT 0,       -- 明确说「没用」
  last_open_at TEXT,
  last_use_at TEXT,
  created_at TEXT,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '可用'
);
CREATE INDEX IF NOT EXISTS idx_kb_nodes_project ON kb_nodes (project_id);
CREATE INDEX IF NOT EXISTS idx_kb_nodes_kind ON kb_nodes (kind);
CREATE INDEX IF NOT EXISTS idx_kb_nodes_status ON kb_nodes (status);

/* 与 project_terms / event_terms 同构：存归一化的 tf-idf 分量，点积即余弦 */
CREATE TABLE IF NOT EXISTS kb_terms (
  key TEXT NOT NULL,
  term TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (key, term)
);
CREATE INDEX IF NOT EXISTS idx_kb_terms_term ON kb_terms (term);

/* 知识条目之间「说的是不是同一件事」。只连同一项目内（全局知识算一个项目），
   不同项目的知识互不背书——否则一个「构建」会把所有项目的构建条目连成一团。 */
CREATE TABLE IF NOT EXISTS kb_links (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  weight REAL NOT NULL,
  lexical REAL NOT NULL DEFAULT 0,
  cooccur REAL NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_kb_links_a ON kb_links (a);
CREATE INDEX IF NOT EXISTS idx_kb_links_b ON kb_links (b);

/* 每次检索留一行：查了什么、给了哪几条、花了多少字。
   只用于回看与调参，不参与打分。 */
CREATE TABLE IF NOT EXISTS kb_hits (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  query TEXT NOT NULL,
  picked TEXT,
  chars INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_kb_hits_at ON kb_hits (at DESC);

/* ---------------------------------------------------------------- 收件箱
   第五张网，但它不是「网」——是入口。项目网记做过什么，事件网记同一件事，
   时间网记什么时候做，知识网记怎么做；这张只回答「外面发生了什么」。

   单独成表的理由和观察通道一样：消息量级比事件大两个数量级，
   混进 events 会把时段权重与阶段判断一起带偏。

   原文永远留在这里，不进上下文；越界的只有摘要（observations）、
   索引（threads）和一句「要不要问你」（route=alert）。 */
CREATE TABLE IF NOT EXISTS inbox_channels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                    -- catalog.js 里的渠道类型
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT,                           -- JSON；secret 字段不在这里
  status TEXT NOT NULL DEFAULT '待启动',
  last_at TEXT,                          -- 最后一次收到消息
  last_error TEXT,
  cursor TEXT,                           -- JSON：各适配器自己的增量水位
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id TEXT PRIMARY KEY,                   -- sha1(渠道+会话+消息id+时间)，天然去重
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'group',   -- private / group
  chat_id TEXT NOT NULL,
  chat_name TEXT,
  sender_id TEXT,
  sender_name TEXT,
  msg_id TEXT,
  at TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  attachments INTEGER NOT NULL DEFAULT 0,
  mentions_me INTEGER NOT NULL DEFAULT 0,
  route TEXT NOT NULL DEFAULT 'archive', -- alert / observe / knowledge / archive
  reason TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  handled_at TEXT,                       -- 被提升成观察 / 提醒后回填
  raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_at ON inbox_messages (at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_chat ON inbox_messages (chat_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_route ON inbox_messages (route, at DESC);

/* 一个会话一行：未读数、最后一条、自己长出来的权重。
   权重只用于排序「先看哪个群」，不参与是否提醒——提醒只看单条。 */
CREATE TABLE IF NOT EXISTS inbox_threads (
  id TEXT PRIMARY KEY,                   -- channelId:chatId
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  name TEXT,
  scope TEXT NOT NULL DEFAULT 'group',
  total INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  alerts INTEGER NOT NULL DEFAULT 0,
  weight REAL NOT NULL DEFAULT 1,
  last_text TEXT,
  last_at TEXT,
  muted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inbox_threads_last ON inbox_threads (last_at DESC);

/* ---------------------------------------------------------------- 安全边界
   三张表合起来回答一件事：「AI 把什么发了出去，谁点头的，出了事能不能说清。」

   security_gates —— 出站闸门。只记「需要人点头」的那几次：命中什么（脱敏后）、
                     发给谁、谁批的、什么时候作废。正文只留指纹不留原文 ——
                     为了安全先把密钥收一遍，是这件事最容易闹的笑话。
   security_tasks —— 留痕任务。可变索引：候选 / 进行中 / 已归档。
   security_ledger —— 账本。只追加的哈希链，每一行都把上一行的哈希算进自己。
                     改任何一行，后面全对不上；删一行，链就断在删除的位置。
                     数据库层用触发器禁掉 UPDATE / DELETE，不靠自觉。 */
CREATE TABLE IF NOT EXISTS security_gates (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'outbound',   -- outbound / reply / tool
  exposure TEXT NOT NULL DEFAULT 'send',   -- send（往外送）/ pull（只查不送）/ none
  target TEXT NOT NULL DEFAULT '',         -- 发到哪：群 / 人 / 工具名
  channel TEXT NOT NULL DEFAULT '',        -- 渠道 id 或 MCP 服务名
  purpose TEXT NOT NULL DEFAULT '',        -- 调用方自己写的「为什么要发」
  task_id TEXT,
  run_id TEXT,
  project_id TEXT,
  verdict TEXT NOT NULL DEFAULT 'allow',   -- allow / confirm / deny
  status TEXT NOT NULL DEFAULT 'auto',     -- auto / pending / approved / denied / used / expired
  risk TEXT NOT NULL DEFAULT 'none',       -- none / low / medium / high / critical
  hits TEXT,                               -- JSON：[{type,label,count,samples}]，只有脱敏片段
  digest TEXT NOT NULL DEFAULT '',         -- sha256(kind|target|正文)：批准绑死在这一份内容上
  preview TEXT NOT NULL DEFAULT '',        -- 脱敏后的前 160 字，够用户判断就行
  chars INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  decided_at TEXT,
  decided_by TEXT,                         -- user / rule / timeout
  decision_scope TEXT,                     -- once / type
  used_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_gates_status ON security_gates (status, at DESC);
CREATE INDEX IF NOT EXISTS idx_security_gates_digest ON security_gates (digest);

CREATE TABLE IF NOT EXISTS security_tasks (
  id TEXT PRIMARY KEY,                     -- A-20261111-01
  status TEXT NOT NULL DEFAULT 'candidate',-- candidate / open / dropped / closed
  created_at TEXT NOT NULL,
  opened_at TEXT,
  closed_at TEXT,
  title TEXT NOT NULL DEFAULT '',
  ask TEXT NOT NULL DEFAULT '',            -- 原话。留痕的本意就是「他当时确实是这么说的」
  from_name TEXT,
  from_id TEXT,
  channel TEXT,
  chat TEXT,
  message_id TEXT,
  deadline TEXT,
  expect TEXT,
  outcome TEXT,
  entries INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT,
  event_id TEXT,                           -- 压缩进事件网的那条事件
  event_code TEXT,                         -- LZ001：给用户看的编号
  digested_at TEXT,
  last_digest_seq INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_tasks_status ON security_tasks (status, created_at DESC);

CREATE TABLE IF NOT EXISTS security_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- task / understand / action / outbound / approval / close / correct / note
  task_id TEXT,
  actor TEXT NOT NULL DEFAULT 'user',      -- user / agent / channel:<id> / system
  title TEXT NOT NULL DEFAULT '',
  body TEXT,                               -- JSON
  refs TEXT,                               -- JSON：inbox 消息 / gate / run / tool
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_ledger_task ON security_ledger (task_id, seq);
CREATE INDEX IF NOT EXISTS idx_security_ledger_at ON security_ledger (at DESC);

CREATE TRIGGER IF NOT EXISTS security_ledger_no_update
BEFORE UPDATE ON security_ledger
BEGIN
  SELECT RAISE(ABORT, 'security_ledger 只追加，不允许修改');
END;

CREATE TRIGGER IF NOT EXISTS security_ledger_no_delete
BEFORE DELETE ON security_ledger
BEGIN
  SELECT RAISE(ABORT, 'security_ledger 只追加，不允许删除');
END;
`

function createDb ({ configDir, dbPath } = {}) {
  if (!configDir && !dbPath) throw new Error('createDb 需要 configDir 或 dbPath')
  const file = dbPath || path.join(configDir, 'memory', 'memory.db')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA foreign_keys = ON;')

  /* 升级前先读旧版本：v1 → v2 才补种硬性上下文；用户清空后不会每次启动又塞回来 */
  const previous = Number(db.prepare('PRAGMA user_version').get().user_version || 0)
  db.exec(SCHEMA)
  /* v4 → v5：时间网改成「按时段 + 跨周重复」计权，补三列。
     这张表是纯派生缓存，syncTime 会整体 DELETE 重插，旧数值无需迁移。 */
  if (previous < 5) {
    const columns = new Set(db.prepare('PRAGMA table_info(time_slots)').all().map((c) => c.name))
    for (const [name, ddl] of [
      ['share', 'REAL NOT NULL DEFAULT 0'],
      ['reliability', 'REAL NOT NULL DEFAULT 0'],
      ['weeks', 'INTEGER NOT NULL DEFAULT 0']
    ]) {
      if (!columns.has(name)) db.exec('ALTER TABLE time_slots ADD COLUMN ' + name + ' ' + ddl)
    }
  }
  /* v10 → v11：留痕压缩进事件网，任务上多记「压到哪条事件」与「压到第几条账本」。
     旧库补列即可，历史任务在下次打开设置页时按需补压。 */
  if (previous < 11) {
    const columns = new Set(db.prepare('PRAGMA table_info(security_tasks)').all().map((c) => c.name))
    for (const [name, ddl] of [
      ['event_id', 'TEXT'],
      ['event_code', 'TEXT'],
      ['digested_at', 'TEXT'],
      ['last_digest_seq', 'INTEGER NOT NULL DEFAULT 0']
    ]) {
      if (!columns.has(name)) db.exec('ALTER TABLE security_tasks ADD COLUMN ' + name + ' ' + ddl)
    }
  }
  /* 旧库在 v10 时没有 event_code，索引必须放在补列之后；
     否则 CREATE TABLE/INDEX 阶段会先报 no such column，升级直接中断。 */
  db.exec('CREATE INDEX IF NOT EXISTS idx_security_tasks_event ON security_tasks (event_code);')
  if (previous < 2) hardContext.seed(db)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)

  return {
    db,
    file,
    version: SCHEMA_VERSION,
    previousVersion: previous,
    close () { db.close() }
  }
}

module.exports = { createDb, SCHEMA, SCHEMA_VERSION }
