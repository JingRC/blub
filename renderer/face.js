// renderer/face.js — 本地人脸识别（认主 / 在场判定）
//
// 为什么从云端换成本地：免费视觉模型判身份不可靠——它会把"主人参考照"当成答案点头，
// 相似度能吐出 9 这种越界值，线上表现就是"人明明不在镜头里也认成主人"，锁屏跟着形同虚设。
// 这里改成数学比对：@vladmandic/human 在本机做「人脸检测 + 1024 维特征」，
// 与认主时存下的特征算相似度；画面里 0 张脸就是 noFace，不靠模型"猜"。
// 全程离线、零 API 费用、不会 429，同样的输入给同样的分数。
//
// 模型文件随 npm 包放在 node_modules/@vladmandic/human/models，但渲染层是 file:// 页面，
// 浏览器不允许 fetch 本地文件，所以这里把 fetch 拦下来（只拦模型 URL）交给主进程读盘。
//
// 对上层只暴露三件事：identify（判身份）/ describe（取特征）/ refresh（认主后重算）。

(function () {
  // 模型走一个"假域名"：tfjs 的模型加载器只认 http/https/indexeddb 这几种 scheme，
  // 自定义 scheme 它直接找不到 IO handler（会静默卡住）。这个域名不会真的联网——
  // 下面的 fetch 拦截会把请求交给主进程读本地文件，一个字节都不会出去。
  const MODEL_BASE = "https://petface.local/models/";
  const MODEL_NAME = /^[\w.-]+$/; // 只允许纯文件名（主进程还会再校验一次目录）
  // 0.55 是相似度门槛（human 的 0~1 归一化相似度，>0.5 即"像同一个人"）
  const THRESHOLD = 0.55;
  const DETECT_SCALE = 1.0; // 检测输入缩放（本应用禁了 GPU，渲染层 WebGL 是软件实现，小一点快很多）
  // 人脸质量门槛：杂物（椅背、显示器边框、海报）被误检成"脸"时通常分数低、框也小，
  // 而那种垃圾框算出来的特征有可能恰好落在主人附近——判身份前先把这种候选扔掉。
  const MIN_FACE_SCORE = 0.5; // 检测置信度下限
  const MIN_FACE_WIDTH = 0.1; // 人脸框宽度至少占画面 10%（坐桌前的人远大于此）

  let initPromise = null;
  let lib = null; // human 实例
  let refs = []; // 主人的特征向量（最多 3 条，对应 3 张参考照）
  let shimmed = false;
  let meshWarned = false; // "没有 mesh 关键点"只提示一次，别刷屏
  const state = { ready: false, error: null, refs: 0, backend: "" };

  function log(line) {
    console.log(`[face] ${line}`);
  }

  /**
   * 上报一条人脸实测样本给主进程落盘（认主自适应用，见开发记录"认主自适应"一节）。
   * 纯旁路：不参与任何判定，失败也不影响识别——攒数据而已。
   */
  function reportSample(s) {
    try {
      if (window.dshPet && window.dshPet.faceSample) window.dshPet.faceSample(s);
    } catch {}
  }

  /** 只拦模型 URL，其它请求原样转发（渲染层平时不发请求，拦错了也不至于静默失败） */
  function installFetchShim() {
    if (shimmed) return;
    shimmed = true;
    const orig = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith(MODEL_BASE)) {
        const name = u.slice(MODEL_BASE.length).split(/[?#]/)[0];
        if (!MODEL_NAME.test(name)) throw new Error(`bad model name: ${name}`);
        const bytes = await window.dshPet.faceModelBytes(name);
        if (!bytes || !bytes.byteLength) throw new Error(`model missing: ${name}`);
        return new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": name.endsWith(".json")
              ? "application/json"
              : "application/octet-stream",
          },
        });
      }
      if (!orig) throw new Error("fetch unavailable");
      return orig(url, init);
    };
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        if (!window.Human || !window.Human.Human) throw new Error("human 库没加载（index.html 缺 script 标签）");
        if (!window.dshPet || !window.dshPet.faceModelBytes) throw new Error("桥未就绪");
        installFetchShim();
        lib = new window.Human.Human({
          modelBasePath: MODEL_BASE,
          // 本应用禁了 GPU（main.js 里 disable-gpu），渲染层没有 WebGL，只能走 wasm；
          // wasm 二进制也要走我们的桥（file:// 页面读不了本地文件），所以显式给路径 +
          // 让 tfjs 用平台 fetch 去取，而不是让 emscripten 自己按相对路径找。
          backend: "wasm",
          wasmPath: MODEL_BASE,
          wasmPlatformFetch: true,
          cacheModels: true,
          // 不做预热：human 的 warmup 会拿内置样例图跑一遍推理，在 wasm 后端上会卡住；
          // 代价只是第一次探测多花百来毫秒，不值得为它冒风险。
          warmup: "none",
          debug: false,
          filter: { enabled: false },
          face: {
            enabled: true,
            detector: {
              maxDetected: 3,
              minConfidence: 0.3,
              iouThreshold: 0.3,
              return: false,
              scale: DETECT_SCALE,
            },
            mesh: { enabled: true },
            description: { enabled: true },
            iris: { enabled: false },
            emotion: { enabled: false },
            antispoof: { enabled: false },
            liveness: { enabled: false },
          },
          body: { enabled: false },
          hand: { enabled: false },
          object: { enabled: false },
          gesture: { enabled: false },
          segmentation: { enabled: false },
        });
        // tfjs 内部还缓存着一份 platform.fetch（在我们替换全局 fetch 之前就抓好的），
        // 加载 wasm 二进制走的是那一份，不换掉它会真的去解析这个假域名然后卡死。
        try {
          lib.tf.env().platform.fetch = window.fetch;
        } catch (err) {
          log(`platform.fetch 替换失败（wasm 可能加载不了）：${err.message}`);
        }
        await lib.load();
        await lib.warmup();
        try { state.backend = lib.tf.getBackend(); } catch {}
        state.ready = true;
        log(`模型就绪（backend=${state.backend}）`);
        await syncRefs();
      } catch (err) {
        state.ready = false;
        state.error = err.message;
        log(`初始化失败：${err.message} → 身份判定回退云端模型`);
      }
      reportReady();
      return state.ready;
    })();
    return initPromise;
  }

  function reportReady() {
    try {
      window.dshPet.faceReady({
        ready: state.ready,
        refs: refs.length,
        backend: state.backend,
        error: state.error,
      });
    } catch {}
  }

  function area(box) {
    // human 的 Box 是 [x, y, 宽, 高]（不是左上右下两个角），别当成角坐标去减
    return Math.max(0, box[2]) * Math.max(0, box[3]);
  }

  /** 画面里可能有好几个人，取最大的那张脸（近的那个人就是"在用电脑的人"） */
  function biggest(faces) {
    if (!faces || !faces.length) return null;
    return faces.slice().sort((a, b) => area(b.box) - area(a.box))[0];
  }

  function frameWidthOf(input) {
    return Number(input && (input.videoWidth || input.naturalWidth || input.width)) || 0;
  }

  /**
   * 从检测结果里挑出"合格的人脸"：分数够高、框够大。
   * 传 width 时会连尺寸一起卡（实时画面用）；参考照是裁剪过的人脸特写，只卡分数。
   */
  function usableFaces(faces, width) {
    return (faces || []).filter((f) => {
      if (!f || !f.box) return false;
      if ((f.score || 0) < MIN_FACE_SCORE) return false;
      if (!width) return true;
      return f.box[2] >= width * MIN_FACE_WIDTH; // Box[2] 就是人脸的宽（像素）
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("参考照载入失败"));
      img.src = src;
    });
  }

  /** 对一张图取人脸特征；图里没有脸就返回 null（调用前必须已确保模型加载完） */
  async function descriptorOf(input) {
    const res = await lib.detect(input);
    // 参考照是裁剪过的人脸特写，只卡检测分，不卡尺寸
    const face = biggest(usableFaces(res.face, 0));
    return face && face.embedding && face.embedding.length ? face.embedding : null;
  }

  /** 对外的取特征：先确保模型就绪 */
  async function describe(input) {
    if (!(await init())) return null;
    return descriptorOf(input);
  }

  // ---- 哈欠几何量（MAR / EAR）-------------------------------------------------
  //
  // 为什么要它：单帧"张嘴"分不出说话还是打哈欠。业界通行做法是算两个尺度无关的比值，
  // 再看时间曲线——真哈欠的 MAR 会缓慢升到峰值并维持 2 秒以上，说话只是快速小幅张合。
  //   嘴部纵横比 MAR = 上下唇距离 / 嘴角宽度：闭嘴约 0.2~0.4，说话/吃饭 0.5~0.6，
  //     真哈欠常 >0.7（具体阈值必须按自己的摄像头实测，不能照抄）
  //   眼睛纵横比 EAR：睁眼约 0.32，闭眼 0.15~0.18；打哈欠常伴眯眼
  // 现在的用途：渲染层每秒量一次，主进程拿"抓帧那一刻"的外唇 MAR 给云端的哈欠结论过闸
  // （张嘴≠哈欠：说话、手托下巴把嘴顶开也会张嘴，见 emotion.js 的 _gateYawn）。
  // 关键点编号用 MediaPipe FaceMesh 拓扑（@vladmandic/human 的 mesh 就是这套）。
  const LM = {
    mLeft: 61, mRight: 291, lipUp: 13, lipDown: 14,
    lipTop: 0, lipBottom: 17,
    eyeRUp: 159, eyeRDown: 145, eyeRIn: 33, eyeROut: 133,
    eyeLUp: 386, eyeLDown: 374, eyeLIn: 362, eyeLOut: 263,
  };
  const toPx = (p, w, h) => [p[0] * w, p[1] * h]; // 归一化 → 像素，消掉画面长宽比失真
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  /** 从一张人脸的 mesh 关键点算 MAR / EAR / 头俯仰；没有关键点返回 null */
  function geometryOf(face, w, h) {
    const m = face && face.mesh;
    if (!m || !m[LM.lipUp] || !m[LM.lipDown] || !m[LM.mLeft] || !m[LM.mRight]) return null;
    const g = (i) => toPx(m[i], w, h);
    const mouthW = dist(g(LM.mLeft), g(LM.mRight)) || 1;
    // 内唇口径：闭嘴时上下内唇相触，基线≈0（实测 0.03~0.05），动态范围大
    const marIn = dist(g(LM.lipUp), g(LM.lipDown)) / mouthW;
    // 外唇口径：跟文献里那套阈值（闭嘴 0.2~0.4 / 说话 0.5~0.6 / 哈欠 >0.7）同口径，
    // 方便对着参考值判读（嘴唇本身有厚度，所以闭嘴时不是 0）
    const marOut = m[LM.lipTop] && m[LM.lipBottom]
      ? dist(g(LM.lipTop), g(LM.lipBottom)) / mouthW
      : null;
    const earR = dist(g(LM.eyeRUp), g(LM.eyeRDown)) / (dist(g(LM.eyeRIn), g(LM.eyeROut)) || 1);
    const earL = dist(g(LM.eyeLUp), g(LM.eyeLDown)) / (dist(g(LM.eyeLIn), g(LM.eyeLOut)) || 1);
    let pitch = null;
    try {
      pitch = face.rotation && face.rotation.angle ? Number(face.rotation.angle.pitch) : null;
    } catch {}
    return {
      marIn: +marIn.toFixed(3),
      marOut: marOut == null ? null : +marOut.toFixed(3),
      ear: +((earR + earL) / 2).toFixed(3),
      pitch,
    };
  }

  /** human 实例不是并发安全的：所有 detect 调用排成一条队列 */
  let libQueue = Promise.resolve();
  function withLib(fn) {
    const p = libQueue.then(fn, fn);
    libQueue = p.then(() => {}, () => {});
    return p;
  }

  /**
   * 只算几何量、不上报身份、不触发任何判定（渲染层的 1 秒测量循环用，
   * 量出来的 MAR 会随帧送给主进程做哈欠"过闸"）。
   * @returns {Promise<{faces:number, marIn?:number, marOut?:number|null, ear?:number, pitch?:number|null}|null>}
   */
  async function metrics(input) {
    if (!(await init())) return null;
    return withLib(async () => {
      const w = frameWidthOf(input);
      const h = Number(input.videoHeight || input.naturalHeight || input.height) || 0;
      const res = await lib.detect(input);
      const face = biggest(usableFaces(res.face, w));
      if (!face) return { faces: 0 };
      const geo = geometryOf(face, w, h);
      return geo ? { faces: 1, ...geo } : { faces: 1 };
    });
  }

  /**
   * 同步主人特征：老用户只有 3 张参考照、没有特征，这里就地补算并存回主进程，
   * 所以换成本地识别不需要重新认主。
   */
  async function syncRefs() {
    const info = await window.dshPet.faceRefs();
    if (!info) return;
    const saved = (info.descriptors || []).filter(
      (d) => Array.isArray(d) && d.length === 1024,
    );
    const photos = info.refs || [];
    refs = saved;
    if (photos.length && saved.length !== photos.length) {
      const computed = [];
      for (const dataUrl of photos) {
        try {
          // 用 descriptorOf 而不是 describe：describe 会 await init()，
          // 而这里正在 init() 里面，那样会卡死（自己等自己）。
          const d = await descriptorOf(await loadImage(dataUrl));
          if (d) computed.push(d);
        } catch (err) {
          log(`参考照算特征失败：${err.message}`);
        }
      }
      if (computed.length) {
        const kept = await window.dshPet.faceEnrollDescriptor(computed);
        refs = (kept && kept.descriptors) || computed;
        log(`参考照特征已补算并保存：${refs.length} 条`);
      }
    }
    state.refs = refs.length;
  }

  /**
   * 判一次身份。
   * @returns {Promise<object|null>} 结论对象；本地不可用（模型没起来 / 还没认主）时返回 null，
   *   调用方据此回退到云端模型。
   */
  async function identify(input, source) {
    if (!(await init())) return null;
    if (!refs.length) return null;
    const width = frameWidthOf(input);
    const height = Number(input.videoHeight || input.naturalHeight || input.height) || 0;
    const res = await withLib(() => lib.detect(input));
    const faces = res.face || [];
    const usable = usableFaces(faces, width);
    const face = biggest(usable);
    if (!face || !face.embedding || !face.embedding.length) {
      // 有候选但全被质量门槛刷掉 → 按"画面里没人"处理，别拿垃圾框去比身份
      if (faces.length) {
        const why = faces
          .map((f) => `${(f.score || 0).toFixed(2)}分/${Math.round(f.box[2])}px`)
          .join("、");
        log(`丢弃 ${faces.length} 个不合格候选（${why}；要求 ≥${MIN_FACE_SCORE}分 且 ≥${Math.round(width * MIN_FACE_WIDTH)}px）→ 按"没人"处理`);
      }
      // 有脸但被质量门槛刷掉也要记：这能说明"是没看到人"还是"看到了但太糊/太小"
      reportSample({ rej: faces.length, src: source || "probe" });
      return {
        ts: Date.now(),
        noFace: true,
        ownerPresent: false,
        faces: 0,
        similarity: 0,
        distance: 0,
        source: source || "probe",
      };
    }
    const best = lib.match.find(face.embedding, refs);
    const ownerPresent = best.similarity >= THRESHOLD;
    // 顺便把哈欠/眯眼几何量一起带出来（只上报 + 打日志，身份判定不看它；
    // 主进程的哈欠"过闸"用的是随帧送去的 1 秒循环那份几何量）
    const geo = geometryOf(face, width, height);
    if (!geo && !meshWarned) {
      meshWarned = true;
      log("没拿到 face.mesh 关键点 → 哈欠几何量（MAR/EAR）暂时不可用");
    }
    const geoText = geo
      ? ` 嘴${geo.marIn}/${geo.marOut == null ? "-" : geo.marOut} 眼${geo.ear}${geo.pitch == null ? "" : ` 头${geo.pitch.toFixed(2)}`}`
      : "";
    const detail = `sim=${best.similarity.toFixed(3)} 检测分=${(face.score || 0).toFixed(2)} 脸框=${Math.round(face.box[2])}x${Math.round(face.box[3])}${geoText}`;
    // 攒"主人长什么样"的实测数据（认主自适应的第一步）：
    // 每帧送一条给主进程落盘。不能只靠 pet-run.log —— 那份每次启动被覆盖，
    // 而且它只在 own 或 sim≥0.45 时才写，低相似度的样本全丢了，攒不出完整分布。
    reportSample({
      sim: Number(best.similarity.toFixed(3)),
      sc: Number((face.score || 0).toFixed(2)),
      bw: Math.round(face.box[2]),
      bh: Math.round(face.box[3]),
      pit: geo && typeof geo.pitch === "number" ? Number(geo.pitch.toFixed(2)) : null,
      src: source || "probe",
      own: ownerPresent,
    });
    // 认成主人要留痕：将来"门自己开了"能翻到这里看是不是误判
    if (ownerPresent) log(`判定：主人（${detail}）`);
    else if (best.similarity >= 0.45) log(`判定：不是主人，但相似度偏高（${detail}，门槛 ${THRESHOLD}）`);
    return {
      ts: Date.now(),
      noFace: false,
      ownerPresent,
      faces: usable.length,
      similarity: Number(best.similarity.toFixed(3)),
      distance: Number(best.distance.toFixed(3)),
      source: source || "probe",
      ...(geo || {}), // mar / ear / pitch（主进程只取它认识的字段，多余的无副作用）
    };
  }

  window.dshFace = {
    init,
    identify,
    describe,
    metrics,
    /** 认主完成后重算特征 */
    refresh: async () => {
      if (!state.ready && !(await init())) return;
      await syncRefs();
      reportReady();
    },
    isReady: () => state.ready,
    hasRefs: () => refs.length > 0,
    state: () => ({ ...state, threshold: THRESHOLD }),
    /** 两条特征之间的相似度（标定门槛用） */
    compare: (a, b) => (lib ? lib.match.similarity(a, b) : 0),
  };

  // 提前把模型加载起来（首次约 10MB，之后走 IndexedDB 缓存），别等第一次探测才现学
  init().catch(() => {});

  // 认主完成后主进程会叫一声：按新照片重算特征
  if (window.dshPet && window.dshPet.onFaceRefresh) {
    window.dshPet.onFaceRefresh(() => {
      window.dshFace.refresh().catch((err) => log(`refresh failed: ${err.message}`));
    });
  }
})();