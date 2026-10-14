// renderer/ask-card.js —— "秒答"卡片的渲染层
//
// 只干三件事：把主进程算好的答案摆上去、把卡片高度调成刚好够、把 ✕ 接上。
// 答案由主进程（ask-hub.js）产出：先查项目知识包，不够再翻 D:\company 的代码/文档。

(function () {
  const innerEl = document.getElementById("inner");
  const roomEl = document.getElementById("room");
  const srcEl = document.getElementById("src");
  const msEl = document.getElementById("ms");
  const closeBtn = document.getElementById("close");

  /**
   * 按内容量算这张卡需要多高，报给主进程去 setBounds。
   * 关键点：必须量 **#inner**（它的高度只由文字决定），不能量 .body——
   * .body 是 flex:1 撑满窗口的，量它永远等于当前窗口高度，卡就永远不会伸缩。
   * 常量 16 = .body 的上下内边距（8 + 6）+ 卡片上下 1px 边框。
   */
  function fitHeight() {
    if (!window.dshPet || !window.dshPet.resizeAskCard) return;
    const head = document.querySelector(".head").offsetHeight;
    const foot = document.querySelector(".foot").offsetHeight;
    const need = Math.ceil(head + foot + innerEl.offsetHeight + 16);
    window.dshPet.resizeAskCard(Math.max(96, Math.min(340, need)));
  }

  function setBody(text, cls) {
    document.body.classList.remove("busy", "err");
    if (cls) document.body.classList.add(cls);
    innerEl.textContent = text || "";
    fitHeight();
  }

  /** 查资料中：立刻给反馈（模型要几秒，不给提示主人会以为没点上） */
  function renderBusy() {
    roomEl.textContent = "正在听最近那句…";
    srcEl.textContent = "";
    msEl.textContent = "";
    innerEl.textContent = "";
    const spin = document.createElement("span");
    spin.className = "spin";
    innerEl.appendChild(spin);
    innerEl.appendChild(document.createTextNode("查项目资料中（知识包 → 代码）…"));
    document.body.classList.remove("err");
    document.body.classList.add("busy");
    fitHeight();
  }

  function renderResult(msg) {
    // 失败时别写成"没听出明确的问题"——那是在说"同事没提问"，跟"这次没查成"是两回事，
    // 会让人误判成旁听没听到话。
    roomEl.textContent = msg && msg.ok ? msg.room || "（没听出明确的问题）" : "这次没查成";
    roomEl.title = roomEl.textContent;
    if (msg && msg.ok) {
      setBody((msg.answer || "").trim() || "（模型没给出内容）", null);
      const src = (msg.sources || []).join("、");
      srcEl.textContent = src ? `来源：${src}` : "来源：知识包";
      srcEl.title = srcEl.textContent;
      msEl.textContent = msg.ms ? `${(msg.ms / 1000).toFixed(1)}s` : "";
    } else {
      setBody((msg && msg.error) || "没查出来", "err");
      srcEl.textContent = "";
      msEl.textContent = "";
    }
  }

  closeBtn.addEventListener("click", () => {
    if (window.dshPet && window.dshPet.closeAskCard) window.dshPet.closeAskCard();
  });

  if (window.dshPet && window.dshPet.onAskCard) {
    window.dshPet.onAskCard((msg) => {
      if (!msg) return;
      if (msg.type === "busy") renderBusy();
      else renderResult(msg);
    });
  }

  // 字体/换行算完再量一次（首帧字体没就位时量出来会偏小）
  fitHeight();
  window.addEventListener("load", fitHeight);
})();