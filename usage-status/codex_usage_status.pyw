# -*- coding: utf-8 -*-
"""Codex 用量状态悬浮小窗（方案 A）

独立置顶小窗：Codex 启动时自动出现，关闭时自动隐藏；
实时读取本机 Codex 会话日志（token_count 事件），按"每个问题"显示
token 消耗、缓存命中率和估算费用。不改动 Codex 应用本体。
"""

import ctypes
import ctypes.wintypes
import glob
import json
import os
import subprocess
import sys
import threading
import time
import tkinter as tk
import datetime
from tkinter import font as tkfont

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SESSIONS_ROOT = os.path.join(os.path.expanduser("~"), ".codex", "sessions")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
LOG_DIR = os.path.join(BASE_DIR, "logs")
LOG_PATH = os.path.join(LOG_DIR, "usage-status.log")
BALANCE_URL = "https://api.deepseek.com/user/balance"
KEY_ENV = "DEEPSEEK_API_KEY"
KEY_FILES = [
    os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "reasonix", ".env"),
    r"E:\codex-work\cangku\inventory-reconciliation\.env",
]

# USD 每 1M token；来源：本地 Reasonix 配置（deepseek 官方单价）
PRICES = {
    "deepseek-v4-flash": {"input": 0.14, "cached": 0.0028, "output": 0.28},
    "deepseek-v4-pro": {"input": 0.435, "cached": 0.003625, "output": 0.87},
}
POLL_SEC = 1.5
PROCESS_NAMES = ["Codex Web GPT.exe", "codex.exe"]
MAX_QUESTION_HISTORY = 6
PANEL_W = 400

BG = "#202226"
FG = "#e8e8ea"
MUT = "#9aa0a6"
ACC = "#4fc3f7"
GOOD = "#66bb6a"


