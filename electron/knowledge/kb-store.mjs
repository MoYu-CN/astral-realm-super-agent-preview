/**
 * 知识库存储层 —— 读写 `<项目根>/知识库/` 那套分册结构。
 *
 * ## 目录结构（照《AI 通用行为准则》6.2 的规定，不自行发明）
 *
 * ```
 * <项目根>/知识库/
 *   00-开始这里-总纲.md          ← 入口：结构说明 + 分册索引表
 *   方法/
 *     00-方法主体.md              ← 分册索引（含「什么时候读它」那一列）
 *     方法-01-【领域】.md         ← 装 M-001 ~ M-010
 *   避错/
 *     00-避错主体.md              ← 分册索引
 *     避错-01-【领域】.md         ← 装 P-001 ~ P-010
 * ```
 *
 * ## 为什么分册而不是一条一文件
 * 一条一文件 → 查 30 条要读 30 次，每次烧上下文。
 * 分册装订 → 一册 10 条，读 1 次拿 10 条。
 * 但**光分册不够**：必须有一个主体文件写明每册「覆盖领域 / 编号区间 / 什么时候读它」，
 * 否则执行者不知道该读哪册，只能全量加载，分册就白分了。
 *
 * ## 本模块的职责边界
 * **只管存储与检索，不碰 markdown 渲染、不碰 UI、不碰智能体。**
 * 写入时必须同步更新主体文件的索引表 —— 索引漏一条，整套库就开始腐烂
 * （这是准则 6.2 明写的规则，不是洁癖）。
 *
 * ## 原子性
 * 每次写都是「临时文件 + rename」。知识库是长期资产，
 * 写到一半断电留个半截文件比写失败严重得多。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "./kb-config.mjs";

/** 知识库根目录名（准则 6.2 规定叫「知识库」）。 */
export const KB_DIR_NAME = "知识库";

/** 库来源标记文件（只在用 baseDir 集中存放时写）。 */
export const ORIGIN_NAME = ".origin.json";

/** 项目路径的短 hash（撞名时作目录后缀）。 */
function shortHash(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 6);
}

/**
 * 把「项目名」清洗成能安全当目录名的一段。
 *
 * ⚠ 项目名来自设置/表单输入，直接拼进路径的话
 *   `"../.."` 之类的输入会把库写到父目录外面 —— 那是静默的数据落错地方。
 *
 * @param {unknown} value 原始项目名。
 * @returns {string} 清洗后的名字；洗不出东西时返回空串（调用方退到 basename）。
 */
