// music.js —— 听歌点评：知道主人在听什么歌，听完给一句随口的点评
//
// 数据从哪来（方向 7 的三层降级，这里实现前两层）：
//   ① Windows 媒体控制中心（SMTC）—— 走 music-nowplaying.ps1 这个常驻子进程，
//      能拿到 歌名/歌手/专辑/播放状态/进度/总长（"这首放完了没"不用猜）
//   ② 拿不到就不点评（第三层"音频指纹/云音频模型"要装东西，这一版不做）
//
// 两条纪律（跟项目其他部分一致）：
//   1. **只依据拿到的事实说话**：模型只知道歌名/歌手/专辑/听了多久，
//      所以 prompt 里写死"不许编歌词/专辑背景/发行年份"，认不出就围绕"听了多久/换歌/循环"说
//   2. **只记元数据**：事件日志里只写歌名+歌手+时长（t:"music"），**不存音频**、不写歌词
//
// 关着开关时这个模块**一个子进程都不起**（零开销）；开着也只在换歌/放完时才有动作。

const { spawn } = require("child_process");
const https = require("https");
const path = require("path");
const EventLog = require("./eventlog");

const READER_PS1 = path.join(__dirname, "music-nowplaying.ps1").replace("app.asar", "app.asar.unpacked");
const MIN_PLAY_SEC = 20;      // 短于这个时长不点评（开场音效、误触、秒切都不值得说一句）
const SAME_SONG_COOLDOWN_MS = 30 * 60000; // 同一首歌（单曲循环）30 分钟内只评一次，别刷屏
const IDLE_TICKS_TO_FINISH = 2;  // 连续几个 tick 都看不到会话，才算"放完/关掉了"（一次抖动不算）
const END_TOLERANCE_SEC = 5;     // 距结尾 5 秒内换歌 → 算"听完了"，否则算"没听完"
const DURATION_TIMEOUT_MS = 5000; // 总长反查的超时：查不到就退回"总长未知"口径，不能吊着

class MusicWatcher {
  /**
   * @param {object} opts
   * @param {string} opts.logFile   事件日志文件（听歌记录写这里）
   * @param {()=>{enabled:boolean,pollMs:number}} opts.getConfig
   * @param {(model:string, prompt:string, maxTokens:number, timeoutMs:number)=>Promise<string>} opts.askLLM
   * @param {(model:string, usage:object)=>void} [opts.recordUsage]
   * @param {(text:string, meta:object)=>void} [opts.onComment] 点评好了 → 交给主进程弹气泡
   * @param {(meta:object)=>void} [opts.onRecord] 落了一笔听歌记录（主进程拿去更新情绪模块的内存镜像）
   * @param {(line:string)=>void} [opts.onLog]
   */
  constructor(opts = {}) {
    this.logFile = opts.logFile;
    this.getConfig = opts.getConfig || (() => ({ enabled: false, pollMs: 3000 }));
    this.askLLM = opts.askLLM || (async () => "");
    this.recordUsage = opts.recordUsage || (() => {});
    this.onComment = opts.onComment || (() => {});
    this.onRecord = opts.onRecord || null;
    this.onLog = opts.onLog || (() => {});

    this.child = null;         // PowerShell 读取器
    this.started = false;
    this.cur = null;           // 当前这首 {app,title,artist,album,pos,end,status,key}
    this.idleTicks = 0;
    this.recent = new Map();   // key → 上次点评时间（同曲冷却）
    this.spawnFails = 0;
    this.lastSnap = null;      // 最近一次读到的东西（设置页拿来显示"现在在放什么"）
    this.smtcActive = false;   // SMTC 最近一次快照有没有会话（有 → QQ音乐文字层让位）
    this.lastComment = null;
    this.durationCache = new Map(); // key → 总长秒数（公开接口反查成功才缓存，防同曲重复发请求）
    this._endInflight = new Set();  // 正在反查总长的 key（防重复发）
    // 可注入（探针用假实现）：QQ音乐公开搜索接口反查歌曲总长
    this.fetchDuration = opts.fetchDuration || null; // null = 用下面的默认实现（懒初始化避免顶层依赖）
    this.buf = "";
  }

  // ---- 生命周期 -------------------------------------------------------------

