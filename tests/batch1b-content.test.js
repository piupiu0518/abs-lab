/* 第 1 批 B 三个题库的内容核对（SPEC 3.3）：node --test tests/
 *   shared/quiz/items/math-m2.json（M2 二次函数）、chemistry-cb.json（C-B 溶解度曲线）、chemistry-cc.json（C-C 反应后溶质成分）
 *
 * 四件事：
 *   1. 结构：每道题的 id、模块、题型、知识点、情境、重测 / 部件 / 解释的规则，选项和理由的 id **按顺序**（SPEC 列出的顺序
 *      就是显示顺序，id 依次取 a、b、c、d / r1、r2、r3）、正确选项、每个选项上的错误概念标签（含没有标签的）——
 *      题目表照抄 SPEC 第 4.5、5.3、6.5 节（下面的 SPEC 常量）；再用 core.classify 走一遍判定。
 *   2. 数值：题干、选项、参考解释里出现的每个数，都用模型函数（math/js/quadratic-model.js、chemistry/js/chem-models.js）
 *      重新算出来再比对；correct 指向的选项必须就是算出来的那个；理由里不写出这道题的结果（理由只写方法）。
 *   3. 图：题图和选项缩略图里代表模型量的点，用同一个模型函数重新生成、逐点比对（误差 1e-4）；
 *      示意性的图（菜园、降温轨迹 a / b / d）按下面写明的规则核对。
 *   4. 模块完整性、正确选项的位置（与 tools/build-index.py 的 check_positions 同一条规则）、
 *      标签覆盖（被引用的标签至少 2 道题、2 种情境，全部题库一起算）、知识点覆盖（新题的每个 kp 都有二段式题和迁移题）。
 */
"use strict";
var describe = require("node:test").describe;
var it = require("node:test").it;
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var core = require("../shared/quiz/core.js");
var Q = require("../math/js/quadratic-model.js");
var C = require("../chemistry/js/chem-models.js");

var ITEMS_DIR = path.join(__dirname, "..", "shared", "quiz", "items");
function loadBank(f) { return JSON.parse(fs.readFileSync(path.join(ITEMS_DIR, f), "utf8")).items; }
var M2 = loadBank("math-m2.json");
var CB = loadBank("chemistry-cb.json");
var CC = loadBank("chemistry-cc.json");
var NEW = M2.concat(CB, CC);
// 全部题库（第 0 批示范题、第 1 批 A、第 1 批 B）：标签覆盖、知识点覆盖、id 唯一都按全库算
var EVERY = [];
fs.readdirSync(ITEMS_DIR).filter(function (f) { return /\.json$/.test(f); }).sort().forEach(function (f) {
  EVERY = EVERY.concat(loadBank(f));
});
var TAGS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "shared", "quiz", "misconceptions.json"), "utf8")).tags;
var SEARCH = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "shared", "search-index.json"), "utf8")).items;
var BY = core.byId(NEW);

/* ---------- 小工具 ---------- */
var EPS = 1e-4;
var MINUS = "−";
function near(a, b, msg, eps) {
  assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || "") + "：期望 " + b + "，实际 " + a);
}
function nearPts(actual, expected, msg) {
  assert.ok(Array.isArray(actual), msg + "：缺少点列");
  assert.equal(actual.length, expected.length, msg + "：点数不对");
  for (var i = 0; i < expected.length; i++) {
    near(actual[i][0], expected[i][0], msg + " 第 " + i + " 点 x", EPS);
    near(actual[i][1], expected[i][1], msg + " 第 " + i + " 点 y", EPS);
  }
}
function has(str, sub, msg) {
  assert.ok(String(str).indexOf(sub) >= 0, (msg || "") + "：「" + str + "」里应该有「" + sub + "」");
}
function hasNot(str, sub, msg) {
  assert.ok(String(str).indexOf(sub) < 0, (msg || "") + "：「" + str + "」里不该有「" + sub + "」");
}
function opt(item, id) {
  var o = (item.answer.options || []).filter(function (x) { return x.id === id; })[0];
  assert.ok(o, item.id + " 缺少选项 " + id);
  return o;
}
function rsn(item, id) {
  var o = (item.reason.options || []).filter(function (x) { return x.id === id; })[0];
  assert.ok(o, item.id + " 缺少理由 " + id);
  return o;
}
function itemsOf(fig, t) { return (fig.items || []).filter(function (x) { return x.t === t; }); }
function lines(fig) { return itemsOf(fig, "polyline").map(function (x) { return x.pts; }); }
function texts(fig) { return itemsOf(fig, "text").map(function (x) { return x.s; }); }
function ys(pts) { return pts.map(function (p) { return p[1]; }); }
function r4(v) { return Q.round(v, 4); }
function r1(v) { return Math.round(v * 10) / 10; }
function f1(v) { return r1(v).toFixed(1); }
function range(a, b, step) { var o = []; for (var v = a; v <= b + 1e-9; v += step) o.push(Q.round(v, 6)); return o; }
function values(o) { return Object.keys(o).map(function (k) { return o[k]; }).filter(Boolean); }
function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
// 选项里写的数：「48 m²」「−7」「约 1.3 g」「26.5%」→ 数值（负号是「−」）
function numIn(s) {
  var m = /([−-]?\d+(?:\.\d+)?)/.exec(String(s));
  assert.ok(m, "「" + s + "」里没有数");
  return parseFloat(m[1].replace(MINUS, "-"));
}
// 「(−1, 3)」→ [−1, 3]
function ptIn(s) {
  var m = /\(([−-]?\d+(?:\.\d+)?), ([−-]?\d+(?:\.\d+)?)\)/.exec(String(s));
  assert.ok(m, "「" + s + "」里没有坐标");
  return [parseFloat(m[1].replace(MINUS, "-")), parseFloat(m[2].replace(MINUS, "-"))];
}
// 理由只写方法、不写结果：理由里不出现给定的字样；tokens 为数时按独立的数字查（前后不是数字或小数点）
function noResultInReasons(q, tokens) {
  q.reason.options.forEach(function (o) {
    tokens.forEach(function (t) {
      if (typeof t === "number") {
        var s = String(t).replace("-", MINUS).replace(".", "\\.");
        assert.ok(!new RegExp("(^|[^0-9.])" + s + "(?![0-9]|\\.[0-9])").test(o.text), q.id + " 理由 " + o.id + "「" + o.text + "」写出了结果 " + t);
      } else hasNot(o.text, t, q.id + " 理由 " + o.id + " 写出了结果");
    });
  });
}
// 题里出现的全部文字：题干、提问、选项、理由、参考、图里的文字
function allText(q) {
  var s = [q.stem, q.ask || "", q.context, q.feedback.ref];
  q.answer.options.forEach(function (o) { s.push(o.text); });
  if (q.reason) q.reason.options.forEach(function (o) { s.push(o.text); });
  figsOf(q).forEach(function (f) {
    if (f.fig.alt) s.push(f.fig.alt);
    if (f.fig.axes) { s.push(f.fig.axes.x || ""); s.push(f.fig.axes.y || ""); }
    (f.fig.items || []).forEach(function (x) { if (x.s) s.push(x.s); if (x.label) s.push(x.label); });
  });
  return s.join("\n");
}
function figsOf(q) {
  var out = (q.figures || []).map(function (f, i) { return { fig: f, where: q.id + " 题图 " + i, thumb: false }; });
  q.answer.options.forEach(function (o) { if (o.figure) out.push({ fig: o.figure, where: q.id + " 选项 " + o.id, thumb: true }); });
  return out;
}
var SVG_COLORS = ["blue", "green", "coral", "sun", "red", "purple", "cyan", "ink", "muted"];

/* ======================================================================
 * SPEC 第 4.5、5.3、6.5 节的题目表（原样编码）：类型、情境、知识点（照 SPEC 的顺序）、
 * 选项 [id, 标签]（按显示顺序，null = 无标签）、正确选项、理由、题图张数、选项是否带缩略图
 * ====================================================================== */
