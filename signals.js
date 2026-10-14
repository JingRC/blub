// signals.js —— 感知信号声明表
//
// 目的：把"一个信号的全部知识"收在一处。以前这些知识散在 emotion.js 里：
//   判定口径     → ACTION_PROMPT（原 emotion.js:50-55）
//   字段名/中文名 → actionDefs()（原 :303-325）+ ACTION_NAMES
//   本机复核     → _gateYawn（原 :433-453）专写哈欠、_gateAction 管自定义动作
//   记账与反应   → _noteYawn 带专属话术、_recordAction 只计数
// 目标：加一个新识别（例如"揉眼"）只往 SIGNALS 里加一条，主程序不动 if。
//
// 接线进度：
//   ✅ 第 1 步（2026-09-18 已完成）——本文件成为**唯一真源**，emotion.js 由它派生：
//      动作 prompt 文案与字段名、中文名、情绪词表与 valence、突变判定参数、
//      哈欠闸门阈值、自定义动作闸门放松系数。行为逐字不变（同批输入新旧两版比对通过）。
//   ✅ 第 2 步（2026-09-18 已完成）——哈欠的**闸门逻辑与话术**也搬进来了：
//      emotion.js 里 _gateYawn/_gateAction 合并成通用的 _gate()（threshold / range / null 三种策略，
//      缺数据时的态度看 onMissingGeo / onNoMouth），阈值来源统一到 _gateMin()（环境变量 > 标定
//      覆盖 > 声明默认）；话术、冷却、气泡文案由下面的 react 段生成；计数改成**按段**、
//      段长取 count.endGapMs。看家模式不记账由 PRECONDITIONS 表达。
//      ⚠️ 这一步是**有意的行为变更**：姿势类不再按固定 30 秒反复计数
//      （实测：摸下巴连续 10 分钟 20 次 → 1 次；离开 90 秒断开 = 2 次；只离开 40 秒仍算同一段 = 1 次）；
//      哈欠计数不变（一次/两次/同一段 = 1/2/1）。
//   ✅ 第 3 步（2026-09-18 已完成）——calib/ 改成读这里：反馈列表会列出"声明里有但还没识别到过"
//      的信号（新加一条声明就能在界面上选中它跑演示）；演示剧本（teach.steps）、判定策略
//      （teach.strategy）、要采的几何字段、结果提示语、emoji 全部由本文件提供，
//      calib 里不再有第二份情绪词表或写死的哈欠演示步骤。
//   ✅ 小尾巴（2026-09-18 已完成）——report.emoji 已接到心情记录面板（🥱🤔🤨🙆）
//
// 三条自我约束（防止声明膨胀成"小语言"）：
//   · 声明里**只允许数据 + 策略名**，不许写函数或表达式；策略实现放 strategies/ 里
//   · 字段**按需增加**；等第二个信号真需要时再加
//   · 状态机与安防阈值**不在这里**（guard.js 的监控/确认/锁定、probe 身份探测属于"围栏"，
//     跟"看得懂什么"是两件事；dsh 也是把 sandbox/approval 和 tools 分开的）
//
// 2026-09-18 主人拍板的五件事（已写进下面）：
//   ① "主人不在就不记账"放**全局**一条（PRECONDITIONS），不写进每张卡片
//   ② 计数改成**按段**（姿势连续保持 = 一段），不再用固定时间窗：哈欠段 30 秒、托腮/摸下巴段 60 秒
//   ③ 自定义动作**只走行为线**（情绪线再问一遍等于参考图成本翻倍）；行为线被关掉时才回落情绪线
//   ④ "策略名 + 实现分开放"照做：demo-threshold（哈欠）/ demo-range（自定义动作）
//   ⑤ 报告里的 emoji 保留（现状报告没有 emoji，属新增的展示约定）

// ---- 分析线（一次调用问哪些信号）--------------------------------------------
// 三条线的节奏、花费、问法都不同，所以"信号排在哪条线"必须是声明的一部分。
// 注意 probe 这条线只做身份探测，它的 prompt/判定归 guard 那侧，不在这里声明（见上面第 3 条约束）。
const LANES = {
  emotion: {
    interval: "intervalMs", // 默认 60s，见 emotion.js 的 this.intervalMs
    maxTokens: 900,
    asks: ["emotion", "owner"], // 顺带问情绪与身份（已认主时才要身份）
  },
  behavior: {
    interval: "behaviorIntervalMs", // 默认 5s（DSH_PET_BEHAVIOR_INTERVAL 可调，0=关）
    maxTokens: 120, // prompt 短、max_tokens 小：这条线只问动作，省钱也快
    asks: ["actions"],
    skipWhenNoFace: true, // 画面里没人就别问（没人的"动作"没有意义）
  },
};

