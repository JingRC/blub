// 首启向导：第一次打开桌宠时配 API / 命名 / 自检。所有 IPC 走 preload 暴露的 window.dshPet。
// 步骤：
//   1 欢迎 + 命名
//   2 视觉 API（识人 / 屏幕摘要 / 情绪）
//   3 文本 API（聊天 / 推测原因 / 讲笑话 / 纪要）
//   4 完成（回桌面）

const $ = (root, sel) => root.querySelector(sel);

const STEPS = ["问候", "视觉", "文本", "完成"];

let providers = [];
let visionChoice = { providerId: "zhipu", base: "", key: "", model: "" };
let textChoice = { providerId: "deepseek", base: "", key: "", model: "" };
let profile = { petName: "鲸鱼", ownerName: "主人" };

async function init() {
  // 兜底：任何一步 IPC 失败都不能让页面空白——拿不到厂商列表就用空列表，
  // 至少"欢迎 + 命名"页要能渲染出来。
  try {
    const [provs, prof] = await Promise.all([
      window.dshPet.firstRunProviders().catch(() => []),
      window.dshPet.firstRunProfile().catch(() => ({ petName: "鲸鱼", ownerName: "主人" })),
    ]);
    providers = Array.isArray(provs) && provs.length ? provs : [];
    if (prof && typeof prof === "object") profile = { petName: prof.petName || "鲸鱼", ownerName: prof.ownerName || "主人" };
  } catch (err) {
    console.error("[firstrun] 初始化失败，使用默认值渲染：", err);
  }
  render();
}

function render() {
  const app = $("#app");
  app.innerHTML = "";
  app.appendChild(steps());
  showStep(0);
}

function steps() {
  const wrap = document.createElement("div");
  wrap.className = "steps";
  wrap.innerHTML = STEPS.map((s, i) => `<div class="step-dot" data-dot="${i}"></div>`).join("");
  wrap.dataset.wrap = "dots";
  return wrap;
}

function setDotStep(k) {
  const wrap = document.querySelector('[data-wrap="dots"]');
  if (!wrap) return;
  const dots = wrap.querySelectorAll(".step-dot");
  dots.forEach((d, i) => {
    d.className = "step-dot" + (i === k ? " active" : i < k ? " done" : "");
  });
}

