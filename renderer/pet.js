// renderer/pet.js - 呆萌鲸鱼 + 真实泡泡 + 拖动

(function () {
  const stage = document.getElementById("stage");
  const statusEl = document.getElementById("status");
  const bubbleText = document.getElementById("bubbleText");
  const bubbleMenu = document.getElementById("bubbleMenu");
  const whale = document.getElementById("whale");

  const BUBBLE = {
    idle: "",
    thinking: "?",
    tool: "",
    approval: "!",
    streaming: "…",
    done: "✓",
    error: "!",
    disconnected: "··",
  };

  const STATUS = {
    idle: "空闲 · 漂浮中",
    thinking: "思考中 · 喷水…",
    tool: "执行工具 · 尾鳍摆动",
    approval: "等待你的批准",
    streaming: "输出中…",
    done: "完成 · 跃出水面",
    error: "出错了 · 翻肚皮",
    disconnected: "未连接 · 127.0.0.1:3080",
  };

  // ============================================================
  // 尾巴自然摆动 - JavaScript 动画（变量提前声明，避免 TDZ 错误）
  // ============================================================
  const tailGroup = document.querySelector(".tail-group");
  let tailAnimationId = null;
  let tailSpeed = 0.5; // 默认摆动速度
  let tailMaxAngle = 15; // 默认最大角度
  let tailPaused = false; // 抚摸/挣扎时暂停 JS 尾巴（由 CSS 接管）

  // 根据状态调整尾巴摆动速度（函数声明提升，但需要在变量声明后调用）
  function updateTailAnimation(state) {
    if (state === "tool") {
      tailSpeed = 1.2;
      tailMaxAngle = 20;
    } else {
      tailSpeed = 0.5;
      tailMaxAngle = 15;
    }
  }

  function pauseTailAnimation() {
    tailPaused = true;
    if (tailAnimationId) {
      cancelAnimationFrame(tailAnimationId);
      tailAnimationId = null;
    }
  }

  function resumeTailAnimation() {
    tailPaused = false;
    if (tailAnimationId) return;
    // 重新启动
    startTailAnimationLoop();
  }

  function startTailAnimationLoop() {
    let angle = 0;
    let direction = 1;
    // 尾巴只是缓慢摆动，没必要跟 60fps 同步：限制到 ~20fps。
    // 这样 JS 唤醒次数降到 1/3、样式写入也少，常驻 CPU 明显下降，肉眼看不出差别。
    const FRAME_MS = 50;
    let lastTs = 0;

    function animate(ts) {
      if (tailPaused) {
        tailAnimationId = null;
        return;
      }
      // 离上次真正画了一帧还不够 FRAME_MS，这帧跳过（不写样式）
      if (ts - lastTs < FRAME_MS) {
        tailAnimationId = requestAnimationFrame(animate);
        return;
      }
      // 步子按真实经过时间缩放：节流后摆动速度和 60fps 时一样，不是慢三倍
      const elapsed = ts - lastTs;
      lastTs = ts;
      const step = Math.min(4, elapsed / 16.7);
      angle += tailSpeed * direction * step;

      if (angle >= tailMaxAngle) {
        angle = tailMaxAngle;
        direction = -1;
      } else if (angle <= -tailMaxAngle) {
        angle = -tailMaxAngle;
        direction = 1;
      }

      if (tailGroup) {
        tailGroup.style.transform = `rotate(${angle}deg)`;
      }

      tailAnimationId = requestAnimationFrame(animate);
    }

    tailAnimationId = requestAnimationFrame(animate);
  }

  function startTailAnimation() {
    startTailAnimationLoop();
  }

  // ============================================================
  // 状态管理
  // ============================================================
  function setState(state) {
    if (!state || !STATUS[state]) state = "idle";
    stage.dataset.state = state;
    statusEl.textContent = STATUS[state];
    if (bubbleText) bubbleText.textContent = BUBBLE[state] || "";
    updateTailAnimation(state);
  }

  // 初始化状态（现在 tailSpeed/tailMaxAngle 已声明，不会 TDZ）
  setState("disconnected");

  // 启动尾巴动画
  startTailAnimation();

  // ============================================================
  // 换装：拉当前装扮并渲染；设置窗口 / 泡泡菜单改动后由主进程广播实时更新
  // ============================================================
  if (window.dshPetOutfit) {
    if (window.dshPet && window.dshPet.outfitGet) {
      window.dshPet.outfitGet().then((s) => window.dshPetOutfit.apply(s)).catch(() => {});
    }
    if (window.dshPet && window.dshPet.onOutfit) {
      window.dshPet.onOutfit((s) => window.dshPetOutfit.apply(s));
    }
  }

  // ============================================================
  // 拖动系统 - 绝对坐标定位（平滑无抖动）
  // ============================================================
  let isDragging = false;
  let dragStartScreenX = 0;
  let dragStartScreenY = 0;
  let dragWindowX = 0;
  let dragWindowY = 0;
  let dragMoved = false;
  let dragRAF = null;
  let pendingTargetX = null;
  let pendingTargetY = null;
  let dragAnimTimer = null;
  let dragAnimType = null; // 'struggling' | 'petted' | null
  const DRAG_THRESHOLD = 3;

  // 停止拖动动画
  function stopDragAnimation() {
    if (dragAnimTimer) {
      clearTimeout(dragAnimTimer);
      dragAnimTimer = null;
    }
    if (dragAnimType) {
      whale.classList.remove("struggling", "petted");
      dragAnimType = null;
      resumeTailAnimation();
    }
  }

  // 开始或切换拖动动画（拖动期间持续；每 2.5~3.5 秒可随机换一种）
  function startDragAnimation() {
    if (dragAnimType) return; // 已有动画在跑
    // 随机选择挣扎或抚摸
    dragAnimType = "pending";
    applyDragAnim(Math.random() < 0.5 ? "struggling" : "petted");
  }

  function applyDragAnim(type) {
    // 清除旧计时器和动画类（但不恢复尾巴，避免中间闪烁）
    if (dragAnimTimer) {
      clearTimeout(dragAnimTimer);
      dragAnimTimer = null;
    }
    whale.classList.remove("struggling", "petted");
    void whale.offsetWidth; // 重启 CSS 动画

    dragAnimType = type;
    pauseTailAnimation();
    whale.classList.add(type);

    // 2.5~3.5 秒后随机换一种动画（若仍在拖动）
    const duration = 2500 + Math.random() * 1000;
    dragAnimTimer = setTimeout(() => {
      dragAnimTimer = null;
      if (isDragging && dragMoved && dragAnimType) {
        const next = dragAnimType === "struggling" ? "petted" : "struggling";
        applyDragAnim(next);
      } else if (dragAnimType) {
        // 拖动已结束，清理
        whale.classList.remove("struggling", "petted");
        dragAnimType = null;
        resumeTailAnimation();
      }
    }, duration);
  }

  whale.addEventListener("mousedown", (e) => {
    // 只处理左键（button 0）
    if (e.button !== 0) return;
    isDragging = true;
    dragStartScreenX = e.screenX;
    dragStartScreenY = e.screenY;
    dragMoved = false;
    pendingTargetX = null;
    pendingTargetY = null;

    // 获取当前窗口位置作为拖动基准
    try {
      const pos = window.dshPet && window.dshPet.getWindowPosition
        ? window.dshPet.getWindowPosition()
        : [0, 0];
      dragWindowX = pos[0];
      dragWindowY = pos[1];
    } catch (err) {
      dragWindowX = 0;
      dragWindowY = 0;
    }

    whale.style.cursor = "grabbing";
    whale.classList.add("dragging"); // 拖动时禁用滤镜和 will-change
    // 按住即触发交互动画（无论是否移动）
    startDragAnimation();
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;

    const dx = e.screenX - dragStartScreenX;
    const dy = e.screenY - dragStartScreenY;

    if (!dragMoved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
      dragMoved = true;
    }

    if (dragMoved && window.dshPet && window.dshPet.moveWindowTo) {
      // 计算目标位置（绝对坐标）
      pendingTargetX = dragWindowX + dx;
      pendingTargetY = dragWindowY + dy;

      if (!dragRAF) {
        dragRAF = requestAnimationFrame(() => {
          if (pendingTargetX !== null && pendingTargetY !== null) {
            window.dshPet.moveWindowTo(pendingTargetX, pendingTargetY);
            pendingTargetX = null;
            pendingTargetY = null;
          }
          dragRAF = null;
        });
      }
    }
    e.preventDefault();
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    whale.style.cursor = "pointer";
    whale.classList.remove("dragging"); // 恢复滤镜和 will-change
    stopDragAnimation(); // 松手停止动画
    if (dragRAF) {
      cancelAnimationFrame(dragRAF);
      dragRAF = null;
    }
  });

  // 双击鲸鱼切换置顶状态
  let lastClickTime = 0;
  whale.addEventListener("click", () => {
    const now = Date.now();
    if (now - lastClickTime < 350) {
      // 双击
      if (window.dshPet && window.dshPet.toggleAlwaysOnTop) {
        window.dshPet.toggleAlwaysOnTop();
      }
      lastClickTime = 0;
    } else {
      lastClickTime = now;
    }
  });

  // ============================================================
  // 右上角钉子按钮：置顶 / 取消置顶
  // ============================================================
  const pinBtn = document.getElementById("pinBtn");
  let pinState = null; // 上一次已知的置顶状态（null = 还没收到）
  function renderPin(on) {
    const changed = pinState !== null && pinState !== on;
    pinState = on;
    if (!pinBtn) return;
    pinBtn.dataset.on = on ? "1" : "0";
    pinBtn.title = on ? "已置顶（点击取消置顶）" : "未置顶（点击保持置顶）";
    // 取消置顶后桌宠会被其他窗口挡住，看起来像"消失了"——明说一句，别让人找不到按钮
    if (changed && !on && window.dshPetEmotion && window.dshPetEmotion.showBubble) {
      window.dshPetEmotion.showBubble("📌 已取消置顶：会被其他窗口盖住，点右上角 📌 再钉住", "calm");
    }
  }
  if (pinBtn) {
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (window.dshPet && window.dshPet.toggleAlwaysOnTop) window.dshPet.toggleAlwaysOnTop();
    });
    if (window.dshPet && window.dshPet.onAlwaysOnTop) {
      window.dshPet.onAlwaysOnTop(renderPin);
    }
  }

  // ============================================================
  // 泡泡菜单 - 上浮动画
  // ============================================================
  let bubblesVisible = false;
  const allBubbleItems = Array.from(document.querySelectorAll(".bubble-item"));
  /**
   * 当前该显示的泡泡——**隐藏的（hidden）不参与布局**。
   * 为什么：⏸ 暂停只在"正在旁听"时才有意义，平时藏着；要是它照样占一个位子，
   * 那行里就会空出一个洞。所以每次显示泡泡都按"可见的"重算行列。
   */
  const bubbleItems = () => allBubbleItems.filter((el) => !el.hidden);
  const BUBBLE_W = 46;       // 主泡泡直径
  const BUBBLE_SPACING = 52; // 主泡泡中心间距
  const BUBBLE_ROW_STEP = 58; // 上下两行的间距（比泡泡高一点，免得行间贴住）
  const SUB_W = 38;          // 子泡泡直径
  const SUB_SPACING = 50;    // 子泡泡中心间距

  /**
   * 主泡泡菜单分行。
   * 为什么必须分行：窗口只有 322px 宽，一行**最多**放得下 6 个泡泡（6×52+46=306）；
   * 加第 7 个（🎧 旁听）时那行就有 358px，两头的泡泡会被窗口裁掉一半。
   * 规则：先按"一行最多几个"定行数，再把每行**分均匀**（8 个 → 4+4，7 个 → 4+3），
   * 避免出现"最后一行只孤零零一个"。以后再加功能（最多 12 个）也不用重排。
   * @returns {number[][]} 每个元素是一行里各泡泡的下标
   */
  function planBubbleRows(count) {
    const stageW = stage.clientWidth || 322;
    const maxRowW = stageW - 16; // 两侧各留 8px
    const perRow = Math.max(1, Math.floor((maxRowW - BUBBLE_W) / BUBBLE_SPACING) + 1);
    const rowCount = Math.max(1, Math.ceil(count / perRow));
    const balanced = Math.ceil(count / rowCount);
    const rows = [];
    for (let i = 0; i < count; i += balanced) {
      rows.push(Array.from({ length: Math.min(balanced, count - i) }, (_, k) => i + k));
    }
    return rows;
  }

  /** 每个泡泡的目标位置：第 0 行最靠近鲸鱼，往上依次叠 */
  function bubblePositions() {
    const positions = [];
    planBubbleRows(bubbleItems().length).forEach((row, r) => {
      // 每行按真实宽度居中（算上泡泡自身宽度），否则会整体右偏、顶出窗口
      const startX = -(((row.length - 1) * BUBBLE_SPACING) + BUBBLE_W) / 2;
      row.forEach((idx, i) => {
        positions[idx] = {
          x: startX + i * BUBBLE_SPACING,
          y: -78 - BUBBLE_ROW_STEP * r - Math.random() * 6, // 一点随机抖动，像真的泡泡
        };
      });
    });
    return positions;
  }

  function showBubbles() {
    if (bubblesVisible) return;
    bubblesVisible = true;
    // 泡泡菜单和心情气泡抢同一块地方，先收掉气泡
    if (window.dshPetEmotion) window.dshPetEmotion.hideBubble();

    const positions = bubblePositions();
    const items = bubbleItems(); // 这一次要显示的那批（隐藏的不算）

    items.forEach((item, index) => {
      const pos = positions[index];
      item.style.left = `${pos.x}px`;
      item.style.top = `${pos.y}px`;
      item.style.animationDelay = `${index * 55}ms`; // 按顺序冒出来，而不是"啪"一下全出现
      item.classList.remove("popping", "floating");
      item.classList.add("rising");
    });

    bubbleMenu.classList.add("visible");

    // 上浮完成后切换到浮动状态（每行错开相位，飘得更自然）
    setTimeout(() => {
      items.forEach((item) => {
        item.classList.remove("rising");
        item.style.animationDelay = `${-(0.3 + Math.random() * 2.2).toFixed(2)}s`;
        item.classList.add("floating");
      });
    }, items.length * 55 + 800);
  }

  function hideBubbles() {
    if (!bubblesVisible) return;
    bubblesVisible = false;

    allBubbleItems.forEach((item) => {
      item.classList.remove("rising", "floating");
      item.style.animationDelay = "";
      item.classList.add("popping");
    });

    setTimeout(() => {
      bubbleMenu.classList.remove("visible");
      allBubbleItems.forEach((item) => {
        item.classList.remove("popping");
        item.style.opacity = "";
      });
    }, 300);
  }

  /**
   * 可见泡泡变了（典型：旁听时 ⏸/▶️ 那个冒出来或收回去）→ **就地重排**。
   * 不重播上浮动画：菜单可能正开着（比如从托盘点了暂停），这时候新泡泡如果没人给它
   * 位置，就会堆在容器左上角。
   */
  function relayoutBubbles() {
    if (!bubblesVisible) return;
    const positions = bubblePositions();
    bubbleItems().forEach((item, index) => {
      const pos = positions[index];
      if (!pos) return;
      item.style.left = `${pos.x}px`;
      item.style.top = `${pos.y}px`;
    });
  }
  const bubbleObserver = new MutationObserver(relayoutBubbles);
  allBubbleItems.forEach((el) => bubbleObserver.observe(el, { attributes: true, attributeFilter: ["hidden"] }));

  // 右键鲸鱼切换泡泡（区分拖动和右键）
  whale.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 如果发生了拖动，不触发泡泡菜单
    if (dragMoved) {
      dragMoved = false;
      return;
    }
    
    if (bubblesVisible) {
      hideBubbles();
    } else {
      showBubbles();
    }
  });

  // 点击主泡泡 → 展开子泡泡（"心情"直接开面板，不再挂 6 个子泡泡）
  allBubbleItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = item.dataset.action;

      if (action === "close") {
        // 关闭桌宠
        if (window.dshPet && window.dshPet.quit) {
          window.dshPet.quit();
        }
        return;
      }
      if (action === "mood") {
        // 心情面板：记录为主，设置收在面板右上角 ⚙ 里
        hideSubMenu();
        hideBubbles();
        if (window.dshPetEmotion) window.dshPetEmotion.showMoodPanel();
        return;
      }
      if (action === "meal") {
        // 吃饭打卡：主人主动记的生活记录（不是识别出来的），弹对话框
        hideSubMenu();
        hideBubbles();
        openMealDialog();
        return;
      }
      if (action === "meet") {
        // 会议旁听：点一下开始听，再点一下结束并出纪要（采集在 renderer/meeting.js 里）
        hideSubMenu();
        hideBubbles();
        if (window.dshPetMeeting) window.dshPetMeeting.toggle();
        return;
      }
      if (action === "meet-pause") {
        // 会中休息：⏸ 暂停（停采集、不出纪要）/ ▶️ 继续（接着记）
        hideSubMenu();
        hideBubbles();
        if (window.dshPetMeeting && window.dshPetMeeting.pauseToggle) window.dshPetMeeting.pauseToggle();
        return;
      }
      if (action === "meet-ask") {
        // 秒答：拿"最近这段旁听原文"当问题去查项目资料（知识包优先，不够再翻代码），
        // 答案弹在鲸鱼旁边的小卡片上（那张卡片对共享屏幕/截屏不可见）
        hideSubMenu();
        hideBubbles();
        if (window.dshPetMeeting && window.dshPetMeeting.askNow) window.dshPetMeeting.askNow();
        return;
      }
      if (action === "minutes") {
        // 会议记录：打开纪要窗口（历次会议 + 原文对照 + 追问）——没记录过也照开，里面会教怎么开始
        hideSubMenu();
        hideBubbles();
        if (window.dshPet && window.dshPet.meetingWindow) window.dshPet.meetingWindow();
        return;
      }
      showSubMenu(action, item);
    });
  });

  // 左键点击空白处关闭泡泡和子泡泡
  document.addEventListener("click", (e) => {
    if (e.button !== 0) return;
    const inBubble = bubbleMenu.contains(e.target);
    const inSub = subMenuEl.contains(e.target);
    if (!inBubble && !inSub) {
      if (bubblesVisible) hideBubbles();
      hideSubMenu();
    }
  });

  // ============================================================
  // 自定义对话框（替代 prompt/alert，Electron 不支持 prompt）
  // ============================================================
  const dialogEl = document.getElementById("petDialog");
  const dialogTitle = document.getElementById("dialogTitle");
  const dialogBody = document.getElementById("dialogBody");
  const dialogInputWrap = document.getElementById("dialogInputWrap");
  const dialogInput = document.getElementById("dialogInput");
  const dialogOk = document.getElementById("dialogOk");
  const dialogCancel = document.getElementById("dialogCancel");

  let dialogResolve = null; // 当前对话框的 resolve

  // 显示对话框：opts { title, body, html, showInput, inputValue, placeholder, okText, buttons }
  function showDialog(opts) {
    return new Promise((resolve) => {
      dialogResolve = resolve;
      dialogTitle.textContent = opts.title || "提示";
      if (opts.html) {
        dialogBody.innerHTML = opts.html;
      } else {
        dialogBody.textContent = opts.body || "";
      }
      if (opts.showInput) {
        dialogInputWrap.hidden = false;
        dialogInput.value = opts.inputValue || "";
        dialogInput.placeholder = opts.placeholder || "";
        setTimeout(() => dialogInput.focus(), 30);
      } else {
        dialogInputWrap.hidden = true;
        dialogInput.value = "";
      }
      dialogOk.textContent = opts.okText || "确定";
      dialogCancel.hidden = !!opts.hideCancel;
      dialogEl.hidden = false;

      // 选项按钮（点击即 resolve 对应值并关闭）
      if (opts.buttons && opts.buttons.length) {
        // 同时给了输入框时保留"确定"：既能点快捷项、也能自己打字（吃饭打卡靠这个一次搞定）
        dialogOk.hidden = !opts.showInput;
        dialogCancel.hidden = !!opts.hideCancel;
        const holder = document.createElement("div");
        holder.className = "dialog-opt-buttons";
        holder.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;justify-content:center;";
        opts.buttons.forEach((b) => {
          const btn = document.createElement("button");
          btn.className = "dialog-btn" + (b.primary ? " primary" : "");
          btn.textContent = b.label;
          btn.style.cssText += ";font-size:12px;padding:4px 10px;";
          btn.addEventListener("click", () => closeDialog(b.value));
          holder.appendChild(btn);
        });
        dialogBody.appendChild(holder);
      } else {
        dialogOk.hidden = false;
      }
    });
  }

  function closeDialog(result) {
    if (dialogEl) dialogEl.hidden = true;
    if (dialogResolve) {
      const r = dialogResolve;
      dialogResolve = null;
      r(result);
    }
  }

  dialogOk.addEventListener("click", () => {
    const hasInput = !dialogInputWrap.hidden;
    closeDialog(hasInput ? dialogInput.value : true);
  });

  dialogCancel.addEventListener("click", () => closeDialog(null));

  dialogInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      closeDialog(dialogInput.value);
    } else if (e.key === "Escape") {
      closeDialog(null);
    }
  });

  // 替代 alert
  async function petAlert(message) {
    await showDialog({ title: "提示", body: String(message), okText: "知道了" });
  }

  // 替代 prompt
  async function petPrompt(question, defaultValue, placeholder) {
    const result = await showDialog({
      title: "输入",
      body: String(question),
      showInput: true,
      inputValue: defaultValue || "",
      placeholder: placeholder || "",
    });
    // 返回输入值；null 表示取消
    return result === null || result === false ? null : result;
  }

  // 选项对话框：buttons = [{label, value}]
  async function petChoose(title, prompt, buttons) {
    const result = await showDialog({ title, body: String(prompt), buttons, okText: "取消", hideCancel: true });
    return result; // closeDialog 传回 b.value（原始值），无选择则 null
  }

  /**
   * 吃饭打卡：一个对话框搞定 —— 上面输入框，下面"最近吃过的"快捷按钮，点一下就记完。
   * 记完的陪伴话术由主进程发气泡过来（这里不重复弹窗），失败才提示。
   */
  async function openMealDialog() {
    if (!window.dshPet || !window.dshPet.mealAdd) return;
    let recent = [];
    try { recent = (await window.dshPet.mealRecent()) || []; } catch {}
    const picked = await showDialog({
      title: "🍚 吃饭打卡",
      body: recent.length ? "吃了啥？点下面的最近记录，或直接打字：" : "记一句吃了啥（≤40 字）：",
      showInput: true,
      placeholder: "比如：牛肉面、番茄炒蛋…",
      okText: "记一笔",
      // 快捷项直接取"最近吃过的"（去重、最新在前）——多数时候一个字都不用打
      buttons: recent.map((w) => ({ label: `🍚 ${w}`, value: w })),
    });
    if (picked === null) return; // 取消
    const what = String(picked || "").trim();
    if (!what) return;
    const r = await window.dshPet.mealAdd(what);
    if (!r || !r.ok) await petAlert((r && r.error) || "没记上，再试一次？");
  }

  // ============================================================
  // 子泡泡菜单（点击主泡泡展开子泡泡）
  // ============================================================

  const subMenuEl = document.getElementById("subMenu");

  // 子泡泡数据：key 是主泡泡 action
  const SUB_ITEMS = {
    feed: [
      { icon: "🔑", label: "换 API", action: "change-api" },
      { icon: "🤖", label: "选模型", action: "pick-model" },
      { icon: "📊", label: "看用量", action: "usage" },
      { icon: "📚", label: "知识库", action: "kb" },
    ],
    play: [
      { icon: "🌀", label: "转圈", action: "spin" },
      { icon: "🤸", label: "跳跃", action: "jump" },
      { icon: "💥", label: "暴击", action: "crit" },
      { icon: "🎲", label: "随机", action: "random" },
    ],
    ask: [
      { icon: "💬", label: "提问", action: "ask" },
    ],
    // 换装：帽子清单来自 renderer/outfit.js（加新帽子会自动出现在这里）
    hat: (window.dshPetOutfit ? window.dshPetOutfit.itemsFor("hat") : []).map((h) => ({
      icon: h.emoji,
      label: h.label,
      action: "hat:" + h.id,
    })),
  };

  let subVisible = false;

  function hideSubMenu() {
    if (!subVisible) return;
    subVisible = false;
    subMenuEl.classList.remove("visible");
    subMenuEl.innerHTML = "";
  }

  function showSubMenu(parentAction, anchorItem) {
    const items = SUB_ITEMS[parentAction];
    if (!items) return;
    subVisible = true;
    subMenuEl.innerHTML = "";
    subMenuEl.classList.add("visible");
    // 子泡泡和心情气泡抢同一块地方，先收掉气泡
    if (window.dshPetEmotion) window.dshPetEmotion.hideBubble();

    const stageW = stage.clientWidth || 322;
    const maxRowW = stageW - 16; // 两侧各留 8px

    // 按可用宽度折行：一行放得下几个就放几个，绝不让泡泡顶出窗口
    const perRow = Math.max(1, Math.floor((maxRowW - SUB_W) / SUB_SPACING) + 1);
    const rows = [];
    for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));

    // 定位子菜单到主泡泡正上方；最宽的一行决定横向居中范围（保证不超界）
    const widest = Math.max(...rows.map((r) => ((r.length - 1) * SUB_SPACING) + SUB_W));
    if (anchorItem) {
      const parentRect = anchorItem.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      let cx = parentRect.left + parentRect.width / 2 - stageRect.left;
      const halfW = widest / 2;
      cx = Math.max(halfW, Math.min(cx, stageW - halfW));
      subMenuEl.style.left = `${cx}px`;
      subMenuEl.style.top = `${parentRect.top - stageRect.top}px`;
    } else {
      subMenuEl.style.left = "50%";
      subMenuEl.style.top = "45%";
    }
    subMenuEl.style.transform = "translateX(-50%)";

    rows.forEach((row, r) => {
      // 每行按真实宽度居中（itemW 算进去），多出的行往上叠
      const startX = -(((row.length - 1) * SUB_SPACING) + SUB_W) / 2;
      row.forEach((it, i) => {
        const el = document.createElement("div");
        el.className = "sub-item";
        el.dataset.action = it.action;
        const x = startX + i * SUB_SPACING; // 固定位置，不随机（防止超界）
        const y = -46 - r * 56;
        el.style.left = `calc(50% + ${x}px)`;
        el.style.top = `calc(50% + ${y}px)`;
        el.innerHTML = `<div class="bubble-circle">${it.icon}</div><div class="bubble-label">${it.label}</div>`;
        subMenuEl.appendChild(el);

        el.addEventListener("click", (e) => {
          e.stopPropagation();
          handleSubAction(it.action);
        });
      });
    });

    // 上浮动画
    const subItems = subMenuEl.querySelectorAll(".sub-item");
    subItems.forEach((el, i) => {
      setTimeout(() => {
        el.classList.remove("floating");
        el.classList.add("rising");
        setTimeout(() => {
          el.classList.remove("rising");
          el.classList.add("floating");
        }, 700);
      }, i * 90);
    });
  }

  async function handleSubAction(action) {
    hideSubMenu();
    hideBubbles();

    // 换装（帽子）：本地先换上（不等回包，点一下立刻见效），再落盘
    if (action.indexOf("hat:") === 0) {
      await applyGear("hat", action.slice(4));
      return;
    }

    switch (action) {
      case "change-api":
        await handleChangeApi();
        break;
      case "pick-model":
        await handlePickModel();
        break;
      case "usage":
        await handleUsage();
        break;
      case "kb":
        await petAlert("知识库上传功能开发中 📚");
        break;
      case "spin":
        triggerPlayAction("转圈");
        break;
      case "jump":
        triggerPlayAction("跳跃");
        break;
      case "crit":
        triggerPlayAction("暴击");
        break;
      case "random":
        triggerPlayAction("随机");
        break;
      case "ask":
        await showAskDialog();
        break;
    }
  }

  /** 换装扮（按槽位）：本地先换上（点一下立刻见效，不等回包），再落盘；颜色沿用该槽位当前配色 */
  async function applyGear(slot, id) {
    if (!window.dshPetOutfit) return;
    const cur = window.dshPetOutfit.current || {};
    const next = { ...cur, [slot]: { ...(cur[slot] || {}), id } };
    window.dshPetOutfit.apply(next);
    if (window.dshPet && window.dshPet.outfitSet) {
      try {
        const r = await window.dshPet.outfitSet({ [slot]: { id } }); // 只发该槽位，主进程逐槽位合并
        if (r) window.dshPetOutfit.apply(r);
      } catch (err) {
        console.log("[pet] 换装保存失败:", err && err.message);
      }
    }
  }

  async function handleChangeApi() {
    const base = await petPrompt("输入 API 基础地址:", CONFIG.apiBase);
    if (!base) return;
    const key = await petPrompt("输入 API 密钥:");
    if (!key) return;
    CONFIG.apiBase = base;
    CONFIG.apiKey = key;
    await petAlert("已更新 API 配置 ✅\n基础地址: " + base);
  }

  async function handleUsage() {
    setState("thinking");

    // 1. 选择展示范围
    const rangeDays = await petChoose(
      "查看用量",
      "请选择统计的时间范围：",
      [
        { label: "📅 全部", value: 0, primary: true },
        { label: "近 7 天 (周)", value: 7 },
        { label: "近 30 天 (月)", value: 30 },
        { label: "今天", value: 1 },
      ]
    );
    if (rangeDays === null) { setState("idle"); return; }

    // 2. 选择来源
    const srcChoice = await petChoose(
      "查看用量",
      "统计哪个来源的用量？",
      [
        { label: "全部 (DSH + 桌宠)", value: "all", primary: true },
        { label: "DeepSeek Harness", value: "dsh" },
        { label: "鲸鱼桌宠", value: "pet" },
      ]
    );
    if (srcChoice === null) { setState("idle"); return; }

    // 3. 拉取并展示
    try {
      let usageText = "暂无用量数据（DSH 会话扫描后展示）📊";
      if (window.dshPet && window.dshPet.getUsageStats) {
        const res = await window.dshPet.getUsageStats({ rangeDays, source: srcChoice });
        const summary = res?.summary || res?.total;
        const totals = res?.totals || null;
        if (summary && (summary.totalTokens > 0 || summary.calls > 0)) {
          const rangeLabel = rangeDays === 0 ? "全部时间" : rangeDays === 1 ? "今天" : `近 ${rangeDays} 天`;
          const srcLabel = srcChoice === "all" ? "DSH + 桌宠" : srcChoice === "dsh" ? "DeepSeek Harness" : "鲸鱼桌宠";
          const last = summary.lastCall;
          const lastLine = last
            ? `\n\n最近一次 (${last.source === "dsh" ? "DSH" : "桌宠"}${last.model ? " · " + last.model : ""}):\n  输入 ${(last.input || 0).toLocaleString()} / 输出 ${(last.output || 0).toLocaleString()} tok`
            : "";
          usageText = `📊 用量统计 [${srcLabel} · ${rangeLabel}]\n\n` +
            `累计 Tokens: ${summary.totalTokens.toLocaleString()}\n` +
            `输入: ${summary.inputTokens.toLocaleString()} / 输出: ${summary.outputTokens.toLocaleString()}\n` +
            `缓存读: ${summary.cacheReadTokens.toLocaleString()} / 推理: ${summary.reasoningTokens.toLocaleString()}\n` +
            `调用次数: ${summary.calls.toLocaleString()}${lastLine}`;

          // 附加来源分解
          if (totals && srcChoice === "all") {
            const d = totals.dsh || { totalTokens: 0, calls: 0 };
            const p = totals.pet || { totalTokens: 0, calls: 0 };
            usageText += `\n\n来源分解:\n  DSH: ${d.totalTokens.toLocaleString()} tok (${d.calls || 0} 次)\n  桌宠: ${p.totalTokens.toLocaleString()} tok (${p.calls || 0} 次)`;
          }
        }
      }
      // 4. 是否应用到鲸鱼下方用量条
      const applyView = await petChoose(
        "应用到下方用量条？",
        "是否让鲸鱼下方的实时用量条也按 [当前范围 + 来源] 显示？",
        [
          { label: "✅ 应用", value: "yes", primary: true },
          { label: "取消", value: "no" },
        ]
      );
      if (applyView === "yes") {
        usageView = { rangeDays, source: srcChoice };
        await refreshBottomUsageBar();
      }
      setState("done");
      await petAlert(usageText);
    } catch (err) {
      setState("error");
      await petAlert(`查询用量失败: ${err.message || err}`);
    }
  }

  async function handlePickModel() {
    // 用子泡泡选择模型（重新显示子菜单并填充模型选项）
    subMenuEl.innerHTML = "";
    subMenuEl.classList.add("visible");
    const modelItems = CONFIG.models.map((m) => ({
      icon: m.id === currentModel ? "✅" : "🤖",
      label: m.id,
      action: "model:" + m.id,
    }));
    const spacing = 52;
    const startX = -(modelItems.length - 1) * spacing / 2;

    modelItems.forEach((it, i) => {
      const el = document.createElement("div");
      el.className = "sub-item";
      if (it.icon === "✅") el.classList.add("active");
      const x = startX + i * spacing;
      const y = -52;
      el.style.left = `calc(50% + ${x}px)`;
      el.style.top = `calc(50% + ${y}px)`;
      el.innerHTML = `<div class="bubble-circle">${it.icon}</div><div class="bubble-label">${it.label}</div>`;
      subMenuEl.appendChild(el);

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const modelId = it.action.replace("model:", "");
        currentModel = modelId;
        hideSubMenu();
        hideBubbles();
        petAlert(`已切换到模型: ${currentModel} ✅`);
      });
    });

    const items = subMenuEl.querySelectorAll(".sub-item");
    items.forEach((el, i) => {
      setTimeout(() => {
        el.classList.add("rising");
        setTimeout(() => {
          el.classList.remove("rising");
          el.classList.add("floating");
        }, 700);
      }, i * 90);
    });
  }

  // 配置（来自 config.js）
  const CONFIG = window.DSH_PET_CONFIG || {
    models: [
      { id: "glm-5.3-flash", name: "GLM-5.3 Flash", desc: "最新快速模型" },
      { id: "glm-5.2", name: "GLM-5.2", desc: "旗舰模型 · 最强" },
      { id: "glm-5.1", name: "GLM-5.1", desc: "进阶模型 · 均衡" },
      { id: "glm-5",   name: "GLM-5",   desc: "标准模型 · 快速" },
    ],
    defaultModel: "glm-5.3-flash",
  };
  let currentModel = CONFIG.defaultModel;

  async function showAskDialog() {
    const question = await petPrompt(`问鲸鱼一个问题（当前模型: ${currentModel}）:`);
    if (!question) return;

    setState("thinking");
    bubbleText.textContent = "?";
    statusEl.textContent = "思考中 · 请求模型…";
    // 输入 = 普通攻击（消耗输入 token）
    triggerHitEffect("攻击!");

    try {
      let answer;
      let usage = null;
      if (window.dshPet && window.dshPet.ask) {
        const res = await window.dshPet.ask(currentModel, question);
        // 兼容：主进程返回 {content, usage} 或纯字符串
        if (res && typeof res === "object") {
          answer = res.content;
          usage = res.usage;
        } else {
          answer = res;
        }
      } else {
        answer = `（演示模式，未连接主进程）\n你问了: ${question}\n当前模型: ${currentModel}`;
      }
      setState("done");
      bubbleText.textContent = "✓";

      // 根据 token 用量决定效果强度：
      // 输出 token 多 = 暴击；输出 token 少 = 普通完成
      const outTokens = usage?.completion_tokens || 0;
      const inTokens = usage?.prompt_tokens || 0;
      if (outTokens >= 150) {
        triggerCritEffect(`暴击 +${outTokens} tok`);
      } else if (outTokens >= 30) {
        triggerCritEffect("暴击!");
      } else {
        triggerHitEffect("完成!");
      }

      const usageLine = usage
        ? `\n\n📊 用量: 输入 ${inTokens} / 输出 ${outTokens} / 共 ${usage.total_tokens || inTokens + outTokens} tokens`
        : "";
      await petAlert(`🐋 ${currentModel} 回答:\n\n${answer}${usageLine}`);
    } catch (err) {
      setState("error");
      bubbleText.textContent = "!";
      await petAlert(`出错了: ${err.message || err}`);
    }
  }

  function triggerPlayAction(action) {
    if (action.includes("转圈")) {
      whale.style.transition = "transform 1s ease-in-out";
      whale.style.transform = "rotate(360deg)";
      setTimeout(() => {
        whale.style.transform = "";
        whale.style.transition = "";
      }, 1000);
    } else if (action.includes("跳跃")) {
      whale.style.transition = "transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)";
      whale.style.transform = "translateY(-40px) scale(1.1)";
      setTimeout(() => {
        whale.style.transform = "";
        whale.style.transition = "";
      }, 700);
      setState("done");
    } else if (action.includes("随机")) {
      const randomActions = ["spin", "jump", "blink", "bounce", "crit"];
      const pick = randomActions[Math.floor(Math.random() * randomActions.length)];
      if (pick === "spin") triggerPlayAction("转圈");
      else if (pick === "jump") triggerPlayAction("跳跃");
      else if (pick === "blink") {
        setState("idle");
        setTimeout(() => setState("done"), 600);
      } else if (pick === "bounce") {
        whale.style.transition = "transform 0.3s ease-in-out";
        whale.style.transform = "translateY(-20px)";
        setTimeout(() => {
          whale.style.transform = "translateY(0)";
          setTimeout(() => {
            whale.style.transform = "translateY(-10px)";
            setTimeout(() => {
              whale.style.transform = "";
              whale.style.transition = "";
            }, 300);
          }, 300);
        }, 300);
      } else if (pick === "crit") {
        triggerCritEffect();
      }
    } else if (action.includes("暴击") || action.includes("crit")) {
      triggerCritEffect();
    }
  }

  // ============================================================
  // 攻击/暴击效果：输入=普通攻击，输出=暴击（输出 token 更多）
  // ============================================================
  function triggerHitEffect(text) {
    // 普通攻击：轻量星星 + 小震动
    const burst = document.getElementById("critBurst");
    if (!burst) return;

    burst.innerHTML = `
      <div class="flash"></div>
      <div class="ring"></div>
      <div class="crit-text">${text || "攻击!"}</div>
    `;

    const colors = ["#ffe66d", "#87cefa", "#7fffd4"];
    for (let i = 0; i < 6; i++) {
      const spark = document.createElement("div");
      spark.className = "spark";
      const angle = (Math.PI * 2 * i) / 6 + Math.random() * 0.5;
      const dist = 30 + Math.random() * 25;
      spark.style.setProperty("--tx", `${Math.cos(angle) * dist}px`);
      spark.style.setProperty("--ty", `${Math.sin(angle) * dist}px`);
      spark.style.setProperty("--rot", `${(Math.random() - 0.5) * 360}deg`);
      spark.style.background = colors[i % colors.length];
      spark.style.boxShadow = `0 0 6px ${colors[i % colors.length]}`;
      burst.appendChild(spark);
    }

    burst.classList.add("visible");
    whale.classList.add("hit");

    setTimeout(() => {
      burst.classList.remove("visible");
      whale.classList.remove("hit");
    }, 700);
  }

  function triggerCritEffect(text) {
    const burst = document.getElementById("critBurst");
    if (!burst) return;

    // 重置并填充星星
    burst.innerHTML = `
      <div class="flash"></div>
      <div class="ring"></div>
      <div class="crit-text">${text || "暴击!"}</div>
    `;

    // 生成 12 颗星星，随机方向
    const colors = ["#ffe66d", "#ffb347", "#7fffd4", "#87cefa", "#ff9ecb", "#d4ff7f"];
    for (let i = 0; i < 12; i++) {
      const spark = document.createElement("div");
      spark.className = "spark";
      const angle = (Math.PI * 2 * i) / 12 + Math.random() * 0.4;
      const dist = 50 + Math.random() * 45;
      spark.style.setProperty("--tx", `${Math.cos(angle) * dist}px`);
      spark.style.setProperty("--ty", `${Math.sin(angle) * dist}px`);
      spark.style.setProperty("--rot", `${(Math.random() - 0.5) * 540}deg`);
      spark.style.background = colors[i % colors.length];
      spark.style.boxShadow = `0 0 8px ${colors[i % colors.length]}`;
      burst.appendChild(spark);
    }

    burst.classList.add("visible");
    whale.classList.add("hit");
    stage.classList.add("shake");

    // 0.9 秒后清理
    setTimeout(() => {
      burst.classList.remove("visible");
      whale.classList.remove("hit");
      stage.classList.remove("shake");
    }, 900);
  }

  // ============================================================
  // 实时用量统计（鲸鱼下方显示 + 增长时触发暴击）
  // ============================================================
  const usageBar = document.getElementById("usageBar");
  const usageTokensEl = document.getElementById("usageTokens");
  const usageRowsEl = document.getElementById("usageRows");
  let lastTotalTokens = 0;

  // 用量视图状态（看用量时可选范围/来源）
  let usageView = { rangeDays: 0, source: "all" }; // 0=全部; 默认鲸鱼下方显示全部

  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  // 渲染单条来源行
  function sourceRowHtml(source, label, s) {
    if (!s || (!s.totalTokens && !s.calls)) return "";
    const inT = s.inputTokens != null ? s.inputTokens : s.promptTokens || 0;
    const outT = s.outputTokens != null ? s.outputTokens : s.completionTokens || 0;
    const cacheT = s.cacheReadTokens != null ? s.cacheReadTokens : s.cachedTokens || 0;
    const rowClass = source === "dsh" ? "ur-src-dsh" : "ur-src-pet";
    return `<div class="usage-row ${rowClass}"><span class="ur-name">${label}</span>` +
      `<span class="ur-val">${formatTokens(s.totalTokens || 0)}</span>` +
      `<span class="ur-in">入${formatTokens(inT)}</span>` +
      `<span class="ur-out">出${formatTokens(outT)}</span>` +
      (cacheT ? `<span class="ur-cache">缓存${formatTokens(cacheT)}</span>` : "") +
      `<span class="ur-val">${s.calls || 0}次</span></div>`;
  }

  // 渲染用量条（按 usageView 的 source 决定行数；totals 含 all/dsh/pet 分项）
  function applyUsageToBar(s, totals) {
    if (!usageBar) return;
    usageBar.hidden = false;
    const rangeLabel = usageView.rangeDays === 0 ? "全部" : usageView.rangeDays >= 30 ? "近30天" : usageView.rangeDays >= 7 ? "近7天" : "今天";

    // 主行：总量 + 范围（范围仅在非全部时显示）
    const total = s.totalTokens || 0;
    usageTokensEl.textContent = rangeLabel === "全部"
      ? `${formatTokens(total)} tok`
      : `${formatTokens(total)} tok · ${rangeLabel}`;

    // 明细行：按来源
    if (usageRowsEl) {
      let rowsHtml = "";
      if (totals) {
        if (usageView.source === "all" || usageView.source === "dsh") {
          rowsHtml += sourceRowHtml("dsh", "DSH", totals.dsh || totals.sources?.dsh);
        }
        if (usageView.source === "all" || usageView.source === "pet") {
          rowsHtml += sourceRowHtml("pet", "桌宠", totals.pet || totals.sources?.pet);
        }
      }
      usageRowsEl.innerHTML = rowsHtml;
    }

    // 增长动画（仅当有最近一次产出）
    const last = s.lastCall;
    if (last && (last.output > 0 || (last.total || 0) > 0)) {
      const delta = last.total != null ? last.total : (last.output || 0);
      usageBar.classList.remove("bump");
      void usageBar.offsetWidth;
      usageBar.classList.add("bump");
      if (delta >= 800) triggerCritEffect(`暴击 +${formatTokens(delta)}`);
      else if (delta >= 200) triggerCritEffect(`暴击 +${formatTokens(delta)}`);
      else triggerHitEffect(`+${formatTokens(delta)}`);
    }
    lastTotalTokens = total;
  }

  function updateUsageDisplay(stats) {
    if (!usageBar || !stats) return;
    usageBar.hidden = false;
    // 推送格式: stats = { all, dsh, pet, byDay, ...扁平 }  → 构造 totals
    if (stats.totals) {
      applyUsageToBar(stats.summary || stats.total || stats.all, stats.totals);
    } else if (stats.all) {
      applyUsageToBar(stats.all, { dsh: stats.dsh, pet: stats.pet, all: stats.all });
    } else {
      applyUsageToBar(stats, null);
    }
  }

  // 按当前视图重新拉取统计（供看用量对话框 + 定时刷新 + 底部条联动）
  async function fetchUsageView() {
    if (!window.dshPet || !window.dshPet.getUsageStats) return null;
    try {
      const res = await window.dshPet.getUsageStats({
        rangeDays: usageView.rangeDays,
        source: usageView.source,
      });
      return res;
    } catch (err) {
      console.log("[pet] fetchUsageView failed:", err.message);
      return null;
    }
  }

  // 刷新底部用量条（按 usageView 拉取并渲染）
  async function refreshBottomUsageBar() {
    const res = await fetchUsageView();
    if (res) {
      if (res.totals) {
        applyUsageToBar(res.summary || res.total || res.totals.all, res.totals);
      } else {
        applyUsageToBar(res.summary || res.total || res, null);
      }
    }
  }

  // 初始化获取当前统计
  if (window.dshPet && window.dshPet.getUsageStats) {
    window.dshPet.getUsageStats({ rangeDays: 0, source: "all" }).then((stats) => {
      updateUsageDisplay(stats);
    }).catch(() => {});
  }

  // 订阅推送
  if (window.dshPet && window.dshPet.onMealOpen) {
    // 托盘菜单"🍚 记录吃饭" → 在这儿弹打卡对话框
    window.dshPet.onMealOpen(() => openMealDialog());
  }
  if (window.dshPet && window.dshPet.onUsageStats) {
    window.dshPet.onUsageStats((stats) => {
      // 实时推送是"全部"视图；仅当用户未自定义视图时才自动更新下方条
      if (usageView.rangeDays === 0 && usageView.source === "all") {
        updateUsageDisplay(stats);
      }
      // 用户自定义视图时忽略推送，避免条被覆盖回全部（看用量时会自行刷新）
    });
  }

  // ============================================================
  // 订阅状态
  // 订阅状态
  if (window.dshPet) {
    window.dshPet.onState(({ state, meta }) => {
      setState(state);
      if (meta && meta.reason) {
        const prev = STATUS[state] || "";
        statusEl.textContent = `${prev} · ${meta.reason}`;
        setTimeout(() => {
          if (stage.dataset.state === state) statusEl.textContent = prev;
        }, 1400);
      }
    });
  } else {
    const demo = ["idle", "thinking", "tool", "approval", "streaming", "done", "error", "disconnected"];
    let i = 0;
    setInterval(() => setState(demo[i++ % demo.length]), 2500);
  }

  // 暴露给 emotion.js 的桥：心情气泡"聊聊天"按钮唤起提问框
  window.dshPetPlay = {
    // 会议旁听要用它确认一句（本地弹窗，点"开始"那一下顺带满足浏览器对录音的手势要求）
    choose: petChoose,
    ask: () => showAskDialog(),
    meal: () => openMealDialog(),
    play: (action) => triggerPlayAction(action),
  };
})();
