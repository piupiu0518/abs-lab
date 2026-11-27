/* ABS-LAB「溶解度曲线」页面脚本（chemistry/solubility.html）
 *
 * 三个情境（标签页切换，一次只显示一个，每个是一个任务 data-task）：
 *   cool     降温结晶：KNO₃，100 g 水里一共加入 80 g，从 60℃ 起左右拖状态点（只改温度），挂预测关卡 c-cb-poe（部件 cb-state）；
 *   compare  两条曲线与交点：KNO₃、NaCl 各一份（都是 100 g 水），每次拖一个状态点（左右改温度、上下改溶质的质量）；
 *   nacl     NaCl 与蒸发结晶：60℃ 恰好饱和（37.3 g），降温看析出多少，再「恒温蒸发 10 g 水」。
 * 溶解度、状态、析出量、质量分数都由 js/chem-models.js（window.ABSLabChem）算，和题库、单元测试用的是同一份函数。
 *
 * 为什么这样写：
 *   - 一屏只放一个可拖动对象和一个联动图（SPEC 第 2 节）：拖的是坐标板上的「状态点」（空心圆），旁边的小烧杯只跟着变。
 *     cool 里改溶质总量的滑块收进「进阶」。
 *   - 隐性支架（SPEC 5.2）：状态点在曲线上方时，曲线上同一温度处出现实心点（溶液实际组成的点），两点之间连竖直虚线，
 *     旁边写「析出 x g」（nacl 的水不是 100 g，写「每 100 g 水多 x g」，和纵轴一致；实际析出多少看读数和烧杯）；
 *     杯底的晶体跟着增减。学生不用先记公式，看图就知道「多出来的部分析出来了」。
 *   - 吸附：cool、nacl 只左右拖，离碰到曲线的温度不到 0.4℃ 时吸到曲线上，读数正好是「恰好饱和」（按温度算、不按像素：
 *     手机上 1℃ 不到 3 px，按 8 px 算会在曲线两边各留出约 3℃ 的「死区」，析出量一下子从 0 跳到 7 g）；
 *     compare 在平面里拖，离曲线不到约 6 px（屏幕上沿法线量）时吸到曲线上，离交点约 0.6℃ 以内吸到交点温度；
 *     离整十度不到 0.3℃ 时吸到整十度，读数正好是课本表里的值（题目里的计算只用整十度的表值）。曲线的吸附先算，整十度盖不掉它。
 *   - 拖动在 svgkit 的 rAF 帧里回调本文件；回调里只改属性和文字节点，不读布局、不建节点、不用 innerHTML，
 *     手机上每帧开销很小（同 math/js/moving-point.js）。读数、板上的标注都用 textNode.nodeValue 改（characterData 变动），
 *     不触发 linker.js 盯着的 childList 变动，拖动时它不会反复刷新。
 *   - 界面上只出现初中的说法（溶解度、饱和、析出、溶质质量分数），不出现高中的概念。
 * 语法不超过 ES2019，与 shared/*.js 一样用 var + function。
 */
