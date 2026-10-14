// calib/preload.js — 标定页面的桥
//
// 这里复用桌宠那份 renderer/face.js（MAR/EAR 的计算只有一份，免得两边算法走偏），
// 它只需要几个桥：模型字节 + 认主资料 + 状态回报。标定不做身份判定，
// 所以认主相关全部给空实现，只保证 face.js 能正常初始化并给出几何量。

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshPet", {
  faceModelBytes: (name) => ipcRenderer.invoke("calib:model", name),
  faceRefs: async () => null, // 没有参考照：face.js 只算几何量，不做身份
  faceEnrollDescriptor: async () => ({ descriptors: [] }),
  faceReady: () => {},
  sendFaceVerdict: () => {},
  onFaceRefresh: () => () => {},
});

contextBridge.exposeInMainWorld("dshCalib", {
  // 识别反馈 / 演示教学
  records: () => ipcRenderer.invoke("calib:records"),
  learned: () => ipcRenderer.invoke("calib:learned"),
  learnedSave: (payload) => ipcRenderer.invoke("calib:learned-save", payload),
  learnedRemove: (key) => ipcRenderer.invoke("calib:learned-remove", key),
});