/* ABS-LAB 化学模型：溶解度曲线（chemistry/solubility.html）、反应后溶质成分（chemistry/solute.html）
 *
 * 浏览器里是 window.ABSLabChem，node 里 require 得到同一个对象：
 *   - 两个实验页用它算溶解度、状态、析出量、质量分数、pH、示意粒子数、取样结果、变质探究的现象；
 *   - tests/batch1b-content.test.js 用它重新算出题库里的数值和缩略图，tests/chem-models.test.js 测边界情况。
 * 初中写法：界面上只出现「稀盐酸」「NaOH 溶液」和体积（mL），离子数量只给「示意粒子数」。
 * 下面的浓度（mol/L）、pH 的算法只在代码里用，界面上不出现（「物质的量」「电离」「水解」是高中内容）。
 * 语法不超过 ES2019（不用 ?. 和 ??），与 shared/*.js 一样用 var + function。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ABSLabChem = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  function num(v, d) { v = +v; return isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function round(v, n) {
    var k = Math.pow(10, n == null ? 4 : n);
    var r = Math.round(v * k) / k;
    return r === 0 ? 0 : r;
  }

  /* ==================== 溶解度 ==================== */
  // 人教版课本的溶解度表（g / 100 g 水），0～100℃ 每 10℃ 一个值
  var TEMPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  var TABLE = {
    KNO3: [13.3, 20.9, 31.6, 45.8, 63.9, 85.5, 110, 138, 169, 202, 246],
    NaCl: [35.7, 35.8, 36.0, 36.3, 36.6, 37.0, 37.3, 37.8, 38.4, 39.0, 39.8]
  };
  var NAME = { KNO3: "KNO₃", NaCl: "NaCl" };

  // 单调三次插值（Fritsch–Carlson）：过每个表值，在表值之间不超调（两种物质的溶解度都随温度单调增大，曲线也单调）
  var SLOPES = {};
  function slopes(sub) {
    if (SLOPES[sub]) return SLOPES[sub];
    var x = TEMPS, y = TABLE[sub], n = x.length, d = [], m = [];
    for (var i = 0; i < n - 1; i++) d.push((y[i + 1] - y[i]) / (x[i + 1] - x[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (var j = 1; j < n - 1; j++) m[j] = d[j - 1] * d[j] > 0 ? (d[j - 1] + d[j]) / 2 : 0;
    for (var k = 0; k < n - 1; k++) {
      if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
      var a = m[k] / d[k], b = m[k + 1] / d[k], s = a * a + b * b;
      if (s > 9) { var t = 3 / Math.sqrt(s); m[k] = t * a * d[k]; m[k + 1] = t * b * d[k]; }
    }
    SLOPES[sub] = m;
    return m;
  }
  // 温度 T（℃，夹在 0～100）时的溶解度（g / 100 g 水）
  function solubility(sub, T) {
    var y = TABLE[sub];
    if (!y) return null;
    T = clamp(num(T, 20), TEMPS[0], TEMPS[TEMPS.length - 1]);
    var i = Math.min(TEMPS.length - 2, Math.floor(T / 10));
    var x0 = TEMPS[i], hh = TEMPS[i + 1] - x0, t = (T - x0) / hh, m = slopes(sub);
    if (t === 0) return y[i];
    var t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * hh * m[i] + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * hh * m[i + 1];
  }
  // 表值之间的直线插值（只用来对照「约 47℃」这种口算结果）
  function solubilityLinear(sub, T) {
    var y = TABLE[sub];
    T = clamp(num(T, 20), 0, 100);
    var i = Math.min(TEMPS.length - 2, Math.floor(T / 10)), t = (T - TEMPS[i]) / 10;
    return y[i] + (y[i + 1] - y[i]) * t;
  }
  // 溶解度等于 S 时的温度（二分法；曲线单调增大）。S 超出 0～100℃ 的范围时返回 null
  function tempForSolubility(sub, S, linear) {
    var f = linear ? solubilityLinear : solubility;
    S = num(S, 0);
    if (S < f(sub, 0) || S > f(sub, 100)) return null;
    var lo = 0, hi = 100;
    for (var i = 0; i < 100; i++) { var mid = (lo + hi) / 2; if (f(sub, mid) < S) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  // KNO₃ 和 NaCl 两条曲线的交点（在 20～30℃ 之间）
  function crossing(linear) {
    var f = linear ? solubilityLinear : solubility, lo = 20, hi = 30;
    for (var i = 0; i < 100; i++) { var mid = (lo + hi) / 2; if (f("KNO3", mid) < f("NaCl", mid)) lo = mid; else hi = mid; }
    var T = (lo + hi) / 2;
    return { T: T, S: f("KNO3", T) };
  }

  // 状态：温度 T、水的质量 W（g）、加入的溶质总量 m（g）
  //   per100 = m × 100 / W（每 100 g 水对应的量，状态点的纵坐标）；S = 溶解度
  //   status：per100 < S 不饱和（"unsat"）；= S 恰好饱和（"sat"）；> S 饱和并有晶体析出（"crystal"）。
  //   eps 是判「恰好」的容差（g / 100 g 水，缺省 1e-6；页面上的吸附另算）
  //   precipitate = (per100 − S) × W / 100（不饱和时 0）；dissolved = m − precipitate；
  //   fraction = dissolved ÷ (W + dissolved) × 100（溶质质量分数，%）
  function state(sub, T, W, m, eps) {
    W = Math.max(0, num(W, 100)); m = Math.max(0, num(m, 0)); eps = eps == null ? 1e-6 : eps;
    var S = solubility(sub, T), per100 = W > 0 ? m * 100 / W : Infinity;
    var status = per100 < S - eps ? "unsat" : per100 <= S + eps ? "sat" : "crystal";
    // 没有水时（W = 0）溶质全部是固体
    var precipitate = W === 0 ? m : status === "crystal" ? (per100 - S) * W / 100 : 0;
    var dissolved = m - precipitate;
    return {
      sub: sub, T: num(T, 20), W: W, m: m, S: S, per100: per100, status: status,
      precipitate: precipitate, dissolved: dissolved,
      solutionPer100: Math.min(per100, S),   // 溶液的实际组成（曲线上方的状态点对应曲线上同一温度的实心点）
      fraction: W + dissolved > 0 ? dissolved / (W + dissolved) * 100 : 0
    };
  }
  // 饱和溶液的溶质质量分数（%）：S ÷ (100 + S) × 100
  function saturatedFraction(sub, T) { var S = solubility(sub, T); return S / (100 + S) * 100; }
  // 降温轨迹：从 T0 降到 T1，溶液的实际组成点 [T, min(per100, S(T))]（先水平，碰到曲线后沿曲线下滑）
  function coolPath(sub, m, W, T0, T1, n) {
    n = Math.max(2, Math.round(num(n, 40)));
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var T = T0 + (T1 - T0) * i / n, s = state(sub, T, W, m);
      pts.push([round(T, 4), round(s.solutionPer100, 4)]);
    }
    return pts;
  }
  // 曲线上的点（画图用）
  function curvePoints(sub, T0, T1, n) {
    n = Math.max(2, Math.round(num(n, 50)));
    var pts = [];
    for (var i = 0; i <= n; i++) { var T = T0 + (T1 - T0) * i / n; pts.push([round(T, 4), round(solubility(sub, T), 4)]); }
    return pts;
  }

  /* ==================== 四对试剂：pH、示意粒子数、取样 ==================== */
  // 锥形瓶里都是 20 mL，滴入体积 V（0～40 mL），每对都在 V = 20 mL 时恰好完全反应。
  // 内部浓度（只在代码里用）：HCl、NaOH 0.10 mol/L；Ba(OH)₂、H₂SO₄ 0.050 mol/L；Na₂CO₃ 0.050 mol/L。
  // 1 个示意粒子代表 0.1 mmol：粒子数 = mmol × 10。
  var VOL0 = 20, VMAX = 40, VEQ = 20, PER = 10;
  var PAIRS = {
    1: { id: 1, flask: "稀盐酸", titrant: "NaOH 溶液", products: ["NaCl", "H₂O"], ions: ["H⁺", "Cl⁻", "Na⁺", "OH⁻"] },
    2: { id: 2, flask: "NaOH 溶液", titrant: "稀盐酸", products: ["NaCl", "H₂O"], ions: ["Na⁺", "OH⁻", "H⁺", "Cl⁻"] },
    3: { id: 3, flask: "Ba(OH)₂ 溶液", titrant: "稀硫酸", products: ["BaSO₄↓", "H₂O"], ions: ["Ba²⁺", "OH⁻", "H⁺", "SO₄²⁻"] },
    4: { id: 4, flask: "稀盐酸", titrant: "Na₂CO₃ 溶液", products: ["NaCl", "H₂O", "CO₂↑"], ions: ["H⁺", "Cl⁻", "Na⁺", "CO₃²⁻"] }
  };
  // 水的离子积按 25℃ 取 1e-14；④ 过量 Na₂CO₃ 的溶液按 [OH⁻] = √(2.1×10⁻⁴ × c) 估算，pH 不低于 7
  var KB_CARB = 2.1e-4;
  function phFromH(cH) { return -Math.log(cH) / Math.LN10; }
  function phFromOH(cOH) { return 14 + Math.log(cOH) / Math.LN10; }

  // 某对试剂滴入 V mL 时的溶液：pH、各离子的示意粒子数、已生成的沉淀 / 已放出的气体（示意粒子数）、溶质、所处阶段。
  // eps：判「恰好完全反应」的容差（mL，缺省 1e-9；页面上取样点在 20 mL 附近吸附另算）
  function pairState(id, V, eps) {
    var P = PAIRS[id];
    if (!P) return null;
    V = clamp(num(V, 0), 0, VMAX); eps = eps == null ? 1e-9 : eps;
    var stage = V < VEQ - eps ? "before" : V <= VEQ + eps ? "equiv" : "after";
    // 在容差内判为恰好完全反应时，按正好 20 mL 算，粒子数才守恒（不会出现加了 19.8 mL、Na⁺ 却和 Cl⁻ 一样多）
    if (stage === "equiv") V = VEQ;
    var tot = VOL0 + V;                          // 溶液总体积（mL）
    var ions = {}, precip = {}, gas = {}, pH, solutes;
    var mm = function (mmol) { return round(mmol * PER, 6); };
    if (id === 1 || id === 2) {
      // 强酸、强碱完全反应：剩下哪一种就按它的 H⁺ 或 OH⁻ 算 pH
      var acid = id === 1 ? 0.1 * VOL0 : 0.1 * V, base = id === 1 ? 0.1 * V : 0.1 * VOL0; // mmol
      var hLeft = Math.max(0, acid - base), ohLeft = Math.max(0, base - acid);
      if (stage === "equiv") { hLeft = 0; ohLeft = 0; }
      ions["H⁺"] = mm(hLeft); ions["OH⁻"] = mm(ohLeft); ions["Na⁺"] = mm(base); ions["Cl⁻"] = mm(acid);
      pH = stage === "equiv" ? 7 : hLeft > 0 ? phFromH(hLeft / tot) : phFromOH(ohLeft / tot);
      if (id === 1) solutes = V === 0 ? ["HCl"] : stage === "before" ? ["NaCl", "HCl"] : stage === "equiv" ? ["NaCl"] : ["NaCl", "NaOH"];
      else solutes = V === 0 ? ["NaOH"] : stage === "before" ? ["NaCl", "NaOH"] : stage === "equiv" ? ["NaCl"] : ["NaCl", "HCl"];
    } else if (id === 3) {
      // Ba(OH)₂ 0.050 mol/L：Ba²⁺ 0.05、OH⁻ 0.10；H₂SO₄ 0.050 mol/L：H⁺ 0.10、SO₄²⁻ 0.05（mmol/mL）
      var ba = 0.05 * VOL0, oh = 0.1 * VOL0, h = 0.1 * V, so4 = 0.05 * V;
      var baso4 = Math.min(ba, so4), water = Math.min(h, oh);
      var ba3 = ba - baso4, so3 = so4 - baso4, oh3 = oh - water, h3 = h - water;
      if (stage === "equiv") { ba3 = 0; so3 = 0; oh3 = 0; h3 = 0; baso4 = ba; }
      ions["Ba²⁺"] = mm(ba3); ions["OH⁻"] = mm(oh3); ions["H⁺"] = mm(h3); ions["SO₄²⁻"] = mm(so3);
      precip["BaSO₄"] = mm(baso4);
      pH = stage === "equiv" ? 7 : h3 > 0 ? phFromH(h3 / tot) : phFromOH(oh3 / tot);
      solutes = stage === "before" ? ["Ba(OH)₂"] : stage === "equiv" ? [] : ["H₂SO₄"];
    } else {
      // 2HCl + Na₂CO₃ = 2NaCl + H₂O + CO₂↑。假设生成的 CO₂ 全部逸出（不留在溶液里，不影响 pH）
      var hcl = 0.1 * VOL0, co3 = 0.05 * V, na = 0.1 * V;
      var used = Math.min(co3, hcl / 2);           // 反应掉的 CO₃²⁻（mmol）
      var h4 = hcl - 2 * used, c4 = co3 - used;
      if (stage === "equiv") { h4 = 0; c4 = 0; used = hcl / 2; }
      ions["H⁺"] = mm(h4); ions["Cl⁻"] = mm(hcl); ions["Na⁺"] = mm(na); ions["CO₃²⁻"] = mm(c4);
      gas["CO₂"] = mm(used);
      if (stage === "equiv") pH = 7;
      else if (h4 > 0) pH = phFromH(h4 / tot);
      else pH = Math.max(7, phFromOH(Math.sqrt(KB_CARB * (c4 / tot))));
      solutes = V === 0 ? ["HCl"] : stage === "before" ? ["NaCl", "HCl"] : stage === "equiv" ? ["NaCl"] : ["NaCl", "Na₂CO₃"];
    }
    return { id: id, V: V, stage: stage, pH: pH, ions: ions, precipitate: precip, gas: gas, solutes: solutes, pair: P };
  }
  // pH 曲线上的点（V 从 0 到 vTo，每 step mL 一个点；恰好完全反应那一点单独加上，曲线才会经过 (20, 7)）
  function phCurve(id, vTo, step) {
    vTo = clamp(num(vTo, VMAX), 0, VMAX); step = num(step, 0.5);
    var pts = [];
    for (var v = 0; v <= vTo + 1e-9; v += step) pts.push([round(v, 4), round(pairState(id, v).pH, 4)]);
    if (vTo >= VEQ && !pts.some(function (p) { return p[0] === VEQ; })) {
      pts.push([VEQ, 7]);
      pts.sort(function (a, b) { return a[0] - b[0]; });
    }
    return pts;
  }

  /* ==================== NaOH 变质探究 ==================== */
  // 三种样品：none 未变质（NaOH）、partial 部分变质（NaOH 和 Na₂CO₃）、full 完全变质（Na₂CO₃）。
  // 试管里的东西只记「有没有」（初中定性判断）：
  //   acid 足量稀盐酸：总是过量，加进去以后试管一直呈酸性（之后再加 CaCl₂、石灰水也不足以把它中和掉）；
  //        有 Na₂CO₃ 或 CaCO₃ 时冒气泡；NaOH、Na₂CO₃、CaCO₃、Ca(OH)₂ 都被反应掉，生成 NaCl、CaCl₂
  //   phenol 酚酞：有 NaOH、Na₂CO₃ 或 Ca(OH)₂，并且没有过量的酸时变红，否则无色（之后每一步都按当时的溶液重新判断颜色）
  //   cacl2 过量 CaCl₂ 溶液：Na₂CO₃ → CaCO₃ 白色沉淀（同时生成 NaCl）；NaOH 不反应；CaCl₂、NaCl 的溶液呈中性
  //   lime 澄清石灰水 Ca(OH)₂（过量）：Na₂CO₃ → CaCO₃ 白色沉淀，同时生成 NaOH；NaOH 不反应；剩余的 Ca(OH)₂ 使溶液呈碱性
  //        （试管里已经有过量的酸时，石灰水被中和，没有沉淀）
  var SAMPLES = { none: { NaOH: true }, partial: { NaOH: true, Na2CO3: true }, full: { Na2CO3: true } };
  var SAMPLE_NAME = { none: "未变质", partial: "部分变质", full: "完全变质" };
  var REAGENTS = {
    acid: "足量稀盐酸", phenol: "酚酞溶液", cacl2: "过量 CaCl₂ 溶液", lime: "澄清石灰水"
  };
  function newTube(sample) {
    var s = SAMPLES[sample] || {};
    return { sample: sample, NaOH: !!s.NaOH, Na2CO3: !!s.Na2CO3, CaCO3: false, CaOH2: false, CaCl2: false, NaCl: false,
      acid: false, indicator: false, steps: [] };
  }
  function copy(t) { var o = {}; Object.keys(t).forEach(function (k) { o[k] = Array.isArray(t[k]) ? t[k].slice() : t[k]; }); return o; }
  function isRed(t) { return t.indicator && !t.acid && (t.NaOH || t.Na2CO3 || t.CaOH2); }
  // 加入一种试剂：返回新的试管（不改原来的）和这一步的现象 { bubbles, precipitate, red, text }
  function addReagent(tube, reagent) {
    var t = copy(tube), bubbles = false, precipitate = false;
    if (reagent === "acid") {
      if (t.Na2CO3 || t.CaCO3) bubbles = true;
      if (t.NaOH || t.Na2CO3) t.NaCl = true;
      if (t.CaCO3 || t.CaOH2) t.CaCl2 = true;
      t.NaOH = false; t.Na2CO3 = false; t.CaCO3 = false; t.CaOH2 = false; t.acid = true;
    } else if (reagent === "phenol") {
      t.indicator = true;
    } else if (reagent === "cacl2") {
      if (!t.acid && t.Na2CO3) { t.Na2CO3 = false; t.CaCO3 = true; t.NaCl = true; precipitate = true; }
      t.CaCl2 = true;
    } else if (reagent === "lime") {
      if (t.acid) { t.CaCl2 = true; }
      else {
        if (t.Na2CO3) { t.Na2CO3 = false; t.CaCO3 = true; t.NaOH = true; precipitate = true; }
        t.CaOH2 = true;
      }
    } else {
      return null;
    }
    var red = isRed(t), parts = [];
    if (bubbles) parts.push("产生气泡");
    if (precipitate) parts.push("产生白色沉淀");
    if (t.indicator) parts.push(red ? "溶液变红" : "溶液无色");
    var text = parts.length ? parts.join("，") : "无明显现象";
    t.steps.push({ reagent: reagent, bubbles: bubbles, precipitate: precipitate, red: red, text: text });
    return { tube: t, bubbles: bubbles, precipitate: precipitate, red: red, text: text };
  }
  // 由看到的现象推断样品（「证据够了才算对」）：把这份样品做过的每支试管（试剂顺序 + 每一步看到的现象），
  // 按同样的试剂顺序分别套到三种情况上，只留下每一步现象（气泡、白色沉淀、变红）都完全一致的情况。
  // tubes: [{ steps: [{ reagent, bubbles, precipitate, red }] }]（页面上 addReagent 记下的 tube.steps 就是这个形状）。
  // 一支试管都没做（或只取样没加试剂）时三种情况都留下
  var SAMPLE_ORDER = ["none", "partial", "full"];
  function consistentSamples(tubes) {
    return SAMPLE_ORDER.filter(function (smp) {
      return (tubes || []).every(function (tb) {
        var steps = (tb && tb.steps) || [];
        var sim = runSequence(smp, steps.map(function (x) { return x.reagent; })).steps;
        if (sim.length !== steps.length) return false;
        for (var i = 0; i < sim.length; i++) {
          var o = steps[i], r = sim[i];
          if (r.bubbles !== !!o.bubbles || r.precipitate !== !!o.precipitate || r.red !== !!o.red) return false;
        }
        return true;
      });
    });
  }
  // 「A」和「B」、「A」「B」和「C」
  function quoteList(list) {
    var q = list.map(function (k) { return "「" + SAMPLE_NAME[k] + "」"; });
    return q.length > 1 ? q.slice(0, -1).join("") + "和" + q[q.length - 1] : q.join("");
  }
  // 核对一份样品：只根据学生自己看到的现象给反馈，不会泄露答案
  //   correct：现象只剩一种可能，并且就是学生选的；
  //   contradicted：学生选的那种已经被现象排除；
  //   ambiguous：学生选的那种还在，但现象还分不出两三种情况（包括一支试管都没做）
  function judgeSample(tubes, choice) {
    var left = consistentSamples(tubes);
    if (left.indexOf(choice) === -1) return { status: "contradicted", remaining: left, text: "和你看到的现象对不上" };
    if (left.length === 1) return { status: "correct", remaining: left, text: "✓ 现象只能是「" + SAMPLE_NAME[choice] + "」" };
    return { status: "ambiguous", remaining: left, text: "现在的现象还分不出" + quoteList(left) + "，再设计一步实验" };
  }
  // NaOH 和 Na₂CO₃ 的混合溶液里逐滴加入稀盐酸：盐酸先和 NaOH 反应（NaOH + HCl = NaCl + H₂O），
  // NaOH 反应完才和 Na₂CO₃ 反应放出 CO₂（Na₂CO₃ + 2HCl = 2NaCl + H₂O + CO₂↑，初中按一步写）。
  // acid、naoh、co3 用同一种「份数」（不出现单位）；返回已放出的 CO₂ 份数
  function mixGas(acid, naoh, co3) {
    acid = Math.max(0, num(acid, 0)); naoh = Math.max(0, num(naoh, 0)); co3 = Math.max(0, num(co3, 0));
    return Math.min(co3, Math.max(0, acid - naoh) / 2);
  }
  // 画图用：加入盐酸从 0 到 acidMax，等分 n 段
  function mixGasCurve(naoh, co3, acidMax, n) {
    n = Math.max(2, Math.round(num(n, 40)));
    var pts = [];
    for (var i = 0; i <= n; i++) { var a = acidMax * i / n; pts.push([round(a, 4), round(mixGas(a, naoh, co3), 4)]); }
    return pts;
  }
  // 按顺序加一串试剂，返回每一步的现象（测试和页面都用）
  function runSequence(sample, reagents) {
    var t = newTube(sample), out = [];
    (reagents || []).forEach(function (r) { var res = addReagent(t, r); if (res) { t = res.tube; out.push(res); } });
    return { tube: t, steps: out };
  }

  return {
    round: round,
    TEMPS: TEMPS, TABLE: TABLE, NAME: NAME,
    solubility: solubility, solubilityLinear: solubilityLinear, tempForSolubility: tempForSolubility, crossing: crossing,
    state: state, saturatedFraction: saturatedFraction, coolPath: coolPath, curvePoints: curvePoints,
    VOL0: VOL0, VMAX: VMAX, VEQ: VEQ, PAIRS: PAIRS,
    pairState: pairState, phCurve: phCurve,
    SAMPLES: SAMPLES, SAMPLE_NAME: SAMPLE_NAME, REAGENTS: REAGENTS,
    newTube: newTube, addReagent: addReagent, isRed: isRed, runSequence: runSequence,
    mixGas: mixGas, mixGasCurve: mixGasCurve,
    consistentSamples: consistentSamples, judgeSample: judgeSample
  };
});