(function () {
  "use strict";

  var S = window.ABSLabSVG;
  var C = window.ABSLabChem;
  var Q = window.ABSLabQuiz;
  var KEYS = ["cool", "compare", "nacl"];
  var PROGRESS_KEY = "chem_solub_tasks";
  var WIDGET_ID = "cb-state";
  var QID_POE = "c-cb-poe";
  var SVGNS = "http://www.w3.org/2000/svg";

  var CURVE_SNAP = 0.4;   // cool、nacl（只改温度）：离碰到曲线的温度不到 0.4℃：吸到曲线上（恰好饱和）
  var CMP_SNAP_PX = 6;    // compare（平面里拖）：离曲线不到 6 px（屏幕上，沿曲线的法线量）：吸到曲线上
  var CROSS_SNAP = 0.6;   // compare：温度离交点不到 0.6℃：吸到交点温度
  var TEN_SNAP = 0.3;     // 离整十度不到 0.3℃：吸到整十度（课本溶解度表里的温度）；比曲线的吸附窄，而且排在它后面
  var KBD_SNAP = 0.5;     // 键盘一步走 1（℃ 或 g），吸附只取半步：下一步能照常走开，不会被吸回原处
  var GATE_LOW = 22, GATE_HIGH = 58; // 预测关卡的完成条件：温度既到过 ≤ 22℃，也到过 ≥ 58℃（SPEC 5.2）
  var STATUS_TEXT = { unsat: "不饱和", sat: "恰好饱和", crystal: "饱和且有晶体" };
  // compare 里会移动状态点的按键：方向键、翻页键（见 svgkit.js 的 onKey）。Home / End 只沿带 along 的约束跳到两端，
  // compare 的平面约束没有 along，按了不移动点，不算在内（否则键盘标记留着，之后手指拖动也按键盘的吸附算）
  var MOVE_KEYS = { ArrowRight: 1, Right: 1, ArrowLeft: 1, Left: 1, ArrowUp: 1, Up: 1, ArrowDown: 1, Down: 1, PageUp: 1, PageDown: 1 };

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function round(v, n) { var k = Math.pow(10, n); return Math.round(v * k) / k; }
  // 读数：固定小数位，去掉「-0.0」
  function fx(v, n) {
    var s = round(v, n).toFixed(n);
    return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
  }
  // 读数要用的文字节点：元素里没有就补一个（只在建页面时调用，不在拖动里）
  function textOf(el) {
    if (!el) return { nodeValue: "" };
    if (!el.firstChild || el.firstChild.nodeType !== 3) el.insertBefore(document.createTextNode(""), el.firstChild);
    return el.firstChild;
  }
  function setText(tn, s) { if (tn.nodeValue !== s) tn.nodeValue = s; }
  function setShown(h, on) {
    if (!h) return;
    if (typeof h.show === "function") h.show(!!on);
    else if (h.node) h.node.style.display = on ? "" : "none";
  }
  function destroyBoard(b) { if (b && typeof b.destroy === "function") { try { b.destroy(); } catch (e) { /* 已拆掉 */ } } }
  function svgEl(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function f1(v) { return String(Math.round(v * 10) / 10); }
  // 估算标注的宽度（px，不量 DOM）：汉字 1em，其余约 0.6em（同 svgkit 的 textW）
  function textW(s, fs) {
    var w = 0;
    for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) >= 0x2e80 ? fs : 0.6 * fs;
    return w;
  }
  // 画板上 1 个世界单位等于多少 px（i = 0 横向，1 纵向）。b.size() 读的是布局时记下的数，不读 DOM
  function kOf(b, i) {
    var s = b.size(), v = b.view;
    return i === 0 ? (s.plot[2] - s.plot[0]) / (v[1] - v[0]) : (s.plot[3] - s.plot[1]) / (v[3] - v[2]);
  }
  // 模型二分法算出的温度（47.5828963…、59.9999999…）去掉最后几位的浮点尾巴：60℃ 就是 60
  function tidy(t) { return t == null ? null : Math.round(t * 1e9) / 1e9; }

  /* ==================== 任务进度（chem_solub_tasks） ==================== */
  function loadTasks() {
    var out = { cool: false, compare: false, nacl: false };
    var A = window.ABSLabAuth, saved = null;
    if (A && typeof A.getProgress === "function") {
      try { saved = A.getProgress(PROGRESS_KEY, null); } catch (e) { saved = null; }
    }
    if (saved && typeof saved === "object") KEYS.forEach(function (k) { out[k] = !!saved[k]; });
    return out;
  }
  var TASKS = loadTasks();
  function markTask(k) {
    if (TASKS[k]) return;
    // 先读一次存着的进度再合并：别的标签页里刚完成的任务不会被这里覆盖掉
    var cur = loadTasks();
    KEYS.forEach(function (x) { TASKS[x] = !!(TASKS[x] || cur[x]); });
    TASKS[k] = true;
    var A = window.ABSLabAuth;
    if (A && typeof A.setProgress === "function") {
      try { A.setProgress(PROGRESS_KEY, { cool: TASKS.cool, compare: TASKS.compare, nacl: TASKS.nacl }); } catch (e) { /* 存储不可用：本页照常显示完成 */ }
    }
    paintTabs();
  }

  /* ==================== 标签页 ==================== */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.sb-tabs [role="tab"][data-tab]'));
  var CUR = "cool";
  var PANELS = {};
  function paintTabs() {
    tabs.forEach(function (b) { b.classList.toggle("is-done", !!TASKS[b.getAttribute("data-tab")]); });
  }
  function show(key, focus) {
    if (KEYS.indexOf(key) < 0) return false;
    CUR = key;
    tabs.forEach(function (b) {
      var on = b.getAttribute("data-tab") === key;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.setAttribute("tabindex", on ? "0" : "-1");
      if (on && focus) { try { b.focus(); } catch (e) { /* 老浏览器 */ } }
    });
    KEYS.forEach(function (k) {
      var p = document.querySelector('section[data-task="' + k + '"]');
      if (p) p.hidden = k !== key;
    });
    // 面板刚从隐藏变成显示：有 ResizeObserver 的浏览器会自己重排，没有的（iOS 13.0–13.3）这里补一次
    var T = PANELS[key];
    if (T && T.resize) T.resize();
    return true;
  }
  tabs.forEach(function (b, i) {
    b.addEventListener("click", function () { show(b.getAttribute("data-tab"), false); });
    // 方向键在标签之间移动（WAI-ARIA 标签页的习惯）
    b.addEventListener("keydown", function (e) {
      var d = e.key === "ArrowRight" || e.key === "Right" ? 1 : e.key === "ArrowLeft" || e.key === "Left" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      var n = tabs[(i + d + tabs.length) % tabs.length];
      show(n.getAttribute("data-tab"), true);
    });
  });

  var HASH = String(location.hash || "");
  var HASH_QID = /^#qz-(c-cb-[a-z0-9-]+)$/.test(HASH) ? HASH.slice(4) : "";
  // ?task=cool|compare|nacl 和 #qz-c-cb-poe：同步切到对应面板（linker.js 稍后按 ?task 滚动、高亮这个面板，它得先显示出来）
  function pickInitialTab() {
    var task = null;
    try { task = new URLSearchParams(location.search).get("task"); } catch (e) {
      var mm = /[?&]task=([a-z]+)/.exec(location.search || "");
      task = mm ? mm[1] : null;
    }
    if (task && show(task, false)) return;
    if (HASH_QID === QID_POE) show("cool", false);
  }

  /* ==================== 画板没加载成功 ==================== */
  if (!S || typeof S.board !== "function" || !C || typeof C.state !== "function") {
    KEYS.forEach(function (k) {
      var w = $("solub-" + k + "-boards");
      if (w) {
        var p = document.createElement("p");
        p.className = "sb-load";
        p.appendChild(document.createTextNode("画板没有加载成功，请刷新页面再试。"));
        w.parentNode.insertBefore(p, w);
        w.style.display = "none";
      }
    });
    paintTabs();
    pickInitialTab();
    return;
  }

  /* ==================== 公用部件 ==================== */
  // 坐标板：横轴温度、纵轴每 100 g 水中溶质的质量；刻度按情境给，和网格线对齐
  function solBoard(host, view, xt, yt, label) {
    return S.board(host, {
      view: view, aspect: "fill", ratio: 0.68, maxHeight: "46vh",
      axes: { x: "温度/℃", y: "每 100 g 水中溶质的质量 / g", xt: xt, yt: yt }, grid: true, pad: [24, 16, 20, 10],
      ariaLabel: label
    });
  }
  function ticks(a, b, d) { var out = []; for (var v = a; v <= b + 1e-9; v += d) out.push(v); return out; }

  // 板上的一条标注（「析出 x g」「恰好饱和」）：svgkit 的文字位置（e、w、n、s、ne……）建好就不能改，
  // 所以每个方位各建一个、只显示一个。文字用自己补的文字节点改 nodeValue（svgkit 的文字是常量 ""，不会去碰它）。
  // off：离锚点多远（px），一个数，或者按方位给（{ n: 14, … }）
  function mkTag(b, color, poses, off) {
    var items = {}, tns = {}, cur = null, at = [0, 0];
    poses.forEach(function (p) {
      var h = b.text(function () { return at; }, "", { pos: p, color: color, offset: typeof off === "number" ? off : off[p], cls: "sb-noptr sb-tag" });
      var t = h.node.firstChild || h.node;
      var tn = document.createTextNode("");
      t.appendChild(tn);
      setShown(h, false);
      items[p] = h; tns[p] = tn;
    });
    return {
      set: function (str, a, pos) {
        at = a;
        if (pos !== cur) {
          if (cur) setShown(items[cur], false);
          cur = pos;
          setShown(items[pos], true);
        }
        setText(tns[pos], str);
      },
      hide: function () { if (cur) { setShown(items[cur], false); cur = null; } },
      text: function () { return cur ? tns[cur].nodeValue : ""; }
    };
  }
  // 虚线旁的标注（「析出 x g」「每 100 g 水多 x g」）：字号 13px（.sb-tag），各方位离锚点的距离。
  // 写在空心点上方时多留一点，不压着空心点的描边
  var TAG_FS = 13;
  var TAG_OFF = { e: 12, w: 12, n: 14, s: 12, ne: 12, nw: 12, se: 12, sw: 12 };
  var TAG_POS = ["e", "w", "n", "s", "ne", "nw", "se", "sw"];
  // 标注的外框（屏幕 px，按字数估宽、按字号估高，不量 DOM）：对齐方式和 svgkit 的 placeText 一样
  // （n：基线在锚点上方 off；s：dy 0.8em；其余：dy 0.35em）。字形上沿约在基线上 0.92em，下沿约在基线下 0.3em
  function tagBox(b, at, pos, w) {
    var c = b.toScreen(at), off = TAG_OFF[pos], fs = TAG_FS, x0, base;
    if (pos.indexOf("e") >= 0) x0 = c[0] + off; else if (pos.indexOf("w") >= 0) x0 = c[0] - off - w; else x0 = c[0] - w / 2;
    if (pos.indexOf("n") >= 0) base = c[1] - off; else if (pos.indexOf("s") >= 0) base = c[1] + off + 0.8 * fs; else base = c[1] + 0.35 * fs;
    return [x0, base - 0.92 * fs, x0 + w, base + 0.3 * fs];
  }
  // 外框和溶解度曲线有没有重叠（留 3 px，文字的白边也算进去）。曲线单调上升：外框横跨的那段温度里，
  // 曲线在屏幕上的高度就在两端之间，和外框的上下沿比一比就行（曲线只画在 [t0, t1] 里）
  function hitsCurve(b, sub, box, t0, t1) {
    var pad = 3;
    var ta = Math.max(b.toWorld([box[0] - pad, 0])[0], t0), tb = Math.min(b.toWorld([box[2] + pad, 0])[0], t1);
    if (ta > tb) return false;
    var top = b.toScreen([tb, C.solubility(sub, tb)])[1], bot = b.toScreen([ta, C.solubility(sub, ta)])[1];
    return !(bot < box[1] - pad || top > box[3] + pad);
  }
  // 在候选位置里挑第一个「整个在画区里、又不压着曲线」的；都压着时取第一个在画区里的。
  // 写在点正上方 / 正下方（n、s，文字居中）时，靠近左右边缘可以整体往里挪一点，只要文字还盖着这个点的横坐标
  function pickPlace(b, cands, str, subs, t0, t1) {
    var plot = b.size().plot, w = textW(str, TAG_FS), first = null, lo = plot[0] + 2, hi = plot[2] + 2;
    for (var i = 0; i < cands.length; i++) {
      var cd = cands[i], bx = tagBox(b, cd.at, cd.pos, w), hit = false;
      if ((cd.pos === "n" || cd.pos === "s") && (bx[0] < lo || bx[2] > hi)) {
        var dx = bx[0] < lo ? lo - bx[0] : hi - bx[2];
        if (Math.abs(dx) > w / 2 - 6) continue;
        var cx = b.toScreen(cd.at)[0] + dx;
        cd = { at: [b.toWorld([cx, 0])[0], cd.at[1]], pos: cd.pos };
        bx = [bx[0] + dx, bx[1], bx[2] + dx, bx[3]];
      }
      if (bx[0] < lo || bx[2] > hi || bx[1] < plot[1] || bx[3] > plot[3] - 2) continue;
      if (!first) first = cd;
      for (var j = 0; j < subs.length && !hit; j++) hit = hitsCurve(b, subs[j], bx, t0, t1);
      if (!hit) return cd;
    }
    return first || cands[0];
  }
  // 虚线旁的标注写在哪里（subs：板上要避开的曲线，t1：曲线画到的温度）。
  //   虚线够长：先试虚线中点左边（曲线往右上升，状态点在曲线上方时左边是空的），再试空心点上方、中点右边……
  //   虚线太短（NaCl 的曲线很平，或刚过曲线）：先试空心点上方，再试实心点下方。
  // 每个位置都核对一遍：不出画区、不压在曲线（和贴着曲线的路线）上。手机上画板窄，左边常常放不下，
  // 以前退到中点右边，正好压在往右上升的曲线上
  function pptPlace(b, T, y0, y1, str, subs, t1) {
    var a = b.toScreen([T, y0]), c = b.toScreen([T, y1]);
    var top = [T, y1], bot = [T, y0], mid = [T, (y0 + y1) / 2], cands;
    if (Math.abs(a[1] - c[1]) >= 24) {
      cands = [{ at: mid, pos: "w" }, { at: top, pos: "n" }, { at: top, pos: "nw" }, { at: top, pos: "ne" },
        { at: mid, pos: "e" }, { at: bot, pos: "se" }, { at: bot, pos: "s" }, { at: top, pos: "w" }, { at: top, pos: "e" }];
    } else {
      cands = [{ at: top, pos: "n" }, { at: top, pos: "nw" }, { at: top, pos: "ne" },
        { at: bot, pos: "s" }, { at: bot, pos: "se" }, { at: bot, pos: "sw" }, { at: top, pos: "w" }, { at: top, pos: "e" }];
    }
    return pickPlace(b, cands, str, subs, 0, t1);
  }
  // 「恰好饱和」写在点的旁边：右边放得下就放右边
  function sidePlace(b, p, str) {
    var c = b.toScreen(p), plot = b.size().plot;
    return { at: p, pos: plot[2] - c[0] > textW(str, 13) + 24 ? "e" : "w" };
  }
  // 「恰好饱和」：曲线在屏幕上陡（KNO₃）时写在点的旁边，和曲线分得开；曲线平（NaCl）时写在旁边会压在曲线上，
  // 改写在点的上方（贴着上沿时写在下方）
  function satPlace(b, sub, p, str) {
    var dT = 0.5, k = Math.abs(C.solubility(sub, p[0] + dT) - C.solubility(sub, p[0] - dT)) / (2 * dT) * kOf(b, 1) / kOf(b, 0);
    if (k >= 0.6) return sidePlace(b, p, str);
    var c = b.toScreen(p), plot = b.size().plot;
    return { at: p, pos: c[1] - plot[1] > 34 ? "n" : "s" };
  }

  // 小烧杯：水面高度跟水的质量走，杯底的晶体个数跟析出质量走（unit 克一颗，至少一颗）。
  // 晶体一次建好（最多 48 颗，从杯底中间往上堆），拖动时只改 visibility，不建节点
  function beaker(host, unit) {
    if (!host) return { set: function () {} };
    var svg = svgEl("svg", { viewBox: "0 0 100 120", focusable: "false", "aria-hidden": "true" });
    var liq = svgEl("rect", { "class": "sb-bk-liq", x: 17, width: 66, y: 35, height: 78 }, svg);
    var surf = svgEl("line", { "class": "sb-bk-surf", x1: 17, x2: 83, y1: 35, y2: 35 }, svg);
    [35, 54.5, 74, 93.5].forEach(function (y) { svgEl("line", { "class": "sb-bk-mark", x1: 18, x2: 25, y1: y, y2: y }, svg); });
    var pos = [];
    for (var r = 0; r < 6; r++) {
      var n = 11 - r;
      for (var i = 0; i < n; i++) pos.push({ r: r, x: 50 + (i - (n - 1) / 2) * 6.2, y: 109.6 - r * 4.6 });
    }
    pos.sort(function (a, b) { return a.r - b.r || Math.abs(a.x - 50) - Math.abs(b.x - 50) || a.x - b.x; });
    pos = pos.slice(0, 48);
    var xg = svgEl("g", null, svg), xs = pos.map(function (p) {
      var d = "M" + f1(p.x - 3.3) + " " + f1(p.y) + "L" + f1(p.x) + " " + f1(p.y - 2.6) + "L" + f1(p.x + 3.3) + " " + f1(p.y) + "L" + f1(p.x) + " " + f1(p.y + 2.6) + "Z";
      return svgEl("path", { "class": "sb-bk-x", d: d, visibility: "hidden" }, xg);
    });
    svgEl("path", { "class": "sb-bk-glass", d: "M8 9 L16 12 L16 108 Q16 114 22 114 L78 114 Q84 114 84 108 L84 12 L92 9" }, svg);
    host.appendChild(svg);
    var lastW = -1, lastK = 0;
    return {
      set: function (W, ppt) {
        if (W !== lastW) {
          lastW = W;
          var y = 113 - 78 * clamp(W, 0, 100) / 100;
          liq.setAttribute("y", f1(y)); liq.setAttribute("height", f1(113 - y));
          surf.setAttribute("y1", f1(y)); surf.setAttribute("y2", f1(y));
        }
        var k = ppt > 1e-9 ? Math.min(xs.length, Math.max(1, Math.round(ppt / unit))) : 0;
        if (k !== lastK) {
          for (var j = Math.min(k, lastK); j < Math.max(k, lastK); j++) xs[j].setAttribute("visibility", j < k ? "visible" : "hidden");
          lastK = k;
        }
      },
      crystals: function () { return lastK; }
    };
  }

  // 读数区：温度、溶解度 S、状态（data-status）、析出晶体的质量、溶质质量分数（1 位小数）。suf：compare 的两列（-KNO3 / -NaCl）
  function readout(rootId, suf) {
    var root = $(rootId), sfx = suf ? "-" + suf : "";
    function q(k) { return root ? root.querySelector('[data-r="' + k + sfx + '"]') : null; }
    var stEl = q("status");
    var tn = { T: textOf(q("T")), S: textOf(q("S")), status: textOf(stEl), ppt: textOf(q("ppt")), w: textOf(q("w")) };
    var last = null;
    return {
      set: function (s, own) {
        setText(tn.T, fx(s.T, 1) + "℃");
        setText(tn.S, fx(s.S, 1) + " g");
        setText(tn.ppt, fx(s.precipitate, 1) + " g");
        setText(tn.w, fx(s.fraction, 1) + "%");
        if (s.status !== last) {
          last = s.status;
          setText(tn.status, STATUS_TEXT[s.status] || "");
          if (stEl) stEl.setAttribute("data-status", s.status);
          if (root && own !== false) root.setAttribute("data-status", s.status);
        }
      }
    };
  }

  // 水平拖动的约束（cool、nacl：只改温度）。纵坐标由 y() 现取（溶质总量、水的质量变了，点跟着上下移）。
  //   拖动：离碰到曲线的温度 target() 不到 0.4℃ 吸到曲线上；否则离整十度不到 0.3℃ 吸到整十度（先算曲线：0.3 < 0.4，
  //   吸到整十度也不会越过曲线，盖不掉曲线的吸附）；其余按 0.1℃ 取整（读数和状态始终对得上）。
  //   按温度、不按像素：手机上 1℃ 不到 3 px，8 px 就是 ±3℃，状态点在曲线两边各卡住 3℃，析出量从 0 一下子跳到约 7 g。
  //   键盘（along）：一步跨过曲线或落在离它不到半步的地方就停在曲线上；svgkit 随后会对目标点再投影一次，
  //   这时按原样返回（kbd 记着目标），不再吸附，下一步能照常走开。hold(T) 同理：程序里改位置时不吸附
  function hCons(o) {
    var kbd = null;
    function res(T) { return { p: [T, o.y()], T: T, s: T - o.x0 }; }
    function snap(T) {
      var t = o.target();
      if (t != null && Math.abs(T - t) < CURVE_SNAP) return t;
      var t10 = Math.round(T / 10) * 10;
      if (Math.abs(T - t10) < TEN_SNAP) return t10;
      return round(T, 1);
    }
    return {
      kind: "segment",
      project: function (p) {
        var T = clamp(p[0], o.x0, o.x1);
        if (kbd !== null && Math.abs(T - kbd) < 1e-9) { T = kbd; kbd = null; return res(T); }
        kbd = null;
        return res(clamp(snap(T), o.x0, o.x1));
      },
      along: function (m, ds) {
        var T0 = m && typeof m.T === "number" ? m.T : o.x0;
        var T = clamp(T0 + ds, o.x0, o.x1), t = o.target();
        if (t != null && t !== T0 && Math.abs(ds) <= 10 && ((T0 - t) * (T - t) < 0 || Math.abs(T - t) < Math.abs(ds) * KBD_SNAP)) T = t;
        else if (Math.abs(T - Math.round(T)) > 1e-9) T = round(T, 1);
        kbd = T;
        return res(T);
      },
      span: function () { return { key: "T", min: o.x0, max: o.x1 }; },
      hold: function (T) { kbd = T; }
    };
  }

  // 状态点的读屏文字：温度、每 100 g 水中的量、状态
  function ariaOf(name, T, per100, status) {
    return name + "：温度 " + fx(T, 1) + "℃，每 100 g 水中 " + fx(per100, 1) + " g，" + (STATUS_TEXT[status] || "");
  }

  /* ==================== 情境 cool：降温结晶（预测关卡 cb-state） ==================== */
  var cool = (function () {
    var SUB = "KNO3", W = 100, T0 = 60, M0 = 80, X0 = 0, X1 = 100, Y1 = 250;
    var wrap = $("solub-cool-boards"), host = $("solub-cool-board"), panel = $("solub-cool");
    var read = readout("solub-cool-read", ""), bk = beaker($("solub-cool-beaker"), 2);
    var mText = textOf($("solub-cool-m")), advNote = $("solub-cool-adv-note"), ctl = null;
    var st = {
      T: T0, m: M0, s: null, cr: null, minT: T0, maxT: T0,
      seen: { unsat: false, sat: false, crystal: false }, seq: 0,
      // 预测关卡挂上之前先按锁定处理：引擎加载题库要一会儿，这期间拖动的结果不算数。引擎没加载成功时放开（见文件末尾）
      locked: !!(Q && typeof Q.registerExternal === "function"),
      pct: -1, doneSent: false
    };
    var g = null, P = null, cons = null, dash = null, solPt = null, tag = null, satTag = null;
    var target = null, api = null, stage = "";

    function per100() { return st.m * 100 / W; }
    function calcTarget() { target = tidy(C.tempForSolubility(SUB, per100())); }

    function build() {
      destroyBoard(g);
      calcTarget();
      g = solBoard(host, [X0, X1, 0, Y1], ticks(0, 100, 20), ticks(0, 240, 40), "KNO₃ 的溶解度曲线和状态点");
      // 溶液实际组成的点走过的路线（解锁后拖过的温度范围）：不饱和时就是状态点本身，析出晶体后贴着曲线。
      // 宽而淡，画在曲线下面；和「实际结果」图里的轨迹是同一条（coolPath）
      g.fn(function (T) { return Math.min(per100(), C.solubility(SUB, T)); }, {
        domain: function () { return [st.minT, st.maxT]; }, color: "blue", width: 9, cls: "sb-noptr sb-trail"
      });
      g.polyline(C.curvePoints(SUB, 0, 100, 100), { color: "blue", width: 2.5, cls: "sb-noptr" });
      dash = g.segment(function () { return [st.T, st.s ? st.s.S : 0]; }, function () { return [st.T, per100()]; }, { dash: true, color: "coral", width: 2, cls: "sb-noptr" });
      solPt = g.point(function () { return [st.T, st.s ? st.s.S : 0]; }, { r: 5, color: "blue", cls: "sb-noptr" });
      setShown(dash, false); setShown(solPt, false);
      tag = mkTag(g, "coral", TAG_POS, TAG_OFF);
      satTag = mkTag(g, "green", ["e", "w", "n", "s"], 18);
      cons = hCons({ x0: X0, x1: X1, y: per100, target: function () { return target; } });
      P = g.point([st.T, per100()], {
        draggable: true, r: 7, hit: 24, step: 1, color: "blue", cls: "sb-hollow",
        constrain: cons,
        ariaLabel: "可拖动的状态点：左右拖动改变温度",
        ariaText: function (pt, m) {
          var T = m && typeof m.T === "number" ? m.T : pt.get()[0];
          return ariaOf("KNO₃ 的状态点", T, per100(), C.state(SUB, T, W, st.m).status);
        }
      });
      P.on("drag", function () { sync(true); });
      // 拖动结束补一次：最后一个 pointermove 没赶上 rAF 帧时，读数也对齐到状态点的最终位置
      P.on("end", function () { sync(false); });
      if (st.locked) P.enable(false);
      st.cr = null;
      sync(false);
    }

    // 走过的状态：按「不饱和 → 碰到曲线 → 析出」的顺序记（任务完成条件）。
    // 一帧里直接从不饱和跳到有晶体（手指划得快，没落进吸附范围）也算碰到过曲线：两次之间状态点一定穿过了曲线
    function track(prev, now) {
      var crossed = !!prev && ((prev === "unsat" && now === "crystal") || (prev === "crystal" && now === "unsat"));
      st.seen[now] = true;
      if (crossed) st.seen.sat = true;
      if (st.seq === 0 && now === "unsat") st.seq = 1;
      if (st.seq === 1 && (now === "sat" || (crossed && now === "crystal"))) st.seq = 2;
      if (st.seq === 2 && now === "crystal") st.seq = 3;
      if (st.seq >= 3) markTask("cool");
    }

    function sync(fromDrag) {
      var m = typeof P.meta === "function" ? P.meta() : null;
      var T = m && typeof m.T === "number" ? m.T : P.get()[0];
      var prev = st.s ? st.s.status : null;
      var s = C.state(SUB, T, W, st.m);
      st.T = T; st.s = s;
      if (!st.locked) {
        if (T < st.minT) st.minT = T;
        if (T > st.maxT) st.maxT = T;
        track(prev, s.status);
      }
      read.set(s);
      bk.set(W, s.precipitate);

      // 隐性支架：曲线上方 → 实心点（溶液实际组成的点）+ 竖直虚线 +「析出 x g」（水是 100 g，每 100 g 水多出的量就是析出的量）；
      // 在曲线上 →「恰好饱和」
      var cr = s.status === "crystal";
      if (cr !== st.cr) { st.cr = cr; setShown(dash, cr); setShown(solPt, cr); }
      if (cr) {
        var str = "析出 " + fx(s.precipitate, 1) + " g", pl = pptPlace(g, T, s.S, s.per100, str, [SUB], X1);
        tag.set(str, pl.at, pl.pos);
      } else tag.hide();
      if (s.status === "sat") {
        var sp = satPlace(g, SUB, [T, s.per100], "恰好饱和");
        satTag.set("恰好饱和", sp.at, sp.pos);
      } else satTag.hide();

      // 预测关卡的进度：[22, 58] 这一段被走过的温度范围盖住了多少（引擎只在「动手」阶段显示，别的时候调用也没关系）
      if (api && !st.locked && !st.doneSent) {
        var cov = clamp((Math.min(st.maxT, GATE_HIGH) - Math.max(st.minT, GATE_LOW)) / (GATE_HIGH - GATE_LOW), 0, 1);
        var ok = st.minT <= GATE_LOW + 1e-9 && st.maxT >= GATE_HIGH - 1e-9;
        if (ok) cov = 1;
        var pct = Math.round(cov * 100);
        // 百分数变了才报：引擎每次都会改进度文字，拖动时少改几次 DOM
        if (pct !== st.pct) { st.pct = pct; api.onProgress(cov); }
        if (ok) { st.doneSent = true; api.done(); markTask("cool"); }
      }

      if (!fromDrag) g.update();
    }

    // 进阶：一共加入的 KNO₃（20～200 g）。预测关卡进行中（预测、动手、对比、解释）固定为 80 g：
    // 实际结果图和完成条件都按 80 g；做完（反馈）或做过（free）才能改
    function advOpen() { return !st.locked && (!api || stage === "free" || stage === "feedback"); }
    function paintAdv() {
      var open = advOpen();
      var inp = ctl && ctl.node ? ctl.node.querySelector("input") : null;
      if (inp) inp.disabled = !open;
      if (advNote) advNote.hidden = open;
    }
    function setM(v) {
      v = clamp(Math.round(+v || M0), 20, 200);
      if (ctl) ctl.set("m", v);
      setText(mText, String(v));
      if (v === st.m) return;
      st.m = v;
      calcTarget();
      // 溶质总量变了：路线从当前温度重新画；状态点只上下移，温度不动（不吸附）
      st.minT = st.T; st.maxT = st.T;
      cons.hold(st.T);
      P.set([st.T, per100()]);
      sync(false);
    }
    var ctlHost = $("solub-cool-ctl");
    if (ctlHost && typeof S.controls === "function") {
      ctl = S.controls(ctlHost, [{ id: "m", label: "一共加入的 KNO₃（g）", min: 20, max: 200, step: 1, value: M0 }], function (v) {
        if (!advOpen()) { ctl.set("m", st.m); return; }
        setM(v.m);
      });
    }

    function lock() {
      st.locked = true;
      if (P) P.enable(false);
      wrap.classList.add("sb-locked");
      if (panel) panel.classList.add("sb-locked");
      paintAdv();
    }
    function unlock() {
      st.locked = false;
      if (P) P.enable(true);
      wrap.classList.remove("sb-locked");
      if (panel) panel.classList.remove("sb-locked");
      // 解锁以后才记走过的温度范围（完成条件「解锁期间到过 ≤ 22℃ 和 ≥ 58℃」）
      st.minT = st.T; st.maxT = st.T;
      st.s = null;
      sync(false);
      paintAdv();
    }
    // 重新预测：溶质回到 80 g、温度回到 60℃，走过的范围、进度清零（done 可以再报一次）
    function reset() {
      st.m = M0; calcTarget();
      if (ctl) ctl.set("m", M0);
      setText(mText, String(M0));
      cons.hold(T0);
      P.set([T0, per100()]);
      st.minT = T0; st.maxT = T0; st.pct = -1; st.doneSent = false;
      st.seen = { unsat: false, sat: false, crystal: false }; st.seq = 0; st.s = null;
      sync(false);
      paintAdv();
    }
    // 「实际结果」：和预测选项的缩略图同一个视野、同样的坐标轴（view [0,70,0,130]，KNO₃ 曲线浅色参照），
    // 画溶液实际组成的点从 60℃ 到 20℃ 的轨迹 coolPath（先水平，约 47.6℃ 碰到曲线后沿曲线下滑）。
    // 关卡进行中溶质总量锁在 80 g，和板上拖出来的路线一致
    function result() {
      return {
        figure: {
          view: [0, 70, 0, 130], aspect: "fill", pad: [18, 44, 18, 18],
          axes: { x: "T/℃", y: "g", xt: [20, 60], yt: [80] },
          items: [
            { t: "polyline", pts: C.curvePoints(SUB, 0, 66, 33), color: "muted" },
            { t: "polyline", pts: C.coolPath(SUB, M0, W, T0, 20) }
          ]
        },
        // 对比图下的说明（引擎缺省写「你刚才拖出来的图象」）：轨迹是溶液实际组成的点，不是一直水平走的空心点（和题干、图例的说法一致）
        note: "溶液实际组成的点走过的路线（60℃ → 20℃）"
      };
    }

    if (st.locked) { wrap.classList.add("sb-locked"); if (panel) panel.classList.add("sb-locked"); }
    build();
    paintAdv();
    return {
      resize: function () { if (g) g.resize(); },
      get: function () {
        var s = st.s || C.state(SUB, st.T, W, st.m);
        return {
          T: st.T, m: st.m, W: W, S: s.S, per100: s.per100, status: s.status, precipitate: s.precipitate,
          dissolved: s.dissolved, fraction: s.fraction, minT: st.minT, maxT: st.maxT,
          seen: { unsat: st.seen.unsat, sat: st.seen.sat, crystal: st.seen.crystal }, seq: st.seq,
          touchT: target, locked: st.locked, stage: stage || null, gateDone: st.doneSent, done: !!TASKS.cool,
          label: tag ? tag.text() : ""
        };
      },
      boards: function () { return { board: g, curve: g }; },
      handle: function () { return P; },
      bind: function (a) { api = a; return { lock: lock, unlock: unlock, reset: reset, result: result }; },
      setStage: function (s) {
        stage = s || "";
        if (stage === "feedback") markTask("cool");
        paintAdv();
      },
      bound: function () { return !!api; },
      free: function () { api = null; unlock(); }
    };
  })();
  PANELS.cool = cool;

  /* ==================== 情境 compare：两条曲线与交点 ==================== */
  var compare = (function () {
    var W = 100, X1 = 60, Y1 = 120;
    var CR = C.crossing();
    CR = { T: CR.T, S: CR.S };
    var SUBS = ["KNO3", "NaCl"], COL = { KNO3: "blue", NaCl: "green" };
    var host = $("solub-compare-board"), readEl = $("solub-compare-read");
    var hintEl = $("solub-compare-hint"), hintText = textOf(hintEl);
    var eqEl = readEl ? readEl.querySelector("[data-solub-equal]") : null;
    var picks = Array.prototype.slice.call(document.querySelectorAll("[data-solub-pick]"));
    var heads = {}, reads = {}, bks = {};
    var st = {
      active: "KNO3", kbd: false, equal: false, both: false, hint: null, status: "unsat",
      // 起点：两份都不饱和、温度不同（「都到交点温度」要学生自己拖出来），离两条曲线都远：
      // NaCl 以前在 (10, 20)，正好落在 KNO₃ 的曲线上（S = 20.9），看着像「KNO₃ 饱和了」
      KNO3: { T: 45, m: 50, s: null, cr: null },
      NaCl: { T: 40, m: 20, s: null, cr: null },
      // 任务：两份都在交点温度恰好饱和过（bothSat），也有过温度都在交点、却不都饱和（notBoth）
      bothSat: false, notBoth: false
    };
    var g = null, P = {}, dash = {}, solPt = {}, tag = null, satTag = null;
    SUBS.forEach(function (sub) {
      heads[sub] = readEl ? readEl.querySelector('thead th[data-sub="' + sub + '"]') : null;
      reads[sub] = readout("solub-compare-read", sub);
      bks[sub] = beaker($("solub-compare-bk-" + sub), 2.5);
    });

    // 点 (T, y) 离这种物质的曲线有多远（屏幕 px，沿法线量）：竖直方向差 |y − S(T)|，按曲线在屏幕上的斜率折算。
    // KNO₃ 的曲线陡，只看竖直方向差会把「看着已经贴着曲线」的点算远
    function perpPx(sub, T, y) {
      var kx = kOf(g, 0), ky = kOf(g, 1), ta = Math.max(0, T - 0.25), tb = Math.min(100, T + 0.25);
      var k = (C.solubility(sub, tb) - C.solubility(sub, ta)) / (tb - ta) * ky / kx;
      return Math.abs(y - C.solubility(sub, T)) * ky / Math.sqrt(1 + k * k);
    }
    // 平面里拖（左右改温度、上下改溶质的质量），夹在视野里。吸附：离交点温度不到 0.6℃ → 交点温度；
    // 离整十度不到 0.3℃ → 整十度；离这种物质的曲线不到 6 px（沿法线）→ 曲线上（恰好饱和，温度不动、竖直吸上去）。
    // 其余按 0.1 取整。键盘（st.kbd，见 build 里的 keydown）：一步 1，吸附只取半步，不会被吸回原处
    function cons(sub) {
      return {
        kind: "box",
        project: function (p) {
          var key = st.kbd;
          var T = clamp(p[0], 0, X1), y = clamp(p[1], 0, Y1);
          var t10 = Math.round(T / 10) * 10;
          if (Math.abs(T - CR.T) < (key ? KBD_SNAP : CROSS_SNAP)) T = CR.T;
          else if (Math.abs(T - t10) < (key ? 1e-9 : TEN_SNAP)) T = t10;
          else T = round(T, 1);
          var Sv = C.solubility(sub, T);
          if (key ? Math.abs(y - Sv) < KBD_SNAP : perpPx(sub, T, y) < CMP_SNAP_PX) y = Sv; else y = round(y, 1);
          return { p: [T, y], T: T, m: y };
        },
        span: function () { return { key: "T", min: 0, max: X1 }; }
      };
    }

    function clearKbd() { st.kbd = false; }

    function build() {
      destroyBoard(g);
      g = solBoard(host, [0, X1, 0, Y1], ticks(0, 60, 10), ticks(0, 120, 20), "KNO₃ 和 NaCl 的溶解度曲线、交点和两个状态点");
      // 交点：竖直虚线落到横轴，交点处标「交点 t℃」（t 由模型算，1 位小数）
      g.segment([CR.T, CR.S], [CR.T, 0], { dash: true, color: "purple", width: 1.2, cls: "sb-noptr" });
      SUBS.forEach(function (sub) { g.polyline(C.curvePoints(sub, 0, X1, 60), { color: COL[sub], width: 2.5, cls: "sb-noptr" }); });
      // 曲线的名字写在曲线外侧的空白处：KNO₃ 在曲线左上方，NaCl 在右端上方
      g.text([50, C.solubility("KNO3", 50)], "KNO₃", { pos: "nw", color: "blue", offset: 8, cls: "sb-noptr" });
      g.text([X1, C.solubility("NaCl", X1)], "NaCl", { pos: "nw", color: "green", offset: 8, cls: "sb-noptr" });
      g.point([CR.T, CR.S], { r: 5, color: "purple", cls: "sb-noptr" });
      g.text([CR.T, CR.S], "交点 " + fx(CR.T, 1) + "℃", { pos: "se", color: "purple", offset: 10, cls: "sb-noptr" });
      SUBS.forEach(function (sub) {
        var o = st[sub];
        dash[sub] = g.segment(function () { return [o.T, o.s ? o.s.S : 0]; }, function () { return [o.T, o.m]; }, { dash: true, color: "coral", width: 2, cls: "sb-noptr" });
        solPt[sub] = g.point(function () { return [o.T, o.s ? o.s.S : 0]; }, { r: 5, color: COL[sub], cls: "sb-noptr" });
        setShown(dash[sub], false); setShown(solPt[sub], false);
        o.cr = null;
      });
      tag = mkTag(g, "coral", TAG_POS, TAG_OFF);
      satTag = mkTag(g, "green", ["e", "w", "n", "s"], 18);
      SUBS.forEach(function (sub) {
        var o = st[sub], name = C.NAME[sub];
        var pt = g.point([o.T, o.m], {
          draggable: true, r: 7, hit: 24, step: 1, color: COL[sub], cls: "sb-hollow",
          constrain: cons(sub),
          ariaLabel: "可拖动的 " + name + " 状态点：左右改温度，上下改溶质的质量",
          ariaText: function (p) { var q = p.get(); return ariaOf(name + " 的状态点", q[0], q[1], C.state(sub, q[0], W, q[1]).status); }
        });
        P[sub] = pt;
        // 键盘移动前先记一下：这一步按键盘的吸附范围算（keydown 先到点自己，再冒泡到 svgkit 的监听）。
        // 只记真会移动这个点的键；手指、鼠标一按下就清掉，拖动总按拖动的吸附算
        if (pt.node && pt.node.addEventListener) {
          pt.node.addEventListener("keydown", function (e) { st.kbd = !!MOVE_KEYS[e.key] && pt.enabled(); });
          pt.node.addEventListener("pointerdown", clearKbd);
          pt.node.addEventListener("mousedown", clearKbd);
          pt.node.addEventListener("touchstart", clearKbd, { passive: true });
        }
        pt.on("drag", function () { sync(sub, true); });
        pt.on("end", function () { st.kbd = false; sync(sub, false); });
      });
      // svgkit 的按键监听挂在 svg 上、比这里先挂（建第一个可拖动的点时）：它处理完这一下按键，键盘标记就清掉，
      // 不管点有没有动（没动时不发 end）
      if (g.svg && g.svg.addEventListener) g.svg.addEventListener("keydown", clearKbd);
      SUBS.forEach(function (sub) { sync(sub, false); });
      pick(st.active);
    }

    function paintTags() {
      var sub = st.active, o = st[sub], s = o.s;
      if (!s) return;
      if (s.status === "crystal") {
        var str = "析出 " + fx(s.precipitate, 1) + " g", pl = pptPlace(g, o.T, s.S, o.m, str, SUBS, X1);
        tag.set(str, pl.at, pl.pos);
      } else tag.hide();
      if (s.status === "sat") {
        var sp = satPlace(g, sub, [o.T, o.m], "恰好饱和");
        satTag.set("恰好饱和", sp.at, sp.pos);
      } else satTag.hide();
    }

    // 读数表的 data-status 跟着当前拖的那一种（变了才改）
    function paintStatus() {
      var o = st[st.active], v = o && o.s ? o.s.status : "";
      if (readEl && v && v !== st.status) { st.status = v; readEl.setAttribute("data-status", v); }
    }
    // 两份溶液的质量分数并排：都在交点温度、都饱和时相同，整行高亮；只是温度相同、不都饱和时各写各的
    function paintCompare() {
      var K = st.KNO3, N = st.NaCl;
      if (!K.s || !N.s) return;
      var both = Math.abs(K.T - CR.T) < 1e-9 && Math.abs(N.T - CR.T) < 1e-9;
      var satK = K.s.status !== "unsat", satN = N.s.status !== "unsat";
      var eq = both && satK && satN;
      st.both = both;
      if (eq !== st.equal) { st.equal = eq; if (eqEl) eqEl.classList.toggle("on", eq); }
      if (both && K.s.status === "sat" && N.s.status === "sat") st.bothSat = true;
      if (both && !(satK && satN)) st.notBoth = true;
      var hint = eq ? "两份都饱和：质量分数相同" : both ? "温度都在交点，但不都饱和：质量分数要看各自溶了多少" : "";
      if (hint !== st.hint) {
        st.hint = hint;
        setText(hintText, hint || " ");
        if (hintEl) hintEl.classList.toggle("is-eq", eq);
      }
      paintStatus();
      if (st.bothSat && st.notBoth) markTask("compare");
    }

    function sync(sub, fromDrag) {
      var o = st[sub], p = P[sub].get();
      o.T = p[0]; o.m = p[1];
      o.s = C.state(sub, o.T, W, o.m);
      reads[sub].set(o.s, false);
      bks[sub].set(W, o.s.precipitate);
      var cr = o.s.status === "crystal";
      if (cr !== o.cr) { o.cr = cr; setShown(dash[sub], cr); setShown(solPt[sub], cr); }
      if (sub === st.active) paintTags();
      paintCompare();
      if (!fromDrag) g.update();
    }

    // 选拖哪一个：另一个照样显示（淡一些）但拖不动、手指落在它上面照常滚动页面
    function pick(sub) {
      if (SUBS.indexOf(sub) < 0 || !P[sub]) return false;
      st.active = sub;
      SUBS.forEach(function (x) {
        var on = x === sub;
        P[x].enable(on);
        if (heads[x]) heads[x].classList.toggle("is-on", on);
      });
      picks.forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-solub-pick") === sub ? "true" : "false"); });
      // 当前拖的点放到最上层：两个点叠在一起（都在交点）时，手指按到的是它
      var n = P[sub].node;
      if (n && n.parentNode && n.parentNode.lastChild !== n) n.parentNode.appendChild(n);
      paintTags();
      paintStatus();
      g.update();
      return true;
    }
    picks.forEach(function (b) {
      b.addEventListener("click", function () { pick(b.getAttribute("data-solub-pick")); });
    });

    build();
    return {
      resize: function () { if (g) g.resize(); },
      get: function () {
        function one(sub) {
          var o = st[sub], s = o.s || C.state(sub, o.T, W, o.m);
          return { T: o.T, m: o.m, S: s.S, status: s.status, precipitate: s.precipitate, fraction: s.fraction };
        }
        return {
          active: st.active, KNO3: one("KNO3"), NaCl: one("NaCl"), cross: { T: CR.T, S: CR.S },
          equal: st.equal, both: st.both, bothSat: st.bothSat, notBoth: st.notBoth, done: !!TASKS.compare
        };
      },
      boards: function () { return { board: g, curve: g }; },
      handle: function (sub) { return P[sub || st.active] || null; },
      pick: pick
    };
  })();
  PANELS.compare = compare;

  /* ==================== 情境 nacl：NaCl 与蒸发结晶 ==================== */
  var nacl = (function () {
    // 纵轴 0～80 g（只有这块板）：水最少剩 50 g 时，每 100 g 水中的总量是 37.3 × 100 ÷ 50 = 74.6 g，状态点和虚线
    // 一直画在板上、按比例（SPEC 写的 0～50 g 画不下蒸发以后的状态点）
    var SUB = "NaCl", M = 37.3, T0 = 60, W0 = 100, WMIN = 50, DW = 10, X0 = 0, X1 = 100, Y1 = 80;
    var host = $("solub-nacl-board");
    var read = readout("solub-nacl-read", ""), bk = beaker($("solub-nacl-beaker"), 0.5);
    var wText = textOf($("solub-nacl-w")), capText = textOf($("solub-nacl-cap"));
    var evapBtn = document.querySelector("[data-solub-evap]"), resetBtn = document.querySelector("[data-solub-reset]");
    var noteText = textOf($("solub-nacl-note"));
    var st = { T: T0, W: W0, evap: 0, everEvap: false, cooled: false, s: null, cr: null };
    var g = null, P = null, cons = null, dash = null, solPt = null, tag = null, satTag = null, target = null;

    function per100() { return M * 100 / st.W; }
    function calcTarget() { target = tidy(C.tempForSolubility(SUB, per100())); }

    function build() {
      destroyBoard(g);
      calcTarget();
      g = solBoard(host, [X0, X1, 0, Y1], ticks(0, 100, 20), ticks(0, 80, 10), "NaCl 的溶解度曲线和状态点");
      g.polyline(C.curvePoints(SUB, 0, 100, 100), { color: "green", width: 2.5, cls: "sb-noptr" });
      dash = g.segment(function () { return [st.T, st.s ? st.s.S : 0]; }, function () { return [st.T, per100()]; }, { dash: true, color: "coral", width: 2, cls: "sb-noptr" });
      solPt = g.point(function () { return [st.T, st.s ? st.s.S : 0]; }, { r: 5, color: "green", cls: "sb-noptr" });
      setShown(dash, false); setShown(solPt, false);
      tag = mkTag(g, "coral", TAG_POS, TAG_OFF);
      satTag = mkTag(g, "green", ["e", "w", "n", "s"], 18);
      cons = hCons({ x0: X0, x1: X1, y: per100, target: function () { return target; } });
      P = g.point([st.T, per100()], {
        draggable: true, r: 7, hit: 24, step: 1, color: "green", cls: "sb-hollow",
        constrain: cons,
        ariaLabel: "可拖动的状态点：左右拖动改变温度",
        ariaText: function (pt, m) {
          var T = m && typeof m.T === "number" ? m.T : pt.get()[0];
          return ariaOf("NaCl 的状态点", T, per100(), C.state(SUB, T, st.W, M).status);
        }
      });
      P.on("drag", function () { sync(true); });
      P.on("end", function () { sync(false); });
      st.cr = null;
      sync(false);
    }

    function sync(fromDrag) {
      var m = typeof P.meta === "function" ? P.meta() : null;
      var T = m && typeof m.T === "number" ? m.T : P.get()[0];
      var s = C.state(SUB, T, st.W, M);
      st.T = T; st.s = s;
      if (T <= 20 + 1e-9) st.cooled = true;
      read.set(s);
      bk.set(st.W, s.precipitate);
      var cr = s.status === "crystal";
      if (cr !== st.cr) { st.cr = cr; setShown(dash, cr); setShown(solPt, cr); }
      // 虚线的长度是「每 100 g 水」多出来的量（和纵轴一致），旁边就这样写；水不是 100 g 时实际析出的质量不等于它，
      // 实际析出多少只写在读数和烧杯里，免得同一个数一会儿按 100 g 水、一会儿按实际的水算
      if (cr) {
        var str = "每 100 g 水多 " + fx(s.per100 - s.S, 1) + " g", pl = pptPlace(g, T, s.S, s.per100, str, [SUB], X1);
        tag.set(str, pl.at, pl.pos);
      } else tag.hide();
      if (s.status === "sat") {
        var sp = satPlace(g, SUB, [T, s.per100], "恰好饱和");
        satTag.set("恰好饱和", sp.at, sp.pos);
      } else satTag.hide();
      if (st.cooled && st.everEvap) markTask("nacl");
      if (!fromDrag) g.update();
    }

    function paintBtns() {
      var can = st.W - DW >= WMIN - 1e-9;
      if (evapBtn) evapBtn.disabled = !can;
      setText(noteText, can ? "水最少剩 50 g。" : "水只剩 50 g 了，不能再蒸发。点「重置」从头再来。");
    }
    function setW(W) {
      st.W = W;
      calcTarget();
      setText(wText, String(W));
      setText(capText, "水 " + W + " g");
    }
    // 恒温蒸发 10 g 水：温度不动，水少了，每 100 g 水中的总量变大，状态点往上移，析出量按模型算
    function evaporate() {
      if (st.W - DW < WMIN - 1e-9) return false;
      setW(st.W - DW);
      st.evap++; st.everEvap = true;
      cons.hold(st.T);
      P.set([st.T, per100()]);
      sync(false);
      paintBtns();
      return true;
    }
    function reset() {
      setW(W0);
      st.evap = 0;
      cons.hold(T0);
      P.set([T0, per100()]);
      sync(false);
      paintBtns();
    }
    if (evapBtn) evapBtn.addEventListener("click", evaporate);
    if (resetBtn) resetBtn.addEventListener("click", reset);

    build();
    paintBtns();
    return {
      resize: function () { if (g) g.resize(); },
      get: function () {
        var s = st.s || C.state(SUB, st.T, st.W, M);
        return {
          T: st.T, W: st.W, m: M, S: s.S, per100: s.per100, status: s.status, precipitate: s.precipitate,
          dissolved: s.dissolved, fraction: s.fraction, evaporated: st.evap, everEvaporated: st.everEvap, cooled: st.cooled,
          done: !!TASKS.nacl, label: tag ? tag.text() : ""
        };
      },
      boards: function () { return { board: g, curve: g }; },
      handle: function () { return P; },
      evaporate: evaporate,
      reset: reset
    };
  })();
  PANELS.nacl = nacl;

  /* ==================== 初始标签页、深链 ==================== */
  paintTabs();
  pickInitialTab();
  window.addEventListener("abs-auth-changed", function () { TASKS = loadTasks(); paintTabs(); });

  /* ==================== 预测关卡（外部部件 cb-state）、练一练 ==================== */
  function scrollToQid(qid) {
    var t = $("qz-" + qid);
    if (t && t.scrollIntoView) { try { t.scrollIntoView({ block: "start" }); } catch (e) { t.scrollIntoView(true); } }
  }
  function fail(el, text) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    var p = document.createElement("p");
    p.className = "sb-load";
    p.appendChild(document.createTextNode(text));
    el.appendChild(p);
  }

  var gateP = Promise.resolve(null);
  var ansHost = $("qz-cool-ans"), promptHost = $("qz-cool-prompt");
  if (Q && typeof Q.registerExternal === "function" && typeof Q.mount === "function") {
    // 先注册再 mount：卡片按外部部件排版（题干进 promptHost 放在模块图上方，作答区留在 #qz-cool-ans，紧跟在模块图下面）
    Q.registerExternal(WIDGET_ID, {
      cover: $("solub-cool-boards"),
      bind: function (a) { return cool.bind(a); }
    });
    gateP = Promise.resolve().then(function () {
      return Q.mount(ansHost, { items: [QID_POE], mode: "poe", promptHost: promptHost });
    }).then(function (ctrl) {
      var card = ctrl && ctrl.cards && ctrl.cards[0];
      if (!card || !cool.bound()) {
        // 题目没加载成功（或这道题被过滤掉）：不挂预测关卡，情境照常可以拖
        cool.free();
        return ctrl || null;
      }
      // 跟着卡片的阶段放开、锁住「进阶」里的溶质总量（data-stage 是属性变动，不触发 linker 的 childList 监听）
      var el = card.el;
      cool.setStage(typeof card.stage === "function" ? card.stage() : el && el.getAttribute("data-stage"));
      if (el && typeof MutationObserver === "function") {
        new MutationObserver(function () { cool.setStage(el.getAttribute("data-stage")); }).observe(el, { attributes: true, attributeFilter: ["data-stage"] });
      }
      if (HASH_QID === QID_POE) scrollToQid(QID_POE);
      return ctrl;
    }).catch(function (e) {
      if (window.console && console.warn) console.warn("预测关卡加载失败", e);
      cool.free();
      return null;
    });
  } else {
    cool.free();
  }

  // 练一练：默认收起，第一次展开时才 mount（9 道题的图不在打开页面时就画，手机上省时间）。
  // 没加载成功（题库读不到，或读到了却没有 cb 的题）：写一句提示，收起再展开时再试一次
  var MORE_FAIL = "题目没有加载成功，请检查网络后刷新页面。";
  var practice = $("solub-practice"), more = $("solub-more"), moreP = null, moreFailed = false;
  function ensureMore() {
    if (moreP) return moreP;
    if (!Q || typeof Q.mount !== "function" || typeof Q.load !== "function") {
      fail(more, MORE_FAIL);
      moreP = Promise.resolve(null);
      return moreP;
    }
    // cb 里 retest: true 的题（二段式、迁移、逆向），按题库顺序；预测关卡在上面的情境里，不在这里出
    var p = Q.load().then(function (bank) {
      var ids = bank.items.filter(function (it) { return it.module === "cb" && it.retest === true; }).map(function (it) { return it.id; });
      if (!ids.length) throw new Error("题库里没有 cb 的题");
      return Q.mount(more, { items: ids, mode: "practice" }).then(function (ctrl) {
        if (!ctrl || !ctrl.cards || !ctrl.cards.length) throw new Error("没有挂上题目卡片");
        return ctrl;
      });
    }).catch(function (e) {
      if (window.console && console.warn) console.warn("练一练加载失败", e);
      fail(more, MORE_FAIL);
      // 不留着失败的结果：收起再展开时重新读（整份题库都没读到时引擎也不缓存，会重新请求）。
      // 还展开着就等收起时再清：深链打开练一练时 toggle 事件晚到一步，不会紧接着再读一遍
      if (moreP === p) { if (practice && practice.open) moreFailed = true; else moreP = null; }
      return null;
    });
    moreP = p;
    return p;
  }
  if (practice) {
    practice.addEventListener("toggle", function () {
      if (practice.open) ensureMore();
      else if (moreFailed) { moreFailed = false; moreP = null; }
    });
  }
  function openMore() {
    if (practice && !practice.open) practice.open = true;
    return ensureMore();
  }
  // #qz-<题目 id>（导图上的「理解测试」标签、重测页的「回到题目所在页面」都这样链）：卡片异步渲染，渲染完再定位
  if (HASH_QID && HASH_QID !== QID_POE) {
    openMore().then(function () { scrollToQid(HASH_QID); });
  }

  /* ==================== 测试钩子（CONTRACT 第 5 节，只读） ==================== */
  window.__solub = {
    tab: function () { return CUR; },
    show: function (key) { return show(key, false); },
    get: function (key) { var T = PANELS[key || CUR]; return T ? T.get() : null; },
    boards: function (key) { var T = PANELS[key || CUR]; return T ? T.boards() : null; },
    handle: function (key, sub) { var T = PANELS[key || CUR]; return T ? T.handle(sub) : null; },
    tasks: function () { return { cool: !!TASKS.cool, compare: !!TASKS.compare, nacl: !!TASKS.nacl }; },
    gate: function () { return gateP; },
    more: function () { return openMore(); }
  };
})();
