#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ABS-LAB 第 1 批 A 端到端测试（任务书 SPEC-1A 第 8.C 节；选择器、测试钩子见 CONTRACT-1A 第 4～6 节）。

用法（在仓库根目录或任意目录）：
    python3 tests/e2e_batch1a.py                       # 全部场景
    python3 tests/e2e_batch1a.py --only pa_mobile,check
    python3 tests/e2e_batch1a.py --headed --keep --port 8093

场景：offline、lazy、pa_mobile、pe_mobile、m1_mobile、closed_loop、check、maps。
每个检查打印一行 PASS / FAIL + 原因（带上实际读到的数字），最后打印每个场景的汇总表；有任何失败退出码为 1，
没装 Playwright 时打印「未运行」、退出码为 2。
截图（tests/__out__/e2e1a_*.png）、下载的 CSV 和 dev-server 的输出都放在 tests/__out__/（已在 .gitignore 里，不提交）。

为什么这样写（和 tests/e2e_batch0.py 同一套做法，但不 import 它，这个文件自己就能跑）：
  - 自己启动 node tools/dev-server.js（默认端口 8092，通过 /abs-lab/ 子路径访问），能发现以 "/" 开头的绝对路径；
    dev-server 的 Redis 是内存模拟，每次启动都是空库，所以账号名每次随机生成。
  - 「跳天」靠改浏览器时钟：context.clock.set_fixed_time() 只冻结 Date，定时器和 rAF 照常走，必须在 goto 之前调用。
  - 手机上的拖动（滑块、动点、时间轴手柄）一律用 CDP 的 Input.dispatchTouchEvent 发真的触屏事件，
    不用改 input.value 的办法冒充；只有和改动前的页面逐字比对读数时，两边用同样的 input 事件设到同一个值。
  - 改动前的电学实验台：git show 11b2ae1:physics/circuits-lab.html，用 page.route 挂在 /abs-lab/physics/ 下的一个假地址上，
    相对路径（../shared/…）照样能加载，和改动后的页面在同样的滑块位置下比对 #r3、#s3、#g3（13 号：#r13、#s13、#o13）。
  - 选项的显示顺序在三个新题库里打乱过（id 不变、正确答案不总在第一个）：一律按 id 点，不按位置点。
  - 只用 Python 标准库 + Playwright（sync API）。
