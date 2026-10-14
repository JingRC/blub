// guard.js — 应用级看家锁屏（非系统锁屏）
//
// 两档节奏，键鼠只影响"快档还是慢档"，不再决定"探不探"（身份识别是本机人脸识别，不花钱）：
//   1) 慢档（键鼠在动 + 刚亲眼看主人在镜头里，ACTIVE_PROBE_MS 6s 一眼）：
//      人在镜头前还动着键鼠，基本就是本人，但绝不能停——主人一起身、换个人来摸电脑，
//      正是最该抓住的时刻。停探测等于把这段时间完全交给运气。
//   2) 快档（键鼠静下来达 idleGateS，或最近一眼没看到人，复检节奏 CONFIRM_PROBE_MS 3s 一眼）：
//      人可能刚走，按固定节拍盯着，抓住"人走"那一刻。正常的盯梢节拍是 probeIntervalMs；
//      只有"最近一眼没看到人"时才收紧到 3 秒复核——单帧漏检不算人不在，得连续几眼都空。
//   3) 锁定：连续 MISS_STRIKES 眼都看不到人，且确认不在累计达 lockAfterMs。
//      解锁：输入密码，或本机人脸识别到主人回来（锁定期切 2s 快节奏，回来一两秒就开门）。
//
// 局限（必须知情）：Electron 无法拦截 Alt+Tab / Win 键 / Ctrl+Alt+Del / 任务管理器，
// 因此这是"防顺手操作"的软锁，不是安全边界。真正禁止操作只能靠系统锁屏。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TICK_MS = 1000;
const DEFAULT_IDLE_GATE_S = 6; // 键鼠空闲多久 → 立刻识别一眼
const DEFAULT_LOCK_AFTER_MS = 5000; // 确认人不在后，持续多久就锁定
// 身份识别已经换成本机人脸识别（约 200ms 本地计算、不花钱、不 429），
// 节奏不必再为"省 API 调用"让步；但也没必要压到 3 秒一眼——
// 盯得太密只会在人脸偶尔没检出来时把人误锁在外面。
const PROBE_INTERVAL_MS = 10000; // 盯梢节奏：10 秒一眼
const ACTIVE_PROBE_MS = 6000; // 人在镜头前 + 键鼠在动时的慢档复核节奏（不能停，防换人）
const LOCK_PROBE_MS = 2000; // 锁定期识别节奏（等刷脸解锁，越短回来开门越快）
const DEFAULT_HARD_LOCK_MS = 300000; // 壁纸锁屏盖上后，多久没人解锁就追加系统锁屏兜底（5 分钟）
const DEFAULT_STRANGER_STRIKES = 2; // 连续几次认出"有人但不是主人"就直接锁（防单次误判把人锁外面）
const DEFAULT_OWNER_STRIKES = 2; // 刷脸解锁要连续认出来几次（防单次误判就把门打开）
// "人不在"要连续几眼都看不到人才算数（单帧漏检不算）：转头、一帧糊掉、杂物被误检
// 都会让一眼变成"没人"。实测两眼的旧规则在 2 分 40 秒里把主人误锁了 2 次。
const MISS_STRIKES = 3;
// 最近一眼没看到人 → 复检节奏收紧到这个值（本机识别不花钱）。
// 这样"连续 3 眼没人"只要 6 秒左右就能确认，真离开不会比旧规则慢。
const CONFIRM_PROBE_MS = 3000;
// 相似度贴着门槛（face.js 门槛 0.55）的"不是主人"更像主人自己侧脸/逆光——
// 实测主人本人的相似度就在 0.49~0.74 之间跳，按"别人"处理等于把自己锁在门外。
const AMBIGUOUS_SIM = 0.45;