export function safeDirName(value) {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/[\\/:*?"<>|]/gu, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/gu, "")
    .trim();
  const noLeadingDots = cleaned.replace(/^\.+/u, "").trim();
  return noLeadingDots;
}

/**
 * 解析知识库的根目录。
 *
 * - `baseDir` 为空 → `<项目根>/知识库`
 *   （默认：跟着项目走，能随 git 一起提交、团队共享）
 * - `baseDir` 非空 → `<父目录>/<项目名>`
 *   （集中存放，便于统一备份）
 *
 * ## 项目名从哪来
 * 优先用**登记过的项目名**（`projects.json` 的 registry，见 index.js），
 * 没登记才退到 `path.basename(项目根)`。
 * ⚠ `baseDir` 为空时库恒为 `<项目根>/知识库`，项目名**不参与**路径解析 ——
 *   这是刻意的：默认布局「跟着项目走」不该被一个显示名改写。
 *
 * ## ⚠ 为什么要 .origin.json
 * 用「项目名」当子目录时，**不同路径的同名项目会撞进同一个库**
 * （比如两个都叫 `app` 的项目）。那会让 A 项目的避错混进 B 项目里，
 * 而且因为看起来一切正常，**极难排查** —— 属于静默的数据混淆。
 *
 * 所以库里记一份来源项目路径：目录已存在、但来源**不是**当前项目时，
 * 退化成 `<项目名>-<短hash>`。
 *
 * 只在 `baseDir` 非空时才有这层判断 —— 默认布局（项目内）不存在撞库问题，
 * 也就不用为一个用不到的场景去动旧路径。
 *
 * @param {string} projectRoot 项目根目录。
 * @param {string} [baseDir] 配置里的父目录（空 = 用项目内「知识库」）。
 * @param {string} [projectName] 登记过的项目名（空 = 用 basename(项目根)）。
 * @returns {string} 库目录绝对路径。
 */
export function resolveKbDir(projectRoot, baseDir = "", projectName = "") {
  const root = path.resolve(projectRoot);
  const base = typeof baseDir === "string" ? baseDir.trim() : "";
  if (base === "") return path.join(root, KB_DIR_NAME);

  const parent = path.resolve(base);
  const registered = safeDirName(projectName);
  const name = registered !== "" ? registered : path.basename(root);
  let dir = path.join(parent, name);

  const marker = path.join(dir, ORIGIN_NAME);
  if (fs.existsSync(marker)) {
    try {
      const origin = JSON.parse(fs.readFileSync(marker, "utf8"))?.projectRoot;
      if (typeof origin === "string" && origin !== "" && path.resolve(origin) !== root) {
        dir = path.join(parent, `${name}-${shortHash(root)}`);
      }
    } catch {
      /* 标记读不出来就按原路径用：宁可退化成旧行为，也不要因此建不了库 */
    }
  }
  return dir;
}

/** 每册容量（准则 6.2：装满即开新册，容量写进总纲别随心情改）。 */
/** 每册容量的**默认值**（用户可在设置页改，见 kb-config.js 的 volumePerBook）。 */
export const VOLUME_PER_BOOK = 10;

/** 两大类。 */
export const KINDS = Object.freeze(["方法", "避错"]);

/**
 * 编号前缀 —— 准则 6.2：`M-0XX` = 方法（Method），`P-0XX` = 避错（Pitfall）。
 * 三位数从 001 开始，**只增不改**，已发布编号永不复用。
 */
export const PREFIX = Object.freeze({ 方法: "M", 避错: "P" });

/** 总纲文件名。 */
const OUTLINE_NAME = "00-开始这里-总纲.md";
/** 主体（分册索引）文件名。 */
const INDEX_NAME = Object.freeze({ 方法: "00-方法主体.md", 避错: "00-避错主体.md" });

/** 单条条目的体积上限（字节）。防止一条写成整篇报告。 */
const MAX_ENTRY_BYTES = 64 * 1024;

/**
 * 把 0 补齐到 3 位：`7` → `"007"`。
 * @param {number} n 序号。
 * @returns {string} 三位字符串。
 */
function pad3(n) {
  return String(n).padStart(3, "0");
}

/**
 * 解析条目编号 → `{kind, seq}`。
 *
 * @param {string} id 形如 `"P-003"` / `"M-017"`。
 * @returns {{kind: string, seq: number} | null} 解析失败返 null。
 */
export function parseEntryId(id) {
  if (typeof id !== "string") return null;
  const m = /^([MP])-(\d{3})$/.exec(id.trim());
  if (m === null) return null;
  const kind = m[1] === "M" ? "方法" : "避错";
  return { kind, seq: Number(m[2]) };
}

/**
 * 知识库。
 *
 * 一次性把整个库读进内存，写时整体落盘。
 * 条目数量是几十条量级，不值得为增量写引入复杂度 ——
 * 增量写的 bug 面积（索引同步、编号分配）远大于它省下的 IO。
 */
export class KnowledgeBase {
  /**
   * @param {string} projectRoot 项目根目录。实际库路径是 `<projectRoot>/知识库`。
   * @param {object} [config] 生效配置（来自 ConfigStore.get()）。
   *   缺省时用 `DEFAULT_CONFIG`，等价于「每册 10 条、总量不限」。
   *   传入是为了让 `volumePerBook` 从硬编码常量变成**可配** ——
   *   它原先是 `VOLUME_PER_BOOK`，用户改不了。
   * @param {string} [projectName] 登记过的项目名（决定 baseDir 布局下的子目录名）。
   */
  constructor(projectRoot, config = null, projectName = "") {
    this.projectRoot = path.resolve(projectRoot);
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    /** 登记过的项目名（空 = 没登记，退到 basename）。 */
    this.projectName = typeof projectName === "string" ? projectName.trim() : "";
    /** 库目录：由 `baseDir` + 项目名决定（空 = 项目内「知识库」）。 */
    this.dir = resolveKbDir(this.projectRoot, this.config.baseDir, this.projectName);
    /** @type {{outline: string, books: Record<string, {file: string, domain: string, ids: string[]}>, seq: Record<string, number>}} */
    this.state = { outline: "", books: { 方法: {}, 避错: {} }, seq: { 方法: 0, 避错: 0 } };
    this.loaded = false;
    /** 最近一次失败原因，供诊断。 */
    this.lastError = null;
  }

  /**
   * 换配置。目录没变时**不重载条目**（条目状态不受配置影响）；目录变了就必须重算 + 丢状态。
   * 设置页改完配置后调用（`index.js` 里会对所有已缓存的库逐个调它）。
   *
   * ⚠⚠ **`baseDir` 一改，`this.dir` 就变了** —— 只换 `this.config` 而不重算，
   *   已缓存的库会一直指向旧目录：表现是「在设置页填了『知识库父目录』却没用 /
   *   原来那本库看起来空了」。踩过的坑：把父目录改成另一个位置却仍按旧目录读，
   *   `dir` 变了以后旧目录读进来的 `state` 也不再有效，必须一起清掉，
   *   否则新旧两本书的内容会混在一起。
   *
   * @param {object} config 新配置。
   */
  applyConfig(config) {
    const next = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    const nextDir = resolveKbDir(this.projectRoot, next.baseDir, this.projectName);
    if (nextDir === this.dir) {
      this.config = next;
      return;
    }
    this.config = next;
    this.dir = nextDir;
    this.state = { outline: "", books: { 方法: {}, 避错: {} }, seq: { 方法: 0, 避错: 0 } };
    this.loaded = false;
    this.lastError = null;
  }

  /** 每册容量（可配，默认 10）。 */
  get volumePerBook() {
    const n = this.config?.volumePerBook;
    return typeof n === "number" && n >= 1 ? n : VOLUME_PER_BOOK;
  }

  /** 总量上限（0 = 不限）。 */
  get maxTotal() {
    const n = this.config?.maxTotal;
    return typeof n === "number" && n >= 0 ? n : 0;
  }

  /**
   * 定位某个工作区对应的知识库。
   *
   * ⚠ **没找到时返回 null，绝不自动创建。**
   * 准则 6.2 说「每次接手新项目先检查这套目录是否存在；不存在就建」——
   * 但那是**智能体的判断**，不是工具的。
   * 工具擅自建库会掩盖「这个项目其实没在用知识库」这个事实，
   * 让提醒功能对所有项目都显示「暂无避���」，看起来像坏了。
   * 真正要建由智能体调 `kb_init` 显式触发。
   *
   * @param {string} projectRoot 项目根目录。
   * @param {object} [config] 生效配置。
   * @param {string} [projectName] 登记过的项目名（baseDir 布局下的子目录名）。
   * @returns {KnowledgeBase | null} 库不存在时返 null。
   */
  static locate(projectRoot, config = null, projectName = "") {
    if (typeof projectRoot !== "string" || projectRoot.trim() === "") return null;
    // ⚠ 必须把 config 传下去 —— 库路径由 baseDir 决定，
    //   不传的话用户在设置里改了目录也没用（还是按项目内找）。
    const kb = new KnowledgeBase(projectRoot.trim(), config, projectName);
    if (!fs.existsSync(kb.dir)) return null;
    return kb;
  }

  /**
   * 从磁盘加载。**不抛错**：失败时保留空态并记下原因。
   * @returns {boolean} 库是否存在且读成功。
   */
  load() {
    try {
      const outlinePath = path.join(this.dir, OUTLINE_NAME);
      this.state.outline = fs.existsSync(outlinePath)
        ? fs.readFileSync(outlinePath, "utf8")
        : "";
      this.state.books = { 方法: {}, 避错: {} };
      this.state.seq = { 方法: 0, 避错: 0 };

      for (const kind of KINDS) {
        const kindDir = path.join(this.dir, kind);
        if (!fs.existsSync(kindDir)) continue;
        for (const name of fs.readdirSync(kindDir)) {
          // 主体索引文件不是分册
          if (!name.endsWith(".md") || name === INDEX_NAME[kind]) continue;
          const m = /^(\S+?)-(\d+)-(.+)\.md$/u.exec(name);
          if (m === null) continue;
          const file = path.join(kindDir, name);
          const ids = readEntryIds(fs.readFileSync(file, "utf8"));
          this.state.books[kind][name] = { file, domain: m[3], ids };
          for (const id of ids) {
            const parsed = parseEntryId(id);
            if (parsed !== null && parsed.seq > this.state.seq[kind]) {
              this.state.seq[kind] = parsed.seq;
            }
          }
        }
      }
      this.loaded = true;
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`;
      this.loaded = false;
      return false;
    }
  }

  /**
   * 分配下一个编号（**只增不改**，不复用）。
   *
   * ⚠ 分配后必须真的写进某册，否则下次 load 回来序号会退回去，
   * 造成编号复用 —— 那正是准则禁止的「已发布编号永远不复用」被破坏。
   *
   * @param {string} kind `"方法"` 或 `"避错"`。
   * @returns {string} 新编号（如 `"P-011"`）。
   */
  allocateId(kind) {
    const next = this.state.seq[kind] + 1;
    return `${PREFIX[kind]}-${pad3(next)}`;
  }

  /**
   * 找出某类该往哪个册追加 —— 按**领域名**归册，册不存在则新建。
   *
   * 同领域已有册 → 追加；册已满 → 开新册（`<领域>-<序号>`）。
   * 这就是准则 6.2 的「按领域分册，不按时间分册」+「装满即开新册」。
   *
   * @param {string} kind 类别。
   * @param {string} domain 领域名（如「构建与部署」）。
   * @returns {{file: string, name: string}} 目标分册。
   */
  bookFor(kind, domain) {
    const clean = sanitizeDomain(domain);
    const books = this.state.books[kind];
    // 同领域且未满 → 用它
    for (const [name, book] of Object.entries(books)) {
      if (book.domain === clean && book.ids.length < this.volumePerBook) {
        return { file: book.file, name };
      }
    }
    // 需要新册：找该领域已有的最大序号 +1
    let maxNo = 0;
    for (const name of Object.keys(books)) {
      const m = new RegExp(`^${escapeRe(kind)}-(\\d+)-${escapeRe(clean)}\\.md$`, "u").exec(name);
      if (m !== null) maxNo = Math.max(maxNo, Number(m[1]));
    }
    const no = pad3(maxNo + 1);
    const name = `${kind}-${no}-${clean}.md`;
    return { file: path.join(this.dir, kind, name), name };
  }

  /**
   * 写入一条。
   *
   * @param {string} kind 类别。
   * @param {object} entry `{id?, domain, title, trigger, steps, why, symptoms, verify, boundaries}`。
   * @returns {{ok: boolean, id?: string, error?: string}}
   */
  async write(kind, entry) {
    if (!KINDS.includes(kind)) return { ok: false, error: `未知类别 ${kind}` };
    const normalized = normalizeEntry(kind, entry);
    if (normalized.error !== undefined) return { ok: false, error: normalized.error };

    // ── 总量上限校验（超限**拒绝**，不静默删）────────────────
    //
    // ⚠ 这里必须报错而不是替用户清理：悄悄删掉他的条目属于「隐藏操作」，
    //   是准则红线之一（隐藏失败/省略不利信息）。正确做法是拒写+ 说清为什么，
    //   让他自己决定删哪些（remove 是显式的）。
    //
    // 覆盖已有条目（显式传了 id）不占新名额，所以不校验。
    const isUpdate = typeof entry?.id === "string" && parseEntryId(entry.id) !== null;
    if (this.maxTotal > 0 && !isUpdate && this.count() >= this.maxTotal) {
      return {
        ok: false,
        code: "MAX_TOTAL_REACHED",
        error:
          `条目总数已达上限 ${this.maxTotal} 条。` +
          `请先删除不再需要的条目（kb_remove / 面板上的删除按钮），或调高设置里的总量上限。`,
      };
    }

    const id = typeof entry?.id === "string" && parseEntryId(entry.id) !== null
      ? entry.id.trim().toUpperCase()
      : this.allocateId(kind);
    const parsed = parseEntryId(id);
    if (parsed === null || parsed.kind !== kind) {
      return { ok: false, error: `编号 ${id} 与类别 ${kind} 不匹配` };
    }

    const body = renderEntry(kind, { ...normalized, id });
    const bytes = Buffer.byteLength(body, "utf8");
    const maxBytes = Number.isInteger(this.config?.maxEntryBytes)
      ? this.config.maxEntryBytes
      : MAX_ENTRY_BYTES;
    if (bytes > maxBytes) {
      return {
        ok: false,
        code: "MAX_ENTRY_BYTES",
        error: `单条 ${(bytes / 1024).toFixed(1)} KB，超过 ${(maxBytes / 1024).toFixed(0)} KB 上限`,
      };
    }

    const book = this.bookFor(kind, normalized.domain);
    try {
      await appendToFile(book.file, body);
    } catch (error) {
      this.lastError = `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`;
      return { ok: false, error: this.lastError };
    }

    // 内存态同步 —— 不重载整个库，避免刚写的内容被旧文件覆盖掉
    const bookName = path.basename(book.file);
    if (this.state.books[kind][bookName] === undefined) {
      this.state.books[kind][bookName] = { file: book.file, domain: normalized.domain, ids: [] };
    }
    if (!this.state.books[kind][bookName].ids.includes(id)) {
      this.state.books[kind][bookName].ids.push(id);
    }
    if (parsed.seq > this.state.seq[kind]) this.state.seq[kind] = parsed.seq;

    // ⚠ 索引必须同步 —— 准则 6.2：「每加一条，同步更新主体文件的索引」
    const indexRes = await this.#rewriteIndex(kind);
    if (!indexRes.ok) return { ok: false, error: `条目已写入但索引更新失败：${indexRes.error}` };

    return { ok: true, id };
  }

  /**
   * 「工序接入」检索：按**正在做的事**挑出该照做的条目。
   *
   * ## 与 `search()` 的分工（别混用）
   * - `search(text)`：**关键词包含**匹配，打平权分。回答「库里有没有提过这个词」。
   * - `guide({task, stage})`：以**「触发条件」为主匹配字段**，按
   *   「任务里有几个词真的落在那条触发条件上」打分，并用 IDF 压低
   *   「到处都出现」的水词（如「文件」「问题」）。回答「这个工序该照哪几条做」。
   *
   * ⚠ **以触发条件为主字段是刻意的**：那条字段本来就是回答「下次什么时候会遇到」的，
   *   最接近「工序」语义。退化成全文关键词匹配会给出「搜得到但不对路」的结果 ——
   *   智能体会为一个这次根本不存在的问题去改代码。
   *
   * ## 权重（改这里要同时改注释）
   * - 触发条件 / 适用场景：**权 1.0**（唯一的主字段）
   * - 标题：0.35（只作加权，**不算命中** —— 标题只是标签，不是「什么时候遇到」）
   * - 步骤 / 先做、为什么 / 依据：合计 0.55（次级证据，长字段按字符数封顶，
   *   免得一条 20 步的条目靠字符多空手拿分）
   * - 领域名出现在任务里：×1.25（与 `search()` 的领域加分同一个意思）
   *
   * ## 分级：主命中优先，次级证据最多补 1 条
   * - tier 1 = 触发条件上有**实词**命中，且覆盖率 ≥ `PRIMARY_MIN_COVERAGE`
   * - tier 2 = 触发条件一条没中，但有次级证据（覆盖率 ≥ `SECONDARY_MIN`），同样要求实词
   * tier 2 会带 `matchedBy:"secondary"` 如实标出来，让调用方知道它只是「可能相关」。
   * ⚠ 两道门槛（覆盖率 + 实词）是**实测逼出来的**：只靠覆盖率时，「一个」「插件」
   *   这类到处都有的 2-gram 会把不相干的条目顶上来（见验收报告里的实测分数）。
   *
   * @param {object} query `{task, stage?, kind?, limit?, exclude?}`。
   *   `exclude` 是已经给过的编号（自动注入先用它挑过 3 条，工具再深挖时不重复）。
   * @returns {{entries: Array<object>, scanned: number, task: string, stage: string}}
   *   条目含 `id/kind/domain/title/trigger/steps/why/symptoms/verify/boundaries`
   *   与 `score/matchedBy/matchedTerms`（后三个是**可核对**用的，不是内容）。
   */
  guide(query) {
    const task = typeof query?.task === "string" ? query.task.trim() : "";
    const stage = typeof query?.stage === "string" ? query.stage.trim() : "";
    const limit = Number.isInteger(query?.limit) ? Math.max(1, Math.min(20, query.limit)) : 5;
    const exclude = new Set(Array.isArray(query?.exclude) ? query.exclude : []);
    /** 查询词元 = 任务 + 阶段提示词（阶段词只帮忙，不单独构成命中）。 */
    const terms = tokenize(`${task} ${STAGE_HINTS[stage] ?? ""}`);
    const hitTerms = new Set(terms);

    // ── ① 一次遍历读出全部条目（库里是几十条量级）────────────────
    const rows = [];
    for (const kind of KINDS) {
      if (query?.kind !== undefined && query.kind !== kind) continue;
      for (const [name, book] of Object.entries(this.state.books[kind])) {
        for (const id of book.ids) {
          const entry = this.#readEntry(kind, name, id);
          if (entry === null) continue;
          rows.push({
            entry,
            kind,
            domain: book.domain,
            fields: {
              // ⚠ 两类条目的「主字段」叫法不同（避错=触发条件，方法=适用场景），
              //   parseEntryBlock 已经把两者归一成 entry.trigger。
              trigger: String(entry.trigger ?? ""),
              title: String(entry.title ?? ""),
              steps: (entry.steps ?? []).join("\n"),
              why: String(entry.why ?? ""),
              // 核实性字段也写上：说「先看违规症状」时它得能被搜到
              extra: [entry.symptoms, entry.verify, entry.boundaries].filter((s) => typeof s === "string").join("\n"),
            },
          });
        }
      }
    }

    // ── ② 词的「普遍程度」→ IDF 权重 ───────────────────────────
    //
    // ⚠ 中文按 2-gram 切，「文件」「一个」这类组合会同时命中几十条。
    //   不压权重的话，谁的正文长谁分高 —— 那正是「关键词噪音」。
    //   在哪个字段出现才算数也在这里定：标题/次级字段里的出现不进主字段索引。
    const df = new Map();
    for (const term of hitTerms) {
      let n = 0;
      for (const row of rows) {
        if (
          includesTerm(row.fields.trigger, term) ||
          includesTerm(row.fields.steps, term)
        ) {
          n += 1;
        }
      }
      df.set(term, n);
    }
    const weight = (term) => 1 / (1 + (df.get(term) ?? 0));
    const totalWeight = [...hitTerms].reduce((sum, term) => sum + weight(term), 0);
    const maxWeight = hitTerms.size === 0 ? 0 : Math.max(...[...hitTerms].map(weight));

    // ── ③ 逐条打分 ──────────────────────────────────────────────
    const scored = [];
    for (const row of rows) {
      if (exclude.has(row.entry.id)) continue;
      const matched = [];
      let wTrigger = 0;
      let wSecondary = 0;
      for (const term of hitTerms) {
        const w = weight(term);
        if (includesTerm(row.fields.trigger, term)) {
          wTrigger += w;
          matched.push(term);
        } else if (includesTerm(row.fields.title, term)) {
          wSecondary += w * 0.35;
          matched.push(term);
        } else {
          // ⚠ 次级证据按**字符数封顶**：长字段不该靠篇幅拿分
          const hay = `${row.fields.steps}\n${row.fields.why}\n${row.fields.extra}`;
          if (includesTerm(hay, term)) {
            wSecondary += w * 0.55 * Math.min(1, 240 / Math.max(240, hay.length));
            matched.push(term);
          }
        }
      }
      const triggerCoverage = totalWeight === 0 ? 0 : wTrigger / totalWeight;
      const secondaryCoverage = totalWeight === 0 ? 0 : wSecondary / totalWeight;
      // ⚠ 「实词」这道必须有：任务里的「一个」「插件」这类词到处都是，
      //   只靠覆盖率的话，长任务里它们能凑够分把不相干的条目顶上来（实测踩过）。
      const solidHit = matched.some((term) => weight(term) >= maxWeight * SOLID_HIT_RATIO);
      const domainBonus = row.domain !== "" && task.includes(row.domain) ? 1.25 : 1;
      const score = (triggerCoverage + secondaryCoverage * 0.35) * domainBonus;
      const tier =
        triggerCoverage >= PRIMARY_MIN_COVERAGE && solidHit
          ? 1
          : secondaryCoverage >= SECONDARY_MIN && solidHit
            ? 2
            : 0;
      if (tier === 0) continue;
      scored.push({
        row,
        tier,
        score,
        triggerCoverage,
        secondaryCoverage,
        matchedTerms: matched.sort(),
      });
    }

    // ── ④ 排序：主命中优先；同级按分数，再按编号（结果必须稳定）──
    scored.sort((a, b) => {
      const ta = a.tier === 1 ? -1 : 0;
      const tb = b.tier === 1 ? -1 : 0;
      if (ta !== tb) return ta - tb;
      if (b.score !== a.score) return b.score - a.score;
      return a.row.entry.id.localeCompare(b.row.entry.id);
    });

    const out = [];
    let secondaryUsed = 0;
    for (const item of scored) {
      if (out.length >= limit) break;
      // 次级证据最多补 1 条：宁可少给，也不让「可能相关」占满名额
      if (item.tier === 2) {
        if (secondaryUsed >= SECONDARY_SLOTS) continue;
        secondaryUsed += 1;
      }
      out.push({
        ...item.row.entry,
        kind: item.row.kind,
        domain: item.row.domain,
        // ⚠ 下面三个是**可核对**的元信息（不是条目内容）：
        //   调用方可以据此判断「为什么给了它」。
        score: Number(item.score.toFixed(3)),
        matchedBy: item.tier === 1 ? "trigger" : "secondary",
        matchedTerms: item.matchedTerms.slice(0, 12),
      });
    }
    return { entries: out, scanned: rows.length, task, stage };
  }

  /**
   * 检索。
   *
   * 打分规则刻意保守：**宁可少推，不可错推**。
   * 推一条不相关的避错比不推更糟 —— 智能体会为一个不存在的问题去改代码。
   *
   * @param {object} query `{text?, kind?, domain?, limit?}`。
   * @returns {Array<object>} 命中条目（含 id/kind/domain/title 与正文四段）。
   */
  search(query) {
    const text = typeof query?.text === "string" ? query.text.trim().toLowerCase() : "";
    const terms = text === "" ? [] : tokenize(text);
    const limit = Number.isInteger(query?.limit) ? query.limit : 5;
    const out = [];

    for (const kind of KINDS) {
      if (query?.kind !== undefined && query.kind !== kind) continue;
      for (const [name, book] of Object.entries(this.state.books[kind])) {
        if (query?.domain !== undefined && book.domain !== query.domain) continue;
        for (const id of book.ids) {
          const entry = this.#readEntry(kind, name, id);
          if (entry === null) continue;
          let score = 0;
          if (terms.length === 0) score = 1;
          else {
            const hay = `${entry.title}\n${entry.trigger}\n${entry.why}\n${(entry.steps || []).join("\n")}`
              .toLowerCase();
            for (const term of terms) if (hay.includes(term)) score += 1;
            if (book.domain && text.includes(book.domain.toLowerCase())) score += 2;
          }
          if (score > 0) out.push({ ...entry, kind, domain: book.domain, book: name, score });
        }
      }
    }
    // 同分按编号排 —— 保证结果稳定，不随文件遍历顺序抖动
    out.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
    return out.slice(0, limit);
  }

  /**
   * 读单条。
   * @param {string} id 编号。
   * @returns {object | null}
   */
  get(id) {
    const parsed = parseEntryId(id);
    if (parsed === null) return null;
    for (const [name] of Object.entries(this.state.books[parsed.kind])) {
      const entry = this.#readEntry(parsed.kind, name, id);
      if (entry !== null) return { ...entry, kind: parsed.kind, book: name };
    }
    return null;
  }

  /**
   * 列出全部条目摘要。
   * @returns {Array<{id: string, kind: string, domain: string, title: string}>}
   */
  list() {
    const out = [];
    for (const kind of KINDS) {
      for (const [name, book] of Object.entries(this.state.books[kind])) {
        for (const id of book.ids) {
          const entry = this.#readEntry(kind, name, id);
          if (entry === null) continue;
          out.push({ id, kind, domain: book.domain, book: name, title: entry.title });
        }
      }
    }
    return out;
  }

  /**
   * 诊断信息。
   * @returns {object}
   */
  /**
   * 条目总数（两类合计）。
   * @returns {number}
   */
  count() {
    let n = 0;
    for (const kind of KINDS) {
      for (const book of Object.values(this.state.books[kind])) n += book.ids.length;
    }
    return n;
  }

  /**
   * 删除一条，并同步分册文件与主体索引。
   *
   * ⚠ **编号不复用**：删掉 P-003 之后，下一次写入仍拿 P-004
   *   （序号 state.seq 只增不减）。这是准则 6.2「已发布编号永不复用」的要求 ——
   *   否则别人引用过的 P-003 会在某天指向另一个完全不同的内容。
   *
   * @param {string} id 条目编号。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async remove(id) {
    const parsed = parseEntryId(id);
    if (parsed === null) return { ok: false, error: `编号格式不对：${id}` };

    for (const [name, book] of Object.entries(this.state.books[parsed.kind])) {
      const at = book.ids.indexOf(id);
      if (at === -1) continue;
      if (!fs.existsSync(book.file)) {
        // 文件没了但内存里有 —— 清内存，让状态自愈
        book.ids.splice(at, 1);
        await this.#rewriteIndex(parsed.kind);
        return { ok: true };
      }
      try {
        const text = fs.readFileSync(book.file, "utf8");
        await atomicWrite(book.file, removeEntryBlock(text, id));
        book.ids.splice(at, 1);
        await this.#rewriteIndex(parsed.kind);
        return { ok: true };
      } catch (error) {
        this.lastError = `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`;
        return { ok: false, error: this.lastError };
      }
    }
    return { ok: false, error: `没有编号 ${id}` };
  }

  /**
   * 清理到指定条数：**删最旧的**。
   *
   * ⚠ 只删**最旧**而不是随机删 —— 条目的价值随时间衰减，越旧越可能已过时
   *   （准则 6.8：过时的直接删）。随机删会误删刚沉淀的好条目。
   *
   * ⚠ **删分册文件**：某册被清空后，那个 .md 文件已经没有内容，
   *   留着会让 `load()` 扫到一个空册。空册删文件，非空册只删条目块。
   *
   * @param {number} keep 保留条数（两类合计）。
   * @returns {Promise<{ok: boolean, removed: string[], error?: string}>}
   */
  async prune(keep) {
    const target = Number.isInteger(keep) && keep >= 0 ? keep : 0;
    const removed = [];
    // 收集全部条目按编号升序（P-001 < P-010 < M-001 < M-002）
    const all = this.list()
      .map((e) => e.id)
      .sort((a, b) => {
        const pa = parseEntryId(a);
        const pb = parseEntryId(b);
        if (pa.seq !== pb.seq) return pa.seq - pb.seq;
        return a.localeCompare(b);
      });
    const excess = all.length - target;
    if (excess <= 0) return { ok: true, removed };

    for (const id of all.slice(0, excess)) {
      const one = await this.remove(id);
      if (one.ok === true) removed.push(id);
    }
    // 清掉空册文件
    for (const kind of KINDS) {
      for (const [name, book] of Object.entries(this.state.books[kind])) {
        if (book.ids.length > 0 || !fs.existsSync(book.file)) continue;
        try {
          fs.rmSync(book.file, { force: true });
        } catch {
          /* 删不掉空册不影响正确性，下次 load 会再扫到 */
        }
        delete this.state.books[kind][name];
      }
    }
    return { ok: true, removed };
  }

  /**
   * 按配置的阈值判断是否该清理，并在该清理时执行。
   *
   * ⚠ **默认关闭**（autoPruneThreshold = 0）：工具不该在用户没要求时删他的数据。
   *   删哪些条目是用户的决定 —— 真超上限时**拒绝写入并提示**，
   *   而不是悄悄替他删（那属于「隐藏操作」，准则红线之一）。
   *
   * @returns {Promise<{pruned: string[]}>}
   */
  async pruneIfNeeded() {
    const threshold = this.config?.autoPruneThreshold ?? 0;
    if (!Number.isInteger(threshold) || threshold <= 0) return { pruned: [] };
    const total = this.count();
    if (total <= threshold) return { pruned: [] };
    // 保留多少条：配了就按配的，没配就按「刚好留满两册」推算。
    // ⚠ 阈值（何时触发）与保留量（清到多少）是**两件事** ——
    //   原来代码把阈值同时当保留量用，导致「超了就砍到阈值」，
    //   用户想要的是「超了就清理，但至少留够 N 条」。
    const keepCfg = this.config?.autoPruneKeep ?? 0;
    const keep = Number.isInteger(keepCfg) && keepCfg > 0
      ? keepCfg
      : this.volumePerBook * KINDS.length;
    const result = await this.prune(keep);
    return { pruned: result.removed, keep };
  }


  describe() {
    const counts = {};
    for (const kind of KINDS) counts[kind] = this.list().filter((e) => e.kind === kind).length;
    return {
      dir: this.dir,
      exists: fs.existsSync(this.dir),
      counts,
      books: { 方法: Object.keys(this.state.books.方法).length, 避错: Object.keys(this.state.books.避错).length },
      lastError: this.lastError,
    };
  }

  /**
   * 从分册里读一条。私有。
   * @param {string} kind 类别。
   * @param {string} bookName 分册文件名。
   * @param {string} id 编号。
   * @returns {object | null}
   */
  #readEntry(kind, bookName, id) {
    const book = this.state.books[kind][bookName];
    if (book === undefined || !fs.existsSync(book.file)) return null;
    const text = fs.readFileSync(book.file, "utf8");
    return parseEntryBlock(text, id);
  }

  /**
   * 重写某类的主体索引文件。私有。
   * @param {string} kind 类别。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async #rewriteIndex(kind) {
    const books = Object.entries(this.state.books[kind])
      .map(([name, book]) => ({ name, ...book }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
    const rows = books
      .map((b) => {
        const ids = b.ids.length > 0 ? `${b.ids[0]} ~ ${b.ids[b.ids.length - 1]}` : "（空）";
        return `| ${b.name} | ${b.domain} | ${ids} | |`;
      })
      .join("\n");
    const content =
      `# ${kind}分册索引\n\n` +
      `> 落笔规则：按**领域**分册（不按时间）；每册约 ${this.volumePerBook} 条，装满即开新册；\n` +
      `> 编号全局连续、只增不改。每新增一条，**必须同步更新下表**。\n\n` +
      `| 册名 | 覆盖领域 | 编号区间 | 什么时候读它 |\n|---|---|---|---|\n${rows}\n`;
    try {
      await atomicWrite(path.join(this.dir, kind, INDEX_NAME[kind]), content);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}` };
    }
  }
}

/**
 * 字段名 → 渲染标题。
 * 方法与避错的必备字段不同（准则 6.4 / 6.5）。
 */
const HEADINGS = {
  方法: { trigger: "适用场景", steps: "步骤", verify: "验证方式", boundaries: "已知边界" },
  避错: { trigger: "触发条件", steps: "先做", why: "为什么", symptoms: "违规症状（怎么判断你没做）" },
};

/**
 * 校验并规整一条待写入的条目。
 *
 * ⚠ **必填校验是硬门槛**，因为准则 6.6 明确写了：
 *「每写一条规则，反问自己：怎么判断违反了这条？答不上来说明这条是装饰品。」
 * 对避错来说，**缺「违规症状」的条目直接拒收** —— 没有可观测症状的规则等于没有规则。
 *
 * @param {string} kind 类别。
 * @param {object} entry 原始条目。
 * @returns {object} 规整后的条目，或 `{error}`。
 */
function normalizeEntry(kind, entry) {
  if (entry === null || typeof entry !== "object") return { error: "条目必须是对象" };
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  if (title === "") return { error: "缺少标题" };
  const domain = typeof entry.domain === "string" ? entry.domain.trim() : "";

  const out = { title, domain: domain === "" ? "未分类" : domain };
  if (typeof entry.trigger === "string") out.trigger = entry.trigger.trim();

  if (Array.isArray(entry.steps)) {
    out.steps = entry.steps.map((s) => String(s).trim()).filter((s) => s !== "");
  } else if (typeof entry.steps === "string") {
    out.steps = entry.steps.split(/\r?\n/u).map((s) => s.trim()).filter((s) => s !== "");
  } else {
    out.steps = [];
  }

  for (const key of ["why", "verify", "boundaries", "symptoms"]) {
    if (typeof entry[key] === "string" && entry[key].trim() !== "") out[key] = entry[key].trim();
  }

  if (kind === "避错") {
    // 准则 6.4 的四个必备字段，缺一不可
    if (out.trigger === undefined || out.trigger === "") {
      return { error: "避错条目必须有「触发条件」——下次什么时候遇到" };
    }
    if (out.steps.length === 0) {
      return { error: "避错条目必须有「先做」——至少一条可执行动作" };
    }
    if (out.why === undefined) {
      return { error: "避错条目必须有「为什么」——依据是什么" };
    }
    if (out.symptoms === undefined) {
      return { error: "避错条目必须有「违规症状」——没这一项等于没规则（准则 6.6）" };
    }
  } else if (out.steps.length === 0) {
    return { error: "方法条目必须有「步骤」" };
  }
  return out;
}

/**
 * 渲染一条为 markdown。**追加**格式（前面留空行）。
 * @param {string} kind 类别。
 * @param {object} entry 已规整且带 id 的条目。
 * @returns {string} markdown 文本。
 */
function renderEntry(kind, entry) {
  const h = HEADINGS[kind];
  const lines = ["", `## ${entry.id} ${entry.title}`, ""];
  if (entry.trigger !== undefined) lines.push(`**${h.trigger}**：${entry.trigger}`, "");
  if (entry.steps.length > 0) {
    lines.push(`**${h.steps}**：`, "");
    entry.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push("");
  }
  if (entry.why !== undefined) lines.push(`**${h.why}**：${entry.why}`, "");
  if (entry.verify !== undefined) lines.push(`**${h.verify}**：${entry.verify}`, "");
  if (entry.boundaries !== undefined) lines.push(`**${h.boundaries}**：${entry.boundaries}`, "");
  if (entry.symptoms !== undefined) lines.push(`**${h.symptoms}**：${entry.symptoms}`, "");
  return lines.join("\n");
}

/**
 * 从分册文本里扫出所有条目编号。
 * @param {string} text 分册全文。
 * @returns {string[]} 编号数组，按出现顺序。
 */
/**
 * 从分册文本里切掉某一个条目块（remove 用）。
 *
 * 切法与 parseEntryBlock 对称：找 `## <id> ` 标题行，
 * 一直切到下一个同级 `## [MP]-\d{3} ` 标题（或文件末尾）为止。
 *
 * ⚠ 连同**标题前的空行**一起删，否则文件里会留下一堆空行；
 *   但至少保留文件头部的标题与说明（`readEntryIds` 只看 `## ` 开头的行，
 *   头部的 `# 方法分册` 是 `# ` 单井号，不受影响）。
 *
 * @param {string} text 分册全文。
 * @param {string} id 要删的编号。
 * @returns {string} 删掉该条目后的文本。
 */
function removeEntryBlock(text, id) {
  const heading = new RegExp(`^##\\s+${escapeRe(id)}\\s+`, "mu");
  const m = heading.exec(text);
  if (m === null) return text;
  const start = m.index;
  const rest = text.slice(start + m[0].length);
  const nextIdx = rest.search(/^##\s+[MP]-\d{3}\s+/mu);
  const cut = nextIdx === -1 ? rest.length : nextIdx;
  const head = text.slice(0, start).replace(/\n{3,}$/u, "\n\n");
  return (head + rest.slice(cut)).replace(/\n{3,}/gu, "\n\n");
}


function readEntryIds(text) {
  const out = [];
  for (const m of text.matchAll(/^##\s+([MP]-\d{3})\s+/gmu)) out.push(m[1]);
  return out;
}

/**
 * 从分册文本里切出某一条并解析字段。
 *
 * 故意**只解析需要的字段**，不构造完整 markdown AST ——
 * 知识库是我们自己写的格式，格式稳定，不需要通用解析器。
 *
 * @param {string} text 分册全文。
 * @param {string} id 目标编号。
 * @returns {object | null}
 */
function parseEntryBlock(text, id) {
  // 找到标题行，要求行首是 `## <id> `（前面不接其它字符，避免匹配到正文里的引用）
  const heading = new RegExp(`^##\\s+${escapeRe(id)}\\s+(.+)$`, "mu");
  const m = heading.exec(text);
  if (m === null) return null;
  const start = m.index;
  // 到下一个同级标题为止
  const rest = text.slice(start + m[0].length);
  const nextIdx = rest.search(/^##\s+[MP]-\d{3}\s+/mu);
  const body = nextIdx === -1 ? rest : rest.slice(0, nextIdx);

  const field = (label) => {
    const fm = new RegExp(`\\*\\*${escapeRe(label)}\\*\\*[：:]\\s*([\\s\\S]*?)(?=\\n\\s*\\n|$)`, "u").exec(body);
    return fm === null ? undefined : fm[1].trim();
  };
  const stepsField = (() => {
    for (const label of ["步骤", "先做"]) {
      const fm = new RegExp(`\\*\\*${escapeRe(label)}\\*\\*[：:]\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\n\\*\\*|$)`, "u").exec(body);
      if (fm !== null) {
        return fm[1]
          .split(/\r?\n/u)
          .map((s) => s.replace(/^\s*\d+\.\s*/u, "").trim())
          .filter((s) => s !== "");
      }
    }
    return [];
  })();

  // ⚠⚠ **值为 `undefined` 的自有可枚举键过不了宿主的无损 JSON 检查。**
  //
  // 避错条目没有「验证方式 / 已知边界」，方法条目没有「违规症状」——
  // 缺的那个 `field()` 返回 `undefined`（:769），于是返回对象上带出一个
  // 值为 undefined 的自有键，宿主的 `snapshotToolValue` 直接拒绝：
  //   `tool "kb_get" returned invalid output: value is not lossless JSON`
  //
  // 后果是 **`kb_get` / `kb_search` 每次调用必失败**（`kb_list` 不带这些
  // 字段，所以没暴露 —— 同一个病只挂在两条路上）。
  //
  // ⚠ 修法是**删键**，不是写 `null`：下游渲染用的判据是 `!== undefined`，
  //   写 `null` 会让它渲染出「**验证方式**：null」这种字样。
  const out = {
    id,
    title: m[1].trim(),
    trigger: field("触发条件") ?? field("适用场景"),
    steps: stepsField,
    why: field("为什么"),
    verify: field("验证方式"),
    boundaries: field("已知边界"),
    symptoms: field("违规症状（怎么判断你没做）"),
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

/**
 * 分词：英文按词、中文按 2-gram。
 *
 * 为什么要 2-gram：中文没有空格，单字切分会产出大量无意义词
 * （"文件" 命中 "操作" 其实不对），而双字组合恰好对应中文语义的最小单位。
 *
 * @param {string} text 查询串。
 * @returns {string[]} 词元数组（已小写、去重）。
 */
function tokenize(text) {
  const out = new Set();
  for (const word of text.toLowerCase().split(/[^a-z0-9一-鿿]+/u)) {
    if (word === "") continue;
    if (/^[a-z0-9]+$/u.test(word)) {
      if (word.length >= 2) out.add(word);
    } else {
      for (let i = 0; i + 2 <= word.length; i += 1) out.add(word.slice(i, i + 2));
      if (word.length === 1) out.add(word);
    }
  }
  return [...out];
}

/**
 * `guide()` 的阶段提示词 —— 阶段**只帮忙、不单独构成命中**。
 *
 * 为什么要它：同一个词在不同工序下的含义不同（「构建」在动手前是准备、在排障时是现场）。
 * 加进去的词会走同一套 IDF 权重，所以它压不过任务本身的实词。
 */
const STAGE_HINTS = Object.freeze({
  设计: "设计 方案 结构 取舍 接口",
  动手前: "动手前 开工前 先查 先读 前置条件 准备",
  写码中: "实现 编写 改动 代码 接口 命名",
  提交前: "提交前 自测 校验 验证 回归 检查 清单",
  排障: "报错 失败 排查 复现 不生效 现象 崩溃",
});

/**
 * 入选门槛（**两道一起**才算命中：覆盖率 + 至少一个实词）。
 *
 * ⚠ 为什么要两道：
 *   只看「有没有命中」→ 任务是「给插件新增一个工具」时，
 *   「一个」「插件」这种到处都是的 2-gram 会把一堆不相干的条目顶上来（实测踩过）；
 *   只看覆盖率 → 一个水词加一个实词的长任务里，实词那条反而被稀释掉。
 *
 * 值为什么是这两个：见验收报告里 5 个真实任务描述的实测分数
 * （真命中在 0.13~0.44，噪音在 0.02~0.05）。
 */
const PRIMARY_MIN_COVERAGE = 0.06;
const SECONDARY_MIN = 0.15;

/** 「实词」判据：命中的词里至少有一个的 IDF 权重 ≥ 本次查询最大权重的这个比例。 */
const SOLID_HIT_RATIO = 0.34;

/** `guide()` 里次级证据最多补几条（其余名额留给主命中）。 */
const SECONDARY_SLOTS = 1;

/**
 * 判断 `term` 是否落在 `hay` 里。
 *
 * ⚠ 与 `search()` 一样是**包含**匹配（`includes`），不切词边界 ——
 *   中文没有词边界，切了反而漏。这里单独成函数只是为了标明「这是同一个判据」。
 *
 * @param {string} hay 被查的字段（调用方已决定要不要小写）。
 * @param {string} term 词元（tokenize 产出，已小写）。
 * @returns {boolean}
 */
function includesTerm(hay, term) {
  return hay.toLowerCase().includes(term);
}

/**
 * 领域名清洗：去掉路径分隔符与换行，避免拼出越界路径。
 * @param {string} value 原始领域名。
 * @returns {string} 安全领域名。
 */
function sanitizeDomain(value) {
  const cleaned = String(value).replace(/[\\/:*?"<>|\r\n]/gu, "").trim();
  return cleaned === "" ? "未分类" : cleaned.slice(0, 40);
}

/** 正则转义。 */
function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * 原子写：临时文件 + rename。
 * @param {string} file 目标文件。
 * @param {string} content 内容。
 */
async function atomicWrite(file, content) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, content, "utf8");
  await fs.promises.rename(tmp, file);
}

/**
 * 追加写（同样走 tmp + rename，保证不留半截文件）。
 * @param {string} file 目标文件。
 * @param {string} content 要追加的内容。
 */
async function appendToFile(file, content) {
  const kind = kindOfBook(file);
  const header = HEADER_MAP[kind] ?? `# ${kind}分册\n`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : header;
  await atomicWrite(file, existing + content);
}

/**
 * 从文件名推类别。私有工具。
 * @param {string} file 文件路径。
 * @returns {string} 类别。
 */
function kindOfBook(file) {
  return path.basename(path.dirname(file)).trim();
}

/** 新分册的头部注释。 */
const HEADER_MAP = {
  方法: `# 方法分册\n\n> 本册收录可复用的流程与做法。按领域归册，编号全局连续。\n`,
  避错: `# 避错分册\n\n> 本册收录踩过的坑。**写成前瞻式 guard，不写事故叙事**（准则 6.4）。\n`,
};

export { atomicWrite, renderEntry, normalizeEntry, sanitizeDomain, HEADER_MAP };