def log(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def cost_usd(model, inp, cached, out):
    p = PRICES.get(model)
    if not p:
        return None
    return ((max(inp - cached, 0) * p["input"]) + (cached * p["cached"]) + (out * p["output"])) / 1_000_000


def fmt_tokens(n):
    if n >= 1_000_000:
        return "%.2fM" % (n / 1_000_000)
    if n >= 1_000:
        return "%.1fK" % (n / 1_000)
    return str(n)


def fmt_usd(v):
    if v is None:
        return "—"
    if v == 0:
        return "$0.00"
    if v >= 1:
        return "$%.3f" % v
    if v >= 0.01:
        return "$%.4f" % v
    return "$%.5f" % v


def fmt_cny(v, rate):
    if v is None or not rate or rate <= 0:
        return "—"
    return "≈¥%.2f" % (v * rate)


def cache_pct(cached, inp):
    return (cached / inp * 100) if inp else 0.0


def set_dpi_aware():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


class SessionReader:
    """增量读取最新 Codex 会话 JSONL，维护会话/本问/上次请求统计。"""

    def __init__(self):
        self.path = None
        self.offset = 0
        self.pending = b""
        self._no_data = set()
        self.model = "deepseek-v4-flash"
        self.session_start = ""
        self.session_totals = {}
        self.last_req = None
        self.question = None  # {"no","input","cached","output","reqs"}
        self.question_no = 0
        self.questions = []   # 最近 MAX_QUESTION_HISTORY 个已完成问题

    def _candidates(self):
        out = []
        for p in glob.glob(os.path.join(SESSIONS_ROOT, "**", "rollout-*.jsonl"), recursive=True):
            try:
                st = os.stat(p)
            except OSError:
                continue
            out.append((p, st.st_mtime))
        out.sort(key=lambda x: -x[1])
        return [p for p, _ in out]

    def refresh(self):
        cands = self._candidates()
        if not cands:
            return
        if self.path and cands[0] == self.path:
            self._parse()
            return
        for p in cands:
            if p == self.path:
                self._parse()
                return
            if p in self._no_data:
                continue
            self._reset(p)
            self._parse()
            if self._has_data():
                log("session switch -> %s" % os.path.basename(p))
                return
            self._no_data.add(p)
            self._reset(None)
        # 全部无数据时，退回最新会话作为"等待中"
        self._reset(cands[0])
        self._parse()
        log("session switch -> %s (waiting)" % os.path.basename(cands[0]))

    def _reset(self, path):
        self.path = path
        self.offset = 0
        self.pending = b""
        self.model = "deepseek-v4-flash"
        self.session_totals = {}
        self.last_req = None
        self.question = None
        self.question_no = 0
        self.questions = []

    def _has_data(self):
        return bool(self.last_req or self.session_totals)

    def _parse(self):
        try:
            with open(self.path, "rb") as fh:
                fh.seek(self.offset)
                chunk = fh.read()
                self.offset += len(chunk)
        except OSError:
            return
        if not chunk:
            return
        data = self.pending + chunk
        lines = data.split(b"\n")
        self.pending = lines.pop()
        for raw in lines:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            self._handle(obj)

    def _handle(self, obj):
        typ = obj.get("type")
        payload = obj.get("payload") or {}
        if typ == "event_msg":
            ptype = payload.get("type")
            if ptype == "token_count":
                info = payload.get("info") or {}
                if info:
                    self._on_token(info)
            elif ptype == "thread_settings_applied":
                ts = payload.get("thread_settings") or {}
                m = ts.get("model")
                if m:
                    self.model = m
        elif typ == "response_item":
            if payload.get("role") == "user":
                self._on_question_boundary()

    def _on_question_boundary(self):
        if self.question is not None and self.question["reqs"] > 0:
            q = self.question
            q["cache_pct"] = cache_pct(q["cached"], q["input"])
            q["cost"] = cost_usd(self.model, q["input"], q["cached"], q["output"])
            self.questions.append(q)
            if len(self.questions) > MAX_QUESTION_HISTORY:
                self.questions = self.questions[-MAX_QUESTION_HISTORY:]
        self.question_no += 1
        self.question = {"no": self.question_no, "input": 0, "cached": 0, "output": 0, "reqs": 0, "cache_pct": 0.0, "cost": None}

    def _on_token(self, info):
        total = info.get("total_token_usage") or {}
        last = info.get("last_token_usage") or {}
        if total:
            self.session_totals = total
        if last:
            self.last_req = last
            if self.question is None:
                self._on_question_boundary()
            q = self.question
            q["input"] += int(last.get("input_tokens", 0))
            q["cached"] += int(last.get("cached_input_tokens", 0))
            q["output"] += int(last.get("output_tokens", 0))
            q["reqs"] += 1

    def snapshot(self):
        q = self.question
        if q is None:
            q = {"no": 0, "input": 0, "cached": 0, "output": 0, "reqs": 0, "cache_pct": 0.0, "cost": None}
        t = self.session_totals or {}
        tin = int(t.get("input_tokens", 0))
        tcached = int(t.get("cached_input_tokens", 0))
        tout = int(t.get("output_tokens", 0))
        return {
            "model": self.model,
            "question_no": self.question_no,
            "question": q,
            "session": {"input": tin, "cached": tcached, "output": tout, "total": int(t.get("total_tokens", 0))},
            "session_cost": cost_usd(self.model, tin, tcached, tout),
            "last_req": self.last_req,
            "questions": list(self.questions),
            "path": self.path,
        }


class BalanceFetcher:
    """读取 DeepSeek 账户余额（后台线程，每 60s 刷新，不泄露密钥）。"""

    def __init__(self):
        self._lock = threading.Lock()
        self.balance = None  # {"ok": bool, "currency": str, "total": str, "error": str}
        self._stop = False

    def _load_key(self):
        k = os.environ.get(KEY_ENV, "").strip()
        if k:
            return k
        for cand in KEY_FILES:
            try:
                with open(cand, "r", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        line = line.strip()
                        if line.startswith(KEY_ENV + "="):
                            v = line.split("=", 1)[1].strip().strip('"').strip("'")
                            if v:
                                return v
            except OSError:
                continue
        return ""

    def _set(self, val):
        with self._lock:
            self.balance = val

    def fetch_once(self):
        import urllib.request
        key = self._load_key()
        if not key:
            self._set({"ok": False, "currency": "", "total": "", "error": "no key"})
            return
        req = urllib.request.Request(BALANCE_URL, headers={"Authorization": "Bearer " + key})
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            infos = data.get("balance_infos") or []
            if infos:
                b = infos[0]
                self._set({"ok": True, "currency": str(b.get("currency", "")), "total": str(b.get("total_balance", "")), "error": ""})
                log("balance ok: %s %s" % (b.get("currency", ""), b.get("total_balance", "")))
            else:
                self._set({"ok": False, "currency": "", "total": "", "error": "no balance_infos"})
                log("balance fetch failed: no balance_infos")
        except Exception as exc:
            self._set({"ok": False, "currency": "", "total": "", "error": str(exc)[:120]})
            log("balance fetch failed: %s" % str(exc)[:120])

    def run_loop(self):
        while not self._stop:
            try:
                self.fetch_once()
            except Exception as exc:
                log("balance loop error: %s" % exc)
            time.sleep(60.0)


class DailyLedger:
    """增量统计今日/本周（周一起）DeepSeek 计费会话消耗；其余模型标 unpriced。"""

    def __init__(self):
        self._files = {}  # path -> {"mtime","size","offset","pending","input","cached","output","model"}
        self._lock = threading.Lock()
        self._stop = False
        self.today = 0.0
        self.week = 0.0
        self.today_tokens = 0
        self.week_tokens = 0
        self.unpriced = False
        self.ready = False
        self._last_log = None

    def _period_dirs(self):
        today = datetime.date.today()
        monday = today - datetime.timedelta(days=today.weekday())
        out = []
        for i in range(7):
            d = monday + datetime.timedelta(days=i)
            if d > today:
                break
            out.append((d.strftime("%Y/%m/%d"), d == today))
        return out

    def _parse_file(self, path, st):
        st_cur = self._files.get(path)
        if st_cur is None or st.st_size < st_cur.get("offset", 0):
            st_cur = {"offset": 0, "pending": b"", "input": 0, "cached": 0, "output": 0, "model": "deepseek-v4-flash"}
        st_cur["mtime"] = st.st_mtime
        st_cur["size"] = st.st_size
        try:
            with open(path, "rb") as fh:
                fh.seek(st_cur["offset"])
                chunk = fh.read()
                st_cur["offset"] += len(chunk)
        except OSError:
            return
        if chunk:
            data = st_cur["pending"] + chunk
            lines = data.split(b"\n")
            st_cur["pending"] = lines.pop()
            for raw in lines:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                p = obj.get("payload") or {}
                if obj.get("type") == "event_msg":
                    pt = p.get("type")
                    if pt == "thread_settings_applied":
                        m = (p.get("thread_settings") or {}).get("model")
                        if m:
                            st_cur["model"] = m
                    elif pt == "token_count":
                        info = p.get("info") or {}
                        total = info.get("total_token_usage") or {}
                        if total:
                            st_cur["input"] = int(total.get("input_tokens", 0))
                            st_cur["cached"] = int(total.get("cached_input_tokens", 0))
                            st_cur["output"] = int(total.get("output_tokens", 0))
        self._files[path] = st_cur

    def _tick(self):
        today_cost = 0.0
        week_cost = 0.0
        today_tok = 0
        week_tok = 0
        unpriced_models = set()
        for sub, is_today in self._period_dirs():
            base = os.path.join(SESSIONS_ROOT, *sub.split("/"))
            if not os.path.isdir(base):
                continue
            try:
                names = os.listdir(base)
            except OSError:
                continue
            for name in names:
                if not (name.startswith("rollout-") and name.endswith(".jsonl")):
                    continue
                path = os.path.join(base, name)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                cur = self._files.get(path)
                if cur is None or cur.get("size") != st.st_size or cur.get("mtime") != st.st_mtime:
                    self._parse_file(path, st)
                fin = self._files[path]
                c = cost_usd(fin["model"], fin["input"], fin["cached"], fin["output"])
                if c is None:
                    if fin["input"] + fin["output"] > 0:
                        unpriced_models.add(fin["model"])
                    continue
                tot = fin["input"] + fin["output"]
                if is_today:
                    today_cost += c
                    today_tok += tot
                week_cost += c
                week_tok += tot
        with self._lock:
            self.today = today_cost
            self.week = week_cost
            self.today_tokens = today_tok
            self.week_tokens = week_tok
            self.unpriced = len(unpriced_models) > 0
            self.ready = True

    def snapshot(self):
        with self._lock:
            return {
                "today": self.today,
                "week": self.week,
                "today_tokens": self.today_tokens,
                "week_tokens": self.week_tokens,
                "unpriced": self.unpriced,
                "ready": self.ready,
            }

    def run_loop(self):
        while not self._stop:
            try:
                self._tick()
                s = self.snapshot()
                if s["ready"]:
                    key = "today=%s week=%s unpriced=%s" % (fmt_usd(s["today"]), fmt_usd(s["week"]), s["unpriced"])
                    if key != self._last_log:
                        self._last_log = key
                        log("ledger: " + key)
            except Exception as exc:
                log("ledger error: %s" % exc)
            time.sleep(4.0)


class UsageStatusApp:
    def __init__(self):
        set_dpi_aware()
        self.root = tk.Tk()
        self.root.title("Codex 用量状态")
        self.root.overrideredirect(True)
        self.root.configure(bg=BG)
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.96)
        self.expanded = True
        self.pinned = True
        self.visible = False
        self.dock_auto = True
        self._drag = None
        self._last_render = None
        self.reader = SessionReader()
        self.balance = BalanceFetcher()
        self.ledger = DailyLedger()
        self._cfg = self._load_config()
        self._build_ui()
        self._bind_events()
        self._apply_config()
        threading.Thread(target=self.balance.run_loop, daemon=True).start()
        threading.Thread(target=self.ledger.run_loop, daemon=True).start()
        log("app started")

    # ---------- config ----------
    def _load_config(self):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            return {}

    def _save_config(self):
        cfg = {
            "x": self.root.winfo_x(),
            "y": self.root.winfo_y(),
            "expanded": self.expanded,
            "pinned": self.pinned,
            "dock_auto": self.dock_auto,
        }
        rate = self._cfg.get("usd_cny_rate")
        if rate is not None:
            cfg["usd_cny_rate"] = rate
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
                json.dump(cfg, fh, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def _apply_config(self):
        if "expanded" in self._cfg:
            self.expanded = bool(self._cfg["expanded"])
        if "pinned" in self._cfg:
            self.pinned = bool(self._cfg["pinned"])
            self.root.attributes("-topmost", self.pinned)
        if "dock_auto" in self._cfg:
            self.dock_auto = bool(self._cfg["dock_auto"])
        if "x" in self._cfg and "y" in self._cfg:
            self.root.geometry("+%d+%d" % (self._cfg["x"], self._cfg["y"]))
        self._clamp_to_screen()

    def _clamp_to_screen(self):
        """把窗口位置夹回屏幕可见范围内，防止拖出屏幕后“找不到”。"""
        try:
            sw = self.root.winfo_screenwidth()
            sh = self.root.winfo_screenheight()
            w = self.root.winfo_width()
            h = self.root.winfo_height()
            if w <= 1 or h <= 1:
                w, h = PANEL_W, 300
            x = max(0, min(self.root.winfo_x(), sw - w - 8))
            y = max(0, min(self.root.winfo_y(), sh - h - 8))
            self.root.geometry("+%d+%d" % (x, y))
        except Exception:
            pass

    # ---------- UI ----------
    def _build_ui(self):
        self._base_font = tkfont.nametofont("TkDefaultFont")
        self._base_font.configure(family="Microsoft YaHei UI", size=9)
        self._mono = tkfont.Font(family="Consolas", size=9)
        self._mono_s = tkfont.Font(family="Consolas", size=8)

        self.frame = tk.Frame(self.root, bg=BG, bd=1, relief="solid", highlightbackground="#3a3d43", highlightthickness=1)
        self.frame.pack(fill="both", expand=True)

        # 头行：模型 + 置顶/折叠/退出
        self.head = tk.Frame(self.frame, bg=BG)
        self.head.pack(fill="x", padx=8, pady=(5, 2))
        self.dot = tk.Label(self.head, text="●", bg=BG, fg=GOOD, font=self._mono_s)
        self.dot.pack(side="left")
        self.model_lbl = tk.Label(self.head, text="model", bg=BG, fg=FG, font=self._mono)
        self.model_lbl.pack(side="left", padx=(4, 8))
        self.btn_pin = tk.Label(self.head, text="顶", bg=BG, fg=MUT, font=self._base_font, cursor="hand2")
        self.btn_pin.pack(side="right", padx=(0, 4))
        self.btn_fold = tk.Label(self.head, text="−", bg=BG, fg=MUT, font=self._base_font, cursor="hand2")
        self.btn_fold.pack(side="right", padx=(0, 4))
        self.btn_close = tk.Label(self.head, text="✕", bg=BG, fg=MUT, font=self._base_font, cursor="hand2")
        self.btn_close.pack(side="right", padx=(0, 4))

        # 内容区（grid 对齐：标签 / Token / 缓存 / 费用）
        self.body = tk.Frame(self.frame, bg=BG)
        self.body.pack(fill="x", padx=10, pady=(0, 4))
        self.body.grid_columnconfigure(1, weight=1)

        self.lbl_question = tk.Label(self.body, text="本问 —", bg=BG, fg=FG, font=self._mono, anchor="w")
        self.lbl_question.grid(row=0, column=0, columnspan=4, sticky="we", pady=(0, 3))

        self.lbl_last_tag = tk.Label(self.body, text="上次请求", bg=BG, fg=MUT, font=self._mono_s, anchor="w", width=8)
        self.lbl_last_tag.grid(row=1, column=0, sticky="w", pady=1)
        self.lbl_last = tk.Label(self.body, text="—", bg=BG, fg=MUT, font=self._mono_s, anchor="w")
        self.lbl_last.grid(row=1, column=1, columnspan=3, sticky="we", pady=1)

        self.lbl_session_tag = tk.Label(self.body, text="会话累计", bg=BG, fg=MUT, font=self._mono_s, anchor="w", width=8)
        self.lbl_session_tag.grid(row=2, column=0, sticky="w", pady=1)
        self.lbl_session = tk.Label(self.body, text="—", bg=BG, fg=MUT, font=self._mono_s, anchor="w")
        self.lbl_session.grid(row=2, column=1, columnspan=3, sticky="we", pady=1)

        self.lbl_cache = tk.Canvas(self.body, width=16, height=6, bg=BG, highlightthickness=0)
        self.lbl_cache.grid(row=3, column=0, columnspan=4, sticky="we", pady=(3, 5))

        self.list_frame = tk.Frame(self.body, bg=BG)
        self.list_frame.grid(row=4, column=0, columnspan=4, sticky="we")
        self.history_rows = []
        self.history_lbls = []
        for r in range(MAX_QUESTION_HISTORY):
            no = tk.Label(self.list_frame, text="", bg=BG, fg=MUT, font=self._mono_s, anchor="e", width=4)
            no.grid(row=r, column=0, sticky="e", padx=(0, 6), pady=1)
            tok = tk.Label(self.list_frame, text="", bg=BG, fg=MUT, font=self._mono_s, anchor="e", width=10)
            tok.grid(row=r, column=1, sticky="e", padx=(0, 10), pady=1)
            cac = tk.Label(self.list_frame, text="", bg=BG, fg=MUT, font=self._mono_s, anchor="w", width=9)
            cac.grid(row=r, column=2, sticky="w", padx=(0, 10), pady=1)
            fee = tk.Label(self.list_frame, text="", bg=BG, fg=MUT, font=self._mono_s, anchor="e", width=9)
            fee.grid(row=r, column=3, sticky="e", pady=1)
            self.history_rows.append((no, tok, cac, fee))
            self.history_lbls += [no, tok, cac, fee]

        self.sep = tk.Frame(self.frame, bg="#3a3d43", height=1)
        self.sep.pack(fill="x", padx=8, pady=(3, 0))
        self.footer = tk.Frame(self.frame, bg=BG)
        self.footer.pack(fill="x", padx=10, pady=(4, 6))
        self.footer.grid_columnconfigure(1, weight=1)
        self.lbl_balance_tag = tk.Label(self.footer, text="余额", bg=BG, fg=MUT, font=self._mono_s, anchor="w", width=8)
        self.lbl_balance_tag.grid(row=0, column=0, sticky="w", pady=1)
        self.lbl_balance = tk.Label(self.footer, text="—", bg=BG, fg=FG, font=self._mono, anchor="e")
        self.lbl_balance.grid(row=0, column=1, sticky="e", pady=1)
        self.lbl_period_tag = tk.Label(self.footer, text="消费", bg=BG, fg=MUT, font=self._mono_s, anchor="w", width=8)
        self.lbl_period_tag.grid(row=1, column=0, sticky="w", pady=1)
        self.lbl_period = tk.Label(self.footer, text="今日 — · 本周 —", bg=BG, fg=MUT, font=self._mono_s, anchor="e")
        self.lbl_period.grid(row=1, column=1, sticky="e", pady=1)
        self.lbl_tokens_tag = tk.Label(self.footer, text="本周", bg=BG, fg=MUT, font=self._mono_s, anchor="w", width=8)
        self.lbl_tokens_tag.grid(row=2, column=0, sticky="w", pady=1)
        self.lbl_tokens = tk.Label(self.footer, text="—", bg=BG, fg=MUT, font=self._mono_s, anchor="e")
        self.lbl_tokens.grid(row=2, column=1, sticky="e", pady=1)

        self.btn_pin.config(fg=ACC if self.pinned else MUT)
        self._refresh_visibility()

    def _refresh_visibility(self):
        if self.expanded:
            self.body.pack(fill="x", padx=10, pady=(0, 4))
            self.btn_fold.config(text="−")
        else:
            self.body.pack_forget()
            self.btn_fold.config(text="+")
        self._fit_size()

    def _fit_size(self):
        try:
            self.root.update_idletasks()
            self.root.geometry("%dx%d" % (PANEL_W, self.root.winfo_reqheight()))
        except Exception:
            pass

    def _bind_events(self):
        for w in (self.frame, self.head, self.dot, self.model_lbl):
            self._bind_drag(w)
        self.btn_pin.bind("<Button-1>", lambda e: self._toggle_pin())
        self.btn_fold.bind("<Button-1>", lambda e: self._toggle_expand())
        self.btn_close.bind("<Button-1>", lambda e: self._quit())
        self.root.bind_all("<Button-3>", self._show_menu)
        for w in (self.lbl_question, self.lbl_last, self.lbl_session) + tuple(self.history_lbls):
            w.bind("<Double-Button-1>", lambda e: self._toggle_expand())
        self.root.protocol("WM_DELETE_WINDOW", self._quit)

    def _bind_drag(self, widget):
        widget.bind("<ButtonPress-1>", self._drag_start)
        widget.bind("<B1-Motion>", self._drag_move)
        widget.bind("<ButtonRelease-1>", self._drag_end)

    def _drag_start(self, e):
        self._drag = (e.x_root - self.root.winfo_x(), e.y_root - self.root.winfo_y())

    def _drag_move(self, e):
        if self._drag:
            self.root.geometry("+%d+%d" % (e.x_root - self._drag[0], e.y_root - self._drag[1]))
            self.dock_auto = False

    def _drag_end(self, e):
        self._drag = None
        self._save_config()

    def _show_menu(self, e):
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label="定位到 Codex 输入框上方", command=self._dock)
        menu.add_command(label="折叠/展开", command=self._toggle_expand)
        menu.add_separator()
        menu.add_command(label="打开会话目录", command=lambda: os.startfile(SESSIONS_ROOT))
        menu.add_command(label="打开日志目录", command=lambda: os.startfile(LOG_DIR))
        menu.add_separator()
        menu.add_command(label="退出小窗（不卸载）", command=self._quit)
        try:
            menu.tk_popup(e.x_root, e.y_root)
        finally:
            menu.grab_release()

    def _toggle_pin(self):
        self.pinned = not self.pinned
        self.root.attributes("-topmost", self.pinned)
        self.btn_pin.config(fg=ACC if self.pinned else MUT)
        self._save_config()

    def _toggle_expand(self):
        self.expanded = not self.expanded
        self._refresh_visibility()
        self._save_config()

    def _quit(self):
        self._save_config()
        log("app exit")
        self.root.destroy()

    # ---------- Codex 检测与定位 ----------
    def _codex_running(self):
        for name in PROCESS_NAMES:
            try:
                out = subprocess.run(
                    ["tasklist", "/FI", "IMAGENAME eq " + name, "/FO", "CSV", "/NH"],
                    capture_output=True, text=True, timeout=5,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                ).stdout
                if name.lower() in out.lower():
                    return True
            except Exception:
                pass
        return False

    def _codex_rect(self):
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        def process_name(pid):
            try:
                h = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
                if not h:
                    return ""
                buf = ctypes.create_unicode_buffer(512)
                size = ctypes.c_ulong(512)
                ok = kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
                kernel32.CloseHandle(h)
                return os.path.basename(buf.value).lower() if ok else ""
            except Exception:
                return ""

        EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        best = None
        best_score = -1
        best_area = 0

        def cb(hwnd, _):
            nonlocal best, best_score, best_area
            if not user32.IsWindowVisible(hwnd):
                return True
            wpid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
            title_buf = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, title_buf, 512)
            title = title_buf.value
            r = ctypes.wintypes.RECT()
            if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
                return True
            w = r.right - r.left
            h = r.bottom - r.top
            if w < 400 or h < 300:
                return True
            pname = process_name(wpid.value)
            tlow = title.lower()
            score = 0
            if "codex" in pname:
                score += 2
            if "codex" in tlow:
                score += 2
            if "chatgpt" in tlow:
                score += 1
            area = w * h
            if score > best_score or (score == best_score and score > 0 and area > best_area):
                best = (r.left, r.top, r.right, r.bottom)
                best_score = score
                best_area = area
            return True

        user32.EnumWindows(EnumWindowsProc(cb), 0)
        return best if best_score > 0 else None

    def _dock(self):
        rect = self._codex_rect()
        if not rect:
            return
        w = self.root.winfo_width()
        h = self.root.winfo_height()
        if w <= 1 or h <= 1:
            w, h = 420, 190
        x = rect[0] + 16
        y = rect[3] - h - 150  # 输入框上方
        if y < rect[1]:
            y = rect[1] + 8
        self.root.geometry("+%d+%d" % (x, y))
        self.dock_auto = False
        self._save_config()

    def _show_window(self):
        if not self.visible:
            self.root.deiconify()
            self.root.lift()
            self.visible = True
            self._fit_size()
            if self.dock_auto:
                self._dock()
            self.root.update_idletasks()
            self._clamp_to_screen()
            log("shown (codex running) geo=%dx%d+%d+%d" % (
                self.root.winfo_width(), self.root.winfo_height(),
                self.root.winfo_x(), self.root.winfo_y()))

    def _force_topmost(self):
        """强制置顶（HWND_TOPMOST 强化）：即使 Codex 全屏/抢焦点，面板仍在上层。"""
        try:
            hwnd = self.root.winfo_id()
            hwnd = ctypes.windll.user32.GetParent(hwnd) if ctypes.windll.user32.GetParent(hwnd) else hwnd
            SWP_NOSIZE = 0x0001
            SWP_NOMOVE = 0x0002
            SWP_NOACTIVATE = 0x0010
            HWND_TOPMOST = -1
            ctypes.windll.user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                                              SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)
            log("topmost reinforced")
        except Exception as exc:
            log("topmost error: %s" % exc)

    def _hide_window(self):
        if self.visible:
            self.root.withdraw()
            self.visible = False
            log("hidden (codex not running)")

    # ---------- 渲染 ----------
    def _render(self, s):
        q = s["question"]
        ses = s["session"]
        qcost = cost_usd(s["model"], q["input"], q["cached"], q["output"])
        qcache = cache_pct(q["cached"], q["input"])
        rate = float(self._cfg.get("usd_cny_rate", 6.75))

        self.model_lbl.config(text=s["model"])
        if q["reqs"]:
            self.lbl_question.config(
                text="本问 #%-2d  %s  缓存 %3.0f%%  %s"
                % (q["no"], fmt_tokens(q["input"] + q["output"]), qcache, fmt_cny(qcost, rate))
            )
        else:
            self.lbl_question.config(text="本问 #%-2d  等待请求…" % s["question_no"])

        lr = s["last_req"]
        if lr:
            li = int(lr.get("input_tokens", 0))
            lc = int(lr.get("cached_input_tokens", 0))
            lo = int(lr.get("output_tokens", 0))
            self.lbl_last.config(
                text="输入 %s · 缓存 %3.0f%% · 输出 %s"
                % (fmt_tokens(li), cache_pct(lc, li), fmt_tokens(lo))
            )
        else:
            self.lbl_last.config(text="—")

        ses_total = ses["input"] + ses["output"]
        ses_cost = s["session_cost"]
        self.lbl_session.config(
            text="%s · 缓存 %3.0f%% · %s"
            % (fmt_tokens(ses_total), cache_pct(ses["cached"], ses["input"]), fmt_cny(ses_cost, rate))
        )

        # 缓存命中条
        self.lbl_cache.delete("all")
        pct = qcache if q["reqs"] else 0.0
        cw = self.lbl_cache.winfo_width()
        if cw <= 1:
            cw = PANEL_W - 40
        ch = 6
        self.lbl_cache.create_rectangle(0, 0, cw, ch, fill="#383b41", outline="")
        self.lbl_cache.create_rectangle(0, 0, int(cw * pct / 100), ch, fill=GOOD, outline="")

        for i, (no, tok, cac, fee) in enumerate(self.history_rows):
            if i < len(s["questions"]):
                hq = s["questions"][len(s["questions"]) - 1 - i]
                no.config(text="#%d" % hq["no"], fg=MUT)
                tok.config(text=fmt_tokens(hq["input"] + hq["output"]), fg=FG if i == 0 else MUT)
                cac.config(text="缓存%3.0f%%" % hq["cache_pct"], fg=GOOD if hq["cache_pct"] >= 90 else MUT)
                fee.config(text=fmt_cny(hq["cost"], rate), fg=FG if i == 0 else MUT)
            else:
                no.config(text="")
                tok.config(text="")
                cac.config(text="")
                fee.config(text="")

        summary = "%s q#%d in=%s cache=%.0f%% out=%s cost=%s sess=%s/%s" % (
            s["model"], s["question_no"], fmt_tokens(q["input"] + q["output"]),
            qcache, fmt_tokens(q["output"]), fmt_usd(qcost),
            fmt_tokens(ses["input"] + ses["output"]), fmt_usd(ses_cost))
        if summary != self._last_render:
            self._last_render = summary
            log("render: " + summary)

        b = self.balance.balance
        if b and b.get("ok") and b.get("total"):
            cur = b.get("currency", "")
            prefix = "¥" if cur == "CNY" else (cur + " " if cur else "")
            self.lbl_balance.config(text="%s%s" % (prefix, b.get("total")))
        else:
            self.lbl_balance.config(text="—")
        led = self.ledger.snapshot()
        mark = "*" if led["unpriced"] else ""
        self.lbl_period.config(text="今日 %s · 本周 %s%s" % (fmt_cny(led["today"], rate), fmt_cny(led["week"], rate), mark))
        self.lbl_tokens.config(text="%s（官方 usage 汇总）" % fmt_tokens(led["week_tokens"]))

    def _poll(self):
        try:
            running = self._codex_running()
            if running:
                self._show_window()
                self._force_topmost()
                self.reader.refresh()
                self._render(self.reader.snapshot())
            else:
                self._hide_window()
        except Exception as exc:
            log("poll error: %s" % exc)
        self.root.after(int(POLL_SEC * 1000), self._poll)

    def run(self):
        self._poll()
        self.root.mainloop()


def main():
    if sys.platform != "win32":
        log("not supported on this platform")
        return
    app = UsageStatusApp()
    app.run()


if __name__ == "__main__":
    main()
