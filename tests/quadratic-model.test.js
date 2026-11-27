/* math/js/quadratic-model.js 的单元测试（node --test tests/）：SPEC 第 4 节、第 8.A 节的边界情况。
 * 题库里的数值由 tests/batch1b-content.test.js 核对；这里只管模型本身：
 *   解析式的写法（a = 1 / −1 / 0.5，h 或 k 为 0，减号是「−」U+2212，不出现 x − −3）；
 *   顶点式 ↔ 一般式互换；区间最值的三种情况（含 a < 0、对称轴正好落在端点上算「区间内」）；
 *   平移描述；篱笆面积（墙长 8 m / 12 m）；对称轴在 y 轴哪一侧；取点函数。
 */
"use strict";
var describe = require("node:test").describe;
var it = require("node:test").it;
var assert = require("node:assert/strict");

var Q = require("../math/js/quadratic-model.js");

var MINUS = "−";
function near(a, b, msg, eps) {
  assert.ok(Math.abs(a - b) <= (eps == null ? 1e-9 : eps), (msg || "") + "：期望 " + b + "，实际 " + a);
}
function range(a, b, step) { var o = []; for (var v = a; v <= b + 1e-9; v += step) o.push(Math.round(v * 1e6) / 1e6); return o; }
// 滑块的取值：a 从 −3 到 3、步长 0.5、跳过 0；h、k 从 −4 到 4、步长 0.5
var AS = range(-3, 3, 0.5).filter(function (a) { return a !== 0; });
var HS = range(-4, 4, 0.5);

describe("常量与数字写法", function () {
  it("MINUS 是 U+2212；fmt 去掉多余的 0、负号用「−」", function () {
    assert.equal(Q.MINUS, MINUS);
    assert.equal(Q.MINUS.charCodeAt(0), 0x2212);
    assert.equal(Q.fmt(2), "2");
    assert.equal(Q.fmt(0.5), "0.5");
    assert.equal(Q.fmt(2.50), "2.5");
    assert.equal(Q.fmt(-7), MINUS + "7");
    assert.equal(Q.fmt(-0.5), MINUS + "0.5");
    assert.equal(Q.fmt(0), "0");
    assert.equal(Q.fmt(-0), "0", "−0 写成 0");
    assert.equal(Q.fmt(-1e-12), "0", "舍入后是 0 时不带负号");
    assert.equal(Q.fmt(1.23456), "1.23", "缺省保留 2 位");
    assert.equal(Q.fmt(1.23456, 3), "1.235");
  });
  it("round：缺省 4 位，−0 变 0", function () {
    assert.equal(Q.round(1.234567), 1.2346);
    assert.equal(Q.round(1.234567, 2), 1.23);
    assert.ok(Object.is(Q.round(-0.00001), 0));
  });
});