"""

import argparse
import csv
import datetime
import io
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
except ImportError:  # 装不了 Playwright 时给出明确提示（任务书 8.C：照写测试、标「未运行」）
    print("未运行：没有安装 Python Playwright（pip install playwright && python3 -m playwright install chromium）")
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.path.join(HERE, "__out__")

# 上海没有夏令时，固定 +8 即可，不依赖系统 tzdata
TZ8 = datetime.timezone(datetime.timedelta(hours=8))

SCENARIOS = ["offline", "lazy", "pa_mobile", "pe_mobile", "m1_mobile", "closed_loop", "check", "maps"]

PASSWORD = "pass1234"
ORIG_REV = "11b2ae1"                      # 第 1 批 A 动手之前的上游提交（电学实验台改动前的版本）
ORIG_PATH = "physics/__e2e1a_orig_circuits.html"   # 改动前的页面挂在这个假地址上（同一目录，相对路径不变）

# 预测关卡（CONTRACT 第 3、4 节）
QID_PA = "p-pa-poe"
QID_PE = "p-pe-poe"
QID_M1 = "m-m1-poe"
TAG_PE = "scaleuniform"
# 闭环里重测应出的题：同一个标签、情境和预测关卡（电子秤表盘）不同
RETEST_PE = ("p-pe-tt-ammeter", "p-pe-tt-height")

# 懒加载的五个资源（CONTRACT 第 4 节）
LAZY = ["shared/quiz/quiz.css", "physics/js/sensor-models.js", "shared/svgkit.js", "shared/quiz/core.js", "shared/quiz/engine.js"]

# 任务书 8.C 第一条要逐页打开的页面（动点页、电学实验台、小测页在场景里还要再操作一下）
OFFLINE_PAGES = [
    "index.html", "math/index.html", "physics/index.html",
    "math/moving-point.html", "physics/circuits-lab.html#3", "physics/circuits-lab.html#13", "check.html?m=pa&t=pre",
]

# 导图标签数（任务书第 8 节：1280×900、游客、只数可见的、不含 data-kind="quiz"）。
# 第 1 批 A 之后是物理 49 / 50、化学 4 / 7、数学 12；第 1 批 B 新增的关联（任务书 1B 第 7.2 节）让数学 +4、化学 +11
BASELINE = {
    "physics": {"default": 49, "hs": 50},
    "chemistry": {"default": 15, "hs": 18},
    "math": {"default": 16, "hs": None},
    "biology": {"default": 13, "hs": None},
}
# 任务书 6.6 节新增的关联：知识点 → 实验 target
NEW_LINKS = {
    "math:c26-1-1": ["mpoint-pq"], "math:c26-4-1": ["mpoint-pq"],
    "math:c23-4-2": ["mpoint-rect", "mpoint-time"], "math:c22-2-2": ["mpoint-rect"],
    "physics:k4": ["circuits-m3"], "physics:k6": ["circuits-m13"],
}
# 实验页上的反向链接：target → 应该出现的知识点标签
BACKLINKS = {
    "mpoint-pq": ["math:c26-1-1", "math:c26-4-1"],
    "mpoint-rect": ["math:c23-4-2", "math:c22-2-2"],
    "mpoint-time": ["math:c23-4-2"],
    "circuits-m3": ["physics:k4"],
    "circuits-m13": ["physics:k6"],
}

# 理解小测：CSV 的列名（任务书 3.2 节的 10 列 + 「编号」），逐字
CSV_HEAD = ["模块", "前测 / 后测", "日期", "题目 id", "答案", "理由", "把握", "判定", "错误概念标签", "用时（秒）", "编号"]
# 理解小测的作答（按题目 id，与显示顺序无关）：(答案, 理由, 把握)。故意混着来：
#   对且有把握、对但没把握、答错且有把握（选到带标签的错项）、答错且没把握、答案对理由错……
CHECK_PRE = {
    "m-m1-tt-pq6": ("a", "r1", "sure"),      # pass
    "m-m1-tt-square": ("a", "r1", "unsure"), # unsure
    "m-m1-tt-kink": ("b", "r2", "sure"),     # 答错有把握：kinkwhere
    "m-m1-tt-time": ("c", "r1", "unsure"),   # 答错没把握、没有标签：gap
    "m-m1-tt-walk": ("a", "r2", "sure"),     # 答案对、理由错：graphaspath
    "m-m1-tt-fill": ("c", "r3", "sure"),     # 答错有把握：uniformislinear（答案、理由同一个标签，只记一次）
    "m-m1-tr-start": ("b", "r2", "unsure"),  # 答错没把握：gap
    "m-m1-tr-speed": ("b", "r2", "sure"),    # 答案错（无标签）、理由错（uniformislinear）、有把握：mc
    "m-m1-inv-sides": ("c", "r2", "unsure"), # 答错没把握、选到带标签的错项：gap + graphaspath
}
CHECK_POST = {
    "m-m1-tt-pq6": ("a", "r1", "sure"),
    "m-m1-tt-square": ("a", "r1", "sure"),
    "m-m1-tt-kink": ("a", "r1", "sure"),
    "m-m1-tt-time": ("a", "r1", "unsure"),
    "m-m1-tt-walk": ("a", "r1", "sure"),
    "m-m1-tt-fill": ("b", "r2", "sure"),     # 答错有把握：graphaspath
    "m-m1-tr-start": ("a", "r1", "sure"),
    "m-m1-tr-speed": ("a", "r2", "sure"),    # 答案对、理由错：uniformislinear
    "m-m1-inv-sides": ("a", "r1", "sure"),
}
# 上面两组作答按题库（shared/quiz/items/math-m1.json）逐题手算的结果，写死在这里：
# 页面的 classify 和小结如果一起算错，测试照样能发现（下面还会用页面的 classify 和 Python 版各算一遍，三者必须一致）。
#   判定规则（任务书 3.4）：答案对理由对有把握 pass、没把握 unsure；答案对理由错 mc；答案错有把握 mc、没把握 gap；判 mc 但没有标签改判 gap。
#   标签：答错的答案选项、答错的理由选项上的 mc 标签（同一个只记一次）；gap 题选到带标签的错项也记。
CHECK_PRE_HAND = {
    "cls": {"m-m1-tt-pq6": ("pass", []), "m-m1-tt-square": ("unsure", []), "m-m1-tt-kink": ("mc", ["kinkwhere"]),
            "m-m1-tt-time": ("gap", []), "m-m1-tt-walk": ("mc", ["graphaspath"]), "m-m1-tt-fill": ("mc", ["uniformislinear"]),
            "m-m1-tr-start": ("gap", []), "m-m1-tr-speed": ("mc", ["uniformislinear"]), "m-m1-inv-sides": ("gap", ["graphaspath"])},
    "pass": 1, "sureWrong": 3,          # 有把握却答错：kink、fill、speed（walk 答案是对的，不算）
    "tags": {"kinkwhere": 1, "graphaspath": 2, "uniformislinear": 2},
}
CHECK_POST_HAND = {
    "cls": {"m-m1-tt-pq6": ("pass", []), "m-m1-tt-square": ("pass", []), "m-m1-tt-kink": ("pass", []),
            "m-m1-tt-time": ("unsure", []), "m-m1-tt-walk": ("pass", []), "m-m1-tt-fill": ("mc", ["graphaspath"]),
            "m-m1-tr-start": ("pass", []), "m-m1-tr-speed": ("mc", ["uniformislinear"]), "m-m1-inv-sides": ("pass", [])},
    "pass": 6, "sureWrong": 1,          # 有把握却答错：fill
    "tags": {"graphaspath": 1, "uniformislinear": 1},
}
CHECK_CODE = "E2E-%02d" % random.randint(0, 99)

# 解释至少 6 个字（预测关卡 explain.min = 6），写一句完整的中文
EXPLAIN_PA = "电流相同时两段电压加起来总等于电源电压"
EXPLAIN_PE = "电阻在分母上所以示数不随压力均匀变化"
EXPLAIN_M1 = "一条边变长一条边变短乘积先变大后变小"

# 注入每个页面的测试辅助函数（只读，不改页面状态）。在页面脚本之前运行，导航后自动重新注入。
HELPER_JS = r"""
(function () {
  if (window.__e2e) return;
  var H = {};
  H.isShown = function (el) {
    if (!el) return false;
    for (var p = el; p && p !== document.documentElement; p = p.parentElement) {
      if (getComputedStyle(p).display === "none") return false;
    }
    return el.getClientRects().length > 0;
  };
  // 与任务书第 8 节基线同一种数法：只数祖先链上没有 display:none 的 .lk-chip
  H.chips = function () {
    var all = Array.prototype.slice.call(document.querySelectorAll(".lk-chip"));
    var shown = all.filter(function (el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) { if (getComputedStyle(p).display === "none") return false; }
      return true;
    });
    var kinds = {};
    shown.forEach(function (c) { var k = c.getAttribute("data-kind") || "?"; kinds[k] = (kinds[k] || 0) + 1; });
    return { dom: all.length, shown: shown.length, nonquiz: shown.length - (kinds.quiz || 0), kinds: kinds };
  };
  // 滑块上数值 v 的位置（视口坐标）。circuits-lab.html 的拇指：触屏 30px 宽，鼠标 22px 宽
  H.sliderXY = function (sel, v) {
    var i = document.querySelector(sel); if (!i) return null;
    var b = i.getBoundingClientRect(), mn = +i.min, mx = +i.max;
    var th = matchMedia("(pointer:coarse)").matches ? 30 : 22;
    return [b.left + th / 2 + (b.width - th) * (v - mn) / (mx - mn), b.top + b.height / 2];
  };
  H.hitIs = function (sel, xy) { var e = document.elementFromPoint(xy[0], xy[1]); var t = document.querySelector(sel); return !!e && !!t && (e === t || t.contains(e)); };
  // 动点页：画板的世界坐标 → 视口坐标（board.toScreen 给 svg 内坐标，再用 getScreenCTM 换到视口）
  H.mpClient = function (key, which, xy) {
    var b = window.__mp.boards(key)[which], s = b.toScreen(xy), svg = b.svg;
    var m = svg.getScreenCTM ? svg.getScreenCTM() : null;
    if (m && svg.createSVGPoint) { var p = svg.createSVGPoint(); p.x = s[0]; p.y = s[1]; p = p.matrixTransform(m); return [p.x, p.y]; }
    var r = svg.getBoundingClientRect(); return [r.left + s[0], r.top + s[1]];
  };
  H.mpClientMany = function (key, which, pts) { return pts.map(function (p) { return H.mpClient(key, which, p); }); };
  // 函数板上画出来的折线（svg 里的 points）换回世界坐标
  H.mpPolylines = function (key, which) {
    var b = window.__mp.boards(key)[which];
    return Array.prototype.map.call(b.svg.querySelectorAll("polyline"), function (pl) {
      var pts = (pl.getAttribute("points") || "").trim().split(/\s+/).filter(Boolean).map(function (q) {
        var a = q.split(",").map(Number); return b.toWorld(a);
      });
      return { cls: pl.getAttribute("class") || "", pts: pts };
    });
  };
  // 外部部件卡片（电学实验台、动点页的预测关卡）：作答区里的 section.qz-card[data-qid]
  H.extCard = function (host) { var cs = document.querySelectorAll(host + " .qz-card[data-qid]"); return cs.length ? cs[cs.length - 1] : null; };
  H.extStage = function (host) { var c = H.extCard(host); return c ? c.getAttribute("data-stage") : null; };
  H.extRecord = function (host) {
    var c = H.extCard(host); if (!c) return null;
    var r = c.querySelector(".qz-record"); if (!r) return { state: null, text: "" };
    return { state: r.getAttribute("data-state"), text: (r.textContent || "").replace(/\s+/g, " ").trim() };
  };
  // 普通题卡片（重测页）
  H.card = function (qid) { var cs = document.querySelectorAll('.qz-card[data-qid="' + qid + '"]'); return cs.length ? cs[cs.length - 1] : null; };
  H.record = function (qid) {
    var c = H.card(qid); if (!c) return null;
    var r = c.querySelector(".qz-record"); if (!r) return { state: null, text: "" };
    return { state: r.getAttribute("data-state"), text: (r.textContent || "").replace(/\s+/g, " ").trim() };
  };
  H.stage = function (qid) { var c = H.card(qid); return c ? c.getAttribute("data-stage") : null; };
  // 3 号模块小灯泡模式：两个工作点的属性、读数文字
  H.pa = function () {
    var g = document.getElementById("g3"), out = { m3: window.__lab ? window.__lab.m3() : null, pts: {}, r3: "" };
    if (g) Array.prototype.forEach.call(g.querySelectorAll("[data-pt]"), function (e) {
      out.pts[e.getAttribute("data-pt")] = { u: e.getAttribute("data-u"), i: e.getAttribute("data-i"),
        cx: +e.getAttribute("cx"), cy: +e.getAttribute("cy") };
    });
    var o3 = document.getElementById("o3"); out.o3 = o3 ? o3.textContent : "";
    out.curves = g ? Array.prototype.map.call(g.querySelectorAll("[data-curve]"), function (e) { return e.getAttribute("data-curve"); }) : [];
    out.sum = !!(g && g.querySelector("[data-sum]"));
    var r = document.getElementById("r3"); out.r3 = r ? r.innerText : "";
    out.value = document.getElementById("i3p").value;
    return out;
  };
  // 13 号模块：表盘上画出来的刻度线、指针、提示
  H.pe = function () {
    var s = document.getElementById("s13"), out = { m13: window.__lab ? window.__lab.m13() : null, ticks: [], pointer: null };
    if (s) {
      Array.prototype.forEach.call(s.querySelectorAll("[data-tick]"), function (e) { out.ticks.push([+e.getAttribute("data-tick"), +e.getAttribute("data-angle")]); });
      // 画出来的线（path 的 d）：测试里用端点算角度，和 data-angle 互相核对
      out.tickD = Array.prototype.map.call(s.querySelectorAll("[data-tick]"), function (e) { return [+e.getAttribute("data-tick"), e.getAttribute("d") || ""]; });
      var p = s.querySelector("[data-pointer]"); out.pointer = p ? +p.getAttribute("data-angle") : null;
      out.pointerD = p ? (p.getAttribute("d") || "") : "";
      out.svgText = s.textContent;
    }
    out.o13 = (document.getElementById("o13") || {}).textContent || "";
    out.r13 = (document.getElementById("r13") || {}).textContent || "";
    out.value = document.getElementById("i13x").value;
    return out;
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


def short(s, n=160):
    s = re.sub(r"\s+", " ", str(s)).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def jd(x):
    return json.dumps(x, ensure_ascii=False)


def load_json(rel):
    with open(os.path.join(REPO, rel), encoding="utf-8") as f:
        return json.load(f)


class Runner:
    def __init__(self, args, browser, base):
        self.args = args
        self.browser = browser
        self.base = base
        self.rows = []          # (scenario, check, ok, reason)
        self.scen = ""
        self.contexts = []
        self.last_page = None
        self.page_errors = []   # 页面的 console.error / pageerror（场景自己决定算不算失败）
        self.D = datetime.datetime.now(TZ8).date()
        self.shots = 0
        self.mobile = {}       # id(context) → 是不是手机触屏上下文（决定拖动用触屏还是鼠标）
        self._orig = None

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

    def shot(self, page, label, full=False):
        try:
            safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", label)[:80]
            path = os.path.join(OUT, "e2e1a_%s_%s.png" % (self.scen, safe))
            page.screenshot(path=path, full_page=full, timeout=10000)
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

    def errors_of(self, scen=None):
        scen = scen or self.scen
        return [x for x in self.page_errors if x[0] == scen]

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

    def orig_html(self):
        """改动前的电学实验台（git show 11b2ae1:physics/circuits-lab.html）。读不到就记 FAIL 并中止这个场景。"""
        if self._orig is None:
            try:
                self._orig = subprocess.run(["git", "show", "%s:physics/circuits-lab.html" % ORIG_REV], cwd=REPO,
                                            capture_output=True, check=True).stdout.decode("utf-8")
            except Exception as e:
                self.require("orig.git_show", False, "读不到改动前的页面 git show %s:physics/circuits-lab.html：%s" % (ORIG_REV, e))
        return self._orig

    def route_orig(self, ctx):
        html = self.orig_html()
        ctx.route("**/abs-lab/" + ORIG_PATH, lambda r: r.fulfill(status=200, content_type="text/html; charset=utf-8", body=html))

    # ---------- 账号与接口 ----------
    def new_user(self, letter):
        # 用户名 2～20 个字符；dev-server 每次启动是空库，加随机数避免同一进程里重名
        return "e1a%s%06d" % (letter, random.randint(0, 999999))

    def register(self, page, name):
        res = page.evaluate("async ([n, p]) => await window.ABSLabAuth.register(n, p)", [name, PASSWORD])
        ok = bool(res and res.get("ok") and res.get("cloud"))
        self.require("register", ok, "ABSLabAuth.register(%s) → %s" % (name, jd(res)), page)
        page.reload(wait_until="load")
        tok = page.evaluate("() => window.ABSLabAuth && window.ABSLabAuth.getToken()")
        self.require("register.token", bool(tok), "登录后 getToken() 有值", page)

    def api(self, page, name, method="GET", body=None):
        return page.evaluate(API_JS, [self.base + "api/" + name, method, body])

    def mistakes(self, page):
        r = self.api(page, "mistakes")
        if r["status"] != 200 or not r["json"] or not r["json"].get("ok"):
            raise StepFail("GET api/mistakes → %s %s" % (r["status"], r["text"]))
        return {m.get("id"): m for m in r["json"].get("items", [])}


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


def tap(R, ctx, page, target):
    """手机上下文用触屏点按（locator.tap），桌面用鼠标点。target 是选择器或 locator。"""
    loc = page.locator(target).first if isinstance(target, str) else target
    loc.scroll_into_view_if_needed()
    if R.mobile.get(id(ctx), False):
        loc.tap()
    else:
        loc.click()
    page.wait_for_timeout(80)


def pointer_path(R, ctx, page, pts, after_move=None, delay_ms=18):
    """按下 → 依次移到 pts[1:] → 抬起。手机上下文用 CDP 触屏事件（Input.dispatchTouchEvent），桌面用鼠标。
    after_move(k) 在每次 move 之后调用，返回值收集起来。"""
    out = []
    if R.mobile.get(id(ctx), False):
        cdp = ctx.new_cdp_session(page)
        try:
            def tp(p):
                return [{"x": float(p[0]), "y": float(p[1]), "id": 1, "radiusX": 4, "radiusY": 4, "force": 1}]
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": tp(pts[0])})
            page.wait_for_timeout(delay_ms)
            for k, p in enumerate(pts[1:]):
                cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": tp(p)})
                page.wait_for_timeout(delay_ms)
                if after_move:
                    out.append(after_move(k))
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
        for k, p in enumerate(pts[1:]):
            page.mouse.move(p[0], p[1])
            page.wait_for_timeout(delay_ms)
            if after_move:
                out.append(after_move(k))
        page.mouse.up()
    page.wait_for_timeout(200)
    return out


def slide(R, ctx, page, sel, targets, step=1.0, after_move=None):
    """真的拖滑块：手指（桌面是鼠标）按在拇指上，横着一步一步移到 targets 里的每个值（每步 step 个单位）。
    返回 (每步 after_move 的结果, 起点是否真的落在滑块上, 最终值)。"""
    page.evaluate("(s) => document.querySelector(s).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })", sel)
    page.wait_for_timeout(250)
    v0 = float(page.evaluate("(s) => document.querySelector(s).value", sel))
    vals, cur = [v0], v0
    for t in targets:
        n = max(1, int(math.ceil(abs(t - cur) / step - 1e-9)))
        vals += [cur + (t - cur) * i / n for i in range(1, n + 1)]
        cur = t
    pts = page.evaluate("([s, vs]) => vs.map(function (v) { return window.__e2e.sliderXY(s, v); })", [sel, vals])
    hit = page.evaluate("([s, p]) => window.__e2e.hitIs(s, p)", [sel, pts[0]])
    samples = pointer_path(R, ctx, page, pts, after_move)
    return samples, hit, float(page.evaluate("(s) => document.querySelector(s).value", sel))


def setv(page, sel, v):
    """只用于和改动前的页面逐字比对：两边用同样的 input 事件把滑块设到同一个值。"""
    page.evaluate("([s, v]) => { var i = document.querySelector(s); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }", [sel, v])


def js_click(page, sel):
    page.evaluate("(s) => document.querySelector(s).click()", sel)


def wait_ext(R, page, host, stages, timeout=15000):
    """等外部部件卡片进入某个阶段（data-stage）。"""
    try:
        wait_js(page, "([h, st]) => st.indexOf(window.__e2e.extStage(h)) >= 0", [host, list(stages)], timeout)
        return True
    except PWTimeout:
        R.info("%s 的卡片 data-stage 等不到 %s，现在是 %r" % (host, list(stages), page.evaluate("(h) => window.__e2e.extStage(h)", host)))
        return False


def wait_ext_record(page, host, want, timeout=20000):
    try:
        return wait_js(page, "([h, w]) => { var r = window.__e2e.extRecord(h); return r && r.state && (w.indexOf(r.state) >= 0 || r.state === 'error') ? r : false; }",
                       [host, list(want)], timeout)
    except PWTimeout:
        cur = page.evaluate("(h) => window.__e2e.extRecord(h)", host)
        return {"state": (cur or {}).get("state"), "text": (cur or {}).get("text", ""), "timeout": True}


def predict_ext(R, ctx, page, host, ch, cf, prefix):
    """外部部件卡片：按 id 选答案 + 把握度 → 提交预测 → 等 data-stage=operate。"""
    card = page.locator(host + " .qz-card[data-qid]").last
    tap(R, ctx, page, card.locator('[data-qz-ans="%s"]' % ch))
    tap(R, ctx, page, card.locator('[data-qz-cf="%s"]' % cf))
    sub = card.locator("[data-qz-submit]")
    R.require(prefix + "submit_enabled", is_enabled(sub), "选了 %s + %s 后「提交预测」可用" % (ch, cf), page)
    tap(R, ctx, page, sub)
    R.require(prefix + "stage_operate", wait_ext(R, page, host, ["operate"]), "提交预测后 data-stage=operate", page)
    page.wait_for_timeout(300)


def finish_ext(R, ctx, page, host, explain, want, prefix):
    """「看对比」→ 写解释 → 提交 → 等记录行。返回记录行。"""
    card = page.locator(host + " .qz-card[data-qid]").last
    cmp_btn = card.locator("[data-qz-compare]")
    R.require(prefix + "compare_enabled", is_enabled(cmp_btn), "完成条件满足后「看对比」可用", page)
    tap(R, ctx, page, cmp_btn)
    R.require(prefix + "stage_explain", wait_ext(R, page, host, ["explain"]), "点「看对比」后 data-stage=explain", page)
    ta = card.locator("textarea[data-qz-ex]")
    ta.wait_for(state="visible", timeout=10000)
    ta.fill(explain)
    exb = card.locator("[data-qz-ex-submit]")
    R.require(prefix + "explain_enabled", is_enabled(exb), "写了 %d 字解释后提交按钮可用" % len(explain), page)
    tap(R, ctx, page, exb)
    rec = wait_ext_record(page, host, want)
    return rec


def lock_layout(page, sec):
    """预测阶段的版面：页面滚到最上面（模块图在正常文档流里，不吸顶），量第一个预测选项顶部 − 模块图下沿。"""
    page.evaluate("() => window.scrollTo(0, 0)")
    page.wait_for_timeout(200)
    return page.evaluate("""(s) => {
      var st = document.querySelector('#' + s + ' .stage'), o = document.querySelector('#qz-' + s + '-ans [data-qz-ans]');
      var lk = document.querySelector('#' + s + ' .stage > .qz-lock');
      if (!st || !o) return null;
      var top = function (e) { var y = 0; for (; e; e = e.offsetParent) y += e.offsetTop; return y; };
      var sb = st.getBoundingClientRect(), ob = o.getBoundingClientRect();
      return { byRect: ob.top - sb.bottom, byOffset: top(o) - (top(st) + st.offsetHeight), stagePos: getComputedStyle(st).position,
               scrollY: window.scrollY, lockShown: !!lk && window.__e2e.isShown(lk), lockText: lk ? lk.textContent : '',
               locked: st.getAttribute('data-qz-locked'), firstOpt: o.getAttribute('data-qz-ans') };
    }""", sec)


def wait_review_state(R, page, states, timeout=20000):
    try:
        return wait_js(page, "(st) => { var r = document.querySelector('.qz-review'); var s = r && r.getAttribute('data-state'); return st.indexOf(s) >= 0 ? s : false; }",
                       list(states), timeout)
    except PWTimeout:
        return page.evaluate("() => { var r = document.querySelector('.qz-review'); return r ? r.getAttribute('data-state') : '(没有 .qz-review)'; }")


def answer_card(R, ctx, page, qid, ch, rs, cf, want=("saved", "guest")):
    """普通题 / 重测题：在 .qz-card[data-qid] 里按 id 选答案、理由、把握度 → 提交 → 等 .qz-record 的状态。"""
    sel = '.qz-card[data-qid="%s"]' % qid
    try:
        page.wait_for_selector(sel, timeout=20000)
    except PWTimeout:
        R.require("card." + qid, False, "没有出现 %s" % sel, page)
    card = page.locator(sel).last
    tap(R, ctx, page, card.locator('[data-qz-ans="%s"]' % ch))
    if rs:
        tap(R, ctx, page, card.locator('[data-qz-rs="%s"]' % rs))
    tap(R, ctx, page, card.locator('[data-qz-cf="%s"]' % cf))
    sub = card.locator("[data-qz-submit]")
    R.require("submit_enabled." + qid, is_enabled(sub), "选了答案/理由/把握度后「提交」可用", page)
    tap(R, ctx, page, sub)
    try:
        return wait_js(page, "([q, w]) => { var r = window.__e2e.record(q); return r && r.state && (w.indexOf(r.state) >= 0 || r.state === 'error') ? r : false; }",
                       [qid, list(want)], 20000)
    except PWTimeout:
        cur = page.evaluate("(q) => window.__e2e.record(q)", qid)
        return {"state": (cur or {}).get("state"), "text": (cur or {}).get("text", ""), "timeout": True}


def await_assets(R, page, prefix=""):
    """等电学实验台懒加载的资源都加载完（__lab.assets() 的 Promise）。"""
    try:
        ok = page.evaluate("async () => { var p = window.__lab && window.__lab.assets(); if (!p) return 'null'; await p; return 'ok'; }")
    except PWError as e:
        ok = "error: " + short(e, 200)
    R.require(prefix + "assets", ok == "ok", "__lab.assets() → %s" % ok, page)


def no_errors_check(R, name, page=None):
    errs = R.errors_of()
    R.check(name, not errs, "console.error / pageerror %d 条%s" % (
        len(errs), ("：" + " | ".join("%s %s @ %s" % (k, short(m, 120), u.replace(R.base, "")) for _, k, u, m in errs[:3])) if errs else ""), page)


def slider_attrs(page, ids):
    """滑块的 min / max / step / value / disabled（和改动前的页面比对用）。"""
    return page.evaluate("(ids) => ids.map(function (i) { var e = document.getElementById(i); return e ? [i, e.min, e.max, e.step, e.value, e.disabled] : [i, null]; })", ids)


def compare_pages(a, b, ids):
    """两个页面上同样 id 的元素 innerHTML 逐字比对；返回不一样的 id。"""
    ga = a.evaluate("(ids) => ids.map(function (i) { var e = document.getElementById(i); return e ? e.innerHTML : null; })", ids)
    gb = b.evaluate("(ids) => ids.map(function (i) { var e = document.getElementById(i); return e ? e.innerHTML : null; })", ids)
    return [ids[k] for k in range(len(ids)) if ga[k] != gb[k] or ga[k] is None], ga, gb


# ------------------------------------------------------------------ 场景 ----

def sc_offline(R):
    """8.C 第 1 条：拦截所有请求，主机不是 localhost 的记下并中止；390×844 触屏逐页打开，
    console.error、pageerror 都是 0，没有横向滚动。动点页每个标签页、电学实验台 3 号 / 13 号（等懒加载完、挂上预测卡片）、
    小测页（开始后看到第 1 题）都操作一下再查。"""
    ctx = R.new_context(mobile=True)
    cur = {"ext": None}
    total = {"ext": 0, "all": 0}

    def route_handler(route):
        u = route.request.url
        host = (urlparse(u).hostname or "").lower()
        total["all"] += 1
        if u.startswith(("http:", "https:", "ws:", "wss:")) and host not in ("localhost", "127.0.0.1", "::1"):
            total["ext"] += 1
            if cur["ext"] is not None:
                cur["ext"].append(u)
            route.abort()
            return
        route.continue_()

    ctx.route("**/*", route_handler)
    for path in OFFLINE_PAGES:
        ext, cons, perr, bad, notes = [], [], [], [], []
        cur["ext"] = ext
        page = R.new_page(ctx, track_errors=False)
        page.on("console", lambda m, cons=cons: cons.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e, perr=perr: perr.append(str(e)))
        page.on("response", lambda r, bad=bad: bad.append("%d %s" % (r.status, r.url)) if r.status >= 400 else None)
        nav_err = ""
        widths = []
        try:
            page.goto(R.url(path), wait_until="load", timeout=30000)
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except PWTimeout:
                pass
            page.wait_for_timeout(800)
            widths.append(("首屏", page.evaluate("() => document.documentElement.scrollWidth")))
            if path.startswith("math/moving-point.html"):
                wait_js(page, "() => !!window.__mp", None, 10000)
                page.evaluate("async () => { await window.__mp.gate(); return 1; }")
                for key in ("rect", "pq", "time"):
                    tap(R, ctx, page, '[role=tab][data-tab="%s"]' % key)
                    page.wait_for_timeout(400)
                    shown = page.evaluate("(k) => window.__mp.tab() === k && window.__e2e.isShown(document.querySelector('section[data-task=\"' + k + '\"]'))", key)
                    notes.append("%s:%s" % (key, "显示" if shown else "没显示"))
                    if not shown:
                        nav_err = nav_err or ("标签页 %s 没有切过去" % key)
                    widths.append((key, page.evaluate("() => document.documentElement.scrollWidth")))
            elif path.startswith("physics/circuits-lab.html"):
                wait_js(page, "() => !!window.__lab", None, 10000)
                st = page.evaluate("async () => { var p = window.__lab.assets(); if (!p) return 'null'; await p; return 'ok'; }")
                notes.append("assets %s" % st)
                if st != "ok":
                    nav_err = nav_err or "__lab.assets() → %s" % st
                # 挂上预测卡片：引擎、题库在断网（只剩 localhost）时也能加载
                btn, host = ('#m3 button[data-m3="lamp"]', "#qz-m3-ans") if path.endswith("#3") else ('#m13 button[data-m13="scale"]', "#qz-m13-ans")
                tap(R, ctx, page, btn)
                try:
                    page.wait_for_selector(host + " .qz-card[data-stage]", timeout=15000)
                    notes.append("预测卡片 %s" % page.evaluate("(h) => window.__e2e.extStage(h)", host))
                except PWTimeout:
                    nav_err = nav_err or "预测卡片没有挂上"
                page.wait_for_timeout(500)
                widths.append(("预测阶段", page.evaluate("() => document.documentElement.scrollWidth")))
            elif path.startswith("check.html"):
                page.wait_for_selector("[data-ck-start]", timeout=15000)
                tap(R, ctx, page, "[data-ck-start]")
                try:
                    page.wait_for_selector('[data-ck-num="1"]', timeout=15000)
                    page.wait_for_selector(".ck-card[data-qid]", timeout=5000)
                    notes.append("第 1 题 %s" % page.evaluate("() => document.querySelector('.ck-card').getAttribute('data-qid')"))
                except PWTimeout:
                    nav_err = nav_err or "开始以后没有看到第 1 题"
                page.wait_for_timeout(400)
                widths.append(("第 1 题", page.evaluate("() => document.documentElement.scrollWidth")))
        except (PWError, PWTimeout) as e:
            nav_err = nav_err or short(e, 200)
        ok = not ext and not cons and not perr and not nav_err
        parts = ["外部请求 %d" % len(ext), "console.error %d" % len(cons), "pageerror %d" % len(perr)]
        if notes:
            parts.append("，".join(notes))
        if nav_err:
            parts.append("出错: " + nav_err)
        if ext:
            parts.append("外部: " + ", ".join(ext[:3]))
        if cons:
            parts.append("console: " + " | ".join(short(c, 120) for c in cons[:3]))
        if perr:
            parts.append("pageerror: " + " | ".join(short(c, 120) for c in perr[:3]))
        if bad:
            parts.append("HTTP≥400（只供参考）: " + ", ".join(bad[:3]))
        R.check("page " + path, ok, "；".join(parts), page)
        wmax = max([w for _, w in widths if w is not None] or [None]) if widths else None
        R.check("no_hscroll_390 " + path, bool(widths) and wmax is not None and wmax <= 390,
                "scrollWidth %s" % "、".join("%s %s" % (k, w) for k, w in widths), page)
        page.close()
    cur["ext"] = None
    R.check("external_requests_total", total["ext"] == 0, "全部页面共发出请求 %d 个，其中外部请求 %d 个" % (total["all"], total["ext"]))


def sc_lazy(R):
    """8.C 第 2 条：新上下文打开电学实验台 1 号模块（再把其他 18 个模块都点一遍），五个测验资源一个都不请求；
    任务书 3.1「打开其他模块不多下载任何东西」：请求总数不变，切到 3 号之前也没有 shared/quiz/ 下的任何请求。
    用页面上的导航切到 3 号（断言 3 号确实打开了）以后才请求，再打开 13 号不重复加载。"""
    ctx = R.new_context(mobile=True)
    reqs = []
    ctx.on("request", lambda r: reqs.append(r.url))
    page = R.new_page(ctx)
    page.goto(R.url("physics/circuits-lab.html#1"), wait_until="load")
    try:
        page.wait_for_load_state("networkidle", timeout=10000)
    except PWTimeout:
        pass
    page.wait_for_timeout(600)
    cur = page.evaluate("() => document.querySelector('section.on') && document.querySelector('section.on').id")
    R.check("opened_module_1", cur == "m1", "打开 #1 后显示的模块 section#%s" % cur, page)
    rel = lambda u: u.split("/abs-lab/", 1)[-1].split("?")[0]
    hit0 = [rel(u) for u in reqs if rel(u) in LAZY]
    a0 = page.evaluate("() => window.__lab.assets() === null")
    dom0 = page.evaluate("() => Array.prototype.map.call(document.querySelectorAll('script[src],link[rel=stylesheet]'), function (e) { return e.getAttribute('src') || e.getAttribute('href'); })")
    dom_hit = [d for d in dom0 if any(x in d for x in ("quiz", "sensor", "svgkit"))]
    R.check("module1.no_quiz_assets", not hit0 and a0 and not dom_hit,
            "1 号模块：已发请求 %d 个，其中测验资源 %s；__lab.assets() === null：%s；页面上的测验脚本 / 样式 %s" % (len(reqs), hit0 or "无", a0, dom_hit or "无"), page)
    n_load = len(reqs)
    load_list = [rel(u) for u in reqs]
    # 其他 18 个模块逐个打开（go(k)，与导航按钮同一个函数）
    for k in range(21):
        if k in (0, 2, 12):
            continue
        page.evaluate("(k) => go(k)", k)
        page.wait_for_timeout(40)
    page.wait_for_timeout(500)
    try:
        page.wait_for_load_state("networkidle", timeout=5000)
    except PWTimeout:
        pass
    hit1 = [rel(u) for u in reqs if rel(u) in LAZY]
    R.check("other_modules.no_quiz_assets", not hit1 and page.evaluate("() => window.__lab.assets() === null"),
            "打开另外 18 个模块后测验资源请求 %s，共 %d 个请求" % (hit1 or "无", len(reqs)), page)
    # 任务书 3.1：打开其他模块「不多下载任何东西」——请求总数和刚加载完时一样；切到 3 号之前也没有任何 shared/quiz/ 下的请求
    extra = [rel(u) for u in reqs[n_load:]]
    R.check("other_modules.no_extra_requests", len(reqs) == n_load and not extra,
            "刚加载完 %d 个请求（%s），打开另外 18 个模块后 %d 个；多出来的 %s" % (n_load, "、".join(load_list), len(reqs), extra or "无"), page)
    quiz_any = [rel(u) for u in reqs if "shared/quiz/" in rel(u) or "sensor-models" in rel(u) or "svgkit" in rel(u)]
    R.check("before_m3.no_shared_quiz", not quiz_any,
            "切到 3 号之前 shared/quiz/ 下（index.json、items/*.json、misconceptions.json、脚本、样式）以及 sensor-models、svgkit 的请求 %s" % (quiz_any or "无"), page)
    n_before = len(reqs)
    # 用页面上的导航切到 3 号：手机上是下拉框 #msel，宽屏是 #chips 的按钮
    via = ""
    if page.locator("#msel").is_visible():
        page.locator("#msel").select_option("2")
        via = "下拉框 #msel"
    else:
        tap(R, ctx, page, page.locator("#chips button").nth(2))
        via = "#chips 第 3 个按钮"
    try:
        wait_js(page, "() => document.getElementById('m3').classList.contains('on') && !!window.__lab.assets()", None, 8000)
    except PWTimeout:
        pass
    m3on = page.evaluate("() => { var e = document.getElementById('m3'); return { on: e.classList.contains('on'), shown: window.__e2e.isShown(e), cur: Array.prototype.filter.call(document.querySelectorAll('section.on'), function (x) { return /^m\\d+$/.test(x.id); }).map(function (x) { return x.id; }) }; }")
    R.check("module3.opened", m3on["on"] and m3on["shown"] and m3on["cur"] == ["m3"],
            "经%s 切换后 section#m3.on=%s 可见=%s（显示中的模块 %s）" % (via, m3on["on"], m3on["shown"], m3on["cur"]), page)
    st = page.evaluate("async () => { var p = window.__lab.assets(); if (!p) return 'null'; await p; return 'ok'; }")
    page.wait_for_timeout(300)
    after = [rel(u) for u in reqs[n_before:] if rel(u) in LAZY]
    R.check("module3.loads_assets", st == "ok" and sorted(set(after)) == sorted(LAZY),
            "经%s 切到 3 号：assets() → %s；新请求的测验资源 %s（应为这 5 个：%s）" % (via, st, after, LAZY), page)
    R.check("module3.engine_svgkit", "shared/quiz/engine.js" in after and "shared/svgkit.js" in after,
            "engine.js、svgkit.js 都是切到 3 号之后才请求的", page)
    R.check("module3.globals", page.evaluate("() => !!(window.ABSLabQuiz && window.ABSLabSensors && window.ABSLabSVG && window.ABSLabQuizCore)"),
            "加载后 ABSLabQuiz、ABSLabSensors、ABSLabSVG、ABSLabQuizCore 都在", page)
    n1 = len(reqs)
    page.evaluate("() => go(12)")
    page.wait_for_timeout(600)
    again = [rel(u) for u in reqs[n1:] if rel(u) in LAZY]
    R.check("module13.no_reload", not again, "再打开 13 号重复请求的测验资源 %s" % (again or "无"), page)
    no_errors_check(R, "no_page_errors", page)


def py_lamp(rp, E=4.5):
    """任务书 4.1 的小灯泡电路，在测试里独立算一遍（不用页面的二分法）：
    R_L(U) = 2 + 2.5U，U + U/(2 + 2.5U)·Rp = E  ⇔  2.5U² + (2 + Rp − 2.5E)U − 2E = 0，取正根。返回 (U灯, I, U滑)。"""
    b = 2 + rp - 2.5 * E
    ul = (-b + math.sqrt(b * b + 4 * 2.5 * 2 * E)) / (2 * 2.5)
    i = ul / (2 + 2.5 * ul)
    return ul, i, E - ul


# #g3 的坐标换算（circuits-lab.html 小灯泡模式的 I-U 图像：横轴 0～4.5 V 对应 x = 40～280，纵轴 0～0.35 A 对应 y = 180～20）
def pa_X(u):
    return 40 + u / 4.5 * 240


def pa_Y(i):
    return 180 - i / 0.35 * 160


def pa_sample_ok(s):
    """一个采样点上的检查。返回 (ok, 说明)。
    页面自己的写法里两个 circle 的 data-i、cy 是同一个变量，模型的 Up 就是 E − UL，所以「电流相等、和为 4.5」在页面内部是构造出来的；
    这里再用 Python 按任务书 4.1 独立核对：滑块值 Rp → 工作点 (U灯, I)；灯的点在 I = U/(2 + 2.5U) 上；变阻器的点满足 I·Rp = U滑；
    两个圆的 cy 相等且等于 I 换算的纵坐标，cx 分别等于 U灯、U滑 换算的横坐标（关于 U = 2.25 V 对称）。"""
    pts = s.get("pts") or {}
    lp, rp = pts.get("lamp"), pts.get("rheo")
    m3 = s.get("m3") or {}
    if not lp or not rp:
        return False, "图上没有两个工作点 %s" % jd(pts)
    same_i = lp["i"] == rp["i"]
    su = float(lp["u"]) + float(rp["u"])
    r3 = s.get("r3") or ""
    mu = re.search(r"U灯\s*([\d.]+)\s*V", r3)
    mp = re.search(r"U滑\s*([\d.]+)\s*V", r3)
    mi = re.search(r"电流 I\s*([\d.]+)\s*A", r3)
    rsum = (float(mu.group(1)) + float(mp.group(1))) if (mu and mp) else None
    msum = (m3.get("UL") or 0) + (m3.get("Up") or 0)
    # 变阻器两端电压 = 电流 × 接入电阻（模型自洽：工作点确实在这个滑片位置上）
    ohm = abs((m3.get("I") or 0) * (m3.get("Rp") or 0) - (m3.get("Up") or 0))
    fails = []
    if not same_i:
        fails.append("data-i 不同")
    if abs(su - 4.5) > 0.01:
        fails.append("属性 U灯+U滑=%.3f" % su)
    if rsum is None or abs(rsum - 4.5) > 0.01 + 1e-9:
        fails.append("读数 U灯+U滑=%s" % rsum)
    if abs(msum - 4.5) > 0.01 or ohm >= 1e-3:
        fails.append("模型 和=%.4f |I·Rp−Up|=%.1e" % (msum, ohm))
    # ---- 独立核对 ----
    try:
        val = float(s.get("value"))
    except (TypeError, ValueError):
        return False, "读不到滑块值 %r" % s.get("value")
    ul, ii, up = py_lamp(val)
    ulp, urp, ip = float(lp["u"]), float(rp["u"]), float(lp["i"])
    if abs((m3.get("Rp") if m3.get("Rp") is not None else -1) - val) > 1e-9:
        fails.append("__lab.m3().Rp=%s ≠ 滑块值 %s" % (m3.get("Rp"), val))
    if abs(ulp - ul) > 0.001 or abs(urp - up) > 0.001 or abs(ip - ii) > 0.001:
        fails.append("Python 解 U灯=%.4f I=%.4f U滑=%.4f，页面 %s/%s/%s" % (ul, ii, up, lp["u"], lp["i"], rp["u"]))
    if abs(ip - ulp / (2 + 2.5 * ulp)) > 0.001:
        fails.append("灯的点不在 I=U/(2+2.5U) 上：%.4f vs %.4f" % (ip, ulp / (2 + 2.5 * ulp)))
    # data-i 是三位小数：乘以 Rp（最大 50）后的舍入误差最多 0.0005·Rp，再加 data-u 的 0.0005
    if abs(float(rp["i"]) * val - urp) > 0.0005 * val + 0.002:
        fails.append("变阻器的点 I·Rp=%.4f ≠ U滑 %.3f" % (float(rp["i"]) * val, urp))
    if lp["cy"] != rp["cy"] or abs(lp["cy"] - pa_Y(ii)) > 0.06:
        fails.append("cy 灯 %s / 滑 %s，按 I 换算 %.2f" % (lp["cy"], rp["cy"], pa_Y(ii)))
    if abs(lp["cx"] - pa_X(ul)) > 0.06 or abs(rp["cx"] - pa_X(up)) > 0.06 or abs(lp["cx"] + rp["cx"] - 2 * pa_X(2.25)) > 0.11:
        fails.append("cx 灯 %s / 滑 %s，按 U 换算 %.2f / %.2f" % (lp["cx"], rp["cx"], pa_X(ul), pa_X(up)))
    if not (mu and mi) or abs(float(mu.group(1)) - ul) > 0.0051 or abs(float(mi.group(1)) - ii) > 0.00051:
        fails.append("#r3 读数 U灯 %s I %s，Python %.3f / %.4f" % (mu and mu.group(1), mi and mi.group(1), ul, ii))
    ok = not fails
    return ok, "Rp=%s I灯=%s I滑=%s U灯+U滑：属性 %.3f、读数 %s、模型 %.4f；Python 解 U灯=%.4f I=%.4f；cy %s/%s cx %s+%s%s" % (
        val, lp["i"], rp["i"], su, ("%.2f" % rsum) if rsum is not None else "读不到", msum, ul, ii, lp["cy"], rp["cy"], lp["cx"], rp["cx"],
        ("；不满足：" + "；".join(fails)) if fails else "")


def sc_pa_mobile(R):
    """8.C 第 3 条（P-A，390×844 触屏）。
    工作点：除了页面自己的属性，还用 Python 按任务书 4.1 独立解（py_lamp）核对每个采样，外加 Rp = 50、6.6 Ω 两个定点。
    R₀ 模式：刚加载时、做完小灯泡切回来以后，读数、电路图、图像、滑块属性都和 11b2ae1 的页面一致。"""
    ctx = R.new_context(mobile=True)
    page = R.new_page(ctx)
    page.goto(R.url("physics/circuits-lab.html#3"), wait_until="load")
    await_assets(R, page)
    R.check("module3.shown", page.evaluate("() => document.getElementById('m3').classList.contains('on')"), "#3 打开 3 号模块", page)
    # 刚打开、还没操作（R₀ 模式默认状态）：读数、电路图、图像、滑块属性和改动前的页面一致
    R.route_orig(ctx)
    orig = R.new_page(ctx)
    orig.goto(R.url(ORIG_PATH + "#3"), wait_until="load")
    orig.wait_for_timeout(500)
    R.check("orig.loaded_fresh", orig.evaluate("() => !!document.getElementById('r3') && document.getElementById('m3').classList.contains('on')"),
            "改动前的页面（%s）打开了 3 号模块" % ORIG_REV, orig)
    diff, ga, _ = compare_pages(page, orig, ["r3", "s3", "g3", "v3p", "v3r"])
    sa, sb = slider_attrs(page, ["i3p", "i3r"]), slider_attrs(orig, ["i3p", "i3r"])
    R.check("r0.fresh_same_as_original", not diff and sa == sb,
            "刚加载（没操作）：#r3、#s3、#g3、#v3p、#v3r 与 %s 逐字一致%s；滑块 min/max/step/value %s（改动前 %s）；#r3「%s」" % (
                ORIG_REV, ("；不一致：%s" % diff) if diff else "", sa, sb, short(re.sub(r"<[^>]+>", " ", ga[0] or ""), 80)), page)
    orig.close()
    tap(R, ctx, page, '#m3 button[data-m3="lamp"]')
    try:
        page.wait_for_selector('#qz-m3-ans .qz-card[data-qid="%s"][data-stage]' % QID_PA, timeout=20000)
    except PWTimeout:
        R.require("gate.card", False, "点「小灯泡」后 20 秒内没有出现预测卡片", page)
    page.wait_for_timeout(300)
    st = page.evaluate("(h) => window.__e2e.extStage(h)", "#qz-m3-ans")
    R.require("gate.stage_predict", st == "predict", "游客第一次打开 data-stage=%r（应为 predict）" % st, page)
    m3 = page.evaluate("() => window.__lab.m3()")
    dis = page.evaluate("() => [document.getElementById('i3p').disabled].concat(Array.prototype.map.call(document.querySelectorAll('#m3 [data-set^=\"vm:\"]'), function (b) { return b.disabled; }))")
    R.check("locked.controls", m3["mode"] == "lamp" and m3["locked"] is True and all(dis),
            "mode=%r locked=%r；#i3p 和两个电压表按钮 disabled=%s" % (m3["mode"], m3["locked"], dis), page)
    prompt = page.evaluate("(q) => { var p = document.querySelector('#qz-m3-prompt .qz-prompt#qz-' + q); return p ? p.getAttribute('data-stage') : null; }", QID_PA)
    R.check("prompt.in_host", prompt is not None, "题干块 #qz-m3-prompt > .qz-prompt#qz-%s（data-stage=%r）" % (QID_PA, prompt), page)
    lay = lock_layout(page, "m3")
    R.check("locked.overlay", bool(lay) and lay["lockShown"] and "先预测，再动手" in (lay["lockText"] or "") and lay["locked"] == "true",
            "遮罩 #m3 .stage > .qz-lock 可见=%s，文字 %r，data-qz-locked=%r" % (lay and lay["lockShown"], lay and short(lay["lockText"], 40), lay and lay["locked"]), page)
    R.check("layout.option_gap<=120", bool(lay) and 0 <= lay["byRect"] <= 120 and 0 <= lay["byOffset"] <= 120,
            "滚到顶（scrollY=%s，模块图 position:%s）：第一个选项（%s）顶部 − 模块图下沿 = %.1f px（按文档位置算 %.1f；应在 0～120，选项在模块图下面）" % (
                lay and lay["scrollY"], lay and lay["stagePos"], lay and lay["firstOpt"], lay["byRect"] if lay else float("nan"), lay["byOffset"] if lay else float("nan")), page)
    R.shot(page, "pa_lock")
    sw = page.evaluate("() => document.documentElement.scrollWidth")
    R.check("layout.no_hscroll_locked", sw <= 390, "预测阶段 scrollWidth=%s" % sw, page)

    # 锁着的时候用手指拖滑块：拖不动、也不记走过的范围
    v_before = page.evaluate("() => document.getElementById('i3p').value")
    _, hit, v_after = slide(R, ctx, page, "#i3p", [5])
    m3 = page.evaluate("() => window.__lab.m3()")
    R.check("locked.drag_no_move", str(v_before) == ("%g" % v_after) and m3["visited"] is None,
            "预测前触屏拖滑块（起点落在滑块上=%s）：值 %s → %g，visited=%r" % (hit, v_before, v_after, m3["visited"]), page)
    R.check("locked.no_rheo_curve", page.evaluate("() => !document.querySelector('#g3 [data-curve=\"rheo\"]') && !document.querySelector('#g3 [data-sum]')"),
            "预测阶段图上没有变阻器曲线和「U灯 + U滑」", page)

    # 提交预测：c + 有把握
    predict_ext(R, ctx, page, "#qz-m3-ans", "c", "sure", "gate.")
    m3 = page.evaluate("() => window.__lab.m3()")
    lk = page.evaluate("() => { var l = document.querySelector('#m3 .stage > .qz-lock'); return { lock: !!l && window.__e2e.isShown(l), attr: document.querySelector('#m3 .stage').getAttribute('data-qz-locked'), dis: document.getElementById('i3p').disabled }; }")
    R.check("gate.unlocked", m3["locked"] is False and not lk["dis"] and not lk["lock"] and lk["attr"] != "true",
            "提交后 locked=%r，#i3p disabled=%r，遮罩可见=%r，data-qz-locked=%r" % (m3["locked"], lk["dis"], lk["lock"], lk["attr"]), page)

    # 真的触屏拖滑块：25 → 5 → 45 → 30（每步 1 Ω），每一步都读两个工作点、读数和模型
    samples, hit, vend = slide(R, ctx, page, "#i3p", [5, 45, 30], step=1.0, after_move=lambda k: page.evaluate("() => window.__e2e.pa()"))
    m3 = page.evaluate("() => window.__lab.m3()")
    vis = m3.get("visited")
    R.check("drag.touch_on_slider", hit, "触点落在 #i3p 上（document.elementFromPoint）", page)
    R.check("drag.visited", bool(vis) and vis[0] <= 10 and vis[1] >= 40,
            "%d 次 touchMove 后 visited=%r（要覆盖 ≤ 10 Ω 和 ≥ 40 Ω），最后停在 %g Ω" % (len(samples), vis, vend), page)
    card = page.locator("#qz-m3-ans .qz-card[data-qid]").last
    R.check("drag.compare_enabled", is_enabled(card.locator("[data-qz-compare]"), 6000), "两端都到过以后「看对比」可用", page)
    good, bad, seen = 0, [], set()
    for s in samples:
        ok, why = pa_sample_ok(s)
        seen.add((s.get("m3") or {}).get("Rp"))
        if ok:
            good += 1
        else:
            bad.append(why)
    R.check("working_points.same_current_sum45", samples and not bad and len(seen) >= 30,
            "%d 个采样（%d 个不同的滑片位置，%s～%s Ω）全部：两个工作点 data-i 相同，U灯 + U滑 = 4.5 V（±0.01）；"
            "并且和 Python 按任务书 4.1 独立解出的工作点一致（±0.001），灯的点在 I = U/(2+2.5U) 上，变阻器的点 I·Rp = U滑，"
            "两个圆 cy 相等且等于 I 换算的纵坐标、cx 等于 U灯/U滑 换算的横坐标（关于 2.25 V 对称），#r3 读数也一致%s" % (
                len(samples), len(seen), min(x for x in seen if x is not None) if seen else "?", max(x for x in seen if x is not None) if seen else "?",
                ("；不满足 %d 个，例如 %s" % (len(bad), bad[0])) if bad else ""), page)
    if samples:
        R.info("采样举例：%s" % pa_sample_ok(samples[len(samples) // 2])[1])
    last = page.evaluate("() => window.__e2e.pa()")
    rg = (last.get("m3") or {}).get("rheo")
    R.check("rheo_curve.drawn", "rheo" in (last.get("curves") or []) and last.get("sum") and rg and rg[0] < 0.5 and rg[1] > 2.5,
            "变阻器曲线 data-curve=rheo 已画出，画到的灯电压范围 %s V，和式 data-sum=%s" % (rg, last.get("sum")), page)
    R.shot(page, "pa_after_drag")

    # 任务书 4.1 的定点（仍然用触屏拖到那个位置）：Rp = 50 Ω 时 U灯 ≈ 0.218 V、I ≈ 0.086 A；Rp = 6.6 Ω 时 U灯 = 2.5 V（正常发光）
    for target, want_u, want_i, extra in ((50.0, 0.218, 0.086, None), (6.6, 2.5, 0.303, "正常发光")):
        _, hit, vend = slide(R, ctx, page, "#i3p", [target], step=1.0)
        s = page.evaluate("() => window.__e2e.pa()")
        lp = (s.get("pts") or {}).get("lamp") or {}
        ok_s, why = pa_sample_ok(s)
        ul_py = py_lamp(target)[0]
        ok = (hit and abs(vend - target) < 1e-9 and ok_s and lp.get("u") is not None
              and abs(float(lp["u"]) - want_u) <= 0.001 and abs(float(lp["i"]) - want_i) <= 0.001
              and (extra is None or extra in (s.get("o3") or "")) and (extra is not None or "正常发光" not in (s.get("o3") or "")))
        R.check("fixed_point.Rp%g" % target, ok,
                "触屏拖到 Rp=%g Ω（停在 %g）：灯的点 U=%s V、I=%s A（任务书 4.1：U≈%s、I≈%s；Python 解 U=%.4f）；#o3「%s」；%s" % (
                    target, vend, lp.get("u"), lp.get("i"), want_u, want_i, ul_py, short(s.get("o3"), 50), why), page)

    rec = finish_ext(R, ctx, page, "#qz-m3-ans", EXPLAIN_PA, ("guest",), "gate.")
    R.check("gate.record_guest", rec.get("state") == "guest", "游客做完：记录行 data-state=%r：%s" % (rec.get("state"), short(rec.get("text"), 80)), page)
    st = page.evaluate("(h) => window.__e2e.extStage(h)", "#qz-m3-ans")
    R.check("gate.stage_feedback", st == "feedback", "提交解释后 data-stage=%r" % st, page)
    sw = page.evaluate("() => document.documentElement.scrollWidth")
    R.check("layout.no_hscroll_after", sw <= 390, "做完后 scrollWidth=%s" % sw, page)

    # 切回 R₀ 模式：读数、电路图、图像和改动前的页面逐字一致
    tap(R, ctx, page, '#m3 button[data-m3="r0"]')
    page.wait_for_timeout(200)
    R.route_orig(ctx)
    orig = R.new_page(ctx)
    orig.goto(R.url(ORIG_PATH + "#3"), wait_until="load")
    orig.wait_for_timeout(500)
    R.check("orig.loaded", orig.evaluate("() => !!document.getElementById('r3') && document.getElementById('m3').classList.contains('on')"),
            "改动前的页面（%s）打开了 3 号模块" % ORIG_REV, orig)
    m3 = page.evaluate("() => window.__lab.m3()")
    R.check("r0.mode", m3["mode"] == "r0" and m3["locked"] is False, "切回 R₀：mode=%r locked=%r" % (m3["mode"], m3["locked"]), page)
    # 小灯泡模式把 #i3p 的步长改成 0.2：切回 R₀ 后 min/max/step 要恢复成原来的
    sa = [x[:4] + x[5:] for x in slider_attrs(page, ["i3p", "i3r"])]
    sb = [x[:4] + x[5:] for x in slider_attrs(orig, ["i3p", "i3r"])]
    R.check("r0.slider_attrs_restored", sa == sb, "切回 R₀ 后滑块 [id, min, max, step, disabled] %s（改动前 %s）" % (sa, sb), page)
    bad, n = [], 0
    sample_txt = ""
    for r0 in (10, 20):
        for rp in (0, 25, 50):
            for vm in (0, 1):
                for pg in (page, orig):
                    setv(pg, "#i3r", r0)
                    setv(pg, "#i3p", rp)
                    js_click(pg, '#m3 [data-set="vm:%d"]' % vm)
                diff, ga, gb = compare_pages(page, orig, ["r3", "s3", "g3", "v3p", "v3r"])
                n += 1
                if diff:
                    bad.append(("R0=%d Rp=%d vm=%d" % (r0, rp, vm), diff))
                elif not sample_txt:
                    sample_txt = page.evaluate("() => document.getElementById('r3').innerText")
    R.check("r0.same_as_original", not bad,
            "R₀ 模式 %d 组（R₀ 10/20 Ω × 滑片 0/25/50 Ω × 两个电压表按钮）#r3、#s3、#g3 与 %s 逐字一致%s；例如 #r3「%s」" % (
                n, ORIG_REV, ("；不一致：%s" % bad[:4]) if bad else "", short(sample_txt, 80)), page)
    ba = page.evaluate("() => Array.prototype.map.call(document.querySelectorAll('#m3 [data-set^=\"vm:\"]'), function (b) { return b.textContent; })")
    bb = orig.evaluate("() => Array.prototype.map.call(document.querySelectorAll('#m3 [data-set^=\"vm:\"]'), function (b) { return b.textContent; })")
    R.check("r0.vm_buttons", ba == bb, "R₀ 模式电压表按钮文字 %s（改动前 %s）" % (ba, bb), page)
    orig.close()
    no_errors_check(R, "no_page_errors", page)


def path_pts(d):
    """「M x1 y1L x2 y2」→ [(x1, y1), (x2, y2)]；读不出来返回 None。"""
    m = re.match(r"\s*M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*$", d or "")
    if not m:
        return None
    x1, y1, x2, y2 = (float(g) for g in m.groups())
    return [(x1, y1), (x2, y2)]


def dial_deg(c, p):
    """表盘角度：0° 在圆心左边（示数 0），90° 在正上方，180° 在右边（满偏）。屏幕坐标 y 向下。"""
    a = 180.0 - math.degrees(math.atan2(c[1] - p[1], p[0] - c[0]))
    return a - 360.0 if a > 270 else a   # 0° 左端因舍入落到圆心下方一点点时，atan2 给 −180° 附近


def sc_pe_mobile(R):
    """8.C 第 4 条（P-E，390×844 触屏）。
    表盘角度除了 data-angle，还按刻度线、指针 path 的端点算一遍（圆心取指针起点）；风速仪刚加载时也和 11b2ae1 比对。"""
    ctx = R.new_context(mobile=True)
    page = R.new_page(ctx)
    page.goto(R.url("physics/circuits-lab.html#13"), wait_until="load")
    await_assets(R, page)
    R.check("module13.shown", page.evaluate("() => document.getElementById('m13').classList.contains('on')"), "#13 打开 13 号模块", page)
    # 刚打开、还没操作（默认是风速仪）：读数、电路图、提示、风速滑块属性和改动前的页面一致
    R.route_orig(ctx)
    orig = R.new_page(ctx)
    orig.goto(R.url(ORIG_PATH + "#13"), wait_until="load")
    orig.wait_for_timeout(500)
    R.check("orig.loaded_fresh", orig.evaluate("() => !!document.getElementById('r13') && document.getElementById('m13').classList.contains('on')"),
            "改动前的页面（%s）打开了 13 号模块" % ORIG_REV, orig)
    m = page.evaluate("() => window.__lab.m13()")
    diff, ga, _ = compare_pages(page, orig, ["r13", "s13", "o13", "v13v"])
    sa, sb = slider_attrs(page, ["i13v"]), slider_attrs(orig, ["i13v"])
    R.check("wind.fresh_same_as_original", m["preset"] == "wind" and not diff and sa == sb,
            "刚加载（没操作）：预设 %r；#r13、#s13、#o13、#v13v 与 %s 逐字一致%s；#i13v min/max/step/value %s（改动前 %s）；#o13「%s」" % (
                m["preset"], ORIG_REV, ("；不一致：%s" % diff) if diff else "", sa, sb, short(re.sub(r"<[^>]+>", " ", ga[2] or ""), 60)), page)
    orig.close()
    tap(R, ctx, page, '#m13 button[data-m13="scale"]')
    try:
        page.wait_for_selector('#qz-m13-ans .qz-card[data-qid="%s"][data-stage]' % QID_PE, timeout=20000)
    except PWTimeout:
        R.require("gate.card", False, "点「电子秤」后 20 秒内没有出现预测卡片", page)
    page.wait_for_timeout(300)
    st = page.evaluate("(h) => window.__e2e.extStage(h)", "#qz-m13-ans")
    R.require("gate.stage_predict", st == "predict", "data-stage=%r（应为 predict）" % st, page)
    pe = page.evaluate("() => window.__e2e.pe()")
    dis = page.evaluate("() => ['i13x', 'i13r', 'i13e'].map(function (i) { return document.getElementById(i).disabled; })")
    R.check("locked.controls", pe["m13"]["locked"] is True and all(dis) and not pe["ticks"] and "?" in (pe.get("svgText") or ""),
            "locked=%r；#i13x/#i13r/#i13e disabled=%s；表盘上画出的刻度线 %d 条（预测前应为 0，表盘写「?」）" % (pe["m13"]["locked"], dis, len(pe["ticks"])), page)
    lay = lock_layout(page, "m13")
    R.check("locked.overlay", bool(lay) and lay["lockShown"] and "先预测，再动手" in (lay["lockText"] or ""),
            "遮罩可见=%s，文字 %r" % (lay and lay["lockShown"], lay and short(lay["lockText"], 40)), page)
    R.check("layout.option_gap<=120", bool(lay) and 0 <= lay["byRect"] <= 120 and 0 <= lay["byOffset"] <= 120,
            "第一个选项顶部 − 模块图下沿 = %.1f px（按文档位置 %.1f；应在 0～120，选项在模块图下面）" % (lay["byRect"] if lay else float("nan"), lay["byOffset"] if lay else float("nan")), page)

    predict_ext(R, ctx, page, "#qz-m13-ans", "a", "sure", "gate.")
    pe = page.evaluate("() => window.__e2e.pe()")
    m = pe["m13"]
    R.check("gate.unlocked_meter_V0", m["locked"] is False and m["meter"] == "V0" and m["R0"] == 10 and m["E"] == 6
            and page.evaluate("() => document.querySelector('#m13 button[data-m13m=\"V0\"]').classList.contains('on')"),
            "提交后 locked=%r，默认电表 %r（按钮 V0 高亮），R₀=%r Ω，电源 %r V" % (m["locked"], m["meter"], m["R0"], m["E"]), page)
    ticks = dict(pe["ticks"])
    R.shot(page, "pe_dial")
    R.check("dial.ticks_after_submit", sorted(ticks) == [0, 10, 20, 30, 40],
            "提交后表盘画出的刻度线 data-tick=%s（R₀ = 10 Ω、电压表测 R₀ 时量程内应为 0～40 N）" % sorted(ticks), page)
    # 每条刻度都要有数字（表盘就是让学生看清 0、10、20、30、40 的间隔）：数字齐全，字框互不重叠
    lab = page.evaluate("""() => Array.prototype.map.call(document.querySelectorAll('#s13 [data-tick-label]'), function (e) {
        var b = e.getBBox(); return { v: +e.getAttribute('data-tick-label'), x0: b.x, x1: b.x + b.width, y0: b.y, y1: b.y + b.height }; })""")
    lab_v = sorted(x["v"] for x in lab)
    lab_ov = [(a["v"], c["v"]) for i, a in enumerate(lab) for c in lab[i + 1:]
              if a["x0"] < c["x1"] and a["x1"] > c["x0"] and a["y0"] < c["y1"] and a["y1"] > c["y0"]]
    R.check("dial.every_tick_labelled", lab_v == sorted(ticks) and not lab_ov,
            "刻度数字 %s（刻度线 %s），重叠的数字 %s" % (lab_v, sorted(ticks), lab_ov or "无"), page)

    # 触屏拖压力 F：20 → 0 → 46（每步 1 N），每一步都读表盘
    samples, hit, vend = slide(R, ctx, page, "#i13x", [0, 46], step=1.0, after_move=lambda k: page.evaluate("() => window.__e2e.pe()"))
    R.check("drag.touch_on_slider", hit, "触点落在 #i13x 上", page)
    by_f = {}
    for s in samples:
        try:
            f = float(s["value"])
        except (TypeError, ValueError):
            continue
        if f == int(f):
            by_f[int(f)] = s
    m = page.evaluate("() => window.__lab.m13()")
    R.check("drag.visited", m["visited"] and m["visited"][0] <= 10 and m["visited"][1] >= 40,
            "%d 次 touchMove 后 visited=%r，停在 F=%g N" % (len(samples), m["visited"], vend), page)
    # F = 0 / 10 / 20 / 30 / 40：表盘刻度线的角度间隔逐个增大；指针正好指在那条刻度线上；角度与 U₀ = 6 × 10 ÷ (40 − 0.5F) 换算的一致
    rows, miss = [], []
    for f in (0, 10, 20, 30, 40):
        s = by_f.get(f)
        if s is None:
            miss.append(f)
            continue
        t = dict(s["ticks"])
        u0 = 6.0 * 10 / (10 + 30 - 0.5 * f)
        rows.append((f, t.get(f), s["pointer"], 180.0 * u0 / 3.0))
    angles = [r[1] for r in rows]
    gaps = [angles[i + 1] - angles[i] for i in range(len(angles) - 1)] if None not in angles else []
    R.check("dial.gaps_increasing", not miss and len(gaps) == 4 and all(gaps[i + 1] > gaps[i] for i in range(3)),
            "F = 0/10/20/30/40 N 时刻度线角度 %s°，间隔 %s°（应逐个增大）%s" % (
                [round(a, 2) if a is not None else None for a in angles], [round(g, 2) for g in gaps], ("；拖动时没停在 F=%s" % miss) if miss else ""), page)
    R.check("dial.pointer_on_tick", rows and all(r[1] is not None and r[2] is not None and abs(r[1] - r[2]) < 0.01 for r in rows),
            "指针角度 %s° 与对应刻度线 %s° 一致" % ([round(r[2], 2) if r[2] is not None else None for r in rows], [round(r[1], 2) if r[1] is not None else None for r in rows]), page)
    R.check("dial.angles_model", rows and all(r[1] is not None and abs(r[1] - r[3]) < 0.01 for r in rows),
            "按 U₀ = 6 V × 10 Ω ÷ (40 Ω − 0.5F)、满偏 3 V = 180° 换算：%s°" % [round(r[3], 2) for r in rows], page)
    lm = dict((t["v"], t["angle"]) for t in m["ticks"] if t["inRange"])
    R.check("dial.hook_matches_dom", all(abs(lm.get(f, -1) - a) < 1e-3 for f, a in ticks.items()) and sorted(lm) == sorted(ticks),
            "__lab.m13().ticks（量程内）%s 与 [data-tick] 一致" % {k: round(v, 2) for k, v in lm.items()}, page)
    # 画出来的线：刻度线 path 的两个端点、指针 path 的终点，按表盘圆心（指针的起点）算角度，和 data-angle 对上（±0.5°）
    geo_bad, geo_rows = [], []
    for f in (0, 10, 20, 30, 40):
        s = by_f.get(f)
        if s is None:
            geo_bad.append("F=%d 没有采样" % f)
            continue
        pc = path_pts(s.get("pointerD"))
        if not pc:
            geo_bad.append("F=%d 读不到指针的 d=%r" % (f, s.get("pointerD")))
            continue
        c = pc[0]
        pa = dial_deg(c, pc[1])
        if abs(pa - s["pointer"]) > 0.5:
            geo_bad.append("F=%d 指针画在 %.2f°，data-angle %.2f°" % (f, pa, s["pointer"]))
        da = dict(s["ticks"])
        drawn = {}
        for v, d in s.get("tickD") or []:
            q = path_pts(d)
            if not q:
                geo_bad.append("刻度 %s 的 d=%r 读不出来" % (v, d))
                continue
            a1, a2 = dial_deg(c, q[0]), dial_deg(c, q[1])
            drawn[v] = round(a2, 2)
            if abs(a1 - da[v]) > 0.5 or abs(a2 - da[v]) > 0.5:
                geo_bad.append("F=%d 时刻度 %s 画在 %.2f°/%.2f°，data-angle %.2f°" % (f, v, a1, a2, da[v]))
        if f == 0:
            geo_rows = sorted(drawn.items())
        if f in drawn and abs(drawn[f] - pa) > 0.5:
            geo_bad.append("F=%d 时指针 %.2f° 没指在刻度线 %.2f° 上" % (f, pa, drawn[f]))
    R.check("dial.drawn_lines_match", not geo_bad,
            "按 path 端点算出的刻度线角度 %s（圆心取指针起点），指针也逐个核对%s" % (geo_rows, ("；不一致：%s" % geo_bad[:3]) if geo_bad else ""), page)
    # R₀ = 10 Ω、F = 45 N：超过量程，指针打到 180°
    s45 = by_f.get(45)
    if s45 is None:
        R.check("over.F45", False, "拖动时没停在 F = 45 N（停过的值 %s）" % sorted(by_f), page)
    else:
        over_txt = "超过量程" in s45["o13"] or "超过量程" in (s45.get("svgText") or "")
        R.check("over.F45", s45["m13"]["R0"] == 10 and s45["m13"]["over"] is True and abs((s45["pointer"] or 0) - 180) < 1e-6 and over_txt and "超过量程" in s45["r13"],
                "R₀=%r Ω、F=45 N：over=%r，指针 %r°，#o13「%s」，#r13 含「超过量程」=%s" % (
                    s45["m13"]["R0"], s45["m13"]["over"], s45["pointer"], short(s45["o13"], 60), "超过量程" in s45["r13"]), page)
    s40 = by_f.get(40)
    if s40 is not None:
        R.check("over.F40_in_range", s40["m13"]["over"] is False and "超过量程" not in s40["o13"],
                "F=40 N 正好满偏：over=%r，#o13「%s」" % (s40["m13"]["over"], short(s40["o13"], 60)), page)
    R.shot(page, "pe_over")
    rec = finish_ext(R, ctx, page, "#qz-m13-ans", EXPLAIN_PE, ("guest",), "gate.")
    R.check("gate.record_guest", rec.get("state") == "guest", "游客做完：记录行 data-state=%r" % rec.get("state"), page)

    # 身高测量仪：刻度角度间隔全部相等（±0.5°）
    tap(R, ctx, page, '#m13 button[data-m13="height"]')
    page.wait_for_timeout(300)
    pe = page.evaluate("() => window.__e2e.pe()")
    ht = sorted(pe["ticks"])
    hg = [ht[i + 1][1] - ht[i][1] for i in range(len(ht) - 1)]
    R.check("height.uniform", pe["m13"]["preset"] == "height" and [t[0] for t in ht] == [150, 160, 170, 180, 190] and hg and max(hg) - min(hg) <= 0.5,
            "身高仪刻度 %s cm，角度 %s°，间隔 %s°（应全部相等，±0.5°）" % ([t[0] for t in ht], [round(t[1], 2) for t in ht], [round(g, 3) for g in hg]), page)
    R.shot(page, "pe_height")

    # 风速仪：读数和改动前的页面逐字一致（3 个风速 × 两个 R₀ 按钮）
    tap(R, ctx, page, '#m13 button[data-m13="wind"]')
    page.wait_for_timeout(300)
    R.route_orig(ctx)
    orig = R.new_page(ctx)
    orig.goto(R.url(ORIG_PATH + "#13"), wait_until="load")
    orig.wait_for_timeout(500)
    R.check("orig.loaded", orig.evaluate("() => !!document.getElementById('r13') && document.getElementById('m13').classList.contains('on')"),
            "改动前的页面（%s）打开了 13 号模块" % ORIG_REV, orig)
    bad, n, ex = [], 0, ""
    for r0 in (20, 100):
        for v in (4, 11.5, 16):
            for pg in (page, orig):
                js_click(pg, '#m13 [data-set="r13:%d"]' % r0)
                setv(pg, "#i13v", v)
            diff, ga, gb = compare_pages(page, orig, ["r13", "s13", "o13", "v13v"])
            n += 1
            if diff:
                bad.append(("R0=%d v=%s" % (r0, v), diff))
            elif r0 == 20 and v == 16:
                ex = page.evaluate("() => document.getElementById('o13').innerText")
    R.check("wind.same_as_original", not bad,
            "风速仪 %d 组（R₀ 20/100 Ω × 风速 4/11.5/16 m/s）#r13、#s13、#o13 与 %s 逐字一致%s；R₀=20、16 m/s 时提示「%s」" % (
                n, ORIG_REV, ("；不一致：%s" % bad[:4]) if bad else "", short(ex, 60)), page)
    orig.close()
    no_errors_check(R, "no_page_errors", page)


def mp_drag(R, ctx, page, key, which, world, sample=False):
    """动点页：把画板滚到视口中间，按世界坐标的路线拖（手机触屏 / 桌面鼠标）。返回每步之后的 __mp.get(key)。"""
    page.evaluate("([k, w]) => window.__mp.boards(k)[w].svg.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })", [key, which])
    page.wait_for_timeout(250)
    pts = page.evaluate("([k, w, p]) => window.__e2e.mpClientMany(k, w, p)", [key, which, [list(q) for q in world]])
    fn = (lambda k: page.evaluate("(k) => window.__mp.get(k)", key)) if sample else None
    return pointer_path(R, ctx, page, pts, fn)


def lerp(a, b, n):
    return [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(1, n + 1)]


def rect_area(s):
    # AB = 4，BC = 6，从 B 出发 B→C→D→A：y = ½·AB·(P 的横坐标)
    if s <= 6:
        return 2.0 * s
    if s <= 10:
        return 12.0
    return 12.0 - 2.0 * (s - 10)


def sc_m1_mobile(R):
    """8.C 第 5 条（M1，390×844 触屏）。
    进度键先断言刚打开时三项都不是 true，再逐个任务看它变成 true；pq 的最大值提示看计算后的 visibility（文字本来就在 HTML 里）；
    time 的拐点高亮两块板都看（C、拐点、「t = 3」），并在 t = 1.5、5 时断言没有高亮。"""
    ctx = R.new_context(mobile=True)
    page = R.new_page(ctx)
    page.goto(R.url("math/moving-point.html"), wait_until="load")
    try:
        wait_js(page, "() => !!window.__mp", None, 10000)
        page.evaluate("async () => { await window.__mp.gate(); return 1; }")
    except (PWTimeout, PWError) as e:
        R.require("setup.hook", False, "window.__mp / __mp.gate() 不可用：%s" % short(e, 200), page)
    R.check("start.tab_rect", page.evaluate("() => window.__mp.tab()") == "rect", "默认标签页 %r" % page.evaluate("() => window.__mp.tab()"), page)
    # 基线：新上下文刚打开时三项都没完成（页面一加载就写成 true 的话，最后「三项都为 true」就是空检查）
    prog_state = lambda: page.evaluate("() => ({ prog: window.ABSLabAuth.getProgress('math_mpoint_tasks'), tasks: window.__mp.tasks() })")
    p0 = prog_state()
    R.check("progress.baseline_all_false", p0["prog"] == {"rect": False, "pq": False, "time": False} and p0["tasks"] == {"rect": False, "pq": False, "time": False}
            and not page.evaluate("() => document.querySelectorAll('[role=tab][data-tab].is-done').length"),
            "刚打开：getProgress('math_mpoint_tasks') = %s，__mp.tasks() = %s，标签页上没有完成标记" % (jd(p0["prog"]), jd(p0["tasks"])), page)

    # ---------- rect：沿 B→C→D→A 小步拖 P ----------
    tap(R, ctx, page, '[role=tab][data-tab="rect"]')
    route = [(0.0, 0.0)] + lerp((0, 0), (6, 0), 30) + lerp((6, 0), (6, 4), 20) + lerp((6, 4), (0, 4), 30)
    sm = mp_drag(R, ctx, page, "rect", "geo", route, sample=True)
    pairs = [(q["s"], q["y"]) for q in sm]

    def first(cond):
        for i, (s, y) in enumerate(pairs):
            if cond(s, y):
                return i
        return None
    i6 = first(lambda s, y: abs(s - 6) < 0.05 and abs(y - 12) < 0.05)
    i10 = first(lambda s, y: abs(s - 10) < 0.05 and abs(y - 12) < 0.05)
    i16 = first(lambda s, y: abs(s - 16) < 0.05 and abs(y) < 0.05)
    R.check("rect.passes_points_in_order", None not in (i6, i10, i16) and i6 < i10 < i16,
            "%d 次 touchMove：经过 (6, 12) 在第 %s 步、(10, 12) 在第 %s 步、(16, 0) 在第 %s 步（应依次出现）" % (len(pairs), i6, i10, i16), page)
    dev = max([abs(y - rect_area(s)) for s, y in pairs] or [99])
    R.check("rect.samples_on_graph", pairs and dev < 0.05,
            "每个采样 (s, y) 都在 y = 2s（0～6）、12（6～10）、12 − 2(s − 10)（10～16）上：最大偏差 %.4f；举例 %s" % (
                dev, [(round(s, 2), round(y, 2)) for s, y in pairs[::16]]), page)
    pls = page.evaluate("() => window.__e2e.mpPolylines('rect', 'fn')")
    cand = [p for p in pls if p["pts"] and abs(p["pts"][0][0]) < 0.05 and abs(p["pts"][0][1]) < 0.05 and max(q[0] for q in p["pts"]) > 15.9]
    want = [(0, 0), (6, 12), (10, 12), (16, 0)]
    ok_pl = False
    got = None
    if cand:
        got = [(round(x, 2), round(y, 2)) for x, y in cand[0]["pts"]]
        j = 0
        for x, y in cand[0]["pts"]:
            if j < len(want) and abs(x - want[j][0]) < 0.05 and abs(y - want[j][1]) < 0.05:
                j += 1
        ok_pl = j == len(want)
    R.check("rect.rendered_polyline", ok_pl, "函数板上画出的折线（换回世界坐标）%s，应依次含 %s" % (got, want), page)
    g = page.evaluate("() => window.__mp.get('rect')")
    R.check("rect.task_done", g["done"] is True and g["maxS"] >= g["len"] - 0.2,
            "rect：maxS=%.2f / 全长 %s，done=%r" % (g["maxS"], g["len"], g["done"]), page)
    p1 = prog_state()
    prog1 = p1["prog"] if isinstance(p1["prog"], dict) else {}
    R.check("progress.after_rect_only", prog1.get("rect") is True and prog1.get("pq") is not True and prog1.get("time") is not True
            and p1["tasks"] == {"rect": True, "pq": False, "time": False},
            "rect 走完后 getProgress = %s，__mp.tasks() = %s（只有 rect 为 true）" % (jd(p1["prog"]), jd(p1["tasks"])), page)
    R.shot(page, "m1_rect")

    # ---------- pq：预测关卡 ----------
    tap(R, ctx, page, '[role=tab][data-tab="pq"]')
    try:
        page.wait_for_selector('#qz-pq-ans .qz-card[data-qid="%s"][data-stage]' % QID_M1, timeout=15000)
    except PWTimeout:
        R.require("pq.card", False, "pq 面板没有出现预测卡片", page)
    page.wait_for_timeout(300)
    st = page.evaluate("(h) => window.__e2e.extStage(h)", "#qz-pq-ans")
    g = page.evaluate("() => window.__mp.get('pq')")
    lk = page.evaluate("() => { var b = document.getElementById('mp-pq-boards'), l = b && b.querySelector(':scope > .qz-lock'); return { attr: b && b.getAttribute('data-qz-locked'), lock: !!l && window.__e2e.isShown(l), text: l ? l.textContent : '' }; }")
    R.check("pq.locked", st == "predict" and g["locked"] is True and lk["attr"] == "true" and lk["lock"] and "先预测，再动手" in lk["text"],
            "data-stage=%r，locked=%r，#mp-pq-boards data-qz-locked=%r，遮罩可见=%r" % (st, g["locked"], lk["attr"], lk["lock"]), page)
    mp_drag(R, ctx, page, "pq", "geo", [(0, 4)] + lerp((0, 4), (0, 1), 8))
    g = page.evaluate("() => window.__mp.get('pq')")
    R.check("pq.locked_no_drag", g["t"] == 0 and g["maxT"] == 0, "预测前触屏拖 P：t=%r maxT=%r（应不动）" % (g["t"], g["maxT"]), page)
    predict_ext(R, ctx, page, "#qz-pq-ans", "a", "sure", "pq.")
    g = page.evaluate("() => window.__mp.get('pq')")
    attr = page.evaluate("() => document.getElementById('mp-pq-boards').getAttribute('data-qz-locked')")
    R.check("pq.unlocked", g["locked"] is False and attr != "true", "提交后 locked=%r，data-qz-locked=%r" % (g["locked"], attr), page)
    mp_drag(R, ctx, page, "pq", "geo", [(0, 4)] + lerp((0, 4), (0, 2), 10))
    g = page.evaluate("() => window.__mp.get('pq')")
    # 提示文字在 HTML 里本来就写着（任何 t 都含「PB = BQ」），显示与否只靠 .mp-boards.mp-hot 的 visibility：要看计算后的样式
    hint_js = """() => { var h = document.getElementById('mp-pq-hint'), b = document.getElementById('mp-pq-boards'), cs = h ? getComputedStyle(h) : null;
      return { text: h ? h.textContent : '', vis: cs ? cs.visibility : null, disp: cs ? cs.display : null, hot: !!b && b.classList.contains('mp-hot'),
               shown: !!h && window.__e2e.isShown(h) && cs.visibility === 'visible' }; }"""
    hint = page.evaluate(hint_js)
    read = page.evaluate("() => (document.getElementById('mp-pq-read') || {}).textContent || ''")
    R.check("pq.t2_y2", abs(g["t"] - 2) < 0.05 and abs(g["y"] - 2) <= 0.02 and re.search(r"t = 2\.0\s*y = 2\.00", read) is not None,
            "拖到 t=%.3f：y=%.4f（应为 2 ± 0.02），屏幕读数 #mp-pq-read「%s」（应为「t = 2.0 y = 2.00」）" % (g["t"], g["y"], short(read, 40)), page)
    R.check("pq.max_hint", g["hotMax"] is True and "PB = BQ" in hint["text"] and hint["hot"] and hint["vis"] == "visible" and hint["shown"],
            "t=2 时 hotMax=%r，#mp-pq-boards.mp-hot=%r，提示「%s」visibility=%r display=%r" % (g["hotMax"], hint["hot"], hint["text"], hint["vis"], hint["disp"]), page)
    R.shot(page, "m1_pq_max")
    mp_drag(R, ctx, page, "pq", "geo", [(0, 2)] + lerp((0, 2), (0, 0.3), 10))
    g = page.evaluate("() => window.__mp.get('pq')")
    hint = page.evaluate(hint_js)
    R.check("pq.hint_hidden_off_max", abs(g["t"] - 3.7) < 0.06 and g["hotMax"] is False and not hint["hot"] and hint["vis"] == "hidden",
            "离开最大值（t=%.2f）：hotMax=%r，#mp-pq-boards.mp-hot=%r，提示 visibility=%r（应为 hidden）" % (g["t"], g["hotMax"], hint["hot"], hint["vis"]), page)
    card = page.locator("#qz-pq-ans .qz-card[data-qid]").last
    R.check("pq.compare_after_3.5", g["maxT"] >= 3.5 and is_enabled(card.locator("[data-qz-compare]"), 6000) and g["done"] is False,
            "拖到 t=%.2f（maxT %.2f ≥ 3.5）后「看对比」可用；任务还没完成 done=%r" % (g["t"], g["maxT"], g["done"]), page)
    rec = finish_ext(R, ctx, page, "#qz-pq-ans", EXPLAIN_M1, ("guest",), "pq.")
    R.check("pq.gate_finished", rec.get("state") == "guest", "预测关卡做完：记录行 data-state=%r" % rec.get("state"), page)
    mp_drag(R, ctx, page, "pq", "geo", [(0, 0.3)] + lerp((0, 0.3), (0, 0), 4))
    g = page.evaluate("() => window.__mp.get('pq')")
    R.check("pq.task_done", g["maxT"] >= g["tmax"] - 0.05 and g["done"] is True, "拖到 t=%.2f（tmax %s）：done=%r" % (g["t"], g["tmax"], g["done"]), page)
    p2 = prog_state()
    prog2 = p2["prog"] if isinstance(p2["prog"], dict) else {}
    R.check("progress.after_pq", prog2.get("rect") is True and prog2.get("pq") is True and prog2.get("time") is not True
            and p2["tasks"] == {"rect": True, "pq": True, "time": False},
            "pq 走完后 getProgress = %s，__mp.tasks() = %s（time 还没完成）" % (jd(p2["prog"]), jd(p2["tasks"])), page)

    # ---------- time：时间轴手柄 ----------
    tap(R, ctx, page, '[role=tab][data-tab="time"]')
    page.wait_for_timeout(200)
    # 两块板上的高亮：几何板（C 点和字母 C）、函数板（拐点、「t = 3」标注）
    hot_js = """() => { var b = window.__mp.boards('time'), H = window.__e2e;
      var info = function (svg) { return Array.prototype.map.call(svg.querySelectorAll('.sk-hot'), function (e) { return [e.tagName.toLowerCase(), (e.textContent || '').trim()]; }); };
      var lab = Array.prototype.filter.call(b.fn.svg.querySelectorAll('text'), function (e) { return /^t\\s*=\\s*3$/.test((e.textContent || '').trim()); });
      return { geo: info(b.geo.svg), fn: info(b.fn.svg), kinkLab: lab.length, kinkLabShown: lab.some(function (e) { return H.isShown(e); }),
               wrapHot: document.getElementById('mp-time-boards').classList.contains('mp-hot') }; }"""

    def time_to(t_from, t_to, n):
        mp_drag(R, ctx, page, "time", "fn", [(t_from, 0)] + lerp((t_from, 0), (t_to, 0), n))
        return page.evaluate("() => window.__mp.get('time')"), page.evaluate(hot_js)

    def no_hot(g, h):
        return g["hotKink"] is False and not h["geo"] and not h["fn"] and not h["kinkLabShown"] and not h["wrapHot"]

    g, h = time_to(0, 1.5, 8)
    R.check("time.no_kink_t1.5", abs(g["t"] - 1.5) < 0.06 and no_hot(g, h),
            "拖到 t=%.2f：hotKink=%r，几何板 .sk-hot %s，函数板 .sk-hot %s，「t = 3」可见=%r（都应没有）" % (g["t"], g["hotKink"], h["geo"], h["fn"], h["kinkLabShown"]), page)
    g, h = time_to(1.5, 3, 8)
    R.check("time.kink_t3", abs(g["t"] - 3) < 0.15 and g["hotKink"] is True and any(x[1] == "C" for x in h["geo"]) and any(x[1] == "" for x in h["geo"]),
            "拖到 t=%.2f（拐点 %s）：hotKink=%r，几何板上高亮（.sk-hot）%s（应有 C 点和字母 C）" % (g["t"], g["kink"], g["hotKink"], h["geo"]), page)
    R.check("time.kink_t3_fn_board", g["hotKink"] is True and any(x[1] == "" for x in h["fn"]) and h["kinkLabShown"],
            "t=%.2f 时函数板上的拐点高亮 .sk-hot %s，标注「t = 3」%d 个、可见=%r" % (g["t"], h["fn"], h["kinkLab"], h["kinkLabShown"]), page)
    R.shot(page, "m1_time_kink")
    g, h = time_to(3, 5, 10)
    R.check("time.no_kink_t5", abs(g["t"] - 5) < 0.06 and no_hot(g, h),
            "拖到 t=%.2f：hotKink=%r，几何板 .sk-hot %s，函数板 .sk-hot %s，「t = 3」可见=%r（离开拐点后都应没有）" % (g["t"], g["hotKink"], h["geo"], h["fn"], h["kinkLabShown"]), page)
    g, h = time_to(5, 7, 10)
    R.check("time.task_done", g["done"] is True and g["maxT"] >= g["total"] - 0.05, "拖到 t=%.2f / %s：done=%r" % (g["t"], g["total"], g["done"]), page)

    prog = page.evaluate("() => window.ABSLabAuth.getProgress('math_mpoint_tasks')")
    R.check("progress.all_true", isinstance(prog, dict) and prog.get("rect") is True and prog.get("pq") is True and prog.get("time") is True,
            "ABSLabAuth.getProgress('math_mpoint_tasks') = %s" % jd(prog), page)
    tasks = page.evaluate("() => window.__mp.tasks()")
    marks = page.evaluate("() => Array.prototype.map.call(document.querySelectorAll('[role=tab][data-tab]'), function (b) { return [b.getAttribute('data-tab'), b.classList.contains('is-done')]; })")
    R.check("tabs.done_marks", tasks == {"rect": True, "pq": True, "time": True} and sorted(marks) == [["pq", True], ["rect", True], ["time", True]],
            "__mp.tasks() = %s；标签页按钮的完成标记（.is-done）%s" % (jd(tasks), marks), page)
    page.evaluate("() => window.scrollTo(0, 0)")
    page.wait_for_timeout(200)
    R.shot(page, "m1_tabs")
    sw = page.evaluate("() => document.documentElement.scrollWidth")
    R.check("layout.no_hscroll", sw <= 390, "scrollWidth=%s" % sw, page)
    no_errors_check(R, "no_page_errors", page)


def sc_closed_loop(R):
    """8.C 第 6 条：新账号在 P-E 预测关卡选 b +「有把握」→ 错题本出现 mc-scaleuniform → 时钟拨到第二天 →
    review.html 出的是 p-pe-tt-ammeter 或 p-pe-tt-height（情境和「电子秤表盘」不同），答对后排到 D+4。
    错题除了查 api/mistakes，还在物理导图的错题本抽屉里看到这一条。"""
    D1, D4 = R.day(1), R.day(4)
    bank = load_json("shared/quiz/items/physics-pe.json")["items"]
    by_id = {it["id"]: it for it in bank}
    tag_name = load_json("shared/quiz/misconceptions.json")["tags"][TAG_PE]["name"]
    ctx = R.new_context(mobile=False)
    page = R.new_page(ctx)
    R.set_day(ctx, 0)
    page.goto(R.url("physics/circuits-lab.html#13"), wait_until="load")
    name = R.new_user("p")
    R.register(page, name)
    R.info("账号 = %s，D = %s" % (name, iso(R.day(0))))
    await_assets(R, page)
    tap(R, ctx, page, '#m13 button[data-m13="scale"]')
    try:
        page.wait_for_selector('#qz-m13-ans .qz-card[data-qid="%s"][data-stage]' % QID_PE, timeout=20000)
    except PWTimeout:
        R.require("gate.card", False, "没有出现预测卡片", page)
    page.wait_for_timeout(300)
    st = page.evaluate("(h) => window.__e2e.extStage(h)", "#qz-m13-ans")
    R.require("gate.stage_predict", st == "predict", "新账号 data-stage=%r" % st, page)
    predict_ext(R, ctx, page, "#qz-m13-ans", "b", "sure", "gate.")
    m = page.evaluate("() => window.__lab.m13()")
    R.check("gate.meter_V0", m["meter"] == "V0", "电表 %r（电压表测 R₀）" % m["meter"], page)
    _, hit, vend = slide(R, ctx, page, "#i13x", [5, 45], step=1.0)
    m = page.evaluate("() => window.__lab.m13()")
    R.check("gate.visited", hit and m["visited"] and m["visited"][0] <= 10 and m["visited"][1] >= 40,
            "鼠标拖 F：visited=%r，停在 %g N" % (m["visited"], vend), page)
    rec = finish_ext(R, ctx, page, "#qz-m13-ans", EXPLAIN_PE, ("saved",), "gate.")
    R.require("gate.record_saved", rec.get("state") == "saved", "记录行 data-state=%r：%s" % (rec.get("state"), short(rec.get("text"), 120)), page)
    t = rec.get("text", "")
    R.check("gate.record_text", "已存入错题本" in t and tag_name in t and fmt_md(D1) in t,
            "记录行应含「已存入错题本」「%s」「%s」：%r" % (tag_name, fmt_md(D1), short(t, 160)), page)
    ms = R.mistakes(page)
    mk = ms.get("mc-" + TAG_PE)
    R.require("mistake.exists", mk is not None, "GET api/mistakes 里有 mc-%s；现有 id：%s" % (TAG_PE, list(ms.keys())), page)
    rv = mk.get("review") or {}
    R.check("mistake.fields", mk.get("origin") == "quiz" and TAG_PE in (mk.get("mc") or []) and QID_PE in (mk.get("qids") or [])
            and rv.get("step") == 0 and rv.get("due") == iso(D1) and mk.get("status") == 0,
            "origin=%r mc=%r qids=%r step=%r due=%r（应为 %s）status=%r" % (mk.get("origin"), mk.get("mc"), mk.get("qids"), rv.get("step"), rv.get("due"), iso(D1), mk.get("status")), page)
    # 错题本页面上也看得到这一条：物理导图的错题本抽屉（shared/mistakes.js，按学科过滤）
    page.goto(R.url("physics/knowledge-map.html"), wait_until="load")
    page.wait_for_timeout(800)
    close_guide(page)
    seen_txt = ""
    try:
        wait_js(page, "() => !!(window.ABSLabMistakes && window.ABSLabMistakes.open)", None, 15000)
        page.evaluate("() => window.ABSLabMistakes.open('')")
        wait_js(page, "(t) => { var d = document.querySelector('.mk-drawer'); return !!d && d.textContent.indexOf(t) >= 0; }", tag_name, 15000)
        item = page.locator(".mk-drawer .mk-item").filter(has_text=tag_name).first
        expect(item).to_be_visible(timeout=5000)
        seen_txt = item.inner_text()
        drawer_ok = True
    except (PWTimeout, AssertionError, PWError) as e:
        drawer_ok = False
        seen_txt = "出错：" + short(e, 120)
    R.check("mistake.in_drawer", drawer_ok and mk.get("subject") == "physics" and tag_name in seen_txt,
            "物理导图的错题本抽屉里看得到这一条（subject=%r）：「%s」" % (mk.get("subject"), short(seen_txt, 120)), page)
    R.shot(page, "mistake_drawer")

    # ---- D+1：重测 ----
    R.set_day(ctx, 1)
    page.goto(R.url("review.html"), wait_until="load")
    st = wait_review_state(R, page, ("list", "empty", "guest", "run", "summary"))
    R.require("D1.review.list", st == "list", ".qz-review data-state=%r（应为 list）" % st, page)
    keys = page.evaluate("() => Array.prototype.map.call(document.querySelectorAll('.qz-review .qz-due-item'), function (e) { return e.getAttribute('data-key'); })")
    R.check("D1.review.due_item", keys == [TAG_PE], "到期项 %s（应只有 %s）" % (keys, TAG_PE), page)
    tap(R, ctx, page, "[data-qz-start]")
    R.require("D1.review.run", wait_review_state(R, page, ("run",)) == "run", "点「开始重测」后进入 run", page)
    try:
        page.wait_for_selector(".qz-review .qz-card[data-qid]", timeout=15000)
    except PWTimeout:
        R.require("D1.review.card", False, "重测里没有出现题目卡片", page)
    qid = page.evaluate("() => { var c = document.querySelectorAll('.qz-review .qz-card[data-qid]'); return c.length ? c[c.length - 1].getAttribute('data-qid') : null; }")
    ctx_served = (by_id.get(qid) or {}).get("context")
    R.check("D1.review.other_context", qid in RETEST_PE and ctx_served != by_id[QID_PE]["context"],
            "重测出的题 %r（情境「%s」），应为 %s 之一（预测关卡的情境是「%s」）" % (qid, ctx_served, list(RETEST_PE), by_id[QID_PE]["context"]), page)
    R.shot(page, "D1_review")
    if qid in by_id:
        it = by_id[qid]
        rec = answer_card(R, ctx, page, qid, it["answer"]["correct"], (it.get("reason") or {}).get("correct"), "sure", want=("saved",))
        R.check("D1.retest.saved", rec.get("state") == "saved", "答对后记录行 %r：%s" % (rec.get("state"), short(rec.get("text"), 100)), page)
        mk = R.mistakes(page).get("mc-" + TAG_PE) or {}
        rv = mk.get("review") or {}
        R.check("D1.mistake.next", rv.get("step") == 1 and rv.get("due") == iso(D4) and mk.get("status") == 1,
                "重测答对后 step=%r due=%r（应为 %s）status=%r" % (rv.get("step"), rv.get("due"), iso(D4), mk.get("status")), page)


def py_classify(item, ch, rs, cf):
    """core.classify 的 Python 版（任务书 3.4 节的判定规则），和页面上的结果互相核对。"""
    ans = bool(item.get("answer")) and ch == item["answer"]["correct"]
    reason = item.get("reason")
    rsn = (not reason) or rs == reason["correct"]
    sure = cf == "sure"
    if ans and rsn:
        cls = "pass" if sure else "unsure"
    elif ans:
        cls = "mc"
    else:
        cls = "mc" if sure else "gap"
    tags = []

    def find(sec, oid):
        for o in (sec or {}).get("options", []):
            if o["id"] == oid:
                return o
        return None
    if not ans:
        o = find(item["answer"], ch)
        if o and o.get("mc") and o["mc"] not in tags:
            tags.append(o["mc"])
    if not rsn:
        o = find(reason, rs)
        if o and o.get("mc") and o["mc"] not in tags:
            tags.append(o["mc"])
    if cls == "mc" and not tags:
        cls = "gap"
    return {"cls": cls, "ans": ans, "tags": tags[:8]}


def expected_run(R, page, pattern, hand, name):
    """小结的期望值：以写死的手算结果 hand 为准（CHECK_PRE_HAND / CHECK_POST_HAND），
    再用页面里 shared/quiz/core.js 的 classify 和 Python 版逐题各算一遍，三者都要一致。"""
    items = [it for it in load_json("shared/quiz/items/math-m1.json")["items"] if it.get("retest") is True]
    resp = [{"ch": pattern[it["id"]][0], "rs": pattern[it["id"]][1] if it.get("reason") else "", "cf": pattern[it["id"]][2]} for it in items]
    js = page.evaluate("""async (resp) => {
      var b = await window.ABSLabQuiz.load();
      var items = b.items.filter(function (it) { return it.module === 'm1' && it.retest === true; });
      return items.map(function (it, k) { var r = window.ABSLabQuizCore.classify(it, resp[k]); return { id: it.id, cls: r.cls, ans: !!r.ans, tags: r.tags }; });
    }""", resp)
    py = [dict(id=it["id"], **py_classify(it, r["ch"], r["rs"], r["cf"])) for it, r in zip(items, resp)]
    R.check(name + ".expected.js_equals_python", js == py, "页面 classify 与 Python 版逐题一致：%s" % ("是" if js == py else "否；页面 %s / Python %s" % (jd(js)[:200], jd(py)[:200])))
    want = [{"id": it["id"], "cls": hand["cls"][it["id"]][0], "tags": hand["cls"][it["id"]][1]} for it in items]
    got = [{"id": e["id"], "cls": e["cls"], "tags": e["tags"]} for e in js]
    R.check(name + ".expected.classify_equals_hand", got == want and len(items) == 9,
            "页面 classify 与写死的手算判定逐题一致（%d 题）：%s" % (len(items), "是；" + "，".join("%s %s%s" % (w["id"].replace("m-m1-", ""), w["cls"], ("[" + ",".join(w["tags"]) + "]") if w["tags"] else "") for w in want)
                                                   if got == want else "否；页面 %s / 手算 %s" % (jd(got)[:300], jd(want)[:300])))
    rows = []
    for it, r in zip(items, resp):
        cls, tg = hand["cls"][it["id"]]
        ans = r["ch"] == it["answer"]["correct"]
        rows.append({"id": it["id"], "ch": r["ch"], "rs": r["rs"], "cf": r["cf"], "cls": cls, "ans": ans, "tags": list(tg), "has_rs": bool(it.get("reason"))})
    tags = {}
    for x in rows:
        for t in x["tags"]:
            tags[t] = tags.get(t, 0) + 1
    n_pass = sum(1 for x in rows if x["cls"] == "pass")
    n_sw = sum(1 for x in rows if not x["ans"] and x["cf"] == "sure")
    R.check(name + ".expected.hand_totals", n_pass == hand["pass"] and n_sw == hand["sureWrong"] and tags == hand["tags"],
            "逐题手算汇总：pass %d（写死 %d）、有把握却答错 %d（写死 %d）、标签 %s（写死 %s）" % (n_pass, hand["pass"], n_sw, hand["sureWrong"], tags, hand["tags"]))
    return {"rows": rows, "pass": hand["pass"], "sureWrong": hand["sureWrong"], "tags": dict(hand["tags"]), "n": len(rows)}


def run_check(R, ctx, page, t, pattern, hand, prefix="", goto=True):
    """做一次 check.html?m=m1&t=…：按 id 作答 9 题，返回 (手算的期望, 屏幕上显示的字母、序号)。
    goto=False：页面已经停在这个小测的开头（例如在小测页上刚登录），不重新打开。prefix 加在检查名前面。"""
    if goto:
        page.goto(R.url("check.html?m=m1&t=%s" % t), wait_until="load")
    page.wait_for_selector("[data-ck-start]", timeout=15000)
    body = page.evaluate("() => document.body.innerText")
    if t == "pre":
        R.check(prefix + "intro.text", "姓名" not in body and "不计分" in body and "这台设备" in body,
                "页面顶部说明（不计分、只存这台设备），页面上没有「姓名」：%s" % ("姓名" not in body), page)
    page.fill("#ck-code", CHECK_CODE)
    tap(R, ctx, page, "[data-ck-start]")
    exp = expected_run(R, page, pattern, hand, prefix + t)
    keys, order, early = [], [], []
    for k in range(9):
        try:
            page.wait_for_selector('[data-ck-num="%d"]' % (k + 1), timeout=10000)
        except PWTimeout:
            R.require("%s%s.q%d" % (prefix, t, k + 1), False, "等不到第 %d 题" % (k + 1), page)
        qid = page.evaluate("() => document.querySelector('.ck-card').getAttribute('data-qid')")
        order.append(qid)
        ch, rs, cf = pattern[qid]
        card = page.locator(".ck-card").first
        ak = card.locator('[data-qz-ans="%s"] .qz-opt-key' % ch).first.text_content()
        tap(R, ctx, page, card.locator('[data-qz-ans="%s"]' % ch))
        rk = ""
        if card.locator("[data-qz-rs]").count():
            rk = card.locator('[data-qz-rs="%s"] .qz-opt-key' % rs).first.text_content()
            tap(R, ctx, page, card.locator('[data-qz-rs="%s"]' % rs))
        tap(R, ctx, page, card.locator('[data-qz-cf="%s"]' % cf))
        keys.append(((ak or "").strip(), (rk or "").strip()))
        fb = page.evaluate("() => { var c = document.querySelector('.ck-card'); return c.querySelectorAll('[data-mark], .qz-feedback, .qz-record').length + (/答对|答错|正确答案/.test(c.innerText) ? 100 : 0); }")
        if fb:
            early.append((qid, fb))
        tap(R, ctx, page, "[data-ck-finish]" if k == 8 else "[data-ck-next]")
    try:
        page.wait_for_selector("#ck-summary", timeout=10000)
    except PWTimeout:
        R.require(prefix + t + ".summary", False, "交卷后没有出现小结 #ck-summary", page)
    page.wait_for_timeout(300)
    R.check(prefix + t + ".bank_order", order == [x["id"] for x in exp["rows"]], "出题顺序 %s（应与题库顺序一致）" % order, page)
    R.check(prefix + t + ".no_feedback_while_answering", not early, "作答时没有显示对错：%s" % (early or "无"), page)
    return exp, keys


def check_summary(R, page, t, exp):
    sm = page.evaluate("""() => {
      var g = function (s) { var e = document.querySelector('#ck-summary ' + s); return e ? { n: e.getAttribute('data-n'), total: e.getAttribute('data-total'), text: e.innerText } : null; };
      return { acc: g('[data-ck-acc]'), sw: g('[data-ck-surewrong]'),
               mc: Array.prototype.map.call(document.querySelectorAll('#ck-summary li[data-ck-mc]'), function (e) { return [e.getAttribute('data-ck-mc'), +e.getAttribute('data-n'), e.innerText.replace(/\\s+/g, ' ')]; }) };
    }""")
    acc, sw = sm["acc"] or {}, sm["sw"] or {}
    R.check(t + ".summary.acc", acc.get("n") == str(exp["pass"]) and acc.get("total") == "9" and ("%d / 9" % exp["pass"]) in (acc.get("text") or ""),
            "正确率：屏幕「%s」data-n=%r；手算 pass %d / 9" % (short(acc.get("text"), 30), acc.get("n"), exp["pass"]), page)
    R.check(t + ".summary.surewrong", sw.get("n") == str(exp["sureWrong"]) and sw.get("total") == "9" and ("%d / 9" % exp["sureWrong"]) in (sw.get("text") or ""),
            "有把握却答错：屏幕「%s」data-n=%r；手算 %d / 9" % (short(sw.get("text"), 30), sw.get("n"), exp["sureWrong"]), page)
    shown = {k: n for k, n, _ in sm["mc"]}
    bad = [(k, shown.get(k), exp["tags"].get(k, 0)) for k in set(shown) | set(exp["tags"]) if shown.get(k, -1) != exp["tags"].get(k, 0)]
    R.check(t + ".summary.mc_counts", sm["mc"] and not bad,
            "错误概念计数：屏幕 %s；手算 %s%s" % (shown, exp["tags"], ("；不一致 %s" % bad) if bad else ""), page)
    return sm


def check_csv(R, ctx, page, t, exp, keys, today):
    with page.expect_download(timeout=15000) as di:
        tap(R, ctx, page, "[data-ck-csv]")
    dl = di.value
    path = os.path.join(OUT, "e2e1a_check_%s.csv" % t)
    dl.save_as(path)
    with open(path, "rb") as f:
        raw = f.read()
    want_name = "小测_m1_%s_%s.csv" % (t, today)
    R.check(t + ".csv.filename", dl.suggested_filename == want_name, "文件名 %r（应为 %r）" % (dl.suggested_filename, want_name), page)
    bom = raw.startswith(b"\xef\xbb\xbf")
    txt = raw[3:].decode("utf-8") if bom else raw.decode("utf-8", "replace")
    hook = page.evaluate("() => window.__check.csvText()")
    R.check(t + ".csv.bom", bom and txt == hook, "以 UTF-8 BOM 开头=%s，去掉 BOM 后与 __check.csvText() 相同=%s" % (bom, txt == hook), page)
    lines = txt.split("\r\n")
    R.check(t + ".csv.header", lines[0] == ",".join(CSV_HEAD), "表头 %r（11 列，逐字）" % lines[0], page)
    data = [l for l in lines[1:] if l]
    R.check(t + ".csv.rows", len(data) == 9 and txt.endswith("\r\n") and "\n" not in txt.replace("\r\n", ""),
            "数据行 %d（应为 9），每行 CRLF 结尾" % len(data), page)
    rows = list(csv.reader(io.StringIO(txt)))[1:]
    rows = [r for r in rows if r]
    bad = []
    for k, r in enumerate(rows[:9]):
        e = exp["rows"][k]
        ak, rk = keys[k] if k < len(keys) else ("?", "?")
        want = ["m1", "前测" if t == "pre" else "后测", today, e["id"], "%s（显示为 %s）" % (e["ch"], ak),
                ("%s（显示为 %s）" % (e["rs"], rk)) if e["has_rs"] else "", "有把握" if e["cf"] == "sure" else "没把握", e["cls"], ";".join(e["tags"])]
        if len(r) != 11 or r[:9] != want or not r[9].isdigit() or r[10] != CHECK_CODE:
            bad.append((k + 1, r, want))
    R.check(t + ".csv.cells", len(rows) == 9 and not bad,
            "9 行逐格：题目 id、答案「id（显示为 字母）」、理由、把握、判定、标签与点的一致，用时是整数、编号 %s%s" % (
                CHECK_CODE, ("；不一致：%s" % jd(bad[:2])) if bad else "；例如第 3 行 %s" % (rows[2] if len(rows) > 2 else None)), page)


def sc_check(R):
    """8.C 第 7 条：check.html?m=m1&t=pre 用固定的混合作答做完 9 题，小结和写死的手算结果（CHECK_PRE_HAND）一致；再做 t=post，前后并排；
    CSV 下载、列名、行数、逐格内容；全程没有任何写请求，没有请求 api/quiz、api/mistakes。游客做完以后再用登录的云账号做一遍（check_logged_in）。"""
    ctx = R.new_context(mobile=True, extra={"accept_downloads": True})
    reqs = []
    ctx.on("request", lambda r: reqs.append((r.method, r.url)))
    page = R.new_page(ctx)
    exp_pre, keys_pre = run_check(R, ctx, page, "pre", CHECK_PRE, CHECK_PRE_HAND)
    today = page.evaluate("() => window.ABSLabQuizCore.today()")
    R.info("前测手算：pass %d、有把握却答错 %d、标签 %s" % (exp_pre["pass"], exp_pre["sureWrong"], exp_pre["tags"]))
    check_summary(R, page, "pre", exp_pre)
    R.shot(page, "pre_summary")
    check_csv(R, ctx, page, "pre", exp_pre, keys_pre, today)
    R.check("pre.no_compare_yet", page.locator("[data-ck-compare]").count() == 0, "只有前测时没有前后对比表", page)

    exp_post, keys_post = run_check(R, ctx, page, "post", CHECK_POST, CHECK_POST_HAND)
    R.info("后测手算：pass %d、有把握却答错 %d、标签 %s" % (exp_post["pass"], exp_post["sureWrong"], exp_post["tags"]))
    check_summary(R, page, "post", exp_post)
    cmp = page.evaluate("""() => { var t = document.querySelector('[data-ck-compare]'); if (!t) return null;
      var out = {}; Array.prototype.forEach.call(t.querySelectorAll('tr[data-ck-row]'), function (tr) {
        var o = {}; Array.prototype.forEach.call(tr.querySelectorAll('td[data-ck-col]'), function (td) { o[td.getAttribute('data-ck-col')] = +td.getAttribute('data-n'); });
        out[tr.getAttribute('data-ck-row')] = o; }); return out; }""")
    want = {"acc": {"pre": exp_pre["pass"], "post": exp_post["pass"]}, "surewrong": {"pre": exp_pre["sureWrong"], "post": exp_post["sureWrong"]}}
    for tg in set(exp_pre["tags"]) | set(exp_post["tags"]):
        want["mc:" + tg] = {"pre": exp_pre["tags"].get(tg, 0), "post": exp_post["tags"].get(tg, 0)}
    bad = [(k, (cmp or {}).get(k), v) for k, v in want.items() if (cmp or {}).get(k) != v]
    extra = [(k, v) for k, v in (cmp or {}).items() if k not in want and (v.get("pre") or v.get("post"))]
    R.check("compare.side_by_side", cmp is not None and not bad and not extra,
            "前后测并排 [data-ck-compare]：%s%s" % (jd(cmp)[:300], ("；不一致 %s" % jd(bad + extra)[:200]) if (bad or extra) else ""), page)
    R.shot(page, "post_summary", full=True)
    check_csv(R, ctx, page, "post", exp_post, keys_post, today)
    st = page.evaluate("() => { try { return JSON.parse(localStorage.getItem('abslab.check.v1')); } catch (e) { return null; } }")
    runs = ((st or {}).get("runs") or {}).get("m1") or {}
    R.check("local.both_runs", sorted(runs) == ["post", "pre"], "localStorage abslab.check.v1 里 m1 的记录 %s" % sorted(runs), page)
    sw = page.evaluate("() => document.documentElement.scrollWidth")
    R.check("layout.no_hscroll", sw <= 390, "小结页 scrollWidth=%s" % sw, page)
    page.wait_for_timeout(800)  # 等可能迟到的请求
    writes = [r for r in reqs if r[0] not in ("GET", "HEAD")]
    apis = [r for r in reqs if "/api/quiz" in r[1] or "/api/mistakes" in r[1]]
    ext = [r for r in reqs if (urlparse(r[1]).hostname or "") not in ("localhost", "127.0.0.1", "::1") and r[1].startswith("http")]
    R.check("requests.read_only", not writes and not apis and not ext,
            "全程 %d 个请求：写请求（POST/PUT/PATCH/DELETE）%s；api/quiz、api/mistakes %s；外部 %s" % (
                len(reqs), writes[:3] or "无", apis[:3] or "无", ext[:3] or "无"))
    no_errors_check(R, "no_page_errors", page)
    check_logged_in(R)


def check_logged_in(R):
    """理解小测登录状态下也不走接口（engine.js「登录状态变化」里：只用 ABSLabQuiz.load() 的页面登录时不发 GET api/quiz）。
    新上下文打开 check.html?m=m1&t=pre，就在小测页上注册一个云账号（abs-auth-changed 在小测页上触发），不刷新接着做 9 题；
    再带着令牌重新打开 t=post 做 9 题。全程不能有 api/quiz、api/mistakes 的请求，也不能有写请求；
    auth.js 自己的请求（注册 POST api/auth、启动时 GET api/auth、云端进度同步 api/progress）单独列出来，不算进小测。
    最后用接口查这个账号：错题本、作答记录都是空的。"""
    ctx = R.new_context(mobile=True)
    reqs = []
    phase = {"v": "setup"}
    ctx.on("request", lambda r: reqs.append((phase["v"], r.method, r.url.split("/abs-lab/", 1)[-1])))
    page = R.new_page(ctx)
    page.goto(R.url("check.html?m=m1&t=pre"), wait_until="load")
    page.wait_for_selector("[data-ck-start]", timeout=15000)
    try:
        page.wait_for_load_state("networkidle", timeout=5000)
    except PWTimeout:
        pass
    name = R.new_user("c")
    phase["v"] = "register"
    res = page.evaluate("async ([n, p]) => await window.ABSLabAuth.register(n, p)", [name, PASSWORD])
    tok = page.evaluate("() => window.ABSLabAuth.getToken()")
    R.require("login.register_on_check_page", bool(res and res.get("ok") and res.get("cloud") and tok),
              "在小测页上注册云账号 %s → %s，getToken() 有值=%s" % (name, jd(res), bool(tok)), page)
    page.wait_for_timeout(1500)   # abs-auth-changed、云端同步可能触发的请求
    phase["v"] = "check"
    exp_pre, _ = run_check(R, ctx, page, "pre", CHECK_PRE, CHECK_PRE_HAND, prefix="login.", goto=False)
    check_summary(R, page, "login.pre", exp_pre)
    exp_post, _ = run_check(R, ctx, page, "post", CHECK_POST, CHECK_POST_HAND, prefix="login.")
    check_summary(R, page, "login.post", exp_post)
    R.check("login.still_logged_in", bool(page.evaluate("() => window.ABSLabAuth.getToken()")), "做完两次小测后仍是登录状态（令牌还在）", page)
    page.wait_for_timeout(1500)   # 等可能迟到的请求
    phase["v"] = "probe"           # 下面是测试自己用接口查账号，不算进页面的请求
    seen = [r for r in reqs if r[0] in ("register", "check")]
    quiz_api = [r for r in seen if r[2].startswith("api/quiz") or r[2].startswith("api/mistakes")]
    auth_own = [r for r in seen if r[2].startswith("api/auth") or r[2].startswith("api/progress")]
    writes = [r for r in seen if r[1] not in ("GET", "HEAD") and r not in auth_own]
    writes_check = [r for r in seen if r[0] == "check" and r[1] not in ("GET", "HEAD") and not r[2].startswith("api/progress")]
    fmt = lambda xs: "、".join("%s %s(%s)" % (m, u, ph) for ph, m, u in xs[:6]) or "无"
    R.check("login.no_quiz_api", not quiz_api, "登录后在小测页的 %d 个请求里 api/quiz、api/mistakes：%s" % (len(seen), fmt(quiz_api)), page)
    R.check("login.no_write_requests", not writes and not writes_check,
            "写请求（POST/PUT/PATCH/DELETE，auth.js 自己的除外）：%s；auth.js 自己的请求（单独列出，不算小测）：%s" % (fmt(writes + writes_check), fmt(auth_own)), page)
    R.info("登录后小测页的 api 请求：%s" % fmt([r for r in seen if r[2].startswith("api/")]))
    ms = R.api(page, "mistakes")
    qz = R.api(page, "quiz")
    m_items = (ms.get("json") or {}).get("items")
    q_items = (qz.get("json") or {}).get("items")
    R.check("login.server_untouched", ms["status"] == 200 and qz["status"] == 200 and m_items == [] and not q_items,
            "做完后用接口查账号 %s：GET api/mistakes → %s，错题 %s；GET api/quiz → %s，作答记录 %s（都应为空）" % (
                name, ms["status"], jd(m_items)[:80], qz["status"], jd(q_items)[:80]), page)
    no_errors_check(R, "login.no_page_errors", page)


def close_guide(page):
    # 物理、化学导图第一次打开会弹出使用指南（模态 dialog），挡住点击：关掉
    page.evaluate("() => Array.prototype.forEach.call(document.querySelectorAll('dialog[open]'), function (d) { try { d.close(); } catch (e) {} })")


def kp_row_chips(page, subj, key):
    return page.evaluate("""([subj, key]) => {
      var el = subj === 'math' ? document.querySelector('li.ok[data-key="' + key + '"]') : document.getElementById(key);
      if (!el) return null;
      var row = el.querySelector('.lk-row[data-lk-for="' + key + '"]');
      if (!row) return [];
      return Array.prototype.map.call(row.querySelectorAll('.lk-chip'), function (c) {
        return { kind: c.getAttribute('data-kind'), to: c.getAttribute('data-lk-to'), href: c.getAttribute('href'), shown: window.__e2e.isShown(c) }; });
    }""", [subj, key])


def follow_chip(R, ctx, page, subj, key, to):
    """在导图上点知识点那一行里指向 to 的「动手」标签（1280 宽、鼠标点，直接跳转）。"""
    sel = ('li.ok[data-key="%s"]' % key if subj == "math" else "#" + key) + ' .lk-row[data-lk-for="%s"] a.lk-chip[data-kind="lab"][data-lk-to="%s"]' % (key, to)
    loc = page.locator(sel).first
    close_guide(page)
    # 知识点所在的章节默认可能是收起的（<details>）：像学生一样先把它展开
    opened = page.evaluate("""(s) => { var c = document.querySelector(s), n = 0; if (!c) return -1;
      for (var p = c.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS' && !p.open) { p.open = true; n++; } return n; }""", sel)
    if opened:
        page.wait_for_timeout(300)
    loc.scroll_into_view_if_needed()
    with page.expect_navigation(wait_until="load", timeout=20000):
        loc.click()
    page.wait_for_timeout(300)


def pill_info(page):
    try:
        wait_js(page, "() => !!document.querySelector('.lk-pill a')", None, 8000)
    except PWTimeout:
        return None
    return page.evaluate("() => { var a = document.querySelector('.lk-pill a'); return { text: a.textContent, href: a.getAttribute('href') }; }")


def backlinks(page, scope_sel, target):
    try:
        wait_js(page, "(s) => !!document.querySelector(s)", "%s .lk-lab[data-lk-target=\"%s\"]" % (scope_sel, target), 8000)
    except PWTimeout:
        return None
    return page.evaluate("""([s, t]) => Array.prototype.map.call(document.querySelectorAll(s + ' .lk-lab[data-lk-target="' + t + '"] .lk-chip[data-kind="kp"]'),
        function (c) { return { to: c.getAttribute('data-lk-to'), href: c.getAttribute('href'), abs: c.href, shown: window.__e2e.isShown(c) }; })""", [scope_sel, target])


def backlink_check(R, page, scope_sel, target):
    """实验页上的反向链接：先切到对应的标签页 / 模块（调用方负责），这里断言每个应有的知识点标签都存在、
    Playwright 判定可见（to_be_visible），链接指向那个学科导图的 knowledge-map.html?kp=<知识点>。"""
    bl = backlinks(page, scope_sel, target) or []
    by = {b["to"]: b for b in bl}
    bad = []
    for ref in BACKLINKS[target]:
        subj, key = ref.split(":")
        b = by.get(ref)
        if not b:
            bad.append("%s 没有" % ref)
            continue
        want = "%s/knowledge-map.html?kp=%s" % (subj, key)
        if not (b["abs"] or "").startswith(R.base) or want not in (b["abs"] or ""):
            bad.append("%s 的链接 %s（应指向 %s）" % (ref, b["abs"], want))
        loc = page.locator('%s .lk-lab[data-lk-target="%s"] .lk-chip[data-kind="kp"][data-lk-to="%s"]' % (scope_sel, target, ref)).first
        try:
            loc.scroll_into_view_if_needed(timeout=5000)
            expect(loc).to_be_visible(timeout=5000)
        except (AssertionError, PWError, PWTimeout) as e:
            bad.append("%s 看不见：%s" % (ref, short(e, 100)))
    want_rows = [(ref, ((by.get(ref) or {}).get("abs") or "").replace(R.base, "")) for ref in BACKLINKS[target]]
    R.check("backlink.%s" % target, bl and not bad,
            "%s .lk-lab：应有的知识点标签 %s 都在、可见（to_be_visible）、指向导图；这一栏共 %d 个知识点标签 %s%s" % (
                scope_sel, want_rows, len(bl), [b["to"] for b in bl], ("；问题：%s" % bad) if bad else ""), page)


def in_viewport(page, sel):
    return page.evaluate("""(s) => { var e = document.querySelector(s); if (!e) return null; var r = e.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, ok: r.bottom > 0 && r.top < window.innerHeight && r.height > 0 }; }""", sel)


def sc_maps(R):
    """8.C 第 8 条：导图上的「动手」标签（新增 6.6 节那些）、点了能定位到模块 / 任务（并且在视口里）、实验页上的反向链接
    （先切到对应的标签页 / 模块，再用 Playwright 判定可见，链接指向 knowledge-map.html?kp=…）、各导图标签数。"""
    ctx = R.new_context(mobile=False)
    page = R.new_page(ctx)
    # ---- 标签数 ----
    for subj in ("physics", "chemistry", "math", "biology"):
        page.goto(R.url("%s/knowledge-map.html" % subj), wait_until="load")
        page.wait_for_timeout(2000)
        c = page.evaluate("() => window.__e2e.chips()")
        base = BASELINE[subj]
        R.check("chips.%s.default" % subj, c["nonquiz"] == base["default"],
                "%s 导图非测试标签 %d（预期 %d）；kinds=%s" % (subj, c["nonquiz"], base["default"], c["kinds"]), page)
        if base["hs"] is not None:
            has = page.evaluate("() => !!document.getElementById('hsToggle')")
            if not has:
                R.check("chips.%s.hs" % subj, False, "没有找到 #hsToggle", page)
                continue
            page.evaluate("() => { var t = document.getElementById('hsToggle'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }")
            page.wait_for_timeout(800)
            c = page.evaluate("() => window.__e2e.chips()")
            R.check("chips.%s.hs" % subj, c["nonquiz"] == base["hs"], "打开高中开关后非测试标签 %d（预期 %d）" % (c["nonquiz"], base["hs"]), page)
            page.evaluate("() => { var t = document.getElementById('hsToggle'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); }")

    # ---- 新增的「动手」标签在对应知识点那一行 ----
    for subj in ("math", "physics"):
        page.goto(R.url("%s/knowledge-map.html" % subj), wait_until="load")
        page.wait_for_timeout(1500)
        close_guide(page)
        for ref, tos in NEW_LINKS.items():
            s, key = ref.split(":")
            if s != subj:
                continue
            chips = kp_row_chips(page, subj, key) or []
            labs = {c["to"]: c for c in chips if c["kind"] == "lab"}
            miss = [t for t in tos if t not in labs or not labs[t]["shown"]]
            hrefs_ok = True
            for t in tos:
                h = (labs.get(t) or {}).get("href") or ""
                if t.startswith("mpoint-"):
                    hrefs_ok = hrefs_ok and "math/moving-point.html" in h and ("task=" + t.split("-", 1)[1]) in h
                elif t == "circuits-m3":
                    hrefs_ok = hrefs_ok and "physics/circuits-lab.html" in h and h.endswith("#3")
                elif t == "circuits-m13":
                    hrefs_ok = hrefs_ok and "physics/circuits-lab.html" in h and h.endswith("#13")
            # 数学导图的章节默认收起（<details>）：像学生一样展开所在章节，再用 Playwright 判定每个新标签看得见
            vis_bad = []
            for t in tos:
                sel = ('li.ok[data-key="%s"]' % key if subj == "math" else "#" + key) + ' .lk-row[data-lk-for="%s"] a.lk-chip[data-kind="lab"][data-lk-to="%s"]' % (key, t)
                page.evaluate("""(s) => { var c = document.querySelector(s); if (!c) return;
                  for (var p = c.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS' && !p.open) p.open = true; }""", sel)
                loc = page.locator(sel).first
                try:
                    loc.scroll_into_view_if_needed(timeout=5000)
                    expect(loc).to_be_visible(timeout=5000)
                except (AssertionError, PWError, PWTimeout) as e:
                    vis_bad.append("%s 看不见：%s" % (t, short(e, 80)))
            R.check("chip.%s" % ref, chips is not None and not miss and hrefs_ok and not vis_bad,
                    "%s 那一行的动手标签 %s（应有 %s，链接 %s；展开所在章节后都可见%s）" % (
                        ref, sorted(labs), tos, [labs[t]["href"].replace(R.base, "") for t in tos if t in labs], ("；" + "；".join(vis_bad)) if vis_bad else ""), page)
        # 截图：展开新标签所在的章节，滚到那一行
        page.evaluate("""(sel) => { var e = document.querySelector(sel); if (!e) return;
          for (var p = e.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS' && !p.open) p.open = true;
          e.scrollIntoView({ block: 'center', behavior: 'instant' }); }""",
                      '#k4 .lk-row[data-lk-for="k4"]' if subj == "physics" else 'li.ok[data-key="c26-1-1"] .lk-row[data-lk-for="c26-1-1"]')
        page.wait_for_timeout(600)
        R.shot(page, "map_%s_chips" % subj)

    # ---- 点数学导图 c26-1-1、c26-4-1 的标签 → 动点页 pq ----
    for key in ("c26-1-1", "c26-4-1"):
        page.goto(R.url("math/knowledge-map.html"), wait_until="load")
        page.wait_for_timeout(1500)
        follow_chip(R, ctx, page, "math", key, "mpoint-pq")
        try:
            wait_js(page, "() => !!window.__mp", None, 10000)
        except PWTimeout:
            pass
        u = page.url.replace(R.base, "")
        info = page.evaluate("""() => ({ tab: window.__mp && window.__mp.tab(), sel: (document.querySelector('[role=tab][data-tab="pq"]') || {}).getAttribute && document.querySelector('[role=tab][data-tab="pq"]').getAttribute('aria-selected'),
          shown: ['rect', 'pq', 'time'].map(function (k) { return window.__e2e.isShown(document.querySelector('section[data-task="' + k + '"]')); }) })""")
        try:
            wait_js(page, "() => document.querySelector('section[data-task=\"pq\"]').classList.contains('lk-flash')", None, 6000)
            flash = True
        except PWTimeout:
            flash = False
        R.check("jump.%s.pq_panel" % key, "math/moving-point.html" in u and "task=pq" in u and info["tab"] == "pq" and info["sel"] == "true" and info["shown"] == [False, True, False] and flash,
                "点 %s 的标签到了 %s：当前标签页 %r（aria-selected=%r），面板 rect/pq/time 显示 %s，pq 面板 .lk-flash=%s" % (key, u, info["tab"], info["sel"], info["shown"], flash), page)
        pill = pill_info(page)
        R.check("jump.%s.pill" % key, bool(pill) and pill["text"].startswith("← 回到") and ("knowledge-map.html?kp=" + key) in (pill["href"] or ""),
                "返回胶囊 .lk-pill：%s" % jd(pill), page)
        vp = in_viewport(page, 'section[data-task="pq"]')
        R.check("jump.%s.in_viewport" % key, bool(vp) and vp["ok"], "跳过来后 pq 面板在视口里：%s" % jd(vp), page)
        if key == "c26-1-1":
            R.shot(page, "mpoint_from_map")
    # 动点页上的反向链接（三个面板各自的 .lk-lab）：先切到那个标签页（其他面板是 display:none），再断言看得见
    for target, task in (("mpoint-pq", "pq"), ("mpoint-rect", "rect"), ("mpoint-time", "time")):
        if page.evaluate("() => window.__mp.tab()") != task:
            page.locator('[role=tab][data-tab="%s"]' % task).click()
            page.wait_for_timeout(300)
        R.check("backlink.%s.tab" % target, page.evaluate("() => window.__mp.tab()") == task, "切到 %s 标签页：当前 %r" % (task, page.evaluate("() => window.__mp.tab()")), page)
        backlink_check(R, page, 'section[data-task="%s"]' % task, target)

    # ---- 点物理导图 k4 的标签 → 电学实验台 3 号；k6 → 13 号 ----
    for key, target, sec in (("k4", "circuits-m3", "m3"), ("k6", "circuits-m13", "m13")):
        page.goto(R.url("physics/knowledge-map.html"), wait_until="load")
        page.wait_for_timeout(1500)
        follow_chip(R, ctx, page, "physics", key, target)
        u = page.url.replace(R.base, "")
        try:
            wait_js(page, "(s) => document.getElementById(s).classList.contains('on')", sec, 8000)
        except PWTimeout:
            pass
        on = page.evaluate("(s) => { var e = document.getElementById(s); return { on: e.classList.contains('on'), shown: window.__e2e.isShown(e), all: Array.prototype.filter.call(document.querySelectorAll('section.on'), function (x) { return /^m\\d+$/.test(x.id); }).map(function (x) { return x.id; }) }; }", sec)
        R.check("jump.%s.module" % key, "physics/circuits-lab.html" in u and on["on"] and on["shown"] and on["all"] == [sec],
                "点 %s 的标签到了 %s：section#%s.on=%s 可见=%s（显示中的模块 %s）" % (key, u, sec, on["on"], on["shown"], on["all"]), page)
        pill = pill_info(page)
        R.check("jump.%s.pill" % key, bool(pill) and pill["text"].startswith("← 回到") and ("knowledge-map.html?kp=" + key) in (pill["href"] or ""),
                "返回胶囊 .lk-pill：%s" % jd(pill), page)
        vp = in_viewport(page, "#" + sec)
        R.check("jump.%s.in_viewport" % key, bool(vp) and vp["ok"], "跳过来后 section#%s 在视口里：%s" % (sec, jd(vp)), page)
        if key == "k4":
            R.shot(page, "circuits_from_map")
        # 反向链接：就在跳过来的这个模块上查（这时它是显示中的模块）
        backlink_check(R, page, "#" + sec, target)


FUNCS = {
    "offline": sc_offline,
    "lazy": sc_lazy,
    "pa_mobile": sc_pa_mobile,
    "pe_mobile": sc_pe_mobile,
    "m1_mobile": sc_m1_mobile,
    "closed_loop": sc_closed_loop,
    "check": sc_check,
    "maps": sc_maps,
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
            raise RuntimeError("dev-server 启动失败（退出码 %s，端口 %d 可能被占用），见 %s" % (proc.returncode, port, log_path))
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
    ap = argparse.ArgumentParser(description="ABS-LAB 第 1 批 A 端到端测试（SPEC-1A 第 8.C 节）")
    ap.add_argument("--only", default="", help="只跑这些场景，逗号分隔：" + ",".join(SCENARIOS))
    ap.add_argument("--headed", action="store_true", help="显示浏览器窗口")
    ap.add_argument("--keep", action="store_true", help="不删除 tests/__out__/ 里上次留下的 e2e1a_* 截图和 CSV")
    ap.add_argument("--port", type=int, default=8092, help="dev-server 端口（默认 8092）")
    ap.add_argument("--no-server", action="store_true", help="不自己启动 dev-server，直接连已经在 --port 上运行的")
    ap.add_argument("--slowmo", type=int, default=0, help=argparse.SUPPRESS)
    args = ap.parse_args()

    only = [s.strip() for s in args.only.split(",") if s.strip()] or list(SCENARIOS)
    bad = [s for s in only if s not in FUNCS]
    if bad:
        ap.error("未知场景 %s；可选：%s" % (bad, ", ".join(SCENARIOS)))

    os.makedirs(OUT, exist_ok=True)
    if not args.keep:
        for f in os.listdir(OUT):
            if f.startswith("e2e1a_") and (f.endswith(".png") or f.endswith(".csv")):
                try:
                    os.remove(os.path.join(OUT, f))
                except OSError:
                    pass

    base = "http://localhost:%d/abs-lab/" % args.port
    proc = log = None
    rows = []
    times = {}
    t_all = time.time()
    try:
        if not args.no_server:
            proc, log = start_server(args.port, os.path.join(OUT, "e2e1a_dev-server.log"))
        print("ABS-LAB 第 1 批 A 端到端测试：%s；场景 %s" % (base, ", ".join(only)), flush=True)
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
                    errs = R.errors_of(name)
                    for _, kind, u, msg in errs[:8]:
                        R.info("页面报错 %s @ %s: %s" % (kind, u.replace(base, ""), short(msg, 200)))
                    if len(errs) > 8:
                        R.info("……另有 %d 条页面报错" % (len(errs) - 8))
                    R.close_contexts()
                if len(R.rows) == n_before:
                    R.check("ran", False, "场景没有产生任何检查")
                times[name] = time.time() - t0
                print("     %s 用时 %.1f s" % (name, times[name]), flush=True)
            rows = R.rows
            browser.close()
    except RuntimeError as e:
        print("FAIL  setup        dev-server                          %s" % e, flush=True)
        rows.append(("setup", "dev-server", False, str(e)))
    finally:
        stop_server(proc, log)

    # ---- 汇总 ----
    print("\n==== 汇总（用时 %.0f s）====" % (time.time() - t_all))
    print("%-12s %5s %5s %7s  %s" % ("场景", "通过", "失败", "用时", "结果"))
    scen_order = [s for s in only] + (["setup"] if any(r[0] == "setup" for r in rows) else [])
    any_fail = False
    for s in scen_order:
        rs = [r for r in rows if r[0] == s]
        npass = sum(1 for r in rs if r[2])
        nfail = sum(1 for r in rs if not r[2])
        res = "未运行" if not rs else ("PASS" if nfail == 0 else "FAIL")
        if nfail or not rs:
            any_fail = True
        print("%-12s %5d %5d %6.1fs  %s" % (s, npass, nfail, times.get(s, 0.0), res))
    fails = [r for r in rows if not r[2]]
    if fails:
        print("\n失败明细：")
        for s, n, _, reason in fails:
            print("  FAIL %-12s %-34s %s" % (s, n, short(reason, 300)))
    print("\n截图、CSV 和 dev-server 日志：%s" % OUT)
    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main())