var MODULES = {
  m2: { bank: M2, prefix: "m-m2-", subject: "math", page: "math/quadratic.html", widget: "m2-vertex",
        explain: "用一句话说一说：为什么向右移，括号里却是减号？", ask: "选出你的预测" },
  cb: { bank: CB, prefix: "c-cb-", subject: "chemistry", page: "chemistry/solubility.html", widget: "cb-state",
        explain: "用一句话说一说：为什么刚开始降温时没有晶体析出？", ask: "选出你的预测" },
  cc: { bank: CC, prefix: "c-cc-", subject: "chemistry", page: "chemistry/solute.html", widget: "cc-curve",
        explain: "用一句话说一说：为什么这里和稀盐酸加 NaOH 不一样？", ask: "选出你的预测" }
};
function mk(id, type, ctx, kp, ans, correct, rs, rcorrect, figs, thumbs) {
  return { id: id, type: type, ctx: ctx, kp: kp, ans: ans, correct: correct, rs: rs, rcorrect: rcorrect, figs: figs || 0, thumbs: !!thumbs };
}
var m = function (k) { return "math:" + k; };
var c = function (k) { return "chemistry:" + k; };
var SPEC = {
  m2: [
    mk("m-m2-poe", "predict", "平移与解析式", [m("c26-2-2")],
      [["a", "shiftsign"], ["b", null], ["c", null], ["d", null]], "b", null, null, 0),
    mk("m-m2-tt-shift", "twotier", "由解析式看平移", [m("c26-2-2")],
      [["a", null], ["b", "shiftsign"], ["c", null]], "a", [["r1", "shiftsign"], ["r2", null]], "r2"),
    mk("m-m2-tt-vertex", "twotier", "读顶点坐标", [m("c26-2-2")],
      [["a", "shiftsign"], ["b", null], ["c", null]], "c", [["r1", null], ["r2", "shiftsign"]], "r1"),
    mk("m-m2-tt-interval", "twotier", "区间不含顶点", [m("c26-2-4")],
      [["a", "vertexismax"], ["b", null], ["c", null]], "b", [["r1", "vertexismax"], ["r2", null]], "r2"),
    mk("m-m2-tt-fence", "twotier", "靠墙围菜园（墙长 8 m）", [m("c26-4-1"), m("c26-2-4")],
      [["a", null], ["b", "vertexismax"], ["c", null]], "a", [["r1", null], ["r2", "vertexismax"]], "r1", 1),
    mk("m-m2-tt-bup", "twotier", "开口向上读图", [m("c26-2-5")],
      [["a", "axisbsign"], ["b", null], ["c", null]], "b", [["r1", "axisbsign"], ["r2", null]], "r2", 1),
    mk("m-m2-tt-bdown", "twotier", "开口向下读图", [m("c26-2-5")],
      [["a", null], ["b", null]], "a", [["r1", null], ["r2", "axisbsign"]], "r1", 1),
    mk("m-m2-tr-flip", "transfer", "开口方向反过来", [m("c26-2-4"), m("c26-2-2"), m("c26-2-5")],
      [["a", "vertexismax"], ["b", null], ["c", null]], "c", [["r1", "vertexismax"], ["r2", null]], "r2"),
    mk("m-m2-tr-wall", "transfer", "墙变长（墙长 12 m）", [m("c26-4-1"), m("c26-2-4")],
      [["a", null], ["b", null], ["c", null]], "a", [["r1", null], ["r2", null]], "r1", 1),
    mk("m-m2-inv", "inverse", "由图象求解析式", [m("c26-2-2")],
      [["a", null], ["b", null], ["c", "shiftsign"]], "b", [["r1", "shiftsign"], ["r2", null]], "r2", 1)
  ],
  cb: [
    mk("c-cb-poe", "predict", "降温时状态点的移动", [c("u9-k4"), c("u9-k5")],
      [["a", null], ["b", "coolalwayscrystal"], ["c", null], ["d", null]], "c", null, null, 0, true),
    mk("c-cb-tt-percent", "twotier", "由溶解度求质量分数", [c("u9-k6"), c("u9-k4")],
      [["a", "solubilityispercent"], ["b", null], ["c", null]], "b", [["r1", null], ["r2", "solubilityispercent"]], "r1"),
    mk("c-cb-tt-percent25", "twotier", "能不能配出", [c("u9-k6")],
      [["a", null], ["b", "solubilityispercent"]], "a", [["r1", "solubilityispercent"], ["r2", null]], "r2"),
    mk("c-cb-tt-cross", "twotier", "交点读图", [c("u9-k4"), c("u9-k6")],
      [["a", "solubilityfraction"], ["b", null]], "b", [["r1", null], ["r2", "solubilityfraction"]], "r1", 1),
    mk("c-cb-tt-cool2cross", "twotier", "降温到交点温度", [c("u9-k4"), c("u9-k6")],
      [["a", null], ["b", "solubilityfraction"]], "a", [["r1", "solubilityfraction"], ["r2", null]], "r2"),
    mk("c-cb-tt-nocrystal", "twotier", "状态点判断", [c("u9-k3"), c("u9-k5")],
      [["a", null], ["b", "coolalwayscrystal"], ["c", null]], "c", [["r1", null], ["r2", "coolalwayscrystal"]], "r1"),
    mk("c-cb-tt-fridge", "twotier", "放进冰箱", [c("u9-k3"), c("u9-k5")],
      [["a", "coolalwayscrystal"], ["b", null]], "b", [["r1", "coolalwayscrystal"], ["r2", null]], "r2"),
    mk("c-cb-tr-nacl", "transfer", "换成 NaCl", [c("u9-k5"), c("u9-k4")],
      [["a", null], ["b", null], ["c", null]], "a", [["r1", null], ["r2", null]], "r1"),
    mk("c-cb-tr-evap", "transfer", "恒温蒸发", [c("u9-k5"), c("u9-k3"), c("u9-k6")],
      [["a", null], ["b", null], ["c", null]], "c", [["r1", null], ["r2", null]], "r2"),
    mk("c-cb-inv", "inverse", "由析出量反推", [c("u9-k4"), c("u9-k5")],
      [["a", null], ["b", null], ["c", null], ["d", null]], "b", [["r1", null], ["r2", null]], "r1")
  ],
  cc: [
    mk("c-cc-poe", "predict", "生成沉淀的中和", [c("u10-k10"), c("u10-k9")],
      [["a", null], ["b", "productalwayssolute"], ["c", null], ["d", "productalwayssolute"]], "a"),
    mk("c-cc-tt-baso4", "twotier", "沉淀（曲线取样）", [c("u10-k10"), c("u10-k9")],
      [["a", "productalwayssolute"], ["b", "productalwayssolute"], ["c", null], ["d", null]], "c",
      [["r1", "productalwayssolute"], ["r2", null]], "r2", 1),
    mk("c-cc-tt-co2", "twotier", "生成气体", [c("u10-k10"), c("u10-k9")],
      [["a", "productalwayssolute"], ["b", null], ["c", null]], "b", [["r1", null], ["r2", "productalwayssolute"]], "r1"),
    mk("c-cc-tt-nacl", "twotier", "稀盐酸加 NaOH 恰好反应", [c("u10-k7")],
      [["a", null], ["b", "neutralnoions"], ["c", null]], "a", [["r1", "neutralnoions"], ["r2", null]], "r2"),
    mk("c-cc-tt-cacl2", "twotier", "石灰水加盐酸后蒸干", [c("u10-k7"), c("u10-k10")],
      [["a", "neutralnoions"], ["b", null], ["c", null]], "b", [["r1", null], ["r2", "neutralnoions"]], "r1"),
    mk("c-cc-tt-phenol", "twotier", "直接滴酚酞检验变质", [c("u10-k6"), c("u10-k8")],
      [["a", null], ["b", "carbonatebasic"]], "a", [["r1", "carbonatebasic"], ["r2", null]], "r2"),
    mk("c-cc-tt-excesscarb", "twotier", "Na₂CO₃ 滴过量后 pH > 7", [c("u10-k8"), c("u10-k10")],
      [["a", "carbonatebasic"], ["b", null], ["c", null]], "c", [["r1", null], ["r2", "carbonatebasic"]], "r1"),
    mk("c-cc-tr-little", "transfer", "只滴几滴稀盐酸", [c("u10-k6"), c("u10-k8")],
      [["a", "littleacid"], ["b", null]], "b", [["r1", "littleacid"], ["r2", null]], "r2"),
    mk("c-cc-tr-mix", "transfer", "混合溶液滴酸的气体图像", [c("u10-k10"), c("u10-k6"), c("u10-k7"), c("u10-k9")],
      [["a", null], ["b", "littleacid"], ["c", null]], "a", [["r1", null], ["r2", "littleacid"]], "r1", 0, true),
    mk("c-cc-inv", "inverse", "由 pH 曲线反推", [c("u10-k10"), c("u10-k7")],
      [["a", null], ["b", null], ["c", null]], "c", [["r1", null], ["r2", null]], "r2", 1)
  ]
};
function pairsToObj(pairs) { var o = {}; (pairs || []).forEach(function (p) { o[p[0]] = p[1]; }); return o; }

