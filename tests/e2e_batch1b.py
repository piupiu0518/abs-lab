#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ABS-LAB 第 1 批 B 端到端测试（任务书 SPEC-1B 第 8.C 节；选择器、测试钩子见 CONTRACT-1B 第 5 节和三个页面的修复报告）。

用法（在仓库根目录或任意目录）：
    python3 tests/e2e_batch1b.py                       # 全部场景
    python3 tests/e2e_batch1b.py --only m2_mobile,check
    python3 tests/e2e_batch1b.py --headed --keep --port 8093

场景：offline、m2_mobile、cb_mobile、cc_mobile、closed_loop、check、maps、words。
每个检查打印一行 PASS / FAIL + 原因（带上实际读到的数字），最后打印每个场景的汇总表；有任何失败退出码为 1，
没装 Playwright 时打印「未运行」、退出码为 2。
截图（tests/__out__/e2e1b_*.png）、下载的 CSV 和 dev-server 的输出都放在 tests/__out__/（已在 .gitignore 里，不提交）。

为什么这样写（和 tests/e2e_batch1a.py 同一套做法，但不 import 它，这个文件自己就能跑）：
  - 自己启动 node tools/dev-server.js（默认端口 8093，通过 /abs-lab/ 子路径访问），能发现以 "/" 开头的绝对路径；
    dev-server 的 Redis 是内存模拟，每次启动都是空库，所以账号名每次随机生成。
  - 「跳天」靠改浏览器时钟：context.clock.set_fixed_time() 只冻结 Date，定时器和 rAF 照常走，必须在 goto 之前调用。
  - 手机上的拖动（顶点、区间窗口、状态点、取样点、滑块）一律用 CDP 的 Input.dispatchTouchEvent 发真的触屏事件，
    起点放在可拖动对象当前的位置上（compare 里是当前选中的那个状态点），并用 elementFromPoint 核对起点落在它上面。
    M2 abc 的 a、b 也用手指拖滑块（起点落在拇指上）。锁定时的拖动核对手指落在遮罩 .qz-lock 上（遮罩接住了手指）。
  - 读数一律核对「看得见」（__e2e.isShown：祖先链上没有 display:none、有渲染框），不只读 textContent。
  - 选项的显示顺序在题库里打乱过（id 不变）：一律按 id 点，不按位置点；变质探究的结论按选项的文字（未变质 / 部分变质 / 完全变质）选。
  - 变质探究的结论按屏幕上写出来的逐步现象（#so-log「加入过量 CaCl₂ 溶液：产生白色沉淀」「加入酚酞溶液：溶液变红 / 溶液无色」）
    推断（红色 + 沉淀 = 部分变质，红色、没有沉淀 = 未变质，无色 = 完全变质），再和试管上的 .tube-obs、data-red / data-precipitate、
    画出来的沉淀颗粒、液体颜色互相核对；不读页面藏着的分配，判对以后才拿钩子里的分配核对一遍。
  - 理解小测的期望数字写死在 CHECK_CC_HAND 里（按题库逐题手算），运行时再用页面的 ABSLabQuizCore.classify 和 Python 版各算一遍。
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
from urllib.parse import urlparse, quote

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

SCENARIOS = ["offline", "m2_mobile", "cb_mobile", "cc_mobile", "closed_loop", "check", "maps", "words"]

PASSWORD = "pass1234"
MINUS = "−"   # 数学式里的减号「−」

# 预测关卡（CONTRACT-1B 第 3、5 节）
QID_M2 = "m-m2-poe"
QID_CB = "c-cb-poe"
QID_CC = "c-cc-poe"
TAG_CB = "coolalwayscrystal"
# 闭环里重测应出的题：同一个标签、情境和预测关卡（降温时状态点的移动）不同
RETEST_CB = ("c-cb-tt-nocrystal", "c-cb-tt-fridge")

# 任务书 8.C 第一条要逐页打开的页面（三个新页面每个标签页都切一遍，小测页开始后看到第 1 题）
OFFLINE_PAGES = [
    "math/quadratic.html", "chemistry/solubility.html", "chemistry/solute.html",
    "math/index.html", "chemistry/index.html", "chemistry/neutralization.html",
    "check.html?m=m2&t=pre", "check.html?m=cb&t=pre", "check.html?m=cc&t=pre",
]
TABS = {
    "math/quadratic.html": ("__quad", ["vertex", "interval", "abc"]),
    "chemistry/solubility.html": ("__solub", ["cool", "compare", "nacl"]),
    "chemistry/solute.html": ("__solute", ["curve", "spoil"]),
}
# 学科页的「互动实验」入口卡片（任务书 3.5：标「初中」）
PORTALS = {"math/index.html": ["quadratic.html"], "chemistry/index.html": ["solubility.html", "solute.html"]}

# 进度键（任务书 3.2）
PROG = {
    "math_quad_tasks": ["vertex", "interval", "abc"],
    "chem_solub_tasks": ["cool", "compare", "nacl"],
    "chem_solute_tasks": ["curve", "spoil"],
}

# 导图标签数（1280×900、游客、只数可见的、不含 data-kind="quiz"）：第 1 批 B 之后物理 49 / 50、化学 15 / 18、数学 16、生物 13
BASELINE = {
    "physics": {"default": 49, "hs": 50},
    "chemistry": {"default": 15, "hs": 18},
    "math": {"default": 16, "hs": None},
    "biology": {"default": 13, "hs": None},
}
# 任务书 7.2 节新增的关联：知识点 → 实验 target
NEW_LINKS = {
    "math:c26-2-2": ["quad-vertex"], "math:c26-2-4": ["quad-interval"],
    "math:c26-4-1": ["quad-interval"], "math:c26-2-5": ["quad-abc"],
    "chemistry:u9-k3": ["solub-cool"], "chemistry:u9-k4": ["solub-cool", "solub-compare"],
    "chemistry:u9-k5": ["solub-cool", "solub-nacl"], "chemistry:u9-k6": ["solub-compare"],
    "chemistry:u10-k6": ["solute-spoil"], "chemistry:u10-k7": ["solute-curve"],
    "chemistry:u10-k8": ["solute-spoil"], "chemistry:u10-k9": ["solute-curve"],
    "chemistry:u10-k10": ["solute-curve"],
}
# target → (页面, 任务)
TARGET_PAGE = {
    "quad-vertex": ("math/quadratic.html", "vertex"), "quad-interval": ("math/quadratic.html", "interval"),
    "quad-abc": ("math/quadratic.html", "abc"),
    "solub-cool": ("chemistry/solubility.html", "cool"), "solub-compare": ("chemistry/solubility.html", "compare"),
    "solub-nacl": ("chemistry/solubility.html", "nacl"),
    "solute-curve": ("chemistry/solute.html", "curve"), "solute-spoil": ("chemistry/solute.html", "spoil"),
}
# 新的测试标签（题库 kp）：知识点 → 题目所在的新页面
QUIZ_KPS = {
    "math:c26-2-2": "math/quadratic.html", "math:c26-2-4": "math/quadratic.html",
    "math:c26-2-5": "math/quadratic.html", "math:c26-4-1": "math/quadratic.html",
    "chemistry:u9-k3": "chemistry/solubility.html", "chemistry:u9-k4": "chemistry/solubility.html",
    "chemistry:u9-k5": "chemistry/solubility.html", "chemistry:u9-k6": "chemistry/solubility.html",
    "chemistry:u10-k6": "chemistry/solute.html", "chemistry:u10-k7": "chemistry/solute.html",
    "chemistry:u10-k8": "chemistry/solute.html", "chemistry:u10-k9": "chemistry/solute.html",
    "chemistry:u10-k10": "chemistry/solute.html",
}
# 实验页上的反向链接：target → 应该出现的知识点标签（就是 7.2 节的关联反过来）
BACKLINKS = {}
for _ref, _tos in NEW_LINKS.items():
    for _t in _tos:
        BACKLINKS.setdefault(_t, []).append(_ref)
# 导图上点哪些动手标签：7.2 节新增的 15 个（知识点 × target）都点一遍。先点落在非默认标签页的，
# 这样每个页面第一次打开时就看得出确实切过去了（也在那时核对一次这个页面上的反向链接）
JUMPS = sorted([(_r.split(":")[0], _r.split(":")[1], _t) for _r, _tos in NEW_LINKS.items() for _t in _tos],
               key=lambda j: (j[2] in ("quad-vertex", "solub-cool", "solute-curve"), j[0], j[1], j[2]))
# 导图上点哪些测试标签：13 个都点。落点是 #qz-<这个知识点的第一道题>：预测关卡（poe）切到它的标签页、滚到题干；其余展开练一练、滚到那道题
GATE_TAB = {"m-m2-poe": ("__quad", "vertex", None), "c-cb-poe": ("__solub", "cool", None), "c-cc-poe": ("__solute", "curve", 3)}
HOOK_OF = {"math/quadratic.html": "__quad", "chemistry/solubility.html": "__solub", "chemistry/solute.html": "__solute"}

# 理解小测：CSV 的列名（11 列），逐字
CSV_HEAD = ["模块", "前测 / 后测", "日期", "题目 id", "答案", "理由", "把握", "判定", "错误概念标签", "用时（秒）", "编号"]
# check.html?m=cc&t=pre 的作答（按题目 id，与显示顺序无关）：(答案, 理由, 把握)。故意混着来
CHECK_CC = {
    "c-cc-tt-baso4": ("c", "r2", "sure"),       # 全对、有把握：pass
    "c-cc-tt-co2": ("a", "r2", "sure"),         # 答错有把握：答案、理由同一个标签 productalwayssolute，只记一次
    "c-cc-tt-nacl": ("a", "r2", "unsure"),      # 全对、没把握：unsure
    "c-cc-tt-cacl2": ("b", "r2", "sure"),       # 答案对、理由错：mc neutralnoions（不算「有把握却答错」）
    "c-cc-tt-phenol": ("b", "r1", "unsure"),    # 答错没把握：gap，但选到带标签的错项，记 carbonatebasic
    "c-cc-tt-excesscarb": ("b", "r1", "sure"),  # 答错有把握、错项没有标签、理由对：mc 没有标签改判 gap
    "c-cc-tr-little": ("a", "r1", "sure"),      # 答错有把握：mc littleacid
    "c-cc-tr-mix": ("a", "r1", "sure"),         # 全对、有把握：pass
    "c-cc-inv": ("a", "r2", "unsure"),          # 答错没把握、错项没有标签：gap
}
# 上面的作答按题库（shared/quiz/items/chemistry-cc.json）逐题手算的结果，写死在这里：
#   判定规则（SPEC-1A 3.4）：答案对理由对有把握 pass、没把握 unsure；答案对理由错 mc；答案错有把握 mc、没把握 gap；判 mc 但没有标签改判 gap。
#   标签：答错的答案选项、答错的理由选项上的 mc 标签（同一个只记一次）；gap 题选到带标签的错项也记。
#   有把握却答错 = 答案错且选了「有把握」：co2、excesscarb、little 三题。
CHECK_CC_HAND = {
    "cls": {"c-cc-tt-baso4": ("pass", []), "c-cc-tt-co2": ("mc", ["productalwayssolute"]), "c-cc-tt-nacl": ("unsure", []),
            "c-cc-tt-cacl2": ("mc", ["neutralnoions"]), "c-cc-tt-phenol": ("gap", ["carbonatebasic"]),
            "c-cc-tt-excesscarb": ("gap", []), "c-cc-tr-little": ("mc", ["littleacid"]), "c-cc-tr-mix": ("pass", []),
            "c-cc-inv": ("gap", [])},
    "pass": 2, "sureWrong": 3,
    "tags": {"productalwayssolute": 1, "neutralnoions": 1, "carbonatebasic": 1, "littleacid": 1},
}
CHECK_CODE = "E2E-%02d" % random.randint(0, 99)

# 解释至少 6 个字（预测关卡 explain.min = 6），写一句完整的中文
EXPLAIN_M2 = "顶点移到 x 等于 2 时括号要等于零所以写减号"
EXPLAIN_CB = "刚降温时溶解度还比八十克大溶液不饱和所以不析出"
EXPLAIN_CC = "硫酸钡沉淀离开了溶液氢离子和氢氧根结合成水"

# 化学新页面界面上不能出现的说法（任务书第 2 节；只有默认收起、标「高中」的小框例外）
FORBIDDEN = ["mol", "物质的量", "离子方程式", "电离", "水解", "Kb", "NaHCO"]

# C-C 第 6.1 节的示意粒子数（1 个粒子 = 0.1 mmol，按内部浓度手算）：
#   ③ Ba(OH)₂ 0.050 mol/L × 20 mL = 1 mmol → Ba²⁺ 10、OH⁻ 20；稀硫酸 0.050 mol/L 每 2 mL 滴入 1 个 SO₄²⁻、2 个 H⁺
#   V = 10：Ba²⁺ 10 − 5 = 5、OH⁻ 20 − 10 = 10、BaSO₄ 5；V = 20：四种都是 0、BaSO₄ 10；V = 30：过量 5 个 SO₄²⁻、10 个 H⁺
PAIR3_COUNTS = {
    10: ({"Ba²⁺": 5, "OH⁻": 10, "SO₄²⁻": 0, "H⁺": 0}, 5, "Ba(OH)₂", "before"),
    20: ({"Ba²⁺": 0, "OH⁻": 0, "SO₄²⁻": 0, "H⁺": 0}, 10, "没有溶质", "equiv"),
    30: ({"Ba²⁺": 0, "OH⁻": 0, "SO₄²⁻": 5, "H⁺": 10}, 10, "H₂SO₄", "after"),
}
#   ④ 稀盐酸 0.10 mol/L × 20 mL → H⁺ 20、Cl⁻ 20；Na₂CO₃ 0.050 mol/L 每 2 mL 滴入 1 个 CO₃²⁻、2 个 Na⁺
#   V = 30：Na⁺ 30、Cl⁻ 20、CO₃²⁻ 过量 5、H⁺ 0，放出 CO₂ 10；pH = 11.16（任务书 6.1 的表）
PAIR4_V30 = ({"H⁺": 0, "Cl⁻": 20, "Na⁺": 30, "CO₃²⁻": 5}, 10, "NaCl、Na₂CO₃", "11.16")

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
  // 三个新页面的画板（钩子 boards(k) 的形状各不一样）和可拖动对象
  H.board = function (pg, key) {
    if (pg === "quad") return window.__quad.boards(key);
    if (pg === "solub") return window.__solub.boards(key).board;
    if (pg === "solute") return window.__solute.boards(key).ph;
    return null;
  };
  H.handle = function (pg, key, sub) {
    if (pg === "quad") return window.__quad.handle(key);
    if (pg === "solub") return window.__solub.handle(key, sub);
    if (pg === "solute") return window.__solute.handle(key);
    return null;
  };
  // 世界坐标 → 视口坐标（board.toScreen 给 svg 内坐标，再用 getScreenCTM 换到视口）
  H.client = function (b, xy) {
    var s = b.toScreen(xy), svg = b.svg;
    var m = svg.getScreenCTM ? svg.getScreenCTM() : null;
    if (m && svg.createSVGPoint) { var p = svg.createSVGPoint(); p.x = s[0]; p.y = s[1]; p = p.matrixTransform(m); return [p.x, p.y]; }
    var r = svg.getBoundingClientRect(); return [r.left + s[0], r.top + s[1]];
  };
  H.clientMany = function (pg, key, pts) { var b = H.board(pg, key); return pts.map(function (p) { return H.client(b, p); }); };
  // 手指落点上的元素是不是这个可拖动对象（svgkit 的点：P.node 是一个 g，里面有光圈、触控圈、实心点）
  H.onHandle = function (pg, key, sub, xy) {
    var h = H.handle(pg, key, sub), e = document.elementFromPoint(xy[0], xy[1]);
    return !!(h && h.node && e && (e === h.node || h.node.contains(e)));
  };
  // svgkit 滑块（.sk-range，拇指 26px 宽）上数值 v 的位置（视口坐标）
  H.skSliderXY = function (sel, v) {
    var i = document.querySelector(sel); if (!i) return null;
    var b = i.getBoundingClientRect(), mn = +i.min, mx = +i.max, th = 26;
    return [b.left + th / 2 + (b.width - th) * (v - mn) / (mx - mn), b.top + b.height / 2];
  };
  H.hitIs = function (sel, xy) { var e = document.elementFromPoint(xy[0], xy[1]); var t = document.querySelector(sel); return !!e && !!t && (e === t || t.contains(e)); };
  // 外部部件卡片（预测关卡）：作答区里的 section.qz-card[data-qid]
  H.extCard = function (host) { var cs = document.querySelectorAll(host + " .qz-card[data-qid]"); return cs.length ? cs[cs.length - 1] : null; };
  H.extStage = function (host) { var c = H.extCard(host); return c ? c.getAttribute("data-stage") : null; };
  H.extRecord = function (host) {
    var c = H.extCard(host); if (!c) return null;
    var r = c.querySelector(".qz-record"); if (!r) return { state: null, text: "" };
    return { state: r.getAttribute("data-state"), text: (r.textContent || "").replace(/\s+/g, " ").trim() };
  };
  H.lock = function (cover) {
    var b = document.querySelector(cover), l = b && b.querySelector(":scope > .qz-lock");
    return { attr: b ? b.getAttribute("data-qz-locked") : null, shown: !!l && H.isShown(l), text: l ? l.textContent : "" };
  };
  // 锁定时手指落点上的元素是不是 cover 里的遮罩 .qz-lock（遮罩接住手指，可拖动对象收不到）
  H.lockHit = function (cover, xy) {
    var b = document.querySelector(cover), l = b && b.querySelector(":scope > .qz-lock"), e = document.elementFromPoint(xy[0], xy[1]);
    var cls = e ? (typeof e.className === "string" ? e.className : (e.className && e.className.baseVal) || "") : "";
    return { isLock: !!(l && e && (e === l || l.contains(e))), el: e ? e.tagName + (cls ? "." + cls.trim().split(/\s+/).join(".") : "") : null };
  };
  // 一组选择器各自看不看得见
  H.shownMap = function (sels) { var o = {}; sels.forEach(function (s) { o[s] = H.isShown(document.querySelector(s)); }); return o; };
  // 元素在不在视口里（至少露出一部分，并且有高度）
  H.inView = function (el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), vh: window.innerHeight,
             inView: r.height > 0 && r.bottom > 0 && r.top < window.innerHeight };
  };
  // 普通题卡片（重测页）
  H.card = function (qid) { var cs = document.querySelectorAll('.qz-card[data-qid="' + qid + '"]'); return cs.length ? cs[cs.length - 1] : null; };
  H.record = function (qid) {
    var c = H.card(qid); if (!c) return null;
    var r = c.querySelector(".qz-record"); if (!r) return { state: null, text: "" };
    return { state: r.getAttribute("data-state"), text: (r.textContent || "").replace(/\s+/g, " ").trim() };
  };
  // 渲染出来的文字（含 svg 里的 text）：跳过 script / style，跳过 skipSel（例如 details.hs-box）里的文字
  H.texts = function (skipSel) {
    var out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) {
      var p = n.parentElement, skip = false;
      for (var q = p; q; q = q.parentElement) {
        var tg = q.tagName;
        if (tg === "SCRIPT" || tg === "STYLE" || tg === "NOSCRIPT" || tg === "TEMPLATE") { skip = true; break; }
        if (skipSel && q.matches && q.matches(skipSel)) { skip = true; break; }
      }
      if (!skip && n.nodeValue && n.nodeValue.trim()) out.push(n.nodeValue);
    }
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


