// renderer/meeting.js —— 会议旁听（渲染层）：负责"听"，把声音切成一句一句送去转写
//
// 为什么在本机先切句（而不是整段录音上云）：
//   1. 静音不上云 —— 一场一小时会真正有人说话的时间往往只有二三十分钟
//   2. 单段 ≤30 秒是 ASR 的硬限制，反正得切；这里顺手把"人的停顿"当切点，比按固定时长切更自然
//   3. 转写延迟低（一段说完一两秒就出字幕），会议开完不用等
//
// 两条轨：
//   remote = 系统声环回（Electron 的 getDisplayMedia + loopback，拿到的是"电脑在播的声音"）
//            → 会议里其他人的发言；戴耳机也照样能录到
//   me     = 麦克风 → 我自己的发言（会议软件不会把自己的声音回放给自己，所以必须单独抓）
//   分开录的好处：纪要里天然能分清"我 / 对方"，不用做声纹分离
//
// 时间戳一律按**样本数**换算（不靠 Date.now 抖），保证时间轴与音频严格对齐。

(function () {
  const TARGET_RATE = 16000; // ASR 要 16k
  const FRAME = 512;         // VAD 判定粒度：32ms @16k
  const FRAME_MS = (FRAME / TARGET_RATE) * 1000;
  const SPEECH_ON_FRAMES = 3;    // 连续 3 帧够响才算"开口"（挡住敲键盘那种单帧毛刺）
  const HANG_FRAMES = Math.round(800 / FRAME_MS);  // 静音 800ms ≈ 一句话说完
  const PREROLL_FRAMES = 2;      // 前导：留 64ms，别把第一个字的辅音切掉
  const MIN_SPEECH_MS = 400;     // 短于 400ms 的当噪音（咳嗽、鼠标声）丢掉
  const MAX_CHUNK_MS = 20000;    // 单段上限（ASR 硬限 30 秒，留余量）
  const MIN_RMS = 0.006;         // 绝对静音下限（安静房间底噪约 0.002~0.005）
  const NOISE_MULT = 3.0;        // 判定阈值 = 自适应底噪 × 这个倍数

  let ctx = null;
  let tracks = [];      // 每路音轨的处理管线
  let active = false;
  let starting = false;
  let barEl = null;
  let barTextEl = null;
  let barMetaEl = null;
  let barTimer = null;
  let startedAt = 0;
  let lastLineAt = 0;
  let paused = false;        // 会中休息：音频轨已经停了，但这场会还在（不出纪要）
  let firstStartedAt = 0;    // 这一场第一次开始的时间（时间轴原点，跟主进程的 startedAt 对齐）
  let runStartedAt = 0;      // 当前这段采集是什么时候开始的（暂停时置 0）
  let activeBaseMs = 0;      // 之前几段一共实际录了多久

  // ---- 小工具 ---------------------------------------------------------------

  const frameMsOf = (samples) => (samples / TARGET_RATE) * 1000;

  /**
   * 计时一律按"实际录了多久"算——休息（暂停）那段不计。
   * 这样字幕条上的计时、主进程的纪要时长、以及时间轴上的【mm:ss】三者是一致的：
   * 暂停 30 分钟回来，时间轴是接着往下排的，不会突然跳一大截。
   */
  const elapsedMs = () => activeBaseMs + (runStartedAt ? Date.now() - runStartedAt : 0);

  /** 16k 单声道 Float32 → WAV（PCM16）：所有 ASR 都认这个格式，不需要 ffmpeg */
  function encodeWav(samples) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF");
    v.setUint32(4, 36 + n * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);           // PCM
    v.setUint16(22, 1, true);           // 单声道
    v.setUint32(24, TARGET_RATE, true);
    v.setUint32(28, TARGET_RATE * 2, true); // byteRate
    v.setUint16(32, 2, true);           // blockAlign
    v.setUint16(34, 16, true);          // 位深
    str(36, "data");
    v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  /** 线性插值降采样（保留跨块的相位，避免每块接缝处出现咔哒声） */
  function makeResampler(inRate) {
    const ratio = inRate / TARGET_RATE;
    let pos = 0;
    return function (input) {
      const out = [];
      while (pos < input.length) {
        const i = Math.floor(pos);
        const frac = pos - i;
        const a = input[i];
        const b = i + 1 < input.length ? input[i + 1] : a;
        out.push(a + (b - a) * frac);
        pos += ratio;
      }
      pos -= input.length;
      return Float32Array.from(out);
    };
  }

  /**
   * 一句话切分器（每路音轨一个）：
   *   静音态：慢慢跟出房间底噪 → 阈值 = max(下限, 底噪×3)；连续够响就"开口"
   *   说话态：攒帧；静音够久 或 攒够 20 秒 → 切一段送去转写
   * 阈值自适应是必须的：同一台机器，开空调和半夜的底噪能差好几倍，写死阈值必翻车。
   */
  function makeSegmenter(track) {
    let mode = "silence";
    let speechRun = 0;
    let hang = 0;
    let noiseFloor = 0.004;
    let seg = [];
    let segStartSample = 0;
    let pre = [];

    function threshold() {
      return Math.max(MIN_RMS, noiseFloor * NOISE_MULT);
    }

    function flush(forced) {
      if (mode !== "speech") return;
      const total = seg.length * FRAME;
      const speechSamples = Math.max(0, total - (forced ? 0 : hang * FRAME));
      const t0 = track.originWall + frameMsOf(segStartSample);
      const t1 = t0 + frameMsOf(total);
      const out = seg;
      seg = [];
      pre = [];
      hang = 0;
      speechRun = 0;
      if (forced) {
        // 一口气说太久被强制切开：不退回静音态，下一帧接着攒，接缝处不丢音频
        segStartSample += total;
      } else {
        mode = "silence";
      }
      if (speechSamples < MIN_SPEECH_MS / FRAME_MS * FRAME) return; // 太短，当噪音丢掉
      let len = 0;
      for (const f of out) len += f.length;
      const all = new Float32Array(len);
      let off = 0;
      for (const f of out) { all.set(f, off); off += f.length; }
      try {
        window.dshPet.meetingChunk({ source: track.source, t0, t1, wav: encodeWav(all) });
      } catch (err) {
        console.warn("[meeting] 送音频失败:", err && err.message);
      }
    }

    function pushFrame(frame, startSample) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      if (mode === "silence") {
        noiseFloor = noiseFloor * 0.95 + rms * 0.05; // 只在静音时跟底噪，说话时不污染
        speechRun = rms > threshold() ? speechRun + 1 : 0;
        pre.push(frame);
        if (pre.length > PREROLL_FRAMES) pre.shift();
        if (speechRun >= SPEECH_ON_FRAMES) {
          mode = "speech";
          hang = 0;
          seg = pre.slice();                                    // 连前导一起带上
          segStartSample = startSample - (seg.length - 1) * FRAME;
          pre = [];
        }
        return;
      }
      seg.push(frame);
      hang = rms > threshold() ? 0 : hang + 1;
      const ms = frameMsOf(seg.length * FRAME);
      if (hang >= HANG_FRAMES) flush(false);
      else if (ms >= MAX_CHUNK_MS) flush(true);
    }

    // 主人点"结束"时要立刻把正在攒的这句交出去——**不能**靠"喂静音帧"来逼：
    // 切句要连续 HANG_FRAMES(≈800ms) 帧静音才吐，喂一帧根本不够，最后一句会整段丢掉。
    return { pushFrame, flushNow: () => flush(false) };
  }

  // ---- 采集 -----------------------------------------------------------------

  /** 系统声环回：主进程已经把 display media 处理器设成"主屏 + loopback 音频" */
  async function getLoopbackStream() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    // 只要声音：视频轨立刻停掉（不停掉会白白编码一路画面）
    for (const t of stream.getVideoTracks()) {
      t.stop();
      stream.removeTrack(t);
    }
    if (!stream.getAudioTracks().length) throw new Error("没拿到系统声音轨（这台机器/这个版本可能不支持环回录音）");
    return stream;
  }

  async function getMicStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        // 开会时我们要的是"我说话的原声"：回声消除/降噪会把小声说话吃掉，关掉
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });
  }

  /**
   * 给一路 stream 搭好"降采样 → 切句 → 送转写"的管线。
   * @param {number} originWall 这一轨的时间原点（墙上时间）：正常开始就是"这一场开始那一刻"，
   *   暂停后继续要传"开始时刻 + 已经录过的时长"——这样恢复后的【mm:ss】是接着休息前往下走的。
   */
  function attachTrack(source, stream, originWall) {
    const srcNode = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1); // 4096 帧 ≈ 85ms 一次回调
    const resample = makeResampler(ctx.sampleRate);
    const track = {
      source,
      stream,
      srcNode,
      proc,
      resample,
      acc: new Float32Array(0),
      cursor: 0,                       // 已处理的样本数（16k）
      originWall: originWall || Date.now(), // 这一轨的时间原点（见函数头注释）
      seg: null,
    };
    track.seg = makeSegmenter(track);

    proc.onaudioprocess = (e) => {
      const inBuf = e.inputBuffer;
      const ch = inBuf.numberOfChannels;
      let mono = inBuf.getChannelData(0);
      if (ch > 1) {
        const b = inBuf.getChannelData(1);
        const mix = new Float32Array(mono.length);
        for (let i = 0; i < mono.length; i++) mix[i] = (mono[i] + b[i]) / 2;
        mono = mix;
      }
      const ds = resample(mono);
      // 把降采样后的样本接起来，按 512 一帧喂给切分器
      const merged = new Float32Array(track.acc.length + ds.length);
      merged.set(track.acc, 0);
      merged.set(ds, track.acc.length);
      let off = 0;
      while (merged.length - off >= FRAME) {
        const frame = merged.subarray(off, off + FRAME);
        track.seg.pushFrame(frame, track.cursor);
        track.cursor += FRAME;
        off += FRAME;
      }
      track.acc = merged.subarray(off);
    };
    srcNode.connect(proc);
    proc.connect(ctx.destination); // ScriptProcessor 必须接到 destination 才会持续触发
    tracks.push(track);
  }

  // ---- 界面（鲸鱼下面的实时字幕条）------------------------------------------

  function ensureBar() {
    if (barEl) return;
    barEl = document.getElementById("meetingBar");
    barTextEl = document.getElementById("meetingBarText");
    barMetaEl = document.getElementById("meetingBarMeta");
  }

  /**
   * "旁听"那个泡泡跟着状态变：没在听 = 🎧 旁听；正在听 = ⏹ 结束。
   * 为什么要变：这个按钮是"开始/结束"一体的，只写死"旁听"的话，主人正在录的时候
   * 根本看不出再点一下会发生什么（跟托盘"状态+动作"那条约定一致）。
   */
  function renderMeetBubble(active, lines) {
    const icon = document.getElementById("meetBubbleIcon");
    const label = document.getElementById("meetBubbleLabel");
    if (icon) icon.textContent = active ? "⏹" : "🎧";
    if (label) label.textContent = active ? "结束" : "旁听";
    const item = icon && icon.closest ? icon.closest(".bubble-item") : null;
    if (item) {
      item.title = !active
        ? "开始旁听这场会（只在有人说话时上传转写，结束后自动出纪要）"
        : paused
          ? `已暂停（已记 ${lines || 0} 句）——点这里是**结束**并出纪要，想接着听请点 ▶️ 继续`
          : `正在旁听（已记 ${lines || 0} 句）——点一下结束，我会顺手把纪要写出来`;
    }
  }

  /**
   * "暂停 / 继续"那个泡泡：**只在旁听时才出现**（没在听时它没意义，藏着不占位置）。
   * 状态跟托盘、跟 🎧 那个泡泡一样按"状态+动作"写：⏸ 暂停 / ▶️ 继续。
   */
  function renderPauseBubble(active, isPaused) {
    const item = document.getElementById("pauseBubbleItem");
    if (item) item.hidden = !active;
    const icon = document.getElementById("pauseBubbleIcon");
    const label = document.getElementById("pauseBubbleLabel");
    if (icon) icon.textContent = isPaused ? "▶️" : "⏸";
    if (label) label.textContent = isPaused ? "继续" : "暂停";
    if (item) item.title = isPaused ? "接着听（重新接上电脑声音和麦克风）" : "暂停一下：会中休息不录、不上传，这场会不结束";
  }

  /**
   * 旁听期间才会出现的两个泡泡：⏸ 暂停/继续、💡 秒答。
   * 一起管是有意的——它们都跟着"在不在听"走，分散在各处刷很容易漏掉一个
   * （表现就是"结束旁听了，秒答还挂在那儿"）。
   */
  function renderContextBubbles(active, isPaused) {
    renderPauseBubble(active, isPaused);
    const ask = document.getElementById("askBubbleItem");
    if (ask) ask.hidden = !active;
  }

  /** 收尾阶段：字幕条改成进度条（"整理纪要 2/5 段"），省得主人以为卡死了 */
  function renderSettleBar(done, total, final) {
    ensureBar();
    if (!barEl) return;
    barEl.hidden = false;
    if (barMetaEl) barMetaEl.textContent = final ? "📝 正在汇总成整篇纪要…" : `📝 整理纪要 ${done || 0}/${total || 0} 段`;
    if (barTextEl) barTextEl.textContent = "已经在收尾了，写好我会弹气泡告诉你";
  }

  // ---- 采集端心跳（主进程靠它判断渲染层有没有失联）----------------------------

  let beatTimer = null;

  function startBeat() {
    if (beatTimer) clearInterval(beatTimer);
    const send = () => {
      try { if (window.dshPet.meetingBeat) window.dshPet.meetingBeat(); } catch {}
    };
    send();
    beatTimer = setInterval(send, 60000);
  }

  function stopBeat() {
    if (beatTimer) {
      clearInterval(beatTimer);
      beatTimer = null;
    }
  }

  function renderBar() {
    ensureBar();
    if (!barEl) return;
    if (!active) {
      barEl.hidden = true;
      if (barTimer) { clearInterval(barTimer); barTimer = null; }
      return;
    }
    barEl.hidden = false;
    const sec = Math.max(0, Math.floor(elapsedMs() / 1000));
    const mmss = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
    if (barMetaEl) barMetaEl.textContent = paused ? `⏸ 已暂停 ${mmss}（休息期间不录）` : `🎧 记录中 ${mmss}`;
  }

  function startBarTimer() {
    if (barTimer) clearInterval(barTimer);
    barTimer = setInterval(renderBar, 1000);
    renderBar();
  }

  function showLine(line) {
    ensureBar();
    if (!barTextEl || !line || !line.text) return;
    if (window.__meetingLive === false) return; // 设置里关掉了实时字幕（记还是照记）
    if (Date.now() - lastLineAt < 300 && barTextEl.dataset.src === line.src) return; // 太密的短句别把字幕刷花
    lastLineAt = Date.now();
    barTextEl.dataset.src = line.src || "";
    barTextEl.textContent = `${line.src === "me" ? "我" : "对方"}：${line.text}`;
    if (barMetaEl) {
      const sec = Math.max(0, Math.floor(elapsedMs() / 1000));
      barMetaEl.textContent = `🎧 记录中 ${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")} · ${line.count || 0} 句`;
    }
    barTextEl.classList.remove("pop");
    void barTextEl.offsetWidth;
    barTextEl.classList.add("pop");
  }

  // ---- 开始 / 暂停 / 继续 / 结束 --------------------------------------------

  /**
   * 采集前要过的一道"点击手势"关。
   * 从泡泡菜单点进来时本来就有点击；但**从托盘点进来没有**——Chromium 会拒绝 getDisplayMedia，
   * 系统声那一路直接采不到。这时先弹一个本地确认框，**点那一下就是手势**，点完再开始采集。
   * @returns {Promise<boolean>} 拿到手势（或被点"取消"）后返回
   */
  async function ensureGesture(title, desc, okLabel) {
    const ask = (window.dshPetPlay && window.dshPetPlay.choose) || null;
    if (!ask || window.__meetingGestureOk) {
      window.__meetingGestureOk = false;
      return true;
    }
    const ok = await ask(title, desc, [
      { label: okLabel || "好的", value: "go", primary: true },
      { label: "取消", value: null },
    ]);
    window.__meetingGestureOk = false;
    return ok === "go";
  }

  async function start(opts) {
    if (active || starting) return { ok: false, error: "已经在旁听" };
    if (!window.dshPet || !window.dshPet.meetingChunk) return { ok: false, error: "主进程没接上" };
    starting = true;
    try {
      const wantMic = !!(opts && opts.mic);
      // 计时原点先定下来（attachTrack 要靠它把 t0 换算成"这一场开始后第几秒"）
      startedAt = Date.now();
      firstStartedAt = startedAt;
      activeBaseMs = 0;
      ctx = new AudioContext();
      if (ctx.state === "suspended") await ctx.resume();
      const errs = [];
      // 系统声：主路（会议里对方的声音）
      try {
        attachTrack("remote", await getLoopbackStream(), firstStartedAt + activeBaseMs);
      } catch (err) {
        errs.push(`系统声：${err.message}`);
        console.warn("[meeting] 系统声采集失败:", err.message);
      }
      // 麦克风：可选（记下我自己说的话）
      if (wantMic) {
        try {
          attachTrack("me", await getMicStream(), firstStartedAt + activeBaseMs);
        } catch (err) {
          errs.push(`麦克风：${err.message}`);
        }
      }
      if (!tracks.length) {
        await cleanup();
        firstStartedAt = 0;
        return { ok: false, error: errs.join("；") || "没采到任何声音" };
      }
      active = true;
      paused = false;
      runStartedAt = startedAt;
      renderMeetBubble(true, 0);
      renderContextBubbles(true, false);
      startBeat(); // 让主进程知道"采集端活着"
      startBarTimer();
      if (barTextEl) barTextEl.textContent = "开始听了…（静音时不会上传任何东西）";
      console.log(`[meeting] 开始旁听：${tracks.map((t) => t.source).join("+")}${errs.length ? `（${errs.join("；")}）` : ""}`);
      return { ok: true, sources: tracks.map((t) => t.source), warnings: errs };
    } finally {
      starting = false;
    }
  }

  async function cleanup() {
    for (const t of tracks) {
      try { t.proc.onaudioprocess = null; } catch {}
      try { t.proc.disconnect(); } catch {}
      try { t.srcNode.disconnect(); } catch {}
      try { t.stream.getTracks().forEach((x) => x.stop()); } catch {}
    }
    tracks = [];
    try { if (ctx) await ctx.close(); } catch {}
    ctx = null;
  }

  async function stop(reason) {
    if (!active) return { ok: false, error: "当前没有在旁听" };
    active = false;
    paused = false;
    runStartedAt = 0;
    // 把正在攒的那一句也交出去（不然"结束"时嘴里的最后几个字会被丢掉）
    for (const t of tracks) {
      try { if (t.seg) t.seg.flushNow(); } catch {}
    }
    stopBeat();
    await cleanup();
    renderBar();
    renderMeetBubble(false, 0);
    renderContextBubbles(false, false);
    if (barTextEl) barTextEl.textContent = "";
    console.log(`[meeting] 停止采集（${reason || "手动"}）`);
    return { ok: true };
  }

  /**
   * 暂停（会中休息）：把音频轨停掉——**不上传、不转写、也不出纪要**，这场会还开着。
   * 正在攒的半句先 flushNow 交出去（跟"结束"同一个道理：休息前说了一半的话不能丢）。
   * 心跳**不停**：渲染层还活着，只是没在录；万一这会儿进程崩了，主进程的看门狗照样能收尾。
   */
  async function pause(reason) {
    if (!active || paused) return { ok: false, error: "当前没有在旁听" };
    activeBaseMs += runStartedAt ? Date.now() - runStartedAt : 0;
    runStartedAt = 0;
    paused = true;
    for (const t of tracks) {
      try { if (t.seg) t.seg.flushNow(); } catch {}
    }
    await cleanup();
    renderBar();
    renderMeetBubble(true, 0);
    renderContextBubbles(true, true);
    if (barTextEl) barTextEl.textContent = "已暂停：休息期间不录、也不上传，点 ▶️ 继续接着记";
    try { window.dshPet.meetingPause(true, reason || "暂停"); } catch {}
    console.log(`[meeting] 暂停采集（${reason || "手动"}），已录 ${Math.round(activeBaseMs / 1000)} 秒`);
    return { ok: true };
  }

  /**
   * 继续：重新接上音频轨，接着记。
   * 时间原点传"开始时刻 + 已经录过的时长"→ 恢复后的【mm:ss】接着休息前往下走（时间轴跳过休息）。
   * 这里同样需要"点击手势"（getDisplayMedia 的规矩），从托盘点进来时会先弹确认框要那一下点击。
   */
  async function resume(reason) {
    if (!active || !paused) return { ok: false, error: "现在不是在暂停中" };
    if (!(await ensureGesture("🎧 继续旁听？", "会重新接上电脑里的声音和麦克风，接着往纪要里记。", "继续旁听"))) {
      return { ok: false, error: "已取消" };
    }
    starting = true;
    try {
      ctx = new AudioContext();
      if (ctx.state === "suspended") await ctx.resume();
      const errs = [];
      const origin = firstStartedAt + activeBaseMs;
      try {
        attachTrack("remote", await getLoopbackStream(), origin);
      } catch (err) {
        errs.push(`系统声：${err.message}`);
      }
      if (window.__meetingMicWanted !== false) {
        try {
          attachTrack("me", await getMicStream(), origin);
        } catch (err) {
          errs.push(`麦克风：${err.message}`);
        }
      }
      if (!tracks.length) {
        await cleanup();
        return { ok: false, error: errs.join("；") || "没接上任何声音" };
      }
      paused = false;
      runStartedAt = Date.now();
      renderMeetBubble(true, 0);
      renderContextBubbles(true, false);
      startBarTimer();
      if (barTextEl) barTextEl.textContent = "继续听了…（静音时不会上传任何东西）";
      // 主进程要重新起算（静音提醒、最长时长、时间轴上的休息位置都靠它）
      try { window.dshPet.meetingPause(false, reason || "继续"); } catch {}
      console.log(`[meeting] 继续旁听：${tracks.map((t) => t.source).join("+")}${errs.length ? `（${errs.join("；")}）` : ""}`);
      return { ok: true, sources: tracks.map((t) => t.source), warnings: errs };
    } finally {
      starting = false;
    }
  }

  /** 泡泡菜单用：⏸ 暂停 ↔ ▶️ 继续 一个按钮切换 */
  function pauseToggle() {
    return paused ? resume("泡泡菜单") : pause("泡泡菜单");
  }

  /**
   * 💡 秒答：同事刚问了个问题，点一下就要一句能说出口的话。
   * 问题不用你打——主进程会拿**最近这段旁听原文**去问（同事那句就在里面）。
   * 答案不走这里显示，而是弹在鲸鱼旁边那张小卡片上（它对外面的屏幕共享不可见）。
   */
  async function askNow() {
    if (!active) return { ok: false, error: "先开始旁听，才有最近那句话可问" };
    const emo = window.dshPetEmotion;
    // 先给个"在查了"的反馈：模型要几秒，什么都不显示会被当成点空了
    try { if (emo) emo.showBubble("💡 查资料中…（先知识包，不够再翻代码）", "calm"); } catch {}
    let r = null;
    try {
      r = await window.dshPet.askAboutMeeting();
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    try {
      if (!emo) return r;
      if (r && r.ok) emo.hideBubble(); // 答案在卡片上，气泡该让位
      else emo.showBubble(`💡 秒答没成：${(r && r.error) || "主进程没响应"}`, "calm");
    } catch {}
    return r;
  }

  /** 泡泡菜单 / 托盘都用它：没有在听就开始，正在听就结束 */
  async function toggle() {
    // 正在听 → 走 stopAndFinish（**必须告诉主进程**，不然采集停了但纪要永远不会生成）
    if (active) return stopAndFinish("手动结束");
    // 先读设置：麦克风轨要不要一起录、要不要滚实时字幕（设置页改完立刻生效）
    try {
      const cfg = await window.dshPet.meetingConfig();
      window.__meetingMicWanted = !cfg || cfg.mic !== false;
      window.__meetingLive = !cfg || cfg.liveCaption !== false;
    } catch {}
    if (!(await ensureGesture(
      "🎧 开始旁听这场会？",
      "会录下电脑里的声音（对方发言）和麦克风（你自己的发言），只在有人说话时上传转写；结束后自动出纪要。",
      "开始旁听",
    ))) {
      return { ok: false, error: "已取消" };
    }
    const r = await start({ mic: !!(window.__meetingMicWanted !== false) });
    if (r.ok) {
      if (window.dshPetEmotion) window.dshPetEmotion.hideBubble();
      // 主进程要知道"真的开始采集了"（它负责记账和落盘）
      window.dshPet.meetingStarted({ sources: r.sources, warnings: r.warnings });
    } else if (window.dshPetEmotion) {
      window.dshPetEmotion.showBubble(`🎧 没能开始旁听：${r.error}`, "calm");
    }
    return r;
  }

  // 主进程/菜单让它结束（结束不需要手势）→ 本体采完后请主进程收尾出纪要
  async function stopAndFinish(reason) {
    if (!active) return { ok: false, error: "当前没有在旁听" };
    const r = await stop(reason);
    // **关键路径优先**：先把"结束了"告诉主进程（收尾、出纪要都靠它）。
    // 顺序不能反：反馈气泡只是"尽力而为"的 UI 调用，一旦它抛异常（渲染层状态不对、
    // 元素没了…），后面那句 meetingStopped 就永远不会执行——表现就是"点了结束没反应"。
    let stopped = null;
    try {
      stopped = await window.dshPet.meetingStopped(reason || "手动结束");
    } catch (err) {
      stopped = { ok: false, error: err.message };
    }
    try {
      if (!window.dshPetEmotion) return r;
      window.dshPetEmotion.showBubble(
        stopped && stopped.ok !== false
          ? "🎧 收工，正在把刚才听到的整理成纪要（几十秒）…"
          : `🎧 结束没成功：${(stopped && stopped.error) || "主进程没响应"}`,
        "calm",
      );
    } catch {}
    return r;
  }

  window.dshPetMeeting = {
    toggle,
    pause: (reason) => pause(reason),
    resume: (reason) => resume(reason),
    pauseToggle,
    askNow,
    start: (opts) => { window.__meetingGestureOk = true; return start(opts); },
    stop: stopAndFinish,
    isActive: () => active,
    isPaused: () => paused,
  };

  // 主进程来的指令
  if (window.dshPet && window.dshPet.onMeetingSignal) {
    window.dshPet.onMeetingSignal(async (msg) => {
      if (!msg) return;
      if (msg.type === "line") showLine(msg);
      else if (msg.type === "state" && msg.phase === "minutes") {
        renderSettleBar(msg.done, msg.total, msg.final); // 收尾进度
      } else if (msg.type === "state") {
        renderBar(); // 非结算态：字幕条按 active 显隐
        renderMeetBubble(!!msg.active, msg.lines);
        renderContextBubbles(!!msg.active, !!msg.paused);
        if (msg.quiet && window.dshPetEmotion) {
          window.dshPetEmotion.showBubble(`🎧 已经 ${msg.quietMinutes || 15} 分钟没听到人说话，还在开会吗？（右键鲸鱼 → ⏹ 结束，我就出纪要）`, "calm");
        }
      } else if (msg.type === "stop-request") {
        await stopAndFinish(msg.reason || "托盘结束");
      } else if (msg.type === "pause-request") {
        // 托盘点"暂停"：不需要手势，直接停采集
        const r = await pause(msg.reason || "托盘暂停");
        if (!r.ok && window.dshPetEmotion) window.dshPetEmotion.showBubble(`🎧 暂停没成功：${r.error}`, "calm");
      } else if (msg.type === "resume-request") {
        const r = await resume(msg.reason || "托盘继续");
        if (!r.ok && window.dshPetEmotion) window.dshPetEmotion.showBubble(`🎧 继续没成功：${r.error}`, "calm");
      } else if (msg.type === "start-request") {
        window.__meetingMicWanted = msg.mic !== false;
        await toggle();
      }
    });
  }

  // 进窗口时对一次状态：万一窗口刚重启过（或正在旁听时刷新），泡泡上的字要跟真实状态一致
  if (window.dshPet && window.dshPet.meetingStatus) {
    window.dshPet
      .meetingStatus()
      .then((s) => renderMeetBubble(!!(s && s.active), s && s.lines))
      .catch(() => renderMeetBubble(false, 0));
  } else {
    renderMeetBubble(false, 0);
  }
  renderContextBubbles(active, paused); // ⏸ 暂停 / 💡 秒答 默认都藏着，只在"正在听"时才露头
})();