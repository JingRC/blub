// renderer/lock.js — 锁定覆盖层交互（会生气的看家鲸鱼）
//
// 解锁路径：
//   1) 输入密码（本文件提交给主进程校验）
//   2) 摄像头识别到主人回来（主进程 guard 收到在场结论后自动解锁并销毁本窗口）
//
// 情绪状态（跟着每次身份结论切）：
//   waiting     等主人回来，台词轮换卖萌
//   noFace      画面里没人 → 探头喊人（带 Z 打呼，像睡着了）
//   stranger    有人但不是主人（相似度明显不像）→ 泛红、抖屏、怒眉竖眼
//   confirming  看着像主人，但还没连续确认 → 底色仍然保持蓝的，鲸鱼探头看仔细些
//   owner       确认到主人了（真的开门 / 看家满 30 分钟播告别）→ 绿底 + 跳两下
// 状态只影响表现，不影响锁定与解锁逻辑；本窗口始终不提供关闭入口。
//
// 一条线的设计：没看到你 = 蓝底；看着像你 = 还是蓝底（只探头确认）；
// 连续两眼都确认是你 = 绿底 + 鲸鱼跳两下 + "找到主人啦，我这就开门～"。

(function () {
  const pw = document.getElementById("pw");
  const msg = document.getElementById("msg");
  const faceStatus = document.getElementById("faceStatus");
  const sayEl = document.getElementById("say");
  const clock = document.getElementById("clock");
  const dateEl = document.getElementById("date");

  function tick() {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
    dateEl.textContent = now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  }
  tick();
  setInterval(tick, 1000);

  // ---- 海底气泡：让它看起来像个水缸 ----
  (function bubbles() {
    const host = document.getElementById("bubbles");
    for (let i = 0; i < 12; i++) {
      const b = document.createElement("i");
      const size = 6 + Math.random() * 16;
      b.style.left = `${Math.random() * 100}%`;
      b.style.width = `${size}px`;
      b.style.height = `${size}px`;
      b.style.animationDuration = `${9 + Math.random() * 10}s`;
      b.style.animationDelay = `${Math.random() * 9}s`;
      host.appendChild(b);
    }
  })();

  // ---- 看家心情 + 台词 ----
  const LINES = {
    waiting: [
      "主人你什么时候回来呀～我在这儿等着呢",
      "电脑我已经守好了，就等你回来夸我一句",
      "刚刚有个想动鼠标的人，被我瞪回去了（骄傲）",
      "悄悄说：我连水都没敢喝，怕错过你回来的第一眼",
    ],
    noFace: [
      "主人不见了……主人你去哪了呀？",
      "探头看不到人，你把电脑交给鲸鱼守着了吗？",
      "喂——是主人吗？不露脸我可不开门哦",
    ],
    stranger: [
      "你不是我的主人，不要过来啊！！",
      "站住！这不是你的电脑，退后退远点！",
      "哼！再靠近我就喷水了，我说到做到！",
      "我记住你的脸了，等主人回来我全告诉他！",
    ],
    confirming: [
      "好像是你…鲸鱼再确认一眼就开门",
      "看着挺像你的，别动，就一眼～",
    ],
    owner: [
      "找到主人啦，我这就开门～",
    ],
  };
  const ROTATE_MS = { waiting: 5200, noFace: 4200, stranger: 3200, confirming: 3000, owner: 0 };
  const ANGRY_HOLD_MS = 8000; // 生气至少维持这么久，免得识别一抖就变成卖萌
  // 相似度低于这个值才算"别人"。贴着门槛（face.js 门口 0.55）的票更像主人自己角度/光线差，
  // 跟 guard.js 里的 AMBIGUOUS_SIM 保持一致。
  const STRANGER_MAX_SIM = 0.45;

  let mood = "waiting";
  let lineIdx = 0;
  let rotateTimer = null;
  let angryUntil = 0;
  let ownerConfirmed = false; // 主进程确认到主人了（绿底已亮，别再切回去）
  let hardHint = "";   // 硬锁兜底提示（拼在状态行后面）
  let faceUnlockOff = false; // 本机人脸识别没起来 → 只能密码解锁，状态行要说实话

  function renderSay() {
    const list = LINES[mood] || LINES.waiting;
    sayEl.textContent = list[lineIdx % list.length];
  }

  function scheduleRotate() {
    if (rotateTimer) { clearTimeout(rotateTimer); rotateTimer = null; }
    const ms = ROTATE_MS[mood];
    if (!ms) return; // owner 只有一句，不轮换
    rotateTimer = setTimeout(() => {
      lineIdx++;
      renderSay();
      scheduleRotate();
    }, ms);
  }

  const FACE_LINE = {
    waiting: () =>
      faceUnlockOff
        ? `刷脸解锁暂时不可用，请输密码${hardHint}`
        : `摄像头识别中… 回到镜头前会自动解锁${hardHint}`,
    noFace: () => `主人不见了…你去哪儿了呀${hardHint}`,
    stranger: () => "⚠️ 这张脸不是主人！屏幕我不开",
    confirming: () => "👀 好像是你…再确认一眼就开门",
    owner: () => "✅ 找到主人啦，正在开门…",
  };

  function setMood(next) {
    if (next === mood) {
      renderSay();
      return;
    }
    mood = next;
    document.body.dataset.mood = mood;
    if (mood === "stranger") {
      // 抖一下 + 更换台词，像真被吓到又生气
      document.body.classList.remove("shake-screen");
      void document.body.offsetWidth;
      document.body.classList.add("shake-screen");
      lineIdx = 0;
    }
    renderSay();
    scheduleRotate();
    faceStatus.textContent = (FACE_LINE[mood] || FACE_LINE.waiting)();
  }

  // 主进程推送的身份结论。注意"看着像主人"还不算数：主进程要连续两眼命中才真的开门，
  // 所以这一眼只把鲸鱼切到"确认中"（底色仍是蓝的）；绿底由 pet:owner-confirmed 接管。
  if (window.dshPet.onPresenceSample) {
    window.dshPet.onPresenceSample((p) => {
      if (!p || ownerConfirmed) return; // 已经确认开门了，别再往回切
      if (p.ownerPresent === true) { setMood("confirming"); return; }
      // 相似度贴着门槛的票不算"别人"：主人自己侧脸/逆光实测就是 0.49，
      // 以前会冲自己主人发红脸骂"你不是我的主人"。跟 guard 用同一个门槛。
      const sim = Number(p.similarity) || 0;
      if (!p.noFace && sim < STRANGER_MAX_SIM) {
        // 画面里确实有人，而且明显不像主人 → 生气（并保持一会儿）
        angryUntil = Date.now() + ANGRY_HOLD_MS;
        setMood("stranger");
        return;
      }
      // 画面里没人：生气期内不立刻改口（人可能只是转过头/低头）
      if (Date.now() < angryUntil) { setMood("stranger"); return; }
      if (p.noFace) setMood("noFace");
      // 有脸但看不清是不是主人（相似度卡在门槛边上）：保持现状，不冤枉也不乱认
    });
  }

  let busy = false;

  async function submit() {
    const value = pw.value;
    if (!value || busy) return;
    busy = true;
    msg.textContent = "";
    try {
      const r = await window.dshPet.guardUnlock(value);
      if (r && r.ok) {
        msg.style.color = "#7fffd4";
        msg.textContent = "解锁成功，欢迎回来～";
        setMood("owner");
        // 主进程会销毁本窗口
      } else {
        msg.style.color = "#ffb3b3";
        msg.textContent = (r && r.error) || "密码不对，再试一次";
        pw.value = "";
        document.body.classList.remove("shake");
        void document.body.offsetWidth;
        document.body.classList.add("shake");
      }
    } catch (err) {
      msg.style.color = "#ffb3b3";
      msg.textContent = "解锁请求失败：" + (err.message || err);
    } finally {
      busy = false;
      pw.focus();
    }
  }

  document.getElementById("unlockBtn").addEventListener("click", submit);
  pw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });
  document.getElementById("focusBtn").addEventListener("click", () => pw.focus());

  // 锁定期保持聚焦，键盘输入直接进密码框
  document.addEventListener("keydown", (e) => {
    if (document.activeElement !== pw && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      pw.focus();
    }
  });

  // 屏蔽右键菜单与开发者工具快捷键
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "F12" || (e.ctrlKey && e.shiftKey && (k === "I" || k === "J" || k === "C")) || (e.ctrlKey && k === "U")) {
      e.preventDefault();
    }
  });

  // 初始化：确认锁定态 + 硬锁兜底倒计时
  window.dshPet.guardLockInfo().then((info) => {
    if (!info || !info.locked) {
      faceStatus.textContent = "已解锁";
      return;
    }
    if (!info.hasPassword) {
      hardHint = "（未设密码：只能靠刷脸解锁）";
    } else if (info.hardLockAfterS > 0) {
      const left = info.hardLockAt
        ? Math.max(0, Math.round((info.hardLockAt - Date.now()) / 60000))
        : Math.round(info.hardLockAfterS / 60);
      hardHint = `（${left} 分钟内没人解锁将追加系统锁屏兜底）`;
    }
    faceUnlockOff = info.faceUnlock === false; // 身份只认本机人脸识别，它没起来就别承诺刷脸
    setMood("waiting");
    faceStatus.textContent = FACE_LINE.waiting();
    pw.focus();
  }).catch(() => {});

  // ---- 刷脸解锁：终于等到主人（开心告别动画）----
  let farewellShown = false;

  // 锁定状态变化（例如刚被认出主人）时刷新状态行
  if (window.dshPet.onGuardStatus) {
    window.dshPet.onGuardStatus((s) => {
      if (!s) return;
      if (s.locked === false && !farewellShown) faceStatus.textContent = "已解锁，正在打开…";
    });
  }

  /** 看家时长说人话：40 秒 / 3 分 20 秒 / 1 小时 5 分 */
  function fmtDur(ms) {
    const s = Math.max(1, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) {
      const rs = s % 60;
      return rs ? `${m} 分 ${rs} 秒` : `${m} 分钟`;
    }
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
  }

  /** 撒几颗星星，像鲸鱼在甩尾巴庆祝 */
  function sparkleBurst() {
    const host = document.getElementById("sparkles");
    if (!host || host.childElementCount) return;
    const emojis = ["✨", "🎉", "⭐", "💫", "🐟", "💧"];
    for (let i = 0; i < 10; i++) {
      const el = document.createElement("span");
      el.textContent = emojis[i % emojis.length];
      el.style.left = `${8 + Math.random() * 84}%`;
      el.style.bottom = `${10 + Math.random() * 45}%`;
      el.style.animationDelay = `${(Math.random() * 0.9).toFixed(2)}s`;
      host.appendChild(el);
    }
  }

  if (window.dshPet.onUnlockAnim) {
    window.dshPet.onUnlockAnim(({ guardMs }) => {
      const box = document.getElementById("farewell");
      if (!box || farewellShown) return;
      farewellShown = true;
      ownerConfirmed = true;
      const dur = document.getElementById("farewellDur");
      if (dur) dur.textContent = fmtDur(guardMs);
      setMood("owner");
      box.hidden = false;
      document.querySelector(".box").hidden = true; // 密码框该退场了
      document.querySelector(".hint").hidden = true;
      sparkleBurst();
    });
  }

  // 刷脸确认到主人（连续两眼命中）→ 这才是"真正的找到主人"那一刻：
  // 绿底 + 鲸鱼跳两下 + "找到主人啦，我这就开门～"，主进程会留一点时间让它演完再撤。
  if (window.dshPet.onOwnerConfirmed) {
    window.dshPet.onOwnerConfirmed(() => {
      ownerConfirmed = true;
      setMood("owner");
    });
  }

  scheduleRotate();
  renderSay();
})();