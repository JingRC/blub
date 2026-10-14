// emotion.js — 主进程情绪监测模块（摄像头 → 视觉分析 → 变化检测 → 记录 → 推测 → 陪伴）
//
// 数据流：
//   渲染层(emotion.js) 每 20s 抓一帧摄像头画面（JPEG dataURL）
//     → IPC "pet:emotion-frame" → 本模块 analyzeFrame()
//     → 按间隔(默认60s)节流，调 GLM-4V 视觉模型输出 JSON 情绪样本
//     → 检测"显著情绪变化"（valence 突变 或 正负情绪跨越）
//     → 显著变化：落盘事件(data/emotion-events.json) + 异步让文本模型推测原因
//     → 通过回调把分析结果/事件/陪伴消息推回渲染层（鲸鱼反应 + 气泡）
//
// 屏幕内容：显著情绪变化要推测原因时，main.js 注入的 captureScreen 会抓一帧屏幕，
// 视觉模型出一句"此刻屏幕上在干什么"的摘要，喂给推测模型（原图不落盘、只留摘要）。
// 小动作识别（摸下巴/托腮/伸懒腰）：视觉 prompt 加字段 → _parseSample 提取 →
// _accept 里按天计数 → 报告里显示。**判定口径/字段名/中文名全在 signals.js 声明表里**，
// 加新动作只往那边的 SIGNALS 加一条，本文件不用改（已接线，见 signals.js 顶部说明）。
//
// 哈欠"过闸"：云端说"在打哈欠"不算数，还得本机 face.mesh 量到的外唇 MAR ≥ 阈值才认
// （张嘴≠哈欠：说话、手托下巴把嘴顶开都会被云端误判。过闸规则统一走 _gate()，
//  阈值与"为什么是 0.34"的依据在 signals.js 的 yawn 声明里）。
//
// 自进化（演示学习）：data/learned-actions.json 由标定/反馈工具写入，本模块只读并热加载——
//   1) 阈值覆盖：gate.yawn.marOutMin（主人演示一次真哈欠就自动定出来，见 _yawnMarMin）
//   2) 自定义动作：actions（如"喝水"）带演示参考图 + 描述 → 塞进视觉 prompt 当 few-shot 例子
//      （云端据此认识这个动作），本机照旧按天计数；若演示时也量到了几何区间，就再当一道本机闸门
//  文件不存在/读坏了就退回内置行为，功能不会因为学坏而崩。
//
// 所有回调都不抛异常——情绪功能永远不能弄崩桌宠。

const fs = require("fs");
const path = require("path");
// 感知信号声明表：动作的判定口径/字段名/中文名、情绪词表与 valence、突变判定参数、
// 哈欠闸门阈值、自定义动作的闸门放松系数——**唯一真源都在那边**，本文件只派生使用。
// 加一个新识别 → 只往 signals.js 的 SIGNALS 里加一条，这里不用改 if。
const Signals = require("./signals");
// 事件日志（方向 2）：所有"发生过什么"只追加，统计由它派生（见 eventlog.js）
const EventLog = require("./eventlog");

/** 内置信号（哈欠 + 三个小动作）：顺序 = prompt 字段顺序 = 报告顺序 */
const BUILTIN_SIGNALS = Signals.SIGNALS;

/** 情绪词表（与视觉模型 prompt 保持一致） */
const EMOTION_LABELS = Signals.EMOTION.labels;

/** 情绪 → valence 参考值（-1 消极 ~ +1 积极），检测突变用 */
const EMOTION_VALENCE = Signals.EMOTION.valence;

/**
 * 视觉 prompt 里的"动作字段"说明：由 signals.js 拼出来。
 * 每条声明的 prompt.ask 就是**最终文字（含结尾标点）**，所以拼出来的字符串与重构前逐字一致。
 * 要加新行为识别只改 signals.js，这里不用动。
 * 云端模型负责"看"，本机只做计数——打哈欠就是这么接进来的。
 * 注意免费小模型对细粒度动作判别力一般，别指望它每次都对。
 */
const ACTION_PROMPT =
  Signals.ACTION_PROMPT_HEADER + BUILTIN_SIGNALS.map((s) => s.prompt.ask).join("");

/** 判定"显著变化"的阈值（值在 signals.js 的 EMOTION.change / absence 里，这里只派生） */
const DELTA_THRESHOLD = Signals.EMOTION.change.deltaThreshold; // 情绪标签变了，且 valence 相对基线跳变 ≥ 此值才算"显著变化"
const MIN_CONFIDENCE = Signals.EMOTION.change.minConfidence;   // 低于此置信度的样本不参与突变判定
const MAX_HISTORY = Signals.EMOTION.change.history;            // 内存里保留的最近样本数
const MAX_EVENTS = 500;         // 落盘事件上限（超出裁最旧的）
const ABSENT_THRESHOLD = Signals.EMOTION.absence.strikes;      // 连续多少个样本未见主人 → 触发锁屏预警
const SIM_OWNER_MIN = 0.55;     // 刷脸解锁：模型自报相似度不到此值一律不认主人（免费模型嘴上乱点头）
// 发呆判定（用户盲猜的判据，实测挺准）：看得见主人 + 键鼠静下来 = 发呆。
// 纯本机信号（本地人脸结论 + 系统键鼠空闲秒数），不花 API。
const GAZE_IDLE_S = 60;         // 键鼠静多少秒起算"可能发呆"
const GAZE_MIN_MS = 2 * 60000;  // 连续发呆够久才记一笔（短停顿不算）
// 记账节流现在按"段"算，段长写在声明里（signals.js 的 count.endGapMs）：
//   瞬时动作 30 秒、持续性姿势 60 秒。姿势连续保持 = 同一段，只算一次；
//   离开超过段长才算这段结束。这样"扶着下巴想 5 分钟"是 1 次，不是每 30 秒记一次。
// 这个常量只剩"发呆"那条老路径在用（见 _recordAction）。
const ACTION_DEDUPE_MS = 30000;
// 声明里没写 count.endGapMs 时的兜底段长
const DEFAULT_SEGMENT_GAP_MS = 30000;
// 过闸阈值的**来源与优先级**统一在 _gateMin()：环境变量 > 标定覆盖 > 声明默认。
// 阈值本身、环境变量名、"为什么是 0.34"的实测依据都在 signals.js 的 yawn 声明里。
// 自定义动作的本机闸门放松系数：演示区间向外扩这么多，避免姿势一变就全部否掉（值在声明模板里）
const CUSTOM_GATE_SLACK = Signals.CUSTOM_SIGNAL_TEMPLATE.gate.slack;

/** 视觉模型失败后的冷却时长：免费池限流期间别每帧都去撞，直接走备胎 */
const VISION_COOLDOWN_MS = 5 * 60 * 1000;
// 看家期间"偶尔摸鱼"的发条区间：每 25~40 分钟随机一次（纯表演，见 _scheduleSlack）
const GUARD_SLACK_MIN_MS = 25 * 60000;
const GUARD_SLACK_MAX_MS = 40 * 60000;

// ---- 主人自己设的定时提醒（吃药…，设置在 reminders.js）----------------------
// 到点后多久之内还补提醒：应用刚启动、主人刚好走开一下，都不该把这条提醒吞掉
// （看家/人不在时也会等到回来那一刻补上，只要还在这个窗口里）。
const REMINDER_LATE_MIN = 60;
// 点"10 分钟后再提醒"往后推多久
const REMINDER_SNOOZE_MS = 10 * 60000;

// ---- 每次"判断"都要有个了结（开发记录 方向 3）-------------------------------
// 以前 _visionChat 的 fetch 没有超时：一个卡住的 socket 会让 this.busy 永远为 true，
// 整条情绪/行为/身份线就静默地死了（不报错、不记录、看着像"桌宠不理人了"）。
// 现在每条链都有自己的上限，超时带原因放弃、并往事件日志写一条 miss 记录——
// 悬挂态从"看不见"变成"查得到"。
const VISION_DEADLINE_MS = 20000;      // 视觉模型单次请求（含读 body）
const PROBE_DEADLINE_MS = 8000;        // 身份探测要快（锁屏判定等不起）
const SCREEN_HINT_DEADLINE_MS = 12000; // 屏幕内容摘要（只是推测用的旁证，慢就不要了）
const TEXT_DEADLINE_MS = 25000;        // 文字模型（推测原因；超时只放弃等待，结果丢弃）
const SPECULATE_MIN_DELTA = 0.1;       // 推测原因的小闸门：标签翻了但好感值几乎没动 = 检测噪声，不推测
const LANE_DEADLINE_MS = 30000;        // 整条分析线"一拍"的总上限（兜住上面所有调用）

class EmotionWatcher {
  /**
   * @param {object} opts
   * @param {(q: string) => Promise<string>} opts.askLLM  文本模型问答（推测原因用）
   * @param {(model: string, usage: object) => void} [opts.recordUsage]
   * @param {string} opts.dataDir   持久化目录（userData）
   * @param {string} [opts.visionModel]  视觉模型 id
   * @param {string[]} [opts.visionFallbacks] 视觉备用模型（主模型失败时按序兜底）
   * @param {string} [opts.textModel]    推测原因用的文本模型 id
   * @param {number} [opts.intervalMs]   分析最小间隔
   * @param {(sample: object) => void} [opts.onAnalysis]   每次成功分析
   * @param {(event: object) => void} [opts.onEvent]       显著变化事件
   * @param {(text: string, mood: string) => void} [opts.onCompanion] 陪伴消息
   * @param {() => string} [opts.getDshState]  当前 DSH agent 状态（推测上下文）
   * @param {() => Promise<string|null>} [opts.captureScreen] 抓一帧屏幕（JPEG dataURL），
   *        只在"显著情绪变化"要推测原因时调一次，用来看看主人此刻屏幕上在忙什么
   * @param {(line: string) => void} [opts.onLog]
   */
  constructor(opts = {}) {
    this.askLLM = opts.askLLM || (async () => "");
    this.recordUsage = opts.recordUsage || (() => {});
    this.dataDir = opts.dataDir;
    this.visionModel = opts.visionModel || "glm-4v-flash";
    this.visionFallbacks = Array.isArray(opts.visionFallbacks) ? opts.visionFallbacks.filter(Boolean) : [];
    this._modelCooldown = new Map(); // 视觉模型 -> 冷却到期时刻（被限流的模型先歇会儿）
    this.textModel = opts.textModel || "deepseek-flash";
    this.intervalMs = opts.intervalMs || 60000;
    this.onAnalysis = opts.onAnalysis || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.onCompanion = opts.onCompanion || (() => {});
    this.onOwnerChange = opts.onOwnerChange || (() => {});
    this.onPresence = opts.onPresence || (() => {}); // 每次身份结论（应用级锁屏判定用）
    // 报告内容变了（新事件 / 原因补上 / 兜底）→ 通知渲染层：面板若开着就地刷新，
    // 否则"鲸鱼还在琢磨原因"要等主人重开面板才会变
    this.onReportChanged = opts.onReportChanged || (() => {});
    this.getDshContext = opts.getDshContext || (() => null); // 电脑工作上下文（会话活动概况）
    this.captureScreen = opts.captureScreen || null; // 抓屏（突变时看一眼屏幕内容，推测原因用）
    // 系统键鼠空闲秒数（main 注入 powerMonitor）——发呆判定的依据之一
    this.getIdleSeconds = opts.getIdleSeconds || (() => 0);
    this.onLog = opts.onLog || (() => {});

    this.enabled = true;      // 总开关（摄像头识别）
    this.probe = false;       // 在场探测模式（便宜的身份识别，应用级锁屏用）
    this.probeIntervalMs = 0; // 探测节奏（由 guard 下发）
    this.current = null;      // 最近一次样本
    this.history = [];        // 最近样本
    this.events = [];         // 显著变化事件（持久化）
    this.busy = false;        // 一次只允许一个在途视觉请求
    this.lastProbeAt = 0;     // 上次"身份探测"的时间（锁屏下发节奏，本机识别可用时其实不走云端）
    this.lastEmotionAt = 0;   // 上次"情绪/行为分析"的时间（按自己的 intervalMs）
    // 行为专线节奏：只问"有没有摸下巴/托腮/伸懒腰/打哈欠"（不问情绪、不问身份）。
    // 情绪线是 1 分钟一帧，几秒的小动作基本抓不到；这条线默认 5 秒一帧专门抓动作
    // （哈欠只持续 4~6 秒，节奏太慢就有一半落在两帧之间）。
    // 设 0 可关掉（env DSH_PET_BEHAVIOR_INTERVAL 秒数可覆盖）。注意显式传 0 是"关掉"，不能再兜底成默认值
    this.behaviorIntervalMs = opts.behaviorIntervalMs === undefined
      ? 5000
      : Math.max(0, Number(opts.behaviorIntervalMs) || 0);
    this.lastBehaviorAt = 0;
    this._gazeSince = 0;      // 本次"发呆"的起点（键鼠静下来那一刻）
    this._gazeLastSeen = 0;   // 最近一次仍处于发呆的时刻（用来算时长，避免把"人走了"那段算进去）
    this._actionLastAt = {};  // 动作名 → 上次计数时间（只剩"发呆"这条老路径在用，见 _recordAction）
    this._segments = {};      // 信号 key → { lastHitAt, countedAt, startTs, hits }：按段计数 + 段长标定（见 _recordHit / _closeSegment）
    this._speakAt = {};       // 信号 key → 上次为它说话的 time（react.cooldownMs 用，见 _maybeSpeak）
    this._slackTimer = null;  // 看家期间"偶尔摸鱼"的发条（见 _scheduleSlack）
    this._frameGeo = null;    // 当前这一帧送进来时本机量到的嘴部几何量（过闸用，见 _gate）
    this.companionSeenAt = {}; // 情绪→上次陪伴消息时间（避免刷屏）

    // ---- 主动交互策略引擎的状态 ----
    this.lastInteractAt = 0;   // 上次主动交互时间（全局冷却用）
    this._interactTimes = [];  // 本小时主动交互时间戳（限频用）
    this._streak = { group: null, count: 0, since: 0 }; // 情绪组连续状态
    this._snooze = {};         // 规则→被用户"再一会儿"后的静默截止时间
    this._behavior = {
      yawnTotal: 0, yawnByDay: {},
      actionTotal: {}, actionByDay: {}, // 小动作（摸下巴/托腮/伸懒腰）按动作名统计
      sampleByDay: {}, emotionByDay: {},
      mealTotal: 0, mealByDay: {},      // 吃饭（主人主动记的，不是识别出来的）
      musicTotal: 0, musicByDay: {},    // 听歌（music.js 直接写日志，这里只是内存镜像，重启后由 derive 重算）
    }; // 行为/样本按天统计

    // ---- 吃饭打卡 / 提醒 ----
    this.reminders = { mealReminder: true, items: [] }; // 由 main.js 用 reminders.js 覆盖
    this._mealAskedDay = {};                 // { 午餐: "2026-09-20" } 当天问过就不再问
    // 自定义提醒（吃药…）"今天这个点说过没有"：提醒 id → { day, at, snoozeUntil }
    this._reminderFired = {};
    this._reminderTimer = setInterval(() => this._checkReminders(), 60000);

    // ---- 认主 / 看家模式 ----
    this.owner = null;          // { enrolledAt, refs: [dataURL...], descriptors: [特征...], guardEnabled }
    this.localIdentity = false; // 本地人脸识别是否接管身份判定（接管后云端模型只做情绪）
    this._lastLocalVerdict = null; // 最近一次本地身份结论（覆盖情绪样本里的身份字段）
    this.guardActive = false;   // 看家模式进行中（主人不在）
    this.guardWarnMs = opts.guardWarnMs || 10000; // 锁屏前预警时长（留出取消机会）
    this._absentRun = 0;        // 连续"未见主人"的样本数
    this._warnTimer = null;     // 锁屏预警倒计时
    this._guardSnoozeUntil = 0; // 用户点"我在"后的免打扰截止时间
    this._loadOwner();

    this._loadLog();

    // ---- 自进化：演示学习出来的配置（标定/反馈工具写文件，这里只读 + 热加载）----
    this.learned = { version: 1, gate: {}, actions: {}, feedback: [] };
    this._learnedMtime = 0;
    this._loadLearned();
    this._watchLearned();
  }

