/* ABS-LAB「二次函数实验室」页面脚本（math/quadratic.html）
 *
 * 三个情境（标签页切换，一次只显示一个，每个是一个任务 data-task）：
 *   vertex    顶点式与平移：拖顶点（吸附 0.5）改 h、k，滑块调 a；挂预测关卡 m-m2-poe（外部部件 m2-vertex）；
 *   interval  区间上的最值：y = (x − 1)² + 2，拖 x 轴上的区间窗口，看对称轴在窗口左侧、里面、右侧时最值在哪里；
 *   abc       a、b、c 与图象：调 a、b（c 在「进阶」里），看对称轴 x = −b/(2a) 在 y 轴哪一侧、与 y 轴的交点 (0, c)。
 * 解析式、平移描述、对称轴、区间最值都由 js/quadratic-model.js（window.ABSLabQuadratic）算，和题库、单元测试用的是同一份函数。
 *
 * 为什么这样写：
 *   - 一屏只放一个可拖动对象和一个联动图（SPEC 第 2 节）：vertex 拖顶点、interval 拖窗口手柄，abc 没有可拖动的点，
 *     a、b 两个滑块就是主控件；默认最多 2 个滑块，其余（interval 的 a、h、k，abc 的 c）收进「进阶」。
 *   - 拖动在 svgkit 的 rAF 帧里回调本文件；回调里只改属性和文字节点，不读布局、不建节点、不用 innerHTML，
 *     手机上每帧开销很小（同 js/moving-point.js）。读数用 textNode.nodeValue 改（characterData 变动），
 *     不触发 linker.js 盯着的 childList 变动，拖动时它不会反复刷新。画板上会变的文字（平移描述、最值标注）也这样改：
 *     见 dynText。
 *   - a 不能是 0（不再是二次函数）：滑块落到 0 时按拖动方向跳到 ±0.5（见 zeroSkip）。
 *   - 画板上会动的标注（平移描述、最值、窗口两端的数值、对称轴）不压刻度数字、原点「O」、手柄和别的标注：
 *     每帧给几个候选位置打分，取代价最小的（见「画板标注避让」）。
 * 语法不超过 ES2019，与 shared/*.js 一样用 var + function。
 */
