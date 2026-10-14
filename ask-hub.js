// ask-hub.js —— 会议旁听"秒答"：同事在会上问了个问题，点一下，把答案找出来
//
// 跟旁听那条线的关系：
//   旁听（renderer/meeting.js + meeting.js）负责"把会上的话变成逐句原文"，
//   本模块负责"用最近的原文当问题，去资料里找答案，交给一张小卡片显示"。
//
// 答案从哪来（两层，先便宜后昂贵）：
//   ① 知识包 company-kb/srm.md —— 事先把这个项目（赛轮 SRM）固化成一份"业务+页面+流程+术语"。
//      量很小（十几 KB），**每次整包都给模型**，秒回，且口径统一。
//   ② 本地检索 D:\company 的源码与文档 —— 知识包没盖到的细节（某个字段、某段逻辑），
//      用关键词在**白名单目录**里捞几行出来一起给模型。纯本地、不发网络、不 shell。
//
// 三条自我约束（跟项目其他部分一致）：
//   1. **不编**：资料里没有就直说"没查到"，会上瞎答比不答更糟
//   2. **要能追责**：答案必须带来源（知识包 / 某个文件），主人才敢照着说
//   3. **只读**：全程不改 D:\company 里的任何文件（连临时文件都不落）

const fs = require("fs");
const path = require("path");

const KB_FILE = path.join(__dirname, "company-kb", "srm.md");

/** 检索根目录：默认就盯这台机器上的 SRM 项目，可用环境变量换 */
const PROJECT_ROOT = process.env.DSH_PET_ASK_ROOT || "D:\\company";

/**
 * 检索白名单：只扫"业务/页面/接口/状态机/文档"这几类文件。
 * 为什么要白名单：整个 D:\company 里有大量临时脚本、日志、结果 txt、构建产物，
 * 全扫进来只会拖慢检索、还会把噪音顶到答案里（"这条结论来自 build_log3.txt" 毫无意义）。
 */
const SOURCE_RULES = [
  // ① 文档放最前：量小、信息密度最高，**不能被源码把行数配额吃光**（排在后面就轮不到它们了）
  { file: "SRM系统三端实现梳理.md" },
  { dir: "项目介绍", exts: [".md", ".html"], skip: [] },
  { dir: "问题清单", exts: [".md"], skip: [] },
  { dir: "cyriex-srm", exts: [".md"], skip: ["/node_modules/", "/target/"] },
  // ② SRM 业务源码：只扫业务模块。框架层 sailun-* 是芋道脚手架（用户/权限/文件那些通用件），
  //    跟"这个项目怎么答"关系不大，全扫进来只会多几万行噪音。
  {
    dir: "cyriex-srm/srm-cloud",
    exts: [".java"],
    skip: ["/target/", "/node_modules/", "/sailun-", "/srm-module-finance/", "/srm-module-logistics/", "/srm-module-sourcing/"],
  },
  // ③ 前端：页面与文案（问"在哪儿点/这状态啥意思"全靠它）
  { dir: "cyriex-srm/srm-vue3-admin/src", exts: [".vue", ".ts"], skip: ["/node_modules/", "/dist/", "/dist-prod/"] },
  { dir: "cyriex-srm/srm-vue3-supplier/src", exts: [".vue", ".ts"], skip: ["/node_modules/", "/dist/"] },
];

const MAX_FILE_BYTES = 300 * 1024;   // 单文件上限：再大的基本是日志/数据，不是要查的东西
// 索引行数上限：白名单下实测约 15 万行，给到 25 万是**留余量**——
// 撞上限会静默丢掉排在后面的文件（表现是"有些东西搜不到"），宁可多占十几 MB 内存。
const MAX_INDEX_LINES = 250000;
const MAX_SNIPPETS = 8;              // 最多给模型几行片段
const MAX_SNIPPET_FILES = 4;         // 片段最多来自几个文件

class AskHub {
  /**
   * @param {object} opts
   * @param {(model:string, prompt:string, maxTokens:number, timeoutMs:number)=>Promise<string>} opts.askLLM
   * @param {(model:string, usage:object)=>void} [opts.recordUsage]
   * @param {(line:string)=>void} [opts.onLog]
   */
  constructor(opts = {}) {
    this.askLLM = opts.askLLM || (async () => "");
    this.recordUsage = opts.recordUsage || (() => {});
    this.onLog = opts.onLog || (() => {});
    this._kb = null;        // {text, mtimeMs, at}
    this._index = null;     // [{rel, lines}]
    this._busy = false;     // 同一时间只答一个问题（点太快就忽略后一次）
  }

  // ---- 知识包 ---------------------------------------------------------------

