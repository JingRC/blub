// renderer/config.js - 桌宠配置（API 设置与可用模型）
// 在 index.html 中于 pet.js 之前加载，暴露到 window.DSH_PET_CONFIG

window.DSH_PET_CONFIG = {
  // API 基础地址（OpenAI 兼容格式 - 智谱官方）
  apiBase: "https://open.bigmodel.cn/api/paas/v4",

  // API 密钥不放在代码里（会被 git 记录下来）——已挪到 data/api-keys.json，该文件被 .gitignore 排除。
  // 桌宠的请求由主进程发出、用那个文件里的密钥；这里留空只是为了兼容旧的“改 API”对话框。
  apiKey: "",

  // 可用模型列表
  models: [
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash", desc: "最新快速模型" },
    { id: "glm-5.2", name: "GLM-5.2", desc: "旗舰模型 · 最强" },
    { id: "glm-5.1", name: "GLM-5.1", desc: "进阶模型 · 均衡" },
    { id: "glm-5",   name: "GLM-5",   desc: "标准模型 · 快速" },
  ],

  // 默认使用的模型
  defaultModel: "glm-5.3-flash",
};
