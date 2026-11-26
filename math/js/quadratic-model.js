/* ABS-LAB「二次函数实验室」的数学模型（math/quadratic.html 三个情境 + 题库 math-m2.json 里的数值）
 *
 * 浏览器里是 window.ABSLabQuadratic，node 里 require 得到同一个对象：
 *   - math/quadratic.html 用它算顶点、对称轴、区间最值、平移描述，写解析式；
 *   - tests/batch1b-content.test.js 用它重新算出题目里的数值和选项缩略图，和题库核对；
 *   - tests/quadratic-model.test.js 测边界情况。
 * 全部是初中内容（九年级上册 第二十二章 二次函数）。解析式里的减号一律用「−」（U+2212）。
 * 语法不超过 ES2019（不用 ?. 和 ??），与 shared/*.js 一样用 var + function。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ABSLabQuadratic = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var MINUS = "−";
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }
  function round(v, n) {
    var k = Math.pow(10, n == null ? 4 : n);
    var r = Math.round(v * k) / k;
    return r === 0 ? 0 : r;
  }
  // 数字写法：去掉多余的 0（2、0.5、1.25），负号用「−」
  function fmt(v, n) {
    var r = round(v, n == null ? 2 : n);
    var s = String(Math.abs(r));
    return (r < 0 ? MINUS : "") + s;
  }

  /* ---------- 顶点式 ↔ 一般式 ---------- */
  // y = a(x − h)² + k  ⇔  y = ax² + bx + c，b = −2ah，c = ah² + k
  function vertexToGeneral(a, h, k) {
    a = num(a, 1); h = num(h, 0); k = num(k, 0);
    return { a: a, b: round(-2 * a * h, 10), c: round(a * h * h + k, 10) };
  }
  // 顶点 h = −b/(2a)，k = c − b²/(4a)
  function generalToVertex(a, b, c) {
    a = num(a, 1); b = num(b, 0); c = num(c, 0);
    if (a === 0) return null;
    return { a: a, h: round(-b / (2 * a), 10), k: round(c - b * b / (4 * a), 10) };
  }
  function axis(a, b) { a = num(a, 1); return a === 0 ? null : round(-num(b, 0) / (2 * a), 10); }
  function valueAt(a, h, k, x) { return num(a, 1) * Math.pow(num(x, 0) - num(h, 0), 2) + num(k, 0); }
  function valueGeneral(a, b, c, x) { x = num(x, 0); return num(a, 1) * x * x + num(b, 0) * x + num(c, 0); }

  /* ---------- 区间最值 ---------- */
  // y = a(x − h)² + k 在 x1 ≤ x ≤ x2 上的最小值、最大值，以及对称轴相对区间的位置（三种情况）：
  //   case "left"：对称轴在区间左侧（h < x1）；"inside"：在区间内（含端点）；"right"：在区间右侧（h > x2）
  // 对称轴在区间里时，顶点处取到一个最值（a > 0 最小、a < 0 最大），另一个在离对称轴较远的端点；
  // 不在区间里时，函数在区间上单调，两个最值都在端点
  function intervalExtrema(a, h, k, x1, x2) {
    a = num(a, 1); h = num(h, 0); k = num(k, 0); x1 = num(x1, 0); x2 = num(x2, 0);
    if (x1 > x2) { var t = x1; x1 = x2; x2 = t; }
    var cs = h < x1 ? "left" : h > x2 ? "right" : "inside";
    var p1 = { x: x1, y: valueAt(a, h, k, x1) }, p2 = { x: x2, y: valueAt(a, h, k, x2) };
    var cands = [p1, p2];
    if (cs === "inside") cands.push({ x: h, y: k });
    var mn = cands[0], mx = cands[0];
    cands.forEach(function (p) { if (p.y < mn.y - 1e-12) mn = p; if (p.y > mx.y + 1e-12) mx = p; });
    return {
      "case": cs,
      min: { x: round(mn.x, 10), y: round(mn.y, 10) },
      max: { x: round(mx.x, 10), y: round(mx.y, 10) }
    };
  }

  /* ---------- 平移描述 ---------- */
  // 由 y = x²（顶点 (0, 0)）平移到顶点 (h, k)：「向右 2、向下 1」「向左 3」「向上 0.5」；不动时「不平移」
  function shiftText(h, k) {
    h = round(num(h, 0), 6); k = round(num(k, 0), 6);
    var parts = [];
    if (h > 0) parts.push("向右 " + fmt(h)); else if (h < 0) parts.push("向左 " + fmt(-h));
    if (k > 0) parts.push("向上 " + fmt(k)); else if (k < 0) parts.push("向下 " + fmt(-k));
    return parts.length ? parts.join("、") : "不平移";
  }

  /* ---------- 解析式的写法 ---------- */
  // 系数 a：1 不写，−1 只写「−」，其余写数字
  function coefA(a) {
    a = round(a, 6);
    if (a === 1) return "";
    if (a === -1) return MINUS;
    return fmt(a);
  }
  // 顶点式：y = (x − 2)²、y = −(x + 3)² − 1、y = 0.5x² + 2、y = 2(x − 1)² + 3
  function formatVertex(a, h, k) {
    a = round(num(a, 1), 6); h = round(num(h, 0), 6); k = round(num(k, 0), 6);
    var sq = h === 0 ? "x²" : "(x " + (h > 0 ? MINUS + " " + fmt(h) : "+ " + fmt(-h)) + ")²";
    var s = "y = " + coefA(a) + sq;
    if (k > 0) s += " + " + fmt(k); else if (k < 0) s += " " + MINUS + " " + fmt(-k);
    return s;
  }
  // 一般式：y = x² − 2x − 1、y = −x² − 2x + 1、y = 2x² + x
  function formatGeneral(a, b, c) {
    a = round(num(a, 1), 6); b = round(num(b, 0), 6); c = round(num(c, 0), 6);
    var s = "y = " + coefA(a) + "x²";
    if (b !== 0) s += " " + (b > 0 ? "+" : MINUS) + " " + (Math.abs(b) === 1 ? "" : fmt(Math.abs(b))) + "x";
    if (c !== 0) s += " " + (c > 0 ? "+" : MINUS) + " " + fmt(Math.abs(c));
    return s;
  }

  /* ---------- a、b、c 与图象 ---------- */
  function sign(v) { v = round(num(v, 0), 9); return v > 0 ? "+" : v < 0 ? MINUS : "0"; }
  // 对称轴 x = −b/(2a) 在 y 轴的哪一侧："left" / "right" / "on"（b = 0 时就是 y 轴）
  function axisSide(a, b) {
    var x = axis(a, b);
    if (x === null) return null;
    return x < 0 ? "left" : x > 0 ? "right" : "on";
  }
  // 左同右异：对称轴在 y 轴左侧时 a、b 同号，右侧时异号
  function abSigns(a, b, c) {
    return { a: sign(a), b: sign(b), c: sign(c), side: axisSide(a, b), opens: num(a, 1) > 0 ? "up" : "down", yIntercept: num(c, 0) };
  }

  /* ---------- 靠墙围矩形（篱笆问题） ---------- */
  // 篱笆总长 L，靠墙一边不用篱笆，墙长 wall；垂直于墙的边长 x，平行于墙的边 L − 2x，面积 S = x(L − 2x)。
  // 取值范围：0 < L − 2x ≤ wall ⇒ (L − wall)/2 ≤ x < L/2（墙比 L 还长时下限是 0，开区间）。
  // 对称轴 x = L/4：在范围里时 S 的最大值在顶点；不在范围里（L/4 < 下限）时 S 在范围上随 x 增大而减小，最大值在下限处
  function fence(L, wall) {
    L = num(L, 20); wall = num(wall, L);
    var xMin = Math.max(0, (L - wall) / 2), xMax = L / 2, ax = L / 4;
    var inRange = ax >= xMin && ax < xMax;
    var xBest = inRange ? ax : xMin;
    return {
      L: L, wall: wall, xMin: round(xMin, 10), xMax: round(xMax, 10), xMinOpen: xMin === 0, axis: round(ax, 10),
      inRange: inRange, xAtMax: round(xBest, 10), Smax: round(xBest * (L - 2 * xBest), 10),
      Svertex: round(ax * (L - 2 * ax), 10), S: function (x) { x = num(x, 0); return x * (L - 2 * x); }
    };
  }

  /* ---------- 画图用 ---------- */
  function sample(f, x0, x1, n) {
    n = Math.max(1, Math.round(num(n, 40)));
    var pts = [];
    for (var i = 0; i <= n; i++) { var x = x0 + (x1 - x0) * i / n; pts.push([round(x), round(f(x))]); }
    return pts;
  }
  // 抛物线 y = a(x − h)² + k 在 [x0, x1] 上的点，只留 y 在 [yMin, yMax] 里的那一段（缩略图、函数板的视野）。
  // 视野里的部分是连续的一段（开口向上时去掉两侧太高的部分），所以直接过滤即可
  function parabolaPoints(a, h, k, x0, x1, n, yMin, yMax) {
    var pts = sample(function (x) { return valueAt(a, h, k, x); }, x0, x1, n);
    if (yMin == null && yMax == null) return pts;
    return pts.filter(function (p) { return (yMin == null || p[1] >= yMin - 1e-9) && (yMax == null || p[1] <= yMax + 1e-9); });
  }

  return {
    MINUS: MINUS, round: round, fmt: fmt,
    vertexToGeneral: vertexToGeneral, generalToVertex: generalToVertex, axis: axis,
    valueAt: valueAt, valueGeneral: valueGeneral,
    intervalExtrema: intervalExtrema, shiftText: shiftText,
    formatVertex: formatVertex, formatGeneral: formatGeneral,
    sign: sign, axisSide: axisSide, abSigns: abSigns,
    fence: fence, sample: sample, parabolaPoints: parabolaPoints
  };
});