  log(line) { this.onLog(`[emotion] ${line}`); }

  // ---- 事件日志（唯一真源）--------------------------------------------------
  // 方向 2：所有"发生过什么"只往 events.jsonl 追加，统计由它派生（见 eventlog.js）。
  // 旧的两个 JSON（emotion-events / emotion-behavior）与旧的段日志**保留不动**，
  // 只在第一次启动新格式时整段导入一次——这是"历史数值一个都不改"的保险。

  get eventsFile() { return path.join(this.dataDir, "emotion-events.json"); }
  get behaviorFile() { return path.join(this.dataDir, "emotion-behavior.json"); }
  get segmentsFile() { return path.join(this.dataDir, "signal-segments.jsonl"); }
  get logFile() { return EventLog.logFileIn(this.dataDir); }

  _loadLog() {
    try {
      if (!fs.existsSync(this.logFile)) {
        const recs = EventLog.importLegacy(
          { eventsFile: this.eventsFile, behaviorFile: this.behaviorFile, segmentsFile: this.segmentsFile },
          dayKey,
        );
        for (const r of recs) EventLog.append(this.logFile, r);
        const imp = recs.find((r) => r.t === "import") || {};
        this.log(
          `events.jsonl 首次建立：导入 ${Object.keys(imp.days || {}).length} 天统计、` +
            `${(imp.events || []).length} 条事件、${(imp.segments || []).length} 条段记录（旧文件保留未动）`,
        );
      } else if (EventLog.compactIfNeeded(this.logFile, dayKey)) {
        this.log("events.jsonl 已压缩：旧记录折叠成按天汇总，累计数字不变");
      }
      const { behavior, events } = EventLog.derive(EventLog.read(this.logFile).records, dayKey);
      this._behavior = behavior;
      this._trimByDay(); // 内存里仍按"只保留最近 30 天"的老规矩（日志里其实全都在，随时能重算）
      this.events = events.slice(-MAX_EVENTS);

      // 上次没等到推测结果就退出（或那次推测最终失败）的事件：永远等不到原因了。补一句兜底
      // 并**追加**一条 reason 记录——不去改写历史行，这就是"日志即真源"的做法。
      let missed = 0;
      for (const e of events) {
        if (e && e.kind !== "gaze" && !e.reason) {
          e.reason = "这次没推测出原因（当时没等到模型回应）";
          EventLog.append(this.logFile, { t: "reason", ts: Date.now(), targetTs: e.ts, reason: e.reason });
          missed++;
        }
      }
      if (missed) this.log(`events: ${missed} 条历史事件补了兜底原因（追加进日志）`);
    } catch (err) {
      this.log(`event log load failed: ${err.message}`);
    }
  }

  /** 往日志追加一条记录：全模块唯一的落盘出口 */
  _append(rec) {
    try {
      EventLog.append(this.logFile, rec);
    } catch (err) {
      this.log(`event log append failed: ${err.message}`);
    }
  }

  // ---- 自进化：演示学习配置（只读 + 热加载）----------------------------------

  get learnedFile() { return path.join(this.dataDir, "learned-actions.json"); }

  _loadLearned() {
    try {
      if (!fs.existsSync(this.learnedFile)) return;
      const saved = JSON.parse(fs.readFileSync(this.learnedFile, "utf8"));
      if (!saved || typeof saved !== "object") return;
      this.learned = {
        version: Number(saved.version) || 1,
        gate: saved.gate && typeof saved.gate === "object" ? saved.gate : {},
        actions: saved.actions && typeof saved.actions === "object" ? saved.actions : {},
        feedback: Array.isArray(saved.feedback) ? saved.feedback : [],
      };
      const custom = Object.keys(this.learned.actions);
      const gates = Object.keys(this.learned.gate);
      this.log(`learned: 自定义动作 ${custom.length ? custom.join("/") : "无"}｜阈值覆盖 ${gates.length ? gates.join("/") : "无"}`);
    } catch (err) {
      this.log(`learned load failed（退回内置行为）：${err.message}`);
    }
  }

  /**
   * 盯着配置文件（反馈工具保存后本进程要立刻生效，不用重启桌宠）。
   * 5 秒轮询一次 mtime 足够——演示学习是低频操作。
   */
  _watchLearned() {
    try {
      fs.watchFile(this.learnedFile, { interval: 5000 }, (cur) => {
        if (!cur || !cur.mtimeMs || cur.mtimeMs === this._learnedMtime) return;
        this._learnedMtime = cur.mtimeMs;
        this._loadLearned();
      });
    } catch (err) {
      this.log(`learned watch failed: ${err.message}`);
    }
  }

  /**
   * 当前生效的动作表：内置 4 个 + 演示学来的自定义动作。
   * 自定义动作由云端视觉模型"看"（带主人的演示参考图），本机负责计数（可选几何闸门）。
   */
  actionDefs() {
    // 内置信号直接从声明表来（顺序 = prompt 字段顺序 = 报告顺序）。
    // ownChannel 标记"独立通道"：哈欠自带 sample.yawn 字段、自己的计数器、自己的气泡，
    // 不算进"小动作"统一下（原来这是散在 _readActions/_noActions/_noFaceJson 里的 key !== "yawn"）。
    const defs = BUILTIN_SIGNALS.map((s) => ({
      key: s.key,
      label: s.label,
      builtin: true,
      ownChannel: !!s.ownChannel,
    }));
    for (const [key, a] of Object.entries(this.learned.actions || {})) {
      if (!a || typeof a !== "object") continue;
      const labelName = String(a.label || "").trim();
      if (!labelName) continue;
      defs.push({
        key,
        label: labelName,
        builtin: false,
        custom: true,
        desc: String(a.desc || "").trim(),
        refs: Array.isArray(a.refs) ? a.refs.filter((r) => typeof r === "string").slice(0, 2) : [],
        // 声明模板把"演示量到的几何区间"包成统一的 range 闸门（含放松系数、段长、缺项态度），
        // 这样 _gate()/_recordHit() 只有一套写法，不必在这里判断形状
        gate:
          a.gate && typeof a.gate === "object" && Object.keys(a.gate).length
            ? {
                strategy: "range",
                ranges: a.gate,
                fields: Signals.CUSTOM_SIGNAL_TEMPLATE.gate.fields,
                slack: CUSTOM_GATE_SLACK,
                onMissingField: Signals.CUSTOM_SIGNAL_TEMPLATE.gate.onMissingField,
              }
            : null,
        count: { mode: "segment", endGapMs: Signals.CUSTOM_SIGNAL_TEMPLATE.count.endGapMs },
        react: null, // 只统计、不搭话（跟内置小动作一致）
      });
    }
    return defs;
  }

  /** 视觉 prompt 里的动作字段说明（内置 + 自定义动作各一行） */
  _actionPrompt() {
    const customs = this.actionDefs().filter((d) => d.custom);
    if (!customs.length) return ACTION_PROMPT;
    return ACTION_PROMPT + customs
      .map((d) => `${d.key}=画面里的人正在做「${d.label}」${d.desc ? `（${d.desc}）` : ""}，看不清或不确定就 false；`)
      .join("");
  }

  /** 输出 JSON 里的动作字段清单（含演示学来的自定义动作，字段名要跟 _actionPrompt 对齐） */
  _actionSchema() {
    const keys = this.actionDefs().map((d) => d.key);
    return keys.map((k) => `"${k}": bool`).join(", ");
  }

  /** "画面里没人"时要模型回的那串 JSON（字段跟当前动作表一致） */
  _noFaceJson(owner) {
    const fields = this.actionDefs().filter((d) => !d.ownChannel).map((d) => `"${d.key}": false`);
    return `{"noFace": true${owner ? ', "ownerPresent": false' : ""}, "emotion": "none", "confidence": 0, "yawn": false${
      fields.length ? ", " + fields.join(", ") : ""
    }}`;
  }

  /** 自定义动作的演示参考图（few-shot）：连字段名一起塞进视觉 prompt */
  _learnedRefs() {
    const content = [];
    for (const d of this.actionDefs()) {
      if (!d.custom || !d.refs.length) continue;
      content.push({ type: "text", text: `参考图（主人自己演示的「${d.label}」，对应字段 ${d.key}）：` });
      for (const url of d.refs) content.push({ type: "image_url", image_url: { url } });
    }
    return content;
  }

  /** 含自定义动作的全 false 集合（画面里没人时用） */
  _noActions() {
    const o = {};
    for (const d of this.actionDefs()) if (!d.ownChannel) o[d.key] = false;
    return o;
  }

  /** 按 key 找当前生效的信号声明（内置优先，自定义动作兜底） */
  _signalDef(key) {
    return (
      BUILTIN_SIGNALS.find((s) => s.key === key) ||
      this.actionDefs().find((d) => d.key === key) ||
      null
    );
  }

  /** 信号在报告里的图标（来自声明 report.emoji；自定义动作没有专属表情就返回空串） */
  _signalEmoji(key) {
    const s = this._signalDef(key);
    return (s && s.report && s.report.emoji) || "";
  }

  /**
   * 某个信号的过闸阈值：优先级 = 环境变量 > 标定覆盖（演示教学写的）> 声明默认。
   * 环境变量名与默认值都来自声明（gate.env / gate.min），所以同一个信号只有一个出处在管它。
   */
  _gateMin(sig) {
    const g = (sig && sig.gate) || {};
    if (g.env && process.env[g.env] !== undefined) {
      return Math.max(0, Number(process.env[g.env]) || 0); // 设 0 = 关掉这道闸
    }
    if (g.learnt) {
      const learnt = (this.learned.gate || {})[sig.key];
      const v = learnt ? Number(learnt.marOutMin) : NaN;
      if (Number.isFinite(v) && v > 0) return v;
    }
    return typeof g.min === "number" ? g.min : 0;
  }

  /** 哈欠阈值当前生效值（报告与标定工具要看）：等价于 _gateMin(yawn 声明) */
  _yawnMarMin() {
    return this._gateMin(this._signalDef("yawn"));
  }