/* ====================================================================== 1. 结构 */
describe("第 1 批 B 题库：结构与 SPEC 题目表一致", function () {
  Object.keys(SPEC).forEach(function (mod) {
    var MD = MODULES[mod];
    it(mod + "：题目 id 和顺序（预测关卡在前，其余按 SPEC 顺序）", function () {
      assert.deepEqual(MD.bank.map(function (x) { return x.id; }), SPEC[mod].map(function (x) { return x.id; }));
    });
    SPEC[mod].forEach(function (sp) {
      it(sp.id + "：字段、选项和理由的顺序、标签、判定", function () {
        var q = BY[sp.id];
        assert.ok(q, "题库里找不到 " + sp.id);
        assert.equal(q.id.indexOf(MD.prefix), 0, "id 前缀");
        assert.match(q.id, /^[a-z0-9][a-z0-9-]{2,47}$/);
        assert.equal(q.subject, MD.subject);
        assert.equal(q.module, mod);
        assert.equal(q.type, sp.type);
        assert.equal(q.level, "junior");
        assert.deepEqual(q.kp, sp.kp, "kp 照 SPEC 的顺序");
        assert.equal(q.context, sp.ctx);
        assert.equal(q.page, MD.page);
        assert.equal(q.confidence, true);
        assert.ok(Array.isArray(q.figures), "figures 应是数组");
        assert.equal(q.figures.length, sp.figs, "题图张数");
        assert.ok(typeof q.stem === "string" && q.stem.length > 8, "题干");
        assert.ok(q.feedback && typeof q.feedback.ref === "string" && q.feedback.ref.length > 8, "参考解释");
        if (sp.type === "predict") {
          assert.equal(q.retest, false, "带部件的题不重测");
          assert.equal(q.widget, MD.widget);
          assert.deepEqual(q.explain, { prompt: MD.explain, min: 6 });
          assert.equal(q.ask, MD.ask, "预测的提问（选项不是「哪一个图象」）");
          has(q.stem, "先预测：");
        } else {
          assert.equal(q.retest, true);
          assert.equal(q.widget, null);
          assert.equal(q.explain, null);
          assert.equal(q.ask, undefined, "只有预测关卡才有 ask");
        }
        // 答案：选项的顺序就是 SPEC 列出的顺序，id 依次是 a、b、c、d（不再重排）
        var ids = sp.ans.map(function (p) { return p[0]; });
        assert.deepEqual(ids, ["a", "b", "c", "d"].slice(0, ids.length), "SPEC 表本身按 a、b、c… 排");
        assert.deepEqual(q.answer.options.map(function (o) { return o.id; }), ids, "选项顺序");
        assert.equal(q.answer.correct, sp.correct);
        var ans = pairsToObj(sp.ans);
        q.answer.options.forEach(function (o) {
          assert.ok(typeof o.text === "string" && o.text.length > 0, sp.id + " 选项 " + o.id + " 没有文字");
          assert.equal(o.mc == null ? null : o.mc, ans[o.id], sp.id + " 选项 " + o.id + " 的标签");
          assert.ok(!("mc" in o) || typeof o.mc === "string", sp.id + " 选项 " + o.id + "：无标签时不写 mc 字段");
          if (sp.thumbs) assert.ok(o.figure, sp.id + " 选项 " + o.id + " 应带缩略图");
          else assert.ok(!o.figure, sp.id + " 选项 " + o.id + " 不该带缩略图");
        });
        // 理由
        var rs = pairsToObj(sp.rs);
        if (!sp.rs) assert.equal(q.reason, null);
        else {
          var rids = sp.rs.map(function (p) { return p[0]; });
          assert.deepEqual(rids, ["r1", "r2", "r3"].slice(0, rids.length));
          assert.deepEqual(q.reason.options.map(function (o) { return o.id; }), rids, "理由顺序");
          assert.equal(q.reason.correct, sp.rcorrect);
          q.reason.options.forEach(function (o) {
            assert.ok(typeof o.text === "string" && o.text.length > 0);
            assert.equal(o.mc == null ? null : o.mc, rs[o.id], sp.id + " 理由 " + o.id + " 的标签");
            assert.ok(!o.figure);
          });
        }
        // 判定（core.classify）
        assert.deepEqual(core.classify(q, { ch: sp.correct, rs: sp.rcorrect, cf: "sure" }), { cls: "pass", ans: true, rsn: true, tags: [] });
        assert.equal(core.classify(q, { ch: sp.correct, rs: sp.rcorrect, cf: "unsure" }).cls, "unsure");
        Object.keys(ans).forEach(function (oid) {
          if (oid === sp.correct) return;
          var sure = core.classify(q, { ch: oid, rs: sp.rcorrect, cf: "sure" });
          var unsure = core.classify(q, { ch: oid, rs: sp.rcorrect, cf: "unsure" });
          assert.equal(unsure.cls, "gap", sp.id + " 选 " + oid + "、没把握 → gap");
          if (ans[oid]) assert.deepEqual([sure.cls, sure.tags], ["mc", [ans[oid]]], sp.id + " 选 " + oid + "、有把握");
          else assert.deepEqual([sure.cls, sure.tags], ["gap", []], sp.id + " 选无标签的 " + oid + "、有把握 → gap");
        });
        Object.keys(rs).forEach(function (rid) {
          if (rid === sp.rcorrect) return;
          var r = core.classify(q, { ch: sp.correct, rs: rid, cf: "unsure" });
          if (rs[rid]) assert.deepEqual([r.cls, r.tags], ["mc", [rs[rid]]], sp.id + " 理由 " + rid);
          else assert.equal(r.cls, "gap", sp.id + " 理由 " + rid + "（无标签）→ gap");
        });
        assert.deepEqual(core.itemTags(q).slice().sort(), uniq(values(ans).concat(values(rs))).sort());
      });
    });
  });

  it("三个题库用到的错误概念标签都在 misconceptions.json 里", function () {
    NEW.forEach(function (q) {
      core.itemTags(q).forEach(function (t) { assert.ok(TAGS[t], q.id + " 的标签 " + t + " 不在标签库里"); });
    });
  });

  it("知识点都在 shared/search-index.json 里", function () {
    var keys = {};
    SEARCH.forEach(function (x) { keys[x.s + ":" + x.k] = true; });
    NEW.forEach(function (q) { q.kp.forEach(function (k) { assert.ok(keys[k], q.id + " 的知识点 " + k + " 不在搜索索引里"); }); });
  });

  it("模块完整性：1 预测、6 二段式（每道有标签选项）、2 迁移、1 逆向；可重测的题正好 9 道", function () {
    Object.keys(MODULES).forEach(function (mod) {
      var b = MODULES[mod].bank;
      var n = function (t) { return b.filter(function (q) { return q.type === t; }).length; };
      assert.deepEqual([n("predict"), n("twotier"), n("transfer"), n("inverse")], [1, 6, 2, 1], mod + " 各题型道数");
      b.filter(function (q) { return q.type === "twotier"; }).forEach(function (q) {
        assert.ok(core.itemTags(q).length >= 1, q.id + " 是二段式，至少一个答案或理由选项要带标签");
      });
      assert.equal(b.filter(function (q) { return q.retest === true; }).length, 9, mod + " 可重测的题");
      assert.equal(b.length, 10);
    });
  });

  it("被引用的标签至少 2 道题、2 种情境（全部题库一起算），且至少一道能重测", function () {
    var used = {};
    EVERY.forEach(function (q) {
      core.itemTags(q).forEach(function (t) { (used[t] = used[t] || []).push(q); });
    });
    var mine = uniq([].concat.apply([], NEW.map(core.itemTags)));
    assert.deepEqual(mine.slice().sort(), ["axisbsign", "carbonatebasic", "coolalwayscrystal", "littleacid", "neutralnoions",
      "productalwayssolute", "shiftsign", "solubilityfraction", "solubilityispercent", "vertexismax"]);
    Object.keys(used).forEach(function (t) {
      var qs = used[t];
      var ctx = uniq(qs.map(function (q) { return q.context || q.id; }));
      assert.ok(qs.length >= 2, t + " 只有 " + qs.length + " 道题");
      assert.ok(ctx.length >= 2, t + " 只有 " + ctx.length + " 种情境");
      assert.ok(qs.some(function (q) { return q.retest === true && !q.widget; }), t + " 没有能重测的题");
    });
  });

  it("新题的每个知识点都有二段式题和迁移题覆盖（全部题库一起算；掌握门槛要两种都做对）", function () {
    var types = {};
    EVERY.forEach(function (q) { q.kp.forEach(function (k) { (types[k] = types[k] || {})[q.type] = true; }); });
    var kps = uniq([].concat.apply([], NEW.map(function (q) { return q.kp; })));
    assert.equal(kps.length, 13, "SPEC 第 1 节列出的 13 个知识点都用到了");
    kps.forEach(function (k) {
      assert.ok(types[k].twotier, k + " 没有二段式题");
      assert.ok(types[k].transfer, k + " 没有迁移题");
    });
  });

  it("全库 id 唯一，按题记的错题 id 不冲突", function () {
    var ids = EVERY.map(function (q) { return q.id; });
    assert.equal(uniq(ids).length, ids.length);
    var z = ids.map(function (id) { return core.qzId(id); });
    assert.equal(uniq(z).length, z.length);
  });

  it("每张图的写法 svgkit 都认：view、aspect、元素类型、颜色、点在视图里、缩略图每条折线 ≤ 50 点", function () {
    NEW.forEach(function (q) {
      figsOf(q).forEach(function (F) {
        var fig = F.fig, where = F.where;
        assert.ok(Array.isArray(fig.view) && fig.view.length === 4, where + " view");
        assert.ok(fig.view[1] > fig.view[0] && fig.view[3] > fig.view[2], where + " view 范围");
        assert.ok(fig.aspect === "fill" || fig.aspect === "equal", where + " aspect");
        assert.ok(fig.axes === null || typeof fig.axes === "object", where + " axes");
        if (!F.thumb) assert.ok(typeof fig.alt === "string" && fig.alt.length > 4, where + " 题图要有 alt");
        assert.ok(Array.isArray(fig.items) && fig.items.length > 0, where + " items");
        fig.items.forEach(function (x) {
          assert.ok(["polyline", "polygon", "segment", "circle", "point", "text"].indexOf(x.t) >= 0, where + " 元素类型 " + x.t);
          if (x.color) assert.ok(SVG_COLORS.indexOf(x.color) >= 0, where + " 颜色 " + x.color);
          var pts = x.pts || [x.a, x.b, x.at, x.c].filter(Boolean);
          pts.forEach(function (p) {
            assert.ok(isFinite(p[0]) && isFinite(p[1]), where + " 坐标不是有限数");
            // 坐标都已经 round 到 4 位小数
            assert.equal(p[0], r4(p[0]), where + " 坐标没有 round 到 4 位");
            assert.equal(p[1], r4(p[1]), where + " 坐标没有 round 到 4 位");
            // 折线、线段、点都在视图里（svgkit 不裁折线，出界会画到坐标轴外面）；文字可以贴边
            var tol = x.t === "text" ? 0.1 : 1e-9;
            var vx = (fig.view[1] - fig.view[0]) * tol, vy = (fig.view[3] - fig.view[2]) * tol;
            assert.ok(p[0] >= fig.view[0] - vx && p[0] <= fig.view[1] + vx && p[1] >= fig.view[2] - vy && p[1] <= fig.view[3] + vy,
              where + " 点 " + JSON.stringify(p) + " 在视图外");
          });
          if (x.t === "polyline" && F.thumb) assert.ok(x.pts.length <= 50, where + " 折线点太多：" + x.pts.length);
        });
      });
    });
  });
});