(function () {
  "use strict";

  var S = window.ABSLabSVG;
  var M = window.ABSLabQuadratic;
  var Q = window.ABSLabQuiz;
  var KEYS = ["vertex", "interval", "abc"];
  var PROGRESS_KEY = "math_quad_tasks";
  var WIDGET_ID = "m2-vertex";
  var QID_POE = "m-m2-poe";
  var GATE_H = 2; // 预测关卡的完成条件：顶点到过 h ≥ 2，也到过 h ≤ −2（SPEC 4.2）
  // 对比区「实际结果」小图的视野和坐标轴。预测选项不带缩略图：图上看得出顶点在哪一边，等于给出答案
  var POE_VIEW = [-4.5, 4.5, -3, 7];
  var POE_AXES = { x: "x", y: "y", xt: [-2, 2], yt: [] };

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  // 吸附到 0.5 的倍数；「|| 0」把 −0 变成 0（测试钩子读出来的数不会是 −0）
  function half(v) { return Math.round(v * 2) / 2 || 0; }
  // 数值写法：去掉多余的 0，负号用「−」（模型的 fmt）；a、h、k、x 都是 0.5 的倍数，函数值最多三位小数
  function nf(v) { return M ? M.fmt(v, 3) : String(v); }
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
  // 键盘（方向键）移动：现在的 svgkit 键盘移动也会触发 drag；保险起见下一帧再同步一次（重复同步没有副作用）
  function afterKey(P, fn) {
    if (!P || !P.node || !P.node.addEventListener) return;
    P.node.addEventListener("keydown", function () {
      var raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
      raf(function () { fn(false); });
    });
  }
  // 画板上会变的文字：svgkit 的 text 传一个固定的空字符串，它以后不会再改这段文字（只按 at 重新定位）；
  // 文字由本文件通过文字节点改。opt 对象 svgkit 每次重画时都会重新读 pos、offset，所以位置函数 at(opt) 可以顺手改朝向。
  // at 收到 opt 作参数：svgkit 建元素时就会调用一次 at，那时 dynText 还没返回
  function dynText(board, at, opt) {
    var h = board.text(function () { return at(opt); }, "", opt);
    var t = h.node && h.node.querySelector ? h.node.querySelector("text") : null;
    return { h: h, tn: textOf(t), opt: opt };
  }
  // 滑块 input：锁定时设成 disabled；也用来分辨键盘和手指（见 zeroSkip）
  function ctlInput(ctl, id) {
    return ctl && ctl.node ? ctl.node.querySelector('.sk-ctl[data-id="' + id + '"] input') : null;
  }
  // a 的滑块跳过 0：落到 0 时按移动方向跳到 −0.5 或 0.5。
  // 手指拖：方向按上一次手指给出的值算（rawPrev）；手指停在 0 的位置抖动时，连着收到 0，保持当前这一侧，不会在 ±0.5 之间来回跳。
  // 键盘：从 0.5 按一下「减小」得到 0，方向按当前的值算，跳到 −0.5；从 −0.5 按「增大」得到 0，跳到 0.5，能越过 0
  function zeroSkip(inp, initial) {
    var rawPrev = initial, kbd = false;
    if (inp && inp.addEventListener) {
      inp.addEventListener("keydown", function () { kbd = true; });
      ["pointerdown", "touchstart", "mousedown"].forEach(function (ev) {
        inp.addEventListener(ev, function () { kbd = false; }, { passive: true });
      });
    }
    return {
      fix: function (raw, cur) {
        var out = raw;
        if (raw === 0) {
          var ref = kbd ? cur : rawPrev;
          out = ref > 0 ? -0.5 : ref < 0 ? 0.5 : (cur || 0.5);
        }
        rawPrev = raw;
        kbd = false;
        return out;
      },
      reset: function (v) { rawPrev = v; kbd = false; }
    };
  }

  /* ==================== 画板标注避让 ==================== */
  // 画板上会动的标注（最值、窗口两端的数值、平移描述）给几个候选位置，逐个估一下会压到什么，取代价最小的
  // （同样小取排在前面的）。压到坐标轴刻度数字、原点「O」、拖动手柄、别的标注代价高，压到曲线、坐标轴线代价低。
  // 全部是乘加：toScreen、size 只读 svgkit 记下的数，不读布局；文字宽度按字符估（同 svgkit）。拖动的每一帧都能算
  var TICK_FS = 11; // svgkit 刻度数字的字号（.sk-tick-t）
  // 文字宽度：汉字、全角符号按 1em，其余按 0.6em
  function textW(s, fs) {
    s = String(s == null ? "" : s);
    var w = 0;
    for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) >= 0x2e80 ? fs : 0.6 * fs;
    return w;
  }
  // 画板标注的字号：svgkit 在画板窄于 260px 时缩成 12px
  function labelFs(b) { var z = b.size(); return z.w < 260 ? 12 : 14; }
  // 文字占的矩形（屏幕坐标，含 1.5px 白边）：排法同 svgkit 的 placeText（pos：c n s e w ne nw se sw；off 像素）
  function textRect(p, pos, off, w, fs) {
    var x = pos.indexOf("e") >= 0 ? p[0] + off : pos.indexOf("w") >= 0 ? p[0] - off - w : p[0] - w / 2;
    var y = pos.indexOf("n") >= 0 ? p[1] - off - 0.9 * fs : pos.indexOf("s") >= 0 ? p[1] + off - 0.05 * fs : p[1] - 0.55 * fs;
    return [x - 1.5, y - 1.5, x + w + 1.5, y + fs + 1.5];
  }
  function overlapArea(a, b) {
    var w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    return w > 0 && h > 0 ? w * h : 0;
  }
  // 圆（拖动手柄的光圈、高亮的点）按外接正方形算
  function circleRect(p, r, wt) { return [p[0] - r, p[1] - r, p[0] + r, p[1] + r, wt]; }
  // 刻度间隔：同 svgkit 的 autoTicks（1、2、5、10… 里第一个让刻度数字相距 ≥ 32px 的）
  function tickStep(k) {
    var st = 1, guard = 0;
    while (st * k < 32 && guard++ < 20) st = String(st).charAt(0) === "2" ? st * 2.5 : st * 2;
    return st;
  }
  // 坐标轴带来的障碍：两条轴线、刻度数字、原点「O」。xTicks 为 false 时 x 轴不写刻度数字（interval 画板）
  function axisObstacles(b, view, xTicks) {
    var o = b.toScreen([0, 0]), ax = o[0], ay = o[1];
    var kx = b.toScreen([1, 0])[0] - ax, ky = ay - b.toScreen([0, 1])[1];
    var top = b.toScreen([0, view[3]])[1], bot = b.toScreen([0, view[2]])[1];
    var left = b.toScreen([view[0], 0])[0], right = b.toScreen([view[1], 0])[0];
    var out = [
      [ax - 1.5, top - 10, ax + 1.5, bot, 2],          // y 轴
      [left, ay - 1.5, right + 10, ay + 1.5, 2],       // x 轴
      [ax - 15, ay + 2, ax - 2, ay + 4 + TICK_FS, 8]   // 原点「O」
    ];
    var st = tickStep(ky), v, s, w, i;
    for (i = Math.ceil(view[2] / st - 1e-9); i * st <= view[3] + 1e-9; i++) {
      v = i * st;
      if (v === 0) continue;
      s = nf(v); w = textW(s, TICK_FS); s = b.toScreen([0, v])[1];
      out.push([ax - 6 - w, s - 7, ax - 3, s + 7, 8]);
    }
    if (xTicks) {
      st = tickStep(kx);
      for (i = Math.ceil(view[0] / st - 1e-9); i * st <= view[1] + 1e-9; i++) {
        v = i * st;
        if (v === 0) continue;
        w = textW(nf(v), TICK_FS); s = b.toScreen([v, 0])[0];
        out.push([s - w / 2 - 1, ay + 3, s + w / 2 + 1, ay + 6 + TICK_FS, 8]);
      }
    }
    return out;
  }
  // 曲线 y = f(x) 是不是从矩形里穿过：在矩形的横向范围里取 9 个点，有点落在里面、或相邻两点跨过矩形都算
  function curveHits(b, f, r) {
    var w0 = b.toWorld([r[0], 0])[0], w1 = b.toWorld([r[2], 0])[0], prev = null;
    for (var i = 0; i <= 8; i++) {
      var y = f(w0 + (w1 - w0) * i / 8);
      if (!isFinite(y)) { prev = null; continue; }
      var sy = b.toScreen([0, y])[1], side = sy < r[1] ? -1 : sy > r[3] ? 1 : 0;
      if (side === 0 || (prev !== null && side !== prev)) return true;
      prev = side;
    }
    return false;
  }
  // 线段 A→B（世界坐标）是不是从矩形里穿过：沿线段取 13 个点
  function segHits(b, A, B, r) {
    for (var i = 0; i <= 12; i++) {
      var p = b.toScreen([A[0] + (B[0] - A[0]) * i / 12, A[1] + (B[1] - A[1]) * i / 12]);
      if (p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3]) return true;
    }
    return false;
  }
  // 在候选位置里挑一个。cands：[{ at: 世界坐标, pos, off, bias（可选：这个位置本身的代价，不太想用的位置给一点） }]；
  // obs：障碍矩形 [x0, y0, x1, y1, 代价]；
  // fns：[{ f, w }] 曲线；segs：[{ a, b, w }] 线段。出了画板（svg）代价很高；伸出画图区（网格）一点点代价低
  // （画图区四周还有 20px 留白，写得下）。返回 { c: 候选, r: 矩形 }
  function overflow(r, box) {
    return Math.max(0, box[0] - r[0]) + Math.max(0, r[2] - box[2]) + Math.max(0, box[1] - r[1]) + Math.max(0, r[3] - box[3]);
  }
  function pickPlace(b, cands, text, fs, obs, fns, segs) {
    var z = b.size(), plot = z.plot, best = null, bestCost = Infinity, w = textW(text, fs);
    var svgBox = [1, 1, z.w - 1, z.h - 1], plotBox = [plot[0] - 4, plot[1] - 4, plot[2] + 4, plot[3] + 4];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i], r = textRect(b.toScreen(c.at), c.pos, c.off, w, fs), area = (r[2] - r[0]) * (r[3] - r[1]) || 1, j;
      var out = overflow(r, svgBox), soft = overflow(r, plotBox);
      var cost = (c.bias || 0) + (out > 0 ? 40 + out : 0) + (soft > 0 ? 1 + soft * 0.1 : 0);
      for (j = 0; j < obs.length && cost < bestCost; j++) {
        var a = overlapArea(r, obs[j]);
        if (a > 0) cost += obs[j][4] * (0.5 + a / area);
      }
      for (j = 0; j < (fns || []).length && cost < bestCost; j++) if (curveHits(b, fns[j].f, r)) cost += fns[j].w;
      for (j = 0; j < (segs || []).length && cost < bestCost; j++) if (segHits(b, segs[j].a, segs[j].b, r)) cost += segs[j].w;
      if (cost < bestCost - 1e-9) { bestCost = cost; best = { c: c, r: r }; }
      if (cost === 0) break;
    }
    return best;
  }

  /* ==================== 任务进度（math_quad_tasks） ==================== */
  function loadTasks() {
    var out = { vertex: false, interval: false, abc: false };
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
      try { A.setProgress(PROGRESS_KEY, { vertex: TASKS.vertex, interval: TASKS.interval, abc: TASKS.abc }); } catch (e) { /* 存储不可用：本页照常显示完成 */ }
    }
    paintTabs();
  }

  /* ==================== 标签页 ==================== */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.qd-tabs [role="tab"][data-tab]'));
  var CUR = "vertex";
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
  var HASH_QID = /^#qz-(m-m2-[a-z0-9-]+)$/.test(HASH) ? HASH.slice(4) : "";
  // ?task=vertex|interval|abc 和 #qz-m-m2-poe：同步切到对应面板（linker.js 稍后按 ?task 滚动、高亮这个面板，它得先显示出来）。
  // 两个都有时以 #qz-m-m2-poe 为准：它指名要预测关卡的题干，题干在 vertex 面板里，切到别的面板就滚不到了。
  // 这时把地址里的 task 去掉（linker.js 在本文件之后加载，加载时才读地址）：不然它会去滚那个藏着的面板，把题干滚走
  function dropTaskParam() {
    var kept = String(location.search || "").replace(/^\?/, "").split("&").filter(function (kv) {
      return kv && kv.split("=")[0] !== "task";
    });
    if (kept.join("&") === String(location.search || "").replace(/^\?/, "")) return;
    try {
      history.replaceState(history.state, "", location.pathname + (kept.length ? "?" + kept.join("&") : "") + location.hash);
    } catch (e) { /* 老浏览器：不改地址 */ }
  }
  function pickInitialTab() {
    if (HASH_QID === QID_POE) { show("vertex", false); dropTaskParam(); return; }
    var task = null;
    try { task = new URLSearchParams(location.search).get("task"); } catch (e) {
      var mm = /[?&]task=([a-z]+)/.exec(location.search || "");
      task = mm ? mm[1] : null;
    }
    if (task) show(task, false);
  }

  /* ==================== 画板没加载成功 ==================== */
  if (!S || typeof S.board !== "function" || !S.on || typeof S.controls !== "function" || !M) {
    KEYS.forEach(function (k) {
      var w = $("quad-" + k + "-boards");
      if (w) {
        var p = document.createElement("p");
        p.className = "qd-load";
        p.appendChild(document.createTextNode("画板没有加载成功，请刷新页面再试。"));
        w.parentNode.insertBefore(p, w);
        w.style.display = "none";
      }
    });
    paintTabs();
    pickInitialTab();
    return;
  }

  /* ==================== 情境 vertex：顶点式与平移（预测关卡 m2-vertex） ==================== */
  var vertex = (function () {
    var VIEW = [-6, 6, -6, 8];
    var BOX = [-5, 5, -5, 7];   // 顶点能去的范围：留一圈，抛物线和箭头不贴边
    var wrap = $("quad-vertex-boards"), host = $("quad-vertex-board"), ctlHost = $("quad-vertex-ctl");
    var exprT = textOf($("quad-expr")), shiftT = textOf($("quad-shift")), atT = textOf($("quad-vertex-at"));
    // 「动手」阶段的一行提示：完成条件是顶点到过 x = 2 和 x = −2（进度 0 → 50% → 100%），不说出来学生不知道还差什么
    var hintEl = $("quad-gate-hint");
    var st = {
      a: 1, h: 0, k: 0, expr: "", shift: "", at: "", minH: 0, maxH: 0, pos: false, neg: false, arrow: null,
      // 预测关卡挂上之前先按锁定处理：引擎加载题库要一会儿，这期间拖动的结果不算数。引擎没加载成功时放开（见文件末尾）
      locked: !!(Q && typeof Q.registerExternal === "function"),
      pct: -1, doneSent: false
    };
    var b = null, V = null, shaft = null, head = null, lab = null, ctl = null, inpA = null, zs = null;
    var api = null, stage = "";

    // 箭头按像素定尺寸（世界单位里的长短随屏幕大小变）：箭头尖停在顶点圆点外面 10px，箭头头部长 11px、半宽 5.5px。
    // 只做乘法（toScreen 不读布局）；h、k 或缩放变了才重算
    var aKey = "", aGeo = null;
    function arrowGeo() {
      var kx = b.toScreen([1, 0])[0] - b.toScreen([0, 0])[0];
      var key = st.h + "|" + st.k + "|" + kx;
      if (key === aKey) return aGeo;
      aKey = key;
      var L = Math.sqrt(st.h * st.h + st.k * st.k), Lp = L * kx;
      if (!(kx > 0) || Lp < 30) { aGeo = null; return null; }
      var ux = st.h / L, uy = st.k / L, gap = 10 / kx, hl = 11 / kx, hw = 5.5 / kx;
      var tip = [st.h - ux * gap, st.k - uy * gap], bs = [tip[0] - ux * hl, tip[1] - uy * hl];
      aGeo = { base: bs, head: [tip, [bs[0] - uy * hw, bs[1] + ux * hw], [bs[0] + uy * hw, bs[1] - ux * hw]] };
      return aGeo;
    }
    function shaftEnd() { var g = arrowGeo(); return g ? g.base : [0, 0]; }
    function headPts() { var g = arrowGeo(); return g ? g.head : []; }
    // 平移描述写在箭头旁边，沿箭头的法线方向往外放（文字从箭头往法线那边伸出去，不会横压在箭头上）：
    // 优先写在开口的反方向那一侧（开口向上写在箭头下方，抛物线在顶点上方，下方空着；开口向下写在上方），
    // 箭头竖直时写在右边（不压 y 轴左边的刻度数字）；正下方时离得远一点，让开 x 轴下面的刻度数字。
    // 先放在箭头中点；压到刻度数字、y 轴、顶点、抛物线时（顶点离得远、文字又长的时候会这样），
    // 沿箭头前后挪，或者换到另一侧（见 pickPlace）
    var labKey = "", labPick = null;
    // 方向 (px, py) 对应的文字位置（svgkit 的 pos：n s e w ne nw se sw）
    function dirPos(px, py, dflt) { return (py < -0.3 ? "s" : py > 0.3 ? "n" : "") + (px > 0.3 ? "e" : px < -0.3 ? "w" : "") || dflt; }
    function labAt(o) {
      var L = Math.sqrt(st.h * st.h + st.k * st.k);
      if (!(L > 0) || !b) return [st.h / 2, st.k / 2];
      var z = b.size(), key = [st.h, st.k, st.a, st.shift, z.w, z.h, z.plot[0], z.plot[1]].join("|");
      if (key !== labKey || !labPick) {
        labKey = key;
        var nx = -st.k / L, ny = st.h / L;           // 箭头方向转 90°
        if (ny === 0 ? nx < 0 : (ny > 0) === (st.a > 0)) { nx = -nx; ny = -ny; }
        var cands = [], sides = [];
        [1, -1].forEach(function (sg) { sides.push(dirPos(nx * sg, ny * sg, "e")); });
        // 1）箭头旁边（中点优先，再沿箭头前后挪），先开口反方向那一侧，再另一侧
        sides.forEach(function (pos) {
          [0.5, 0.35, 0.65, 0.2, 0.8].forEach(function (t) {
            cands.push({ at: [st.h * t, st.k * t], pos: pos, off: pos === "s" ? 18 : 8 });
          });
        });
        // 2）离箭头远一点（箭头贴着 x 轴时，越过 x 轴下面那一行刻度数字）
        sides.forEach(function (pos) {
          [0.5, 0.35, 0.65].forEach(function (t) { cands.push({ at: [st.h * t, st.k * t], pos: pos, off: 30 }); });
        });
        // 3）写在顶点外面（箭头很短、或者两侧都挤的时候）：开口反方向、箭头方向和它两边斜 45°，让开顶点的光圈
        var ux = st.h / L, uy = st.k / L, r2 = Math.SQRT1_2, V0 = [st.h, st.k];
        [st.a > 0 ? "s" : "n", dirPos(ux, uy, "e"), dirPos((ux - uy) * r2, (ux + uy) * r2, "e"), dirPos((ux + uy) * r2, (uy - ux) * r2, "e")]
          .forEach(function (pos) { cands.push({ at: V0, pos: pos, off: 20 }); });
        var obs = axisObstacles(b, VIEW, true);
        var vp = b.toScreen([st.h, st.k]);
        obs.push(circleRect(vp, 16, 3), circleRect(vp, 9, 10));   // 顶点：浅色光圈、实心圆点
        obs.push(circleRect(b.toScreen([0, 0]), 5, 3));
        var pk = pickPlace(b, cands, st.shift, labelFs(b), obs, [
          { f: function (x) { return M.valueAt(st.a, st.h, st.k, x); }, w: 4 },
          { f: function (x) { return x * x; }, w: 1.5 }
        ], [{ a: [0, 0], b: [st.h, st.k], w: 2 }]);
        labPick = pk ? pk.c : cands[0];
      }
      o.pos = labPick.pos; o.offset = labPick.off;
      return labPick.at;
    }

    function build() {
      b = S.board(host, {
        view: VIEW, aspect: "equal", height: "auto", maxHeight: "56vh",
        axes: { x: "x", y: "y" }, grid: true, pad: 20, ariaLabel: "抛物线 y = a(x − h)² + k 和可拖动的顶点"
      });
      // 参照 y = x²：浅色虚线；静态图形都加 qd-noptr，挡不住顶点的触控圈
      b.fn(function (x) { return x * x; }, { color: "muted", dash: true, width: 1.5, cls: "qd-noptr" });
      b.fn(function (x) { return M.valueAt(st.a, st.h, st.k, x); }, { color: "blue", width: 3, cls: "qd-noptr" });
      shaft = b.segment([0, 0], shaftEnd, { color: "purple", width: 2.5, cls: "qd-noptr qd-arrow" });
      head = b.polygon(headPts, { color: "purple", fill: true, width: 1, cls: "qd-noptr qd-arrow" });
      lab = dynText(b, labAt, { pos: "s", offset: 18, color: "purple", cls: "qd-noptr" });
      b.point([0, 0], { r: 3, color: "muted", cls: "qd-noptr" });
      V = b.point([0, 0], {
        draggable: true, r: 7, hit: 24, step: 0.5,
        constrain: S.on.all(S.on.box(BOX), S.on.grid(0.5)),
        ariaLabel: "可拖动的顶点",
        ariaText: function () { return "顶点 (" + nf(st.h) + ", " + nf(st.k) + ")，" + M.formatVertex(st.a, st.h, st.k); },
        color: "blue"
      });
      V.on("drag", function () { sync(true); });
      // 拖动结束补一次：最后一个 pointermove 没赶上 rAF 帧时，读数也对齐到顶点的最终位置
      V.on("end", function () { sync(false); });
      afterKey(V, sync);
      if (st.locked) V.enable(false);

      ctl = S.controls(ctlHost, [
        { id: "a", label: "a（开口方向和大小）", min: -3, max: 3, step: 0.5, value: st.a }
      ], function (v) {
        var a = zs.fix(v.a, st.a);
        if (a !== v.a) ctl.set("a", a);
        if (a === st.a) return;
        st.a = a;
        sync(false);
      });
      inpA = ctlInput(ctl, "a");
      zs = zeroSkip(inpA, st.a);
      if (inpA && st.locked) inpA.disabled = true;
      sync(false);
    }

    function sync(fromDrag) {
      var p = V.get();
      st.h = p[0]; st.k = p[1];
      var e = M.formatVertex(st.a, st.h, st.k), s = M.shiftText(st.h, st.k), at = nf(st.h) + ", " + nf(st.k);
      if (e !== st.expr) { st.expr = e; setText(exprT, e); }
      if (s !== st.shift) {
        st.shift = s;
        setText(shiftT, s);
        // 画板上不写「不平移」：顶点在原点时没有箭头
        setText(lab.tn, st.h === 0 && st.k === 0 ? "" : s);
      }
      if (at !== st.at) { st.at = at; setText(atT, at); }
      var arrow = !!arrowGeo();
      if (arrow !== st.arrow) { st.arrow = arrow; setShown(shaft, arrow); setShown(head, arrow); }

      // 只记解锁以后（预测之后、或做过预测的自由操作）到过的位置
      if (!st.locked) {
        if (st.h < st.minH) st.minH = st.h;
        if (st.h > st.maxH) st.maxH = st.h;
        if (st.h > 0) st.pos = true;
        if (st.h < 0) st.neg = true;
        // 任务：顶点在 h 的正负两侧都到过（完成预测关卡时一定满足）
        if (st.pos && st.neg) markTask("vertex");
        if (api) {
          // 预测关卡的进度：h ≥ 2、h ≤ −2 各算一半（引擎只在「动手」阶段显示，别的时候调用也没关系）
          var right = st.maxH >= GATE_H, left = st.minH <= -GATE_H;
          var pct = (right ? 50 : 0) + (left ? 50 : 0);
          if (pct !== st.pct && !st.doneSent) { st.pct = pct; api.onProgress(pct / 100); }
          if (right && left && !st.doneSent) { st.doneSent = true; markTask("vertex"); api.done(); }
        }
      }
      if (!fromDrag) b.update();
    }

    function lock() {
      st.locked = true;
      if (V) V.enable(false);
      if (inpA) inpA.disabled = true;
      wrap.classList.add("qd-locked");
    }
    function unlock() {
      st.locked = false;
      if (V) V.enable(true);
      if (inpA) inpA.disabled = false;
      wrap.classList.remove("qd-locked");
    }
    // 重新预测：顶点回到原点、a 回到 1，到过的范围、进度清零（done 可以再报一次）
    function reset() {
      st.a = 1;
      if (ctl) ctl.set("a", 1);
      if (zs) zs.reset(1);
      st.minH = 0; st.maxH = 0; st.pct = -1; st.doneSent = false;
      if (V) V.set([0, 0]);
      sync(false);
    }
    // 「实际结果」：视野 POE_VIEW、坐标轴 POE_AXES，画 y = (x − 2)² 和浅色虚线 y = x²。
    // 点每 0.125 取一个，只留视野里的
    function result() {
      var n = Math.round((POE_VIEW[1] - POE_VIEW[0]) * 8);
      function para(h) { return M.parabolaPoints(1, h, 0, POE_VIEW[0], POE_VIEW[1], n, POE_VIEW[2], POE_VIEW[3]); }
      return {
        figure: {
          view: POE_VIEW.slice(), aspect: "fill", axes: POE_AXES,
          items: [
            { t: "polyline", pts: para(0), color: "muted", dash: true },
            { t: "polyline", pts: para(GATE_H) }
          ]
        },
        // 对比图下的说明（引擎缺省写「你刚才拖出来的图象」）：手机上半宽的格子很窄，分成两行写，
        // 换行处由页面 CSS 的 white-space: pre-line 保留（见 quadratic.html），式子不会从中间折断
        note: "实线是 y = (x − 2)²\n虚线是 y = x²"
      };
    }

    if (st.locked) wrap.classList.add("qd-locked");
    build();
    return {
      resize: function () { if (b) b.resize(); },
      get: function () {
        return { a: st.a, h: st.h, k: st.k, expr: st.expr, shift: st.shift, locked: st.locked, minH: st.minH, maxH: st.maxH,
          stage: stage || null, done: !!TASKS.vertex };
      },
      boards: function () { return b; },
      handle: function () { return V; },
      bind: function (a) { api = a; return { lock: lock, unlock: unlock, reset: reset, result: result }; },
      setStage: function (s) {
        stage = s || "";
        // 提示只在「动手」阶段显示（hidden 是属性变动，不触发 linker 的 childList 监听）
        if (hintEl) hintEl.hidden = stage !== "operate";
        // 做完整个预测关卡（反馈阶段）也算完成任务
        if (stage === "feedback") markTask("vertex");
      },
      bound: function () { return !!api; },
      free: function () { api = null; if (hintEl) hintEl.hidden = true; unlock(); }
    };
  })();
  PANELS.vertex = vertex;

  /* ==================== 情境 interval：区间上的最值 ==================== */
  var interval = (function () {
    // 视野按开口方向取：开口向上时往上多留（端点处的函数值大），开口向下时往下多留。只在 a 变号时重建画板
    var VIEW_UP = [-4, 6, -3, 12], VIEW_DOWN = [-4, 6, -9, 6];
    var o = { a: 1, h: 1, k: 2, w: 2 };
    var CASE_TEXT = { left: "对称轴在区间左侧", inside: "对称轴在区间内", right: "对称轴在区间右侧" };
    var wrap = $("quad-interval-boards"), host = $("quad-interval-board"), ctlHost = $("quad-interval-ctl");
    var caseEl = $("quad-case");
    var exprT = textOf($("quad-int-expr")), rangeT = textOf($("quad-int-range")), caseT = textOf(caseEl);
    var minT = textOf($("quad-min")), maxT = textOf($("quad-max")), minAtT = textOf($("quad-min-at")), maxAtT = textOf($("quad-max-at"));
    var whyT = textOf($("quad-why"));
    var st = {
      x1: 2, x2: 4, ex: null, cs: "", seen: { left: false, inside: false, right: false },
      expr: "", range: "", why: "", minS: "", maxS: "", minAt: "", maxAt: "", lm: "", lx: "", vis: {}
    };
    var VIEW = VIEW_UP, b = null, H = null, ctl = null, zs = null;
    var minPt = null, maxPt = null, twinMax = null, twinMin = null, minLab = null, maxLab = null, x1Lab = null, x2Lab = null, axLab = null;

    function f(x) { return M.valueAt(o.a, o.h, o.k, x); }
    // 窗口手柄的约束：手柄在窗口中点、贴着 x 轴走；左端点吸附到 0.5 的倍数，窗口不出视野。
    // meta.x1 是左端点：键盘一步 0.5（snap），Home / End 跳到最左、最右
    function winConstraint() {
      function at(x1) {
        x1 = clamp(half(x1), VIEW[0], VIEW[1] - o.w);
        return { p: [x1 + o.w / 2, 0], x1: x1 };
      }
      return {
        kind: "window", snap: 0.5,
        project: function (p) { return at(p[0] - o.w / 2); },
        along: function (m, ds) { return at((m && typeof m.x1 === "number" ? m.x1 : st.x1) + ds); },
        span: function () { return { key: "x1", min: VIEW[0], max: VIEW[1] - o.w }; }
      };
    }
    // 画板上标注的位置（pickPlace 挑）：
    //   对称轴的标注「x = h」写在它上端的右边，压到 y 轴的刻度数字时换到左边或往下挪一行；
    //   窗口两端的数值默认写在端点正下方，压到原点「O」、窗口手柄时往外偏或往下挪；
    //   最小值写在点下面、最大值写在点上面，压到坐标轴、刻度数字、手柄、曲线、另一个标注时，
    //   改写在背着对称轴的一侧、斜下（上）方……；点在视野外时（调过 a、h、k 以后可能）标注停在视野边上，
    //   先写在朝对称轴的一侧，读数照样对（另加 ↑ ↓ 表示还在更高 / 更低处）；两个都出了视野时一上一下错开一行。
    // 一帧只算一次：几个标注的位置函数都调 plan()，状态和画板尺寸没变就用上次的结果（sync 里清掉 planKey）
    var planKey = "", PL = null;
    function extremeCands(pt, kind, line) {
      var top = VIEW[3], bot = VIEW[2];
      var outS = pt.x < o.h ? "w" : "e", inS = outS === "w" ? "e" : "w";
      if (pt.y > top - 0.45 || pt.y < bot + 0.45) {
        var hi = pt.y > top - 0.45, y0 = hi ? top - 0.45 : bot + 0.45, d = hi ? -line : line, list = [];
        [0, 1, 2, 3, 4, 5].forEach(function (n) {
          var at = [pt.x, y0 + d * n];
          list.push({ at: at, pos: inS, off: 10 }, { at: at, pos: outS, off: 10 });
        });
        return list;
      }
      var v = kind === "min" ? "s" : "n", u = v === "s" ? "n" : "s", p = [pt.x, pt.y];
      return [
        { at: p, pos: v, off: 9 }, { at: p, pos: outS, off: 10 }, { at: p, pos: v + outS, off: 7 },
        { at: p, pos: inS, off: 10 }, { at: p, pos: v + inS, off: 7 }, { at: p, pos: v, off: 22 },
        { at: p, pos: u + outS, off: 7 }, { at: p, pos: u + inS, off: 7 }, { at: p, pos: u, off: 9 },
        // 点贴着 x 轴、压在手柄或窗口两端的数值上时：再离远一点
        { at: p, pos: outS, off: 20 }, { at: p, pos: inS, off: 20 }, { at: p, pos: v, off: 36 }, { at: p, pos: u, off: 22 }
      ];
    }
    function plan() {
      var z = b.size();
      var key = [st.x1, o.w, o.a, o.h, o.k, st.lm, st.lx, z.w, z.h, z.plot[0], z.plot[1]].join("|");
      if (key === planKey && PL) return PL;
      planKey = key;
      var dflt = { at: [0, 0], pos: "s", off: 9 };
      PL = {
        ax: { at: [o.h, VIEW[3] - 0.35], pos: "e", off: 5 },
        x1: { at: [st.x1, 0], pos: "s", off: 7 }, x2: { at: [st.x2, 0], pos: "s", off: 7 }, min: dflt, max: dflt
      };
      if (!st.ex) return PL;
      var fs = labelFs(b), obs = axisObstacles(b, VIEW, false), fns = [{ f: f, w: 3 }];
      var line = (fs + 4) / (b.toScreen([0, 0])[1] - b.toScreen([0, 1])[1]);   // 一行字的高度（世界单位）
      var a1 = b.toScreen([st.x1, 0]), a2 = b.toScreen([st.x2, 0]);
      var hp = b.toScreen([st.x1 + o.w / 2, 0]);
      obs.push(circleRect(hp, 17, 3), circleRect(hp, 10, 10));   // 窗口手柄：浅色光圈（压一点还看得清）、实心圆点
      obs.push([a1[0] - 3, a1[1] - 4, a2[0] + 3, a1[1] + 4, 3]);        // x 轴上的窗口粗线
      var hx = b.toScreen([o.h, 0])[0];
      obs.push([hx - 2, z.plot[1], hx + 2, z.plot[3], 1]);               // 对称轴（虚线）
      // 挑好一个就把它占的地方也记成障碍，后面的标注让开它；skip：不算障碍的那一项（标注自己的点）
      function place(k, cands, text, fnList, skip) {
        var pk = pickPlace(b, cands, text, fs, skip ? obs.filter(function (r) { return r !== skip; }) : obs, fnList, null);
        if (!pk) return;
        PL[k] = pk.c;
        pk.r.push(8); obs.push(pk.r);
      }
      // 最值点、两端相等时另一端的点（看得见的才算）
      var dots = { min: null, max: null, twinMin: null, twinMax: null };
      if (inView(st.ex.min)) dots.min = circleRect(b.toScreen([st.ex.min.x, st.ex.min.y]), 9, 6);
      if (inView(st.ex.max)) dots.max = circleRect(b.toScreen([st.ex.max.x, st.ex.max.y]), 9, 6);
      if (st.twinMin && inView(st.ex.min)) dots.twinMin = circleRect(b.toScreen(st.twinMin), 8, 6);
      if (st.twinMax && inView(st.ex.max)) dots.twinMax = circleRect(b.toScreen(st.twinMax), 8, 6);
      Object.keys(dots).forEach(function (d) { if (dots[d]) obs.push(dots[d]); });
      // 对称轴的标注
      var axTop = [o.h, VIEW[3] - 0.35], axLow = [o.h, VIEW[3] - 0.35 - line];
      place("ax", [
        { at: axTop, pos: "e", off: 5 }, { at: axTop, pos: "w", off: 5 }, { at: axLow, pos: "e", off: 5 }, { at: axLow, pos: "w", off: 5 }
      ], "x = " + nf(o.h), fns);
      // 窗口两端的数值
      [["x1", st.x1, "sw", "se"], ["x2", st.x2, "se", "sw"]].forEach(function (e) {
        var at = [e[1], 0];
        place(e[0], [
          { at: at, pos: "s", off: 7 }, { at: at, pos: e[2], off: 6 }, { at: at, pos: "s", off: 21 }, { at: at, pos: e[3], off: 6 },
          // 写到 x 轴上方是最后的办法（离 y 轴近时像是 y 轴的刻度）
          { at: at, pos: "s", off: 36 }, { at: at, pos: "n" + e[2].charAt(1), off: 6, bias: 3 }
        ], nf(e[1]), null);
      });
      place("min", extremeCands(st.ex.min, "min", line), st.lm || "", fns, dots.min);
      place("max", extremeCands(st.ex.max, "max", line), st.lx || "", fns, dots.max);
      return PL;
    }
    function placeAt(k) { return function (opt) { var c = plan()[k]; opt.pos = c.pos; opt.offset = c.off; return c.at; }; }
    function inView(p) { return p.y >= VIEW[2] && p.y <= VIEW[3]; }

    function build() {
      destroyBoard(b);
      VIEW = o.a > 0 ? VIEW_UP : VIEW_DOWN;
      // 画板上的文字节点都是新的：缓存的文字清空，下面的 sync 全部重写一遍
      st.cs = ""; st.vis = {}; st.range = ""; st.expr = "";
      b = S.board(host, {
        view: VIEW, aspect: "equal", height: "auto", maxHeight: "56vh",
        // x 轴不写刻度数字：窗口两端的数值写在窗口下面，对称轴的位置写在它上端，免得和刻度数字挤在一起
        axes: { x: "x", y: "y", xt: [] }, grid: true, pad: 20, ariaLabel: "抛物线和 x 轴上可拖动的区间窗口"
      });
      // 区间窗口：浅色色带 + 两条边 + x 轴上的粗线段；窗口里的那段图象加粗
      b.polygon(function () { return [[st.x1, VIEW[2]], [st.x2, VIEW[2]], [st.x2, VIEW[3]], [st.x1, VIEW[3]]]; },
        { color: "blue", fill: true, cls: "qd-noptr qd-band" });
      b.segment(function () { return [st.x1, VIEW[2]]; }, function () { return [st.x1, VIEW[3]]; }, { color: "blue", width: 1, cls: "qd-noptr qd-edge" });
      b.segment(function () { return [st.x2, VIEW[2]]; }, function () { return [st.x2, VIEW[3]]; }, { color: "blue", width: 1, cls: "qd-noptr qd-edge" });
      // 对称轴：颜色跟着三种情况变（CSS 按 #quad-interval-boards 的 data-case 改 --sk-c）
      b.segment(function () { return [o.h, VIEW[2]]; }, function () { return [o.h, VIEW[3]]; }, { color: "ink", dash: true, width: 2.5, cls: "qd-noptr qd-axis" });
      axLab = dynText(b, placeAt("ax"), { pos: "e", offset: 5, color: "ink", cls: "qd-noptr qd-axis" });
      b.fn(f, { color: "muted", width: 2, cls: "qd-noptr" });
      b.fn(f, { domain: function () { return [st.x1, st.x2]; }, color: "blue", width: 5, cls: "qd-noptr" });
      b.segment(function () { return [st.x1, 0]; }, function () { return [st.x2, 0]; }, { color: "blue", width: 6, cls: "qd-noptr" });
      x1Lab = dynText(b, placeAt("x1"), { pos: "s", offset: 7, color: "blue", cls: "qd-noptr" });
      x2Lab = dynText(b, placeAt("x2"), { pos: "s", offset: 7, color: "blue", cls: "qd-noptr" });
      // 最小值点、最大值点：高亮并标出数值；两个端点的函数值相等且都是最大（或最小）值时，另一个端点也画一个点
      twinMax = b.point(function () { return st.twinMax || [0, 0]; }, { r: 5, color: "red", cls: "qd-noptr" });
      twinMin = b.point(function () { return st.twinMin || [0, 0]; }, { r: 5, color: "green", cls: "qd-noptr" });
      minPt = b.point(function () { return st.ex ? [st.ex.min.x, st.ex.min.y] : [0, 0]; }, { r: 6, color: "green", cls: "qd-noptr" });
      maxPt = b.point(function () { return st.ex ? [st.ex.max.x, st.ex.max.y] : [0, 0]; }, { r: 6, color: "red", cls: "qd-noptr" });
      minLab = dynText(b, placeAt("min"), { pos: "s", offset: 9, color: "green", cls: "qd-noptr" });
      maxLab = dynText(b, placeAt("max"), { pos: "n", offset: 9, color: "red", cls: "qd-noptr" });
      H = b.point([st.x1 + o.w / 2, 0], {
        draggable: true, r: 8, hit: 24, step: 0.5,
        constrain: winConstraint(),
        ariaLabel: "x 轴上的区间窗口：拖动它改变 x 的范围",
        ariaText: function () { return nf(st.x1) + " ≤ x ≤ " + nf(st.x2); },
        color: "blue"
      });
      H.on("drag", function () { sync(true); });
      H.on("end", function () { sync(false); });
      afterKey(H, sync);
      sync(false);
    }

    function sync(fromDrag) {
      var m = typeof H.meta === "function" ? H.meta() : null;
      var x1 = m && typeof m.x1 === "number" ? m.x1 : st.x1;
      st.x1 = x1; st.x2 = x1 + o.w;
      var ex = M.intervalExtrema(o.a, o.h, o.k, st.x1, st.x2);
      st.ex = ex;
      planKey = "";   // 标注位置在这一帧重画时重新挑（见 plan）
      // 两个端点的函数值一样（窗口关于对称轴对称）：最值在两个端点同时取到
      var y1 = f(st.x1), y2 = f(st.x2), tie = Math.abs(y1 - y2) < 1e-9;
      var tieMax = tie && ex.max.x !== o.h, tieMin = tie && ex.min.x !== o.h;
      st.twinMax = tieMax ? [st.x2, y2] : null;
      st.twinMin = tieMin ? [st.x2, y2] : null;

      var e = M.formatVertex(o.a, o.h, o.k), r = nf(st.x1) + " ≤ x ≤ " + nf(st.x2);
      if (e !== st.expr) { st.expr = e; setText(exprT, e); }
      if (r !== st.range) { st.range = r; setText(rangeT, r); setText(x1Lab.tn, nf(st.x1)); setText(x2Lab.tn, nf(st.x2)); }
      if (ex["case"] !== st.cs) {
        st.cs = ex["case"];
        caseEl.setAttribute("data-case", st.cs);
        wrap.setAttribute("data-case", st.cs);
        setText(caseT, CASE_TEXT[st.cs]);
        st.seen[st.cs] = true;
      }
      setText(axLab.tn, "x = " + nf(o.h));
      // 一句话说明增减性：这正是「最值在哪」的理由
      var up = o.a > 0, why;
      if (st.cs === "inside") why = "顶点在这一段里：" + (up ? "最小值" : "最大值") + "在顶点处取到";
      else why = "在这一段上，y 随 x 的增大而" + ((st.cs === "left") === up ? "增大" : "减小");
      if (why !== st.why) { st.why = why; setText(whyT, why); }

      var ms = nf(ex.min.y), xs = nf(ex.max.y);
      var ma = "x = " + nf(ex.min.x) + (tieMin ? " 或 " + nf(ex.min.x === st.x1 ? st.x2 : st.x1) : "");
      var xa = "x = " + nf(ex.max.x) + (tieMax ? " 或 " + nf(ex.max.x === st.x1 ? st.x2 : st.x1) : "");
      if (ms !== st.minS) { st.minS = ms; setText(minT, ms); }
      if (xs !== st.maxS) { st.maxS = xs; setText(maxT, xs); }
      if (ma !== st.minAt) { st.minAt = ma; setText(minAtT, ma); }
      if (xa !== st.maxAt) { st.maxAt = xa; setText(maxAtT, xa); }
      var inMin = inView(ex.min), inMax = inView(ex.max);
      var lm = "最小值 " + ms + (ex.min.y < VIEW[2] ? " ↓" : ""), lx = "最大值 " + xs + (ex.max.y > VIEW[3] ? " ↑" : "");
      st.lm = lm; st.lx = lx;
      setText(minLab.tn, lm); setText(maxLab.tn, lx);
      var vis = st.vis;
      if (vis.min !== inMin) { vis.min = inMin; setShown(minPt, inMin); }
      if (vis.max !== inMax) { vis.max = inMax; setShown(maxPt, inMax); }
      var tx = !!st.twinMax && inMax, tn = !!st.twinMin && inMin;
      if (vis.twinMax !== tx) { vis.twinMax = tx; setShown(twinMax, tx); }
      if (vis.twinMin !== tn) { vis.twinMin = tn; setShown(twinMin, tn); }

      if (st.seen.left && st.seen.inside && st.seen.right) markTask("interval");
      if (!fromDrag) b.update();
    }

    // 滑块：窗口宽度 w（默认露出）；进阶里 a、h、k。改 w 时左端点不动（2 ≤ x ≤ 4 → 2 ≤ x ≤ 5），放不下时往左挪
    ctl = S.controls(ctlHost, [
      { id: "w", label: "窗口宽度", min: 1, max: 6, step: 0.5, value: o.w },
      { id: "a", label: "a", min: -3, max: 3, step: 0.5, value: o.a, advanced: true },
      { id: "h", label: "h（对称轴 x = h）", min: -3, max: 5, step: 0.5, value: o.h, advanced: true },
      { id: "k", label: "k", min: -2, max: 5, step: 0.5, value: o.k, advanced: true }
    ], function (v, id) {
      if (id === "a") {
        var a = zs.fix(v.a, o.a);
        if (a !== v.a) ctl.set("a", a);
        if (a === o.a) return;
        var flip = (a > 0) !== (o.a > 0);
        o.a = a;
        if (flip) { build(); return; }
      } else if (id === "w") {
        if (v.w === o.w) return;
        o.w = v.w;
        H.set([st.x1 + o.w / 2, 0]);   // 约束会把左端点夹回视野里
      } else if (id === "h" || id === "k") {
        if (v[id] === o[id]) return;
        o[id] = v[id];
      }
      sync(false);
    });
    zs = zeroSkip(ctlInput(ctl, "a"), o.a);

    build();
    return {
      resize: function () { if (b) b.resize(); },
      get: function () {
        var ex = st.ex || { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
        return { a: o.a, h: o.h, k: o.k, x1: st.x1, x2: st.x2, width: o.w, "case": st.cs,
          min: { x: ex.min.x, y: ex.min.y }, max: { x: ex.max.x, y: ex.max.y },
          seen: { left: st.seen.left, inside: st.seen.inside, right: st.seen.right }, done: !!TASKS.interval };
      },
      boards: function () { return b; },
      handle: function () { return H; }
    };
  })();
  PANELS.interval = interval;

  /* ==================== 情境 abc：a、b、c 与图象 ==================== */
  var abc = (function () {
    var VIEW = [-6, 6, -6, 8];
    var o = { a: 1, b: 2, c: -1 };
    var SIDE_TEXT = { left: "对称轴在 y 轴左侧", right: "对称轴在 y 轴右侧", on: "对称轴就是 y 轴" };
    var wrap = $("quad-abc-boards"), host = $("quad-abc-board"), ctlHost = $("quad-abc-ctl");
    var sideEl = $("quad-side"), signsEl = $("quad-signs");
    var exprT = textOf($("quad-abc-expr")), sideT = textOf(sideEl), relT = textOf($("quad-ab-rel"));
    var axisFT = textOf($("quad-axis-f"));
    var cells = {}, means = {};
    ["a", "b", "c"].forEach(function (k) {
      var td = signsEl ? signsEl.querySelector('.qd-sg td[data-k="' + k + '"]') : null;
      var md = signsEl ? signsEl.querySelector('.qd-mean td[data-k="' + k + '"]') : null;
      cells[k] = { el: td, tn: textOf(td) };
      means[k] = textOf(md);
    });
    // seenB：a > 0（up）、a < 0（down）时各见过 b 的哪些符号（b = 0 不算）；同一个 a 的符号下 b 的正负都见过，才算「b 变过号」
    var st = { axis: 0, side: "", signs: { a: "", b: "", c: "" }, expr: "",
      seenB: { up: { pos: false, neg: false }, down: { pos: false, neg: false } }, flipped: { up: false, down: false }, txt: {},
      axT: "", yT: "" };
    var b = null, ctl = null, zs = null, axLab = null, yLab = null;

    function f(x) { return M.valueGeneral(o.a, o.b, o.c, x); }
    // 对称轴的标注写在它上端、背着 y 轴的一侧；与 y 轴交点的标注写在背着对称轴的一侧（尽量不压在抛物线和对称轴上）。
    // 压到刻度数字、原点「O」时换一侧或挪开一点（pickPlace 挑，同 interval 的 plan）
    var planKey = "", PL = null;
    function plan() {
      var z = b.size(), key = [o.a, o.b, o.c, st.axT, st.yT, z.w, z.h, z.plot[0], z.plot[1]].join("|");
      if (key === planKey && PL) return PL;
      planKey = key;
      var away = st.axis < 0 ? "w" : "e", near = away === "w" ? "e" : "w";
      var fs = labelFs(b), obs = axisObstacles(b, VIEW, true), fns = [{ f: f, w: 3 }];
      var line = (fs + 4) / (b.toScreen([0, 0])[1] - b.toScreen([0, 1])[1]);
      var axTop = [st.axis, VIEW[3] - 0.4], axLow = [st.axis, VIEW[3] - 0.4 - line];
      var ax = pickPlace(b, [
        { at: axTop, pos: away, off: 5 }, { at: axTop, pos: near, off: 5 }, { at: axLow, pos: away, off: 5 }, { at: axLow, pos: near, off: 5 }
      ], st.axT || "", fs, obs, fns, null);
      if (ax) { ax.r.push(8); obs.push(ax.r); }
      var sx = b.toScreen([st.axis, 0])[0];
      obs.push([sx - 2, z.plot[1], sx + 2, z.plot[3], 1]);   // 对称轴（虚线）
      var p = [0, o.c], yo = st.axis > 0 ? "w" : "e", yi = yo === "w" ? "e" : "w";
      var y = pickPlace(b, [
        { at: p, pos: yo, off: 9 }, { at: p, pos: "n" + yo, off: 7 }, { at: p, pos: "s" + yo, off: 7 },
        { at: p, pos: yi, off: 9 }, { at: p, pos: "n" + yi, off: 7 }, { at: p, pos: "s" + yi, off: 7 }
      ], st.yT || "", fs, obs, fns, null);
      PL = { ax: ax ? ax.c : { at: axTop, pos: away, off: 5 }, y: y ? y.c : { at: p, pos: yo, off: 9 } };
      return PL;
    }
    function placeAt(k) { return function (opt) { var c = plan()[k]; opt.pos = c.pos; opt.offset = c.off; return c.at; }; }

    function build() {
      b = S.board(host, {
        view: VIEW, aspect: "equal", height: "auto", maxHeight: "56vh",
        axes: { x: "x", y: "y" }, grid: true, pad: 20, ariaLabel: "抛物线 y = ax² + bx + c、它的对称轴和与 y 轴的交点"
      });
      b.segment(function () { return [st.axis, VIEW[2]]; }, function () { return [st.axis, VIEW[3]]; }, { color: "purple", dash: true, width: 2.5, cls: "qd-noptr" });
      axLab = dynText(b, placeAt("ax"), { pos: "e", offset: 5, color: "purple", cls: "qd-noptr" });
      b.fn(f, { color: "blue", width: 3, cls: "qd-noptr" });
      b.point(function () { return [0, o.c]; }, { r: 6, color: "coral", cls: "qd-noptr" });
      yLab = dynText(b, placeAt("y"), { pos: "e", offset: 9, color: "coral", cls: "qd-noptr" });
    }

    function paintSign(k, s) {
      var c = cells[k];
      if (!c || st.signs[k] === s) return;
      st.signs[k] = s;
      setText(c.tn, s);
      if (c.el) c.el.setAttribute("data-sign", s);
    }
    function setTxt(key, tn, s) { if (st.txt[key] !== s) { st.txt[key] = s; setText(tn, s); } }

    function sync() {
      var ax = M.axis(o.a, o.b), sg = M.abSigns(o.a, o.b, o.c);
      st.axis = ax;
      var e = M.formatGeneral(o.a, o.b, o.c);
      if (e !== st.expr) { st.expr = e; setText(exprT, e); }
      if (sg.side !== st.side) {
        st.side = sg.side;
        sideEl.setAttribute("data-side", sg.side);
        setText(sideT, SIDE_TEXT[sg.side]);
      }
      paintSign("a", sg.a); paintSign("b", sg.b); paintSign("c", sg.c);
      // 左同右异：a、b 同号时对称轴在左侧，异号时在右侧
      var rel = o.b === 0 ? "b = 0" : (o.a > 0) === (o.b > 0) ? "a、b 同号" : "a、b 异号";
      setTxt("rel", relT, rel);
      setTxt("ma", means.a, o.a > 0 ? "开口向上" : "开口向下");
      setTxt("mb", means.b, rel);
      setTxt("mc", means.c, o.c > 0 ? "交 y 轴正半轴" : o.c < 0 ? "交 y 轴负半轴" : "过原点");
      // 对称轴 x = −b/(2a)：除不尽时（如 a = 1.5、b = 1）写约等号
      var axS = (Math.abs(M.round(ax, 3) - ax) > 1e-9 ? " ≈ " : " = ") + nf(ax);
      st.axT = "x" + axS; st.yT = "(0, " + nf(o.c) + ")";
      planKey = "";   // 标注位置在这一帧重画时重新挑（见 plan）
      setText(axLab.tn, st.axT);
      setTxt("axf", axisFT, "对称轴 x = −b/(2a)" + axS);
      setText(yLab.tn, st.yT);

      // 任务：a > 0 时 b 的正负都见过（对称轴从 y 轴一侧跑到另一侧），a < 0 时也都见过，才算完成。
      // 按 a 的符号分开记：a 变号前看到的 b 不算到新的符号头上（例如 b = 0 时把 a 调成负的、再调 b 到负，
      // 不会因为 a > 0 时见过 b > 0 就算 a < 0 时 b 变过号）
      if (o.b !== 0) {
        var sb = st.seenB[o.a > 0 ? "up" : "down"];
        sb[o.b > 0 ? "pos" : "neg"] = true;
      }
      st.flipped.up = st.seenB.up.pos && st.seenB.up.neg;
      st.flipped.down = st.seenB.down.pos && st.seenB.down.neg;
      if (st.flipped.up && st.flipped.down) markTask("abc");
      b.update();
    }

    build();
    ctl = S.controls(ctlHost, [
      { id: "a", label: "a", min: -3, max: 3, step: 0.5, value: o.a },
      { id: "b", label: "b", min: -3, max: 3, step: 0.5, value: o.b },
      { id: "c", label: "c", min: -3, max: 3, step: 0.5, value: o.c, advanced: true }
    ], function (v, id) {
      if (id === "a") {
        var a = zs.fix(v.a, o.a);
        if (a !== v.a) ctl.set("a", a);
        o.a = a;
      } else {
        o[id] = v[id];
      }
      sync();
    });
    zs = zeroSkip(ctlInput(ctl, "a"), o.a);
    sync();
    return {
      resize: function () { if (b) b.resize(); },
      get: function () {
        return { a: o.a, b: o.b, c: o.c, axis: st.axis, side: st.side,
          signs: { a: st.signs.a, b: st.signs.b, c: st.signs.c },
          flipped: { up: st.flipped.up, down: st.flipped.down }, done: !!TASKS.abc };
      },
      boards: function () { return b; },
      // 这个情境没有可拖动的点：a、b 两个滑块就是主控件
      handle: function () { return null; }
    };
  })();
  PANELS.abc = abc;

  /* ==================== 初始标签页、深链 ==================== */
  paintTabs();
  pickInitialTab();
  window.addEventListener("abs-auth-changed", function () { TASKS = loadTasks(); paintTabs(); });

  /* ==================== 预测关卡（外部部件 m2-vertex）、练一练 ==================== */
  function scrollToQid(qid) {
    var t = $("qz-" + qid);
    if (t && t.scrollIntoView) { try { t.scrollIntoView({ block: "start" }); } catch (e) { t.scrollIntoView(true); } }
  }
  function fail(el, text) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    var p = document.createElement("p");
    p.className = "qd-load";
    p.appendChild(document.createTextNode(text));
    el.appendChild(p);
  }

  var gateP = Promise.resolve(null);
  var ansHost = $("qz-vertex-ans"), promptHost = $("qz-vertex-prompt");
  if (Q && typeof Q.registerExternal === "function" && typeof Q.mount === "function") {
    // 先注册再 mount：卡片按外部部件排版（题干进 promptHost 放在画板上方，作答区留在 #qz-vertex-ans，紧跟在画板下面）
    Q.registerExternal(WIDGET_ID, {
      cover: $("quad-vertex-boards"),
      bind: function (a) { return vertex.bind(a); }
    });
    gateP = Promise.resolve().then(function () {
      return Q.mount(ansHost, { items: [QID_POE], mode: "poe", promptHost: promptHost });
    }).then(function (ctrl) {
      var card = ctrl && ctrl.cards && ctrl.cards[0];
      if (!card || !vertex.bound()) {
        // 题目没加载成功（或这道题被过滤掉）：不挂预测关卡，情境照常可以拖
        vertex.free();
        return ctrl || null;
      }
      // 跟着卡片的阶段记下 stage（data-stage 是属性变动，不触发 linker 的 childList 监听）
      var el = card.el;
      vertex.setStage(card.stage());
      if (el && typeof MutationObserver === "function") {
        new MutationObserver(function () { vertex.setStage(el.getAttribute("data-stage")); }).observe(el, { attributes: true, attributeFilter: ["data-stage"] });
      }
      if (HASH_QID === QID_POE) scrollToQid(QID_POE);
      return ctrl;
    }).catch(function (e) {
      if (window.console && console.warn) console.warn("预测关卡加载失败", e);
      vertex.free();
      return null;
    });
  } else {
    vertex.free();
  }

  // 练一练：默认收起，第一次展开时才 mount（9 道题的缩略图不在打开页面时就画，手机上省时间）
  var practice = $("quad-practice"), more = $("quad-more"), moreP = null;
  function ensureMore() {
    if (moreP) return moreP;
    if (!Q || typeof Q.mount !== "function" || typeof Q.load !== "function") {
      fail(more, "题目没有加载成功，请检查网络后刷新页面。");
      moreP = Promise.resolve(null);
      return moreP;
    }
    // m2 里 retest: true 的题（二段式、迁移、逆向），按题库顺序；预测关卡在上面的情境里，不在这里出。
    // 没加载成功、或者题库里一道 m2 的题也没有（题库文件没读到）：写一句提示，不留一块空白；
    // moreP 清空，收起再展开「练一练」时重新试一次（引擎读题库失败时不缓存，重试会重新请求）
    var p = Q.load().then(function (bank) {
      var ids = ((bank && bank.items) || []).filter(function (it) { return it.module === "m2" && it.retest === true; }).map(function (it) { return it.id; });
      if (!ids.length) throw new Error("题库里没有 m2 的题");
      return Q.mount(more, { items: ids, mode: "practice" });
    }).catch(function (e) {
      if (window.console && console.warn) console.warn("练一练加载失败", e);
      fail(more, "题目没有加载成功，请检查网络后刷新页面。");
      if (moreP === p) moreP = null;
      return null;
    });
    moreP = p;
    return p;
  }
  if (practice) {
    practice.addEventListener("toggle", function () { if (practice.open) ensureMore(); });
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
  window.__quad = {
    tab: function () { return CUR; },
    show: function (key) { return show(key, false); },
    get: function (key) { var T = PANELS[key || CUR]; return T ? T.get() : null; },
    boards: function (key) { var T = PANELS[key || CUR]; return T ? T.boards() : null; },
    handle: function (key) { var T = PANELS[key || CUR]; return T ? T.handle() : null; },
    tasks: function () { return { vertex: !!TASKS.vertex, interval: !!TASKS.interval, abc: !!TASKS.abc }; },
    gate: function () { return gateP; },
    more: function () { return openMore(); }
  };
})();