  /** 打开开关时调用：起读取器（已经起着就什么都不做） */
  start() {
    if (this.started) return;
    this.started = true;
    this.spawnFails = 0;
    this.log("听歌点评已开启");
    this._spawn();
  }

  /** 关掉开关/退出时调用 */
  stop() {
    if (!this.started && !this.child) return;
    this.started = false;
    this._kill();
    this.cur = null;
    this.idleTicks = 0;
    this.log("听歌点评已关闭（读取器已停，零开销）");
  }

  /** 配置变了（开关/节奏）：按需起停 */
  applyConfig() {
    const cfg = this.getConfig();
    if (cfg && cfg.enabled) {
      if (!this.started) this.start();
      else this._restartIfIntervalChanged(cfg.pollMs);
    } else {
      this.stop();
    }
    return this.status();
  }

  _kill() {
    if (this.child) {
      try { this.child.kill(); } catch {}
      this.child = null;
    }
    this.buf = "";
  }

  _spawn() {
    if (!this.started) return;
    const cfg = this.getConfig() || {};
    const interval = Math.min(30000, Math.max(1000, Number(cfg.pollMs) || 3000));
    this._interval = interval;
    let child = null;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", READER_PS1, "-IntervalMs", String(interval)],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      this._spawnFailed(err);
      return;
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const s = String(chunk).trim();
      if (s) this.log(`读取器 stderr：${s.slice(0, 200)}`);
    });
    child.on("error", (err) => this._spawnFailed(err));
    child.on("exit", (code) => {
      this.child = null;
      if (!this.started) return;
      // 读取器自己退了（异常/被杀）：退避重起，连挂几次就安静下来别刷日志
      if (this.spawnFails >= 3) {
        this.log("读取器反复起不来，暂时不再重试（开关关掉再打开可重试）");
        return;
      }
      const wait = 2000 * (this.spawnFails + 1);
      this.log(`读取器退出（code=${code}），${wait / 1000} 秒后重起`);
      setTimeout(() => { if (this.started) this._spawn(); }, wait);
    });
  }

  _spawnFailed(err) {
    this.spawnFails += 1;
    this.log(`起读取器失败（第 ${this.spawnFails} 次）：${err.message}`);
  }

  _restartIfIntervalChanged(pollMs) {
    const want = Number(pollMs) || 3000;
    if (this._interval === want) return;
    this.log(`节奏从 ${this._interval}ms 改为 ${want}ms，重启读取器`);
    this._kill();
    this._spawn();
  }

  /** stdout 是按行 JSON；粘包/断包都要能拼回来 */
  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let snap = null;
      try {
        snap = JSON.parse(line);
      } catch {
        continue; // PowerShell 偶尔会吐非 JSON 的行（警告等），丢掉就是了
      }
      this.handleSnapshot(snap);
    }
    if (this.buf.length > 65536) this.buf = ""; // 防护：极端情况下别把缓冲撑爆
  }

  // ---- 状态机（可被测：直接喂快照）------------------------------------------

  /**
   * 处理一次快照：判断"上一首是不是结束了/被切了"，是就点评。
   * @param {object} snap {ok, ts, sessions:[{app,status,title,artist,album,pos,end}]}
   * @param {string} [source] "smtc"（PowerShell 读取器，第一优先）| "qqm"（QQ音乐文字层，第二层）。
   *   SMTC 只要最近一次快照里有任何会话，qqm 的快照就整个忽略——避免同一首歌被两层各评一次。
   */
  handleSnapshot(snap, source) {
    source = source || "smtc";
    if (!snap || snap.ok === false) {
      if (snap && snap.err) this.log(`读取器报错（它会自己重试）：${String(snap.err).slice(0, 160)}`);
      return;
    }
    const sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
    if (source === "smtc") {
      // 只有"带歌名的会话"才算 SMTC 活着——空标题会话既用不上，也不该挡住 qqm 层
      this.smtcActive = sessions.some((s) => s && s.title);
    } else if (this.smtcActive) {
      return; // SMTC 活着，QQ音乐文字层让位
    }
    this.lastSnap = { at: Date.now(), sessions };
    // 优先"正在播放"；都在暂停就挑上次那家（避免在多个播放器之间乱跳）
    const playing = sessions.filter((s) => s.status === "Playing" && s.title);
    const same = this.cur ? sessions.find((s) => s.app === this.cur.app && s.title) : null;
    const now = playing[0] || same || null;

    if (!now) {
      // 一个会话都没有：可能是"放完自动关掉了/播放器退了"，连续几个 tick 才算数
      this.idleTicks += 1;
      if (this.cur && this.idleTicks >= IDLE_TICKS_TO_FINISH) {
        this._finish(this.cur, this._outcome(this.cur));
        this.cur = null;
      }
      return;
    }
    this.idleTicks = 0;

    const key = this._key(now);
    if (this.cur && key !== this.cur.key) {
      // 换歌了 → 上一首到此为止（放完还是切走，看进度）
      if (!this.cur.done) this._finish(this.cur, this._outcome(this.cur));
      this.cur = null;
    }
    if (!this.cur) {
      this.cur = { ...now, key, done: false };
      this.log(`在听：${now.title}${now.artist ? " - " + now.artist : ""}（${now.app}）`);
      this._lookupEnd(this.cur); // 没报总长的来源（QQ音乐文字层）异步反查，结算前能查回来
      return;
    }
    // 同一首：更新进度；播放器报 Stopped 说明这首完了（有些播放器不会自动换会话）
    this.cur.pos = now.pos;
    this.cur.end = now.end || this.cur.end; // 文字层快照 end 恒为 0，别把反查回来的总长冲掉
    this.cur.status = now.status;
    if (now.status === "Stopped" && !this.cur.done) {
      this.cur.done = true;
      this._finish(this.cur, this._outcome(this.cur));
    }
  }

  _key(s) {
    return `${s.app || ""}|${s.title || ""}|${s.artist || ""}`;
  }

  /**
   * 没报总长的歌（QQ音乐文字层 end=0）用公开搜索接口反查总长。
   * 异步、不阻塞状态机：查回来时这首歌还在放就补上，结算时"听完/没听完"就有据可判。
   * 失败/超时/查到的都对不上号 → 什么都不填，点评退回"总长未知"口径（unknownEnd）。
   */
  _lookupEnd(track) {
    if (Number(track.end) > 0 || !track.title) return;
    const cached = this.durationCache.get(track.key);
    if (cached > 0) {
      track.end = cached;
      return;
    }
    if (this._endInflight.has(track.key)) return;
    this._endInflight.add(track.key);
    const impl = this.fetchDuration || fetchSongDuration;
    Promise.resolve()
      .then(() => impl(track.title, track.artist, DURATION_TIMEOUT_MS))
      .then((sec) => {
        this._endInflight.delete(track.key);
        if (!(sec > 0)) return;
        if (this.durationCache.size > 200) this.durationCache.clear(); // 防护：别无限长
        this.durationCache.set(track.key, sec);
        if (this.cur && this.cur.key === track.key && !(Number(this.cur.end) > 0)) {
          this.cur.end = sec;
          this.log(`「${track.title}」总长 ${fmt(sec)}（公开接口反查）`);
        }
      })
      .catch((err) => {
        this._endInflight.delete(track.key);
        this.log(`「${track.title}」总长反查失败（点评退回"总长未知"口径）：${err.message}`);
      });
  }

  /** 放完还是没听完？看进度离结尾多远 */
  _outcome(t) {
    const end = Number(t.end) || 0;
    const pos = Number(t.pos) || 0;
    return end > 0 && pos >= end - END_TOLERANCE_SEC ? "ended" : "skipped";
  }

  // ---- 点评 -----------------------------------------------------------------

  _finish(track, outcome) {
    const playedSec = Math.max(0, Math.round(Number(track.pos) || 0));
    const totalSec = Math.max(0, Math.round(Number(track.end) || 0));
    const meta = {
      app: track.app || "",
      title: track.title || "",
      artist: track.artist || "",
      album: track.album || "",
      playedSec,
      totalSec,
      outcome,
      // 总长缺失（文字层 end=0 且反查没查到/没赶上）：听完/没听完无从判断，点评用"陪他听了 X 分钟"口径
      unknownEnd: !(totalSec > 0),
    };
    if (!meta.title) return;
    if (playedSec < MIN_PLAY_SEC) {
      this.log(`「${meta.title}」只放了 ${playedSec} 秒，不值当点评，跳过`);
      return;
    }
    const last = this.recent.get(track.key) || 0;
    if (Date.now() - last < SAME_SONG_COOLDOWN_MS) {
      this.log(`「${meta.title}」刚评过（${Math.round((Date.now() - last) / 60000)} 分钟前），跳过`);
      return;
    }
    this.recent.set(track.key, Date.now());
    this._record(meta);
    this._comment(meta).then((text) => {
      if (!text) return;
      this.lastComment = { at: Date.now(), text, meta };
      this.onComment(text, meta);
    });
  }

  /**
   * 设置页"听歌测试"：不真放歌，拿一首假歌走一遍"反查总长 → 算口径 → 点评"，
   * 验证点评链路是否通。全程不碰 this.cur（别弄乱你真在听的那首）、不写记录、不占同曲冷却。
   */
  async testRun() {
    const app = "QQ音乐";
    const title = "测试-桌宠自检";
    const artist = "测试歌手";
    // 独立 track，挂在状态机之外
    const track = { app, title, artist, album: "", pos: 25, end: 0, key: this._key({ app, title, artist }) };
    this._lookupEnd(track); // 走真实反查路径（查不到也只是退回 unknownEnd，不影响自检）
    await new Promise((r) => setTimeout(r, 20)); // 等反查微任务落地（能查回就补上总长）
    const meta = this._previewMeta(track); // 与 _finish 同口径，但不落盘、不记冷却
    const text = await this._comment(meta);
    this.log(`听歌测试：模拟「${title} - ${artist}」听了 ${meta.playedSec} 秒${meta.unknownEnd ? "（总长未知口径）" : ` / 全长 ${fmt(meta.totalSec)}`}`);
    return { ok: true, title, artist, playedSec: meta.playedSec, totalSec: meta.totalSec, unknownEnd: meta.unknownEnd, comment: text || "" };
  }

  /** 组装点评用的元数据（_finish 的只读版：不写记录、不记冷却） */
  _previewMeta(track) {
    const playedSec = Math.max(0, Math.round(Number(track.pos) || 0));
    const totalSec = Math.max(0, Math.round(Number(track.end) || 0));
    return {
      app: track.app || "", title: track.title || "", artist: track.artist || "", album: track.album || "",
      playedSec, totalSec, outcome: this._outcome(track), unknownEnd: !(totalSec > 0),
    };
  }

  /** 听歌记录：**只写元数据**，不存音频、不写歌词 */
  _record(meta) {
    try {
      EventLog.append(this.logFile, {
        t: "music",
        ts: Date.now(),
        app: meta.app,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        playedSec: meta.playedSec,
        totalSec: meta.totalSec,
        outcome: meta.outcome,
      });
      // 内存镜像跟上（重启后由 derive 重算，数字一致）；镜像坏了不能影响记录本身
      if (this.onRecord) {
        try { this.onRecord(meta); } catch {}
      }
    } catch (err) {
      this.log(`听歌记录落盘失败（不影响点评）：${err.message}`);
    }
  }

  _hint(meta) {
    const heard = meta.unknownEnd
      ? `听了 ${fmt(meta.playedSec)}（这个来源拿不到歌曲总长，有没有放完未知）`
      : meta.outcome === "ended"
        ? (meta.totalSec > 0 ? `听完了整首（${fmt(meta.playedSec)}）` : "听完了")
        : `没听完就切了（听了 ${fmt(meta.playedSec)}${meta.totalSec > 0 ? " / 全长 " + fmt(meta.totalSec) : ""}）`;
    return [
      `- 歌名：${meta.title}`,
      meta.artist ? `- 歌手：${meta.artist}` : "",
      meta.album ? `- 专辑：${meta.album} ` : "",
      `- 播放器：${meta.app || "未知"}`,
      `- 他怎么听的：${heard}`,
    ].filter(Boolean).join("\n");
  }

  /** 一句话点评（不认识这首歌也要能说，靠"怎么听的"这类事实兜底） */
  async _comment(meta) {
    const prompt =
      `主人刚才在电脑上听歌。请用**一句话**（不超过 20 字）像朋友那样随口说一句。\n\n` +
      `你**只知道**下面这些，别的你根本没听到：\n${this._hint(meta)}\n\n` +
      `硬性要求：\n` +
      `1. 不许编歌词、专辑背景、发行年份、获奖、乐评梗——你不知道就别提。\n` +
      `2. 不认得这首歌也别装认得；可以围绕"他听了多久/怎么听的"说（比如单曲循环式听法、才一分半就换台）。\n` +
      `3. 如果他是没听完就切了，这句话里要能看出来"没听完"（例如"这首没留住他，一分半就换台了"）。\n` +
      `4. 如果"怎么听的"里写了"有没有放完未知"，那就别断言听完还是没听完，围绕"陪他听了 X 分钟"这类事实说。\n` +
      `5. 只输出这一句话本身：不要引号、不要解释、不要 emoji、不要感叹号堆情绪。`;
    try {
      const text = await this.askLLM("", prompt, 400, 30000);
      return String(text || "").replace(/["'“”\n]/g, "").trim().slice(0, 40);
    } catch (err) {
      this.log(`点评生成失败（这次就不说了）：${err.message}`);
      return "";
    }
  }

  // ---- 状态（设置页拿来显示"到底读到没读到"）--------------------------------

  status() {
    const s = this.lastSnap ? this.lastSnap.sessions.find((x) => x.status === "Playing" && x.title) : null;
    return {
      enabled: !!(this.getConfig() || {}).enabled,
      running: !!this.child,
      nowPlaying: s ? { title: s.title, artist: s.artist || "", app: s.app || "" } : null,
      lastComment: this.lastComment ? { text: this.lastComment.text, at: this.lastComment.at } : null,
    };
  }

  log(line) {
    try {
      this.onLog(String(line));
    } catch {}
  }
}

/** 秒 → "1:30" 这种（点评 prompt 里给人看的时长） */
function fmt(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * QQ音乐公开搜索接口反查歌曲总长（秒）。普通网页接口：无 key、无登录，
 * 腾讯哪天改版/风控了就查不到 → 上层退回"总长未知"口径，不坏菜。
 */
function fetchSongDuration(title, artist, timeoutMs) {
  return new Promise((resolve, reject) => {
    const q = encodeURIComponent(`${String(title || "").trim()} ${String(artist || "").trim()}`.trim());
    const req = https.get(
      {
        host: "c.y.qq.com",
        path: `/soso/fcgi-bin/client_search_cp?w=${q}&format=json`,
        timeout: Math.max(1000, Number(timeoutMs) || DURATION_TIMEOUT_MS),
        headers: { Referer: "https://y.qq.com/", "User-Agent": "Mozilla/5.0 (dsh-pet)" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          if (buf.length > 512 * 1024) req.destroy(new Error("响应过大，丢弃"));
        });
        res.on("end", () => {
          try {
            const list = (((JSON.parse(buf) || {}).data || {}).song || {}).list || [];
            resolve(_pickDuration(list, title, artist));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("查询超时")));
    req.on("error", reject);
  });
}

/** 从搜索结果里挑总长：歌名完全一致才算（DJ 版/翻唱总长不一样，宁可不要） */
function _pickDuration(list, title, artist) {
  const norm = (s) => String(s || "").trim();
  const t = norm(title);
  let cands = (Array.isArray(list) ? list : []).filter((r) => norm(r && r.songname) === t);
  if (!cands.length) return 0;
  const a = norm(artist);
  if (a) {
    // 严格对号：接口的歌手数组里必须出现"整串"或逐个歌手名（按 / ; 分隔）。
    // 不用子串包含——"李荣浩/张惠妹"这种合并串会连 DJ 版/其他版本一起放进候选。
    const names = [a, ...a.split(/[/;、,，]/).map(norm).filter(Boolean)];
    const matched = cands.filter((r) =>
      (r.singer || []).some((s) => names.includes(norm(s && s.name))),
    );
    if (matched.length) cands = matched;
  }
  const sec = Math.round(Number(cands[0].interval) || 0);
  return sec > 0 ? sec : 0;
}

module.exports = { MusicWatcher, READER_PS1, MIN_PLAY_SEC, SAME_SONG_COOLDOWN_MS, fmt, _pickDuration };