class ScreenGuard {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir            配置与密码存放目录
   * @param {() => number} opts.getIdleSeconds  系统键鼠空闲秒数（main 注入 powerMonitor）
   * @param {() => boolean} opts.isEnrolled  是否已认主（未认主无法判定在场）
   * @param {(ms: number|null, probe: boolean) => void} opts.onCadence 调整抓帧/探测节奏
   * @param {() => void} [opts.onProbeNow]   键鼠刚静下来 → 立即抓一帧识别一次
   * @param {(info: object) => void} opts.onLock    需要弹锁定覆盖层
   * @param {(info: object) => void} opts.onUnlock  需要撤掉锁定覆盖层
   * @param {() => void} [opts.onHardLock]   壁纸锁屏超时未解锁 → 追加系统锁屏（硬锁兜底）
   * @param {(line: string) => void} [opts.onLog]
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir;
    this.getIdleSeconds = opts.getIdleSeconds || (() => 0);
    this.isEnrolled = opts.isEnrolled || (() => false);
    this.onCadence = opts.onCadence || (() => {});
    this.onProbeNow = opts.onProbeNow || (() => {});
    this.onLock = opts.onLock || (() => {});
    this.onUnlock = opts.onUnlock || (() => {});
    this.onHardLock = opts.onHardLock || (() => {});
    this.onLog = opts.onLog || (() => {});

    this.idleGateS = Number(opts.idleGateS) || DEFAULT_IDLE_GATE_S;
    this.lockAfterMs = Number(opts.lockAfterMs) || DEFAULT_LOCK_AFTER_MS;
    this.hardLockAfterMs = Number(opts.hardLockAfterMs) || DEFAULT_HARD_LOCK_MS;
    // 识别节奏固定 5 秒一眼：盯梢期不随结论、不随键鼠变速，要的就是"人刚走就被抓住"
    this.probeIntervalMs = Number(opts.probeIntervalMs) || PROBE_INTERVAL_MS;
    this.lockProbeMs = LOCK_PROBE_MS;
    // 认出"别人在用电脑"就直接锁——这是最该拦的情况，不看键鼠动没动
    this.lockOnStranger = opts.lockOnStranger !== false;
    this.strangerStrikes =
      Number(opts.strangerStrikes) || DEFAULT_STRANGER_STRIKES;
    // 解锁是安全边界：必须"专门的刷脸探测"连续认出来 ownerStrikes 次才开门。
    // 免费视觉模型会偶发地把参考照当答案说"是主人"，一次就开门等于锁了个寂寞。
    this.ownerStrikes = Number(opts.ownerStrikes) || DEFAULT_OWNER_STRIKES;
    // "连续几眼看不到人才算人不在"（单帧漏检不算）
    this.missStrikes = Number(opts.missStrikes) || MISS_STRIKES;

    this.enabled = false; // 应用级锁屏开关（需已设密码才可开）
    this.locked = false;
    this.mode = "idle"; // idle（不探测）| monitoring（监测中）
    this.absentSince = 0; // 连续不在的起点
    this._tickTimer = null;
    this._cadenceKey = null; // 已下发的节奏（去重，避免重复重置对方的节流计时）
    this._hardTimer = null; // 硬锁兜底倒计时
    this._hardLockAt = 0; // 硬锁触发时刻（0 = 未启用/未锁定）
    this.lockedAt = 0; // 本次锁定的开始时刻（解锁时用来算"看家护院了多久"）
    this._lastPresence = null; // 最近一次身份结论 {ownerPresent, noFace, at}
    this._noFaceRun = 0; // 连续多少次"画面里没有人"（遮挡/离开镜头）
    this._strangerRun = 0; // 连续多少次"有人但不是主人"
    this._sawOwnerAt = 0; // 最近一次"明确看到主人"的时间戳（0 = 没见过）
    this._ownerStrikes = 0; // 解锁用：连续几次刷脸认出主人
    this._salt = null;
    this._hash = null;

