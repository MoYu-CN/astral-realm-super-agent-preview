import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ConfigStore, DEFAULT_CONFIG } from "./kb-config.mjs";
import { KnowledgeBase, KINDS, KB_DIR_NAME, parseEntryId } from "./kb-store.mjs";

const require = createRequire(import.meta.url);
const kbIndex = require("../memory/kb-index.js");

const OUTLINE_NAME = "00-开始这里-总纲.md";
const INDEX_NAME = { 方法: "00-方法主体.md", 避错: "00-避错主体.md" };

const OUTLINE_TEXT = `# 知识库总纲

本目录是**项目级知识库**：可复用的做法放「方法/」，踩过的坑放「避错/」。

## 结构

\`\`\`
知识库/
├── 00-开始这里-总纲.md      ← 本文件
├── 方法/
│   ├── 00-方法主体.md
│   └── 方法-01-【领域】.md
└── 避错/
    ├── 00-避错主体.md
    └── 避错-01-【领域】.md
\`\`\`

## 规则

- \`M-0XX\` = 方法，\`P-0XX\` = 避错；三位数从 001 起，只增不改。
- 按领域分册，不按时间分册；每册装满即开新册。
- 每新增一条，必须同步更新对应的主体索引。
- 避错条目四段必填：触发条件 / 先做 / 为什么 / 违规症状。
- 可用工具：kb_guide / kb_search / kb_add / kb_list / kb_get / kb_remove / kb_prune / kb_init。

动手前先用 \`kb_guide\` 按正在做的事查；要回答「这个项目以前提过吗」用 \`kb_search\`。
`;

function safeId(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "default";
}

function defaultIndex(kind, volumePerBook) {
  return `# ${kind}分册索引\n\n` +
    `> 落笔规则：按**领域**分册（不按时间）；每册约 ${volumePerBook} 条，装满即开新册；\n` +
    `> 编号全局连续、只增不改。每新增一条，**必须同步更新下表**。\n\n` +
    `| 册名 | 覆盖领域 | 编号区间 | 什么时候读它 |\n|---|---|---|---|\n`;
}

function formatEntryLine(entry) {
  const trigger = entry.trigger ? `触发：${entry.trigger}` : "";
  const steps = Array.isArray(entry.steps) && entry.steps.length
    ? `先做：${entry.steps.slice(0, 3).join("；")}`
    : "";
  const why = entry.why ? `为什么：${entry.why}` : "";
  return [`### ${entry.id} ${entry.title}`, [trigger, steps, why].filter(Boolean).join("\n")].filter(Boolean).join("\n");
}

