// renderer/minutes.js —— "会议记录"窗口：历次会议列表 + 正文（含原文对照）+ 重命名/删除 + 追问
//
// 这块是主人**验证旁听记对了没有、并且管得住自己记录**的地方，所以刻意做到：
//   · 左边列出历次会议（时间 / 时长 / 句数），点哪场看哪场——不是只看最近一场
//   · 每场都能改名：改名会同时改 md 文件名、正文标题和索引（主进程里做，事件日志只追加一条）
//   · 删除是**移进回收站**（可还原），问一句再删；历史统计不受影响（发生过就是发生过）
//   · 正文带"附：原文时间轴（按句）"——纪要说的每条，都能翻回当时那句原话
//
// 内容都来自主进程（meeting.js），这里只负责画：markdown **先转义再套样式**（模型输出不当 HTML 用）。

(function () {
  const titleEl = document.getElementById("mtTitle");
  const metaEl = document.getElementById("mtMeta");
  const bodyEl = document.getElementById("mtBody");
  const answerEl = document.getElementById("mtAnswer");
  const askInput = document.getElementById("mtAskInput");
  const listEl = document.getElementById("mtList");
  const countEl = document.getElementById("mtCount");
  const sideFootEl = document.getElementById("mtSideFoot");

  let list = [];          // 历次会议（最新在前）
  let currentFile = null; // 当前展示的文件名
  let latestFile = null;  // 最近一场的文件名（决定追问能不能用）

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const baseName = (p) => String(p || "").split(/[\\/]/).pop();
  const hm = (ts) => {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const mdhm = (ts) => {
    const d = new Date(ts);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm(ts)}`;
  };
  const ymdhm = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm(ts)}`;
  };
  const mins = (durMs) => (durMs ? Math.max(1, Math.round(durMs / 60000)) : 0);

  /** 极简 markdown → HTML（只支持纪要里实际会出现的那几种：标题/列表/加粗/引用/行内代码） */
  function renderMarkdown(md) {
    const lines = String(md || "").split(/\r?\n/);
    const out = [];
    let inList = false;
    const closeList = () => {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
    };
    const inline = (s) =>
      esc(s)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/【(\d{1,2}:\d{2})】/g, "<code>【$1】</code>"); // 时间戳做成等宽，扫起来快

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) {
        closeList();
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        closeList();
        const lvl = Math.min(4, h[1].length);
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
        continue;
      }
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) {
        if (!inList) {
          out.push("<ul>");
          inList = true;
        }
        // 待办清单在 md 里是 "- [ ] 事项"，直接渲染会露出一对中括号，看着像没写完
        let text = li[1];
        const box = text.match(/^\[([ xX])\]\s*(.*)$/);
        if (box) text = `${box[1].trim() ? "☑" : "☐"} ${box[2]}`;
        out.push(`<li>${inline(text)}</li>`);
        continue;
      }
      const q = line.match(/^>\s?(.*)$/);
      if (q) {
        closeList();
        out.push(`<blockquote>${inline(q[1])}</blockquote>`);
        continue;
      }
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    return out.join("\n");
  }

  // ---- 小弹窗（重命名 / 确认删除）------------------------------------------

  const modalEl = document.getElementById("mtModal");
  const modalTitleEl = document.getElementById("mtModalTitle");
  const modalBodyEl = document.getElementById("mtModalBody");
  const modalOkEl = document.getElementById("mtModalOk");
  const modalCancelEl = document.getElementById("mtModalCancel");

  /** @returns {Promise<any>} 确定时给输入框的值（没输入框就是 true），取消是 null */
  function askModal({ title, bodyHtml, okText, inputValue, placeholder }) {
    return new Promise((resolve) => {
      modalTitleEl.textContent = title;
      modalBodyEl.innerHTML = bodyHtml || "";
      modalOkEl.textContent = okText || "确定";
      let input = null;
      if (inputValue !== undefined) {
        input = document.createElement("input");
        input.type = "text";
        input.maxLength = 40;
        input.value = inputValue || "";
        input.placeholder = placeholder || "";
        modalBodyEl.appendChild(input);
      }
      const done = (v) => {
        modalEl.hidden = true;
        modalOkEl.onclick = null;
        modalCancelEl.onclick = null;
        document.removeEventListener("keydown", onKey);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === "Escape") done(null);
        else if (e.key === "Enter" && input) done(input.value);
      };
      modalOkEl.onclick = () => done(input ? input.value : true);
      modalCancelEl.onclick = () => done(null);
      document.addEventListener("keydown", onKey);
      modalEl.hidden = false;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  // ---- 左侧列表 -------------------------------------------------------------

  function renderList() {
    countEl.textContent = `${list.length} 场`;
    if (!list.length) {
      listEl.innerHTML = `<div class="empty" style="padding:8px">还没有记录</div>`;
      sideFootEl.textContent = "纪要存在本机 data/meetings/";
      return;
    }
    listEl.innerHTML = list
      .map((m) => {
        const end = m.startedAt + (m.durMs || 0);
        return `<div class="m-item${m.file === currentFile ? " on" : ""}" data-file="${esc(m.file)}">
          <div class="m-item-title">${esc(m.title || "会议纪要")}</div>
          <div class="m-item-meta">${esc(mdhm(m.startedAt))}–${esc(hm(end))} · ${mins(m.durMs)} 分钟 · ${m.lines || 0} 句</div>
          ${m.fallback ? `<div class="m-item-warn">⚠️ 自动兜底版</div>` : ""}
        </div>`;
      })
      .join("");
    listEl.querySelectorAll(".m-item").forEach((el) => {
      el.addEventListener("click", () => showByFile(el.dataset.file));
    });
  }

  // ---- 右侧正文 -------------------------------------------------------------

  function emptyState() {
    titleEl.textContent = "📝 会议记录";
    metaEl.textContent = "还没有记录";
    bodyEl.innerHTML = `<div class="empty">这里还没有会议纪要。<br><br>
      <b>怎么开始一次旁听：</b><br>
      1. 右键鲸鱼 → <b>🎧 旁听</b> → 弹框里点「开始旁听」（托盘菜单里也有这一项）<br>
      2. 开会时鲸鱼下面会滚实时字幕，看得见它听到了什么<br>
      3. 会开完再点一次 <b>⏹ 结束</b> —— 我就把纪要写到这里来<br><br>
      记录都在本机 <code>data/meetings/</code> 下的 md 文件里（超期按设置自动清），每份的"附：原文时间轴"能让你逐句核对记对没有。</div>`;
  }

  /** 追问只在"最近一场"能用：主进程手里只有那一场的逐句原文 */
  function renderAskState() {
    const isLatest = !!currentFile && currentFile === latestFile;
    askInput.disabled = !isLatest;
    document.getElementById("mtAskBtn").disabled = !isLatest;
    askInput.placeholder = isLatest
      ? "比如：客户最后确认的报价是多少？谁负责改合同？"
      : "只有最近一场能用追问（更早的可以看正文里的原文时间轴）";
    if (!isLatest) {
      answerEl.hidden = true;
      answerEl.textContent = "";
    }
  }

  /** 正文第一行本来就是把标题又写了一遍（跟窗口标题重复）——去掉，省得看着像两份标题 */
  function stripDuplicateTitle(md, title) {
    const lines = String(md || "").split(/\r?\n/);
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    const h = (lines[i] || "").match(/^#\s+(.*)$/);
    if (h && title && h[1].trim() === String(title).trim()) {
      lines.splice(i, 1);
      return lines.join("\n");
    }
    return String(md || "");
  }

  function renderDoc({ title, startedAt, endedAt, durMs, lines, markdown, fallback, file }) {
    currentFile = file || null;
    titleEl.textContent = `📝 ${title || "会议纪要"}`;
    const end = endedAt || (startedAt && durMs ? startedAt + durMs : 0);
    metaEl.textContent = [
      startedAt ? `${ymdhm(startedAt)}${end ? " – " + hm(end) : ""}` : "",
      mins(durMs) ? `${mins(durMs)} 分钟` : "",
      lines ? `${lines} 句` : "",
      currentFile,
    ]
      .filter(Boolean)
      .join(" · ");
    bodyEl.innerHTML =
      (fallback ? `<div class="warn">⚠️ 这份是自动兜底版（模型这次没产出结构版，原因已记进事件日志）</div>` : "") +
      renderMarkdown(stripDuplicateTitle(markdown, title) || "（没有内容）");
    document.title = `会议记录 · ${title || ""}`;
    renderAskState();
    renderList();
    const btns = ["mtRename", "mtCopy", "mtFolder", "mtOpen", "mtDelete"];
    btns.forEach((id) => {
      document.getElementById(id).disabled = !currentFile;
    });
  }

  async function showByFile(file) {
    if (!file) {
      currentFile = null;
      emptyState();
      renderList();
      ["mtRename", "mtCopy", "mtFolder", "mtOpen", "mtDelete"].forEach((id) => {
        document.getElementById(id).disabled = true;
      });
      return;
    }
    const r = await window.dshPet.meetingRead(file);
    if (!r || !r.ok) {
      currentFile = null;
      bodyEl.innerHTML = `<div class="empty">${esc((r && r.error) || "读不到这份纪要")}</div>`;
      return;
    }
    const meta = r.meta || {};
    renderDoc({
      title: meta.title || baseName(file).replace(/\.md$/, ""),
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      durMs: meta.durMs,
      lines: meta.lines,
      fallback: meta.fallback,
      markdown: r.markdown,
      file,
    });
  }

  async function refresh(keepFile) {
    if (!window.dshPet || !window.dshPet.meetingList) {
      emptyState();
      return;
    }
    try {
      const latest = await window.dshPet.meetingLatest();
      latestFile = latest && latest.file ? baseName(latest.file) : null;
      list = (await window.dshPet.meetingList()) || [];
      const want = keepFile || (list.some((m) => m.file === currentFile) ? currentFile : list[0] && list[0].file);
      if (!list.length) {
        // 刚结束、文件还没进列表（或落盘失败）时，至少把内存里这份画出来
        if (latest) {
          renderDoc({ ...latest, file: latestFile });
          return;
        }
        currentFile = null;
        emptyState();
        renderList();
        ["mtRename", "mtCopy", "mtFolder", "mtOpen", "mtDelete"].forEach((id) => {
          document.getElementById(id).disabled = true;
        });
        return;
      }
      await showByFile(want);
    } catch {
      emptyState();
    }
  }

  // ---- 按钮 ------------------------------------------------------------------

  document.getElementById("mtRename").addEventListener("click", async () => {
    if (!currentFile) return;
    const cur = (list.find((m) => m.file === currentFile) || {}).title || "";
    const next = await askModal({
      title: "给这次会议改个名字",
      bodyHtml: "名字会同时用在文件名、正文标题和列表里（≤40 字）。",
      okText: "保存",
      inputValue: cur,
      placeholder: "比如：与客户确认报价与交付节点",
    });
    if (next === null) return;
    const r = await window.dshPet.meetingRename(currentFile, next);
    if (r && r.ok) {
      metaEl.textContent = `${metaEl.textContent} · 已改名`;
      await refresh(r.file);
    } else {
      await askModal({ title: "改名没成功", bodyHtml: esc((r && r.error) || "未知原因"), okText: "知道了" });
      await refresh(currentFile);
    }
  });

  document.getElementById("mtDelete").addEventListener("click", async () => {
    if (!currentFile) return;
    const cur = (list.find((m) => m.file === currentFile) || {}).title || currentFile;
    const yes = await askModal({
      title: "把这份纪要删掉？",
      bodyHtml: `「${esc(cur)}」会被<b>移到回收站</b>（还能还原），本机记录里不再显示。<br>事件日志里的历史记录不动——那场会确实开过。`,
      okText: "移到回收站",
    });
    if (yes === null) return;
    const r = await window.dshPet.meetingDelete(currentFile);
    if (r && r.ok) {
      currentFile = null;
      await refresh();
    } else {
      await askModal({ title: "删除没成功", bodyHtml: esc((r && r.error) || "未知原因"), okText: "知道了" });
    }
  });

  document.getElementById("mtCopy").addEventListener("click", async () => {
    if (!currentFile) return;
    const text = bodyEl.innerText || "";
    try {
      await navigator.clipboard.writeText(text);
      metaEl.textContent = `${metaEl.textContent.replace(/ · 已复制$/, "")} · 已复制`;
    } catch {
      metaEl.textContent = `${metaEl.textContent.replace(/ · 已复制失败.*$/, "")} · 复制失败（可点"打开"再复制）`;
    }
  });

  document.getElementById("mtFolder").addEventListener("click", () => {
    if (window.dshPet.meetingOpen) window.dshPet.meetingOpen("folder", currentFile);
  });

  document.getElementById("mtOpen").addEventListener("click", () => {
    if (window.dshPet.meetingOpen) window.dshPet.meetingOpen("file", currentFile);
  });

  async function ask() {
    const q = askInput.value.trim();
    if (!q || !currentFile || currentFile !== latestFile) return;
    answerEl.hidden = false;
    answerEl.textContent = "正在翻记录…";
    try {
      const r = await window.dshPet.meetingAsk(q);
      answerEl.textContent = r && r.ok ? r.answer : `没问成：${(r && r.error) || "未知原因"}`;
    } catch (err) {
      answerEl.textContent = `没问成：${err.message}`;
    }
  }

  document.getElementById("mtAskBtn").addEventListener("click", ask);
  askInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      ask();
    }
  });

  // 主进程推来新纪要（窗口开着的时候）→ 切到这一份
  if (window.dshPet && window.dshPet.onMeetingMinutes) {
    window.dshPet.onMeetingMinutes((m) => {
      latestFile = m && m.file ? baseName(m.file) : latestFile;
      refresh(m && m.file ? baseName(m.file) : null);
    });
  }

  refresh();
})();