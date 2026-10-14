// eventlog.js —— 事件日志（开发记录「方向 2」：日志是唯一真源，统计是它的派生视图）
//
// 为什么这么改：以前"事件时间线"和"行为统计"各存一份**结果**
// （emotion-events.json / emotion-behavior.json，每次全量重写）。想改一下计数语义就得重算，
// 而且真出过一次"顺手把统计清零"的事故。现在只追加、不改写、不删行：
//   写：任何"发生过什么"都往日志 append 一行 JSON（用 t 标明类型）
//   读：启动时读一遍日志 → 派生出报告要用的视图（今日/累计/时间线）
// 落盘只有一个出口，所以不存在"两处数字对不上"。旧的两个 JSON 文件保留不动（迁移时读一次）。
//
// 记录类型：
//   {t:"log-start", ts}                                    日志出生标记
//   {t:"import", ts, days}                                 从旧 JSON 一次性导入的"按天汇总"（旧文件保留不动）
//   {t:"hit", ts, key, label, own}                         一次信号命中（已按"段"判重）
//   {t:"sample", ts, emotion}                              一个情绪样本（今日分布用）
//   {t:"change", ts, from, to, delta, valenceFrom, valenceTo}  情绪显著变化（时间线）
//   {t:"reason", ts, targetTs, reason, comfort}            推测结果回填（追加，不去改旧行）
//   {t:"gaze", ts, startTs, minutes}                       一次发呆
//   {t:"segment", ts, key, from, to, sec, hits, endGapMs}  一段的起止（段长标定）
//   {t:"miss", ts, kind, label, reason, ms}                一次"没结论"（超时/放弃）——方向 3：悬挂态要留痕
//   {t:"meal", ts, slot, what, taste?}                     一顿饭（主人主动记的，不是识别出来的）
//   {t:"speech", ts, meeting, src, text, durMs}            旁听到的一句原话（src: remote=电脑里放的声音 / me=麦克风）
//   {t:"meeting", ts, id, title, startedAt, endedAt, durMs, lines, chars, file}  一场旁听的汇总（纪要文件路径）
//   {t:"meeting-rename", ts, id, title, file}              后来给这场会改了名（追加，不改旧行；派生时覆盖标题）
//   {t:"music", ts, app, title, artist, album, playedSec, totalSec, outcome}  听完/切掉一首歌（听歌点评，只记元数据）
//   {t:"fold", ts, days}                                   压缩：把要丢掉的旧记录按天汇总进 days
//
// 旁听相关两类记录的分工：`speech` 是**逐句原文**（只用来回看/检索，不进日常统计——
// 否则报告里会被会议内容淹没）；`meeting` 是**一场会议的汇总**（进按天统计与时间线）。
// `music` 同理只进**按天计数**、不进心情时间线（一天几十首会把别的记录淹掉）。
//
// 压缩（对应 dsh 的 compaction 思路）：日志涨到 MAX_BYTES 时，把最旧的一大段原始记录
// 折叠成一条 fold（只留按天汇总），保住"累计/按天"的数字不变，同时让文件不至于无限长。

const fs = require("fs");
const path = require("path");

const MAX_BYTES = 8 * 1024 * 1024; // 触发压缩的日志体积
const KEEP_RATIO = 0.4;            // 压缩后保留最新多少比例的原始记录

/** 每天一张汇总表：{yawn, actions:{名:次}, samples, emotions:{情绪:次}, meals, meetings, music} */
function emptyDays() {
  return {};
}
function bumpDay(days, day, fn) {
  const d = (days[day] = days[day] || { yawn: 0, actions: {}, samples: 0, emotions: {}, meals: 0, meetings: 0, music: 0 });
  fn(d);
}

/**
 * 把一批记录折叠成"按天汇总"（import / fold 用同一个形状）
 * @param {object[]} records
 * @param {(ts:number)=>string} dayKeyOf
 */
