// privacy.js —— 隐私开关（开发记录 方向 4）
//
// 目前只有一项开关：**屏幕截屏**。
//
// 为什么只给这一项：桌宠在"情绪显著变化"时会抓一帧你鼠标所在那块屏幕，交给视觉模型
// 出一句"此刻在干什么"的摘要，用来推测情绪变化的原因。摄像头拍的是"你"，
// 屏幕拍的是"你正在处理的一切"（可能开着密码管理器、客户记录、正在共享的会议屏幕）——
// 内容不由你选，所以单独给一个开关，默认开，共享屏幕/投屏演示时可以关掉。
//
// 为什么不做"完全不上云"总开关：摄像头帧、认主参考照、文字推测都要靠上云才成立，
// 按下总开关等于把桌宠变成只会认脸的空壳（情绪、行为、推测全停），实际不会有人开，
// 为一份自己不用的功能写代码 + 长期维护接线不值。

const fs = require("fs");
const path = require("path");

/** 默认值：屏幕截屏默认开（保持既有行为不变） */
const DEFAULTS = { screenCapture: true };

function fileIn(dataDir) {
  return path.join(dataDir, "privacy.json");
}

/** 读开关（文件不存在/坏了都当默认，绝不因为读设置把桌宠弄崩） */
function load(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileIn(dataDir), "utf8"));
    return { screenCapture: raw.screenCapture !== false };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 原子写（先写临时文件再改名，避免断电留下半截 JSON） */
function save(dataDir, next) {
  const cfg = { screenCapture: next.screenCapture !== false };
  const f = fileIn(dataDir);
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, f);
  return cfg;
}

module.exports = { load, save, fileIn, DEFAULTS };