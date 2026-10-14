// renderer/settings.js — 心情设置（独立窗口）
//
// 桌宠"心情记录"面板右上角 ⚙ 打开本窗口；设置项全部收在这里：
//   摄像头识别 / 识别频率 / 认主 / 应用锁屏（壁纸式）/ 系统锁屏
// 相机在桌宠窗口里，所以"认主登记"是请主进程转发给桌宠窗口去拍的。

(function () {
  const host = document.getElementById("settingsCards");

  let guardState = null;      // guardStatus()
  let ownerState = null;      // ownerInfo()
  let reportData = null;      // emotionReport()（取识别开关/频率）
  let privacyState = null;    // privacyStatus()（屏幕截屏开关）
  let reminderState = null;   // reminderStatus()（饭点提醒开关 + 主人自己设的定时提醒）
  let meetingState = null;    // meetingConfig()（旁听：麦克风轨 / 字幕 / 保留天数 / 热词）
  let musicState = null;      // musicConfig()（听歌点评开关 + "现在读到在放什么"）
  let outfitState = null;     // outfitGet()（换装：当前帽子 + 配色）
  let autostartOn = false;    // autostartStatus()（开机自启是否已写入注册表）
  let camEnabled = false;
  let cachedPresence = null;  // 最近一次身份结论
  let msg = null;             // { text, ok }
  const customSec = { gate: "", after: "" }; // 自定义秒数输入（重绘后回填）
  // "加一条提醒"的草稿：重绘（比如点了星期几）后要把输入内容原样填回去
  const remindDraft = { at: "", text: "", days: [0, 1, 2, 3, 4, 5, 6] };
  // 旁听卡片里两个输入框的草稿（重绘后回填，别把正在打的字清掉）
  const meetDraft = { keep: "", hot: "" };

  /** 星期简名（0=周日，跟 Date.getDay() 一致） */
  const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

  /** 把 days 数组说成一句人话（空/全选 = 每天） */
  function daysLabel(days) {
    const d = Array.isArray(days) ? [...new Set(days)].sort((a, b) => a - b) : [];
    if (!d.length || d.length === 7) return "每天";
    const s = d.join(",");
    if (s === "1,2,3,4,5") return "工作日";
    if (s === "0,6") return "周末";
    return "周" + d.map((i) => DAY_NAMES[i] || "?").join("");
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
  }

  /** 状态条：识别 / 认主 / 此刻有没有看到主人 / 锁屏是否在生效 */
  function statusChips() {
    const chips = [];
    const interval = reportData && reportData.intervalMinutes ? reportData.intervalMinutes : 3;
    chips.push(`<span class="mr-chip ${camEnabled ? "on" : ""}">📷 识别${camEnabled ? `开 · ${interval} 分钟` : "关"}</span>`);

    const enrolled = !!(ownerState && ownerState.enrolled);
    chips.push(`<span class="mr-chip">👤 ${enrolled ? `认主 ${ownerState.refCount}/3` : "未认主"}</span>`);

    if (enrolled) {
      let t = "🧿 还没识别过";
      if (cachedPresence) {
        const at = cachedPresence.ts ? ` · ${fmtClock(cachedPresence.ts)}` : "";
        t = cachedPresence.ownerPresent
          ? `✅ 看到主人${at}`
          : cachedPresence.noFace ? `画面里没人${at}` : `🙈 不是主人${at}`;
      }
      chips.push(`<span class="mr-chip">${t}</span>`);
    }

    const g = guardState || {};
    chips.push(g.enabled
      ? `<span class="mr-chip on">🔒 应用锁屏 · ${g.locked ? "已锁定" : "守家中"}</span>`
      : `<span class="mr-chip">🔓 应用锁屏关${g.hasPassword ? "" : "（未设密码）"}</span>`);

    if (enrolled && ownerState.guardEnabled) chips.push(`<span class="mr-chip">🛡 系统锁屏开</span>`);
    return chips.join("");
  }

  function cardsHtml() {
    const g = guardState || {};
    const o = ownerState || {};
    const enrolled = !!o.enrolled;
    const interval = reportData && reportData.intervalMinutes ? reportData.intervalMinutes : 3;
    const pick = (label, val, current, act) =>
      `<span class="mr-chip pick${val === current ? " on" : ""}" data-act="${act}" data-val="${val}">${label}</span>`;
    // 拿不到状态时按默认（开）渲染，别让界面显示成"关"
    const sc = privacyState ? privacyState.screenCapture !== false : true;
    const mr = reminderState ? reminderState.mealReminder !== false : true;
    const mc = meetingState || { mic: true, liveCaption: true, keepDays: 30, hotwords: "" };
    if (!meetDraft.hot && mc.hotwords) meetDraft.hot = mc.hotwords; // 首次渲染把已存的热词带进输入框
    // 听歌点评：**默认关**（拿不到状态时也按关渲染——这是个"要主动开"的功能）
    const mu = !!(musicState && musicState.enabled);
    const muNow = (() => {
      const st = (musicState && musicState.status) || null;
      if (!mu) return "";
      if (!st || !st.running) return "现在：读取器没起来";
      return st.nowPlaying ? `现在读到：${st.nowPlaying.title}${st.nowPlaying.artist ? " - " + st.nowPlaying.artist : ""}` : "现在：没读到在放的歌";
    })();

    return `
      <div class="mr-card">
        <div class="mr-card-title">📷 摄像头识别</div>
        <div class="mr-row">
          <span class="mr-row-label">情绪识别</span>
          <span class="mr-row-ctrl">
            <span class="mr-chip pick${camEnabled ? " on" : ""}" data-act="cam" data-val="on">开</span>
            <span class="mr-chip pick${camEnabled ? "" : " on"}" data-act="cam" data-val="off">关</span>
          </span>
        </div>
        <div class="mr-field">
          <div class="mr-field-label">识别频率</div>
          <div class="mr-field-ctrl">${[1, 3, 5].map((m) => pick(`${m} 分钟`, m, interval, "interval")).join("")}</div>
        </div>
        <div class="mr-note">关掉识别就完全不看摄像头；锁屏探测期间（键鼠空闲/锁定期）会临时开启。</div>
      </div>

      <div class="mr-card">
        <div class="mr-card-title">🖥 屏幕截屏<span class="mr-tag">会上云</span></div>
        <div class="mr-row">
          <span class="mr-row-label">情绪突变时抓一帧屏幕</span>
          <span class="mr-row-ctrl">
            <span class="mr-chip pick${sc ? " on" : ""}" data-act="screencap" data-val="on">开</span>
            <span class="mr-chip pick${sc ? "" : " on"}" data-act="screencap" data-val="off">关</span>
          </span>
        </div>
        <div class="mr-note">只在情绪显著变化、要推测原因时抓一帧，抓的是鼠标所在那块屏（缩到 1280×720），交给视觉模型出一句 30 字摘要；<b>原图不落盘</b>，但摘要文字会写进事件日志。摄像头拍的是“你”，屏幕拍的是“你正在处理的一切”（可能开着密码管理器、客户记录、正在共享的会议屏幕）——共享屏幕、投屏演示时可以顺手关掉它，其余功能不受影响，只是推测会少一条线索。</div>
      </div>

      <div class="mr-card">
        <div class="mr-card-title">🔔 提醒</div>
        <div class="mr-row">
          <span class="mr-row-label">饭点提醒（记一笔吃了啥）</span>
          <span class="mr-row-ctrl">
            <span class="mr-chip pick${mr ? " on" : ""}" data-act="mealremind" data-val="on">开</span>
            <span class="mr-chip pick${mr ? "" : " on"}" data-act="mealremind" data-val="off">关</span>
          </span>
        </div>
        <div class="mr-note">午饭 11:30~13:00、晚饭 17:30~19:30 各最多问一次；<b>看家时不问、键鼠闲着超过 10 分钟不问、当天问过就不再问</b>，点「稍后」当天也不再问。记录只存在本机（写进事件日志），不上云。</div>

        <div class="mr-field">
          <div class="mr-field-label">自己定的提醒（吃药、量血压…）</div>
          <div class="mr-field-ctrl" id="remindList">
            ${remindItemsHtml()}
          </div>
        </div>
        <div class="mr-field">
          <div class="mr-field-label">加一条</div>
          <div class="mr-field-ctrl">
            <input id="remindAt" type="time" class="mr-num" style="width:86px" value="${esc(remindDraft.at)}" />
            <input id="remindText" type="text" class="lock-input" style="max-width:150px" maxlength="20" placeholder="提醒内容，如：吃药" value="${esc(remindDraft.text)}" />
            <button class="mr-btn" data-act="remind-add">添加</button>
          </div>
          <div class="mr-field-ctrl" style="margin-top:4px">
            <span class="mr-unit">星期几：</span>
            ${DAY_NAMES.map((n, i) => `<span class="mr-chip pick${remindDraft.days.includes(i) ? " on" : ""}" data-act="remind-day" data-val="${i}">${n}</span>`).join("")}
            <span class="mr-chip pick" data-act="remind-days" data-val="all">每天</span>
            <span class="mr-chip pick" data-act="remind-days" data-val="work">工作日</span>
            <span class="mr-chip pick" data-act="remind-days" data-val="weekend">周末</span>
          </div>
        </div>
        <div class="mr-note">到点后鲸鱼会冒出来说一句（带「知道了 / 10 分钟后再提醒」两个按钮）。<b>看家中、键鼠闲着超过 10 分钟不打扰，到点后 1 小时内还补提醒</b>——去倒杯水回来不会漏掉吃药。<br>提醒只是记着这件事，不评价、不追问；设置只存在本机（data/reminders.json），不上云。</div>
      </div>

      <div class="mr-card">
        <div class="mr-card-title">🎧 会议旁听<span class="mr-tag">语音会上云</span></div>
        <div class="mr-row">
          <span class="mr-row-label">麦克风轨（记下我自己的发言）</span>
          <span class="mr-row-ctrl">
            <span class="mr-chip pick${mc.mic ? " on" : ""}" data-act="meetmic" data-val="on">开</span>
            <span class="mr-chip pick${mc.mic ? "" : " on"}" data-act="meetmic" data-val="off">关</span>
          </span>
        </div>
        <div class="mr-row">
          <span class="mr-row-label">会中实时字幕（鲸鱼下面滚一句）</span>
          <span class="mr-row-ctrl">
            <span class="mr-chip pick${mc.liveCaption ? " on" : ""}" data-act="meetlive" data-val="on">开</span>
            <span class="mr-chip pick${mc.liveCaption ? "" : " on"}" data-act="meetlive" data-val="off">关</span>
          </span>
        </div>
        <div class="mr-field">
          <div class="mr-field-label">纪要文件保留多久（超期自动清）</div>
          <div class="mr-field-ctrl">
            ${[7, 30, 90, 365].map((v) => pick(`${v} 天`, v, mc.keepDays, "meetkeep")).join("")}
            <input id="meetKeep" type="number" class="mr-num" placeholder="自定义" value="${esc(meetDraft.keep)}" />
            <span class="mr-unit">天</span>
            <button class="mr-btn" data-act="meetkeep-custom">应用</button>
          </div>
        </div>
        <div class="mr-field">
          <div class="mr-field-label">热词（人名 / 项目代号 / 产品名，逗号分隔，最多 100 个）</div>
          <div class="mr-field-ctrl">
            <input id="meetHot" type="text" class="lock-input" placeholder="张总,报价单,星河项目" value="${esc(meetDraft.hot)}" />
            <button class="mr-btn" data-act="meethot-save">保存</button>
          </div>
        </div>
        <div class="mr-note">旁听只在<b>你点开始的这段时间</b>录：系统声（会议里对方的声音，戴耳机也能录到）+ 麦克风（你的声音，可关）。本机先做静音切分，<b>只有人在说话的片段</b>才上传转写（智谱 GLM-ASR，和你现有密钥同一个通道）；静音时段一个字节都不发。<br>结束时自动出结构化纪要：议题 / 结论决议 / 待办（谁+何时+依据）/ 待确认 / 关键数据点，每条带【mm:ss】可回溯原话，另外附上这段时间的情绪与在场旁注。纪要存在 data/meetings/ 下的 md 文件里，随时能复制拿走。<br>会中间要休息（比如茶歇、午休）就用右键菜单里的 <b>⏸ 暂停</b>：暂停期间不录也不上传、这场会不结束，回来点 <b>▶️ 继续</b> 接着记；休息时长不算进"实际记录时长"，时间轴也会跳过它。<br>会上同事问到项目上的事，用 <b>💡 秒答</b>：它拿<b>最近这段旁听原文</b>当问题，先查项目知识包、不够再翻 <code>D:\company</code> 的代码，答案弹在鲸鱼旁边一张小卡片上（<b>共享屏幕/截屏里看不到那张卡</b>），每条答案都标了来源。它只读项目文件，不改任何东西。</div>
      </div>

      <div class="mr-card">
        <div class="mr-card-title">🎵 听歌点评<span class="mr-tag">可选 · 默认关</span></div>
        <div class="mr-row">
          <span class="mr-row-label">听完一首给一句随口的点评</span>
          <span class="mr-row-ctrl">
            <span class="mr-chip pick${mu ? " on" : ""}" data-act="music" data-val="on">开</span>
            <span class="mr-chip pick${mu ? "" : " on"}" data-act="music" data-val="off">关</span>
          </span>
        </div>
        ${muNow ? `<div class="mr-row"><span class="mr-row-label">${esc(muNow)}</span></div>` : ""}
        <div class="mr-row">
          <span class="mr-row-label">不真放歌，模拟"刚听完一首"走一遍点评</span>
          <span class="mr-row-ctrl"><span class="mr-chip pick" data-act="music-test">听歌测试</span></span>
        </div>
        <div class="mr-note">开着才会去问 Windows「现在在放什么」（媒体控制中心，能读到歌名/歌手/专辑/进度），<b>只读元数据：不录音、不存音频、不写歌词</b>。一首放完——或者没听完就切了——就给一句 20 字以内的随口感；<b>认不出的歌不许编</b>，只说"你听了多久、怎么听的"这类事实。听歌记录（歌名+时长）会写进事件日志。关着的时候一个子进程都不起，零开销。</div>
      </div>

      <div class="mr-card">
        <div class="mr-card-title">👗 换装<span class="mr-tag">纯外观</span></div>
        ${(() => {
          const bc = String((outfitState && outfitState.bodyColor) || (window.dshPetOutfit && window.dshPetOutfit.BODY_DEFAULT) || "#1b5299");
          return `<div class="mr-field">
              <div class="mr-field-label">🐳 本体主色<span class="mr-unit" style="margin-left:6px">肚皮/腮红/暗部由它自动派生</span></div>
              <div class="mr-field-ctrl" style="flex-wrap:wrap;gap:6px">
                ${(window.dshPetOutfit ? window.dshPetOutfit.COLORS : []).map((c) => {
                  const on = String(c).toLowerCase() === bc.toLowerCase();
                  return `<span class="mr-chip pick swatch${on ? " on" : ""}" data-act="bodycolor" data-val="${c}" style="background:${c}" title="${c}"></span>`;
                }).join("")}
              </div>
              <div class="mr-field-ctrl" style="margin-top:4px">
                <input id="bodyColorInput" type="text" class="lock-input" style="max-width:110px" maxlength="7" placeholder="#1b5299" value="${esc(bc)}" />
                <button class="mr-btn" data-act="bodycolor-custom">应用</button>
              </div>
            </div>`;
        })()}
        ${(window.dshPetOutfit ? window.dshPetOutfit.SLOTS : []).map((slot) => {
          const cur = (outfitState && outfitState[slot.key]) || { id: "none", color: "" };
          const colorRow = cur.id !== "none"
            ? `<div class="mr-field">
                 <div class="mr-field-label">配色</div>
                 <div class="mr-field-ctrl" style="flex-wrap:wrap;gap:6px">
                   ${window.dshPetOutfit.COLORS.map((c) => {
                     const on = String(c).toLowerCase() === String(cur.color || "").toLowerCase();
                     return `<span class="mr-chip pick swatch${on ? " on" : ""}" data-act="gearcolor:${slot.key}" data-val="${c}" style="background:${c}" title="${c}"></span>`;
                   }).join("")}
                 </div>
               </div>`
            : "";
          return `<div class="mr-field">
              <div class="mr-field-label">${slot.emoji} ${slot.label}</div>
              <div class="mr-field-ctrl" style="flex-wrap:wrap">
                ${slot.items.map((it) => pick(`${it.emoji} ${it.label}`, it.id, cur.id, "gear:" + slot.key)).join("")}
              </div>
            </div>${colorRow}`;
        }).join("")}
        <div class="mr-note">纯本机外观，存在 data/outfit.json，不上云、不参与识别判定。本体主色只管一个颜色，其余（肚皮/腮红/暗部/墨色）按比例自动派生，配不丑。也可以右键鲸鱼 → <b>🎩 换装</b> 快速换帽子；眼镜/配饰/手持在这里配，选了才出现配色行。</div>
      </div>

      <div class="mr-card">
        <div class="mr-card-title">🚀 开机自启<span class="mr-tag">可选</span></div>
        <div class="mr-row">
          <span class="mr-row-label">登录 Windows 后自动把桌宠起起来</span>
          <span class="mr-row-ctrl">
            <span class="mr-chip pick${autostartOn ? " on" : ""}" data-act="autostart" data-val="on">开</span>
            <span class="mr-chip pick${autostartOn ? "" : " on"}" data-act="autostart" data-val="off">关</span>
          </span>
        </div>
        <div class="mr-note">开了之后，开机登录就自动起桌宠（写进当前用户的启动项，<b>不需要管理员权限，也不用改任何系统设置</b>）。桌宠起着，听歌守护这些才会在后台跑、才能攒记录。关掉就是把这个启动项删掉。</div>
      </div>

      <div class="mr-card">
        <div class="mr-card-title">👤 认主</div>
        <div class="mr-row">
          <span class="mr-row-label">${enrolled ? `已登记 ${o.refCount}/3 张参考照` : "还没有认主"}</span>
          <span class="mr-row-ctrl"><span class="mr-chip pick" data-act="enroll">${enrolled ? "重新登记" : "开始登记"}</span></span>
        </div>
        <div class="mr-note">认主后鲸鱼才能判断"画面里的人是不是你"，这是刷脸解锁的前提。点登记后会回到桌宠窗口连拍 3 张。</div>
      </div>

      <div class="mr-card">
        <div class="mr-card-title">🔒 应用锁屏<span class="mr-tag">壁纸式 · 非系统锁屏</span></div>
        <div class="mr-row">
          <span class="mr-row-label">当前状态</span>
          <span class="mr-row-ctrl">${g.enabled ? `<span class="mr-chip on">已开启</span>` : `<span class="mr-chip">已关闭</span>`}</span>
        </div>
        <div class="mr-field">
          <div class="mr-field-label">密码</div>
          <div class="mr-field-ctrl">
            <input id="lockPwInput" type="password" class="lock-input" placeholder="设置 / 修改密码（至少 4 位）" autocomplete="off" />
            <button id="lockPwSave" class="mr-btn">保存</button>
          </div>
        </div>
        <div class="mr-field">
          <div class="mr-field-label">键鼠静下来多久 → 先看一眼</div>
          <div class="mr-field-ctrl">
            ${[3, 5, 6, 8, 15].map((v) => pick(`${v} 秒`, v, g.idleGateS, "gate")).join("")}
            <input id="gateCustom" type="number" class="mr-num" placeholder="自定义" value="${esc(String(customSec.gate || ""))}" />
            <span class="mr-unit">秒</span>
            <button class="mr-btn" data-act="gate-custom">应用</button>
          </div>
        </div>
        <div class="mr-field">
          <div class="mr-field-label">盯梢节奏（看不到人时多久识别一次）</div>
          <div class="mr-field-ctrl">
            ${[3, 5, 10, 15, 30].map((v) => pick(`${v} 秒`, v, g.probeIntervalS, "probe")).join("")}
          </div>
        </div>
        <div class="mr-row">
          <span class="mr-row-label">认出"不是主人" → 立即锁</span>
          <span class="mr-row-ctrl">
            <span class="mr-chip pick${g.lockOnStranger ? " on" : ""}" data-act="stranger" data-val="on">开</span>
            <span class="mr-chip pick${g.lockOnStranger ? "" : " on"}" data-act="stranger" data-val="off">关</span>
          </span>
        </div>
        <div class="mr-field">
          <div class="mr-field-label">人不在画面中多久就锁定</div>
          <div class="mr-field-ctrl">
            ${[3, 5, 10, 15, 30].map((v) => pick(`${v} 秒`, v, g.lockAfterS, "after")).join("")}
            <input id="afterCustom" type="number" class="mr-num" placeholder="自定义" value="${esc(String(customSec.after || ""))}" />
            <span class="mr-unit">秒</span>
            <button class="mr-btn" data-act="after-custom">应用</button>
          </div>
        </div>
        <div class="mr-field">
          <div class="mr-field-label">锁屏后多久没人解锁 → 追加系统锁屏兜底</div>
          <div class="mr-field-ctrl">
            ${pick("关闭", 0, g.hardLockAfterS, "hardlock")}
            ${pick("3 分钟", 180, g.hardLockAfterS, "hardlock")}
            ${pick("5 分钟", 300, g.hardLockAfterS, "hardlock")}
            ${pick("10 分钟", 600, g.hardLockAfterS, "hardlock")}
          </div>
        </div>
        <div class="mr-btn-row">
          <button class="mr-btn" data-act="guard-mode" data-val="${g.enabled ? "off" : "on"}">${g.enabled ? "关闭应用锁屏" : "开启应用锁屏"}</button>
          <button class="mr-btn" data-act="lock-now">立即锁定</button>
          <button class="mr-btn mr-btn-cancel" data-act="clear-pw">清除密码</button>
        </div>
        <div class="mr-note">节奏是固定的：正常时按"盯梢节奏"复核（默认 10 秒），不随键鼠抖动变速；一旦某一眼没看到人，会自动收紧到<b>每 3 秒复检</b>一次（本机识别，不花钱），连续 <b>3 眼</b>都看不到人才算"人不在"，累计够久就锁。也就是人走开/遮住镜头约 <b>6~9 秒</b>上锁；中间任一眼认出你，计时立刻清零——转头、一帧糊掉不会把你锁在外面。认出画面里明显不像的别人 → 连续两次直接锁屏。可填范围：空闲 2~300 秒、不在 2~600 秒。<br>分层设计：壁纸锁屏负责挡顺手操作、护隐私（软锁，Alt+Tab 可绕）；兜底那档会真的调用系统锁屏（硬锁，要输 Windows 密码才能进）。密码忘了删掉 data/lock.json 可复位（不影响认主）。</div>
      </div>

      <div class="mr-card">
        <div class="mr-card-title">🛡 系统锁屏<span class="mr-tag">真锁 Windows</span></div>
        <div class="mr-row">
          <span class="mr-row-label">离开后锁屏</span>
          <span class="mr-row-ctrl">
            <span class="mr-chip pick${o.guardEnabled ? " on" : ""}" data-act="sysguard" data-val="on">开</span>
            <span class="mr-chip pick${o.guardEnabled ? "" : " on"}" data-act="sysguard" data-val="off">关</span>
          </span>
        </div>
        <div class="mr-note">连续多次没看到主人会调用系统锁屏（要输 Windows 密码解锁），并暂停 AI 问答。与应用锁屏相互独立。</div>
      </div>`;
  }

  /** 已设的自定义提醒：一行一条（⏰ 时间 · 内容 · 星期几），右边开关 / 删除 */
  function remindItemsHtml() {
    const items = reminderState && Array.isArray(reminderState.items) ? reminderState.items : [];
    if (!items.length) return `<span class="mr-note" style="margin:0">还没设过。比如 08:30「吃药」。</span>`;
    return items
      .map((it) => {
        const on = it.enabled !== false;
        return `<div class="mr-row" style="flex:1 1 100%">
          <span class="mr-row-label">⏰ ${esc(it.at)} · ${esc(it.text)} · ${esc(daysLabel(it.days))}</span>
          <span class="mr-row-ctrl">
            <span class="mr-chip pick${on ? " on" : ""}" data-act="remind-toggle" data-val="${esc(it.id)}">${on ? "已开" : "已关"}</span>
            <span class="mr-chip pick" data-act="remind-del" data-val="${esc(it.id)}">删除</span>
          </span>
        </div>`;
      })
      .join("");
  }

  /** 当前自定义提醒列表（拷贝一份，避免直接改到 state） */
  function currentItems() {
    return reminderState && Array.isArray(reminderState.items) ? reminderState.items.map((x) => ({ ...x })) : [];
  }

  function msgHtml() {
    if (!msg) return "";
    return `<div class="mr-msg ${msg.ok ? "ok" : "bad"}">${esc(msg.text)}</div>`;
  }

  function render() {
    if (!host) return;
    host.innerHTML = `<div class="mr-dist" id="settingsStatusStrip">${statusChips()}</div>${cardsHtml()}${msgHtml()}`;
    bind();
  }

  /** 只刷新状态条和提示行，不整块重绘（免得清掉正在输入的密码/秒数） */
  function renderStatusStrip() {
    const el = document.getElementById("settingsStatusStrip");
    if (el) el.innerHTML = statusChips();
  }

  function renderMsg() {
    if (!host) return;
    let el = host.querySelector(".mr-msg");
    if (!msg) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      host.appendChild(el);
    }
    el.className = `mr-msg ${msg.ok ? "ok" : "bad"}`;
    el.textContent = msg.text;
  }

  // ---- 数据 ------------------------------------------------------------------

  async function refresh() {
    if (!window.dshPet) return;
    try { reportData = await window.dshPet.emotionReport(); } catch { reportData = null; }
    try { guardState = await window.dshPet.guardStatus(); } catch { guardState = null; }
    try { ownerState = await window.dshPet.ownerInfo(); } catch { ownerState = null; }
    try { privacyState = await window.dshPet.privacyStatus(); } catch { privacyState = null; }
    try { reminderState = await window.dshPet.reminderStatus(); } catch { reminderState = null; }
    try { meetingState = await window.dshPet.meetingConfig(); } catch { meetingState = null; }
    try { musicState = await window.dshPet.musicConfig(); } catch { musicState = null; }
    try { outfitState = await window.dshPet.outfitGet(); } catch { outfitState = null; }
    try { autostartOn = !!(await window.dshPet.autostartStatus()).enabled; } catch { autostartOn = false; }
    if (reportData) {
      camEnabled = reportData.enabled !== false;
      const cur = reportData.current;
      if (cur && ownerState && ownerState.enrolled && !cachedPresence) {
        cachedPresence = { noFace: !!cur.noFace, ownerPresent: cur.ownerPresent === true, ts: cur.ts };
      }
    }
    render();
  }

  // ---- 交互 ------------------------------------------------------------------

  async function act(name, val) {
    const say = (text, ok) => { msg = { text, ok: ok !== false }; };

    if (name === "cam") {
      if ((val === "on") !== camEnabled) await window.dshPet.emotionToggle();
      say(val === "on" ? "已开启摄像头识别" : "已关闭摄像头识别");
    } else if (name === "interval") {
      await window.dshPet.emotionSetInterval(Number(val));
      say(`识别频率已设为每 ${val} 分钟`);
    } else if (name === "screencap") {
      const r = await window.dshPet.privacySet({ screenCapture: val === "on" });
      say(r && r.screenCapture
        ? "已开启屏幕截屏"
        : "已关闭屏幕截屏：情绪突变时不再抓屏，推测照常（只是少一条线索）");
    } else if (name === "music") {
      const r = await window.dshPet.musicConfigSet({ enabled: val === "on" });
      musicState = r || musicState; // 用返回值就地刷新，别等下次重开设置页（右边那句"现在读到…"要跟着变）
      say(r && r.enabled
        ? "已开启听歌点评：读完一首就说一句（放一半就切了也会说，会注明没听完）"
        : "已关闭听歌点评：不再读系统在放什么，读取器已停");
    } else if (name === "music-test") {
      say("正在模拟一首歌走点评链路…");
      const r = await window.dshPet.musicTest();
      if (r && r.ok) {
        say(`听歌测试通过：模拟「${r.title} - ${r.artist}」听了 ${r.playedSec} 秒，点评${r.comment ? `"${r.comment}"` : "链路通了（模型这次没返回内容）"}`);
      } else {
        say(`听歌测试失败：${(r && r.reason) || "未知原因"}`, false);
      }
    } else if (name === "bodycolor") {
      const r = await window.dshPet.outfitSet({ bodyColor: val });
      outfitState = r || outfitState;
      say("已更新本体配色（肚皮/腮红/暗部跟着自动变）");
    } else if (name === "bodycolor-custom") {
      const el = document.getElementById("bodyColorInput");
      const v = el ? String(el.value || "").trim() : "";
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
        say("请填 #rrggbb 格式的颜色，比如 #1b5299", false);
      } else {
        const r = await window.dshPet.outfitSet({ bodyColor: v });
        outfitState = r || outfitState;
        say(`本体配色已设为 ${v}`);
      }
    } else if (name.indexOf("gear:") === 0) {
      const slot = name.slice(5);
      const r = await window.dshPet.outfitSet({ [slot]: { id: val } });
      outfitState = r || outfitState;
      const it = window.dshPetOutfit && window.dshPetOutfit.findItem(slot, val);
      const slotLabel = (window.dshPetOutfit && (window.dshPetOutfit.SLOTS.find((s) => s.key === slot) || {}).label) || slot;
      say(it && it.id === "none" ? `已摘掉${slotLabel}` : `已换上「${(it && it.label) || val}」`);
    } else if (name.indexOf("gearcolor:") === 0) {
      const slot = name.slice(10);
      const r = await window.dshPet.outfitSet({ [slot]: { color: val } });
      outfitState = r || outfitState;
      say("已更新配色");
    } else if (name === "autostart") {
      const r = await window.dshPet.autostartSet(val === "on");
      autostartOn = !!(r && r.ok && r.enabled);
      say(r && r.ok
        ? (val === "on" ? "已开启开机自启：下次登录 Windows 会自动起桌宠" : "已关闭开机自启：已从启动项删掉")
        : `设置失败：${(r && r.reason) || "未知原因"}`, !!(r && r.ok));
    } else if (name === "mealremind") {
      const r = await window.dshPet.reminderSet({ mealReminder: val === "on" });
      say(r && r.mealReminder ? "已开启饭点提醒" : "已关闭饭点提醒（不再主动问吃了啥，仍可自己点菜单记）");
    } else if (name === "remind-toggle" || name === "remind-del") {
      const items = currentItems();
      const hit = items.find((x) => x && x.id === val);
      if (!hit) {
        say("这条提醒已经不在列表里了", false);
      } else if (name === "remind-del") {
        const r = await window.dshPet.reminderSet({ items: items.filter((x) => x.id !== val) });
        say(`已删除提醒「${hit.text}」`, !!(r && r.items));
      } else {
        const on = hit.enabled === false; // 反转
        const r = await window.dshPet.reminderSet({
          items: items.map((x) => (x.id === val ? { ...x, enabled: on } : x)),
        });
        say(`提醒「${hit.text}」已${on ? "打开" : "关闭"}`, !!(r && r.items));
      }
    } else if (name === "remind-day") {
      // 只是改草稿（还没提交），让 refresh → render 把选中状态画出来
      const d = Number(val);
      remindDraft.days = remindDraft.days.includes(d)
        ? remindDraft.days.filter((x) => x !== d)
        : [...remindDraft.days, d].sort((a, b) => a - b);
    } else if (name === "remind-days") {
      remindDraft.days = val === "work" ? [1, 2, 3, 4, 5] : val === "weekend" ? [0, 6] : [0, 1, 2, 3, 4, 5, 6];
    } else if (name === "remind-add") {
      const at = String(remindDraft.at || "").trim();
      const text = String(remindDraft.text || "").trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
        say("先选个时间（24 小时制）", false);
      } else if (!text) {
        say("写一句提醒内容，比如“吃药”", false);
      } else if (currentItems().length >= 20) {
        say("提醒最多存 20 条，先删掉几条吧", false);
      } else {
        const r = await window.dshPet.reminderSet({
          items: [...currentItems(), { at, text, days: remindDraft.days, enabled: true }],
        });
        if (r && r.items) {
          const label = daysLabel(remindDraft.days);
          remindDraft.at = "";
          remindDraft.text = "";
          say(`已加上：${label} ${at} 「${text}」`);
        } else {
          say("没存上，再试一次？", false);
        }
      }
    } else if (name === "meetmic" || name === "meetlive") {
      const r = await window.dshPet.meetingConfigSet(name === "meetmic" ? { mic: val === "on" } : { liveCaption: val === "on" });
      if (name === "meetmic") {
        say(r && r.mic ? "已开启麦克风轨：你自己的发言也会记进纪要" : "已关闭麦克风轨：只记会议里对方的声音");
      } else {
        say(r && r.liveCaption ? "已开启会中实时字幕" : "已关闭会中实时字幕（照常记录，只是鲸鱼下面不滚字）");
      }
    } else if (name === "meetkeep") {
      const r = await window.dshPet.meetingConfigSet({ keepDays: Number(val) });
      say(`已设为：纪要保留 ${(r && r.keepDays) || val} 天，超期自动清（只清 md 文件）`);
    } else if (name === "meetkeep-custom") {
      const v = Number(meetDraft.keep);
      if (!(v >= 1 && v <= 3650)) {
        say("保留天数请填 1~3650", false);
      } else {
        const r = await window.dshPet.meetingConfigSet({ keepDays: v });
        meetDraft.keep = "";
        say(`已设为：纪要保留 ${(r && r.keepDays) || v} 天`);
      }
    } else if (name === "meethot-save") {
      const r = await window.dshPet.meetingConfigSet({ hotwords: meetDraft.hot });
      const n = String((r && r.hotwords) || "")
        .split(/[,，、;；\n\r\t]+/)
        .map((s) => s.trim())
        .filter(Boolean).length;
      say(n ? `已保存热词 ${n} 个：转写时会当上下文用，人名和项目代号会准很多` : "已清空热词");
    } else if (name === "enroll") {
      msg = { text: "已转到桌宠窗口，按气泡提示看镜头拍照", ok: true };
      renderMsg();
      window.dshPet.requestEnroll();
      return; // 主进程会把本窗口收起来
    } else if (name === "gate") {
      await window.dshPet.guardConfigure({ idleGateS: Number(val) });
      say(`已设为：键鼠空闲 ${val} 秒后开始确认`);
    } else if (name === "after") {
      await window.dshPet.guardConfigure({ lockAfterS: Number(val) });
      say(`已设为：人不在 ${val} 秒后锁定`);
    } else if (name === "probe") {
      await window.dshPet.guardConfigure({ probeIntervalS: Number(val) });
      say(`已设为：盯梢时每 ${val} 秒识别一次`);
    } else if (name === "stranger") {
      await window.dshPet.guardConfigure({ lockOnStranger: val === "on" });
      say(val === "on"
        ? "已开启：认出画面里是别人（连续两次）立即锁屏"
        : "已关闭：别人用电脑只在\"人不在\"累计到时间后才锁");
    } else if (name === "guard-mode") {
      const r = await window.dshPet.guardEnable(val === "on");
      say(r && r.ok ? (r.enabled ? "应用锁屏已开启" : "应用锁屏已关闭") : (r && r.error) || "操作失败", r && r.ok);
    } else if (name === "lock-now") {
      const s = await window.dshPet.guardLockNow();
      if (!(s && s.locked)) say("需要先设置密码才能立即锁定", false);
      else return; // 覆盖层已盖上，本窗口会被主进程收起
    } else if (name === "clear-pw") {
      if (!(guardState && guardState.hasPassword)) say("还没有设置密码", false);
      else { await window.dshPet.guardClearPassword(); say("密码已清除，应用锁屏已关闭"); }
    } else if (name === "sysguard") {
      const r = await window.dshPet.guardToggle();
      say(r && r.enabled ? "系统锁屏已开启" : "系统锁屏已关闭");
    } else if (name === "hardlock") {
      const v = Number(val);
      await window.dshPet.guardConfigure({ hardLockAfterS: v });
      say(v === 0
        ? "已关闭硬锁兜底：只保留壁纸锁屏"
        : `已设为：锁屏 ${Math.round(v / 60)} 分钟没人解锁 → 追加系统锁屏兜底`);
    } else if (name === "gate-custom") {
      const v = Number(customSec.gate);
      if (!customSec.gate || !(v >= 2 && v <= 300)) say("键鼠空闲请填 2~300 之间的秒数", false);
      else { await window.dshPet.guardConfigure({ idleGateS: v }); say(`已设为：键鼠空闲 ${v} 秒后开始确认`); }
    } else if (name === "after-custom") {
      const v = Number(customSec.after);
      if (!customSec.after || !(v >= 2 && v <= 600)) say("离开时长请填 2~600 之间的秒数", false);
      else { await window.dshPet.guardConfigure({ lockAfterS: v }); say(`已设为：人不在 ${v} 秒后锁定`); }
    }
    await refresh();
  }

  function bind() {
    host.querySelectorAll("[data-act]").forEach((el) => {
      el.addEventListener("click", () => act(el.dataset.act, el.dataset.val));
    });

    // 加提醒的两个输入框：输入即记住（重绘后按草稿回填），回车等同点"添加"
    const atInput = document.getElementById("remindAt");
    const textInput = document.getElementById("remindText");
    if (atInput) atInput.addEventListener("input", () => { remindDraft.at = atInput.value; });
    if (textInput) {
      textInput.addEventListener("input", () => { remindDraft.text = textInput.value; });
      textInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); act("remind-add"); }
      });
    }

    // 旁听卡片两个输入框：输入即记住（重绘后按草稿回填），回车 = 点那个按钮
    const keepInput = document.getElementById("meetKeep");
    const hotInput = document.getElementById("meetHot");
    if (keepInput) {
      keepInput.addEventListener("input", () => { meetDraft.keep = keepInput.value; });
      keepInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); act("meetkeep-custom"); }
      });
    }
    if (hotInput) {
      hotInput.addEventListener("input", () => { meetDraft.hot = hotInput.value; });
      hotInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); act("meethot-save"); }
      });
    }

    // 自定义秒数：输入即记住，回车等同点"应用"
    for (const [id, key, name] of [["gateCustom", "gate", "gate-custom"], ["afterCustom", "after", "after-custom"]]) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.addEventListener("input", () => { customSec[key] = input.value; });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); act(name); }
      });
    }

    // 本体配色输入框：回车等同点"应用"（值本身来自状态，不需要草稿）
    const bodyInput = document.getElementById("bodyColorInput");
    if (bodyInput) {
      bodyInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); act("bodycolor-custom"); }
      });
    }

    const pw = document.getElementById("lockPwInput");
    const saveBtn = document.getElementById("lockPwSave");
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        const v = pw ? pw.value : "";
        if (!v) { msg = { text: "请先输入密码", ok: false }; renderMsg(); return; }
        const r = await window.dshPet.guardSetPassword(v);
        if (r && r.ok) {
          if (pw) pw.value = "";
          msg = { text: "密码已保存，应用锁屏已开启 ✅", ok: true };
          await refresh();
        } else {
          msg = { text: (r && r.error) || "设置失败", ok: false };
          renderMsg();
        }
      });
    }
    if (pw) {
      pw.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); if (saveBtn) saveBtn.click(); }
      });
    }
  }

  // 主进程推送：身份结论 / 锁屏状态 → 状态条实时刷新
  if (window.dshPet) {
    if (window.dshPet.onPresenceSample) {
      window.dshPet.onPresenceSample((p) => {
        if (!p) return;
        cachedPresence = p;
        renderStatusStrip();
      });
    }
    if (window.dshPet.onGuardStatus) {
      window.dshPet.onGuardStatus((s) => {
        if (s) { guardState = s; renderStatusStrip(); }
      });
    }
  }

  refresh();
})();