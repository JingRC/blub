// meeting.js —— 会议旁听（主进程）：把"听到的话"变成**可回溯、有条理**的会议纪要
//
// 数据流（跟情绪那条线一个套路：本机先做便宜的事，只把值得的东西上云）：
//   渲染层 renderer/meeting.js：系统声环回（会议里别人说的话）+ 麦克风（我说的话）两轨
//     → 本机 VAD 切句（静音不切、太长才强制切）→ 16k 单声道 WAV 片段
//     → IPC "pet:meeting-chunk" → 本模块
//   → 串行队列调智谱 GLM-ASR（单段上限 30 秒；超时 30 秒；失败隔 6 秒重试一次）
//   → 每句原文追加进事件日志（t:"speech"，只追加不改写）+ 实时回推渲染层当字幕
//   结束时 → 每 10 分钟一段先各自小结 → 再合成一份结构化纪要（议题/决议/待办/待确认/数据点/风险）
//     → 写 data/meetings/<时间>-<标题>.md + index.json，并追加一条 t:"meeting" 汇总
//
// 三条自我约束（跟项目其他部分保持一致）：
//   1. **每次判断都有个了结**：ASR 超时/纪要超时都带原因记录（t:"miss"），不静默悬挂
//   2. **模型只负责"写"，数字由本机算**：时长/句数/发言占比这类统计我们自己算，不让模型编
//   3. **原文与纪要分开存**：日志（逐句原文）与 data/meetings（纪要文件）互不覆盖；
//      清理只删旧纪要文件，绝不回头去改事件日志

const fs = require("fs");
const path = require("path");
const EventLog = require("./eventlog");

const ASR_MODEL = "glm-asr-2512";       // 智谱语音识别（25MB / 30 秒一段）
const ASR_DEADLINE_MS = 30000;         // 单段转写上限
const ASR_RETRY_GAP_MS = 6000;         // 失败后隔多久重试一次（跟别的模型调用一致）
const MINUTES_DEADLINE_MS = 90000;     // 纪要生成（分段小结 + 总纪要）单次上限
const SEGMENT_MINUTES = 10;            // 时间轴分段粒度（也是"分段小结"的粒度）
const MAX_QUEUE = 24;                  // 转写队列积压上限：超了就丢最旧的并记原因
const MAX_PROMPT_CHARS = 40000;        // 喂给模型的原文上限（超出保留头尾，中间标注截断）
const QUIET_WARN_MS = 15 * 60000;      // 多久没听到人说话 → 提醒一句"还在开会吗"
const HEARTBEAT_TIMEOUT_MS = 3 * 60000; // 采集端多久没心跳 → 判定失联，自动收尾（别一直挂着"记录中"）
const WATCHDOG_TICK_MS = 60000;        // 看门狗的检查节奏
const MAX_SESSION_MS = 4 * 3600000;    // 一场旁听最长 4 小时（防止忘了关，白花钱）
const KEEP_LINES_IN_MEMORY = 4000;     // 内存里保留的原文行数上限（超过只保最新，日志里仍有）

