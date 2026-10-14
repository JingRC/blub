// outfit-config.js —— 换装 + 本体配色（data/outfit.json）
//
// 跟 privacy.js / music-config.js 一个路子：设置单独存一个文件，读坏了退回默认，
// 绝不因为设置读不出来把桌宠弄崩。
//
// 存两类"外观"：
//   bodyColor  鲸鱼**本体主色**（'#rrggbb'）。只存这一个——肚皮/高光/暗部/腮红/墨色
//              都由渲染层按比例派生（见 renderer/outfit.js 的 bodyVars），
//              主人不用逐个调，也不容易配丑。
//   hat/face/extra/hand  四个槽位的装扮（一个槽位同时只穿一件），每个是 { id, color }。
//              id 由渲染层 renderer/outfit.js 定义并绘制，主进程不校验"这件装扮存不存在"
//              （那是渲染层的事），只当一个安全的短字符串存着（正则限制字符集/长度）。
//
// 兼容早期格式：{ hat:'tophat', hatColor:'#xxx' }（只有帽子）→ 迁到 hat 槽位。
//
// 换装纯本机外观：不上云、不参与任何识别判定、写不进事件日志。

const fs = require("fs");
const path = require("path");

const SLOT_KEYS = ["hat", "face", "extra", "hand"];

const BODY_DEFAULT = "#1b5299"; // 深海蓝（原来的固定色）

const DEFAULTS = {
  bodyColor: BODY_DEFAULT,
  hat: { id: "none", color: "#1b5299" },
  face: { id: "none", color: "#1f2937" },
  extra: { id: "none", color: "#c0392b" },
  hand: { id: "none", color: "#e08a1e" },
};

const ID_RE = /^[a-z0-9_-]{1,24}$/i;      // 装扮 id：短、纯 ASCII，防脏数据
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;    // 配色：只收 6 位十六进制

function fileIn(dataDir) {
  return path.join(dataDir, "outfit.json");
}

function validColor(v, fallback) {
  return typeof v === "string" && COLOR_RE.test(v) ? v : fallback;
}

function slotValue(raw, key) {
  const d = DEFAULTS[key];
  const v = raw && typeof raw === "object" ? raw[key] : null;
  if (!v || typeof v !== "object") return { ...d };
  return {
    id: typeof v.id === "string" && ID_RE.test(v.id) ? v.id : d.id,
    color: validColor(v.color, d.color),
  };
}

function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const bodyColor = validColor(r.bodyColor, BODY_DEFAULT);
  // 兼容早期扁平格式：{ hat: 'tophat', hatColor: '#xxx' }
  if (typeof r.hat === "string") {
    return {
      bodyColor,
      ...Object.fromEntries(SLOT_KEYS.map((k) => [k, { ...DEFAULTS[k] }])),
      hat: {
        id: ID_RE.test(r.hat) ? r.hat : DEFAULTS.hat.id,
        color: validColor(r.hatColor, DEFAULTS.hat.color),
      },
    };
  }
  return {
    bodyColor,
    ...Object.fromEntries(SLOT_KEYS.map((k) => [k, slotValue(r, k)])),
  };
}

/** 读装扮（文件不存在/坏了都当默认，绝不因为读设置把桌宠弄崩） */
function load(dataDir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(fileIn(dataDir), "utf8")));
  } catch {
    return normalize({});
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

/** 把一份"只改某几项"的补丁合并进现有装扮（逐槽位深合并，不会把颜色冲掉） */
function merge(base, patch) {
  const out = normalize(base);
  const p = patch && typeof patch === "object" ? patch : {};
  if (typeof p.bodyColor === "string" && COLOR_RE.test(p.bodyColor)) out.bodyColor = p.bodyColor;
  for (const k of SLOT_KEYS) {
    if (p[k] && typeof p[k] === "object") out[k] = { ...out[k], ...slotValue({ [k]: { ...out[k], ...p[k] } }, k) };
  }
  return out;
}

module.exports = { load, save, merge, fileIn, normalize, SLOT_KEYS, DEFAULTS, BODY_DEFAULT };