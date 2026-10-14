// main.js - Electron main process for the DSH desktop pet.

const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage, powerMonitor, screen, desktopCapturer, session } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const privacy = require("./privacy");
const reminders = require("./reminders");
const meetingConfig = require("./meeting-config");
const { MeetingRecorder, stamp } = require("./meeting");
const { AskHub } = require("./ask-hub");
const musicConfig = require("./music-config");
const { MusicWatcher } = require("./music");
const EventLog = require("./eventlog");
const { DshClient } = require("./dsh-client");
const { EmotionWatcher, configureEmotionApi } = require("./emotion");
const { ScreenGuard } = require("./guard");
const { getBuiltinProviders, resolveVision, resolveText } = require("./providers");
const outfitConfig = require("./outfit-config");

// 关键修复：禁用沙箱，避免 MOJO 权限错误
app.commandLine.appendSwitch("no-sandbox");
// GPU：默认**开**（渲染走硬件合成）。
// 历史：这里原本是无条件 disable-gpu，是为了绕开这台机器上的 MOJO 权限错误；
// 但关掉 GPU 的代价实测很大——透明窗口的合成退回软件实现，鲸鱼身上任何持续动画
// （比如 DSH 没跑时的 breathe）都要整窗重画：渲染线程占单核 83%（动画全停也有 35%），
// 拖动跟着顿。实测同一台机器开 GPU 后：83% → 30%，且启动无 MOJO 报错，故改为默认开。
// 万一你的机器上开 GPU 出现黑底/闪烁/启动报错：设环境变量 DSH_PET_GPU=0 回到旧的稳妥设置。
if (process.env.DSH_PET_GPU === "0") {
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  app.commandLine.appendSwitch("disable-gpu");
  console.log("[dsh] GPU 已关闭（DSH_PET_GPU=0）：走软件合成");
} else {
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
}
// 禁用网络服务沙箱（Windows 上导致 FATAL mojo 错误的根源）
app.commandLine.appendSwitch("disable-features", "NetworkServiceSandbox,NetworkServiceInProcess");
app.commandLine.appendSwitch("no-network-sandbox");

// 数据目录：开发态用项目里的 data/（便于调试、跟着仓库走）；
// 打包安装后（NSIS 装到 Program Files，目录只读）用 Electron 默认的 %APPDATA%\dsh-pet。
// 加固：只要跑的是本仓库 node_modules 下的 electron，就一律钉死 data\，不看 isPackaged——
// 一旦 dist\resources 里混进一个 app.asar，isPackaged 会误报 true，实例就去读 %APPDATA%
// 空目录（没密钥 → 每次启动都弹"初次设置"，还 401）。曾经真实踩过这个坑。
const repoElectron = process.execPath
  .toLowerCase()
  .startsWith(path.join(__dirname, "node_modules").toLowerCase());
if (!app.isPackaged || repoElectron) {
  app.setPath("userData", path.join(__dirname, "data"));
}
console.log(`[dsh] Using userData: ${app.getPath("userData")}`);

// 单实例锁：防止启动多个桌面宠物
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log("[dsh] another instance is running, quitting...");
  app.quit();
} else {
  // 又有人启动了桌宠（多半是重复点了启动器/双击了 vbs）→ 把已经在跑的这只叫到最前。
  // 注意"藏着"的情况：托盘隐藏后窗口 isVisible() 是 false，这时 focus() 一点用都没有，
  // 主人会以为"点了没反应"，所以先 show() 再抬到最前。
  app.on("second-instance", () => {
    if (petWin && !petWin.isDestroyed()) {
      if (petWin.isMinimized()) petWin.restore();
      if (!petWin.isVisible()) petWin.show();
      petWin.moveTop();
      petWin.focus();
    }
  });
}

const PANEL_URL = process.env.DSH_PANEL_URL || "http://127.0.0.1:3080";
const DSH_BASE = process.env.DSH_BASE || "http://127.0.0.1:3080";
const PET_W = 320; // 加宽，容纳 3 个泡泡菜单不超出边界
const PET_H = 440; // 加高，为鲸鱼上方的对话框预留空间（透明区域）
const ASK_CARD_W = 380; // "秒答"卡片宽度：够放下几行答案，又不至于横着一大片挡事

let petWin = null;
let panelWin = null;
let tray = null;
let dsh = null;
let petAlwaysOnTop = true; // 记录当前置顶状态

// 隐私开关（data/privacy.json）：目前只有"屏幕截屏"一项，默认开。
// 关掉后 captureScreenJpeg 直接返回 null —— 屏幕帧一帧都不会被抓，更不会上云。
let screenCaptureEnabled = privacy.load(app.getPath("userData")).screenCapture;
console.log(`[dsh] 屏幕截屏开关: ${screenCaptureEnabled ? "开" : "关"}（data/privacy.json）`);

// 提醒设置（data/reminders.json）：饭点提醒（默认开）+ 主人自己设的定时提醒（吃药…）
let reminderCfg = reminders.load(app.getPath("userData"));
console.log(`[dsh] 提醒：饭点${reminderCfg.mealReminder ? "开" : "关"} · 自定义 ${reminderCfg.items.length} 条（data/reminders.json）`);

// 桌宠窗口当前是否可见（托盘菜单文案用）
function petVisible() {
  return !!(petWin && !petWin.isDestroyed() && petWin.isVisible());
}

/** 托盘：隐藏 / 显示桌宠。隐藏只是不画出来，情绪识别与看家照常在后台跑 */
function togglePetVisible(force, why) {
  if (!petWin || petWin.isDestroyed()) return;
  const show = typeof force === "boolean" ? force : !petVisible();
  if (show) petWin.show();
  else petWin.hide();
  // 把"谁改的可见性"记下来：托盘单击和菜单项走的是同一个函数，
  // 出问题时（比如"桌宠怎么不见了"）要靠这条日志分辨来源。
  console.log(`[dsh] pet window visible -> ${show}（${why || "未知来源"}）`);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// 切换置顶状态
function toggleAlwaysOnTop() {
  petAlwaysOnTop = !petAlwaysOnTop;
  if (petWin && !petWin.isDestroyed()) {
    petWin.setAlwaysOnTop(petAlwaysOnTop, petAlwaysOnTop ? "floating" : "normal");
    if (petAlwaysOnTop) {
      // 光设 topmost 不够，两件事都得补：
      //   ① 窗口可能正"藏在托盘里"——藏着的窗口设了置顶也什么都看不见（主人就踩过这个：
      //      点"保持置顶"没反应，其实窗口当时是隐藏的）；
      //   ② 设了 topmost 不等于抬到最前，可能仍被别的窗口压着。
      // 点"置顶"的意图就是"让鲸鱼显示在最上面"，所以这里顺手显示 + 抬到最前（不抢焦点）。
      if (!petVisible()) petWin.show();
      petWin.moveTop();
    }
  }
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
  }
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send("pet:always-on-top", petAlwaysOnTop);
  }
  console.log(`[dsh] alwaysOnTop -> ${petAlwaysOnTop}（可见=${petVisible()}）`);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "打开面板", click: () => openPanel() },
    { label: "打开浏览器面板", click: () => shell.openExternal(PANEL_URL) },
    {
      // 跟"应用锁屏"那条一样，标签里写清"当前状态 + 点下去会怎样"：
      // 这两种开关都是点一次切一次，只写动作名的话点完看不出状态变没变。
      label: petVisible() ? "👁 桌宠：显示中（点这里隐藏）" : "🙈 桌宠：已隐藏（点这里显示）",
      click: () => togglePetVisible(undefined, "托盘菜单"),
    },
    {
      label: petAlwaysOnTop ? "📌 置顶：已开启（点这里取消）" : "📌 置顶：已关闭（点这里开启）",
      click: () => toggleAlwaysOnTop(),
    },
    {
      label: "情绪监测",
      submenu: [
        { label: "开/关摄像头识别", click: () => emotionToggle() },
        { label: "查看情绪报告", click: () => showEmotionReport() },
      ],
    },
    {
      // 会议旁听：开始/结束都从这里切（开始时会先弹一下本地确认，那一击同时满足录音的手势要求）
      label: meeting && meeting.status().active
        ? (meeting.status().paused
            ? "🎧 旁听：暂停中（点这里结束并出纪要）"
            : "🎧 旁听：记录中（点这里结束并出纪要）")
        : "🎧 旁听：未开始（点这里旁听这场会）",
      click: () => meetingToggle(),
    },
    // 会中休息：只在已经开着旁听时才出现
    ...(meeting && meeting.status().active
      ? [{
          label: meeting.status().paused ? "▶️ 继续旁听（接着往纪要里记）" : "⏸ 暂停一下（休息不录，这场会不结束）",
          click: () => meetingPauseToggle(),
        }]
      : []),
    { label: "📝 会议记录（历次纪要）", click: () => openMinutes() },
    {
      // 吃饭打卡：鲸鱼窗口被挡住时也能记（对话框在桌宠窗口里弹，所以先把鲸鱼显出来）
      label: "🍚 记录吃饭",
      click: () => {
        togglePetVisible(true, "托盘菜单·记录吃饭");
        petSend("pet:meal-open");
      },
    },
    {
      label: "心情设置",
      click: () => openSettings(),
    },
    {
      // 识别不准就在这里反馈：列出识别记录，挑出错的演示一遍真实动作
      label: "识别反馈 / 演示教学",
      click: () => openFeedbackTool("feedback"),
    },
    {
      label: "应用锁屏",
      submenu: [
        { label: screenGuard && screenGuard.locked ? "已锁定（输入密码解锁）" : "立即锁定", click: () => guardLockNow() },
        {
          // 标签里写清楚"当前状态 + 点下去会怎样"：这个开关点一次就切换一次，
          // 之前标签只有"关闭应用锁屏"，误点之后又没有任何可见反馈（桌宠窗口可能是隐藏的），
          // 结果就是"锁屏怎么不管用了"却找不到原因。
          label:
            screenGuard && screenGuard.enabled
              ? "🔒 应用锁屏：已开启（点这里关闭）"
              : "🔓 应用锁屏：已关闭（点这里开启）",
          click: () => guardToggle(),
        },
      ],
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
}

// ---- pet window -----------------------------------------------------------

function createPetWindow() {
  console.log("[dsh] Creating pet window...");
  
  petWin = new BrowserWindow({
    width: PET_W,
    height: PET_H,
    x: 100,
    y: 100,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 摄像头抓帧必须在窗口被遮挡时也继续（锁屏覆盖层会盖住鲸鱼窗口）
      backgroundThrottling: false,
    },
  });

  petWin.setAlwaysOnTop(true, "floating");
  
  console.log("[dsh] Window created, showing...");
  petWin.show();
  console.log("[dsh] Window size:", petWin.getSize());
  console.log("[dsh] Window bounds:", petWin.getBounds());
  console.log("[dsh] Content size:", petWin.getContentSize());
  
  petWin.loadFile(path.join(__dirname, "renderer", "index.html"));

  // 摄像头权限：仅放行媒体采集（情绪识别用），其余默认拒绝
  petWin.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "media");
  });
  petWin.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return permission === "media";
  });
  
  // 转发渲染进程 console 到主进程日志（调试用）
  // 兼容两种签名：旧版 (event, level, message)；Electron ≥32 (event, details{level,message})
  petWin.webContents.on("console-message", (_e, ...args) => {
    let level, message;
    if (typeof args[0] === "object" && args[0] !== null) {
      level = args[0].level;
      message = args[0].message;
    } else {
      level = args[0];
      message = args[1];
    }
    if (typeof message !== "string") return;
    if (level <= 2 || level === "info" || level === "warning") {
      console.log(`[renderer] ${message}`);
    } else {
      console.error(`[renderer:error] ${message}`);
    }
  });

  // 添加更多调试信息
  petWin.webContents.on("did-finish-load", () => {
    console.log("[dsh] Renderer loaded successfully");
    // 渲染层就绪后：下发摄像头初始开关 + 首启动弹认主窗口（已认主则打招呼）
    setTimeout(() => {
      // 置顶状态主动推一次，右上角钉子按钮才能显示正确状态
      petSend("pet:always-on-top", petAlwaysOnTop);
      petSend("pet:outfit", outfitCfg); // 初始装扮（戴着上次选的帽子启动）
      petSend("pet:emotion-camera", {
        enabled: emotionWatcher ? emotionWatcher.enabled : true,
        intervalMs: cameraCadenceMs(),
        probe: false,
      });
      maybeOpenOnboarding();
    }, 500);
  });
  
  petWin.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    console.error("[dsh] Renderer failed to load:", errorCode, errorDescription);
  });
  
  petWin.webContents.on("crashed", () => {
    console.error("[dsh] Renderer crashed!");
  });

  petWin.on("closed", () => {
    petWin = null;
  });
}