export function createKnowledgeService({ configDir, memory = null }) {
  const dataDir = path.join(configDir, "knowledge-plugin");
  const fallbackRoots = path.join(configDir, "project-knowledge");
  const configStore = new ConfigStore(dataDir);
  configStore.load();
  const cache = new Map();
  /** 每个库上一次同步索引时的文件签名：没变就不重读正文 */
  const indexSign = new Map();
  /** 索引不可用时的降级原因（会如实带回给调用方，不静默） */
  let indexError = "";

  /**
   * 记忆库句柄。可能为 null（记忆库被关掉 / 单测没注入）——
   * 此时知识库退回关键词检索，功能不残，只是没有权重。
   */
  function store() {
    if (typeof memory === "function") {
      try {
        return memory() || null;
      } catch (err) {
        indexError = err?.message || String(err);
        return null;
      }
    }
    return memory || null;
  }

  function settingsFile() {
    return path.join(configDir, "settings.json");
  }

  function pluginEnabled() {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
      return settings?.plugins?.knowledge?.enabled !== false;
    } catch {
      return true;
    }
  }

  function context(raw = {}) {
    const projectId = safeId(raw.projectId);
    const projectName = String(raw.projectName || "").trim() || "默认项目";
    const provided = String(raw.projectRoot || "").trim();
    const projectRoot = provided
      ? path.resolve(provided)
      : path.join(fallbackRoots, projectId);
    return { projectId, projectName, projectRoot };
  }

  function kbFor(ctx) {
    const key = `${ctx.projectRoot.toLowerCase()}|${ctx.projectName}`;
    let kb = cache.get(key);
    const config = configStore.get();
    if (!kb) {
      kb = new KnowledgeBase(ctx.projectRoot, config, ctx.projectName);
      cache.set(key, kb);
    } else {
      kb.applyConfig(config);
    }
    return kb;
  }

  function existingKb(ctx) {
    const kb = kbFor(ctx);
    if (!fs.existsSync(kb.dir)) return null;
    kb.load();
    return kb;
  }

  function counts(kb) {
    const list = kb.list();
    return {
      方法: list.filter((entry) => entry.kind === "方法").length,
      避错: list.filter((entry) => entry.kind === "避错").length,
      total: list.length
    };
  }

  /* ---------------------------------------------------------------- 索引同步
   *
   * 正文在 Markdown，索引在 memory.db 的 kb_nodes。两者必须对齐，
   * 但「每次检索都读全部 md」在库变大后会明显变慢 —— 用文件签名短路：
   * 只有分册的 mtime / size 变了才重读正文并重算词向量。
   *
   * 签名只看 stat，不看内容，所以「几十条的小库」基本零成本；
   * 真正改动时才付一次全量读取的钱，而那一次本来就要写文件。
   */

  function dirSignature(kb) {
    const parts = [];
    for (const kind of KINDS) {
      let names = [];
      try {
        names = fs.readdirSync(path.join(kb.dir, kind));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".md") || name === INDEX_NAME[kind]) continue;
        try {
          const st = fs.statSync(path.join(kb.dir, kind, name));
          parts.push(`${kind}/${name}:${Math.round(st.mtimeMs)}:${st.size}`);
        } catch {
          /* 文件刚被删：下一轮签名自然会变 */
        }
      }
    }
    return parts.sort().join("|");
  }

  function entriesOf(kb, projectId) {
    const out = [];
    for (const item of kb.list()) {
      const entry = kb.get(item.id);
      if (!entry) continue;
      out.push({
        source: "kb",
        projectId,
        entryId: item.id,
        kind: item.kind,
        domain: item.domain || "",
        entry,
        trust: 1
      });
    }
    return out;
  }

  function syncIndex(ctx, kb) {
    const s = store();
    if (!s) return { ok: false, reason: indexError || "记忆库不可用，知识库退回关键词检索" };
    if (!kb || !fs.existsSync(kb.dir)) return { ok: true, skipped: true, total: 0 };
    const sign = dirSignature(kb);
    if (indexSign.get(ctx.projectId) === sign) return { ok: true, skipped: true };
    try {
      const res = s.kb({ action: "sync", entries: entriesOf(kb, ctx.projectId) });
      if (!res || res.ok === false) return { ok: false, reason: (res && res.error) || "索引失败" };
      indexSign.set(ctx.projectId, sign);
      indexError = "";
      return { ok: true, ...res.data, note: res.note };
    } catch (error) {
      indexError = error?.message || String(error);
      return { ok: false, reason: indexError };
    }
  }

  /* 明确要正文时才补：检索默认只返回摘要，这是「库大也不涨上下文」的关键 */
  function withBody(kb, entries) {
    return entries.map((item) => {
      const full = item.id ? kb.get(item.id) : null;
      return full ? { ...item, ...full } : item;
    });
  }

  async function init(ctx, raw = {}) {
    const kb = kbFor(ctx);
    try {
      fs.mkdirSync(kb.projectRoot, { recursive: true });
      fs.mkdirSync(kb.dir, { recursive: true });
      for (const kind of KINDS) {
        fs.mkdirSync(path.join(kb.dir, kind), { recursive: true });
      }
      const created = [];
      const outline = path.join(kb.dir, OUTLINE_NAME);
      if (!fs.existsSync(outline)) {
        fs.writeFileSync(outline, OUTLINE_TEXT, "utf8");
        created.push(OUTLINE_NAME);
      }
      for (const kind of KINDS) {
        const index = path.join(kb.dir, kind, INDEX_NAME[kind]);
        if (!fs.existsSync(index)) {
          fs.writeFileSync(index, defaultIndex(kind, kb.volumePerBook), "utf8");
          created.push(`${kind}/${INDEX_NAME[kind]}`);
        }
      }
      kb.load();
      return { ok: true, dir: kb.dir, created, ...describe(ctx) };
    } catch (error) {
      return { ok: false, error: error?.message || String(error), dir: kb.dir };
    }
  }

  function describe(ctx) {
    const kb = kbFor(ctx);
    const exists = fs.existsSync(kb.dir);
    if (exists) kb.load();
    return {
      ok: true,
      exists,
      dir: kb.dir,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      projectRoot: ctx.projectRoot,
      counts: exists ? counts(kb) : { 方法: 0, 避错: 0, total: 0 },
      books: exists ? { 方法: Object.keys(kb.state.books.方法).length, 避错: Object.keys(kb.state.books.避错).length } : { 方法: 0, 避错: 0 },
      config: configStore.get(),
      lastError: kb.lastError || ""
    };
  }

  function browse(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: true, exists: false, dir: kbFor(ctx).dir, entries: [], counts: { 方法: 0, 避错: 0, total: 0 }, config: configStore.get() };
    const summary = kb.list();
    const entries = summary.map((entry) => {
      const full = kb.get(entry.id) || {};
      return { ...full, kind: entry.kind, domain: entry.domain, book: entry.book };
    }).sort((a, b) => String(b.id).localeCompare(String(a.id)));
    return { ok: true, exists: true, dir: kb.dir, entries, counts: counts(kb), config: configStore.get() };
  }

  /**
   * 检索。默认走知识网（第四张网）：返回「编号 + 标题 + 一行摘要 + 权重」，
   * 不含正文。要正文传 `detail: true`，或按编号调 kb_get ——
   * 一次只搬真正要看的那条，库再大也不涨上下文。
   *
   * 索引不可用时退回 kb-store 的关键词检索（结果里 `weighted:false` 如实标出）。
   */
  function search(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: true, exists: false, entries: [], dir: kbFor(ctx).dir };
    const limit = Number.isInteger(raw.limit) ? raw.limit : configStore.get().searchLimit;
    const text = raw.text ?? raw.query ?? "";
    const synced = syncIndex(ctx, kb);
    const s = store();
    if (synced.ok && s) {
      const res = s.kb({
        action: "search",
        project: ctx.projectId,
        query: text,
        kind: raw.kind,
        domain: raw.domain,
        limit
      });
      if (res && res.ok) {
        return {
          ok: true,
          exists: true,
          weighted: true,
          entries: raw.detail ? withBody(kb, res.data.entries) : res.data.entries,
          scanned: res.data.scanned,
          chars: res.data.entries.reduce((sum, item) => sum + String(item.digest || "").length, 0),
          note: res.note,
          index: { total: synced.total, added: synced.added, updated: synced.updated }
        };
      }
    }
    return {
      ok: true,
      exists: true,
      weighted: false,
      reason: synced.reason || indexError || "索引不可用",
      entries: kb.search({ text, kind: raw.kind, domain: raw.domain, limit })
    };
  }

  function guide(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: true, exists: false, entries: [], dir: kbFor(ctx).dir };
    const task = raw.task ?? raw.query ?? "";
    const stage = raw.stage;
    const limit = Number.isInteger(raw.limit) ? Math.max(1, Math.min(20, raw.limit)) : 5;
    const exclude = Array.isArray(raw.exclude) ? raw.exclude : [];
    const synced = syncIndex(ctx, kb);
    const s = store();
    if (synced.ok && s) {
      const res = s.kb({
        action: "search",
        project: ctx.projectId,
        query: [task, stage].filter(Boolean).join(" "),
        kind: raw.kind,
        limit: limit + exclude.length
      });
      if (res && res.ok) {
        const entries = res.data.entries.filter((item) => !exclude.includes(item.id)).slice(0, limit);
        return {
          ok: true,
          exists: true,
          weighted: true,
          entries: raw.detail ? withBody(kb, entries) : entries,
          scanned: res.data.scanned,
          task,
          stage,
          note: res.note
        };
      }
    }
    const result = kb.guide({ task, stage, kind: raw.kind, limit, exclude });
    return { ...result, ok: true, exists: true, weighted: false, reason: synced.reason || indexError || "索引不可用" };
  }

  function get(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: false, exists: false, error: "这个项目还没有知识库", dir: kbFor(ctx).dir };
    const id = String(raw.id || raw.key || "").trim();
    const entry = kb.get(id);
    if (!entry) return { ok: false, error: `没有编号 ${id}` };
    /* 取正文才算「打开」：这条计数直接决定它在权重里能排多前 */
    const s = store();
    let weight = null;
    if (s) {
      try {
        const res = s.kb({ action: "get", project: ctx.projectId, id });
        if (res && res.ok) weight = { weight: res.data.weight, percent: res.data.percent, opens: res.data.opens };
      } catch {
        /* 计数失败不影响读正文 */
      }
    }
    return weight ? { ok: true, entry, ...weight } : { ok: true, entry };
  }

  async function add(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: false, exists: false, error: "这个项目还没有知识库，请先初始化（kb_init）", dir: kbFor(ctx).dir };
    const kind = raw.kind === "方法" || raw.kind === "避错" ? raw.kind : configStore.get().defaultKind;
    const entry = raw.entry && typeof raw.entry === "object" ? raw.entry : raw;
    const id = String(raw.id || entry.id || "").trim();
    if (id && parseEntryId(id)) {
      return update(ctx, { ...raw, kind, id, entry: { ...entry, id } });
    }
    const result = await kb.write(kind, entry);
    if (result.ok) {
      const pruned = await kb.pruneIfNeeded();
      /* 写入后签名一定变，但 mtime 在某些文件系统上精度只有秒 —— 主动失效更稳。
         然后**立即重建**：刚写的知识必须马上能搜到，不能等下一次检索。 */
      indexSign.delete(ctx.projectId);
      const index = syncIndex(ctx, kb);
      return { ...result, kind, pruned: pruned.pruned || [], index };
    }
    return result;
  }

  async function update(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: false, exists: false, error: "这个项目还没有知识库" };
    const kind = raw.kind === "方法" || raw.kind === "避错" ? raw.kind : configStore.get().defaultKind;
    const id = String(raw.id || "").trim();
    if (!parseEntryId(id)) return { ok: false, error: "编号格式不对" };
    const remove = await kb.remove(id);
    if (!remove.ok) return remove;
    const entry = raw.entry && typeof raw.entry === "object" ? raw.entry : raw;
    const result = await kb.write(kind, { ...entry, id });
    if (result.ok) {
      indexSign.delete(ctx.projectId);
      const index = syncIndex(ctx, kb);
      return { ...result, kind, updated: true, index };
    }
    return result;
  }

  async function remove(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: false, exists: false, error: "这个项目还没有知识库" };
    const result = await kb.remove(String(raw.id || ""));
    if (result.ok) {
      /* 删除必须立刻反映到索引：否则检索还会给出一个打开就 404 的编号 */
      indexSign.delete(ctx.projectId);
      syncIndex(ctx, kb);
    }
    return result;
  }

  async function prune(ctx, raw = {}) {
    const kb = existingKb(ctx);
    if (!kb) return { ok: false, exists: false, error: "这个项目还没有知识库" };
    const keep = Number.isInteger(raw.keep) ? raw.keep : 0;
    return kb.prune(keep);
  }

  function saveConfig(raw = {}) {
    return (async () => {
      const result = await configStore.save(raw);
      if (result.ok) {
        for (const kb of cache.values()) kb.applyConfig(result.config);
      }
      return result;
    })();
  }

  /**
   * 注入系统提示。
   *
   * ⚠ 这一段的字数**每轮都要付**，所以刻意做薄：
   *   旧版注入总纲全文（约 1.4k 字）+ 三条完整条目（每条 300 字），
   *   库越大越不划算，而且大部分内容当轮根本用不到。
   *   现在固定约 200 字：只给「怎么用 + 现在最该看的三条标题」，
   *   正文一律按需取。这不是省一点，是把「上下文随库增长」这条线砍平。
   */
  function inject(ctx, raw = {}) {
    const cfg = configStore.get();
    const kb = kbFor(ctx);
    const exists = fs.existsSync(kb.dir);
    if (exists) kb.load();
    const parts = [];
    if (!cfg.injectEnabled) return { text: "" };

    parts.push(
      "## 知识库\n\n" +
      "本项目的做法与踩过的坑在 `知识库/`（`M-` 方法 / `P-` 避错）。" +
      "动手前用 `kb_guide` 按当前任务查，要目录用 `kb_digest`；" +
      "检索只回摘要，正文由 `kb_get` 单条取。"
    );

    if (!exists) {
      parts.push("这个项目还没有知识库。需要时先调用 `kb_init` 建骨架，再沉淀。");
      return { text: parts.join("\n\n").trim() };
    }

    const synced = syncIndex(ctx, kb);
    const s = store();
    let top = [];
    if (cfg.guideInjectEnabled !== false && synced.ok && s) {
      const res = raw.task
        ? s.kb({
          action: "search",
          project: ctx.projectId,
          query: raw.task,
          limit: Math.max(1, Math.min(8, Number(cfg.guideInjectLimit) || 3))
        })
        : s.kb({ action: "digest", project: ctx.projectId });
      if (res && res.ok) {
        top = raw.task
          ? res.data.entries.map((item) => ({ key: item.key, id: item.id, title: item.title, percent: item.percent }))
          : (res.data.top || []).slice(0, Math.max(1, Math.min(8, Number(cfg.guideInjectLimit) || 3)));
      }
      /* 被注入就算「被引用」：权重里 uses 这一项靠它累积，
         否则「摘要够用、从没取正文」的好条目会一直得不到加分。 */
      if (top.length) {
        try {
          s.kb({ action: "use", keys: top.map((item) => item.key).filter(Boolean) });
        } catch {
          /* 计数失败不影响注入 */
        }
      }
    }
    if (top.length) {
      parts.push(
        "现在最该先看的 " + top.length + " 条（按权重）：\n" +
        top.map((item) => `- ${item.id || ""} ${item.title}（${item.percent}%）`).join("\n")
      );
    }
    /* 字数上限现在只是一道保险：正常内容约 200 字，远小于默认 6000。
       保留它是为了「一旦哪天又有人往里塞长内容」时仍能被截住。 */
    const cap = Math.max(200, Math.min(20000, Number(cfg.injectMaxChars) || 6000));
    const text = parts.join("\n\n").trim();
    return { text: text.length > cap ? text.slice(0, cap) + "\n\n（已按设置的字数上限截断）" : text };
  }

  /**
   * 目录层：库里有什么、哪些权重最高、哪些长期没人打开。
   * 一条正文都不给 —— 这是渐进披露的第一层，成本固定。
   */
  function digest(ctx, raw = {}) {
    const kb = existingKb(ctx);
    const s = store();
    if (!s) {
      return { ok: true, exists: Boolean(kb), weighted: false, reason: indexError || "记忆库不可用", total: kb ? kb.count() : 0 };
    }
    if (!kb) {
      return { ok: true, exists: false, weighted: true, total: 0, chars: 0, kinds: {}, domains: [], top: [], cold: [], dir: kbFor(ctx).dir };
    }
    const synced = syncIndex(ctx, kb);
    const res = s.kb({ action: "digest", project: ctx.projectId });
    return {
      ok: true,
      exists: true,
      weighted: true,
      dir: kb.dir,
      index: synced,
      ...(res && res.ok ? res.data : { total: 0 })
    };
  }

  /** 反馈：有用 / 没用。权重唯一的人工入口。 */
  function feedback(ctx, raw = {}) {
    const s = store();
    if (!s) return { ok: false, error: indexError || "记忆库不可用" };
    const res = s.kb({
      action: "feedback",
      project: ctx.projectId,
      id: raw.id,
      key: raw.key,
      useful: raw.useful !== false
    });
    return res && res.ok ? { ok: true, ...res.data, note: res.note } : { ok: false, error: (res && res.error) || "反馈失败" };
  }

  async function invoke(action, raw = {}, project = {}) {
    if (!pluginEnabled()) {
      return { ok: false, error: "知识库插件当前未启用" };
    }
    const ctx = context(project);
    switch (action) {
      case "describe": return describe(ctx);
      case "browse": return browse(ctx, raw);
      case "search": return search(ctx, raw);
      case "guide": return guide(ctx, raw);
      case "digest": return digest(ctx, raw);
      case "feedback": return feedback(ctx, raw);
      case "get": return get(ctx, raw);
      case "add": return add(ctx, raw);
      case "update": return update(ctx, raw);
      case "remove": return remove(ctx, raw);
      case "prune": return prune(ctx, raw);
      case "init": return init(ctx, raw);
      case "config": return { ok: true, config: configStore.get(), ...describe(ctx) };
      case "saveConfig": return saveConfig(raw);
      case "resetConfig": return saveConfig({ ...DEFAULT_CONFIG });
      case "inject": return inject(ctx, raw);
      default: return { ok: false, error: `未知知识库操作：${action}` };
    }
  }

  async function runTool(name, args = {}, project = {}) {
    const ctx = context(project);
    if (!pluginEnabled()) return JSON.stringify({ ok: false, error: "知识库插件当前未启用" });
    const map = {
      kb_list: "browse",
      kb_search: "search",
      kb_guide: "guide",
      kb_digest: "digest",
      kb_feedback: "feedback",
      kb_get: "get",
      kb_add: "add",
      kb_remove: "remove",
      kb_prune: "prune",
      kb_init: "init"
    };
    const action = map[name];
    if (!action) throw new Error(`未知知识库工具：${name}`);
    const result = await invoke(action, args, project);
    if (result && result.entries && result.entries.length && action !== "browse") {
      result.entries = result.entries.map((entry) => {
        if (entry.id) return entry;
        return entry;
      });
    }
    return JSON.stringify(result, null, 2);
  }

  return { invoke, runTool, context, describe, inject, config: () => configStore.get() };
}