// ---- 全局前置条件（对所有信号生效，所以不写进每张卡片）----------------------
// "主人不在就不记账"是安防语义，不属于某个信号。现在它是 emotion.js 里 _noteBehavior 和
// _accept 各写一遍的 if（guardActive 时直接 return），接线时收敛成这一条。
const PRECONDITIONS = {
  skipWhenNoFace: true, // 画面里没人 → 任何信号都不成立
  skipWhenGuardActive: true, // 看家模式（连续多帧没看到主人）→ 不计数、不弹气泡
};

// 看家期间的"偶尔摸鱼"**不在这里**：那是看家职责的表演（guard 侧的发条），
// 不影响任何识别与锁定判定。接法：guard 每 25~40 分钟随机放一次摸鱼小动画（打盹/偷玩水），
// 其余时间保持警惕神态——主人 2026-09-18 的要求是"偶尔摸鱼，更多时候还是看家护院"。
// 信号表只该管"看得懂什么"，不该管"鲸鱼怎么演"。

// ---- 信号声明 ---------------------------------------------------------------

// 动作 prompt 的开头（所有动作字段共用一句总说明）。
// 现状（逐字保留）：免费小模型需要"没有就 false，不要硬凑"这种硬话，否则什么都点头。
const ACTION_PROMPT_HEADER =
  "动作字段（没有就 false，不要硬凑，看不清也 false）：";

