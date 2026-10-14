// meeting-config.js —— 会议旁听的设置（data/meeting.json）
//
// 跟 privacy.js / reminders.js 一个路子：设置单独存一个文件，读坏了就退回默认，
// 绝不因为设置读不出来把桌宠弄崩。
//
//   mic         true/false  是否同时录麦克风。**默认开**：系统声只有"对方"的声音，
//                            加上麦克风才能把"我"说的话也记下来，纪要里能分清谁说的
//   liveCaption true/false  会中要不要在鲸鱼下面滚实时字幕
//   keepDays    1~3650      纪要文件（data/meetings/*.md）保留多少天，超期自动清；
//                            **只删纪要文件**，事件日志里的原文行不动（那条纪律不能破）
//   hotwords    "张总,报价单,XX项目"  热词：项目代号/人名/产品名。实测喂给 ASR 会被当上下文用，
//                            专有名词的错字明显减少（最多 100 个）

const fs = require("fs");
const path = require("path");

const DEFAULTS = { mic: true, liveCaption: true, keepDays: 30, hotwords: "" };
const MAX_HOTWORDS = 100;

function fileIn(dataDir) {
  return path.join(dataDir, "meeting.json");
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return DEFAULTS.keepDays;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    mic: r.mic !== false,
    liveCaption: r.liveCaption !== false,
    keepDays: clamp(Number(r.keepDays), 1, 3650),
    hotwords: String(r.hotwords || "").slice(0, 500),
  };
}

/** 热词字符串 → 数组（逗号/顿号/分号/换行都能当分隔，去重、截断） */
function hotwordList(cfg) {
  const s = String((cfg && cfg.hotwords) || "");
  const out = [];
  for (const w of s.split(/[,，、;；\n\r\t]+/)) {
    const t = w.trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_HOTWORDS) break;
  }
  return out;
}

function load(dataDir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(fileIn(dataDir), "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

/** 原子写（先临时文件再改名） */
function save(dataDir, next) {
  const cfg = normalize(next);
  const f = fileIn(dataDir);
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, f);
  return cfg;
}

module.exports = { load, save, fileIn, hotwordList, DEFAULTS, MAX_HOTWORDS };