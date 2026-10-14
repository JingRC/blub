// preload.js - bridges the main process IPC to the whale renderer.
//
// Context isolation keeps the renderer sandboxed; this file is the only surface
// that exposes `window.dshPet`, used by renderer/pet.js.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshPet", {
  onState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("pet:state", handler);
    return () => ipcRenderer.removeListener("pet:state", handler);
  },
  openPanel: () => ipcRenderer.send("pet:open-panel"),
  quit: () => ipcRenderer.send("pet:quit"),
  openDevTools: () => ipcRenderer.send("pet:devtools"),
  moveWindow: (dx, dy) => ipcRenderer.send("pet:move-window", dx, dy),
  moveWindowTo: (x, y) => ipcRenderer.send("pet:move-window-to", x, y),
  getWindowPosition: () => ipcRenderer.sendSync("pet:get-position"),
  toggleAlwaysOnTop: () => ipcRenderer.send("pet:toggle-always-on-top"),
  onAlwaysOnTop: (cb) => {
    const handler = (_e, value) => cb(value);
    ipcRenderer.on("pet:always-on-top", handler);
    return () => ipcRenderer.removeListener("pet:always-on-top", handler);
  },
  // 调用大模型 API（通过主进程，避免 CORS 与密钥暴露）
  ask: (model, question) => ipcRenderer.invoke("pet:ask", model, question),
  // 获取可用模型列表（主进程转发 /v1/models）
  listModels: () => ipcRenderer.invoke("pet:list-models"),
  // 获取累计用量统计
  getUsageStats: () => ipcRenderer.invoke("pet:get-usage-stats"),
  // 订阅用量统计推送（每次提问后）
  onUsageStats: (cb) => {
    const handler = (_e, stats) => cb(stats);
    ipcRenderer.on("pet:usage-stats", handler);
    return () => ipcRenderer.removeListener("pet:usage-stats", handler);
  },
  // IPC 测试
  ping: () => {
    const result = ipcRenderer.sendSync("pet:ping");
    return result;
  },
  // ---- 情绪监测（摄像头识别 / 记录 / 推测 / 陪伴）----
  // 渲染层抓到一帧就送主进程（主进程节流分析）。
  // geo 是抓帧那一刻本机量到的嘴部几何量 {ts, marOut, marIn}，给哈欠"过闸"用（可为 null）
  sendEmotionFrame: (dataUrl, geo) => ipcRenderer.send("pet:emotion-frame", dataUrl, geo),
  // 摄像头不可用（无设备/被拒绝）上报
  emotionCameraError: (msg) => ipcRenderer.send("pet:emotion-camera-error", msg),
  // 主进程通知摄像头开/关
  onEmotionCamera: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("pet:emotion-camera", handler);
    return () => ipcRenderer.removeListener("pet:emotion-camera", handler);
  },
  // 每次情绪分析结果
  onEmotionUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("pet:emotion-update", handler);
    return () => ipcRenderer.removeListener("pet:emotion-update", handler);
  },
  // 显著情绪变化事件
  onEmotionEvent: (cb) => {
    const handler = (_e, event) => cb(event);
    ipcRenderer.on("pet:emotion-event", handler);
    return () => ipcRenderer.removeListener("pet:emotion-event", handler);
  },
  // 陪伴消息（心情气泡）
  onCompanion: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("pet:companion", handler);
    return () => ipcRenderer.removeListener("pet:companion", handler);
  },
  // 情绪报告数据
  emotionReport: () => ipcRenderer.invoke("pet:emotion-report"),
  // 报告内容变化（新事件 / 原因补上 / 兜底）→ 面板开着时刷新
  onEmotionReportChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("pet:emotion-report-changed", handler);
    return () => ipcRenderer.removeListener("pet:emotion-report-changed", handler);
  },
  // 用户点了心情气泡上的交互按钮
  emotionInteract: (id) => ipcRenderer.invoke("pet:emotion-interact", id),
  // 认主登记（送一张参考照）/ 认主状态 / 看家开关
  emotionEnroll: (dataUrl) => ipcRenderer.invoke("pet:emotion-enroll", dataUrl),
  ownerInfo: () => ipcRenderer.invoke("pet:emotion-owner-info"),
  guardToggle: () => ipcRenderer.invoke("pet:emotion-guard-toggle"),
  // 认主引导窗口完成通知
  enrollDone: () => ipcRenderer.send("pet:enroll-done"),
  // 每次身份结论（含锁屏探测期的快速探测）→ 心情面板状态条
  onPresenceSample: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on("pet:presence-sample", handler);
    return () => ipcRenderer.removeListener("pet:presence-sample", handler);
  },
  // 锁屏状态变化（锁定/解锁）
  onGuardStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on("pet:guard-status", handler);
    return () => ipcRenderer.removeListener("pet:guard-status", handler);
  },
  // 打开独立的心情设置窗口
  openSettings: () => ipcRenderer.send("pet:open-settings"),
  // 打开"识别反馈 / 演示教学"工具（独立的 calib 窗口，标定与演示学习都在那边）
  openFeedback: () => ipcRenderer.send("pet:open-feedback"),
  // 托盘"查看情绪报告" → 打开心情记录面板
  onShowReport: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("pet:emotion-show-report", handler);
    return () => ipcRenderer.removeListener("pet:emotion-show-report", handler);
  },
  // 设置窗口请求认主登记（相机在桌宠窗口，由主进程转发过去拍）
  requestEnroll: () => ipcRenderer.send("pet:enroll-request"),
  onEnrollRequest: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("pet:enroll-request", handler);
    return () => ipcRenderer.removeListener("pet:enroll-request", handler);
  },
  // 主人在场/看家状态推送
  onOwnerPresence: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on("pet:owner-presence", handler);
    return () => ipcRenderer.removeListener("pet:owner-presence", handler);
  },
  // ---- 应用级锁屏 ----
  guardStatus: () => ipcRenderer.invoke("pet:guard-status"),
  guardSetPassword: (pw) => ipcRenderer.invoke("pet:guard-set-password", pw),
  guardEnable: (on) => ipcRenderer.invoke("pet:guard-enable", on),
  guardConfigure: (cfg) => ipcRenderer.invoke("pet:guard-configure", cfg),
  guardClearPassword: () => ipcRenderer.invoke("pet:guard-clear-password"),
  guardLockNow: () => ipcRenderer.invoke("pet:guard-lock-now"),
  guardUnlock: (pw) => ipcRenderer.invoke("pet:guard-unlock", pw),
  guardLockInfo: () => ipcRenderer.invoke("pet:guard-lock-info"),
  // 刷脸解锁：主进程让锁屏先播"终于等到主人啦"的动画再撤（带看家时长）
  onUnlockAnim: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("pet:unlock-anim", handler);
    return () => ipcRenderer.removeListener("pet:unlock-anim", handler);
  },
  // 刷脸确认到主人（连续两眼命中、真的开门）→ 锁屏转绿 + 鲸鱼跳两下
  onOwnerConfirmed: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("pet:owner-confirmed", handler);
    return () => ipcRenderer.removeListener("pet:owner-confirmed", handler);
  },
  // 开关摄像头识别
  emotionToggle: () => ipcRenderer.invoke("pet:emotion-toggle"),
  // 设置识别间隔（分钟）
  emotionSetInterval: (minutes) => ipcRenderer.invoke("pet:emotion-interval", minutes),
  // ---- 隐私开关（屏幕截屏）----
  privacyStatus: () => ipcRenderer.invoke("pet:privacy-status"),
  privacySet: (cfg) => ipcRenderer.invoke("pet:privacy-set", cfg),
  // ---- 吃饭打卡 + 提醒设置 ----
  mealAdd: (what) => ipcRenderer.invoke("pet:meal-add", what),
  mealRecent: () => ipcRenderer.invoke("pet:meal-recent"),
  reminderStatus: () => ipcRenderer.invoke("pet:reminder-status"),
  reminderSet: (cfg) => ipcRenderer.invoke("pet:reminder-set", cfg),
  // 托盘"记录吃饭" → 让桌宠窗口弹打卡对话框
  onMealOpen: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("pet:meal-open", handler);
    return () => ipcRenderer.removeListener("pet:meal-open", handler);
  },
  // ---- 会议旁听（采集在渲染层，转写/纪要在主进程）----
  // 一句切好的语音（wav=ArrayBuffer，16k 单声道 PCM）→ 主进程排队转写
  meetingChunk: (chunk) => ipcRenderer.invoke("pet:meeting-chunk", chunk),
  // 采集真的开始了（主进程据此开账本；tray 入口也靠它知道状态）
  meetingStarted: (info) => ipcRenderer.invoke("pet:meeting-started", info),
  // 采集停了 → 主进程收尾出纪要
  meetingStopped: (reason) => ipcRenderer.invoke("pet:meeting-stopped", reason),
  // 会中休息：on=true 暂停（这场会不结束）/ on=false 继续
  meetingPause: (on, reason) => ipcRenderer.invoke("pet:meeting-pause", { on: !!on, reason }),
  // ---- 旁听"秒答"：同事提问 → 主进程查项目资料 → 卡片显示答案 ----
  // 用最近这段旁听原文当问题去查（知识包优先，不够再翻 D:\company 的代码）
  askAboutMeeting: () => ipcRenderer.invoke("pet:ask-meeting"),
  // 卡片渲染层：订阅"查资料中 / 答案就绪"
  onAskCard: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on("pet:ask-card", handler);
    return () => ipcRenderer.removeListener("pet:ask-card", handler);
  },
  closeAskCard: () => ipcRenderer.send("pet:ask-card-close"),
  resizeAskCard: (height) => ipcRenderer.send("pet:ask-card-resize", height),
  // 采集端心跳（主进程用它判断"渲染层是不是已经失联"）
  meetingBeat: () => ipcRenderer.send("pet:meeting-beat"),
  meetingStatus: () => ipcRenderer.invoke("pet:meeting-status"),
  // 主进程 → 桌宠窗口：实时字幕 / 状态提醒 / 让它开始或结束采集
  onMeetingSignal: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on("pet:meeting-signal", handler);
    return () => ipcRenderer.removeListener("pet:meeting-signal", handler);
  },
  // 打开"会议记录"窗口（泡泡菜单的 📝 纪要走这里；没记录过也照开，里面教怎么开始）
  meetingWindow: () => ipcRenderer.send("pet:meeting-window"),
  // 纪要窗口用：最近一场 / 历次会议 / 读某一份 / 追问 / 打开文件（或所在文件夹）
  meetingLatest: () => ipcRenderer.invoke("pet:meeting-latest"),
  meetingList: () => ipcRenderer.invoke("pet:meeting-list"),
  meetingRead: (file) => ipcRenderer.invoke("pet:meeting-read", file),
  meetingRename: (file, title) => ipcRenderer.invoke("pet:meeting-rename", file, title),
  meetingDelete: (file) => ipcRenderer.invoke("pet:meeting-delete", file),
  meetingAsk: (question) => ipcRenderer.invoke("pet:meeting-ask", question),
  meetingOpen: (what, file) => ipcRenderer.invoke("pet:meeting-open", what, file),
  onMeetingMinutes: (cb) => {
    const handler = (_e, minutes) => cb(minutes);
    ipcRenderer.on("pet:meeting-minutes", handler);
    return () => ipcRenderer.removeListener("pet:meeting-minutes", handler);
  },
  // 旁听设置（麦克风轨 / 实时字幕 / 保留天数 / 热词）
  meetingConfig: () => ipcRenderer.invoke("pet:meeting-config"),
  meetingConfigSet: (cfg) => ipcRenderer.invoke("pet:meeting-config-set", cfg),
  // ---- 听歌点评（可选，默认关）----
  // 只读系统"正在播放"的元数据（歌名/歌手/专辑/进度）+ 开关状态
  musicConfig: () => ipcRenderer.invoke("pet:music-config"),
  musicConfigSet: (cfg) => ipcRenderer.invoke("pet:music-config-set", cfg),
  // 设置页"听歌测试"：模拟一首歌走完点评链路
  musicTest: () => ipcRenderer.invoke("pet:music-test"),
  // 开机自启（读写 HKCU Run 注册表）
  autostartStatus: () => ipcRenderer.invoke("pet:autostart-get"),
  autostartSet: (on) => ipcRenderer.invoke("pet:autostart-set", on),
  // ---- 换装（帽子 + 配色，纯外观）----
  outfitGet: () => ipcRenderer.invoke("pet:outfit-get"),
  outfitSet: (cfg) => ipcRenderer.invoke("pet:outfit-set", cfg),
  onOutfit: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on("pet:outfit", handler);
    return () => ipcRenderer.removeListener("pet:outfit", handler);
  },
  // ---- 首启向导（首次打开桌面宠物时的配 API / 命名 / 自检窗口）----
  firstRunProviders: () => ipcRenderer.invoke("pet:firstrun-providers"),
  firstRunProfile: () => ipcRenderer.invoke("pet:firstrun-profile"),
  firstRunListModels: (opts) => ipcRenderer.invoke("pet:firstrun-list-models", opts),
  firstRunTest: (opts) => ipcRenderer.invoke("pet:firstrun-test", opts),
  firstRunSave: (payload) => ipcRenderer.invoke("pet:firstrun-save", payload),
  firstRunDone: () => ipcRenderer.invoke("pet:firstrun-done"),
  firstRunSkip: () => ipcRenderer.invoke("pet:firstrun-skip"),
  // ---- 本地人脸识别（认主/在场判定，模型与特征都在本机）----
  // 读模型文件（渲染层是 file:// 页面，fetch 不了本地文件，交给主进程读盘）
  faceModelBytes: (name) => ipcRenderer.invoke("pet:face-model", name),
  // 主人的参考照 + 特征向量（老用户只有照片，渲染层会就地补算特征）
  faceRefs: () => ipcRenderer.invoke("pet:face-refs"),
  faceEnrollDescriptor: (list) => ipcRenderer.invoke("pet:face-enroll-descriptor", list),
  // 本地识别就绪/失效（主进程据此决定身份是本地判还是回退云端模型）
  faceReady: (info) => ipcRenderer.send("pet:face-ready", info),
  // 每次本地身份结论（含锁屏探测期的快速探测）
  sendFaceVerdict: (v) => ipcRenderer.send("pet:face-verdict", v),
  // 认主自适应：每帧上报一条人脸相似度实测样本（主进程落到 data/face-samples.jsonl，纯旁路）
  faceSample: (s) => ipcRenderer.send("pet:face-sample", s),
  // 认主完成后主进程叫渲染层重算特征
  onFaceRefresh: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("pet:face-refresh", handler);
    return () => ipcRenderer.removeListener("pet:face-refresh", handler);
  },
});
