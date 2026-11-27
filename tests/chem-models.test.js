/* chemistry/js/chem-models.js 的单元测试（node --test tests/）：SPEC 第 5.1、6.1 节和第 8.A 节的边界情况。
 * 题库里的数值由 tests/batch1b-content.test.js 核对；这里只管模型本身：
 *   溶解度：插值在表值处取原值、表值之间单调且不超调；80 g 对应的温度、两条曲线的交点；
 *   状态：不饱和 / 恰好饱和 / 有晶体（含容差 eps、水 50 g）、析出量、质量分数、降温轨迹、NaCl 蒸发；
 *   四对试剂：V = 0 / 10 / 20 / 30 / 40 mL 时的 pH（误差 0.01）、各阶段的溶质、示意粒子数守恒；
 *   NaOH 变质探究：每种「样品 × 试剂顺序」（三步以内全部列举）的现象，覆盖第 6.1 节的每一条规则；
 *   NaOH 和 Na₂CO₃ 混合溶液滴盐酸放出的气体。
 */
"use strict";
var describe = require("node:test").describe;
var it = require("node:test").it;
var assert = require("node:assert/strict");

var C = require("../chemistry/js/chem-models.js");

function near(a, b, msg, eps) {
  assert.ok(Math.abs(a - b) <= (eps == null ? 1e-9 : eps), (msg || "") + "：期望 " + b + "，实际 " + a);
}
function range(a, b, step) { var o = []; for (var v = a; v <= b + 1e-9; v += step) o.push(Math.round(v * 1e6) / 1e6); return o; }
var SUBS = ["KNO3", "NaCl"];