def num_of(s):
    """「48.4 g」「26.5%」「60.0℃」→ 48.4；读不出来返回 None。"""
    m = re.search(r"-?\d+(?:\.\d+)?", (s or "").replace(MINUS, "-"))
    return float(m.group(0)) if m else None


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
            path = os.path.join(OUT, "e2e1b_%s_%s.png" % (self.scen, safe))
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

    # ---------- 账号与接口 ----------
    def new_user(self, letter):
        # 用户名 2～20 个字符；dev-server 每次启动是空库，加随机数避免同一进程里重名
        return "e1b%s%06d" % (letter, random.randint(0, 999999))

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


def settle_scroll(page, timeout_ms=2500):
    """等页面停止滚动（引擎提交预测后会平滑滚动；滚动中算出来的视口坐标不准）。"""
    last, t0 = None, time.time()
    while time.time() - t0 < timeout_ms / 1000.0:
        y = page.evaluate("() => [window.scrollX, window.scrollY]")
        if y == last:
            return
        last = y
        page.wait_for_timeout(120)


def lerp(a, b, n):
    return [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(1, n + 1)]


def board_pts(page, pg, key, world):
    """把画板滚到视口中间（等滚动停下），把世界坐标的路线换成视口坐标。"""
    page.evaluate("([p, k]) => window.__e2e.board(p, k).svg.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })", [pg, key])
    page.wait_for_timeout(200)
    settle_scroll(page)
    return page.evaluate("([p, k, w]) => window.__e2e.clientMany(p, k, w)", [pg, key, [list(q) for q in world]])


def board_drag(R, ctx, page, pg, key, world, sample_js=None, sub=None):
    """把画板滚到视口中间，按世界坐标的路线拖（手机触屏 / 桌面鼠标）；world[0] 必须是可拖动对象当前的位置。
    返回 (每步之后 sample_js 的结果, 起点是否落在可拖动对象上)。"""
    pts = board_pts(page, pg, key, world)
    hit = page.evaluate("([p, k, s, xy]) => window.__e2e.onHandle(p, k, s, xy)", [pg, key, sub, pts[0]])
    fn = (lambda k: page.evaluate(sample_js)) if sample_js else None
    return pointer_path(R, ctx, page, pts, fn), hit


def handle_at(page, pg, key, sub=None):
    return page.evaluate("([p, k, s]) => window.__e2e.handle(p, k, s).get()", [pg, key, sub])


def locked_drag_to(R, ctx, page, pg, key, cover, to, steps, keep_y=False):
    """锁定时：从可拖动对象所在的位置按下手指拖向 to。返回 lockHit（手指落点是不是 cover 里的遮罩 .qz-lock，以及落点元素）。"""
    h = handle_at(page, pg, key)
    start = (h[0], h[1])
    end = (to[0], h[1] if keep_y else to[1])
    pts = board_pts(page, pg, key, [start] + lerp(start, end, steps))
    lk = page.evaluate("([c, xy]) => window.__e2e.lockHit(c, xy)", [cover, pts[0]])
    on_h = page.evaluate("([p, k, xy]) => window.__e2e.onHandle(p, k, null, xy)", [pg, key, pts[0]])
    pointer_path(R, ctx, page, pts)
    lk["onHandle"] = on_h
    return lk


def shown_map(page, sels):
    return page.evaluate("(s) => window.__e2e.shownMap(s)", list(sels))


def fmt_shown(m):
    return "、".join("%s %s" % (k, "看得见" if v else "看不见") for k, v in m.items())


def drag_to(R, ctx, page, pg, key, to, steps, sample_js=None, sub=None, keep_y=None):
    """从可拖动对象现在的位置拖到世界坐标 to（steps 步）。keep_y：只改横坐标时纵坐标保持不变（取样点、状态点）。"""
    h = handle_at(page, pg, key, sub)
    start = (h[0], h[1])
    end = (to[0], h[1] if keep_y else to[1])
    return board_drag(R, ctx, page, pg, key, [start] + lerp(start, end, steps), sample_js, sub)


def slide_sk(R, ctx, page, sel, targets, step=0.5, after_move=None):
    """真的拖 svgkit 滑块：手指按在拇指上，横着一步一步移到 targets 里的每个值。返回 (采样, 起点落在滑块上, 最终值)。"""
    page.evaluate("(s) => document.querySelector(s).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })", sel)
    page.wait_for_timeout(250)
    settle_scroll(page)
    v0 = float(page.evaluate("(s) => document.querySelector(s).value", sel))
    vals, cur = [v0], v0
    for t in targets:
        n = max(1, int(math.ceil(abs(t - cur) / step - 1e-9)))
        vals += [cur + (t - cur) * i / n for i in range(1, n + 1)]
        cur = t
    pts = page.evaluate("([s, vs]) => vs.map(function (v) { return window.__e2e.skSliderXY(s, v); })", [sel, vals])
    hit = page.evaluate("([s, p]) => window.__e2e.hitIs(s, p)", [sel, pts[0]])
    samples = pointer_path(R, ctx, page, pts, after_move)
    return samples, hit, float(page.evaluate("(s) => document.querySelector(s).value", sel))


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


