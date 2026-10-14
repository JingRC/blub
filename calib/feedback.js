// calib/feedback.js — 识别反馈 + 演示教学（整窗口只有这一套交互）
//
// 交互模型：列表里点一行 = 选中；选中后只出现一条操作栏 + 一个按钮（不再每行挂一个 👎）。
//   哈欠    → 三段演示（故意张嘴 → 托下巴 → 真打哈欠）→ 自动算阈值（threshold.js）
//   动作    → 一段演示（8 秒）→ 参考图 few-shot + 本机几何区间复核
//   新动作  → 同上，另填名字/描述
//   情绪    → 没有可演示的动作，只记一条反馈
// 采集能力（摄像头 + face.mesh）来自 calib.js 的 window.dshTool。

(function () {
  const $ = (id) => document.getElementById(id);
  const actBar = $("actBar");
  const actWhat = $("actWhat");
  const actRunBtn = $("actRunBtn");
  const actCancelBtn = $("actCancelBtn");
  const hintLine = $("hintLine");
  const demoBox = $("demoBox");
  const demoNo = $("demoNo");
  const demoTag = $("demoTag");
  const demoTitle = $("demoTitle");
  const demoHint = $("demoHint");
  const demoNew = $("demoNew");
  const demoLabel = $("demoLabel");
  const demoDesc = $("demoDesc");
  const demoCount = $("demoCount");
  const demoBar = $("demoBar");
  const demoProgress = $("demoProgress");
  const demoPeak = $("demoPeak");
  const demoStartBtn = $("demoStartBtn");
  const demoAgainBtn = $("demoAgainBtn");
  const demoSaveBtn = $("demoSaveBtn");
  const demoCancelBtn = $("demoCancelBtn");
  const demoInfo = $("demoInfo");
  const demoFrames = $("demoFrames");
  const fbList = $("fbList");

  const SAMPLE_MS = 300;   // 采样间隔（约 3 样本/秒：一次识别 ~190ms）
  const PREP_S = 2;        // 每段前的准备（先把姿势摆好，别把起手录进去）
  const FRAME_EVERY = 2;   // 每两拍留一张候选帧，最后挑 2 张最"像动作"的当参考图

  // 说明：哈欠的三段演示剧本（两段负例 + 一段正例）已经搬进 signals.js 的
// yawn.teach.steps —— 加新信号只需在声明里写自己的剧本，这个文件不用动。

  let records = null;
  let decls = {};          // 信号声明（signals.js 经主进程下发）：演示剧本/判定策略/几何字段都从这来
  let sel = null;          // 选中的行：{kind:"yawn"|"action"|"new"|"emotion", key, label, desc, ts}
  let steps = [];          // 本次要演示的段
  let segs = [];           // 每次演示采到的样本（按段累积：[{role, samples:[...]}]）
  let curSeg = null;
  let frames = [];         // 候选关键帧 [{t, dataUrl}]
  let running = false;
  let cancelled = false;
  let timer = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (ts) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
  const f3 = (x) => (typeof x === "number" ? x.toFixed(3) : "-");
  const num = (list, f) => list.map((s) => s[f]).filter((x) => typeof x === "number").sort((a, b) => a - b);
  const q = (v, p) => (v.length ? v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))] : null);

  // ---- 列表 -------------------------------------------------------------------

  async function loadRecords() {
    records = await window.dshCalib.records();
    decls = records.decls || {};
    const L = [];
    const MIN_SEP = window.yawnThreshold.MIN_SEP;
    const thrNow = records.learned.yawnMarMin == null ? `内置 ${window.yawnThreshold.DEFAULT}` : `学到的 ${records.learned.yawnMarMin}`;
    const negNow = negBaseline();

    L.push(`<div class="grp"><span class="dot"></span>打哈欠 · 当前阈值 ${thrNow}</div>`);
    L.push(row("yawn", "🥱", "哈欠", `今日 <b>${records.yawn.today}</b> · 累计 ${records.yawn.total}`));
    if (negNow != null) {
      L.push(`<div class="note">已知负例上限 ${f3(negNow)}（演示时峰值要高出它 ≥${MIN_SEP} 才算分得开）</div>`);
    } else {
      L.push('<div class="note">还没有负例基线：演示哈欠时会先带你做两段负例（故意张嘴 / 托下巴）</div>');
    }

    L.push('<div class="grp"><span class="dot"></span>动作计数</div>');
    for (const a of records.actions) {
      const info = records.learned.custom.find((c) => c.label === a.name);
      const tags = [
        info ? "学来的" : "",
        info && info.gated ? "本机复核" : "",
        info && info.refs ? `参考图 ${info.refs}` : "",
      ].filter(Boolean).join(" · ");
      L.push(row("action", "✋", a.name + (tags ? ` <span class="tag">${tags}</span>` : ""), `今日 <b>${a.today}</b> · 累计 ${a.total}`, { name: a.name, delKey: info ? info.key : "" }));
    }
    L.push(row("new", "➕", "教一个新动作（例：喝水 / 揉眼 / 转笔）", ""));

    L.push('<div class="grp"><span class="dot"></span>情绪识别 · 最近 15 条变化</div><div class="scroll">');
    if (!records.events.length) L.push('<div class="note">今天还没有情绪变化记录</div>');
    for (const e of records.events) {
      L.push(row("emotion", "", `${fmt(e.ts)}　${e.from} → ${e.to}`, "", { ts: e.ts }));
    }
    L.push("</div>");

    if (records.feedback.length) {
      L.push('<div class="grp"><span class="dot"></span>最近的反馈</div><div class="scroll">');
      for (const f of records.feedback.slice(0, 8)) {
        L.push(`<div class="note" style="padding:2px 9px">${fmt(f.ts)}　${f.subject || f.kind}　${f.note || ""}</div>`);
      }
      L.push("</div>");
    }

    fbList.innerHTML = L.join("");
    fbList.querySelectorAll(".row").forEach((el) => {
      el.addEventListener("click", () => selectRow(el.dataset));
    });
    fbList.querySelectorAll("button[data-del]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation(); // 别把行选中了
        const r = await window.dshCalib.learnedRemove(btn.dataset.del);
        if (!(r && r.ok)) {
          demoBox.hidden = false;
          demoInfo.textContent = `删除失败：${(r && r.error) || "未知"}`;
          demoInfo.className = "saved bad";
        }
        await loadRecords();
      });
    });
    if (sel) markSelected();
  }

  function row(kind, ic, name, numHtml, extra = {}) {
    const data = [`data-kind="${kind}"`, extra.name ? `data-name="${extra.name}"` : "", extra.ts ? `data-ts="${extra.ts}"` : ""]
      .filter(Boolean).join(" ");
    // 学来的动作才带一个删除小叉（学错了想重来），别的行没有按钮
    const del = extra.delKey ? `<button class="mini del" data-del="${extra.delKey}" title="删掉这个学来的动作">✕</button>` : "";
    return `<div class="row" ${data}><span class="ic">${ic}</span><span class="nm">${name}</span><span class="num">${numHtml}</span>${del}</div>`;
  }

  /** 负例上限：优先用演示学到的新值，没有就退回早先那次标定文件里的值 */
  function negBaseline() {
    if (records && records.learned.yawnNegMax != null) return records.learned.yawnNegMax;
    if (records && records.lastCalibration) return records.lastCalibration.negMax;
    return null;
  }

  function markSelected() {
    fbList.querySelectorAll(".row").forEach((el) => el.classList.remove("sel"));
    if (!sel) return;
    const want = sel.kind === "action" ? sel.label : sel.kind === "emotion" ? String(sel.ts) : null;
    for (const el of fbList.querySelectorAll(".row")) {
      if (el.dataset.kind !== sel.kind) continue;
      if (want == null || el.dataset.name === want || el.dataset.ts === want) { el.classList.add("sel"); break; }
    }
  }

  // ---- 选中 → 一条操作栏 --------------------------------------------------------

  function selectRow(d) {
    if (running) return;
    if (d.kind === "yawn") sel = { kind: "yawn", label: "哈欠", key: "yawn", decl: decls.yawn || null };
    else if (d.kind === "new") sel = { kind: "new", label: "", key: "", desc: "", decl: decls.__custom || null };
    else if (d.kind === "action") {
      const info = records.learned.custom.find((c) => c.label === d.name);
      // 演示剧本与判定策略都从声明来：内置信号在 decls 里有自己的一条，自定义动作套用模板
      const decl = (d.key && decls[d.key]) || (info && decls[info.key]) || decls.__custom || null;
      sel = info
        ? { kind: "action", label: info.label, key: info.key, desc: info.desc, decl }
        : { kind: "new", label: d.name, key: "", desc: "", decl };
    } else sel = { kind: "emotion", ts: Number(d.ts) };

    markSelected();
    resetDemo();
    actBar.hidden = false;
    demoBox.hidden = true;

    if (sel.kind === "emotion") {
      actWhat.innerHTML = `已选：<b>${fmt(sel.ts)} 这条情绪变化</b>　<span style="color:#7f9ab5">情绪没有可演示的动作，只能记一条反馈</span>`;
      actRunBtn.textContent = "记下这条不对";
      actRunBtn.className = "";
      hintLine.textContent = "情绪暂时只能记反馈（以后想用演示教学，可以告诉我怎么演示）。";
      return;
    }
    actRunBtn.className = "primary";
    if (sel.kind === "yawn") {
      actWhat.innerHTML = '已选：<b>🥱 哈欠</b>　<span style="color:#7f9ab5">三段：故意张嘴 → 托下巴 → 真打哈欠，约 35 秒</span>';
      actRunBtn.textContent = "演示真实动作";
      hintLine.textContent = "演示时会先带你做两段「不是哈欠但容易被认成哈欠」的动作，再真打哈欠，用来定阈值。";
    } else {
      actWhat.innerHTML = `已选：<b>${sel.label}</b>　<span style="color:#7f9ab5">一段演示 8 秒，可演示多次；画面会当参考图教给模型</span>`;
      actRunBtn.textContent = "演示真实动作";
      hintLine.textContent = "把动作做完整一点，中途别停；演示画面会留 2 张参考图给模型看。";
    }
  }

  actCancelBtn.addEventListener("click", () => {
    sel = null;
    running = false;
    resetDemo();
    actBar.hidden = true;
    demoBox.hidden = true;
    markSelected();
    hintLine.textContent = "点下面任意一行来选它；「哈欠」会带你做三段（先故意张嘴、再托下巴、最后真打哈欠），自动算出阈值。";
  });

  actRunBtn.addEventListener("click", () => {
    if (!sel) return;
    if (sel.kind === "emotion") {
      window.dshCalib.learnedSave({ feedback: { kind: "emotion", subject: fmt(sel.ts), note: "主人认为这条情绪不对" } }).then((r) => {
        demoBox.hidden = false;
        demoNo.textContent = "反馈";
        demoTitle.textContent = "已记下";
        demoHint.textContent = "情绪识别暂时不做演示教学。";
        demoInfo.textContent = r && r.ok ? "已记下这条反馈 ✓" : `保存失败：${r && r.error}`;
        demoInfo.className = r && r.ok ? "saved ok" : "saved bad";
        hideDemoButtons();
        loadRecords();
      });
      return;
    }
    startTeach();
    // 哈欠/已有动作：一次点击就开演（先给 2 秒准备）；新动作要先填名字，所以留给面板上的「开始演示」
    if (sel.kind !== "new") runDemo().catch((e) => console.error("[lab] 演示出错:", e.message));
  });

  // ---- 演示向导 ----------------------------------------------------------------

  function resetDemo() {
    segs = [];
    frames = [];
    curSeg = null;
    cancelled = false;
    demoInfo.textContent = "";
    demoInfo.className = "saved";
    demoFrames.innerHTML = "";
    demoCount.hidden = true;
    demoBar.hidden = true;
    demoPeak.hidden = true;
    demoTag.hidden = true;
    demoProgress.style.width = "0%";
  }

  function hideDemoButtons() {
    demoStartBtn.hidden = true;
    demoAgainBtn.hidden = true;
    demoSaveBtn.hidden = true;
  }

  function startTeach() {
    resetDemo();
    demoBox.hidden = false;
    // 演示剧本来自声明（teach.steps）；没写剧本的信号（例如演示教学学的自定义动作）走通用单段演示
    const t = (sel.decl && sel.decl.teach) || null;
    steps = t && Array.isArray(t.steps) && t.steps.length
      ? t.steps
      : [
          {
            role: "pos",
            title: sel.label ? `演示「${sel.label}」` : "演示这个新动作",
            hint: `${(t && t.seconds) || 8} 秒里做 2~3 次，动作做完整一点`,
            seconds: (t && t.seconds) || 8,
          },
        ];
    demoNew.hidden = sel.kind !== "new";
    demoLabel.value = sel.label || "";
    demoDesc.value = sel.desc || "";
    demoNo.textContent = steps.length > 1 ? `共 ${steps.length} 段` : "一段演示";
    demoTitle.textContent = steps[0].title;
    demoHint.textContent = steps[0].hint;
    hideDemoButtons();
    demoStartBtn.hidden = false;
    demoStartBtn.disabled = sel.kind === "new" && !demoLabel.value.trim();
    demoStartBtn.textContent = "开始演示";
  }

  demoLabel.addEventListener("input", () => {
    if (sel && sel.kind === "new" && !running) demoStartBtn.disabled = !demoLabel.value.trim();
  });

  async function runDemo() {
    if (running || !sel) return;
    if (sel.kind === "new" && !demoLabel.value.trim()) return;
    running = true;
    cancelled = false;
    window.dshTool.busyDemo = true; // 演示中不让 Esc 关窗口（calib.js 会看这个标记）
    actRunBtn.disabled = true;       // 演示中别再点操作栏（取消请用演示面板里的「取消」）
    actCancelBtn.disabled = true;
    hideDemoButtons();
    demoStartBtn.hidden = true;

    await window.dshTool.ready;
    if (!timer) timer = setInterval(tick, SAMPLE_MS);
    demoCount.hidden = false;
    demoBar.hidden = false;
    demoPeak.hidden = false;

    for (let i = 0; i < steps.length && !cancelled; i++) {
      const st = steps[i];
      demoNo.textContent = steps.length > 1 ? `第 ${i + 1} / ${steps.length} 段` : "演示";
      demoTitle.textContent = st.title;
      demoTag.hidden = st.role !== "pos";
      demoTag.textContent = st.role === "pos" ? "正例" : "负例（不算哈欠）";
      demoProgress.style.width = "0%";
      // 准备
      for (let s = PREP_S; s > 0 && !cancelled; s--) {
        demoHint.textContent = `准备：${s} 秒后开始（先别做动作）`;
        demoCount.textContent = s;
        await sleep(1000);
      }
      if (cancelled) break;
      demoCount.textContent = "开始！";
      demoHint.textContent = st.role === "pos" ? "现在开始做动作！" : "现在按提示做（这不会算成哈欠）";
      await sleep(600);
      if (cancelled) break;
      // 记录
      curSeg = { role: st.role, samples: [] };
      const total = st.seconds * 1000;
      const t0 = Date.now();
      let n = 0;
      while (Date.now() - t0 < total && !cancelled) {
        if (frames.length < 40 && n++ % FRAME_EVERY === 0) {
          const snap = window.dshTool.snap();
          if (snap) frames.push({ t: Date.now(), dataUrl: snap });
        }
        demoCount.textContent = Math.ceil((total - (Date.now() - t0)) / 1000);
        demoProgress.style.width = `${Math.min(100, ((Date.now() - t0) / total) * 100).toFixed(1)}%`;
        await sleep(180);
      }
      if (curSeg.samples.length) segs.push(curSeg);
      curSeg = null;
      demoProgress.style.width = "100%";
      await sleep(300);
    }

    running = false;
    window.dshTool.busyDemo = false;
    actRunBtn.disabled = false;
    actCancelBtn.disabled = false;
    demoCount.hidden = true;
    demoBar.hidden = true;
    demoPeak.hidden = true;
    demoStartBtn.hidden = true;

    if (cancelled) {
      demoNo.textContent = "已取消";
      demoTitle.textContent = "这次的数据没保留";
      demoHint.textContent = "点操作栏的「演示真实动作」可以重来。";
      return;
    }
    await afterDemo();
  }

  async function tick() {
    if (!running || !curSeg) return;
    const g = await window.dshTool.measure();
    if (!g) return;
    curSeg.samples.push({
      t: Date.now(),
      faces: g.faces,
      marOut: typeof g.marOut === "number" ? g.marOut : null,
      marIn: typeof g.marIn === "number" ? g.marIn : null,
      ear: typeof g.ear === "number" ? g.ear : null,
      pitch: typeof g.pitch === "number" ? g.pitch : null,
    });
    updatePeakReadout();
  }

  /** 演示中的实时读数：本段峰值 +（哈欠时）跟负例上限的差距 */
  function updatePeakReadout() {
    const all = segs.flatMap((s) => s.samples).concat(curSeg ? curSeg.samples : []);
    const out = num(all, "marOut");
    const inn = num(all, "marIn");
    const peak = out.length ? out[out.length - 1] : null;
    let line = `本段峰值 外唇 ${f3(peak)}　内唇 ${f3(inn.length ? inn[inn.length - 1] : null)}`;
    if (sel && sel.kind === "yawn" && typeof peak === "number") {
      const neg = negBaseline();
      if (neg != null) {
        const sep = peak - neg;
        line += `　负例上限 ${f3(neg)} → 差 ${sep >= 0 ? "+" : ""}${f3(sep)}`;
      }
    }
    demoPeak.textContent = line;
  }

  const rangeOf = (all, field) => {
    const v = num(all, field);
    if (v.length < 8) return null;
    const lo = q(v, 0.1);
    const hi = q(v, 0.9);
    const pad = Math.max(0.02, (hi - lo) * 0.25);
    return [Number((lo - pad).toFixed(3)), Number((hi + pad).toFixed(3))];
  };

  /** 挑 2 张最"像在做动作"的候选帧：几何量偏离中位最多的那两拍 */
  function pickFrames() {
    if (!frames.length) return [];
    const all = segs.flatMap((s) => s.samples);
    if (all.length < 5) return frames.slice(0, 2);
    const med = (f) => { const v = num(all, f); return v.length ? v[Math.floor(v.length / 2)] : null; };
    const base = { marOut: med("marOut"), marIn: med("marIn"), ear: med("ear"), pitch: med("pitch") };
    const score = (ts) => {
      let best = null;
      let bestDt = Infinity;
      for (const s of all) {
        const dt = Math.abs(s.t - ts);
        if (dt < bestDt) { bestDt = dt; best = s; }
      }
      if (!best) return 0;
      let sc = 0;
      for (const [k, bv] of Object.entries(base)) {
        if (typeof best[k] === "number" && typeof bv === "number") sc += Math.abs(best[k] - bv);
      }
      return sc;
    };
    const ranked = frames.slice().sort((a, b) => score(b.t) - score(a.t));
    const first = ranked[0];
    const second = ranked.find((f) => Math.abs(f.t - first.t) > 800) || ranked[1] || first;
    return [first, second].filter(Boolean);
  }

  /** 演示结束：算结论，等主人点保存 */
  async function afterDemo() {
    const all = segs.flatMap((s) => s.samples);
    const posSamples = segs.filter((s) => s.role === "pos").flatMap((s) => s.samples);
    const negSamples = segs.filter((s) => s.role === "neg").flatMap((s) => s.samples);

    demoNo.textContent = "演示完成";
    demoTag.hidden = true;
    demoAgainBtn.hidden = false;
    demoSaveBtn.hidden = false;
    demoStartBtn.hidden = true;

    // 判定策略由声明决定（teach.strategy）：demo-threshold = 演示定阈值（哈欠走这条），
    // demo-range = 演示取几何区间 + 参考图（自定义动作走这条）
    const t = (sel.decl && sel.decl.teach) || null;
    const strategy = (t && t.strategy) || (sel.kind === "yawn" ? "demo-threshold" : "demo-range");
    if (strategy === "demo-threshold") {
      // 本次采到的负例（有的话）优先；没有就用基线
      const negFresh = num(negSamples, "marOut");
      const negMax = negFresh.length ? negFresh[negFresh.length - 1] : negBaseline();
      const pos = q(num(posSamples, "marOut"), 0.9);
      const v = window.yawnThreshold(pos, negMax);
      demoTitle.textContent = v.ok ? `可以定阈值：${v.thr}` : "这次还分不开";
      demoHint.textContent = (t && t.resultHint) || "以后云端说命中时，本机几何量要过这个阈值才算数。";
      demoInfo.textContent =
        v.reason +
        (negFresh.length ? "" : "（这次没采到负例样本，用的旧基线）") +
        (v.ok ? "" : " → 点「再演示一次」，阈值保持原样不变。");
      demoInfo.className = v.ok ? "saved ok" : "saved warn";
      demoSaveBtn.dataset.mode = "yawn";
      demoSaveBtn.dataset.thr = v.ok ? String(v.thr) : "";
      demoSaveBtn.dataset.neg = negMax == null ? "" : String(negMax);
      demoSaveBtn.dataset.pos = pos == null ? "" : String(pos);
      demoSaveBtn.disabled = !v.ok;
      return;
    }

    // 自定义动作：参考图 + 本机几何区间（要采哪些几何量由声明模板给）
    const gateFields = (decls.__custom && decls.__custom.gate && decls.__custom.gate.fields) || ["marIn", "marOut", "ear", "pitch"];
    const gate = {};
    for (const f of gateFields) {
      const r = rangeOf(all, f);
      if (r) gate[f] = r;
    }
    const refs = pickFrames();
    demoSaveBtn.dataset.mode = "action";
    demoSaveBtn.dataset.samples = String(all.length);
    demoSaveBtn.dataset.gate = Object.keys(gate).length ? JSON.stringify(gate) : "";
    demoSaveBtn.dataset.refs = JSON.stringify(refs.map((f) => f.dataUrl));
    demoFrames.innerHTML = refs.map((f) => `<img src="${f.dataUrl}" title="${fmt(f.t)}" />`).join("");
    const label = (sel.kind === "new" ? demoLabel.value : sel.label || demoLabel.value).trim();
    demoTitle.textContent = `学会了：${label || "（还没起名字）"}`;
    demoHint.textContent = (t && t.resultHint) || "参考图会跟着每次识别发给模型；几何区间用来复核，避免「看起来像」就算。";
    demoInfo.textContent =
      `采集 ${all.length} 个样本　参考图 ${refs.length} 张　` +
      (Object.keys(gate).length ? `本机复核区间：${Object.keys(gate).join(" / ")}` : "没量到几何区间（只靠参考图）");
    demoInfo.className = "saved ok";
    demoSaveBtn.disabled = !label;
  }

  demoSaveBtn.addEventListener("click", async () => {
    demoSaveBtn.disabled = true;
    demoAgainBtn.disabled = true;
    const mode = demoSaveBtn.dataset.mode;
    let payload;
    let line;
    if (mode === "yawn") {
      const thr = Number(demoSaveBtn.dataset.thr);
      const neg = demoSaveBtn.dataset.neg === "" ? null : Number(demoSaveBtn.dataset.neg);
      const pos = demoSaveBtn.dataset.pos === "" ? null : Number(demoSaveBtn.dataset.pos);
      payload = {
        gate: { yawn: { marOutMin: thr, negMax: neg, pos, source: "demo", updatedAt: Date.now() } },
        feedback: { kind: "action", subject: "哈欠", note: `演示教学：阈值 ${thr}（负例上限 ${neg == null ? "-" : f3(neg)}）` },
      };
      line = `哈欠阈值已生效：${thr}（桌宠 5 秒内热加载）。以后说话、托下巴都过不了这道闸。`;
    } else {
      const label = (sel.kind === "new" ? demoLabel.value : sel.label || demoLabel.value).trim();
      const desc = (sel.kind === "new" ? demoDesc.value : sel.desc || demoDesc.value).trim();
      const key = sel.key || nextKey();
      payload = {
        action: {
          key,
          label,
          desc,
          refs: JSON.parse(demoSaveBtn.dataset.refs || "[]"),
          gate: demoSaveBtn.dataset.gate ? JSON.parse(demoSaveBtn.dataset.gate) : null,
          demoSamples: Number(demoSaveBtn.dataset.samples) || 0,
        },
        feedback: { kind: "action", subject: label, note: `演示教学：${demoSaveBtn.dataset.samples} 样本` },
      };
      line = `已学会「${label}」，桌宠 5 秒内生效；以后它会被算进「${label}」的计数里。`;
    }
    const r = await window.dshCalib.learnedSave(payload);
    demoInfo.textContent = r && r.ok ? line : `保存失败：${(r && r.error) || "未知"}`;
    demoInfo.className = r && r.ok ? "saved ok" : "saved bad";
    demoSaveBtn.hidden = true;
    demoAgainBtn.hidden = true;
    hideDemoButtons();
    sel = null;
    actBar.hidden = true;
    markSelected();
    frames = [];
    demoFrames.innerHTML = "";
    await loadRecords();
  });

  function nextKey() {
    const used = (records && records.learned.custom ? records.learned.custom : []).map((c) => c.key);
    let i = 1;
    while (used.includes(`c${i}`)) i += 1;
    return `c${i}`;
  }

  demoStartBtn.addEventListener("click", () => runDemo().catch((e) => console.error("[lab] 演示出错:", e.message)));
  demoAgainBtn.addEventListener("click", () => runDemo().catch((e) => console.error("[lab] 演示出错:", e.message)));
  demoCancelBtn.addEventListener("click", () => {
    if (running) { cancelled = true; return; }
    // 没在演示：收起演示面板，选中还在，可以再点操作栏重来
    demoBox.hidden = true;
    resetDemo();
  });

  loadRecords().catch((e) => {
    fbList.textContent = `读取识别记录失败：${e.message}`;
  });
})();