function foldToDays(records, dayKeyOf) {
  const days = emptyDays();
  const add = (day, { yawn = 0, actions = {}, samples = 0, emotions = {}, meals = 0, meetings = 0, music = 0 } = {}) => {
    bumpDay(days, day, (d) => {
      d.yawn += Number(yawn) || 0;
      for (const [k, v] of Object.entries(actions || {})) d.actions[k] = (d.actions[k] || 0) + (Number(v) || 0);
      d.samples += Number(samples) || 0;
      for (const [k, v] of Object.entries(emotions || {})) d.emotions[k] = (d.emotions[k] || 0) + (Number(v) || 0);
      d.meals += Number(meals) || 0;
      d.meetings += Number(meetings) || 0;
      d.music += Number(music) || 0;
    });
  };
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (r.t === "hit") {
      const day = dayKeyOf(r.ts);
      if (r.own) add(day, { yawn: 1 });
      else add(day, { actions: { [r.label || r.key || "未知"]: 1 } });
    } else if (r.t === "sample") {
      add(dayKeyOf(r.ts), { samples: 1, emotions: { [r.emotion || "none"]: 1 } });
    } else if (r.t === "meal") {
      add(dayKeyOf(r.ts), { meals: 1 });
    } else if (r.t === "meeting") {
      // 只有"一场会议"这个汇总进统计；逐句 speech 不进（一天几百句会把别的数字淹掉）
      add(dayKeyOf(r.ts), { meetings: 1 });
    } else if (r.t === "music") {
      // 听歌也只进按天计数、不进时间线（跟 speech 同理）
      add(dayKeyOf(r.ts), { music: 1 });
    } else if (r.t === "import" || r.t === "fold") {
      for (const [day, v] of Object.entries(r.days || {})) add(day, v);
      // 导入的旧事件/旧段记录也要继续算进时间线 → 由 derive 单独处理，这里只汇总计数
    }
  }
  return days;
}

/**
 * 派生出报告要用的视图：behavior（四张按天的表 + 两个总数）与 events（时间线，旧 shape 不变）
 * @param {object[]} records
 * @param {(ts:number)=>string} dayKeyOf
 */