const SIGNALS = [
  {
    key: "yawn",
    label: "哈欠",
    lane: "behavior", // 行为专线是抓哈欠的主力（哈欠只持续 4~6 秒，情绪线 60s 一帧抓不到）
    ownChannel: true, // 哈欠是独立通道：自己带 sample.yawn 字段、自己一个计数器、自己一句气泡，
    //                   不算进"小动作"统一下（报告里单独一行）。原来这是散在
    //                   _readActions/_noActions/_noFaceJson/报告里的"key !== 'yawn'"硬编码。
    prompt: {
      // ask 是**最终拼进 prompt 的整段文字**（含结尾标点），这样第 1 步重构可以逐字比对。
      // 判定口径 + 反例都要写清楚：免费小模型分不清"张嘴说话/托下巴顶开嘴"和"真打哈欠"。
      ask: "yawn=在打哈欠：嘴巴张开、或刚张开正在合上、眼睛眯起/眼眶湿润都算（正常说话、微笑、手托下巴把嘴顶开都不算）；",
    },
    gate: {
      // 云端说"在打哈欠"不算数，本机外唇 MAR 要够大才采信
      strategy: "threshold",
      field: "marOut",
      min: 0.34,
      // 为什么停在这个值（实测依据，别再凭感觉往上调）：托下巴 0.235~0.317 挡得住；
      // 说话 0.278~0.422 与真哈欠 0.182~0.431 重叠，单帧分不开，已认"偶尔误报"这个代价。
      // 历史：曾用 0.50 想连说话一起挡，结果真哈欠（0.40~0.43）也被否 → 哈欠等于记不上数。
      why: "手托下巴上限 0.317 之上；说话与真哈欠重叠，分不开",
      env: "DSH_PET_YAWN_MAR", // 环境变量可覆盖，设 0 = 关掉这道闸
      learnt: true, // 标定工具演示一次真哈欠可写覆盖值（learned-actions.json 的 gate.yawn.marOutMin）
      onMissingGeo: "count", // 没收到本机几何量（旧渲染层/管线坏了）：闸门失效但仍计数，并在日志里喊出来
      onNoMouth: "reject", // 量不到嘴（没脸/关键点缺失）：这一帧不计数
    },
    // 按"段"计数，不用固定时间窗：姿势连续保持算一段，离开了 endGapMs 才算这段结束。
    // 哈欠是瞬时动作（一次 4~6 秒），30 秒足够把连续两三帧并成一段。
    count: { mode: "segment", endGapMs: 30000 },
    react: {
      // 只有哈欠会主动搭话；其它动作只进报告（"攒着让你自己看"就够，免得变成碎碎念）
      mood: "tired",
      cooldownMs: 600000, // 10 分钟最多说一次
      suppressWhenWarn: true, // 锁屏预警气泡挂着时不抢话（气泡留给"我在"按钮）
      blocksSmallTalk: true, // 这一帧说了哈欠，就不再叠加随机搭话（免得气泡互相顶掉）
      bubble: "捕捉到打哈欠（今日 {n} 次 / 累计 {total} 次）",
      lines: [
        { maxToday: 2, text: "哈欠一口，困意满满～" },
        { maxToday: 5, text: "这是今天的第 {n} 个哈欠了，要不要眯一会儿？" },
        {
          maxToday: Infinity,
          text: "今天已经 {n} 个哈欠了！身体在强烈抗议，快休息！",
        },
      ],
    },
    teach: {
      // 演示教学：先做两段负例再真打哈欠 → 用 threshold.js 的策略定阈值。
      // steps 是"演示剧本"（原来写死在 calib/feedback.js 里，加新信号就得改界面代码）
      strategy: "demo-threshold",
      geo: "marOut", // 定阈值只认外唇 MAR
      record: ["marIn", "ear"], // 顺带存下来当旁证（标定报告里会列）
      resultHint:
        "以后云端说「在打哈欠」时，本机外唇 MAR 要过这个阈值才算数（说话/托下巴会被挡住）。",
      steps: [
        {
          role: "neg",
          title: "先故意张嘴合上（不要打哈欠）",
          hint: "不出声，像说话那样张嘴合上 5~6 次 —— 「像哈欠但不是」的负例",
          seconds: 6,
        },
        {
          role: "neg",
          title: "手托下巴 / 托腮",
          hint: "手托着下巴或撑着脸颊，保持住 —— 你遇到的误报场景",
          seconds: 6,
        },
        {
          role: "pos",
          title: "现在真打 1~2 个哈欠",
          hint: "张大嘴保持 2~3 秒；等显示「开始！」再打（哈欠只有几秒，提前会被漏掉）",
          seconds: 18,
        },
      ],
    },
    report: { emoji: "🥱", showWhenZero: false }, // 今日为 0 的条目别占位
  },

  // 托腮 / 摸下巴是"持续性姿势"，可能保持好几分钟（苦思冥想时手就搭在那儿不动）。
  // 段结束判 60 秒的依据：公开研究给的是**频率**不是时长——人平均每 2~4 分钟就会摸一次脸
  // （伯克利 2008：15.7 次/小时；新南威尔士 2015：23 次/小时；一天可达数百次）。
  // 所以"离开 60 秒"既不会把一段连续姿势切碎，也不会把两次独立动作粘成一段。
  // 原来的固定 30 秒窗会把"扶着下巴想 5 分钟"记成 10 次——今天日志里摸下巴 115 次很可能就
  // 含这个虚高成分。想更准可以用真实数据标定：让行为线记下每次命中的时间戳，跑一天看段长分布。
  {
    key: "handOnChin",
    label: "摸下巴",
    lane: "behavior",
    prompt: { ask: "handOnChin=手或手指托着、摸着下巴，下巴靠/搭在手上；" },
    gate: null, // 本机没有对应几何量（没开手部检测）→ 直接采信云端
    count: { mode: "segment", endGapMs: 60000 },
    report: { emoji: "🤔", showWhenZero: false },
  },

  {
    key: "handOnCheek",
    label: "托腮",
    lane: "behavior",
    prompt: { ask: "handOnCheek=手撑着脸颊（托腮）；" },
    gate: null,
    count: { mode: "segment", endGapMs: 60000 }, // 同"摸下巴"：姿势型，段结束判定放长
    report: { emoji: "🤨", showWhenZero: false },
  },

  {
    key: "stretch",
    label: "伸懒腰",
    lane: "behavior",
    prompt: { ask: "stretch=双臂上举或身体后仰伸懒腰。" }, // 现状最后一条用"。"收尾，逐字保留
    gate: null,
    count: { mode: "segment", endGapMs: 30000 }, // 瞬时动作（3~5 秒），跟哈欠同档
    report: { emoji: "🙆", showWhenZero: false },
  },
];

