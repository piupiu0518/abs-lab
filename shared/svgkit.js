/* ABS-LAB 画板组件 → window.ABSLabSVG（node 里 require 得到同一个对象）
 *
 * 数学交互题、示范题、题目里的静态小图共用这一套 SVG 画板。接口见 README「画板组件」一节。
 * 为什么这样写：
 *  - 学生主要用 390px 宽的手机和微信内置浏览器，用手指拖。拖动走 Pointer Events + setPointerCapture；
 *    pointermove 只记坐标，每帧一次 requestAnimationFrame 统一「换算 → 约束 → 改 DOM → 回调 → 联动重画」，
 *    一帧里不反复读写布局，低端机也跟手。按下时缓存 getScreenCTM() 的逆矩阵，拖动中不再读布局。
 *  - viewBox 用像素尺寸（0 0 宽 高），尺寸变了重新布局：文字、线宽始终是固定像素，
 *    约 170px 宽的选项缩略图里字也不会被缩到看不清；点保存世界坐标，重排后位置不变。
 *  - 只有手指落在「可拖动且可用」的点的触控圈上（或手绘开着时落在画区里）才 preventDefault，
 *    其余地方（包括手绘板四周的坐标轴留白）照常上下滚动页面、双指缩放。
 *  - geo / on 是纯数学，不碰 DOM：加载本文件时不访问 document / window，node 单元测试可直接 require。
 *  - 语法不超过 ES2019，不用第三方库，不请求任何外部资源。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof window !== "undefined" && root === window) root.ABSLabSVG = api;
})(typeof window !== "undefined" ? window : this, function (root) {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";

  /* ============================== geo：纯几何 ============================== */
  // 点一律用 [x, y] 数组（世界坐标，y 轴向上）。

  function isArr(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function cross(ax, ay, bx, by) { return ax * by - ay * bx; }

  function dist(A, B) {
    var dx = B[0] - A[0], dy = B[1] - A[1];
    return Math.sqrt(dx * dx + dy * dy);
  }
  function lerp(A, B, t) { return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]; }

  // P 在直线 AB 上的投影参数（不夹）；A、B 重合时没有方向，约定返回 0（投影就是 A）
  function param(P, A, B) {
    var dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    if (!(L2 > 0)) return 0;
    return ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2;
  }
  function projectSegment(P, A, B) {
    var t = clamp(param(P, A, B), 0, 1);
    return { p: lerp(A, B, t), t: t };
  }
  function polylineLength(pts) {
    var L = 0;
    for (var i = 0; i + 1 < pts.length; i++) L += dist(pts[i], pts[i + 1]);
    return L;
  }
  // 折线上离 P 最近的点。距离相同取前一段：拐角处两段给出同一个点，结果不会来回跳。
  function projectPolyline(P, pts) {
    var n = pts ? pts.length : 0;
    if (!n) return { p: [P[0], P[1]], s: 0, i: -1 };
    if (n === 1) return { p: [pts[0][0], pts[0][1]], s: 0, i: 0 };
    var best = null, bestD = Infinity, acc = 0;
    for (var i = 0; i + 1 < n; i++) {
      var A = pts[i], B = pts[i + 1], L = dist(A, B);
      var r = projectSegment(P, A, B);
      var dx = r.p[0] - P[0], dy = r.p[1] - P[1], d = dx * dx + dy * dy;
      if (d < bestD - 1e-15) { bestD = d; best = { p: r.p, s: acc + r.t * L, i: i }; }
      acc += L;
    }
    return best;
  }
  // 沿折线走到弧长 s 处（夹在 [0, 总长]），给方向键和 on.polyline().along 用
  function atLength(pts, s) {
    var n = pts ? pts.length : 0;
    if (!n) return { p: [0, 0], s: 0, i: -1 };
    if (n === 1) return { p: [pts[0][0], pts[0][1]], s: 0, i: 0 };
    var total = polylineLength(pts);
    s = clamp(+s || 0, 0, total);
    var acc = 0;
    for (var i = 0; i + 1 < n; i++) {
      var L = dist(pts[i], pts[i + 1]);
      if (s <= acc + L || i + 2 === n) {
        var t = L > 0 ? clamp((s - acc) / L, 0, 1) : 0;
        return { p: lerp(pts[i], pts[i + 1], t), s: s, i: i };
      }
      acc += L;
    }
    return { p: [pts[n - 1][0], pts[n - 1][1]], s: total, i: n - 2 };
  }
  // 垂足：在直线 AB 上，可以落在线段的延长线上（钝角三角形的高就是这样）
  function foot(P, A, B) { return lerp(A, B, param(P, A, B)); }
  // 直线 AB 与直线 CD 的交点；平行（含重合）或有一条退化成点时返回 null。
  // 判平行用相对误差：坐标很大或很小时也不会误判。
  function intersect(A, B, C, D) {
    var rx = B[0] - A[0], ry = B[1] - A[1], sx = D[0] - C[0], sy = D[1] - C[1];
    var den = cross(rx, ry, sx, sy);
    var scale = Math.sqrt((rx * rx + ry * ry) * (sx * sx + sy * sy));
    if (!(scale > 0) || Math.abs(den) <= 1e-12 * scale) return null;
    var t = cross(C[0] - A[0], C[1] - A[1], sx, sy) / den;
    return [A[0] + t * rx, A[1] + t * ry];
  }
  // 绕 O 逆时针转 deg 度。90° 的整数倍用精确的 0 / ±1，避免 cos(90°)=6e-17 这类尾巴出现在读数里。
  function rotate(P, O, deg) {
    var c, s, q = deg / 90;
    if (q === Math.round(q)) {
      var k = ((q % 4) + 4) % 4;
      c = [1, 0, -1, 0][k]; s = [0, 1, 0, -1][k];
    } else {
      var a = deg * Math.PI / 180;
      c = Math.cos(a); s = Math.sin(a);
    }
    var dx = P[0] - O[0], dy = P[1] - O[1];
    return [O[0] + dx * c - dy * s, O[1] + dx * s + dy * c];
  }
  function reflect(P, A, B) {
    var F = foot(P, A, B);
    return [2 * F[0] - P[0], 2 * F[1] - P[1]];
  }
  // 有向面积（鞋带公式）：顶点逆时针为正
  function signedArea(poly) {
    var s = 0, n = poly ? poly.length : 0;
    for (var i = 0; i < n; i++) {
      var p = poly[i], q = poly[(i + 1) % n];
      s += p[0] * q[1] - q[0] * p[1];
    }
    return s / 2;
  }
  function area(poly) { return Math.abs(signedArea(poly)); }
  // ∠AOB 的度数，[0, 180]。用 atan2(|叉积|, 点积) 而不是 acos：接近 0° 和 180° 时也准，
  // 并且先除以 π 再乘 180，直角、平角得到精确的 90、180。
  function angle(A, O, B) {
    var ax = A[0] - O[0], ay = A[1] - O[1], bx = B[0] - O[0], by = B[1] - O[1];
    if ((ax === 0 && ay === 0) || (bx === 0 && by === 0)) return 0;
    return Math.atan2(Math.abs(cross(ax, ay, bx, by)), ax * bx + ay * by) / Math.PI * 180;
  }

  var geo = {
    dist: dist, lerp: lerp, param: param, projectSegment: projectSegment,
    projectPolyline: projectPolyline, polylineLength: polylineLength, atLength: atLength,
    foot: foot, intersect: intersect, rotate: rotate, reflect: reflect,
    area: area, signedArea: signedArea, angle: angle, clamp: clamp
  };

  /* ============================== on：约束 ============================== */
  // 约束对象 { project(p) → { p:[x,y], …附加量 } | null, along?(附加量, ds) → 同上, snap?, span? }。
  // span() → { key, min, max, wrap? }：点沿约束「走了多少」用附加量里的哪一项（key；null 表示用横坐标），取值范围多大。
  //   读屏软件把可拖动的点当滑块读，要靠它给出 aria-valuemin / max / now；Home / End 也靠它跳到两端
  //   （wrap 表示首尾相接，比如圆，没有两端）。自己写的约束要支持 Home / End，along 得把超出范围的 ds 夹到端点。
  // 参数可以是 [x,y]、Point（有 get）、或返回 [x,y] 的函数，每次投影时重新取值，约束能跟着别的点动。
  function val(v) {
    if (typeof v === "function") return v();
    if (v && !isArr(v) && typeof v.get === "function") return v.get();
    return v;
  }
  function valPts(pts) {
    var arr = val(pts) || [], out = [];
    for (var i = 0; i < arr.length; i++) out.push(val(arr[i]));
    return out;
  }
  // 吸附到 step 的整数倍；toFixed(10) 去掉 0.1×3 = 0.30000000000000004 这类尾巴
  function snapTo(v, step, base) {
    base = base || 0;
    return parseFloat((Math.round((v - base) / step) * step + base).toFixed(10));
  }

  var on = {
    segment: function (A, B) {
      return {
        kind: "segment",
        project: function (p) {
          var a = val(A), b = val(B), r = projectSegment(p, a, b);
          return { p: r.p, t: r.t, s: r.t * dist(a, b) };
        },
        along: function (m, ds) {
          var a = val(A), b = val(B), L = dist(a, b);
          if (!(L > 0)) return { p: [a[0], a[1]], t: 0, s: 0 };
          var t = clamp((m && m.t ? m.t : 0) + ds / L, 0, 1);
          return { p: lerp(a, b, t), t: t, s: t * L };
        },
        span: function () { return { key: "s", min: 0, max: dist(val(A), val(B)) }; }
      };
    },
    // meta：s 弧长（从第一个点量起），i 段号
    polyline: function (pts) {
      return {
        kind: "polyline",
        project: function (p) { return projectPolyline(p, valPts(pts)); },
        along: function (m, ds) { return atLength(valPts(pts), (m && m.s ? m.s : 0) + ds); },
        span: function () { return { key: "s", min: 0, max: polylineLength(valPts(pts)) }; }
      };
    },
    // meta：a 角度（弧度，(-π, π]）；along 的 ds 是弧长（世界单位）
    circle: function (c, r) {
      return {
        kind: "circle",
        project: function (p) {
          var C = val(c), R = +val(r);
          var a = (p[0] === C[0] && p[1] === C[1]) ? 0 : Math.atan2(p[1] - C[1], p[0] - C[0]);
          return { p: [C[0] + R * Math.cos(a), C[1] + R * Math.sin(a)], a: a };
        },
        along: function (m, ds) {
          var C = val(c), R = +val(r);
          var a = (m && m.a ? m.a : 0) + (R > 0 ? ds / R : 0);
          a = Math.atan2(Math.sin(a), Math.cos(a));
          return { p: [C[0] + R * Math.cos(a), C[1] + R * Math.sin(a)], a: a };
        },
        span: function () { return { key: "a", min: -Math.PI, max: Math.PI, wrap: true }; }
      };
    },
    // 函数图象上的点：按 x 竖直投影（手指左右移，点沿曲线走），x 夹在定义域内；
    // 该处函数值不是有限数时返回 null，点停在原处。meta：x
    fn: function (f, dom) {
      function at(x) {
        var d = val(dom) || [-Infinity, Infinity];
        x = clamp(x, +d[0], +d[1]);
        var y;
        try { y = +f(x); } catch (e) { y = NaN; }
        return isFinite(y) ? { p: [x, y], x: x } : null;
      }
      return {
        kind: "fn",
        project: function (p) { return at(p[0]); },
        along: function (m, ds) { return at((m && m.x ? m.x : 0) + ds); },
        // 定义域无界时 min / max 不是有限数，点那边就不写 aria-valuemin / max、不响应 Home / End
        span: function () { var d = val(dom) || [-Infinity, Infinity]; return { key: "x", min: +d[0], max: +d[1] }; }
      };
    },
    // 吸附到格点；snap 让方向键至少走一格（否则 0.1 的步长会被吸回原处）
    grid: function (step, origin) {
      step = +step || 1;
      var o = origin || [0, 0];
      return {
        kind: "grid", snap: step,
        project: function (p) { return { p: [snapTo(p[0], step, o[0]), snapTo(p[1], step, o[1])] }; }
      };
    },
    // 夹在矩形 [x0, x1, y0, y1] 内
    box: function (bx) {
      return {
        kind: "box",
        project: function (p) {
          var b = val(bx);
          return { p: [clamp(p[0], +b[0], +b[1]), clamp(p[1], +b[2], +b[3])] };
        },
        // 平面里的点，滑块数值取横坐标（与以前的 aria-valuenow 一致）；没有 along，Home / End 不管
        span: function () { var b = val(bx); return { key: null, min: +b[0], max: +b[1] }; }
      };
    },
    // 依次套用多个约束，例如 on.all(on.box(view), on.grid(0.5))；附加量合并
    all: function () {
      var cs = Array.prototype.slice.call(arguments).map(asConstraint).filter(Boolean);
      var snap = 0, spanOf = null;
      cs.forEach(function (c) {
        if (c.snap > snap) snap = c.snap;
        if (!spanOf && typeof c.span === "function") spanOf = c;
      });
      return {
        kind: "all", snap: snap,
        // 取第一个给得出范围的约束（例如 on.all(on.box(view), on.grid(0.5)) 里的 box）
        span: spanOf ? function () { return spanOf.span(); } : undefined,
        project: function (p) {
          var out = { p: p };
          for (var i = 0; i < cs.length; i++) {
            var r = normProj(cs[i].project(out.p));
            if (!r) return null;
            for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) out[k] = r[k];
          }
          return out;
        }
      };
    }
  };
  // constrain 也可以直接给一个函数 p → [x,y] 或 { p, … }
  function normProj(r) {
    if (!r) return null;
    if (isArr(r)) return { p: r };
    return r.p ? r : null;
  }
  function asConstraint(c) {
    if (!c) return null;
    if (typeof c === "function") return { project: function (p) { return normProj(c(p)); } };
    if (typeof c.project === "function") return c;
    return null;
  }

  /* ============================== 运行时公共状态 ============================== */
  // 性能打点（端到端测试读它）：每个 move 处理函数、每个拖动帧各自计时累加
  var perf = {
    moves: 0, moveMs: 0, frames: 0, frameMs: 0,
    reset: function () { perf.moves = 0; perf.moveMs = 0; perf.frames = 0; perf.frameMs = 0; }
  };
  function now() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }
  function raf(fn) { return root && root.requestAnimationFrame ? root.requestAnimationFrame(fn) : setTimeout(fn, 16); }
  function caf(id) { if (root && root.cancelAnimationFrame) root.cancelAnimationFrame(id); else clearTimeout(id); }

  var DRAG = null;      // 同一时刻只有一个拖动（单指操作；第二根手指忽略）
  var frameDepth = 0;   // >0：正处在拖动帧 / 键盘移动里，update() 改为当帧同步完成
  var PENDING = [];     // 帧里被要求 update 的画板，帧末统一同步重画（几何板拖动 → 函数板当帧跟上）
  var seq = 0;
  var RO = null, WIN_HOOKED = false, ALL = [];
  var VHB = [], VH_RAF = 0;  // maxHeight 用 vh 的画板；视口高度变化时由共用的 window resize 监听重排（见 watch）
  var VH_JITTER = 40;   // 视口高度变化不超过这么多 px 不重排：挡掉零碎抖动；40vh 的板因此最多差 16px
  var COLORS = ["blue", "green", "coral", "sun", "red", "purple", "cyan", "ink", "muted"];
  var EXT = 9;          // 坐标轴箭头伸出视野的像素
  var hasPE = function () { return typeof root.PointerEvent === "function" || typeof root.PointerEvent === "object"; };

  function flushPending() {
    while (PENDING.length) {
      var S = PENDING.shift();
      if (S.pend && !S.destroyed) S.renderDyn();
    }
  }
  function inFrame(S, fn) {
    frameDepth++;
    try { fn(); S.renderDyn(); flushPending(); } finally { frameDepth--; }
  }

  /* ============================== 样式 ============================== */
  // 颜色只用 theme.css 的变量，并写回退值：知识导图等页面不加载 theme.css 也能正常显示。
  var CSS = [
    ".sk-board{display:block;width:100%;max-width:100%;overflow:hidden;touch-action:pan-y;touch-action:pan-y pinch-zoom;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;font-family:inherit}",
    // 手绘开着时不给整块 svg 设 touch-action:none：那样手指落在坐标轴、刻度那圈留白上也滚不动页面。
    // 只在画区里拦滚动，由非 passive 的 touchstart（onTouchGuard / onTStart）按 inPlot 判断后 preventDefault。
    ".sk-board.sk-sketch-on{cursor:crosshair}",
    ".sk-fig{pointer-events:none;touch-action:auto}",
    ".sk-c-blue{--sk-c:var(--blue,#3b5bdb)}.sk-c-green{--sk-c:var(--green,#12956b)}.sk-c-coral{--sk-c:var(--coral,#f2643d)}",
    ".sk-c-sun{--sk-c:var(--sun,#ffc83d)}.sk-c-red{--sk-c:var(--red,#d7263d)}.sk-c-purple{--sk-c:var(--purple,#7a36a6)}",
    ".sk-c-cyan{--sk-c:var(--cyan,#06b6d4)}.sk-c-ink{--sk-c:var(--ink,#2b2d42)}.sk-c-muted{--sk-c:var(--muted,#5c667a)}",
    ".sk-board .sk-hot{--sk-c:var(--coral,#f2643d)}",
    ".sk-layer-shapes,.sk-layer-text,.sk-layer-bg,.sk-layer-sketch{pointer-events:none}",
    ".sk-grid{fill:none;stroke:var(--line,#e3e6ec);stroke-width:1px;shape-rendering:crispEdges}",
    ".sk-axis{fill:none;stroke:var(--muted,#5c667a);stroke-width:1.3px}",
    ".sk-arrow,.sk-tickm{fill:var(--muted,#5c667a)}",
    ".sk-tickm{fill:none;stroke:var(--muted,#5c667a);stroke-width:1.3px}",
    ".sk-tick-t{font-size:11px;fill:var(--muted,#5c667a)}",
    ".sk-axname{font-size:12px;font-weight:600;fill:var(--ink,#2b2d42)}",
    ".sk-var{font-style:italic}",
    // 线宽走自定义属性 --sk-w（由通用选项 width 写在元素的 style 上）：CSS 规则会盖过 stroke-width 属性，
    // 直接写属性不起作用；而写成行内 stroke-width 又会反过来盖过下面 .sk-hot、手绘的加粗规则
    ".sk-stroke{fill:none;stroke:var(--sk-c,#3b5bdb);stroke-width:var(--sk-w,2px);stroke-linecap:round;stroke-linejoin:round;transition:stroke-width .15s}",
    ".sk-dash .sk-stroke{stroke-dasharray:6 5}",
    ".sk-fillon .sk-stroke{fill:var(--sk-c,#3b5bdb);fill-opacity:.18}",
    ".sk-board .sk-hot .sk-stroke{stroke-width:3.5px}",
    ".sk-text{fill:var(--sk-c,#2b2d42);font-size:14px;font-weight:600;paint-order:stroke;stroke:var(--sk-halo,var(--surface,#fff));stroke-width:3px;stroke-linejoin:round}",
    ".sk-small .sk-text{font-size:12px}",
    ".sk-pt .sk-text{fill:var(--ink,#2b2d42)}",
    ".sk-board .sk-hot .sk-text,.sk-board .sk-hot.sk-text{fill:var(--coral,#f2643d)}",
    ".sk-pt{outline:none}",
    ".sk-pt-dot{fill:var(--sk-c,#3b5bdb);stroke:var(--surface,#fff);stroke-width:2px;transition:stroke-width .15s,stroke-opacity .15s}",
    ".sk-pt-halo{fill:var(--sk-c,#3b5bdb);fill-opacity:.16;stroke:none}",
    ".sk-hit{fill:#000;fill-opacity:0;stroke:none;pointer-events:all;touch-action:none;cursor:grab}",
    ".sk-dragging .sk-hit{cursor:grabbing}",
    ".sk-dragging .sk-pt-halo{fill-opacity:.3}",
    ".sk-pt.sk-kbd .sk-pt-halo{stroke:var(--blue,#3b5bdb);stroke-width:2px;fill-opacity:.24}",
    ".sk-disabled .sk-hit{pointer-events:none;cursor:default}",
    ".sk-disabled .sk-pt-halo{display:none}",
    ".sk-disabled .sk-pt-dot{fill:var(--light,#7c869a)}",
    ".sk-board .sk-hot .sk-pt-dot{stroke:var(--coral,#f2643d);stroke-opacity:.35;stroke-width:10px}",
    // 轻微闪烁提示（例如「还没走到 D」）；减弱动效时改成静态描边
    "@keyframes sk-pulse{0%,100%{stroke-opacity:.12}50%{stroke-opacity:.55}}",
    ".sk-pulse .sk-pt-dot{stroke:var(--sk-c,#3b5bdb);stroke-width:9px;animation:sk-pulse 1.6s ease-in-out infinite}",
    ".sk-sketchg .sk-stroke{stroke-width:3px}",
    // 滑块：轨道细、拇指大，整个控件高 44px，手指好按
    // 间距不用 flex 的 gap，改用 margin：iOS 14.5 以前的 Safari、Chrome 84 以前不认 flex gap，元素会挤在一起。
    // .sk-controls 只是竖排，用普通块级布局即可；原来「gap 2px + 进阶 margin-top 4px」合成进阶的 margin-top 6px
    ".sk-controls{margin-top:8px}",
    ".sk-ctl{display:flex;flex-direction:column}",
    ".sk-ctl-head{display:flex;justify-content:space-between;align-items:baseline;font-size:.9rem;font-weight:600;color:var(--ink,#2b2d42)}",
    ".sk-ctl-val{font-variant-numeric:tabular-nums;color:var(--blue,#3b5bdb);min-width:3em;text-align:right;margin-left:8px}",
    // 前缀 .sk-controls 提高优先级：theme.css 在窄屏把 input[type=range] 设成 30px 高
    ".sk-controls .sk-range{-webkit-appearance:none;appearance:none;display:block;width:100%;height:44px;margin:0;padding:0;background:transparent;cursor:pointer}",
    // 只在浏览器认 :focus-visible 时去掉默认焦点框：旧内核（iOS 15.4、Chrome 86 以前）整条规则作废，保留默认框，键盘用户仍看得到焦点
    ".sk-range:focus:not(:focus-visible){outline:none}",
    ".sk-range:focus-visible{outline:2px solid var(--blue,#3b5bdb);outline-offset:2px;border-radius:8px}",
    ".sk-range::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:var(--line,#e3e6ec)}",
    ".sk-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:26px;height:26px;margin-top:-10px;border-radius:50%;background:var(--blue,#3b5bdb);border:3px solid var(--surface,#fff);box-shadow:0 1px 4px rgba(43,45,66,.3)}",
    ".sk-range::-moz-range-track{height:6px;border-radius:3px;background:var(--line,#e3e6ec)}",
    ".sk-range::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:var(--blue,#3b5bdb);border:3px solid var(--surface,#fff)}",
    ".sk-adv{border-top:1px dashed var(--line,#e3e6ec);margin-top:6px}",
    ".sk-adv>summary{min-height:44px;display:flex;align-items:center;cursor:pointer;list-style:none;font-size:.88rem;font-weight:600;color:var(--blue,#3b5bdb)}",
    ".sk-adv>summary::-webkit-details-marker{display:none}",
    ".sk-adv>summary::before{content:'▸';margin-right:6px}",
    ".sk-adv[open]>summary::before{content:'▾'}",
    "@media (prefers-reduced-motion:reduce){.sk-board *,.sk-controls *{transition:none!important;animation:none!important}.sk-pulse .sk-pt-dot{stroke-opacity:.45}}"
  ].join("\n");

  function injectStyles() {
    if (document.getElementById("sk-styles")) return;
    var st = document.createElement("style");
    st.id = "sk-styles";
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ============================== DOM 小工具 ============================== */
  function mk(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  // 像素坐标保留 1 位小数：字符串短，肉眼看不出差别
  function f1(v) { return Math.round(v * 10) / 10; }
  function fmtNum(v) {
    var s = String(parseFloat((+v).toFixed(6)));
    return s.charAt(0) === "-" ? "−" + s.slice(1) : s;
  }
  // 估算文字宽度（不量 DOM，免得强制布局）：汉字和全角符号 1em，其余约 0.6em
  function textW(s, fs) {
    s = String(s == null ? "" : s);
    var w = 0;
    // 中日韩文字按全角；「℃」这类字母式符号（U+2100～214F）字形也接近全角，按半角估会把坐标轴名截掉一截
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      w += c >= 0x2e80 || (c >= 0x2100 && c <= 0x214f) ? fs : 0.6 * fs;
    }
    return w;
  }
  function colorOf(o, def) {
    if (o.accent) return "coral";
    return COLORS.indexOf(o.color) >= 0 ? o.color : def;
  }
  function rootCls(kind, o, def, fillDef) {
    var c = "sk-item sk-" + kind + " sk-c-" + colorOf(o, def);
    if (o.dash) c += " sk-dash";
    if (o.fill === true || (o.fill !== false && fillDef)) c += " sk-fillon";
    if (o.cls) c += " " + o.cls;
    return c;
  }
  function isDyn(v) {
    if (typeof v === "function") return true;
    if (v && !isArr(v) && typeof v.get === "function") return true;
    if (isArr(v)) for (var i = 0; i < v.length; i++) if (isArr(v[i]) ? false : isDyn(v[i])) return true;
    return false;
  }
  // 文字相对锚点的位置 pos：c n s e w ne nw se sw；off 是离锚点的像素距离
  function placeText(t, x, y, pos, off) {
    pos = pos || "c";
    var anchor = "middle", dx = 0, dy = 0, base = "0.35em";
    if (pos.indexOf("e") >= 0) { anchor = "start"; dx = off; }
    else if (pos.indexOf("w") >= 0) { anchor = "end"; dx = -off; }
    if (pos.indexOf("n") >= 0) { dy = -off; base = "0"; }
    else if (pos.indexOf("s") >= 0) { dy = off; base = "0.8em"; }
    t.setAttribute("x", f1(x + dx));
    t.setAttribute("y", f1(y + dy));
    t.setAttribute("dy", base);
    t.setAttribute("text-anchor", anchor);
  }
  function niceUp(step) {
    var p = Math.pow(10, Math.floor(Math.log(step) / Math.LN10 + 1e-9)), m = step / p;
    return m < 1.5 ? 2 * p : m < 3.5 ? 5 * p : 10 * p;
  }
  // 网格间隔：从 base（默认 1 个单位）起，按 2、5、10… 放大，直到不超过 24 条且间距不小于 12px
  function gridStep(span, k, base) {
    var st = base > 0 ? base : 1, guard = 0;
    while ((span / st > 24 || st * k < 12) && guard++ < 40) st = niceUp(st);
    return st;
  }
  // 自动刻度：数字之间至少留 32px
  function autoTicks(lo, hi, k) {
    var st = gridStep(hi - lo, k, 1), guard = 0, out = [];
    while (st * k < 32 && guard++ < 40) st = niceUp(st);
    for (var i = Math.ceil(lo / st - 1e-9); i * st <= hi + 1e-9; i++) out.push(parseFloat((i * st).toFixed(10)));
    return out;
  }
  function vpH() {
    var d = document.documentElement;
    // 用 documentElement.clientHeight：手机浏览器地址栏收起时它不变，板子不会跟着滚动忽大忽小
    return (d && d.clientHeight) || root.innerHeight || 800;
  }
  function parseLen(m, def) {
    if (m == null) m = def;
    if (typeof m === "number") return m;
    var s = String(m), n = parseFloat(s);
    if (!isFinite(n)) return Infinity;
    return /vh\s*$/.test(s) ? n / 100 * vpH() : n;
  }

  /* ============================== 尺寸监听（所有画板共用一个） ============================== */
  // 焦点在文字输入框里：手机弹出软键盘会把视口压矮（安卓旧 WebView、微信等），这时不跟着缩板子，
  // 免得键盘一开一关，板子一缩一放，页面上下跳。滑块、复选框这类不弹键盘的不算。
  function typing() {
    var a = document.activeElement;
    if (!a) return false;
    if (a.isContentEditable || a.tagName === "TEXTAREA") return true;
    return a.tagName === "INPUT" && !/^(range|checkbox|radio|button|submit|reset|image|color|file|hidden)$/i.test(a.type || "");
  }
  // ResizeObserver 只盯容器宽度：竖向拉窗口、分屏、自由窗口时宽度不变，maxHeight 写成 vh 的板子不会重排，
  // 就会超过「不超过视口某个比例」的限制。这里按视口高度补一次重排。
  // vpH() 用 documentElement.clientHeight，手机地址栏收放时它本身不变；VH_JITTER 再挡掉其余零碎抖动。
  function checkVh() {
    VH_RAF = 0;
    if (!VHB.length || typing()) return;
    var h = vpH();
    for (var i = 0; i < VHB.length; i++) {
      var s = VHB[i];
      if (s.vpUsed > 0 && Math.abs(h - s.vpUsed) > VH_JITTER) s.relayout();
    }
  }
  // 整页只挂一个 window resize 监听：没有 ResizeObserver 时按宽度重排各板；vh 检查用 rAF 合并，一帧最多一次
  function onWinResize() {
    for (var i = 0; i < ALL.length; i++) ALL[i].scheduleLayout(0);
    if (VHB.length && !VH_RAF) VH_RAF = raf(checkVh);
  }
  function hookWin() {
    if (WIN_HOOKED) return;
    WIN_HOOKED = true;
    root.addEventListener("resize", onWinResize);
    root.addEventListener("orientationchange", onWinResize);
  }
  function watch(S) {
    var list = S.el.__skStates || (S.el.__skStates = []);
    list.push(S);
    if (S.vh) { VHB.push(S); hookWin(); }
    if (typeof root.ResizeObserver === "function") {
      if (!RO) {
        RO = new root.ResizeObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            var ss = entries[i].target.__skStates || [], w = entries[i].contentRect.width;
            for (var j = 0; j < ss.length; j++) ss[j].scheduleLayout(w);
          }
        });
      }
      if (list.length === 1) RO.observe(S.el);
    } else {
      // 没有 ResizeObserver 的旧内核：退回 window resize，逐个画板比较宽度
      ALL.push(S);
      hookWin();
    }
  }
  function unwatch(S) {
    var i = ALL.indexOf(S);
    if (i >= 0) ALL.splice(i, 1);
    i = VHB.indexOf(S);
    if (i >= 0) VHB.splice(i, 1);
    var list = S.el.__skStates || [];
    i = list.indexOf(S);
    if (i >= 0) list.splice(i, 1);
    if (RO && !list.length) RO.unobserve(S.el);
  }

  /* ============================== board ============================== */
  function board(el, opts) {
    if (typeof el === "string") el = document.querySelector(el);
    if (!el) throw new Error("ABSLabSVG.board：找不到容器元素");
    opts = opts || {};
    injectStyles();

    var V = (opts.view || [-5, 5, -5, 5]).map(Number);
    if (!(V[1] > V[0])) V[1] = V[0] + 1;
    if (!(V[3] > V[2])) V[3] = V[2] + 1;
    var xmin = V[0], xmax = V[1], ymin = V[2], ymax = V[3];
    var aspect = opts.aspect === "fill" ? "fill" : "equal";
    var axes = opts.axes || null;
    var gridOpt = opts.grid;
    var id = ++seq;
    var mhSpec = opts.maxHeight == null ? (opts.figure ? 320 : "70vh") : opts.maxHeight;

    var S = {
      id: id, el: el, items: [], raf: 0, lraf: 0, pend: false, destroyed: false,
      W: 0, H: 0, kx: 1, ky: 1, ox: 0, oy: 0, lastW: -1, pendW: 0,
      plot: [0, 0, 0, 0], interactive: false, sketch: null,
      // vh：最大高度跟视口高度走；vpUsed：上次布局时用的视口高度（视口变高 / 变矮时据此判断要不要重排）
      vh: /vh\s*$/.test(String(mhSpec)), vpUsed: 0
    };
    var svg = mk("svg", {
      "class": "sk-board" + (opts.figure ? " sk-fig" : "") + (opts.cls ? " " + opts.cls : ""),
      focusable: "false",
      role: opts.figure ? "img" : "group",
      "aria-label": opts.ariaLabel || (opts.figure ? "示意图" : "画板")
    });
    S.svg = svg;
    var defs = mk("defs", null, svg);
    var clip = mk("clipPath", { id: "skc" + id }, defs);
    var clipRect = mk("rect", null, clip);
    var L = {
      bg: mk("g", { "class": "sk-layer-bg" }, svg),
      shapes: mk("g", { "class": "sk-layer-shapes" }, svg),
      sketch: mk("g", { "class": "sk-layer-sketch" }, svg),
      text: mk("g", { "class": "sk-layer-text" }, svg),
      // 点永远在最上层：后画的多边形、函数图象不会盖住触控圈
      pts: mk("g", { "class": "sk-layer-pts" }, svg)
    };
    el.appendChild(svg);

    function sx(x) { return S.ox + (x - xmin) * S.kx; }
    function sy(y) { return S.oy - (y - ymin) * S.ky; }
    function toScreen(p) { return [sx(p[0]), sy(p[1])]; }
    function toWorld(s) { return [xmin + (s[0] - S.ox) / S.kx, ymin + (S.oy - s[1]) / S.ky]; }
    S.toScreen = toScreen; S.toWorld = toWorld;

    /* ---------- 布局 ---------- */
    function axisPos() {
      return {
        yAt: (ymin <= 0 && ymax >= 0) ? 0 : ymin,   // x 轴画在 y = yAt
        xAt: (xmin <= 0 && xmax >= 0) ? 0 : xmin    // y 轴画在 x = xAt
      };
    }
    // 内边距：在 opts.pad 的基础上，按坐标轴名字、刻度数字实际要占的地方自动加宽，免得被裁掉
    function pads() {
      var p = opts.pad != null ? opts.pad : 24, t, r, b, l;
      if (isArr(p)) { t = +p[0]; r = +p[1]; b = +p[2]; l = +p[3]; } else { t = r = b = l = +p; }
      if (axes) {
        var ap = axisPos();
        r = Math.max(r, EXT + 6 + textW(axes.x || "", 12));
        t = Math.max(t, EXT + 8);
        if (ap.yAt === ymin) b = Math.max(b, 18);
        if (ap.xAt === xmin) {
          var labs = isArr(axes.yt) ? axes.yt : [ymin, ymax], mw = 0;
          for (var i = 0; i < labs.length; i++) mw = Math.max(mw, textW(fmtNum(labs[i]), 11));
          if (ap.xAt === 0 && ap.yAt === 0) mw = Math.max(mw, 8);
          l = Math.max(l, mw + 7);
        }
      }
      return [t, r, b, l];
    }
    function layout(force, wIn) {
      if (S.destroyed) return;
      var w = wIn;
      if (!(w > 0)) w = svg.getBoundingClientRect().width;
      // 容器暂时不可见（display:none）：先按 300px 画，等 ResizeObserver 报出真实宽度再重排
      if (!(w > 0)) w = S.W > 0 ? S.W : 300;
      if (!force && Math.abs(w - S.lastW) < 0.5) return;
      S.lastW = w;
      var P = pads(), pt = P[0], pr = P[1], pb = P[2], pl = P[3];
      var xs = xmax - xmin, ys = ymax - ymin;
      S.vpUsed = S.vh ? vpH() : 0;
      var mh = parseLen(mhSpec);
      var hOpt = typeof opts.height === "number" ? opts.height : null;
      var pw = Math.max(10, w - pl - pr), H, ph;
      if (aspect === "equal") {
        var k;
        if (hOpt) {
          H = Math.min(hOpt, mh);
          k = Math.min(pw / xs, Math.max(10, H - pt - pb) / ys);
        } else {
          k = pw / xs;
          H = k * ys + pt + pb;
          if (H > mh) { H = mh; k = Math.min(k, Math.max(10, H - pt - pb) / ys); }
        }
        S.kx = S.ky = k;
        ph = Math.max(10, H - pt - pb);
        S.ox = pl + (pw - k * xs) / 2;
        S.oy = pt + (ph - k * ys) / 2 + k * ys;
      } else {
        var ratio = opts.ratio > 0 ? opts.ratio : 0.62;
        H = Math.min(hOpt || w * ratio, mh);
        H = Math.max(H, pt + pb + 20);
        ph = H - pt - pb;
        S.kx = pw / xs; S.ky = ph / ys;
        S.ox = pl; S.oy = pt + ph;
      }
      H = Math.round(H);
      S.W = w; S.H = H;
      S.plot = [sx(xmin), sy(ymax), sx(xmax), sy(ymin)];
      svg.setAttribute("viewBox", "0 0 " + f1(w) + " " + H);
      svg.style.height = H + "px";
      svg.classList.toggle("sk-small", w < 260);
      clipRect.setAttribute("x", f1(S.plot[0] - 3));
      clipRect.setAttribute("y", f1(S.plot[1] - 3));
      clipRect.setAttribute("width", f1(S.plot[2] - S.plot[0] + 6));
      clipRect.setAttribute("height", f1(S.plot[3] - S.plot[1] + 6));
      drawDecor();
      for (var i = 0; i < S.items.length; i++) S.items[i].render();
    }
    // ResizeObserver 回调里不直接改尺寸（会触发「ResizeObserver loop」报错），推到下一帧
    S.scheduleLayout = function (w) {
      S.pendW = w;
      if (!S.lraf) S.lraf = raf(function () { S.lraf = 0; layout(false, S.pendW); });
    };
    // 视口高度变了（宽度可能没变）：强制重排；已排上的按宽度重排一并取消，它能做的这里都做了
    S.relayout = function () {
      if (S.lraf) { caf(S.lraf); S.lraf = 0; }
      layout(true);
    };

    /* ---------- 网格与坐标轴（只在布局时重画） ---------- */
    function tickText(parent, x, y, s, anchor, dy, cls) {
      var t = mk("text", { "class": cls || "sk-tick-t", x: f1(x), y: f1(y), dy: dy, "text-anchor": anchor }, parent);
      t.textContent = s;
      return t;
    }
    function drawDecor() {
      var bg = L.bg;
      while (bg.firstChild) bg.removeChild(bg.firstChild);
      var X0 = sx(xmin), X1 = sx(xmax), Y0 = sy(ymin), Y1 = sy(ymax), i, v, d;
      if (gridOpt) {
        var base = typeof gridOpt === "number" ? gridOpt : 1;
        var gx = gridStep(xmax - xmin, S.kx, base), gy = gridStep(ymax - ymin, S.ky, base);
        if (aspect === "equal") gx = gy = Math.max(gx, gy);
        d = [];
        for (i = Math.ceil(xmin / gx - 1e-9); i * gx <= xmax + 1e-9; i++) d.push("M" + f1(sx(i * gx)) + " " + f1(Y1) + "V" + f1(Y0));
        for (i = Math.ceil(ymin / gy - 1e-9); i * gy <= ymax + 1e-9; i++) d.push("M" + f1(X0) + " " + f1(sy(i * gy)) + "H" + f1(X1));
        mk("path", { "class": "sk-grid", d: d.join("") }, bg);
      }
      if (!axes) return;
      var ap = axisPos(), ay = sy(ap.yAt), ax = sx(ap.xAt);
      var g = mk("g", { "class": "sk-axes" }, bg);
      var tipX = X1 + EXT, tipY = Y1 - EXT;
      mk("path", { "class": "sk-axis", d: "M" + f1(X0) + " " + f1(ay) + "H" + f1(tipX - 3) + "M" + f1(ax) + " " + f1(Y0) + "V" + f1(tipY + 3) }, g);
      mk("path", {
        "class": "sk-arrow",
        d: "M" + f1(tipX) + " " + f1(ay) + "l-8 -4v8z" + "M" + f1(ax) + " " + f1(tipY) + "l-4 8h8z"
      }, g);
      var origin = ap.xAt === 0 && ap.yAt === 0;
      var xt = axes.xt === undefined ? autoTicks(xmin, xmax, S.kx) : (axes.xt || []);
      var yt = axes.yt === undefined ? autoTicks(ymin, ymax, S.ky) : (axes.yt || []);
      d = [];
      for (i = 0; i < xt.length; i++) {
        v = +xt[i];
        if (!(v >= xmin - 1e-9 && v <= xmax + 1e-9)) continue;
        if (origin && v === 0) continue;
        d.push("M" + f1(sx(v)) + " " + f1(ay) + "v-4");
        tickText(g, sx(v), ay + 4, fmtNum(v), "middle", "0.8em");
      }
      for (i = 0; i < yt.length; i++) {
        v = +yt[i];
        if (!(v >= ymin - 1e-9 && v <= ymax + 1e-9)) continue;
        if (origin && v === 0) continue;
        d.push("M" + f1(ax) + " " + f1(sy(v)) + "h4");
        tickText(g, ax - 5, sy(v), fmtNum(v), "end", "0.35em");
      }
      if (d.length) mk("path", { "class": "sk-tickm", d: d.join("") }, g);
      if (origin) tickText(g, ax - 4, ay + 3, "O", "end", "0.8em", "sk-tick-t sk-var");
      var oneLetter = /^[A-Za-z]$/;
      if (axes.x) tickText(g, tipX + 4, ay, axes.x, "start", "0.35em", "sk-axname" + (oneLetter.test(axes.x) ? " sk-var" : ""));
      if (axes.y) tickText(g, ax + 7, tipY + 2, axes.y, "start", "0.35em", "sk-axname" + (oneLetter.test(axes.y) ? " sk-var" : ""));
    }

    /* ---------- 元素 ---------- */
    function addItem(node, dyn, render, extra) {
      var item = { node: node, dyn: !!dyn, render: render };
      S.items.push(item);
      render();
      var h = extra || {};
      h.node = node;
      h.show = function (on) { node.style.display = on === false ? "none" : ""; return h; };
      h.toggle = function (cls, on) { node.classList.toggle(cls, on === undefined ? undefined : !!on); return h; };
      h.remove = function () {
        var i = S.items.indexOf(item);
        if (i >= 0) S.items.splice(i, 1);
        if (node.parentNode) node.parentNode.removeChild(node);
        if (h._onRemove) h._onRemove();
      };
      return h;
    }
    function ptsAttr(pts) {
      var s = [];
      for (var i = 0; i < pts.length; i++) {
        var p = val(pts[i]);
        if (!p) continue;
        s.push(f1(sx(p[0])) + "," + f1(sy(p[1])));
      }
      return s.join(" ");
    }
    // 写自定义属性而不是 stroke-width：见样式表 .sk-stroke 的注释（高亮、手绘的加粗规则仍能盖过它）
    function setW(n, o) { if (+o.width > 0) n.style.setProperty("--sk-w", (+o.width) + "px"); }

    var b = {
      svg: svg, el: el, view: V.slice(), opts: opts,
      toScreen: toScreen, toWorld: toWorld,
      size: function () { return { w: S.W, h: S.H, plot: S.plot.slice() }; }
    };

    b.segment = function (A, B, o) {
      o = o || {};
      var g = mk("g", { "class": rootCls("seg", o, "ink", false) }, L.shapes);
      var ln = mk("line", { "class": "sk-stroke" }, g);
      setW(ln, o);
      return addItem(g, isDyn(A) || isDyn(B), function () {
        var a = val(A), c = val(B);
        if (!a || !c) return;
        ln.setAttribute("x1", f1(sx(a[0]))); ln.setAttribute("y1", f1(sy(a[1])));
        ln.setAttribute("x2", f1(sx(c[0]))); ln.setAttribute("y2", f1(sy(c[1])));
      });
    };
    function poly(tag, kind, def, fillDef) {
      return function (pts, o) {
        o = o || {};
        var g = mk("g", { "class": rootCls(kind, o, def, fillDef) }, L.shapes);
        var n = mk(tag, { "class": "sk-stroke" }, g);
        setW(n, o);
        return addItem(g, isDyn(pts), function () { n.setAttribute("points", ptsAttr(val(pts) || [])); });
      };
    }
    b.polyline = poly("polyline", "pl", "blue", false);
    b.polygon = poly("polygon", "pg", "ink", true);
    b.circle = function (c, r, o) {
      o = o || {};
      var g = mk("g", { "class": rootCls("ci", o, "ink", false) }, L.shapes);
      // 用 ellipse：aspect fill 时 x、y 单位长度不同，世界里的圆在屏幕上是椭圆
      var e = mk("ellipse", { "class": "sk-stroke" }, g);
      setW(e, o);
      return addItem(g, isDyn(c) || typeof r === "function", function () {
        var C = val(c), R = +val(r);
        e.setAttribute("cx", f1(sx(C[0]))); e.setAttribute("cy", f1(sy(C[1])));
        e.setAttribute("rx", f1(Math.abs(R * S.kx))); e.setAttribute("ry", f1(Math.abs(R * S.ky)));
      });
    };
    b.text = function (at, str, o) {
      o = o || {};
      var g = mk("g", { "class": rootCls("tx", o, "ink", false) }, L.text);
      var t = mk("text", { "class": "sk-text" }, g);
      var last = null;
      return addItem(g, isDyn(at) || typeof str === "function", function () {
        var p = val(at), s = typeof str === "function" ? str() : str;
        s = s == null ? "" : String(s);
        if (s !== last) { t.textContent = s; last = s; }
        if (p) placeText(t, sx(p[0]), sy(p[1]), o.pos || "c", o.offset != null ? o.offset : 6);
      });
    };
    // 函数图象：在屏幕上自适应采样（弯的地方多取点），非有限值或跳变（渐近线）处断开；裁到视野内
    b.fn = function (f, o) {
      o = o || {};
      var g = mk("g", { "class": rootCls("fn", o, "blue", false), "clip-path": "url(#skc" + id + ")" }, L.shapes);
      var path = mk("path", { "class": "sk-stroke" }, g);
      setW(path, o);
      return addItem(g, true, function () {
        var dom = o.domain ? val(o.domain) : [xmin, xmax];
        var lo = Math.max(+dom[0], xmin), hi = Math.min(+dom[1], xmax);
        if (typeof o.upTo === "function") hi = Math.min(hi, +o.upTo());
        path.setAttribute("d", hi > lo ? sampleFn(f, lo, hi) : "");
      });
    };
    function sampleFn(f, lo, hi) {
      var PH = Math.max(1, S.plot[3] - S.plot[1]), lim = PH * 6;
      var n = Math.max(16, Math.min(400, Math.ceil((hi - lo) * S.kx / 4)));
      var out = [], pen = false;
      function pt(x) {
        var y;
        try { y = +f(x); } catch (e) { y = NaN; }
        if (!isFinite(y)) return null;
        return [sx(x), clamp(sy(y), S.plot[1] - lim, S.plot[3] + lim)];
      }
      function put(s) { out.push((pen ? "L" : "M") + f1(s[0]) + " " + f1(s[1])); pen = true; }
      function seg(x0, s0, x1, s1, depth) {
        var oneNull = (s0 === null) !== (s1 === null);
        if (s0 === null && s1 === null) { pen = false; return; }
        var xm = (x0 + x1) / 2, sm = null, need = false;
        if (depth < 6) {
          sm = pt(xm);
          need = oneNull || sm === null || Math.abs(sm[1] - (s0[1] + s1[1]) / 2) > 0.5;
        }
        if (need) { seg(x0, s0, xm, sm, depth + 1); seg(xm, sm, x1, s1, depth + 1); return; }
        if (oneNull || (depth >= 6 && Math.abs(s1[1] - s0[1]) > PH)) { pen = false; return; }
        if (!pen) put(s0);
        put(s1);
      }
      var x0 = lo, s0 = pt(lo);
      for (var i = 1; i <= n; i++) {
        var x1 = lo + (hi - lo) * i / n, s1 = pt(x1);
        seg(x0, s0, x1, s1, 0);
        x0 = x1; s0 = s1;
      }
      if (out.length === 1 && s0) out.push("L" + f1(s0[0] + 0.01) + " " + f1(s0[1]));
      return out.join("");
    }

    /* ---------- 点 ---------- */
    b.point = function (at, o) {
      o = o || {};
      var derived = typeof at === "function";           // 由别的量算出来的点（如垂足）：只读，不能拖
      var drag = !!o.draggable && !derived;
      var cons = asConstraint(o.constrain) || (drag ? on.box(V) : null);
      var r = o.r > 0 ? o.r : (drag ? 6 : 4);
      var color = colorOf(o, drag ? "blue" : "ink");
      var g = mk("g", { "class": "sk-pt sk-c-" + color + (drag ? " sk-drag" : "") + (o.cls ? " " + o.cls : "") }, L.pts);
      if (drag) mk("circle", { "class": "sk-pt-halo", r: r + 8 }, g);
      mk("circle", { "class": "sk-pt-dot", r: r }, g);
      if (o.label) {
        var lab = mk("text", { "class": "sk-text sk-pt-label" }, g);
        lab.textContent = o.label;
        placeText(lab, 0, 0, o.pos || "ne", r + 3);
      }
      var hit = null;
      var cur = [0, 0], meta = {}, enabled = true, handlers = { start: [], drag: [], end: [] };
      var P = { board: b, node: g };
      if (drag) {
        hit = mk("circle", { "class": "sk-hit", r: Math.max(22, +o.hit || 22) }, g);
        hit.__skPoint = P;
        g.__skPoint = P;
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "slider");
        g.setAttribute("aria-label", o.ariaLabel || ("可拖动的点 " + (o.label || "")).replace(/\s+$/, ""));
        ensureInteractive();
      }
      function apply(p) {
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) return false;
        var r2 = cons ? normProj(cons.project([+p[0], +p[1]])) : { p: [+p[0], +p[1]] };
        if (!r2 || !isFinite(r2.p[0]) || !isFinite(r2.p[1])) return false;
        var changed = r2.p[0] !== cur[0] || r2.p[1] !== cur[1];
        cur = [r2.p[0], r2.p[1]];
        var m = {};
        for (var k in r2) if (k !== "p" && Object.prototype.hasOwnProperty.call(r2, k)) m[k] = r2[k];
        meta = m;
        return changed;
      }
      function render() {
        if (derived) { var p = at(); if (p && isFinite(p[0]) && isFinite(p[1])) cur = [+p[0], +p[1]]; }
        g.setAttribute("transform", "translate(" + f1(sx(cur[0])) + "," + f1(sy(cur[1])) + ")");
      }
      // 约束的取值范围（见 on 一节的 span）；给不出有限范围时返回 null
      function spanOf() {
        var sp = null;
        if (cons && typeof cons.span === "function") { try { sp = cons.span(); } catch (e) { sp = null; } }
        return sp && isFinite(sp.min) && isFinite(sp.max) && sp.max >= sp.min ? sp : null;
      }
      // 滑块的当前值：有范围就取范围说的那一项，和 aria-valuemin / max 同一个量；没有就沿用弧长 → x → 角度 → 横坐标
      function nowOf(sp) {
        if (sp) return sp.key && typeof meta[sp.key] === "number" ? meta[sp.key] : cur[0];
        return meta.s != null ? meta.s : meta.x != null ? meta.x : meta.a != null ? meta.a : cur[0];
      }
      function r4(v) { return String(parseFloat((+v).toFixed(4))); }
      // 读屏用的文字：默认读坐标；题目里 x、y 另有含义时（例如示范题的路程、面积），用 o.ariaText(P, meta) 自己给，
      // 免得读屏读出的数和屏幕上的读数对不上
      function aria() {
        if (!drag) return;
        var txt = null;
        if (typeof o.ariaText === "function") { try { txt = o.ariaText(P, meta); } catch (e) { txt = null; } }
        if (txt == null || txt === "") {
          var d = (o.step && o.step < 0.1) ? 2 : 1;
          txt = (o.label ? o.label + " " : "") + "x = " + fmtNum(cur[0].toFixed(d)) + "，y = " + fmtNum(cur[1].toFixed(d));
        }
        g.setAttribute("aria-valuetext", String(txt));
        // 不写 min / max 时读屏软件按 0–100 理解 valuenow；范围已知就写上，valuenow 夹在范围里保持一致
        var sp = spanOf(), v = nowOf(sp);
        if (sp) {
          v = clamp(v, sp.min, sp.max);
          g.setAttribute("aria-valuemin", r4(sp.min));
          g.setAttribute("aria-valuemax", r4(sp.max));
        } else {
          g.removeAttribute("aria-valuemin");
          g.removeAttribute("aria-valuemax");
        }
        g.setAttribute("aria-valuenow", r4(v));
      }
      function fire(ev) {
        var hs = handlers[ev] ? handlers[ev].slice() : [];
        for (var i = 0; i < hs.length; i++) hs[i](P);
      }
      if (!derived) apply(at || [0, 0]);
      P.get = function () { return [cur[0], cur[1]]; };
      P.set = function (p) { if (apply(p)) { render(); aria(); } update(); return P; };
      P.meta = function () { return meta; };
      P.on = function (ev, fn) { if (handlers[ev] && typeof fn === "function") handlers[ev].push(fn); return P; };
      P.off = function (ev, fn) { var a = handlers[ev], i = a ? a.indexOf(fn) : -1; if (i >= 0) a.splice(i, 1); return P; };
      P.enabled = function () { return drag && enabled; };
      P.enable = function (yes) {
        enabled = yes !== false;
        g.classList.toggle("sk-disabled", !enabled);
        if (drag) {
          g.setAttribute("tabindex", enabled ? "0" : "-1");
          if (enabled) g.removeAttribute("aria-disabled"); else g.setAttribute("aria-disabled", "true");
          if (!enabled && DRAG && DRAG.P === P) endDrag(DRAG, true);
        }
        return P;
      };
      // 以下几个给拖动 / 键盘代码用
      P._canDrag = function () { return drag && enabled && !S.destroyed && g.style.display !== "none"; };
      P._dragTo = function (w) { if (apply(w)) { render(); return true; } return false; };
      P._fire = fire;
      P._aria = aria;
      // 键盘移动和拖动一样发 start / drag / end，联动的板当帧重画
      function keyTo(r3) {
        if (!r3) return;
        inFrame(S, function () {
          fire("start");
          if (apply(r3.p)) { render(); fire("drag"); }
          fire("end");
          aria();
        });
      }
      P._keyMove = function (dir, axis) {
        var st = Math.max(+o.step || 0.1, (cons && cons.snap) || 0) * dir, r3;
        if (cons && cons.along) r3 = normProj(cons.along(meta, st));
        else { var np = [cur[0], cur[1]]; np[axis] += st; r3 = { p: np }; }
        keyTo(r3);
      };
      // Home / End：沿约束跳到起点 / 终点。走一段比整个范围还长的距离，让 along 夹到端点：端点由约束自己算，
      // 首尾相接的折线也不会把终点认成起点。没有两端（圆）或没有 along 的约束返回 false，按键留给页面。
      P._keyEnd = function (dir) {
        var sp = spanOf();
        if (!sp || sp.wrap || !cons || typeof cons.along !== "function") return false;
        keyTo(normProj(cons.along(meta, dir * (sp.max - sp.min + 1))));
        return true;
      };
      var h = addItem(g, derived, render, P);
      h._onRemove = function () { if (DRAG && DRAG.P === P) endDrag(DRAG, true); };
      aria();
      return P;
    };

    /* ---------- 手绘 ---------- */
    b.sketch = function (o) {
      o = o || {};
      if (S.sketch) S.sketch.api.remove();
      ensureInteractive();
      var g = mk("g", { "class": "sk-item sk-sketchg sk-c-" + colorOf(o, "purple") }, L.sketch);
      var pl = mk("polyline", { "class": "sk-stroke" }, g);
      var sk = { on: true, pts: [], str: "", o: o, pl: pl };
      function redraw() {
        var s = [];
        for (var i = 0; i < sk.pts.length; i++) s.push(f1(sx(sk.pts[i][0])) + "," + f1(sy(sk.pts[i][1])));
        sk.str = s.join(" ");
        pl.setAttribute("points", sk.str);
      }
      var api = addItem(g, false, redraw);
      var baseRemove = api.remove;
      api.clear = function () { sk.pts = []; redraw(); return api; };
      api.get = function () { return sk.pts.map(function (p) { return [p[0], p[1]]; }); };
      api.set = function (pts) { sk.pts = (pts || []).map(function (p) { return [+p[0], +p[1]]; }); redraw(); return api; };
      api.enable = function (yes) {
        sk.on = yes !== false;
        svg.classList.toggle("sk-sketch-on", sk.on);
        if (!sk.on && DRAG && DRAG.sk === sk) endDrag(DRAG, true);
        return api;
      };
      api.remove = function () {
        if (DRAG && DRAG.sk === sk) endDrag(DRAG, true);
        if (S.sketch === sk) S.sketch = null;
        svg.classList.remove("sk-sketch-on");
        baseRemove();
      };
      sk.api = api;
      S.sketch = sk;
      svg.classList.add("sk-sketch-on");
      return api;
    };
    // 拖动帧里给手绘加一个点：夹进视野；monotoneX 时只收 x 继续变大的点（函数图象不能往回画）
    S.sketchAdd = function (sk, sxv, syv) {
      var w = toWorld([sxv, syv]);
      w[0] = clamp(w[0], xmin, xmax); w[1] = clamp(w[1], ymin, ymax);
      var n = sk.pts.length, last = n ? sk.pts[n - 1] : null;
      if (last) {
        if (sk.o.monotoneX && !(w[0] > last[0])) return;
        if (Math.abs(sx(last[0]) - sx(w[0])) + Math.abs(sy(last[1]) - sy(w[1])) < 2) return;
      }
      sk.pts.push(w);
      sk.str += (sk.str ? " " : "") + f1(sx(w[0])) + "," + f1(sy(w[1]));
      sk.pl.setAttribute("points", sk.str);
    };
    function inPlot(cx, cy) {
      var rc = svg.getBoundingClientRect(), k = S.W / (rc.width || S.W || 1);
      var x = (cx - rc.left) * k, y = (cy - rc.top) * k;
      return x >= S.plot[0] - 12 && x <= S.plot[2] + 12 && y >= S.plot[1] - 12 && y <= S.plot[3] + 12;
    }

    /* ---------- 交互（有可拖动的点或手绘时才挂监听：纯静态图不挂，不影响滚动性能） ---------- */
    function hitPoint(t) {
      var P = t && t.__skPoint;
      return P && P._canDrag() ? P : null;
    }
    function ensureInteractive() {
      if (S.interactive) return;
      S.interactive = true;
      if (hasPE()) {
        svg.addEventListener("pointerdown", onPDown);
        svg.addEventListener("pointermove", onPMove);
        svg.addEventListener("pointerup", onPUp);
        svg.addEventListener("pointercancel", onPUp);
        svg.addEventListener("lostpointercapture", onPUp);
        // 非 passive：只有手指落在可拖动的触控圈上（或手绘开着、落在画区内）才 preventDefault，其余照常滚动
        svg.addEventListener("touchstart", onTouchGuard, { passive: false });
      } else {
        svg.addEventListener("touchstart", onTStart, { passive: false });
        svg.addEventListener("touchmove", onTMove, { passive: false });
        svg.addEventListener("touchend", onTEnd);
        svg.addEventListener("touchcancel", onTEnd);
        svg.addEventListener("mousedown", onMDown);
      }
      svg.addEventListener("keydown", onKey);
      svg.addEventListener("focusin", onFocusIn);
      svg.addEventListener("focusout", onFocusOut);
    }
    // 按下时决定拖什么：触控圈上的点优先，其次是手绘
    function begin(target, cx, cy, pid) {
      if (DRAG || S.destroyed) return false;
      var P = hitPoint(target);
      if (P) { startDrag(S, P, null, cx, cy, pid); return true; }
      if (S.sketch && S.sketch.on && inPlot(cx, cy)) {
        S.sketch.pts = []; S.sketch.str = "";
        startDrag(S, null, S.sketch, cx, cy, pid);
        S.sketchAdd(S.sketch, DRAG.ma * cx + DRAG.mc * cy + DRAG.me, DRAG.mb * cx + DRAG.md * cy + DRAG.mf);
        return true;
      }
      return false;
    }
    function onPDown(e) {
      lastPointer = now();
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (!begin(e.target, e.clientX, e.clientY, e.pointerId)) return;
      e.preventDefault();
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 个别旧内核不支持：退回靠事件冒泡 */ }
    }
    function onPMove(e) {
      var d = DRAG;
      if (!d || d.S !== S || e.pointerId !== d.id) return;
      var t0 = now();
      d.cx = e.clientX; d.cy = e.clientY;
      if (!d.raf) d.raf = raf(d.tick);
      perf.moves++; perf.moveMs += now() - t0;
    }
    function onPUp(e) {
      var d = DRAG;
      if (!d || d.S !== S || e.pointerId !== d.id) return;
      // 只认 svg 自己丢了捕获：触屏按下时浏览器可能先隐式捕获到触控圈，改由 svg 捕获时
      // 有的内核会在触控圈上发 lostpointercapture 并冒泡上来，那不是拖动结束
      if (e.type === "lostpointercapture" && e.target !== svg) return;
      if (e.type === "pointerup") { d.cx = e.clientX; d.cy = e.clientY; }
      endDrag(d, e.type !== "pointerup");
    }
    function onTouchGuard(e) {
      if (hitPoint(e.target)) { e.preventDefault(); return; }
      var t = e.touches && e.touches[0];
      if (S.sketch && S.sketch.on && t && e.touches.length === 1 && inPlot(t.clientX, t.clientY)) e.preventDefault();
    }
    // 没有 PointerEvent 的旧内核：touch + mouse
    function findTouch(list, idn) {
      for (var i = 0; list && i < list.length; i++) if (list[i].identifier === idn) return list[i];
      return null;
    }
    function onTStart(e) {
      lastPointer = now();
      if (DRAG) { if (DRAG.S === S) e.preventDefault(); return; }
      var t = e.changedTouches[0];
      if (begin(e.target, t.clientX, t.clientY, "t" + t.identifier)) e.preventDefault();
    }
    function onTMove(e) {
      var d = DRAG;
      if (!d || d.S !== S) return;
      var t0 = now();
      var t = findTouch(e.changedTouches, +String(d.id).slice(1));
      if (t) {
        e.preventDefault();
        d.cx = t.clientX; d.cy = t.clientY;
        if (!d.raf) d.raf = raf(d.tick);
      }
      perf.moves++; perf.moveMs += now() - t0;
    }
    function onTEnd(e) {
      var d = DRAG;
      if (!d || d.S !== S) return;
      var t = findTouch(e.changedTouches, +String(d.id).slice(1));
      if (t) endDrag(d, e.type === "touchcancel");
    }
    function onMDown(e) {
      lastPointer = now();
      if (e.button !== 0) return;
      if (!begin(e.target, e.clientX, e.clientY, "mouse")) return;
      e.preventDefault();
      var mv = function (ev) {
        var d = DRAG;
        if (!d || d.id !== "mouse") return;
        var t0 = now();
        d.cx = ev.clientX; d.cy = ev.clientY;
        if (!d.raf) d.raf = raf(d.tick);
        perf.moves++; perf.moveMs += now() - t0;
      };
      var up = function () {
        root.removeEventListener("mousemove", mv);
        root.removeEventListener("mouseup", up);
        if (DRAG && DRAG.id === "mouse") endDrag(DRAG, false);
      };
      root.addEventListener("mousemove", mv);
      root.addEventListener("mouseup", up);
    }
    // 键盘：左 / 下 = 负方向，右 / 上 = 正方向，沿约束走 step；PageUp / PageDown 走 10 步；
    // Home / End 跳到约束的起点 / 终点（和原生滑块一样）
    var KEYS = {
      ArrowRight: [1, 0], Right: [1, 0], ArrowLeft: [-1, 0], Left: [-1, 0],
      ArrowUp: [1, 1], Up: [1, 1], ArrowDown: [-1, 1], Down: [-1, 1],
      PageUp: [10, 1], PageDown: [-10, 1]
    };
    var ENDS = { Home: -1, End: 1 };
    function onKey(e) {
      var P = e.target && e.target.__skPoint;
      var k = KEYS[e.key], end = ENDS[e.key];
      if (!P || !(k || end) || !P._canDrag() || DRAG) return;
      if (k) {
        e.preventDefault();
        e.target.classList.add("sk-kbd");
        P._keyMove(k[0], k[1]);
      } else if (P._keyEnd(end)) {
        e.preventDefault();
        e.target.classList.add("sk-kbd");
      }
    }
    // 焦点圈只在用键盘（Tab）进来时显示：手指 / 鼠标点中时不出现多余的框
    var lastPointer = 0;
    function onFocusIn(e) {
      if (e.target && e.target.__skPoint && now() - lastPointer > 400) e.target.classList.add("sk-kbd");
    }
    function onFocusOut(e) { if (e.target && e.target.classList) e.target.classList.remove("sk-kbd"); }

    /* ---------- 重画 ---------- */
    function renderDyn() {
      if (S.raf) { caf(S.raf); S.raf = 0; }
      S.pend = false;
      for (var i = 0; i < S.items.length; i++) if (S.items[i].dyn) S.items[i].render();
    }
    S.renderDyn = renderDyn;
    // 用 rAF 合并，每帧最多一次；在拖动帧里调用时记下来，帧末同步完成（联动的板不慢一帧）
    function update() {
      if (S.destroyed) return;
      if (frameDepth > 0) {
        if (!S.pend) { S.pend = true; PENDING.push(S); }
        return;
      }
      if (!S.raf) S.raf = raf(function () { S.raf = 0; renderDyn(); });
    }
    b.update = update;
    b.resize = function () { layout(true); };
    b.destroy = function () {
      if (S.destroyed) return;
      if (DRAG && DRAG.S === S) endDrag(DRAG, true);
      S.destroyed = true;
      if (S.raf) caf(S.raf);
      if (S.lraf) caf(S.lraf);
      unwatch(S);
      S.items = [];
      if (svg.parentNode) svg.parentNode.removeChild(svg);
    };

    layout(true);
    watch(S);
    return b;
  }

  /* ============================== 拖动（所有画板共用） ============================== */
  function startDrag(S, P, sk, cx, cy, pid) {
    var m = null, d = { S: S, P: P, sk: sk, id: pid, cx: cx, cy: cy, raf: 0, ox: 0, oy: 0 };
    try { m = S.svg.getScreenCTM(); } catch (e) { m = null; }
    if (m) {
      // 缓存屏幕 → svg 的逆矩阵：拖动中只做乘加，不再读布局
      var inv = m.inverse();
      d.ma = inv.a; d.mb = inv.b; d.mc = inv.c; d.md = inv.d; d.me = inv.e; d.mf = inv.f;
    } else {
      var rc = S.svg.getBoundingClientRect(), k = S.W / (rc.width || S.W || 1);
      d.ma = k; d.mb = 0; d.mc = 0; d.md = k; d.me = -rc.left * k; d.mf = -rc.top * k;
    }
    if (P) {
      // 记住「点的位置 − 手指位置」：点不会跳到手指中心，手指也不会挡住点
      var ps = S.toScreen(P.get());
      d.ox = ps[0] - (d.ma * cx + d.mc * cy + d.me);
      d.oy = ps[1] - (d.mb * cx + d.md * cy + d.mf);
      P.node.classList.add("sk-dragging");
    }
    d.tick = function () { runFrame(d); };
    DRAG = d;
    S.svg.classList.add("sk-active");
    if (P) P._fire("start");
  }
  // 一帧：换算 → 约束 → 改 DOM → drag 回调 → 本板和联动板重画，全部同步完成
  function runFrame(d) {
    var t0 = now();
    d.raf = 0;
    var S = d.S;
    if (S.destroyed) return;
    var X = d.ma * d.cx + d.mc * d.cy + d.me + d.ox, Y = d.mb * d.cx + d.md * d.cy + d.mf + d.oy;
    frameDepth++;
    try {
      if (d.sk) S.sketchAdd(d.sk, X, Y);
      else if (d.P._dragTo(S.toWorld([X, Y]))) {
        d.P._fire("drag");
        S.renderDyn();
      }
      flushPending();
    } finally {
      frameDepth--;
    }
    perf.frames++; perf.frameMs += now() - t0;
  }
  function endDrag(d, cancelled) {
    if (DRAG !== d) return;
    // 还有没画的最后一帧：抬手前先补上，松手位置就是最后看到的位置
    if (d.raf) { caf(d.raf); if (!cancelled) runFrame(d); d.raf = 0; }
    DRAG = null;
    var S = d.S;
    try { if (typeof d.id === "number" && S.svg.hasPointerCapture && S.svg.hasPointerCapture(d.id)) S.svg.releasePointerCapture(d.id); } catch (e) { /* 忽略 */ }
    S.svg.classList.remove("sk-active");
    if (d.P) {
      d.P.node.classList.remove("sk-dragging");
      d.P._aria();
      d.P._fire("end");
    } else if (d.sk && d.sk.o.onEnd) {
      d.sk.o.onEnd(d.sk.api.get());
    }
  }

  /* ============================== figure：声明式静态图 ============================== */
  // spec 见 SPEC 7.3：{ view, aspect, axes, ratio?, maxHeight?, grid?, pad?, alt?, items:[…] }
  function figure(el, spec) {
    spec = spec || {};
    var b = board(el, {
      view: spec.view || [0, 10, 0, 10],
      aspect: spec.aspect === "equal" ? "equal" : "fill",
      axes: spec.axes || null,
      grid: spec.grid || false,
      pad: spec.pad != null ? spec.pad : 18,
      ratio: spec.ratio,
      height: spec.height,
      maxHeight: spec.maxHeight != null ? spec.maxHeight : 320,
      figure: true,
      ariaLabel: spec.alt || "示意图",
      cls: spec.cls
    });
    var items = spec.items || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var o = { dash: !!it.dash, accent: !!it.accent, color: it.color, width: it.width, cls: it.cls };
      if (it.t === "polyline" && it.pts) b.polyline(it.pts, o);
      else if (it.t === "polygon" && it.pts) { o.fill = it.fill !== false; b.polygon(it.pts, o); }
      else if (it.t === "segment" && it.a && it.b) b.segment(it.a, it.b, o);
      else if (it.t === "circle" && it.c) { o.fill = !!it.fill; b.circle(it.c, +it.r || 1, o); }
      else if (it.t === "point" && it.at) { o.label = it.label; o.pos = it.pos; o.r = it.r || 3.5; b.point(it.at, o); }
      else if (it.t === "text" && it.at) { o.pos = it.pos; b.text(it.at, it.s == null ? "" : it.s, o); }
    }
    return b;
  }

  /* ============================== controls：滑块 ============================== */
  // 默认最多露出 2 个滑块，其余收进「进阶」：手机上一屏只放少量可操作的东西，减轻认知负荷
  var ctlSeq = 0;
  function decimals(step) {
    var s = String(step), i = s.indexOf(".");
    return i < 0 ? 0 : s.length - i - 1;
  }
  function controls(el, defs, onChange) {
    if (typeof el === "string") el = document.querySelector(el);
    injectStyles();
    var rootEl = document.createElement("div");
    rootEl.className = "sk-controls";
    var main = document.createElement("div");
    main.className = "sk-ctl-main";
    rootEl.appendChild(main);
    var adv = null, advBody = null, shown = 0;
    var vals = {}, inputs = {}, outs = {}, dec = {};
    (defs || []).forEach(function (d) {
      var isAdv = !!d.advanced || shown >= 2;
      if (!isAdv) shown++;
      if (isAdv && !adv) {
        adv = document.createElement("details");
        adv.className = "sk-adv";
        var sm = document.createElement("summary");
        sm.textContent = "进阶";
        adv.appendChild(sm);
        advBody = document.createElement("div");
        advBody.className = "sk-adv-body";
        adv.appendChild(advBody);
      }
      var row = document.createElement("div");
      row.className = "sk-ctl";
      row.setAttribute("data-id", d.id);
      var iid = "skc" + (++ctlSeq) + "-" + String(d.id).replace(/[^A-Za-z0-9_-]/g, "");
      var lab = document.createElement("label");
      lab.className = "sk-ctl-head";
      lab.setAttribute("for", iid);
      var nm = document.createElement("span");
      nm.className = "sk-ctl-name";
      nm.textContent = d.label || d.id;
      var out = document.createElement("output");
      out.className = "sk-ctl-val";
      out.setAttribute("for", iid);
      lab.appendChild(nm);
      lab.appendChild(out);
      var inp = document.createElement("input");
      inp.type = "range";
      inp.className = "sk-range";
      inp.id = iid;
      var step = d.step != null ? +d.step : 1;
      inp.min = d.min != null ? d.min : 0;
      inp.max = d.max != null ? d.max : 10;
      inp.step = step;
      inp.value = d.value != null ? d.value : inp.min;
      dec[d.id] = decimals(step);
      vals[d.id] = +inp.value;
      out.textContent = fmtNum((+inp.value).toFixed(dec[d.id]));
      inp.addEventListener("input", function () {
        vals[d.id] = +inp.value;
        out.textContent = fmtNum((+inp.value).toFixed(dec[d.id]));
        if (typeof onChange === "function") onChange(api.values(), d.id);
      });
      row.appendChild(lab);
      row.appendChild(inp);
      (isAdv ? advBody : main).appendChild(row);
      inputs[d.id] = inp; outs[d.id] = out;
    });
    if (adv) rootEl.appendChild(adv);
    el.appendChild(rootEl);
    var api = {
      node: rootEl,
      get: function (id) { return vals[id]; },
      // 程序里改值不触发 onChange（调用方自己知道改了什么），只同步滑块和读数
      set: function (id, v) {
        var inp = inputs[id];
        if (!inp) return api;
        inp.value = v;
        vals[id] = +inp.value;
        outs[id].textContent = fmtNum((+inp.value).toFixed(dec[id]));
        return api;
      },
      values: function () {
        var o = {};
        for (var k in vals) if (Object.prototype.hasOwnProperty.call(vals, k)) o[k] = vals[k];
        return o;
      }
    };
    return api;
  }

  return {
    version: "0.1.0",
    geo: geo,
    on: on,
    perf: perf,
    board: board,
    figure: figure,
    controls: controls,
    fmt: fmtNum,
    colors: COLORS.slice()
  };
});
