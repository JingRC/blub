// renderer/onboarding.js — 首启动认主引导窗口
//
// 流程：点"开始认主" → 3-2-1 倒计时 → 拍摄 → 重复 3 次（每次可调整姿态）
//       → 3 张参考照经 IPC 存入 data/owner.json → 通知主进程完成 → 自动关窗。
// 中途关窗/点跳过：不强制，之后可从 心情 → 认主登记 再进。

(function () {
  const video = document.getElementById("video");
  const countdownEl = document.getElementById("countdown");
  const flashEl = document.getElementById("flash");
  const statusEl = document.getElementById("status");
  const mainBtn = document.getElementById("mainBtn");
  const skipBtn = document.getElementById("skipBtn");
  const dots = [0, 1, 2].map((i) => document.getElementById("dot" + i));

  const POSES = ["请正对镜头～", "稍微侧一点头～", "最后一张，自然一点～"];
  const REF_WIDTH = 160; // 参考照宽度（小图省空间，识别时省 token）

  let stream = null;
  let canvas = document.createElement("canvas");
  let running = false;

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      video.srcObject = stream;
      mainBtn.disabled = false;
      setStatus("摄像头就绪，点下方按钮开始");
    } catch (err) {
      setStatus("❌ 摄像头不可用（" + err.name + "）。请检查系统相机权限后重开窗口。");
      mainBtn.textContent = "摄像头不可用";
    }
  }

  function setStatus(text) { statusEl.textContent = text; }

  function capture() {
    if (!video.videoWidth) return null;
    const scale = REF_WIDTH / video.videoWidth;
    canvas.width = REF_WIDTH;
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.6);
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function countdown(n) {
    countdownEl.classList.add("show");
    for (let i = n; i >= 1; i--) {
      countdownEl.textContent = i;
      await sleep(800);
    }
    countdownEl.classList.remove("show");
    flashEl.classList.remove("go");
    void flashEl.offsetWidth;
    flashEl.classList.add("go");
  }

  mainBtn.addEventListener("click", async () => {
    if (running) return;
    running = true;
    mainBtn.disabled = true;

    for (let i = 0; i < 3; i++) {
      dots.forEach((d, j) => {
        d.classList.toggle("done", j < i);
        d.classList.toggle("now", j === i);
      });
      setStatus(`第 ${i + 1}/3 张：${POSES[i]}`);
      mainBtn.textContent = "拍摄中…";
      await countdown(3);
      const dataUrl = capture();
      if (!dataUrl) {
        setStatus("❌ 没抓到画面，摄像头可能被占了，重试一次");
        running = false;
        mainBtn.disabled = false;
        mainBtn.textContent = "重新开始";
        return;
      }
      const res = await window.dshPet.emotionEnroll(dataUrl);
      if (res && res.done) {
        dots.forEach((d) => { d.classList.remove("now"); d.classList.add("done"); });
        setStatus("✅ 认主完成！鲸鱼已经记住你了");
        mainBtn.textContent = "完成 🎉";
        if (stream) stream.getTracks().forEach((t) => t.stop());
        // 通知主进程（鲸鱼庆祝 + 关闭本窗口）
        window.dshPet.enrollDone();
        setTimeout(() => window.close(), 900);
        return;
      }
    }
    setStatus("✅ 参考照已存好，下次启动不再认主");
    mainBtn.textContent = "完成";
    running = false;
  });

  skipBtn.addEventListener("click", () => window.close());

  startCamera();
})();