// ---- panel window ---------------------------------------------------------

function openPanel() {
  if (panelWin) {
    if (panelWin.isMinimized()) panelWin.restore();
    panelWin.focus();
    return;
  }
  panelWin = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#0b1622",
    title: "Blub",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panelWin.loadURL(PANEL_URL);
  panelWin.on("closed", () => {
    panelWin = null;
  });
}

// ---- 应用级锁屏（全屏覆盖层，非系统锁屏）------------------------------------

let screenGuard = null;
let lockWin = null;

/** 所有显示器的并集范围（多屏一起遮住） */
function unionDisplayBounds() {
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1280, height: 800 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function initGuard() {
  screenGuard = new ScreenGuard({
    dataDir: app.getPath("userData"),
    idleGateS: Number(process.env.DSH_PET_IDLE_GATE) || undefined,
    lockAfterMs: Number(process.env.DSH_PET_LOCK_AFTER) ? Number(process.env.DSH_PET_LOCK_AFTER) * 1000 : undefined,
    getIdleSeconds: () => {
      try { return powerMonitor.getSystemIdleTime(); } catch { return 0; }
    },
    isEnrolled: () => !!(emotionWatcher && emotionWatcher.isEnrolled()),
    onLog: (line) => process.stderr.write(line + "\n"),
    // 调整抓帧节奏 + 让情绪模块切到便宜的在场探测模式
    onCadence: (ms, probe) => {
      if (emotionWatcher) emotionWatcher.setProbe(!!probe, ms || undefined);
      petSend("pet:emotion-camera", {
        // 探测/锁定期必须开摄像头，否则刷脸解锁无从谈起（与情绪识别开关解耦）
        enabled: probe ? true : (emotionWatcher ? emotionWatcher.enabled : true),
        intervalMs: ms || cameraCadenceMs(),
        probe: !!probe,
      });
    },
    onLock: () => {
      createLockWindow();
      // 锁屏覆盖层是全屏的，设置窗口先收起来免得混在 Alt+Tab 里
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.hide();
      pushGuardStatus();
    },
    // 键鼠刚静下来：立即抓一帧识别一次（之后按固定节奏复检）
    onProbeNow: () => {
      petSend("pet:emotion-camera", {
        enabled: true,
        intervalMs: screenGuard ? screenGuard.probeIntervalMs : 5000,
        probe: true,
        probeNow: true,
      });
    },
    onUnlock: (info) => {
      const face = !!(info && info.reason === "face");
      if (face && lockWin && !lockWin.isDestroyed()) {
        // 刷脸开门的两条路，都要让锁屏先把画面演完再撤覆盖层（不然窗口一关什么都看不见）：
        //   看家满 30 分钟 → 播"🎉 终于等到主人啦"告别动画（带真实看家时长）
        //   不到 30 分钟   → 只把"确认到你"这一下演出来（绿底 + 鲸鱼跳两下）
        const longEnough = (info.guardMs || 0) >= UNLOCK_ANIM_MIN_GUARD_MS;
        if (longEnough) {
          lockWin.webContents.send("pet:unlock-anim", { guardMs: info.guardMs || 0 });
        } else {
          lockWin.webContents.send("pet:owner-confirmed", { guardMs: info.guardMs || 0 });
        }
        pushGuardStatus();
        if (unlockAnimTimer) clearTimeout(unlockAnimTimer);
        unlockAnimTimer = setTimeout(() => {
          unlockAnimTimer = null;
          destroyLockWindow();
        }, longEnough ? UNLOCK_ANIM_MS : OWNER_CONFIRM_MS);
        return;
      }
      destroyLockWindow();
      pushGuardStatus();
    },
    // 硬锁兜底：壁纸锁屏盖上后 N 分钟没人解锁 → 追加系统锁屏（真拦住）
    onHardLock: () => {
      try {
        const { spawn } = require("child_process");
        spawn("rundll32.exe", ["user32.dll,LockWorkStation"], { detached: true, stdio: "ignore" }).unref();
        console.log("[dsh] 壁纸锁屏超时没人解锁 -> 追加系统锁屏兜底");
      } catch (err) {
        console.error("[dsh] hard lock failed:", err.message);
      }
      pushGuardStatus();
    },
  });
  if (screenGuard.enabled) screenGuard.start();
  console.log(`[dsh] screen guard ready (enabled=${screenGuard.enabled}, password=${screenGuard.hasPassword()})`);
  if (tray) tray.setContextMenu(buildTrayMenu());

  // 系统锁屏期间不必重复看家；系统解锁后恢复
  powerMonitor.on("lock-screen", () => {
    if (screenGuard) { screenGuard.absentSince = 0; screenGuard.stop(); }
  });
  powerMonitor.on("unlock-screen", () => {
    if (screenGuard && screenGuard.enabled) screenGuard.start();
  });
}

// 刷脸解锁后让锁屏先把动画播完再撤（这段时间已经不算锁定了，只是画面还没撤）
const UNLOCK_ANIM_MS = 3000;
// 不够 30 分钟时只演"确认到你"这一下：绿底 + 鲸鱼跳两下（0.6s × 3 ≈ 1.8s），
// 留 2 秒让它跳完再撤覆盖层，否则窗口一关绿底根本来不及出现。
const OWNER_CONFIRM_MS = 2000;
// 只有真的等了很久才值得庆祝：看家满 30 分钟才说"终于等到主人啦"，
// 日常走开几分钟开门就只是绿底"找到主人啦，我这就开门～"，不播告别动画。
const UNLOCK_ANIM_MIN_GUARD_MS = 30 * 60 * 1000;
let unlockAnimTimer = null;

function createLockWindow() {
  if (lockWin && !lockWin.isDestroyed()) { lockWin.focus(); return; }
  // 重新上锁时取消上一次还没播完的告别动画
  if (unlockAnimTimer) { clearTimeout(unlockAnimTimer); unlockAnimTimer = null; }
  const b = unionDisplayBounds();
  lockWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    skipTaskbar: false,
    backgroundColor: "#050d18",
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockWin.setAlwaysOnTop(true, "screen-saver");
  lockWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lockWin.loadFile(path.join(__dirname, "renderer", "lock.html"));
  // 锁定期间不允许被关闭
  lockWin.on("close", (e) => {
    if (screenGuard && screenGuard.locked) e.preventDefault();
  });
  lockWin.on("closed", () => { lockWin = null; });
  lockWin.once("ready-to-show", () => { if (lockWin) lockWin.focus(); });
  console.log("[dsh] lock overlay shown");
}

function destroyLockWindow() {
  if (unlockAnimTimer) { clearTimeout(unlockAnimTimer); unlockAnimTimer = null; }
  if (lockWin && !lockWin.isDestroyed()) {
    const w = lockWin;
    lockWin = null;
    w.removeAllListeners("close");
    w.destroy();
  } else {
    lockWin = null;
  }
  console.log("[dsh] lock overlay hidden");
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/** 把锁屏状态推给渲染层（心情记录状态条要实时反映"会不会锁屏"） */
function pushGuardStatus() {
  broadcast("pet:guard-status", screenGuard ? screenGuard.status : null);
}

/** 推给所有关心该事件的窗口：桌宠 + 心情设置 + 锁屏覆盖层（摄像头指令仍只发桌宠） */
function broadcast(channel, payload) {
  petSend(channel, payload);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
  // 锁屏覆盖层要知道"镜头前是不是主人"——好决定继续等还是发火
  if (lockWin && !lockWin.isDestroyed()) lockWin.webContents.send(channel, payload);
}

/** 托盘/面板：立即锁定 */
function guardLockNow() {
  if (!screenGuard) return;
  if (!screenGuard.hasPassword()) {
    petSend("pet:companion", { text: "🔐 先设个密码才能用应用锁屏哦（心情 → ⚙ 设置）", mood: "calm" });
    togglePetVisible(true);
    return;
  }
  screenGuard.lock("manual");
}

/** 托盘：开关应用锁屏 */
function guardToggle() {
  if (!screenGuard) return;
  const r = screenGuard.setEnabled(!screenGuard.enabled);
  if (!r.ok) {
    petSend("pet:companion", { text: `🔒 ${r.error}（心情 → ⚙ 设置）`, mood: "calm" });
    togglePetVisible(true);
  } else {
    petSend("pet:companion", {
      text: r.enabled
        ? `🔒 应用锁屏已开启：键鼠静下来 ${r.idleGateS}s 先看一眼，之后每 ${r.probeIntervalS}s 复检；认出别人直接锁，人不在 ${r.lockAfterS}s 锁屏`
        : "🔓 应用锁屏已关闭",
      mood: "calm",
    });
  }
  if (tray) tray.setContextMenu(buildTrayMenu());
  pushGuardStatus();
}

// ---- onboarding window（首启动认主引导）------------------------------------

let onboardWin = null;

/** 未配 API 时先弹首启向导；配置齐了再走"未认主弹认主窗口 / 已认主打招呼"的老逻辑 */
function maybeOpenOnboarding() {
  if (apiKeysMissing()) {
    openFirstRun();
    return;
  }
  if (emotionWatcher && emotionWatcher.isEnrolled()) {
    petSend("pet:companion", { text: "主人你好呀～鲸鱼一直在等你回来", mood: "happy" });
    return;
  }
  openOnboarding();
}

// ---- 首启向导（第一次打开：配 API / 昵称 / 自检）---------------------------

let firstRunWin = null;

function openFirstRun() {
  if (firstRunWin && !firstRunWin.isDestroyed()) {
    firstRunWin.show();
    firstRunWin.focus();
    return;
  }
  firstRunWin = new BrowserWindow({
    width: 560,
    height: 660,
    minWidth: 480,
    minHeight: 560,
    resizable: true,
    backgroundColor: "#0b1622",
    title: "欢迎使用 · 初次设置",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  firstRunWin.loadFile(path.join(__dirname, "renderer", "firstrun.html"));
  firstRunWin.on("closed", () => {
    firstRunWin = null;
  });
}

// ---- 桌宠档案（名字/称呼，data/profile.json）--------------------------------
const PROFILE_FILE = path.join(app.getPath("userData"), "profile.json");

function loadProfile() {
  try {
    const p = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
    return { petName: p.petName || "鲸鱼", ownerName: p.ownerName || "主人" };
  } catch (_) {
    return { petName: "鲸鱼", ownerName: "主人" };
  }
}

let petProfile = loadProfile();

function saveProfile(p) {
  try {
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(p, null, 2), "utf8");
    petProfile = { petName: p.petName || "鲸鱼", ownerName: p.ownerName || "主人" };
  } catch (err) {
    console.error(`[dsh] profile.json 写入失败：${err.message}`);
  }
}

// ---- 换装（帽子 + 配色，data/outfit.json）------------------------------------
// 纯外观：存一个帽子 id + 一个配色，改了立即广播给桌宠窗口重画，不上云、不参与识别。
let outfitCfg = outfitConfig.load(app.getPath("userData"));

ipcMain.handle("pet:outfit-get", () => JSON.parse(JSON.stringify(outfitCfg)));
ipcMain.handle("pet:outfit-set", (_e, cfg) => {
  // 逐槽位深合并：只改"帽子 id"时不会把帽子颜色冲掉（{hat:{id}} 不该清掉 hat.color）
  outfitCfg = outfitConfig.save(app.getPath("userData"), outfitConfig.merge(outfitCfg, cfg));
  petSend("pet:outfit", outfitCfg); // 桌宠窗口立即换装（设置窗口/泡泡菜单都能触发）
  const worn = outfitConfig.SLOT_KEYS.filter((k) => outfitCfg[k].id !== "none")
    .map((k) => `${k}=${outfitCfg[k].id}`).join(" ");
  console.log(`[dsh] 外观 -> 本体=${outfitCfg.bodyColor} ${worn || "（无装扮）"}`);
  return JSON.parse(JSON.stringify(outfitCfg));
});

function openOnboarding() {
  if (onboardWin) {
    onboardWin.focus();
    return;
  }
  onboardWin = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    backgroundColor: "#0b1622",
    title: "鲸鱼认主",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  onboardWin.loadFile(path.join(__dirname, "renderer", "onboarding.html"));
  onboardWin.on("closed", () => {
    onboardWin = null;
  });
}

// ---- 识别反馈 / 演示教学工具（独立进程的 calib 应用）------------------------
//
// 为什么不内嵌成一个窗口：演示要独占摄像头、还要加载人脸模型，标定时可能来回跑几轮，
// 单独进程最稳（它崩了不影响桌宠）。这里只负责把那个窗口叫起来。

let feedbackOpenedAt = 0;

function openFeedbackTool(tab) {
  const now = Date.now();
  if (now - feedbackOpenedAt < 5000) return; // 防连点（那个工具自己有单实例锁，重复叫也没用）
  feedbackOpenedAt = now;
  try {
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [path.join(__dirname, "calib", "main.js"), `--tab=${tab || "feedback"}`], {
      detached: true,
      stdio: "ignore",
      cwd: __dirname,
    });
    child.unref();
    console.log(`[dsh] 打开识别反馈工具（tab=${tab || "feedback"}）`);
  } catch (err) {
    console.error("[dsh] 打开识别反馈工具失败:", err.message);
  }
}

// ---- 心情设置窗口（独立窗口，桌宠面板右上角 ⚙ 打开）------------------------

let settingsWin = null;

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 430,
    height: 640,
    minWidth: 360,
    minHeight: 420,
    backgroundColor: "#0b1622",
    title: "心情设置",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, "renderer", "settings.html"));
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