/* ==================== 溶解度 ==================== */
describe("溶解度表与插值", function () {
  it("课本表值（SPEC 5.1）", function () {
    assert.deepEqual(C.TEMPS, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    assert.deepEqual(C.TABLE.KNO3, [13.3, 20.9, 31.6, 45.8, 63.9, 85.5, 110, 138, 169, 202, 246]);
    assert.deepEqual(C.TABLE.NaCl, [35.7, 35.8, 36.0, 36.3, 36.6, 37.0, 37.3, 37.8, 38.4, 39.0, 39.8]);
    assert.deepEqual(C.NAME, { KNO3: "KNO₃", NaCl: "NaCl" });
  });
  it("三次插值在表值处正好取原值（不是近似），左右两侧连续", function () {
    SUBS.forEach(function (sub) {
      C.TEMPS.forEach(function (T, i) {
        assert.equal(C.solubility(sub, T), C.TABLE[sub][i], sub + " " + T + "℃");
        assert.equal(C.solubilityLinear(sub, T), C.TABLE[sub][i], sub + " 直线 " + T + "℃");
        if (T > 0) near(C.solubility(sub, T - 1e-7), C.TABLE[sub][i], sub + " " + T + "℃ 左侧", 1e-4);
        if (T < 100) near(C.solubility(sub, T + 1e-7), C.TABLE[sub][i], sub + " " + T + "℃ 右侧", 1e-4);
      });
    });
  });
  it("表值之间单调递增、不超调（每 0.05℃ 取样）", function () {
    SUBS.forEach(function (sub) {
      var prev = -Infinity;
      range(0, 100, 0.05).forEach(function (T) {
        var s = C.solubility(sub, T), i = Math.min(9, Math.floor(T / 10));
        assert.ok(s > prev, sub + " 在 " + T + "℃ 不递增：" + prev + " → " + s);
        assert.ok(s >= C.TABLE[sub][i] - 1e-12 && s <= C.TABLE[sub][i + 1] + 1e-12, sub + " 在 " + T + "℃ 超出相邻两个表值");
        prev = s;
      });
    });
  });
  it("直线插值：两个表值的平均数在中点；温度夹在 0～100℃；不认识的物质返回 null", function () {
    near(C.solubilityLinear("KNO3", 45), (63.9 + 85.5) / 2, "KNO₃ 45℃");
    near(C.solubilityLinear("NaCl", 25), (36.0 + 36.3) / 2, "NaCl 25℃");
    assert.equal(C.solubility("KNO3", -5), 13.3); assert.equal(C.solubility("KNO3", 120), 246);
    assert.equal(C.solubility("X", 20), null);
  });
  it("KNO₃ 溶解度 80 g 时：三次插值 47.58℃（SPEC ≈ 47.6），直线插值 47.45℃（SPEC 写 47.4，是截去而不是四舍五入）", function () {
    var Tc = C.tempForSolubility("KNO3", 80), Tl = C.tempForSolubility("KNO3", 80, true);
    near(Tc, 47.5829, "三次插值", 1e-4);
    assert.equal(Math.round(Tc * 10) / 10, 47.6);
    near(Tl, 40 + (80 - 63.9) / (85.5 - 63.9) * 10, "直线插值 = 40 + 16.1 / 21.6 × 10", 1e-9);
    assert.equal(Math.floor(Tl * 10) / 10, 47.4);
    near(C.solubility("KNO3", Tc), 80, "代回去", 1e-9);
    near(C.solubilityLinear("KNO3", Tl), 80, "代回去（直线）", 1e-9);
    // 反函数：每个能取到的 S 都能求回温度
    [13.3, 20, 36.1, 63.9, 100, 246].forEach(function (S) {
      near(C.solubility("KNO3", C.tempForSolubility("KNO3", S)), S, "S = " + S, 1e-9);
    });
    near(C.solubility("NaCl", C.tempForSolubility("NaCl", 36.1)), 36.1, "NaCl", 1e-9);
    // 超出 0～100℃ 的范围：null
    assert.equal(C.tempForSolubility("KNO3", 10), null);
    assert.equal(C.tempForSolubility("KNO3", 300), null);
    assert.equal(C.tempForSolubility("NaCl", 40), null);
  });
  it("两条曲线的交点 T ≈ 23.5℃、S ≈ 36.1 g；交点以下 NaCl 大、以上 KNO₃ 大", function () {
    var X = C.crossing();
    near(X.T, 23.4561, "交点温度", 1e-4); near(X.S, 36.0963, "交点溶解度", 1e-4);
    assert.equal(Math.round(X.T * 10) / 10, 23.5); assert.equal(Math.round(X.S * 10) / 10, 36.1);
    near(C.solubility("KNO3", X.T), C.solubility("NaCl", X.T), "交点处相等", 1e-9);
    range(0, 23.4, 0.2).forEach(function (T) { assert.ok(C.solubility("KNO3", T) < C.solubility("NaCl", T), T + "℃"); });
    range(23.6, 100, 0.2).forEach(function (T) { assert.ok(C.solubility("KNO3", T) > C.solubility("NaCl", T), T + "℃"); });
    // 直线插值的交点（只作对照）
    near(C.crossing(true).T, 23.1655, "直线插值的交点", 1e-4);
  });
  it("curvePoints：两端、点数、round 到 4 位", function () {
    var p = C.curvePoints("KNO3", 0, 60, 30);
    assert.equal(p.length, 31);
    assert.deepEqual(p[0], [0, 13.3]); assert.deepEqual(p[30], [60, 110]); assert.deepEqual(p[10], [20, 31.6]);
    p.forEach(function (q) { assert.equal(q[1], Math.round(C.solubility("KNO3", q[0]) * 1e4) / 1e4); });
    // 反向（从高温到低温）也行
    var r = C.curvePoints("KNO3", 60, 20, 40);
    assert.deepEqual(r[0], [60, 110]); assert.deepEqual(r[40], [20, 31.6]);
  });
});

/* ==================== 状态 ==================== */
describe("状态：不饱和、恰好饱和、有晶体析出", function () {
  it("KNO₃ 80 g / 100 g 水：60℃ 不饱和，约 47.6℃ 恰好饱和，20℃ 析出 48.4 g", function () {
    var s60 = C.state("KNO3", 60, 100, 80);
    assert.equal(s60.status, "unsat");
    assert.equal(s60.per100, 80); assert.equal(s60.S, 110); assert.equal(s60.precipitate, 0); assert.equal(s60.dissolved, 80);
    near(s60.fraction, 80 / 180 * 100, "质量分数");
    assert.equal(s60.solutionPer100, 80, "不饱和时实心点就是状态点");
    var Tc = C.tempForSolubility("KNO3", 80);
    assert.equal(C.state("KNO3", Tc, 100, 80).status, "sat");
    var s20 = C.state("KNO3", 20, 100, 80);
    assert.equal(s20.status, "crystal");
    near(s20.precipitate, 48.4, "析出");
    near(s20.dissolved, 31.6, "溶解");
    assert.equal(s20.solutionPer100, 31.6, "实心点在曲线上");
    near(s20.fraction, 31.6 / 131.6 * 100, "质量分数 = 饱和溶液的");
    near(s20.fraction, C.saturatedFraction("KNO3", 20), "saturatedFraction");
    assert.equal((Math.round(s20.fraction * 10) / 10).toFixed(1), "24.0");
  });
  it("容差 eps：离曲线 0.19 g 时缺省判为有晶体，eps = 0.5 时判为恰好饱和（页面吸附另算）", function () {
    var S = C.solubility("KNO3", 47.5);
    assert.ok(80 - S > 0.18 && 80 - S < 0.2);
    assert.equal(C.state("KNO3", 47.5, 100, 80).status, "crystal");
    var s = C.state("KNO3", 47.5, 100, 80, 0.5);
    assert.equal(s.status, "sat"); assert.equal(s.precipitate, 0);
    assert.equal(C.state("KNO3", 47.7, 100, 80, 0.5).status, "sat");
    assert.equal(C.state("KNO3", 48.5, 100, 80, 0.5).status, "unsat");
    // 缺省容差 1e-6
    assert.equal(C.state("NaCl", 20, 100, 36 + 5e-7).status, "sat");
    assert.equal(C.state("NaCl", 20, 100, 36 + 5e-6).status, "crystal");
    assert.equal(C.state("NaCl", 20, 100, 36 - 5e-6).status, "unsat");
  });
  it("水 W = 50 g：每 100 g 水对应的量 = 2m；析出量按 W 折算", function () {
    var a = C.state("NaCl", 20, 50, 18);
    assert.equal(a.per100, 36); assert.equal(a.status, "sat"); assert.equal(a.precipitate, 0);
    var b = C.state("NaCl", 20, 50, 20);
    assert.equal(b.status, "crystal");
    near(b.precipitate, (40 - 36) * 50 / 100, "析出 2 g");
    near(b.dissolved, 18); near(b.fraction, 18 / 68 * 100);
    var c = C.state("KNO3", 30, 50, 10);
    assert.equal(c.per100, 20); assert.equal(c.status, "unsat"); near(c.fraction, 10 / 60 * 100);
  });
  it("NaCl 情境：60℃ 37.3 g 恰好饱和 → 20℃ 析出 1.3 g → 恒温蒸发 10 g 水再多析出 3.6 g；水最少 50 g", function () {
    assert.equal(C.state("NaCl", 60, 100, 37.3).status, "sat");
    var p20 = C.state("NaCl", 20, 100, 37.3).precipitate;
    near(p20, 1.3);
    var p90 = C.state("NaCl", 20, 90, 37.3).precipitate;
    near(p90 - p20, 3.6, "蒸发 10 g 水多析出");
    near(C.state("NaCl", 20, 50, 37.3).precipitate, 37.3 - 18, "水剩 50 g");
    // 恒温蒸发后仍是饱和溶液：质量分数不变
    near(C.state("NaCl", 20, 90, 37.3).fraction, C.saturatedFraction("NaCl", 20), "质量分数", 1e-9);
    near(C.saturatedFraction("NaCl", 20), 36 / 136 * 100);
  });
  it("降温轨迹 coolPath：先水平、碰到曲线后沿曲线下滑；点数 n + 1", function () {
    var P = C.coolPath("KNO3", 80, 100, 60, 20);
    assert.equal(P.length, 41);
    assert.deepEqual(P[0], [60, 80]); assert.deepEqual(P[40], [20, 31.6]);
    var Tc = C.tempForSolubility("KNO3", 80);
    P.forEach(function (p, i) {
      assert.equal(p[0], 60 - i);
      if (p[0] >= Tc) assert.equal(p[1], 80, p[0] + "℃ 水平段");
      else near(p[1], Math.round(C.solubility("KNO3", p[0]) * 1e4) / 1e4, p[0] + "℃ 在曲线上", 1e-12);
      if (i) assert.ok(p[1] <= P[i - 1][1]);
    });
    // 溶质很少时一直水平（不碰到曲线）
    var Q = C.coolPath("KNO3", 20, 100, 60, 20, 8);
    Q.forEach(function (p) { assert.equal(p[1], 20); });
    assert.equal(Q.length, 9);
  });
});

/* ==================== 四对试剂 ==================== */
describe("四对试剂：pH、阶段、溶质", function () {
  var PH = {
    1: [1.00, 1.48, 7.00, 12.30, 12.52],
    2: [13.00, 12.52, 7.00, 1.70, 1.48],
    3: [13.00, 12.52, 7.00, 1.70, 1.48],
    4: [1.00, 1.48, 7.00, 11.16, 11.27]
  };
  it("常量：锥形瓶 20 mL、最多滴 40 mL、20 mL 时恰好完全反应；试剂对的名称", function () {
    assert.deepEqual([C.VOL0, C.VMAX, C.VEQ], [20, 40, 20]);
    assert.deepEqual([C.PAIRS[1].flask, C.PAIRS[1].titrant], ["稀盐酸", "NaOH 溶液"]);
    assert.deepEqual([C.PAIRS[2].flask, C.PAIRS[2].titrant], ["NaOH 溶液", "稀盐酸"]);
    assert.deepEqual([C.PAIRS[3].flask, C.PAIRS[3].titrant], ["Ba(OH)₂ 溶液", "稀硫酸"]);
    assert.deepEqual([C.PAIRS[4].flask, C.PAIRS[4].titrant], ["稀盐酸", "Na₂CO₃ 溶液"]);
    assert.deepEqual(C.PAIRS[3].products, ["BaSO₄↓", "H₂O"]);
    assert.deepEqual(C.PAIRS[4].products, ["NaCl", "H₂O", "CO₂↑"]);
    assert.equal(C.pairState(5, 10), null);
  });
  it("V = 0 / 10 / 20 / 30 / 40 mL 时的 pH 与 SPEC 6.1 的表一致（误差 0.01）", function () {
    Object.keys(PH).forEach(function (id) {
      [0, 10, 20, 30, 40].forEach(function (v, i) {
        near(C.pairState(+id, v).pH, PH[id][i], "试剂对 " + id + " V = " + v, 0.01);
      });
    });
  });
  it("pH 随 V 单调（① ④ 升、② ③ 降），④ 过量以后不低于 7；V 夹在 0～40", function () {
    [1, 2, 3, 4].forEach(function (id) {
      var up = id === 1 || id === 4, prev = null;
      range(0, 40, 0.25).forEach(function (v) {
        var p = C.pairState(id, v).pH;
        assert.ok(p >= 0 && p <= 14, "pH 在 0～14");
        if (prev !== null) assert.ok(up ? p >= prev : p <= prev, "试剂对 " + id + " 在 V = " + v + " 不单调");
        prev = p;
      });
    });
    range(20, 40, 0.5).forEach(function (v) { assert.ok(C.pairState(4, v).pH >= 7); });
    assert.equal(C.pairState(1, 55).V, 40); assert.equal(C.pairState(1, -3).V, 0);
  });
  it("阶段：V < 20 before、= 20 equiv、> 20 after；eps 内算恰好完全反应（页面吸附另算）", function () {
    [1, 2, 3, 4].forEach(function (id) {
      assert.equal(C.pairState(id, 19.9).stage, "before");
      assert.equal(C.pairState(id, 20).stage, "equiv");
      assert.equal(C.pairState(id, 20.1).stage, "after");
      var e = C.pairState(id, 19.8, 0.3);
      assert.equal(e.stage, "equiv"); assert.equal(e.pH, 7);
    });
    assert.equal(C.pairState(1, 19.6, 0.3).stage, "before");
  });
  it("各阶段的溶质（沉淀、气体、水不算）", function () {
    var exp = {
      1: [["HCl"], ["NaCl", "HCl"], ["NaCl"], ["NaCl", "NaOH"]],
      2: [["NaOH"], ["NaCl", "NaOH"], ["NaCl"], ["NaCl", "HCl"]],
      3: [["Ba(OH)₂"], ["Ba(OH)₂"], [], ["H₂SO₄"]],
      4: [["HCl"], ["NaCl", "HCl"], ["NaCl"], ["NaCl", "Na₂CO₃"]]
    };
    Object.keys(exp).forEach(function (id) {
      assert.deepEqual(C.pairState(+id, 0).solutes, exp[id][0], id + " V = 0");
      [0.5, 5, 10, 19.5].forEach(function (v) { assert.deepEqual(C.pairState(+id, v).solutes, exp[id][1], id + " V = " + v); });
      assert.deepEqual(C.pairState(+id, 20).solutes, exp[id][2], id + " V = 20");
      [20.5, 30, 40].forEach(function (v) { assert.deepEqual(C.pairState(+id, v).solutes, exp[id][3], id + " V = " + v); });
    });
  });
  it("③ 的示意粒子数（SPEC 6.1 的例子）：V = 10 时 Ba²⁺ 5、OH⁻ 10、SO₄²⁻ 0、H⁺ 0，BaSO₄ 5；V = 20 时四种都是 0", function () {
    var a = C.pairState(3, 10);
    assert.deepEqual(a.ions, { "Ba²⁺": 5, "OH⁻": 10, "H⁺": 0, "SO₄²⁻": 0 });
    assert.deepEqual(a.precipitate, { "BaSO₄": 5 });
    assert.deepEqual(C.pairState(3, 20).ions, { "Ba²⁺": 0, "OH⁻": 0, "H⁺": 0, "SO₄²⁻": 0 });
    assert.deepEqual(C.pairState(3, 20).precipitate, { "BaSO₄": 10 });
    assert.deepEqual(C.pairState(3, 30).ions, { "Ba²⁺": 0, "OH⁻": 0, "H⁺": 10, "SO₄²⁻": 5 });
    assert.deepEqual(C.pairState(4, 30).ions, { "H⁺": 0, "Cl⁻": 20, "Na⁺": 30, "CO₃²⁻": 5 });
    assert.deepEqual(C.pairState(4, 30).gas, { "CO₂": 10 });
    // 离子条的顺序 = PAIRS[id].ions，键都在
    [1, 2, 3, 4].forEach(function (id) {
      assert.deepEqual(Object.keys(C.pairState(id, 10).ions).sort(), C.PAIRS[id].ions.slice().sort());
    });
  });
  it("示意粒子数守恒（V 从 0 到 40 每 0.25 mL，另加 7.3、19.99、20.01）", function () {
    var Vs = range(0, 40, 0.25).concat([7.3, 19.99, 20.01]);
    var E = 1e-6;
    Vs.forEach(function (v) {
      var s1 = C.pairState(1, v), s2 = C.pairState(2, v), s3 = C.pairState(3, v), s4 = C.pairState(4, v);
      var i1 = s1.ions, i2 = s2.ions, i3 = s3.ions, i4 = s4.ions, tag = " V = " + v;
      // ① 稀盐酸里滴 NaOH：Cl⁻ 一直 20，Na⁺ = 滴进去的 V；消耗的 H⁺ = 消耗的 OH⁻；H⁺、OH⁻ 不同时剩下；电荷守恒
      near(i1["Cl⁻"], 20, "① Cl⁻" + tag, E); near(i1["Na⁺"], v, "① Na⁺" + tag, E);
      near(20 - i1["H⁺"], v - i1["OH⁻"], "① 消耗的 H⁺ = 消耗的 OH⁻" + tag, E);
      assert.ok(i1["H⁺"] === 0 || i1["OH⁻"] === 0, "① H⁺、OH⁻ 不同时剩下" + tag);
      near(i1["Na⁺"] + i1["H⁺"], i1["Cl⁻"] + i1["OH⁻"], "① 电荷" + tag, E);
      // ② NaOH 溶液里滴稀盐酸：Na⁺ 一直 20，Cl⁻ = V
      near(i2["Na⁺"], 20, "② Na⁺" + tag, E); near(i2["Cl⁻"], v, "② Cl⁻" + tag, E);
      near(20 - i2["OH⁻"], v - i2["H⁺"], "② 消耗的 OH⁻ = 消耗的 H⁺" + tag, E);
      assert.ok(i2["H⁺"] === 0 || i2["OH⁻"] === 0);
      near(i2["Na⁺"] + i2["H⁺"], i2["Cl⁻"] + i2["OH⁻"], "② 电荷" + tag, E);
      // ③ Ba(OH)₂ 里滴稀硫酸：Ba²⁺ + BaSO₄ = 10；SO₄²⁻ + BaSO₄ = 滴进去的 V/2；H⁺ 加进去 V 个
      near(i3["Ba²⁺"] + s3.precipitate["BaSO₄"], 10, "③ Ba" + tag, E);
      near(i3["SO₄²⁻"] + s3.precipitate["BaSO₄"], v / 2, "③ SO₄" + tag, E);
      near(20 - i3["OH⁻"], v - i3["H⁺"], "③ 消耗的 OH⁻ = 消耗的 H⁺" + tag, E);
      assert.ok(i3["Ba²⁺"] === 0 || i3["SO₄²⁻"] === 0, "③ Ba²⁺、SO₄²⁻ 不同时剩下" + tag);
      near(2 * i3["Ba²⁺"] + i3["H⁺"], i3["OH⁻"] + 2 * i3["SO₄²⁻"], "③ 电荷" + tag, E);
      // ④ 稀盐酸里滴 Na₂CO₃：Cl⁻ 一直 20，Na⁺ = V；加进去的 CO₃²⁻（V/2）= 剩下的 + 放出的 CO₂；消耗的 H⁺ = 2 × CO₂
      near(i4["Cl⁻"], 20, "④ Cl⁻" + tag, E); near(i4["Na⁺"], v, "④ Na⁺" + tag, E);
      near(i4["CO₃²⁻"] + s4.gas["CO₂"], v / 2, "④ CO₃" + tag, E);
      near(20 - i4["H⁺"], 2 * s4.gas["CO₂"], "④ H⁺ 与 CO₂" + tag, E);
      assert.ok(i4["H⁺"] === 0 || i4["CO₃²⁻"] === 0, "④ H⁺、CO₃²⁻ 不同时剩下" + tag);
      near(i4["Na⁺"] + i4["H⁺"], i4["Cl⁻"] + 2 * i4["CO₃²⁻"], "④ 电荷" + tag, E);
      // 粒子数不为负；① ② ④ 没有沉淀，① ② ③ 没有气体
      [s1, s2, s3, s4].forEach(function (s) { Object.keys(s.ions).forEach(function (k) { assert.ok(s.ions[k] >= 0, k + tag); }); });
      assert.deepEqual([s1.precipitate, s2.precipitate, s4.precipitate, s1.gas, s2.gas, s3.gas], [{}, {}, {}, {}, {}, {}]);
    });
  });
  it("phCurve：每 step 一个点，经过 (20, 7)；只画到 vTo", function () {
    var p = C.phCurve(1, 40, 0.5);
    assert.equal(p.length, 81);
    assert.ok(p.some(function (q) { return q[0] === 20 && q[1] === 7; }));
    var odd = C.phCurve(2, 40, 3);   // 3 的倍数不含 20：单独补上 (20, 7)
    assert.ok(odd.some(function (q) { return q[0] === 20 && q[1] === 7; }));
    for (var i = 1; i < odd.length; i++) assert.ok(odd[i][0] > odd[i - 1][0], "按 V 排好");
    var part = C.phCurve(1, 10, 2);
    assert.deepEqual(part.map(function (q) { return q[0]; }), [0, 2, 4, 6, 8, 10]);
    part.forEach(function (q) { near(q[1], Math.round(C.pairState(1, q[0]).pH * 1e4) / 1e4, "V = " + q[0]); });
  });
});

/* ==================== NaOH 变质探究 ==================== */
describe("NaOH 变质探究的反应规则", function () {
  var SAMPLES = ["none", "partial", "full"];
  var REAG = ["acid", "phenol", "cacl2", "lime"];

  it("三种样品、四种试剂的名称", function () {
    assert.deepEqual(C.SAMPLES, { none: { NaOH: true }, partial: { NaOH: true, Na2CO3: true }, full: { Na2CO3: true } });
    assert.deepEqual(C.SAMPLE_NAME, { none: "未变质", partial: "部分变质", full: "完全变质" });
    assert.deepEqual(C.REAGENTS, { acid: "足量稀盐酸", phenol: "酚酞溶液", cacl2: "过量 CaCl₂ 溶液", lime: "澄清石灰水" });
  });

  // 独立写的参照规则（照 SPEC 6.1 的四条，按「试管里有哪些东西」逐步推）：与模型逐步比对
  function refStep(t, r) {
    var n = {}; Object.keys(t).forEach(function (k) { n[k] = t[k]; });
    var ev = { bubbles: false, precipitate: false };
    if (r === "acid") {
      // 足量稀盐酸：有 Na₂CO₃（或之前生成的 CaCO₃）时产生气泡；之后溶液呈酸性
      ev.bubbles = !!(t.Na2CO3 || t.CaCO3);
      n.NaOH = n.Na2CO3 = n.CaCO3 = n.CaOH2 = false; n.acid = true;
    } else if (r === "cacl2") {
      // 过量 CaCl₂：Na₂CO₃ → CaCO₃ 白色沉淀（同时生成 NaCl）；NaOH 不反应；CaCl₂、NaCl 溶液中性
      if (t.Na2CO3 && !t.acid) { ev.precipitate = true; n.Na2CO3 = false; n.CaCO3 = true; }
    } else if (r === "lime") {
      // 澄清石灰水：Na₂CO₃ → CaCO₃ 白色沉淀，同时生成 NaOH；NaOH 不反应；（酸过量时被中和，没有沉淀）
      if (!t.acid) {
        if (t.Na2CO3) { ev.precipitate = true; n.Na2CO3 = false; n.CaCO3 = true; n.NaOH = true; }
        n.CaOH2 = true;
      }
    } else if (r === "phenol") {
      n.ind = true;
    }
    // 酚酞：溶液里有 NaOH、Na₂CO₃ 或 Ca(OH)₂，并且没有过量的酸时变红，否则无色
    ev.red = !!(n.ind && !n.acid && (n.NaOH || n.Na2CO3 || n.CaOH2));
    ev.ind = !!n.ind;
    return { t: n, ev: ev };
  }
  function refRun(sample, seq) {
    var s = C.SAMPLES[sample], t = { NaOH: !!s.NaOH, Na2CO3: !!s.Na2CO3, CaCO3: false, CaOH2: false, acid: false, ind: false }, out = [];
    seq.forEach(function (r) { var x = refStep(t, r); t = x.t; out.push(x.ev); });
    return out;
  }
  function allSeqs(maxLen) {
    var out = [[]], layer = [[]];
    for (var n = 1; n <= maxLen; n++) {
      var next = [];
      layer.forEach(function (s) { REAG.forEach(function (r) { next.push(s.concat([r])); }); });
      out = out.concat(next); layer = next;
    }
    return out;
  }

  it("每种「样品 × 试剂顺序」（0～3 步，共 3 × 85 种）的气泡、沉淀、颜色和现象文字都与参照规则一致", function () {
    var seqs = allSeqs(3);
    assert.equal(seqs.length, 85);
    SAMPLES.forEach(function (sample) {
      seqs.forEach(function (seq) {
        var got = C.runSequence(sample, seq), exp = refRun(sample, seq), tag = sample + " " + seq.join("→");
        assert.equal(got.steps.length, seq.length);
        assert.equal(got.tube.steps.length, seq.length, tag + " 试管记下每一步");
        seq.forEach(function (r, i) {
          var g = got.steps[i], e = exp[i];
          assert.deepEqual([g.bubbles, g.precipitate, g.red], [e.bubbles, e.precipitate, e.red], tag + " 第 " + (i + 1) + " 步");
          var parts = [];
          if (e.bubbles) parts.push("产生气泡");
          if (e.precipitate) parts.push("产生白色沉淀");
          if (e.ind) parts.push(e.red ? "溶液变红" : "溶液无色");
          assert.equal(g.text, parts.length ? parts.join("，") : "无明显现象", tag + " 现象文字");
          assert.equal(g.red, C.isRed(g.tube), tag + " isRed");
          assert.equal(got.tube.steps[i].reagent, r);
        });
      });
    });
  });

  it("足量稀盐酸：有 Na₂CO₃ 才冒气泡；之前生成的 CaCO₃ 也冒气泡；之后溶液呈酸性（酚酞无色）", function () {
    assert.deepEqual(SAMPLES.map(function (s) { return C.runSequence(s, ["acid"]).steps[0].bubbles; }), [false, true, true]);
    ["cacl2", "lime"].forEach(function (r) {
      assert.deepEqual(SAMPLES.map(function (s) { return C.runSequence(s, [r, "acid"]).steps[1].bubbles; }), [false, true, true], r + " 之后加酸");
    });
    SAMPLES.forEach(function (s) {
      var r = C.runSequence(s, ["acid", "phenol"]);
      assert.equal(r.tube.acid, true);
      assert.equal(r.steps[1].red, false, s + " 加过足量酸后酚酞无色");
      assert.equal(C.runSequence(s, ["phenol", "acid"]).steps[1].red, false, s + " 先变红，加足量酸后褪色");
      assert.equal(C.runSequence(s, ["acid", "acid"]).steps[1].bubbles, false, s + " 第二次加酸不再冒气泡");
    });
  });

  it("酚酞：直接滴，三种样品都变红（Na₂CO₃ 溶液也显碱性）", function () {
    SAMPLES.forEach(function (s) { assert.equal(C.runSequence(s, ["phenol"]).steps[0].red, true, s); });
    assert.equal(C.runSequence("full", ["phenol"]).tube.NaOH, false, "完全变质的样品里没有 NaOH 也变红");
  });

  it("过量 CaCl₂：只和 Na₂CO₃ 生成白色沉淀（NaOH 不反应）；酸过量时不沉淀", function () {
    assert.deepEqual(SAMPLES.map(function (s) { return C.runSequence(s, ["cacl2"]).steps[0].precipitate; }), [false, true, true]);
    SAMPLES.forEach(function (s) {
      var t = C.runSequence(s, ["cacl2"]).tube;
      assert.equal(t.NaOH, !!C.SAMPLES[s].NaOH, s + " NaOH 不反应");
      assert.equal(t.Na2CO3, false); assert.equal(t.CaCO3, !!C.SAMPLES[s].Na2CO3); assert.equal(t.CaCl2, true);
      assert.equal(C.runSequence(s, ["acid", "cacl2"]).steps[1].precipitate, false, s + " 酸过量时不沉淀");
    });
  });

  it("「过量 CaCl₂ → 酚酞」能区分三种样品：无沉淀变红 / 有沉淀变红 / 有沉淀无色", function () {
    var got = SAMPLES.map(function (s) {
      var r = C.runSequence(s, ["cacl2", "phenol"]);
      return [r.steps[0].precipitate, r.steps[1].red, r.steps[0].text, r.steps[1].text];
    });
    assert.deepEqual(got, [
      [false, true, "无明显现象", "溶液变红"],
      [true, true, "产生白色沉淀", "溶液变红"],
      [true, false, "产生白色沉淀", "溶液无色"]
    ]);
    // 三种结果互不相同
    var keys = got.map(function (g) { return g[0] + "/" + g[1]; });
    assert.equal(keys.filter(function (k, i) { return keys.indexOf(k) === i; }).length, 3);
    // 先滴酚酞再加过量 CaCl₂：完全变质的样品红色褪去
    assert.deepEqual(SAMPLES.map(function (s) { return C.runSequence(s, ["phenol", "cacl2"]).steps[1].red; }), [true, true, false]);
  });

  it("澄清石灰水：和 Na₂CO₃ 生成白色沉淀，同时生成 NaOH；「石灰水 → 酚酞」任何样品都变红", function () {
    assert.deepEqual(SAMPLES.map(function (s) { return C.runSequence(s, ["lime"]).steps[0].precipitate; }), [false, true, true]);
    var full = C.runSequence("full", ["lime"]).tube;
    assert.equal(full.NaOH, true, "生成 NaOH");
    assert.equal(full.CaCO3, true); assert.equal(full.CaOH2, true); assert.equal(full.Na2CO3, false);
    SAMPLES.forEach(function (s) {
      assert.equal(C.runSequence(s, ["lime", "phenol"]).steps[1].red, true, s + " 石灰水 → 酚酞变红");
      assert.equal(C.runSequence(s, ["lime", "phenol"]).steps[0].text, C.SAMPLES[s].Na2CO3 ? "产生白色沉淀" : "无明显现象");
      assert.equal(C.runSequence(s, ["acid", "lime"]).steps[1].precipitate, false, s + " 酸过量时石灰水被中和");
      assert.equal(C.runSequence(s, ["acid", "lime", "phenol"]).steps[2].red, false, s + " 酸过量，仍无色");
    });
    assert.equal(C.runSequence("none", ["lime"]).tube.NaOH, true, "NaOH 不反应，仍在");
  });

  it("addReagent 不改原来的试管；不认识的试剂返回 null，runSequence 跳过它", function () {
    var t = C.newTube("partial"), before = JSON.stringify(t);
    var r = C.addReagent(t, "cacl2");
    assert.equal(JSON.stringify(t), before, "原试管不变");
    assert.notEqual(r.tube, t);
    assert.equal(r.tube.steps.length, 1); assert.equal(t.steps.length, 0);
    assert.equal(C.addReagent(t, "water"), null);
    assert.deepEqual(C.runSequence("full", ["water", "acid"]).steps.length, 1);
    assert.deepEqual(C.newTube("x"), { sample: "x", NaOH: false, Na2CO3: false, CaCO3: false, CaOH2: false, CaCl2: false, NaCl: false, acid: false, indicator: false, steps: [] });
    assert.equal(C.isRed(C.newTube("none")), false, "没滴酚酞时不算红");
  });
});

/* ==================== 混合溶液滴盐酸 ==================== */
describe("NaOH 和 Na₂CO₃ 混合溶液滴盐酸放出的气体（mixGas）", function () {
  it("盐酸先和 NaOH 反应：不超过 NaOH 的份数时没有气体；之后每 2 份盐酸放出 1 份 CO₂；Na₂CO₃ 反应完就不再增加", function () {
    [0, 0.5, 1, 2].forEach(function (a) { assert.equal(C.mixGas(a, 2, 2), 0, "盐酸 " + a); });
    assert.equal(C.mixGas(3, 2, 2), 0.5);
    assert.equal(C.mixGas(4, 2, 2), 1);
    assert.equal(C.mixGas(6, 2, 2), 2);
    assert.equal(C.mixGas(8, 2, 2), 2);
    assert.equal(C.mixGas(1, 0, 2), 0.5, "没有 NaOH 时一开始就放气");
    assert.equal(C.mixGas(5, 5, 0), 0, "没有 Na₂CO₃ 时一直没有气体");
    assert.equal(C.mixGas(-1, 2, 2), 0); assert.equal(C.mixGas(4, -2, 2), 2, "负数按 0（NaOH 当 0 份）");
  });
  it("mixGasCurve：等分 n 段；单调不减；终点 = 全部 Na₂CO₃ 放出的 CO₂", function () {
    var p = C.mixGasCurve(2, 2, 8, 8);
    assert.deepEqual(p, [[0, 0], [1, 0], [2, 0], [3, 0.5], [4, 1], [5, 1.5], [6, 2], [7, 2], [8, 2]]);
    var q = C.mixGasCurve(1, 3, 10);
    assert.equal(q.length, 41);
    for (var i = 1; i < q.length; i++) assert.ok(q[i][1] >= q[i - 1][1]);
    assert.equal(q[q.length - 1][1], 3);
    assert.equal(C.mixGasCurve(0, 4, 8, 1).length, 3, "至少 2 段");
  });
});

/* ======================================================================
 * 变质探究的核对：「证据够了才算对」（用户决定）。把一份样品做过的每支试管按同样的试剂顺序
 * 套到三种情况上，只留下现象完全一致的；只剩一种且和选的相同才算 ✓
 * ====================================================================== */
describe("变质探究：由现象推断样品（consistentSamples / judgeSample）", function () {
  // 真实样品 smp 按试剂顺序 rs 做一支试管，记下每一步看到的现象（页面上 tube.steps 就是这个形状）
  function tube(smp, rs) {
    var t = C.newTube(smp);
    rs.forEach(function (r) { t = C.addReagent(t, r).tube; });
    return { steps: t.steps };
  }
  var ALL = ["none", "partial", "full"];

  it("一支试管都没做：三种情况都留下；核对时不说对错", function () {
    assert.deepEqual(C.consistentSamples([]), ALL);
    ALL.forEach(function (ch) {
      var j = C.judgeSample([], ch);
      assert.equal(j.status, "ambiguous");
      assert.ok(j.text.indexOf("「未变质」「部分变质」和「完全变质」") !== -1, j.text);
    });
    // 只取样、没加试剂的试管也一样
    assert.deepEqual(C.consistentSamples([{ steps: [] }]), ALL);
  });

  it("只滴酚酞：三种都变红，三种情况都留下", function () {
    ALL.forEach(function (smp) { assert.deepEqual(C.consistentSamples([tube(smp, ["phenol"])]), ALL, smp); });
  });

  it("足量稀盐酸：有气泡 → 留下部分变质、完全变质；没有气泡 → 只剩未变质", function () {
    assert.deepEqual(C.consistentSamples([tube("partial", ["acid"])]), ["partial", "full"]);
    assert.deepEqual(C.consistentSamples([tube("full", ["acid"])]), ["partial", "full"]);
    assert.deepEqual(C.consistentSamples([tube("none", ["acid"])]), ["none"]);
    assert.equal(C.judgeSample([tube("none", ["acid"])], "none").status, "correct");
    var j = C.judgeSample([tube("full", ["acid"])], "full");
    assert.equal(j.status, "ambiguous");
    assert.equal(j.text, "现在的现象还分不出「部分变质」和「完全变质」，再设计一步实验");
    // 选了已经被现象排除的那种
    assert.deepEqual(C.judgeSample([tube("full", ["acid"])], "none"), { status: "contradicted", remaining: ["partial", "full"], text: "和你看到的现象对不上" });
  });

  it("过量 CaCl₂ 后滴酚酞：三种样品各自唯一确定", function () {
    ALL.forEach(function (smp) {
      var tb = [tube(smp, ["cacl2", "phenol"])];
      assert.deepEqual(C.consistentSamples(tb), [smp], smp);
      assert.equal(C.judgeSample(tb, smp).status, "correct");
      ALL.filter(function (x) { return x !== smp; }).forEach(function (wrong) {
        assert.equal(C.judgeSample(tb, wrong).status, "contradicted", smp + " 选成 " + wrong);
      });
    });
  });

  it("澄清石灰水后滴酚酞：都变红，分不出部分变质和完全变质（未变质因为没有沉淀能分出来）", function () {
    assert.deepEqual(C.consistentSamples([tube("partial", ["lime", "phenol"])]), ["partial", "full"]);
    assert.deepEqual(C.consistentSamples([tube("full", ["lime", "phenol"])]), ["partial", "full"]);
    assert.deepEqual(C.consistentSamples([tube("none", ["lime", "phenol"])]), ["none"]);
  });

  it("几支试管合起来看：先加盐酸（有气泡），再做一支「过量 CaCl₂ → 酚酞」，就能确定", function () {
    var tb = [tube("partial", ["acid"]), tube("partial", ["cacl2", "phenol"])];
    assert.deepEqual(C.consistentSamples(tb), ["partial"]);
    assert.equal(C.judgeSample(tb, "partial").status, "correct");
    // 现象记录被改过（和任何一种情况都对不上）：一种都不剩，怎么选都是对不上
    var forged = [{ steps: [{ reagent: "acid", bubbles: true, precipitate: true, red: false }] }];
    assert.deepEqual(C.consistentSamples(forged), []);
    assert.equal(C.judgeSample(forged, "full").status, "contradicted");
  });
});