describe("解析式的写法（formatVertex / formatGeneral）", function () {
  it("顶点式：SPEC 的例子", function () {
    assert.equal(Q.formatVertex(1, 2, 0), "y = (x " + MINUS + " 2)²");
    assert.equal(Q.formatVertex(1, -3, -1), "y = (x + 3)² " + MINUS + " 1");
    assert.equal(Q.formatVertex(-1, 1, 2), "y = " + MINUS + "(x " + MINUS + " 1)² + 2");
    assert.equal(Q.formatVertex(0.5, 0, 2), "y = 0.5x² + 2");
    assert.equal(Q.formatVertex(2, 1, 3), "y = 2(x " + MINUS + " 1)² + 3");
  });
  it("a = 1 不写 1，a = −1 只写「−」，其余写数字（含 −0.5、−2.5）", function () {
    assert.equal(Q.formatVertex(1, 0, 0), "y = x²");
    assert.equal(Q.formatVertex(-1, 0, 0), "y = " + MINUS + "x²");
    assert.equal(Q.formatVertex(-0.5, -1, 0), "y = " + MINUS + "0.5(x + 1)²");
    assert.equal(Q.formatVertex(-2.5, 0, -3), "y = " + MINUS + "2.5x² " + MINUS + " 3");
    assert.equal(Q.formatVertex(3, 0.5, -0.5), "y = 3(x " + MINUS + " 0.5)² " + MINUS + " 0.5");
  });
  it("h = 0 时写 x²，k = 0 时不写常数项", function () {
    assert.equal(Q.formatVertex(2, 0, 0), "y = 2x²");
    assert.equal(Q.formatVertex(1, 0, -2), "y = x² " + MINUS + " 2");
    assert.equal(Q.formatVertex(1, -2, 0), "y = (x + 2)²");
    assert.equal(Q.formatVertex(1, 4, 0), "y = (x " + MINUS + " 4)²");
  });
  it("滑块能到的所有 (a, h, k)：没有 ASCII 减号、没有 x − −3 / + −、a = 1 不写 1、能把 a、h、k 读回来", function () {
    AS.forEach(function (a) {
      HS.forEach(function (h) {
        HS.forEach(function (k) {
          var s = Q.formatVertex(a, h, k);
          assert.ok(s.indexOf("-") < 0, s + " 里有 ASCII 减号");
          assert.ok(!/[−+] [−+]/.test(s) && !/[−+][−+]/.test(s), s + " 里有连着的两个符号");
          assert.ok(!/= 1[(x]/.test(s) && !/= −1[(x]/.test(s), s + " a = ±1 时不写 1");
          assert.ok(!/\.0[^0-9]|\.0$/.test(s), s + " 有多余的 .0");
          // 读回来：y = [系数](x ∓ h)² ± k
          var m = /^y = (−?)(\d+(?:\.\d+)?)?(?:\(x ([−+]) (\d+(?:\.\d+)?)\)²|x²)(?: ([−+]) (\d+(?:\.\d+)?))?$/.exec(s);
          assert.ok(m, "写法不认识：" + s);
          var A = (m[1] ? -1 : 1) * (m[2] ? +m[2] : 1);
          var H = m[3] ? (m[3] === MINUS ? 1 : -1) * +m[4] : 0;
          var K = m[5] ? (m[5] === MINUS ? -1 : 1) * +m[6] : 0;
          assert.deepEqual([A, H, K], [a, h, k], s);
        });
      });
    });
  });
  it("一般式：b = ±1 只写 x，b、c 为 0 时不写", function () {
    assert.equal(Q.formatGeneral(1, -2, -1), "y = x² " + MINUS + " 2x " + MINUS + " 1");
    assert.equal(Q.formatGeneral(-1, -2, 1), "y = " + MINUS + "x² " + MINUS + " 2x + 1");
    assert.equal(Q.formatGeneral(2, 1, 0), "y = 2x² + x");
    assert.equal(Q.formatGeneral(1, -1, 0), "y = x² " + MINUS + " x");
    assert.equal(Q.formatGeneral(1, 0, 0), "y = x²");
    assert.equal(Q.formatGeneral(0.5, 0, -3), "y = 0.5x² " + MINUS + " 3");
    assert.equal(Q.formatGeneral(-3, 1.5, 2.5), "y = " + MINUS + "3x² + 1.5x + 2.5");
    AS.forEach(function (a) {
      range(-3, 3, 0.5).forEach(function (b) {
        [-2, 0, 2].forEach(function (c) {
          var s = Q.formatGeneral(a, b, c);
          assert.ok(s.indexOf("-") < 0 && !/[−+] [−+]/.test(s), s);
          assert.ok(!/ 1x/.test(s) && !/= 1x/.test(s) && !/0x/.test(s.replace(/\d0x/, "")), s + " 不写 1x、0x");
        });
      });
    });
  });
});

describe("顶点式 ↔ 一般式", function () {
  it("y = a(x − h)² + k ⇔ b = −2ah、c = ah² + k；往返不变", function () {
    assert.deepEqual(Q.vertexToGeneral(1, 1, -2), { a: 1, b: -2, c: -1 });
    assert.deepEqual(Q.vertexToGeneral(-1, -1, 2), { a: -1, b: -2, c: 1 });
    assert.deepEqual(Q.generalToVertex(1, -2, -1), { a: 1, h: 1, k: -2 });
    assert.deepEqual(Q.generalToVertex(-1, -2, 1), { a: -1, h: -1, k: 2 });
    AS.forEach(function (a) {
      HS.forEach(function (h) {
        [-3, -0.5, 0, 1.5].forEach(function (k) {
          var g = Q.vertexToGeneral(a, h, k), v = Q.generalToVertex(g.a, g.b, g.c);
          near(v.a, a, "a"); near(v.h, h, "h (" + a + "," + h + "," + k + ")"); near(v.k, k, "k");
          // 两种写法在各处的值一样
          [-3, -1, 0, 0.5, 2].forEach(function (x) { near(Q.valueGeneral(g.a, g.b, g.c, x), Q.valueAt(a, h, k, x), "y(" + x + ")"); });
          near(Q.axis(g.a, g.b), h, "对称轴 = h");
          near(Q.valueAt(a, h, k, h), k, "顶点处 y = k");
        });
      });
    });
  });
  it("a = 0 不是二次函数：generalToVertex、axis、axisSide 返回 null", function () {
    assert.equal(Q.generalToVertex(0, 1, 1), null);
    assert.equal(Q.axis(0, 1), null);
    assert.equal(Q.axisSide(0, 1), null);
  });
});

describe("区间最值（intervalExtrema）", function () {
  it("对称轴在区间左侧（a > 0）：y = (x − 1)² + 2，2 ≤ x ≤ 4 → 最小 (2, 3)、最大 (4, 11)", function () {
    assert.deepEqual(Q.intervalExtrema(1, 1, 2, 2, 4), { "case": "left", min: { x: 2, y: 3 }, max: { x: 4, y: 11 } });
  });
  it("对称轴在区间内（a > 0）：最小在顶点，最大在离对称轴较远的端点", function () {
    assert.deepEqual(Q.intervalExtrema(1, 1, 2, 0, 4), { "case": "inside", min: { x: 1, y: 2 }, max: { x: 4, y: 11 } });
    assert.deepEqual(Q.intervalExtrema(1, 1, 2, -2, 2), { "case": "inside", min: { x: 1, y: 2 }, max: { x: -2, y: 11 } });
  });
  it("对称轴在区间右侧（a > 0）：在区间上递减，最小在右端点", function () {
    assert.deepEqual(Q.intervalExtrema(1, 1, 2, -3, -1), { "case": "right", min: { x: -1, y: 6 }, max: { x: -3, y: 18 } });
  });
  it("a < 0：三种情况都对（开口向下，顶点处取最大）", function () {
    assert.deepEqual(Q.intervalExtrema(-1, 1, 2, 2, 4), { "case": "left", min: { x: 4, y: -7 }, max: { x: 2, y: 1 } });
    assert.deepEqual(Q.intervalExtrema(-1, 1, 2, 0, 3), { "case": "inside", min: { x: 3, y: -2 }, max: { x: 1, y: 2 } });
    assert.deepEqual(Q.intervalExtrema(-1, 1, 2, -2, 0), { "case": "right", min: { x: -2, y: -7 }, max: { x: 0, y: 1 } });
  });
  it("对称轴正好在端点上算「区间内」；端点顺序反了也照样算", function () {
    assert.deepEqual(Q.intervalExtrema(1, 2, 0, 2, 5), { "case": "inside", min: { x: 2, y: 0 }, max: { x: 5, y: 9 } });
    assert.deepEqual(Q.intervalExtrema(1, 5, 0, 2, 5), { "case": "inside", min: { x: 5, y: 0 }, max: { x: 2, y: 9 } });
    assert.deepEqual(Q.intervalExtrema(-2, 2, 1, 2, 3), { "case": "inside", min: { x: 3, y: -1 }, max: { x: 2, y: 1 } });
    assert.deepEqual(Q.intervalExtrema(1, 1, 2, 4, 2), Q.intervalExtrema(1, 1, 2, 2, 4));
    // 刚出端点一点点就是 left / right
    assert.equal(Q.intervalExtrema(1, 1.999, 0, 2, 5)["case"], "left");
    assert.equal(Q.intervalExtrema(1, 5.001, 0, 2, 5)["case"], "right");
  });
  it("与逐点取样的最值一致（滑块能到的 a、h，窗口宽 1～6、位置 −4～4）", function () {
    [-3, -1, -0.5, 0.5, 1, 2].forEach(function (a) {
      [-3, -1, 0, 1, 2.5].forEach(function (h) {
        [1, 2.5, 6].forEach(function (w) {
          [-4, -1.5, 0, 2].forEach(function (x1) {
            var x2 = x1 + w, k = 1, E = Q.intervalExtrema(a, h, k, x1, x2);
            var ys = range(x1, x2, w / 400).concat([Math.min(Math.max(h, x1), x2)]).map(function (x) { return Q.valueAt(a, h, k, x); });
            near(E.min.y, Math.min.apply(null, ys), "min a=" + a + " h=" + h + " [" + x1 + "," + x2 + "]", 1e-9);
            near(E.max.y, Math.max.apply(null, ys), "max", 1e-9);
            near(Q.valueAt(a, h, k, E.min.x), E.min.y, "min 点在曲线上");
            near(Q.valueAt(a, h, k, E.max.x), E.max.y, "max 点在曲线上");
            assert.equal(E["case"], h < x1 ? "left" : h > x2 ? "right" : "inside");
          });
        });
      });
    });
  });
});

describe("平移描述（shiftText）", function () {
  it("SPEC 的例子和各种组合", function () {
    assert.equal(Q.shiftText(2, -1), "向右 2、向下 1");
    assert.equal(Q.shiftText(-3, 0), "向左 3");
    assert.equal(Q.shiftText(-3, -1), "向左 3、向下 1");
    assert.equal(Q.shiftText(0, 0.5), "向上 0.5");
    assert.equal(Q.shiftText(0, -2), "向下 2");
    assert.equal(Q.shiftText(1.5, 2), "向右 1.5、向上 2");
    assert.equal(Q.shiftText(0, 0), "不平移");
    assert.equal(Q.shiftText(1e-9, -1e-9), "不平移", "浮点误差不算平移");
  });
  it("左右、上下各自独立；文字里没有负号", function () {
    HS.forEach(function (h) {
      HS.forEach(function (k) {
        var s = Q.shiftText(h, k);
        assert.ok(s.indexOf(MINUS) < 0 && s.indexOf("-") < 0, s);
        assert.equal(s.indexOf("向右") >= 0, h > 0); assert.equal(s.indexOf("向左") >= 0, h < 0);
        assert.equal(s.indexOf("向上") >= 0, k > 0); assert.equal(s.indexOf("向下") >= 0, k < 0);
      });
    });
  });
});

describe("a、b、c 与图象", function () {
  it("sign 和 axisSide：左同右异", function () {
    assert.equal(Q.sign(2), "+"); assert.equal(Q.sign(-0.5), MINUS); assert.equal(Q.sign(0), "0"); assert.equal(Q.sign(1e-12), "0");
    assert.equal(Q.axisSide(1, -2), "right");
    assert.equal(Q.axisSide(-1, -2), "left");
    assert.equal(Q.axisSide(1, 0), "on");
    assert.equal(Q.axisSide(-2, 0), "on");
    AS.forEach(function (a) {
      range(-3, 3, 0.5).forEach(function (b) {
        var side = Q.axisSide(a, b);
        if (b === 0) assert.equal(side, "on");
        else assert.equal(side, (a > 0) === (b > 0) ? "left" : "right", "a = " + a + "，b = " + b);
      });
    });
  });
  it("abSigns：a、b、c 的正负、开口方向、与 y 轴的交点", function () {
    assert.deepEqual(Q.abSigns(1, -2, -1), { a: "+", b: MINUS, c: MINUS, side: "right", opens: "up", yIntercept: -1 });
    assert.deepEqual(Q.abSigns(-1, -2, 1), { a: MINUS, b: MINUS, c: "+", side: "left", opens: "down", yIntercept: 1 });
    assert.deepEqual(Q.abSigns(2, 0, 0), { a: "+", b: "0", c: "0", side: "on", opens: "up", yIntercept: 0 });
    near(Q.valueGeneral(1, -2, -1, 0), -1, "与 y 轴交于 (0, c)");
  });
});

describe("靠墙围矩形（fence）", function () {
  it("L = 20、墙长 8：6 ≤ x < 10，对称轴 5 不在范围里，x = 6 时最大 48（顶点值 50 取不到）", function () {
    var F = Q.fence(20, 8);
    assert.deepEqual([F.xMin, F.xMax, F.xMinOpen, F.axis, F.inRange, F.xAtMax, F.Smax, F.Svertex], [6, 10, false, 5, false, 6, 48, 50]);
    near(F.S(6), 48); near(F.S(5), 50); near(F.S(10), 0);
  });
  it("L = 20、墙长 12：4 ≤ x < 10，对称轴 5 在范围里，x = 5 时最大 50", function () {
    var F = Q.fence(20, 12);
    assert.deepEqual([F.xMin, F.xMax, F.axis, F.inRange, F.xAtMax, F.Smax], [4, 10, 5, true, 5, 50]);
    near(F.S(4), 48);
  });
  it("墙正好等于 L/2 时对称轴落在下限上（算在范围里）；墙比 L 还长时下限是 0（开区间）", function () {
    var F = Q.fence(20, 10);
    assert.deepEqual([F.xMin, F.inRange, F.xAtMax, F.Smax], [5, true, 5, 50]);
    var G = Q.fence(20, 30);
    assert.deepEqual([G.xMin, G.xMinOpen, G.inRange, G.Smax], [0, true, true, 50]);
  });
  it("最大值与逐点取样一致（墙长 2～20）", function () {
    range(2, 20, 1).forEach(function (w) {
      var F = Q.fence(20, w);
      var xs = range(F.xMin, F.xMax - 1e-6, 0.005);
      var best = Math.max.apply(null, xs.map(F.S));
      near(F.Smax, best, "墙长 " + w, 1e-3);
      near(20 - 2 * F.xMin, Math.min(w, 20), "x 取下限时平行于墙的边 = 墙长");
    });
  });
});

describe("取点函数", function () {
  it("sample：n 段 n + 1 个点，坐标 round 到 4 位", function () {
    var p = Q.sample(function (x) { return x * x; }, 0, 1, 3);
    assert.deepEqual(p, [[0, 0], [0.3333, 0.1111], [0.6667, 0.4444], [1, 1]]);
  });
  it("parabolaPoints：只留 y 在视野里的连续一段；不给视野时全留", function () {
    var all = Q.parabolaPoints(1, 0, 0, -3, 3, 12);
    assert.equal(all.length, 13);
    var p = Q.parabolaPoints(1, 0, 0, -3, 3, 12, -1, 4);
    assert.deepEqual(p.map(function (q) { return q[0]; }), [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2]);
    p.forEach(function (q) { assert.ok(q[1] >= -1 && q[1] <= 4); });
    // 开口向下：去掉两侧太低的部分
    var d = Q.parabolaPoints(-1, 1, 2, -4.5, 4.5, 72, -3, 7);
    d.forEach(function (q) { assert.ok(q[1] >= -3 - 1e-9); near(q[1], Q.round(Q.valueAt(-1, 1, 2, q[0]), 4), "在曲线上"); });
    for (var i = 1; i < d.length; i++) near(d[i][0] - d[i - 1][0], 0.125, "连续一段", 1e-9);
  });
});