// ---- tray -----------------------------------------------------------------

function createTray() {
  // 优先用 assets/tray.png（蓝底白鲸 32x32，任务栏上看得清）；
  // 读不到就退回内嵌小图标，保证托盘一定存在
  let icon = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  if (icon.isEmpty()) icon = fallbackTrayIcon();
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Blub 桌宠\n单击：显示/隐藏桌宠 · 右键：菜单");
  tray.setContextMenu(buildTrayMenu());
  // 单击托盘图标 = 显示/隐藏桌宠（藏起来后靠它找回来）
  tray.on("click", () => togglePetVisible(undefined, "托盘单击"));
}

/** 内嵌兜底托盘图标（assets/tray.png 缺失时用） */
function fallbackTrayIcon() {
  return nativeImage.createFromBuffer(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVR4nO3OMQEAIAzAMf9oww4ydeIkJ7YDnHsQE5Kkf0sBAAAAAIC3+w9zA+4CwHF+A/UCAABs1QE0+gENaHID6QAAAABJRU5ErkJggg==",
      "base64"
    )
  );
}

// ---- 大模型 API（OpenAI 兼容）---------------------------------------------
// 密钥不写在代码里：从 data/api-keys.json 读（环境变量优先，方便临时覆盖）。
// 该文件已被 .gitignore 排除，所以把仓库分享给别人时密钥不会跟着走。
// 文件缺失或填错时密钥为空 → 视觉/文字请求失败并在日志里说清原因。
// 这是有意的"失败即停"：把密钥藏在代码里悄悄兜底，反而会让人忘了它已经泄露。

const API_KEYS_FILE = path.join(app.getPath("userData"), "api-keys.json");
// 兜底源：仓库里的 data\api-keys.json。万一某个实例的 userData 指去了别处（比如 %APPDATA%）
// 或者 userData 里被"以后再说"写空了，只要还是从本仓库启动的，密钥照样找得到，
// 不会再每次启动都弹"初次设置"。仓库配置只读不写，用户在向导里保存的永远优先。
const REPO_API_KEYS_FILE = path.join(__dirname, "data", "api-keys.json");

// 首启向导写回的配置结构（新版，多厂商）：
//   {
//     providers: [{id,label,kind,base,models:[{id,label,vision,text}]}...],  // 用户在向导里选/加的厂商
//     vision: { providerId, base, key, model },   // 视觉通道选中项
//     text:   { providerId, base, key, model }    // 文本通道选中项
//   }
// 旧版是扁平字段（visionBase/visionKey/textBase/textKey）。为了不弄丢老用户的 key，
// loadApiKeys() 读到旧格式会自动折算成新格式（不落盘），下次向导保存时才覆盖。

function readApiKeysFile(file) {
  const p = file || API_KEYS_FILE;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`[dsh] ${p} 读取失败：${err.message}`);
    return {};
  }
}

// 取出"任意格式"配置里的端点原始值（新嵌套 / 旧扁平都吃）
function readEndpoints(cfg) {
  return {
    vision: cfg.vision || {
      providerId: "zhipu",
      base: cfg.visionBase,
      key: cfg.visionKey,
      model: cfg.visionModel,
    },
    text: cfg.text || {
      providerId: "deepseek",
      base: cfg.textBase,
      key: cfg.textKey,
      model: cfg.textModel,
    },
  };
}

function loadApiKeys() {
  const cfg = readApiKeysFile();
  // 兜底源（仓库 data\）。userData 里缺哪一路密钥就从仓库补哪一路，
  // ——让"userData 指错目录 / '以后再说'把两路都写成 null / 旧格式"都不会再触发首启弹窗。
  const repo = (API_KEYS_FILE === REPO_API_KEYS_FILE) ? {} : readApiKeysFile(REPO_API_KEYS_FILE);
  const repoEp = readEndpoints(repo);
  const { vision: visionRaw, text: textRaw } = readEndpoints(cfg);

  // 如果 userData 这一路 key 是空，就用仓库那路
  const mergedVision = visionRaw.key ? visionRaw : repoEp.vision.key ? repoEp.vision : visionRaw;
  const mergedText = textRaw.key ? textRaw : repoEp.text.key ? repoEp.text : textRaw;
  if (visionRaw.key && !textRaw.key && repoEp.text.key) {
    console.log(`[dsh] text 密钥从仓库配置兜底（${REPO_API_KEYS_FILE}）`);
  } else if (textRaw.key && !visionRaw.key && repoEp.vision.key) {
    console.log(`[dsh] vision 密钥从仓库配置兜底（${REPO_API_KEYS_FILE}）`);
  } else if (!visionRaw.key && !textRaw.key && (repoEp.vision.key || repoEp.text.key)) {
    console.log(`[dsh] 两路密钥都从仓库配置兜底（${REPO_API_KEYS_FILE}）`);
  }

  const providers = Array.isArray(cfg.providers) && cfg.providers.length ? cfg.providers : getBuiltinProviders();

  const vis = resolveVision(mergedVision, providers);
  const txt = resolveText(mergedText, providers);
  const pick = (envVal, fileVal, dflt) => envVal || fileVal || dflt;

  return {
    providers,
    vision: {
      providerId: mergedVision.providerId || "zhipu",
      base: pick(process.env.DSH_PET_API_BASE, vis.base, "https://open.bigmodel.cn/api/paas/v4"),
      key: pick(process.env.DSH_PET_API_KEY, vis.key, ""),
      model: pick(process.env.DSH_PET_VISION_MODEL, vis.model, "glm-4v-flash"),
    },
    text: {
      providerId: mergedText.providerId || "deepseek",
      base: pick(process.env.DSH_PET_TEXT_API_BASE, txt.base, "https://api.deepseek.com/v1"),
      key: pick(process.env.DSH_PET_TEXT_API_KEY, txt.key, ""),
      model: pick(process.env.DSH_PET_TEXT_MODEL, txt.model, "deepseek-flash"),
    },
    // 兼容旧调用方
    visionBase: vis.base,
    visionKey: vis.key,
    textBase: txt.base,
    textKey: txt.key,
  };
}

// 向导保存时调用：把新配置落盘（原子写，避免写一半崩了留个坏 json）
function saveApiKeys(next) {
  const tmp = API_KEYS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, API_KEYS_FILE);
}

/** 是否还没配过任何 API（首启向导的触发条件之一） */
function apiKeysMissing() {
  const cfg = loadApiKeys();
  return !cfg.vision.key && !cfg.text.key;
}

const API_KEYS = loadApiKeys();
if (!API_KEYS.vision.key || !API_KEYS.text.key) {
  console.error(`[dsh] ⚠️ API 密钥缺失（vision/text），视觉与文字功能会失败。请在 ${API_KEYS_FILE} 里填好并重启桌宠`);
}

// 视觉通道——情绪/行为/身份识别、屏幕摘要。可变对象：向导保存后原地改字段即可全局生效
const PET_API = { base: API_KEYS.vision.base, key: API_KEYS.vision.key };
const VISION_MODEL = API_KEYS.vision.model;

// 文字通道——情绪原因推测 / 讲笑话 / 会议纪要。可变对象，同上
const TEXT_API = { base: API_KEYS.text.base, key: API_KEYS.text.key };
const TEXT_MODEL = API_KEYS.text.model;

/** 向导保存后热更新，免重启 */
function applyApiKeys(cfg) {
  if (!cfg) return;
  if (cfg.vision) {
    PET_API.base = cfg.vision.base;
    PET_API.key = cfg.vision.key;
    if (cfg.vision.model) _setVisionModel(cfg.vision.model);
  }
  if (cfg.text) {
    TEXT_API.base = cfg.text.base;
    TEXT_API.key = cfg.text.key;
    if (cfg.text.model) _setTextModel(cfg.text.model);
  }
  configureEmotionApi(PET_API.base, PET_API.key);
  meetingRuntime && meetingRuntime.setApi && meetingRuntime.setApi(PET_API.base, PET_API.key);
}
function _setVisionModel(m) { try { visionModelRef.value = m; } catch (_) {} }
function _setTextModel(m) { try { textModelRef.value = m; } catch (_) {} }
const visionModelRef = { value: VISION_MODEL };
const textModelRef = { value: TEXT_MODEL };

// ---- 用量持久化存储（桌宠 + DSH 会话扫描）-------------------------------

const { UsageStore } = require("./usage-store");

// 数据目录：userData 已指向 <app>/data
let usageStore = null;
let dshScanTimer = null;

function initUsageStore() {
  const dataDir = app.getPath("userData");
  usageStore = new UsageStore({
    dataDir,
    dshSessionsDir: path.join(os.homedir(), ".dsh", "sessions"),
  });
  usageStore.load();

  // 首次后台扫描 DSH 会话（异步，不阻塞启动）
  setTimeout(() => {
    try {
      const added = usageStore.scanDshSessions();
      console.log(`[dsh] usage scan done, added ${added} records, total ${usageStore.count()}`);
      pushUsageToRenderer();
    } catch (err) {
      console.error("[dsh] usage scan failed:", err.message);
    }
  }, 2500);

  // 定期增量扫描（30s 一次）
  dshScanTimer = setInterval(() => {
    try {
      const added = usageStore.scanDshSessions();
      if (added > 0) {
        console.log(`[dsh] usage scan +${added} records`);
        pushUsageToRenderer();
      }
    } catch (err) {
      console.error("[dsh] usage scan failed:", err.message);
    }
  }, 30000);
}

