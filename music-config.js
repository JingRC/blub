// music-config.js —— 听歌点评的设置（data/music.json）
//
// 跟 meeting-config.js / privacy.js 一个路子：设置单独存一个文件，读坏了退回默认，
// 绝不因为设置读不出来把桌宠弄崩。
//
//   enabled  true/false  **默认关**。听歌点评是要主动开的功能：
//                        ① 它要去读系统的"正在播放"（Windows 媒体控制中心），
//                           这属于"看你在干什么"，默认开着不合适；
//                        ② 关着的时候**一个 PowerShell 子进程都不起**，零开销
//   pollMs   1000~30000  多久看一眼"换歌了没"。默认 3 秒——
//                        换歌是分钟级的事，3 秒足够，又不至于让子进程空转太勤
//   qqmHintShown        false   "老版 QQ 音乐最小化盲区"的引导气泡是否已给主人弹过。
//                                 守护每次新 attach 都会发 hint，主进程只在没弹过的时候真弹，
//                                 弹过后写 true 持久化，避免天天骚扰。

const fs = require("fs");
const path = require("path");

const DEFAULTS = { enabled: false, pollMs: 3000, qqmHintShown: false };

function fileIn(dataDir) {
  return path.join(dataDir, "music.json");
}

function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const n = Number(r.pollMs);
  return {
    enabled: r.enabled === true,
    pollMs: Number.isFinite(n) ? Math.min(30000, Math.max(1000, Math.round(n))) : DEFAULTS.pollMs,
    qqmHintShown: r.qqmHintShown === true,
  };
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

module.exports = { load, save, fileIn, normalize, DEFAULTS };