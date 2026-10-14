// reminders.js —— 提醒设置（2026-09-20 起：饭点提醒 + 主人自定义的定时提醒）
//
// 为什么单独一个文件：这些是**主人自己定时间的生活提醒**，跟"隐私开关"（privacy.js）不是一类东西，
// 也跟"感知声明"（signals.js，管识别什么）不是一类东西——它们不识别任何东西，只是到点问一句。
//
// 两种提醒长在同一个文件里：
//   mealReminder: true/false     饭点提醒（时间窗写在 emotion.js：午饭 11:30~13:00、晚饭 17:30~19:30）
//   items: [{ id, enabled, at, days, text }]
//                                主人自己设的提醒（吃药、交周报…）：
//                                at   = "08:30"（24 小时制时刻）
//                                days = [0..6] 星期几提醒，0=周日；**空数组 = 每天**
//                                text = 到点要说的一句话（如"吃药"）
//
// 存盘是原子写（先写临时文件再改名）；文件不存在/读坏了都退回默认——
// 绝不因为设置读不出来把桌宠弄崩。

const fs = require("fs");
const path = require("path");

/** 默认：饭点提醒开着；自定义提醒一开始是空的（等主人自己加） */
const DEFAULTS = { mealReminder: true, items: [] };

/** 一次最多存几条自定义提醒（防止设置文件被写爆；界面上也够用了） */
const MAX_ITEMS = 20;

function fileIn(dataDir) {
  return path.join(dataDir, "reminders.json");
}

/**
 * 归一化一条自定义提醒：字段不全/格式不对就当这条没写，返回 null。
 * 宁可少一条，也不要半条坏数据（坏数据会变成"到点了却什么都不说"的鬼故事）。
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const at = String(raw.at || "").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return null; // 必须 24 小时制 HH:MM
  const text = String(raw.text || "").replace(/\s+/g, " ").trim().slice(0, 20);
  if (!text) return null; // 没写提醒内容 = 没意义
  const days = Array.isArray(raw.days)
    ? [...new Set(raw.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    : [];
  return {
    // id 只在本机用（气泡按钮要知道点的是哪一条）；界面新建时由 main 这边补一个
    id: String(raw.id || "").trim() || `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    enabled: raw.enabled !== false,
    at,
    days, // 空 = 每天
    text,
  };
}

function normalize(raw) {
  const list = Array.isArray(raw && raw.items) ? raw.items : [];
  return {
    mealReminder: !(raw && raw.mealReminder === false),
    items: list.map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS),
  };
}

/** 读设置（文件不存在/坏了都当默认，绝不因为读设置把桌宠弄崩） */
function load(dataDir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(fileIn(dataDir), "utf8")));
  } catch {
    return { mealReminder: DEFAULTS.mealReminder, items: [] };
  }
}

/** 原子写（先写临时文件再改名，避免断电留下半截 JSON） */
function save(dataDir, next) {
  const cfg = normalize(next);
  const f = fileIn(dataDir);
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, f);
  return cfg;
}

module.exports = { load, save, fileIn, normalizeItem, DEFAULTS, MAX_ITEMS };