// 记录桌宠自身一次用量（持久化 + 实时推送）
function recordUsage(model, usage) {
  const prompt = usage?.prompt_tokens || 0;
  const completion = usage?.completion_tokens || 0;
  const total = usage?.total_tokens || prompt + completion;
  // 缓存命中 tokens（部分 API 在 prompt_tokens_details.cached_tokens）
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;

  if (usageStore) {
    usageStore.addRecord({
      source: "pet",
      model,
      input: Math.max(0, prompt - cached),
      output: completion,
      cacheRead: cached,
      reasoning: usage?.completion_tokens_details?.reasoning_tokens || 0,
    });
    usageStore.save();
  }
  return summarizeUsage(0, "all");
}

// 汇总统计（按需过滤来源与时间范围）
function summarizeUsage(sinceTs, source) {
  if (!usageStore) return emptySummary();
  return usageStore.summarize(sinceTs || 0, source || "all");
}

function emptySummary() {
  return { calls: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, uncachedTokens: 0, lastCall: null };
}

// 推送用量到渲染器（默认全部来源、全部时间）
function pushUsageToRenderer() {
  if (petWin && !petWin.isDestroyed()) {
    const all = summarizeUsage(0, "all");
    const pet = summarizeUsage(0, "pet");
    const dsh = summarizeUsage(0, "dsh");
    const byDay = usageStore ? usageStore.groupByDay(0, "all") : {};
    petWin.webContents.send("pet:usage-stats", {
      all,
      pet,
      dsh,
      byDay,
      total: all,
      // 兼容旧渲染端字段
      totalTokens: all.totalTokens,
      promptTokens: all.inputTokens,
      completionTokens: all.outputTokens,
      cachedTokens: all.cacheReadTokens,
      uncachedTokens: all.uncachedTokens,
      calls: all.calls,
      lastCall: all.lastCall,
    });
  }
}

async function petAsk(model, question) {
  const url = `${PET_API.base}/chat/completions`;
  const body = {
    model,
    messages: [{ role: "user", content: question }],
    stream: false,
    // glm-5.3-flash 等思考模型需要大 max_tokens 容纳 reasoning + 回答
    max_tokens: 4000,
  };
  // 智谱思考模型支持 thinking 参数
  if (/glm-5\.3/i.test(model)) {
    body.thinking = { type: "enabled" };
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PET_API.key}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("API 响应中没有内容（思考模型可能需要更大 max_tokens）");
  }
  // 返回内容 + token 用量（用于攻击/暴击效果挂钩）
  const usage = data?.usage || null;
  return { content, usage };
}

/**
 * 文字通道（DeepSeek）：情绪原因推测、讲笑话用。
 * 视觉仍走 PET_API（智谱 glm-4v-flash），因为 DeepSeek 没有视觉模型。
 */
// 文字模型请求的总上限（方向 3：每次判断都要有个了结）。超时就掐断连接，
// 让 emotion.js 那侧走"失败 → 重试 → 兜底原因"，而不是永远挂着等一个不会来的回应。
const TEXT_TIMEOUT_MS = 30000;

/**
 * @param {string} model
 * @param {string} question
 * @param {number} [maxTokens] 输出上限。默认 800（推测原因/讲笑话这种一两句的够用）；
 *        会议纪要要一次写好几节，得给大一点，不然会被从中间截断。
 * @param {number} [timeoutMs] HTTP 超时。默认 30 秒；会议纪要那种几千 token 的输出要 30~60 秒，
 *        必须放长，否则会在半路被掐断（表现就是"模型没产出"→ 掉进兜底版）。
 */
async function textAsk(model, question, maxTokens, timeoutMs) {
  const url = `${TEXT_API.base}/chat/completions`;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Number(timeoutMs) > 0 ? Number(timeoutMs) : TEXT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEXT_API.key}`,
      },
      body: JSON.stringify({
        model: model || textModelRef.value,
        messages: [{ role: "user", content: question }],
        max_tokens: Number(maxTokens) > 0 ? Number(maxTokens) : 800, // deepseek-flash 会先输出 reasoning，再给答案
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`文字模型 ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("文字模型没有返回内容");
    return { content, usage: data?.usage || null };
  } catch (err) {
    if (timedOut) {
      const e = new Error(`TIMEOUT ${TEXT_TIMEOUT_MS}ms（文字模型没在限期内回应）`);
      e.code = "TIMEOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function petListModels() {
  const url = `${PET_API.base}/models`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${PET_API.key}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  return (data?.data || []).map((m) => m.id);
}

// 本地人脸识别的状态：unknown（还没起来）/ ready / failed
let faceIdentity = "unknown";

// ---- 情绪监测（摄像头 → GLM-4V 分析 → 记录/推测 → 陪伴）-------------------

let emotionWatcher = null;

/** 渲染层该按多快抓帧：取情绪 / 行为专线 / 锁屏探测里最快的那个节奏。
 *  少了这步，行为专线（10 秒）会被情绪线的抓帧节奏（60 秒）卡死——抓不到帧等于这条线不存在。 */
function cameraCadenceMs() {
  if (!emotionWatcher) return 60000;
  return emotionWatcher.captureInterval() || 60000;
}

/**
 * 抓一帧屏幕（JPEG dataURL），给"情绪突变时看看主人在忙什么"用。
 * 只抓鼠标所在的那块屏，缩到 1280×720、JPEG 70 —— 够模型看懂在干什么，又不会太大。
 * 原图只在内存里走一圈交给视觉模型，不落盘。
 * 开关（data/privacy.json 的 screenCapture）关掉时直接返回 null：一帧都不抓，
 * 更谈不上离开本机；上层 _screenHint 拿不到图就跳过这条线索，推测照常进行。
 */
async function captureScreenJpeg() {
  if (!screenCaptureEnabled) return null;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 720 },
    });
    if (!sources || !sources.length) return null;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const src =
      sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) return null;
    return `data:image/jpeg;base64,${src.thumbnail.toJPEG(70).toString("base64")}`;
  } catch (err) {
    console.error("[dsh] captureScreenJpeg failed:", err.message);
    return null;
  }
}

function initEmotion() {
  configureEmotionApi(PET_API.base, PET_API.key);
  emotionWatcher = new EmotionWatcher({
    dataDir: app.getPath("userData"),
    // 视觉主力：glm-4.6v-flash（免费、新一代、128K、可关思考，判别力比 4V-Flash 强一档）
    // 备胎：glm-4v-flash（老免费模型，免费池限流时顶上，保证识别不断档）
    visionModel: process.env.DSH_PET_VISION_MODEL || "glm-4.6v-flash",
    visionFallbacks: (process.env.DSH_PET_VISION_FALLBACKS || "glm-4v-flash")
      .split(",").map((s) => s.trim()).filter(Boolean),
    textModel: textModelRef.value,
    intervalMs: Number(process.env.DSH_PET_EMOTION_INTERVAL) || 60000,
    // 行为专线（摸下巴/托腮/伸懒腰/哈欠）：默认 5 秒一帧专门抓动作
    // （情绪线 1 分钟一帧，几秒的小动作基本抓不到；哈欠只持续 4~6 秒）。
    // env 传秒数可调，传 0 关掉。
    behaviorIntervalMs: process.env.DSH_PET_BEHAVIOR_INTERVAL !== undefined
      ? Number(process.env.DSH_PET_BEHAVIOR_INTERVAL) * 1000
      : undefined,
    // 文字活儿（推测原因/讲笑话）走 DeepSeek；视觉走智谱
    askLLM: async (model, question) => {
      const r = await textAsk(model, question);
      if (r.usage) recordUsage(model, r.usage);
      return r.content;
    },
    recordUsage,
    getDshContext: () => (dsh ? dsh.dshContext() : null),
    // 发呆判定用：系统键鼠空闲秒数（跟应用锁屏同源）
    getIdleSeconds: () => {
      try { return powerMonitor.getSystemIdleTime(); } catch { return 0; }
    },
    // 显著情绪变化要推测原因时抓一帧屏幕（只抓一次、不落盘），让推测有"在看什么"这条线索
    captureScreen: captureScreenJpeg,
    // 身份探测结论 → 应用级锁屏判定 + 渲染层状态条
    onPresence: (p) => {
      // 身份归谁管：本地人脸识别可用时只认它（云端模型会把参考照当答案点头）；
      // 它明确失败过才退回云端；还在加载（unknown）时两边都不信——启动那几十秒里
      // 拿云端结论去锁屏，最可能的结果是把正坐在电脑前的人锁在外面。
      const trusted = p.local || faceIdentity === "failed";
      if (screenGuard && trusted) screenGuard.handlePresence(p);
      broadcast("pet:presence-sample", p);
    },
    onLog: (line) => process.stderr.write(line + "\n"),
    // 分析结果 → 渲染层（鲸鱼按情绪做反应）
    onAnalysis: (sample) => {
      petSend("pet:emotion-update", { current: sample, enabled: emotionWatcher.enabled });
    },
    // 显著变化事件 → 渲染层（顺带让开着的心情面板刷新，新记录立刻出现）
    onEvent: (event) => {
      petSend("pet:emotion-event", event);
      petSend("pet:emotion-report-changed");
    },
    // 报告内容变化（原因补上 / 兜底）→ 渲染层就地刷新面板
    onReportChanged: () => petSend("pet:emotion-report-changed"),
    // 陪伴消息 → 渲染层心情气泡（可带按钮 actions 和鲸鱼动作 effect）
    onCompanion: (text, mood, payload) => {
      // 定时提醒（吃药…）自带"露个面"：桌宠可能正藏在托盘里，藏着的鲸鱼说话没人看得见
      if (payload?.showPet) togglePetVisible(true, "定时提醒");
      petSend("pet:companion", {
        text,
        mood,
        actions: payload?.actions || null,
        effect: payload?.effect || null,
      });
    },
    // 主人离开/回归（看家模式开关）→ 通知渲染层 + 按需锁屏
    onOwnerChange: (state) => {
      petSend("pet:owner-presence", state);
      if (lockWin && !lockWin.isDestroyed()) lockWin.webContents.send("pet:owner-presence", state);
      if (state.guardActive && state.lock) {
        // Windows 锁屏：主人不在时禁止任何人操控电脑
        try {
          const { spawn } = require("child_process");
          spawn("rundll32.exe", ["user32.dll,LockWorkStation"], { detached: true, stdio: "ignore" }).unref();
          console.log("[dsh] owner away -> workstation locked");
        } catch (err) {
          console.error("[dsh] lock failed:", err.message);
        }
      }
    },
  });
  console.log(`[dsh] emotion watcher ready (vision=${emotionWatcher.visionModel} 备用=${emotionWatcher.visionFallbacks.join("/") || "无"})`);
  // 把提醒设置交给 watcher：它每分钟检查一次饭点 + 主人自己设的定时提醒
  // （看家/人不在/当天问过都不打扰；自定义提醒到点后 1 小时内还会补上）
  emotionWatcher.setReminders(reminderCfg);
  // 退出前把还没结束的"段"写进标定日志（不然最后一段会丢在内存里，段长标定就少一条样本）
  app.on("before-quit", () => {
    try { emotionWatcher.flushSegments(); } catch (err) { console.error("[dsh] flushSegments failed:", err.message); }
    // 听歌读取器是个常驻子进程，退出时必须收掉（不然会在系统里留下孤儿 powershell）
    try { if (musicWatcher) musicWatcher.stop(); } catch (err) { console.error("[dsh] music stop failed:", err.message); }
    try { if (qqmProc) qqmProc.kill(); } catch (err) { console.error("[dsh] qqm daemon stop failed:", err.message); }
  });
}

/** 安全地给渲染层发消息 */
function petSend(channel, payload) {
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send(channel, payload);
  }
}

/** 托盘：开关摄像头识别 */
function emotionToggle() {
  if (!emotionWatcher) return;
  const next = !emotionWatcher.enabled;
  emotionWatcher.setEnabled(next);
  petSend("pet:emotion-camera", { enabled: next, intervalMs: cameraCadenceMs(), probe: false });
  console.log("[dsh] emotion camera ->", next ? "on" : "off");
}

