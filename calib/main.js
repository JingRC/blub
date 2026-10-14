// calib/main.js — 桌宠识别实验室（独立小应用，跟正在跑的桌宠互不干扰）
//
// 用法： cd dsh-pet && npx electron calib/main.js      （或 npm run calib；桌宠面板的 🎓 按钮也会拉起它）
// 作用： 列出桌宠认出来的东西（哈欠 / 动作 / 情绪记录）→ 点一行 → 对着镜头演示一遍真实的样子：
//        哈欠会先做两段负例再真打哈欠，自动算出阈值；新动作会留参考图 + 本机几何区间。
//        结果写进 data/learned-actions.json，桌宠 5 秒内热加载生效（不用重启）。
//
// 为什么要独立跑：演示要独占摄像头并加载人脸模型，跟桌宠抢资源；
// 分开跑就不必给桌宠加"演示模式"，也不怕演示中途崩掉影响桌宠。

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

// 跟桌宠一样的启动开关（这台机器上不开这些会报 MOJO 权限错误；
// 禁用 GPU 后人脸模型走 wasm 后端，标定量出来的值也跟桌宠里一致）
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-features", "NetworkServiceSandbox,NetworkServiceInProcess");
app.commandLine.appendSwitch("no-network-sandbox");

// 用单独的数据目录：Chromium 会锁 userData，两个进程共用会打架
const USER_DATA = path.join(__dirname, "..", "data", "calib-userdata");
fs.mkdirSync(USER_DATA, { recursive: true });
app.setPath("userData", USER_DATA);

const DATA_DIR = path.join(__dirname, "..", "data");
const LEARNED_FILE = path.join(DATA_DIR, "learned-actions.json");
const BEHAVIOR_FILE = path.join(DATA_DIR, "emotion-behavior.json");
const EVENTS_FILE = path.join(DATA_DIR, "emotion-events.json");

// 启动参数：--tab=calib|feedback（桌宠面板那个 🎓 按钮会带着 feedback 打开）
const TAB = (process.argv.find((a) => a.startsWith("--tab=")) || "--tab=calib").slice("--tab=".length);

// 单实例：同时开两个会抢摄像头（后开的那个直接把已有窗口叫到前台）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// 本地模型目录（跟主程序里的 FACE_MODEL_DIRS 保持一致）
const FACE_MODEL_DIRS = [
  path.join(__dirname, "..", "node_modules", "@vladmandic", "human", "models"),
  path.join(__dirname, "..", "node_modules", "@tensorflow", "tfjs-backend-wasm", "dist"),
];

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 880,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: "#0b1622",
    title: "桌宠识别实验室",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 只放行摄像头（file:// 页面不给权限会直接拿不到 getUserMedia）
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "media");
  });
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return permission === "media";
  });

  // 渲染层日志转到终端（标定过程与报告同时留一份在命令行里）
  // 兼容两种签名：旧版 (event, level, message)；Electron ≥32 (event, details{level,message})
  win.webContents.on("console-message", (_e, ...args) => {
    let level, message;
    if (typeof args[0] === "object" && args[0] !== null) {
      level = args[0].level;
      message = args[0].message;
    } else {
      level = args[0];
      message = args[1];
    }
    if (typeof message !== "string") return;
    if (level === "error" || level === 3) console.error(`[calib:error] ${message}`);
    else console.log(`[calib] ${message}`);
  });

  win.loadFile(path.join(__dirname, "index.html"), { query: { tab: TAB } });
  win.on("closed", () => { win = null; });
}