def wait_card(R, page, host, qid, timeout=20000):
    try:
        page.wait_for_selector('%s .qz-card[data-qid="%s"][data-stage]' % (host, qid), timeout=timeout)
    except PWTimeout:
        R.require("gate.card", False, "%d 秒内 %s 里没有出现预测卡片 %s" % (timeout // 1000, host, qid), page)
    page.wait_for_timeout(300)


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
    settle_scroll(page)


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
    return wait_ext_record(page, host, want)


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


def no_errors_check(R, name, page=None):
    errs = R.errors_of()
    R.check(name, not errs, "console.error / pageerror %d 条%s" % (
        len(errs), ("：" + " | ".join("%s %s @ %s" % (k, short(m, 120), u.replace(R.base, "")) for _, k, u, m in errs[:3])) if errs else ""), page)


def progress(page, key):
    return page.evaluate("(k) => window.ABSLabAuth ? window.ABSLabAuth.getProgress(k) : '(没有 ABSLabAuth)'", key)


def all_true(prog, key):
    return isinstance(prog, dict) and all(prog.get(k) is True for k in PROG[key])


def none_true(prog, key):
    return not isinstance(prog, dict) or all(prog.get(k) is not True for k in PROG[key])


def scroll_w(page):
    return page.evaluate("() => document.documentElement.scrollWidth")


def tab_to(R, ctx, page, hook, key):
    """点标签页按钮切换情境，返回 (钩子 tab(), 面板可见, 其他面板都隐藏)。"""
    tap(R, ctx, page, '[role=tab][data-tab="%s"]' % key)
    page.wait_for_timeout(350)
    return page.evaluate("""([h, k]) => {
      var all = Array.prototype.slice.call(document.querySelectorAll('section[data-task]'));
      var me = document.querySelector('section[data-task="' + k + '"]');
      return { tab: window[h].tab(), shown: window.__e2e.isShown(me),
               others: all.filter(function (s) { return s !== me && window.__e2e.isShown(s); }).map(function (s) { return s.getAttribute('data-task'); }) }; }""", [hook, key])


# ------------------------------------------------------------------ 场景 ----

def sc_offline(R):
    """8.C 第 1 条：拦截所有请求，主机不是 localhost 的记下并中止；390×844 触屏逐页打开，
    console.error、pageerror 都是 0，没有横向滚动。三个新页面每个标签页都切一遍（溶质页再选③、等预测卡片挂上），
    学科页看新入口卡片（标「初中」），小测页开始后看到第 1 题。"""
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
            widths.append(("首屏", scroll_w(page)))
            if path in TABS:
                hook, keys = TABS[path]
                wait_js(page, "(h) => !!window[h]", hook, 10000)
                page.evaluate("async (h) => { await window[h].gate(); return 1; }", hook)
                for key in keys:
                    t = tab_to(R, ctx, page, hook, key)
                    notes.append("%s:%s" % (key, "显示" if (t["tab"] == key and t["shown"] and not t["others"]) else "没显示"))
                    if not (t["tab"] == key and t["shown"] and not t["others"]):
                        nav_err = nav_err or ("标签页 %s 没有切过去：%s" % (key, jd(t)))
                    if path == "chemistry/solute.html" and key == "curve":
                        # 选③：挂上预测关卡（引擎、题库在断网时也能从 localhost 加载）
                        tap(R, ctx, page, '[data-pair="3"]')
                        page.evaluate("async () => { await window.__solute.gate(); return 1; }")
                        try:
                            page.wait_for_selector('#qz-curve-ans .qz-card[data-qid="%s"][data-stage]' % QID_CC, timeout=15000)
                            notes.append("③ 预测卡片 %s" % page.evaluate("() => window.__e2e.extStage('#qz-curve-ans')"))
                        except PWTimeout:
                            nav_err = nav_err or "选③后预测卡片没有挂上"
                        page.wait_for_timeout(300)
                    widths.append((key, scroll_w(page)))
            elif path in PORTALS:
                for href in PORTALS[path]:
                    b = page.evaluate("(h) => { var a = document.querySelector('a.portal-card[href=\"' + h + '\"]'); if (!a) return null; var g = a.querySelector('.badge'); return { badge: g ? g.textContent.trim() : '', shown: window.__e2e.isShown(a), title: (a.querySelector('h3') || {}).textContent || '' }; }", href)
                    notes.append("入口 %s：%s" % (href, jd(b)))
                    if not b or b["badge"] != "初中" or not b["shown"]:
                        nav_err = nav_err or ("入口卡片 %s 不对：%s" % (href, jd(b)))
            elif path.startswith("chemistry/neutralization"):
                n = page.evaluate("() => document.querySelectorAll('.next-step-card a[href*=\"solute.html\"]').length")
                notes.append("下一步卡片 %d" % n)
            elif path.startswith("check.html"):
                mod = re.search(r"m=(\w+)", path).group(1)
                pre = {"m2": "m-m2-", "cb": "c-cb-", "cc": "c-cc-"}[mod]
                page.wait_for_selector("[data-ck-start]", timeout=15000)
                tap(R, ctx, page, "[data-ck-start]")
                try:
                    page.wait_for_selector('[data-ck-num="1"]', timeout=15000)
                    page.wait_for_selector(".ck-card[data-qid]", timeout=5000)
                    q1 = page.evaluate("() => document.querySelector('.ck-card').getAttribute('data-qid')")
                    notes.append("第 1 题 %s" % q1)
                    if not (q1 or "").startswith(pre):
                        nav_err = nav_err or "第 1 题 %s 不是 %s 模块的" % (q1, mod)
                except PWTimeout:
                    nav_err = nav_err or "开始以后没有看到第 1 题"
                page.wait_for_timeout(400)
                widths.append(("第 1 题", scroll_w(page)))
        except (PWError, PWTimeout) as e:
            nav_err = nav_err or short(e, 200)
        ok = not ext and not cons and not perr and not nav_err and not bad
        parts = ["外部请求 %d" % len(ext), "console.error %d" % len(cons), "pageerror %d" % len(perr), "本地 HTTP≥400 %d" % len(bad)]
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
            parts.append("HTTP≥400: " + ", ".join(bad[:3]))
        R.check("page " + path, ok, "；".join(parts), page)
        wmax = max([w for _, w in widths if w is not None] or [None]) if widths else None
        R.check("no_hscroll_390 " + path, bool(widths) and wmax is not None and wmax <= 390,
                "scrollWidth %s" % "、".join("%s %s" % (k, w) for k, w in widths), page)
        page.close()
    cur["ext"] = None
    R.check("external_requests_total", total["ext"] == 0, "全部页面共发出请求 %d 个，其中外部请求 %d 个" % (total["all"], total["ext"]))


def sc_m2_mobile(R):
    """8.C 第 2 条（M2，390×844 触屏）：vertex 先锁定（拖不动）→ 选 a +「有把握」提交 → 解锁 → 真的触屏拖顶点到 h = 2、h = −2，
    解析式逐字（减号是 U+2212）；interval 拖窗口经过三种情况，2 ≤ x ≤ 4 时最小值 3；abc：a = 1、b = −2 时对称轴在右侧，
    a > 0、a < 0 下 b 都变过号（a、b 都用手指拖滑块）；三个任务都记为完成。锁定时手指落在遮罩上；每个读数都核对看得见。"""
    ctx = R.new_context(mobile=True)
    page = R.new_page(ctx)
    page.goto(R.url("math/quadratic.html"), wait_until="load")
    try:
        wait_js(page, "() => !!window.__quad", None, 10000)
        page.evaluate("async () => { await window.__quad.gate(); return 1; }")
    except (PWTimeout, PWError) as e:
        R.require("setup.hook", False, "window.__quad / __quad.gate() 不可用：%s" % short(e, 200), page)
    R.check("start.tab_vertex", page.evaluate("() => window.__quad.tab()") == "vertex", "默认标签页 %r" % page.evaluate("() => window.__quad.tab()"), page)
    p0 = progress(page, "math_quad_tasks")
    t0 = page.evaluate("() => window.__quad.tasks()")
    R.check("progress.baseline_all_false", none_true(p0, "math_quad_tasks") and t0 == {"vertex": False, "interval": False, "abc": False},
            "刚打开：getProgress('math_quad_tasks') = %s，__quad.tasks() = %s" % (jd(p0), jd(t0)), page)

    # ---------- vertex：锁定 ----------
    wait_card(R, page, "#qz-vertex-ans", QID_M2)
    st = page.evaluate("(h) => window.__e2e.extStage(h)", "#qz-vertex-ans")
    g = page.evaluate("() => window.__quad.get('vertex')")
    lk = page.evaluate("() => window.__e2e.lock('#quad-vertex-boards')")
    en = page.evaluate("() => window.__quad.handle('vertex').enabled()")
    dis_a = page.evaluate("() => document.querySelector('#quad-vertex .sk-ctl[data-id=\"a\"] input').disabled")
    R.check("vertex.locked", st == "predict" and g["locked"] is True and lk["attr"] == "true" and lk["shown"] and "先预测，再动手" in lk["text"]
            and en is False and dis_a is True,
            "data-stage=%r，locked=%r，#quad-vertex-boards data-qz-locked=%r，遮罩可见=%r「%s」，顶点 enabled()=%r，a 滑块 disabled=%r" % (
                st, g["locked"], lk["attr"], lk["shown"], short(lk["text"], 20), en, dis_a), page)
    R.shot(page, "vertex_locked")
    lh = locked_drag_to(R, ctx, page, "quad", "vertex", "#quad-vertex-boards", (2, 0), 8)
    g = page.evaluate("() => window.__quad.get('vertex')")
    ex = page.text_content("#quad-expr")
    R.check("vertex.locked_no_drag", lh["isLock"] and not lh["onHandle"] and g["h"] == 0 and g["k"] == 0 and ex == "y = x²",
            "预测前触屏从顶点所在的 (0, 0) 拖向 (2, 0)：手指落点 %s（应是 #quad-vertex-boards 里的遮罩 .qz-lock：%s；落在顶点上=%s），h=%r k=%r，#quad-expr「%s」（应不动）" % (
                lh["el"], lh["isLock"], lh["onHandle"], g["h"], g["k"], ex), page)

    # ---------- 选 a +「有把握」→ 解锁 ----------
    predict_ext(R, ctx, page, "#qz-vertex-ans", "a", "sure", "vertex.")
    g = page.evaluate("() => window.__quad.get('vertex')")
    lk = page.evaluate("() => window.__e2e.lock('#quad-vertex-boards')")
    en = page.evaluate("() => window.__quad.handle('vertex').enabled()")
    R.check("vertex.unlocked", g["locked"] is False and lk["attr"] != "true" and not lk["shown"] and en is True,
            "提交后 locked=%r，data-qz-locked=%r，遮罩可见=%r，顶点 enabled()=%r" % (g["locked"], lk["attr"], lk["shown"], en), page)

    samp = "() => { var g = window.__quad.get('vertex'); return [g.h, g.k, document.getElementById('quad-expr').textContent]; }"
    sm, hit = drag_to(R, ctx, page, "quad", "vertex", (2, 0), 12, samp)
    g = page.evaluate("() => window.__quad.get('vertex')")
    ex = page.text_content("#quad-expr")
    sh = page.text_content("#quad-shift")
    vis = shown_map(page, ["#quad-expr", "#quad-shift", "#quad-vertex-at"])
    want = "y = (x %s 2)²" % MINUS
    R.check("vertex.touch_on_handle", hit, "触屏起点落在顶点上（elementFromPoint 在 __quad.handle('vertex').node 里）", page)
    R.check("vertex.h2_expr", g["h"] == 2 and g["k"] == 0 and ex == want and "-" not in ex and sh == "向右 2" and all(vis.values()),
            "%d 次 touchMove 拖到 h=%r k=%r：#quad-expr「%s」（应为「%s」，减号 U+2212），#quad-shift「%s」；%s" % (
                len(sm), g["h"], g["k"], ex, want, sh, fmt_shown(vis)), page)
    R.shot(page, "vertex_h2")
    sm, hit = drag_to(R, ctx, page, "quad", "vertex", (-2, 0), 16, samp)
    g = page.evaluate("() => window.__quad.get('vertex')")
    ex = page.text_content("#quad-expr")
    sh = page.text_content("#quad-shift")
    vis = shown_map(page, ["#quad-expr", "#quad-shift"])
    R.check("vertex.hm2_expr", hit and g["h"] == -2 and g["k"] == 0 and ex == "y = (x + 2)²" and sh == "向左 2" and all(vis.values()),
            "再拖到 h=%r k=%r（起点在顶点上=%s）：#quad-expr「%s」（应为「y = (x + 2)²」），#quad-shift「%s」；%s；minH=%r maxH=%r" % (
                g["h"], g["k"], hit, ex, sh, fmt_shown(vis), g["minH"], g["maxH"]), page)
    seen_expr = sorted(set(s[2] for s in sm))
    R.info("拖动中出现过的解析式：%s" % seen_expr)
    rec = finish_ext(R, ctx, page, "#qz-vertex-ans", EXPLAIN_M2, ("guest",), "vertex.")
    R.check("vertex.gate_finished", rec.get("state") == "guest" and page.evaluate("(h) => window.__e2e.extStage(h)", "#qz-vertex-ans") == "feedback",
            "游客做完预测关卡：记录行 data-state=%r，data-stage=%r" % (rec.get("state"), page.evaluate("(h) => window.__e2e.extStage(h)", "#qz-vertex-ans")), page)
    p1 = progress(page, "math_quad_tasks")
    R.check("progress.after_vertex", isinstance(p1, dict) and p1.get("vertex") is True and p1.get("interval") is not True and p1.get("abc") is not True,
            "vertex 做完后 getProgress = %s（只有 vertex 为 true）" % jd(p1), page)

    # ---------- interval：拖窗口经过三种情况 ----------
    t = tab_to(R, ctx, page, "__quad", "interval")
    R.check("interval.tab", t["tab"] == "interval" and t["shown"] and not t["others"], "切到 interval：%s" % jd(t), page)
    g = page.evaluate("() => window.__quad.get('interval')")
    mn = page.text_content("#quad-min")
    R.check("interval.default", g["x1"] == 2 and g["x2"] == 4 and g["case"] == "left" and mn == "3" and page.text_content("#quad-int-range") == "2 ≤ x ≤ 4",
            "默认窗口 %s ≤ x ≤ %s，case=%r，#quad-min「%s」，#quad-int-range「%s」" % (g["x1"], g["x2"], g["case"], mn, page.text_content("#quad-int-range")), page)
    isamp = """() => { var g = window.__quad.get('interval'), c = document.getElementById('quad-case');
      return [g.x1, g.x2, c.getAttribute('data-case'), document.getElementById('quad-min').textContent, window.__e2e.isShown(c)]; }"""
    seen = []
    hits = []
    case_hidden = 0
    for mid, n in ((1.0, 10), (-2.5, 14), (3.0, 20)):
        sm, hit = drag_to(R, ctx, page, "quad", "interval", (mid, 0), n, isamp, keep_y=True)
        hits.append(hit)
        case_hidden += sum(1 for s in sm if not s[4])
        for s in sm:
            if not seen or seen[-1] != s[2]:
                seen.append(s[2])
        g = page.evaluate("() => window.__quad.get('interval')")
        R.info("窗口中点拖到 %s：%s ≤ x ≤ %s，case=%s，最小值 %s，最大值 %s" % (mid, g["x1"], g["x2"], g["case"], g["min"], g["max"]))
    g = page.evaluate("() => window.__quad.get('interval')")
    dom_case = page.get_attribute("#quad-case", "data-case")
    R.check("interval.touch_on_handle", all(hits), "三次触屏拖动的起点都落在窗口手柄上：%s" % hits, page)
    R.check("interval.three_cases", set(["left", "inside", "right"]) <= set(seen) and g["seen"] == {"left": True, "inside": True, "right": True}
            and case_hidden == 0,
            "拖动中 #quad-case 的 data-case 依次为 %s（应出现 left / inside / right），钩子 seen=%s；采样里 #quad-case 看不见的 %d 次（应为 0）" % (
                seen, jd(g["seen"]), case_hidden), page)
    mn = page.text_content("#quad-min")
    mx = page.text_content("#quad-max")
    vis = shown_map(page, ["#quad-min", "#quad-min-at", "#quad-max", "#quad-case"])
    R.check("interval.min3_at_2_4", g["x1"] == 2 and g["x2"] == 4 and mn == "3" and dom_case == "left" and abs(g["min"]["y"] - 3) < 1e-9
            and page.text_content("#quad-min-at") == "x = 2" and all(vis.values()),
            "拖回 %s ≤ x ≤ %s：#quad-min「%s」（%s），#quad-max「%s」，data-case=%r（y = (x − 1)² + 2 在 2～4 上最小值 3）；%s" % (
                g["x1"], g["x2"], mn, page.text_content("#quad-min-at"), mx, dom_case, fmt_shown(vis)), page)
    R.check("interval.task_done", g["done"] is True and page.evaluate("() => window.__quad.tasks().interval") is True,
            "interval 三种情况都出现过：done=%r" % g["done"], page)
    R.shot(page, "interval")

    # ---------- abc ----------
    t = tab_to(R, ctx, page, "__quad", "abc")
    R.check("abc.tab", t["tab"] == "abc" and t["shown"] and not t["others"], "切到 abc：%s" % jd(t), page)
    g0 = page.evaluate("() => window.__quad.get('abc')")
    sel_a = '#quad-abc .sk-ctl[data-id="a"] input'
    sel_b = '#quad-abc .sk-ctl[data-id="b"] input'
    va = float(page.evaluate("(s) => document.querySelector(s).value", sel_a))
    R.check("abc.default_a1_b2", g0["a"] == 1 and g0["b"] == 2 and va == 1,
            "abc 默认 a=%s b=%s c=%s（a 滑块的值 %s）：a 已经是 1，下面用手指把 b 从 2 拖到 −2" % (g0["a"], g0["b"], g0["c"], va), page)
    _, hit_b, vb = slide_sk(R, ctx, page, sel_b, [-2], step=0.5)
    page.wait_for_timeout(150)
    g = page.evaluate("() => window.__quad.get('abc')")
    side = page.get_attribute("#quad-side", "data-side")
    side_t = page.text_content("#quad-side")
    expr = page.text_content("#quad-abc-expr")
    signs = page.evaluate("() => ['a', 'b', 'c'].map(function (k) { var td = document.querySelector('#quad-signs .qd-sg td[data-k=\"' + k + '\"]'); return td ? td.getAttribute('data-sign') : null; })")
    vis = shown_map(page, ["#quad-side", "#quad-abc-expr", "#quad-signs"])
    want_expr = "y = x² %s 2x %s 1" % (MINUS, MINUS)
    R.check("abc.a1_bm2_right", hit_b and vb == -2 and g["a"] == 1 and g["b"] == -2 and side == "right" and "右侧" in side_t and expr == want_expr
            and signs == ["+", MINUS, MINUS] and all(vis.values()),
            "a = 1 时手指拖 b 滑块 2 → −2（起点落在滑块拇指上=%s，滑块值 %s）：钩子 a=%s b=%s，#quad-side data-side=%r「%s」，#quad-abc-expr「%s」（应为「%s」），正负小表 %s；%s" % (
                hit_b, vb, g["a"], g["b"], side, side_t, expr, want_expr, signs, fmt_shown(vis)), page)
    R.check("abc.flip_up_only", g["flipped"] == {"up": True, "down": False} and g["done"] is False,
            "a > 0 时 b 由 + 变 −：flipped=%s，done=%r（a < 0 还没做）" % (jd(g["flipped"]), g["done"]), page)
    _, hit_a, va = slide_sk(R, ctx, page, sel_a, [-1], step=0.5)
    page.wait_for_timeout(150)
    g = page.evaluate("() => window.__quad.get('abc')")
    R.check("abc.touch_a_slider", hit_a and va == -1 and g["a"] == -1 and g["b"] == -2 and g["flipped"] == {"up": True, "down": False},
            "手指拖 a 滑块 1 → −1（跳过 0；起点落在滑块拇指上=%s）：滑块值 %s，钩子 a=%s b=%s，flipped=%s（只改 a 不算 b 变号）" % (
                hit_a, va, g["a"], g["b"], jd(g["flipped"])), page)
    _, hit, vend = slide_sk(R, ctx, page, sel_b, [2], step=0.5)
    g = page.evaluate("() => window.__quad.get('abc')")
    side = page.get_attribute("#quad-side", "data-side")
    vis = shown_map(page, ["#quad-side"])
    R.check("abc.touch_b_slider", hit and vend == 2 and g["b"] == 2 and g["a"] == -1 and side == "right" and all(vis.values()),
            "a = −1 时手指拖 b 滑块 −2 → 2（起点落在滑块上=%s）：滑块值 %s，钩子 a=%s b=%s，对称轴 data-side=%r（a、b 异号，在右侧）；%s" % (
                hit, vend, g["a"], g["b"], side, fmt_shown(vis)), page)
    R.check("abc.task_done", g["flipped"] == {"up": True, "down": True} and g["done"] is True,
            "a > 0、a < 0 下 b 都变过号：flipped=%s，done=%r" % (jd(g["flipped"]), g["done"]), page)
    R.shot(page, "abc")

    prog = progress(page, "math_quad_tasks")
    tasks = page.evaluate("() => window.__quad.tasks()")
    marks = page.evaluate("() => Array.prototype.map.call(document.querySelectorAll('[role=tab][data-tab]'), function (b) { return [b.getAttribute('data-tab'), b.classList.contains('is-done')]; })")
    R.check("progress.all_true", all_true(prog, "math_quad_tasks") and tasks == {"vertex": True, "interval": True, "abc": True}
            and all(m[1] for m in marks) and len(marks) == 3,
            "getProgress('math_quad_tasks') = %s，__quad.tasks() = %s，标签页完成标记 %s" % (jd(prog), jd(tasks), marks), page)
    widths = []
    for key in ("vertex", "interval", "abc"):
        page.evaluate("(k) => window.__quad.show(k)", key)
        page.wait_for_timeout(150)
        widths.append((key, scroll_w(page)))
    R.check("layout.no_hscroll", all(w <= 390 for _, w in widths), "三个标签页 scrollWidth %s" % widths, page)
    no_errors_check(R, "no_page_errors", page)


def sc_cb_mobile(R):
    """8.C 第 3 条（C-B，390×844 触屏）：cool 先锁定（拖不动）→ 选 c 提交 → 解锁 → 触屏每步 0.25℃ 从 60℃ 拖到 20℃：
    T > 47.6℃ 的每个采样析出量都正好是 0（读数看得见），到 20℃ 读数 48.4 g（±0.1）、板上看得见「析出 48.4 g」；compare：交点处两份都恰好饱和 →
    质量分数相同、[data-solub-equal].on（底色确实变了）；nacl：20℃ 析出 1.3 g，恒温蒸发 10 g 水后 4.9 g（多 3.6 g），板上纵轴 0～80、
    状态点画在板上、虚线旁写「每 100 g 水多 …」；三个任务都记为完成。锁定时手指落在遮罩上。"""
    ctx = R.new_context(mobile=True)
    page = R.new_page(ctx)
    page.goto(R.url("chemistry/solubility.html"), wait_until="load")
    try:
        wait_js(page, "() => !!window.__solub", None, 10000)
        page.evaluate("async () => { await window.__solub.gate(); return 1; }")
    except (PWTimeout, PWError) as e:
        R.require("setup.hook", False, "window.__solub / __solub.gate() 不可用：%s" % short(e, 200), page)
    p0 = progress(page, "chem_solub_tasks")
    t0 = page.evaluate("() => window.__solub.tasks()")
    R.check("progress.baseline_all_false", none_true(p0, "chem_solub_tasks") and t0 == {"cool": False, "compare": False, "nacl": False},
            "刚打开：getProgress('chem_solub_tasks') = %s，__solub.tasks() = %s" % (jd(p0), jd(t0)), page)

    # ---------- cool：锁定 ----------
    wait_card(R, page, "#qz-cool-ans", QID_CB)
    st = page.evaluate("(h) => window.__e2e.extStage(h)", "#qz-cool-ans")
    g = page.evaluate("() => window.__solub.get('cool')")
    lk = page.evaluate("() => window.__e2e.lock('#solub-cool-boards')")
    en = page.evaluate("() => window.__solub.handle('cool').enabled()")
    R.check("cool.locked", st == "predict" and g["locked"] is True and lk["attr"] == "true" and lk["shown"] and "先预测，再动手" in lk["text"] and en is False,
            "data-stage=%r，locked=%r，#solub-cool-boards data-qz-locked=%r，遮罩可见=%r，状态点 enabled()=%r；T=%s m=%s" % (
                st, g["locked"], lk["attr"], lk["shown"], en, g["T"], g["m"]), page)
    R.shot(page, "cool_locked")
    lh = locked_drag_to(R, ctx, page, "solub", "cool", "#solub-cool-boards", (40, 80), 8, keep_y=True)
    g = page.evaluate("() => window.__solub.get('cool')")
    R.check("cool.locked_no_drag", lh["isLock"] and not lh["onHandle"] and g["T"] == 60 and g["precipitate"] == 0,
            "预测前触屏从状态点所在的 (60, 80) 往左拖：手指落点 %s（应是 #solub-cool-boards 里的遮罩 .qz-lock：%s；落在状态点上=%s），T=%r（应不动）" % (
                lh["el"], lh["isLock"], lh["onHandle"], g["T"]), page)

    predict_ext(R, ctx, page, "#qz-cool-ans", "c", "sure", "cool.")
    g = page.evaluate("() => window.__solub.get('cool')")
    lk = page.evaluate("() => window.__e2e.lock('#solub-cool-boards')")
    en = page.evaluate("() => window.__solub.handle('cool').enabled()")
    R.check("cool.unlocked", g["locked"] is False and lk["attr"] != "true" and not lk["shown"] and en is True,
            "提交后 locked=%r，data-qz-locked=%r，遮罩可见=%r，状态点 enabled()=%r" % (g["locked"], lk["attr"], lk["shown"], en), page)

    # ---------- 触屏 60℃ → 20℃，每步 0.25℃ ----------
    samp = """() => { var g = window.__solub.get('cool'), r = document.getElementById('solub-cool-read');
      var q = function (k) { var e = r.querySelector('[data-r="' + k + '"]'); return e ? e.textContent : null; };
      var pe = r.querySelector('[data-r="ppt"]');
      return { T: g.T, status: g.status, ppt: g.precipitate, dT: q('T'), dppt: q('ppt'), dst: q('status'), label: g.label, vis: window.__e2e.isShown(pe) }; }"""
    sm, hit = drag_to(R, ctx, page, "solub", "cool", (20, 80), 160, samp, keep_y=True)
    R.check("cool.touch_on_point", hit, "触屏起点落在状态点 (60, 80) 上", page)
    hot = [s for s in sm if s["T"] > 47.6]
    bad = [s for s in hot if s["ppt"] != 0 or s["dppt"] != "0.0 g" or s["status"] != "unsat" or not s["vis"]]
    temps = sorted(set(round(s["T"], 2) for s in hot))
    R.check("cool.no_precipitate_above_47.6", len(hot) >= 40 and not bad,
            "%d 次 touchMove，其中 T > 47.6℃ 的采样 %d 个（%d 个不同温度，%s～%s℃）：析出量（钩子）全是 0、读数「0.0 g」且看得见、状态 unsat%s" % (
                len(sm), len(hot), len(temps), temps[0] if temps else "?", temps[-1] if temps else "?",
                ("；不满足 %d 个，例如 %s" % (len(bad), jd(bad[0]))) if bad else ""), page)
    sat = [s for s in sm if s["status"] == "sat"]
    first_cr = next((s for s in sm if s["status"] == "crystal"), None)
    R.check("cool.touches_curve_47.6", sat and all(abs(s["T"] - 47.583) < 0.01 and s["dst"] == "恰好饱和" for s in sat) and first_cr and first_cr["T"] < 47.6,
            "碰到曲线：恰好饱和的采样 %s（应在约 47.6℃，读数「恰好饱和」）；第一次有晶体 %s" % (
                [(s["T"], s["dst"]) for s in sat[:3]], jd(first_cr)), page)
    g = page.evaluate("() => window.__solub.get('cool')")
    dppt = page.text_content('#solub-cool-read [data-r="ppt"]')
    v = num_of(dppt)
    vis = shown_map(page, ['#solub-cool-read [data-r="ppt"]', '#solub-cool-read [data-r="T"]', '#solub-cool-read [data-r="status"]'])
    # 板上看得见的标注（.sb-tag 里的 text，同一时间只显示一个方位）：应正好是「析出 48.4 g」，并且画在虚线旁边
    tg = page.evaluate("""() => {
      var b = window.__solub.boards('cool').board, svg = b.svg, H = window.__e2e, g = window.__solub.get('cool');
      var tags = Array.prototype.filter.call(svg.querySelectorAll('.sb-tag text'), function (t) { return H.isShown(t) && (t.textContent || '').trim(); });
      var top = H.client(b, [g.T, g.per100]), bot = H.client(b, [g.T, g.S]);
      return { tags: tags.map(function (t) { var r = t.getBoundingClientRect(); return { text: t.textContent.trim(), rect: [r.left, r.top, r.right, r.bottom] }; }),
               dashX: top[0], dashY: [top[1], bot[1]] }; }""")
    tag_txt = [t["text"] for t in tg["tags"]]
    near = False
    for t in tg["tags"]:
        if t["text"] == "析出 48.4 g":
            r = t["rect"]
            y0, y1 = min(tg["dashY"]), max(tg["dashY"])
            dx = 0 if r[0] <= tg["dashX"] <= r[2] else min(abs(r[0] - tg["dashX"]), abs(r[2] - tg["dashX"]))
            near = dx <= 40 and r[3] >= y0 - 30 and r[1] <= y1 + 30
    R.check("cool.at20_48.4", g["T"] == 20 and v is not None and abs(v - 48.4) <= 0.1 + 1e-9 and "g" in dppt and g["label"] == "析出 48.4 g"
            and all(vis.values()),
            "停在 T=%r℃：读数「析出晶体的质量」「%s」（应为 48.4 g ± 0.1；80 − 31.6；%s），钩子标注「%s」，precipitate=%.4f，质量分数 %.1f%%" % (
                g["T"], dppt, fmt_shown(vis), g["label"], g["precipitate"], g["fraction"]), page)
    R.check("cool.board_tag_48.4", tag_txt == ["析出 48.4 g"] and near,
            "cool 板上看得见的标注 %s（应正好是「析出 48.4 g」），在虚线（x=%.1f，y %.1f～%.1f）旁边=%r" % (
                tag_txt, tg["dashX"], min(tg["dashY"]), max(tg["dashY"]), near), page)
    R.check("cool.gate_and_task", g["gateDone"] is True and g["minT"] <= 22 and g["maxT"] >= 58 and g["done"] is True,
            "解锁后温度到过 %s～%s℃（≤ 22 且 ≥ 58）：gateDone=%r，cool 任务 done=%r" % (g["minT"], g["maxT"], g["gateDone"], g["done"]), page)
    R.shot(page, "cool_20")
    rec = finish_ext(R, ctx, page, "#qz-cool-ans", EXPLAIN_CB, ("guest",), "cool.")
    R.check("cool.gate_finished", rec.get("state") == "guest", "游客做完预测关卡：记录行 data-state=%r" % rec.get("state"), page)

    # ---------- compare ----------
    t = tab_to(R, ctx, page, "__solub", "compare")
    R.check("compare.tab", t["tab"] == "compare" and t["shown"] and not t["others"], "切到 compare：%s" % jd(t), page)
    g = page.evaluate("() => window.__solub.get('compare')")
    cr = g["cross"]
    R.check("compare.crossing", abs(cr["T"] - 23.46) < 0.01 and abs(cr["S"] - 36.10) < 0.01,
            "交点 T=%.3f℃ S=%.3f g（任务书 5.1：约 23.5℃、36.1 g）" % (cr["T"], cr["S"]), page)
    tap(R, ctx, page, '[data-solub-pick="KNO3"]')
    _, hit_k = drag_to(R, ctx, page, "solub", "compare", (cr["T"] + 0.2, cr["S"] + 0.3), 16, sub="KNO3")
    tap(R, ctx, page, '[data-solub-pick="NaCl"]')
    act = page.evaluate("() => window.__solub.get('compare').active")
    _, hit_n = drag_to(R, ctx, page, "solub", "compare", (cr["T"] - 0.2, cr["S"] - 0.2), 16, sub="NaCl")
    page.wait_for_timeout(300)  # 高亮的底色有 0.15 s 过渡
    eq_js = """() => { var e = document.querySelector('[data-solub-equal]'), td = e.querySelector('td');
      return { on: e.classList.contains('on'), bg: getComputedStyle(td).backgroundColor, color: getComputedStyle(td).color }; }"""
    g = page.evaluate("() => window.__solub.get('compare')")
    wk = page.text_content('[data-r="w-KNO3"]')
    wn = page.text_content('[data-r="w-NaCl"]')
    eq1 = page.evaluate(eq_js)
    eq_on = eq1["on"]
    cmp_sels = ['[data-r="w-KNO3"]', '[data-r="w-NaCl"]', "[data-solub-equal]", '[data-r="status-KNO3"]', '[data-r="status-NaCl"]']
    vis = shown_map(page, cmp_sels)
    R.check("compare.touch_on_selected", hit_k and hit_n and act == "NaCl",
            "两次触屏拖动都从当前选中的状态点出发：KNO₃=%s，NaCl=%s（切换后 active=%r）" % (hit_k, hit_n, act), page)
    R.check("compare.both_sat_equal", g["KNO3"]["status"] == "sat" and g["NaCl"]["status"] == "sat"
            and abs(g["KNO3"]["T"] - cr["T"]) < 1e-9 and abs(g["NaCl"]["T"] - cr["T"]) < 1e-9
            and abs(g["KNO3"]["fraction"] - g["NaCl"]["fraction"]) < 1e-6 and wk == wn and eq_on and g["equal"] is True and all(vis.values()),
            "KNO₃ (%.2f℃, %.2f g, %s) / NaCl (%.2f℃, %.2f g, %s)：质量分数 %s / %s（钩子 %.3f / %.3f），[data-solub-equal].on=%r，equal=%r；%s" % (
                g["KNO3"]["T"], g["KNO3"]["m"], g["KNO3"]["status"], g["NaCl"]["T"], g["NaCl"]["m"], g["NaCl"]["status"],
                wk, wn, g["KNO3"]["fraction"], g["NaCl"]["fraction"], eq_on, g["equal"], fmt_shown(vis)), page)
    R.shot(page, "compare_equal")
    # 同一温度、NaCl 不饱和：不高亮，各自的值（任务的另一半）
    _, hit_n2 = drag_to(R, ctx, page, "solub", "compare", (cr["T"], 15), 12, sub="NaCl")
    page.wait_for_timeout(300)
    g = page.evaluate("() => window.__solub.get('compare')")
    wk = page.text_content('[data-r="w-KNO3"]')
    wn = page.text_content('[data-r="w-NaCl"]')
    eq2 = page.evaluate(eq_js)
    eq_on = eq2["on"]
    vis = shown_map(page, cmp_sels)
    R.check("compare.notboth_task", hit_n2 and g["NaCl"]["status"] == "unsat" and abs(g["NaCl"]["T"] - cr["T"]) < 1e-9 and not eq_on and wk != wn
            and g["notBoth"] is True and g["done"] is True and all(vis.values()),
            "NaCl 拖到 (%.2f℃, %.1f g, %s)：质量分数 %s / %s，高亮=%r，notBoth=%r，compare 任务 done=%r；%s" % (
                g["NaCl"]["T"], g["NaCl"]["m"], g["NaCl"]["status"], wk, wn, eq_on, g["notBoth"], g["done"], fmt_shown(vis)), page)
    R.check("compare.highlight_visible", eq1["bg"] != eq2["bg"] and eq1["color"] != eq2["color"],
            "质量分数那一行的单元格：相同时底色 %s、字色 %s；不同时底色 %s、字色 %s（高亮要看得出来）" % (eq1["bg"], eq1["color"], eq2["bg"], eq2["color"]), page)

    # ---------- nacl ----------
    t = tab_to(R, ctx, page, "__solub", "nacl")
    R.check("nacl.tab", t["tab"] == "nacl" and t["shown"] and not t["others"], "切到 nacl：%s" % jd(t), page)
    g = page.evaluate("() => window.__solub.get('nacl')")
    R.check("nacl.start", g["T"] == 60 and g["W"] == 100 and g["status"] == "sat" and g["precipitate"] == 0,
            "起点 T=%s℃、水 %s g、%s g NaCl：status=%r，析出 %s" % (g["T"], g["W"], g["m"], g["status"], g["precipitate"]), page)
    _, hit = drag_to(R, ctx, page, "solub", "nacl", (20, 0), 40, keep_y=True)
    g = page.evaluate("() => window.__solub.get('nacl')")
    d1 = page.text_content('#solub-nacl-read [data-r="ppt"]')
    nacl_sels = ['#solub-nacl-read [data-r="ppt"]', '#solub-nacl-read [data-r="T"]']
    vis = shown_map(page, nacl_sels)
    R.check("nacl.cool_to_20_1.3", hit and g["T"] == 20 and d1 == "1.3 g" and abs(g["precipitate"] - 1.3) < 1e-6 and all(vis.values()),
            "触屏降到 T=%r℃（起点在状态点上=%s）：读数「%s」（应为 1.3 g = 37.3 − 36.0；%s），钩子 %.4f" % (g["T"], hit, d1, fmt_shown(vis), g["precipitate"]), page)
    evb = page.evaluate("() => { var b = document.querySelector('[data-solub-evap]'); return b ? { text: b.textContent.trim(), shown: window.__e2e.isShown(b), disabled: b.disabled } : null; }")
    R.check("nacl.evap_button", bool(evb) and evb["text"] == "恒温蒸发 10 g 水" and evb["shown"] and not evb["disabled"],
            "蒸发按钮 [data-solub-evap]：%s（文字应为「恒温蒸发 10 g 水」，看得见、能点）" % jd(evb), page)
    tap(R, ctx, page, "[data-solub-evap]")
    page.wait_for_timeout(250)
    g = page.evaluate("() => window.__solub.get('nacl')")
    d2 = page.text_content('#solub-nacl-read [data-r="ppt"]')
    v1, v2 = num_of(d1), num_of(d2)
    vis = shown_map(page, nacl_sels)
    R.check("nacl.evap_4.9_plus_3.6", g["W"] == 90 and d2 == "4.9 g" and v1 is not None and v2 is not None and abs((v2 - v1) - 3.6) < 1e-9
            and abs(g["precipitate"] - 1.3 - 3.6) < 1e-6 and all(vis.values()),
            "点一次「恒温蒸发 10 g 水」：水 %s g，读数「%s」，比蒸发前多 %.1f g（应为 3.6 g = 10 g 水在 20℃ 溶的量；%s），钩子 %.4f" % (
                g["W"], d2, (v2 - v1) if (v1 is not None and v2 is not None) else float("nan"), fmt_shown(vis), g["precipitate"]), page)
    # 板上：纵轴 0～80（没有夹紧标注）、状态点按 per100 画在板上、虚线旁写「每 100 g 水多 …」。
    # 注意：SPEC-1B 5.2 节原文写「纵轴 0～50 g」，画不下蒸发以后的状态点（水剩 50 g 时每 100 g 水 74.6 g）；
    # 页面有意改成 0～80（chemistry/js/solubility.js nacl 情境开头的注释），本场景的验收要求就是 0～80、不夹紧，这里按 0～80 断言
    bd = page.evaluate("""() => {
      var b = window.__solub.boards('nacl').board, svg = b.svg, z = b.size(), plot = z.plot, H = window.__e2e;
      var P = window.__solub.handle('nacl'), h = P.get(), s = b.toScreen(h);
      var ys = Array.prototype.filter.call(svg.querySelectorAll('text'), function (t) {
        if (!/^\\d+$/.test((t.textContent || '').trim()) || !H.isShown(t)) return false;
        var bb = t.getBBox(); return bb.x + bb.width <= plot[0] + 2; }).map(function (t) { return +t.textContent.trim(); });
      var arrows = Array.prototype.filter.call(svg.querySelectorAll('text'), function (t) { return H.isShown(t) && /[↑↓]/.test(t.textContent || ''); }).length;
      var tags = Array.prototype.filter.call(svg.querySelectorAll('.sb-tag text'), function (t) { return H.isShown(t) && (t.textContent || '').trim(); });
      var g = window.__solub.get('nacl');
      var top = H.client(b, [g.T, g.per100]), bot = H.client(b, [g.T, g.S]);
      var nr = P.node.getBoundingClientRect();
      return { view: b.view, yticks: ys, arrows: arrows, h: h, inPlot: s[1] >= plot[1] - 0.5 && s[1] <= plot[3] + 0.5 && s[0] >= plot[0] - 0.5 && s[0] <= plot[2] + 0.5,
               nodeCenter: [nr.left + nr.width / 2, nr.top + nr.height / 2], want: top, dashX: top[0], dashY: [top[1], bot[1]],
               tags: tags.map(function (t) { var r = t.getBoundingClientRect(); return { text: t.textContent.trim(), rect: [r.left, r.top, r.right, r.bottom] }; }) };
    }""")
    g = page.evaluate("() => window.__solub.get('nacl')")
    per100 = 37.3 * 100 / 90
    R.check("nacl.board_y_0_80", bd["view"][2] == 0 and bd["view"][3] == 80 and set(range(10, 81, 10)) <= set(bd["yticks"]) and max(bd["yticks"]) == 80 and bd["arrows"] == 0,
            "nacl 板的视野 %s，纵轴刻度数字 %s（应到 80；0 在原点处写作 O），板上带 ↑/↓ 的夹紧标注 %d 个（应为 0）" % (bd["view"], bd["yticks"], bd["arrows"]), page)
    nc, wt = bd["nodeCenter"], bd["want"]
    R.check("nacl.point_on_board", abs(bd["h"][1] - per100) < 1e-6 and abs(g["per100"] - per100) < 1e-6 and bd["inPlot"]
            and abs(nc[0] - wt[0]) < 2.5 and abs(nc[1] - wt[1]) < 2.5,
            "蒸发后状态点 %s（每 100 g 水 %.3f g = 37.3 × 100 ÷ 90），在画区里=%r，画出来的圆心 (%.1f, %.1f) 与按坐标换算的 (%.1f, %.1f) 一致（±2.5 px）" % (
                [round(x, 3) for x in bd["h"]], per100, bd["inPlot"], nc[0], nc[1], wt[0], wt[1]), page)
    lab = [t for t in bd["tags"] if t["text"].startswith("每 100 g 水多")]
    want_lab = "每 100 g 水多 5.4 g"   # 41.44 − 36.0 = 5.44
    near = False
    if lab:
        r = lab[0]["rect"]
        y0, y1 = min(bd["dashY"]), max(bd["dashY"])
        dx = 0 if r[0] <= bd["dashX"] <= r[2] else min(abs(r[0] - bd["dashX"]), abs(r[2] - bd["dashX"]))
        near = dx <= 40 and r[3] >= y0 - 30 and r[1] <= y1 + 30
    R.check("nacl.per100_label", len(lab) == 1 and lab[0]["text"] == want_lab and g["label"] == want_lab and near,
            "虚线旁的标注 %s（应为「%s」），离虚线（x=%.1f，y %.1f～%.1f）近=%r；读数里的实际析出 %s" % (
                [t["text"] for t in bd["tags"]], want_lab, bd["dashX"], min(bd["dashY"]), max(bd["dashY"]), near, d2), page)
    R.shot(page, "nacl_evap")
    R.check("nacl.task_done", g["done"] is True, "降到 ≤ 20℃ 并蒸发过：nacl 任务 done=%r（cooled=%r, everEvaporated=%r）" % (g["done"], g["cooled"], g["everEvaporated"]), page)

    prog = progress(page, "chem_solub_tasks")
    tasks = page.evaluate("() => window.__solub.tasks()")
    R.check("progress.all_true", all_true(prog, "chem_solub_tasks") and tasks == {"cool": True, "compare": True, "nacl": True},
            "getProgress('chem_solub_tasks') = %s，__solub.tasks() = %s" % (jd(prog), jd(tasks)), page)
    widths = []
    for key in ("cool", "compare", "nacl"):
        page.evaluate("(k) => window.__solub.show(k)", key)
        page.wait_for_timeout(150)
        widths.append((key, scroll_w(page)))
    R.check("layout.no_hscroll", all(w <= 390 for _, w in widths), "三个标签页 scrollWidth %s" % widths, page)
    no_errors_check(R, "no_page_errors", page)


def ions_dom(page):
    """取样点处屏幕上的东西：离子条（data-n 和条上看得见的数字）、小烧杯（data-n、说明文字里的数字、画出来的颗粒 / 气泡数）、
    取样卡片、pH 读数，都带上「看得见」。"""
    return page.evaluate("""() => {
      var H = window.__e2e, vis = function (e) { return !!e && getComputedStyle(e).display !== 'none'; };
      var out = { ions: {}, cnt: {}, barHidden: [], solid: null, gas: null };
      Array.prototype.forEach.call(document.querySelectorAll('#solute-bars [data-ion]'), function (e) {
        var k = e.getAttribute('data-ion'), c = e.querySelector('.so-cnt');
        out.ions[k] = +e.getAttribute('data-n');
        out.cnt[k] = c && H.isShown(c) ? c.textContent.trim() : null;
        if (!H.isShown(e)) out.barHidden.push(k);
      });
      var s = document.querySelector('#solute-beaker [data-solid]'), g = document.querySelector('#solute-beaker [data-gas]');
      out.solid = s && !s.hidden ? +s.getAttribute('data-n') : null;
      out.gas = g && !g.hidden ? +g.getAttribute('data-n') : null;
      out.solidTxt = s && H.isShown(s) ? s.textContent.replace(/\\s+/g, '') : null;
      out.gasTxt = g && H.isShown(g) ? g.textContent.replace(/\\s+/g, '') : null;
      var svg = document.querySelector('#solute-beaker svg');
      out.beakerShown = H.isShown(svg);
      out.pptDots = Array.prototype.filter.call(svg.querySelectorAll(':scope > circle'), vis).length;
      out.bubDots = Array.prototype.filter.call(svg.querySelectorAll(':scope > g > circle'), vis).length;
      out.stage = document.getElementById('solute-stage').getAttribute('data-stage');
      out.ph = document.getElementById('solute-ph').textContent;
      out.solutes = document.getElementById('solute-solutes').textContent;
      out.note = document.getElementById('solute-note').textContent;
      out.inCard = !!document.querySelector('#solute-sample #solute-solutes');
      out.shown = H.shownMap(['#solute-sample', '#solute-solutes', '#solute-ph', '#solute-stage', '#solute-bars']);
      var c = window.__solute.get('curve'); out.V = c.V; out.pair = c.pair;
      return out; }""")


def ions_visible_ok(d, ions, solid=None, gas=None):
    """离子条上看得见的数字 = 期望的粒子数；沉淀 / 气体的说明文字和画出来的颗粒数一致；取样卡片、pH 读数看得见。返回问题列表。"""
    bad = []
    want_cnt = dict((k, str(v)) for k, v in ions.items())
    if d["cnt"] != want_cnt:
        bad.append("离子条上看得见的数字 %s（应为 %s）" % (jd(d["cnt"]), jd(want_cnt)))
    if d["barHidden"]:
        bad.append("看不见的离子条 %s" % d["barHidden"])
    if solid is not None:
        want = "沉淀BaSO₄：%d" % solid
        if d["solidTxt"] != want or d["pptDots"] != min(solid, 10):
            bad.append("沉淀说明「%s」（应为「%s」），画出来的沉淀颗粒 %d（应为 %d）" % (d["solidTxt"], want, d["pptDots"], min(solid, 10)))
    if gas is not None:
        want = "放出CO₂：%d" % gas
        if d["gasTxt"] != want or d["bubDots"] != min(gas, 10):
            bad.append("气体说明「%s」（应为「%s」），画出来的气泡 %d（应为 %d）" % (d["gasTxt"], want, d["bubDots"], min(gas, 10)))
    if not d["beakerShown"]:
        bad.append("小烧杯看不见")
    hid = [k for k, v in d["shown"].items() if not v]
    if hid:
        bad.append("看不见：%s" % hid)
    return bad


# 变质探究：按钮、选项上的文字（逐字），结论按文字选
REAGENT_LABEL = {"acid": "足量稀盐酸", "phenol": "酚酞溶液", "cacl2": "过量 CaCl₂ 溶液", "lime": "澄清石灰水"}
JUDGE_OPTS = [["", "请选择"], ["none", "未变质"], ["partial", "部分变质"], ["full", "完全变质"]]
JUDGE_LABEL = dict((v, t) for v, t in JUDGE_OPTS if v)

SPOIL_LABELS_JS = r"""() => { var H = window.__e2e;
  var t = function (s) { var e = document.querySelector(s); return e ? { text: e.textContent.replace(/\s+/g, ' ').trim(), shown: H.isShown(e) } : null; };
  var o = { reagents: {}, samples: {}, opts: {} };
  ['acid', 'phenol', 'cacl2', 'lime'].forEach(function (r) { o.reagents[r] = t('[data-reagent="' + r + '"]'); });
  ['A', 'B', 'C'].forEach(function (x) {
    o.samples[x] = t('button[data-sample="' + x + '"]');
    var s = document.querySelector('[data-judge="' + x + '"]');
    o.opts[x] = s ? { shown: H.isShown(s), list: Array.prototype.map.call(s.options, function (op) { return [op.value, op.textContent.trim()]; }) } : null;
  });
  o.newTube = t('[data-tube-new]'); o.check = t('[data-judge-check]'); o.reshuffle = t('[data-reshuffle]');
  return o; }"""
# 每份样品的核对反馈：[文字, data-ok, 看得见]
SPOIL_FB_JS = r"""() => ['A', 'B', 'C'].map(function (x) { var e = document.querySelector('[data-fb="' + x + '"]');
  return e ? [e.textContent, e.getAttribute('data-ok'), window.__e2e.isShown(e)] : ['', null, false]; })"""
# 当前试管：屏幕上的逐步现象（#so-log）、试管下面的 .tube-obs、data-*、画出来的沉淀颗粒、液体颜色
TUBE_JS = r"""() => { var t = document.querySelector('#so-rack .tube.cur'), log = document.getElementById('so-log'), H = window.__e2e;
  if (!t) return null;
  var ob = t.querySelector('.tube-obs'), liq = t.querySelector('svg .tb-liq');
  return { sample: t.getAttribute('data-sample'), red: t.getAttribute('data-red'), ppt: t.getAttribute('data-precipitate'), steps: t.getAttribute('data-steps'),
           obs: ob ? ob.textContent.trim() : null, obsShown: H.isShown(ob), tubeShown: H.isShown(t),
           log: Array.prototype.map.call(log.querySelectorAll('li'), function (li) { return li.textContent.replace(/\s+/g, ' ').trim(); }),
           logShown: H.isShown(log), pptDots: t.querySelectorAll('svg .tb-ppt').length, liq: liq ? getComputedStyle(liq).fill : null }; }"""


def judge_by_label(page, x, value):
    """按选项的文字（未变质 / 部分变质 / 完全变质）选结论，返回 select 现在的值。"""
    page.select_option('[data-judge="%s"]' % x, label=JUDGE_LABEL[value])
    return page.evaluate("(x) => document.querySelector('[data-judge=\"' + x + '\"]').value", x)


def read_tube_log(tb, first_label):
    """按屏幕上写出来的两步现象推断：第 1 步「加入<first_label>：产生白色沉淀 / 无明显现象」，第 2 步「加入酚酞溶液：溶液变红 / 溶液无色」。
    case：红 + 沉淀 = partial，红、没有沉淀 = none，无色 + 沉淀 = full，其余 ?。"""
    out = {"case": "?", "ppt": None, "red": None, "o2": None}
    if not tb or len(tb["log"]) != 2:
        return out
    l1, l2 = tb["log"]
    p1, p2 = "加入%s：" % first_label, "加入%s：" % REAGENT_LABEL["phenol"]
    if not (l1.startswith(p1) and l2.startswith(p2)):
        return out
    o1, o2 = l1[len(p1):], l2[len(p2):]
    out["ppt"] = {"产生白色沉淀": True, "无明显现象": False}.get(o1)
    out["red"] = {"溶液变红": True, "溶液无色": False}.get(o2)
    out["o2"] = o2
    if out["ppt"] is None or out["red"] is None:
        return out
    out["case"] = {(True, True): "partial", (False, True): "none", (True, False): "full"}.get((out["ppt"], out["red"]), "?")
    return out


def tube_cross_check(x, tb, d):
    """屏幕上的逐步现象和试管的其他表现互相核对，返回问题列表。"""
    bad = []
    if tb["obs"] != d["o2"] or not tb["obsShown"]:
        bad.append("%s：.tube-obs「%s」（看得见=%s），应和最后一步「%s」相同" % (x, tb["obs"], tb["obsShown"], d["o2"]))
    if not (tb["logShown"] and tb["tubeShown"]):
        bad.append("%s：逐步现象看得见=%s，试管看得见=%s" % (x, tb["logShown"], tb["tubeShown"]))
    if tb["red"] != ("true" if d["red"] else "false") or tb["ppt"] != ("true" if d["ppt"] else "false"):
        bad.append("%s：data-red=%s data-precipitate=%s 和写出来的现象（红=%s、沉淀=%s）不一致" % (x, tb["red"], tb["ppt"], d["red"], d["ppt"]))
    if (tb["pptDots"] > 0) != bool(d["ppt"]):
        bad.append("%s：画出来的沉淀颗粒 %d 和写出来的「%s沉淀」不一致" % (x, tb["pptDots"], "有" if d["ppt"] else "没有"))
    return bad


def pinkish(fill):
    """svg 的 fill（rgb(...)）是不是偏红：R 比 G 大 40 以上。"""
    m = re.match(r"rgba?\((\d+),\s*(\d+),\s*(\d+)", fill or "")
    return bool(m) and int(m.group(1)) - int(m.group(2)) >= 40


def cc_drag_v(R, ctx, page, target, steps):
    """沿 pH 曲线拖取样点到 V = target（触屏）。V 按 0.1 mL 取整：手指没正好落在 target 上时，再从取样点现在的位置
    按像素差补拖一次（最多 3 次；补拖也是真的触屏拖动）。返回 (起点在取样点上, 补拖次数)。"""
    _, hit = drag_to(R, ctx, page, "solute", "curve", (target, 0), steps, keep_y=True)
    fixes = 0
    for aim in (target, target - 0.04, target + 0.04):
        V = page.evaluate("() => window.__solute.get('curve').V")
        if abs(V - target) < 1e-9:
            break
        fixes += 1
        drag_to(R, ctx, page, "solute", "curve", (aim, 0), 4, keep_y=True)
    return hit, fixes


def sc_cc_mobile(R):
    """8.C 第 4 条（C-C，390×844 触屏）：①②④ 和③都取样；选③时锁定（手指落在遮罩上、拖不动）→ 选 a 提交 → 解锁 → 触屏拖取样点经过
    V = 10、20、30 mL，粒子数（data-n 和条上看得见的数字）、沉淀（说明文字和画出来的颗粒）、取样卡片和任务书 6.1 一致；
    ④ 在 V = 30 mL 时 pH 显示 11.16。spoil：按钮、选项的文字逐字；先不做试管直接核对 → 不算完成、提示还分不出；
    再每份做「过量 CaCl₂ → 酚酞」，按屏幕上写出来的现象下结论（按选项文字选）→ 全部 ✓、任务完成；
    另外每份做一支「澄清石灰水 → 酚酞」，都写着「溶液变红」。"""
    ctx = R.new_context(mobile=True)
    page = R.new_page(ctx)
    page.goto(R.url("chemistry/solute.html"), wait_until="load")
    try:
        wait_js(page, "() => !!window.__solute", None, 10000)
    except (PWTimeout, PWError) as e:
        R.require("setup.hook", False, "window.__solute 不可用：%s" % short(e, 200), page)
    page.wait_for_timeout(500)
    p0 = progress(page, "chem_solute_tasks")
    t0 = page.evaluate("() => window.__solute.tasks()")
    R.check("progress.baseline_all_false", none_true(p0, "chem_solute_tasks") and t0 == {"curve": False, "spoil": False},
            "刚打开：getProgress('chem_solute_tasks') = %s，__solute.tasks() = %s" % (jd(p0), jd(t0)), page)
    g = page.evaluate("() => window.__solute.get('curve')")
    R.check("curve.default_pair1", g["pair"] == 1 and g["locked"] is False and page.evaluate("() => window.__solute.tab()") == "curve",
            "默认试剂对 %r，locked=%r" % (g["pair"], g["locked"]), page)

    # ---------- ①、② 取样 ----------
    for pid, v in ((1, 25), (2, 15)):
        tap(R, ctx, page, '[data-pair="%d"]' % pid)
        page.wait_for_timeout(250)
        hit, _ = cc_drag_v(R, ctx, page, v, 12)
        g = page.evaluate("() => window.__solute.get('curve')")
        R.check("curve.sample_pair%d" % pid, hit and g["pair"] == pid and g["sampled"].get(str(pid)) is True,
                "试剂对 %d：触屏拖到 V=%s（起点在取样点上=%s），pH %s，溶质 %s，sampled=%s" % (pid, g["V"], hit, g["phText"], g["solutes"], jd(g["sampled"])), page)

    # ---------- ③：锁定 → 提交 → 解锁 ----------
    tap(R, ctx, page, '[data-pair="3"]')
    page.evaluate("async () => { await window.__solute.gate(); return 1; }")
    wait_card(R, page, "#qz-curve-ans", QID_CC)
    st = page.evaluate("(h) => window.__e2e.extStage(h)", "#qz-curve-ans")
    g = page.evaluate("() => window.__solute.get('curve')")
    lk = page.evaluate("() => window.__e2e.lock('#solute-curve-boards')")
    en = page.evaluate("() => window.__solute.handle('curve').enabled()")
    R.check("curve.p3_locked", g["pair"] == 3 and st == "predict" and g["locked"] is True and lk["attr"] == "true" and lk["shown"]
            and "先预测，再动手" in lk["text"] and en is False,
            "选③：data-stage=%r，locked=%r，#solute-curve-boards data-qz-locked=%r，遮罩可见=%r，取样点 enabled()=%r" % (st, g["locked"], lk["attr"], lk["shown"], en), page)
    R.shot(page, "p3_locked")
    lh = locked_drag_to(R, ctx, page, "solute", "curve", "#solute-curve-boards", (15, 0), 8, keep_y=True)
    g = page.evaluate("() => window.__solute.get('curve')")
    R.check("curve.p3_locked_no_drag", lh["isLock"] and not lh["onHandle"] and g["V"] == 0,
            "预测前触屏从取样点所在的 (0, pH) 往右拖：手指落点 %s（应是 #solute-curve-boards 里的遮罩 .qz-lock：%s；落在取样点上=%s），V=%r（应不动）" % (
                lh["el"], lh["isLock"], lh["onHandle"], g["V"]), page)
    predict_ext(R, ctx, page, "#qz-curve-ans", "a", "sure", "curve.")
    g = page.evaluate("() => window.__solute.get('curve')")
    lk = page.evaluate("() => window.__e2e.lock('#solute-curve-boards')")
    en = page.evaluate("() => window.__solute.handle('curve').enabled()")
    R.check("curve.p3_unlocked", g["locked"] is False and lk["attr"] != "true" and not lk["shown"] and en is True,
            "提交后 locked=%r，data-qz-locked=%r，遮罩可见=%r，取样点 enabled()=%r" % (g["locked"], lk["attr"], lk["shown"], en), page)

    # ---------- ③ 拖过 V = 10、20、30 ----------
    for V in (10, 20, 30):
        hit, fixes = cc_drag_v(R, ctx, page, V, 12)
        d = ions_dom(page)
        ions, solid, sol, stage = PAIR3_COUNTS[V]
        got = dict((k, d["ions"].get(k)) for k in ions)
        vbad = ions_visible_ok(d, ions, solid=solid)
        R.check("curve.p3_V%d" % V, hit and abs(d["V"] - V) < 1e-9 and d["ions"] == ions and d["solid"] == solid and d["solutes"] == sol
                and d["inCard"] and d["stage"] == stage and not vbad,
                "③ 触屏拖到 V=%s mL（起点在取样点上=%s，补拖 %d 次）：离子条 data-n %s（应为 %s），条上看得见的数字 %s，沉淀 BaSO₄ %s（应为 %d；说明「%s」，画出 %d 颗），"
                "取样卡片溶质「%s」（应为「%s」），阶段 %r，pH %s%s" % (d["V"], hit, fixes, jd(got), jd(ions), jd(d["cnt"]), d["solid"], solid, d["solidTxt"], d["pptDots"],
                                                           d["solutes"], sol, d["stage"], d["ph"], ("；问题：" + "；".join(vbad)) if vbad else "；都看得见"), page)
        if V == 20:
            R.shot(page, "p3_V20")
    hit, _ = cc_drag_v(R, ctx, page, 40, 10)
    g = page.evaluate("() => window.__solute.get('curve')")
    R.check("curve.p3_gate_range", g["gateDone"] is True and g["minV"] <= 5 and g["maxV"] >= 35,
            "③ 解锁后 V 到过 %s～%s mL（≤ 5 且 ≥ 35）：gateDone=%r" % (g["minV"], g["maxV"], g["gateDone"]), page)
    rec = finish_ext(R, ctx, page, "#qz-curve-ans", EXPLAIN_CC, ("guest",), "curve.")
    R.check("curve.gate_finished", rec.get("state") == "guest", "游客做完预测关卡：记录行 data-state=%r" % rec.get("state"), page)

    # ---------- ④ V = 30 ----------
    tap(R, ctx, page, '[data-pair="4"]')
    page.wait_for_timeout(300)
    lk = page.evaluate("() => window.__e2e.lock('#solute-curve-boards')")
    hit, fixes = cc_drag_v(R, ctx, page, 30, 14)
    d = ions_dom(page)
    ions4, gas4, sol4, ph4 = PAIR4_V30
    vbad = ions_visible_ok(d, ions4, gas=gas4)
    R.check("curve.p4_V30_pH", hit and abs(d["V"] - 30) < 1e-9 and d["ph"].strip() == ph4 and d["solutes"] == sol4 and d["ions"] == ions4 and d["gas"] == gas4
            and lk["attr"] != "true" and not lk["shown"] and not vbad,
            "④ 触屏拖到 V=%s mL（补拖 %d 次）：#solute-pH「%s」（应为 %s），溶质「%s」，离子 %s（条上看得见 %s），CO₂ %s（说明「%s」，画出 %d 个气泡）；切到④时遮罩 %r/%r%s" % (
                d["V"], fixes, d["ph"], ph4, d["solutes"], jd(d["ions"]), jd(d["cnt"]), d["gas"], d["gasTxt"], d["bubDots"], lk["attr"], lk["shown"],
                ("；问题：" + "；".join(vbad)) if vbad else "；都看得见"), page)
    R.shot(page, "p4_V30")
    g = page.evaluate("() => window.__solute.get('curve')")
    R.check("curve.task_done", g["sampled"] == {"1": True, "2": True, "3": True, "4": True} and g["done"] is True,
            "四对试剂都取样过：sampled=%s，curve 任务 done=%r" % (jd(g["sampled"]), g["done"]), page)

    # ---------- spoil ----------
    t = tab_to(R, ctx, page, "__solute", "spoil")
    R.check("spoil.tab", t["tab"] == "spoil" and t["shown"] and not t["others"], "切到 spoil：%s" % jd(t), page)
    lab = page.evaluate(SPOIL_LABELS_JS)
    lab_bad = []
    for r, want in REAGENT_LABEL.items():
        got = lab["reagents"].get(r) or {}
        if got.get("text") != want or not got.get("shown"):
            lab_bad.append("试剂按钮 %s：%s（应为「%s」、看得见）" % (r, jd(got), want))
    for x in "ABC":
        got = lab["samples"].get(x) or {}
        if got.get("text") != "样品 " + x or not got.get("shown"):
            lab_bad.append("样品按钮 %s：%s" % (x, jd(got)))
        op = lab["opts"].get(x) or {}
        if op.get("list") != JUDGE_OPTS or not op.get("shown"):
            lab_bad.append("结论选择 %s 的选项 %s（应为 %s）" % (x, jd(op), jd(JUDGE_OPTS)))
    for k, want in (("newTube", "取样到新试管"), ("check", "核对"), ("reshuffle", "换一组样品")):
        got = lab.get(k) or {}
        if got.get("text") != want or not got.get("shown"):
            lab_bad.append("%s：%s（应为「%s」）" % (k, jd(got), want))
    R.check("spoil.labels", not lab_bad,
            "按钮和选项的文字：试剂 %s，结论选项 %s%s" % (
                "/".join((lab["reagents"].get(r) or {}).get("text") or "?" for r in REAGENT_LABEL), "/".join(v for _, v in (lab["opts"].get("A") or {}).get("list", [])),
                ("；问题：" + "；".join(lab_bad)) if lab_bad else "，都看得见"), page)

    # 一支试管都没做就下结论（按选项的文字选）→ 证据不够，不算完成
    picked = {}
    for x, v in zip("ABC", ("none", "partial", "full")):
        picked[x] = judge_by_label(page, x, v)
    tap(R, ctx, page, "[data-judge-check]")
    page.wait_for_timeout(200)
    sp = page.evaluate("() => window.__solute.get('spoil')")
    fb = page.evaluate(SPOIL_FB_JS)
    R.check("spoil.guess_without_tubes", picked == {"A": "none", "B": "partial", "C": "full"} and sp["made"] == 0 and sp["done"] is False and sp["correct"] is False
            and all(sp["verdict"][x]["status"] == "ambiguous" for x in "ABC") and all(f[1] == "wait" and "分不出" in f[0] and f[2] for f in fb)
            and page.evaluate("() => window.__solute.tasks().spoil") is False and not page.text_content("#so-all").strip(),
            "一支试管都没做就按文字选 A「未变质」/ B「部分变质」/ C「完全变质」（select 的值 %s）并核对：verdict 状态 %s，看得见的反馈 %s，done=%r（不能算完成）" % (
                jd(picked), [sp["verdict"][x]["status"] for x in "ABC"], [(f[0], f[2]) for f in fb[:1]], sp["done"]), page)

    # 每份样品一支「过量 CaCl₂ → 酚酞」：按屏幕上写出来的逐步现象下结论
    deduced, obs, cross = {}, {}, []
    for x in "ABC":
        tap(R, ctx, page, 'button[data-sample="%s"]' % x)
        tap(R, ctx, page, "[data-tube-new]")
        tap(R, ctx, page, '[data-reagent="cacl2"]')
        tap(R, ctx, page, '[data-reagent="phenol"]')
        tb = page.evaluate(TUBE_JS)
        obs[x] = tb
        d = read_tube_log(tb, REAGENT_LABEL["cacl2"])
        deduced[x] = d["case"] if (tb and tb["sample"] == x and tb["steps"] == "cacl2,phenol") else "?"
        if d["case"] != "?":
            cross += tube_cross_check(x, tb, d)
    reds = [obs[x]["liq"] for x in "ABC" if deduced[x] in ("none", "partial")]
    clear = [obs[x]["liq"] for x in "ABC" if deduced[x] == "full"]
    if not (len(set(reds)) == 1 and clear and reds[0] not in clear and pinkish(reds[0]) and not pinkish(clear[0])):
        cross.append("液体颜色：变红的 %s，无色的 %s（变红的应偏红、和无色的不同）" % (reds, clear))
    R.check("spoil.tubes_observed", all(v != "?" for v in deduced.values()) and sorted(deduced.values()) == ["full", "none", "partial"],
            "三份样品各做「过量 CaCl₂ → 酚酞」，屏幕上的逐步现象 %s → 推断 %s" % (
                jd({x: (o["log"] if o else None) for x, o in obs.items()}), jd(deduced)), page)
    R.check("spoil.tubes_consistent", not cross and all(v != "?" for v in deduced.values()),
            "逐步现象和试管上的 .tube-obs（看得见）%s、data-red / data-precipitate、画出来的沉淀颗粒 %s、液体颜色 %s 一致%s" % (
                jd({x: o["obs"] if o else None for x, o in obs.items()}), jd({x: o["pptDots"] if o else None for x, o in obs.items()}),
                jd({x: o["liq"] if o else None for x, o in obs.items()}), ("；问题：" + "；".join(cross)) if cross else ""), page)
    picked = {}
    for x in "ABC":
        if deduced[x] in ("none", "partial", "full"):
            picked[x] = judge_by_label(page, x, deduced[x])
    tap(R, ctx, page, "[data-judge-check]")
    page.wait_for_timeout(200)
    sp = page.evaluate("() => window.__solute.get('spoil')")
    fb = page.evaluate(SPOIL_FB_JS)
    allmsg = page.text_content("#so-all")
    all_shown = page.evaluate("() => window.__e2e.isShown(document.getElementById('so-all'))")
    R.check("spoil.all_correct_done", picked == deduced and all(f[1] == "true" and f[0].startswith("✓") and f[2] for f in fb) and sp["correct"] is True and sp["done"] is True
            and page.evaluate("() => window.__solute.tasks().spoil") is True and "都判断对了" in allmsg and all_shown,
            "按现象选结论（按文字选，select 的值 %s）后核对：看得见的反馈 %s，「%s」（看得见=%s），correct=%r，spoil 任务 done=%r" % (
                jd(picked), [f[0] for f in fb if f[2]], allmsg, all_shown, sp["correct"], sp["done"]), page)
    R.check("spoil.deduced_matches_assign", deduced == sp["assign"], "按现象推断的 %s 与页面的分配 %s 一致（判对以后才读分配）" % (jd(deduced), jd(sp["assign"])), page)
    R.shot(page, "spoil_judged")

    # 每份样品一支「澄清石灰水 → 酚酞」：都变红（Na₂CO₃ 和石灰水生成 NaOH，剩下的石灰水也显碱性）
    lime = {}
    lime_bad = []
    for x in "ABC":
        tap(R, ctx, page, 'button[data-sample="%s"]' % x)
        tap(R, ctx, page, "[data-tube-new]")
        tap(R, ctx, page, '[data-reagent="lime"]')
        tap(R, ctx, page, '[data-reagent="phenol"]')
        tb = page.evaluate(TUBE_JS)
        hk = [q for q in page.evaluate("() => window.__solute.get('spoil').tubes") if q["cur"]]
        d = read_tube_log(tb, REAGENT_LABEL["lime"])
        lime[x] = (tb["log"] if tb else None, tb["obs"] if tb else None)
        want_ppt = deduced[x] in ("partial", "full")   # 按上面看到的现象：有 Na₂CO₃ 的样品，石灰水也生成白色沉淀
        if not tb or tb["sample"] != x or tb["steps"] != "lime,phenol":
            lime_bad.append("%s：试管 %s" % (x, jd(tb)))
            continue
        if not (d["red"] is True and d["ppt"] is want_ppt and tb["obs"] == "溶液变红" and tb["obsShown"] and tb["logShown"] and tb["tubeShown"]
                and tb["red"] == "true" and (hk and hk[0]["red"] is True) and pinkish(tb["liq"])):
            lime_bad.append("%s：逐步现象 %s（第 1 步应%s白色沉淀），.tube-obs「%s」（看得见=%s；应为「溶液变红」），data-red=%s，钩子 red=%s，液体 %s" % (
                x, tb["log"], "有" if want_ppt else "没有", tb["obs"], tb["obsShown"], tb["red"], hk[0]["red"] if hk else None, tb["liq"]))
    R.check("spoil.lime_phenol_all_red", not lime_bad,
            "每份样品一支「澄清石灰水 → 酚酞」：%s（都应变红：Na₂CO₃ 和石灰水生成 NaOH）%s" % (jd(lime), ("；问题：" + "；".join(lime_bad)) if lime_bad else ""), page)
    hs = page.evaluate("() => { var d = document.querySelector('details.hs-box'); return d ? { open: d.open, text: d.textContent.replace(/\\s+/g, ' ').trim() } : null; }")
    R.check("spoil.hs_box_closed", bool(hs) and hs["open"] is False and "高中" in hs["text"], "高中小框 details.hs-box：%s" % jd(hs), page)

    prog = progress(page, "chem_solute_tasks")
    tasks = page.evaluate("() => window.__solute.tasks()")
    R.check("progress.all_true", all_true(prog, "chem_solute_tasks") and tasks == {"curve": True, "spoil": True},
            "getProgress('chem_solute_tasks') = %s，__solute.tasks() = %s" % (jd(prog), jd(tasks)), page)
    widths = []
    for key in ("curve", "spoil"):
        page.evaluate("(k) => window.__solute.show(k)", key)
        page.wait_for_timeout(150)
        widths.append((key, scroll_w(page)))
    R.check("layout.no_hscroll", all(w <= 390 for _, w in widths), "两个标签页 scrollWidth %s" % widths, page)
    no_errors_check(R, "no_page_errors", page)


def sc_closed_loop(R):
    """8.C 闭环：新账号在 C-B 预测关卡选 b +「有把握」，拖到完成（≤ 22℃、≥ 58℃）→ 看对比 → 解释 → 记录存好 →
    api/mistakes 里有 mc-coolalwayscrystal、化学导图的错题本抽屉里看得到这一条 → 时钟拨到第二天 →
    review.html 出的是 c-cb-tt-nocrystal 或 c-cb-tt-fridge，答对后排到 D+4。"""
    D1, D4 = R.day(1), R.day(4)
    bank = load_json("shared/quiz/items/chemistry-cb.json")["items"]
    by_id = {it["id"]: it for it in bank}
    tag_name = load_json("shared/quiz/misconceptions.json")["tags"][TAG_CB]["name"]
    ctx = R.new_context(mobile=False)
    page = R.new_page(ctx)
    R.set_day(ctx, 0)
    page.goto(R.url("chemistry/solubility.html"), wait_until="load")
    name = R.new_user("b")
    R.register(page, name)
    R.info("账号 = %s，D = %s" % (name, iso(R.day(0))))
    try:
        wait_js(page, "() => !!window.__solub", None, 10000)
        page.evaluate("async () => { await window.__solub.gate(); return 1; }")
    except (PWTimeout, PWError) as e:
        R.require("setup.hook", False, "window.__solub 不可用：%s" % short(e, 200), page)
    wait_card(R, page, "#qz-cool-ans", QID_CB)
    st = page.evaluate("(h) => window.__e2e.extStage(h)", "#qz-cool-ans")
    R.require("gate.stage_predict", st == "predict", "新账号 data-stage=%r" % st, page)
    predict_ext(R, ctx, page, "#qz-cool-ans", "b", "sure", "gate.")
    _, hit = drag_to(R, ctx, page, "solub", "cool", (20, 0), 40, keep_y=True)
    g = page.evaluate("() => window.__solub.get('cool')")
    R.check("gate.operated", hit and g["T"] == 20 and g["minT"] <= 22 and g["maxT"] >= 58 and g["gateDone"] is True,
            "鼠标拖状态点 60 → %s℃（起点在状态点上=%s）：到过 %s～%s℃，gateDone=%r" % (g["T"], hit, g["minT"], g["maxT"], g["gateDone"]), page)
    rec = finish_ext(R, ctx, page, "#qz-cool-ans", EXPLAIN_CB, ("saved",), "gate.")
    R.require("gate.record_saved", rec.get("state") == "saved", "记录行 data-state=%r：%s" % (rec.get("state"), short(rec.get("text"), 120)), page)
    t = rec.get("text", "")
    R.check("gate.record_text", "已存入错题本" in t and tag_name in t and fmt_md(D1) in t,
            "记录行应含「已存入错题本」「%s」「%s」：%r" % (tag_name, fmt_md(D1), short(t, 160)), page)
    ms = R.mistakes(page)
    mk = ms.get("mc-" + TAG_CB)
    R.require("mistake.exists", mk is not None, "GET api/mistakes 里有 mc-%s；现有 id：%s" % (TAG_CB, list(ms.keys())), page)
    rv = mk.get("review") or {}
    R.check("mistake.fields", mk.get("origin") == "quiz" and TAG_CB in (mk.get("mc") or []) and QID_CB in (mk.get("qids") or [])
            and rv.get("step") == 0 and rv.get("due") == iso(D1) and mk.get("status") == 0 and mk.get("subject") == "chemistry",
            "origin=%r subject=%r mc=%r qids=%r step=%r due=%r（应为 %s）status=%r" % (
                mk.get("origin"), mk.get("subject"), mk.get("mc"), mk.get("qids"), rv.get("step"), rv.get("due"), iso(D1), mk.get("status")), page)
    R.shot(page, "gate_saved")
    # 错题本页面上也看得到这一条：化学导图的错题本抽屉（shared/mistakes.js，按学科过滤）
    page.goto(R.url("chemistry/knowledge-map.html"), wait_until="load")
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
    R.check("mistake.in_drawer", drawer_ok and tag_name in seen_txt,
            "化学导图的错题本抽屉里看得到这一条（.mk-drawer .mk-item 可见，含「%s」）：「%s」" % (tag_name, short(seen_txt, 120)), page)
    R.shot(page, "mistake_drawer")

    # ---- D+1：重测 ----
    R.set_day(ctx, 1)
    page.goto(R.url("review.html"), wait_until="load")
    st = wait_review_state(R, page, ("list", "empty", "guest", "run", "summary"))
    R.require("D1.review.list", st == "list", ".qz-review data-state=%r（应为 list）" % st, page)
    keys = page.evaluate("() => Array.prototype.map.call(document.querySelectorAll('.qz-review .qz-due-item'), function (e) { return e.getAttribute('data-key'); })")
    R.check("D1.review.due_item", keys == [TAG_CB], "到期项 %s（应只有 %s）" % (keys, TAG_CB), page)
    tap(R, ctx, page, "[data-qz-start]")
    R.require("D1.review.run", wait_review_state(R, page, ("run",)) == "run", "点「开始重测」后进入 run", page)
    try:
        page.wait_for_selector(".qz-review .qz-card[data-qid]", timeout=15000)
    except PWTimeout:
        R.require("D1.review.card", False, "重测里没有出现题目卡片", page)
    qid = page.evaluate("() => { var c = document.querySelectorAll('.qz-review .qz-card[data-qid]'); return c.length ? c[c.length - 1].getAttribute('data-qid') : null; }")
    ctx_served = (by_id.get(qid) or {}).get("context")
    R.check("D1.review.served", qid in RETEST_CB and ctx_served != by_id[QID_CB]["context"],
            "重测出的题 %r（情境「%s」），应为 %s 之一（预测关卡的情境是「%s」）" % (qid, ctx_served, list(RETEST_CB), by_id[QID_CB]["context"]), page)
    R.shot(page, "D1_review")
    if qid in by_id:
        it = by_id[qid]
        rec = answer_card(R, ctx, page, qid, it["answer"]["correct"], (it.get("reason") or {}).get("correct"), "sure", want=("saved",))
        R.check("D1.retest.saved", rec.get("state") == "saved", "答对后记录行 %r：%s" % (rec.get("state"), short(rec.get("text"), 100)), page)
        mk = R.mistakes(page).get("mc-" + TAG_CB) or {}
        rv = mk.get("review") or {}
        R.check("D1.mistake.next", rv.get("step") == 1 and rv.get("due") == iso(D4) and mk.get("status") == 1,
                "重测答对后 step=%r due=%r（应为 %s）status=%r" % (rv.get("step"), rv.get("due"), iso(D4), mk.get("status")), page)
    no_errors_check(R, "no_page_errors", page)


def py_classify(item, ch, rs, cf):
    """core.classify 的 Python 版（SPEC-1A 3.4 节的判定规则），和页面上的结果互相核对。"""
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
    """小结的期望值：以写死的手算结果 hand 为准，再用页面里 shared/quiz/core.js 的 classify 和 Python 版逐题各算一遍，三者都要一致。"""
    items = [it for it in load_json("shared/quiz/items/chemistry-cc.json")["items"] if it.get("retest") is True]
    resp = [{"ch": pattern[it["id"]][0], "rs": pattern[it["id"]][1] if it.get("reason") else "", "cf": pattern[it["id"]][2]} for it in items]
    js = page.evaluate("""async (resp) => {
      var b = await window.ABSLabQuiz.load();
      var items = b.items.filter(function (it) { return it.module === 'cc' && it.retest === true; });
      return items.map(function (it, k) { var r = window.ABSLabQuizCore.classify(it, resp[k]); return { id: it.id, cls: r.cls, ans: !!r.ans, tags: r.tags }; });
    }""", resp)
    py = [dict(id=it["id"], **py_classify(it, r["ch"], r["rs"], r["cf"])) for it, r in zip(items, resp)]
    R.check(name + ".expected.js_equals_python", js == py, "页面 classify 与 Python 版逐题一致：%s" % ("是" if js == py else "否；页面 %s / Python %s" % (jd(js)[:200], jd(py)[:200])))
    want = [{"id": it["id"], "cls": hand["cls"][it["id"]][0], "tags": hand["cls"][it["id"]][1]} for it in items]
    got = [{"id": e["id"], "cls": e["cls"], "tags": e["tags"]} for e in js]
    R.check(name + ".expected.classify_equals_hand", got == want and len(items) == 9,
            "页面 classify 与写死的手算判定逐题一致（%d 题）：%s" % (len(items), "是；" + "，".join("%s %s%s" % (w["id"].replace("c-cc-", ""), w["cls"], ("[" + ",".join(w["tags"]) + "]") if w["tags"] else "") for w in want)
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


def sc_check(R):
    """8.C 理解小测（游客，390×844）：check.html?m=cc&t=pre 用固定的混合作答（按 id 点）做完 9 题，小结和写死的手算结果一致；
    CSV：BOM、列名逐字、9 行逐格和点的一致；全程没有写请求，没有请求 api/quiz、api/mistakes。"""
    ctx = R.new_context(mobile=True, extra={"accept_downloads": True})
    reqs = []
    ctx.on("request", lambda r: reqs.append((r.method, r.url)))
    page = R.new_page(ctx)
    page.goto(R.url("check.html?m=cc&t=pre"), wait_until="load")
    page.wait_for_selector("[data-ck-start]", timeout=15000)
    body = page.evaluate("() => document.body.innerText")
    R.check("intro.text", "姓名" not in body and "不计分" in body and "这台设备" in body and "反应后溶质成分" in body,
            "页面顶部说明（不计分、只存这台设备、模块名「反应后溶质成分」），没有「姓名」：%s" % ("姓名" not in body), page)
    page.fill("#ck-code", CHECK_CODE)
    tap(R, ctx, page, "[data-ck-start]")
    exp = expected_run(R, page, CHECK_CC, CHECK_CC_HAND, "pre")
    keys, order, early = [], [], []
    for k in range(9):
        try:
            page.wait_for_selector('[data-ck-num="%d"]' % (k + 1), timeout=10000)
        except PWTimeout:
            R.require("pre.q%d" % (k + 1), False, "等不到第 %d 题" % (k + 1), page)
        qid = page.evaluate("() => document.querySelector('.ck-card').getAttribute('data-qid')")
        order.append(qid)
        if qid not in CHECK_CC:
            R.require("pre.q%d.known" % (k + 1), False, "第 %d 题 %r 不在作答表里" % (k + 1, qid), page)
        ch, rs, cf = CHECK_CC[qid]
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
        R.require("pre.summary", False, "交卷后没有出现小结 #ck-summary", page)
    page.wait_for_timeout(300)
    R.check("pre.bank_order", order == [x["id"] for x in exp["rows"]], "出题顺序 %s（应与题库顺序一致）" % order, page)
    R.check("pre.no_feedback_while_answering", not early, "作答时没有显示对错：%s" % (early or "无"), page)
    today = page.evaluate("() => window.ABSLabQuizCore.today()")

    # ---- 小结 ----
    sm = page.evaluate("""() => {
      var g = function (s) { var e = document.querySelector('#ck-summary ' + s); return e ? { n: e.getAttribute('data-n'), total: e.getAttribute('data-total'), text: e.innerText } : null; };
      return { acc: g('[data-ck-acc]'), sw: g('[data-ck-surewrong]'),
               mc: Array.prototype.map.call(document.querySelectorAll('#ck-summary li[data-ck-mc]'), function (e) { return [e.getAttribute('data-ck-mc'), +e.getAttribute('data-n'), e.innerText.replace(/\\s+/g, ' '), window.__e2e.isShown(e)]; }) };
    }""")
    acc, sw = sm["acc"] or {}, sm["sw"] or {}
    R.check("pre.summary.acc", acc.get("n") == str(exp["pass"]) and acc.get("total") == "9" and ("%d / 9" % exp["pass"]) in (acc.get("text") or ""),
            "正确率：屏幕「%s」data-n=%r；手算 pass %d / 9" % (short(acc.get("text"), 30), acc.get("n"), exp["pass"]), page)
    R.check("pre.summary.surewrong", sw.get("n") == str(exp["sureWrong"]) and sw.get("total") == "9" and ("%d / 9" % exp["sureWrong"]) in (sw.get("text") or ""),
            "有把握却答错：屏幕「%s」data-n=%r；手算 %d / 9" % (short(sw.get("text"), 30), sw.get("n"), exp["sureWrong"]), page)
    shown = {k: n for k, n, _, _ in sm["mc"]}
    bad = [(k, shown.get(k), exp["tags"].get(k, 0)) for k in set(shown) | set(exp["tags"]) if shown.get(k, -1) != exp["tags"].get(k, 0)]
    R.check("pre.summary.mc_counts", sm["mc"] and not bad,
            "错误概念计数：屏幕 %s；手算 %s%s" % (shown, exp["tags"], ("；不一致 %s" % bad) if bad else ""), page)
    # 屏幕上读到的那一行文字：错误概念的名称（misconceptions.json）和「n 次」
    tag_names = load_json("shared/quiz/misconceptions.json")["tags"]
    txt_by = {k: t for k, _, t, _ in sm["mc"]}
    vis_by = {k: v for k, _, _, v in sm["mc"]}
    txt_bad = []
    for k, n in exp["tags"].items():
        nm = (tag_names.get(k) or {}).get("name") or k
        t = txt_by.get(k) or ""
        if nm not in t or ("%d 次" % n) not in t or not vis_by.get(k):
            txt_bad.append("%s：「%s」（看得见=%s；应含「%s」「%d 次」）" % (k, t, vis_by.get(k), nm, n))
    R.check("pre.summary.mc_text", sm["mc"] and not txt_bad,
            "错误概念那几行屏幕上的文字（innerText 含名称和次数）：%s%s" % (
                "；".join("「%s」" % short(txt_by.get(k, ""), 40) for k in exp["tags"]), ("；不一致 %s" % txt_bad) if txt_bad else ""), page)
    R.shot(page, "pre_summary", full=True)

    # ---- CSV ----
    with page.expect_download(timeout=15000) as di:
        tap(R, ctx, page, "[data-ck-csv]")
    dl = di.value
    path = os.path.join(OUT, "e2e1b_check_pre.csv")
    dl.save_as(path)
    with open(path, "rb") as f:
        raw = f.read()
    want_name = "小测_cc_pre_%s.csv" % today
    R.check("pre.csv.filename", dl.suggested_filename == want_name, "文件名 %r（应为 %r）" % (dl.suggested_filename, want_name), page)
    bom = raw.startswith(b"\xef\xbb\xbf")
    txt = raw[3:].decode("utf-8") if bom else raw.decode("utf-8", "replace")
    hook = page.evaluate("() => window.__check.csvText()")
    R.check("pre.csv.bom", bom and txt == hook, "以 UTF-8 BOM 开头=%s，去掉 BOM 后与 __check.csvText() 相同=%s" % (bom, txt == hook), page)
    lines = txt.split("\r\n")
    R.check("pre.csv.header", lines[0] == ",".join(CSV_HEAD), "表头 %r（11 列，逐字）" % lines[0], page)
    data = [l for l in lines[1:] if l]
    R.check("pre.csv.rows", len(data) == 9 and txt.endswith("\r\n") and "\n" not in txt.replace("\r\n", ""),
            "数据行 %d（应为 9），每行 CRLF 结尾" % len(data), page)
    rows = [r for r in list(csv.reader(io.StringIO(txt)))[1:] if r]
    bad = []
    for k, r in enumerate(rows[:9]):
        e = exp["rows"][k]
        ak, rk = keys[k] if k < len(keys) else ("?", "?")
        want = ["cc", "前测", today, e["id"], "%s（显示为 %s）" % (e["ch"], ak),
                ("%s（显示为 %s）" % (e["rs"], rk)) if e["has_rs"] else "", "有把握" if e["cf"] == "sure" else "没把握", e["cls"], ";".join(e["tags"])]
        if len(r) != 11 or r[:9] != want or not r[9].isdigit() or r[10] != CHECK_CODE:
            bad.append((k + 1, r, want))
    R.check("pre.csv.cells", len(rows) == 9 and not bad,
            "9 行逐格：模块 cc、前测、日期、题目 id、答案「id（显示为 字母）」、理由、把握、判定、标签与点的一致，用时是整数、编号 %s%s" % (
                CHECK_CODE, ("；不一致：%s" % jd(bad[:2])) if bad else "；例如第 2 行 %s" % (rows[1] if len(rows) > 1 else None)), page)

    st = page.evaluate("() => { try { return JSON.parse(localStorage.getItem('abslab.check.v1')); } catch (e) { return null; } }")
    runs = ((st or {}).get("runs") or {}).get("cc") or {}
    R.check("local.run_saved", sorted(runs) == ["pre"], "localStorage abslab.check.v1 里 cc 的记录 %s" % sorted(runs), page)
    sw_ = scroll_w(page)
    R.check("layout.no_hscroll", sw_ <= 390, "小结页 scrollWidth=%s" % sw_, page)
    page.wait_for_timeout(800)  # 等可能迟到的请求
    writes = [r for r in reqs if r[0] not in ("GET", "HEAD")]
    apis = [r for r in reqs if "/api/quiz" in r[1] or "/api/mistakes" in r[1]]
    ext = [r for r in reqs if (urlparse(r[1]).hostname or "") not in ("localhost", "127.0.0.1", "::1") and r[1].startswith("http")]
    R.check("requests.read_only", not writes and not apis and not ext,
            "全程 %d 个请求：写请求（POST/PUT/PATCH/DELETE）%s；api/quiz、api/mistakes %s；外部 %s" % (
                len(reqs), writes[:3] or "无", apis[:3] or "无", ext[:3] or "无"))
    no_errors_check(R, "no_page_errors", page)


def close_guide(page):
    # 物理、化学导图第一次打开会弹出使用指南（模态 dialog），挡住点击：关掉
    page.evaluate("() => Array.prototype.forEach.call(document.querySelectorAll('dialog[open]'), function (d) { try { d.close(); } catch (e) {} })")


def kp_sel(subj, key):
    return 'li.ok[data-key="%s"]' % key if subj == "math" else "#" + key


def kp_row_chips(page, subj, key):
    return page.evaluate("""([subj, key]) => {
      var el = subj === 'math' ? document.querySelector('li.ok[data-key="' + key + '"]') : document.getElementById(key);
      if (!el) return null;
      var row = el.querySelector('.lk-row[data-lk-for="' + key + '"]');
      if (!row) return [];
      return Array.prototype.map.call(row.querySelectorAll('.lk-chip'), function (c) {
        return { kind: c.getAttribute('data-kind'), to: c.getAttribute('data-lk-to'), quiz: c.getAttribute('data-lk-quiz'),
                 href: c.getAttribute('href'), abs: c.href, shown: window.__e2e.isShown(c) }; });
    }""", [subj, key])


def open_details(page, sel):
    """知识点所在的章节默认可能是收起的（<details>）：像学生一样先把它展开。返回展开了几层。"""
    return page.evaluate("""(s) => { var c = document.querySelector(s), n = 0; if (!c) return -1;
      for (var p = c.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS' && !p.open) { p.open = true; n++; } return n; }""", sel)


def visible_check(page, sel):
    loc = page.locator(sel).first
    try:
        loc.scroll_into_view_if_needed(timeout=5000)
        expect(loc).to_be_visible(timeout=5000)
        return ""
    except (AssertionError, PWError, PWTimeout) as e:
        return short(e, 80)


def goto_map(R, page, subj, sel):
    """打开导图，等 linker 把标签插进知识点那一行（sel 出现，最多 15 秒），关掉使用指南。"""
    page.goto(R.url("%s/knowledge-map.html" % subj), wait_until="load")
    try:
        page.wait_for_selector(sel, state="attached", timeout=15000)
    except PWTimeout:
        R.info("导图 %s 上 15 秒内没有出现 %s" % (subj, sel))
    page.wait_for_timeout(300)
    close_guide(page)


def follow_chip(R, ctx, page, subj, key, to):
    """在导图上点知识点那一行里指向 to 的「动手」标签（1280 宽、鼠标点，直接跳转）。"""
    sel = kp_sel(subj, key) + ' .lk-row[data-lk-for="%s"] a.lk-chip[data-kind="lab"][data-lk-to="%s"]' % (key, to)
    close_guide(page)
    if open_details(page, sel):
        page.wait_for_timeout(300)
    loc = page.locator(sel).first
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


def backlink_check(R, ctx, page, target):
    """实验页上的反向链接：先切到对应的标签页，再断言这一栏的知识点标签正好是 BACKLINKS[target]、都看得见、指向导图。"""
    pg, task = TARGET_PAGE[target]
    hook = HOOK_OF[pg]
    if page.evaluate("(h) => window[h].tab()", hook) != task:
        page.locator('[role=tab][data-tab="%s"]' % task).click()
        page.wait_for_timeout(300)
    scope = 'section[data-task="%s"] .lk-lab[data-lk-target="%s"]' % (task, target)
    try:
        wait_js(page, "(s) => !!document.querySelector(s)", scope, 8000)
    except PWTimeout:
        R.check("backlink.%s" % target, False, "没有 %s" % scope, page)
        return
    bl = page.evaluate("""(s) => Array.prototype.map.call(document.querySelectorAll(s + ' .lk-chip[data-kind="kp"]'),
        function (c) { return { to: c.getAttribute('data-lk-to'), abs: c.href }; })""", scope)
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
        v = visible_check(page, '%s .lk-chip[data-kind="kp"][data-lk-to="%s"]' % (scope, ref))
        if v:
            bad.append("%s 看不见：%s" % (ref, v))
    extra = sorted(set(by) - set(BACKLINKS[target]))
    R.check("backlink.%s" % target, bl and not bad and not extra,
            "%s：知识点标签 %s（应正好是 %s），都可见、指向导图%s" % (
                scope, sorted(by), sorted(BACKLINKS[target]), ("；问题：%s" % (bad + (["多出 %s" % extra] if extra else []))) if (bad or extra) else ""), page)


def sc_maps(R):
    """8.C 导图（1280×900 游客）：数学、化学导图上 7.2 节的动手标签和新的测试标签（链接、可见）；各导图非测试标签数；
    15 个新的动手标签都点一遍 → 对应情境显示（.lk-flash）、面板定位在视口里、有返回胶囊 .lk-pill；三个实验页上的反向链接；
    13 个新的测试标签都点一遍 → 那道题（#qz-<id>）看得见、在视口里（预测关卡在它的标签页上，其余在展开的练一练里）；
    中和反应实验台的「下一步」卡片链接到 solute.html?from=chemistry:u10-k7，打开后有返回胶囊。"""
    ctx = R.new_context(mobile=False)
    page = R.new_page(ctx)
    idx = load_json("shared/quiz/index.json")
    # ---- 标签数 ----
    for subj in ("physics", "chemistry", "math", "biology"):
        page.goto(R.url("%s/knowledge-map.html" % subj), wait_until="load")
        page.wait_for_timeout(2000)
        c = page.evaluate("() => window.__e2e.chips()")
        base = BASELINE[subj]
        R.check("chips.%s.default" % subj, c["nonquiz"] == base["default"],
                "%s 导图非测试标签 %d（预期 %d）；kinds=%s" % (subj, c["nonquiz"], base["default"], c["kinds"]), page)
        if base["hs"] is not None:
            if not page.evaluate("() => !!document.getElementById('hsToggle')"):
                R.check("chips.%s.hs" % subj, False, "没有找到 #hsToggle", page)
                continue
            page.evaluate("() => { var t = document.getElementById('hsToggle'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }")
            page.wait_for_timeout(800)
            c = page.evaluate("() => window.__e2e.chips()")
            R.check("chips.%s.hs" % subj, c["nonquiz"] == base["hs"], "打开高中开关后非测试标签 %d（预期 %d）" % (c["nonquiz"], base["hs"]), page)
            page.evaluate("() => { var t = document.getElementById('hsToggle'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); }")

    # ---- 新增的「动手」标签、测试标签在对应知识点那一行 ----
    for subj in ("math", "chemistry"):
        page.goto(R.url("%s/knowledge-map.html" % subj), wait_until="load")
        page.wait_for_timeout(1800)
        close_guide(page)
        for ref, tos in NEW_LINKS.items():
            s, key = ref.split(":")
            if s != subj:
                continue
            chips = kp_row_chips(page, subj, key) or []
            labs = {c["to"]: c for c in chips if c["kind"] == "lab"}
            miss = [t for t in tos if t not in labs]
            href_bad = []
            for t in tos:
                h = (labs.get(t) or {}).get("abs") or ""
                pg, task = TARGET_PAGE[t]
                if not (h.startswith(R.base + pg) and ("task=" + task) in h and "from=" in h):
                    href_bad.append("%s → %s" % (t, h.replace(R.base, "")))
            vis_bad = []
            for t in tos:
                sel = kp_sel(subj, key) + ' .lk-row[data-lk-for="%s"] a.lk-chip[data-kind="lab"][data-lk-to="%s"]' % (key, t)
                open_details(page, sel)
                v = visible_check(page, sel)
                if v:
                    vis_bad.append("%s 看不见：%s" % (t, v))
            R.check("chip.%s" % ref, chips and not miss and not href_bad and not vis_bad,
                    "%s 那一行的动手标签 %s（应有 %s），链接 %s（应指向 页面?task=…&from=…）%s" % (
                        ref, sorted(labs), tos, [labs[t]["abs"].replace(R.base, "") for t in tos if t in labs],
                        ("；" + "；".join(href_bad + vis_bad + (["缺 %s" % miss] if miss else []))) if (href_bad or vis_bad or miss) else ""), page)
        for ref, pg in QUIZ_KPS.items():
            s, key = ref.split(":")
            if s != subj:
                continue
            chips = kp_row_chips(page, subj, key) or []
            qz = [c for c in chips if c["kind"] == "quiz" and c["quiz"] == ref]
            first = ((idx.get("kps") or {}).get(ref) or [{}])[0].get("id")
            want = R.base + pg + "?from=" + quote(ref, safe="") + "#qz-" + str(first)
            prefix = {"math/quadratic.html": "m-m2-", "chemistry/solubility.html": "c-cb-", "chemistry/solute.html": "c-cc-"}[pg]
            sel = kp_sel(subj, key) + ' .lk-row[data-lk-for="%s"] a.lk-chip[data-kind="quiz"]' % key
            open_details(page, sel)
            v = visible_check(page, sel) if qz else "没有"
            R.check("quiz_chip.%s" % ref, len(qz) == 1 and qz[0]["abs"] == want and str(first).startswith(prefix) and not v,
                    "%s 的测试标签 %d 个，链接 %s（应为 %s：%s 下这个知识点的第一道题），可见：%s" % (
                        ref, len(qz), qz[0]["abs"].replace(R.base, "") if qz else None, want.replace(R.base, ""), pg, v or "是"), page)
        page.evaluate("""(sel) => { var e = document.querySelector(sel); if (!e) return;
          for (var p = e.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS' && !p.open) p.open = true;
          e.scrollIntoView({ block: 'center', behavior: 'instant' }); }""",
                      'li.ok[data-key="c26-2-4"] .lk-row[data-lk-for="c26-2-4"]' if subj == "math" else '#u9-k4 .lk-row[data-lk-for="u9-k4"]')
        page.wait_for_timeout(600)
        R.shot(page, "map_%s_chips" % subj)

    # ---- 点动手标签 → 实验页的对应情境（15 个都点）----
    checked_pages = set()
    for subj, key, target in JUMPS:
        pg, task = TARGET_PAGE[target]
        hook = HOOK_OF[pg]
        sel = kp_sel(subj, key) + ' .lk-row[data-lk-for="%s"] a.lk-chip[data-kind="lab"][data-lk-to="%s"]' % (key, target)
        goto_map(R, page, subj, sel)
        follow_chip(R, ctx, page, subj, key, target)
        try:
            wait_js(page, "(h) => !!window[h]", hook, 10000)
        except PWTimeout:
            pass
        u = page.url.replace(R.base, "")
        try:
            wait_js(page, "(k) => document.querySelector('section[data-task=\"' + k + '\"]').classList.contains('lk-flash')", task, 6000)
            flash = True
        except PWTimeout:
            flash = False
        page.wait_for_timeout(250)
        settle_scroll(page, 3000)
        info = page.evaluate("""([h, k]) => { var all = Array.prototype.slice.call(document.querySelectorAll('section[data-task]'));
          var btn = document.querySelector('[role=tab][data-tab="' + k + '"]'), me = document.querySelector('section[data-task="' + k + '"]');
          return { tab: window[h] && window[h].tab(), sel: btn ? btn.getAttribute('aria-selected') : null, view: window.__e2e.inView(me),
                   shown: all.filter(function (s) { return window.__e2e.isShown(s); }).map(function (s) { return s.getAttribute('data-task'); }) }; }""", [hook, task])
        vw = info["view"] or {}
        # 定位：面板在视口里，面板顶部露在屏幕上（linker 把面板放在屏幕中间，面板比屏幕高时顶部对齐、留出顶栏）
        located = bool(vw.get("inView")) and -2 <= vw.get("top", -999) < vw.get("vh", 0) - 60
        R.check("jump.%s.%s" % (key, task), u.startswith(pg) and ("task=" + task) in u and info["tab"] == task and info["sel"] == "true"
                and info["shown"] == [task] and flash and located,
                "点 %s 的「%s」标签到了 %s：当前标签页 %r（aria-selected=%r），显示中的面板 %s，%s 面板 .lk-flash=%s，面板在视口里 top=%s bottom=%s（视口高 %s）=%s" % (
                    key, target, u, info["tab"], info["sel"], info["shown"], task, flash, vw.get("top"), vw.get("bottom"), vw.get("vh"), located), page)
        pill = pill_info(page)
        R.check("jump.%s.%s.pill" % (key, task), bool(pill) and pill["text"].startswith("← 回到") and ("knowledge-map.html?kp=" + key) in (pill["href"] or ""),
                "返回胶囊 .lk-pill：%s" % jd(pill), page)
        if pg not in checked_pages:
            R.shot(page, "from_map_%s_%s" % (key, task))
            checked_pages.add(pg)
            for t, (p2, _) in TARGET_PAGE.items():
                if p2 == pg:
                    backlink_check(R, ctx, page, t)

    # ---- 点测试标签 → 新页面上的那道题（13 个都点）----
    for ref, pg in QUIZ_KPS.items():
        subj, key = ref.split(":")
        first = str(((idx.get("kps") or {}).get(ref) or [{}])[0].get("id"))
        sel = kp_sel(subj, key) + ' .lk-row[data-lk-for="%s"] a.lk-chip[data-kind="quiz"]' % key
        goto_map(R, page, subj, sel)
        close_guide(page)
        if open_details(page, sel):
            page.wait_for_timeout(300)
        loc = page.locator(sel).first
        loc.scroll_into_view_if_needed()
        with page.expect_navigation(wait_until="load", timeout=20000):
            loc.click()
        anchor = "qz-" + first
        try:
            wait_js(page, "(id) => { var e = document.getElementById(id), v = window.__e2e.inView(e); return !!(v && v.inView && window.__e2e.isShown(e)); }", anchor, 12000)
        except PWTimeout:
            pass
        page.wait_for_timeout(250)
        settle_scroll(page, 3000)
        u = page.url.replace(R.base, "")
        st = page.evaluate("""(id) => { var e = document.getElementById(id), H = window.__e2e, d = document.querySelector('details.qz-practice');
          return { exists: !!e, shown: H.isShown(e), view: H.inView(e), cls: e ? e.className : null, practiceOpen: d ? d.open : null,
                   inPractice: !!(e && d && d.contains(e)) }; }""", anchor)
        gt = GATE_TAB.get(first)
        if gt:
            h, tk, pair = gt
            where = page.evaluate("([h, p]) => ({ tab: window[h] ? window[h].tab() : null, pair: p && window[h] ? window[h].get('curve').pair : null })", [h, pair])
            place_ok = where["tab"] == tk and (pair is None or where["pair"] == pair) and not st["inPractice"]
            place = "预测关卡：标签页 %r（应为 %s）%s" % (where["tab"], tk, ("，试剂对 %r（应为 %d）" % (where["pair"], pair)) if pair else "")
        else:
            place_ok = st["practiceOpen"] is True and st["inPractice"]
            place = "练一练展开=%r，题目在练一练里=%r" % (st["practiceOpen"], st["inPractice"])
        vw = st["view"] or {}
        pill = pill_info(page)
        R.check("quiz_jump.%s" % ref, u == pg + "?from=" + quote(ref, safe="") + "#" + anchor and st["exists"] and st["shown"] and bool(vw.get("inView"))
                and place_ok and bool(pill) and ("knowledge-map.html?kp=" + key) in (pill["href"] or ""),
                "点 %s 的测试标签到了 %s：#%s 存在=%s、看得见=%s、在视口里 top=%s bottom=%s（视口高 %s）=%s；%s；返回胶囊 %s" % (
                    ref, u, anchor, st["exists"], st["shown"], vw.get("top"), vw.get("bottom"), vw.get("vh"), vw.get("inView"), place, jd(pill)), page)

    # ---- 中和反应实验台的「下一步」卡片 ----
    page.goto(R.url("chemistry/neutralization.html"), wait_until="load")
    page.wait_for_timeout(800)
    nx = page.evaluate("""() => { var a = document.querySelector('.next-step-card a.next-step-link'); if (!a) return null;
      var card = a.closest('.card'), prev = card ? card.previousElementSibling : null;
      return { text: a.textContent.trim(), abs: a.href, shown: window.__e2e.isShown(a),
               afterTasks: !!(prev && prev.querySelector('#chemTaskList')) }; }""")
    want = R.base + "chemistry/solute.html?from=chemistry:u10-k7"
    R.check("neut.next_card", bool(nx) and nx["abs"] == want and nx["shown"] and nx["afterTasks"]
            and nx["text"] == "下一步：换几对试剂，看反应后溶液里有什么 →",
            "「下一步」卡片：%s（链接应为 %s，放在任务卡片下面）" % (jd(nx), want.replace(R.base, "")), page)
    if nx:
        with page.expect_navigation(wait_until="load", timeout=20000):
            page.locator(".next-step-card a.next-step-link").first.click()
        try:
            wait_js(page, "() => !!window.__solute", None, 10000)
        except PWTimeout:
            pass
        pill = pill_info(page)
        u = page.url.replace(R.base, "")
        R.check("neut.next_opens_solute", u == "chemistry/solute.html?from=chemistry:u10-k7" and page.evaluate("() => !!window.__solute")
                and bool(pill) and pill["text"].startswith("← 回到") and "knowledge-map.html?kp=u10-k7" in (pill["href"] or ""),
                "点「下一步」到了 %s，__solute=%s，返回胶囊 %s" % (u, page.evaluate("() => !!window.__solute"), jd(pill)), page)
        R.shot(page, "neut_next")
    no_errors_check(R, "no_page_errors", page)


class WordScan:
    """界面用词：每到一个状态就把渲染出来的文字（含 svg，跳过 details.hs-box）收一遍，查禁用词。"""

    def __init__(self, page):
        self.page = page
        self.snaps = []        # 状态名
        self.hits = []         # (状态, 词, 那段文字)
        self.miss = []         # 没到达的状态 / 没出现的证据
        self.segs = set()

    def snap(self, label):
        texts = self.page.evaluate("() => window.__e2e.texts('details.hs-box')")
        self.snaps.append(label)
        for t in texts:
            self.segs.add(t)
            for w in FORBIDDEN:
                if w in t and not any(h[1] == w and h[2] == t for h in self.hits):
                    self.hits.append((label, w, t))
        return texts

    def need(self, label, ok, why=""):
        if not ok:
            self.miss.append("%s%s" % (label, ("：" + why) if why else ""))
        return ok


def wrong_pick(sec):
    """答错时选哪个：优先选带错误概念标签的错项（这样反馈里会出现反驳性的「常见想法」），没有就选第一个错项。"""
    if not sec:
        return ""
    wrong = [o for o in sec["options"] if o["id"] != sec["correct"]]
    tagged = [o for o in wrong if o.get("mc")]
    return (tagged or wrong)[0]["id"]


def answer_quiet(R, ctx, page, qid, ch, rs, cf, want=("guest", "saved")):
    """普通题（练一练）：按 id 选答案、理由、把握度 → 提交 → 等记录行；不单独记检查行。返回记录行（失败时带 error）。"""
    sel = '.qz-card[data-qid="%s"]' % qid
    try:
        page.wait_for_selector(sel, timeout=15000)
        card = page.locator(sel).last
        tap(R, ctx, page, card.locator('[data-qz-ans="%s"]' % ch))
        if rs:
            tap(R, ctx, page, card.locator('[data-qz-rs="%s"]' % rs))
        tap(R, ctx, page, card.locator('[data-qz-cf="%s"]' % cf))
        sub = card.locator("[data-qz-submit]")
        if not is_enabled(sub, 5000):
            return {"state": None, "error": "提交按钮不可用"}
        tap(R, ctx, page, sub)
        return wait_js(page, "([q, w]) => { var r = window.__e2e.record(q); return r && r.state && (w.indexOf(r.state) >= 0 || r.state === 'error') ? r : false; }",
                       [qid, list(want)], 20000)
    except (PWTimeout, PWError) as e:
        return {"state": None, "error": short(e, 120)}


def words_practice(R, ctx, page, W, bank_file):
    """练一练：展开，9 题都答错（选带标签的错项、错的理由、有把握），反馈和反驳性的「常见想法」都渲染出来以后再收一遍文字。"""
    page.evaluate("() => { var d = document.querySelector('details.qz-practice'); if (d) d.open = true; }")
    try:
        wait_js(page, "() => document.querySelectorAll('details.qz-practice .qz-card[data-qid]').length >= 9", None, 15000)
    except PWTimeout:
        pass
    n = page.evaluate("() => document.querySelectorAll('details.qz-practice .qz-card[data-qid]').length")
    W.need("练一练 9 题", n == 9, "只有 %d 题" % n)
    W.snap("练一练展开")
    items = [it for it in load_json(bank_file)["items"] if it.get("retest") is True]
    done = 0
    for it in items:
        rec = answer_quiet(R, ctx, page, it["id"], wrong_pick(it["answer"]), wrong_pick(it.get("reason")), "sure")
        if W.need("练一练 %s 答完" % it["id"], rec.get("state") in ("guest", "saved"), jd(rec)):
            done += 1
    fbs = page.evaluate("""() => { var H = window.__e2e, P = document.querySelector('details.qz-practice');
      var vis = function (s) { return Array.prototype.filter.call(P.querySelectorAll(s), function (e) { return H.isShown(e); }).length; };
      return { fb: vis('.qz-feedback .qz-verdict'), refute: vis('.qz-refute'), ref: vis('.qz-ref-main'), key: vis('.qz-key') }; }""")
    W.need("练一练的反馈", fbs["fb"] == len(items) and fbs["refute"] >= 1 and fbs["key"] == len(items), jd(fbs))
    W.snap("练一练 %d 题都答错之后" % done)
    return "练一练答错 %d 题（反馈 %d、正确答案 %d、常见想法 %d、参考解释 %d）" % (done, fbs["fb"], fbs["key"], fbs["refute"], fbs["ref"])


def gate_feedback_shown(page, host):
    return page.evaluate("""(h) => { var c = window.__e2e.extCard(h), H = window.__e2e; if (!c) return null;
      var vis = function (s) { return Array.prototype.filter.call(c.querySelectorAll(s), function (e) { return H.isShown(e); }).length; };
      return { stage: c.getAttribute('data-stage'), verdict: vis('.qz-verdict'), refute: vis('.qz-refute'), ref: vis('.qz-ref-main'), mine: vis('.qz-mine') }; }""", host)


def words_quad(R, ctx, page, W):
    notes = []
    for key in ("vertex", "interval", "abc"):
        t = tab_to(R, ctx, page, "__quad", key)
        W.need("切到 %s" % key, t["tab"] == key and t["shown"], jd(t))
        W.snap("标签页 %s" % key)
    tab_to(R, ctx, page, "__quad", "vertex")
    wait_card(R, page, "#qz-vertex-ans", QID_M2)
    W.snap("vertex 锁定")
    predict_ext(R, ctx, page, "#qz-vertex-ans", "a", "sure", "words.quad.gate.")
    for h in (2, -2):
        drag_to(R, ctx, page, "quad", "vertex", (h, 0), 14)
        g = page.evaluate("() => window.__quad.get('vertex')")
        W.need("vertex h=%d" % h, g["h"] == h, "h=%r" % g["h"])
        W.snap("vertex h=%d" % h)
    rec = finish_ext(R, ctx, page, "#qz-vertex-ans", EXPLAIN_M2, ("guest",), "words.quad.gate.")
    fb = gate_feedback_shown(page, "#qz-vertex-ans") or {}
    W.need("vertex 预测关卡的反馈", rec.get("state") == "guest" and fb.get("stage") == "feedback" and fb.get("ref") == 1 and fb.get("refute", 0) >= 1, jd(fb))
    W.snap("vertex 预测关卡反馈（选 a，参考解释 + 常见想法）")
    notes.append("vertex 关卡反馈 %s" % jd(fb))
    tab_to(R, ctx, page, "__quad", "interval")
    for mid in (1.0, -2.5, 3.0):
        drag_to(R, ctx, page, "quad", "interval", (mid, 0), 12, keep_y=True)
        W.snap("interval 窗口中点 %s（%s）" % (mid, page.get_attribute("#quad-case", "data-case")))
    W.need("interval 三种情况", page.evaluate("() => { var s = window.__quad.get('interval').seen; return s.left && s.inside && s.right; }"))
    tab_to(R, ctx, page, "__quad", "abc")
    for sel, v in (('#quad-abc .sk-ctl[data-id="b"] input', -2), ('#quad-abc .sk-ctl[data-id="a"] input', -1), ('#quad-abc .sk-ctl[data-id="b"] input', 2)):
        _, hit, got = slide_sk(R, ctx, page, sel, [v], step=0.5)
        W.need("abc 滑块 %s → %s" % (sel.split('"')[1], v), hit and got == v, "hit=%s 值 %s" % (hit, got))
        W.snap("abc %s = %s" % (sel.split('"')[1], v))
    return notes


def words_solub(R, ctx, page, W):
    notes = []
    for key in ("cool", "compare", "nacl"):
        t = tab_to(R, ctx, page, "__solub", key)
        W.need("切到 %s" % key, t["tab"] == key and t["shown"], jd(t))
        W.snap("标签页 %s" % key)
    tab_to(R, ctx, page, "__solub", "cool")
    wait_card(R, page, "#qz-cool-ans", QID_CB)
    W.snap("cool 锁定")
    predict_ext(R, ctx, page, "#qz-cool-ans", "b", "sure", "words.solub.gate.")
    for T in (50, 47.6, 30, 20):
        drag_to(R, ctx, page, "solub", "cool", (T, 0), 20, keep_y=True)
        g = page.evaluate("() => window.__solub.get('cool')")
        W.snap("cool T=%s（%s，%s）" % (g["T"], g["status"], g["label"]))
    W.need("cool 降到 20℃", g["T"] == 20, "T=%r" % g["T"])
    rec = finish_ext(R, ctx, page, "#qz-cool-ans", EXPLAIN_CB, ("guest",), "words.solub.gate.")
    fb = gate_feedback_shown(page, "#qz-cool-ans") or {}
    W.need("cool 预测关卡的反馈", rec.get("state") == "guest" and fb.get("stage") == "feedback" and fb.get("ref") == 1 and fb.get("refute", 0) >= 1, jd(fb))
    W.snap("cool 预测关卡反馈（选 b，参考解释 + 常见想法）")
    notes.append("cool 关卡反馈 %s" % jd(fb))
    tab_to(R, ctx, page, "__solub", "compare")
    cr = page.evaluate("() => window.__solub.get('compare').cross")
    tap(R, ctx, page, '[data-solub-pick="KNO3"]')
    drag_to(R, ctx, page, "solub", "compare", (cr["T"] + 0.2, cr["S"] + 0.3), 14, sub="KNO3")
    W.snap("compare KNO₃ 在交点")
    tap(R, ctx, page, '[data-solub-pick="NaCl"]')
    drag_to(R, ctx, page, "solub", "compare", (cr["T"] - 0.2, cr["S"] - 0.2), 14, sub="NaCl")
    W.need("compare 质量分数相同", page.evaluate("() => window.__solub.get('compare').equal") is True)
    W.snap("compare 两份都在交点、都饱和")
    drag_to(R, ctx, page, "solub", "compare", (cr["T"], 15), 10, sub="NaCl")
    W.snap("compare NaCl 不饱和")
    drag_to(R, ctx, page, "solub", "compare", (cr["T"], 60), 12, sub="NaCl")
    W.snap("compare NaCl 有晶体")
    tab_to(R, ctx, page, "__solub", "nacl")
    drag_to(R, ctx, page, "solub", "nacl", (20, 0), 30, keep_y=True)
    W.snap("nacl 20℃")
    for k in range(5):
        tap(R, ctx, page, "[data-solub-evap]")
        page.wait_for_timeout(200)
        W.snap("nacl 蒸发 %d 次" % (k + 1))
    g = page.evaluate("() => window.__solub.get('nacl')")
    dis = page.evaluate("() => document.querySelector('[data-solub-evap]').disabled")
    W.need("nacl 蒸发到 50 g 水", g["W"] == 50 and dis is True, "水 %s g，按钮 disabled=%r" % (g["W"], dis))
    tap(R, ctx, page, "[data-solub-reset]")
    page.wait_for_timeout(200)
    W.snap("nacl 重置")
    return notes


def words_solute(R, ctx, page, W):
    notes = []
    for key in ("curve", "spoil"):
        t = tab_to(R, ctx, page, "__solute", key)
        W.need("切到 %s" % key, t["tab"] == key and t["shown"], jd(t))
        W.snap("标签页 %s" % key)
    tab_to(R, ctx, page, "__solute", "curve")
    for pid in (1, 2, 3, 4):
        tap(R, ctx, page, '[data-pair="%d"]' % pid)
        page.wait_for_timeout(250)
        if pid == 3:
            page.evaluate("async () => { await window.__solute.gate(); return 1; }")
            wait_card(R, page, "#qz-curve-ans", QID_CC)
            W.snap("③ 锁定（V = 0）")
            predict_ext(R, ctx, page, "#qz-curve-ans", "b", "sure", "words.solute.gate.")
        W.snap("试剂对 %d，V = 0" % pid)
        for V in (10, 20, 30):
            cc_drag_v(R, ctx, page, V, 10)
            d = page.evaluate("() => { var c = window.__solute.get('curve'); return { V: c.V, pair: c.pair, stage: c.stage, note: document.getElementById('solute-note').textContent }; }")
            W.need("试剂对 %d 拖到 V=%d" % (pid, V), d["pair"] == pid and abs(d["V"] - V) < 1e-9, jd(d))
            W.snap("试剂对 %d，V = %d（%s）" % (pid, V, d["stage"]))
            if pid == 4 and V == 30:
                W.need("④ 恰好完全反应之后的说明出现在取样卡片上", "Na₂CO₃ 溶液滴过量了" in d["note"], "「%s」" % d["note"])
        if pid == 3:
            cc_drag_v(R, ctx, page, 40, 8)
            rec = finish_ext(R, ctx, page, "#qz-curve-ans", EXPLAIN_CC, ("guest",), "words.solute.gate.")
            fb = gate_feedback_shown(page, "#qz-curve-ans") or {}
            W.need("③ 预测关卡的反馈", rec.get("state") == "guest" and fb.get("stage") == "feedback" and fb.get("ref") == 1 and fb.get("refute", 0) >= 1, jd(fb))
            W.snap("③ 预测关卡反馈（选 b，参考解释 + 常见想法）")
            notes.append("③ 关卡反馈 %s" % jd(fb))
    tab_to(R, ctx, page, "__solute", "spoil")
    seqs = (["acid", "phenol"], ["cacl2", "phenol", "acid"], ["lime", "phenol"], ["phenol", "lime", "cacl2"])
    n_tubes = 0
    seen_obs = set()
    for x in "ABC":
        for seq in seqs:
            tap(R, ctx, page, 'button[data-sample="%s"]' % x)
            tap(R, ctx, page, "[data-tube-new]")
            for r in seq:
                tap(R, ctx, page, '[data-reagent="%s"]' % r)
            tb = page.evaluate(TUBE_JS)
            ok = bool(tb) and tb["sample"] == x and tb["steps"] == ",".join(seq) and len(tb["log"]) == len(seq)
            W.need("样品 %s：%s" % (x, " → ".join(seq)), ok, jd(tb))
            if tb:
                for line in tb["log"]:
                    seen_obs.add(line.split("：", 1)[-1])
            n_tubes += 1
            W.snap("样品 %s：%s" % (x, " → ".join(seq)))
    # 现象都出现过：气泡、白色沉淀、变红、无色、无明显现象（说明各种现象文字都被收过一遍）
    W.need("各种现象文字都出现过", all(any(k in o for o in seen_obs) for k in ("产生气泡", "产生白色沉淀", "溶液变红", "溶液无色", "无明显现象")), jd(sorted(seen_obs)))
    for v in ("none", "partial", "full"):
        for x in "ABC":
            judge_by_label(page, x, v)
        tap(R, ctx, page, "[data-judge-check]")
        page.wait_for_timeout(200)
        W.snap("结论都选「%s」后核对（%s）" % (JUDGE_LABEL[v], "/".join(page.evaluate(SPOIL_FB_JS)[i][0][:6] for i in range(3))))
    tap(R, ctx, page, "[data-reshuffle]")
    page.wait_for_timeout(200)
    W.snap("换一组样品")
    notes.append("做了 %d 支试管，看到的现象 %s" % (n_tubes, "、".join(sorted(seen_obs))))
    return notes


def sc_words(R):
    """8.C 界面用词：三个新页面在很多状态下收一遍渲染出来的文字（含 svg）——每个标签页；预测关卡锁定、操作中、做完以后的反馈
    （参考解释和反驳性的「常见想法」）；溶质页四对试剂 × V = 0、10、20、30 mL 的取样卡片；四种试剂在每份样品上的现象和核对反馈；
    溶解度页的降温、交点、蒸发、重置；练一练 9 题都答错以后的反馈。除了默认收起的 details.hs-box，都不出现
    mol、物质的量、离子方程式、电离、水解（也查 Kb、NaHCO）。"""
    ctx = R.new_context(mobile=True)
    runs = {"math/quadratic.html": (words_quad, "shared/quiz/items/math-m2.json"),
            "chemistry/solubility.html": (words_solub, "shared/quiz/items/chemistry-cb.json"),
            "chemistry/solute.html": (words_solute, "shared/quiz/items/chemistry-cc.json")}
    for pg, (hook, keys) in TABS.items():
        page = R.new_page(ctx)
        page.goto(R.url(pg), wait_until="load")
        try:
            wait_js(page, "(h) => !!window[h]", hook, 10000)
            page.evaluate("async (h) => { await window[h].gate(); return 1; }", hook)
        except (PWTimeout, PWError) as e:
            R.check("words.%s.setup" % pg, False, "钩子不可用：%s" % short(e, 120), page)
            page.close()
            continue
        W = WordScan(page)
        W.snap("首屏")
        fn, bank = runs[pg]
        notes = []
        try:
            notes += fn(R, ctx, page, W)
        except StepFail as e:
            W.miss.append("操作中止：%s" % short(e, 160))
        except (PWTimeout, PWError) as e:
            W.miss.append("操作出错：%s" % short(e, 160))
        try:
            notes.append(words_practice(R, ctx, page, W, bank))
        except (PWTimeout, PWError) as e:
            W.miss.append("练一练出错：%s" % short(e, 160))
        hs = page.evaluate("() => Array.prototype.map.call(document.querySelectorAll('details.hs-box'), function (d) { return { open: d.open, text: d.textContent.replace(/\\s+/g, ' ').trim() }; })")
        hs_ok = all(not h["open"] for h in hs)
        if pg == "chemistry/solute.html":
            # 这一句只能在默认收起、标「高中」的小框里（说明上面的检查确实把小框排除在外、其余地方真的没有）
            hs_ok = hs_ok and len(hs) == 1 and "NaHCO₃" in hs[0]["text"] and "高中" in hs[0]["text"]
        hits = ["%s @「%s」（%s）" % (w, short(t, 50), lab) for lab, w, t in W.hits]
        R.check("words.%s" % pg, not W.hits and not W.miss and hs_ok and len(W.snaps) >= 10,
                "收了 %d 个状态的文字（共 %d 段不同的文字、%d 字）；禁用词 %s：%s；%s；没到达的状态：%s；高中小框 %s" % (
                    len(W.snaps), len(W.segs), sum(len(x) for x in W.segs), "/".join(FORBIDDEN), hits or "无",
                    "；".join(notes), W.miss or "无", jd(hs) if hs else "无"), page)
        page.close()
    no_errors_check(R, "no_page_errors")


FUNCS = {
    "offline": sc_offline,
    "m2_mobile": sc_m2_mobile,
    "cb_mobile": sc_cb_mobile,
    "cc_mobile": sc_cc_mobile,
    "closed_loop": sc_closed_loop,
    "check": sc_check,
    "maps": sc_maps,
    "words": sc_words,
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
    ap = argparse.ArgumentParser(description="ABS-LAB 第 1 批 B 端到端测试（SPEC-1B 第 8.C 节）")
    ap.add_argument("--only", default="", help="只跑这些场景，逗号分隔：" + ",".join(SCENARIOS))
    ap.add_argument("--headed", action="store_true", help="显示浏览器窗口")
    ap.add_argument("--keep", action="store_true", help="不删除 tests/__out__/ 里上次留下的 e2e1b_* 截图和 CSV")
    ap.add_argument("--port", type=int, default=8093, help="dev-server 端口（默认 8093）")
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
            if f.startswith("e2e1b_") and (f.endswith(".png") or f.endswith(".csv")):
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
            proc, log = start_server(args.port, os.path.join(OUT, "e2e1b_dev-server.log"))
        print("ABS-LAB 第 1 批 B 端到端测试：%s；场景 %s" % (base, ", ".join(only)), flush=True)
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