/** 托盘：查看情绪报告（转发给渲染层弹报告视图） */
function showEmotionReport() {
  togglePetVisible(true); // 报告在桌宠窗口里画，先把桌宠显示出来
  if (petWin && !petWin.isDestroyed()) {
    petWin.focus();
    petWin.webContents.send("pet:emotion-show-report");
  }
}

// ---- 会议旁听（采集在渲染层；转写 / 纪要 / 落盘在这里）-----------------------
//
// 为什么采集放渲染层：系统声环回是 Chromium 的 getDisplayMedia 能力，只有页面里能拿到；
// 主进程负责三件事：① 把 getDisplayMedia 的请求直接放行成"主屏 + 系统声音"
// ② 收音频片段 → 串行转写 → 落事件日志（meeting.js）③ 纪要窗口与托盘入口。

let meeting = null;
let meetingCfg = meetingConfig.load(app.getPath("userData"));
let minutesWin = null;
let lastMeetTraySig = ""; // 上一次刷托盘菜单时的"旁听状态"（active|paused），用来避免每句原文都重建菜单

/**
 * 让 getDisplayMedia 直接返回"主屏 + 系统声音（loopback）"，不弹选择框。
 * 全项目只有会议旁听会调 getDisplayMedia，所以放心全局设 handler。
 */
function installDisplayMediaHandler() {
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ["screen"] })
          .then((sources) => {
            const primaryId = screen.getPrimaryDisplay().id;
            const pick = sources.find((s) => String(s.display_id) === String(primaryId)) || sources[0];
            if (!pick) return callback({});
            // audio:'loopback' = 这台机器正在播放的声音（Windows 支持）
            callback({ video: pick, audio: "loopback" });
          })
          .catch((err) => {
            console.error("[dsh] 取屏幕源失败（系统声环回不可用）:", err.message);
            callback({});
          });
      },
      { useSystemPicker: false },
    );
    console.log("[dsh] 系统声音采集已就绪（getDisplayMedia → 主屏 + loopback）");
  } catch (err) {
    console.error("[dsh] 注册系统声音采集失败:", err.message);
  }
}