  /** 三张按天的表都只保留最近 30 天 */
  _trimByDay() {
    const b = this._behavior;
    for (const key of ["yawnByDay", "sampleByDay", "emotionByDay", "mealByDay", "meetingByDay", "musicByDay"]) {
      const table = b[key];
      if (!table) continue;
      const days = Object.keys(table).sort();
      while (days.length > 30) delete table[days.shift()];
    }
    // 小动作表是"动作名 → {日期: 次数}"，逐层裁
    for (const table of Object.values(b.actionByDay || {})) {
      const days = Object.keys(table).sort();
      while (days.length > 30) delete table[days.shift()];
    }
  }

  /** 记一次打哈欠；返回 {today, total} */
  _recordYawn() {
    const day = dayKey();
    const b = this._behavior;
    b.yawnTotal += 1;
    b.yawnByDay[day] = (b.yawnByDay[day] || 0) + 1;
    this._trimByDay();
    this._append({ t: "hit", ts: Date.now(), key: "yawn", label: "哈欠", own: true });
    return { today: b.yawnByDay[day], total: b.yawnTotal };
  }

  /** 记一个情绪样本（按天累计，供"今日情感分布/样本数"用） */
  _recordSample(emotion) {
    const day = dayKey();
    const b = this._behavior;
    b.sampleByDay[day] = (b.sampleByDay[day] || 0) + 1;
    const m = b.emotionByDay[day] || (b.emotionByDay[day] = {});
    m[emotion] = (m[emotion] || 0) + 1;
    this._trimByDay();
    this._append({ t: "sample", ts: Date.now(), emotion });
  }

  yawnToday() {
    return this._behavior.yawnByDay[dayKey()] || 0;
  }

  /**
   * 听歌点评落了一笔（music.js 自己往事件日志追加，这里只把内存镜像跟上——
   * 跟 addMeal 同一个套路；重启后由 derive 重算，数字一致）。
   */
  noteMusic() {
    const day = dayKey();
    const b = this._behavior;
    b.musicTotal = (b.musicTotal || 0) + 1;
    b.musicByDay[day] = (b.musicByDay[day] || 0) + 1;
  }

  /**
   * 往按天的表里 +1（纯写入：不含任何"同一段"判断——段逻辑只在 _recordHit 一处）。
   * 同时也往事件日志追加一条 hit（这样"统计 = 日志的派生视图"才成立）。
   */
  _bumpActionDay(name, key) {
    const day = dayKey();
    const b = this._behavior;
    b.actionTotal[name] = (b.actionTotal[name] || 0) + 1;
    const table = b.actionByDay[name] || (b.actionByDay[name] = {});
    table[day] = (table[day] || 0) + 1;
    this._trimByDay();
    this._append({ t: "hit", ts: Date.now(), key: key || name, label: name, own: false });
    return { today: table[day], total: b.actionTotal[name] };
  }

  /**
   * 老路径（发呆记账）用：带 30 秒去重，保留历史行为不动。
   * 信号类命中不走这里——它们按声明里的段长判段（见 _recordHit）。
   */
  _recordAction(name) {
    const now = Date.now();
    if (now - (this._actionLastAt[name] || 0) < ACTION_DEDUPE_MS) return null;
    this._actionLastAt[name] = now;
    return this._bumpActionDay(name);
  }

  /** 某个小动作今天的次数 */
  actionToday(name) {
    const table = this._behavior.actionByDay[name];
    return (table && table[dayKey()]) || 0;
  }

  // ---- 吃饭打卡 --------------------------------------------------------------
  //
  // 定位：这是**主人主动提交的生活记录**，不是识别出来的动作，所以：
  //   · 不进 signals.js（那份声明管"看得懂什么"，吃饭不需要看懂）
  //   · 进事件日志（管"发生过什么"）→ 时间线/统计/折叠/恢复全都白拿，
  //     而且能和情绪变化排在同一条时间线上（"饿的时候是不是更容易烦"这类问题才有得看）

  /** 今天记了几顿 */
  mealsToday() {
    return this._behavior.mealByDay[dayKey()] || 0;
  }

