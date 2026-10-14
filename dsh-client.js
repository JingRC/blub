// dsh-client.js — minimal DSH /api client for the desktop pet.
//
// Runs in the Electron MAIN process (Node: no browser Origin/Fetch-Metadata),
// so it clears DSH's loopback trust fence as a non-browser client. It speaks
// the smallest slice of the 0.1.5-rc.1 /api protocol needed to drive the
// whale's state:
//
//   - GET  /?token=<token>    — one-time auth exchange (HTTP 303 + Set-Cookie
//                               `dsh-auth-...=...`); needed because 0.1.5
//                               protects /api with browser-session auth
//   - POST /api/session/list  — unary RPC (running baseline for sessions)
//   - WS  /api/remote.mux     — Gateway stream; open the internal `$events`
//                               stream and receive ready/emit/waterfall frames
//
// Wire shapes (from packages/client/connection and packages/api/gateway):
//   unary request   { type:'client-request', rpcId, method, payload:{args} }
//   unary response  { rpcId, result:{ ok:true, value } | { ok:false, error } }
//   mux open        { type:'open', streamId, endpoint:'$events', payload:{args:{}} }
//   mux downlink    { type:'item', streamId, value } where value is one of
//                   {type:'ready',clientId,host} | {type:'emit',event,args} |
//                   {type:'waterfall',event,eventId,agentId,request} | {type:'cancel',eventId}
//
// Host events seen on `$events` (packages/api/session-controller):
//   api-session/status   (sessionId, running:boolean)  — primary lifecycle signal
//   api-session/activity (sessionId, updatedAt)        — user-turn activity
//   api-session/error    (sessionId, message)
//   api-session/added    (summary) / api-session/removed (sessionId)
//
// All network targets are loopback (127.0.0.1:3080); the base URL and port are
// configurable. Errors are logged and surfaced via the `state` callback, so a
// broken connection never crashes the pet — it just floats idle.

const WebSocket = require("ws");

/** A tiny counter for rpcIds. */
let rpcCounter = 0;
function nextRpcId() {
  rpcCounter += 1;
  return `pet-${Date.now()}-${rpcCounter}`;
}

class DshClient {
  /**
   * @param {object} opts
   * @param {string} [opts.base]   base URL, default http://127.0.0.1:3080
   * @param {(state: PetState, meta: object) => void} opts.onState
   *        called whenever the derived pet state changes.
   * @param {(line: string) => void} [opts.onLog]  diagnostic sink.
   */
  constructor(opts = {}) {
    this.base = (opts.base || "http://127.0.0.1:3080").replace(/\/+$/, "");
    this.onState = opts.onState;
    this.onLog = opts.onLog || (() => {});
    this.ws = null;
    this.alive = false;
    this.hostHome = null;
    this.token = opts.token || null; // launch token printed by `dsh web`
    this.cookie = null; // `dsh-auth-...=...` exchanged from the token
    this.sessions = []; // last session/list items
    this.running = new Set(); // sessionIds currently running
    this.lastState = "disconnected";
    this.reconnectTimer = null;
    this.idleTimer = null;
    // If no frame arrives for this long while "running", fall back to "thinking"
    // (we are likely mid-generation but haven't seen a finer-grained event).
    this.idleFallbackMs = 4000;
  }

  log(line) {
    this.onLog(`[dsh] ${line}`);
  }

  /** Derive the pet state from what we know and push it to the renderer. */
  emit(reason) {
    let state;
    if (!this.alive) state = "disconnected";
    else if (this.running.size > 0) state = "thinking";
    else state = "idle";
    if (state !== this.lastState) {
      this.lastState = state;
      this.onState(state, { reason: reason || "change", sessions: this.sessions.length, running: this.running.size, hostHome: this.hostHome });
      this.log(`state -> ${state} (${reason || "change"})`);
    }
  }

  /** 供情绪推测使用的电脑工作上下文（会话活动概况，而非只有连接状态） */
  dshContext() {
    const now = Date.now();
    let latest = 0;
    for (const s of this.sessions) {
      const t = Number(s.updatedAt) || 0;
      // 兼容秒/毫秒两种时间戳
      latest = Math.max(latest, t > 1e12 ? t : t * 1000);
    }
    return {
      connected: this.alive,
      state: this.lastState,
      running: this.running.size,
      sessions: this.sessions.length,
      lastActiveMinAgo: latest ? Math.round((now - latest) / 60000) : null,
    };
  }

  /** POST a unary /api call (client-request envelope), returning result.value. */
  async unary(method, args) {
    const url = `${this.base}/api/${method}`;
    const body = {
      type: "client-request",
      rpcId: nextRpcId(),
      method,
      payload: { args: args ?? { _request: {} } },
    };
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.result;
    if (!result?.ok) {
      throw new Error(`${method} -> ${result?.error?.code || "unknown"}: ${result?.error?.message || "no result"}`);
    }
    return result.value;
  }

  async listSessions() {
    // session/list returns { items: [{ sessionId, updatedAt, running, ... }] }.
    const value = await this.unary("session/list", { _request: {} });
    const list = value?.items || [];
    this.sessions = list;
    // Seed the running set: items carry a `running` boolean.
    this.running = new Set(list.filter((s) => s.running === true).map((s) => s.sessionId));
    this.log(`session/list ok (${list.length} sessions, ${this.running.size} running)`);
    return list;
  }

