// usage-store.js — 持久化 token 用量存储 + DSH 会话扫描采集。
//
// 设计：
//   - 桌宠自身的 LLM 调用由主进程 recordUsage() 累计后写入这里（source:"pet"）。
//   - DSH（DeepSeek Harness）在会话日志里为每次 LLM 调用记录 usage chunk
//     （assistant/chunk + chunk.type==="usage"），我们扫描 .jsonl.zstd 会话文件
//     提取（source:"dsh"），并记录每个文件已扫描到的字节偏移，实现增量扫描。
//   - 历史记录持久化到 userData/usage-history.json（含日期，支持按范围筛选）。

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("node:zlib");

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

class UsageStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir        持久化目录（Electron userData）
   * @param {string} [opts.dshSessionsDir] DSH 会话目录（通常 <dshHome>/sessions）
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir;
    this.dshSessionsDir = opts.dshSessionsDir || path.join(os.homedir(), ".dsh", "sessions");
    this.historyPath = path.join(this.dataDir, "usage-history.json");
    // records: [{ ts, source:'dsh'|'pet', model?, input, output, cacheRead, reasoning }]
    this.records = [];
    // fileCursor: { [absPath]: { bytesScanned, mtimeMs } }
    this.fileCursor = {};
    this.callsBySource = { dsh: 0, pet: 0 };
    this._loaded = false;
  }

  load() {
    try {
      if (fs.existsSync(this.historyPath)) {
        const raw = JSON.parse(fs.readFileSync(this.historyPath, "utf8"));
        this.records = Array.isArray(raw.records) ? raw.records : [];
        this.fileCursor = raw.fileCursor && typeof raw.fileCursor === "object" ? raw.fileCursor : {};
        this._loaded = true;
        return true;
      }
    } catch (err) {
      console.error("[usage-store] load failed:", err.message);
    }
    this.records = [];
    this._loaded = true;
    return false;
  }

  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.historyPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({
        records: this.records,
        fileCursor: this.fileCursor,
        savedAt: Date.now(),
      }));
      fs.renameSync(tmp, this.historyPath);
    } catch (err) {
      console.error("[usage-store] save failed:", err.message);
    }
  }

  // ---- 记录 ----------------------------------------------------------------

  /** 追加一条用量记录。 */
  addRecord(rec) {
    const r = {
      ts: rec.ts || Date.now(),
      source: rec.source === "dsh" ? "dsh" : "pet",
      input: rec.input || 0,
      output: rec.output || 0,
      cacheRead: rec.cacheRead || 0,
      reasoning: rec.reasoning || 0,
    };
    if (rec.model) r.model = rec.model;
    if (rec.provider) r.provider = rec.provider;
    this.records.push(r);
    this.callsBySource[r.source] = (this.callsBySource[r.source] || 0) + 1;
    // 简单上限保护：保留最近 50000 条
    if (this.records.length > 50000) {
      this.records.splice(0, this.records.length - 50000);
    }
  }

  // ---- 统计聚合 ------------------------------------------------------------

  /**
   * 汇总统计。
   * @param {number} [sinceTs] 时间下限（毫秒）；缺省=全部。
   * @param {'dsh'|'pet'|'all'} [source]
   */
  summarize(sinceTs, source) {
    const since = sinceTs || 0;
    const src = source || "all";
    let calls = 0;
    let input = 0, output = 0, cacheRead = 0, reasoning = 0;
    let last = null;
    for (const r of this.records) {
      if (r.ts < since) continue;
      if (src !== "all" && r.source !== src) continue;
      calls++;
      input += r.input || 0;
      output += r.output || 0;
      cacheRead += r.cacheRead || 0;
      reasoning += r.reasoning || 0;
      if (!last || r.ts > last.ts) last = r;
    }
    const total = input + output + cacheRead;
    return {
      calls,
      totalTokens: total,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      reasoningTokens: reasoning,
      uncachedTokens: input,
      lastCall: last
        ? { ts: last.ts, source: last.source, model: last.model || "", input: last.input, output: last.output, cacheRead: last.cacheRead, reasoning: last.reasoning, total: (last.input || 0) + (last.output || 0) + (last.cacheRead || 0) }
        : null,
    };
  }

  /** 按天分组汇总（用于图表/列表）。 */
  groupByDay(sinceTs, source) {
    const since = sinceTs || 0;
    const src = source || "all";
    const days = {};
    for (const r of this.records) {
      if (r.ts < since) continue;
      if (src !== "all" && r.source !== src) continue;
      const d = new Date(r.ts).toISOString().slice(0, 10);
      if (!days[d]) days[d] = { input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 };
      days[d].input += r.input || 0;
      days[d].output += r.output || 0;
      days[d].cacheRead += r.cacheRead || 0;
      days[d].reasoning += r.reasoning || 0;
      days[d].calls++;
    }
    return days;
  }

  /** 全部记录数量。 */
  count() {
    return this.records.length;
  }

  // ---- DSH 会话扫描 -------------------------------------------------------

  /** 递归列出 <workspace>/<session>/session.jsonl.zstd 文件。 */
  listSessionFiles() {
    const out = [];
    const root = this.dshSessionsDir;
    if (!fs.existsSync(root)) return out;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".jsonl.zstd")) out.push(full);
      }
    };
    walk(root);
    return out;
  }

  /** 扫描一个会话文件的全部 zstd 帧，返回 { recs, maxEnd }（跳过 start<fromOffset 的帧）。 */
  decodeSessionFile(file, fromOffset) {
    const buf = fs.readFileSync(file);
    const frames = [];
    let pos = 0;
    while (pos < buf.length) {
      const idx = buf.indexOf(ZSTD_MAGIC, pos);
      if (idx === -1) break;
      const next = buf.indexOf(ZSTD_MAGIC, idx + 4);
      frames.push({ start: idx, end: next === -1 ? buf.length : next });
      pos = next === -1 ? buf.length : next;
    }
    const out = [];
    let maxEnd = 0;
    for (const fr of frames) {
      if (fr.end > maxEnd) maxEnd = fr.end;
      if (fr.start < (fromOffset || 0)) continue; // 已扫描过的旧帧
      let text;
      try {
        text = zlib.zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString("utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (line.indexOf('"type":"usage"') === -1) continue;
        try {
          const j = JSON.parse(line);
          const usage = j?.data?.chunk?.usage;
          if (!usage) continue;
          out.push({
            ts: j.time || Date.now(),
            input: usage.inputTokens || 0,
            output: usage.outputTokens || 0,
            cacheRead: usage.cacheReadTokens || 0,
            reasoning: usage.reasoningTokens || 0,
            model: (j.data && (j.data.model || (j.data.message && j.data.message.model))) || undefined,
            provider: (j.data && j.data.provider) || undefined,
          });
        } catch {}
      }
    }
    return { recs: out, maxEnd };
  }

  /** 增量扫描所有会话文件（只处理新增字节），把 DSH 用量写入历史。 */
  scanDshSessions() {
    const files = this.listSessionFiles();
    let added = 0;
    for (const file of files) {
      try {
        const st = fs.statSync(file);
        const cursor = this.fileCursor[file];
        const from = cursor && cursor.bytesScanned === st.size ? undefined : (cursor ? cursor.bytesScanned : 0);
        // 文件完全未变 → 跳过
        if (cursor && cursor.bytesScanned === st.size && cursor.mtimeMs === st.mtimeMs) {
          continue;
        }
        const { recs, maxEnd } = this.decodeSessionFile(file, from);
        for (const rec of recs) {
          this.addRecord({ ...rec, source: "dsh" });
          added++;
        }
        this.fileCursor[file] = { bytesScanned: Math.max(maxEnd, cursor ? cursor.bytesScanned : 0), mtimeMs: st.mtimeMs };
      } catch (err) {
        console.error(`[usage-store] scan ${file} failed:`, err.message);
      }
    }
    if (added > 0) {
      this.save();
    }
    return added;
  }
}

module.exports = { UsageStore };