function initMeeting() {
  installDisplayMediaHandler();
  meeting = new MeetingRecorder({
    dataDir: app.getPath("userData"),
    // 智谱同一个 key：GLM-ASR（转写）跟视觉模型同一个通道
    baseUrl: PET_API.base,
    apiKey: PET_API.key,
    // 写纪要要的输出预算比"推测一句原因"大得多，所以这里透传 maxTokens；
    // 超时也单独放长到 120 秒（几千 token 的正文 + 模型自己的思考，30 秒根本不够）
    askLLM: async (model, question, maxTokens) => {
      const r = await textAsk(model, question, maxTokens, 120000);
      if (r.usage) recordUsage(model || textModelRef.value, r.usage);
      return r.content;
    },
    recordUsage,
    getConfig: () => ({ ...meetingCfg, hotwords: meetingConfig.hotwordList(meetingCfg) }),
    // 会中旁注：情绪突变 / 长时间发呆（本机感知，模型看不到这层）
    getAmbient: (t0, t1) => (emotionWatcher && emotionWatcher.ambientBetween ? emotionWatcher.ambientBetween(t0, t1) : []),
    onLog: (line) => process.stderr.write(line + "\n"),
    onLine: (line) => petSend("pet:meeting-signal", { type: "line", ...line }),
    onState: (state) => {
      petSend("pet:meeting-signal", { type: "state", ...state });
      // 托盘菜单上的"记录中 / 暂停中"要跟着变，但**别每来一句原文都重建菜单**
      // （onState 每转写出一句都会调一次），所以只在 开始/暂停 这类状态真的变了时刷新
      const sig = `${!!state.active}|${!!state.paused}`;
      if (sig !== lastMeetTraySig) {
        lastMeetTraySig = sig;
        refreshMeetingTray();
      }
    },
    onMinutes: (minutes) => {
      const st = minutes.stats || {};
      // 纪要写好了：气泡说一声（带按钮），纪要窗口开着的话就地刷新
      petSend("pet:companion", {
        text: `📝 纪要写好了：${minutes.title}（实际记录 ${st.minutes || 0} 分钟 / ${minutes.lines.length} 句${st.pauses ? ` / 会中休息 ${st.pauses} 次` : ""}${minutes.fallback ? "；这次模型没产出结构版，先给你自动兜底版" : ""}）`,
        mood: "happy",
        showPet: true,
        actions: [
          { id: "minutes-open", label: "📄 看纪要" },
          { id: "minutes-later", label: "稍后" },
        ],
        effect: "jump",
      });
      // 纪要窗口开着就地刷新（没开就不用管，下次打开会读 meeting.latest()）
      if (minutesWin && !minutesWin.isDestroyed()) {
        minutesWin.webContents.send("pet:meeting-minutes", {
          title: minutes.title,
          file: minutes.file,
          markdown: minutes.markdown,
          fallback: !!minutes.fallback,
        });
      }
    },
  });
  meeting.pruneOld();     // 启动时顺手清一次超期纪要（只删文件，事件日志一行不动）
  meeting.hydrateLast();  // 重启后把"最近一场"从事件日志捞回来（追问/纪要窗口立刻可用）
  console.log(`[dsh] 会议旁听就绪（麦克风轨=${meetingCfg.mic ? "开" : "关"} · 字幕=${meetingCfg.liveCaption ? "开" : "关"} · 纪要保留 ${meetingCfg.keepDays} 天）`);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/** 托盘菜单要跟着旁听状态变（记录中 / 暂停中 / 未开始），这里统一刷一下 */
function refreshMeetingTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/** 托盘/菜单：切换旁听（开始要经过渲染层那一下点击，浏览器才允许录音） */
function meetingToggle() {
  if (!meeting) return;
  if (meeting.status().active) {
    petSend("pet:meeting-signal", { type: "stop-request", reason: "托盘结束" });
    return;
  }
  togglePetVisible(true, "托盘·开始旁听");
  petSend("pet:meeting-signal", { type: "start-request", mic: !!meetingCfg.mic });
}

/**
 * 托盘/菜单：暂停 ↔ 继续（会中休息）。
 * 暂停不需要手势（只是停采集）；**继续需要**——采集端要重新 getDisplayMedia，
 * 所以先把桌宠显出来，让渲染层弹出的那个确认框（点一下就是手势）看得见、点得到。
 */
function meetingPauseToggle() {
  if (!meeting) return;
  const st = meeting.status();
  if (!st.active) return;
  if (st.paused) togglePetVisible(true, "托盘·继续旁听");
  petSend("pet:meeting-signal", { type: st.paused ? "resume-request" : "pause-request", reason: "托盘" });
}

/** 纪要窗口（独立窗口：内容长，塞在鲸鱼那个小窗口里读不下去） */
function openMinutes() {
  if (!meeting) return;
  // 特意**不**在没有纪要时弹"还没有纪要"就完事：那样主人根本看不到这个功能长什么样。
  // 直接开窗口——里面空状态会写清怎么开始，还有历次会议可以翻。
  if (minutesWin && !minutesWin.isDestroyed()) {
    minutesWin.show();
    minutesWin.focus();
    return;
  }
  minutesWin = new BrowserWindow({
    width: 900,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#0b1622",
    title: "会议纪要",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  minutesWin.loadFile(path.join(__dirname, "renderer", "minutes.html"));
  minutesWin.on("closed", () => {
    minutesWin = null;
  });
}

// ---- DSH client wiring ----------------------------------------------------

function startDsh() {
  // Token printed by `dsh web` (its URL carries ?token=...). Also accept a
  // full panel URL with the token embedded, e.g. DSH_PANEL_URL=http://127.0.0.1:3080/?token=xxx
  const token =
    process.env.DSH_TOKEN ||
    (() => { try { return new URL(PANEL_URL).searchParams.get("token"); } catch { return null; } })();
  dsh = new DshClient({
    base: DSH_BASE,
    token,
    onState: (state, meta) => {
      if (petWin && !petWin.isDestroyed()) {
        petWin.webContents.send("pet:state", { state, meta });
      }
    },
    onLog: (line) => {
      process.stderr.write(line + "\n");
    },
  });
  dsh.start();
}

// ---- IPC handlers（提前注册，避免 whenReady 内注册时机问题）----------------

ipcMain.on("pet:open-panel", () => openPanel());

// 桌宠面板右上角 ⚙ → 打开独立的心情设置窗口
ipcMain.on("pet:open-settings", () => openSettings());

// 桌宠面板右上角 🎓 / 托盘菜单 → 打开"识别反馈 · 演示教学"工具
ipcMain.on("pet:open-feedback", () => openFeedbackTool("feedback"));

// 设置窗口点了"认主登记"：相机在桌宠窗口，转发过去拍，并把设置窗口先收起来
ipcMain.on("pet:enroll-request", () => {
  togglePetVisible(true); // 认主要拍照，桌宠窗口得先露出来
  petSend("pet:enroll-request");
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.hide();
});
ipcMain.on("pet:quit", () => app.quit());
ipcMain.on("pet:devtools", () => {
  if (petWin) petWin.webContents.openDevTools({ mode: "detach" });
});
ipcMain.on("pet:move-window", (_e, dx, dy) => {
  if (petWin && !petWin.isDestroyed()) {
    const [x, y] = petWin.getPosition();
    petWin.setPosition(x + dx, y + dy);
  }
});

// 绝对坐标移动（平滑无抖动）
ipcMain.on("pet:move-window-to", (_e, x, y) => {
  if (petWin && !petWin.isDestroyed()) {
    // 使用 setBounds 显式固定尺寸，避免透明窗口 setPosition 导致尺寸漂移
    petWin.setBounds({ x: Math.round(x), y: Math.round(y), width: PET_W, height: PET_H });
  }
});

// 获取窗口位置（同步）
ipcMain.on("pet:get-position", (event) => {
  if (petWin && !petWin.isDestroyed()) {
    event.returnValue = petWin.getPosition();
  } else {
    event.returnValue = [0, 0];
  }
});

// 切换置顶
ipcMain.on("pet:toggle-always-on-top", () => toggleAlwaysOnTop());

// IPC 测试（同步）
ipcMain.on("pet:ping", (event) => {
  console.log("[dsh] ping received!");
  event.returnValue = "pong";
});

// 大模型 API 调用（提问）
ipcMain.handle("pet:ask", async (_e, model, question) => {
  if (!model || !question) throw new Error("缺少参数");
  // 看家模式：主人不在时禁止 AI 问答（防止别人操作电脑支使鲸鱼）
  if (emotionWatcher && emotionWatcher.guardActive) {
    throw new Error("🛡 主人不在，鲸鱼正在看家，AI 问答暂时关闭");
  }
  const result = await petAsk(model, question);
  // 记录用量并推送实时统计
  if (result.usage) {
    recordUsage(model, result.usage);
    pushUsageToRenderer();
  }
  return result;
});

// 查询可用模型
ipcMain.handle("pet:list-models", async () => {
  return await petListModels();
});

// 获取累计用量统计（可带查询参数 { rangeDays, source }）
ipcMain.handle("pet:get-usage-stats", async (_e, opts) => {
  opts = opts || {};
  const rangeDays = opts.rangeDays || 0; // 0 = 全部
  const source = opts.source || "all";   // all | dsh | pet
  const sinceTs = rangeDays > 0 ? Date.now() - rangeDays * 86400000 : 0;
  const summary = summarizeUsage(sinceTs, source);
  const byDay = usageStore ? usageStore.groupByDay(sinceTs, source) : {};
  return {
    summary,
    byDay,
    totals: {
      all: summarizeUsage(sinceTs, "all"),
      dsh: summarizeUsage(sinceTs, "dsh"),
      pet: summarizeUsage(sinceTs, "pet"),
    },
    total: summary,
  };
});

// ---- 情绪监测 IPC ----------------------------------------------------------

// 认主自适应（第一步：先量分布）：把每帧的人脸相似度实测样本落到 data/face-samples.jsonl。
// 为什么必须单独落盘：① pet-run.log 每次启动被覆盖，攒不了几天；② 它只在 own 或 sim≥0.45 时
// 才写，低相似度样本全丢了 —— 攒不出完整分布，就没法定"高置信收集"的门槛。
// 纯旁路：不参与任何判定，出问题也不影响识别。超 8MB 轮转成 face-samples.1.jsonl。
const FACE_SAMPLES_FILE = path.join(app.getPath("userData"), "face-samples.jsonl");
const FACE_SAMPLES_MAX = 8 * 1024 * 1024;
let faceSampleWarned = false;

ipcMain.on("pet:face-sample", (_e, s) => {
  if (!s || typeof s !== "object") return;
  try {
    let idle = null;
    try { idle = powerMonitor.getSystemIdleTime(); } catch {}
    // 附上"键鼠空闲秒数 + 是否处于锁屏覆盖层"：将来分析时当弱标签用
    // （空闲 0~几秒 + 没锁屏 ≈ 人正坐在电脑前 → 这一帧大概率是主人本人）
    const line = JSON.stringify({
      t: Date.now(),
      sim: s.sim, sc: s.sc, bw: s.bw, bh: s.bh, pit: s.pit,
      src: s.src, own: s.own, rej: s.rej,
      idle, locked: !!(screenGuard && screenGuard.locked),
    });
    let size = 0;
    try { size = fs.statSync(FACE_SAMPLES_FILE).size; } catch {}
    if (size > FACE_SAMPLES_MAX) {
      try { fs.renameSync(FACE_SAMPLES_FILE, FACE_SAMPLES_FILE + ".1"); } catch {}
    }
    fs.appendFileSync(FACE_SAMPLES_FILE, line + "\n");
  } catch (err) {
    // 攒数据失败绝不能影响识别：只提醒一次，不刷屏
    if (!faceSampleWarned) {
      faceSampleWarned = true;
      console.warn("[dsh] face-samples 落盘失败（不影响识别）:", err.message);
    }
  }
});

// 本地人脸识别的模型目录（随 npm 包离线携带，不走 CDN）
const FACE_MODEL_DIRS = [
  path.join(__dirname, "node_modules", "@vladmandic", "human", "models"),
  // tfjs 的 wasm 后端二进制（渲染层没有 WebGL，只能跑 wasm 后端）
  path.join(__dirname, "node_modules", "@tensorflow", "tfjs-backend-wasm", "dist"),
];

// 渲染层是 file:// 页面，fetch 不到本地文件：只允许按文件名读上面两个目录里的文件
ipcMain.handle("pet:face-model", (_e, name) => {
  if (typeof name !== "string" || !/^[\w.-]+\.(json|bin|wasm)$/.test(name)) return null;
  for (const dir of FACE_MODEL_DIRS) {
    try {
      return require("fs").readFileSync(path.join(dir, name));
    } catch {}
  }
  console.warn("[dsh] face model not found:", name);
  return null;
});

// 主人的参考照 + 特征向量（渲染层按参考照补算特征，老用户不用重新认主）
ipcMain.handle("pet:face-refs", () => {
  const owner = emotionWatcher && emotionWatcher.owner;
  return {
    refs: (owner && owner.refs) || [],
    descriptors: (owner && owner.descriptors) || [],
  };
});

ipcMain.handle("pet:face-enroll-descriptor", (_e, list) => {
  if (!emotionWatcher) return { descriptors: [] };
  return { descriptors: emotionWatcher.enrollDescriptors(list) };
});

// 本地人脸识别就绪/失效：就绪后身份判定完全交给本地，云端模型只做情绪
ipcMain.on("pet:face-ready", (_e, info) => {
  const ready = !!(info && info.ready);
  faceIdentity = ready ? "ready" : "failed";
  if (emotionWatcher) emotionWatcher.localIdentity = ready;
  console.log(
    `[dsh] local face identity ${ready ? "ON" : "OFF"} (backend=${(info && info.backend) || "?"}, refs=${(info && info.refs) || 0}${info && info.error ? `, err=${info.error}` : ""})`,
  );
});

// 渲染层的本地身份结论：走 emotion 的 onPresence 一条路（它会转发给 guard 和渲染层）
ipcMain.on("pet:face-verdict", (_e, v) => {
  if (!v || typeof v !== "object" || !emotionWatcher) return;
  emotionWatcher.acceptLocalVerdict({
    ts: Number(v.ts) || Date.now(),
    noFace: v.noFace === true,
    ownerPresent: v.ownerPresent === true,
    similarity: Number(v.similarity) || 0,
    faces: Number(v.faces) || 0,
    source: v.source === "probe" ? "probe" : "emotion",
    local: true,
  });
});

// 渲染层送来一帧摄像头画面（JPEG dataURL），交给分析器节流处理
// geo：抓帧那一刻本机量到的嘴部几何量（哈欠"过闸"用），渲染层没量到就是 null
ipcMain.on("pet:emotion-frame", (_e, dataUrl, geo) => {
  if (emotionWatcher) emotionWatcher.analyzeFrame(dataUrl, geo).catch(() => {});
});

// 渲染层摄像头启动失败（无设备/被拒绝）：关掉开关，避免反复重试
ipcMain.on("pet:emotion-camera-error", (_e, msg) => {
  console.warn("[dsh] emotion camera error:", msg);
  if (emotionWatcher) emotionWatcher.setEnabled(false);
});

// 情绪报告
ipcMain.handle("pet:emotion-report", () => {
  return emotionWatcher ? emotionWatcher.getReport() : null;
});

// 隐私开关：屏幕截屏（默认开）。关掉后情绪突变时不再抓屏——推测照常，只是少了屏幕这条线索
ipcMain.handle("pet:privacy-status", () => ({ screenCapture: screenCaptureEnabled }));
ipcMain.handle("pet:privacy-set", (_e, cfg) => {
  const next = privacy.save(app.getPath("userData"), {
    screenCapture: cfg && cfg.screenCapture !== undefined ? !!cfg.screenCapture : screenCaptureEnabled,
  });
  screenCaptureEnabled = next.screenCapture;
  console.log(`[dsh] 屏幕截屏 -> ${screenCaptureEnabled ? "开" : "关"}`);
  return { screenCapture: screenCaptureEnabled };
});

// 吃饭打卡：主人主动记的一条生活记录（时间/餐次/吃了啥），写进事件日志，纯本机
ipcMain.handle("pet:meal-add", (_e, what) => {
  if (!emotionWatcher) return { ok: false, error: "情绪模块还没起来" };
  return emotionWatcher.addMeal(what);
});
// 最近吃过的菜名（去重、最新在前）→ 打卡对话框里的快捷按钮
ipcMain.handle("pet:meal-recent", () => (emotionWatcher ? emotionWatcher.recentMeals(5) : []));

// 提醒设置：饭点提醒开关 + 主人自己设的定时提醒（吃药…）列表。
// 每次都由设置页把整份设置交上来（界面是唯一编辑入口），没带的字段沿用当前值。
ipcMain.handle("pet:reminder-status", () => ({ ...reminderCfg, items: [...(reminderCfg.items || [])] }));
ipcMain.handle("pet:reminder-set", (_e, cfg) => {
  const next = reminders.save(app.getPath("userData"), {
    mealReminder: cfg && cfg.mealReminder !== undefined ? !!cfg.mealReminder : reminderCfg.mealReminder,
    items: cfg && cfg.items !== undefined ? cfg.items : reminderCfg.items,
  });
  reminderCfg = next;
  if (emotionWatcher) emotionWatcher.setReminders(next);
  console.log(`[dsh] 提醒设置 -> 饭点${reminderCfg.mealReminder ? "开" : "关"} · 自定义 ${reminderCfg.items.length} 条`);
  return { ...reminderCfg, items: [...reminderCfg.items] };
});

// ---- 会议旁听 IPC ----
// 一段音频进来（wav 是结构化克隆过来的 ArrayBuffer）→ 丢进转写队列，立刻返回不阻塞采集
ipcMain.handle("pet:meeting-chunk", (_e, chunk) => {
  if (!meeting || !chunk || !chunk.wav) return { ok: false };
  const wav = Buffer.isBuffer(chunk.wav) ? chunk.wav : Buffer.from(new Uint8Array(chunk.wav));
  meeting.addChunk({ source: chunk.source, t0: chunk.t0, t1: chunk.t1, wav });
  return { ok: true, pending: meeting.status().pending };
});
// 渲染层真的开始采了 → 开账本（顺序上：先能采到，才谈得上记）
ipcMain.handle("pet:meeting-started", (_e, info) => (meeting ? meeting.start({ sources: (info && info.sources) || null }) : { ok: false }));
// 采集端心跳：渲染层每 60 秒报一次"我还活着"，失联时看门狗才能自动收尾
ipcMain.on("pet:meeting-beat", () => { if (meeting) meeting.beat(); });
// 会中休息：on=true 暂停（停采集、这场会不结束）/ on=false 继续（接着记）
ipcMain.handle("pet:meeting-pause", (_e, info) => {
  if (!meeting) return { ok: false, error: "会议模块没起来" };
  const r = info && info.on === false ? meeting.resume((info && info.reason) || "继续") : meeting.pause((info && info.reason) || "暂停");
  if (r && r.ok) refreshMeetingTray();
  return r;
});
// 采集停了 → 收尾出纪要。**不 await**：写纪要要几十秒，别把渲染层的"结束"卡住
ipcMain.handle("pet:meeting-stopped", (_e, reason) => {
  if (!meeting) return { ok: false };
  meeting
    .stop(reason || "手动结束")
    .then((r) => {
      if (!r || !r.ok) petSend("pet:companion", { text: `🎧 ${(r && r.error) || "这场没记成"}`, mood: "calm" });
    })
    .catch((err) => console.error("[dsh] 会议收尾失败:", err.message));
  return { ok: true, pending: true };
});
ipcMain.handle("pet:meeting-status", () => (meeting ? meeting.status() : { active: false }));
// 泡泡菜单的 📝 纪要 → 打开会议记录窗口
ipcMain.on("pet:meeting-window", () => openMinutes());
ipcMain.handle("pet:meeting-latest", () => (meeting ? meeting.latest() : null));
ipcMain.handle("pet:meeting-list", () => (meeting ? meeting.listMeetings() : []));
ipcMain.handle("pet:meeting-read", (_e, file) => (meeting ? meeting.readMeeting(file) : { ok: false, error: "会议模块没起来" }));
// 给纪要改名（文件名/正文标题/索引一起改，事件日志只追加一条 rename 记录）
ipcMain.handle("pet:meeting-rename", (_e, file, title) => (meeting ? meeting.renameMeeting(file, title) : { ok: false, error: "会议模块没起来" }));
// 删一份纪要：**进回收站**（不是永久删），文件走了再从索引里摘掉；事件日志里的历史保留
ipcMain.handle("pet:meeting-delete", async (_e, file) => {
  if (!meeting) return { ok: false, error: "会议模块没起来" };
  const r = meeting.readMeeting(file);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "找不到这份纪要" };
  try {
    await shell.trashItem(r.file);
    meeting.forget(file);
    console.log(`[dsh] 纪要已移入回收站：${path.basename(r.file)}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `删除失败：${err.message}` };
  }
});
ipcMain.handle("pet:meeting-ask", (_e, question) => (meeting ? meeting.ask(question) : { ok: false, error: "会议模块没起来" }));
// 打开纪要文件 / 在文件夹里定位（导出就是"它就是一份本地 md，随便你拿走"）
ipcMain.handle("pet:meeting-open", (_e, what, file) => {
  if (!meeting) return { ok: false, error: "会议模块没起来" };
  // 窗口里选中的是哪一份就打开哪一份；没指定就退回最近一场
  let target = null;
  if (file) {
    const r = meeting.readMeeting(file);
    if (r && r.ok) target = r.file;
  }
  if (!target) {
    const m = meeting.latest();
    if (m && m.file) target = m.file;
  }
  if (!target) return { ok: false, error: "还没有可打开的纪要文件" };
  if (what === "folder") {
    shell.showItemInFolder(target);
    return { ok: true, file: target };
  }
  shell.openPath(target).then((err) => {
    if (err) console.error("[dsh] 打开纪要失败:", err);
  });
  return { ok: true, file: target };
});
ipcMain.handle("pet:meeting-config", () => ({ ...meetingCfg }));
ipcMain.handle("pet:meeting-config-set", (_e, cfg) => {
  meetingCfg = meetingConfig.save(app.getPath("userData"), { ...meetingCfg, ...(cfg || {}) });
  console.log(
    `[dsh] 旁听设置 -> 麦克风${meetingCfg.mic ? "开" : "关"} · 字幕${meetingCfg.liveCaption ? "开" : "关"} · 保留 ${meetingCfg.keepDays} 天 · 热词 ${meetingConfig.hotwordList(meetingCfg).length} 个`,
  );
  if (tray) tray.setContextMenu(buildTrayMenu());
  return { ...meetingCfg };
});

// ---- 旁听"秒答"：同事提问 → 查项目资料 → 鲸鱼旁边一张小卡片 -------------------
//
// 跟 📝 纪要的区别：纪要是"会后整理整场"，秒答是"会中被问到、现在就要一句能说出口的话"。
// 两条通道都复用旁听的逐句原文，但秒答只取**最近一段**，并且：
//   ① 先查知识包（company-kb/srm.md，事先固化的业务/页面/流程/术语），再按需翻 D:\company 的代码
//   ② 答案必须带来源，主人当场能判断可不可信
//   ③ 卡片窗口开 **setContentProtection** —— 共享屏幕/录屏/截屏里看不到它

let askHub = null;
let askCardWin = null;

/** 懒加载：第一次点"秒答"才建实例（顺便也就推迟了索引扫描） */
function ensureAskHub() {
  if (askHub) return askHub;
  askHub = new AskHub({
    askLLM: async (model, prompt, maxTokens, timeoutMs) => {
      const r = await textAsk(model, prompt, maxTokens, timeoutMs);
      if (r.usage) recordUsage(model || textModelRef.value, r.usage);
      return r.content;
    },
    recordUsage,
    onLog: (line) => process.stderr.write(`[ask] ${line}\n`),
  });
  return askHub;
}

/** 卡片窗口：小、无边框、置顶、不进任务栏；关键是它**不会被共享屏幕抓到** */
function createAskCardWindow() {
  askCardWin = new BrowserWindow({
    width: ASK_CARD_W,
    height: 200,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  askCardWin.setAlwaysOnTop(true, "screen-saver");
  // ★ 这张卡不给"外面"看：Windows 上相当于 WDA_EXCLUDEFROMCAPTURE，
  //   共享屏幕/录屏/系统截屏里都拍不到它（鲸鱼窗口本身不设，正常可见）
  askCardWin.setContentProtection(true);
  askCardWin.loadFile(path.join(__dirname, "renderer", "ask-card.html"));
  askCardWin.on("closed", () => { askCardWin = null; });
}

/** 把卡片摆到鲸鱼旁边（右边放不下就摆左边；纵向不出工作区） */
function positionAskCard() {
  if (!askCardWin || askCardWin.isDestroyed() || !petWin || petWin.isDestroyed()) return;
  const pb = petWin.getBounds();
  const bb = askCardWin.getBounds();
  const area = screen.getDisplayMatching(pb).workArea;
  let x = pb.x + pb.width + 8;
  if (x + bb.width > area.x + area.width) x = pb.x - bb.width - 8;
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - bb.width - 8));
  const y = Math.max(area.y + 8, Math.min(pb.y + 36, area.y + area.height - bb.height - 8));
  askCardWin.setBounds({ x: Math.round(x), y: Math.round(y), width: bb.width, height: bb.height });
}

function showAskCard() {
  if (!askCardWin || askCardWin.isDestroyed()) createAskCardWindow();
  positionAskCard();
  // 用 showInactive：卡片自己冒出来，但**不抢会议软件的焦点**（不然你正在说话会被切走）
  askCardWin.showInactive();
}

function hideAskCard() {
  if (askCardWin && !askCardWin.isDestroyed()) askCardWin.hide();
}

function askCardSend(payload) {
  if (askCardWin && !askCardWin.isDestroyed()) askCardWin.webContents.send("pet:ask-card", payload);
}

/**
 * 等卡片页面加载完。
 * 为什么必须等：第一次点"秒答"时窗口是刚建的，渲染层的监听还没挂上，
 * 这时候发的"查资料中"会直接丢掉 —— 表现就是卡片亮着但一直停在默认文案。
 */
function askCardReady() {
  return new Promise((resolve) => {
    if (!askCardWin || askCardWin.isDestroyed()) return resolve();
    if (!askCardWin.webContents.isLoading()) return resolve();
    askCardWin.webContents.once("did-finish-load", () => resolve());
  });
}

/** 会议最近的对话（秒答的"问题"就是它最后几行） */
function recentTranscriptText() {
  if (!meeting) return "";
  const lines = meeting.recentLines(120000, 12);
  if (!lines.length) return "";
  return lines.map((l) => `【${stamp(l.offsetMs)}】${l.src === "me" ? "我" : "对方"}：${l.text}`).join("\n");
}

ipcMain.handle("pet:ask-meeting", async () => {
  const q = recentTranscriptText();
  if (!q) {
    return { ok: false, error: "还没旁听到内容：先点 🎧 旁听，等同事开口之后再点秒答" };
  }
  // 先把卡片亮出来并显示"查资料中"：模型要几秒，没反馈会被当成没点上
  showAskCard();
  await askCardReady();
  askCardSend({ type: "busy" });
  const r = await ensureAskHub().answer(q);
  askCardSend({ type: "result", ...r });
  return r;
});

ipcMain.on("pet:ask-card-close", () => hideAskCard());
// 卡片按内容量自报高度（两行答案就别摊一块大空板）
ipcMain.on("pet:ask-card-resize", (_e, h) => {
  if (!askCardWin || askCardWin.isDestroyed()) return;
  const bb = askCardWin.getBounds();
  const height = Math.max(96, Math.min(340, Math.round(Number(h) || bb.height)));
  if (height === bb.height) return;
  askCardWin.setBounds({ x: bb.x, y: bb.y, width: bb.width, height });
});

// ---- 听歌点评（可选功能，默认关）--------------------------------------------
//
// 打开开关后：常驻一个 PowerShell 子进程去读 Windows 媒体控制中心（SMTC），
// 每几秒报一次"现在在放什么"；换歌/放完时由 music.js 判断并生成一句点评 → 弹鲸鱼气泡。
// 关着的时候**一个子进程都不起**（零开销），也不去读系统在放什么。
// 只读元数据（歌名/歌手/专辑/进度）：不录音、不存音频、不写歌词。

let musicCfg = musicConfig.load(app.getPath("userData"));
let musicWatcher = null;
let qqmProc = null; // QQ音乐文字层守护（music-qqm-daemon.py，老版 QQ音乐不走 SMTC 时用它）

/** 按开关起停 QQ音乐文字层守护 */
function syncQqmDaemon() {
  if (musicCfg.enabled && !qqmProc) {
    try {
      const { spawn } = require("child_process");
      qqmProc = spawn(process.platform === "win32" ? "python" : "python3",
        [path.join(__dirname, "music-qqm-daemon.py").replace("app.asar", "app.asar.unpacked")],
        { stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      qqmProc.stdout.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            if (j.t === "session" && musicWatcher) {
              // 转成 music.js 状态机认识的快照（end=0：文字层拿不到歌曲总长）
              musicWatcher.handleSnapshot({
                ok: true, ts: Date.now(),
                sessions: [{
                  app: "QQ音乐", title: j.title || "", artist: j.artist || "",
                  status: j.status || "Playing", pos: j.pos || 0, end: 0,
                }],
              }, "qqm");
            } else if (j.t === "log") {
              process.stderr.write(`[music-qqm] ${j.msg}\n`);
            } else if (j.t === "hint") {
              // 最小化盲区的引导气泡：守护每次 attach 都发，主进程只在没弹过的时候真弹
              if (!musicCfg.qqmHintShown) {
                if (typeof petSend === "function") {
                  petSend("pet:companion", { text: `🎵 ${j.msg}`, mood: "neutral", showPet: true });
                }
                musicCfg = musicConfig.save(app.getPath("userData"), { ...musicCfg, qqmHintShown: true });
                console.log("[dsh] 已弹出 QQ音乐最小化盲区引导气泡一次（qqmHintShown=true 持久化）");
              }
            }
          } catch {}
        }
      });
      qqmProc.stderr.on("data", (d) => process.stderr.write(`[music-qqm] ${d}`));
      qqmProc.on("exit", () => { qqmProc = null; });
      console.log("[dsh] QQ音乐文字层守护已启动");
    } catch (err) {
      console.error("[dsh] QQ音乐文字层守护启动失败（不影响其他来源）：", err.message);
      qqmProc = null;
    }
  } else if (!musicCfg.enabled && qqmProc) {
    try { qqmProc.kill(); } catch {}
    qqmProc = null;
    console.log("[dsh] QQ音乐文字层守护已停止");
  }
}

function initMusic() {
  musicWatcher = new MusicWatcher({
    logFile: EventLog.logFileIn(app.getPath("userData")),
    getConfig: () => musicCfg,
    // 点评走文字模型（跟推测原因/写纪要同一条通道）
    askLLM: async (model, prompt, maxTokens, timeoutMs) => {
      const r = await textAsk(model, prompt, maxTokens, timeoutMs);
      if (r.usage) recordUsage(model || textModelRef.value, r.usage);
      return r.content;
    },
    recordUsage,
    onComment: (text) => {
      if (!text) return;
      petSend("pet:companion", { text: `🎵 ${text}`, mood: "happy", showPet: true });
    },
    // 落了一笔听歌记录 → 情绪模块的内存镜像跟上（报告里"今日听歌"才能立刻看到，
    // 不用等重启重算）
    onRecord: () => {
      if (emotionWatcher) emotionWatcher.noteMusic();
    },
    onLog: (line) => process.stderr.write(`[music] ${line}\n`),
  });
  musicWatcher.applyConfig(); // 开关是开的就起读取器，关着就什么都不做
  syncQqmDaemon();            // QQ音乐文字层守护跟着同一个开关
  console.log(`[dsh] 听歌点评：${musicCfg.enabled ? `开（每 ${musicCfg.pollMs}ms 看一眼）` : "关"}`);
}

ipcMain.handle("pet:music-config", () => ({
  ...musicCfg,
  status: musicWatcher ? musicWatcher.status() : null,
}));
ipcMain.handle("pet:music-config-set", (_e, cfg) => {
  musicCfg = musicConfig.save(app.getPath("userData"), { ...musicCfg, ...(cfg || {}) });
  if (musicWatcher) musicWatcher.applyConfig();
  syncQqmDaemon();
  console.log(`[dsh] 听歌点评 -> ${musicCfg.enabled ? `开（每 ${musicCfg.pollMs}ms 看一眼）` : "关（读取器已停）"}`);
  return { ...musicCfg, status: musicWatcher ? musicWatcher.status() : null };
});

// 设置页"听歌测试"：模拟一首歌走完点评链路（不真放歌、不落记录）
ipcMain.handle("pet:music-test", async () => {
  if (!musicWatcher) return { ok: false, reason: "听歌点评还没初始化" };
  try {
    return await musicWatcher.testRun();
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// ---- 开机自启（写 HKCU\...\Run 注册表，不需要管理员） -------------------------
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const AUTOSTART_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTOSTART_NAME = "DshPet";

function autostartCommand() {
  // 用 vbs 启动（无黑窗）；文件就在 app 根目录
  const vbs = `"${path.join(__dirname, "启动桌宠.vbs")}"`;
  return `wscript.exe ${vbs}`;
}

ipcMain.handle("pet:autostart-get", async () => {
  try {
    const { stdout } = await execFileAsync("reg", ["query", AUTOSTART_KEY, "/v", AUTOSTART_NAME]);
    return { enabled: stdout.includes(AUTOSTART_NAME) };
  } catch {
    return { enabled: false }; // reg 查不到该值会非零退出，就是没开
  }
});

ipcMain.handle("pet:autostart-set", async (_e, on) => {
  try {
    if (on) {
      await execFileAsync("reg", ["add", AUTOSTART_KEY, "/v", AUTOSTART_NAME, "/t", "REG_SZ", "/d", autostartCommand(), "/f"]);
    } else {
      await execFileAsync("reg", ["delete", AUTOSTART_KEY, "/v", AUTOSTART_NAME, "/f"]); // 不存在也会报错，忽略
    }
    console.log(`[dsh] 开机自启 -> ${on ? "开" : "关"}`);
    return { ok: true, enabled: !!on };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// 开关摄像头识别
ipcMain.handle("pet:emotion-toggle", () => {
  emotionToggle();
  return emotionWatcher ? emotionWatcher.enabled : false;
});

// 设置识别间隔（分钟）→ 同步给渲染层调整抓帧节奏
ipcMain.handle("pet:emotion-interval", (_e, minutes) => {
  if (!emotionWatcher) return 0;
  emotionWatcher.setIntervalMs(Number(minutes) * 60000);
  petSend("pet:emotion-camera", {
    enabled: emotionWatcher.enabled,
    intervalMs: cameraCadenceMs(),
    probe: false,
  });
  return emotionWatcher.intervalMs;
});

// 用户点了心情气泡上的交互按钮
ipcMain.handle("pet:emotion-interact", (_e, id) => {
  // 纪要气泡上的两个按钮由会议这边处理（不归情绪的策略引擎）
  if (id === "minutes-open") {
    openMinutes();
    return true;
  }
  if (id === "minutes-later") {
    petSend("pet:companion", { text: "好，纪要已经存在本地了（托盘 → 📝 最近的会议纪要 随时能翻）", mood: "calm" });
    return true;
  }
  if (emotionWatcher) {
    emotionWatcher.handleInteraction(id).catch((err) =>
      console.warn("[dsh] emotion interact failed:", err.message)
    );
  }
  return true;
});

// 认主登记：渲染层连拍参考照，每张调一次；满 3 张即完成
ipcMain.handle("pet:emotion-enroll", (_e, dataUrl) => {
  if (!emotionWatcher) return { count: 0, done: false };
  const r = emotionWatcher.enrollOwner(dataUrl);
  // 照片变了 → 让桌宠窗口按新照片重算本地人脸特征（旧特征在 enrollOwner 里已作废）
  if (r.done) petSend("pet:face-refresh");
  return r;
});

// 认主/看家状态
ipcMain.handle("pet:emotion-owner-info", () => {
  if (!emotionWatcher) return { enrolled: false, refCount: 0, guardEnabled: false, guardActive: false };
  return {
    enrolled: emotionWatcher.isEnrolled(),
    refCount: emotionWatcher.owner ? emotionWatcher.owner.refs.length : 0,
    guardEnabled: emotionWatcher.guardEnabled,
    guardActive: emotionWatcher.guardActive,
  };
});

// 看家模式开关（主人离开后自动锁屏）
ipcMain.handle("pet:emotion-guard-toggle", () => {
  return emotionWatcher ? emotionWatcher.toggleGuard() : { enabled: false };
});

// 认主引导窗口完成 → 鲸鱼庆祝 + 关闭引导窗口
// ---- 首启向导 IPC -----------------------------------------------------------

// 列内置厂商（向导打开时读，渲染端不用走 ipc 也能拿到，但 ipc 是单一入口更稳）
ipcMain.handle("pet:firstrun-providers", () => getBuiltinProviders());

ipcMain.handle("pet:firstrun-profile", () => petProfile);

// 列某厂商在某 base 下能跑通的模型（让向导的"测试连接"按钮能给反馈）
ipcMain.handle("pet:firstrun-list-models", async (_e, opts) => {
  const base = (opts && opts.base || "").replace(/\/+$/, "");
  const key = (opts && opts.key || "").trim();
  if (!base) throw new Error("缺少 base");
  if (!key) throw new Error("缺少 key");
  const url = `${base}/models`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}：${t.slice(0, 120)}`);
  }
  const j = await res.json();
  const arr = Array.isArray(j && j.data) ? j.data : (Array.isArray(j) ? j : []);
  return arr.map((m) => ({
    id: m.id || m.name || String(m),
    label: m.id || m.name || String(m),
  })).filter((m) => m.id);
});

// 测连通：发一条最短可能的消息，确认这个厂商的 base+key+model 真的能用
ipcMain.handle("pet:firstrun-test", async (_e, opts) => {
  const kind = opts && opts.kind || "text";
  const base = (opts && opts.base || "").replace(/\/+$/, "");
  const key = (opts && opts.key || "").trim();
  const model = (opts && opts.model || "").trim();
  if (!base || !key || !model) return { ok: false, error: "请先把 base / key / model 都填好" };

  // 最轻的请求：文本通道发一条"回 1"；视觉通道发一个最小图（黑底 + 一点亮度差，让模型认得出"图"）
  const isVision = kind === "vision";
  const start = Date.now();
  try {
    const userText = isVision
      ? "这是一个连通性测试，请只回 'pong'。"
      : "pong. 只回 'pong'。";
    const userContent = isVision ? [
      { type: "text", text: userText },
      // 1x1 灰阶 PNG 的 base64，足够让视觉模型识别"有图"
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6KlgAAAAASUVORK5CYII=" } },
    ] : userText;
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: userContent }],
        max_tokens: 16,
        temperature: 0,
      }),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}：${t.slice(0, 160)}`, latencyMs };
    }
    const j = await res.json();
    return { ok: true, latencyMs, reply: ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "").slice(0, 40) };
  } catch (err) {
    return { ok: false, error: err.message || String(err), latencyMs: Date.now() - start };
  }
});

// 保存向导配置：写 api-keys.json + profile.json，热更新运行时
ipcMain.handle("pet:firstrun-save", (_e, payload) => {
  if (!payload || typeof payload !== "object") return { ok: false, error: "参数无效" };
  // 简单字段校验（防误填）
  const cfg = {
    providers: Array.isArray(payload.providers) && payload.providers.length ? payload.providers : getBuiltinProviders(),
    vision: payload.vision && payload.vision.key ? payload.vision : null,
    text: payload.text && payload.text.key ? payload.text : null,
  };
  saveApiKeys(cfg);
  if (payload.petName || payload.ownerName) {
    saveProfile({ petName: payload.petName, ownerName: payload.ownerName });
  }
  // 热更新
  const fresh = loadApiKeys();
  applyApiKeys(fresh);
  console.log(`[dsh] 首启向导保存完成：vision=${fresh.vision.providerId}/${fresh.vision.model}  text=${fresh.text.providerId}/${fresh.text.model}`);
  return { ok: true };
});

ipcMain.handle("pet:firstrun-done", () => {
  if (firstRunWin && !firstRunWin.isDestroyed()) firstRunWin.close();
  // 关掉向导后，老逻辑接管：未认主弹认主、已认主打招呼
  if (emotionWatcher && emotionWatcher.isEnrolled()) {
    petSend("pet:companion", { text: `${petProfile.ownerName}你好呀～鲸鱼一直在等你回来`, mood: "happy" });
  } else {
    openOnboarding();
  }
  return { ok: true };
});

ipcMain.handle("pet:firstrun-skip", () => {
  // "以后再说"：跳过首启，但写空骨架避免下次又弹
  try { saveApiKeys({ providers: getBuiltinProviders(), vision: null, text: null }); } catch (_) {}
  if (firstRunWin && !firstRunWin.isDestroyed()) firstRunWin.close();
  return { ok: true };
});

ipcMain.on("pet:enroll-done", () => {
  petSend("pet:companion", {
    text: "✅ 认主完成！以后鲸鱼只认你一个人啦～",
    mood: "happy",
    effect: "spin",
  });
  if (onboardWin && !onboardWin.isDestroyed()) onboardWin.close();
});

// ---- 应用级锁屏 IPC --------------------------------------------------------

ipcMain.handle("pet:guard-status", () => (screenGuard ? screenGuard.status : null));

ipcMain.handle("pet:guard-set-password", (_e, pw) => {
  return screenGuard ? screenGuard.setPassword(pw) : { ok: false, error: "未初始化" };
});

ipcMain.handle("pet:guard-enable", (_e, on) => {
  return screenGuard ? screenGuard.setEnabled(on) : { ok: false, error: "未初始化" };
});

ipcMain.handle("pet:guard-configure", (_e, cfg) => {
  return screenGuard ? screenGuard.configure(cfg) : null;
});

ipcMain.handle("pet:guard-clear-password", () => {
  return screenGuard ? screenGuard.clearPassword() : { ok: false };
});

ipcMain.handle("pet:guard-lock-now", () => {
  guardLockNow();
  return screenGuard ? screenGuard.status : null;
});

// 锁定界面提交密码（刷脸解锁由 onPresence → guard.handlePresence 触发）
ipcMain.handle("pet:guard-unlock", (_e, pw) => {
  return screenGuard ? screenGuard.tryPassword(pw) : { ok: false, error: "未初始化" };
});

ipcMain.handle("pet:guard-lock-info", () => {
  if (!screenGuard) return null;
  return {
    locked: screenGuard.locked,
    hasPassword: screenGuard.hasPassword(),
    // 刷脸解锁只认本机人脸识别；它没起来时锁屏就别再承诺"回到镜头前会自动解锁"
    faceUnlock: faceIdentity === "ready",
    hardLockAfterS: Math.round(screenGuard.hardLockAfterMs / 1000),
    hardLockAt: screenGuard.locked ? screenGuard._hardLockAt : 0,
  };
});

// ---- app lifecycle --------------------------------------------------------

app.whenReady().then(() => {
  // 单实例锁没拿到时**什么都不能做**：以前这里只在 ready 之前调了 app.quit()，
  // 而那时 quit 不生效，于是照样把窗口建出来 —— 结果屏幕上会出现两只鲸鱼，
  // 两只还抢同一个 data/pet-run.log。现在直接在这里拦住。
  if (!gotTheLock) {
    console.log("[dsh] 已有实例在跑，本进程不再建窗口");
    app.quit();
    return;
  }
  console.log("[dsh] App ready, creating windows...");
  createPetWindow();
  createTray();
  startDsh();
  initUsageStore(); // 初始化持久化用量存储 + DSH 会话扫描
  initEmotion();    // 情绪监测（摄像头识别 + 记录 + 推测 + 陪伴）
  initMeeting();    // 会议旁听（系统声环回 + 麦克风 → 转写 → 纪要）
  initMusic();      // 听歌点评（可选，默认关：开了才起读取器）
  initGuard();      // 应用级锁屏（空闲轮询 + 在场探测 + 全屏覆盖层）
  console.log("[dsh] All initialization complete");
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  console.log("[dsh] before-quit");
  if (dsh) dsh.stop();
  if (dshScanTimer) {
    clearInterval(dshScanTimer);
    dshScanTimer = null;
  }
  // 退出前保存
  if (usageStore) usageStore.save();
});

app.on("will-quit", () => {
  console.log("[dsh] will-quit");
});

app.on("quit", (_e, exitCode) => {
  console.log("[dsh] quit event, exitCode:", exitCode);
});

app.on("render-process-gone", (_e, webContents, details) => {
  console.error("[dsh] render-process-gone:", JSON.stringify(details));
});

app.on("child-process-gone", (_e, details) => {
  console.error("[dsh] child-process-gone:", JSON.stringify(details));
});

// 捕获未处理异常
process.on("uncaughtException", (err) => {
  console.error("[dsh] uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[dsh] unhandledRejection:", reason);
});
