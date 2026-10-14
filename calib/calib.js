// calib/calib.js — 摄像头 + 本机几何量采集层（识别实验室窗口共用）
//
// 只干三件事：开摄像头、每 700ms 刷一次实时读数、给上层提供 measure()/snap()。
// 演示流程（选哪一行、演几段、怎么存）都在 feedback.js 里；
// 几何量算法复用桌宠的 renderer/face.js（同一份 MAR/EAR，两边不会走偏）。

(function () {
  const video = document.getElementById("preview");
  const statusEl = document.getElementById("status");
  const metricsEl = document.getElementById("metrics");
  const stateEl = document.getElementById("state");

  let previewTimer = null;
  let tickBusy = false; // human 的 wasm 后端不并发安全：一次只跑一个识别

  function showMetrics(g) {
    if (!g) return;
    metricsEl.textContent =
      `嘴=${g.marIn == null ? "-" : g.marIn} / ${g.marOut == null ? "-" : g.marOut}` +
      `　眼=${g.ear == null ? "-" : g.ear}　脸=${g.faces}`;
  }

  /** 量一次几何量（调用方要自己保证不并发；这里也兜一层锁） */
  async function measure() {
    if (tickBusy || !video.videoWidth) return null;
    tickBusy = true;
    try {
      const g = await window.dshFace.metrics(video);
      showMetrics(g);
      return g;
    } catch (err) {
      console.warn("[lab] 测量失败:", err.message);
      return null;
    } finally {
      tickBusy = false;
    }
  }

  /** 抓一帧当前画面（演示时留作参考图，160px 小图省体积） */
  function snap() {
    if (!video.videoWidth) return null;
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = Math.round((video.videoHeight / video.videoWidth) * 160);
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  }

  // 没在演示时也隔 700ms 报一下当前读数，方便对镜头位置
  function startPreview() {
    if (previewTimer) return;
    previewTimer = setInterval(() => measure().catch(() => {}), 700);
  }

  const bootPromise = (async function boot() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      video.srcObject = stream;
      if (!video.videoWidth) {
        await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
      }
      statusEl.textContent = "正在加载人脸模型…（第一次要几秒）";
      const ok = await window.dshFace.init();
      const st = window.dshFace.state();
      if (!ok) {
        statusEl.textContent = `人脸模型加载失败：${st.error || "未知"}`;
        stateEl.textContent = "人脸模型不可用";
        return;
      }
      statusEl.textContent = `就绪（backend=${st.backend}）`;
      stateEl.textContent = `人脸模型就绪（backend=${st.backend}）`;
      startPreview();
    } catch (err) {
      statusEl.textContent = `摄像头打不开：${err.name}`;
      stateEl.textContent = "摄像头不可用";
      console.warn("[lab] camera unavailable:", err.name, err.message);
    }
  })();

  // 上层（feedback.js）要等摄像头 + 模型就绪
  window.dshTool = { video, measure, snap, showMetrics, ready: bootPromise };

  document.addEventListener("keydown", (e) => {
    // 演示中途别让 Esc 把窗口关掉（演示数据就白采了）
    if (e.key === "Escape" && !window.dshTool.busyDemo) window.close();
  });
})();