    this._load();
  }

  log(line) {
    this.onLog(`[guard] ${line}`);
  }

  /** 下发节奏（去重）：ms=null 表示停止探测，probe=true 表示切到便宜的在场探测 */
  _setCadence(ms, probe) {
    const key = `${ms}|${probe}`;
    if (this._cadenceKey === key) return;
    this._cadenceKey = key;
    this.onCadence(ms, probe);
  }

  // ---- 配置持久化（密码 + 开关）----------------------------------------------

  get configFile() {
    return path.join(this.dataDir, "lock.json");
  }

  _load() {
    try {
      if (fs.existsSync(this.configFile)) {
        const c = JSON.parse(fs.readFileSync(this.configFile, "utf8"));
        this._salt = typeof c.salt === "string" ? c.salt : null;
        this._hash = typeof c.hash === "string" ? c.hash : null;
        this.idleGateS = Number(c.idleGateS) || this.idleGateS;
        this.lockAfterMs = Number(c.lockAfterMs) || this.lockAfterMs;
        if (
          Number.isFinite(Number(c.probeIntervalMs)) &&
          Number(c.probeIntervalMs) >= 1500
        ) {
          this.probeIntervalMs = Number(c.probeIntervalMs);
        }
        if (typeof c.lockOnStranger === "boolean")
          this.lockOnStranger = c.lockOnStranger;
        // 0 也是合法值（表示关闭硬锁兜底），所以不能只用 || 兜底
        if (Number.isFinite(Number(c.hardLockAfterMs)))
          this.hardLockAfterMs = Number(c.hardLockAfterMs);
        this.enabled = c.enabled === true && this.hasPassword();
      }
    } catch (err) {
      this.log(`config load failed: ${err.message}`);
    }
  }

  _save() {
    try {
      fs.writeFileSync(
        this.configFile,
        JSON.stringify(
          {
            enabled: this.enabled,
            salt: this._salt,
            hash: this._hash,
            idleGateS: this.idleGateS,
            lockAfterMs: this.lockAfterMs,
            probeIntervalMs: this.probeIntervalMs,
            lockOnStranger: this.lockOnStranger,
            hardLockAfterMs: this.hardLockAfterMs,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      this.log(`config save failed: ${err.message}`);
    }
  }

  hasPassword() {
    return !!(this._salt && this._hash);
  }

  _digest(plain, salt) {
    return crypto.createHash("sha256").update(`${salt}:${plain}`).digest("hex");
  }

  /** 设置/修改密码（设完即启用应用锁屏） */
  setPassword(plain) {
    if (typeof plain !== "string" || plain.length < 4)
      return { ok: false, error: "密码至少 4 位" };
    this._salt = crypto.randomBytes(16).toString("hex");
    this._hash = this._digest(plain, this._salt);
    this.enabled = true;
    this._save();
    this.start();
    return { ok: true, ...this.status };
  }

  verifyPassword(plain) {
    if (!this.hasPassword() || typeof plain !== "string") return false;
    const got = Buffer.from(this._digest(plain, this._salt));
    const want = Buffer.from(this._hash);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  clearPassword() {
    this._salt = null;
    this._hash = null;
    this.enabled = false;
    this._save();
    if (this.locked) this.unlock("password-cleared");
    this.stop();
    return { ok: true, ...this.status };
  }

  setEnabled(on) {
    if (on && !this.hasPassword()) return { ok: false, error: "请先设置密码" };
    this.enabled = !!on;
    this._save();
    if (this.enabled) this.start();
    else {
      // 顺序要紧：先解锁再 stop。反过来 unlock() 会把自己重新拉回 monitoring
      // 并下发探测节奏，结果"关掉了锁屏却还在每 3 秒抓一次脸"。
      if (this.locked) this.unlock("disabled");
      this.stop();
    }
    return { ok: true, ...this.status };
  }

  /** 调整触发参数（空闲阈值秒 / 持续不在秒 / 识别节奏秒 / 硬锁兜底分钟数，0 = 关闭） */
  configure(cfg = {}) {
    const gate = Number(cfg.idleGateS);
    const after = Number(cfg.lockAfterS);
    if (gate >= 2 && gate <= 300) this.idleGateS = Math.round(gate);
    // 下限放到 2 秒：本地人脸识别不花钱，人一走就能锁（默认 3 秒）
    if (after >= 2 && after <= 600) this.lockAfterMs = Math.round(after) * 1000;
    const probe = Number(cfg.probeIntervalS);
    if (probe >= 2 && probe <= 120) {
      this.probeIntervalMs = Math.round(probe) * 1000;
      // 节奏变了要重新下发（否则去重点会拦住），监测中立即按新节奏跑
      if (this.mode === "monitoring") {
        this._cadenceKey = null;
        this._setCadence(this.probeIntervalMs, true);
      }
    }
    if (typeof cfg.lockOnStranger === "boolean")
      this.lockOnStranger = cfg.lockOnStranger;
    if (cfg.hardLockAfterS !== undefined) {
      const hard = Number(cfg.hardLockAfterS);
      if (hard === 0) {
        this.hardLockAfterMs = 0;
      } else if (hard >= 60 && hard <= 3600)
        this.hardLockAfterMs = Math.round(hard) * 1000;
      // 锁定中改设置 → 立即按新值重新计时
      if (this.locked) this._armHardLock();
    }
    this._save();
    return this.status;
  }

  get status() {
    return {
      enabled: this.enabled,
      hasPassword: this.hasPassword(),
      locked: this.locked,
      mode: this.mode,
      idleGateS: this.idleGateS,
      lockAfterS: Math.round(this.lockAfterMs / 1000),
      probeIntervalS: Math.round(this.probeIntervalMs / 1000),
      lockOnStranger: this.lockOnStranger,
      hardLockAfterS: Math.round(this.hardLockAfterMs / 1000),
      hardLockAt: this.locked ? this._hardLockAt : 0,
    };
  }

  /**
   * 硬锁兜底倒计时：壁纸锁屏盖上后，若 N 分钟内没人来解锁（刷脸/密码都没人），
   * 就追加调用系统锁屏。软锁负责挡顺手操作和护隐私，硬锁负责真拦住。
   */
  _armHardLock() {
    this._clearHardLock();
    if (!this.hardLockAfterMs) return;
    const minutes = Math.round(this.hardLockAfterMs / 60000);
    this._hardLockAt = Date.now() + this.hardLockAfterMs;
    this._hardTimer = setTimeout(() => {
      this._hardTimer = null;
      if (!this.locked) return; // 期间已经解锁了
      this.log(
        `locked ${minutes}min with nobody unlocking -> hard lock (system lock)`,
      );
      this.onHardLock();
    }, this.hardLockAfterMs);
    this.log(`hard lock armed: ${minutes} 分钟内没人解锁 -> 系统锁屏兜底`);
  }

  _clearHardLock() {
    if (this._hardTimer) {
      clearTimeout(this._hardTimer);
      this._hardTimer = null;
    }
    this._hardLockAt = 0;
  }

  // ---- 空闲轮询 --------------------------------------------------------------

  start() {
    if (!this.enabled) return;
    // 锁着的时候被 stop() 过（Windows 锁屏 → 解锁走一圈）→ 必须把锁定期的刷脸节奏补回来。
    // _onTick 在 locked 时直接 return，不会自己重新下发节奏；漏了这一步，覆盖层还挂着
    // 却永远不会再认人，界面上那句"回到镜头前会自动解锁"就成了谎话，只能输密码。
    if (this.locked) {
      this._cadenceKey = null; // 先去重键位，否则这次下发会被 _setCadence 拦掉
      this._setCadence(this.lockProbeMs, true);
    }
    if (this._tickTimer) return;
    this._tickTimer = setInterval(() => this._onTick(), TICK_MS);
    this.log(
      `started (idleGate=${this.idleGateS}s, lockAfter=${Math.round(this.lockAfterMs / 1000)}s)`,
    );
  }

  stop() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    this._clearHardLock();
    this.mode = "idle";
    this.absentSince = 0;
    this._setCadence(null, false);
  }

  _onTick() {
    if (!this.enabled || this.locked) return;
    if (!this.isEnrolled()) return; // 未认主无法判定，不锁
    const idle = Number(this.getIdleSeconds()) || 0;

    // 键鼠在动 + 刚亲眼看主人在镜头里 → 不用 5 秒一眼死盯，但绝不能停：
    // 主人一起身、换个人来摸电脑，正是最该抓住的时刻，这里保留每 10 秒一次的慢档复核。
    if (
      idle < this.idleGateS &&
      !this._blindNow() &&
      this._seenWithin(ACTIVE_PROBE_MS + this.probeIntervalMs)
    ) {
      if (this.mode !== "monitoring") {
        this.mode = "monitoring";
        this.log("owner seen + input active -> slow watch (every 10s)");
      }
      this.absentSince = 0;
      this._setCadence(ACTIVE_PROBE_MS, true);
      return;
    }

    // 快档：键鼠静下来，或最近两眼都没看到主人 → 一眼一眼盯着，抓住"人走"那一刻。
    // 这里不重置 absentSince——缺席正在累计时跑的正是这一步，重置就永远锁不上了。
    const entering = this.mode !== "monitoring";
    // 最近一眼没看到人（可能就是走开了）→ 复检节奏收紧到 3 秒。
    // 单帧漏检不再直接算"人不在"，得连续几眼都空；节奏不收紧的话这几眼要等三个 10 秒。
    const target =
      this._noFaceRun > 0 ? CONFIRM_PROBE_MS : this.probeIntervalMs;
    const wasSlow = this._cadenceKey !== `${target}|true`;
    if (entering) {
      this.mode = "monitoring";
      if (idle >= this.idleGateS) {
        // 键鼠刚静下来 → 立刻照一眼，看人还在不在
        this.log(
          `idle ${idle}s >= ${this.idleGateS}s -> probe now, then every ${Math.round(this.probeIntervalMs / 1000)}s`,
        );
      } else {
        // 键鼠虽然在动，但最近一直没看到主人（被遮住/人走了/换了人）→ 立刻复核并继续盯
        this.log("input active but owner not seen -> keep watching");
      }
    } else if (wasSlow) {
      this.log(
        `owner stops moving or leaves frame -> fast watch (every ${Math.round(target / 1000)}s)`,
      );
    }
    this._setCadence(target, true);
    if (entering || wasSlow) this.onProbeNow(); // 刚切进快档 → 立刻照一眼，不等下一个节拍
  }

  /** 最近 ms 毫秒内是否明确看到过主人 */
  _seenWithin(ms) {
    return this._sawOwnerAt > 0 && Date.now() - this._sawOwnerAt <= ms;
  }

  /**
   * 最近一眼是不是"没看到人脸"（镜头被遮挡、人离开镜头范围）。
   * 只要最近一眼没人就算数：本地人脸识别很稳（实测连续 10 次判定一致），
   * 而"切到快档 + 立刻补一眼"是更谨慎的方向，等第二次反而白白慢一拍。
   * 结论太旧（超过一个慢档节拍 + 一个快档节拍）视为未知，不拿过时判断锁人。
   */
  _blindNow() {
    if (!this._lastPresence || this._noFaceRun < 1) return false;
    return (
      Date.now() - this._lastPresence.at <=
      ACTIVE_PROBE_MS + this.probeIntervalMs
    );
  }

  // ---- 摄像头在场结论 --------------------------------------------------------

  /** emotion 模块每次给出身份结论都会调这里 */
  handlePresence(p) {
    if (!p || !this.enabled) return;
    const present = p.ownerPresent === true;
    const noFace = p.noFace === true;
    // 画面里确实有人、但不是主人。相似度贴着门槛的票不算"别人"——
    // 主人自己侧脸/逆光实测就是 0.49，按"别人"走"两次立即锁"会把自己锁在门外。
    const stranger =
      !present && !noFace && (Number(p.similarity) || 0) < AMBIGUOUS_SIM;
    // 记下最近一眼看到什么：镜头被遮住（noFace）时，即使键鼠在动也不能当"人在"
    this._lastPresence = { ownerPresent: present, noFace, at: Date.now() };
    this._noFaceRun = noFace ? this._noFaceRun + 1 : 0;
    this._strangerRun = stranger ? this._strangerRun + 1 : 0;
    if (present) this._sawOwnerAt = Date.now(); // 记下"亲眼看主人在"的时刻

    if (this.locked) {
      // 锁定期：只等主人回来刷脸。
      // 开门条件收紧两层：① 只认专门的刷脸探测（常规情绪分析不算）；
      // ② 要连续 ownerStrikes 次都认出主人——单次误判不解锁。
      if (!present) {
        this._ownerStrikes = 0;
        return;
      }
      if (p.source !== "probe") return;
      // 开门只认本机人脸识别。云端免费视觉模型会把参考照当答案点头——实测"画面里明明没人"
      // 它也回 ownerPresent=true、similarity=1，拿它开门等于没锁；更糟的是"看家满 3 分钟
      // 就播'终于等到主人啦'"的告别动画会跟着变成笑话：人都没回来，屏幕自己开了还撒星星。
      if (!p.local) {
        this._ownerStrikes = 0;
        return;
      }
      this._ownerStrikes += 1;
      if (this._ownerStrikes >= this.ownerStrikes) {
        this.log(`face confirmed ${this._ownerStrikes}x -> unlock`);
        this.unlock("face");
      } else {
        this.log(
          `face ${this._ownerStrikes}/${this.ownerStrikes} -> 再确认一次`,
        );
      }
      return;
    }

    // 认出"别人在用电脑"（画面里有人但不是主人）→ 直接锁，不管键鼠在不在动。
    // 别人的手正放在键盘上，就是他本人被拦住也认不出密码，最该拦的正是这一刻。
    if (this.lockOnStranger && stranger) {
      if (this._strangerRun >= this.strangerStrikes) {
        this.log(
          `stranger at the computer (${this._strangerRun} strikes) -> LOCK now`,
        );
        this.lock("stranger");
        return;
      }
      // 第一次看到"别人"：立刻转入盯梢（键鼠在动也盯），马上复核一眼
      if (this.mode === "idle") {
        this.mode = "monitoring";
        this._setCadence(this.probeIntervalMs, true);
        this.onProbeNow();
        this.log("stranger suspected -> watch closely");
      }
      return;
    }

    // 最近一眼画面里没人（镜头被遮挡 / 人离开镜头范围）：键鼠在动也转入盯梢，
    // 不能因为鼠标还在动就当成"人在"。这里主动推进，不等下一秒轮询。
    if (this.mode === "idle" && this._blindNow()) {
      this.mode = "monitoring";
      this._setCadence(CONFIRM_PROBE_MS, true); // 疑似离开 → 立刻收紧复检节奏
      this.onProbeNow();
      this.log("blind (no face) -> watch closely");
    }

    if (this.mode !== "monitoring") return;

    if (present) {
      // 人还在 → 清空缺席计时。节奏由 _onTick 下一拍放回盯梢档
      this.absentSince = 0;
      return;
    }
    const now = Date.now();
    if (!this.absentSince) {
      this.absentSince = now;
      this.log("absent -> counting");
    }
    // 单帧漏检不算"人不在"：要连续 missStrikes 眼都没看到人，且累计时长够。
    // 中间任一眼认出主人，_noFaceRun 归零、计时清零，从头再来。
    if (
      this._noFaceRun >= this.missStrikes &&
      now - this.absentSince >= this.lockAfterMs
    ) {
      this.lock("absent");
    }
  }

  // ---- 锁定 / 解锁 -----------------------------------------------------------

  lock(reason) {
    if (this.locked || !this.hasPassword()) return;
    this.locked = true;
    this.lockedAt = Date.now();
    this.absentSince = 0;
    this._ownerStrikes = 0; // 每次上锁都从零开始数"连续认出主人"的次数
    this._setCadence(this.lockProbeMs, true); // 锁定期切快节奏，等刷脸
    this._armHardLock(); // 起硬锁兜底倒计时
    this.log(`LOCK (${reason || "manual"})`);
    this.onLock({ reason: reason || "manual", at: Date.now() });
  }

  unlock(reason) {
    if (!this.locked) return;
    this.locked = false;
    this.absentSince = 0;
    // 解锁后重新开始判断"看没看到主人"：否则刚解锁就拿着锁定前的"没看到"结论又把人锁回去
    this._lastPresence = null;
    this._noFaceRun = 0;
    this._strangerRun = 0;
    this._sawOwnerAt = 0;
    this._ownerStrikes = 0; // 开门后清空"连续认出主人"的计数
    this._clearHardLock(); // 有人解锁了，取消兜底
    this.mode = "monitoring";
    this._setCadence(this.probeIntervalMs, true); // 刚解锁用快档复核一下
    const guardMs = this.lockedAt ? Date.now() - this.lockedAt : 0; // 这次看了多久家
    this.lockedAt = 0;
    this.log(`UNLOCK (${reason})`);
    this.onUnlock({ reason, at: Date.now(), guardMs });
  }

  /** 锁定界面提交密码 */
  tryPassword(plain) {
    if (!this.locked) return { ok: true };
    if (this.verifyPassword(plain)) {
      this.unlock("password");
      return { ok: true };
    }
    this.log("password rejected");
    return { ok: false, error: "密码不对，再试一次" };
  }
}

module.exports = { ScreenGuard };