function pad2(n) {
  return String(n).padStart(2, "0");
}
/** mm:ss（纪要里的时间戳一律用它，跟原文行一一对应） */
function stamp(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
function clock(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fileStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}
/** 文件名里能用的短标题（中文保留；其余字符压成下划线） */
function slug(text, fallback) {
  const s = String(text || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/_+/g, "_").slice(0, 24);
  return s || fallback;
}
/** 超长文本保留头尾、中间标注截断（头尾往往分别是"背景"和"结论/待办"） */
function capMiddle(text, max) {
  if (text.length <= max) return text;
  const half = Math.floor((max - 60) / 2);
  return `${text.slice(0, half)}\n…（中间省略 ${text.length - 2 * half} 字）…\n${text.slice(-half)}`;
}

class MeetingRecorder {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir     数据目录（userData）
   * @param {string} opts.baseUrl     智谱 base（与视觉模型同一个）
   * @param {string} opts.apiKey      智谱 key（与视觉模型同一个）
   * @param {(model:string, q:string)=>Promise<string>} opts.askLLM  文本模型（写纪要）
   * @param {(model:string, usage:object)=>void} [opts.recordUsage]
   * @param {()=>{mic:boolean,keepDays:number,hotwords:string[]}} [opts.getConfig]
   * @param {(t0:number,t1:number)=>Array<{ts:number,text:string}>} [opts.getAmbient] 会中旁注（情绪/在场）
   * @param {(line:object)=>void} [opts.onLine]     实时字幕（一句原文）
   * @param {(state:object)=>void} [opts.onState]   状态（开始/停止/句数/静音提醒）
   * @param {(result:object)=>void} [opts.onMinutes] 纪要就绪
   * @param {(line:string)=>void} [opts.onLog]
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.askLLM = opts.askLLM || (async () => "");
    this.recordUsage = opts.recordUsage || (() => {});
    this.getConfig = opts.getConfig || (() => ({ mic: false, keepDays: 30, hotwords: [] }));
    this.getAmbient = opts.getAmbient || (() => []);
    this.onLine = opts.onLine || (() => {});
    this.onState = opts.onState || (() => {});
    this.onMinutes = opts.onMinutes || (() => {});
    this.onLog = opts.onLog || (() => {});

    this.logFile = EventLog.logFileIn(this.dataDir);
    this.dir = path.join(this.dataDir, "meetings");
    this.session = null;      // 进行中的一场（start → stop）
    this.last = null;         // 最近一场的纪要（面板/追问用）
    this._queue = [];         // 待转写的音频片段
    this._pumping = false;
    this._busy = false;       // stop() 正在生成纪要（避免重复触发）
    this._quietTimer = null;
    this._maxTimer = null;
    this._beatAt = 0;         // 最近一次"采集端还活着"的时间（有心跳或送到音频都算）
    this._watchdogTimer = null;
  }

  // ---- 对外接口 -------------------------------------------------------------

  /** 开始旁听。sources 由主进程按配置给（remote=系统声 / me=麦克风） */
  start(meta = {}) {
    if (this.session) return { ok: false, error: "已经在旁听了" };
    const startedAt = Date.now();
    this.session = {
      id: `m${startedAt}`,
      startedAt,
      sources: meta.sources || { remote: true, me: false },
      title: "",
      lines: [],
      chars: 0,
      dropped: 0,
      paused: false,        // 会中休息：停采集、不转写，但这场会还在
      pausedAt: 0,          // 本次暂停开始时间（恢复时折算进 pausedMs）
      pausedMs: 0,          // 累计暂停多久（"实际记录时长"和最长时长都按扣掉它算）
      pauses: [],           // 每次休息：{offsetMs（在"实际记录时间轴"上的位置）, ms}
    };
    this._queue = [];
    this.log(`旁听开始（系统声=${this.session.sources.remote ? "开" : "关"} 麦克风=${this.session.sources.me ? "开" : "关"}）`);
    this._armTimers();
    this._pushState();
    return { ok: true, id: this.session.id, startedAt };
  }

  /** 一段音频送到（wav 是 16k 单声道 PCM 的 WAV Buffer） */
  addChunk(chunk) {
    if (!this.session || !chunk || !chunk.wav) return;
    const wav = Buffer.isBuffer(chunk.wav) ? chunk.wav : Buffer.from(chunk.wav);
    if (wav.length < 1024) return; // 太短，没意义
    if (this._queue.length >= MAX_QUEUE) {
      // 积压（网络慢/模型慢）：丢最旧的一段，并把"丢过"记下来——纪要里要能看出有洞
      this._queue.shift();
      this.session.dropped += 1;
      this._miss("asr", "队列积压，丢了最旧的一段语音", 0);
    }
    this._queue.push({ source: chunk.source === "me" ? "me" : "remote", t0: chunk.t0, t1: chunk.t1, wav });
    this._beatAt = Date.now(); // 有音频送来说明采集端活着
    this._touch();
    this._pump();
  }

  /** 结束旁听：把队列里剩下的转写完 → 生成纪要 → 落盘 */
  async stop(why = "手动结束") {
    if (!this.session) return { ok: false, error: "当前没有在旁听" };
    if (this._busy) return { ok: false, error: "正在写纪要，稍等" };
    this._busy = true;
    const s = this.session;
    const endedAt = Date.now();
    try {
      this._clearTimers();
      // 在最坏情况下（单段 30s 超时 + 6s 重试间隔 + 再 30s 超时）一段能拖到 66 秒，
      // 所以至少留 90 秒把已经收到的片段转写完，别把最后一段丢掉
      await this._drain(90000);
      // 若是在暂停状态下结束的，把这段休息也结算进去（否则时长会把它算成"在听"）。
      // 注意要**同时补一条 pauses 记录**：不补的话"休息过"这件事在纪要里会凭空消失
      // （pauses 平时是在 resume() 里记的，而这次没人来 resume）。
      if (s.paused) {
        const restMs = Math.max(0, endedAt - s.pausedAt);
        const at = Math.max(0, s.pausedAt - s.startedAt - s.pausedMs);
        s.pauses.push({ offsetMs: at, ms: restMs });
        s.pausedMs += restMs;
        s.paused = false;
        s.pausedAt = 0;
      }
      this.session = null;
      this.log(`旁听结束（${why}）：${s.lines.length} 句 / 实际 ${Math.round((endedAt - s.startedAt - s.pausedMs) / 1000)} 秒${s.pausedMs ? `（另暂停 ${Math.round(s.pausedMs / 1000)} 秒）` : ""}${s.dropped ? ` / 丢过 ${s.dropped} 段` : ""}`);

      if (!s.lines.length) {
        this._miss("meeting", "这场旁听没转出任何内容", endedAt - s.startedAt);
        this._pushState({ active: false, empty: true });
        return { ok: false, error: "这场没听到可转写的内容（可以看看是不是没声音/麦克风被占用）" };
      }

      const minutes = await this._buildMinutes(s, endedAt, why);
      this.last = minutes;
      this._writeFiles(minutes);
      this._appendMeetingRecord(minutes);
      this._pruneOldFiles();
      this.onMinutes(minutes);
      this._pushState({ active: false, minutes: minutes.title });
      return { ok: true, minutes };
    } catch (err) {
      this.log(`旁听结束处理失败：${err.message}`);
      this._miss("meeting", `结束处理失败：${err.message}`, endedAt - s.startedAt);
      return { ok: false, error: err.message };
    } finally {
      this._busy = false;
    }
  }

  /**
   * 暂停旁听（会中休息）：采集端会停掉音频轨，**这场会不结束、不出纪要**，
   * 等 resume() 接着记。暂停期间不转写、不上传，也不提醒"还在开会吗"。
   * 时间轴的做法：休息时间从"实际记录时间轴"里**跳过**（继续后接着往后排），
   * 所以记完的原文是连续的，休息这件事在纪要第一节里单独说明。
   */
  pause(why = "手动暂停") {
    const s = this.session;
    if (!s) return { ok: false, error: "当前没有在旁听" };
    if (s.paused) return { ok: false, error: "已经在暂停中" };
    s.paused = true;
    s.pausedAt = Date.now();
    // 暂停期间别提醒"还在开会吗"（人可能真的在休息）；恢复时重新计时
    if (this._quietTimer) { clearTimeout(this._quietTimer); this._quietTimer = null; }
    // 最长时长按"实际在听"算：暂停时不烧额度，否则午休回来就被判超时
    if (this._maxTimer) { clearTimeout(this._maxTimer); this._maxTimer = null; }
    this.log(`旁听暂停（${why}）`);
    this._pushState();
    return { ok: true, paused: true };
  }

  /** 继续旁听（采集端会重新接上音频轨） */
  resume(why = "手动继续") {
    const s = this.session;
    if (!s) return { ok: false, error: "当前没有在旁听" };
    if (!s.paused) return { ok: false, error: "现在不是在暂停中" };
    const now = Date.now();
    const ms = Math.max(0, now - s.pausedAt);
    // 这次休息在"实际记录时间轴"上的位置 = 暂停那一刻已经记了多久
    const offsetMs = Math.max(0, s.pausedAt - s.startedAt - s.pausedMs);
    s.paused = false;
    s.pausedAt = 0;
    s.pausedMs += ms;
    s.pauses.push({ offsetMs, ms });
    this._beatAt = now;       // 重新起算，别让看门狗把"刚恢复"当成失联
    this._touch();            // 静音提醒重新计时
    this._armMaxTimer();      // 按剩余额度重新武装最长时长
    this.log(`旁听继续（${why}）：休息了 ${Math.round(ms / 1000)} 秒`);
    this._pushState();
    return { ok: true, paused: false, pauseMs: ms };
  }

  /** 当前状态（渲染层轮询/面板用） */
  status() {
    const s = this.session;
    return {
      active: !!s,
      paused: !!(s && s.paused),
      startedAt: s ? s.startedAt : 0,
      lines: s ? s.lines.length : 0,
      pending: this._queue.length,
      sources: s ? s.sources : null,
      lastLines: s ? s.lines.slice(-8).map((l) => ({ ts: l.ts, src: l.src, text: l.text })) : [],
      minutes: this.last ? { title: this.last.title, file: this.last.file, startedAt: this.last.startedAt } : null,
    };
  }

  /** 最近一场纪要的全文（面板渲染用；没有就返回 null） */
  latest() {
    if (!this.last) this.hydrateLast();
    return this.last;
  }

  /**
   * 最近一段原文 —— 给"秒答"当问题用（同事刚问的那句就在这几行里）。
   *   正在旁听 → 取最近 windowMs 内的句子（按时间轴截，不是按条数，免得停停说说时截到很久以前）
   *   已经结束 → 取最近那场纪要的尾部（刚散会有人追问，也答得上）
   * @returns {Array<{src:string, text:string, offsetMs:number}>}
   */
  recentLines(windowMs = 120000, limit = 12) {
    const s = this.session;
    const all = s ? s.lines : (this.last && this.last.lines) || [];
    if (!all.length) return [];
    const tail = all.slice(-limit);
    const picked = s
      ? (() => {
          const cut = (tail[tail.length - 1].offsetMs || 0) - windowMs;
          return tail.filter((l) => (l.offsetMs || 0) >= cut);
        })()
      : tail;
    return picked.map((l) => ({ src: l.src, text: l.text, offsetMs: l.offsetMs || 0 }));
  }

  /**
   * 重启后"最近一场"就不在内存里了 → 从**事件日志**把它捞回来（逐句原文都在 `speech` 行里）。
   * 为什么能这么做：日志是唯一真源，`meeting` 汇总 + 它的 `speech` 行足够还原追问所需的上下文；
   * 纪要正文再从 md 文件读回来。找不到（没开过会/日志被折叠掉了）就保持 null，追问会如实说没有。
   */
  hydrateLast() {
    if (this.last) return this.last;
    try {
      const { records } = EventLog.read(this.logFile);
      let rec = null;
      const speeches = [];
      for (const r of records) {
        if (!r || typeof r !== "object") continue;
        if (r.t === "meeting") rec = r;           // 取最后一条会议汇总
        else if (r.t === "speech") speeches.push(r);
      }
      if (!rec) return null;
      const startedAt = rec.startedAt || rec.ts || 0;
      const lines = speeches
        .filter((x) => !x.meeting || !rec.id || x.meeting === rec.id)
        .map((x) => ({
          ts: x.ts || startedAt,
          offsetMs: Math.max(0, (x.ts || startedAt) - startedAt),
          durMs: x.durMs || 0,
          src: x.src === "me" ? "me" : "remote",
          text: x.text || "",
        }))
        .filter((x) => x.text);
      if (!lines.length) return null;
      const name = rec.file ? path.basename(rec.file) : "";
      let markdown = "";
      if (name) {
        try {
          markdown = fs.readFileSync(path.join(this.dir, name), "utf8");
        } catch {}
      }
      const endedAt = rec.endedAt || rec.ts || startedAt;
      this.last = {
        id: rec.id || "",
        title: rec.title || "会议纪要",
        startedAt,
        endedAt,
        durMs: rec.durMs || endedAt - startedAt,
        lines,
        stats: this._stats({ startedAt, lines, chars: lines.reduce((a, x) => a + x.text.length, 0) }, endedAt),
        markdown,
        file: name ? path.join(this.dir, name) : "",
        fallback: !markdown,
      };
      this.log(`已从事件日志恢复最近一场（${lines.length} 句）：${this.last.title}`);
      return this.last;
    } catch (err) {
      this.log(`恢复最近一场失败（不影响使用）：${err.message}`);
      return null;
    }
  }

  /** 清一次超期纪要文件（主进程启动时调；只删 data/meetings 下的旧文件，事件日志一行不动） */
  pruneOld() {
    this._pruneOldFiles();
  }

  /** 历次会议（读 index.json，最新在前）——"会议记录"窗口的列表用 */
  listMeetings() {
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(this.dir, "index.json"), "utf8"));
      if (!Array.isArray(idx)) return [];
      return idx
        .filter((e) => e && e.file)
        .map((e) => ({
          id: e.id || "",
          file: e.file,
          title: e.title || "会议纪要",
          startedAt: Number(e.startedAt) || 0,
          endedAt: Number(e.endedAt) || 0,
          durMs: Number(e.durMs) || 0,
          lines: Number(e.lines) || 0,
          fallback: !!e.fallback,
        }))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 200);
    } catch {
      return [];
    }
  }

  /**
   * 读某一份纪要的正文（会议记录窗口点历史用）。
   * **只接受 data/meetings 目录下的纯文件名**：窗口传来的字符串不可信，
   * basename 不等于原串（含路径分隔符/上跳）就直接拒绝，免得被读成任意文件。
   */
  readMeeting(name) {
    const valid = this._resolve(name);
    if (!valid.ok) return valid;
    try {
      const markdown = fs.readFileSync(valid.file, "utf8");
      return { ok: true, file: valid.file, meta: valid.meta, markdown };
    } catch (err) {
      return { ok: false, error: `读不到这份纪要（可能已经被清理）：${err.message}` };
    }
  }

  /**
   * 改名：一处改，三处跟着走——
   *   ① md 文件名（保持"日期_时间_标题.md"的形状，排序不被打乱）
   *   ② md 正文第一行的大标题
   *   ③ index.json 里的 title/file
   * 另外往事件日志**追加**一条 `meeting-rename`（不去改那条历史的 `meeting` 行），
   * 由 eventlog.derive 把新标题应用到时间线上——跟"推测原因回填 change"是同一个套路。
   * @returns {{ok:boolean, error?:string, title?:string, file?:string}}
   */
  renameMeeting(file, title) {
    const valid = this._resolve(file);
    if (!valid.ok) return valid;
    const clean = String(title || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!clean) return { ok: false, error: "标题不能是空的" };
    const oldName = valid.base;
    const m = oldName.match(/^(\d{4}-\d{2}-\d{2}_\d{4})_(.*)\.md$/);
    const prefix = m ? m[1] : fileStamp(valid.meta.startedAt || Date.now());
    const newName = `${prefix}_${slug(clean, "会议")}.md`;
    try {
      if (newName !== oldName) {
        // 同名撞车（同一天同一时间改两次名之类）：补一个后缀，别把别人的文件盖了
        let finalName = newName;
        let n = 2;
        while (fs.existsSync(path.join(this.dir, finalName)) && finalName !== oldName) {
          finalName = `${prefix}_${slug(clean, "会议")}-${n}.md`;
          n += 1;
        }
        fs.renameSync(valid.file, path.join(this.dir, finalName));
        valid.meta.file = finalName;
      }
      const md = fs.readFileSync(path.join(this.dir, valid.meta.file), "utf8");
      const firstLine = md.split(/\r?\n/, 1)[0] || "";
      const rest = md.split(/\r?\n/).slice(1).join("\n");
      fs.writeFileSync(path.join(this.dir, valid.meta.file), firstLine.startsWith("# ") ? `# ${clean}\n${rest}` : `# ${clean}\n${md}`, "utf8");

      const idx = this._readIndex();
      const hit = idx.find((e) => e && e.file === oldName);
      if (hit) {
        hit.title = clean;
        hit.file = valid.meta.file;
      }
      this._writeIndex(idx);
      try {
        EventLog.append(this.logFile, { t: "meeting-rename", ts: Date.now(), id: valid.meta.id || "", title: clean, file: valid.meta.file });
      } catch {}
      this.log(`纪要改名：${oldName} → ${valid.meta.file}（${clean}）`);
      return { ok: true, title: clean, file: valid.meta.file };
    } catch (err) {
      this.log(`改名失败：${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /** 从索引里摘掉一条（文件已经进回收站了；事件日志里的历史不动） */
  forget(file) {
    const valid = this._resolve(file);
    if (!valid.ok) return valid;
    const idx = this._readIndex().filter((e) => !(e && (e.file === valid.base || e.id === valid.meta.id)));
    this._writeIndex(idx);
    return { ok: true };
  }

  _readIndex() {
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(this.dir, "index.json"), "utf8"));
      return Array.isArray(idx) ? idx : [];
    } catch {
      return [];
    }
  }

  _writeIndex(idx) {
    const f = path.join(this.dir, "index.json");
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(idx.slice(-200), null, 2));
    fs.renameSync(tmp, f);
  }

  /** 校验"纯文件名"并取出绝对路径 + 元信息（改名/读/删共用同一道闸） */
  _resolve(name) {
    const raw = String(name || "");
    const base = path.basename(raw);
    if (!base || base !== raw || !base.toLowerCase().endsWith(".md")) return { ok: false, error: "文件名不合法" };
    const file = path.join(this.dir, base);
    const meta = this.listMeetings().find((e) => e.file === base) || { id: "", file: base, title: base.replace(/\.md$/, ""), startedAt: 0 };
    return { ok: true, base, file, meta };
  }

  /** 会后追问：拿"最近一场的纪要 + 原文"当上下文问一句（只在本地组 prompt，走文本模型） */
  async ask(question) {
    const q = String(question || "").trim();
    if (!q) return { ok: false, error: "没写问题" };
    const m = this.latest(); // 重启后从日志恢复，别让"每次重启就追不了上次的会"
    if (!m) return { ok: false, error: "还没有可追问的会议" };
    const ctx = capMiddle(
      [
        `【纪要】\n${m.markdown}`,
        `【原文节选】\n${m.lines.slice(-400).map((l) => `[${stamp(l.offsetMs)}] ${l.src === "me" ? "我" : "对方"}：${l.text}`).join("\n")}`,
      ].join("\n\n"),
      40000,
    );
    const prompt =
      `你是会议助手。下面是刚才那场会议的纪要和原文节选。请只依据这些内容回答，` +
      `答不上来就直说"记录里没有提到"，不要编。回答里如果引用了原话，带上【mm:ss】时间戳。\n\n` +
      `${ctx}\n\n【问题】${q}`;
    try {
      const answer = await this._text(prompt, MINUTES_DEADLINE_MS, 3000);
      return { ok: true, answer: String(answer || "").trim() || "（模型没给出内容）" };
    } catch (err) {
      this._miss("meeting-ask", `追问失败：${err.message}`, 0);
      return { ok: false, error: err.message };
    }
  }

  // ---- 转写（队列 + 超时 + 重试）-------------------------------------------

  /** 队列泵：**串行**转写，保证原文顺序和时间轴一致（并发会让前一句后落地） */
  async _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this._queue.length) {
        const c = this._queue.shift();
        const text = await this._transcribeWithRetry(c);
        if (text) this._accept(c, text);
      }
    } finally {
      this._pumping = false;
      this._pushState();
    }
  }

  /** 等队列清空（结束前用；等不到就带着"还剩几段"继续，别把主人卡在结束按钮上） */
  async _drain(maxMs) {
    const t0 = Date.now();
    while ((this._queue.length || this._pumping) && Date.now() - t0 < maxMs) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (this._queue.length) this._miss("asr", `结束前还有 ${this._queue.length} 段没转写完`, Date.now() - t0);
  }

  async _transcribeWithRetry(c) {
    const cfg = this.getConfig() || {};
    const hotwords = Array.isArray(cfg.hotwords) ? cfg.hotwords.join(",") : "";
    // 上下文：上一句原文（ASR 有上下文提示时会明显更准，尤其是人名和项目代号）
    const prev = this.session && this.session.lines.length
      ? this.session.lines[this.session.lines.length - 1].text
      : "";
    const t0 = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const text = await this._asr(c.wav, { hotwords, prompt: prev });
        return text;
      } catch (err) {
        const ms = Date.now() - t0;
        if (attempt === 1 && err.name !== "AbortError") {
          this.log(`转写失败，${ASR_RETRY_GAP_MS / 1000} 秒后重试一次：${err.message}`);
          await new Promise((r) => setTimeout(r, ASR_RETRY_GAP_MS));
          continue;
        }
        // 两次都没成：记一条"没结论"，纪要里会显示这段是空的
        this._miss("asr", `转写失败（${err.name === "AbortError" ? "超时" : err.message}）`, ms);
        return "";
      }
    }
    return "";
  }

  /** 真正调 ASR：multipart/form-data，字段跟官方 cURL 一致（实测 200：返回 {text, usage}） */
  async _asr(wav, { hotwords, prompt }) {
    const fd = new FormData();
    fd.append("model", ASR_MODEL);
    fd.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
    if (hotwords) fd.append("hotwords", hotwords);
    if (prompt) fd.append("prompt", prompt.slice(-400)); // 只带最近一点上下文，别把 prompt 撑爆
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ASR_DEADLINE_MS);
    try {
      const resp = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: fd,
        signal: ctrl.signal,
      });
      const raw = await resp.text();
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${raw.slice(0, 160)}`);
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`返回不是 JSON：${raw.slice(0, 120)}`);
      }
      if (data && data.usage) this.recordUsage(ASR_MODEL, data.usage);
      return String((data && (data.text || data.result)) || "").replace(/\s+/g, " ").trim();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 收下一句：落日志（只追加）+ 进内存 + 回推渲染层当字幕 */
  _accept(c, text) {
    const s = this.session;
    if (!s) return;
    const clean = String(text).trim();
    if (!clean) return;
    // ASR 偶尔会复读上一句（尤其是静音段被切进来）：连着重复的就不要了
    const prev = s.lines[s.lines.length - 1];
    if (prev && prev.text === clean && prev.src === c.source) return;
    const offsetMs = Math.max(0, (Number(c.t0) || Date.now()) - s.startedAt);
    const durMs = Math.max(0, (Number(c.t1) || 0) - (Number(c.t0) || 0));
    const line = { ts: Number(c.t0) || Date.now(), offsetMs, durMs, src: c.source, text: clean };
    s.lines.push(line);
    if (s.lines.length > KEEP_LINES_IN_MEMORY) s.lines.shift(); // 内存只留最新的（日志里全在）
    s.chars += clean.length;
    try {
      EventLog.append(this.logFile, {
        t: "speech",
        ts: line.ts,
        meeting: s.id,
        src: line.src,
        text: line.text,
        durMs: line.durMs,
      });
    } catch (err) {
      this.log(`原文落盘失败（继续，不影响纪要）：${err.message}`);
    }
    this.onLine({ ...line, count: s.lines.length });
    this._pushState();
  }

  // ---- 纪要 -----------------------------------------------------------------

  /**
   * 生成纪要：先把原文按 SEGMENT_MINUTES 分段各自小结（这一步也顺便产出"时间轴分段"），
   * 再合成一份总纪要。分两步的好处：长会也不会超出上下文，而且每段的细节不会被压掉。
   */
  async _buildMinutes(s, endedAt, why) {
    const buckets = this._buckets(s.lines);
    const segSummaries = new Array(buckets.length);
    // 分段小结**并发**跑（限流 3 路）：一段要十几二十秒，串行等的话 3 小时的会要 5~8 分钟，
    // 并发后 2~3 分钟就出结果；限流是为了别把免费池打爆（打爆了反而集体重试、更慢）。
    let done = 0;
    this._pushProgress(0, buckets.length);
    await this._pool(
      buckets.map((b, idx) => async () => {
        const text = b.lines.map((l) => `[${stamp(l.offsetMs)}] ${l.src === "me" ? "我" : "对方"}：${l.text}`).join("\n");
        try {
          const out = await this._text(this._segmentPrompt(b, text), MINUTES_DEADLINE_MS, 4000);
          segSummaries[idx] = { from: b.from, to: b.to, raw: out, json: this._parseJson(out) };
        } catch (err) {
          this._miss("minutes-segment", `第 ${stamp(b.from)} 段小结失败：${err.message}`, 0);
          segSummaries[idx] = { from: b.from, to: b.to, raw: "", json: null };
        } finally {
          this._pushProgress(++done, buckets.length);
        }
      }),
      3,
    );

    // 分段跑完后还要合成整篇（最长 90 秒），进度条得往前挪一格，不然一直停在"N/N 段"像卡死
    this._pushProgress(buckets.length, buckets.length, true);

    const stats = this._stats(s, endedAt);
    let body = "";
    let title = "";
    try {
      const parsed = this._parseFinal(await this._text(this._finalPrompt(s, stats, segSummaries), MINUTES_DEADLINE_MS, 8000));
      title = parsed.title;
      body = parsed.body;
      if (!body) this.log("总纪要这次没吐正文（走进兜底版）");
    } catch (err) {
      this._miss("minutes", `总纪要生成失败：${err.message}`, 0);
    }

    // 兜底：模型没产出（超时/限流）也要给主人一份能用的东西——统计 + 时间轴原文，
    // 并明说"这份是自动兜底版，原因写在这里"，而不是静默"纪要没了"。
    const fallback = !body;
    if (fallback) {
      body = [
        "## 三、时间轴分段（自动兜底版）",
        ...segSummaries.map((sg) => {
          const raw = String(sg.raw || "").trim();
          const inner = sg.json
            ? (sg.json.points || []).map((p) => `- ${p}`).join("\n")
            : raw || "- （这段没生成小结）";
          return `**${stamp(sg.from)}–${stamp(sg.to)}**\n${inner}`;
        }),
        "## 附：原文时间轴（按句）",
        ...s.lines.map((l) => `- 【${stamp(l.offsetMs)}】${l.src === "me" ? "我" : "对方"}：${l.text}`),
      ].join("\n");
    }

    // 模型没给标题就自己起一个（标题要进文件名，不能空着）
    if (!title) title = this._guessTitle(body, s.startedAt, fallback);

    const markdown = [
      `# ${title || "会议纪要"}`,
      "",
      `> 旁听时间：${clock(s.startedAt)} – ${clock(endedAt)}（实际记录 ${stats.minutes} 分钟${stats.pauses ? `，期间暂停 ${stats.pauses} 次共 ${this._spanText(stats.pausedSec)}` : ""}）· 结束方式：${why}`,
      fallback ? "> ⚠️ 这份是**自动兜底版**：模型这次没能产出结构化纪要（原因已记进事件日志），下面是自动统计与原文。\n" : "",
      "## 一、会议基本盘（本机统计，未经过模型）",
      `- 记录 ${stats.lines} 句 / ${stats.chars} 字；我方 ${stats.meLines} 句、对方 ${stats.remoteLines} 句`,
      `- 我方说话时长约 ${stats.meSec} 秒、对方约 ${stats.remoteSec} 秒（按语音段时长累加，非精确）`,
      s.dropped ? `- ⚠️ 期间有 ${s.dropped} 段语音因积压被丢弃，"原文时间轴"里会缺这几处` : "- 没有丢段",
      (s.pauses || []).length
        ? `- 会中休息 ${s.pauses.length} 次（时间轴已跳过休息，原文前后是接着的）：${s.pauses.map((p) => `【${stamp(p.offsetMs)}】起停了 ${this._spanText(Math.round(p.ms / 1000))}`).join("；")}`
        : "- 全程没有暂停",
      "",
      "## 二、时间轴分段小结",
      ...segSummaries.map((sg) => {
        const j = sg.json;
        const head = `### ${stamp(sg.from)} – ${stamp(sg.to)}${j && j.topic ? ` · ${j.topic}` : ""}`;
        if (!j) {
          // JSON 没解析出来 ≠ 模型没写：把它的原文（markdown）照收，别白丢十分钟内容
          const raw = String(sg.raw || "").trim();
          return raw ? `${head}\n${raw}` : `${head}\n- （这段没生成小结，可看附录原文）`;
        }
        const rows = [];
        for (const p of j.points || []) rows.push(`- ${p}`);
        for (const d of j.decisions || []) rows.push(`- ✅ 决议：${d}`);
        for (const t of j.todos || []) {
          if (t && typeof t === "object") rows.push(`- ⏰ 待办：${t.what || ""}${t.owner ? `（${t.owner}）` : ""}${t.due ? ` 截止 ${t.due}` : ""}${t.at ? ` 【${t.at}】` : ""}`);
          else rows.push(`- ⏰ 待办：${t}`);
        }
        for (const o of j.open || []) rows.push(`- ❓ 待确认：${o}`);
        for (const dd of j.data || []) rows.push(`- 📊 数据：${dd}`);
        return `${head}\n${rows.join("\n")}`;
      }),
      "",
      body,
      "",
      "## 九、旁听旁注（本机感知，模型看不到）",
      ...(this._ambient(s.startedAt, endedAt).length
        ? this._ambient(s.startedAt, endedAt).map((a) => `- ${clock(a.ts).slice(11)} ${a.text}`)
        : ["- （这段时间没捕捉到情绪突变或长时间离座）"]),
      "",
      !fallback && !/附：原文时间轴/.test(body) ? this._rawAppendix(s) : "",
    ].filter((x) => x !== "").join("\n");

    return {
      id: s.id,
      title: title || "会议纪要",
      startedAt: s.startedAt,
      endedAt,
      // 时长按"实际记录"算（扣掉休息）：列表里的"时长"跟纪要正文里的口径要一致
      durMs: Math.max(0, endedAt - s.startedAt - (s.pausedMs || 0)),
      lines: s.lines.map((l) => ({ ts: l.ts, offsetMs: l.offsetMs, src: l.src, text: l.text })),
      stats,
      markdown,
      file: "",
      fallback,
    };
  }

  /**
   * 模型没给标题时的兜底：优先从"议题"第一条里抠一句短的，抠不出来就用时间。
   * （实测模型偶尔会漏 title 字段，标题又直接进文件名，不能不管）
   */
  _guessTitle(body, startedAt, fallback) {
    const d = new Date(startedAt);
    const byTime = `会议纪要 · ${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (fallback) return byTime;
    const m = String(body || "").match(/^\s*[-*]\s+(.{4,60})$/m);
    if (m) {
      const t = m[1].replace(/【\d{2}:\d{2}】/g, "").replace(/\*\*/g, "").split(/[，。；、:：]/)[0].trim();
      if (t.length >= 4) return t.slice(0, 18);
    }
    return byTime;
  }

  _rawAppendix(s) {
    return ["", "## 附：原文时间轴（按句，可回溯）", ...s.lines.map((l) => `- 【${stamp(l.offsetMs)}】${l.src === "me" ? "我" : "对方"}：${l.text}`)].join("\n");
  }

  _buckets(lines) {
    const out = [];
    const span = SEGMENT_MINUTES * 60000;
    for (const l of lines) {
      const b = out[out.length - 1];
      if (b && l.offsetMs - b.from < span) {
        b.lines.push(l);
        b.to = l.offsetMs + (l.durMs || 0);
      } else {
        out.push({ from: l.offsetMs, to: l.offsetMs + (l.durMs || 0), lines: [l] });
      }
    }
    return out;
  }

  _stats(s, endedAt) {
    const sum = (src) => s.lines.filter((l) => l.src === src).reduce((a, l) => a + (l.durMs || 0), 0);
    // 时长一律按"实际在听"算：休息（暂停）的那段不算，跟时间轴（跳过休息）保持一致
    const pausedMs = Math.max(0, s.pausedMs || 0);
    return {
      minutes: Math.max(1, Math.round((endedAt - s.startedAt - pausedMs) / 60000)),
      pauses: (s.pauses || []).length,
      pausedSec: Math.round(pausedMs / 1000),
      lines: s.lines.length,
      chars: s.chars,
      meLines: s.lines.filter((l) => l.src === "me").length,
      remoteLines: s.lines.filter((l) => l.src === "remote").length,
      meSec: Math.round(sum("me") / 1000),
      remoteSec: Math.round(sum("remote") / 1000),
    };
  }

  /** 秒数说成"X 分钟"或"X 秒"（休息时长读起来不别扭） */
  _spanText(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return s >= 60 ? `${Math.round(s / 60)} 分钟` : `${s} 秒`;
  }

  _ambient(t0, t1) {
    try {
      const list = this.getAmbient(t0, t1) || [];
      return list.slice(0, 40);
    } catch {
      return [];
    }
  }

  _segmentPrompt(b, text) {
    return (
      `你是严谨的会议纪要助手。下面是线上会议第 ${stamp(b.from)}–${stamp(b.to)} 这一段（约 ${SEGMENT_MINUTES} 分钟）的逐句语音转写。` +
      `"对方"是会议里其他人的声音，"我"是参会主人的声音；转写可能有错别字和听错的地方。\n\n` +
      `${text}\n\n` +
      `请只输出一个 JSON 对象（不要代码块、不要解释），字段如下：\n` +
      `{"topic":"这段在谈什么，≤14字","points":["要点，一句一条，引用原话时带上【mm:ss】时间戳"],` +
      `"decisions":["明确的结论/决议，带【mm:ss】"],"todos":[{"what":"要做什么","owner":"谁负责（没提到就空着）","due":"截止时间（没提到就空着）","at":"mm:ss"}],` +
      `"open":["没定下来、需要再确认的问题"],"data":["价格/日期/数量/型号等硬信息，带【mm:ss】"]}\n` +
      `没有内容的字段就给空数组。不要评价、不要补充会议里没有的信息。`
    );
  }

  /** 并发限流跑一批任务（每段小结自带兜底，这里只负责别一次打太多） */
  async _pool(tasks, limit) {
    const queue = tasks.slice();
    const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
      while (queue.length) {
        const task = queue.shift();
        if (task) await task();
      }
    });
    await Promise.all(workers);
  }

  /** 写纪要的进度（渲染层拿它在字幕条上显示"整理 2/5 段"，省得主人以为卡死了） */
  _pushProgress(done, total, final) {
    try {
      this.onState({ active: false, phase: "minutes", done, total, final: !!final, lines: 0 });
    } catch {}
  }

  /**
   * 解析总纪要输出：约定是"第一行 `# 标题`，后面是 markdown 正文"。
   * 为什么不继续用 JSON：正文里全是中文标点、引号、换行，塞进 JSON 字符串很容易被模型写坏
   * （一坏就掉进兜底版）。markdown 是模型最擅长的格式，坏不了。
   */
  _parseFinal(text) {
    const s = String(text || "")
      .replace(/^\s*```(?:markdown|md)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    const m = s.match(/^#\s+(.+)$/m);
    const title = m ? m[1].trim().slice(0, 40) : "";
    const body = (m ? s.replace(m[0], "") : s).replace(/^\s*\n/, "").trim();
    return { title, body };
  }

  _finalPrompt(s, stats, segSummaries) {
    // 小结没解析成 JSON 时**别当它不存在**：模型明明写了东西（raw），只是格式没守规矩。
    // 直接把原文喂进去，比"本段缺失"强得多（不然一段十分钟的内容就这么没了）。
    const segText = segSummaries
      .map((sg) => {
        const head = `【${stamp(sg.from)}–${stamp(sg.to)}】`;
        if (sg.json) return `${head}${JSON.stringify(sg.json)}`;
        const raw = String(sg.raw || "").trim();
        return `${head}${raw ? raw.slice(0, 1500) : "（本段小结缺失）"}`;
      })
      .join("\n");
    const raw = capMiddle(s.lines.map((l) => `[${stamp(l.offsetMs)}] ${l.src === "me" ? "我" : "对方"}：${l.text}`).join("\n"), MAX_PROMPT_CHARS);
    return (
      `你是严谨的会议纪要助手。下面是一场线上会议的**分段小结**和**原文**。请合成一份有条理的会议纪要正文。\n` +
      `硬性要求：\n` +
      `1. 只依据给到的内容，不要编造；不确定的地方写进"待确认"。\n` +
      `2. 每条结论/待办/数据后面带【mm:ss】时间戳（用原文里的时间戳），方便回听原话。\n` +
      `3. 待办要尽量写清"做什么 / 谁 / 什么时候"，没提到就留空，不要瞎填。\n` +
      `4. 别写"会议基本盘/时间轴分段"这两节（那两节由本机自动生成，你写了会被丢掉）。\n` +
      `5. 语气中性，不做评价。\n\n` +
      `【分段小结】\n${segText}\n\n【原文】\n${raw}\n\n` +
      `输出格式（严格遵守；**不要 JSON、不要代码块**，正文里该有的中文标点照常用）：\n` +
      `第一行只写一个大标题：# 标题（≤18 字，具体一点，例如"与客户确认报价与交付节点"）\n` +
      `然后依次输出下面这几节，节标题文字照抄：\n` +
      `## 三、议题与讨论\n（按议题分条，每条一句结论性描述 + 依据【mm:ss】）\n` +
      `## 四、结论与决议\n` +
      `## 五、待办清单\n（每条写成"- [ ] 事项 — 负责人 — 截止 — 依据【mm:ss】"，没提到的留空）\n` +
      `## 六、待确认的问题\n` +
      `## 七、关键数据点\n` +
      `## 八、风险与分歧\n` +
      `（说明：本机统计——共 ${stats.minutes} 分钟、${stats.lines} 句，我方 ${stats.meLines} 句 / 对方 ${stats.remoteLines} 句。）`
    );
  }

  /**
   * 调文本模型。两个坑都在这里兜住：
   *   ① **空内容要重试**：deepseek-flash 先输出"思考"再输出正文，思考会把 max_tokens 吃光 →
   *      正文长度 0（实测 max_tokens=4000 时 4000 token 全是思考，finish_reason=length）。
   *      遇到空内容就把预算翻倍再来一次，别让整份纪要掉进兜底版。
   *   ② 超时上限由调用处给（写纪要要几十秒，不能按"推测一句原因"的 30 秒算）。
   * @param {number} maxTokens 输出预算：分段小结 4000、总纪要 8000、追问 3000
   */
  async _text(prompt, deadlineMs, maxTokens) {
    let budget = maxTokens;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const out = await this._textOnce(prompt, deadlineMs, budget);
      if (String(out || "").trim()) return out;
      if (attempt === 2 || budget >= 8000) return out; // 已经给到模型上限，认了
      budget = Math.min(8000, Math.round(budget * 2));
      this.log(`模型这次只吐了思考没吐正文 → 输出预算提到 ${budget} 再试一次`);
    }
    return "";
  }

  /** 单次调用（超时用 race 掐断；真正的 HTTP 超时由主进程那层控制） */
  async _textOnce(prompt, deadlineMs, maxTokens) {
    const p = this.askLLM("", prompt, maxTokens);
    let timer = null;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => {
        const e = new Error(`超时（${Math.round(deadlineMs / 1000)} 秒）`);
        e.name = "AbortError";
        rej(e);
      }, deadlineMs);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 从模型输出里抠出 JSON（容忍 ```json 包裹和前后废话） */
  _parseJson(text) {
    const s = String(text || "");
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1] : s;
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const obj = JSON.parse(body.slice(start, end + 1));
      return obj && typeof obj === "object" ? obj : null;
    } catch {
      return null;
    }
  }

  // ---- 落盘 -----------------------------------------------------------------

  _writeFiles(minutes) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const name = `${fileStamp(minutes.startedAt)}_${slug(minutes.title, "会议")}.md`;
      const file = path.join(this.dir, name);
      fs.writeFileSync(file, minutes.markdown, "utf8");
      minutes.file = file;
      const idxFile = path.join(this.dir, "index.json");
      let idx = [];
      try {
        idx = JSON.parse(fs.readFileSync(idxFile, "utf8"));
        if (!Array.isArray(idx)) idx = [];
      } catch {
        idx = [];
      }
      idx.push({
        id: minutes.id,
        file: name,
        title: minutes.title,
        startedAt: minutes.startedAt,
        endedAt: minutes.endedAt,
        durMs: minutes.durMs,
        lines: minutes.lines.length,
        fallback: !!minutes.fallback,
      });
      const tmp = idxFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(idx.slice(-200), null, 2));
      fs.renameSync(tmp, idxFile);
      this.log(`纪要已存：${name}`);
    } catch (err) {
      this.log(`纪要落盘失败：${err.message}`);
      this._miss("meeting", `纪要落盘失败：${err.message}`, 0);
    }
  }

  _appendMeetingRecord(minutes) {
    try {
      EventLog.append(this.logFile, {
        t: "meeting",
        ts: minutes.endedAt,
        id: minutes.id,
        title: minutes.title,
        startedAt: minutes.startedAt,
        endedAt: minutes.endedAt,
        durMs: minutes.durMs,
        lines: minutes.lines.length,
        chars: minutes.stats.chars,
        file: minutes.file ? path.basename(minutes.file) : "",
      });
    } catch (err) {
      this.log(`会议汇总落盘失败：${err.message}`);
    }
  }

  /** 清理超期的旧纪要文件（只删文件，不动事件日志里的任何一行） */
  _pruneOldFiles(keepDaysOverride) {
    try {
      const keepDays = Number(keepDaysOverride) || Number(this.getConfig().keepDays) || 30;
      if (!(keepDays > 0)) return;
      const idxFile = path.join(this.dir, "index.json");
      if (!fs.existsSync(idxFile)) return;
      let idx = JSON.parse(fs.readFileSync(idxFile, "utf8"));
      if (!Array.isArray(idx)) return;
      const deadline = Date.now() - keepDays * 86400000;
      const keep = [];
      let removed = 0;
      for (const e of idx) {
        if (!e || !e.startedAt || e.startedAt >= deadline) {
          keep.push(e);
          continue;
        }
        try {
          const f = path.join(this.dir, e.file || "");
          if (e.file && fs.existsSync(f)) fs.unlinkSync(f);
          removed++;
        } catch {
          keep.push(e); // 删不掉就留着（GitHub 上那种"文件被占用"别把索引也弄丢）
        }
      }
      if (removed) {
        const tmp = idxFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(keep, null, 2));
        fs.renameSync(tmp, idxFile);
        this.log(`已清理 ${removed} 份超过 ${keepDays} 天的旧纪要文件`);
      }
    } catch (err) {
      this.log(`清理旧纪要失败（不影响使用）：${err.message}`);
    }
  }

  // ---- 小工具 ---------------------------------------------------------------

  /** 日志统一出口（跟 emotion.js 一样写成方法，回调抛异常也不能影响主流程） */
  log(line) {
    try {
      this.onLog(String(line));
    } catch {}
  }

  /** 一次"没结论"：落一条 miss（方向 3：悬挂态必须留痕），并顺手清静音提醒计时 */
  _miss(kind, reason, ms) {
    try {
      EventLog.append(this.logFile, { t: "miss", ts: Date.now(), kind, label: "会议旁听", reason, ms: ms || 0 });
    } catch {}
    this.log(`miss[${kind}] ${reason}`);
  }

  /** 有新的语音进来 → 重置"静音提醒"计时（一直没人说话才会提醒） */
  _touch() {
    if (this._quietTimer) clearTimeout(this._quietTimer);
    const cur = this.session;
    if (!cur || cur.paused) return; // 暂停中不提醒
    this._quietTimer = setTimeout(() => {
      if (!this.session) return;
      this.onState({ active: true, quiet: true, quietMinutes: Math.round(QUIET_WARN_MS / 60000) });
      this.log(`已经 ${Math.round(QUIET_WARN_MS / 60000)} 分钟没听到人说话`);
    }, QUIET_WARN_MS);
  }

  _armTimers() {
    this._touch();
    this._beatAt = Date.now();
    // 看门狗：定期检查采集端还活着没（渲染层崩了/环回断了要能自动收尾）
    // 暂停期间照样看：心跳还在就说明渲染层只是"没在录"，真的崩了才会收尾
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    this._watchdogTimer = setInterval(() => this._checkWatchdog(), WATCHDOG_TICK_MS);
    this._armMaxTimer();
  }

  /** 忘了关的兜底：按**实际在听**的时长算，到点自动结束并出纪要（宁可少听，也别白烧一晚上 API） */
  _armMaxTimer() {
    if (this._maxTimer) clearTimeout(this._maxTimer);
    this._maxTimer = null;
    const s = this.session;
    if (!s) return;
    const left = MAX_SESSION_MS - (Date.now() - s.startedAt - (s.pausedMs || 0));
    if (left <= 0) {
      this.log("旁听已达最长时长，自动结束");
      this.stop("超过最长时长，自动结束").catch(() => {});
      return;
    }
    this._maxTimer = setTimeout(() => {
      if (!this.session) return;
      this.log("旁听超过 4 小时，自动结束");
      this.stop("超过最长时长，自动结束").catch(() => {});
    }, left);
  }

  _clearTimers() {
    if (this._quietTimer) clearTimeout(this._quietTimer);
    if (this._maxTimer) clearTimeout(this._maxTimer);
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    this._quietTimer = null;
    this._maxTimer = null;
    this._watchdogTimer = null;
  }

  /** 采集端心跳（渲染层每 60 秒发一次）：只更新"还活着"的时间 */
  beat() {
    if (this.session) this._beatAt = Date.now();
  }

  /**
   * 看门狗：渲染层崩了、环回断了、窗口被系统挂起……主进程这边不能一直挂着"记录中"
   * （主人会以为还在录）。超过 HEARTBEAT_TIMEOUT_MS 没有任何心跳/音频 → 自动收尾出纪要。
   */
  _checkWatchdog() {
    const s = this.session;
    if (!s) return;
    const idle = Date.now() - (this._beatAt || s.startedAt);
    if (idle < HEARTBEAT_TIMEOUT_MS) return;
    this.log(`采集端 ${Math.round(idle / 1000)} 秒没有动静，判定失联 → 自动收尾`);
    this.stop(`采集端失联（${Math.round(idle / 60000)} 分钟没有心跳）`).catch(() => {});
  }

  _pushState(extra) {
    const s = this.session;
    this.onState({
      active: !!s,
      paused: !!(s && s.paused),
      startedAt: s ? s.startedAt : 0,
      lines: s ? s.lines.length : 0,
      pending: this._queue.length,
      sources: s ? s.sources : null,
      ...(extra || {}),
    });
  }
}

module.exports = { MeetingRecorder, ASR_MODEL, stamp, SEGMENT_MINUTES };