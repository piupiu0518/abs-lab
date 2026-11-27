#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ABS-LAB 第 0 批端到端测试（SPEC §11.C；选择器、钩子、data-state 见 CONTRACT §6.3 / §6.6 / §7 / §8 / §9）。

用法（在仓库根目录或任意目录）：
    python3 tests/e2e_batch0.py                       # 全部场景
    python3 tests/e2e_batch0.py --only closed_loop,stable
    python3 tests/e2e_batch0.py --headed --keep

场景：offline、mobile_drag、closed_loop、stable、mastery、guest、edge、regression。
每个检查打印一行 PASS / FAIL + 原因，最后打印汇总表；有任何失败退出码为 1。
截图（失败时，和少量成功时）放在 tests/__out__/（已在 .gitignore 里，不提交）；dev-server 的输出也写在那里。

为什么这样写：
  - 自己启动 node tools/dev-server.js（默认端口 8090，通过 /abs-lab/ 子路径访问），和线上一样走子路径，
    能发现以 "/" 开头的绝对路径；dev-server 的 Redis 是内存模拟，每次启动都是空库，所以账号名每次随机生成。
  - 「跳天」靠改浏览器时钟：context.clock.set_fixed_time() 只冻结 Date，定时器和 rAF 照常走（拖动要用），
    而且必须在 goto 之前调用。题目记录里的日期 d 是学生设备的本地日期，服务器只校验格式，所以这样能测重测排期。
  - 只用 Python 标准库 + Playwright（sync API），不需要再装别的包。