// ---- 情绪（不是"命中/未命中"的布尔信号，所以单独放）--------------------------
// 情绪是八选一的分类 + 由标签映射出的 valence，不进 SIGNALS 数组。
const EMOTION = {
  lane: "emotion",
  labels: {
    happy: "开心",
    calm: "平静",
    focused: "专注",
    surprised: "惊讶",
    tired: "疲惫",
    sad: "低落",
    stressed: "压力大",
    angry: "生气",
  },
  // valence 不采信模型给的连续值（免费小模型对同一张图 0.0/0.6 乱跳，会让突变判定变丢硬币），
  // 改成由标签查表——稳定、可解释、够用。
  valence: {
    happy: 0.8,
    calm: 0.3,
    focused: 0.2,
    surprised: 0.1,
    tired: -0.2,
    sad: -0.6,
    stressed: -0.6,
    angry: -0.7,
  },
  parse: { confidenceDefault: 0.6 }, // 模型没给 confidence 时的兜底
  change: {
    // 什么才算"显著情绪变化"（会写事件、推测原因、弹提醒）
    requireLabelChange: true, // 只认标签真的换了；否则 calm→calm 的数值抖动也会记一条
    deltaThreshold: 0.35, // valence 相对近期基线（前 2~3 个有效样本均值）的跳变幅度
    crossSign: { prevMin: 0.05, nextAbs: 0.3 }, // 正负情绪跨越，且两侧幅度够大
    minConfidence: 0.45, // 低于此置信度的样本不参与突变判定
    history: 60, // 内存里保留的最近样本数（落盘事件另有上限 500）
  },
  absence: { strikes: 5 }, // 连续多少个样本未见主人 → 触发锁屏预警（判定本身在 guard 侧）
};

// ---- 自定义动作（"演示教学"学来的）如何变成一份声明 ---------------------------
// learned-actions.json 继续当**覆盖层**：内置声明是默认，主人教的是补丁，5 秒热加载不动。
// 接线时按下面模板把 learned.actions 逐条展开成运行时声明。
const CUSTOM_SIGNAL_TEMPLATE = {
  key: "<learned 里的 key>",
  label: "<label>",
  lane: "behavior", // 只走行为线：情绪线再问一遍等于每 60 秒白发一次参考图（成本翻倍），
  // 而行为线 5 秒一帧本来就带全部动作字段，不会漏。
  // 唯一例外：行为线被关掉时（DSH_PET_BEHAVIOR_INTERVAL=0）回落到情绪线，
  // 否则主人教的动作会永远不被问到。
  // 注意：自定义动作的 prompt 片段是现拼的（带 label + desc），不像内置信号那样是固定文字，
  // 现状格式见 emotion.js 的 _actionPrompt()：`${key}=画面里的人正在做「${label}」（${desc}），看不清或不确定就 false；`
  prompt: { ask: "<按 label + desc 现拼，见上>" },
  refs: "learned.refs（最多 2 张 160px 演示参考图，当 few-shot 垫在 prompt 最后）",
  ownChannel: false, // 属于"小动作"统一下，报告里按 label 列一行
  gate: {
    // 演示时量到过几何区间就当一道闸门：云端说发生了、本机姿势却完全不像 → 不计数
    strategy: "range",
    fields: ["marIn", "marOut", "ear", "pitch"],
    slack: 0.25, // 区间向外扩这么多，避免姿势一变就全部否掉（原 CUSTOM_GATE_SLACK）
    onMissingField: "skip", // 本机这一项没量到 → 跳过该项，别拿缺失当否证
  },
  count: { mode: "segment", endGapMs: 60000 }, // 自定义动作多半也是持续性姿势（喝水/扶着什么），按姿势力度给 60 秒
  react: null, // 只统计、不搭话
  teach: {
    strategy: "demo-range", // 演示一次 → 取几何区间 + 参考图
    seconds: 8, // 单段演示时长
    refs: 2, // 挑几张参考图当 few-shot
    resultHint:
      "参考图会跟着每次识别发给模型（告诉它这类画面叫什么）；几何区间用来复核，避免「看起来像」就算。",
  },
};

module.exports = {
  LANES,
  PRECONDITIONS,
  ACTION_PROMPT_HEADER,
  SIGNALS,
  EMOTION,
  CUSTOM_SIGNAL_TEMPLATE,
};