  /** 最近记过的菜名（去重、最新在前）——打卡时当快捷按钮，省得每次打字 */
  recentMeals(n) {
    const out = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < (n || 5); i--) {
      const e = this.events[i];
      if (!e || e.kind !== "meal" || !e.what) continue;
      if (!out.includes(e.what)) out.push(e.what);
    }
    return out;
  }

  /**
   * 记一顿饭。
   * @param {string} what 吃了啥（必填）
   * @returns {{ok:boolean, error?:string, slot?:string, todayCount?:number}}
   */
  addMeal(what) {
    const text = String(what || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!text) return { ok: false, error: "还没写吃了啥" };
    const ts = Date.now();
    const slot = mealSlotOf(ts);
    this._append({ t: "meal", ts, slot, what: text });
    // 内存里的统计立刻跟上（重启后由 derive 重算，数字一致）
    this._behavior.mealTotal += 1;
    this._behavior.mealByDay[dayKey(ts)] = (this._behavior.mealByDay[dayKey(ts)] || 0) + 1;
    this.events.push({ kind: "meal", ts, slot, what: text });
    this.log(`meal -> ${slot}：${text}（今日第 ${this.mealsToday()} 顿）`);

    // 陪伴话术：只记录 + 陪伴 + 偶尔好奇。**永不评判健康/热量/身材**——
    // 一旦说教，主人就不会再点这个按钮，功能就死了（这条是设计红线）。
    this.onCompanion(mealQuip(text, slot, this.mealsToday(), this.recentMeals(2)[1]), "happy", { effect: "wiggle" });
    this.onReportChanged();
    return { ok: true, slot, todayCount: this.mealsToday() };
  }

  /**
   * 会中旁注：t0~t1 这段时间里**本机看到的**东西（情绪突变 / 长时间发呆）。
   * 为什么放在这条线里：会议纪要想写"说到预算那会儿你情绪明显变了""有一段你不在座位上"，
   * 这些摄像头/键鼠侧的事实别的会议助手拿不到；而它们本来就已经在情绪事件表里了，顺手取即可。
   * @returns {Array<{ts:number,text:string}>}
   */
  ambientBetween(t0, t1) {
    const out = [];
    for (const e of this.events || []) {
      if (!e || !e.ts || e.ts < t0 || e.ts > t1) continue;
      if (e.kind === "gaze") {
        out.push({ ts: e.ts, text: `你在屏幕前停了约 ${Math.max(1, Math.round(e.minutes || 0))} 分钟（键鼠一直没动）` });
      } else if (e.to) {
        const from = EMOTION_LABELS[e.from] || e.from;
        const to = EMOTION_LABELS[e.to] || e.to;
        out.push({ ts: e.ts, text: `情绪从「${from}」变成「${to}」${e.reason ? `，可能是：${e.reason}` : ""}` });
      }
    }
    return out.slice(-40);
  }

  /** main.js 用 reminders.js 的设置覆盖（饭点开关 + 主人自己设的定时提醒） */
  setReminders(cfg) {
    this.reminders = {
      mealReminder: !(cfg && cfg.mealReminder === false),
      items: Array.isArray(cfg && cfg.items) ? cfg.items : [],
    };
  }

  /** 每分钟一拍：先看饭点，再看主人自己设的定时提醒 */
  _checkReminders() {
    this._checkMealReminder();
    this._checkCustomReminders();
  }

  /**
   * 主人自己设的定时提醒（吃药…）。规则：
   *   · 到点（含之后 REMINDER_LATE_MIN 分钟内）说一次；点过"知道了"或当天该点已说过 → 不再说
   *   · 点"10 分钟后再提醒" → 推迟到那时再说一次（这一条只推迟这一次，不改设置）
   *   · 看家中、人明显不在（键鼠闲 10 分钟以上）不打扰——等回来了还在窗口里就补上，
   *     所以"到点正好去倒水"不会把吃药提醒弄丢
   *   · 只说提醒内容本身，不评判、不追问（跟吃饭打卡同一条红线）
   */
  _checkCustomReminders() {
    try {
      const items = (this.reminders && this.reminders.items) || [];
      if (!items.length) return;
      const now = new Date();
      const stamp = now.getTime();
      const day = dayKey(stamp);
      const mins = now.getHours() * 60 + now.getMinutes();
      const dow = now.getDay();
      for (const it of items) {
        if (!it || it.enabled === false || !it.id) continue;
        if (Array.isArray(it.days) && it.days.length && !it.days.includes(dow)) continue;
        const parts = String(it.at || "").split(":");
        const atMins = Number(parts[0]) * 60 + Number(parts[1]);
        if (!Number.isFinite(atMins)) continue;
        const st = this._reminderFired[it.id] || null;
        const snoozeDue = !!(st && st.snoozeUntil && stamp >= st.snoozeUntil);
        // 今天这个点已经说过了（除非是"推迟后再说到点"）→ 不重复
        if (st && st.day === day && st.at === it.at && !snoozeDue) continue;
        // 还没到点、或已经过了补提醒窗口 → 这次不看（推迟到点的例外）
        if (!snoozeDue && (mins < atMins || mins > atMins + REMINDER_LATE_MIN)) continue;
        if (this.guardActive) continue;
        if ((Number(this.getIdleSeconds()) || 0) > 600) continue;
        this._reminderFired[it.id] = { day, at: it.at, snoozeUntil: 0 };
        this.log(`reminder -> ${it.at} ${it.text}`);
        this.onCompanion(`🔔 ${it.text}`, "calm", {
          // 桌宠可能正藏在托盘里：定时提醒得自己冒出来，不然等于没说
          showPet: true,
          actions: [
            { id: `remind-ok:${it.id}`, label: "知道了" },
            { id: `remind-snooze:${it.id}`, label: "10 分钟后再提醒" },
          ],
        });
      }
    } catch (err) {
      this.log(`custom reminder failed: ${err.message}`);
    }
  }

  /**
   * 饭点提醒（每分钟看一次）：午饭 11:30~13:00、晚饭 17:30~19:30 各最多问一次。
   * 打扰的边界（都很保守，宁可少问）：看家时不问、人明显不在（键鼠闲 10 分钟以上）不问、
   * 当天已经问过（不管有没有记）就不问、开关关了不问。
   */
  _checkMealReminder() {
    try {
      if (!this.reminders || !this.reminders.mealReminder) return;
      if (this.guardActive) return;
      const now = new Date();
      const slot = mealSlotOf(now.getTime());
      const mins = now.getHours() * 60 + now.getMinutes();
      const inWindow = (slot === "午餐" && mins >= 11 * 60 + 30 && mins <= 13 * 60) ||
                       (slot === "晚餐" && mins >= 17 * 60 + 30 && mins <= 19 * 60);
      if (!inWindow) return;
      if (this._mealAskedDay[slot] === dayKey(now.getTime())) return;
      // 人明显不在就别问：系统键鼠闲着超过 10 分钟 ≈ 走开了
      if ((Number(this.getIdleSeconds()) || 0) > 600) return;
      this._mealAskedDay[slot] = dayKey(now.getTime());
      this.log(`meal reminder -> ${slot}`);
      this.onCompanion(`🍚 到${slot}时间了～在吃吗？吃了啥，记一笔？`, "calm", {
        actions: [
          { id: "meal", label: "🍚 记一笔" },
          { id: "meal-later", label: "稍后" },
        ],
      });
    } catch (err) {
      this.log(`meal reminder failed: ${err.message}`);
    }
  }

  /**
   * 通用"过闸"：云端说命中了，还要本机这一刻的证据支持才采信。
   * 规则全部来自声明（signals.js 的 gate 段 / 自定义动作模板），本文件不再为某个信号写专门分支：
   *   strategy: "threshold" → 本机某项几何量要 ≥ 阈值（哈欠：外唇 MAR）
   *   strategy: "range"     → 本机几何量要落在演示区间的 [下限-留白, 上限+留白] 内
   *   gate: null            → 没有本机复核手段（没开手部检测），直接采信云端
   * 缺数据时的态度也由声明决定（onMissingGeo / onNoMouth）——
   * 原则：宁可留一句日志，也不要静悄悄地把整条识别饿死。
   */
  _gate(sig, hit, where) {
    if (!hit) return false;
    const g = sig && sig.gate;
    if (!g) return true;
    if (g.strategy === "threshold") return this._gateThreshold(sig, g, where);
    if (g.strategy === "range") return this._gateRange(sig, g, where);
    return true;
  }

  /**
   * 阈值型过闸（哈欠：外唇 MAR 够不够大）。
   * 为什么要这道闸：单帧"嘴张开"既可能是说话，也可能是手托下巴把嘴顶开，云端小模型分不出来。
   * 几何量由渲染层在抓帧那一刻就近取好随帧送来（renderer/emotion.js 的 nearestGeo）。
   */
  _gateThreshold(sig, g, where) {
    const geo = this._frameGeo;
    if (!geo) {
      // 渲染层没送几何量（旧版渲染层/管线出问题）：按声明决定放行还是否掉，
      // 但无论哪种都要在日志里看得见——否则整条识别会静悄悄地死掉。
      const pass = g.onMissingGeo !== "reject";
      this.log(`${where}: 云端说在${sig.label}，但没收到本机嘴部几何量 -> ${pass ? "闸门失效，仍计数" : "不计数"}`);
      return pass;
    }
    const v = geo[g.field];
    const min = this._gateMin(sig);
    if (typeof v !== "number") {
      const pass = g.onNoMouth === "count";
      this.log(`${where}: 云端说在${sig.label}，但本机这一刻没量到 ${g.field}（没脸/关键点缺失）-> ${pass ? "仍计数" : "不计数"}`);
      return pass;
    }
    if (v < min) {
      this.log(`${where}: 云端说在${sig.label}，本机 ${g.field}=${v.toFixed(3)} < ${min} -> 按说话/托下巴处理，不计数`);
      return false;
    }
    this.log(`${where}: ${sig.label}过闸（本机 ${g.field}=${v.toFixed(3)} ≥ ${min}）`);
    return true;
  }

  /** 区间型过闸（自定义动作：演示时量到的几何区间，向外留一点余量） */
  _gateRange(sig, g, where) {
    const geo = this._frameGeo;
    if (!geo) return true; // 没收到本机几何量：闸门失效，仍采信云端
    const slack = typeof g.slack === "number" ? g.slack : 0;
    const ranges = g.ranges || {};
    for (const key of g.fields || []) {
      const range = ranges[key];
      if (!Array.isArray(range) || range.length !== 2) continue;
      const v = geo[key];
      if (typeof v !== "number") continue; // 本机这一项没量到 → 跳过，别拿缺失当否证
      const lo = range[0] - slack;
      const hi = range[1] + slack;
      if (v < lo || v > hi) {
        this.log(
          `${where}: 云端说在做「${sig.label}」，但本机 ${key}=${v} 不在演示区间 [${range[0]}, ${range[1]}]（放宽后 [${lo.toFixed(2)}, ${hi.toFixed(2)}]）-> 不计数`,
        );
        return false;
      }
    }
    return true;
  }

  /** 从云端返回的 JSON 里取"这一类动作"的布尔值并逐个过闸（哈欠走独立通道，在 _parseSample 里单独过闸） */
  _readActions(obj, where) {
    const out = {};
    for (const d of this.actionDefs()) {
      if (d.ownChannel) continue; // 哈欠走独立通道（样本里是单独的 yawn 字段）
      out[d.key] = this._gate(d, obj[d.key] === true, where);
    }
    return out;
  }

  /**
   * 记一次信号命中：按"段"计数 + 按声明决定要不要搭话。
   * 按段：同一段里连续命中只算一次；离开超过 count.endGapMs（瞬时动作 30s / 持续性姿势 60s）
   * 才算这段结束，下一次命中是新的一段。这样"扶着下巴想 5 分钟"是 1 次，而不是每 30 秒记一次
   * （依据见 signals.js 里 count 段的注释：人平均每 2~4 分钟摸一次脸）。
   * @returns {boolean} 是否说了话（说了就不再叠加随机搭话，免得气泡互相顶掉）
   */
  _recordHit(sig, where) {
    // "看家模式不记账"是全局前置条件，写在声明里（PRECONDITIONS.skipWhenGuardActive）
    if (Signals.PRECONDITIONS.skipWhenGuardActive && this.guardActive) return false;
    const now = Date.now();
    const endGapMs = (sig.count && sig.count.endGapMs) || DEFAULT_SEGMENT_GAP_MS;
    const seg = this._segments[sig.key] || (this._segments[sig.key] = { lastHitAt: 0, countedAt: 0, startTs: 0, hits: 0 });
    const gap = now - seg.lastHitAt;
    seg.lastHitAt = now;
    seg.hits = (seg.hits || 0) + 1;
    if (seg.countedAt && gap < endGapMs) return false; // 还在同一段里 → 不重复计数
    // 走到这里说明"上一段结束了"（离开超过段长）：把它写进标定日志，再开新的一段。
    // 记的是上一段真正的最后一次命中时刻（不是这次），否则会把停顿也算进段长。
    if (seg.countedAt) this._closeSegment(sig.key);
    seg.countedAt = now;
    seg.startTs = now;
    seg.hits = 1;
    seg.endGapMs = endGapMs;
    // 哈欠有自己的计数器（yawnTotal/yawnByDay），小动作按中文名进 actionTotal/actionByDay。
    // 两套存储早晚要合并成"事件日志的派生视图"（开发记录 方向 2），这一步只把段逻辑统一掉。
    const r = sig.ownChannel ? this._recordYawn() : this._bumpActionDay(sig.label, sig.key);
    this.log(`${sig.label}：今日 ${r.today} 次 / 累计 ${r.total} 次（${where}）`);
    return this._maybeSpeak(sig, r);
  }

  /**
   * 关掉一段：把这一段的起止与命中次数追加进事件日志（t:"segment"）。
   * 用途是**段长标定**——声明里的 30 秒 / 60 秒是照公开研究（人平均每 2~4 分钟摸一次脸）
   * 定的，攒一天真实分布后就能回填成实测值。
   */
  _closeSegment(key) {
    const seg = this._segments[key];
    if (!seg || !seg.countedAt || !seg.startTs) return;
    const rec = {
      key,
      from: seg.startTs,
      to: seg.lastHitAt,
      sec: Math.round((seg.lastHitAt - seg.startTs) / 100) / 10, // 段长（秒，一位小数）
      hits: seg.hits,
      endGapMs: seg.endGapMs, // 当时生效的段长判定，便于对比不同配置
    };
    seg.countedAt = 0;
    seg.startTs = 0;
    seg.hits = 0;
    this._append({ t: "segment", ts: Date.now(), ...rec });
  }

  /** 退出前把还"开着"的段落盘（不然最后一段会丢在内存里） */
  flushSegments() {
    for (const key of Object.keys(this._segments)) this._closeSegment(key);
  }

  /** 按声明的 react 段决定要不要说这句话（没有 react 段 = 只统计、不搭话） */
  _maybeSpeak(sig, r) {
    const react = sig.react;
    if (!react) return false;
    const now = Date.now();
    if (this._warnTimer && react.suppressWhenWarn) return false; // 锁屏预警气泡挂着：不抢话
    const cooldown = react.cooldownMs || 0;
    if (now - (this._speakAt[sig.key] || 0) <= cooldown) return false;
    this._speakAt[sig.key] = now;
    const fill = (tpl) =>
      String(tpl || "")
        .replace(/\{n\}/g, r.today)
        .replace(/\{total\}/g, r.total);
    const line = (react.lines || []).find((l) => r.today <= l.maxToday);
    const quip = line ? fill(line.text) : "";
    this.onCompanion(`${fill(react.bubble)}${quip ? "\n" + quip : ""}`, react.mood || null);
    return true;
  }

  /** 记一次打哈欠（保留这个名字给两条线的调用点；内部走通用的"记一次命中"） */
  _noteYawn(hit) {
    if (!hit) return false;
    const sig = this._signalDef("yawn");
    return sig ? this._recordHit(sig, "yawn") : false;
  }

  /**
   * 记小动作们（摸下巴 / 托腮 / 伸懒腰…）：每个命中各走一次通用记账
   * （按段计数 + 按声明决定搭不搭话）。内置这几个都没有 react 段 = 只统计不搭话：
   * 它们不算"需要被关心"的信号，说了只会变碎碎念，攒在报告里让主人自己看。
   * 情绪线与行为专线共用（所以放在这里而不是内联在某一条线里）。
   */
  _noteActions(actions) {
    for (const [field, hit] of Object.entries(actions || {})) {
      if (!hit) continue;
      const sig = this._signalDef(field);
      if (sig) this._recordHit(sig, "action");
    }
  }

  // ---- 发呆（看得见主人 + 键鼠静下来）----------------------------------------

  /**
   * 每一帧都调一次（纯本机信号，不花 API）：
   *   看得见主人（本地人脸结论）+ 键鼠空闲 ≥ GAZE_IDLE_S → 进入"发呆"；
   *   键鼠动了，或人不在画面里 → 本次发呆结束，够久（≥ GAZE_MIN_MS）就记一笔。
   * 记录写进 events（kind: "gaze"，带起止与时长），报告里跟情绪变化一起按时间排。
   * 局限：看视频/看书也是"人在+不动键鼠"，会被算成发呆——没有眼动/屏幕内容信号可分。
   */
  _trackGaze() {
    if (!this.enabled) return;
    const now = Date.now();
    const idleS = Number(this.getIdleSeconds()) || 0;
    const present = !!(this._lastLocalVerdict && this._lastLocalVerdict.ownerPresent);
    if (present && idleS >= GAZE_IDLE_S) {
      if (!this._gazeSince) {
        // 键鼠静下来的那一刻就是起点（现在往回推 idleS 秒），不用等这一帧才发现
        this._gazeSince = now - idleS * 1000;
        this.log(`gaze -> start ${fmtTime(this._gazeSince)}`);
      }
      this._gazeLastSeen = now;
      return;
    }
    if (!this._gazeSince) return;
    const startTs = this._gazeSince;
    const endTs = this._gazeLastSeen || now;
    this._gazeSince = 0;
    this._gazeLastSeen = 0;
    if (endTs - startTs < GAZE_MIN_MS) return; // 短停顿不算
    this._recordGaze(startTs, endTs);
  }

  /** 记一次发呆（进心情记录 + 行为统计计数） */
  _recordGaze(startTs, endTs) {
    const minutes = Math.max(1, Math.round((endTs - startTs) / 60000));
    const event = { kind: "gaze", ts: endTs, startTs, minutes };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    this._append({ t: "gaze", ts: endTs, startTs, minutes });
    this.onEvent(event);
    this._recordAction("发呆"); // 只借它的"按天计数"（返回值这里用不上）
    this.log(
      `gaze -> ${minutes} 分钟（${fmtTime(startTs)}~${fmtTime(endTs)}）今日 ${this.actionToday("发呆")} 次`,
    );
  }

  // ---- 认主 / 看家模式 --------------------------------------------------------

  get ownerFile() { return path.join(this.dataDir, "owner.json"); }

  _loadOwner() {
    try {
      if (fs.existsSync(this.ownerFile)) {
        const saved = JSON.parse(fs.readFileSync(this.ownerFile, "utf8"));
        if (saved && Array.isArray(saved.refs) && saved.refs.length) {
          this.owner = {
            enrolledAt: Number(saved.enrolledAt) || Date.now(),
            refs: saved.refs.slice(0, 3),
            guardEnabled: saved.guardEnabled !== false,
            // 本地人脸识别用的 1024 维特征（渲染层算好存这儿，与参考照一一对应）
            descriptors: Array.isArray(saved.descriptors) ? saved.descriptors.slice(0, 3) : [],
          };
        }
      }
    } catch (err) {
      this.log(`owner load failed: ${err.message}`);
    }
  }

  _saveOwner() {
    try {
      fs.writeFileSync(this.ownerFile, JSON.stringify(this.owner, null, 2));
    } catch (err) {
      this.log(`owner save failed: ${err.message}`);
    }
  }

  isEnrolled() { return !!(this.owner && this.owner.refs.length >= 3); }

  /**
   * 认主登记：存一张参考照（渲染层连拍 3 张，每张调一次）；满 3 张即完成。
   * @returns {{count: number, done: boolean}}
   */
  enrollOwner(dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") return { count: 0, done: false };
    if (!this.owner) this.owner = { enrolledAt: Date.now(), refs: [], guardEnabled: true };
    if (!Array.isArray(this.owner.refs)) this.owner.refs = [];
    this.owner.refs.push(dataUrl);
    // 换了照片，旧的人脸特征就作废了（桌宠窗口会在认主完成后按新照片重算）
    this.owner.descriptors = [];
    this.owner.enrolledAt = Date.now();
    const done = this.owner.refs.length >= 3;
    if (done) this.owner.refs = this.owner.refs.slice(-3);
    this._saveOwner();
    this.log(`owner enrolled: ${this.owner.refs.length}/3 refs`);
    return { count: this.owner.refs.length, done };
  }

  /**
   * 存主人的人脸特征（渲染层 @vladmandic/human 算的 1024 维向量）。
   * 认主/在场判定靠它做余弦比对，比让云端模型"看图投票"可靠得多。
   */
  enrollDescriptors(list) {
    const kept = Array.isArray(list)
      ? list.filter((d) => Array.isArray(d) && d.length === 1024)
      : [];
    if (!kept.length || !this.owner) return (this.owner && this.owner.descriptors) || [];
    this.owner.descriptors = kept.slice(-3);
    this._saveOwner();
    this.log(`owner face descriptors saved: ${this.owner.descriptors.length}`);
    return this.owner.descriptors;
  }

  /**
   * 渲染层本地人脸识别给出的身份结论。
   * 本地识别接管后，"是不是主人"不再问云端——免费视觉模型会把参考照当答案点头，
   * 说"没脸也是主人"，锁屏和看家全被它带偏。这里只负责广播结论，
   * 并把它记下来覆盖情绪样本里的身份字段（看家时长统计用的就是这个字段）。
   */
  acceptLocalVerdict(p) {
    if (!p) return;
    this._lastLocalVerdict = {
      ts: p.ts || Date.now(),
      noFace: p.noFace === true,
      ownerPresent: p.ownerPresent === true,
    };
    if (this.current) {
      this.current.noFace = this._lastLocalVerdict.noFace;
      this.current.ownerPresent = this._lastLocalVerdict.ownerPresent;
    }
    this.onPresence(p); // → guard（含刷脸解锁）+ 渲染层状态条
  }

  /** 看家开关（主人离开后是否自动锁屏） */
  toggleGuard() {
    if (this.owner) this.owner.guardEnabled = !(this.owner.guardEnabled !== false);
    this._saveOwner();
    return { enabled: this.guardEnabled };
  }

  get guardEnabled() {
    return !!(this.owner && this.owner.guardEnabled !== false);
  }

  /**
   * 在场追踪：连续默认为主人不在 → 先发锁屏预警（可取消），预警到期仍不在才看家。
   * 预警的意义：防误锁——低头捡东西、戴口罩、转头看窗外都不该被瞬间锁屏。
   */
  _trackPresence(sample) {
    const now = Date.now();
    if (sample.ownerPresent === true) {
      this._absentRun = 0;
      this._cancelWarn();
      if (this.guardActive) this._guardEnd();
      return;
    }

    this._absentRun += 1;
    if (this.guardActive || this._warnTimer) return;   // 已在看家/预警中
    if (now < this._guardSnoozeUntil) return;          // 用户刚点过"我在"
    if (this._absentRun < ABSENT_THRESHOLD) return;
    this._warnLeave();
  }

  /** 锁屏预警：气泡带"我在"按钮，倒计时结束仍不见主人才真正看家 */
  _warnLeave() {
    const seconds = Math.round(this.guardWarnMs / 1000);
    this.log(`owner absent x${this._absentRun} -> warn ${seconds}s before lock`);
    this.onCompanion(
      `🛡 连续 ${this._absentRun} 次没看到主人，${seconds} 秒后鲸鱼要把电脑锁起来看家啦…你还在吗？`,
      "stressed",
      { actions: [{ id: "im-here", label: "我在" }] }
    );
    this._warnTimer = setTimeout(() => {
      this._warnTimer = null;
      // 预警期间若已重新识别到主人，_trackPresence 会清零并取消；这里再确认一次
      if (this._absentRun >= ABSENT_THRESHOLD) this._guardStart();
    }, this.guardWarnMs);
  }

  _cancelWarn() {
    if (this._warnTimer) {
      clearTimeout(this._warnTimer);
      this._warnTimer = null;
      this.log("lock warning cancelled");
    }
  }

  // 看家期间的"偶尔摸鱼"：主人不在时鲸鱼主要保持警惕，但也不能一直绷着——
  // 每 25~40 分钟随机放一次打盹小动画（纯表演，**不改任何识别/锁定判定**）。
  // 主人 2026-09-18 的要求是"偶尔摸鱼，更多的时候还是看家护院"。
  _scheduleSlack() {
    if (this._slackTimer) return;
    const wait = GUARD_SLACK_MIN_MS + Math.random() * (GUARD_SLACK_MAX_MS - GUARD_SLACK_MIN_MS);
    this._slackTimer = setTimeout(() => {
      this._slackTimer = null;
      if (!this.guardActive) return; // 主人已经回来了，不摸了
      this.log("guard slack: 偷个懒（纯表演，不影响看家判定）");
      this.onCompanion("🐋 趁主人不在，偷偷歪着眯一小会儿…（耳朵还竖着呢）", "tired", { effect: "slack" });
      this._scheduleSlack(); // 排下一次
    }, wait);
  }

  /** 停止摸鱼发条（主人回来/退出看家时调用） */
  _stopSlack() {
    if (this._slackTimer) {
      clearTimeout(this._slackTimer);
      this._slackTimer = null;
    }
  }

  _guardStart() {
    this.guardActive = true;
    this.log(`owner absent x${this._absentRun} -> guard ON (lock=${this.guardEnabled})`);
    this.onCompanion("🛡 主人不在，鲸鱼进入看家模式，替你守着电脑～", "calm");
    this.onOwnerChange({ present: false, guardActive: true, lock: this.guardEnabled });
    this._scheduleSlack(); // 看家期间的发条：每 25~40 分钟偶尔摸个鱼
  }

  _guardEnd() {
    this.guardActive = false;
    this._absentRun = 0;
    this._stopSlack();
    this.log("owner back -> guard OFF");
    this.onCompanion("🎉 欢迎回来主人！鲸鱼把电脑看得好好的～", "happy", { effect: "jump" });
    this.onOwnerChange({ present: true, guardActive: false, lock: false });
  }

  // ---- 视觉分析 ------------------------------------------------------------

  /** 视觉模型候选链：主模型 + 备用（免费视觉池经常限流，不能只押一个模型） */
  _visionModels() {
    return [this.visionModel, ...this.visionFallbacks].filter(Boolean);
  }

  /**
   * 候选链，但跳过正在冷却的模型。免费池被限流（429 / 1305）后，
   * 每 15 秒都去撞一次纯属浪费——把失败的模型冷掉 5 分钟，期间直接用备胎，
   * 到期自动恢复尝试主力。全部都在冷却时仍返回主模型，避免无模型可用。
   */
  _visionCandidates() {
    const now = Date.now();
    const all = this._visionModels();
    const ready = all.filter((m) => (this._modelCooldown.get(m) || 0) <= now);
    return ready.length ? ready : all.slice(0, 1);
  }

  /** 所有视觉模型都在冷却期？是的话这一拍干脆不问云端（否则每次都必失败 + 日志刷屏） */
  _visionCoolingAll() {
    const now = Date.now();
    return this._visionModels().every((m) => (this._modelCooldown.get(m) || 0) > now);
  }

  /** 4.6V / 5 系列支持显式关思考：关了更快更省，输出也更干净（老模型忽略该参数） */
  _needsThinkingOff(model) {
    return /^glm-(4\.6|5)/.test(String(model));
  }

  /**
   * 调视觉模型，带候选链回退：主模型报错（如智谱免费池 1305 访问量过大）、
   * 或返回空内容时，自动换下一个候选模型重试一次。
   * 只靠一个免费模型会出现"隔几次识别失败一次"，识别时断时续，锁屏判定也跟着抖。
   * **每次请求都有硬超时**（方向 3）：超时就 abort 掉连接并报 TIMEOUT，
   * 绝不把调用方永远挂住——escalate 到顶层会被记成一条 miss 记录。
   * @param {number} [deadlineMs] 本次请求的上限（默认 VISION_DEADLINE_MS；身份探测给更短）
   * @returns {Promise<string>} 模型返回的原始文本（未解析）
   */
  async _visionChat(content, maxTokens, deadlineMs) {
    const models = this._visionCandidates();
    const limit = Number(deadlineMs) > 0 ? Number(deadlineMs) : VISION_DEADLINE_MS;
    let lastErr = null;
    for (const model of models) {
      // 超时就用 AbortController 真把请求掐掉（不然 socket 会一直挂着占资源）
      const ctrl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, limit);
      try {
        const body = { model, messages: [{ role: "user", content }], max_tokens: maxTokens };
        if (this._needsThinkingOff(model)) body.thinking = { type: "disabled" };
        const resp = await fetch(`${PET_API_BASE()}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${PET_API_KEY()}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data?.usage) this.recordUsage(model, data.usage);
        const text = data?.choices?.[0]?.message?.content || "";
        if (!text.trim()) throw new Error("空回复（思考token吃光了输出上限）");
        if (model !== this.visionModel) this.log(`vision fallback -> ${model}`);
        return text;
      } catch (err) {
        // 超时的报错文案要说清"谁超时、限多少"——这条会一路记进事件日志
        lastErr = timedOut ? new Error(`TIMEOUT ${limit}ms（视觉模型 ${model} 没在限期内回应）`) : err;
        if (timedOut) lastErr.code = "TIMEOUT";
        // 失败的模型冷掉一阵，别在限流期间每帧都去撞
        this._modelCooldown.set(model, Date.now() + VISION_COOLDOWN_MS);
        this.log(`vision ${model} failed: ${lastErr.message} -> 冷却 ${Math.round(VISION_COOLDOWN_MS / 60000)} 分钟`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error("没有可用的视觉模型");
  }

  /**
   * 给任意 await 加一个"最晚到这里必须了结"的上限（方向 3 的兜底）。
   * 超时不抛给调用方崩链路，而是返回 null 并记一条 miss——调用方拿到 null 就当"这一拍没结论"。
   * 注意：这只是**放弃等待**（底层请求可能还在跑，结果会被丢弃）；
   * 视觉链那条有自己的 AbortController，会真掐断连接。
   */
  async _withDeadline(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        this._noteMiss({ kind: "timeout", label, reason: `超过 ${ms}ms 没回来`, ms });
        resolve(null);
      }, ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 记一次"没结论"（超时/放弃）：写日志 + 往事件日志追加一条 miss，让悬挂态可查 */
  _noteMiss({ kind, label, reason, ms }) {
    this.log(`miss(${kind}): ${label} —— ${reason}`);
    this._append({ t: "miss", ts: Date.now(), kind, label, reason, ms: ms || null });
  }

  /**
   * 渲染层送来一帧（dataURL）。内部节流 + 串行，保证不会打爆 API。
   * 两条线各自节流，都从"请求开始"计时而非"分析完成"：否则 API 耗时会累积，
   * 让实际节奏从 60s 漂到 120s（抓两帧只用一帧）。0.8 容差吸收抓帧定时器
   * 与主进程计时之间的抖动。
   *   情绪/行为分析 → 完整情绪分析（记录/推测/陪伴），按 intervalMs
   *   在场探测（probe，应用级锁屏用）→ 只问"是不是主人"，不记录不打扰
   * @param {string} dataUrl 摄像头帧（JPEG dataURL）
   * @param {{ts:number, marOut:number|null, marIn:number|null}} [geo]
   *        渲染层在抓帧那一刻量到的嘴部几何量（过闸用，见 _gate）
   */
  async analyzeFrame(dataUrl, geo) {
    if (!dataUrl) return;
    if (!this.enabled && !this.probe) return; // 探测由锁屏驱动，优先于情绪开关
    // 发呆判定：只看本机信号（本地人脸结论 + 键鼠空闲），跟云端调用无关，所以每帧都先判
    this._trackGaze();
    if (this.busy) return;
    const now = Date.now();
    // 两条线各走各的节奏，谁也别吞掉谁：
    //   身份探测（probe）→ 只有"本机人脸不可用"时才问云端（本地可用时身份结论由渲染层直接给），
    //     按锁屏下发的探测节奏跑；
    //   情绪/行为分析 → 按自己的 intervalMs 跑。
    // 以前这里用 `probe ? 探测 : 情绪` 二选一，结果"应用锁屏一开（probe 常驻 true），
    // 情绪记录/突变/哈欠/小动作/屏幕内容全停"——实测重启后 4 分钟零样本。
    const probeDue =
      this.probe && !this.localIdentity &&
      now - this.lastProbeAt >= (this.probeIntervalMs || 5000) * 0.8;
    const emotionDue = this.enabled && now - this.lastEmotionAt >= this.intervalMs * 0.8;
    // 行为专线：画面里没人就不问（省调用——没人的时候"动作"没有意义）
    const behaviorDue =
      this.enabled && this.behaviorIntervalMs > 0 &&
      now - this.lastBehaviorAt >= this.behaviorIntervalMs * 0.8 &&
      !(this._lastLocalVerdict && this._lastLocalVerdict.noFace);
    if (!probeDue && !emotionDue && !behaviorDue) return;
    if (this._visionCoolingAll()) return; // 两个视觉模型都在冷却：这一拍问也是白问（省一次必失败的请求 + 日志别刷屏）
    this.busy = true;
    try {
      // 记下这一帧对应的本机几何量：下面这一拍的哈欠结论要靠它过闸（一次只跑一帧，不会串）
      // 每一拍都套一层总上限（方向 3）：上面每条链各有自己的超时，这里兜住整拍的异常情况，
      // 保证 busy 一定会被 finally 释放、绝不出现"整条线静默死掉"。
      this._frameGeo = geo && typeof geo === "object" ? geo : null;
      if (probeDue) {
        this.lastProbeAt = now;
        const p = await this._withDeadline(this._callProbe(dataUrl), LANE_DEADLINE_MS, "身份探测");
        if (p) this.onPresence({ ...p, source: "probe" });
      } else if (emotionDue) {
        this.lastEmotionAt = now;
        const sample = await this._withDeadline(this._callVision(dataUrl), LANE_DEADLINE_MS, "情绪线");
        if (sample) this._accept(sample);
      } else if (behaviorDue) {
        this.lastBehaviorAt = now;
        const b = await this._withDeadline(this._callBehavior(dataUrl), LANE_DEADLINE_MS, "行为线");
        this._noteBehavior(b);
      }
    } catch (err) {
      // 超时单独记一条 miss（悬挂态要留痕）：链路里抛上来的 TIMEOUT 都在这收口
      if (err && err.code === "TIMEOUT") {
        this._noteMiss({ kind: "vision", label: "分析一拍", reason: err.message });
      }
      this.log(`analyze failed: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * 渲染层该按多快抓帧：取所有"要跑的分析"里最快的那个节奏。
   * 少了这一步，行为专线（10 秒）会被情绪线的抓帧节奏（60 秒）卡死——
   * 渲染层只在被下发的节奏上抓帧，抓不到帧等于这条线不存在。
   */
  captureInterval() {
    const list = [];
    if (this.enabled) {
      list.push(this.intervalMs);
      if (this.behaviorIntervalMs > 0) list.push(this.behaviorIntervalMs);
    }
    if (this.probe) list.push(this.probeIntervalMs || 5000);
    return list.length ? Math.min(...list) : 0;
  }

  /**
   * 切换在场探测模式（应用级锁屏用）。
   * 探测只输出身份结论，不写事件、不弹气泡——锁屏判定要快、要便宜、要安静。
   * @param {boolean} on
   * @param {number} [ms] 探测节奏（毫秒），缺省沿用上次（兜底 5 秒）
   */
  setProbe(on, ms) {
    this.probe = !!on;
    if (on) {
      this.probeIntervalMs = Math.max(1500, Number(ms) || this.probeIntervalMs || 3000);
      // 只在"进入探测"时清掉探测节流计时：锁屏/在场判定要立刻生效。
      // 情绪那条线（lastEmotionAt）不动——它有自己的间隔，不该被键鼠抖动带节奏。
      this.lastProbeAt = 0;
      this.log(`probe ON @${Math.round(this.probeIntervalMs / 1000)}s`);
    } else {
      this.log("probe OFF");
    }
  }

  /** 便宜的纯身份探测：只判断画面中的人是不是主人 */
  async _callProbe(dataUrl) {
    if (!this.isEnrolled()) return null;
    // 当前画面放第一张：免费视觉模型容易"盯着第一张图作答"，
    // 之前第一张是参考照，等于在引导它回"是主人本人"——镜头被遮住也照样点头。
    const content = [
      { type: "image_url", image_url: { url: dataUrl } },
      { type: "image_url", image_url: { url: this.owner.refs[0] } },
      {
        type: "text",
        text: [
          "第 1 张图是此刻的摄像头画面，第 2 张图是主人的参考照片（只作对照）。",
          "只依据第 1 张图判断：画面里有没有人脸？这张脸是不是第 2 张图里的同一个人？",
          "画面黑屏、被遮住、看不到人脸、或人脸不清晰 → 一律 noFace=true、ownerPresent=false。",
          "不要因为第 2 张图是主人就回答 true；只有第 1 张图明确是同一张脸才 ownerPresent=true。",
          '只输出 JSON，禁止其他文字：{"noFace": bool, "ownerPresent": bool, "similarity": 0~1}',
        ].join("\n"),
      },
    ];
    const m = (await this._visionChat(content, 400, PROBE_DEADLINE_MS)).match(/\{[\s\S]*\}/);
    if (!m) {
      this.log("probe: 模型没吐出 JSON，本次不采信");
      return null;
    }
    let obj;
    try { obj = JSON.parse(m[0]); } catch {
      this.log(`probe: JSON 解析失败 -> ${m[0].slice(0, 120)}`);
      return null;
    }
    const noFace = obj.noFace === true;
    // 免费模型会自相矛盾：嘴上说"是主人"却给出很低的相似度。
    // 这里做自洽校验——相似度不到 0.55 一律不认，宁可多等一次探测也不乱认主人。
    const sim = Math.max(0, Math.min(1, Number(obj.similarity) || 0));
    const claimsOwner = !noFace && obj.ownerPresent === true;
    const ownerPresent = claimsOwner && sim >= SIM_OWNER_MIN;
    if (claimsOwner && !ownerPresent) {
      this.log(`probe: 模型说像主人但 similarity=${sim.toFixed(2)} 太低 -> 不认`);
    }
    if (ownerPresent) {
      // 认主是敏感结论，把原始判断打出来，方便事后核对是不是模型瞎点头
      this.log(`probe: 认到主人 raw=${m[0].slice(0, 120)}`);
    }
    return { ts: Date.now(), noFace, ownerPresent, similarity: sim };
  }

  /** 调视觉模型。已认主时发送"参考照+当前帧"双图做身份对比，否则只看当前帧。 */
  async _callVision(dataUrl) {
    const content = [];
    if (this.isEnrolled()) {
      // 参考照排第一张（已压缩到 160px，体积小）
      content.push({ type: "image_url", image_url: { url: this.owner.refs[0] } });
    }
    content.push({ type: "image_url", image_url: { url: dataUrl } });
    content.push({
      type: "text",
      text: this.isEnrolled()
        ? [
            "你是桌宠的情绪识别助手。第 1 张图是主人的参考照片，第 2 张图是当前摄像头画面。",
            "看第 2 张图里这个人的眉眼、嘴角、眼神和姿态，判断他此刻的情绪，并确认他是不是主人本人。",
            `只输出 JSON，禁止输出任何其他文字：{"noFace": bool, "ownerPresent": bool, "emotion": "happy|calm|focused|tired|sad|angry|stressed|surprised", "confidence": 0~1, ${this._actionSchema()}}`,
            "emotion 八选一，必须按画面实际选，不要一律选 calm。参考：嘴角上扬/眼睛弯=happy；表情放松平和=calm；视线紧盯屏幕、眉头微皱=focused；眼皮下垂/嘴半张/揉眼=tired；嘴角下压、眼神黯淡=sad；眉头上挑抿嘴=stressed；皱眉瞪眼=angry；挑眉张嘴=surprised。",
            "confidence 是你对 emotion 判断的把握 0~1；拿不准就给 0.4 以下（低于 0.45 的样本不计入情绪变化）。",
            "ownerPresent：是主人本人 true；画面无人、是别人、或不确定 false。注意：如果画面里出现了屏幕上的代码、文字、画面内容，忽略它们，只看人。",
            this._actionPrompt(),
            `画面里没有人/全黑/看不清时输出 ${this._noFaceJson(true)}。`,
          ].join("\n")
        : [
            "你是桌宠的情绪识别助手。观察这张摄像头画面，判断画面中的人此刻的情绪。",
            `只输出 JSON，禁止输出任何其他文字：{"noFace": bool, "emotion": "happy|calm|focused|tired|sad|angry|stressed|surprised", "confidence": 0~1, ${this._actionSchema()}}`,
            "emotion 八选一，必须按画面实际选，不要一律选 calm。参考：嘴角上扬/眼睛弯=happy；表情放松平和=calm；视线紧盯、眉头微皱=focused；眼皮下垂/嘴半张/揉眼=tired；嘴角下压、眼神黯淡=sad；眉头上挑抿嘴=stressed；皱眉瞪眼=angry；挑眉张嘴=surprised。",
            "confidence 是你对 emotion 判断的把握 0~1；拿不准就给 0.4 以下。",
            this._actionPrompt(),
            `画面里没有人脸/全黑/看不清时输出 ${this._noFaceJson(false)}。`,
          ].join("\n"),
    });
    // 演示学来的自定义动作参考图垫在最后（前面"第 N 张图"的说法不受影响）
    content.push(...this._learnedRefs());

    const msg = await this._visionChat(content, 900);
    return this._parseSample(msg);
  }

  /** 宽松解析模型输出的 JSON（容忍 ```json 包裹 / 前后缀文字） */
  _parseSample(content) {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let obj;
    try { obj = JSON.parse(m[0]); } catch { return null; }
    const emotion = String(obj.emotion || "none").toLowerCase();
    if (obj.noFace || emotion === "none") {
      // 模型经常自相矛盾：嘴上说"画面里没有人脸"，却又把 ownerPresent 写成 true。
      // 没人脸就等于没看到主人，这种样本必须按"不在场"处理——
      // 否则状态条会显示"✅ 看到主人"，看家模式也会被误判成主人回来而解除。
      if (obj.ownerPresent === true) {
        this.log("sample: 模型自相矛盾（noFace=true 却 ownerPresent=true）-> 按不在场处理");
      }
      return {
        ts: Date.now(), noFace: true, emotion: "none", valence: 0, confidence: 0,
        yawn: false, ownerPresent: false, actions: this._noActions(),
      };
    }
    if (!(emotion in EMOTION_VALENCE)) return null;
    return {
      ts: Date.now(),
      noFace: false,
      emotion,
      // valence 不采信模型输出：实测免费小模型对同一张图给出 0.0 / 0.6 乱跳的连续值，
      // 会让"情绪突变"判定变成丢硬币。改为由情绪标签映射——稳定、可解释、够用。
      valence: EMOTION_VALENCE[emotion],
      confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0.6)),
      // 云端说"在打哈欠"还要过本机几何量这一闸（规则来自 signals.js 的 yawn 声明）
      yawn: this._gate(this._signalDef("yawn"), obj.yawn === true, "emotion"),
      // 小动作 + 演示学来的自定义动作：逐个过闸（见 _readActions）→ 只做统计，见 _accept
      actions: this._readActions(obj, "emotion"),
      // 已认主时模型会输出身份字段；未认主时为 undefined，不参与在场判定
      ownerPresent: obj.ownerPresent === true,
    };
  }

  /**
   * 行为专线：只问动作（哈欠 + 小动作 + 演示学来的自定义动作），
   * 不问情绪、不问身份——prompt 短、max_tokens 小，省钱也快。
   * 命中就计数（_noteBehavior），不进情绪历史、不触发突变/陪伴。
   */
  async _callBehavior(dataUrl) {
    const content = [
      { type: "image_url", image_url: { url: dataUrl } },
      {
        type: "text",
        text: [
          "看这张摄像头画面，只判断下面这几个动作：",
          this._actionPrompt(),
          `只输出 JSON，禁止输出任何其他文字：{"noFace": bool, ${this._actionSchema()}}`,
        ].join("\n"),
      },
    ];
    content.push(...this._learnedRefs()); // 自定义动作的演示参考图（few-shot）
    const msg = await this._visionChat(content, 120);
    const m = msg.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let obj;
    try { obj = JSON.parse(m[0]); } catch { return null; }
    if (obj.noFace) return { noFace: true };
    return {
      // 行为专线是抓哈欠的主力（5 秒一帧），同样要过本机几何量这一闸
      yawn: this._gate(this._signalDef("yawn"), obj.yawn === true, "behavior"),
      actions: this._readActions(obj, "behavior"),
    };
  }

  /** 行为专线的结论 → 计数（不写情绪事件、不记样本） */
  _noteBehavior(b) {
    if (!b || b.noFace) return;
    if (this.guardActive) return; // 看家模式（主人不在）：别记账也别弹气泡
    this._noteYawn(b.yawn);
    this._noteActions(b.actions);
  }

  /** 接收一个有效样本：在场判定 → 更新历史 → 检测突变 → 触发陪伴 */
  _accept(sample) {
    this.current = sample;
    // 本地人脸识别接管后，身份以本地结论为准：云端模型只负责看情绪。
    // 免费模型会把参考照当答案点头（"画面里没人"也能回 ownerPresent=true），
    // 拿它当主人是否在场，锁屏和看家都会被带偏。
    if (this.localIdentity && this._lastLocalVerdict) {
      sample.noFace = this._lastLocalVerdict.noFace;
      sample.ownerPresent = this._lastLocalVerdict.ownerPresent;
    }
    this.history.push(sample);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.log(`sample: ${sample.emotion} valence=${sample.valence.toFixed(2)} conf=${sample.confidence.toFixed(2)}${sample.yawn ? " yawn!" : ""}${this.isEnrolled() ? ` owner=${sample.ownerPresent ? "in" : "out"}` : ""}`);
    this.onAnalysis(sample);
    // 今日情绪分布/样本数按天累计（内存里只有最近 60 个样本，代表不了"今天"）
    if (!sample.noFace) this._recordSample(sample.emotion);

    // 主人在场判定（已认主才有效）；看家模式下暂停一切陪伴/记录
    if (this.isEnrolled()) {
      // 本地接管时身份结论已经由 acceptLocalVerdict 实时广播过（还带着 source=probe），
      // 这里不再重复发，只让这一条 60 秒一次的样本去推动看家时长统计
      if (!this.localIdentity) {
        // 身份结论同步给应用级锁屏（guard 在非探测/非锁定态会忽略，无副作用）
        this.onPresence({
          ts: sample.ts,
          noFace: sample.noFace,
          ownerPresent: !sample.noFace && sample.ownerPresent === true,
          similarity: sample.similarity || 0,
          source: "emotion", // 来自常规情绪分析，不是专门的刷脸探测（不能拿它开门）
        });
      }
      this._trackPresence(sample);
    }
    if (this.guardActive) return;
    // 锁屏预警挂起期间保持安静：气泡上留着"我在"按钮，不能被别的话顶掉
    const quiet = !!this._warnTimer;

    // 打哈欠 + 小动作（摸下巴/托腮/伸懒腰）：无论情绪是否突变都计数（突变检测照常并行）。
    // 行为专线（每 10 秒一帧）也走这两个方法，逻辑只有一份。
    const talked = this._noteYawn(sample.yawn);
    this._noteActions(sample.actions);

    const event = this._detectChange(sample);
    // 日常陪伴：不突变也偶尔说句话（同情绪 10 分钟内只说一次）
    // （本帧已经说过哈欠消息就不再叠加随机搭话，避免气泡互相顶掉）
    if (!event) {
      if (!talked && !quiet) this._maybeInteract(sample);
      return;
    }
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    // 情绪变化只追加，不改写历史（原因稍后由 _speculate 追加一条 reason 记录回填）
    this._append({
      t: "change",
      ts: event.ts,
      from: event.from,
      to: event.to,
      valenceFrom: event.valenceFrom,
      valenceTo: event.valenceTo,
      delta: event.delta,
    });
    this.onEvent(event);
    this.onCompanion(
      `📝 已记录 ${fmtTime(event.ts)} 的情绪变化：${label(event.from)} → ${label(event.to)}`,
      event.to
    );
    // 本地小闸门（2026-09-22 对照实验的结论）：|delta| 调到 0.2 就会误杀 31% 有价值的推测
    // （delta=0.17 的"写代码有进展，疲惫转平静"正是好原因的主力），所以只拦
    // "标签翻了但好感值几乎没动"（|Δ| < 0.1）这种检测噪声。留一句**实话**当原因回填——
    // 既不吊着"鲸鱼还在琢磨"，也避免启动兜底把它误标成"模型没回应"。
    if (Math.abs(event.delta) < SPECULATE_MIN_DELTA) {
      const why = `小波动（|Δ${Math.abs(event.delta).toFixed(2)}|），不值得花一次推测`;
      event.reason = why;
      this._append({ t: "reason", ts: Date.now(), targetTs: event.ts, reason: why });
      this.log(`speculate skipped: ${why}`);
      return;
    }
    // 异步推测原因，出来后追加一条消息（不阻塞下一次分析）。
    // 免费文本模型偶尔空手回来（限流/超时），隔 6 秒重试一次；再不行就写兜底原因，
    // 不能让报告一直挂着"鲸鱼还在琢磨原因…"
    this._speculate(event).catch((err) => {
      this.log(`speculate failed: ${err.message} -> 6 秒后重试一次`);
      setTimeout(() => {
        this._speculate(event).catch((err2) => {
          this.log(`speculate retry failed: ${err2.message}`);
          this._fallbackReason(event, this._reasonFailText(err2));
        });
      }, 6000);
    });
  }

  /**
   * 突变检测：只认"情绪标签真的换了"的变化。
   * 之前只看 valence 跳变，会记录出 "calm → calm" 这种无意义事件（旧数据里真有 3 条），
   * 那只是数值抖动，不是主人的情绪变化。现在要求标签变化，且满足其一：
   *   1) valence 相对"近期基线(前 2~3 个有效样本均值)"突变 ≥ 阈值
   *   2) 正负情绪跨越（valence 一正一负）且两侧 |valence| ≥ 0.3
   */
  _detectChange(sample) {
    if (sample.noFace || sample.confidence < MIN_CONFIDENCE) return null;
    const recent = this.history
      .slice(-6, -1)                       // 当前样本之前的最近几个
      .filter((s) => !s.noFace && s.confidence >= MIN_CONFIDENCE)
      .slice(-3);
    if (recent.length < 2) return null;

    const prev = recent[recent.length - 1];
    if (prev.emotion === sample.emotion) return null; // 标签没变就不算"情绪变化"

    const baseline = recent.reduce((a, s) => a + s.valence, 0) / recent.length;
    const delta = sample.valence - baseline;

    const crossedSign = recent.some((s) => s.valence >= 0.05) && sample.valence <= -0.3
      || recent.some((s) => s.valence <= -0.05) && sample.valence >= 0.3;
    const jumped = Math.abs(delta) >= DELTA_THRESHOLD;

    if (!jumped && !crossedSign) return null;
    const from = prev.emotion;
    return {
      ts: sample.ts,
      from,
      to: sample.emotion,
      valenceFrom: Number(baseline.toFixed(2)),
      valenceTo: Number(sample.valence.toFixed(2)),
      delta: Number(delta.toFixed(2)),
      reason: null,     // 推测原因（异步回填）
      comfort: null,    // 关心的话（异步回填）
    };
  }

  // ---- 原因推测 ------------------------------------------------------------

  /** 把电脑工作上下文说成人话，供推测模型参考 */
  _describeDsh() {
    let c = null;
    try { c = this.getDshContext(); } catch { c = null; }
    if (!c) return "AI agent 服务未连接（桌上可能没启动 dsh）";
    if (!c.connected) return "桌宠没连上 AI agent 服务，看不到电脑上的工作状态";
    const parts = [];
    parts.push(c.running > 0 ? `正在运行 ${c.running} 个 AI 会话` : "AI 会话当前都空闲");
    if (typeof c.lastActiveMinAgo === "number") {
      parts.push(
        c.lastActiveMinAgo <= 1
          ? "最近 1 分钟内刚有过会话活动"
          : `最近一次会话活动在约 ${c.lastActiveMinAgo} 分钟前`
      );
    }
    parts.push(`共有 ${c.sessions} 个历史会话`);
    return parts.join("；");
  }

  /**
   * 看一眼屏幕：抓一帧 → 让视觉模型出一句"此刻屏幕上在干什么"的摘要。
   * 只在"显著情绪变化"要推测原因时调用（一天也就几次），原图不落盘、只留摘要。
   * 全程兜底：抓不到屏幕 / 模型失败都返回 null，推测照旧（只是少了这条线索）。
   */
  async _screenHint() {
    if (!this.captureScreen) return null;
    let shot = null;
    try {
      shot = await this.captureScreen();
    } catch (err) {
      this.log(`screen capture failed: ${err.message}`);
      return null;
    }
    if (!shot) return null;
    try {
      const text = await this._visionChat(
        [
          { type: "image_url", image_url: { url: shot } },
          {
            type: "text",
            text: [
              "这是一位用户电脑屏幕的截图（可能有点糊，或好几个窗口叠在一起）。",
              "用不超过 30 个字说清楚他现在大概在做什么：用什么软件、什么内容（例如「VS Code 里改一段报错的 Python」「浏览器查 API 文档」「终端在跑测试」）。",
              "只说屏幕上看得见的事实，不要猜情绪，不要输出 JSON，不要引号。",
            ].join("\n"),
          },
        ],
        200,
        SCREEN_HINT_DEADLINE_MS,
      );
      const line = String(text || "").replace(/\s+/g, " ").replace(/^["'《]+|["'》]+$/g, "").trim();
      if (!line) return null;
      this.log(`screen hint: ${line.slice(0, 80)}`);
      return line.slice(0, 80);
    } catch (err) {
      this.log(`screen summary failed: ${err.message}`);
      return null;
    }
  }

  /** 让文本模型结合时间线 + 电脑工作状态 + 屏幕内容推测情绪突变的原因 */
  async _speculate(event) {
    const samples = this.history.slice(-10)
      .filter((s) => !s.noFace)
      .map((s) => `${fmtTime(s.ts)} ${label(s.emotion)}(valence ${s.valence.toFixed(2)})`)
      .join("\n");
    const dshDesc = this._describeDsh();
    const screenHint = await this._screenHint(); // 抓到才喂，抓不到这条线索就空着
    const question = [
      "一位用户桌前的鲸鱼桌宠持续通过摄像头识别情绪，刚检测到一次显著的情绪变化：",
      `时间点：${fmtTime(event.ts)}；变化：${label(event.from)} → ${label(event.to)}（valence ${event.valenceFrom} → ${event.valenceTo}）`,
      "最近的情绪时间线：",
      samples || "（无更早样本）",
      `此刻电脑上 AI agent 的工作情况：${dshDesc}。`,
      screenHint
        ? `此刻屏幕上的内容：${screenHint}。（这是刚抓的屏幕截图摘要）`
        : "此刻拿不到屏幕内容。",
      screenHint
        ? "请结合时间点、工作情况、屏幕内容一起推测最可能的原因。"
        : "注意：你没有屏幕内容，只能依据时间点和工作情况做【初步推测】。",
      '只输出 JSON：{"reason": "不超过30字的最可能原因推测", "comfort": "不超过20字的暖心陪伴"}',
      screenHint
        ? "reason 里要体现推测依据（时间/工作情况/屏幕内容），语气自然不要武断。"
        : "reason 里要体现推测依据（如时间/工作状态），语气自然不要武断。",
    ].join("\n");
    // 文字模型也要有个了结：超时就放弃等待（底层请求可能还在跑，结果丢弃），
// 让上层走"失败 → 重试 → 兜底原因"那条确定性路径，而不是永远挂着。
    const content = await this._withDeadline(this.askLLM(this.textModel, question), TEXT_DEADLINE_MS, "推测原因");
    if (content == null) throw new Error(`TIMEOUT ${TEXT_DEADLINE_MS}ms（推测原因没在限期内回来）`);
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("推测输出无法解析");
    const obj = JSON.parse(m[0]);
    event.reason = String(obj.reason || "").slice(0, 60);
    event.comfort = String(obj.comfort || "").slice(0, 40);
    if (!event.reason) {
      // 模型回了 JSON 但 reason 是空的：一样算失败，否则报告会一直挂着"还在琢磨"
      this._fallbackReason(event, "模型当时没给出结果");
      return;
    }
    this._append({ t: "reason", ts: Date.now(), targetTs: event.ts, reason: event.reason, comfort: event.comfort });
    this.onCompanion(
      `💭 初步推测：${event.reason}\n${event.comfort || ""}`.trim(),
      event.to
    );
    this.onReportChanged();
  }

  /** 推测失败的原因说成人话（报告里是给主人看的，别把错误原文贴上去） */
  _reasonFailText(err) {
    const m = String((err && err.message) || "");
    if (/429|限流|rate/i.test(m)) return "模型当时被限流了";
    if (/没有返回|无法解析|JSON|empty/i.test(m)) return "模型当时没给出结果";
    return "模型当时没回应";
  }

  /** 推测最终没结果 → 写一句兜底原因（并让开着的报告就地刷新） */
  _fallbackReason(event, why) {
    if (!event || event.reason) return;
    event.reason = `这次没推测出原因（${why}）`;
    this._append({ t: "reason", ts: Date.now(), targetTs: event.ts, reason: event.reason, comfort: null });
    this.onReportChanged();
  }

  // ---- 主动交互策略引擎 -----------------------------------------------------
  //
  // 设计原则：像朋友一样"看火候"，而不是每次表情都搭话——
  //  · 全局冷却：两次主动交互间隔随机 5~10 分钟，每小时最多 4 次
  //  · 规则匹配：按"情绪组连续时长"触发（专注太久/连续低落/连续开心…）
  //  · 可交互：气泡可带按钮（聊聊天/讲个笑话/再一会儿），点击回传 handleInteraction
  //  · 突变事件（_detectChange）不受冷却限制，永远优先

  /** 情绪分组：用于统计"连续处于某种大状态"的时长 */
  _groupOf(emotion) {
    if (emotion === "happy" || emotion === "calm" || emotion === "focused") return "positive";
    if (emotion === "tired") return "tired";
    if (emotion === "sad" || emotion === "stressed" || emotion === "angry") return "negative";
    return "neutral"; // surprised 等
  }

  /** 每次有效样本都进来评估：先更新连续状态，再决定要不要主动交互 */
  _maybeInteract(sample) {
    if (sample.noFace || sample.confidence < MIN_CONFIDENCE) return;
    const now = Date.now();
    const group = this._groupOf(sample.emotion);

    // 更新情绪组连续状态
    if (this._streak.group === group) {
      this._streak.count += 1;
    } else {
      this._streak = { group, count: 1, since: now };
    }

    // 全局限频：随机冷却 5~10 分钟 + 每小时最多 4 次
    if (now - this.lastInteractAt < this._interactCooldown()) return;
    this._interactTimes = this._interactTimes.filter((t) => now - t < 3600000);
    if (this._interactTimes.length >= 4) return;

    const rule = this._pickRule(sample, now);
    if (!rule) return;

    this.lastInteractAt = now;
    this._interactTimes.push(now);
    this.log(`interact: ${rule.id} (${sample.emotion}, streak ${this._streak.count})`);
    this.onCompanion(rule.text, rule.mood, rule.payload || null);
  }

  _interactCooldown() {
    return (5 + Math.random() * 5) * 60000; // 5~10 分钟
  }

  /** 按优先级匹配交互规则；返回 null 表示这轮不打扰 */
  _pickRule(sample, now) {
    const streakMin = (now - this._streak.since) / 60000;
    const group = this._streak.group;
    const snoozed = (id) => now < (this._snooze[id] || 0);

    // 1. 持续专注 ≥ 45 分钟 → 劝休息（可 snooze）
    if (group === "positive" && streakMin >= 45 && !snoozed("focus-reminder")) {
      return {
        id: "focus-reminder",
        mood: "focused",
        text: `⏳ 你已经连续专注 ${Math.round(streakMin)} 分钟啦，起来活动一下？鲸鱼陪你伸个懒腰～`,
        payload: {
          actions: [
            { id: "focus-ack", label: "这就动" },
            { id: "focus-later", label: "再一会儿" },
          ],
        },
      };
    }

    // 2. 压力/生气持续 ≥ 3 分钟 → 深呼吸引导
    if (group === "negative" && sample.emotion !== "sad" && streakMin >= 3 && !snoozed("breath")) {
      return {
        id: "breath",
        mood: "stressed",
        text: "跟鲸鱼一起深呼吸：吸气～～～ 呼气～～～",
        payload: { effect: "breath" },
      };
    }

    // 3. 连续低落 ≥ 2 个样本 → 主动关心，给三个选择
    if (group === "negative" && this._streak.count >= 2 && !snoozed("sad-support")) {
      return {
        id: "sad-support",
        mood: "sad",
        text: "鲸鱼发现你好像不太开心……想聊聊天吗？还是听鲸鱼讲个笑话？",
        payload: {
          actions: [
            { id: "chat", label: "聊聊天" },
            { id: "joke", label: "讲个笑话" },
            { id: "dismiss", label: "没事" },
          ],
        },
      };
    }

    // 4. 连续疲惫 → 提醒休息（今天打哈欠多时更容易触发、文案报数）
    const yawnN = this.yawnToday();
    const tiredHit = group === "tired" && (this._streak.count >= 3 || (sample.yawn && yawnN >= 2));
    if (tiredHit && !snoozed("tired-care")) {
      const yawnLine = yawnN > 0 ? `（今天已经 ${yawnN} 个哈欠了）` : "";
      return {
        id: "tired-care",
        mood: "tired",
        text: `😪 眼皮在打架了吗${yawnLine}？喝口水、看看窗外远处，鲸鱼帮你盯着屏幕～`,
        payload: { actions: [{ id: "tired-ack", label: "好" }] },
      };
    }

    // 5. 连续开心 → 鲸鱼也想凑热闹（低概率，纯卖萌）
    if (group === "positive" && sample.emotion === "happy" && this._streak.count >= 2 && Math.random() < 0.35) {
      return {
        id: "happy-play",
        mood: "happy",
        text: "看你心情这么好，鲸鱼给你转个圈～✨",
        payload: {
          effect: "spin",
          actions: [{ id: "dance-again", label: "再来一个" }],
        },
      };
    }

    // 6. 兜底：小概率随口说句陪伴的话（同情绪 10 分钟冷却）
    const last = this.companionSeenAt[sample.emotion] || 0;
    if (now - last < 15 * 60000) return null;
    if (Math.random() > 0.2) return null;
    const lines = COMPANION[sample.emotion];
    if (!lines) return null;
    this.companionSeenAt[sample.emotion] = now;
    return { id: "casual", mood: sample.emotion, text: lines[Math.floor(Math.random() * lines.length)] };
  }

  /** 用户点了气泡按钮 → 主进程处理（文本反馈 / LLM 笑话 / 唤起聊天） */
  async handleInteraction(id) {
    const reply = (text, mood, payload) => this.onCompanion(text, mood, payload || null);
    // 自定义提醒气泡上的按钮：id 形如 remind-ok:<提醒id> / remind-snooze:<提醒id>。
    // 这里只回一句"收到/多会儿再说"，绝不顺着提醒内容讲道理（吃药就是吃药，不评价）。
    const rm = /^remind-(ok|snooze):(.+)$/.exec(String(id || ""));
    if (rm) {
      const itemId = rm[2];
      const item = ((this.reminders && this.reminders.items) || []).find((x) => x && x.id === itemId);
      const st = this._reminderFired[itemId] ||
        (this._reminderFired[itemId] = { day: dayKey(), at: item ? item.at : "", snoozeUntil: 0 });
      if (rm[1] === "snooze") {
        st.snoozeUntil = Date.now() + REMINDER_SNOOZE_MS;
        reply(`好，${Math.round(REMINDER_SNOOZE_MS / 60000)} 分钟后再提醒你一次`, "calm");
      } else {
        reply("好，鲸鱼记下了 🐋", "calm", { effect: "wiggle" });
      }
      return;
    }
    switch (id) {
      case "focus-ack":
        reply("好耶！鲸鱼等你好消息～", "happy", { effect: "jump" });
        break;
      case "focus-later":
        this._snooze["focus-reminder"] = Date.now() + 30 * 60000; // 30 分钟内不再劝
        reply("好吧，那再给你 30 分钟，记得常眨眼哦～", "calm");
        break;
      case "tired-ack":
        this._snooze["tired-care"] = Date.now() + 45 * 60000;
        reply("乖～鲸鱼在旁边给你扇风～", "calm");
        break;
      case "dance-again":
        reply("看好了哦～～✨", "happy", { effect: "spin" });
        break;
      case "breath-ack":
        this._snooze["breath"] = Date.now() + 60 * 60000;
        break;
      case "chat":
        // 渲染层收到 effect:'chat' 会唤起提问对话框
        reply("来啦来啦，鲸鱼小脑袋已经开动了，你想说什么？", "calm", { effect: "chat" });
        break;
      case "meal":
        // 饭点提醒里点"🍚 记一笔" → 渲染层收到 effect:'meal' 会弹出打卡对话框
        reply("好嘞，吃了啥？记一笔～", "happy", { effect: "meal" });
        break;
      case "meal-later":
        // 当天不会再问（_checkMealReminder 里按 slot 记了"问过"），这句只是好好收场
        reply("好～想起来再记，鲸鱼不催 🐋", "calm");
        break;
      case "joke": {
        try {
          const content = await this.askLLM(
            this.textModel,
            "讲一个不超过30字的程序员/海洋主题冷笑话，只输出笑话本身，不要引号和其他解释。"
          );
          const joke = content.trim().split("\n")[0].slice(0, 80);
          reply(joke || "……鲸鱼突然忘词了，尴尬地喷了个水花💦", "happy", { effect: "wiggle" });
        } catch (err) {
          this.log(`joke failed: ${err.message}`);
          reply("鲸鱼讲笑话的脑回路卡住了💦 直接给你一个大大的拥抱吧！", "happy");
        }
        break;
      }
      case "dismiss":
        this._snooze["sad-support"] = Date.now() + 60 * 60000;
        reply("嗯嗯，鲸鱼就在这儿，随时找我游过来～", "calm");
        break;
      case "im-here":
        // 用户在锁屏预警里点"我在"→ 取消锁屏，并给 5 分钟免打扰
        this._cancelWarn();
        this._absentRun = 0;
        this._guardSnoozeUntil = Date.now() + 5 * 60000;
        reply("好嘞，那鲸鱼继续陪着你～不去看家了 🐋", "happy", { effect: "jump" });
        break;
    }
  }

  // ---- 设置与报告 -----------------------------------------------------------

  setEnabled(on) { this.enabled = !!on; }
  setIntervalMs(ms) {
    this.intervalMs = Math.max(20000, Math.min(3600000, ms));
  }

  /**
   * 情绪报告：今日记录与往天记录分开给，渲染层要分两块展示（不混在一起）
   *  - todayEvents：今天的波动（只有今天）
   *  - pastEvents：往天的波动，最新在前，最多 40 条
   */
  getReport() {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    // from === to 的旧记录是早期"只看 valence 跳变"留下的噪声，读取时一并过滤掉；
    // 发呆（kind:"gaze"）与吃饭（kind:"meal"）都没有 from/to，单独放行 —— 它们要出现在时间线里
    const changes = this.events.filter((e) => e.kind === "gaze" || e.kind === "meal" || e.from !== e.to);
    const today = changes.filter((e) => e.ts >= dayStart.getTime());
    const past = changes.filter((e) => e.ts < dayStart.getTime()).slice(-40).reverse();

    // 今日情绪分布：用按天持久化的统计（内存里只有最近 60 个样本，代表不了"今天"）
    let counts = this._behavior.emotionByDay[dayKey()] || null;
    let samples = this._behavior.sampleByDay[dayKey()] || 0;
    if (!counts) {
      // 兼容旧数据（那时还没按天统计）：退回用内存里今天的样本
      counts = {};
      for (const s of this.history) {
        if (s.noFace || s.ts < dayStart.getTime()) continue;
        counts[s.emotion] = (counts[s.emotion] || 0) + 1;
        samples += 1;
      }
    }
    return {
      current: this.current,
      enabled: this.enabled,
      intervalMinutes: Math.round(this.intervalMs / 60000),
      todayCount: today.length,
      todayEvents: today,
      pastEvents: past,
      todayCounts: counts,
      todaySamples: samples,
      historyLength: this.history.length,
      // emoji 来自声明（signals.js 的 report.emoji），界面直接用，不在渲染层写死
      yawn: { today: this.yawnToday(), total: this._behavior.yawnTotal, emoji: this._signalEmoji("yawn") },
      // 吃饭打卡（主人主动记的）：今日几顿、累计、今日明细（时间线里也会各占一行）
      meal: {
        today: this.mealsToday(),
        total: this._behavior.mealTotal,
        todayList: today.filter((e) => e.kind === "meal").map((e) => ({ ts: e.ts, slot: e.slot, what: e.what })),
      },
      // 听歌点评（可选功能，默认关）：今天几首、累计。渲染层只在"今天有数据"时才显示
      music: {
        today: this._behavior.musicByDay[dayKey()] || 0,
        total: this._behavior.musicTotal || 0,
      },
      // 小动作统计（摸下巴/托腮/伸懒腰）+ 演示学来的自定义动作（如「喝水」），今日与累计
      // 自定义动作只列"学过并且累计 > 0"的，免得没做过的动作在报告里占位
      actions: [
        ...BUILTIN_SIGNALS.filter((s) => !s.ownChannel).map((s) => ({
          name: s.label,
          emoji: this._signalEmoji(s.key),
          today: this.actionToday(s.label),
          total: this._behavior.actionTotal[s.label] || 0,
        })),
        ...this.actionDefs()
          .filter((d) => d.custom)
          .map((d) => ({
            name: d.label,
            emoji: this._signalEmoji(d.key), // 自定义动作没有专属表情（声明模板里是 null）
            custom: true,
            today: this.actionToday(d.label),
            total: this._behavior.actionTotal[d.label] || 0,
          }))
          .filter((a) => a.total > 0),
      ],
      // 当前生效的动作表 + 哈欠阈值（反馈/标定工具要照着它列"可反馈的识别项"）
      learned: {
        yawnMarMin: this._yawnMarMin(),
        custom: this.actionDefs().filter((d) => d.custom).map((d) => ({ key: d.key, label: d.label, gated: !!d.gate })),
      },
      owner: {
        enrolled: this.isEnrolled(),
        refCount: this.owner ? this.owner.refs.length : 0,
        guardEnabled: this.guardEnabled,
        guardActive: this.guardActive,
        present: this.guardActive ? false : this.current ? this.current.ownerPresent === true : null,
      },
    };
  }
}

// ---- 工具函数（模块级，主进程 PET_API 由 main.js 注入避免循环依赖）-----------

let _apiBase = "https://open.bigmodel.cn/api/paas/v4";
let _apiKey = "";
function PET_API_BASE() { return _apiBase; }
function PET_API_KEY() { return _apiKey; }

/** main.js 注入 API 配置 */
function configureEmotionApi(base, key) {
  if (base) _apiBase = base;
  if (key) _apiKey = key;
}

function label(emotion) { return EMOTION_LABELS[emotion] || emotion; }

/**
 * 本地日期键 YYYY-MM-DD。
 * 不能用 toISOString().slice(0,10)：那是 UTC 日期，在东八区会"早上 8 点才换日"，
 * 导致凌晨的心跳/哈欠被算到前一天。
 */
function dayKey(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 按时间推断餐次（主人不必自己选）：早 <10:30；午 10:30~15:00；晚 15:00~21:30；其余算加餐 */
function mealSlotOf(ts) {
  const d = new Date(ts || Date.now());
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins < 10 * 60 + 30) return "早餐";
  if (mins < 15 * 60) return "午餐";
  if (mins < 21 * 60 + 30) return "晚餐";
  return "加餐";
}

/**
 * 记完饭之后鲸鱼说的话。
 * **红线：只记录 / 陪伴 / 偶尔好奇，永不评判健康、热量、身材。**
 * 一旦变成"你怎么又吃泡面"，主人就不会再点这个按钮——功能就死了。
 */
function mealQuip(what, slot, todayCount, prevWhat) {
  if (prevWhat && prevWhat === what) return `又是${what}，真爱啊 🐋`;
  if (todayCount >= 3) return `${what}～今天第 ${todayCount} 顿了，胃口不错嘛 🐋`;
  const pool = [
    `${what}！鲸鱼也想游进去看看 🐋`,
    `记下啦：${slot}·${what} 🍚`,
    `${what} 闻着就香～`,
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 情绪 → 日常陪伴语（随机一条） */
const COMPANION = {
  happy: ["嘿嘿，看你笑得很开心，鲸鱼也想转个圈～", "今天心情不错呀，继续保持这个状态！"],
  calm: ["你看起来很平静，我就安静地陪在旁边吧～", "岁月静好，鲸鱼陪你一起发呆～"],
  focused: ["专注的时候也要记得眨眨眼哦～", "鲸鱼把水花收起来了，不打扰你专注～"],
  surprised: ["哇，发生什么了？鲸鱼很好奇！"],
  tired: ["看起来有点累了呢，要不要起来走走？", "你已经辛苦一阵子了，记得让眼睛休息一下～"],
  sad: ["怎么了？鲸鱼游过来陪你了……", "情绪有点低落？拍拍你，我一直在呢。"],
  stressed: ["深呼吸～鲸鱼帮你把烦恼喷成水花！", "别急别急，一步一步来，我在呢。"],
  angry: ["生气伤身哦，鲸鱼给你喷点冷静水雾～", "先消消气，有什么事慢慢说～"],
};

module.exports = { EmotionWatcher, configureEmotionApi, EMOTION_LABELS, label };
