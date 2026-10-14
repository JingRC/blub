# music-qqm-daemon.py —— QQ音乐"正在播放"读取守护（老版 QQ音乐专用的第二层数据源）
#
# 背景：老版 QQ音乐（如 19.51）不注册 Windows 系统媒体控制中心（SMTC），歌名/歌手/歌词
# 只存在于 DirectWrite 文字渲染调用里（自绘 UI，不走 GDI，本地存储全加密）。
# 本守护用 frida attach 到 QQ音乐进程，在 IDWriteFactory::CreateTextLayout（vtable 槽 18/19）
# 上做**只观察**的钩子——所有要画上屏幕的中文文本（歌名/歌手/歌词/播放状态）都会经过这里。
# 密钥级 hook、函数替换一概不做（替换会搞崩 QQ音乐，见 2026-09-23 实验）。
#
# 关键技巧：attach 时 QQ音乐 的 DWrite 工厂多半早已建好（等不到 DWriteCreateFactory 调用）。
# 解法：**我们自己调一次 DWriteCreateFactory** 拿到工厂实例——工厂的 vtable 是 dwrite.dll
# 里的静态共享内存，所有实例（包括 QQ音乐的）都指同一张表，patch 我们这个实例的 vtable
# 等于 hook 了 QQ音乐的。SHARED/ISOLATED 两种类型都建，避免实现类不同。
#
# 输出协议：stdout 每行一个 JSON：
#   {"t":"session","status":"Playing","title":"对等关系","artist":"李荣浩 / 张惠妹","pos":12}
#   {"t":"session","status":"Paused"|"Stopped", ...}   （pos = 已播秒数，end 恒为 0：读不到总长）
#   {"t":"log","msg":"..."}                              （调试信息）
# 由 main.js 拼装成快照喂给 music.js 的状态机（SMTC 仍是第一优先，本层只在 SMTC 无会话时生效）。
#
# 生命周期：常驻轮询 QQ音乐.exe；没在跑就每 5 秒看一眼（近乎零开销）；退出由 main.js kill。

import ctypes
import frida
import json
import os
import subprocess
import sys
import time

POLL_SEC = 5            # QQ音乐不在时多久看一眼
PAIR_WINDOW_SEC = 2.0   # "已开始播放"之后多久内的文本算"这次播放的元数据"
IDLE_TO_PAUSE = 300     # 多久没有任何文本/时间重绘就认为暂停（纯音乐没歌词，靠进度时间心跳；放宽到 5 分钟兜底）
CONFIRM_WINDOW_SEC = 12 # 配对成功后多久内出现歌词流，算"这次配对被歌词证实了"（观测用，不改变行为）
PAIR_SAMEFRAME_GAP = 0.6  # 配对窗口里相邻候选间隔 > 这个值视为跨帧，可信度低（只打日志）

# pid 文件：桌宠崩溃/被强杀时守护会残留（frida 还挂在 QQ音乐 上），
# 新守护启动时按 pid 文件清场——先验证那个 pid 还是 python 进程再杀，防 pid 复用误伤。
PID_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "qqm-daemon.pid")


def kill_stale_daemon():
    """清掉上一个残留的守护（桌宠异常退出时它杀不到自己）"""
    try:
        with open(PID_FILE, "r", encoding="utf-8") as f:
            old = int(f.read().strip())
    except Exception:
        return
    try:
        # 验证这个 pid 现在还是不是 python——不是（早就退了/pid 被复用）就不动
        r = subprocess.run(
            ["tasklist", "/fi", f"PID eq {old}", "/nh", "/fo", "csv"],
            capture_output=True, text=True, timeout=5,
        )
        if "python" not in (r.stdout or "").lower():
            return
        subprocess.run(["taskkill", "/f", "/pid", str(old)], capture_output=True, timeout=5)
        print(json.dumps({"t": "log", "msg": f"清掉残留守护 pid={old}"}, ensure_ascii=False), flush=True)
    except Exception:
        pass