function derive(records, dayKeyOf) {
  const behavior = {
    yawnTotal: 0,
    yawnByDay: {},
    actionTotal: {},
    actionByDay: {},
    sampleByDay: {},
    emotionByDay: {},
    mealTotal: 0,
    mealByDay: {},
    meetingTotal: 0,   // 旁听过多少场会（不含逐句原文）
    meetingByDay: {},
    musicTotal: 0,     // 听了几首歌（听歌点评的元数据记录，不含任何音频）
    musicByDay: {},
  };
  const events = [];
  const changeByTs = new Map();
  const meetingById = new Map(); // 会议改名要能找到那条 meeting 事件（追加的 rename 记录只管覆盖标题）

  const applyDays = (days) => {
    for (const [day, v] of Object.entries(days || {})) {
      behavior.yawnByDay[day] = (behavior.yawnByDay[day] || 0) + (Number(v.yawn) || 0);
      behavior.yawnTotal += Number(v.yawn) || 0;
      for (const [k, n] of Object.entries(v.actions || {})) {
        behavior.actionTotal[k] = (behavior.actionTotal[k] || 0) + (Number(n) || 0);
        const t = behavior.actionByDay[k] || (behavior.actionByDay[k] = {});
        t[day] = (t[day] || 0) + (Number(n) || 0);
      }
      behavior.sampleByDay[day] = (behavior.sampleByDay[day] || 0) + (Number(v.samples) || 0);
      const m = behavior.emotionByDay[day] || (behavior.emotionByDay[day] = {});
      for (const [k, n] of Object.entries(v.emotions || {})) m[k] = (m[k] || 0) + (Number(n) || 0);
      behavior.mealByDay[day] = (behavior.mealByDay[day] || 0) + (Number(v.meals) || 0);
      behavior.mealTotal += Number(v.meals) || 0;
      behavior.meetingByDay[day] = (behavior.meetingByDay[day] || 0) + (Number(v.meetings) || 0);
      behavior.meetingTotal += Number(v.meetings) || 0;
      behavior.musicByDay[day] = (behavior.musicByDay[day] || 0) + (Number(v.music) || 0);
      behavior.musicTotal += Number(v.music) || 0;
    }
  };

  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const day = dayKeyOf(r.ts || Date.now());
    switch (r.t) {
      case "import":
      case "fold":
        // 只处理"按天汇总"这一件事；具体的事件/段记录在导入时就被拆成了独立的一行行
        applyDays(r.days);
        break;
      case "hit":
        if (r.own) {
          behavior.yawnTotal += 1;
          behavior.yawnByDay[day] = (behavior.yawnByDay[day] || 0) + 1;
        } else {
          const label = r.label || r.key || "未知";
          behavior.actionTotal[label] = (behavior.actionTotal[label] || 0) + 1;
          const t = behavior.actionByDay[label] || (behavior.actionByDay[label] = {});
          t[day] = (t[day] || 0) + 1;
        }
        break;
      case "sample": {
        behavior.sampleByDay[day] = (behavior.sampleByDay[day] || 0) + 1;
        const m = behavior.emotionByDay[day] || (behavior.emotionByDay[day] = {});
        const k = r.emotion || "none";
        m[k] = (m[k] || 0) + 1;
        break;
      }
      case "change": {
        // 时间线条目的形状跟以前 emotion-events.json 里的条目保持一致（渲染层照着它画）。
        // 导入的历史条目自带 reason/comfort，新的变化条目先为空、稍后由 reason 记录回填。
        const e = {
          ts: r.ts,
          from: r.from,
          to: r.to,
          valenceFrom: r.valenceFrom,
          valenceTo: r.valenceTo,
          delta: r.delta,
          reason: r.reason || null,
          comfort: r.comfort || null,
        };
        events.push(e);
        changeByTs.set(r.ts, e);
        break;
      }
      case "reason": {
        // 推测结果是**追加**回来的：按 targetTs 找到那条变化补上原因
        const e = changeByTs.get(r.targetTs);
        if (e) {
          e.reason = r.reason || null;
          e.comfort = r.comfort || null;
        }
        break;
      }
      case "gaze":
        events.push({ kind: "gaze", ts: r.ts, startTs: r.startTs, minutes: r.minutes });
        break;
      case "meal":
        // 吃饭是主人主动记的，不是识别出来的 → 只进计数与时间线，不碰 signals 声明
        behavior.mealTotal += 1;
        behavior.mealByDay[day] = (behavior.mealByDay[day] || 0) + 1;
        events.push({ kind: "meal", ts: r.ts, slot: r.slot || "", what: r.what || "", taste: r.taste || null });
        break;
      case "meeting": {
        behavior.meetingTotal += 1;
        behavior.meetingByDay[day] = (behavior.meetingByDay[day] || 0) + 1;
        const me = {
          kind: "meeting",
          ts: r.ts,
          id: r.id || "",
          title: r.title || "",
          startedAt: r.startedAt || r.ts,
          endedAt: r.endedAt || r.ts,
          durMs: r.durMs || 0,
          lines: r.lines || 0,
          file: r.file || "",
        };
        events.push(me);
        if (me.id) meetingById.set(me.id, me);
        break;
      }
      case "meeting-rename": {
        // 后来改的名字：只覆盖时间线上那条会议事件的标题/文件名，历史行原样留着
        const me = meetingById.get(r.id);
        if (me) {
          if (r.title) me.title = r.title;
          if (r.file) me.file = r.file;
        }
        break;
      }
      case "speech":
        // 逐句原话只服务会议纪要/回看，不进日常统计也不进心情时间线（不然全是会议内容）
        break;
      case "music":
        // 听歌只进按天计数（上面 applyDays/行为初始化里那两个 music 字段），不进心情时间线——
        // 一天几十首会把情绪变化/发呆这些事淹掉。歌名等明细留在日志里，随时能查。
        behavior.musicTotal += 1;
        behavior.musicByDay[day] = (behavior.musicByDay[day] || 0) + 1;
        break;
      default:
        break;
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return { behavior, events };
}

/** 读日志（容忍最后一行是被强杀时截断的半行） */
function read(logFile) {
  try {
    if (!fs.existsSync(logFile)) return { records: [], exists: false };
    const lines = fs.readFileSync(logFile, "utf8").split("\n");
    const records = [];
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        records.push(JSON.parse(s));
      } catch {
        // 半行：丢掉就好（写日志是"先写内容再换行"，断电最多丢最后一条）
      }
    }
    return { records, exists: true };
  } catch {
    return { records: [], exists: false };
  }
}

/** 追加一条记录 */
function append(logFile, rec) {
  fs.appendFileSync(logFile, JSON.stringify(rec) + "\n");
}

/**
 * 把旧格式一次性导入（只在日志文件还不存在时调一次）。
 * **旧文件原地保留不动**——它们是最原始的凭据，也是我们"历史数值一个都不改"的保险。
 * @returns {object[]} 要写进新日志的记录（第一条必定是 log-start）
 */
