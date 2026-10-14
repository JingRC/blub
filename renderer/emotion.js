// renderer/emotion.js — 情绪监测渲染层（桌宠窗口）
//
// 职责：
//   1. 摄像头采集：getUserMedia → 隐藏 video → 按主进程下发的分析间隔抓帧
//      (JPEG dataURL)送主进程。抓帧节奏跟随分析间隔，避免抓了多帧只用一帧的浪费。
//   2. 心情气泡：展示陪伴消息 / 情绪记录通知
//   3. 鲸鱼情绪反应：根据 mood 给 #stage 打 data-mood，CSS 动画接管
//   4. 心情记录面板：实时状态条 + 今日概览/今日记录/历史记录（可折叠）
//      设置项（识别、认主、锁屏）在独立窗口里，右上角 ⚙ 打开
//   5. 暴露 window.dshPetEmotion 给 pet.js 的"心情"泡泡调用
//
// 采集帧默认 320px 宽 JPEG（~30KB），只有主进程分析节流通过时才会真正发 API。

(function () {
  const video = document.getElementById("emotionVideo");
  const canvas = document.getElementById("emotionCanvas");
  const moodBubble = document.getElementById("moodBubble");
  const moodBubbleText = document.getElementById("moodBubbleText");
  const stage = document.getElementById("stage");

  const DEFAULT_CAPTURE_MS = 20000; // 兜底抓帧间隔（主进程会下发真实分析间隔）
  const FRAME_WIDTH = 480; // 帧宽（保持比例缩放）；分辨率太低模型看不清眉眼，情绪判别会退化
  const MOOD_HOLD_MS = 9000; // 鲸鱼情绪动画持续
  const BUBBLE_HOLD_MS = 7000; // 心情气泡持续

  let captureIntervalMs = DEFAULT_CAPTURE_MS; // 实际抓帧间隔（跟随主进程分析间隔）
  let probeMode = false; // 当前是否是锁屏/在场探测节奏（这个节奏下身份本地判，不用跑云端）

  let stream = null;
  let cameraOn = false;
  let cameraStarting = false; // 防并发：cameraOn 要等 getUserMedia 返回才置位，中间再收到一次下发会开两路
  let captureTimer = null;
  let primeTimer = null;
  let bubbleTimer = null;
  let moodTimer = null;
  let consecutiveErrors = 0;

  // ---- 摄像头采集 -----------------------------------------------------------

  async function startCamera() {
    if (cameraOn || cameraStarting) return;
    cameraStarting = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: "user",
        },
        audio: false,
      });
      video.srcObject = stream;
      cameraOn = true;
      consecutiveErrors = 0;
      console.log("[emotion] camera on");
      startMetricsLoop(); // 哈欠几何量测量（标定期，见上面注释）
    } catch (err) {
      console.log("[emotion] camera unavailable:", err.name, err.message);
      if (window.dshPet)
        window.dshPet.emotionCameraError(`${err.name}: ${err.message}`);
      showMoodBubble("📹 没找到可用的摄像头，情绪识别先休息啦", "calm");
    } finally {
      cameraStarting = false;
    }
  }

  function stopCamera() {
    cameraOn = false;
    stopMetricsLoop(); // 摄像头关了就别再算几何量
    if (captureTimer) {
      clearInterval(captureTimer);
      captureTimer = null;
    }
    if (primeTimer) {
      clearTimeout(primeTimer);
      primeTimer = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    console.log("[emotion] camera off");
  }

  /** 抓一帧 → 缩放 → JPEG dataURL（width 控制输出宽度） */
  function captureFrameData(width) {
    if (!cameraOn || !video.videoWidth) return null;
    const w = width || FRAME_WIDTH;
    const scale = w / video.videoWidth;
    canvas.width = w;
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", w <= 200 ? 0.6 : 0.7);
  }

  let faceBusy = false; // 本地人脸识别一次只跑一个：软件 WebGL 偶尔比节拍慢，别堆起来

  /**
   * 抓一帧 + 判身份。
   * 身份判定优先走本地人脸识别（renderer/face.js）：只在这一帧需要，
   * 不必把图送去云端等模型"看图投票"（免费模型还会把参考照当答案点头）。
   * 探测节奏下本地判完就不用跑云端了——省一次往返、省一分钱，也没有 429。
   * 本地不可用（模型没起来 / 还没认主）时照旧送云端，行为与以前一致。
   */
  async function captureFrame() {
    const frameTs = Date.now(); // 抓帧那一刻（几何量要按这个时刻就近取，不能等识别完再取）
    // 正在拖动鲸鱼：整帧跳过。人手上按着窗口就等于"人在跟前"，这一帧的身份判定没有意义，
    // 而人脸推理 + JPEG 编码都要占渲染线程，正是拖动最需要流畅的时候。
    if (document.querySelector(".whale.dragging")) return;
    const dataUrl = captureFrameData();
    if (!dataUrl) return;
    let verdict = null;
    if (window.dshFace && !faceBusy) {
      faceBusy = true;
      try {
        verdict = await window.dshFace.identify(
          video,
          probeMode ? "probe" : "emotion",
        );
      } catch (err) {
        console.warn("[emotion] 本地人脸识别失败:", err.message);
      } finally {
        faceBusy = false;
      }
    }
    if (verdict && window.dshPet && window.dshPet.sendFaceVerdict) {
      window.dshPet.sendFaceVerdict(verdict);
    }
    // 每一帧都送主进程（只是本机 IPC，不花钱）：主进程按"情绪分析间隔"决定要不要跑云端。
    // 以前探测节奏下有本地结论就 return，导致"应用锁屏一开（一直处于探测节奏）时
    // 情绪/行为分析整条停摆"——重启后 4 分钟零样本就是因为这个。
    // 顺带把"这一帧那一刻"的本机几何量（嘴/眼/头姿）送过去：
    // 哈欠要过 MAR 闸门，自定义动作要核对演示区间（见主进程 emotion.js 的 _gateYawn/_gateAction）。
    const geo = nearestGeo(frameTs);
    if (window.dshPet)
      window.dshPet.sendEmotionFrame(dataUrl, {
        ts: frameTs,
        marOut: geo ? geo.marOut : null,
        marIn: geo ? geo.marIn : null,
        ear: geo ? geo.ear : null,
        pitch: geo ? geo.pitch : null,
      });
  }

  function startCaptureLoop(immediate) {
    if (captureTimer) clearInterval(captureTimer);
    if (primeTimer) {
      clearTimeout(primeTimer);
      primeTimer = null;
    }
    captureTimer = setInterval(captureFrame, captureIntervalMs);
    // 首帧尽快抓一帧：开机或"键鼠刚静下来"被唤起时，先给一份即时结论
    primeTimer = setTimeout(captureFrame, immediate ? 300 : 2500);
  }

  // ---- 哈欠几何量：2 秒一次（纯本机识别，不花 API）----
  // 为什么需要：单帧"嘴张开"既可能是说话，也可能是手托下巴把嘴顶开，云端小模型分不出来。
  // 本机量一次嘴部纵横比 MAR（内唇/外唇），一是给主进程的哈欠"过闸"用（云端说哈欠 + 本机 MAR 够大才认），
  // 二是打日志方便标定阈值。真哈欠 MAR 会缓慢升到峰值并维持 2 秒以上，说话只是快速小幅张合。
  // 采样间隔从 1s 放到 2s：本地推理是同步占渲染线程的大头，减半后常驻 CPU 明显下降，
  // 而哈欠本身持续 ≥2s、GEO_MATCH_MS 又有 1.5s 就近窗口，2s 采样照样抓得住。
  const YAWN_METRICS_MS = 2000;
  // 抓帧时取离这一刻最近的几何量样本；时差超过这个值就不采信（必须是"同一刻"的嘴）
  const GEO_MATCH_MS = 1500;
  let metricsTimer = null;
  let metricsBusy = false;
  const geoRecent = []; // 最近几秒的几何量样本 {ts, marOut, marIn, ear, pitch}，抓帧时按时间就近取

  async function metricsTick() {
    if (metricsBusy || !window.dshFace || !window.dshFace.metrics) return;
    // 拖动是短暂的高频操作，而人脸推理是同步占渲染线程的（一次百来毫秒）：
    // 这期间跳过，别让"每秒量一次嘴型"把鲸鱼跟手的流畅度吃掉。
    if (document.querySelector(".whale.dragging")) return;
    metricsBusy = true;
    try {
      const g = await window.dshFace.metrics(video);
      if (g) {
        const ts = Date.now();
        geoRecent.push({
          ts,
          marOut: g.marOut == null ? null : g.marOut,
          marIn: g.marIn == null ? null : g.marIn,
          ear: g.ear == null ? null : g.ear,
          pitch: typeof g.pitch === "number" ? g.pitch : null,
        });
        while (geoRecent.length && ts - geoRecent[0].ts > 5000)
          geoRecent.shift();
        // 嘴 = 内唇口径/外唇口径（外唇跟文献阈值同口径），眼 = 眼睛纵横比，头 = 俯仰
        console.log(
          `[yawn] 嘴=${g.marIn == null ? "-" : g.marIn}/${g.marOut == null ? "-" : g.marOut}` +
            ` 眼=${g.ear == null ? "-" : g.ear}` +
            ` 头=${g.pitch == null ? "-" : g.pitch.toFixed(2)} 脸=${g.faces}`,
        );
      }
    } catch (err) {
      console.log("[yawn] metrics failed:", err.message);
    } finally {
      metricsBusy = false;
    }
  }

  /** 取离时刻 ts 最近的几何量样本（±GEO_MATCH_MS 内）；没有或脸上没量到就返回 null */
  function nearestGeo(ts) {
    let best = null;
    let bestDt = Infinity;
    for (const s of geoRecent) {
      const dt = Math.abs(s.ts - ts);
      if (dt < bestDt) {
        bestDt = dt;
        best = s;
      }
    }
    return best && bestDt <= GEO_MATCH_MS ? best : null;
  }

  function startMetricsLoop() {
    if (metricsTimer) return;
    metricsTimer = setInterval(metricsTick, YAWN_METRICS_MS);
  }

  function stopMetricsLoop() {
    if (metricsTimer) clearInterval(metricsTimer);
    metricsTimer = null;
    geoRecent.length = 0;
  }

  // 主进程控制摄像头开/关，并下发识别节奏（抓帧节拍与之对齐）
  if (window.dshPet && window.dshPet.onEmotionCamera) {
    window.dshPet.onEmotionCamera(
      ({ enabled, intervalMs, probeNow, probe }) => {
        const next = Number(intervalMs);
        // 应用级锁屏会下发探测节奏（慢档 6 秒 / 盯梢 3 秒 / 锁定期 2 秒），下限放到 1.5 秒。
        // 身份走本机人脸识别（约 200ms），不必再为"省 API"把节奏放宽。
        const changed = next >= 1500 && next !== captureIntervalMs;
        if (changed) captureIntervalMs = next;
        probeMode = !!probe; // 探测节奏：身份本地判，云端只在情绪节奏上跑
        if (enabled) {
          startCamera().then(() => {
            if (!cameraOn) return;
            // probeNow：键鼠刚静下来 → 立刻抓一帧，节拍从"现在"重新起算
            if (changed || !captureTimer || probeNow)
              startCaptureLoop(!!probeNow);
          });
        } else {
          stopCamera();
        }
      },
    );
  }

  // ---- 鲸鱼情绪反应 ---------------------------------------------------------

  function applyWhaleMood(mood) {
    if (!mood) return;
    stage.dataset.mood = mood;
    if (moodTimer) clearTimeout(moodTimer);
    moodTimer = setTimeout(() => {
      delete stage.dataset.mood;
    }, MOOD_HOLD_MS);
  }

  function moodOf(text) {
    if (text === "happy" || text === "calm" || text === "focused") return text;
    if (text === "stressed" || text === "angry") return "stressed";
    return "down"; // tired / sad / surprised / 未知
  }

  /** 鲸鱼主动动作（spin=转圈 jump=跃起 wiggle=扭一扭 breath=深呼吸引导 slack=看家摸鱼 chat=唤起提问） */
  function whaleAction(effect) {
    if (!effect) return;
    if (effect === "chat") {
      // 交给 pet.js 暴露的桥唤起提问对话框
      if (window.dshPetPlay && window.dshPetPlay.ask) window.dshPetPlay.ask();
      return;
    }
    if (effect === "meal") {
      // 饭点提醒里点"🍚 记一笔" → 唤起打卡对话框（同样走 pet.js 的桥）
      if (window.dshPetPlay && window.dshPetPlay.meal) window.dshPetPlay.meal();
      return;
    }
    if (effect === "breath") {
      applyWhaleMood("breath"); // CSS：缓慢膨胀收缩
      return;
    }
    if (effect === "slack") {
      // 看家期间的"摸鱼"：慢慢歪过去、再歪回来（像靠着打盹），故意做得低调，
      // 不改心情/神态，主人回来时看家的神态还挂着（dataset.owner="away"）
      const whale = document.getElementById("whale");
      if (!whale) return;
      whale.style.transition = "transform 2.4s ease-in-out";
      whale.style.transform = "rotate(-8deg) translateY(4px) scale(0.98)";
      setTimeout(() => {
        whale.style.transform = "rotate(7deg)";
      }, 2400);
      setTimeout(() => {
        whale.style.transform = "";
        whale.style.transition = "";
      }, 5200);
      return;
    }
    applyWhaleMood("happy");
    if (effect === "spin" || effect === "wiggle") {
      const whale = document.getElementById("whale");
      whale.style.transition = "transform 1s ease-in-out";
      whale.style.transform = "rotate(360deg)";
      setTimeout(() => {
        whale.style.transform = "";
        whale.style.transition = "";
      }, 1000);
    } else if (effect === "jump") {
      const whale = document.getElementById("whale");
      whale.style.transition =
        "transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)";
      whale.style.transform = "translateY(-36px) scale(1.08)";
      setTimeout(() => {
        whale.style.transform = "";
        whale.style.transition = "";
      }, 700);
    }
  }

  // ---- 认主 ----------------------------------------------------------------

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 认主登记：连拍 3 张参考照送给主进程（每张 160px 小图） */
  async function enrollOwner() {
    if (!cameraOn) {
      showMoodBubble(
        "📹 先开启摄像头识别（心情 → ⚙ 设置 → 摄像头识别）再来认主哦",
        "calm",
      );
      return;
    }
    const poses = ["请正对镜头～", "稍微侧一点头～", "最后一张，自然一点～"];
    for (let i = 0; i < 3; i++) {
      showMoodBubble(`👤 认主登记 ${i + 1}/3：${poses[i]}`, "calm");
      await sleep(1600);
      const dataUrl = captureFrameData(160);
      if (!dataUrl) {
        showMoodBubble("📹 摄像头好像没准备好，再试一次吧", "calm");
        return;
      }
      const res = await window.dshPet.emotionEnroll(dataUrl);
      if (res && res.done) {
        showMoodBubble("✅ 认主完成！以后鲸鱼只认你一个人啦～", "happy", {
          effect: "spin",
        });
        return;
      }
    }
    showMoodBubble("👤 参考照已存好，再点一次可重新登记", "calm");
  }

  // 设置窗口点了"认主登记" → 相机在桌宠窗口，这里代跑（拍完的气泡提示也在这边）
  if (window.dshPet && window.dshPet.onEnrollRequest) {
    window.dshPet.onEnrollRequest(() => {
      enrollOwner();
    });
  }

  // 主人在场/看家状态推送 → 鲸鱼看家神态
  if (window.dshPet && window.dshPet.onOwnerPresence) {
    window.dshPet.onOwnerPresence(({ guardActive }) => {
      if (guardActive) {
        stage.dataset.owner = "away"; // 持续看家神态（不受 mood 定时清除影响）
      } else {
        delete stage.dataset.owner;
      }
    });
  }

  // ---- 心情气泡（可带交互按钮）----------------------------------------------

  function showMoodBubble(text, mood, actions, effect) {
    if (!moodBubble || !text) return;
    // 文本行（textContent 防注入）
    moodBubbleText.textContent = text;

    // 动作按钮行（重建，避免残留旧按钮）
    let bar = moodBubble.querySelector(".mood-bubble-actions");
    if (bar) bar.remove();
    if (actions && actions.length) {
      bar = document.createElement("div");
      bar.className = "mood-bubble-actions";
      actions.forEach((a) => {
        const btn = document.createElement("button");
        btn.className = "mood-action-btn";
        btn.textContent = a.label;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          moodBubble.hidden = true;
          if (window.dshPet && window.dshPet.emotionInteract) {
            window.dshPet.emotionInteract(a.id);
          }
        });
        bar.appendChild(btn);
      });
      moodBubble.appendChild(bar);
    }

    moodBubble.hidden = false;
    moodBubble.dataset.mood = moodOf(mood);
    // 重启入场动画
    moodBubble.classList.remove("show");
    void moodBubble.offsetWidth;
    moodBubble.classList.add("show");
    if (effect) whaleAction(effect);
    else applyWhaleMood(moodOf(mood));
    if (bubbleTimer) clearTimeout(bubbleTimer);
    const hold = actions ? 30000 : BUBBLE_HOLD_MS + text.length * 120; // 带按钮的停留更久
    bubbleTimer = setTimeout(() => {
      moodBubble.hidden = true;
    }, hold);
  }

  // 主进程推送：分析结果 / 陪伴消息（可带按钮与动作）
  // （显著变化事件主进程会同时推一条中文陪伴消息，这里不再重复弹气泡）
  if (window.dshPet) {
    if (window.dshPet.onEmotionUpdate) {
      window.dshPet.onEmotionUpdate(({ current, enabled }) => {
        if (typeof enabled === "boolean") camEnabled = enabled;
        if (current) {
          cachedPresence = {
            noFace: !!current.noFace,
            ownerPresent: current.ownerPresent === true,
            ts: current.ts,
          };
          if (!current.noFace) applyWhaleMood(moodOf(current.emotion));
        }
        renderStatusStrip();
      });
    }
    if (window.dshPet.onCompanion) {
      window.dshPet.onCompanion(({ text, mood, actions, effect }) =>
        showMoodBubble(text, mood, actions, effect),
      );
    }
    // 每次身份结论（含锁屏探测期的快速探测）→ 状态条实时刷新
    if (window.dshPet.onPresenceSample) {
      window.dshPet.onPresenceSample((p) => {
        if (!p) return;
        cachedPresence = p;
        renderStatusStrip();
      });
    }
    // 锁屏状态变化（锁定/解锁）→ 状态条实时刷新
    if (window.dshPet.onGuardStatus) {
      window.dshPet.onGuardStatus((s) => {
        if (s) {
          guardState = s;
          renderStatusStrip();
        }
      });
    }
  }

  function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // ---- 心情记录面板 ----------------------------------------------------------
  //
  // 分三块：状态条（识别/认主/在场/锁屏）/ 今日概览（分布+行为）/ 今日记录·历史记录（可折叠）
  // 设置项不在这里——右上角 ⚙ 会另开一个独立窗口。

  const moodPanel = document.getElementById("moodPanel");
  const moodPanelBody = document.getElementById("moodPanelBody");
  const moodGearBtn = document.getElementById("moodGearBtn");

  let reportData = null; // emotionReport()
  let guardState = null; // guardStatus()
  let ownerState = null; // ownerInfo()
  let cachedPresence = null; // 最近一次身份结论 { noFace, ownerPresent, ts }；null = 还不知道
  let camEnabled = false;
  let musicLive = null;      // 听歌状态（musicConfig().status）：nowPlaying 有值 = 正在听歌
  const collapsed = { today: false, history: true }; // 折叠状态（默认：今日展开、历史收起）

  if (moodGearBtn) {
    moodGearBtn.addEventListener("click", () => {
      // 设置放在独立窗口，心情记录留在原处不动
      if (window.dshPet && window.dshPet.openSettings)
        window.dshPet.openSettings();
    });
  }

  // 🎓 识别反馈：打开"识别记录 + 演示教学"工具（另一个独立窗口）
  const moodFeedbackBtn = document.getElementById("moodFeedbackBtn");
  if (moodFeedbackBtn) {
    moodFeedbackBtn.addEventListener("click", () => {
      if (window.dshPet && window.dshPet.openFeedback)
        window.dshPet.openFeedback();
    });
  }
  if (document.getElementById("moodPanelClose")) {
    document.getElementById("moodPanelClose").addEventListener("click", () => {
      moodPanel.hidden = true;
    });
  }
  // 托盘"查看情绪报告" → 打开心情记录面板
  if (window.dshPet && window.dshPet.onShowReport) {
    window.dshPet.onShowReport(() => {
      showMoodPanel();
    });
  }
  moodPanel &&
    moodPanel.addEventListener("click", (e) => {
      if (e.target === moodPanel) moodPanel.hidden = true;
    });

  // 报告内容变了（新事件 / 原因补上 / 兜底）→ 面板开着就地刷新。
  // 不然"💭 鲸鱼还在琢磨原因…"要等主人关掉再打开面板才会变成结果，看着就像卡住了。
  if (window.dshPet && window.dshPet.onEmotionReportChanged) {
    let reportRefreshTimer = null;
    window.dshPet.onEmotionReportChanged(() => {
      if (!moodPanel || moodPanel.hidden || reportRefreshTimer) return;
      reportRefreshTimer = setTimeout(() => {
        reportRefreshTimer = null;
        refreshAll();
      }, 400);
    });
  }

  const MOOD_EMOJI = {
    happy: "😄",
    calm: "😌",
    focused: "🧐",
    surprised: "😮",
    tired: "😴",
    sad: "😟",
    stressed: "😣",
    angry: "😠",
  };

  function esc(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function eventRow(ev) {
    const arrow = ev.delta > 0 ? "📈" : "📉";
    const from = `${MOOD_EMOJI[ev.from] || "❔"}${ev.from}`;
    const to = `${MOOD_EMOJI[ev.to] || "❔"}${ev.to}`;
    const reason = ev.reason
      ? `<div class="mr-reason">💭 ${esc(ev.reason)}${ev.comfort ? ` — ${esc(ev.comfort)}` : ""}</div>`
      : `<div class="mr-reason mr-pending">💭 鲸鱼还在琢磨原因…</div>`;
    return `<div class="mr-event">
      <div class="mr-event-head">
        <span class="mr-time">🕒 ${esc(fmtClock(ev.ts))}</span>
        <span class="mr-change">${arrow} ${esc(from)} → ${esc(to)}</span>
        <span class="mr-delta">${ev.delta > 0 ? "+" : ""}${ev.delta}</span>
      </div>${reason}</div>`;
  }

  /** 发呆记录：没有"从什么情绪到什么情绪"，只有起止时刻和时长 */
  function gazeRow(ev) {
    const start = ev.startTs ? `${esc(fmtClock(ev.startTs))} ~ ` : "";
    return `<div class="mr-event">
      <div class="mr-event-head">
        <span class="mr-time">🕒 ${start}${esc(fmtClock(ev.ts))}</span>
        <span class="mr-change">🧘 发呆 ${ev.minutes} 分钟</span>
      </div>
      <div class="mr-reason"> 看得见你，但键鼠一直没动</div></div>`;
  }

  /** 吃饭打卡在时间线里的一行（主人自己记的，不推测、不评判） */
  function mealRow(ev) {
    return `<div class="mr-event">
      <div class="mr-event-head">
        <span class="mr-time">🕒 ${esc(fmtClock(ev.ts))}</span>
        <span class="mr-change">🍚 ${esc(ev.slot || "吃饭")}</span>
      </div>
      <div class="mr-reason"> ${esc(ev.what || "")}</div></div>`;
  }

  /** 旁听在时间线里的一行（只报"听了多久、记了多少句"，内容归会议纪要那边） */
  function meetingRow(ev) {
    const min = Math.max(1, Math.round((ev.durMs || 0) / 60000));
    const t = new Date(ev.startedAt || ev.ts);
    const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    return `<div class="mr-event">
      <div class="mr-event-head">
        <span class="mr-time">🕒 ${hm}</span>
        <span class="mr-change">🎧 旁听 ${min} 分钟</span>
        <span class="mr-delta">${ev.lines || 0} 句</span>
      </div>
      <div class="mr-reason"> ${esc(ev.title || "会议")}${ev.file ? "（纪要已存盘）" : ""}</div></div>`;
  }

  const anyRow = (ev) =>
    ev.kind === "gaze"
      ? gazeRow(ev)
      : ev.kind === "meal"
        ? mealRow(ev)
        : ev.kind === "meeting"
          ? meetingRow(ev)
          : eventRow(ev);

  /** 状态条：把"到底在不在识别主人 / 会不会锁屏"摆到明面上 */
  function statusChips() {
    const chips = [];
    const interval =
      reportData && reportData.intervalMinutes ? reportData.intervalMinutes : 3;
    chips.push(
      `<span class="mr-chip ${camEnabled ? "on" : ""}">📷 识别${camEnabled ? `开 · ${interval} 分钟` : "关"}</span>`,
    );

    const enrolled = !!(ownerState && ownerState.enrolled);
    chips.push(
      `<span class="mr-chip">👤 ${enrolled ? `认主 ${ownerState.refCount}/3` : "未认主"}</span>`,
    );

    if (enrolled) {
      let t = "🧿 还没识别过";
      if (cachedPresence) {
        const at = cachedPresence.ts ? ` · ${fmtClock(cachedPresence.ts)}` : "";
        t = cachedPresence.ownerPresent
          ? `✅ 看到主人${at}`
          : cachedPresence.noFace
            ? `画面里没人${at}`
            : `🙈 不是主人${at}`;
      }
      chips.push(`<span class="mr-chip">${t}</span>`);
      // 身份是本机人脸识别判的，还是回退给云端模型的
      const fs = window.dshFace ? window.dshFace.state() : null;
      if (fs && fs.ready && window.dshFace.hasRefs()) {
        chips.push(`<span class="mr-chip on">🧬 本机人脸识别</span>`);
      } else if (fs && fs.error) {
        chips.push(`<span class="mr-chip">🧬 人脸识别未就绪</span>`);
      }
    }

    const g = guardState || {};
    chips.push(
      g.enabled
        ? `<span class="mr-chip on">🔒 应用锁屏 · ${g.locked ? "已锁定" : "守家中"}</span>`
        : `<span class="mr-chip">🔓 应用锁屏关${g.hasPassword ? "" : "（未设密码）"}</span>`,
    );

    if (enrolled && ownerState.guardEnabled)
      chips.push(`<span class="mr-chip">🛡 系统锁屏开</span>`);

    // 正在听歌（听歌点评开着且真的读到了在放的歌才显示，遵守"只显示有数据的条目"）
    const np = musicLive && musicLive.nowPlaying;
    if (np && np.title) {
      chips.push(
        `<span class="mr-chip on">🎵 正在听：${esc(np.title)}${np.artist ? " · " + esc(np.artist) : ""}</span>`,
      );
    }
    return chips.join("");
  }

  function statusStripHtml() {
    return `<div class="mr-dist" id="moodStatusStrip">${statusChips()}</div>`;
  }

  /** 只刷新状态条：探测结论每几秒来一次，整块重绘会丢滚动位置 */
  function renderStatusStrip() {
    const el = document.getElementById("moodStatusStrip");
    if (el && moodPanel && !moodPanel.hidden) el.innerHTML = statusChips();
  }

  function recordHtml() {
    const r = reportData;
    if (!r) return `<div class="mr-loading">情绪监测未启动</div>`;

    const counts = Object.entries(r.todayCounts || {}).sort(
      (a, b) => b[1] - a[1],
    );
    const dist = counts.length
      ? counts
          .map(
            ([k, v]) =>
              `<span class="mr-chip">${MOOD_EMOJI[k] || k}${k} ×${v}</span>`,
          )
          .join("")
      : `<span class="mr-chip">今日还没有情绪样本</span>`;

    // 今日记录：只放今天的；今天没有就明说，不拿往天的记录来凑
    const today = r.todayEvents || [];
    const todayHtml = today.length
      ? today.map(anyRow).join("")
      : `<div class="mr-empty">今天还很平稳，没有情绪波动</div>`;

    // 历史记录：往天的（最新在前，按天分组，每组可折叠）
    const past = r.pastEvents || [];
    const groups = groupByDay(past);
    const historyHtml = groups.length
      ? groups
          .map(([day, list]) => {
            const open = !collapsed[`day:${day}`]; // 日期分组默认展开
            return `<div class="mr-dayhead" data-toggle="day:${esc(day)}">
              <span class="mr-caret">${open ? "&#9662;" : "&#9656;"}</span>
              <span class="mr-day-label">${esc(day)}</span>
              <span class="mr-day-count">${list.length} 次</span>
            </div>
            <div class="mr-events"${open ? "" : " hidden"}>${list.map(anyRow).join("")}</div>`;
          })
          .join("")
      : `<div class="mr-empty">还没有更早的记录</div>`;

    const cur = r.current && !r.current.noFace ? r.current : null;
    const nowLine = cur
      ? `当前心情：${MOOD_EMOJI[cur.emotion] || ""}${cur.emotion}（valence ${cur.valence.toFixed(2)}）`
      : "当前心情：暂无画面样本";
    const yawn = r.yawn || { today: 0, total: 0 };
    // 听歌点评（可选功能，默认关）：今天有数据才显示，没听歌不占位
    const music = r.music || { today: 0, total: 0 };

    // 吃饭打卡（主人自己记的）：今日几顿 + 明细。今天没记就直说，别占位
    const meals = r.meal || { today: 0, total: 0, todayList: [] };
    const mealDist = meals.todayList.length
      ? meals.todayList
          .map(
            (m) =>
              `<span class="mr-chip">🍚 ${esc(m.slot)}·${esc(m.what)}</span>`,
          )
          .join("")
      : `<span class="mr-chip">今天还没记（鲸鱼身上 🍚 泡泡 / 托盘菜单都能记）</span>`;

    const todayOpen = !collapsed.today;
    const historyOpen = !collapsed.history;

    return `
      ${statusStripHtml()}
      <div class="mr-now">${nowLine}</div>
      <div class="mr-card">
        <div class="mr-card-title">今日概览</div>
        <div class="mr-field-label">情绪分布<span class="mr-unit">（${r.todaySamples || 0} 个样本）</span></div>
        <div class="mr-dist">${dist}</div>
        <div class="mr-field-label">行为统计</div>
        <div class="mr-dist">
          <span class="mr-chip">${yawn.emoji || "🥱"} 今日哈欠 ×${yawn.today}</span>
          ${music.today > 0 ? `<span class="mr-chip">🎵 今日听歌 ×${music.today}</span>` : ""}
          ${(r.actions || [])
            .filter((a) => a.today > 0) // 只看今天做过的；没做的别占位
            .map(
              // emoji 由主进程按声明（signals.js 的 report.emoji）下发，界面不写死
              (a) =>
                `<span class="mr-chip">${a.emoji ? a.emoji + " " : ""}${a.name} 今日 ×${a.today}</span>`,
            )
            .join("")}
        </div>
      </div>
      <div class="mr-card">
        <div class="mr-card-title">🍚 今日饮食<span class="mr-badge">${meals.today} 顿</span></div>
        <div class="mr-dist">${mealDist}</div>
      </div>
      <div class="mr-card">
        <div class="mr-card-title">📔 今日心情记录<span class="mr-badge">${today.length} 次</span><span class="mr-caret" data-toggle="today">${todayOpen ? "&#9662;" : "&#9656;"}</span></div>
        <div${todayOpen ? "" : " hidden"}>
          <div class="mr-events">${todayHtml}</div>
        </div>
      </div>
      <div class="mr-card">
        <div class="mr-card-title">🕰 历史记录<span class="mr-badge">${past.length} 次</span><span class="mr-caret" data-toggle="history">${historyOpen ? "&#9662;" : "&#9656;"}</span></div>
        <div${historyOpen ? "" : " hidden"}>
          ${historyHtml}
        </div>
      </div>
      <div class="mr-hint">🔒 应用锁屏是"壁纸式"覆盖层（不是系统锁屏）：人离开后盖住屏幕，输密码或回到镜头前刷脸即可解锁；Alt+Tab / 任务管理器仍能绕过。开关在右上角 ⚙ 设置里。</div>
      <div class="mr-hint">💡 推测仅基于时间线和电脑工作状态；以后接通屏幕内容后，鲸鱼能猜得更准。</div>`;
  }

  /** 历史记录按天分组（入参已是最新在前，所以分组顺序天然是倒序） */
  function groupByDay(events) {
    const map = new Map();
    for (const e of events) {
      const key = new Date(e.ts).toLocaleDateString("zh-CN", {
        month: "long",
        day: "numeric",
        weekday: "short",
      });
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    return [...map.entries()];
  }

  // ---- 渲染 / 数据刷新 -------------------------------------------------------

  function renderPanel() {
    if (!moodPanelBody) return;
    moodPanelBody.innerHTML = recordHtml();
    bindRecord();
  }

  async function refreshAll() {
    if (!window.dshPet) return;
    try {
      reportData = await window.dshPet.emotionReport();
    } catch {
      reportData = null;
    }
    try {
      guardState = await window.dshPet.guardStatus();
    } catch {
      guardState = null;
    }
    try {
      ownerState = await window.dshPet.ownerInfo();
    } catch {
      ownerState = null;
    }
    // 听歌状态（🎵 正在听：xxx 状态条用；没开听歌点评/读不到就置空，状态条不显示）
    try {
      const mu = await window.dshPet.musicConfig();
      musicLive = mu && mu.status ? mu.status : null;
    } catch {
      musicLive = null;
    }
    if (reportData) {
      camEnabled = reportData.enabled !== false;
      // 报告里的最近样本也带身份结论，先用它兜底（之后由实时推送刷新）
      const cur = reportData.current;
      if (cur && ownerState && ownerState.enrolled) {
        cachedPresence = {
          noFace: !!cur.noFace,
          ownerPresent: cur.ownerPresent === true,
          ts: cur.ts,
        };
      }
    }
    renderPanel();
  }

  async function showMoodPanel() {
    if (!moodPanel) return;
    moodPanel.hidden = false;
    if (moodPanelBody)
      moodPanelBody.innerHTML = `<div class="mr-loading">🐋 正在翻鲸鱼日记…</div>`;
    await refreshAll();
  }

  // 面板开着时每 5 秒刷一次听歌状态：切歌/暂停后"🎵 正在听"状态条要跟得上，
  // 不能只在开面板那一刻取一次（关面板时 interval 空转，只查一个 hidden 字段，开销可忽略）
  if (window.dshPet) {
    setInterval(async () => {
      if (!moodPanel || moodPanel.hidden) return;
      try {
        const mu = await window.dshPet.musicConfig();
        musicLive = mu && mu.status ? mu.status : null;
      } catch {
        musicLive = null;
      }
      renderStatusStrip();
    }, 5000);
  }

  /** 关掉心情气泡（展开泡泡菜单时调用，免得文字压在泡泡上） */
  function hideBubble() {
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
    if (moodBubble) moodBubble.hidden = true;
  }

  /** 折叠交互：卡片标题里带 data-toggle 的，以及历史日期分组（.mr-dayhead） */
  function bindRecord() {
    moodPanelBody
      .querySelectorAll(".mr-card-title, .mr-dayhead")
      .forEach((el) => {
        const holder = el.dataset.toggle
          ? el
          : el.querySelector("[data-toggle]");
        if (!holder) return; // "今日概览"卡片不折叠
        el.classList.add("mr-toggle");
        el.addEventListener("click", () => {
          const key = holder.dataset.toggle;
          collapsed[key] = !collapsed[key];
          renderPanel();
        });
      });
  }

  window.dshPetEmotion = {
    showMoodPanel,
    hideBubble,
    showBubble: showMoodBubble,
  };
})();
