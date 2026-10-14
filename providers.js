// 内置 API 厂商清单。首启向导从这里读取下拉选项。
// 用户也可以在向导里点"自定义"手动填 base + 模型，不依赖这张表。
//
// 怎么算"已实测可用"：每家写在这里的 base + 默认 model 至少在某个开发者本机用 OK。
// 没实测过的别往里塞，免得向导默认模型一上来就 404。
//
// "kind" 标记厂商能力（哪些通道可用）：
//   - "vision"：支持图像输入（视觉/情绪/屏幕摘要走它）
//   - "text"  ：只支持纯文本（情绪原因/讲笑话/会议纪要走它）
// 同一厂商也可以两种都支持（比如 OpenAI gpt-4o 既能看图也能说话）。
//
// 模型下拉里的每一项都是"OpenAI 兼容 /chat/completions"接口的 model id。
// 用户也可以在向导的"自定义模型"栏直接填新模型，跑通就行。

const BUILTIN_PROVIDERS = [
  {
    id: "zhipu",
    label: "智谱 GLM",
    kind: "both",
    base: "https://open.bigmodel.cn/api/paas/v4",
    docs: "https://open.bigmodel.cn/dev/api",
    models: [
      { id: "glm-4v-flash", label: "glm-4v-flash（视觉推荐）", vision: true, text: false },
      { id: "glm-4-flash",  label: "glm-4-flash（文本）",         vision: false, text: true  },
      { id: "glm-4-plus",   label: "glm-4-plus（更强文本）",     vision: false, text: true  },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "text",
    base: "https://api.deepseek.com/v1",
    docs: "https://api-docs.deepseek.com/",
    models: [
      { id: "deepseek-chat",     label: "deepseek-chat（快）",        vision: false, text: true },
      { id: "deepseek-flash",    label: "deepseek-flash（最快）",     vision: false, text: true },
      { id: "deepseek-reasoner", label: "deepseek-reasoner（带推理）",vision: false, text: true },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "both",
    base: "https://api.openai.com/v1",
    docs: "https://platform.openai.com/docs",
    models: [
      { id: "gpt-4o-mini",  label: "gpt-4o-mini（视觉+文本，便宜）", vision: true, text: true },
      { id: "gpt-4o",       label: "gpt-4o（视觉+文本，强）",       vision: true, text: true },
      { id: "gpt-4.1-mini", label: "gpt-4.1-mini（更新）",         vision: false,text: true },
    ],
  },
  {
    id: "moonshot",
    label: "月之暗面 Kimi",
    kind: "text",
    base: "https://api.moonshot.cn/v1",
    docs: "https://platform.moonshot.cn/docs",
    models: [
      { id: "moonshot-v1-8k",  label: "moonshot-v1-8k",  vision: false, text: true },
      { id: "moonshot-v1-32k", label: "moonshot-v1-32k", vision: false, text: true },
    ],
  },
  {
    id: "custom",
    label: "自定义（OpenAI 兼容）",
    kind: "both",
    base: "",
    docs: "",
    models: [], // 自定义没有预设模型，用户在向导里手填
  },
];

function getBuiltinProviders() {
  return BUILTIN_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    base: p.base,
    docs: p.docs,
    models: p.models.map((m) => ({ id: m.id, label: m.label, vision: !!m.vision, text: !!m.text })),
  }));
}

function findProvider(providers, id) {
  if (!Array.isArray(providers)) return null;
  return providers.find((p) => p && p.id === id) || null;
}

// 给定"当前选中 (providerId, model, key, base)"，解析出实际要用的 base/key/model：
//   - providerId 找不到 → 回退到缺省（智谱视觉 / DeepSeek 文本）
//   - model 不在 provider.models 里 → 原样保留（用户可能在向导手填了新模型）
//   - key 为空 → 保留空（调用方决定要不要拒绝）
function resolveVision(vision, providers) {
  const prov = findProvider(providers, vision && vision.providerId) || providers[0] || {};
  return {
    base: (vision && vision.base) || prov.base || "https://open.bigmodel.cn/api/paas/v4",
    key: (vision && vision.key) || "",
    model: (vision && vision.model) || (prov.models && (prov.models.find((m) => m.vision) || {}).id) || "glm-4v-flash",
  };
}

function resolveText(text, providers) {
  const prov = findProvider(providers, text && text.providerId) || providers[1] || providers[0] || {};
  return {
    base: (text && text.base) || prov.base || "https://api.deepseek.com/v1",
    key: (text && text.key) || "",
    model: (text && text.model) || (prov.models && (prov.models.find((m) => m.text) || {}).id) || "deepseek-flash",
  };
}

module.exports = { BUILTIN_PROVIDERS, getBuiltinProviders, findProvider, resolveVision, resolveText };