// renderer/outfit.js —— 换装：装扮定义 + 绘制（纯 SVG，跟着鲸鱼一起动）
//
// 设计取舍：装扮用**内联 SVG**画，不用图片也不用 emoji。原因：
//   ① 鲸鱼本身就是方块 SVG（粗白描边 + 深海蓝），图片/emoji 风格对不上；
//   ② 要能换色，SVG 直接改 fill/stroke 就行，图片做不到；
//   ③ 装扮组挂在 <svg id="whale"> 里，`[data-state=...] .whale { animation: ... }`
//      点头/漂浮/跳跃会自动带着装扮一起动，不用额外接线；
//   ④ 不占磁盘、任意放大不糊。
//
// 立体感怎么来的：**渐变 + 高光 + 纹理**，不用 SVG 滤镜。
//   理由：桌宠是常驻透明窗口、鲸鱼一直在动（bob/nod），滤镜（feGaussianBlur 之类）
//   每次重绘都要重新栅格化，代价高；而线性/径向渐变是合成器原生支持的，几乎免费。
//   所以每件装备都按"圆柱/球体/上亮下暗"给渐变，再补一两笔高光和白点。
//
// 坐标跟 index.html 里的鲸鱼一致：viewBox 0 0 120 120。关键位置备忘：
//   身体 x20~100 y46~78 ｜ 眼睛 左 cx48 cy58 r7、右 cx72 cy59 r6 ｜ 嘴 cx60 cy68
//   侧鳍 x66~86 y80~90 ｜ 背鳍 x50~62 y32~46 ｜ 腮红 左 cx42 cy70、右 cx78 cy69
// 所有图形都用**普通坐标**、不用 transform 属性——拖动时 CSS 会
// `.whale.dragging * { transform: none }`，带 transform 的图形会被掰直。
//
// 槽位（一个槽位同时只穿一件，各画进自己的图层，图层顺序决定遮挡关系）：
//   hat   帽子  → #hatLayer（身体之上、眼睛之下）
//   face  眼镜  → #faceLayer（眼睛/嘴之上）
//   extra 配饰  → #extraLayer（身体之上、帽子之下）
//   hand  手持  → #handLayer（工具之前，画在侧鳍边）
//
// 暴露 window.dshPetOutfit：{ SLOTS, COLORS, DEFAULTS, apply(state), render(),
//                              itemsFor(slot), findItem(slot,id), current }