"""

import argparse
import datetime
import json
import math
import os
import random
import re
import subprocess
import sys
import time
import traceback
import urllib.request
from urllib.parse import urlparse

try:
    from playwright.sync_api import sync_playwright, expect
    from playwright.sync_api import Error as PWError
    from playwright.sync_api import TimeoutError as PWTimeout
except ImportError:  # 装不了 Playwright 时给出明确提示（SPEC §11：照写测试、标「未运行」）
    print("未运行：没有安装 Python Playwright（pip install playwright && python3 -m playwright install chromium）")
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.path.join(HERE, "__out__")

# 上海没有夏令时，固定 +8 即可，不依赖系统 tzdata
TZ8 = datetime.timezone(datetime.timedelta(hours=8))

SCENARIOS = ["offline", "mobile_drag", "closed_loop", "stable", "mastery", "guest", "edge", "regression"]

PASSWORD = "pass1234"
QID_POE = "m-dd-area-poe"
QID_TT = "m-dd-st-twotier"
QID_TR = "m-dd-area-transfer"
QID_INV = "m-dd-area-inverse"
# 没有标签、按题记的错题 id（core.qzId：题目 id 去掉非字母数字）
QZ_POE = "qz-mddareapoe"
QZ_TT = "qz-mddsttwotier"
# 能在重测页出的三道题的正确答案（答案、理由），重测里出到哪道就答哪道
RIGHT = {QID_TT: ("b", "r2"), QID_TR: ("a", "r1"), QID_INV: ("a", "r1"),
         # 第 1 批 A 的 math-m1.json 里也有带 graphaspath、可以重测的题，重测页按选题规则可能出它们
         "m-m1-tt-walk": ("a", "r1"), "m-m1-tt-fill": ("a", "r1"), "m-m1-inv-sides": ("a", "r1")}
# 上面这些题的情境（与题库里的 context 一致）
RIGHT_CTX = {QID_TT: "距离—时间读图", QID_TR: "动点面积", QID_INV: "动点面积",
             "m-m1-tt-walk": "先走平路再爬坡", "m-m1-tt-fill": "向下细上粗的容器注水", "m-m1-inv-sides": "由图象反推边长"}
TAG = "graphaspath"
TAG_NAME = "图象即轨迹"
# 解释至少 6 个字（math-demo.json 里 explain.min = 6），写一句完整的中文
EXPLAIN = "因为底边AB和高BC都没有变，所以三角形面积不变"

# SPEC §11.C.1 要求逐页打开的页面
OFFLINE_PAGES = [
    "index.html",
    "math/index.html", "physics/index.html", "chemistry/index.html", "biology/index.html",
    "math/knowledge-map.html", "physics/knowledge-map.html", "chemistry/knowledge-map.html", "biology/knowledge-map.html",
    "physics/circuits-lab.html", "physics/hs-electricity.html", "chemistry/neutralization.html", "biology/microscope.html",
    "math/demo-poe.html", "math/svgkit-demo.html", "review.html",
]
# 本批新增的页面：390px 下不得出现横向滚动（CONTRACT §0）；旧页面只报告，不判失败
NEW_PAGES = ("math/demo-poe.html", "math/svgkit-demo.html", "review.html")

# CONTRACT §9 的基线（main 上测得：1280×900、游客、等 2 秒；只数祖先链上没有 display:none 的 .lk-chip）。
# 第 1 批 A 按任务书第 6.6 节新增了 7 条关联：物理 k4 → circuits-m3、k6 → circuits-m13（+2），
# 数学 c23-4-2 → mpoint-rect / mpoint-time、c22-2-2 → mpoint-rect、c26-1-1 → mpoint-pq、c26-4-1 → mpoint-pq（+5）；
# 第 0 批时物理 47 / 48、数学 7。其余学科不变。
# 第 1 批 B 又新增了 15 条关联（任务书 1B 第 7.2 节）：数学 +4（c26-2-2、c26-2-4、c26-4-1、c26-2-5 → quad-*），
# 化学 +11（u9-k3～k6 → solub-*、u10-k6～k10 → solute-*）；第 1 批 A 之后是化学 4 / 7、数学 12
BASELINE = {
    "physics": {"default": 49, "hs": 50},
    "chemistry": {"default": 15, "hs": 18},
    "math": {"default": 16, "hs": None},
    "biology": {"default": 13, "hs": None},
}
# 有测试题的知识点（第 1 批 A 起物理也有：physics-pa.json、physics-pe.json）
QUIZ_CHIPS = {
    "math": ["math:c22-2-2", "math:c23-4-2", "math:c26-1-1",
             # 第 1 批 B：math-m2.json
             "math:c26-2-2", "math:c26-2-4", "math:c26-2-5", "math:c26-4-1"],
    "physics": ["physics:e2", "physics:k3", "physics:k4", "physics:k6", "physics:k7", "physics:k8", "physics:k10"],
    # 第 1 批 B：chemistry-cb.json、chemistry-cc.json
    "chemistry": ["chemistry:u9-k3", "chemistry:u9-k4", "chemistry:u9-k5", "chemistry:u9-k6",
                  "chemistry:u10-k6", "chemistry:u10-k7", "chemistry:u10-k8", "chemistry:u10-k9", "chemistry:u10-k10"],
    "biology": [],
}
# 测试标签链到这个知识点在题库里的第一道题所在的页面（题库文件按文件名排序：math-demo.json 在 math-m1.json 前面）
QUIZ_PAGES = {"math:c22-2-2": "math/demo-poe.html", "math:c23-4-2": "math/demo-poe.html", "math:c26-1-1": "math/moving-point.html",
              # 第 1 批 B：这四个知识点的第一道题都在 math-m2.json 里
              "math:c26-2-2": "math/quadratic.html", "math:c26-2-4": "math/quadratic.html",
              "math:c26-2-5": "math/quadratic.html", "math:c26-4-1": "math/quadratic.html"}

# 拖动路线 B→C→D（世界坐标），P 必须一直在这条折线上
POLY = [(0.0, 0.0), (6.0, 0.0), (6.0, 4.0)]

# 注入每个页面的测试辅助函数（只读，不改页面状态）。在页面脚本之前运行，导航后自动重新注入。
HELPER_JS = r"""
(function () {
  if (window.__e2e) return;
  var H = {};
  function lastCard(qid) {
    var cs = document.querySelectorAll('.qz-card[data-qid="' + qid + '"]');
    return cs.length ? cs[cs.length - 1] : null;
  }
  H.card = lastCard;
  // CONTRACT §7：部件把测试钩子挂在 factory 的 el 上（el.__ddArea）；el 可能是 .qz-widget 本身或它里面的元素
  H.ddHost = function (qid) {
    var c = lastCard(qid || "m-dd-area-poe");
    if (!c) return null;
    var all = [c].concat(Array.prototype.slice.call(c.querySelectorAll("*")));
    for (var i = 0; i < all.length; i++) if (all[i].__ddArea && all[i].__ddArea.board) return all[i];
    return null;
  };
  H.dd = function (qid) { var h = H.ddHost(qid); return h ? h.__ddArea : null; };
  H.ddGet = function (qid) { var d = H.dd(qid); return d ? d.get() : null; };
  // 世界坐标 → 视口坐标（CSS px）：board.toScreen 给 svg 内坐标，再用 getScreenCTM 换到视口（和 svgkit 自己的换算一致）
  H.toClient = function (xy, qid) {
    var d = H.dd(qid); var b = d.board; var s = b.toScreen(xy); var svg = b.svg;
    var m = svg.getScreenCTM ? svg.getScreenCTM() : null;
    if (m && svg.createSVGPoint) { var p = svg.createSVGPoint(); p.x = s[0]; p.y = s[1]; p = p.matrixTransform(m); return [p.x, p.y]; }
    var r = svg.getBoundingClientRect(); return [r.left + s[0], r.top + s[1]];
  };
  H.toClientMany = function (pts, qid) { return pts.map(function (p) { return H.toClient(p, qid); }); };
  H.record = function (qid) {
    var c = lastCard(qid); if (!c) return null;
    var r = c.querySelector(".qz-record"); if (!r) return { state: null, text: "" };
    return { state: r.getAttribute("data-state"), text: (r.textContent || "").replace(/\s+/g, " ").trim() };
  };
  H.stage = function (qid) { var c = lastCard(qid); return c ? c.getAttribute("data-stage") : null; };
  H.isShown = function (el) {
    for (var p = el; p && p !== document.documentElement; p = p.parentElement) {
      if (getComputedStyle(p).display === "none") return false;
    }
    return true;
  };
  // 与 CONTRACT §9 基线脚本同一种数法
  H.chips = function () {
    var all = Array.prototype.slice.call(document.querySelectorAll(".lk-chip"));
    var shown = all.filter(function (el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) { if (getComputedStyle(p).display === "none") return false; }
      return true;
    });
    var kinds = {}, quiz = [];
    shown.forEach(function (c) {
      var k = c.getAttribute("data-kind") || "?"; kinds[k] = (kinds[k] || 0) + 1;
      if (k === "quiz") quiz.push({ ref: c.getAttribute("data-lk-quiz"), text: (c.textContent || "").replace(/\s+/g, " ").trim(), href: c.getAttribute("href") || "" });
    });
    return { dom: all.length, shown: shown.length, nonquiz: shown.length - (kinds.quiz || 0), kinds: kinds, quiz: quiz };
  };
  H.chipText = function (ref) {
    var c = document.querySelector('a.lk-chip[data-kind="quiz"][data-lk-quiz="' + ref + '"]');
    return c ? (c.textContent || "").replace(/\s+/g, " ").trim() : null;
  };
  window.__e2e = H;
})();
"""

API_JS = r"""async ([url, method, body]) => {
  var A = window.ABSLabAuth;
  var t = A && A.getToken ? A.getToken() : null;
  var h = { Authorization: "Bearer " + t };
  if (body) h["Content-Type"] = "application/json";
  var r = await fetch(url, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  var txt = await r.text(); var j = null;
  try { j = JSON.parse(txt); } catch (e) {}
  return { status: r.status, json: j, text: txt.slice(0, 300) };
}"""


class StepFail(Exception):
    """前置步骤失败：这个场景后面的检查都没法做，直接中止（已记为 FAIL）。"""


def fmt_md(d):
    # 与 core.fmtMD 一致：「11 月 25 日」
    return "%d 月 %d 日" % (d.month, d.day)


def iso(d):
    return d.strftime("%Y-%m-%d")


def dist_to_poly(px, py):
    best = float("inf")
    for (ax, ay), (bx, by) in zip(POLY, POLY[1:]):
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        qx, qy = ax + t * dx, ay + t * dy
        best = min(best, math.hypot(px - qx, py - qy))
    return best


def short(s, n=160):
    s = re.sub(r"\s+", " ", str(s)).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


class Runner:
    def __init__(self, args, browser, base):
        self.args = args
        self.browser = browser
        self.base = base
        self.rows = []          # (scenario, check, ok, reason)
        self.scen = ""
        self.contexts = []
        self.last_page = None
        self.page_errors = []   # 非 offline 场景里页面的 console.error / pageerror，只作参考信息
        self.state = {}         # 场景之间共享（例如账号 A 给 regression 用）
        self.D = datetime.datetime.now(TZ8).date()
        self.shots = 0
        self.mobile = {}       # id(context) → 是不是手机触屏上下文（决定拖动用触屏还是鼠标）

    # ---------- 记录 ----------
    def check(self, name, ok, reason="", page=None):
        ok = bool(ok)
        self.rows.append((self.scen, name, ok, reason))
        print("%s  %-12s %-34s %s" % ("PASS" if ok else "FAIL", self.scen, name, short(reason, 400)), flush=True)
        if not ok and page is not None:
            self.shot(page, "FAIL_" + name)
        return ok

    def require(self, name, ok, reason="", page=None):
        if not self.check(name, ok, reason, page):
            raise StepFail("%s: %s" % (name, reason))

    def info(self, msg):
        print("INFO  %-12s %s" % (self.scen, short(msg, 400)), flush=True)

    def shot(self, page, label):
        try:
            safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", label)[:80]
            path = os.path.join(OUT, "e2e_%s_%s.png" % (self.scen, safe))
            page.screenshot(path=path, full_page=False, timeout=10000)
            self.shots += 1
            return path
        except Exception as e:  # 截图失败不影响结论
            self.info("截图失败 %s: %s" % (label, e))
            return None

    # ---------- 浏览器 ----------
    def url(self, path):
        return self.base + path

    def new_context(self, mobile=False, extra=None):
        kw = dict(locale="zh-CN", timezone_id="Asia/Shanghai")
        if mobile:
            kw.update(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            kw.update(viewport={"width": 1280, "height": 900})
        if extra:
            kw.update(extra)
        ctx = self.browser.new_context(**kw)
        ctx.set_default_timeout(15000)
        ctx.set_default_navigation_timeout(30000)
        ctx.add_init_script(HELPER_JS)
        self.mobile[id(ctx)] = mobile
        self.contexts.append(ctx)
        return ctx

    def new_page(self, ctx, track_errors=True):
        page = ctx.new_page()
        self.last_page = page
        if track_errors:
            scen = self.scen

            def on_console(msg):
                if msg.type == "error":
                    self.page_errors.append((scen, "console.error", page.url, msg.text))

            def on_pageerror(err):
                self.page_errors.append((scen, "pageerror", page.url, str(err)))

            page.on("console", on_console)
            page.on("pageerror", on_pageerror)
        return page

    def set_day(self, ctx, n):
        # 必须在导航之前调用：只冻结 Date（设备本地日期），定时器、rAF 照常走
        d = self.D + datetime.timedelta(days=n)
        ctx.clock.set_fixed_time(datetime.datetime(d.year, d.month, d.day, 12, 0, 0, tzinfo=TZ8))
        return d

    def day(self, n):
        return self.D + datetime.timedelta(days=n)

    def close_contexts(self):
        for c in self.contexts:
            try:
                c.close()
            except Exception:
                pass
        self.contexts = []

    # ---------- 账号与接口 ----------
    def new_user(self, letter):
        # 用户名 2～20 个字符；dev-server 每次启动是空库，加随机数避免同一进程里重名
        return "e2e%s%06d" % (letter, random.randint(0, 999999))

    def register(self, page, name):
        res = page.evaluate("async ([n, p]) => await window.ABSLabAuth.register(n, p)", [name, PASSWORD])
        ok = bool(res and res.get("ok") and res.get("cloud"))
        self.require("register", ok, "ABSLabAuth.register(%s) → %s" % (name, json.dumps(res, ensure_ascii=False)), page)
        page.reload(wait_until="load")
        tok = page.evaluate("() => window.ABSLabAuth && window.ABSLabAuth.getToken()")
        self.require("register.token", bool(tok), "登录后 getToken() 有值", page)

    def login(self, page, name):
        res = page.evaluate("async ([n, p]) => await window.ABSLabAuth.login(n, p)", [name, PASSWORD])
        ok = bool(res and res.get("ok") and res.get("cloud"))
        self.require("login", ok, "ABSLabAuth.login(%s) → %s" % (name, json.dumps(res, ensure_ascii=False)), page)
        page.reload(wait_until="load")

    def api(self, page, name, method="GET", body=None):
        return page.evaluate(API_JS, [self.base + "api/" + name, method, body])

    def mistakes(self, page):
        r = self.api(page, "mistakes")
        if r["status"] != 200 or not r["json"] or not r["json"].get("ok"):
            raise StepFail("GET api/mistakes → %s %s" % (r["status"], r["text"]))
        return {m.get("id"): m for m in r["json"].get("items", [])}

    def quiz_records(self, page):
        r = self.api(page, "quiz")
        if r["status"] != 200 or not r["json"] or not r["json"].get("ok"):
            raise StepFail("GET api/quiz → %s %s" % (r["status"], r["text"]))
        return r["json"].get("items") or {}


# ---------------------------------------------------------------- 页面操作 ----

def wait_js(page, expr, arg=None, timeout=15000):
    """等页面里的条件成立；返回条件的值。用固定间隔轮询：装了假时钟的页面里 rAF 是被接管的，不依赖它。"""
    h = page.wait_for_function(expr, arg=arg, timeout=timeout, polling=100)
    return h.json_value()


def is_enabled(locator, timeout=8000):
    try:
        expect(locator).to_be_enabled(timeout=timeout)
        return True
    except AssertionError:
        return False


def stage_of(page, qid):
    return page.evaluate("(q) => window.__e2e.stage(q)", qid)


def wait_stage(R, page, qid, stages, timeout=15000):
    try:
        wait_js(page, "([q, st]) => st.indexOf(window.__e2e.stage(q)) >= 0", [qid, list(stages)], timeout)
        return True
    except PWTimeout:
        R.info("%s 的 data-stage 等不到 %s，现在是 %r" % (qid, list(stages), stage_of(page, qid)))
        return False


def wait_record(page, qid, want, timeout=20000):
    """等 .qz-record 进入期望状态（或 error）；超时返回当前状态。"""
    try:
        return wait_js(page, "([q, w]) => { var r = window.__e2e.record(q); return r && r.state && (w.indexOf(r.state) >= 0 || r.state === 'error') ? r : false; }",
                       [qid, list(want)], timeout)
    except PWTimeout:
        cur = page.evaluate("(q) => window.__e2e.record(q)", qid)
        return {"state": (cur or {}).get("state"), "text": (cur or {}).get("text", ""), "timeout": True}


def wait_dd(R, page):
    """等示范题卡片和部件测试钩子就绪。"""
    try:
        page.wait_for_selector('.qz-card[data-qid="%s"]' % QID_POE, timeout=20000)
    except PWTimeout:
        R.require("setup.card", False, "20 秒内没有出现 .qz-card[data-qid=%s]" % QID_POE, page)
    try:
        wait_js(page, "() => !!window.__e2e.dd()", None, 15000)
    except PWTimeout:
        R.require("setup.dd_hook", False, "部件元素上没有 __ddArea 测试钩子（CONTRACT §7）", page)


def scroll_board(page):
    # 几何板滚到视口中间。用 instant：导图等页面开了 scroll-behavior:smooth，平滑滚动会让坐标算早了
    page.evaluate("() => { var d = window.__e2e.dd(); d.board.svg.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }")
    page.wait_for_timeout(350)


def drag_world_path(with_jitter=True):
    """B→C→D 的手指路线（世界坐标）：B→C 30 步、C→D 18 步，最后 2 步越过 D（约束应把 P 卡在 D）。共 50 次 move。
    手指稍微偏离折线一点点（±0.08），让约束真正起作用。"""
    pts = []
    for i in range(1, 31):
        x = 6.0 * i / 30
        j = (0.08 if i % 2 else -0.08) if (with_jitter and i < 29) else 0.0
        pts.append((x, j))
    for i in range(1, 19):
        y = 4.0 * i / 18
        j = (0.08 if i % 2 else -0.08) if (with_jitter and 2 < i < 17) else 0.0
        pts.append((6.0 + j, y))
    pts.append((6.0, 4.15))
    pts.append((6.0, 4.3))
    return pts


def do_drag(R, page, ctx, world_pts, sample=True, delay_ms=18):
    """从 P 现在的位置拖到 world_pts 的最后一点。手机上下文用 CDP 触屏事件，桌面用鼠标。
    返回每次 move 后读到的 __ddArea.get()（sample=False 时为空）。"""
    g0 = page.evaluate("() => window.__e2e.ddGet()")
    start = [g0["px"], g0["py"]]
    pts = page.evaluate("(pts) => window.__e2e.toClientMany(pts)", [start] + [list(p) for p in world_pts])
    samples = []
    if R.mobile.get(id(ctx), False):
        cdp = ctx.new_cdp_session(page)
        try:
            def tp(p):
                return [{"x": float(p[0]), "y": float(p[1]), "id": 1, "radiusX": 4, "radiusY": 4, "force": 1}]
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": tp(pts[0])})
            page.wait_for_timeout(delay_ms)
            for p in pts[1:]:
                cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": tp(p)})
                page.wait_for_timeout(delay_ms)
                if sample:
                    samples.append(page.evaluate("() => window.__e2e.ddGet()"))
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        finally:
            try:
                cdp.detach()
            except Exception:
                pass
    else:
        page.mouse.move(pts[0][0], pts[0][1])
        page.mouse.down()
        page.wait_for_timeout(delay_ms)
        for p in pts[1:]:
            page.mouse.move(p[0], p[1])
            page.wait_for_timeout(delay_ms)
            if sample:
                samples.append(page.evaluate("() => window.__e2e.ddGet()"))
        page.mouse.up()
    page.wait_for_timeout(250)
    return samples


def keyboard_to_D(page):
    """键盘兜底：聚焦 P（tabindex=0），PageUp 每次沿约束走 10 个 step，不够再按 →。返回最终 maxX。"""
    ok = page.evaluate("""() => { var d = window.__e2e.dd(); var n = d && d.P && d.P.node; if (!n) return false;
      var f = n.hasAttribute('tabindex') ? n : n.querySelector('[tabindex]'); if (!f) return false; f.focus(); return document.activeElement === f; }""")
    if not ok:
        return "聚焦不到 P"
    for key, times in (("PageUp", 30), ("ArrowRight", 150)):
        for _ in range(times):
            if page.evaluate("() => window.__e2e.ddGet().maxX") >= 9.8:
                break
            page.keyboard.press(key)
            page.wait_for_timeout(20)
    page.wait_for_timeout(200)
    return "maxX=%s" % page.evaluate("() => window.__e2e.ddGet().maxX")


def do_predict(R, page, ctx, ch="b", cf="sure", want=("saved",), prefix=""):
    """预测关卡完整流程（CONTRACT §6.4）：选答案 + 把握度 → 提交预测 → 把 P 拖到 D → 看对比 → 写解释 → 提交 → 等记录状态。"""
    wait_dd(R, page)
    card = page.locator('.qz-card[data-qid="%s"]' % QID_POE).last
    st = stage_of(page, QID_POE)
    if st == "free":  # 做过的题：先点「重新预测」回到预测阶段
        card.locator("[data-qz-repredict]").click()
        wait_stage(R, page, QID_POE, ["predict"])
        st = stage_of(page, QID_POE)
    R.require(prefix + "poe.stage_predict", st == "predict", "data-stage=%r" % st, page)
    card.locator('[data-qz-ans="%s"]' % ch).click()
    card.locator('[data-qz-cf="%s"]' % cf).click()
    sub = card.locator("[data-qz-submit]")
    R.require(prefix + "poe.submit_enabled", is_enabled(sub), "选了答案和把握度后「提交预测」应可用", page)
    sub.click()
    R.require(prefix + "poe.stage_operate", wait_stage(R, page, QID_POE, ["operate"]), "提交预测后 data-stage=operate", page)
    scroll_board(page)
    do_drag(R, page, ctx, drag_world_path(), sample=False)
    g = page.evaluate("() => window.__e2e.ddGet()")
    if not R.check(prefix + "poe.drag_to_D", g["maxX"] >= 9.8,
                   "%s拖动后 get()=%s" % ("触屏" if R.mobile.get(id(ctx)) else "鼠标", json.dumps(g)), page):
        # 拖动坏了也把后面的闭环（对比、解释、错题本、重测）测完：改用方向键把 P 走到 D，并在输出里说明
        R.info("拖动没有把 P 带到 D，改用键盘（PageUp / →）继续后面的检查：%s" % keyboard_to_D(page))
        g = page.evaluate("() => window.__e2e.ddGet()")
    cmp_btn = card.locator("[data-qz-compare]")
    R.require(prefix + "poe.compare_enabled", is_enabled(cmp_btn), "拖到 D 后「看对比」应可用；get()=%s" % json.dumps(g), page)
    cmp_btn.click()
    ta = card.locator("textarea[data-qz-ex]")
    try:
        ta.wait_for(state="visible", timeout=10000)
    except PWTimeout:
        R.require(prefix + "poe.explain_box", False, "看对比后没有出现 textarea[data-qz-ex]；stage=%r" % stage_of(page, QID_POE), page)
    ta.fill(EXPLAIN)
    exb = card.locator("[data-qz-ex-submit]")
    R.require(prefix + "poe.explain_submit_enabled", is_enabled(exb), "写了 %d 字解释后提交按钮应可用" % len(EXPLAIN), page)
    exb.click()
    return wait_record(page, QID_POE, want)


def answer_card(R, page, qid, ch, rs, cf, want=("saved", "guest")):
    """普通题 / 重测题：在 .qz-card[data-qid] 里选答案、理由、把握度 → 提交 → 等 .qz-record 的状态。
    返回 (记录, 提交前已标出对错的元素个数)。"""
    sel = '.qz-card[data-qid="%s"]' % qid
    try:
        page.wait_for_selector(sel, timeout=20000)
    except PWTimeout:
        R.require("card." + qid, False, "没有出现 %s" % sel, page)
    card = page.locator(sel).last
    card.scroll_into_view_if_needed()
    if stage_of(page, qid) == "feedback":  # 同一页面上做第二次：先「再做一次」
        retry = card.locator("[data-qz-retry]")
        if retry.count():
            retry.first.click()
            wait_stage(R, page, qid, ["answer"])
    card.locator('[data-qz-ans="%s"]' % ch).click()
    if rs:
        card.locator('[data-qz-rs="%s"]' % rs).click()
    card.locator('[data-qz-cf="%s"]' % cf).click()
    premark = card.locator("[data-mark]").count()
    sub = card.locator("[data-qz-submit]")
    R.require("submit_enabled." + qid, is_enabled(sub), "选了答案/理由/把握度后「提交」应可用", page)
    sub.click()
    return wait_record(page, qid, want), premark


def wait_review_state(R, page, states, timeout=20000):
    try:
        return wait_js(page, "(st) => { var r = document.querySelector('.qz-review'); var s = r && r.getAttribute('data-state'); return st.indexOf(s) >= 0 ? s : false; }",
                       list(states), timeout)
    except PWTimeout:
        return page.evaluate("() => { var r = document.querySelector('.qz-review'); return r ? r.getAttribute('data-state') : '(没有 .qz-review)'; }")


def wait_chip_text(page, ref, want, timeout=12000):
    try:
        wait_js(page, "([r, w]) => window.__e2e.chipText(r) === w", [ref, want], timeout)
    except PWTimeout:
        pass
    return page.evaluate("(r) => window.__e2e.chipText(r)", ref)


def check_mistake(R, page, m, prefix, step, due, status, stable=None):
    rv = (m or {}).get("review") or {}
    R.check(prefix + ".origin", m.get("origin") == "quiz", "origin=%r" % m.get("origin"), page)
    R.check(prefix + ".mc", TAG in (m.get("mc") or []), "mc=%r" % m.get("mc"), page)
    R.check(prefix + ".review.step", rv.get("step") == step, "want %r got %r" % (step, rv.get("step")), page)
    R.check(prefix + ".review.due", rv.get("due") == iso(due), "want %s got %r" % (iso(due), rv.get("due")), page)
    R.check(prefix + ".status", m.get("status") == status, "want %r got %r" % (status, m.get("status")), page)
    if stable is not None:
        R.check(prefix + ".review.stable", rv.get("stable") is stable, "want %r got %r" % (stable, rv.get("stable")), page)


def flow_mobile(R, default):
    """预测题流程用哪种设备：--flow-device 覆盖默认值。"""
    d = R.args.flow_device
    return default if d == "auto" else (d == "mobile")


# ------------------------------------------------------------------ 场景 ----

def sc_offline(R):
    """§11.C.1：拦截所有请求，主机不是 localhost / 127.0.0.1 的记下并中止；逐页统计 console.error、pageerror。
    用 390×844 触屏上下文（主要用户是手机）；新页面顺带检查没有横向滚动。"""
    ctx = R.new_context(mobile=True)
    cur = {"ext": None}

    def route_handler(route):
        u = route.request.url
        host = (urlparse(u).hostname or "").lower()
        if u.startswith(("http:", "https:", "ws:", "wss:")) and host not in ("localhost", "127.0.0.1", "::1"):
            if cur["ext"] is not None:
                cur["ext"].append(u)
            route.abort()
            return
        route.continue_()

    ctx.route("**/*", route_handler)
    total_ext = 0
    for path in OFFLINE_PAGES:
        ext, cons, perr, bad = [], [], [], []
        cur["ext"] = ext
        page = R.new_page(ctx, track_errors=False)
        page.on("console", lambda m, cons=cons: cons.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e, perr=perr: perr.append(str(e)))
        page.on("response", lambda r, bad=bad: bad.append("%d %s" % (r.status, r.url)) if r.status >= 400 else None)
        nav_err = ""
        try:
            page.goto(R.url(path), wait_until="load", timeout=30000)
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except PWTimeout:
                pass
            page.wait_for_timeout(1500)
        except PWError as e:
            nav_err = short(e, 200)
        sw = None
        try:
            sw = page.evaluate("() => document.documentElement.scrollWidth")
        except PWError:
            pass
        total_ext += len(ext)
        ok = not ext and not cons and not perr and not nav_err
        parts = ["外部请求 %d" % len(ext), "console.error %d" % len(cons), "pageerror %d" % len(perr)]
        if nav_err:
            parts.append("打开失败: " + nav_err)
        if ext:
            parts.append("外部: " + ", ".join(ext[:3]))
        if cons:
            parts.append("console: " + " | ".join(short(c, 120) for c in cons[:3]))
        if perr:
            parts.append("pageerror: " + " | ".join(short(c, 120) for c in perr[:3]))
        if bad:
            parts.append("HTTP≥400: " + ", ".join(bad[:3]))
        R.check("page " + path, ok, "；".join(parts), page)
        if path in NEW_PAGES:
            R.check("no_hscroll_390 " + path, sw is not None and sw <= 390, "scrollWidth=%r" % sw, page)
        elif sw is not None and sw > 390:
            R.info("（旧页面，只报告）%s 在 390px 下 scrollWidth=%s" % (path, sw))
        page.close()
    cur["ext"] = None
    R.check("external_requests_total", total_ext == 0, "全部页面外部请求共 %d 个" % total_ext)


PREDICT_LAYOUT_JS = """(q) => {
  var c = window.__e2e.card(q); if (!c) return null;
  var opt = c.querySelector('[data-qz-ans]'), fn = c.querySelector('.dd-fn'), geo = c.querySelector('.dd-geo'), ro = c.querySelector('.dd-readout');
  var lk = c.querySelector('.qz-lock');
  var r = function (e) { if (!e) return null; var b = e.getBoundingClientRect(); return { top: b.top + window.scrollY, bottom: b.bottom + window.scrollY }; };
  var between = []; ['.dd-fn', '.qz-progress', '[data-qz-compare]'].forEach(function (s) { var e = c.querySelector(s); if (e && e.getClientRects().length) between.push(s); });
  return { stage: c.getAttribute('data-stage'), opt: r(opt), geo: r(geo), lock: r(lk), lockShown: !!(lk && lk.getClientRects().length),
           fnShown: !!(fn && fn.getClientRects().length), roVis: ro ? getComputedStyle(ro).visibility : null,
           hint: lk ? getComputedStyle(lk, '::after').content : null, between: between };
}"""


def grayish(css_color):
    """rgb(…) 的三个分量相差不大 = 灰色（红色的「稳定迷思」三个分量差得很远）。"""
    m = re.findall(r"\d+", css_color or "")
    if len(m) < 3:
        return False
    v = [int(x) for x in m[:3]]
    return max(v) - min(v) < 50


def sc_mobile_drag(R):
    """§11.C.2：390×844 触屏，预测前拖不动；提交预测后用 CDP 触屏事件分 50 步把 P 从 B 拖到 D。"""
    ctx = R.new_context(mobile=True)
    page = R.new_page(ctx)
    page.goto(R.url("math/demo-poe.html"), wait_until="load")
    wait_dd(R, page)
    card = page.locator('.qz-card[data-qid="%s"]' % QID_POE).last
    st = stage_of(page, QID_POE)
    R.require("locked.stage_predict", st == "predict", "首次打开 data-stage=%r（应为 predict）" % st, page)
    lock = card.locator(".qz-lock")
    lock_ok = lock.count() > 0 and lock.first.is_visible()
    R.check("locked.overlay", lock_ok and "先预测，再动手" in (lock.first.text_content() or ""),
            "遮罩 .qz-lock 可见且写着「先预测，再动手」" if lock_ok else "没有可见的 .qz-lock", page)
    cmp_btn = card.locator("[data-qz-compare]")
    R.check("locked.compare_disabled", cmp_btn.count() > 0 and cmp_btn.first.is_disabled(), "「看对比」在预测前不可用", page)

    # 预测阶段的手机排版：函数板这时是空的，先不显示；预测选项紧跟在几何板下面，
    # 第一个选项的顶部（页面坐标）不超过 900 px，不用先翻过一整屏的空函数板
    lay = page.evaluate("""(q) => {
      var c = window.__e2e.card(q); if (!c) return null;
      var opt = c.querySelector('[data-qz-ans]'), fn = c.querySelector('.dd-fn'), geo = c.querySelector('.dd-geo'), ro = c.querySelector('.dd-readout');
      var lk = c.querySelector('.qz-lock');
      var r = function (e) { if (!e) return null; var b = e.getBoundingClientRect(); return { top: b.top + window.scrollY, bottom: b.bottom + window.scrollY }; };
      return { opt: r(opt), geo: r(geo), lock: r(lk),
               fnShown: !!(fn && fn.getClientRects().length), roVis: ro ? getComputedStyle(ro).visibility : null,
               hint: lk ? getComputedStyle(lk, '::after').content : null, between: (function () {
                 // 几何板下沿到第一个选项之间，不能夹着函数板、进度提示或「看对比」按钮
                 var out = []; ['.dd-fn', '.qz-progress', '[data-qz-compare]'].forEach(function (s) { var e = c.querySelector(s); if (e && e.getClientRects().length) out.push(s); }); return out; })() };
    }""", QID_POE)
    R.check("layout.first_option_top<=900", bool(lay and lay["opt"]) and lay["opt"]["top"] <= 900,
            "第一个预测选项顶部 %s px（应 ≤ 900）" % (lay and lay["opt"] and round(lay["opt"]["top"])), page)
    R.check("layout.fn_hidden_before_predict", bool(lay) and not lay["fnShown"], "预测前函数板不显示：%s" % json.dumps(lay), page)
    R.check("layout.options_follow_geo", bool(lay) and not lay["between"] and lay["opt"]["top"] - lay["geo"]["bottom"] < 120,
            "几何板下沿 %s → 第一个选项 %s；中间可见的：%s" % (lay and round(lay["geo"]["bottom"]), lay and round(lay["opt"]["top"]), lay and lay["between"]), page)
    R.check("layout.readout_hidden_when_locked", bool(lay) and lay["roVis"] == "hidden", "锁定时读数 visibility=%r（遮罩提示字不和读数叠在一起）" % (lay and lay["roVis"]), page)
    R.check("layout.lock_hint_points_down", bool(lay) and "↓" in (lay["hint"] or "") and lay["lock"]["bottom"] <= lay["opt"]["top"],
            "遮罩提示 %r；遮罩下沿 %s ≤ 选项顶部 %s（箭头指向下面的选项）" % (lay and lay["hint"], lay and round(lay["lock"]["bottom"]), lay and round(lay["opt"]["top"])), page)
    R.shot(page, "locked_layout")

    # 预测之前：手指按在 P 上往 C 拖，P 不能动
    scroll_board(page)
    do_drag(R, page, ctx, [(6.0 * i / 12, 0.0) for i in range(1, 13)], sample=False)
    g = page.evaluate("() => window.__e2e.ddGet()")
    R.check("locked.drag_no_move", abs(g["x"]) < 1e-9 and abs(g["px"]) < 1e-9 and abs(g["py"]) < 1e-9,
            "预测前拖动后 get()=%s" % json.dumps(g), page)
    R.check("locked.compare_still_disabled", cmp_btn.count() > 0 and cmp_btn.first.is_disabled(), "预测前拖过之后「看对比」仍不可用", page)

    # 提交预测
    card.locator('[data-qz-ans="b"]').click()
    card.locator('[data-qz-cf="sure"]').click()
    sub = card.locator("[data-qz-submit]")
    R.require("predict.submit_enabled", is_enabled(sub), "选 b + 有把握后「提交预测」可用", page)
    sub.click()
    R.require("predict.stage_operate", wait_stage(R, page, QID_POE, ["operate"]), "提交预测后 data-stage=operate", page)
    lock_gone = lock.count() == 0 or not lock.first.is_visible()
    R.check("predict.unlocked", lock_gone, "提交预测后遮罩消失", page)
    page.wait_for_timeout(150)
    aft = page.evaluate("""(q) => { var c = window.__e2e.card(q); var fn = c.querySelector('.dd-fn svg'), geo = c.querySelector('.dd-geo'), ro = c.querySelector('.dd-readout');
      var fr = fn ? fn.getBoundingClientRect() : null;
      return { fnW: fr ? Math.round(fr.width) : 0, fnH: fr ? Math.round(fr.height) : 0, geoTop: Math.round(geo.getBoundingClientRect().top), roVis: getComputedStyle(ro).visibility }; }""", QID_POE)
    R.check("predict.fn_shown", aft["fnW"] > 200 and aft["fnH"] > 100, "提交后函数板出现并排好版：%s" % json.dumps(aft), page)
    R.check("predict.scrolled_to_geo", -2 <= aft["geoTop"] <= 120, "提交后滚到几何板：几何板顶部在视口 %s px" % aft["geoTop"], page)
    R.check("predict.readout_shown", aft["roVis"] == "visible", "解锁后读数 visibility=%r" % aft["roVis"], page)

    # 拖动前准备：滚到画板、装长任务监听、清零性能打点
    scroll_board(page)
    has_perf = page.evaluate("() => !!(window.ABSLabSVG && window.ABSLabSVG.perf && typeof window.ABSLabSVG.perf.reset === 'function')")
    R.check("perf.hook", has_perf, "window.ABSLabSVG.perf.reset 存在（CONTRACT §3.3）", page)
    page.evaluate("""() => {
      window.__e2eLT = [];
      try {
        var po = new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { window.__e2eLT.push({ s: e.startTime, d: e.duration }); }); });
        po.observe({ type: 'longtask', buffered: false });
        window.__e2ePO = po;
      } catch (e) { window.__e2eLT = null; }
      if (window.ABSLabSVG && window.ABSLabSVG.perf && window.ABSLabSVG.perf.reset) window.ABSLabSVG.perf.reset();
    }""")
    page.wait_for_timeout(100)
    y0 = page.evaluate("() => window.scrollY")
    t0 = page.evaluate("() => performance.now()")
    samples = do_drag(R, page, ctx, drag_world_path(), sample=True)
    t1 = page.evaluate("() => performance.now()")
    y1 = page.evaluate("() => window.scrollY")
    g = page.evaluate("() => window.__e2e.ddGet()")

    dmax, worst = 0.0, None
    for s in samples:
        d = dist_to_poly(s["px"], s["py"])
        if d > dmax:
            dmax, worst = d, s
    R.check("drag.moves>=40", len(samples) >= 40, "touchMove 次数 %d" % len(samples))
    moved = max([s["x"] for s in samples] or [0])
    R.check("drag.on_polyline", samples and dmax < 0.01 and moved > 1,
            "%d 次采样，离 B→C→D 最远 %.5f，采样里最大 x=%.2f（P 没被拖动时不算通过）%s" % (
                len(samples), dmax, moved, ("，那一次 get()=" + json.dumps(worst)) if dmax >= 0.01 else ""), page)
    R.check("drag.maxX", g["maxX"] >= 9.99, "maxX=%.4f（函数板应显示到 x=10）；终点 get()=%s" % (g["maxX"], json.dumps(g)), page)
    R.check("drag.scrollY_unchanged", abs(y1 - y0) < 1, "scrollY 拖前 %s 拖后 %s" % (y0, y1), page)
    lts = page.evaluate("([a, b]) => window.__e2eLT === null ? null : window.__e2eLT.filter(function (e) { return e.s >= a - 1 && e.s <= b + 1 && e.d > 50; })", [t0, t1])
    if lts is None:
        R.check("drag.no_longtask", False, "这个浏览器不支持 PerformanceObserver longtask，无法判断")
    else:
        R.check("drag.no_longtask", not lts, "拖动 %.0f ms 内超过 50 ms 的长任务：%s" % (t1 - t0, json.dumps(lts) if lts else "无"), page)
    perf = page.evaluate("() => { var p = window.ABSLabSVG && window.ABSLabSVG.perf; return p ? { moves: p.moves, moveMs: p.moveMs, frames: p.frames, frameMs: p.frameMs } : null; }")
    if perf and perf.get("moves"):
        avg = perf["moveMs"] / perf["moves"]
        favg = (perf["frameMs"] / perf["frames"]) if perf.get("frames") else float("nan")
        R.check("drag.move_ms_avg<4", avg < 4, "moves=%d 平均 %.3f ms；frames=%s 平均 %.3f ms" % (perf["moves"], avg, perf.get("frames"), favg), page)
    else:
        R.check("drag.move_ms_avg<4", False, "ABSLabSVG.perf 没有记到 move：%s" % json.dumps(perf), page)
    ro = card.locator(".dd-readout")
    rtext = ro.first.text_content() if ro.count() else ""
    R.check("drag.readout", bool(re.search(r"x\s*=\s*10\.0", rtext or "")) and bool(re.search(r"y\s*=\s*12\.0", rtext or "")),
            "读数 .dd-readout=%r（应为 x = 10.0　y = 12.0）" % rtext, page)
    sw = page.evaluate("() => document.documentElement.scrollWidth")
    R.check("layout.no_hscroll", sw <= 390, "scrollWidth=%s" % sw, page)
    R.check("compare.enabled", is_enabled(cmp_btn.first, 5000), "拖到 D 后「看对比」可用", page)
    R.shot(page, "after_drag")

    # 对比区：两张小图并排（SPEC 7.4：390px 下各约 170px 宽）
    if cmp_btn.first.is_enabled():
        cmp_btn.first.click()
        try:
            page.wait_for_selector('.qz-card[data-qid="%s"] .qz-compare .qz-fig' % QID_POE, timeout=8000)
            page.wait_for_timeout(300)
            boxes = page.evaluate("""(q) => { var c = window.__e2e.card(q); var f = c.querySelectorAll('.qz-compare .qz-fig');
                return Array.prototype.map.call(f, function (e) { var r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }); }""", QID_POE)
            ok = len(boxes) == 2 and abs(boxes[0]["y"] - boxes[1]["y"]) < 4 and all(120 <= b["w"] <= 200 for b in boxes)
            R.check("compare.side_by_side", ok, "对比图 %s" % json.dumps([{k: round(v) for k, v in b.items()} for b in boxes]), page)
            R.shot(page, "compare")
        except PWTimeout:
            R.check("compare.side_by_side", False, "点「看对比」后没有出现 .qz-compare .qz-fig", page)
        sw = page.evaluate("() => document.documentElement.scrollWidth")
        R.check("layout.no_hscroll_after_compare", sw <= 390, "scrollWidth=%s" % sw, page)

        # 写解释 → 反馈 →「重新预测」：又回到锁定，排版和第一次打开时一样（函数板、读数藏起来，选项紧跟几何板）
        try:
            card.locator("textarea[data-qz-ex]").fill("底和高都不变，所以面积不变")
            card.locator("[data-qz-ex-submit]").click()
            wait_record(page, QID_POE, ("guest", "saved"))
            card.locator("[data-qz-repredict]").first.click()
            wait_stage(R, page, QID_POE, ["predict"])
            page.wait_for_timeout(150)
            lay = page.evaluate(PREDICT_LAYOUT_JS, QID_POE)
            ok = bool(lay) and lay["stage"] == "predict" and lay["lockShown"] and not lay["fnShown"] and lay["roVis"] == "hidden" \
                and not lay["between"] and lay["opt"]["top"] - lay["geo"]["bottom"] < 120
            R.check("repredict.layout", ok, "重新预测后：%s" % json.dumps(lay), page)
        except PWTimeout:
            R.check("repredict.layout", False, "没能走到「重新预测」", page)


def sc_closed_loop(R):
    """§11.C.3：账号 A。D 天做题 1 答成 mc → 进错题本；D+1 天重测出题 2（换情境）→ 通过 → step 1、D+4 重测、已订正。"""
    D, D1, D4 = R.day(0), R.day(1), R.day(4)
    mobile = flow_mobile(R, False)
    ctx = R.new_context(mobile=mobile)
    page = R.new_page(ctx)
    R.set_day(ctx, 0)
    page.goto(R.url("math/demo-poe.html"), wait_until="load")
    name = R.new_user("a")
    R.register(page, name)
    R.state["A"] = name
    R.info("账号 A = %s，D = %s" % (name, iso(D)))
    if not mobile:
        wait_dd(R, page)
        lay = page.evaluate(PREDICT_LAYOUT_JS, QID_POE)
        R.check("D.desktop.locked_layout", bool(lay) and lay["stage"] == "predict" and lay["lockShown"] and lay["fnShown"] and lay["roVis"] == "hidden",
                "1280 宽、锁定时：函数板照常并排显示、读数藏起来：%s" % json.dumps(lay), page)

    rec = do_predict(R, page, ctx, "b", "sure", want=("saved",), prefix="D.")
    R.require("D.poe.record_saved", rec.get("state") == "saved", "记录状态 %r：%s" % (rec.get("state"), rec.get("text")), page)
    t = rec.get("text", "")
    R.check("D.poe.record_text", "已存入错题本" in t and TAG_NAME in t and fmt_md(D1) in t,
            "应含「已存入错题本」「%s」「%s」：%r" % (TAG_NAME, fmt_md(D1), t), page)
    fb = page.locator('.qz-card[data-qid="%s"] .qz-feedback' % QID_POE).last
    fbt = fb.text_content() if fb.count() else ""
    R.check("D.poe.feedback", "常见想法" in (fbt or "") and EXPLAIN in (fbt or ""),
            "反馈里有反驳性反馈「常见想法…」并显示学生自己的解释" , page)

    ms = R.mistakes(page)
    m = ms.get("mc-" + TAG)
    R.require("D.mistake.exists", m is not None, "GET api/mistakes 里有 mc-%s；现有 id：%s" % (TAG, list(ms.keys())), page)
    check_mistake(R, page, m, "D.mistake", 0, D1, 0)
    recs = R.quiz_records(page)
    tries = (recs.get(QID_POE) or {}).get("tries") or []
    hit = [a for a in tries if a.get("cls") == "mc"]
    R.check("D.quiz.attempt_mc", bool(hit), "api/quiz 里 %s 的作答：%s" % (QID_POE, json.dumps(tries, ensure_ascii=False)[:300]))
    if hit:
        a = hit[-1]
        R.check("D.quiz.attempt_fields", a.get("d") == iso(D) and a.get("mode") == "poe" and a.get("ch") == "b" and a.get("cf") == "sure" and TAG in (a.get("tags") or []) and a.get("ex") == EXPLAIN,
                "d=%r mode=%r ch=%r cf=%r tags=%r ex=%r" % (a.get("d"), a.get("mode"), a.get("ch"), a.get("cf"), a.get("tags"), a.get("ex")))

    # ---- D+1：重测 ----
    R.set_day(ctx, 1)
    page.goto(R.url("review.html"), wait_until="load")
    st = wait_review_state(R, page, ("list", "empty", "guest", "run", "summary"))
    R.require("D1.review.list", st == "list", ".qz-review data-state=%r（应为 list）" % st, page)
    items = page.evaluate("() => Array.prototype.map.call(document.querySelectorAll('.qz-review .qz-due-item'), function (e) { return { key: e.getAttribute('data-key'), text: e.textContent.replace(/\\s+/g, ' ').trim() }; })")
    R.check("D1.review.one_due", len(items) == 1 and items[0]["key"] == TAG, "到期项 %s" % json.dumps(items, ensure_ascii=False), page)
    R.shot(page, "D1_review_list")
    page.locator("[data-qz-start]").first.click()
    st = wait_review_state(R, page, ("run",))
    R.require("D1.review.run", st == "run", "点「开始重测」后 data-state=%r" % st, page)
    try:
        page.wait_for_selector(".qz-review .qz-card", timeout=15000)
    except PWTimeout:
        R.require("D1.review.card", False, "重测里没有出现题目卡片", page)
    qids = page.evaluate("() => Array.prototype.map.call(document.querySelectorAll('.qz-review .qz-card'), function (e) { return e.getAttribute('data-qid'); })")
    R.check("D1.review.item_is_twotier", bool(qids) and qids[-1] == QID_TT and QID_POE not in qids, "重测出的题 %s（应为 %s，不是 %s）" % (qids, QID_TT, QID_POE), page)
    cmode = page.evaluate("(q) => { var c = window.__e2e.card(q); return c ? c.getAttribute('data-mode') : null; }", QID_TT)
    R.check("D1.retest.mode", cmode == "retest", "卡片 data-mode=%r" % cmode, page)
    rec, premark = answer_card(R, page, QID_TT, "b", "r2", "sure", want=("saved",))
    R.check("D1.retest.no_early_answer", premark == 0, "提交前已标出对错的元素 %d 个" % premark, page)
    R.require("D1.retest.record_saved", rec.get("state") == "saved", "记录状态 %r：%s" % (rec.get("state"), rec.get("text")), page)
    R.check("D1.retest.record_text", "下次重测" in rec.get("text", "") and fmt_md(D4) in rec.get("text", ""),
            "应含「下次重测」「%s」：%r" % (fmt_md(D4), rec.get("text")), page)
    ms = R.mistakes(page)
    m = ms.get("mc-" + TAG) or {}
    check_mistake(R, page, m, "D1.mistake", 1, D4, 1)
    recs = R.quiz_records(page)
    tries = (recs.get(QID_TT) or {}).get("tries") or []
    R.check("D1.quiz.attempt_retest", any(a.get("cls") == "pass" and a.get("mode") == "retest" and a.get("d") == iso(D1) for a in tries),
            "api/quiz 里 %s 的作答：%s" % (QID_TT, json.dumps(tries, ensure_ascii=False)[:300]))

    # 小结：最后一题的「下一题」是「看小结」
    nxt = page.locator(".qz-review [data-qz-next]")
    if nxt.count():
        nxt.last.click()
        st = wait_review_state(R, page, ("summary",))
        si = page.evaluate("() => Array.prototype.map.call(document.querySelectorAll('.qz-review .qz-sum-item'), function (e) { return { key: e.getAttribute('data-key'), text: e.textContent.replace(/\\s+/g, ' ').trim() }; })")
        ok = st == "summary" and any(x["key"] == TAG and fmt_md(D4) in x["text"] for x in si)
        R.check("D1.review.summary", ok, "state=%r 小结 %s" % (st, json.dumps(si, ensure_ascii=False)), page)
    else:
        R.check("D1.review.summary", False, "反馈后没有 [data-qz-next]（看小结）", page)


def sc_stable(R):
    """§11.C.4：账号 B。D 天题 1 答成 mc；D+1 重测题 2 又答成 mc（情境不同）→ 稳定迷思；抽屉和重测页都显示「稳定迷思」。
    之后按计划重测到「已掌握」：记录不撤，徽标变成灰色的「曾是稳定迷思」。"""
    D, D1, D2 = R.day(0), R.day(1), R.day(2)
    mobile = flow_mobile(R, False)
    ctx = R.new_context(mobile=mobile)
    page = R.new_page(ctx)
    R.set_day(ctx, 0)
    page.goto(R.url("math/demo-poe.html"), wait_until="load")
    name = R.new_user("b")
    R.register(page, name)
    R.state["B"] = name
    R.info("账号 B = %s" % name)
    rec = do_predict(R, page, ctx, "b", "sure", want=("saved",), prefix="D.")
    R.require("D.poe.record_saved", rec.get("state") == "saved", "记录状态 %r：%s" % (rec.get("state"), rec.get("text")), page)
    m = R.mistakes(page).get("mc-" + TAG)
    R.require("D.mistake.exists", m is not None, "D 天之后有 mc-%s" % TAG, page)
    R.check("D.mistake.not_stable_yet", ((m.get("review") or {}).get("stable")) is False, "只错一道题不算稳定迷思：stable=%r" % (m.get("review") or {}).get("stable"), page)

    R.set_day(ctx, 1)
    page.goto(R.url("review.html"), wait_until="load")
    st = wait_review_state(R, page, ("list", "empty", "guest"))
    R.require("D1.review.list", st == "list", "data-state=%r" % st, page)
    page.locator("[data-qz-start]").first.click()
    R.require("D1.review.run", wait_review_state(R, page, ("run",)) == "run", "开始重测", page)
    rec, premark = answer_card(R, page, QID_TT, "a", "r1", "sure", want=("saved",))
    R.require("D1.retest.record_saved", rec.get("state") == "saved", "记录状态 %r：%s" % (rec.get("state"), rec.get("text")), page)
    m = R.mistakes(page).get("mc-" + TAG) or {}
    check_mistake(R, page, m, "D1.mistake", 0, D2, 0, stable=True)

    # 数学导图的错题本抽屉
    page.goto(R.url("math/knowledge-map.html"), wait_until="load")
    try:
        wait_js(page, "() => !!(window.ABSLabMistakes && window.ABSLabMistakes.open)", None, 15000)
        page.evaluate("() => window.ABSLabMistakes.open('')")
        wait_js(page, "() => { var d = document.querySelector('.mk-drawer'); return !!d && d.textContent.indexOf('稳定迷思') >= 0; }", None, 15000)
        vis = page.locator(".mk-drawer").get_by_text("稳定迷思").first.is_visible()
        R.check("D1.drawer.stable", vis, "错题本抽屉里「稳定迷思」可见", page)
    except PWTimeout:
        txt = page.evaluate("() => { var d = document.querySelector('.mk-drawer'); return d ? d.textContent : '(没有 .mk-drawer)'; }")
        R.check("D1.drawer.stable", False, "15 秒内抽屉里没有「稳定迷思」：%r" % short(txt, 300), page)
    dtxt = page.evaluate("() => { var d = document.querySelector('.mk-drawer'); return d ? d.textContent.replace(/\\s+/g, ' ') : ''; }")
    R.check("D1.drawer.meta", TAG_NAME in dtxt and ("下次重测：" + fmt_md(D2)) in dtxt,
            "抽屉里有标签名「%s」和「下次重测：%s」" % (TAG_NAME, fmt_md(D2)), page)
    R.shot(page, "D1_drawer")

    # D+2：重测页的到期列表带稳定迷思徽标
    R.set_day(ctx, 2)
    page.goto(R.url("review.html"), wait_until="load")
    st = wait_review_state(R, page, ("list", "empty", "guest"))
    R.require("D2.review.list", st == "list", "data-state=%r" % st, page)
    badge = page.locator('.qz-review .qz-due-item[data-key="%s"] .qz-badge-stable' % TAG)
    ok = badge.count() > 0 and badge.first.is_visible() and "稳定迷思" in (badge.first.text_content() or "")
    R.check("D2.review.stable_badge", ok, "到期项里 .qz-badge-stable「稳定迷思」可见", page)
    R.shot(page, "D2_review_list")

    # 接着按计划重测到「已掌握」：D+2、D+5、D+12、D+26 都答对（间隔 3、7、14 天）。
    # 稳定迷思的记录不撤；掌握以后徽标变成灰色的「曾是稳定迷思」，重测页和错题本都这样显示
    plan = [(2, 1, 5, 1), (5, 2, 12, 1), (12, 3, 26, 1), (26, 4, None, 2)]
    served = []
    for n, step, due_n, status in plan:
        pre = "D%d" % n
        R.set_day(ctx, n)
        page.goto(R.url("review.html"), wait_until="load")
        st = wait_review_state(R, page, ("list", "empty", "guest"))
        R.require(pre + ".review.list", st == "list", "第 D+%d 天 data-state=%r（应为 list）" % (n, st), page)
        page.locator("[data-qz-start]").first.click()
        R.require(pre + ".review.run", wait_review_state(R, page, ("run",)) == "run", "开始重测", page)
        try:
            page.wait_for_selector(".qz-review .qz-card", timeout=15000)
        except PWTimeout:
            R.require(pre + ".review.card", False, "重测里没有出现题目卡片", page)
        qid = page.evaluate("() => { var c = document.querySelectorAll('.qz-review .qz-card'); return c.length ? c[c.length - 1].getAttribute('data-qid') : null; }")
        R.require(pre + ".served", qid in RIGHT, "重测出的题 %r" % qid, page)
        served.append(qid)
        ch, rs = RIGHT[qid]
        rec, _ = answer_card(R, page, qid, ch, rs, "sure", want=("saved",))
        R.require(pre + ".saved", rec.get("state") == "saved", "记录状态 %r：%s" % (rec.get("state"), rec.get("text")), page)
        m = R.mistakes(page).get("mc-" + TAG) or {}
        rv = m.get("review") or {}
        want_due = iso(R.day(due_n)) if due_n is not None else ""
        R.check(pre + ".schedule", rv.get("step") == step and rv.get("due") == want_due and m.get("status") == status and rv.get("stable") is True,
                "want step %s due %r status %s stable True；got step %r due %r status %r stable %r" % (
                    step, want_due, status, rv.get("step"), rv.get("due"), m.get("status"), rv.get("stable")), page)
    # 情境交替：相邻两次出的题情境不同（第 0 批只有「距离—时间读图」（题 2）和「动点面积」（题 3、4）两种；
    # 第 1 批 A 起 math-m1.json 里带 graphaspath 的题也会出，按题目各自的 context 比）
    ctx_of = lambda q: RIGHT_CTX.get(q, q)
    R.check("chain.context_alternates", all(ctx_of(a) != ctx_of(b) for a, b in zip([QID_TT] + served, served)),
            "D+1 起依次出的题：%s" % ([QID_TT] + served))

    # 最后一次的小结：已掌握 + 灰色「曾是稳定迷思」
    nxt = page.locator(".qz-review [data-qz-next]")
    if nxt.count():
        nxt.last.click()
        wait_review_state(R, page, ("summary",))
    sm = page.evaluate("""(t) => { var li = document.querySelector('.qz-review .qz-sum-item[data-key="' + t + '"]'); if (!li) return null;
      var b = li.querySelector('.qz-badge-stable'); return { text: li.textContent.replace(/\s+/g, ' '), badge: b ? b.textContent : null, past: !!(b && b.classList.contains('qz-badge-past')),
        color: b ? getComputedStyle(b).color : null }; }""", TAG)
    R.check("D26.summary.former_stable", bool(sm) and sm["past"] and sm["badge"] == "曾是稳定迷思" and "已掌握" in sm["text"] and grayish(sm["color"]),
            "小结：%s" % json.dumps(sm, ensure_ascii=False), page)
    R.shot(page, "D26_summary")
    # 用 ?tag= 打开：说明已掌握，徽标同样是灰色的「曾是稳定迷思」
    page.goto(R.url("review.html?tag=" + TAG), wait_until="load")
    st = wait_review_state(R, page, ("empty", "list"))
    tb = page.evaluate("() => { var r = document.querySelector('.qz-review'); var b = r && r.querySelector('.qz-badge-stable'); return { text: r ? r.textContent.replace(/\s+/g, ' ') : '', badge: b ? b.textContent : null, past: !!(b && b.classList.contains('qz-badge-past')) }; }")
    R.check("D26.review_tag.former_stable", st == "empty" and tb["past"] and tb["badge"] == "曾是稳定迷思" and "已掌握" in tb["text"],
            "state=%r %s" % (st, json.dumps(tb, ensure_ascii=False)), page)

    # 错题本抽屉：灰色「曾是稳定迷思」，不再有红色的「稳定迷思」
    page.goto(R.url("math/knowledge-map.html"), wait_until="load")
    try:
        wait_js(page, "() => !!(window.ABSLabMistakes && window.ABSLabMistakes.open)", None, 15000)
        page.evaluate("() => window.ABSLabMistakes.open('')")
        wait_js(page, "() => !!document.querySelector('.mk-drawer .mk-stable')", None, 15000)
    except PWTimeout:
        pass
    dr = page.evaluate("() => Array.prototype.map.call(document.querySelectorAll('.mk-drawer .mk-stable'), function (e) { return { text: e.textContent, past: e.classList.contains('mk-stable-past'), bg: getComputedStyle(e).backgroundColor }; })")
    R.check("D26.drawer.former_stable", len(dr) == 1 and dr[0]["past"] and dr[0]["text"] == "曾是稳定迷思" and grayish(dr[0]["bg"]),
            "抽屉里的徽标：%s" % json.dumps(dr, ensure_ascii=False), page)
    R.shot(page, "D26_drawer")


def sc_mastery(R):
    """§11.C.5：账号 C。D 天、D+2 天各做对题 2、题 3（有把握）→ 导图上的测试标签 1 / 2 → 达标 ✓；手动学习状态 sxzs.status 全程不变。"""
    mobile = flow_mobile(R, False)
    ctx = R.new_context(mobile=mobile)
    page = R.new_page(ctx)
    R.set_day(ctx, 0)
    page.goto(R.url("math/demo-poe.html"), wait_until="load")
    name = R.new_user("c")
    R.register(page, name)
    R.state["C"] = name
    R.info("账号 C = %s" % name)
    # 先给一个手动状态（c23-4-2 标「已掌握」），这样「不变」才有意义，也顺带检查「待验证」（CONTRACT §8.3）
    seed = json.dumps({"c23-4-2": 3}, separators=(",", ":"))
    page.evaluate("(v) => localStorage.setItem('sxzs.status', v)", seed)
    page.wait_for_timeout(1500)  # auth.js 600 ms 防抖后推到云端
    s0 = page.evaluate("() => localStorage.getItem('sxzs.status')")
    pr = R.api(page, "progress")
    p0 = (((pr.get("json") or {}).get("data") or {}).get("bridged") or {}).get("sxzs.status")
    R.check("seed.status", s0 == seed, "localStorage sxzs.status=%r；云端 bridged=%r" % (s0, p0), page)

    def two_items(prefix):
        page.goto(R.url("math/demo-poe.html"), wait_until="load")
        rec, _ = answer_card(R, page, QID_TT, "b", "r2", "sure", want=("saved",))
        R.check(prefix + ".twotier.saved", rec.get("state") == "saved", "%r：%s" % (rec.get("state"), rec.get("text")), page)
        rec, _ = answer_card(R, page, QID_TR, "a", "r1", "sure", want=("saved",))
        R.check(prefix + ".transfer.saved", rec.get("state") == "saved", "%r：%s" % (rec.get("state"), rec.get("text")), page)

    def chips(prefix, want22, want23):
        page.goto(R.url("math/knowledge-map.html"), wait_until="load")
        page.wait_for_timeout(1000)
        t22 = wait_chip_text(page, "math:c22-2-2", want22)
        R.check(prefix + ".chip.c22-2-2", t22 == want22, "want %r got %r" % (want22, t22), page)
        t23 = wait_chip_text(page, "math:c23-4-2", want23, 5000)
        R.check(prefix + ".chip.c23-4-2", t23 == want23, "手动「已掌握」：want %r got %r" % (want23, t23), page)

    # 还没做过任何题：c22-2-2「未测」；c23-4-2 手动标了已掌握、测试没达标：「待验证」
    chips("D0", "未测", "待验证")
    # 只做对题 2（二段式）：做过但一天都没达标 →「测试 0 / 2」
    page.goto(R.url("math/demo-poe.html"), wait_until="load")
    rec, _ = answer_card(R, page, QID_TT, "b", "r2", "sure", want=("saved",))
    R.check("D0.twotier.saved", rec.get("state") == "saved", "%r：%s" % (rec.get("state"), rec.get("text")), page)
    chips("D0b", "测试 0 / 2", "待验证")
    two_items("D")
    recs = R.quiz_records(page)
    n = sum(1 for q in (QID_TT, QID_TR) for a in ((recs.get(q) or {}).get("tries") or []) if a.get("cls") == "pass")
    R.check("D.quiz.passes", n == 3, "api/quiz 里 pass 作答 %d 条（应为 3：题 2 两次、题 3 一次）" % n)
    chips("D", "测试 1 / 2", "待验证")
    R.shot(page, "D_map_chip")

    R.set_day(ctx, 2)
    two_items("D2")
    # 题 2 也覆盖 c23-4-2：两天都达标后，c23-4-2 的手动「已掌握」得到验证 →「测试达标 ✓」（不再是「待验证」）
    chips("D2", "测试达标 ✓", "测试达标 ✓")
    R.shot(page, "D2_map_chip")

    s1 = page.evaluate("() => localStorage.getItem('sxzs.status')")
    R.check("status.local_unchanged", s1 == s0, "sxzs.status 开始 %r 结束 %r" % (s0, s1), page)
    pr = R.api(page, "progress")
    if pr.get("status") == 200 and pr.get("json"):
        p1 = (((pr["json"].get("data") or {}).get("bridged")) or {}).get("sxzs.status")
        R.check("status.server_unchanged", p1 == p0, "云端 bridged sxzs.status 开始 %r 结束 %r" % (p0, p1))
    else:
        R.info("读不到云端进度：%s" % pr)


def sc_guest(R):
    """§11.C.6：不登录做完题 1；记录行是登录提示 + 登录按钮；全程没有对 api/mistakes、api/quiz 的 POST。"""
    mobile = flow_mobile(R, True)
    ctx = R.new_context(mobile=mobile)
    page = R.new_page(ctx)
    posts, gets = [], []

    def on_req(req):
        u = req.url
        if "/api/mistakes" in u or "/api/quiz" in u:
            (posts if req.method == "POST" else gets).append("%s %s" % (req.method, u))

    ctx.on("request", on_req)
    page.goto(R.url("math/demo-poe.html"), wait_until="load")
    tok = page.evaluate("() => window.ABSLabAuth && window.ABSLabAuth.getToken()")
    R.require("guest.no_token", not tok, "游客没有 token", page)
    rec = do_predict(R, page, ctx, "b", "sure", want=("guest",), prefix="")
    R.check("poe.record_guest", rec.get("state") == "guest", "记录状态 %r：%s" % (rec.get("state"), rec.get("text")), page)
    R.check("poe.login_hint", "登录后可以存入错题本并按计划重测" in rec.get("text", ""), "记录行：%r" % rec.get("text"), page)
    btn = page.locator('.qz-card[data-qid="%s"] [data-qz-login]' % QID_POE)
    R.check("poe.login_button", btn.count() > 0 and btn.first.is_visible(), "记录行有 [data-qz-login] 按钮", page)
    R.shot(page, "guest_feedback")

    rec2, premark = answer_card(R, page, QID_TT, "b", "r2", "sure", want=("guest",))
    R.check("practice.record_guest", rec2.get("state") == "guest", "题 2 记录状态 %r：%s" % (rec2.get("state"), rec2.get("text")), page)
    R.check("practice.no_early_answer", premark == 0, "提交前已标出对错的元素 %d 个" % premark, page)

    local = page.evaluate("() => { try { return JSON.parse(localStorage.getItem('abslab.quiz.v1') || 'null'); } catch (e) { return 'bad json'; } }")
    tries = ((((local or {}) if isinstance(local, dict) else {}).get("items") or {}).get(QID_POE) or {}).get("tries") or []
    R.check("local_records", any(a.get("cls") == "mc" for a in tries), "localStorage abslab.quiz.v1 里有题 1 的 mc 作答：%s" % short(json.dumps(local, ensure_ascii=False), 200))

    if btn.count():
        btn.first.click()
        try:
            page.wait_for_selector("#absShellModal.open", timeout=5000)
            R.check("login_button_opens_modal", True, "点登录按钮打开了账号窗")
        except PWTimeout:
            R.check("login_button_opens_modal", False, "点 [data-qz-login] 后没有打开 #absShellModal", page)
    page.wait_for_timeout(1000)  # 等可能迟到的请求
    R.check("no_post", not posts, "POST：%s" % (posts or "无"))
    if gets:
        R.info("游客发出的 GET（不算失败，只供参考）：%s" % gets[:5])


def review_items(page, sel=".qz-due-item"):
    return page.evaluate("""(sel) => Array.prototype.map.call(document.querySelectorAll('.qz-review ' + sel), function (e) {
        var a = e.querySelector('a.qz-link');
        return { key: e.getAttribute('data-key'), none: e.getAttribute('data-none'), text: e.textContent.replace(/\\s+/g, ' ').trim(),
                 href: a ? a.getAttribute('href') : null }; })""", sel)


def sc_edge(R):
    """评审发现的两个边角情形（review-results：spec F1 / security F2、spec F2）。
    (a) 账号 E：预测关卡选 d（这个选项没有错误概念标签）→ 按题记的 qz-mddareapoe。预测关卡有部件，重测页出不了它，
        只能回示范页重做；D+1 重做且做对，这条错题要按重测推进（step 1、D+4、已订正），不能一直到期。
    (b) 账号 F：同一天既有按题记的 qz-mddsttwotier（题 2 答错但没有标签），又有 mc-graphaspath；
        一次重测里两项不能出同一道题（先出的那张卡片的反馈会亮出答案，第二遍等于白送一次通过）。"""
    D1, D4 = R.day(1), R.day(4)
    mobile = flow_mobile(R, False)

    # ---------------- (a) ----------------
    ctx = R.new_context(mobile=mobile)
    page = R.new_page(ctx)
    R.set_day(ctx, 0)
    page.goto(R.url("math/demo-poe.html"), wait_until="load")
    name = R.new_user("e")
    R.register(page, name)
    R.info("账号 E = %s" % name)
    rec = do_predict(R, page, ctx, "d", "sure", want=("saved",), prefix="E.D.")
    R.require("E.D.poe.record_saved", rec.get("state") == "saved", "记录状态 %r：%s" % (rec.get("state"), rec.get("text")), page)
    t = rec.get("text", "")
    R.check("E.D.poe.record_text", "已存入错题本「这道题」" in t and fmt_md(D1) in t,
            "应含「已存入错题本「这道题」」「%s」：%r" % (fmt_md(D1), t), page)
    ms = R.mistakes(page)
    m = ms.get(QZ_POE)
    R.require("E.D.mistake.exists", m is not None, "GET api/mistakes 里有 %s；现有 id：%s" % (QZ_POE, list(ms.keys())), page)
    rv = m.get("review") or {}
    R.check("E.D.mistake.fields",
            m.get("origin") == "quiz" and m.get("status") == 0 and rv.get("step") == 0 and rv.get("due") == iso(D1)
            and QID_POE in (m.get("qids") or []) and not (m.get("mc") or []) and ("mc-" + TAG) not in ms,
            "origin=%r status=%r step=%r due=%r（应为 %s）qids=%r mc=%r；有没有 mc-%s：%s" % (
                m.get("origin"), m.get("status"), rv.get("step"), rv.get("due"), iso(D1), m.get("qids"), m.get("mc"), TAG, ("mc-" + TAG) in ms), page)

    # D+1：重测页出不了这道题，列表里注明，并给回示范页的链接
    R.set_day(ctx, 1)
    page.goto(R.url("review.html"), wait_until="load")
    st = wait_review_state(R, page, ("list", "empty", "guest"))
    R.require("E.D1.review.list", st == "list", ".qz-review data-state=%r（应为 list）" % st, page)
    items = review_items(page)
    it = ([x for x in items if x["key"] == "q:" + QID_POE] or [None])[0]
    R.check("E.D1.review.no_retest_item", bool(it) and it["none"] == "true" and "暂时没有可用的重测题" in it["text"],
            "到期项 %s" % json.dumps(items, ensure_ascii=False), page)
    R.check("E.D1.review.link_back", bool(it) and bool(it["href"]) and ("math/demo-poe.html#qz-" + QID_POE) in it["href"],
            "链接 %r" % (it and it["href"]), page)
    start = page.locator("[data-qz-start]")
    R.check("E.D1.review.start_disabled", start.count() > 0 and start.first.is_disabled(), "没有能出的题时「开始重测」不可用", page)
    R.shot(page, "E_D1_review_list")

    # 顺着链接回示范页：做过的预测关卡打开是 free，do_predict 会先点「重新预测」
    link = page.locator('.qz-review .qz-due-item[data-key="q:%s"] a.qz-link' % QID_POE)
    R.require("E.D1.review.link_present", link.count() > 0, "到期项里有回示范页的 a.qz-link（%d 个）" % link.count(), page)
    with page.expect_navigation(wait_until="load"):
        link.first.click()
    wait_dd(R, page)
    st = stage_of(page, QID_POE)
    R.check("E.D1.poe.free", st == "free", "做过的预测关卡再打开 data-stage=%r（应为 free）" % st, page)
    rec = do_predict(R, page, ctx, "a", "sure", want=("saved",), prefix="E.D1.")
    R.require("E.D1.poe.record_saved", rec.get("state") == "saved", "记录状态 %r：%s" % (rec.get("state"), rec.get("text")), page)
    t = rec.get("text", "")
    R.check("E.D1.poe.record_text", ("「这道题」下次重测：" + fmt_md(D4)) in t, "应含「「这道题」下次重测：%s」：%r" % (fmt_md(D4), t), page)
    m = R.mistakes(page).get(QZ_POE) or {}
    rv = m.get("review") or {}
    R.check("E.D1.mistake.status", m.get("status") == 1, "want 1 got %r" % m.get("status"), page)
    R.check("E.D1.mistake.review.step", rv.get("step") == 1, "want 1 got %r" % rv.get("step"), page)
    R.check("E.D1.mistake.review.due", rv.get("due") == iso(D4), "want %s got %r" % (iso(D4), rv.get("due")), page)
    tries = (R.quiz_records(page).get(QID_POE) or {}).get("tries") or []
    last = tries[-1] if tries else {}
    R.check("E.D1.quiz.attempt_mode_poe", last.get("cls") == "pass" and last.get("mode") == "poe" and last.get("d") == iso(D1),
            "存进 api/quiz 的作答仍是 mode poe：最后一条 %s" % json.dumps(last, ensure_ascii=False))
    page.goto(R.url("review.html"), wait_until="load")
    st = wait_review_state(R, page, ("list", "empty", "guest"))
    R.check("E.D1.review.cleared", st == "empty", "重做以后重测页 data-state=%r（应为 empty：这项已排到 %s）" % (st, iso(D4)), page)

    # ---------------- (b) ----------------
    ctx = R.new_context(mobile=mobile)
    page = R.new_page(ctx)
    R.set_day(ctx, 0)
    page.goto(R.url("math/demo-poe.html"), wait_until="load")
    name = R.new_user("f")
    R.register(page, name)
    R.info("账号 F = %s" % name)
    # 先做题 2：c / r2 / 有把握 → 答案错、选项上没有标签 → gap，按题记 qz-mddsttwotier（题 2 retest:true，重测页能出它）。
    # 再做预测关卡选 b → mc-graphaspath。graphaspath 最近一次作答于是落在预测关卡（情境「动点面积」），
    # pickRetest 会优先挑情境不同的题 2，正好和 q: 键要出的题撞上——这就是要测的情形。
    rec, _ = answer_card(R, page, QID_TT, "c", "r2", "sure", want=("saved",))
    R.require("F.D.twotier.saved", rec.get("state") == "saved", "记录状态 %r：%s" % (rec.get("state"), rec.get("text")), page)
    rec = do_predict(R, page, ctx, "b", "sure", want=("saved",), prefix="F.D.")
    R.require("F.D.poe.saved", rec.get("state") == "saved", "记录状态 %r：%s" % (rec.get("state"), rec.get("text")), page)
    ms = R.mistakes(page)
    R.require("F.D.mistakes", QZ_TT in ms and ("mc-" + TAG) in ms, "应有 %s 和 mc-%s；现有 id：%s" % (QZ_TT, TAG, list(ms.keys())), page)
    R.check("F.D.qz_untagged", not (ms[QZ_TT].get("mc") or []), "%s 的 mc=%r（应为空）" % (QZ_TT, ms[QZ_TT].get("mc")), page)

    R.set_day(ctx, 1)
    page.goto(R.url("review.html"), wait_until="load")
    st = wait_review_state(R, page, ("list", "empty", "guest"))
    R.require("F.D1.review.list", st == "list", ".qz-review data-state=%r（应为 list）" % st, page)
    items = review_items(page)
    R.check("F.D1.review.two_due", sorted(x["key"] for x in items) == sorted([TAG, "q:" + QID_TT]) and not any(x["none"] for x in items),
            "到期项 %s" % json.dumps(items, ensure_ascii=False), page)
    page.locator("[data-qz-start]").first.click()
    R.require("F.D1.review.run", wait_review_state(R, page, ("run",)) == "run", "点「开始重测」后进入 run", page)
    served = []
    for n in (1, 2):
        try:
            qid = wait_js(page, """(n) => { var h = document.querySelector('.qz-review .qz-run-head'); var c = document.querySelector('.qz-review .qz-card');
                return h && c && h.textContent.indexOf('第 ' + n + ' / 2 题') === 0 ? c.getAttribute('data-qid') : false; }""", n, 15000)
        except PWTimeout:
            R.require("F.D1.card%d" % n, False, "等不到第 %d / 2 题的卡片" % n, page)
        served.append(qid)
        ans = RIGHT.get(qid)
        R.require("F.D1.card%d.retestable" % n, ans is not None, "第 %d 题出的是 %r" % (n, qid), page)
        rec, premark = answer_card(R, page, qid, ans[0], ans[1], "sure", want=("saved",))
        R.require("F.D1.card%d.saved" % n, rec.get("state") == "saved", "记录状态 %r：%s" % (rec.get("state"), rec.get("text")), page)
        page.locator(".qz-review [data-qz-next]").last.click()
    R.check("F.D1.review.distinct_items", len(served) == 2 and served[0] != served[1], "两张卡片的 data-qid：%s" % served, page)
    R.check("F.D1.review.q_key_own_item", QID_TT in served, "q:%s 只能出它自己：%s" % (QID_TT, served), page)
    st = wait_review_state(R, page, ("summary",))
    si = review_items(page, ".qz-sum-item")
    R.check("F.D1.review.summary", st == "summary" and len(si) == 2 and all(("下次重测：" + fmt_md(D4)) in x["text"] for x in si),
            "state=%r 小结 %s" % (st, json.dumps(si, ensure_ascii=False)), page)


def sc_regression(R):
    """§11.C.7：导图标签数与基线一致（只多出测试标签）；?kp= / ?task= 定位；搜索；旧格式错题和测试来的错题在抽屉里编辑保存。"""
    ctx = R.new_context(mobile=False)
    page = R.new_page(ctx)
    # ---- 标签数 ----
    for subj in ("physics", "chemistry", "math", "biology"):
        page.goto(R.url("%s/knowledge-map.html" % subj), wait_until="load")
        page.wait_for_timeout(2000)
        c = page.evaluate("() => window.__e2e.chips()")
        base = BASELINE[subj]
        R.check("chips.%s.default" % subj, c["nonquiz"] == base["default"],
                "非测试标签 %d（基线 %d）；kinds=%s" % (c["nonquiz"], base["default"], c["kinds"]), page)
        refs = sorted(q["ref"] for q in c["quiz"])
        R.check("chips.%s.quiz" % subj, refs == sorted(QUIZ_CHIPS[subj]), "测试标签 %s（应为 %s）" % (refs, QUIZ_CHIPS[subj]), page)
        if subj == "math":
            texts = [q["text"] for q in c["quiz"]]
            R.check("chips.math.quiz_guest_text", texts and all(t == "理解测试 →" for t in texts), "游客文字 %s" % texts, page)
            hrefs = [q["href"] for q in c["quiz"]]
            R.check("chips.math.quiz_href", hrefs and all(QUIZ_PAGES.get(q["ref"], "?") in q["href"] and "#qz-" in q["href"] for q in c["quiz"]), "链接 %s" % hrefs, page)
        has_toggle = page.evaluate("() => !!document.getElementById('hsToggle')")
        if base["hs"] is not None:
            if not has_toggle:
                R.check("chips.%s.hs" % subj, False, "没有找到 #hsToggle", page)
                continue
            page.evaluate("() => { var t = document.getElementById('hsToggle'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }")
            page.wait_for_timeout(800)
            c = page.evaluate("() => window.__e2e.chips()")
            # 开高中后测试标签不变（第 1 批 A 的题都是初中题）
            hs_refs = sorted(q["ref"] for q in c["quiz"])
            R.check("chips.%s.hs" % subj, c["nonquiz"] == base["hs"] and hs_refs == sorted(QUIZ_CHIPS[subj]),
                    "开高中后非测试标签 %d（基线 %d），测试标签 %s" % (c["nonquiz"], base["hs"], hs_refs), page)
            page.evaluate("() => { var t = document.getElementById('hsToggle'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); }")
        elif has_toggle:
            R.info("%s 导图出现了 #hsToggle（基线没有）" % subj)

    # ---- ?kp= 深链 ----
    page.goto(R.url("math/knowledge-map.html?kp=c22-2-2"), wait_until="load")
    # 导图开了平滑滚动：要等滚动停下来再判断，否则元素正好「路过」视口也会被误判为定位成功
    page.wait_for_timeout(1500)
    last, still, t_end = None, 0, time.time() + 10
    while time.time() < t_end and still < 3:
        y = page.evaluate("() => window.scrollY")
        still = still + 1 if (last is not None and abs(y - last) < 1) else 0
        last = y
        page.wait_for_timeout(200)
    js = """() => { var el = document.querySelector('li.ok[data-key="c22-2-2"]'); if (!el) return { found: false };
      var r = el.getBoundingClientRect(), closed = 0, H = innerHeight;
      for (var p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS' && !p.open) closed++;
      var inView = r.height <= H ? (r.top >= -2 && r.bottom <= H + 2) : (r.top >= -2 && r.top < H / 2);
      return { found: true, top: Math.round(r.top), bottom: Math.round(r.bottom), h: H, scrollY: Math.round(scrollY), closed: closed,
               ok: r.height > 0 && inView && closed === 0 }; }"""
    k = page.evaluate(js)
    R.check("deeplink.kp", bool(k.get("ok")), "?kp=c22-2-2 → %s" % json.dumps(k), page)

    # ---- ?task= 定位 ----
    page.goto(R.url("chemistry/neutralization.html?task=drip"), wait_until="load")
    try:
        wait_js(page, "() => { var e = document.querySelector('[data-task=\"drip\"]'); return !!e && e.classList.contains('lk-flash'); }", None, 6000)
        R.check("deeplink.task", True, "[data-task=drip] 加上了 lk-flash")
    except PWTimeout:
        R.check("deeplink.task", False, "6 秒内 [data-task=drip] 没有 lk-flash", page)

    # ---- 搜索 ----
    def search(path, how):
        page.goto(R.url(path), wait_until="load")
        page.wait_for_timeout(500)
        if how == "button":
            page.locator("#absShellSearchBtn").click()
        else:
            page.keyboard.press("Control+K")
        try:
            inp = page.locator(".ss-back.open .ss-in")
            inp.wait_for(state="visible", timeout=8000)
            inp.fill("函数")
            wait_js(page, "() => document.querySelectorAll('.ss-back.open .ss-it').length > 0", None, 8000)
            n = page.evaluate("() => document.querySelectorAll('.ss-back.open .ss-it').length")
            first = page.evaluate("() => { var a = document.querySelector('.ss-back.open .ss-it'); return a ? a.textContent.replace(/\\s+/g, ' ').trim() : ''; }")
            R.check("search.%s" % how, n > 0 and "函数" in first, "%s：%d 条结果，第一条 %r" % (path, n, short(first, 60)), page)
        except PWTimeout:
            R.check("search.%s" % how, False, "%s：搜「函数」没有结果" % path, page)

    search("index.html", "button")
    search("math/knowledge-map.html", "ctrl_k")

    # ---- 错题本：旧格式错题、测试来的错题 ----
    ctx2 = R.new_context(mobile=False)
    page = R.new_page(ctx2)
    D = R.day(0)
    page.goto(R.url("math/demo-poe.html"), wait_until="load")
    if R.state.get("A"):
        R.login(page, R.state["A"])
        R.info("用 closed_loop 的账号 A = %s 检查抽屉" % R.state["A"])
    else:
        name = R.new_user("r")
        R.register(page, name)
        R.info("closed_loop 没跑：新注册账号 %s，测试来的错题用接口直接写入" % name)

    # 顶栏账号窗里的「今日重测」链接（CONTRACT §8.5）
    try:
        page.evaluate("() => window.ABSLabOpenAuth && window.ABSLabOpenAuth()")
        page.wait_for_selector("#absReviewLink", timeout=5000)
        href = page.evaluate("() => document.getElementById('absReviewLink').href")
        txt = page.locator("#absReviewLink").text_content() or ""
        R.check("topbar.review_link", href == R.url("review.html") and "今日重测" in txt, "href=%r text=%r" % (href, txt), page)
        page.evaluate("() => { var b = document.getElementById('absShellModal'); if (b) b.classList.remove('open'); }")
    except PWTimeout:
        R.check("topbar.review_link", False, "登录后账号窗里没有 #absReviewLink", page)

    old = {"id": "math-oldfmt01", "subject": "math", "kp": "c22-2-2", "kpName": "画函数图象与读图", "chapter": "第二十二章",
           "source": "练习册", "date": iso(D), "question": "旧格式错题", "wrong": "把图象当成运动路线", "fix": "图象表示两个量的对应关系",
           "tags": ["计算"], "status": 0}
    r = R.api(page, "mistakes", "POST", {"op": "upsert", "item": old})
    R.require("oldfmt.upsert", r["status"] == 200, "POST upsert 旧格式错题 → %s %s" % (r["status"], r["text"]), page)
    ms = R.mistakes(page)
    q0 = ms.get("mc-" + TAG)
    if q0 is None or q0.get("origin") != "quiz":
        quiz_item = {"id": "mc-" + TAG, "subject": "math", "kp": "c22-2-2", "kpName": "", "chapter": "", "source": "理解测试", "date": iso(D),
                     "question": "【错误概念】" + TAG_NAME + "｜最近一次：测试数据", "wrong": "答案：b；把握：有把握", "fix": "图象不是运动路线",
                     "tags": ["概念不清"], "status": 0, "origin": "quiz", "mc": [TAG], "qids": [QID_POE],
                     "review": {"step": 0, "due": iso(R.day(1)), "last": iso(D), "stable": False, "hist": [{"d": iso(D), "qid": QID_POE, "cls": "mc"}]}}
        r = R.api(page, "mistakes", "POST", {"op": "upsert", "item": quiz_item})
        R.require("quizfmt.upsert", r["status"] == 200, "POST upsert 测试来的错题 → %s %s" % (r["status"], r["text"]), page)
        q0 = R.mistakes(page).get("mc-" + TAG)
    R.require("quizfmt.has_fields", q0 and q0.get("origin") == "quiz" and q0.get("review"), "接口原样保存 origin/mc/review：%s" % short(json.dumps(q0, ensure_ascii=False), 300), page)

    page.goto(R.url("math/knowledge-map.html"), wait_until="load")
    try:
        wait_js(page, "() => !!(window.ABSLabMistakes && window.ABSLabMistakes.open)", None, 15000)
        page.evaluate("() => window.ABSLabMistakes.open('')")
        wait_js(page, "() => { var d = document.querySelector('.mk-drawer'); return !!d && d.textContent.indexOf('旧格式错题') >= 0; }", None, 15000)
        R.check("oldfmt.shown", page.locator(".mk-drawer").get_by_text("旧格式错题").first.is_visible(), "抽屉里显示旧格式错题", page)
    except PWTimeout:
        R.require("oldfmt.shown", False, "抽屉里没有显示旧格式错题", page)

    def edit_and_save(mid, new_q, status=None):
        page.locator('.mk-drawer [data-mk-edit="%s"]' % mid).first.click()
        ta = page.locator('.mk-drawer form[data-mk-form] textarea[name="question"]')
        ta.wait_for(state="visible", timeout=8000)
        ta.fill(new_q)
        if status is not None:
            page.locator('.mk-drawer form[data-mk-form] input[name="status"][value="%d"]' % status).check()
        page.locator('.mk-drawer form[data-mk-form] button[type="submit"]').click()
        try:
            wait_js(page, "() => { var d = document.querySelector('.mk-drawer'); return !!d && !d.querySelector('[data-mk-form]') && d.textContent.indexOf('已保存') >= 0; }", None, 10000)
            return True
        except PWTimeout:
            return False

    ok = edit_and_save("math-oldfmt01", "旧格式错题（已改）", status=1)
    R.check("oldfmt.saved_ui", ok, "抽屉里编辑后保存成功（出现「已保存」）", page)
    m = R.mistakes(page).get("math-oldfmt01") or {}
    R.check("oldfmt.saved_api", m.get("question") == "旧格式错题（已改）" and m.get("status") == 1 and m.get("tags") == ["计算"] and m.get("source") == "练习册" and m.get("kp") == "c22-2-2",
            "GET：question=%r status=%r tags=%r source=%r kp=%r" % (m.get("question"), m.get("status"), m.get("tags"), m.get("source"), m.get("kp")), page)

    newq = (q0.get("question") or "") + "（看过了）"
    ok = edit_and_save("mc-" + TAG, newq)
    R.check("quizfmt.saved_ui", ok, "测试来的错题在抽屉里编辑后保存成功", page)
    q1 = R.mistakes(page).get("mc-" + TAG) or {}
    r0, r1 = q0.get("review") or {}, q1.get("review") or {}
    same = (q1.get("origin") == "quiz" and q1.get("mc") == q0.get("mc") and q1.get("qids") == q0.get("qids")
            and r1.get("step") == r0.get("step") and r1.get("due") == r0.get("due") and r1.get("stable") == r0.get("stable")
            and q1.get("status") == q0.get("status") and q1.get("question") == newq)
    R.check("quizfmt.fields_kept", same,
            "前 origin=%r mc=%r step=%r due=%r status=%r；后 origin=%r mc=%r step=%r due=%r status=%r question 已改=%r" % (
                q0.get("origin"), q0.get("mc"), r0.get("step"), r0.get("due"), q0.get("status"),
                q1.get("origin"), q1.get("mc"), r1.get("step"), r1.get("due"), q1.get("status"), q1.get("question") == newq), page)


FUNCS = {
    "offline": sc_offline,
    "mobile_drag": sc_mobile_drag,
    "closed_loop": sc_closed_loop,
    "stable": sc_stable,
    "mastery": sc_mastery,
    "guest": sc_guest,
    "edge": sc_edge,
    "regression": sc_regression,
}


# ------------------------------------------------------------- dev-server ----

def start_server(port, log_path):
    log = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(["node", os.path.join("tools", "dev-server.js"), str(port)], cwd=REPO, stdout=log, stderr=subprocess.STDOUT)
    url = "http://localhost:%d/abs-lab/" % port
    deadline = time.time() + 15
    while time.time() < deadline:
        if proc.poll() is not None:
            log.close()
            raise RuntimeError("dev-server 启动失败（退出码 %s），见 %s" % (proc.returncode, log_path))
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return proc, log
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    log.close()
    raise RuntimeError("dev-server 15 秒内没有响应 %s" % url)


def stop_server(proc, log):
    if proc is None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    try:
        log.close()
    except Exception:
        pass


# ------------------------------------------------------------------- main ----

def main():
    ap = argparse.ArgumentParser(description="ABS-LAB 第 0 批端到端测试（SPEC §11.C）")
    ap.add_argument("--only", default="", help="只跑这些场景，逗号分隔：" + ",".join(SCENARIOS))
    ap.add_argument("--headed", action="store_true", help="显示浏览器窗口")
    ap.add_argument("--keep", action="store_true", help="不删除 tests/__out__/ 里上次留下的 e2e_*.png 截图")
    ap.add_argument("--port", type=int, default=8090, help="dev-server 端口（默认 8090）")
    ap.add_argument("--no-server", action="store_true", help="不自己启动 dev-server，直接连已经在 --port 上运行的")
    ap.add_argument("--flow-device", choices=["auto", "desktop", "mobile"], default="auto",
                    help="预测题流程用的设备：auto = 游客用手机（触屏拖动），其余用桌面（鼠标拖动）")
    ap.add_argument("--slowmo", type=int, default=0, help=argparse.SUPPRESS)
    args = ap.parse_args()

    only = [s.strip() for s in args.only.split(",") if s.strip()] or list(SCENARIOS)
    bad = [s for s in only if s not in FUNCS]
    if bad:
        ap.error("未知场景 %s；可选：%s" % (bad, ", ".join(SCENARIOS)))

    os.makedirs(OUT, exist_ok=True)
    if not args.keep:
        for f in os.listdir(OUT):
            if f.startswith("e2e_") and f.endswith(".png"):
                try:
                    os.remove(os.path.join(OUT, f))
                except OSError:
                    pass

    base = "http://localhost:%d/abs-lab/" % args.port
    proc = log = None
    rows = []
    t_all = time.time()
    try:
        if not args.no_server:
            proc, log = start_server(args.port, os.path.join(OUT, "e2e_dev-server.log"))
        print("ABS-LAB 端到端测试：%s；场景 %s" % (base, ", ".join(only)), flush=True)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=not args.headed, slow_mo=args.slowmo or None)
            R = Runner(args, browser, base)
            print("D（上海时区今天）= %s" % iso(R.D), flush=True)
            for name in only:
                R.scen = name
                t0 = time.time()
                print("---- %s ----" % name, flush=True)
                n_before = len(R.rows)
                try:
                    FUNCS[name](R)
                except StepFail as e:
                    R.info("场景中止：%s" % short(e, 300))
                except Exception as e:
                    tb = traceback.format_exc().strip().splitlines()
                    R.check("exception", False, "%s: %s | %s" % (type(e).__name__, short(e, 300), " / ".join(l.strip() for l in tb[-4:])), R.last_page)
                finally:
                    errs = [x for x in R.page_errors if x[0] == name]
                    for _, kind, u, msg in errs[:8]:
                        R.info("页面报错（只供参考）%s @ %s: %s" % (kind, u.replace(base, ""), short(msg, 200)))
                    if len(errs) > 8:
                        R.info("……另有 %d 条页面报错" % (len(errs) - 8))
                    R.close_contexts()
                if len(R.rows) == n_before:
                    R.check("ran", False, "场景没有产生任何检查")
                print("     %s 用时 %.1f s" % (name, time.time() - t0), flush=True)
            rows = R.rows
            browser.close()
    except RuntimeError as e:
        print("FAIL  setup        dev-server                          %s" % e, flush=True)
        rows.append(("setup", "dev-server", False, str(e)))
    finally:
        stop_server(proc, log)

    # ---- 汇总 ----
    print("\n==== 汇总（用时 %.0f s）====" % (time.time() - t_all))
    print("%-12s %5s %5s  %s" % ("场景", "通过", "失败", "结果"))
    scen_order = [s for s in only] + (["setup"] if any(r[0] == "setup" for r in rows) else [])
    any_fail = False
    for s in scen_order:
        rs = [r for r in rows if r[0] == s]
        npass = sum(1 for r in rs if r[2])
        nfail = sum(1 for r in rs if not r[2])
        res = "未运行" if not rs else ("PASS" if nfail == 0 else "FAIL")
        if nfail or not rs:
            any_fail = True
        print("%-12s %5d %5d  %s" % (s, npass, nfail, res))
    fails = [r for r in rows if not r[2]]
    if fails:
        print("\n失败明细：")
        for s, n, _, reason in fails:
            print("  FAIL %-12s %-34s %s" % (s, n, short(reason, 300)))
    print("\n截图和 dev-server 日志：%s" % OUT)
    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main())