  /** 读知识包（按 mtime 缓存：改完知识包不用重启桌宠） */
  loadKb() {
    try {
      const st = fs.statSync(KB_FILE);
      if (this._kb && this._kb.mtimeMs === st.mtimeMs) return this._kb.text;
      const text = fs.readFileSync(KB_FILE, "utf8");
      this._kb = { text, mtimeMs: st.mtimeMs };
      this.log(`知识包已加载：${path.basename(KB_FILE)}（${Math.round(text.length / 1024)} KB）`);
      return text;
    } catch (err) {
      // 知识包没了也要能干活（只靠检索），只是会慢/差一些
      this.log(`读不到知识包（只用本地检索）：${err.message}`);
      return "";
    }
  }

  // ---- 本地检索 -------------------------------------------------------------

  /** 懒加载索引：第一次用的时候才扫目录，之后常驻内存 */
  buildIndex() {
    if (this._index) return this._index;
    const t0 = Date.now();
    const out = [];
    let lines = 0;
    const walk = (abs, rule) => {
      if (lines >= MAX_INDEX_LINES) return;
      let entries = [];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (lines >= MAX_INDEX_LINES) return;
        const child = path.join(abs, e.name);
        if (e.isDirectory()) {
          // 跳过构建产物/依赖（这些目录里的东西不是"业务真相"）
          if (rule.skip.some((s) => (child + "/").replace(/\\/g, "/").includes(s))) continue;
          walk(child, rule);
          continue;
        }
        if (!rule.exts.includes(path.extname(e.name).toLowerCase())) continue;
        try {
          if (fs.statSync(child).size > MAX_FILE_BYTES) continue;
          const text = fs.readFileSync(child, "utf8");
          const arr = text.split(/\r?\n/);
          lines += arr.length;
          out.push({ rel: path.relative(PROJECT_ROOT, child).replace(/\\/g, "/"), lines: arr });
        } catch {
          /* 读不了就跳过，不影响别的文件 */
        }
      }
    };
    for (const rule of SOURCE_RULES) {
      if (rule.file) {
        const abs = path.join(PROJECT_ROOT, rule.file);
        try {
          const text = fs.readFileSync(abs, "utf8");
          out.push({ rel: rule.file, lines: text.split(/\r?\n/) });
        } catch {
          /* 文档不在就算了 */
        }
        continue;
      }
      walk(path.join(PROJECT_ROOT, rule.dir), rule);
    }
    this._index = out;
    this.log(`检索索引就绪：${out.length} 个文件 / ${lines} 行（${Date.now() - t0} ms）`);
    return out;
  }

  /**
   * 把问题拆成"可匹配的词"。
   * 中文没空格，所以按**二字切分**（"授标比例" → 授标/标比/比例）+ 短词组整体，
   * 英文/数字按 token（长度≥2）。这套在"问一句业务问题"的场景下够用，
   * 比引分词库轻得多（不引入任何依赖）。
   */
  _tokens(q) {
    const s = String(q || "");
    const map = new Map();
    const put = (t, w) => map.set(t, Math.max(map.get(t) || 0, w));
    for (const a of s.toLowerCase().match(/[a-z0-9_]{2,}/g) || []) put(a, 2);
    for (const run of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
      if (run.length <= 6) put(run, 3);
      for (let i = 0; i + 2 <= run.length; i++) put(run.slice(i, i + 2), 1);
    }
    return [...map.entries()].map(([t, w]) => ({ t, w }));
  }

  /** 关键词打分检索：返回按文件聚合的片段（给模型当"证据"用） */
  search(query, limit = MAX_SNIPPETS) {
    const tokens = this._tokens(query);
    if (!tokens.length) return [];
    const index = this.buildIndex();
    const hits = [];
    for (const f of index) {
      for (let i = 0; i < f.lines.length; i++) {
        const raw = f.lines[i];
        if (!raw || raw.length > 400) continue;   // 超长行（压缩后的 js/数据）不要
        let score = 0;
        for (const { t, w } of tokens) {
          if (raw.includes(t)) score += w;
        }
        if (score > 0) hits.push({ rel: f.rel, no: i + 1, text: raw.trim().slice(0, 220), score });
      }
    }
    // 高分优先；同一行只留一次
    hits.sort((a, b) => b.score - a.score);
    const picked = [];
    const perFile = new Map();
    for (const h of hits) {
      if (picked.length >= limit) break;
      const n = perFile.get(h.rel) || 0;
      if (n >= 2) continue;                       // 同一个文件最多贡献 2 行，避免一个文件霸榜
      if (perFile.size >= MAX_SNIPPET_FILES && !perFile.has(h.rel)) continue;
      perFile.set(h.rel, n + 1);
      picked.push(h);
    }
    return picked;
  }

  // ---- 答题 -----------------------------------------------------------------

  /**
   * 答题主流程。
   * @param {string} question 提问（这里传的是"会议最近的对话"）
   * @param {object} [opts]
   * @param {boolean} [opts.enableSearch=true] 知识包没盖到就去翻代码
   * @returns {Promise<{ok:boolean, room?:string, answer?:string, sources?:string[], ms?:number, error?:string}>}
   */
  async answer(question, opts = {}) {
    const q = String(question || "").trim();
    if (!q) return { ok: false, error: "还没有可用的旁听原文" };
    if (this._busy) return { ok: false, error: "上一问还在查，稍等一下" };
    this._busy = true;
    const t0 = Date.now();
    try {
      const kb = this.loadKb();
      let snippets = [];
      if (opts.enableSearch !== false) {
        snippets = this.search(q);
        this.log(`本地检索：命中 ${snippets.length} 行（${snippets.map((s) => s.rel).filter((v, i, a) => a.indexOf(v) === i).length} 个文件）`);
      }
      const prompt = this._prompt(q, kb, snippets);
      const text = await this._ask(prompt);
      const parsed = this._parse(text, snippets);
      return { ok: true, ...parsed, ms: Date.now() - t0 };
    } catch (err) {
      this.log(`秒答失败：${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      this._busy = false;
    }
  }

  _prompt(question, kb, snippets) {
    const ev = snippets.length
      ? snippets.map((s, i) => `[${i + 1}] ${s.rel}:${s.no}  ${s.text}`).join("\n")
      : "（没有检索到相关片段）";
    return (
      `你是主人的项目助理，主人正在开会，同事刚问了一个关于"赛轮 SRM 项目"的问题，` +
      `主人需要一句能直接说出口的回答。\n\n` +
      `【会议最近的对话】（最后几行最可能是同事刚问的问题）\n${question}\n\n` +
      `【项目知识包】（先信这个）\n${kb || "（知识包不可用）"}\n\n` +
      `【项目检索片段】（知识包没盖到的细节看这里，路径是证据）\n${ev}\n\n` +
      `请严格按下面格式输出，不要客套话、不要代码块：\n` +
      `问：<把同事最近问的问题用一句话复述清楚；如果看不出来在问什么，就写"没听出明确的问题">\n` +
      `答：<不超过 5 行，口语化，像人在会上直接说出来的话；能带上具体页面名/字段名/状态名最好>\n` +
      `来源：<只写"知识包"，或写上面片段里的文件路径，最多两个，用、分隔>\n\n` +
      `硬性要求：\n` +
      `1. 只依据【知识包】和【检索片段】回答，**不许猜**。两边都没有就写"项目里没查到这条，建议会后确认"，并在来源里写"无"。\n` +
      `2. 不要说"根据知识包/根据检索片段"这类话，主人要能照着直接念。\n` +
      `3. 涉及状态码、比例、必填这类硬规则时，宁可把原始说法抄准，也不要概括得走样。`
    );
  }

  /**
   * 调文本模型（含"只吐思考没吐正文"的重试：deepseek-flash 的思考会吃 token 预算）。
   * 预算给 3000 起步：实测一次问答里 reasoning_tokens ≈ 1200，只给 1500 的话留給正文的太少，
   * 稍微难一点的问题就会被截断（会上答案断在半句比答得短更难看）。
   */
  async _ask(prompt) {
    let budget = 3000;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await this.askLLM("", prompt, budget, 60000);
        if (String(r || "").trim()) return r;
        if (attempt === 2) return "";
      } catch (err) {
        // textAsk 在"正文为空"时是抛错的（只吐了 reasoning），这种情况把预算翻倍再来
        const empty = /没有返回内容/.test(err.message || "");
        if (attempt === 2 || !empty || budget >= 8000) throw err;
        budget = Math.min(8000, budget * 2);
        this.log(`模型这次只吐了思考没吐正文 → 输出预算提到 ${budget} 再试一次`);
      }
    }
    return "";
  }

  /** 解析"问：/答：/来源："三段；来源拿不到就退回"我们实际给了哪些片段" */
  _parse(text, snippets) {
    const s = String(text || "").replace(/^\s*```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
    const grab = (label, next) => {
      const re = next
        ? new RegExp(`${label}\\s*[:：]?\\s*([\\s\\S]*?)(?=\\n\\s*${next}\\s*[:：]|$)`)
        : new RegExp(`${label}\\s*[:：]?\\s*([\\s\\S]*)$`);
      const m = s.match(re);
      return m ? m[1].trim() : "";
    };
    const room = grab("问", "答");
    const answer = grab("答", "来源") || s;
    // 只认两种来源：知识包、或一个像文件路径的东西。
    // 实测模型爱写成"xxx.vue:948"（带行号），所以先把行号剪掉再判断，否则整条会被误杀，
    // 那就浪费了模型给出的"具体到哪一行"这个信息。
    let sources = grab("来源")
      .split(/[、,，;；\n]/)
      .map((x) => x.trim().replace(/[:：]\d+(?:-\d+)?$/, ""))
      .filter((x) => x === "知识包" || /\.(md|java|ts|vue|html)$/i.test(x));
    sources = [...new Set(sources)].slice(0, 2);
    if (!sources.length && snippets.length) {
      sources = [...new Set(snippets.map((x) => x.rel))].slice(0, MAX_SNIPPET_FILES);
    }
    return { room, answer, sources };
  }

  log(line) {
    try {
      this.onLog(String(line));
    } catch {}
  }
}

module.exports = { AskHub, KB_FILE, PROJECT_ROOT };