  /** Exchange the launch token once for the `dsh-auth-` session cookie. */
  async authenticate() {
    if (!this.token || this.cookie) return;
    const res = await fetch(`${this.base}/?token=${encodeURIComponent(this.token)}`, { redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (res.status !== 303 || !setCookie) {
      throw new Error(`auth exchange -> HTTP ${res.status}`);
    }
    this.cookie = setCookie.split(";")[0];
    this.log(`auth ok (cookie=${this.cookie.split("=")[0]}=...)`);
  }

  /** Open the remote.mux downlink, subscribe to `$events`, route frames. */
  connectMux() {
    const url = this.base.replace(/^http/, "ws") + "/api/remote.mux";
    this.log(`mux -> ${url}`);
    this.ws = new WebSocket(url, this.cookie ? { headers: { cookie: this.cookie } } : undefined);
    this.streamOpened = false;

    this.ws.on("open", () => {
      this.log("mux open; opening $events stream");
      // Open the Gateway-internal forwarded-event stream (see stream-protocol.ts).
      this.send({ type: "open", streamId: "pet-events", endpoint: "$events", payload: { args: {} } });
    });

    this.ws.on("message", (data) => this.onFrame(data.toString()));

    this.ws.on("close", (code, reason) => {
      this.log(`mux close (${code})`);
      this.alive = false;
      this.streamOpened = false;
      this.running.clear();
      this.emit("mux-close");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.log(`mux error: ${err.message}`);
      // close handler will reschedule
    });
  }

  send(obj) {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch (err) {
      this.log(`send failed: ${err.message}`);
    }
  }

  /** Route one mux message. Messages are {type:'item'|'failure'|'end', streamId, ...}. */
  onFrame(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // ignore malformed
    }

    // Only the $events logical stream interests us.
    if (msg.type === "failure") {
      this.log(`stream failure: ${msg.value?.code || ""} ${msg.value?.message || ""}`);
      return;
    }
    if (msg.type === "end") {
      this.log("stream ended; server will see us reconnect");
      return;
    }
    if (msg.type !== "item") return;

    const value = msg.value;
    if (!value || typeof value !== "object") return;

    // Opening frame: proves the Host event source is ready.
    if (value.type === "ready") {
      this.hostHome = value.host?.home || null;
      this.alive = true;
      this.emit("events-ready");
      this.log(`events ready (clientId=${value.clientId}, home=${this.hostHome})`);
      return;
    }

    // One Host notification: {type:'emit', event, args}.
    if (value.type === "emit") return this.onEvent(value.event, value.args || []);

    // A pending blocking interaction (approval, user question) arrives as a
    // waterfall request aimed at some client; the pet flashes "approval".
    if (value.type === "waterfall") {
      this.flash("approval", 3000);
      return;
    }
    // value.type === 'cancel' — a waterfall was withdrawn; ignore.
  }

  /** Route one api-session/* Host event to pet state changes. */
  onEvent(event, args) {
    const sid = args[0];

    // api-session/status(sessionId, running) is the primary lifecycle signal.
    if (event === "api-session/status") {
      const running = args[1] === true;
      if (running && sid) {
        this.running.add(sid);
        this.armIdleFallback();
      } else if (!running && sid) {
        const was = this.running.delete(sid);
        if (was) this.emit("status-idle");
        // a finished turn briefly shows "done", then falls back to idle.
        this.flash("done", 1800);
      }
      return;
    }

    // User submitted a turn — activity on a running session.
    if (event === "api-session/activity") {
      if (this.running.size > 0) this.touch();
      return;
    }

    // Agent-level failure -> whale flips belly-up briefly.
    if (event === "api-session/error") {
      this.flash("error", 2600);
      return;
    }

    // added/removed — refresh the known sessions in the background.
    if (event === "api-session/added" || event === "api-session/removed") {
      this.listSessions().catch(() => {});
      this.emit("sessions-changed");
      return;
    }

    // Unknown emit — keep the pet "alive" but do not override a flash.
    if (this.lastState === "disconnected") this.emit("mux-frame");
  }

  // ---- state helpers -------------------------------------------------------

  flash(state, ms) {
    this.onState(state, { reason: "flash", ttl: ms, hostHome: this.hostHome });
    this.lastState = state;
    this.log(`flash -> ${state} for ${ms}ms`);
    if (this._flashTimer) clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      this.emit("flash-expire");
    }, ms);
  }

  touch() {
    // keep current flash alive (no-op change) — resets idle fallback
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.armIdleFallback();
  }

  armIdleFallback() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // if still running but nothing finer arrived, stay "thinking"
      if (this.running.size > 0 && this.lastState !== "tool" && this.lastState !== "approval") {
        this.emit("idle-fallback");
      }
    }, this.idleFallbackMs);
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.start();
      } catch {
        this.scheduleReconnect();
      }
    }, 3000);
  }

  /** Full connect: auth, list sessions, then open the event stream. */
  async start() {
    try {
      await this.authenticate();
      await this.listSessions();
      if (this.ws) {
        try { this.ws.close(); } catch {}
        this.ws = null;
      }
      this.connectMux();
      this._lastStartErrAt = 0; // 恢复后重置限流
    } catch (err) {
      // 重连每 3s 一次，失败日志限流：首 FAIL 必记，之后每 2 分钟一条，避免刷屏
      const now = Date.now();
      if (!this._lastStartErrAt || now - this._lastStartErrAt > 120000) {
        this._lastStartErrAt = now;
        this.log(`start failed: ${err.message}（若持续出现，请确认 dsh web 已启动）`);
      }
      this.alive = false;
      this.emit("start-failed");
      this.scheduleReconnect();
    }
  }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this._flashTimer) clearTimeout(this._flashTimer);
    if (this.ws) try { this.ws.close(); } catch {}
  }
}

module.exports = { DshClient };
