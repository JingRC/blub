// calib/threshold.js — 哈欠阈值怎么算（标定页与反馈页共用，只此一处定义）
//
// 规则（宁漏不误）：
//   有负例基线（标定量到的"闭嘴/故意张嘴说话/手托下巴"最高外唇 MAR）时：
//     演示峰值必须明显高出基线（≥ MIN_SEP）才算"能分开"，才敢用它定阈值；
//     阈值离基线上限至少留 MARGIN，靠负例一侧取值。
//     分不开就**不写阈值**（保持现有值）——绝不允许算出比基线还低的阈值。
//   没有基线时：不敢低于代码默认值（0.34）。
(function () {
  const DEF = 0.34;     // 与 emotion.js 的 YAWN_MAR_MIN 一致
  const MIN_SEP = 0.12; // 演示峰值至少要高出负例上限这么多，才算"单帧 MAR 分得开"
  const MARGIN = 0.04;  // 阈值与负例上限之间至少留的余量

  const clampRound = (x) => Math.round(Math.max(0.2, Math.min(0.95, x)) * 100) / 100;

  /**
   * @param {number} pos 演示里量到的外唇 MAR 高位分位（正例峰值）
   * @param {number|null} neg 负例上限（标定得到的最高外唇 MAR），没做过标定就传 null
   * @returns {{ok:boolean, thr?:number, reason:string}}
   */
  function yawnThreshold(pos, neg) {
    if (typeof pos !== "number") {
      return { ok: false, reason: "这次没量到嘴（人脸没进画面 / 光太暗？），拿不到正例峰值" };
    }
    if (typeof neg === "number") {
      const sep = pos - neg;
      if (sep < MIN_SEP) {
        return {
          ok: false,
          sep,
          reason: `峰值 ${pos.toFixed(3)} 只比负例上限 ${neg.toFixed(3)} 高 ${sep.toFixed(3)}，不够分开（要 ≥${MIN_SEP} 才算单帧分得开）`,
        };
      }
      const thr = clampRound(neg + Math.max(MARGIN, sep * 0.35));
      return {
        ok: true,
        thr,
        sep,
        reason: `峰值 ${pos.toFixed(3)}、负例上限 ${neg.toFixed(3)} → 阈值 ${thr}（离负例留 ${(thr - neg).toFixed(2)} 余量）`,
      };
    }
    const thr = clampRound(Math.max(DEF, pos * 0.7));
    return { ok: true, thr, reason: `峰值 ${pos.toFixed(3)} → 阈值 ${thr}（还没做过基线标定，只能按保守值取，不低于默认 ${DEF}）` };
  }

  window.yawnThreshold = yawnThreshold;
  // 常量也挂出来，界面提示要引用同一份（避免两边各写一个数）
  yawnThreshold.MIN_SEP = MIN_SEP;
  yawnThreshold.MARGIN = MARGIN;
  yawnThreshold.DEFAULT = DEF;
})();