function appRoot() {
  return $("#app");
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function showStep(k) {
  setDotStep(k);
  const app = appRoot();
  // 清理除了 .steps 之外的内容
  app.querySelectorAll(":scope > :not(.steps)").forEach((n) => n.remove());
  if (k === 0) app.appendChild(stepWelcome());
  else if (k === 1) app.appendChild(stepApi("vision"));
  else if (k === 2) app.appendChild(stepApi("text"));
  else app.appendChild(stepDone());
  app.scrollTop = 0;
}

// ---- 步骤 1：欢迎 + 命名 ----------------------------------------------------
function stepWelcome() {
  const card = el("div", "card");
  card.appendChild(el("div", "hero center", "🐋"));
  card.appendChild(el("h1", "center", "欢迎使用深海桌宠"));
  card.appendChild(el("div", "sub center", "先给鲸鱼起个名字，再告诉它你是谁。之后几页配好 AI 接口就能开聊了。"));

  const petField = inputField("桌宠叫什么名字？", profile.petName || "鲸鱼", "petName");
  const ownerField = inputField("你怎么称呼？（鲸鱼会这样喊你）", profile.ownerName || "主人", "ownerName");
  card.appendChild(petField);
  card.appendChild(ownerField);

  const row = el("div", "btn-row");
  const next = el("button", "primary", "下一步 →");
  next.onclick = () => {
    profile.petName = ($("#petName").value || "鲸鱼").trim();
    profile.ownerName = ($("#ownerName").value || "主人").trim();
    showStep(1);
  };
  row.appendChild(skipBtn());
  row.appendChild(next);
  card.appendChild(row);
  return card;
}

function skipBtn() {
  const b = el("button", "ghost", "以后再说");
  b.onclick = async () => {
    await window.dshPet.firstRunSkip();
  };
  return b;
}

function inputField(label, value, id) {
  const wrap = el("label");
  wrap.appendChild(document.createTextNode(label));
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  input.id = id;
  wrap.appendChild(input);
  return wrap;
}

// ---- 步骤 2 / 3：API 配置 -----------------------------------------------------
function stepApi(kind) {
  const isVision = kind === "vision";
  const state = isVision ? visionChoice : textChoice;
  const card = el("div", "card");
  card.appendChild(el("h1", "", isVision ? "👁 视觉 AI —— 认人 / 看屏幕 / 读情绪" : "💬 文本 AI —— 聊天 / 推测 / 讲笑话"));
  card.appendChild(el("div", "sub", isVision
    ? "视觉用来认主人、看屏幕内容、判断情绪。需要一个支持图像输入的模型（比如智谱 GLM）。"
    : "文本用来聊天、推测情绪原因、讲笑话、写会议纪要。随便一个文本模型都行（比如 DeepSeek）。"));

  // 厂商下拉
  const provWrap = el("label");
  provWrap.appendChild(document.createTextNode("AI 厂商"));
  const sel = document.createElement("select");
  sel.id = kind + "-provider";
  providers.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label;
    if (p.id === state.providerId) o.selected = true;
    sel.appendChild(o);
  });
  provWrap.appendChild(sel);
  card.appendChild(provWrap);

  // 该厂商的默认模型列表（随厂商切换刷新）
  const modelWrap = el("label");
  modelWrap.appendChild(document.createTextNode("模型"));
  const modelSel = document.createElement("select");
  modelSel.id = kind + "-model";
  modelWrap.appendChild(modelSel);
  card.appendChild(modelWrap);

  // 自定义模型兜底输入（内置列表里没有时手填）
  const customWrap = el("label");
  customWrap.appendChild(document.createTextNode("自定义模型（可选）"));
  const custom = document.createElement("input");
  custom.type = "text";
  custom.id = kind + "-model-custom";
  custom.placeholder = "内置列表没有时，在这里直接填 model id，如 gpt-4o";
  customWrap.appendChild(custom);
  card.appendChild(customWrap);

  // base + key
  const baseWrap = el("label");
  baseWrap.appendChild(document.createTextNode("接口地址 base URL"));
  const baseIn = document.createElement("input");
  baseIn.type = "text";
  baseIn.id = kind + "-base";
  baseIn.placeholder = "https://api.example.com/v1";
  baseWrap.appendChild(baseIn);
  card.appendChild(baseWrap);

  const keyWrap = el("label");
  keyWrap.appendChild(document.createTextNode("API 密钥"));
  const keyIn = document.createElement("input");
  keyIn.type = "password";
  keyIn.id = kind + "-key";
  keyIn.placeholder = "sk-...";
  keyWrap.appendChild(keyIn);
  card.appendChild(keyWrap);

  // 状态 / 测试
  const status = el("div", "status");
  card.appendChild(status);

  const hint = el("div", "hint");
  hint.textContent = isVision
    ? "密钥只保存在本机 data/api-keys.json，不会上传。" 
    : "找不到密钥？看厂商文档（下方绿色链接）。";
  if (state.base) {
    const pa = providers.find((p) => p.id === state.providerId);
    if (pa && pa.docs) {
      hint.innerHTML = `找不到密钥？<a href="${pa.docs}" target="_blank" rel="noopener">${pa.label} 文档</a>`;
    }
  }
  card.appendChild(hint);

  // 底部操作
  const row = el("div", "btn-row");
  const back = el("button", "ghost", "← 上一步");
  back.onclick = () => showStep(isVision ? 0 : 1);
  const testBtn = el("button", "", "测试连接");
  const next = el("button", "primary", isVision ? "下一步 →" : "完成 ✔");
  row.appendChild(back);
  row.appendChild(testBtn);
  row.appendChild(next);
  card.appendChild(row);

  // ---- 事件 ----
  const currentProvider = () => providers.find((p) => p.id === sel.value);

  function refreshModels() {
    const p = currentProvider();
    modelSel.innerHTML = "";
    const valid = [];
    (p && Array.isArray(p.models) ? p.models : []).forEach((m) => {
      // 只放符合当前 kind 的模型
      if (isVision && !m.vision) return;
      if (!isVision && !m.text) return;
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.label;
      modelSel.appendChild(o);
      valid.push(m.id);
    });
    // 若当前已选了模型且在内置里，回填
    if (state.model && valid.includes(state.model)) modelSel.value = state.model;
    else if (state.model) custom.value = state.model;
    // 预设 base
    if (p && p.base && !baseIn.value) baseIn.value = p.base;
    if (p && p.docs) hint.innerHTML = `找不到密钥？<a href="${p.docs}" target="_blank" rel="noopener">${p.label} 文档</a>`;
    else hint.innerHTML = "密钥只保存在本机 data/api-keys.json，不会上传。";
    status.textContent = "";
  }

  function currentModel() {
    return custom.value.trim() || modelSel.value || "";
  }

  sel.onchange = () => { state.providerId = sel.value; refreshModels(); baseIn.value = (currentProvider() && currentProvider().base) || ""; };

  testBtn.onclick = async () => {
    const opts = { kind, base: baseIn.value.trim(), key: keyIn.value.trim(), model: currentModel() };
    state.base = opts.base; state.key = opts.key; state.model = opts.model;
    status.className = "status";
    status.textContent = "测试中…";
    testBtn.disabled = true;
    try {
      const r = await window.dshPet.firstRunTest(opts);
      if (r && r.ok) {
        status.className = "status ok";
        status.textContent = `✅ 通了！${r.latencyMs}ms${r.reply ? "\u00A0\u00A0模型回：" + r.reply : ""}`;
      } else {
        status.className = "status err";
        status.textContent = "❌ " + (r && r.error || "未知错误");
      }
    } catch (err) {
      status.className = "status err";
      status.textContent = "❌ " + (err && err.message || String(err));
    } finally {
      testBtn.disabled = false;
    }
  };

  next.onclick = async () => {
    state.providerId = sel.value;
    state.base = baseIn.value.trim();
    state.key = keyIn.value.trim();
    state.model = currentModel();
    if (!state.key) { status.className = "status err"; status.textContent = "请先填 API 密钥，或点「以后再说」跳过。"; return; }
    if (isVision) showStep(2);
    else await doFinish();
  };

  refreshModels();
  return card;
}