// 已有窗口时：把那个窗口叫到前台（不新开）
app.on("second-instance", () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

// 渲染层读不到本地文件（file:// 页面），模型字节按文件名交给主进程读
ipcMain.handle("calib:model", (_e, name) => {
  if (typeof name !== "string" || !/^[\w.-]+\.(json|bin|wasm)$/.test(name)) return null;
  for (const dir of FACE_MODEL_DIRS) {
    try {
      return fs.readFileSync(path.join(dir, name));
    } catch {}
  }
  console.warn("[calib] face model not found:", name);
  return null;
});

// ---- 识别反馈 / 演示教学 ---------------------------------------------------

// 声明表是唯一真源（signals.js）：情绪标签、内置信号的演示剧本、自定义动作模板都从那来，
// 这里不再各留一份副本（否则加新信号还得改这个文件）
const Signals = require("../signals");

/** 情绪标签中文名（反馈列表要给人看） */
const EMOTION_LABELS = Signals.EMOTION.labels;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * 桌宠认出来的东西都在哪些文件里：
 *   emotion-behavior.json → 按天的哈欠/动作计数（含自定义动作）
 *   emotion-events.json   → 情绪变化记录
 *   learned-actions.json  → 已学会的自定义动作 + 阈值覆盖
 * 反馈列表就是把这些摊平成"一行一个识别项"，让主人挑哪个不准。
 */
ipcMain.handle("calib:records", () => {
  const behavior = readJson(BEHAVIOR_FILE, {}) || {};
  const events = readJson(EVENTS_FILE, []) || [];
  const learned = readJson(LEARNED_FILE, null) || {};

  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

  const actions = Object.entries(behavior.actionTotal || {}).map(([name, total]) => ({
    name,
    total: Number(total) || 0,
    today: Number((behavior.actionByDay || {})[name] ? (behavior.actionByDay[name][day] || 0) : 0),
  }));
  // 自定义动作即便一次没命中过也列出来（主人可能想删掉/重教）
  for (const [key, a] of Object.entries(learned.actions || {})) {
    if (a && a.label && !actions.some((x) => x.name === a.label)) {
      actions.push({ name: a.label, total: 0, today: 0, custom: true, key });
    }
  }

  // 声明里已定义、但还没被识别到过的信号也列出来（否则"新加一条声明"在界面上看不见，
  // 主人就没法选中它去跑演示教学——这是"加一份声明 + 跑一次演示"能成立的前提）
  const decls = { __custom: Signals.CUSTOM_SIGNAL_TEMPLATE };
  for (const s of Signals.SIGNALS) {
    decls[s.key] = {
      label: s.label,
      ownChannel: !!s.ownChannel,
      gate: s.gate || null,
      count: s.count || null,
      teach: s.teach || null,
      report: s.report || null,
    };
    if (s.ownChannel) continue; // 哈欠本来就有独立一行
    // 只列"写了演示剧本"的内置信号：没剧本的信号拉进列表也没法教，
    // 而且会让内置信号被误存成一份同名的自定义动作
    if (!s.teach || !Array.isArray(s.teach.steps) || !s.teach.steps.length) continue;
    if (actions.some((x) => x.name === s.label)) continue;
    actions.push({ name: s.label, total: 0, today: 0, declared: true, key: s.key });
  }

  const changes = events
    .filter((e) => e && e.kind !== "gaze" && e.from !== e.to)
    .slice(-15)
    .reverse()
    .map((e) => ({
      ts: e.ts,
      from: EMOTION_LABELS[e.from] || e.from || "-",
      to: EMOTION_LABELS[e.to] || e.to || "-",
    }));

  return {
    decls,
    day,
    yawn: { today: Number((behavior.yawnByDay || {})[day] || 0), total: Number(behavior.yawnTotal) || 0 },
    actions,
    events: changes,
    learned: {
      yawnMarMin: learned.gate && learned.gate.yawn ? Number(learned.gate.yawn.marOutMin) : null,
      // 演示时量到的负例上限（说话/托下巴的最高外唇 MAR）：界面要拿它跟演示峰值对比
      yawnNegMax: learned.gate && learned.gate.yawn && learned.gate.yawn.negMax != null
        ? Number(learned.gate.yawn.negMax)
        : null,
      custom: Object.entries(learned.actions || {}).map(([key, a]) => ({
        key,
        label: a && a.label,
        desc: (a && a.desc) || "",
        refs: a && Array.isArray(a.refs) ? a.refs.length : 0,
        gated: !!(a && a.gate),
        updatedAt: (a && a.updatedAt) || 0,
      })),
    },
    feedback: Array.isArray(learned.feedback) ? learned.feedback.slice(-20).reverse() : [],
    // 早先那次四段标定留下的负例基线（现在只当兜底参考；主路径是演示时现采）
    lastCalibration: (() => {
      const c = readJson(path.join(DATA_DIR, "yawn-calibration.json"), null);
      return c ? { ts: c.ts, negMax: c.negMax, yawnQ90: c.yawnQ90, suggested: c.suggested } : null;
    })(),
  };
});

ipcMain.handle("calib:learned", () => readJson(LEARNED_FILE, null) || { version: 1, gate: {}, actions: {}, feedback: [] });

/**
 * 保存"演示教学"的结果：合并进 learned-actions.json（桌宠那边 5 秒内热加载生效）。
 * payload: { gate?: {yawn:{marOutMin}}, action?: {key,label,desc,refs,gate}, feedback?: {...} }
 */
ipcMain.handle("calib:learned-save", (_e, payload) => {
  try {
    const cur = readJson(LEARNED_FILE, null) || { version: 1, gate: {}, actions: {}, feedback: [] };
    const next = {
      version: 1,
      updatedAt: Date.now(),
      gate: { ...(cur.gate || {}), ...((payload && payload.gate) || {}) },
      actions: { ...(cur.actions || {}) },
      feedback: Array.isArray(cur.feedback) ? cur.feedback.slice(-99) : [],
    };
    const act = payload && payload.action;
    if (act && act.key) {
      const prev = next.actions[act.key] || {};
      next.actions[act.key] = {
        ...prev,
        label: act.label,
        desc: act.desc || prev.desc || "",
        // 参考图最多留 2 张（prompt 体积），新的演示覆盖旧的
        refs: Array.isArray(act.refs) && act.refs.length ? act.refs.slice(0, 2) : prev.refs || [],
        gate: act.gate || prev.gate || null,
        demoSamples: act.demoSamples || prev.demoSamples || 0,
        updatedAt: Date.now(),
      };
    }
    if (payload && payload.feedback) next.feedback.push({ ...payload.feedback, ts: Date.now() });
    fs.writeFileSync(LEARNED_FILE, JSON.stringify(next, null, 2));
    console.log(`[calib] 已写入 ${LEARNED_FILE}`);
    return { ok: true, file: LEARNED_FILE, learned: next };
  } catch (err) {
    console.error("[calib] 保存失败:", err.message);
    return { ok: false, error: err.message };
  }
});

/** 删掉一个自定义动作（学错了想重来） */
ipcMain.handle("calib:learned-remove", (_e, key) => {
  try {
    const cur = readJson(LEARNED_FILE, null);
    if (!cur || !cur.actions || !cur.actions[key]) return { ok: false, error: "没有这个动作" };
    delete cur.actions[key];
    cur.updatedAt = Date.now();
    fs.writeFileSync(LEARNED_FILE, JSON.stringify(cur, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());