(function () {
  const DEFAULTS = {
    hat: { id: "none", color: "#1b5299" },
    face: { id: "none", color: "#1f2937" },
    extra: { id: "none", color: "#c0392b" },
    hand: { id: "none", color: "#e08a1e" },
  };

  // ---- 颜色小工具：把主色和黑/白混一混，得到描边用的深色 / 高光 ----
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    let s = m[1];
    if (s.length === 3) s = s.split("").map((c) => c + c).join("");
    return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
  }
  function mix(hex, target, ratio) {
    const a = hexToRgb(hex);
    const b = hexToRgb(target);
    if (!a || !b) return hex;
    const f = (x, y) => Math.round(x + (y - x) * ratio);
    return `rgb(${f(a.r, b.r)}, ${f(a.g, b.g)}, ${f(a.b, b.b)})`;
  }
  const dark = (c) => mix(c, "#0a1f3d", 0.45);   // 压暗 → 帽檐/帽带/纽扣
  const light = (c) => mix(c, "#ffffff", 0.5);   // 提亮 → 高光/镜片
  const pale = (c) => mix(c, "#ffffff", 0.78);   // 很浅 → 镜片反光底

  // ---- 本体配色：只给一个主色，其余按比例派生（跟 pet.css :root 的默认值一致）----
  const BODY_DEFAULT = "#1b5299";
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;
  const normalizeBodyColor = (v) => (typeof v === "string" && HEX_RE.test(v) ? v : BODY_DEFAULT);

  /**
   * 由主色派生出一整组本体变量。
   * 为什么不开放每一项：肚皮要"提亮但不发灰"、墨色要"够深还能看出色相"，
   * 让主人逐个调很容易配丑；派生既保证好看，也让鲸鱼整体保持同一套明暗关系。
   */
  function bodyVars(color) {
    const c = normalizeBodyColor(color);
    return {
      "--whale-body": c,
      "--whale-hi": mix(c, "#ffffff", 0.3),     // 受光面（渐变上端）
      "--whale-mid": c,                          // 主色（渐变中段）
      "--whale-lo": mix(c, "#0a1f3d", 0.3),      // 背光面（渐变下端）
      "--whale-belly": mix(c, "#ffffff", 0.66),  // 肚皮
      "--whale-blush": mix("#ffb3c6", c, 0.18),  // 腮红（暖粉微调向主色）
      "--whale-ink": mix(c, "#0a1f3d", 0.85),    // 墨色：眼睛/嘴/描边
    };
  }

  /** 把主色写进 CSS 变量（挂在 <html> 上，pet.css 的规则自动跟着变） */
  function applyBodyColor(color) {
    const vars = bodyVars(color);
    const el = document.documentElement;
    for (const k of Object.keys(vars)) el.style.setProperty(k, vars[k]);
  }

  // ---- 渐变工具：id 用 `${uid}-${suffix}`，不同槽位/装扮之间不会撞名 ----
  const lgrad = (id, stops, dir) => {
    const x2 = dir === "h" ? 1 : 0;
    const y2 = dir === "v" ? 1 : 0;
    return `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">` +
      stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("") + `</linearGradient>`;
  };
  const rgrad = (id, stops, cx, cy, r) =>
    `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">` +
    stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("") + `</radialGradient>`;
  const defs = (inner) => `<defs>${inner}</defs>`;
  const u = (id) => `url(#${id})`;
  // 圆柱体：左右压暗、中间提亮（帽子立面、杯子、耳罩都用它）
  const cyl = (id, c) => lgrad(id, [["0", dark(c)], ["0.42", light(c)], ["1", dark(c)]], "h");
  // 上亮下暗：球体/圆顶/布料（比纯色多一层体积感）
  const drop = (id, c) => lgrad(id, [["0", light(c)], ["0.55", c], ["1", dark(c)]], "v");

  // ---- 画图形的小帮手（描边宽度/圆角统一交给 pet.css 的类）----
  const F = (d, color, cls) => `<path d="${d}" fill="${color}" class="${cls || "gear-fill"}"/>`;
  const R = (x, y, w, h, r, color, cls) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${color}" class="${cls || "gear-fill"}"/>`;
  const E = (cx, cy, rx, ry, color, cls) =>
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${color}" class="${cls || "gear-fill"}"/>`;
  const C = (cx, cy, r, color, cls) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" class="${cls || "gear-fill"}"/>`;
  // 只描边不填充（眼镜框、耳机头梁、气球线…）；color 可以是 url(#grad)
  const L = (x1, y1, x2, y2, color, w) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w || 3}" class="gear-line"/>`;
  const P = (d, color, w) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w || 3}" class="gear-line"/>`;
  // 高光（无白描边、半透明）：亮点/反光条
  const EH = (cx, cy, rx, ry, color, op) =>
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${color}" opacity="${op == null ? 0.55 : op}"/>`;
  const CH = (cx, cy, r, color, op) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${op == null ? 0.6 : op}"/>`;
  const FH = (d, color, op) => `<path d="${d}" fill="${color}" opacity="${op == null ? 0.4 : op}"/>`;
  // 四角星闪光（巫师帽的星星、宝石光泽）
  const sparkle = (cx, cy, r, color, op) =>
    `<path d="M${cx} ${cy - r} Q${cx + r * 0.26} ${cy - r * 0.26} ${cx + r} ${cy} Q${cx + r * 0.26} ${cy + r * 0.26} ${cx} ${cy + r} Q${cx - r * 0.26} ${cy + r * 0.26} ${cx - r} ${cy} Q${cx - r * 0.26} ${cy - r * 0.26} ${cx} ${cy - r} Z" fill="${color}" opacity="${op == null ? 1 : op}"/>`;

  const NONE = { id: "none", label: "不戴", emoji: "🚫", draw: () => "" };

  /**
   * 槽位清单。想加新装扮：往对应 items 里加一条即可
   * （换装菜单和设置页都会自动出现）。
   * draw(color, uid) 返回 SVG 片段；uid 是本件装扮的唯一前缀，用来给渐变起名。
   */
  const SLOTS = [
    {
      key: "hat", label: "帽子", emoji: "🎩", layer: "hatLayer",
      items: [
        NONE,
        {
          id: "tophat", label: "礼帽", emoji: "🎩",
          draw: (c, uid) => {
            const cr = uid + "-cr", br = uid + "-br", bd = uid + "-bd";
            return defs(cyl(cr, c) + drop(br, c) + lgrad(bd, [["0", mix(c, "#0a1f3d", 0.55)], ["1", mix(c, "#0a1f3d", 0.75)]], "v")) +
              E(60, 48, 27, 5.5, u(br)) +               // 帽檐
              E(60, 47.2, 27, 3.4, light(c), "hat-accent") + // 檐口高光
              R(44, 12, 32, 36, 3, u(cr)) +             // 帽筒（圆柱渐变）
              E(60, 14, 15.5, 3.4, light(c)) +          // 筒顶
              R(44, 36, 32, 7, 1, u(bd), "hat-accent") + // 帽带
              R(45.4, 37.1, 29.2, 1.5, 0.8, light(c), "hat-accent"); // 帽带高光
          },
        },
        {
          id: "beanie", label: "毛线帽", emoji: "🧶",
          draw: (c, uid) => {
            const dm = uid + "-dm", cf = uid + "-cf", pm = uid + "-pm";
            return defs(drop(dm, c) + lgrad(cf, [["0", light(c)], ["1", c]], "v") +
              rgrad(pm, [["0", light(c)], ["1", c]], 0.35, 0.3, 0.85)) +
              F("M36 48 Q36 18 60 18 Q84 18 84 48 Z", u(dm)) +
              // 罗纹：几道细竖线，低透明度，远看是针织质感
              P("M44 21 Q40 30 40 47", light(c), 1.3) + P("M52 18.6 Q49 28 49 47", light(c), 1.3) +
              P("M60 18 L60 47", light(c), 1.3) + P("M68 18.6 Q71 28 71 47", light(c), 1.3) +
              P("M76 21 Q80 30 80 47", light(c), 1.3) +
              R(35, 42, 50, 10, 4, u(cf), "hat-accent") +   // 翻边
              R(36.5, 43.3, 47, 1.8, 0.9, light(c), "hat-accent") + // 翻边高光
              C(60, 16, 6, u(pm), "hat-accent") + CH(58, 14, 2, "#ffffff", 0.5);
          },
        },
        {
          id: "cap", label: "鸭舌帽", emoji: "🧢",
          draw: (c, uid) => {
            const dm = uid + "-dm", vs = uid + "-vs";
            return defs(drop(dm, c) + cyl(vs, c)) +
              F("M38 47 Q38 24 61 24 Q82 24 82 45 Z", u(dm)) +
              P("M61 24 L61 45", dark(c), 1.3) +            // 前片接缝
              E(72, 47, 26, 4.5, u(vs), "hat-accent") +     // 帽舌
              E(72, 46.4, 24, 2.2, light(c), "hat-accent") + // 帽舌高光
              C(60, 24, 2.8, dark(c), "hat-accent") + CH(59.2, 23.3, 1, "#ffffff", 0.6);
          },
        },
        {
          id: "straw", label: "草帽", emoji: "👒",
          draw: (c, uid) => {
            const br = uid + "-br", cw = uid + "-cw", rb = uid + "-rb";
            return defs(lgrad(br, [["0", light(c)], ["0.45", c], ["1", dark(c)]], "v") +
              drop(cw, c) + lgrad(rb, [["0", dark(c)], ["0.5", mix(c, "#a3401f", 0.45)], ["1", dark(c)]], "v")) +
              E(60, 48, 33, 6, u(br)) +
              // 草编纹：同心椭圆
              `<ellipse cx="60" cy="48" rx="26" ry="4.4" fill="none" stroke="${dark(c)}" stroke-width="1" opacity="0.45"/>` +
              `<ellipse cx="60" cy="48" rx="18" ry="3" fill="none" stroke="${dark(c)}" stroke-width="1" opacity="0.38"/>` +
              F("M44 48 Q44 30 60 30 Q76 30 76 48 Z", u(cw)) +  // 帽冠
              R(44, 42, 32, 5, 1, u(rb), "hat-accent") +        // 丝带
              C(60, 44.5, 2.2, dark(c), "hat-accent") + CH(59.3, 43.8, 1, "#ffffff", 0.55); // 丝带小结
          },
        },
        {
          id: "crown", label: "皇冠", emoji: "👑",
          draw: (c, uid) => {
            const gd = uid + "-gd", bs = uid + "-bs";
            // 宝石固定用红/蓝/绿——金色 + 三色宝石才像皇冠，比单色更有贵气
            return defs(lgrad(gd, [["0", light(c)], ["0.5", c], ["1", dark(c)]], "v") +
              lgrad(bs, [["0", light(c)], ["0.6", c], ["1", dark(c)]], "v")) +
              F("M41 38 L48 26 L55 36 L60 22 L65 36 L72 26 L79 38 Z", u(gd)) + // 尖齿
              R(41, 38, 38, 10, 2, u(bs)) +                                     // 帽箍
              C(60, 43, 3.2, "#e84393", "hat-accent") + CH(59, 42, 1.2, "#ffffff", 0.75) +
              C(48, 43, 2.4, "#3aa7e0", "hat-accent") + CH(47.3, 42.3, 0.9, "#ffffff", 0.7) +
              C(72, 43, 2.4, "#2e9e5b", "hat-accent") + CH(71.3, 42.3, 0.9, "#ffffff", 0.7) +
              sparkle(60, 22, 2.2, "#fff6c9", 0.95);                            // 顶尖小星
          },
        },
        {
          id: "party", label: "派对帽", emoji: "🎉",
          draw: (c, uid) => {
            const kn = uid + "-kn";
            // 锥面上的斜条纹：按锥体宽度算好梯形，才贴得住
            return defs(drop(kn, c)) +
              F("M60 10 L44 48 L76 48 Z", u(kn)) +
              FH("M54 24 L66 24 L68.4 30 L51.6 30 Z", light(c), 0.55) +
              FH("M49.9 34 L70.1 34 L72.6 40 L47.4 40 Z", light(c), 0.45) +
              F("M44 48 L76 48 L74.5 44.5 L45.5 44.5 Z", dark(c), "hat-accent") + // 帽檐圈
              C(60, 10, 5, light(c), "hat-accent") + CH(58.4, 8.6, 1.7, "#ffffff", 0.7);
          },
        },
        {
          id: "wizard", label: "巫师帽", emoji: "🪄",
          draw: (c, uid) => {
            const br = uid + "-br", cn = uid + "-cn", bd = uid + "-bd";
            return defs(drop(br, c) + cyl(cn, c) + lgrad(bd, [["0", light(c)], ["1", dark(c)]], "v")) +
              E(60, 48, 28, 5.5, u(br)) +
              E(60, 47.2, 28, 3.3, light(c), "hat-accent") +
              F("M46 48 L60 8 L74 48 Z", u(cn)) +       // 尖筒
              R(47, 40, 26, 6, 1, u(bd), "hat-accent") + // 星带
              sparkle(70, 30, 2.4, light(c), 0.95) + sparkle(52, 26, 1.8, light(c), 0.85) +
              sparkle(65, 41, 1.6, "#fff6c9", 0.9);
          },
        },
      ],
    },

    {
      key: "face", label: "眼镜", emoji: "👓", layer: "faceLayer",
      items: [
        NONE,
        {
          // 圆框眼镜：两个圈正好套在眼睛上 + 鼻梁 + 镜腿 + 镜片淡色反光
          id: "glasses", label: "圆框眼镜", emoji: "👓",
          draw: (c, uid) => {
            const ls = uid + "-ls";
            return defs(rgrad(ls, [["0", pale(c)], ["1", c]], 0.42, 0.34, 0.75)) +
              // 镜片（淡色，能透出眼睛）
              `<circle cx="48" cy="58" r="9.4" fill="${u(ls)}" opacity="0.22"/>` +
              `<circle cx="72" cy="59" r="8.4" fill="${u(ls)}" opacity="0.22"/>` +
              // 镜框
              `<circle cx="48" cy="58" r="10" fill="none" stroke="${c}" stroke-width="3" class="gear-line"/>` +
              `<circle cx="72" cy="59" r="9" fill="none" stroke="${c}" stroke-width="3" class="gear-line"/>` +
              // 框上缘高光 + 镜片斜反光
              P("M41.5 51 A10 10 0 0 1 50 48.6", light(c), 1.6) +
              P("M66.5 52.4 A9 9 0 0 1 74.6 50.2", light(c), 1.6) +
              `<path d="M43.4 56.6 L47.4 52.2" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>` +
              `<path d="M67.4 57.6 L71.4 53.2" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" opacity="0.6"/>` +
              L(58, 58, 63, 59, c) + L(38, 56, 28, 54, c) + L(81, 59, 92, 58, c);
          },
        },
        {
          // 墨镜：深色镜片带渐变 + 镜面斜光
          id: "sunglasses", label: "墨镜", emoji: "🕶",
          draw: (c, uid) => {
            const l1 = uid + "-l1", l2 = uid + "-l2";
            return defs(lgrad(l1, [["0", mix(c, "#ffffff", 0.35)], ["0.4", c], ["1", dark(c)]], "v") +
              lgrad(l2, [["0", mix(c, "#ffffff", 0.3)], ["0.4", c], ["1", dark(c)]], "v")) +
              R(39, 51, 18, 14, 4, u(l1)) + R(63, 52, 17, 13, 4, u(l2)) +
              FH("M43 62 L50 52.6 L53.4 52.6 L45.4 62 Z", "#ffffff", 0.3) +
              FH("M67 63 L73 54.6 L75.4 54.6 L69.4 63 Z", "#ffffff", 0.24) +
              R(55, 56, 10, 3.5, 1.5, dark(c)) +
              L(39, 57, 28, 55, dark(c), 2.2) + L(80, 58, 92, 57, dark(c), 2.2); // 镜腿
          },
        },
        {
          // 口罩：布面渐变 + 褶子 + 鼻梁压条 + 挂耳绳
          id: "mask", label: "口罩", emoji: "😷",
          draw: (c, uid) => {
            const fb = uid + "-fb";
            return defs(lgrad(fb, [["0", "#ffffff"], ["0.5", light(c)], ["1", c]], "v")) +
              `<rect x="45" y="62" width="30" height="13" rx="5" fill="${u(fb)}" stroke="${c}" stroke-width="2.6" class="gear-fill"/>` +
              P("M47 66 Q60 67.6 73 66", c, 1.1) +
              P("M47 70 Q60 71.6 73 70", c, 1.1) +
              P("M52 62.6 Q60 61.3 68 62.6", dark(c), 1.6) +
              L(45, 66, 34, 62, c, 2.4) + L(75, 66, 86, 62, c, 2.4);
          },
        },
      ],
    },

    {
      key: "extra", label: "配饰", emoji: "🎀", layer: "extraLayer",
      items: [
        NONE,
        {
          // 耳机：头梁跨过头顶 + 两侧耳罩（耳罩往里收，别压到尾鳍）
          id: "headphones", label: "耳机", emoji: "🎧",
          draw: (c, uid) => {
            const cp = uid + "-cp", pd = uid + "-pd", bn = uid + "-bn";
            return defs(drop(cp, c) + lgrad(pd, [["0", mix(c, "#0a1f3d", 0.7)], ["1", mix(c, "#0a1f3d", 0.4)]], "v") +
              lgrad(bn, [["0", light(c)], ["1", dark(c)]], "h")) +
              P("M36 54 Q60 30 84 54", u(bn), 5) +      // 头梁
              P("M38 54 Q60 33 82 54", light(c), 1.5) + // 头梁高光
              R(29, 49, 13, 18, 6, u(cp)) + R(78, 49, 13, 18, 6, u(cp)) +  // 耳罩外壳
              R(32, 53, 8, 11, 3.5, u(pd), "hat-accent") + R(80, 53, 8, 11, 3.5, u(pd), "hat-accent") + // 耳垫
              R(30.4, 50.6, 3, 5, 1.5, light(c), "hat-accent") + R(79.4, 50.6, 3, 5, 1.5, light(c), "hat-accent"); // 高光
          },
        },
        {
          // 蝴蝶结：两翼渐变 + 结心 + 翼上折光
          id: "bowtie", label: "蝴蝶结", emoji: "🎀",
          draw: (c, uid) => {
            const wg = uid + "-wg", kt = uid + "-kt";
            return defs(drop(wg, c) + lgrad(kt, [["0", c], ["1", mix(c, "#0a1f3d", 0.6)]], "v")) +
              F("M48 69 L60 75 L48 81 Z", u(wg)) + F("M72 69 L60 75 L72 81 Z", u(wg)) +
              FH("M50 71.4 L57.6 74.6 L50 77.6 Z", light(c), 0.45) +
              FH("M70 71.4 L62.4 74.6 L70 77.6 Z", light(c), 0.45) +
              R(56.4, 71.4, 7.2, 7.2, 2.4, u(kt), "hat-accent") + CH(58.6, 73.6, 1.2, "#ffffff", 0.45);
          },
        },
        {
          // 小花：五瓣径向渐变 + 花心 + 露珠
          id: "flower", label: "小花", emoji: "🌸",
          draw: (c, uid) => {
            const pt = uid + "-pt", ct = uid + "-ct";
            const petals = [0, 72, 144, 216, 288]
              .map((a) => {
                const rad = (a * Math.PI) / 180;
                return E(88 + Math.cos(rad) * 5.4, 62 + Math.sin(rad) * 5.4, 3.6, 3.6, u(pt), "hat-accent");
              })
              .join("");
            return defs(rgrad(pt, [["0", pale(c)], ["1", c]], 0.4, 0.35, 0.8) +
              rgrad(ct, [["0", "#fff6c9"], ["1", "#e0a82e"]], 0.35, 0.35, 0.85)) +
              petals + C(88, 62, 3, u(ct), "hat-accent") + CH(87, 61, 1.1, "#ffffff", 0.6);
          },
        },
      ],
    },

    {
      key: "hand", label: "手持", emoji: "🎈", layer: "handLayer",
      items: [
        NONE,
        {
          // 气球：径向高光（左上受光）+ 绳 + 结
          id: "balloon", label: "气球", emoji: "🎈",
          draw: (c, uid) => {
            const bl = uid + "-bl";
            return defs(rgrad(bl, [["0", light(c)], ["0.5", c], ["1", dark(c)]], 0.34, 0.26, 0.85)) +
              P("M93 78 Q97 62 96 54", dark(c), 2.2) +
              E(96, 42, 11, 13, u(bl)) +
              EH(92.4, 37, 2.8, 4.4, "#ffffff", 0.5) +
              F("M96 55 L92.5 61 L99.5 61 Z", dark(c), "hat-accent");
          },
        },
        {
          // 咖啡杯：上宽下窄的外带纸杯 + 杯套 + 杯盖（别做成等宽的"叠盘"）
          id: "coffee", label: "咖啡杯", emoji: "☕",
          draw: (c, uid) => {
            const bd = uid + "-bd", ld = uid + "-ld", sl = uid + "-sl";
            return defs(cyl(bd, c) + drop(ld, c) + lgrad(sl, [["0", light(c)], ["1", dark(c)]], "v")) +
              // 杯身：梯形，底比口窄
              F("M88 71 L104 71 L101.6 88.4 Q101.3 89 100.5 89 L91.5 89 Q90.7 89 90.4 88.4 Z", u(bd)) +
              // 杯套（略窄一圈）
              F("M89.3 77 L102.7 77 L102 82.4 L90 82.4 Z", u(sl), "hat-accent") +
              // 杯盖
              R(86.6, 67.4, 18.8, 4.2, 2, u(ld), "hat-accent") +
              R(89.6, 64.6, 12.8, 3.2, 1.5, u(ld), "hat-accent");
          },
        },
        {
          // 手机：金属边渐变 + 深色屏 + 斜反光 + 刘海/home 条
          id: "phone", label: "手机", emoji: "📱",
          draw: (c, uid) => {
            const bd = uid + "-bd", sc = uid + "-sc";
            return defs(cyl(bd, c) + lgrad(sc, [["0", "#0a1f3d"], ["1", "#12395f"]], "v")) +
              R(88, 64, 16, 25, 4, u(bd)) +
              R(90, 67, 12, 18, 2, u(sc)) +
              FH("M92 82 L99 70 L101 70 L94 82 Z", "#7fb4ff", 0.22) +
              R(94, 68.4, 4, 1.6, 0.8, dark(c)) +
              R(93, 86, 6, 1.4, 0.7, "#7fb4ff");
          },
        },
        {
          // 小旗：金属杆 + 波浪布面 + 高光
          id: "flag", label: "小旗", emoji: "🚩",
          draw: (c, uid) => {
            const pl = uid + "-pl", cl = uid + "-cl";
            return defs(cyl(pl, "#c9d4e2") + drop(cl, c)) +
              R(89.5, 54, 3, 32, 1.5, u(pl)) +
              C(91, 53, 2.2, "#e8eef7", "hat-accent") + CH(90.3, 52.2, 0.9, "#ffffff", 0.7) +
              F("M93 57 Q102 58.6 112 62 Q102 65.4 93 69 Z", u(cl)) +
              FH("M94.4 59.2 Q102 60.6 108.6 63.2 Q102 64.6 94.4 66.6 Z", "#ffffff", 0.26);
          },
        },
      ],
    },
  ];

  // 换装配色：主色候选（点一下整个装扮换色）
  const COLORS = [
    "#1b5299", "#2f4f7f", "#c0392b", "#e08a1e", "#2e9e5b",
    "#8e44ad", "#e84393", "#6b7280", "#1f2937", "#d4af37",
  ];

  const slotOf = (key) => SLOTS.find((s) => s.key === key);
  function itemsFor(slotKey) {
    const s = slotOf(slotKey);
    return s ? s.items : [];
  }
  function findItem(slotKey, id) {
    const items = itemsFor(slotKey);
    return items.find((it) => it.id === id) || items[0];
  }

  let current = JSON.parse(JSON.stringify(DEFAULTS));

  /** 把当前装扮逐槽位画进各自图层（图层不存在就静默跳过，设置窗口里没有鲸鱼） */
  function render() {
    for (const s of SLOTS) {
      const layer = document.getElementById(s.layer);
      if (!layer) continue;
      const it = findItem(s.key, (current[s.key] || {}).id);
      if (!it || it.id === "none") {
        layer.innerHTML = "";
        continue;
      }
      const color = (current[s.key] || {}).color || DEFAULTS[s.key].color;
      // uid 带槽位前缀：4 个图层在同一个 SVG 里，渐变 id 不能撞名
      layer.innerHTML = it.draw(color, "og-" + s.key + "-" + it.id);
    }
  }

  /** 应用一份装扮（来自主进程或本地即时预览）并立即重画 */
  function apply(state) {
    const s = state && typeof state === "object" ? state : {};
    const next = { bodyColor: normalizeBodyColor(s.bodyColor) };
    for (const slot of SLOTS) {
      const d = DEFAULTS[slot.key];
      const v = s[slot.key];
      next[slot.key] = {
        id: v && typeof v.id === "string" && v.id ? v.id : d.id,
        color: v && typeof v.color === "string" && v.color ? v.color : d.color,
      };
    }
    current = next;
    applyBodyColor(current.bodyColor);
    render();
    return JSON.parse(JSON.stringify(current));
  }

  window.dshPetOutfit = {
    SLOTS,
    COLORS,
    DEFAULTS,
    BODY_DEFAULT,
    apply,
    render,
    bodyVars,
    itemsFor,
    findItem,
    get current() { return JSON.parse(JSON.stringify(current)); },
  };
})();