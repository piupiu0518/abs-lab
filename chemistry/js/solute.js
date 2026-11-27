/* ABS-LAB「反应后溶质成分」页面脚本（chemistry/solute.html）
 *
 * 两个情境（标签页切换，一次只显示一个，每个是一个任务 data-task）：
 *   curve  四对试剂（①～④）：pH 曲线上拖取样点（唯一的拖动对象，横坐标就是滴入体积 V），
 *          联动离子条形图、小烧杯（沉淀 / 气泡）和「取样」卡片；选③时挂预测关卡 c-cc-poe（部件 cc-curve）；
 *   spoil  NaOH 变质探究：三份样品 A、B、C 随机对应未变质 / 部分变质 / 完全变质，取样到试管里依次加试剂，下结论、核对。
 *          核对「证据够了才算对」：按这份样品做过的试管里看到的现象判断（ABSLabChem.judgeSample），光猜对不算完成。
 * pH、示意粒子数、溶质、变质探究的现象都由 js/chem-models.js（window.ABSLabChem）算，和题库、单元测试用的是同一份函数。
 *
 * 为什么这样写：
 *   - 一屏只放一个可拖动对象和一个联动图（SPEC 第 2 节）：curve 只拖取样点，条形图、烧杯、取样卡片跟着变；没有滑块。
 *   - 曲线只画到取样点（SPEC 6.3）：学生自己把曲线「拖」出来；往回拖时曲线跟着缩回去。
 *     恰好完全反应之前 / 之时 / 之后用三种颜色（蓝 / 绿 / 珊瑚）：曲线、取样点、阶段标签、图例同一套颜色。
 *   - 取样点的 V 按 0.1 mL 取整，V = 20 mL 附近 ±0.3 mL 吸到 20：读数、阶段标签、取样卡片对应同一个 V，
 *     「恰好完全反应」那一点不用手指对准 1 个像素。条形图、沉淀、气体的示意粒子数按「整数个滴入的粒子」算
 *     （见 countV），数得清、守恒，并且和阶段标签说的一致（之前还剩反应物、之后有过量的滴入物）。
 *   - 拖动在 svgkit 的 rAF 帧里回调本文件；回调里只改属性、样式和文字节点，不读布局、不建节点、不用 innerHTML，
 *     手机上每帧开销很小（同 math/js/moving-point.js）。文字用 textNode.nodeValue 改（characterData 变动），
 *     不触发 linker.js 盯着的 childList 变动，拖动时它不会反复刷新。条形图的高度用 transform 改，不触发重排。
 *   - 每对试剂各记一个取样点位置：换试剂时从那一对上次停的地方接着看；第一次选③时它在 V = 0，
 *     锁定（预测之前）时条形图和取样卡片不会提前露出「恰好完全反应时还剩什么」。
 *   - 预测关卡只属于③（和电学实验台 3 号的小灯泡模式一样）：选别的试剂对时藏起题干、作答区和遮罩并放开取样点，
 *     切回③时引擎里的状态照旧（还在预测阶段就继续锁着）。
 *   - 界面上只出现「稀盐酸」「NaOH 溶液」和体积（mL），离子数量只给「示意粒子数」（初中写法，SPEC 第 2 节）。
 * 语法不超过 ES2019，与 shared/*.js 一样用 var + function。
 */