// ---- 步骤 4：完成 --------------------------------------------------------------
async function doFinish() {
  const payload = {
    providers,
    vision: visionChoice.providerId && visionChoice.key ? { providerId: visionChoice.providerId, base: visionChoice.base, key: visionChoice.key, model: visionChoice.model } : null,
    text: textChoice.providerId && textChoice.key ? { providerId: textChoice.providerId, base: textChoice.base, key: textChoice.key, model: textChoice.model } : null,
    petName: profile.petName,
    ownerName: profile.ownerName,
  };
  const res = await window.dshPet.firstRunSave(payload).catch((e) => ({ ok: false, error: e.message }));
  if (res && res.ok) {
    showStep(3); // 完成页
  } else {
    const st = document.querySelector(".status");
    if (st) { st.className = "status err"; st.textContent = "保存失败：" + (res && res.error || "未知错误"); }
  }
}

function stepDone() {
  const card = el("div", "card center");
  card.appendChild(el("div", "hero", "🎉"));
  card.appendChild(el("h1", "", "搞定！"));
  card.appendChild(el("div", "sub", `你好，${profile.ownerName || "主人"}！鲸鱼叫 ${profile.petName || "鲸鱼"}，配置已完成。`));
  const row = el("div", "btn-row center");
  const go = el("button", "primary", "开始使用 →");
  go.onclick = () => window.dshPet.firstRunDone();
  row.appendChild(go);
  card.appendChild(row);
  return card;
}

init();