function importLegacy(paths, dayKeyOf) {
  const records = [{ t: "log-start", ts: Date.now() }];
  const days = emptyDays();
  const add = (day, v) => {
    bumpDay(days, day, (d) => {
      d.yawn += Number(v.yawn) || 0;
      for (const [k, n] of Object.entries(v.actions || {})) d.actions[k] = (d.actions[k] || 0) + (Number(n) || 0);
      d.samples += Number(v.samples) || 0;
      for (const [k, n] of Object.entries(v.emotions || {})) d.emotions[k] = (d.emotions[k] || 0) + (Number(n) || 0);
    });
  };

  // 行为统计（按天）
  let behavior = null;
  try {
    if (fs.existsSync(paths.behaviorFile)) behavior = JSON.parse(fs.readFileSync(paths.behaviorFile, "utf8"));
  } catch {}
  if (behavior && typeof behavior === "object") {
    const daySet = new Set([
      ...Object.keys(behavior.yawnByDay || {}),
      ...Object.keys(behavior.sampleByDay || {}),
      ...Object.keys(behavior.emotionByDay || {}),
      ...Object.values(behavior.actionByDay || {}).flatMap((t) => Object.keys(t || {})),
    ]);
    for (const day of daySet) {
      const actions = {};
      for (const [name, table] of Object.entries(behavior.actionByDay || {})) {
        const n = Number((table || {})[day]) || 0;
        if (n) actions[name] = n;
      }
      add(day, {
        yawn: Number((behavior.yawnByDay || {})[day]) || 0,
        actions,
        samples: Number((behavior.sampleByDay || {})[day]) || 0,
        emotions: (behavior.emotionByDay || {})[day] || {},
      });
    }
  }

  // 事件时间线
  let events = [];
  try {
    if (fs.existsSync(paths.eventsFile)) events = JSON.parse(fs.readFileSync(paths.eventsFile, "utf8"));
  } catch {}
  if (!Array.isArray(events)) events = [];

  // 段日志（标定样本）
  let segments = [];
  try {
    if (fs.existsSync(paths.segmentsFile)) {
      for (const line of fs.readFileSync(paths.segmentsFile, "utf8").split("\n")) {
        const s = line.trim();
        if (s) segments.push(JSON.parse(s));
      }
    }
  } catch {}
  if (!Array.isArray(segments)) segments = [];

  records.push({
    t: "import",
    ts: Date.now(),
    days,
    note: "从 emotion-behavior.json 导入的按天汇总；原文件保留未动",
  });

  // 旧时间线与旧段记录**逐条拆成独立的一行**（日志里"一行就是一件事"，没有嵌套数组，
  // 以后分析/重算都只要按 t 过滤）
  for (const e of events) {
    if (!e || typeof e !== "object" || !e.ts) continue;
    if (e.kind === "gaze") {
      records.push({ t: "gaze", ts: e.ts, startTs: e.startTs, minutes: e.minutes });
    } else {
      records.push({
        t: "change",
        ts: e.ts,
        from: e.from,
        to: e.to,
        valenceFrom: e.valenceFrom,
        valenceTo: e.valenceTo,
        delta: e.delta,
        reason: e.reason || null,
        comfort: e.comfort || null,
      });
    }
  }
  for (const s of segments) {
    if (!s || typeof s !== "object" || !s.key) continue;
    records.push({
      t: "segment",
      ts: Number(s.to) || Date.now(),
      key: s.key,
      from: s.from,
      to: s.to,
      sec: s.sec,
      hits: s.hits,
      endGapMs: s.endGapMs,
    });
  }
  void dayKeyOf;
  return records;
}

/**
 * 日志太大就折一次：把最旧的原始记录汇总成一条 fold，保留最新 KEEP_RATIO 的原始记录。
 * 计数（累计/按天）完全不受影响，丢掉的只是"很久以前某一次具体命中"的明细。
 */
function compactIfNeeded(logFile, dayKeyOf) {
  try {
    if (!fs.existsSync(logFile) || fs.statSync(logFile).size <= MAX_BYTES) return false;
    const { records } = read(logFile);
    if (records.length < 100) return false;
    const keepFrom = Math.floor(records.length * (1 - KEEP_RATIO));
    const dropped = records.slice(0, keepFrom);
    const kept = records.slice(keepFrom);
    const days = foldToDays(dropped, dayKeyOf);
    // 被折叠掉的老事件也顺手收进 fold（时间线只保留最近的部分：报告本来也只显示最近 500 条）
    const fold = { t: "fold", ts: Date.now(), days, note: `折叠 ${dropped.length} 条旧记录` };
    const tmp = logFile + ".tmp";
    fs.writeFileSync(tmp, [fold, ...kept].map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.renameSync(tmp, logFile);
    return true;
  } catch {
    return false;
  }
}

module.exports = { read, append, derive, importLegacy, compactIfNeeded, foldToDays, MAX_BYTES };

/** 日志文件路径（放在 data/ 下，跟别的数据一起进版本库） */
module.exports.logFileIn = (dir) => path.join(dir, "events.jsonl");