(function () {
  "use strict";

  var S = window.ABSLabSVG;
  var M = window.ABSLabChem;
  var Q = window.ABSLabQuiz;
  var KEYS = ["curve", "spoil"];
  var PROGRESS_KEY = "chem_solute_tasks";
  var WIDGET_ID = "cc-curve";
  var QID_POE = "c-cc-poe";
  var MODULE = "cc";

  var VMAX = M ? M.VMAX : 40, VEQ = M ? M.VEQ : 20, VOL0 = M ? M.VOL0 : 20;
  var V_STEP = 0.1;           // 取样点的 V 按 0.1 mL 取整（和曲线采样点对齐，读数、条形图、卡片对应同一个 V）
  var SNAP = 0.3;             // |V − 20| ≤ 0.3 mL 时吸到 20（CONTRACT 第 5 节）
  var KEY_STEP = 0.5;         // 方向键一次走 0.5 mL：比吸附范围大，从 20 出发按一下就能离开
  var GATE_LOW = 5, GATE_HIGH = 35; // 预测关卡的完成条件：③下 V 既到过 ≤ 5 mL，也到过 ≥ 35 mL（SPEC 6.3）
  var BAR_MAX = 40;           // 条形图满格 = 40 个示意粒子（四对试剂里最多的离子：滴满 40 mL 时的 Na⁺ / Cl⁻），四对用同一个比例尺
  var MAX_STEPS = 3;          // 一支试管最多加 3 步试剂（SPEC 6.4）
  var MAX_TUBES = 12;         // 试管架上最多留 12 支，多了把最早的一支收走（手机上不至于排出好几屏）

  var STAGE_TEXT = { before: "恰好完全反应之前", equiv: "恰好完全反应", after: "恰好完全反应之后" };
  var STAGE_COLOR = { before: "blue", equiv: "green", after: "coral" };
  // 每种离子一种颜色（中和反应实验台已经用了 H⁺ 红、OH⁻ 蓝、Cl⁻ 绿、Na⁺ 紫，这里照用）；svgkit 的颜色名给对比图用。
  // CO₃²⁻ 不用珊瑚色（那是「恰好完全反应之后」的阶段色，④ 里 CO₃²⁻ 正好只在之后出现，容易看成一回事），改用棕色
  var ION_SK = { "H⁺": "red", "OH⁻": "blue", "Na⁺": "purple", "Cl⁻": "green", "Ba²⁺": "sun", "SO₄²⁻": "cyan", "CO₃²⁻": "sun" };
  var ION_CSS = {
    "H⁺": "var(--red)", "OH⁻": "var(--blue)", "Na⁺": "var(--purple)", "Cl⁻": "var(--green)",
    "Ba²⁺": "var(--sun)", "SO₄²⁻": "var(--cyan)", "CO₃²⁻": "#b45309"
  };
  // 离子名的文字颜色：条的颜色在白底上不够深的（Cl⁻ 绿 3.8 : 1、Ba²⁺ 浅黄、SO₄²⁻ 青 2.4 : 1），文字换深一号，
  // 对比度都在 4.5 : 1 以上（H⁺ 红 5.0、OH⁻ 蓝 5.7、Na⁺ 紫 7.2 本来就够）
  var ION_TEXT = { "Cl⁻": "#0f7a57", "Ba²⁺": "#b45309", "SO₄²⁻": "#0e7490", "CO₃²⁻": "#92400e" };
  // 示意粒子数要守恒：条形图、沉淀、气体按「整数个滴入的粒子」对应的体积算——①② 每 1 mL 滴入 1 个 Na⁺ / H⁺，
  // ③④ 每 2 mL 滴入 1 个 SO₄²⁻ / CO₃²⁻（模型里 1 个示意粒子 = 0.1 mmol）。pH、阶段、取样卡片仍按真实的 V
  var COUNT_STEP = { 1: 1, 2: 1, 3: 2, 4: 2 };

  // 取样卡片：「不算溶质」的生成物（只在已经开始反应、V > 0 时列出）和每个阶段的一句说明。
  // 说明里不提已经反应完的反应物的化学式：卡片上出现的化学式只有溶质和不算溶质的生成物，读起来不混
  // 每句尽量不超过手机上一行半：取样卡片和条形图要和 pH 曲线一起放进第一屏
  var NOT_SOLUTE = {
    1: "H₂O（水）",
    2: "H₂O（水）",
    3: "BaSO₄（沉淀）、H₂O（水）",
    4: "CO₂（气体，跑出了溶液）、H₂O（水）"
  };
  var NOTES = {
    1: {
      zero: "还没滴入 NaOH 溶液：瓶里是稀盐酸。",
      before: "HCl 还没反应完；生成的 NaCl 溶在水里。",
      equiv: "H⁺ 和 OH⁻ 结合成水，Na⁺ 和 Cl⁻ 还在溶液里。",
      after: "NaOH 溶液滴过量了，多出来的 NaOH 也是溶质。"
    },
    2: {
      zero: "还没滴入稀盐酸：瓶里是 NaOH 溶液。",
      before: "NaOH 还没反应完；生成的 NaCl 溶在水里。",
      equiv: "H⁺ 和 OH⁻ 结合成水，Na⁺ 和 Cl⁻ 还在溶液里。",
      after: "稀盐酸滴过量了，多出来的 HCl 也是溶质。"
    },
    3: {
      zero: "还没滴入稀硫酸：瓶里是 Ba(OH)₂ 溶液。",
      before: "Ba(OH)₂ 还没反应完；BaSO₄ 沉在瓶底，不在溶液里。",
      equiv: "沉淀和水都不是溶质：溶液里几乎没有离子了。",
      after: "稀硫酸滴过量了，多出来的 H₂SO₄ 是溶质。"
    },
    4: {
      zero: "还没滴入 Na₂CO₃ 溶液：瓶里是稀盐酸。",
      before: "HCl 还没反应完；CO₂ 跑出了溶液，NaCl 溶在水里。",
      equiv: "CO₂ 跑出了溶液，只剩溶在水里的 NaCl。",
      after: "Na₂CO₃ 溶液滴过量了，它也是溶质（溶液显碱性）。"
    }
  };

  var REAGENT_SHORT = { acid: "稀盐酸", phenol: "酚酞", cacl2: "CaCl₂", lime: "石灰水" };
  var LETTERS = ["A", "B", "C"];
  var CASES = ["none", "partial", "full"];

  function $(id) { return document.getElementById(id); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function round(v, n) { var k = Math.pow(10, n); return Math.round(v * k) / k; }
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
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.appendChild(document.createTextNode(text));
    return n;
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  function sv(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(n);
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function copyObj(o) { var r = {}; Object.keys(o).forEach(function (k) { r[k] = o[k]; }); return r; }

  /* ==================== 任务进度（chem_solute_tasks） ==================== */
  function loadTasks() {
    var out = { curve: false, spoil: false };
    var A = window.ABSLabAuth, saved = null;
    if (A && typeof A.getProgress === "function") {
      try { saved = A.getProgress(PROGRESS_KEY, null); } catch (e) { saved = null; }
    }
    if (saved && typeof saved === "object") KEYS.forEach(function (k) { out[k] = !!saved[k]; });
    return out;
  }
  var TASKS = loadTasks();
  var onTasks = []; // 任务状态变了之后要跟着刷新的地方（标签页的 ✓ 之外，例如 curve 的「四对试剂都取样看看」）
  function markTask(k) {
    if (TASKS[k]) return;
    // 先读一次存着的进度再合并：别的标签页里刚完成的任务不会被这里覆盖掉
    var cur = loadTasks();
    KEYS.forEach(function (x) { TASKS[x] = !!(TASKS[x] || cur[x]); });
    TASKS[k] = true;
    var A = window.ABSLabAuth;
    if (A && typeof A.setProgress === "function") {
      try { A.setProgress(PROGRESS_KEY, { curve: TASKS.curve, spoil: TASKS.spoil }); } catch (e) { /* 存储不可用：本页照常显示完成 */ }
    }
    paintTabs();
  }

  /* ==================== 标签页 ==================== */
  var tabs = $$('.so-tabs [role="tab"][data-tab]');
  var CUR = "curve";
  var PANELS = {};
  function paintTabs() {
    tabs.forEach(function (b) { b.classList.toggle("is-done", !!TASKS[b.getAttribute("data-tab")]); });
    onTasks.forEach(function (f) { f(); });
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

  function qidOf(hash) { hash = String(hash || ""); return /^#qz-(c-cc-[a-z0-9-]+)$/.test(hash) ? hash.slice(4) : ""; }
  var HASH_QID = qidOf(location.hash);
  // #qz-c-cc-poe 同时带着 ?task= 时（例如 ?task=spoil#qz-c-cc-poe）把 task 从地址里去掉（只改地址、不刷新）：
  // linker.js 在本脚本之后才读地址，读到 ?task=spoil 会把页面滚向藏起来的 spoil 面板，把刚定位好的预测题又滚走
  function dropTaskParam() {
    try {
      var q = String(location.search || "");
      if (!/[?&]task=/.test(q) || !window.history || typeof history.replaceState !== "function") return;
      var rest = q.replace(/^\?/, "").split("&").filter(function (kv) { return kv && kv.split("=")[0] !== "task"; }).join("&");
      history.replaceState(history.state, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    } catch (e) { /* 改不了地址：照常显示，只是 linker 可能多滚一次 */ }
  }
  // ?task=curve|spoil 和 #qz-c-cc-poe：同步切到对应面板（linker.js 稍后按 ?task 滚动、高亮这个面板，它得先显示出来）。
  // 两个都有时听 #qz-c-cc-poe 的：预测题在 curve 面板里，留在 spoil 就看不见要定位的题
  function pickInitialTab() {
    if (HASH_QID === QID_POE) { show("curve", false); dropTaskParam(); return; }
    var task = null;
    try { task = new URLSearchParams(location.search).get("task"); } catch (e) {
      var mm = /[?&]task=([a-z]+)/.exec(location.search || "");
      task = mm ? mm[1] : null;
    }
    if (task) show(task, false);
  }

  /* ==================== 模型或画板没加载成功 ==================== */
  if (!S || typeof S.board !== "function" || !M || typeof M.pairState !== "function") {
    ["solute-curve-boards", "solute-lab"].forEach(function (id) {
      var w = $(id);
      if (!w) return;
      var p = el("p", "so-load", "实验没有加载成功，请刷新页面再试。");
      w.parentNode.insertBefore(p, w);
      w.style.display = "none";
    });
    paintTabs();
    pickInitialTab();
    return;
  }

  /* ==================== 情境 curve：四对试剂、pH 曲线上取样 ==================== */
  var curve = (function () {
    var panel = $("so-curve"), wrap = $("solute-curve-boards"), host = $("solute-ph-board");
    var barsEl = $("solute-bars"), stageEl = $("solute-stage"), sampleEl = $("solute-sample");
    var pairBtns = $$("[data-pair]", panel);
    var T = {
      v: textOf($("solute-v")), ph: textOf($("solute-ph")), nature: textOf($("solute-nature")), stage: textOf(stageEl),
      sv: textOf($("solute-sample-v")), solutes: textOf($("solute-solutes")), not: textOf($("solute-not")), note: textOf($("solute-note"))
    };
    var VS = { 1: 0, 2: 0, 3: 0, 4: 0 };                    // 每对试剂各自的取样点位置
    var sampled = { 1: false, 2: false, 3: false, 4: false }; // 每对试剂是否取样过（拖动过取样点）
    var todoEl = $("solute-todo"), leadEl = $("solute-lead"); // 「四对试剂都取样看看」：四对都取样过（或任务早就完成）后藏起
    var pair = 0, full = [], built = false;
    // V：取样点的真实体积；Vc、cs：算示意粒子数用的体积和状态（见 countV）
    var st = { V: 0, s: null, Vc: 0, cs: null, stage: "", cardKey: "", vText: "", phText: "", moved: false, partAt: -1, eqShown: false };
    var parts = { before: [], after: [] };
    var bars = [];
    var gate = {
      api: null, locked: false, p: null, card: null, stage: "", failed: false,
      min: null, max: null, pct: -1, doneSent: false
    };
    var b = null, P = null, eqPt = null;

    /* --- 曲线：每对试剂预先算好 0～40 mL、每 0.1 mL 一个点（M.phCurve），画到当前 V 时只截取前面一段 --- */
    var CURVES = {};
    function curveOf(id) {
      if (CURVES[id]) return CURVES[id];
      var pts = M.phCurve(id, VMAX, V_STEP), n = Math.round(VMAX / V_STEP), ok = pts.length === n + 1;
      for (var i = 0; ok && i <= n; i++) if (Math.abs(pts[i][0] - i * V_STEP) > 1e-6) ok = false;
      if (!ok) {
        // phCurve 的采样和这里的 0.1 mL 对不齐（模型改了步长的写法）：按同一个 pairState 自己算一遍
        pts = [];
        for (var j = 0; j <= n; j++) { var v = round(j * V_STEP, 4); pts.push([v, round(M.pairState(id, v).pH, 4)]); }
      }
      CURVES[id] = pts;
      return pts;
    }
    function idxOf(V) { return clamp(Math.round(V / V_STEP), 0, full.length - 1); }
    function phAt(V) { return full.length ? full[idxOf(V)][1] : 7; }
    // 三段着色：恰好完全反应之前（含 20 mL 那一点，曲线连到 (20, 7)）蓝色、之后珊瑚色
    function cutParts() {
      var i = idxOf(st.V), ie = idxOf(VEQ);
      if (i === st.partAt) return;
      st.partAt = i;
      parts.before = full.slice(0, Math.min(i, ie) + 1);
      parts.after = i > ie ? full.slice(ie, i + 1) : [];
    }

    // 取样点的约束：横坐标就是 V（夹在 0～40 mL，按 0.1 mL 取整，20 mL 附近吸到 20），纵坐标落在当前这对试剂的 pH 曲线上
    function curveConstraint() {
      function at(v) {
        v = clamp(Math.round(+v / V_STEP) * V_STEP, 0, VMAX);
        v = round(v, 4);
        if (Math.abs(v - VEQ) <= SNAP + 1e-9) v = VEQ;
        return { p: [v, phAt(v)], x: v };
      }
      return {
        kind: "fn",
        project: function (p) { return isFinite(p[0]) ? at(p[0]) : null; },
        along: function (m, ds) { return at((m && typeof m.x === "number" ? m.x : st.V) + ds); },
        span: function () { return { key: "x", min: 0, max: VMAX }; }
      };
    }

    // 纵轴画到 pH 15（刻度只标 7、14）：②③ 在 V = 0 时 pH 13，取样点的触控圈离顶边多留一格，
    // 不再盖住纵轴的箭头和轴名「pH」；纵轴刻度数字整体左移（见页面 CSS），也躲开触控圈
    var Y_TOP = 15;
    function build() {
      b = S.board(host, {
        view: [0, VMAX, 0, Y_TOP], aspect: "fill", height: "auto", ratio: 0.5, maxHeight: "40vh",
        // 上边距 20px：写纵轴名「pH」，手机上右上角还放一行横轴说明（.so-xcap）；左边距 34px 放左移了的刻度数字
        // （svgkit 会按坐标轴名、刻度自动加宽其余几边）
        axes: { x: "V/mL", y: "pH", xt: [10, 20, 30, 40], yt: [7, 14] }, grid: true, pad: [20, 24, 24, 34],
        ariaLabel: "pH 随滴入体积 V 变化的曲线"
      });
      // 底色带：恰好完全反应之前 / 之后（很淡），20 mL 处一条绿色竖虚线，pH = 7 一条灰色横虚线
      b.polygon([[0, 0], [VEQ, 0], [VEQ, Y_TOP], [0, Y_TOP]], { fill: true, color: "blue", cls: "so-band so-noptr" });
      b.polygon([[VEQ, 0], [VMAX, 0], [VMAX, Y_TOP], [VEQ, Y_TOP]], { fill: true, color: "coral", cls: "so-band so-noptr" });
      b.segment([0, 7], [VMAX, 7], { dash: true, color: "muted", width: 1, cls: "so-noptr" });
      b.segment([VEQ, 0], [VEQ, Y_TOP], { dash: true, color: "green", width: 1.2, cls: "so-noptr" });
      // 取样点到两条坐标轴的虚线：V 落到横轴上读，pH 落到纵轴上读
      b.segment(function () { return [st.V, 0]; }, function () { return [st.V, phAt(st.V)]; }, { dash: true, color: "muted", width: 1, cls: "so-noptr" });
      b.segment(function () { return [0, phAt(st.V)]; }, function () { return [st.V, phAt(st.V)]; }, { dash: true, color: "muted", width: 1, cls: "so-noptr" });
      b.polyline(function () { cutParts(); return parts.before; }, { color: "blue", width: 3, cls: "so-noptr" });
      b.polyline(function () { cutParts(); return parts.after; }, { color: "coral", width: 3, cls: "so-noptr" });
      eqPt = b.point([VEQ, 7], { r: 5, color: "green", cls: "so-noptr" });
      setShown(eqPt, false);
      P = b.point([0, 7], {
        draggable: true, r: 7, hit: 22, step: KEY_STEP,
        constrain: curveConstraint(),
        ariaLabel: "可拖动的取样点：沿 pH 曲线左右拖，改变滴入的体积 V",
        // 读屏读体积和 pH（与屏幕读数同一套取整）；svgkit 默认读坐标
        ariaText: function (pt, m) {
          var V = m && typeof m.x === "number" ? m.x : 0, s = M.pairState(pair, V);
          return "滴入 V = " + fx(V, 1) + " mL，pH = " + fx(s.pH, 2) + "，" + STAGE_TEXT[s.stage];
        },
        color: "blue"
      });
      P.on("start", function () { st.moved = false; });
      P.on("drag", function () { st.moved = true; sync(true); });
      // 拖动结束补一次：最后一个 pointermove 没赶上 rAF 帧时，读数和图也对齐到取样点的最终位置。
      // 松手时取样点动过，这对试剂就算「取样过」
      P.on("end", function () {
        sync(false);
        if (st.moved) markSampled(pair);
        st.moved = false;
      });
      // 键盘移动：svgkit 的方向键移动也会发 start / drag / end，同上
      buildBeaker();
    }

    /* --- 离子条形图：换试剂时重建（不在拖动里），拖动时只改高度（transform）、数字（文字节点）和 data-n --- */
    function buildBars(id) {
      clear(barsEl);
      bars = [];
      M.PAIRS[id].ions.forEach(function (ion) {
        var col = el("div", "so-col");
        col.setAttribute("data-ion", ion);
        col.setAttribute("data-n", "0");
        var cnt = el("span", "so-cnt", "0");
        var track = el("div", "so-track");
        var fill = el("i", "so-fill");
        fill.style.background = ION_CSS[ion] || "var(--muted)";
        track.appendChild(fill);
        var lab = el("span", "so-ion", ion);
        lab.style.color = ION_TEXT[ion] || ION_CSS[ion] || "var(--ink)";
        col.appendChild(cnt); col.appendChild(track); col.appendChild(lab);
        barsEl.appendChild(col);
        bars.push({ ion: ion, col: col, ct: cnt.firstChild, fill: fill, n: -1, k: -1 });
      });
      barsEl.setAttribute("role", "group");
      barsEl.setAttribute("aria-label", "溶液里的离子（示意粒子数）");
    }
    function paintBars(s) {
      for (var i = 0; i < bars.length; i++) {
        var B = bars[i], raw = s.ions[B.ion] || 0, n = Math.round(raw);
        if (n !== B.n) { B.n = n; setText(B.ct, String(n)); B.col.setAttribute("data-n", String(n)); }
        var k = round(clamp(raw / BAR_MAX, 0, 1), 3);
        if (k !== B.k) {
          B.k = k;
          var tf = "scaleY(" + k + ")";
          B.fill.style.webkitTransform = tf;
          B.fill.style.transform = tf;
        }
      }
    }

    /* --- 小烧杯：液面随总体积升高；③ 瓶底的白色沉淀、④ 往上跑的气泡，一个示意粒子画一个 --- */
    var BK = { liq: null, ppt: [], bub: [], bubG: null, solid: null, gas: null, none: null, solidT: null, gasT: null, h: -1, np: -1, ng: -1, mode: 0 };
    var BK_BOTTOM = 96, BK_H = 84; // 烧杯内底的 y、从底到口的高度（viewBox 单位）
    function buildBeaker() {
      var box = $("solute-beaker"), svg = box ? box.querySelector("svg") : null;
      if (!svg) return;
      clear(svg);
      // 液体先画，杯壁后画（压在液体上面），沉淀、气泡最后
      BK.liq = sv("rect", { x: 17, y: 60, width: 58, height: 36, rx: 3, fill: "var(--blue-soft)" }, svg);
      sv("path", { d: "M12 6h6v84q0 8 8 8h40q8 0 8-8V6h6", fill: "none", stroke: "var(--muted)", "stroke-width": 2.2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      BK.ppt = [];
      for (var i = 0; i < 10; i++) {
        BK.ppt.push(sv("circle", { cx: 26 + (i % 5) * 10, cy: 92 - Math.floor(i / 5) * 6, r: 3, fill: "#fff", stroke: "var(--light)", "stroke-width": 1, style: "display:none" }, svg));
      }
      // 气泡放在一个组里，组跟着液面上下移：一半还在液面下、一半已经跑出液面
      BK.bubG = sv("g", null, svg);
      BK.bub = [];
      var bp = [[28, 8], [44, 4], [60, 9], [36, -6], [52, -10], [24, -16], [66, -4], [40, -20], [58, -24], [32, -30]];
      for (var j = 0; j < 10; j++) {
        BK.bub.push(sv("circle", { cx: bp[j][0], cy: bp[j][1], r: 2.8, fill: "none", stroke: "var(--blue)", "stroke-width": 1.3, style: "display:none" }, BK.bubG));
      }
      BK.solid = box.querySelector("[data-solid]");
      BK.gas = box.querySelector("[data-gas]");
      BK.none = box.querySelector("[data-none]");
      BK.solidT = BK.solid ? textOf(BK.solid.querySelector("b")) : { nodeValue: "" };
      BK.gasT = BK.gas ? textOf(BK.gas.querySelector("b")) : { nodeValue: "" };
    }
    function beakerMode(id) {
      BK.mode = id;
      if (BK.solid) BK.solid.hidden = id !== 3;
      if (BK.gas) BK.gas.hidden = id !== 4;
      if (BK.none) BK.none.hidden = id === 3 || id === 4;
      BK.h = -1; BK.np = -1; BK.ng = -1;
    }
    // s：按 countV 算的状态（沉淀、气体的粒子数）；液面跟着真实的 V（st.V）走
    function paintBeaker(s) {
      if (!BK.liq) return;
      // 总体积 20～60 mL 对应液面高 28～84（烧杯按 60 mL 画）
      var h = round((VOL0 + st.V) / (VOL0 + VMAX) * BK_H, 1);
      if (h !== BK.h) {
        BK.h = h;
        BK.liq.setAttribute("y", String(BK_BOTTOM - h));
        BK.liq.setAttribute("height", String(h));
        // 液面很高时气泡组不再往上移：最上面的气泡（液面上方 30）也留在画面里，十个都看得见
        BK.bubG.setAttribute("transform", "translate(0," + Math.max(BK_BOTTOM - h, 34) + ")");
      }
      var np = BK.mode === 3 ? Math.round(s.precipitate["BaSO₄"] || 0) : 0;
      if (np !== BK.np) {
        BK.np = np;
        for (var i = 0; i < BK.ppt.length; i++) BK.ppt[i].style.display = i < np ? "" : "none";
        if (BK.solid) { BK.solid.setAttribute("data-n", String(np)); setText(BK.solidT, String(np)); }
      }
      var ng = BK.mode === 4 ? Math.round(s.gas["CO₂"] || 0) : 0;
      if (ng !== BK.ng) {
        BK.ng = ng;
        for (var j = 0; j < BK.bub.length; j++) BK.bub[j].style.display = j < ng ? "" : "none";
        if (BK.gas) { BK.gas.setAttribute("data-n", String(ng)); setText(BK.gasT, String(ng)); }
      }
    }

    /* --- 取样卡片：只在（试剂对、阶段、是不是还没开始滴）变了时改文字 --- */
    function paintSample(s) {
      var zero = st.V === 0, key = pair + "|" + s.stage + "|" + (zero ? 0 : 1);
      if (key === st.cardKey) return;
      st.cardKey = key;
      var empty = !s.solutes.length;
      setText(T.solutes, empty ? "没有溶质" : s.solutes.join("、"));
      sampleEl.setAttribute("data-empty", empty ? "true" : "false");
      setText(T.not, zero ? "还没有生成物" : NOT_SOLUTE[pair]);
      setText(T.note, NOTES[pair][zero ? "zero" : s.stage]);
    }

    function paintPoint(stage) {
      if (!P || !P.node) return;
      var c = STAGE_COLOR[stage] || "blue";
      ["blue", "green", "coral"].forEach(function (k) { P.node.classList.toggle("sk-c-" + k, k === c); });
    }

    // 算示意粒子数用的体积：V 取到最近的「整数个滴入粒子」（COUNT_STEP 的整数倍），条形图、沉淀、气体的数才守恒
    // （例如③在 V = 11 mL 时按 12 mL 算：Ba²⁺ 4 + BaSO₄ 6 = 10，OH⁻ 8 = 2 × Ba²⁺）。
    // 不跨过恰好完全反应那一点（V < 20 时最多 20 − q、V > 20 时至少 20 + q，和阶段标签、取样卡片说的一致；
    // 吸到 20 时就是 20），已经开始滴（V > 0）时至少算一份，卡片上说「生成了……」时条形图也看得到
    function countV(id, V) {
      var q = COUNT_STEP[id] || 1;
      if (V <= 0) return 0;
      if (V === VEQ) return VEQ;
      var n = Math.round(V / q) * q;
      if (n < q) n = q;
      if (V < VEQ && n > VEQ - q) n = VEQ - q;
      if (V > VEQ && n < VEQ + q) n = VEQ + q;
      return clamp(n, 0, VMAX);
    }
    function sync(fromDrag, noTrack) {
      var m = typeof P.meta === "function" ? P.meta() : null;
      var V = m && typeof m.x === "number" && isFinite(m.x) ? m.x : 0;
      st.V = V; VS[pair] = V;
      var s = M.pairState(pair, V);
      st.s = s;
      var Vc = countV(pair, V);
      if (Vc !== st.Vc || !st.cs || st.cs.id !== pair) { st.Vc = Vc; st.cs = Vc === V ? s : M.pairState(pair, Vc); }
      var cs = st.cs;
      var vt = fx(V, 1);
      if (vt !== st.vText) { st.vText = vt; setText(T.v, vt); setText(T.sv, vt); }
      var pt = fx(s.pH, 2);
      if (pt !== st.phText) {
        st.phText = pt;
        setText(T.ph, pt);
        var p2 = +pt;
        setText(T.nature, p2 < 7 ? "酸性" : p2 > 7 ? "碱性" : "中性");
      }
      if (s.stage !== st.stage) {
        st.stage = s.stage;
        stageEl.setAttribute("data-stage", s.stage);
        setText(T.stage, STAGE_TEXT[s.stage]);
        paintPoint(s.stage);
      }
      var eq = V >= VEQ;
      if (eq !== st.eqShown) { st.eqShown = eq; setShown(eqPt, eq); }
      paintBars(cs);
      paintBeaker(cs);
      paintSample(s);
      if (!noTrack) track();
      b.update();
    }

    function allSampled() { return sampled[1] && sampled[2] && sampled[3] && sampled[4]; }
    // 取样过的试剂对：按钮右上角打 ✓；「四对试剂都取样看看」在四对都取样过、或者任务早就完成时藏起
    function paintSampled() {
      pairBtns.forEach(function (x) { x.classList.toggle("is-sampled", !!sampled[+x.getAttribute("data-pair")]); });
      var todo = !(allSampled() || TASKS.curve);
      if (todoEl) todoEl.hidden = !todo;
      if (leadEl) leadEl.classList.toggle("so-todo-on", todo); // 手机上这时说明只写前半句，见页面 CSS
    }
    function markSampled(id) {
      if (!sampled[id]) { sampled[id] = true; paintSampled(); }
      if (allSampled()) markTask("curve");
    }
    onTasks.push(paintSampled);

    /* --- 预测关卡（部件 cc-curve，只属于③） --- */
    function lockedNow() { return pair === 3 && gate.locked; }
    function applyLock() {
      var eff = lockedNow();
      if (P) P.enable(!eff);
      wrap.classList.toggle("so-locked", eff);
      // 遮罩由引擎挂在 #solute-curve-boards 上；不在③时 CSS 把它藏起来，这里同步 data-qz-locked（锁着的才写）
      if (pair === 3 && gate.locked && gate.api) wrap.setAttribute("data-qz-locked", "true");
      else wrap.removeAttribute("data-qz-locked");
    }
    // 提交预测后（没锁着）③ 的取样点走过的范围；完成条件是既到过 ≤ 5 mL，也到过 ≥ 35 mL。
    // 进度 = [5, 35] 这一段被走过的范围盖住了多少（引擎只在「动手」阶段显示，别的时候调用也没关系）
    function track() {
      if (pair !== 3 || !gate.api || gate.locked) return;
      var V = st.V;
      if (gate.min === null || V < gate.min) gate.min = V;
      if (gate.max === null || V > gate.max) gate.max = V;
      report();
    }
    function report() {
      if (!gate.api || gate.min === null) return;
      var ok = gate.min <= GATE_LOW && gate.max >= GATE_HIGH;
      var cov = ok ? 1 : clamp((Math.min(gate.max, GATE_HIGH) - Math.max(gate.min, GATE_LOW)) / (GATE_HIGH - GATE_LOW), 0, 1);
      var pct = Math.round(cov * 100);
      // 百分数变了才报：引擎每次都会改进度文字，拖动时少改几次 DOM
      if (pct !== gate.pct && !gate.doneSent) { gate.pct = pct; gate.api.onProgress(cov); }
      if (ok && !gate.doneSent) { gate.doneSent = true; gate.api.done(); }
    }
    function lock() { gate.locked = true; applyLock(); }
    function unlock() {
      gate.locked = false;
      applyLock();
      track();
      // 引擎解锁后会先清空进度提示、80 ms 后再写「现在动手验证……」。取样点原来就走过一段（例如切走再切回来）时，
      // 等它写完再报一次进度；还是 0 时不报，留着那句操作提示
      setTimeout(function () {
        if (gate.locked || gate.doneSent || gate.pct <= 0) return;
        gate.pct = -1;
        report();
      }, 150);
    }
    // 重新预测：③ 的取样点回到 V = 0，走过的范围、进度清零（done 可以再报一次）。随后引擎会再锁上
    function reset() {
      gate.min = null; gate.max = null; gate.pct = -1; gate.doneSent = false;
      VS[3] = 0;
      if (pair === 3 && P) { P.set([0, phAt(0)]); sync(false, true); }
    }
    // 「实际结果」：V = 20 mL（恰好完全反应）时③ 的四种离子的条形图，四根都是 0，用文字标出离子名和「0」；
    // 虚线框是开始时（V = 0）的粒子数，看得出它们都不见了
    function result() {
      var ions = M.PAIRS[3].ions, s20 = M.pairState(3, VEQ), s0 = M.pairState(3, 0);
      var items = [{ t: "segment", a: [0, 0], b: [ions.length, 0], color: "muted", width: 1.5 }];
      ions.forEach(function (ion, i) {
        var x = i + 0.5, n0 = s0.ions[ion] || 0, n = Math.round(s20.ions[ion] || 0);
        if (n0 > 0) items.push({ t: "polyline", pts: [[x - 0.3, 0], [x - 0.3, n0], [x + 0.3, n0], [x + 0.3, 0]], dash: true, color: "muted", width: 1.2 });
        items.push({ t: "segment", a: [x - 0.3, 0], b: [x + 0.3, 0], color: ION_SK[ion] || "ink", width: 6 });
        items.push({ t: "text", at: [x, 0], s: String(n), pos: "n", color: "ink" });
        items.push({ t: "text", at: [x, 0], s: ion, pos: "s", color: "ink" });
      });
      // 手机上对比栏只有一百多 px 宽，图要高一些（ratio 0.9），虚线框里放得下「0」；
      // 宽屏一栏有四五百 px，0.9 就太高了、大半是空白，用 0.6
      var wide = false;
      try { wide = !!(window.matchMedia && window.matchMedia("(min-width: 600px)").matches); } catch (e) { wide = false; }
      return {
        figure: { view: [0, ions.length, -6, 22], aspect: "fill", ratio: wide ? 0.6 : 0.9, axes: null, items: items, alt: "V = 20 mL 时四种离子的示意粒子数" },
        note: "V = 20 mL（恰好完全反应）时四种离子都是 0；虚线框是开始时的粒子数"
      };
    }
    function bind(api) { gate.api = api; return { lock: lock, unlock: unlock, reset: reset, result: result }; }
    // 引擎或题库没加载成功：③ 照常能拖，不让学生卡在锁上；msg 给了就在作答区写一句
    function freeGate(msg) {
      gate.api = null; gate.locked = false; gate.failed = true;
      applyLock();
      var ans = $("qz-curve-ans");
      if (msg && ans && !ans.querySelector(".qz-error")) {
        clear(ans);
        ans.appendChild(el("p", "so-load", msg));
      }
    }
    var GATE_FAIL = "预测题没有加载成功：③ 可以直接拖；刷新页面可以再试一次。";
    function ensureGate() {
      if (gate.p) return gate.p;
      var ansHost = $("qz-curve-ans"), promptHost = $("qz-curve-prompt");
      if (!Q || typeof Q.registerExternal !== "function" || typeof Q.mount !== "function") {
        freeGate(GATE_FAIL);
        gate.p = Promise.resolve(null);
        return gate.p;
      }
      // 题目加载要一会儿：这期间先按锁定处理，拖动的结果不算数（加载失败时放开，见 freeGate）
      gate.locked = true;
      gate.p = Promise.resolve().then(function () {
        return Q.mount(ansHost, { items: [QID_POE], mode: "poe", promptHost: promptHost });
      }).then(function (ctrl) {
        var card = ctrl && typeof ctrl.card === "function" ? ctrl.card(QID_POE) : null;
        if (!card || !gate.api) {
          // 题目没加载成功（或这道题被过滤掉）：不挂预测关卡，③ 照常可以拖
          freeGate(GATE_FAIL);
          return ctrl || null;
        }
        gate.card = card;
        gate.stage = card.stage();
        var cel = card.el;
        // 跟着卡片的阶段（data-stage 是属性变动，不触发 linker 的 childList 监听）
        if (cel && typeof MutationObserver === "function") {
          new MutationObserver(function () { gate.stage = cel.getAttribute("data-stage") || ""; }).observe(cel, { attributes: true, attributeFilter: ["data-stage"] });
        }
        applyLock();
        return ctrl;
      }).catch(function (e) {
        if (window.console && console.warn) console.warn("预测关卡加载失败", e);
        freeGate(GATE_FAIL);
        return null;
      });
      return gate.p;
    }

    /* --- 换试剂 --- */
    function paintPairs() {
      pairBtns.forEach(function (x) { x.setAttribute("aria-pressed", +x.getAttribute("data-pair") === pair ? "true" : "false"); });
    }
    function selectPair(id) {
      id = +id;
      if (!M.PAIRS[id]) return false;
      if (built && id === pair) return true;
      pair = id;
      paintPairs();
      full = curveOf(id);
      st.partAt = -1; st.cardKey = ""; st.stage = ""; st.vText = ""; st.phText = ""; st.cs = null;
      buildBars(id);
      beakerMode(id);
      panel.classList.toggle("so-gate-off", id !== 3);
      if (id === 3) ensureGate();
      applyLock();
      P.set([VS[id], phAt(VS[id])]);
      sync(false);
      built = true;
      return true;
    }
    pairBtns.forEach(function (x) {
      x.addEventListener("click", function () { selectPair(+x.getAttribute("data-pair")); });
    });

    build();
    // 先注册外部部件（mount 之前必须注册）；第一次选③时才 mount
    if (Q && typeof Q.registerExternal === "function") {
      Q.registerExternal(WIDGET_ID, { cover: wrap, bind: bind });
    }
    selectPair(1);
    paintSampled();

    return {
      resize: function () { if (b) b.resize(); },
      select: selectPair,
      ensureGate: ensureGate,
      get: function () {
        // ions / precipitate / gas 是屏幕上显示的示意粒子数（按 countV 的体积 Vc 算，整数）；pH、阶段、溶质按真实的 V
        var s = st.s || M.pairState(pair, st.V), cs = st.cs || s, ions = {}, ppt = {}, gas = {};
        Object.keys(cs.ions).forEach(function (k) { ions[k] = Math.round(cs.ions[k]); });
        Object.keys(cs.precipitate).forEach(function (k) { ppt[k] = Math.round(cs.precipitate[k]); });
        Object.keys(cs.gas).forEach(function (k) { gas[k] = Math.round(cs.gas[k]); });
        return {
          pair: pair, V: st.V, Vc: st.Vc, pH: s.pH, phText: fx(s.pH, 2), stage: s.stage, ions: ions, precipitate: ppt, gas: gas,
          solutes: s.solutes.slice(), locked: lockedNow(), minV: gate.min, maxV: gate.max,
          sampled: copyObj(sampled), done: !!TASKS.curve,
          gateLocked: gate.locked, gateStage: gate.stage || null, gateDone: gate.doneSent, gateMounted: !!gate.card, VS: copyObj(VS)
        };
      },
      boards: function () { return { ph: b, fn: b }; },
      handle: function () { return P; },
      gate: function () { return gate.p; }
    };
  })();
  PANELS.curve = curve;

  /* ==================== 情境 spoil：NaOH 变质探究 ==================== */
  var spoil = (function () {
    var rack = $("so-rack"), log = $("so-log"), hint = $("so-hint"), allMsg = $("so-all"), addLab = $("so-add-lab");
    var hintT = textOf(hint), allT = textOf(allMsg), addLabT = textOf(addLab);
    var sampleBtns = $$(".so-btn[data-sample]", $("solute-lab"));
    var newBtn = document.querySelector("[data-tube-new]");
    var reagentBtns = $$("[data-reagent]");
    var selects = {}, fbs = {};
    LETTERS.forEach(function (x) {
      selects[x] = document.querySelector('[data-judge="' + x + '"]');
      fbs[x] = document.querySelector('[data-fb="' + x + '"]');
    });
    // tubes：试管架上的试管（最多 MAX_TUBES 支）；made：这一组样品做过的所有试管（架上收走的也留着），核对时都算证据。
    // verdict：每份样品最近一次核对的结果 { choice, status, text }，status 是 correct / contradicted / ambiguous / unchosen，
    // 还没核对（或改了选项）时为 null
    var st = {
      assign: {}, tubes: [], made: [], cur: null, sel: "A", seq: 0,
      verdict: { A: blankVerdict(""), B: blankVerdict(""), C: blankVerdict("") }, correct: false
    };
    function blankVerdict(choice) { return { choice: choice || "", status: null, text: "" }; }

    // 三份样品随机对应三种情况（一种一份）；「换一组样品」时保证和上一组不一样
    function shuffled() {
      var a = CASES.slice();
      for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
      return { A: a[0], B: a[1], C: a[2] };
    }
    function sig(o) { return LETTERS.map(function (x) { return o[x] || ""; }).join(","); }
    function newAssign() {
      var old = sig(st.assign), a = shuffled(), n = 0;
      while (sig(a) === old && n++ < 20) a = shuffled();
      st.assign = a;
    }

    /* --- 试管：每加一步试剂整支重画（不在拖动里，开销无所谓） --- */
    function drawTube(t) {
      var model = t.model, red = M.isRed(model), ppt = !!model.CaCO3, last = t.last, bub = !!(last && last.bubbles);
      t.el.setAttribute("data-red", red ? "true" : "false");
      t.el.setAttribute("data-precipitate", ppt ? "true" : "false");
      t.el.setAttribute("data-bubbles", bub ? "true" : "false");
      t.el.setAttribute("data-steps", t.steps.join(","));
      var svg = t.svg;
      clear(svg);
      // 液面：样品占三成，每加一种试剂多一截
      var h = 26 + t.steps.length * 16, top = 100 - h;
      sv("path", { d: "M10 " + top + "V" + 92 + "a13 13 0 0 0 26 0V" + top + "z", "class": "tb-liq" }, svg);
      if (ppt) {
        // 白色沉淀：试管底部一层小颗粒
        [[17, 98], [23, 100], [29, 98], [20, 94], [26, 95], [32, 94], [14, 93]].forEach(function (p) {
          sv("circle", { cx: p[0], cy: p[1], r: 2.6, "class": "tb-ppt" }, svg);
        });
      }
      if (bub) {
        var g = sv("g", null, svg);
        [[16, top + 18], [25, top + 30], [31, top + 12], [20, top + 40], [28, top + 22]].forEach(function (p) {
          sv("circle", { cx: p[0], cy: p[1], r: 2.4, "class": "tb-bub" }, g);
        });
      }
      sv("path", { d: "M8 4V92a15 15 0 0 0 30 0V4", "class": "tb-glass" }, svg);
      sv("path", { d: "M5 4H41", "class": "tb-glass" }, svg);
      t.stepsT.nodeValue = t.steps.length ? t.steps.map(function (r) { return REAGENT_SHORT[r] || r; }).join(" → ") : "只有样品";
      t.obsT.nodeValue = last ? last.text : "还没加试剂";
    }
    function makeTube(letter) {
      var t = {
        id: ++st.seq, sample: letter, model: M.newTube(st.assign[letter]), steps: [], obs: [], last: null,
        el: null, svg: null, stepsT: null, obsT: null
      };
      var fig = el("figure", "tube");
      fig.setAttribute("data-sample", letter);
      fig.setAttribute("data-tube", String(t.id));
      fig.appendChild(el("span", "tube-tag", letter));
      t.svg = sv("svg", { viewBox: "0 0 46 108", "aria-hidden": "true", focusable: "false" }, fig);
      var steps = el("p", "tube-steps", "");
      var obs = el("p", "tube-obs", "");
      fig.appendChild(steps); fig.appendChild(obs);
      t.stepsT = steps.firstChild; t.obsT = obs.firstChild;
      t.el = fig;
      drawTube(t);
      return t;
    }
    function paintCur() {
      st.tubes.forEach(function (t) { t.el.classList.toggle("cur", t === st.cur); });
    }
    // 当前试管的逐步现象（ol），只在加试剂、换试管时重建
    function paintLog() {
      clear(log);
      var t = st.cur;
      if (!t) return;
      t.steps.forEach(function (r, i) {
        var li = document.createElement("li");
        var bb = document.createElement("b");
        bb.appendChild(document.createTextNode(M.REAGENTS[r] || r));
        li.appendChild(document.createTextNode("加入"));
        li.appendChild(bb);
        li.appendChild(document.createTextNode("：" + t.obs[i]));
        log.appendChild(li);
      });
    }
    function paintControls(msg) {
      var t = st.cur, n = t ? t.steps.length : 0;
      // 选中的样品和当前试管里的不是同一份：先不让加试剂，免得以为加进了新选的样品（要先取样到新试管）
      var other = !!t && t.sample !== st.sel;
      reagentBtns.forEach(function (x) {
        var r = x.getAttribute("data-reagent");
        // 同一种试剂在一支试管里只加一次：重复加没有新现象
        x.disabled = !t || other || n >= MAX_STEPS || t.steps.indexOf(r) >= 0;
      });
      // 试剂区的小标题写出当前试管装的是哪份样品
      setText(addLabT, t ? "② 往样品 " + t.sample + " 的试管里依次加试剂（最多 3 步）" : "② 往这支试管里依次加试剂（最多 3 步）");
      var h = msg;
      if (!h) {
        if (!t) h = "先点「取样到新试管」。";
        else if (other) h = "现在选的是样品 " + st.sel + "：先点「取样到新试管」。";
        else if (n === 0) h = "样品 " + t.sample + " 已经取到新试管里：选一种试剂加进去。";
        else if (n < MAX_STEPS) h = "可以接着加（还能加 " + (MAX_STEPS - n) + " 步），也可以再取一支新试管。";
        else h = "这支试管已经加了 3 种试剂。再取一支新试管，换个顺序试试。";
      }
      setText(hintT, h);
    }
    function paintSamples() {
      sampleBtns.forEach(function (x) { x.setAttribute("aria-pressed", x.getAttribute("data-sample") === st.sel ? "true" : "false"); });
    }

    function pick(letter) {
      if (LETTERS.indexOf(letter) < 0) return;
      st.sel = letter;
      paintSamples();
      paintControls();
    }
    function newTube() {
      var t = makeTube(st.sel);
      st.tubes.push(t);
      st.made.push(t);
      // 新试管排在最前面（离试剂按钮最近），做过的往后排
      rack.insertBefore(t.el, rack.firstChild);
      while (st.tubes.length > MAX_TUBES) {
        var old = st.tubes.shift();
        if (old.el.parentNode) old.el.parentNode.removeChild(old.el);
      }
      st.cur = t;
      paintCur(); paintLog(); paintControls();
      return t;
    }
    function add(reagent) {
      var t = st.cur;
      if (!t || t.steps.length >= MAX_STEPS || t.steps.indexOf(reagent) >= 0 || !M.REAGENTS[reagent]) return false;
      var r = M.addReagent(t.model, reagent);
      if (!r) return false;
      t.model = r.tube; t.last = r;
      t.steps.push(reagent); t.obs.push(r.text);
      drawTube(t); paintLog(); paintControls();
      return true;
    }

    /* --- 下结论：「证据够了才算对」 ---
     * 核对时不直接拿答案比，而是看这份样品做过的所有试管（试剂顺序 + 每一步看到的气泡、沉淀、颜色）：
     * ABSLabChem.judgeSample 把这些现象分别套到三种情况上，只留下每一步都对得上的情况。
     *   correct       只剩一种可能，并且就是选的那种 → ✓
     *   contradicted  选的那种已经被看到的现象排除 → 「和你看到的现象对不上」
     *   ambiguous     选的那种还在，但还分不出两三种情况（一支试管都没做时也是这样）→ 提示再设计一步实验
     * 三份都是 correct 才算完成任务：光靠猜（三个选项是一一对应的，按几次核对就能试出来）不算。
     * 反馈只根据学生自己看到的现象，不会说出正确答案 */
    function tubesOf(x) {
      return st.made.filter(function (t) { return t.sample === x; }).map(function (t) { return { steps: t.model.steps || [] }; });
    }
    function paintFeedback(x) {
      var fb = fbs[x], vd = st.verdict[x];
      if (!fb) return;
      fb.textContent = vd.text || "";
      if (!vd.status) fb.removeAttribute("data-ok");
      else fb.setAttribute("data-ok", vd.status === "correct" ? "true" : vd.status === "contradicted" ? "false" : "wait");
    }
    function clearFeedback(x) {
      st.verdict[x] = blankVerdict(selects[x] ? selects[x].value : "");
      paintFeedback(x);
    }
    function check() {
      var all = true;
      LETTERS.forEach(function (x) {
        var v = selects[x] ? selects[x].value : "";
        if (!v) {
          st.verdict[x] = { choice: "", status: "unchosen", text: "先选一个结论" };
        } else {
          var r = M.judgeSample(tubesOf(x), v);
          st.verdict[x] = { choice: v, status: r.status, text: r.status === "contradicted" ? "和你看到的现象对不上" : r.text };
        }
        if (st.verdict[x].status !== "correct") all = false;
        paintFeedback(x);
      });
      st.correct = all;
      setText(allT, all ? "三份样品都判断对了！" : "");
      if (all) markTask("spoil");
      return all;
    }
    function reshuffle() {
      newAssign();
      st.tubes.forEach(function (t) { if (t.el.parentNode) t.el.parentNode.removeChild(t.el); });
      st.tubes = []; st.made = []; st.cur = null; st.correct = false;
      LETTERS.forEach(function (x) {
        if (selects[x]) selects[x].value = "";
        clearFeedback(x);
      });
      setText(allT, "");
      paintLog();
      paintControls("换了一组样品：A、B、C 重新打乱了。先点「取样到新试管」。");
    }

    sampleBtns.forEach(function (x) { x.addEventListener("click", function () { pick(x.getAttribute("data-sample")); }); });
    if (newBtn) newBtn.addEventListener("click", newTube);
    reagentBtns.forEach(function (x) { x.addEventListener("click", function () { add(x.getAttribute("data-reagent")); }); });
    LETTERS.forEach(function (x) {
      if (!selects[x]) return;
      selects[x].addEventListener("change", function () {
        clearFeedback(x);
        st.correct = false;
        setText(allT, "");
      });
    });
    var checkBtn = document.querySelector("[data-judge-check]");
    if (checkBtn) checkBtn.addEventListener("click", check);
    var shuffleBtn = document.querySelector("[data-reshuffle]");
    if (shuffleBtn) shuffleBtn.addEventListener("click", reshuffle);

    // 试剂按钮、结论选项的文字取模型里的名字（REAGENTS、SAMPLE_NAME），和题库、单元测试同一套叫法
    reagentBtns.forEach(function (x) { var r = M.REAGENTS[x.getAttribute("data-reagent")]; if (r && x.textContent !== r) x.textContent = r; });
    LETTERS.forEach(function (x) {
      if (!selects[x]) return;
      $$("option", selects[x]).forEach(function (o) { var nm = M.SAMPLE_NAME[o.value]; if (nm && o.textContent !== nm) o.textContent = nm; });
    });
    newAssign();
    LETTERS.forEach(function (x) { if (selects[x]) selects[x].value = ""; });
    paintSamples();
    paintControls();

    return {
      get: function () {
        var verdict = {};
        LETTERS.forEach(function (x) { verdict[x] = copyObj(st.verdict[x]); });
        return {
          assign: copyObj(st.assign),
          // 试管架上的试管，按取样的先后（最早的在前）；页面上最新的一支排在最前面。made：这一组样品一共做过几支
          tubes: st.tubes.map(function (t) {
            return { sample: t.sample, steps: t.steps.slice(), obs: t.obs.slice(), red: M.isRed(t.model), precipitate: !!t.model.CaCO3,
              bubbles: !!(t.last && t.last.bubbles), cur: t === st.cur };
          }),
          made: st.made.length,
          verdict: verdict, correct: st.correct, sel: st.sel, curSample: st.cur ? st.cur.sample : null, done: !!TASKS.spoil
        };
      },
      boards: function () { return null; },
      handle: function () { return null; }
    };
  })();
  PANELS.spoil = spoil;

  /* ==================== 初始标签页、深链 ==================== */
  paintTabs();
  pickInitialTab();
  window.addEventListener("abs-auth-changed", function () { TASKS = loadTasks(); paintTabs(); });

  function scrollToQid(qid) {
    var t = $("qz-" + qid);
    if (t && t.scrollIntoView) { try { t.scrollIntoView({ block: "start" }); } catch (e) { t.scrollIntoView(true); } }
  }
  function fail(n, text) {
    if (!n) return;
    clear(n);
    n.appendChild(el("p", "so-load", text));
  }

  /* ==================== 练一练 ==================== */
  // 默认收起，第一次展开时才 mount（9 道题的缩略图不在打开页面时就画，手机上省时间）
  var practice = $("so-practice"), more = $("so-more"), moreP = null;
  function ensureMore() {
    if (moreP) return moreP;
    if (!Q || typeof Q.mount !== "function" || typeof Q.load !== "function") {
      fail(more, "题目没有加载成功，请检查网络后刷新页面。");
      moreP = Promise.resolve(null);
      return moreP;
    }
    // cc 里 retest: true 的题（二段式、迁移、逆向），按题库顺序；预测关卡在上面的情境里，不在这里出
    moreP = Q.load().then(function (bank) {
      var ids = bank.items.filter(function (it) { return it.module === MODULE && it.retest === true; }).map(function (it) { return it.id; });
      return Q.mount(more, { items: ids, mode: "practice" });
    }).catch(function (e) {
      if (window.console && console.warn) console.warn("练一练加载失败", e);
      fail(more, "题目没有加载成功，请检查网络后刷新页面。");
      return null;
    });
    return moreP;
  }
  if (practice) {
    practice.addEventListener("toggle", function () { if (practice.open) ensureMore(); });
  }
  function openMore() {
    if (practice && !practice.open) practice.open = true;
    return ensureMore();
  }

  // #qz-<题目 id>（导图上的「理解测试」标签、重测页的「回到题目所在页面」都这样链）：卡片异步渲染，渲染完再定位。
  //   #qz-c-cc-poe：切到 curve、选③，题干渲染出来后滚到题干；其他题：展开练一练，滚到那道题。
  // 打开页面时按地址里的 # 定位；页面已经开着、只改了 #（例如在页面里点了指向本页某道题的链接）时同样处理
  function goToQid(qid) {
    if (!qid) return;
    if (qid === QID_POE) {
      show("curve", false);
      curve.select(3);
      var p = curve.gate();
      if (p && typeof p.then === "function") p.then(function () { scrollToQid(QID_POE); });
      else scrollToQid(QID_POE);
    } else {
      openMore().then(function () { scrollToQid(qid); });
    }
  }
  goToQid(HASH_QID);
  window.addEventListener("hashchange", function () { goToQid(qidOf(location.hash)); });

  /* ==================== 测试钩子（CONTRACT 第 5 节，只读） ==================== */
  window.__solute = {
    tab: function () { return CUR; },
    show: function (key) { return show(key, false); },
    get: function (key) { var T = PANELS[key || CUR]; return T ? T.get() : null; },
    boards: function (key) { var T = PANELS[key || CUR]; return T ? T.boards() : null; },
    handle: function (key) { var T = PANELS[key || CUR]; return T ? T.handle() : null; },
    tasks: function () { return { curve: !!TASKS.curve, spoil: !!TASKS.spoil }; },
    gate: function () { return curve.gate() || Promise.resolve(null); },
    more: function () { return openMore(); }
  };
})();