/* ====================================================================== 2、3. M2 二次函数 */
describe("M2 二次函数：题里的数值和图由 quadratic-model.js 重新算出", function () {
  var fv = Q.formatVertex;
  // 抛物线在视图里的点：x 每 0.125 一个（每单位 8 段），只留 y 在视野里的一段
  function para(a, h, k, view) {
    return Q.parabolaPoints(a, h, k, view[0], view[1], Math.round((view[1] - view[0]) * 8), view[2], view[3]);
  }

  it("m-m2-poe：向右平移 2 → y = (x − 2)²（b）；选项不带缩略图（图上看得出顶点在哪一边，等于给出答案）", function () {
    var q = BY["m-m2-poe"];
    has(q.stem, "y = x² 向右平移 2 个单位");
    // 选项 ↔ 顶点 (h, k)
    var HK = { a: [-2, 0], b: [2, 0], c: [0, 2], d: [0, -2] };
    Object.keys(HK).forEach(function (id) { assert.equal(opt(q, id).text, fv(1, HK[id][0], HK[id][1]), id); });
    assert.deepEqual([opt(q, "a").text, opt(q, "b").text, opt(q, "c").text, opt(q, "d").text],
      ["y = (x + 2)²", "y = (x − 2)²", "y = x² + 2", "y = x² − 2"]);
    // y = x² 的顶点 (0, 0) 向右平移 2 → (2, 0)：shiftText 正好是「向右 2」的只有一个选项
    var right2 = Object.keys(HK).filter(function (id) { return Q.shiftText(HK[id][0], HK[id][1]) === "向右 2"; });
    assert.deepEqual(right2, [q.answer.correct]);
    // 每个点都右移 2：(x, x²) → (x + 2, x²) 在 y = (x − 2)² 上
    range(-3, 3, 0.5).forEach(function (x) { near(Q.valueAt(1, 2, 0, x + 2), x * x, "平移后 (" + (x + 2) + ")"); });
    // 参考：x = 2 时括号等于 0
    near(Q.valueAt(1, 2, 0, 2), 0, "x = 2 时 y = 0");
    has(q.feedback.ref, "移到了 x = 2"); has(q.feedback.ref, "x − 2");
    // 预测阶段只看解析式：四个选项都不带缩略图，题干也不带图
    q.answer.options.forEach(function (o) { assert.ok(!o.figure, o.id + " 不带缩略图"); });
    assert.equal(q.figures.length, 0);
  });

  it("m-m2-tt-shift：y = (x + 3)² − 1 的顶点 (−3, −1)，由 (0, 0) 向左 3、向下 1（a）", function () {
    var q = BY["m-m2-tt-shift"];
    assert.equal(fv(1, -3, -1), "y = (x + 3)² − 1");
    has(q.stem, fv(1, -3, -1));
    var g = Q.vertexToGeneral(1, -3, -1), v = Q.generalToVertex(g.a, g.b, g.c);
    assert.deepEqual([v.h, v.k], [-3, -1]);
    assert.equal(Q.shiftText(v.h, v.k), "向左 3、向下 1");
    // 选项写成「向左平移 3 个单位，再向下平移 1 个单位」：解析出 (dx, dy)，只有正确选项等于顶点的移动
    function shiftOf(s) {
      var mm = /^向(左|右)平移 (\d+) 个单位，再向(上|下)平移 (\d+) 个单位$/.exec(s);
      assert.ok(mm, "选项写法：" + s);
      return [(mm[1] === "左" ? -1 : 1) * +mm[2], (mm[3] === "下" ? -1 : 1) * +mm[4]];
    }
    var ok = q.answer.options.filter(function (o) {
      var d = shiftOf(o.text);
      return d[0] === v.h && d[1] === v.k;
    }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    assert.deepEqual(shiftOf(opt(q, "b").text), [-v.h, v.k], "b 把左右弄反了（shiftsign）");
    assert.deepEqual(shiftOf(opt(q, "c").text), [v.h, -v.k], "c 把上下弄反了");
    has(q.feedback.ref, "y = x² 的顶点是 (0, 0)");
    has(q.feedback.ref, fv(1, -3, -1) + " 的顶点是 (" + Q.fmt(v.h) + ", " + Q.fmt(v.k) + ")");
    has(q.feedback.ref, "横坐标减小 " + Q.fmt(-v.h) + "（向左），纵坐标减小 " + Q.fmt(-v.k) + "（向下）");
    noResultInReasons(q, ["向左", "(" + Q.fmt(v.h) + ", " + Q.fmt(v.k) + ")"]);
  });

  it("m-m2-tt-vertex：y = 2(x − 1)² + 3 的顶点 (1, 3)（c）", function () {
    var q = BY["m-m2-tt-vertex"];
    assert.equal(fv(2, 1, 3), "y = 2(x − 1)² + 3");
    has(q.stem, fv(2, 1, 3));
    var g = Q.vertexToGeneral(2, 1, 3), v = Q.generalToVertex(g.a, g.b, g.c);
    assert.deepEqual([v.h, v.k], [1, 3]);
    var ok = q.answer.options.filter(function (o) { var p = ptIn(o.text); return p[0] === v.h && p[1] === v.k; }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    assert.deepEqual(ptIn(opt(q, "a").text), [-v.h, v.k], "a 把括号里的符号照抄成横坐标（shiftsign）");
    assert.deepEqual(ptIn(opt(q, "b").text), [2, v.k], "b 把系数 a = 2 当成横坐标");
    // 参考：x = 1 时 2(x − 1)² 最小为 0，此时 y = 3；在别处都更大
    near(Q.valueAt(2, 1, 3, 1), 3, "y(1)");
    range(-3, 5, 0.25).forEach(function (x) { assert.ok(Q.valueAt(2, 1, 3, x) >= 3); });
    has(q.feedback.ref, "x − 1 = 0，即 x = 1 时，2(x − 1)² 最小为 0，此时 y = 3");
    noResultInReasons(q, ["(1, 3)", "x = 1", "y = 3"]);
  });

  it("m-m2-tt-interval：y = (x − 1)² + 2 在 2 ≤ x ≤ 4 上最小值 3（b）；a = 顶点纵坐标 2，c = 最大值 11", function () {
    var q = BY["m-m2-tt-interval"];
    has(q.stem, fv(1, 1, 2) + "，当 2 ≤ x ≤ 4 时，y 的最小值是？");
    var E = Q.intervalExtrema(1, 1, 2, 2, 4);
    assert.equal(E["case"], "left", "对称轴在区间左侧");
    assert.deepEqual(E.min, { x: 2, y: 3 });
    assert.deepEqual(E.max, { x: 4, y: 11 });
    // 在 [2, 4] 上单调递增（逐点取样核对）
    var v = range(2, 4, 0.05).map(function (x) { return Q.valueAt(1, 1, 2, x); });
    for (var i = 1; i < v.length; i++) assert.ok(v[i] > v[i - 1]);
    near(Math.min.apply(null, v), E.min.y, "取样的最小值");
    assert.equal(numIn(opt(q, "a").text), 2, "a = 顶点纵坐标");
    assert.equal(numIn(opt(q, "b").text), E.min.y);
    assert.equal(numIn(opt(q, "c").text), E.max.y);
    var ok = q.answer.options.filter(function (o) { return numIn(o.text) === E.min.y; }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    has(q.feedback.ref, "对称轴 x = " + Q.fmt(Q.axis(1, -2)) + " 不在 2～4 之间");
    has(q.feedback.ref, "x = " + E.min.x + " 时最小，y = " + E.min.y);
    q.reason.options.forEach(function (o) { assert.ok(!/\d/.test(o.text), o.id + " 理由里不写数"); });
  });

  // 靠墙围菜园的示意图（不按比例）：墙 (0.5, 5)→(9.5, 5)；篱笆 (2.5, 5)→(2.5, 1.5)→(7.5, 1.5)→(7.5, 5)；
  // 文字：墙长、两个「x」、「20 − 2x」、「菜园」；不写答案
  function checkFenceFig(f, wall) {
    assert.deepEqual(f.view, [0, 10, 0.6, 5.8]);
    assert.equal(f.axes, null);
    var s = itemsOf(f, "segment")[0];
    nearPts([s.a, s.b], [[0.5, 5], [9.5, 5]], "墙");
    nearPts(lines(f)[0], [[2.5, 5], [2.5, 1.5], [7.5, 1.5], [7.5, 5]], "篱笆");
    assert.deepEqual(texts(f), ["墙（长 " + wall + " m）", "x", "x", "20 − 2x", "菜园"]);
  }

  it("m-m2-tt-fence：墙长 8 m → 6 ≤ x < 10，对称轴 x = 5 不在范围里，x = 6 时 S 最大 48（a）；b = 顶点值 50", function () {
    var q = BY["m-m2-tt-fence"], F = Q.fence(20, 8);
    assert.deepEqual([F.xMin, F.xMax, F.axis, F.inRange, F.xAtMax, F.Smax, F.Svertex], [6, 10, 5, false, 6, 48, 50]);
    // 取值范围内逐点取样：最大值在 x = 6，S 随 x 增大而减小
    var xs = range(F.xMin, F.xMax - 0.01, 0.01), S = xs.map(F.S);
    for (var i = 1; i < S.length; i++) assert.ok(S[i] < S[i - 1]);
    near(S[0], F.Smax, "S(6)");
    near(F.S(6), 6 * (20 - 2 * 6), "S = 6 × 8");
    has(q.stem, "20 m"); has(q.stem, "墙长 8 m"); has(q.stem, "S = x(20 − 2x)");
    assert.equal(numIn(opt(q, "a").text), F.Smax);
    assert.equal(numIn(opt(q, "b").text), F.Svertex);
    assert.ok(numIn(opt(q, "c").text) < F.Smax, "c 比最大值小");
    q.answer.options.forEach(function (o) { has(o.text, " m²"); });
    var ok = q.answer.options.filter(function (o) { return numIn(o.text) === F.Smax; }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    has(q.feedback.ref, "20 − 2x ≤ 8，所以 " + F.xMin + " ≤ x < " + F.xMax);
    has(q.feedback.ref, "对称轴 x = " + F.axis + " 不在范围里");
    has(q.feedback.ref, "x = " + F.xAtMax + " 时最大，S = 6 × 8 = " + F.Smax);
    q.reason.options.forEach(function (o) { assert.ok(!/\d/.test(o.text), o.id + " 理由里不写数"); });
    checkFenceFig(q.figures[0], 8);
  });

  it("m-m2-tt-bup：y = x² − 2x − 1 开口向上、对称轴 x = 1 在右侧 → b < 0（b）；题图不泄露 a、b", function () {
    var q = BY["m-m2-tt-bup"], a = 1, b = -2, cc = -1;
    assert.equal(Q.formatGeneral(a, b, cc), "y = x² − 2x − 1");
    assert.equal(Q.axis(a, b), 1);
    assert.equal(Q.axisSide(a, b), "right");
    var sg = Q.abSigns(a, b, cc);
    assert.deepEqual([sg.a, sg.b, sg.opens, sg.side], ["+", MINUS, "up", "right"]);
    has(q.stem, "开口向上"); has(q.stem, "对称轴是直线 x = 1（在 y 轴右侧）");
    hasNot(q.stem, "2x", "题干不写画图用的解析式（会泄露 b）");
    var ok = q.answer.options.filter(function (o) { return o.text === "b " + (sg.b === MINUS ? "<" : ">") + " 0"; }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    // 左同右异：对称轴在右侧时，开口向上 b < 0，开口向下 b > 0；只看对称轴判断不了 b（axisbsign）
    assert.equal(Q.sign(Q.vertexToGeneral(-1, 1, 0).b), "+");
    has(q.feedback.ref, "−b/(2a) = 1 > 0，且 a > 0，所以 b < 0");
    noResultInReasons(q, ["b < 0"]);
    // 题图：抛物线 = parabolaPoints（每 0.125 一个点，只留视野里的），对称轴虚线，只标「x = 1」
    var f = q.figures[0], v = Q.generalToVertex(a, b, cc);
    assert.deepEqual(f.view, [-2, 4, -3, 4]);
    assert.equal(f.aspect, "equal");
    nearPts(lines(f)[0], para(v.a, v.h, v.k, f.view), "题图抛物线");
    lines(f)[0].forEach(function (p) { near(p[1], r4(Q.valueGeneral(a, b, cc, p[0])), "在 y = x² − 2x − 1 上", EPS); });
    var s = itemsOf(f, "segment")[0];
    nearPts([s.a, s.b], [[1, -3], [1, 4]], "对称轴");
    assert.equal(s.dash, true);
    assert.deepEqual(texts(f), ["x = 1"]);
    assert.deepEqual([f.axes.xt, f.axes.yt], [[], []], "不画刻度数值");
  });

  it("m-m2-tt-bdown：y = −x² − 2x + 1 开口向下、对称轴 x = −1 在左侧 → b < 0（a）；理由 2 能蒙对但不对", function () {
    var q = BY["m-m2-tt-bdown"], a = -1, b = -2, cc = 1;
    assert.equal(Q.formatGeneral(a, b, cc), "y = −x² − 2x + 1");
    assert.equal(Q.axis(a, b), -1);
    assert.equal(Q.axisSide(a, b), "left");
    var sg = Q.abSigns(a, b, cc);
    assert.deepEqual([sg.a, sg.b, sg.opens, sg.side], [MINUS, MINUS, "down", "left"]);
    has(q.stem, "开口向下"); has(q.stem, "对称轴是直线 x = −1（在 y 轴左侧）"); has(q.stem, "y = ax² + bx + c");
    hasNot(q.stem, "2x");
    var ok = q.answer.options.filter(function (o) { return o.text === "b " + (sg.b === MINUS ? "<" : ">") + " 0"; }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    // 理由 2（axisbsign）「左侧 → b 负」：开口向上、对称轴也在左侧时 b 是正的
    assert.equal(Q.axisSide(1, 2), "left"); assert.equal(Q.sign(2), "+");
    assert.equal(q.reason.options[1].id, "r2", "参考解释里的「理由 2」就是显示在第 2 个的 r2");
    has(q.feedback.ref, "理由 2"); hasNot(q.feedback.ref, "r2");
    noResultInReasons(q, ["b < 0"]);
    var f = q.figures[0], v = Q.generalToVertex(a, b, cc);
    assert.deepEqual([v.h, v.k], [-1, 2]);
    assert.deepEqual(f.view, [-4, 2, -4, 3]);
    nearPts(lines(f)[0], para(v.a, v.h, v.k, f.view), "题图抛物线");
    lines(f)[0].forEach(function (p) { near(p[1], r4(Q.valueGeneral(a, b, cc, p[0])), "在 y = −x² − 2x + 1 上", EPS); });
    var s = itemsOf(f, "segment")[0];
    nearPts([s.a, s.b], [[-1, -4], [-1, 3]], "对称轴");
    assert.deepEqual(texts(f), ["x = −1"]);
  });

  it("m-m2-tr-flip：y = −(x − 1)² + 2 在 2 ≤ x ≤ 4 上最大值 1（c）、最小值 −7（b）；a = 顶点纵坐标 2", function () {
    var q = BY["m-m2-tr-flip"];
    assert.equal(fv(-1, 1, 2), "y = −(x − 1)² + 2");
    has(q.stem, fv(-1, 1, 2) + "，当 2 ≤ x ≤ 4 时，y 的最大值是？");
    var E = Q.intervalExtrema(-1, 1, 2, 2, 4);
    assert.equal(E["case"], "left");
    assert.deepEqual(E.max, { x: 2, y: 1 });
    assert.deepEqual(E.min, { x: 4, y: -7 });
    var v = range(2, 4, 0.05).map(function (x) { return Q.valueAt(-1, 1, 2, x); });
    for (var i = 1; i < v.length; i++) assert.ok(v[i] < v[i - 1], "y 随 x 增大而减小");
    assert.equal(opt(q, "b").text, Q.fmt(E.min.y)); assert.equal(opt(q, "b").text, "−7");
    assert.equal(numIn(opt(q, "a").text), 2);
    var ok = q.answer.options.filter(function (o) { return numIn(o.text) === E.max.y; }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    has(q.feedback.ref, "x = 2 时 y = " + Q.fmt(Q.valueAt(-1, 1, 2, 2)) + "；x = 4 时 y = " + Q.fmt(Q.valueAt(-1, 1, 2, 4)));
    has(q.feedback.ref, "最大值是 " + Q.fmt(E.max.y) + "，最小值是 " + Q.fmt(E.min.y));
    q.reason.options.forEach(function (o) { assert.ok(!/\d/.test(o.text), o.id + " 理由里不写数"); });
  });

  it("m-m2-tr-wall：墙长 12 m → 4 ≤ x < 10，对称轴 x = 5 在范围里，最大 50（a）；b = 平行边等于墙长时的 48；72 取不到", function () {
    var q = BY["m-m2-tr-wall"], F = Q.fence(20, 12);
    assert.deepEqual([F.xMin, F.xMax, F.axis, F.inRange, F.xAtMax, F.Smax], [4, 10, 5, true, 5, 50]);
    var xs = range(F.xMin, F.xMax - 0.01, 0.01), S = xs.map(F.S);
    near(Math.max.apply(null, S), F.Smax, "取样的最大值");
    near(F.S(F.xMin), 48, "x = 4（平行于墙的边 = 墙长 12）");
    near(20 - 2 * F.xMin, 12);
    has(q.stem, "墙长 12 m"); has(q.stem, "S = x(20 − 2x)"); hasNot(q.stem, "同样");
    assert.equal(numIn(opt(q, "a").text), F.Smax);
    assert.equal(numIn(opt(q, "b").text), F.S(F.xMin));
    assert.ok(numIn(opt(q, "c").text) > F.Svertex, "c 比顶点值还大，取不到");
    var ok = q.answer.options.filter(function (o) { return numIn(o.text) === F.Smax; }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    has(q.feedback.ref, "20 − 2x ≤ 12，所以 " + F.xMin + " ≤ x < " + F.xMax);
    has(q.feedback.ref, "对称轴 x = " + F.axis + " 在范围里，x = 5 时 S 最大，为 " + F.Smax);
    has(q.feedback.ref, "x = 4 时只有 " + F.S(4));
    q.reason.options.forEach(function (o) { assert.ok(!/\d/.test(o.text), o.id + " 理由里不写数"); });
    checkFenceFig(q.figures[0], 12);
  });

  it("m-m2-inv：顶点 (2, −1)、过 (0, 3) → a = 1，y = (x − 2)² − 1（b）；题图点由模型算", function () {
    var q = BY["m-m2-inv"];
    var a = (3 - (-1)) / Math.pow(0 - 2, 2);
    assert.equal(a, 1);
    var A = { a: [2, 2, -1], b: [1, 2, -1], c: [1, -2, -1] };
    Object.keys(A).forEach(function (id) { assert.equal(opt(q, id).text, fv(A[id][0], A[id][1], A[id][2]), id); });
    // 顶点是 (2, −1) 且经过 (0, 3) 的只有 b；c 也经过 (0, 3)，但顶点是 (−2, −1)
    var ok = Object.keys(A).filter(function (id) {
      var p = A[id];
      return p[1] === 2 && p[2] === -1 && Q.valueAt(p[0], p[1], p[2], 0) === 3;
    });
    assert.deepEqual(ok, [q.answer.correct]);
    assert.equal(Q.valueAt(2, 2, -1, 0), 7, "a 不经过 (0, 3)");
    assert.equal(Q.valueAt(1, -2, -1, 0), 3, "c 经过 (0, 3)，错在顶点");
    has(q.stem, "顶点是 (2, −1)"); has(q.stem, "经过点 (0, 3)");
    has(q.feedback.ref, "设 y = a(x − 2)² − 1，代入 (0, 3)：4a − 1 = 3，a = " + a);
    near(Math.pow(0 - 2, 2), 4, "(0 − 2)² = 4");
    noResultInReasons(q, ["a = 1", fv(1, 2, -1)]);
    var f = q.figures[0];
    assert.deepEqual(f.view, [-1, 5, -2, 4]);
    nearPts(lines(f)[0], para(1, 2, -1, f.view), "题图抛物线");
    var P = itemsOf(f, "point");
    assert.deepEqual(P.map(function (p) { return [p.at, p.label]; }), [[[2, -1], "(2, −1)"], [[0, 3], "(0, 3)"]]);
    assert.ok(lines(f)[0].some(function (p) { return p[0] === 0 && p[1] === 3; }), "曲线经过 (0, 3)");
    assert.ok(lines(f)[0].some(function (p) { return p[0] === 2 && p[1] === -1; }), "曲线经过顶点");
  });

  it("文字：减号一律是「−」，不写 x − −3 这类，a = 1 不写 1", function () {
    M2.forEach(function (q) {
      var s = allText(q);
      assert.ok(s.indexOf("-") < 0, q.id + " 出现了 ASCII 减号");
      assert.ok(!/[−+] [−+]/.test(s), q.id + " 出现了连着的两个符号");
      assert.ok(!/(^|[^0-9.])1\(x/.test(s) && !/(^|[^0-9.])1x²/.test(s), q.id + " a = 1 时不写 1");
    });
  });
});

/* ====================================================================== 2、3. C-B 溶解度曲线 */
describe("C-B 溶解度曲线：题里的数值和图由 chem-models.js 重新算出", function () {
  var S = function (sub, T) { return C.solubility(sub, T); };

  it("表值：KNO₃ 20℃ 31.6 g、40℃ 63.9 g、60℃ 110 g；NaCl 20℃ 36.0 g、60℃ 37.3 g", function () {
    assert.equal(S("KNO3", 20), 31.6); assert.equal(S("KNO3", 40), 63.9); assert.equal(S("KNO3", 60), 110);
    assert.equal(S("NaCl", 20), 36.0); assert.equal(S("NaCl", 60), 37.3);
  });

  it("c-cb-poe：60℃ 80 g 不饱和，约 47℃ 碰到曲线，20℃ 共析出 48.4 g；正确轨迹 c = coolPath", function () {
    var q = BY["c-cb-poe"];
    // 题干按用户决定改写（任务书 5.2 节「溶液实际组成的点」的定义），整句锁住
    assert.equal(q.stem, "60℃ 时，把 80 g KNO₃ 完全溶解在 100 g 水里，然后慢慢降温到 20℃。先预测：图上表示溶液实际组成的点（溶液里实际溶解了多少溶质）会怎样移动？");
    var s60 = C.state("KNO3", 60, 100, 80), s20 = C.state("KNO3", 20, 100, 80);
    assert.equal(s60.status, "unsat");
    assert.equal(s20.status, "crystal");
    near(s20.precipitate, 48.4, "20℃ 析出", 1e-9);
    // 碰到曲线的温度：三次插值 47.58℃，直线插值 47.45℃；题里写「约 47℃」
    var Tc = C.tempForSolubility("KNO3", 80), Tl = C.tempForSolubility("KNO3", 80, true);
    near(Tc, 47.58, "三次插值", 0.005); near(Tl, 47.45, "直线插值", 0.005);
    assert.equal(Math.round(Tl), 47); assert.equal(Math.floor(Tc), 47);
    has(opt(q, "c").text, "约 47℃"); has(q.feedback.ref, "约 47℃");
    // 47.6℃ 之前没有晶体，之后有
    assert.equal(C.state("KNO3", 47.7, 100, 80).status, "unsat");
    assert.equal(C.state("KNO3", 47.5, 100, 80).status, "crystal");
    has(q.feedback.ref, "60℃ 时 KNO₃ 的溶解度是 " + S("KNO3", 60) + " g，80 g 溶得下");
    has(q.feedback.ref, "到 20℃ 时溶解度是 " + S("KNO3", 20) + " g，共析出 80 − 31.6 = " + r1(s20.precipitate) + " g");
    // 缩略图规则（view [0, 70, 0, 130]，KNO₃ 曲线 curvePoints(0, 66, 33) 浅色参照）：
    //   a 竖直向下 (60, 80)→(60, S(20))；b 沿曲线 curvePoints(60, 20, 40)；c = coolPath(80 g, 100 g, 60→20)；d 水平 (60, 80)→(20, 80)
    var REF = C.curvePoints("KNO3", 0, 66, 33);
    var COOL = C.coolPath("KNO3", 80, 100, 60, 20);
    var exp = { a: [[60, 80], [60, S("KNO3", 20)]], b: C.curvePoints("KNO3", 60, 20, 40), c: COOL, d: [[60, 80], [20, 80]] };
    q.answer.options.forEach(function (o) {
      var f = o.figure, ls = itemsOf(f, "polyline");
      assert.deepEqual(f.view, [0, 70, 0, 130], o.id + " view（与部件的实际结果图同一个）");
      assert.equal(f.axes.x, "T/℃"); assert.equal(f.axes.y, "g");
      assert.equal(ls.length, 2);
      assert.equal(ls[0].color, "muted");
      nearPts(ls[0].pts, REF, o.id + " 参照：KNO₃ 曲线");
      nearPts(ls[1].pts, exp[o.id], o.id + " 轨迹");
    });
    // 参照曲线不出视野（66℃ 约 126 g）
    assert.ok(REF[REF.length - 1][1] < 130 && REF[REF.length - 1][1] > 120);
    // 实际轨迹：溶液组成点 = min(80, S(T))，先水平（不饱和），碰到曲线后沿曲线下滑
    COOL.forEach(function (p) { near(p[1], r4(Math.min(80, S("KNO3", p[0]))), "轨迹 " + p[0] + "℃", EPS); });
    assert.deepEqual(COOL[0], [60, 80]); assert.deepEqual(COOL[COOL.length - 1], [20, 31.6]);
    var flat = COOL.filter(function (p) { return p[1] === 80; }).map(function (p) { return p[0]; });
    assert.ok(Math.min.apply(null, flat) > Tc - 1 && Math.min.apply(null, flat) <= 48, "水平段到约 48℃ 为止");
    var ok = q.answer.options.filter(function (o) { return JSON.stringify(lines(o.figure)[1]) === JSON.stringify(COOL); }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
  });

  it("c-cb-tt-percent：NaCl 20℃ 饱和溶液 36.0 ÷ 136.0 ≈ 26.5%（b）", function () {
    var q = BY["c-cb-tt-percent"];
    var Sn = S("NaCl", 20), w = C.saturatedFraction("NaCl", 20);
    has(q.stem, "溶解度是 " + Sn.toFixed(1) + " g");
    near(w, 36 / 136 * 100, "饱和质量分数");
    near(C.state("NaCl", 20, 100, Sn).fraction, w, "state 的质量分数", 1e-9);
    assert.equal(opt(q, "b").text, f1(w) + "%");
    assert.equal(opt(q, "a").text, String(Sn) + "%", "a 把溶解度当成百分数");
    assert.equal(opt(q, "c").text, Sn.toFixed(1) + " g");
    var ok = q.answer.options.filter(function (o) { return /%$/.test(o.text) && numIn(o.text) === r1(w); }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    has(q.feedback.ref, "36.0 ÷ (100 + 36.0) × 100% ≈ " + f1(w) + "%");
    noResultInReasons(q, [r1(w)]);
  });

  it("c-cb-tt-percent25：溶解度 25 g → 饱和溶液最多 25 ÷ 125 = 20% < 25%，配不出（a）", function () {
    var q = BY["c-cb-tt-percent25"];
    var max = 25 / (100 + 25) * 100;
    assert.equal(max, 20);
    // 与模型的饱和质量分数同一个算法：S ÷ (100 + S)
    near(C.saturatedFraction("KNO3", 20), 31.6 / 131.6 * 100, "saturatedFraction 的算法");
    assert.ok(max < 25);
    assert.equal(opt(q, q.answer.correct).text, "不能");
    has(q.feedback.ref, "25 ÷ 125 × 100% = " + max + "%，比 25% 小");
    noResultInReasons(q, [max, "125"]);
  });

  // 交点：三次插值 T ≈ 23.46℃、S ≈ 36.10 g
  var X = C.crossing();

  it("c-cb-tt-cross：交点 t ≈ 23.5℃；都饱和时质量分数相等，不饱和时不一定（b）；题图两条曲线 + 交点 + 「t」", function () {
    var q = BY["c-cb-tt-cross"];
    near(X.T, 23.46, "交点温度", 0.005); near(X.S, 36.10, "交点溶解度", 0.005);
    near(S("KNO3", X.T), S("NaCl", X.T), "交点处溶解度相等", 1e-6);
    var kSat = C.state("KNO3", X.T, 100, X.S), nSat = C.state("NaCl", X.T, 100, X.S);
    assert.deepEqual([kSat.status, nSat.status], ["sat", "sat"]);
    near(kSat.fraction, nSat.fraction, "都饱和 → 质量分数相等", 1e-6);
    var kUn = C.state("KNO3", X.T, 100, 20);
    assert.equal(kUn.status, "unsat");
    assert.ok(Math.abs(kUn.fraction - nSat.fraction) > 5, "一份不饱和 → 质量分数不同");
    assert.equal(opt(q, q.answer.correct).text, "不一定");
    q.reason.options.forEach(function (o) { assert.ok(!/\d/.test(o.text)); });
    // 题图：KNO₃、NaCl 曲线 curvePoints(0, 60, 30)；交点 (round(T), round(S))；交点到横轴的虚线；横轴上「t」；不写数值
    var f = q.figures[0], P = [r4(X.T), r4(X.S)];
    assert.deepEqual(f.view, [0, 60, 0, 120]);
    assert.deepEqual([f.axes.x, f.axes.y, f.axes.xt, f.axes.yt], ["温度/℃", "溶解度/g", [], []]);
    nearPts(lines(f)[0], C.curvePoints("KNO3", 0, 60, 30), "KNO₃");
    nearPts(lines(f)[1], C.curvePoints("NaCl", 0, 60, 30), "NaCl");
    assert.deepEqual(itemsOf(f, "point")[0].at, P);
    var s = itemsOf(f, "segment")[0];
    nearPts([s.a, s.b], [P, [P[0], 0]], "交点到横轴的虚线");
    assert.deepEqual(texts(f), ["t", "KNO₃", "NaCl"]);
    assert.deepEqual(itemsOf(f, "text")[0].at, [P[0], 0], "「t」标在横轴上交点的正下方");
    texts(f).forEach(function (t) { assert.ok(!/\d/.test(t), "题图不写数值：" + t); });
  });

  it("c-cb-tt-cool2cross：60℃ 的两份不饱和溶液降到交点温度，不一定都饱和 → 不一定相等（a）", function () {
    var q = BY["c-cb-tt-cool2cross"];
    // 例：KNO₃ 50 g、NaCl 30 g（60℃ 都不饱和）→ 交点温度时 KNO₃ 析出（饱和）、NaCl 仍不饱和 → 质量分数不同
    assert.equal(C.state("KNO3", 60, 100, 50).status, "unsat");
    assert.equal(C.state("NaCl", 60, 100, 30).status, "unsat");
    var k = C.state("KNO3", X.T, 100, 50), n = C.state("NaCl", X.T, 100, 30);
    assert.equal(k.status, "crystal"); assert.equal(n.status, "unsat");
    assert.ok(Math.abs(k.fraction - n.fraction) > 1);
    // 都饱和（KNO₃ 50 g、NaCl 37 g：60℃ 都不饱和，降到交点温度都有晶体）→ 相等
    assert.equal(C.state("NaCl", 60, 100, 37).status, "unsat");
    var n2 = C.state("NaCl", X.T, 100, 37);
    assert.equal(n2.status, "crystal");
    near(k.fraction, n2.fraction, "都饱和时相等", 1e-6);
    assert.equal(opt(q, q.answer.correct).text, "不一定");
    q.reason.options.forEach(function (o) { assert.ok(!/\d/.test(o.text)); });
  });

  it("c-cb-tt-nocrystal：40℃ 溶解度 63.9 g > 50 g，不析出（c）；a = 63.9 − 50，b = 110 − 63.9", function () {
    var q = BY["c-cb-tt-nocrystal"];
    var s = C.state("KNO3", 40, 100, 50);
    assert.equal(s.status, "unsat"); assert.equal(s.precipitate, 0);
    assert.equal(C.state("KNO3", 60, 100, 50).status, "unsat", "60℃ 时也是溶完的");
    near(numIn(opt(q, "a").text), r1(S("KNO3", 40) - 50), "a");
    near(numIn(opt(q, "b").text), r1(S("KNO3", 60) - S("KNO3", 40)), "b 把溶解度之差当析出量");
    assert.equal(opt(q, q.answer.correct).text, "没有");
    has(q.feedback.ref, "40℃ 时 KNO₃ 的溶解度是 " + S("KNO3", 40) + " g，比 50 g 大");
    noResultInReasons(q, [S("KNO3", 40), r1(S("KNO3", 40) - 50), r1(S("KNO3", 60) - S("KNO3", 40))]);
  });

  it("c-cb-tt-fridge：40℃ → 5℃，溶得少时仍不饱和、溶得多时析出 → 不一定（b）", function () {
    var q = BY["c-cb-tt-fridge"];
    var S5 = S("KNO3", 5);
    assert.ok(S5 > 13.3 && S5 < 20.9, "5℃ 的溶解度在表值 0℃、10℃ 之间");
    assert.equal(C.state("KNO3", 40, 100, 10).status, "unsat");
    assert.equal(C.state("KNO3", 5, 100, 10).status, "unsat", "10 g：降到 5℃ 仍不饱和");
    assert.equal(C.state("KNO3", 40, 100, 50).status, "unsat");
    assert.equal(C.state("KNO3", 5, 100, 50).status, "crystal", "50 g：降到 5℃ 析出");
    assert.equal(opt(q, q.answer.correct).text, "不一定");
    noResultInReasons(q, [r1(S5)]);
  });

  it("c-cb-tr-nacl：NaCl 60℃ 37.3 g 恰好饱和，降到 20℃ 析出 1.3 g（a）；b ≈ KNO₃ 的 48.4 g", function () {
    var q = BY["c-cb-tr-nacl"];
    assert.equal(C.state("NaCl", 60, 100, 37.3).status, "sat");
    var p = C.state("NaCl", 20, 100, 37.3).precipitate;
    near(p, 1.3, "析出", 1e-9);
    assert.equal(opt(q, "a").text, "约 " + f1(p) + " g");
    assert.equal(numIn(opt(q, "b").text), Math.round(C.state("KNO3", 20, 100, 80).precipitate), "b 照搬 KNO₃ 的析出量");
    var ok = q.answer.options.filter(function (o) { return /\d/.test(o.text) && numIn(o.text) === r1(p); }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    has(q.feedback.ref, "37.3 − 36.0 = " + f1(p) + " g");
    q.reason.options.forEach(function (o) { assert.ok(!/\d/.test(o.text)); });
  });

  it("c-cb-tr-evap：20℃ 饱和 NaCl 恒温蒸发 10 g 水，析出 3.6 g，质量分数不变（c）", function () {
    var q = BY["c-cb-tr-evap"];
    var before = C.state("NaCl", 20, 100, 36.0), after = C.state("NaCl", 20, 90, 36.0);
    assert.equal(before.status, "sat"); assert.equal(after.status, "crystal");
    near(after.precipitate, 3.6, "析出", 1e-9);
    near(after.precipitate, S("NaCl", 20) * 10 / 100, "10 g 水原来溶的量");
    near(after.fraction, before.fraction, "质量分数不变", 1e-9);
    assert.equal(opt(q, "c").text, "析出 " + f1(after.precipitate) + " g，质量分数不变");
    has(q.feedback.ref, "析出 " + f1(after.precipitate) + " g");
    has(q.feedback.ref, "约 " + f1(before.fraction) + "%");
    q.reason.options.forEach(function (o) { assert.ok(!/\d/.test(o.text)); });
  });

  it("c-cb-inv：20℃ 析出 33.4 g → 原来 31.6 + 33.4 = 65.0 g（b），且 60℃ 时不饱和", function () {
    var q = BY["c-cb-inv"];
    var m0 = S("KNO3", 20) + 33.4;
    near(m0, 65.0, "原来溶解的量", 1e-9);
    assert.equal(C.state("KNO3", 60, 100, m0).status, "unsat");
    // 逐个选项代回去：60℃ 不饱和、20℃ 析出 33.4 g 的只有 b
    var ok = q.answer.options.filter(function (o) {
      var mm = numIn(o.text);
      return C.state("KNO3", 60, 100, mm).status === "unsat" && Math.abs(C.state("KNO3", 20, 100, mm).precipitate - 33.4) < 1e-9;
    }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    assert.equal(opt(q, "b").text, m0.toFixed(1) + " g");
    assert.equal(numIn(opt(q, "c").text), S("KNO3", 60), "c 当成 60℃ 的饱和溶液");
    near(numIn(opt(q, "d").text), S("KNO3", 60) - S("KNO3", 20), "d 是 60℃ 饱和溶液降温的析出量", 1e-9);
    has(q.feedback.ref, "31.6 + 33.4 = " + m0.toFixed(1) + " g");
    has(q.feedback.ref, "60℃ 时的溶解度 " + S("KNO3", 60) + " g");
    noResultInReasons(q, [65, "65.0", S("KNO3", 20)]);
  });
});

/* ====================================================================== 2、3. C-C 反应后溶质成分 */
describe("C-C 反应后溶质成分：题里的结论和图由 chem-models.js 重新算出", function () {
  function ionSum(st) { return Object.keys(st.ions).reduce(function (s, k) { return s + st.ions[k]; }, 0); }
  // 选项里列的物质：「Ba(OH)₂ 和 BaSO₄」「NaCl、HCl」「只有 Ba(OH)₂」→ 排好序的数组
  function substances(s) {
    return String(s).replace(/^只有 /, "").split(/ 和 |、/).map(function (x) { return x.trim(); }).sort();
  }
  // 化学式里的原子数（Unicode 下标）：「Ca(OH)₂」→ {Ca: 1, O: 2, H: 2}；前面的系数「2HCl」乘进去
  var SUB = "₀₁₂₃₄₅₆₇₈₉";
  function atoms(f) {
    f = f.replace(/[↑↓]/g, "").replace(/[₀-₉]/g, function (ch) { return String(SUB.indexOf(ch)); }).trim();
    var mm = /^(\d*)(.*)$/.exec(f), coef = mm[1] ? +mm[1] : 1, s = mm[2], i = 0;
    function group() {
      var out = {};
      while (i < s.length && s[i] !== ")") {
        var part = {};
        if (s[i] === "(") { i++; part = group(); i++; }
        else { var el = /^[A-Z][a-z]?/.exec(s.slice(i)); assert.ok(el, "化学式写法：" + f); part[el[0]] = 1; i += el[0].length; }
        var nm = /^\d+/.exec(s.slice(i)), n = nm ? +nm[0] : 1;
        if (nm) i += nm[0].length;
        Object.keys(part).forEach(function (k) { out[k] = (out[k] || 0) + part[k] * n; });
      }
      return out;
    }
    var g = group();
    Object.keys(g).forEach(function (k) { g[k] *= coef; });
    return g;
  }
  function side(str) {
    var tot = {};
    str.split(" + ").forEach(function (f) { var a = atoms(f); Object.keys(a).forEach(function (k) { tot[k] = (tot[k] || 0) + a[k]; }); });
    return tot;
  }
  function balanced(eq) {
    var p = eq.split(" = ");
    var L = side(p[0]), R = side(p[1]);
    return JSON.stringify(Object.keys(L).sort().map(function (k) { return [k, L[k]]; })) ===
      JSON.stringify(Object.keys(R).sort().map(function (k) { return [k, R[k]]; }));
  }

  it("化学式解析自检：Ca(OH)₂ + 2HCl = CaCl₂ + 2H₂O 配平，Ca(OH)₂ + HCl = CaCl₂ + H₂O 不配平", function () {
    assert.deepEqual(atoms("Ca(OH)₂"), { Ca: 1, O: 2, H: 2 });
    assert.deepEqual(atoms("2H₂O"), { H: 4, O: 2 });
    assert.deepEqual(atoms("Na₂CO₃"), { Na: 2, C: 1, O: 3 });
    assert.ok(balanced("Ca(OH)₂ + 2HCl = CaCl₂ + 2H₂O"));
    assert.ok(!balanced("Ca(OH)₂ + HCl = CaCl₂ + H₂O"));
    assert.ok(balanced("Na₂CO₃ + 2HCl = 2NaCl + H₂O + CO₂↑"));
    assert.ok(balanced("Ba(OH)₂ + H₂SO₄ = BaSO₄↓ + 2H₂O"));
  });

  it("c-cc-poe：③ 恰好完全反应时四种离子都是 0（a）；① 恰好反应时 Na⁺、Cl⁻ 还在", function () {
    var q = BY["c-cc-poe"];
    var s3 = C.pairState(3, C.VEQ), s1 = C.pairState(1, C.VEQ);
    assert.equal(s3.stage, "equiv"); assert.equal(s3.pH, 7);
    assert.deepEqual(s3.ions, { "Ba²⁺": 0, "OH⁻": 0, "H⁺": 0, "SO₄²⁻": 0 });
    assert.equal(s3.precipitate["BaSO₄"], 10, "Ba²⁺、SO₄²⁻ 都进了沉淀");
    assert.deepEqual(s3.solutes, [], "没有溶质");
    assert.deepEqual([s1.ions["Na⁺"], s1.ions["Cl⁻"], s1.ions["H⁺"], s1.ions["OH⁻"]], [20, 20, 0, 0]);
    assert.equal(C.PAIRS[3].flask, "Ba(OH)₂ 溶液"); assert.equal(C.PAIRS[3].titrant, "稀硫酸");
    // 每个选项说的情况，在模型里成不成立：只有 a 成立
    var I = s3.ions;
    var claim = {
      a: ionSum(s3) === 0,
      b: I["Ba²⁺"] > 0 && I["SO₄²⁻"] > 0,
      c: I["H⁺"] > 0 && I["OH⁻"] > 0,
      d: I["Ba²⁺"] > 0 && I["SO₄²⁻"] > 0   // 「生成的盐的离子还在溶液里」：盐 BaSO₄ 的离子
    };
    var ok = Object.keys(claim).filter(function (k) { return claim[k]; });
    assert.deepEqual(ok, [q.answer.correct]);
    has(q.stem, "Ba(OH)₂"); has(q.stem, "BaSO₄"); has(q.stem, "pH = " + s3.pH);
    has(q.feedback.ref, "Na⁺ 和 Cl⁻ 还留在溶液里");
  });

  it("c-cc-tt-baso4：③ 在 V = 10 mL（a 点）pH > 7，溶质只有 Ba(OH)₂（c）；d 是过量以后的 H₂SO₄；题图 = phCurve(3)", function () {
    var q = BY["c-cc-tt-baso4"];
    var s = C.pairState(3, 10);
    assert.equal(s.stage, "before"); assert.ok(s.pH > 7);
    assert.deepEqual(s.solutes, ["Ba(OH)₂"]);
    assert.equal(s.precipitate["BaSO₄"], 5, "BaSO₄ 已经生成了，但它是沉淀");
    var ok = q.answer.options.filter(function (o) { return JSON.stringify(substances(o.text)) === JSON.stringify(s.solutes.slice().sort()); }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    assert.deepEqual(substances(opt(q, "d").text), C.pairState(3, 30).solutes, "d = 稀硫酸过量以后的溶质");
    ["a", "b"].forEach(function (id) { assert.ok(substances(opt(q, id).text).indexOf("BaSO₄") >= 0, id + " 把沉淀当溶质"); });
    var f = q.figures[0];
    assert.deepEqual(f.view, [0, 40, 0, 14]);
    assert.deepEqual([f.axes.x, f.axes.y], ["V/mL", "pH"]);
    nearPts(lines(f)[0], C.phCurve(3, 40, 0.5), "pH 曲线");
    assert.ok(lines(f)[0].some(function (p) { return p[0] === 20 && p[1] === 7; }), "曲线经过 (20, 7)");
    var P = itemsOf(f, "point")[0];
    assert.equal(P.label, "a");
    assert.deepEqual(P.at, [10, r4(s.pH)]);
    has(q.stem, "a 点"); has(q.stem, "pH > 7");
    q.reason.options.forEach(function (o) { assert.ok(!/\d/.test(o.text)); });
  });

  it("c-cc-tt-co2：④ 加到一半（V = 10 mL）盐酸有剩余，溶质 NaCl、HCl（b）；c 是 Na₂CO₃ 过量以后", function () {
    var q = BY["c-cc-tt-co2"];
    var s = C.pairState(4, C.VEQ / 2);
    assert.equal(s.stage, "before");
    assert.ok(s.ions["H⁺"] > 0, "盐酸有剩余");
    assert.equal(s.ions["CO₃²⁻"], 0, "加进去的 Na₂CO₃ 都反应完了");
    assert.ok(s.gas["CO₂"] > 0, "有气泡");
    assert.deepEqual(s.solutes, ["NaCl", "HCl"]);
    // 恰好反应前的任何时候都一样
    range(0.5, 19.5, 0.5).forEach(function (v) { assert.deepEqual(C.pairState(4, v).solutes, ["NaCl", "HCl"], "V = " + v); });
    var ok = q.answer.options.filter(function (o) { return JSON.stringify(substances(o.text)) === JSON.stringify(s.solutes.slice().sort()); }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    assert.deepEqual(substances(opt(q, "c").text), C.pairState(4, 30).solutes.slice().sort());
    assert.ok(substances(opt(q, "a").text).indexOf("CO₂") >= 0, "a 把气体当溶质");
    assert.equal(C.PAIRS[4].flask, "稀盐酸"); assert.equal(C.PAIRS[4].titrant, "Na₂CO₃ 溶液");
  });

  it("c-cc-tt-nacl：① ② 恰好完全反应时 Na⁺、Cl⁻ 各 20，H⁺、OH⁻ 都是 0（a）", function () {
    var q = BY["c-cc-tt-nacl"];
    [1, 2].forEach(function (id) {
      var s = C.pairState(id, C.VEQ);
      assert.deepEqual([s.ions["Na⁺"], s.ions["Cl⁻"], s.ions["H⁺"], s.ions["OH⁻"]], [20, 20, 0, 0], "试剂对 " + id);
      assert.deepEqual(s.solutes, ["NaCl"]);
      assert.ok(ionSum(s) > 0, "b「没有离子」不成立");
      assert.ok(!(s.ions["H⁺"] > 0), "c「只有少量 H⁺ 和 OH⁻」不成立");
    });
    assert.equal(opt(q, q.answer.correct).text, "有 Na⁺ 和 Cl⁻");
    has(q.feedback.ref, "NaCl 溶液");
  });

  it("c-cc-tt-cacl2：Ca(OH)₂ + 2HCl = CaCl₂ + 2H₂O 配平；蒸干留下 CaCl₂（b）", function () {
    var q = BY["c-cc-tt-cacl2"];
    var eq = /([A-Za-z0-9₀-₉()]+ \+ [A-Za-z0-9₀-₉()]+ = [A-Za-z0-9₀-₉()]+ \+ [A-Za-z0-9₀-₉()]+)/.exec(q.feedback.ref);
    assert.ok(eq, "参考解释里有化学方程式");
    assert.equal(eq[1], "Ca(OH)₂ + 2HCl = CaCl₂ + 2H₂O");
    assert.ok(balanced(eq[1]), "方程式配平");
    // 生成物里能溶于水、蒸干后留下的只有 CaCl₂（水蒸发掉）：变质探究里石灰水再加足量盐酸也是得到 CaCl₂
    assert.equal(C.runSequence("none", ["lime", "acid"]).tube.CaCl2, true);
    assert.equal(opt(q, q.answer.correct).text, "白色固体 CaCl₂");
  });

  it("c-cc-tt-phenol：完全变质的样品（只有 Na₂CO₃）直接滴酚酞也变红 → 不能说明有 NaOH（a）；参考的做法能区分", function () {
    var q = BY["c-cc-tt-phenol"];
    assert.equal(C.newTube("full").NaOH, false);
    ["none", "partial", "full"].forEach(function (s) {
      assert.equal(C.runSequence(s, ["phenol"]).steps[0].red, true, s + " 直接滴酚酞都变红");
    });
    // 参考：先加过量 CaCl₂ 除去 Na₂CO₃，再滴酚酞：红 ⇔ 有 NaOH
    ["none", "partial", "full"].forEach(function (s) {
      var r = C.runSequence(s, ["cacl2", "phenol"]);
      assert.equal(r.steps[1].red, !!C.SAMPLES[s].NaOH, s);
      assert.equal(r.steps[0].precipitate, !!C.SAMPLES[s].Na2CO3, s + " 有 Na₂CO₃ 才有沉淀");
    });
    assert.equal(opt(q, q.answer.correct).text, "不能");
    has(q.feedback.ref, "过量 CaCl₂ 溶液");
  });

  it("c-cc-tt-excesscarb：④ 滴过量（V > 20）pH > 7，溶质 NaCl、Na₂CO₃，没有 NaOH、HCl（c）", function () {
    var q = BY["c-cc-tt-excesscarb"];
    range(20.5, 40, 0.5).forEach(function (v) {
      var s = C.pairState(4, v);
      assert.ok(s.pH > 7, "V = " + v + " pH > 7");
      assert.deepEqual(s.solutes, ["NaCl", "Na₂CO₃"]);
      assert.equal(s.ions["H⁺"], 0);
      assert.ok(s.ions["CO₃²⁻"] > 0);
    });
    var s30 = C.pairState(4, 30);
    near(s30.pH, 11.16, "V = 30 mL", 0.005);
    var claim = {
      a: s30.solutes.indexOf("NaOH") >= 0,
      b: s30.solutes.indexOf("HCl") >= 0,
      c: s30.solutes.indexOf("Na₂CO₃") >= 0
    };
    assert.deepEqual(Object.keys(claim).filter(function (k) { return claim[k]; }), [q.answer.correct]);
    has(opt(q, "c").text, "Na₂CO₃");
    has(q.feedback.ref, "不会生成 NaOH");
  });

  it("c-cc-tr-little：NaOH 还在时几滴盐酸先和 NaOH 反应，没有气体 → 不能说明没变质（b）", function () {
    var q = BY["c-cc-tr-little"];
    // 部分变质（NaOH 2 份、Na₂CO₃ 2 份）：盐酸 ≤ 2 份时一点气体都没有，虽然有 Na₂CO₃
    [0.2, 0.5, 1, 2].forEach(function (a) { assert.equal(C.mixGas(a, 2, 2), 0, "盐酸 " + a + " 份"); });
    // 足量（≥ NaOH + 2 × Na₂CO₃）时 Na₂CO₃ 全部放出 CO₂
    assert.equal(C.mixGas(6, 2, 2), 2); assert.equal(C.mixGas(10, 2, 2), 2);
    assert.equal(C.runSequence("partial", ["acid"]).steps[0].bubbles, true, "足量稀盐酸有气泡");
    assert.equal(C.runSequence("full", ["acid"]).steps[0].bubbles, true);
    assert.equal(C.runSequence("none", ["acid"]).steps[0].bubbles, false);
    assert.equal(opt(q, q.answer.correct).text, "不能");
    has(q.feedback.ref, "足量的稀盐酸");
  });

  it("c-cc-tr-mix：缩略图 a = mixGasCurve(2, 2, 8, 8)（先平、再升、后平，正确）；b = (0, 2)；c = (0, 4) 一直上升", function () {
    var q = BY["c-cc-tr-mix"];
    var A = C.mixGasCurve(2, 2, 8, 8), B = C.mixGasCurve(0, 2, 8, 8), Cc = C.mixGasCurve(0, 4, 8, 8);
    assert.deepEqual(A, [[0, 0], [1, 0], [2, 0], [3, 0.5], [4, 1], [5, 1.5], [6, 2], [7, 2], [8, 2]]);
    assert.deepEqual(B, [[0, 0], [1, 0.5], [2, 1], [3, 1.5], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2]]);
    assert.deepEqual(Cc, [[0, 0], [1, 0.5], [2, 1], [3, 1.5], [4, 2], [5, 2.5], [6, 3], [7, 3.5], [8, 4]]);
    var exp = { a: A, b: B, c: Cc };
    q.answer.options.forEach(function (o) {
      var f = o.figure;
      assert.deepEqual(f.view, [0, 8, 0, 4.5]);
      assert.deepEqual([f.axes.x, f.axes.y, f.axes.xt, f.axes.yt], ["盐酸的质量", "气体的质量", [], []], "不写单位和刻度");
      nearPts(lines(f)[0], exp[o.id], o.id);
    });
    // 形状：a 开头一段 0、中间上升、最后不变；b 一开始就上升、最后不变；c 一直上升
    function shape(p) {
      var y = ys(p), d = []; for (var i = 1; i < y.length; i++) d.push(y[i] - y[i - 1]);
      return { flatStart: d[0] === 0, rises: d.some(function (x) { return x > 0; }), flatEnd: d[d.length - 1] === 0, always: d.every(function (x) { return x > 0; }) };
    }
    assert.deepEqual(shape(A), { flatStart: true, rises: true, flatEnd: true, always: false });
    assert.deepEqual(shape(B), { flatStart: false, rises: true, flatEnd: true, always: false });
    assert.deepEqual(shape(Cc), { flatStart: false, rises: true, flatEnd: false, always: true });
    // 混合溶液（NaOH > 0）的图象只有 a 那种：开头那段平线的长度 = NaOH 的份数
    var mixLike = q.answer.options.filter(function (o) { return shape(lines(o.figure)[0]).flatStart; }).map(function (o) { return o.id; });
    assert.deepEqual(mixLike, [q.answer.correct]);
    has(opt(q, "a").text, "开始一段没有气体"); has(opt(q, "c").text, "一直上升");
  });

  it("c-cc-inv：曲线 = 试剂对②（13 → 7 → 1.48），c 点 V = 30 mL 溶质 NaCl、HCl（c）；题图 = phCurve(2)", function () {
    var q = BY["c-cc-inv"];
    var s0 = C.pairState(2, 0), s20 = C.pairState(2, 20), s30 = C.pairState(2, 30), s40 = C.pairState(2, 40);
    near(s0.pH, 13, "起点", 1e-9); assert.equal(s20.pH, 7);
    assert.equal(r1(s40.pH), 1.5, "最后约为 1.5");
    has(q.stem, "开始时 pH ≈ 13"); has(q.stem, "在加入 20 mL 时 pH = 7"); has(q.stem, "最后约为 1.5"); has(q.stem, "加入 30 mL 时（c 点）");
    assert.ok(s30.pH < 7);
    assert.deepEqual(s30.solutes, ["NaCl", "HCl"]);
    // 选项「往 X 里滴 Y；c 点溶质…」→ 找对应的试剂对，曲线起点要是 pH ≈ 13、c 点溶质要和模型一样
    function parse(t) {
      var mm = /^往(.+?)里滴(.+?)；c 点溶质(?:是|只有) (.+)$/.exec(t);
      assert.ok(mm, "选项写法：" + t);
      var flask = mm[1].trim(), titrant = mm[2].trim();
      var pair = Object.keys(C.PAIRS).filter(function (k) { return C.PAIRS[k].flask === flask && C.PAIRS[k].titrant === titrant; })[0];
      assert.ok(pair, "找不到试剂对：" + t);
      return { pair: +pair, solutes: substances(mm[3]) };
    }
    var ok = q.answer.options.filter(function (o) {
      var p = parse(o.text);
      return Math.abs(C.pairState(p.pair, 0).pH - 13) < 0.01 && JSON.stringify(p.solutes) === JSON.stringify(C.pairState(p.pair, 30).solutes.slice().sort());
    }).map(function (o) { return o.id; });
    assert.deepEqual(ok, [q.answer.correct]);
    assert.equal(parse(opt(q, "a").text).pair, 1);
    assert.deepEqual(parse(opt(q, "a").text).solutes, C.pairState(1, 30).solutes.slice().sort(), "a 是 ① 在 30 mL 的溶质，但 ① 起点 pH = 1");
    assert.deepEqual(parse(opt(q, "b").text).solutes, C.pairState(2, 20).solutes, "b 是恰好完全反应时的溶质");
    has(q.feedback.ref, "试剂对②");
    assert.equal(parse(opt(q, q.answer.correct).text).pair, 2);
    // ③ 的 pH 曲线与 ② 完全一样，但选项里只有 HCl 和 NaOH 的两种操作，答案仍唯一
    [0, 10, 20, 30, 40].forEach(function (v) { near(C.pairState(3, v).pH, C.pairState(2, v).pH, "③ 与 ② 同曲线 V = " + v, 1e-9); });
    var f = q.figures[0];
    assert.deepEqual(f.view, [0, 40, 0, 14]);
    nearPts(lines(f)[0], C.phCurve(2, 40, 0.5), "pH 曲线");
    var P = itemsOf(f, "point")[0];
    assert.equal(P.label, "c");
    assert.deepEqual(P.at, [30, r4(s30.pH)]);
    var s = itemsOf(f, "segment")[0];
    nearPts([s.a, s.b], [[0, 7], [40, 7]], "pH = 7 的虚线");
    assert.equal(s.dash, true);
    noResultInReasons(q, ["NaCl 和 HCl"]);
  });

  it("文字：化学式、离子用 Unicode 上下标；不出现高中内容和代码写法", function () {
    CB.concat(CC).forEach(function (q) {
      var s = allText(q);
      assert.ok(!/[A-Za-z)][0-9]/.test(s), q.id + " 出现了 H2SO4 这类代码写法");
      assert.ok(!/[A-Z][a-z]?[+-](?![\s\d])/.test(s) && !/[A-Z][a-z]?\d?[+-]$/.test(s), q.id + " 出现了 Na+ 这类写法");
      assert.ok(s.indexOf("-") < 0, q.id + " 出现了 ASCII 减号");
      ["mol", "物质的量", "离子方程式", "电离", "水解", "Kb", "NaHCO₃"].forEach(function (w) {
        assert.ok(s.indexOf(w) < 0, q.id + " 出现了「" + w + "」");
      });
    });
  });
});

/* ====================================================================== 文字 */
describe("第 1 批 B 题库：文字", function () {
  it("题目能单独出现（重测页、小测）：不写「同上一题」「同样」「附图」", function () {
    NEW.forEach(function (q) {
      ["同上一题", "同样", "附图", "附 pH"].forEach(function (w) { assert.ok(allText(q).indexOf(w) < 0, q.id + " 出现了「" + w + "」"); });
    });
  });
  it("有题图的题，题干说「如图」或提到图里标的点", function () {
    NEW.filter(function (q) { return q.figures.length; }).forEach(function (q) {
      assert.ok(/如图|曲线如图|a 点/.test(q.stem), q.id);
    });
  });
});

/* ======================================================================
 * 正确选项的位置：每个模块按题库顺序，正确答案排在同一位置的题不超过一半（题数是奇数时向上取整），
 * 也不能连续 3 道落在同一位置；正确理由同样检查。与 tools/build-index.py 的 check_positions 是同一条规则。
 * ====================================================================== */
describe("第 1 批 B：正确选项的位置不集中", function () {
  function posOf(sec) {
    for (var i = 0; i < sec.options.length; i++) if (sec.options[i].id === sec.correct) return i;
    return -1;
  }
  Object.keys(MODULES).forEach(function (mod) {
    ["answer", "reason"].forEach(function (key) {
      it(mod + " 模块的" + (key === "answer" ? "正确答案" : "正确理由"), function () {
        var seq = MODULES[mod].bank.filter(function (q) { return !!q[key]; }).map(function (q) { return posOf(q[key]); });
        assert.ok(seq.length > 0 && seq.every(function (p) { return p >= 0; }));
        var limit = Math.ceil(seq.length / 2), counts = {};
        seq.forEach(function (p) { counts[p] = (counts[p] || 0) + 1; });
        Object.keys(counts).forEach(function (p) { assert.ok(counts[p] <= limit, "第 " + (+p + 1) + " 个有 " + counts[p] + " / " + seq.length + " 道"); });
        for (var i = 2; i < seq.length; i++) assert.ok(!(seq[i] === seq[i - 1] && seq[i] === seq[i - 2]), "连续 3 道在第 " + (seq[i] + 1) + " 个");
        assert.ok(Object.keys(counts).length >= 2);
      });
    });
  });
});