def write_pid():
    try:
        os.makedirs(os.path.dirname(PID_FILE), exist_ok=True)
        with open(PID_FILE, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    except Exception:
        pass


def clear_pid():
    try:
        os.remove(PID_FILE)
    except Exception:
        pass

# 出现在 UI 里的固定文案，不能当歌名/歌手
UI_LABELS = {
    "歌曲名", "歌手名称", "未知歌曲", "未知歌手", "播放队列", "音乐馆", "视频",
    "雷达", "我的音乐", "本地和下载", "最近播放", "试听列表", "默认列表",
    "点击登录", "登录中", "桌面歌词", "已开始播放", "已暂停", "我喜欢", "推荐",
    "在线音乐", "官方歌单", "更多", "搜索音乐", "听书", "排行", "歌手", "分类歌单",
    "数字专辑", "手机专享", "听歌识曲", "专属推荐", "每日推荐",
}

JS_HOOK = r'''
"use strict";
function isCJK(s) {
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0x4e00 && c <= 0x9fa5) return true;
  }
  return false;
}
// 进度时间文本（"01:23"）：纯音乐没有歌词，主窗口播放条的时间每秒重绘，是最好的"还在放"心跳
var timeRe = /^\d{1,2}:[0-5]\d$/;
var sent = {};
var fires = { s18: 0, s19: 0 };
function emit(s) {
  if (s.length < 1 || s.length > 80) return;
  var isTime = timeRe.test(s);
  if (!isCJK(s) && !isTime) return;
  if (sent[s]) return;           // 同一段文本全局只报一次（UI 重绘会反复画同一句）
  sent[s] = 1;
  send(JSON.stringify({ t: isTime ? "tick" : "dw", s: s }));
}
function observeFactory(factoryPtr) {
  var vtbl = factoryPtr.readPointer();
  [18, 19].forEach(function (slot) {   // 18=CreateTextLayout, 19=CreateGdiCompatibleTextLayout
    var fnAddr = vtbl.add(slot * Process.pointerSize).readPointer();
    if (!fnAddr || fnAddr.isNull()) return;
    var key = fnAddr.toString();
    if (observeFactory.hooked && observeFactory.hooked[key]) return;
    (observeFactory.hooked = observeFactory.hooked || {})[key] = 1;
    var cntKey = "s" + slot;
    Interceptor.attach(fnAddr, {
      onEnter: function (args) {
        fires[cntKey]++;
        try {
          // CreateTextLayout(this, string, stringLength, format, maxW, maxH, layoutOut)
          var len = args[2].toInt32();
          if (len <= 0 || len > 80) return;
          emit(args[1].readUtf16String(len));
        } catch (e) {}
      }
    });
    send(JSON.stringify({ t: "log", msg: "observe slot " + slot + " @ " + fnAddr }));
  });
  // 自证：自己调一次 slot18（format 传空会返回错误，但函数入口的钩子必然先触发）
  if (!observeFactory.selfTest) {
    observeFactory.selfTest = true;
    try {
      var abi = Process.arch === "ia32" ? "stdcall" : "default";
      var fn18 = new NativeFunction(vtbl.add(18 * Process.pointerSize).readPointer(),
        "int", ["pointer", "pointer", "uint32", "pointer", "float", "float", "pointer"], abi);
      var s = Memory.allocUtf16String("测试HOOK自证");
      var out = Memory.alloc(Process.pointerSize);
      fn18(factoryPtr, s, 8, NULL, 100.0, 20.0, out);
      send(JSON.stringify({ t: "log", msg: "selftest called" }));
    } catch (e) {
      send(JSON.stringify({ t: "log", msg: "selftest err " + e.message }));
    }
  }
}
function selfCreateFactory() {
  // 自己调 DWriteCreateFactory 拿工厂实例 → 它的 vtable 与 QQ音乐实例共享
  var dwp = Module.getGlobalExportByName("DWriteCreateFactory");
  var abi = Process.arch === "ia32" ? "stdcall" : "default";
  var create = new NativeFunction(dwp, "int", ["int", "pointer", "pointer"], abi);
  // IID_IDWriteFactory = {B859EE5A-D838-4B5B-A2E8-1ADC7D93DB48}
  var iid = Memory.alloc(16);
  iid.writeByteArray(
    [0x5a, 0xee, 0x59, 0xb8, 0x38, 0xd8, 0x5b, 0x4b, 0xa2, 0xe8, 0x1a, 0xdc, 0x7d, 0x93, 0xdb, 0x48]);
  var out = Memory.alloc(Process.pointerSize);
  for (var type = 0; type <= 1; type++) {   // SHARED / ISOLATED
    try {
      var r = create(type, iid, out);
      if (r === 0) {
        var f = out.readPointer();
        if (f && !f.isNull()) observeFactory(f);
      }
    } catch (e) {}
  }
  return true;
}
// dwrite.dll 加载好就自建工厂（一次）
var done = false;
var timer = setInterval(function () {
  if (done) { clearInterval(timer); return; }
  try {
    if (selfCreateFactory()) { done = true; clearInterval(timer); }
  } catch (e) { /* dwrite 还没加载，下轮再试 */ }
}, 500);
// 钩子触发计数（诊断用：长时间为 0 = QQ音乐根本没画文字，而不是钩子坏了）
setInterval(function () {
  send(JSON.stringify({ t: "fires", s18: fires.s18, s19: fires.s19 }));
}, 5000);
'''


def is_cjk(s):
    return any("\u4e00" <= ch <= "\u9fa5" for ch in s)


def looks_like_lyric(s):
    # 歌词行/封面文案：当作"还在放"的心跳，不当歌名候选
    prefixes = ("词：", "曲：", "作词", "作曲", "编曲", "♪", "纯音乐", "——", "--", "~~~")
    return s.startswith(prefixes)


class Paired:
    """把文本流配对成 (title, artist)，维护播放/暂停状态并输出 session"""

    def __init__(self, emit):
        self.emit = emit
        self.window = []            # [(t, s)] 待配对的候选（带时间戳：同帧校验要用）
        self.pending_until = 0.0    # "已开始播放"后的配对窗口
        self.cur = None             # {"title","artist"}
        self.playing = False
        self.started_at = 0.0       # monotonic 歌曲开始时刻
        self.paused_total = 0.0
        self.paused_at = 0.0
        self.last_activity = 0.0
        self.last_tick = None       # 上次进度秒数（回跳 = 换歌）
        self.recent = []            # [(ts, s)] 最近 5 秒画过的文本（回跳配对要用：歌名往往画在时间跳回之前）
        self.confirm_until = 0.0    # 配对后这段时间里歌词流 >=2 条 → 记"配对被证实"（观测）
        self.confirm_hits = 0

    def reset_soft(self):
        """重新 attach / 换进程时清掉跨进程的残留状态"""
        self.last_tick = None
        self.recent = []

    def _pos(self):
        if not self.playing:
            return int(self.paused_at - self.started_at - self.paused_total)
        return int(time.monotonic() - self.started_at - self.paused_total)

    def _emit(self, status):
        if not self.cur:
            return
        if not self.playing and status == "Paused":
            return  # 已经是暂停，别重复发
        if status == "Paused" and self.playing:
            self.paused_at = time.monotonic()
            self.playing = False
        elif status == "Playing" and not self.playing and self.cur:
            self.paused_total += time.monotonic() - self.paused_at
            self.playing = True
        self.emit({
            "t": "session", "status": status,
            "title": self.cur.get("title", ""), "artist": self.cur.get("artist", ""),
            "pos": max(0, self._pos()),
        })

    def on_tick(self, s=""):
        """进度时间心跳（纯音乐没有歌词，靠主窗口播放条的时间重绘知道"还在放"）"""
        self.last_activity = time.monotonic()
        sec = None
        if s and ":" in s:
            try:
                m, ss = s.split(":", 1)
                sec = int(m) * 60 + int(ss)
            except (ValueError, TypeError):
                sec = None
        if sec is not None:
            # 进度回跳（03:45 → 00:0x）= 换歌了。QQ 音乐的通知设置不一定弹"已开始播放"，
            # 这个兜底不依赖任何设置：换歌必然重置进度。歌名往往画在时间跳回之前，
            # 所以窗口里先塞进回跳前 5 秒内画过的文本（dedup 使它们不会再发一遍）。
            if self.last_tick is not None and sec < self.last_tick - 5:
                now = time.monotonic()
                self.pending_until = now + PAIR_WINDOW_SEC
                # 回跳的瞬间窗口里不一定已经有新歌名——把过去 5 秒画过的 CJK 文本回填进去（按时间顺序），
                # 等下一条文本到来时一起配对；下面的 tick() 也会在窗口过期时主动配一次。
                self.window = [(ts, s) for (ts, s) in self.recent if now - ts <= 5.0]
                self.log_window("tick-back")
            self.last_tick = sec
        if self.cur and not self.playing:
            self._emit("Playing")

    def log_window(self, tag):
        try:
            cs = [s for _, s in self.window]
            self.emit({"t": "log", "msg": f"pair[{tag}] window={cs[:6]}"})
        except Exception:
            pass

    def on_text(self, s):
        now = time.monotonic()
        self.last_activity = now
        if s == "已开始播放":
            self.pending_until = now + PAIR_WINDOW_SEC
            self.window = []
            return
        if s in UI_LABELS:
            return
        # 最近文本环（回跳配对的素材；所有 CJK 文本都进，含歌词——配对时靠顺序赌播放条先画）
        if is_cjk(s) and not looks_like_lyric(s):
            self.recent.append((now, s))
            cutoff = now - 5.0
            while self.recent and self.recent[0][0] < cutoff:
                self.recent.pop(0)
        if "暂停" in s:
            # 界面明说暂停了（桌面歌词/播放条会画），不用等超时
            if self.cur and self.playing:
                self._emit("Paused")
            return
        if looks_like_lyric(s):
            # 歌词在流 → 一定在放；暂停中的话恢复播放
            if self.cur and not self.playing:
                self._emit("Playing")
            # 配对后的歌词流计数：满 2 条 → 配对被歌词流证实
            if self.confirm_until and now < self.confirm_until:
                self.confirm_hits += 1
                if self.confirm_hits >= 2:
                    self.confirm_until = 0
                    try:
                        self.emit({"t": "log", "msg": f"pair confirmed: 配对后出现歌词流，title/artist 大概率配对了"})
                    except Exception:
                        pass
            return
        if not is_cjk(s):
            return

        if self.pending_until and now <= self.pending_until:
            # UI_LABELS 已经在上面过滤；looks_like_lyric 上面过滤（歌词不进配对候选）
            self.window.append((now, s))
            if now >= self.pending_until:
                self._pair()
            return
        # 非配对窗口里的普通文本：播放队列的 (歌名, 歌手) 行等，只当心跳
        if self.cur and not self.playing:
            self._emit("Playing")

    def _pair(self):
        self.pending_until = 0
        pairs = [(ts, s) for ts, s in self.window if s not in UI_LABELS and not looks_like_lyric(s)]
        self.window = []
        self.emit({"t": "log", "msg": f"pair cands={[s for _, s in pairs][:6]}"})
        if not pairs:
            return
        # 同帧校验：相邻候选间隔太大（>0.6s）说明不是同一批画的，"歌手在前歌名在后"的赌注不可信——
        # 只打日志不拒绝（真实数据攒起来才知道该不该放宽/收紧）
        gaps = [pairs[i + 1][0] - pairs[i][0] for i in range(len(pairs) - 1)]
        if any(g > PAIR_SAMEFRAME_GAP for g in gaps):
            self.emit({"t": "log", "msg": f"pair[gap] 候选间隔 {['%.2fs' % g for g in gaps]}，可能跨帧，配对可信度低"})
        cands = [s for _, s in pairs]
        # 约定：QQ音乐播放条重绘顺序 = 歌手在前、歌名在后（2026-09-23 实测）。
        # 多歌手时歌手串自带 " / "，可自证身份。
        artist = cands[0]
        title = cands[1] if len(cands) > 1 else artist
        if " / " in title and " / " not in artist:
            artist, title = title, artist
        self.cur = {"title": title, "artist": artist}
        self.started_at = time.monotonic()
        self.paused_total = 0.0
        self.playing = True
        # 开歌词确认观测窗（纯音乐不会有歌词流 → 一直不 confirm，正常）
        self.confirm_until = time.monotonic() + CONFIRM_WINDOW_SEC
        self.confirm_hits = 0
        self.emit({
            "t": "session", "status": "Playing",
            "title": title, "artist": artist, "pos": 0,
        })

    def tick(self, minimized=False):
        if minimized:
            # 最小化 = 文字层盲区（自绘 UI 一个字都不画），不是暂停：
            # 挂起"没动静=暂停"的判定，不然最小化 5 分钟回来就被记成暂停。
            # 代价：最小化期间手动暂停感知不到，恢复后 pos 会虚长一点。
            self.last_activity = time.monotonic()
            return
        # 窗口期到了但还没配对（典型：回跳回填了 recent，新文本迟迟不来）
        # → 主动配一次，否则配对被无限搁置
        if self.pending_until and time.monotonic() > self.pending_until and self.window:
            self._pair()
        # 长时间没有任何文本重绘 → 暂停（纯音乐/前奏也够用）
        if self.cur and self.playing and time.monotonic() - self.last_activity > IDLE_TO_PAUSE:
            self._emit("Paused")


def find_qqmusic():
    try:
        procs = frida.get_local_device().enumerate_processes()
    except AttributeError:  # 旧版 frida
        procs = frida.enumerate_processes()
    for proc in procs:
        if proc.name.lower() == "qqmusic.exe":
            return proc.pid
    return None


def qqmusic_minimized(pid):
    """QQ 音乐有没有可见且最小化的顶层窗口（收进托盘 = 全隐藏，不算，维持原超时口径）"""
    user32 = ctypes.windll.user32
    hit = {"minimized": False}
    proc_id = ctypes.c_ulong(pid)
    enum = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)

    def on_window(hwnd, _lparam):
        owner = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == proc_id and user32.IsWindowVisible(hwnd) and user32.IsIconic(hwnd):
            hit["minimized"] = True
            return 0  # 停止枚举
        return 1

    try:
        user32.EnumWindows(enum(on_window), 0)
    except Exception:
        return False
    return hit["minimized"]


def run():
    def out(obj):
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    kill_stale_daemon()   # 上一个桌宠崩溃留下的守护先清掉（frida 不能双挂同一进程）
    write_pid()
    paired = Paired(out)
    print(json.dumps({"t": "log", "msg": "daemon up"}, ensure_ascii=False), flush=True)

    while True:
        try:
            pid = find_qqmusic()
        except Exception as e:
            out({"t": "log", "msg": f"枚举进程失败（5 秒后重试）：{e}"})
            time.sleep(POLL_SEC)
            continue
        if pid is None:
            # QQ音乐不在：如果之前有歌，告诉状态机"停了"
            if paired.cur:
                paired._emit("Stopped")
                paired.cur = None
            time.sleep(POLL_SEC)
            continue
        try:
            session = frida.attach(pid)
        except Exception as e:
            out({"t": "log", "msg": f"attach 失败（5 秒后重试）：{e}"})
            time.sleep(POLL_SEC)
            continue

        stop = {"flag": False}

        def on_message(m, data):
            if m["type"] != "send":
                return
            try:
                j = json.loads(m["payload"])
            except Exception:
                return
            if j.get("t") == "dw":
                paired.on_text(j.get("s", ""))
            elif j.get("t") == "tick":
                paired.on_tick(j.get("s", ""))
            elif j.get("t") == "fires":
                out({"t": "log", "msg": f"fires s18={j.get('s18')} s19={j.get('s19')}"})
            elif j.get("t") == "log":
                out({"t": "log", "msg": "hook: " + str(j.get("msg", ""))})

        def on_detached(*_a):
            stop["flag"] = True

        try:
            script = session.create_script(JS_HOOK)
            script.on("message", on_message)
            script.load()
            session.on("detached", on_detached)
            paired.reset_soft()   # 新 attach：进度基线/文本环都是新进程的，别拿旧的当回跳
            out({"t": "log", "msg": f"attached pid={pid}"})
            # 最小化盲区的引导：node 侧只弹第一次（ musicCfg.qqmHintShown 管着），这里每次 attach 都发
            out({"t": "hint", "msg": "老版 QQ 音乐最小化后就读不到歌了（它不画字）——在 QQ 音乐里打开「桌面歌词」可以绕过这个盲区，歌词照样画、心跳不断"})
            while not stop["flag"]:
                time.sleep(1)
                paired.tick(qqmusic_minimized(pid))
                if find_qqmusic() != pid:   # 进程没了/换新实例
                    break
            if paired.cur:
                paired._emit("Stopped")
                paired.cur = None
            paired.reset_soft()
        except Exception as e:
            out({"t": "log", "msg": f"session 异常（5 秒后重试）：{e}"})
        finally:
            try:
                session.detach()
            except Exception:
                pass
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        pass
    finally:
        clear_pid()
