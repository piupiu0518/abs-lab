/* shared/quiz/core.js 的单元测试（node --test tests/）。
 * 断言写的是 SPEC 的规则（5.3 判定、7.1 进错题本、7.2 重测排期、8 掌握门槛），不是照抄实现：
 * 以后改 core.js，只要这些测试还过，页面（engine.js、linker.js、review.html）的行为就没变。
 * 用到真实题库 shared/quiz/items/math-demo.json、标签库 shared/quiz/misconceptions.json，再加一些合成题，
 * 专门构造真实题库里碰不到的情况（高中题、带部件的重测题、多个标签等）。
 */
"use strict";
var describe = require("node:test").describe;
var it = require("node:test").it;
var assert = require("node:assert/strict");

var core = require("../shared/quiz/core.js");
var BANK = require("../shared/quiz/items/math-demo.json");
var LIB = require("../shared/quiz/misconceptions.json").tags;

// require 出来的 JSON 是共享对象：测试里一律先深拷贝再用，防止某个用例改坏后面的用例
function clone(o) { return JSON.parse(JSON.stringify(o)); }
var ITEMS = clone(BANK.items);
var BY = core.byId(ITEMS);
var POE = BY["m-dd-area-poe"];          // 题 1：预测关卡（有部件，不能重测），context 动点面积
var TT = BY["m-dd-st-twotier"];         // 题 2：二段式，context 距离—时间读图
var TR = BY["m-dd-area-transfer"];      // 题 3：迁移，context 动点面积
var INV = BY["m-dd-area-inverse"];      // 题 4：逆向，context 动点面积
// link-names.json 的 kps 由 build-index.py 生成，这里用固定的合成名称，测试不受生成结果影响
var NAMES = { "math:c22-2-2": { n: "画函数图象与读图", c: "第二十二章 函数" } };

var D = "2026-11-24"; // 「第 D 天」
function plus(n) { return core.addDays(D, n); }
// 同一天里的先后靠服务器时间 t
function at(day, hh) { return day + "T" + hh + ":00:00.000Z"; }
function att(day, cls, extra) {
  var a = { d: day, t: at(day, "04"), cls: cls, ch: "", rs: "", cf: "sure", tags: [], ex: "", mode: "practice" };
  Object.keys(extra || {}).forEach(function (k) { a[k] = extra[k]; });
  return a;
}
// recs([qid, attempt], …) → records（顺带用到 addAttempt）
function recs() {
  var r = {};
  for (var i = 0; i < arguments.length; i++) r = core.addAttempt(r, arguments[i][0], arguments[i][1]);
  return r;
}

// 合成题：答案 b、理由 r2 带错误概念标签（默认 tagaaaa），a / r1 是正确选项
function syn(id, o) {
  o = o || {};
  return {
    id: id,
    subject: o.subject || "math",
    module: o.module || "m1",
    type: o.type || "twotier",
    level: o.level || "junior",
    context: o.context || "c1",
    retest: o.retest === undefined ? true : o.retest,
    widget: o.widget || null,
    kp: o.kp || ["math:k1"],
    stem: o.stem || "合成题 " + id,
    answer: { options: [{ id: "a", text: "甲" }, { id: "b", text: "乙", mc: o.tag || "tagaaaa" }, { id: "c", text: "丙" }], correct: "a" },
    reason: o.noReason ? null : {
      options: [{ id: "r1", text: "理由一" }, { id: "r2", text: "理由二", mc: o.rtag || o.tag || "tagaaaa" }, { id: "r3", text: "理由三" }],
      correct: "r1"
    },
    feedback: { ref: "参考解释 " + id }
  };
}
var SYN_LIB = {
  tagaaaa: { name: "甲概念", subject: "math", kp: ["math:k1", "math:k2"], refute: "反驳甲" },
  // 主学科是物理，kp 列表里第一个却是数学的：进错题本时应取「主学科里的第一个 kp」
  tagbbbb: { name: "乙概念", subject: "physics", kp: ["math:k9", "physics:p1", "physics:p2"], refute: "反驳乙" },
  tagcccc: { name: "丙概念", subject: "math", kp: ["math:k3"], refute: "反驳丙" }
};

// 错题本条目的 question 应为「前缀 + 题干前 60 字」（超长时实现可以在后面加省略号）
function assertQuestion(q, prefix, stem) {
  assert.equal(q.indexOf(prefix), 0, "question 前缀不对：" + q);
  var rest = q.slice(prefix.length);
  var s = stem.replace(/\s+/g, " ").trim();
  if (s.length <= 60) assert.equal(rest, s);
  else {
    assert.equal(rest.slice(0, 60), s.slice(0, 60));
    assert.ok(rest.length === 60 || rest.length === 61, "题干截取过长：" + rest);
  }
}
var MISTAKE_ID_RE = /^[a-z]{2,10}-[a-z0-9]{6,32}$/; // api/mistakes.js 的 ID_RE

/* ================================================================ */
describe("classify：5.3 判定表", function () {
  var T = syn("syn-tt", { tag: "tagaaaa", rtag: "tagcccc" });
  // 再加一个「答案 c 带 tagbbbb、理由 r2 也带 tagbbbb」的变体，测合并去重
  var T2 = syn("syn-tt2", { rtag: "tagbbbb" });
  T2.answer.options[2].mc = "tagbbbb";
  function cls(item, ch, rs, cf) { return core.classify(item, { ch: ch, rs: rs, cf: cf }); }

  it("答案对 + 理由对 + 有把握 → pass，无标签", function () {
    assert.deepEqual(cls(T, "a", "r1", "sure"), { cls: "pass", ans: true, rsn: true, tags: [] });
  });
  it("答案对 + 理由对 + 没把握 → unsure（不算通过）", function () {
    assert.deepEqual(cls(T, "a", "r1", "unsure"), { cls: "unsure", ans: true, rsn: true, tags: [] });
  });
  it("答案对 + 理由错 + 有把握 → mc，标签取所选错误理由上的", function () {
    assert.deepEqual(cls(T, "a", "r2", "sure"), { cls: "mc", ans: true, rsn: false, tags: ["tagcccc"] });
  });
  it("答案对 + 理由错 + 没把握 → 仍是 mc（理由错不论把握）", function () {
    assert.deepEqual(cls(T, "a", "r2", "unsure"), { cls: "mc", ans: true, rsn: false, tags: ["tagcccc"] });
  });
  it("答案错 + 有把握 → mc，标签取所选错误答案上的", function () {
    assert.deepEqual(cls(T, "b", "r1", "sure"), { cls: "mc", ans: false, rsn: true, tags: ["tagaaaa"] });
  });
  it("答案错 + 没把握 → gap（标签照样带出，供进错题本按概念聚合）", function () {
    assert.deepEqual(cls(T, "b", "r1", "unsure"), { cls: "gap", ans: false, rsn: true, tags: ["tagaaaa"] });
    assert.deepEqual(cls(T, "c", "r1", "unsure"), { cls: "gap", ans: false, rsn: true, tags: [] });
  });
  it("答案错 + 理由错：标签是两者的并集", function () {
    assert.deepEqual(cls(T, "b", "r2", "sure"), { cls: "mc", ans: false, rsn: false, tags: ["tagaaaa", "tagcccc"] });
    assert.deepEqual(cls(T, "b", "r2", "unsure"), { cls: "gap", ans: false, rsn: false, tags: ["tagaaaa", "tagcccc"] });
  });
  it("答案和理由上是同一个标签：去重", function () {
    assert.deepEqual(cls(T2, "c", "r2", "sure").tags, ["tagbbbb"]);
    assert.deepEqual(cls(T2, "b", "r2", "sure").tags, ["tagaaaa", "tagbbbb"]);
  });
  it("判为 mc 但选项上没有标签 → gap", function () {
    // 答案错（c 无标签）、有把握
    assert.deepEqual(cls(T, "c", "r1", "sure"), { cls: "gap", ans: false, rsn: true, tags: [] });
    // 答案对、理由错（r3 无标签），有把握和没把握都一样
    assert.deepEqual(cls(T, "a", "r3", "sure"), { cls: "gap", ans: true, rsn: false, tags: [] });
    assert.deepEqual(cls(T, "a", "r3", "unsure"), { cls: "gap", ans: true, rsn: false, tags: [] });
    // 没选答案也不会凭空出现标签
    assert.equal(cls(T, undefined, "r1", "sure").cls, "gap");
  });
  it("只取「选错了的」选项上的标签：正确选项上即使有 mc 也不算", function () {
    var W = syn("syn-weird", { rtag: "tagcccc" });
    W.answer.options[0].mc = "tagbbbb"; // 正确答案 a 上挂了标签（不该出现，但规则要稳）
    W.reason.options[0].mc = "tagbbbb"; // 正确理由 r1 上也挂了
    assert.deepEqual(cls(W, "a", "r2", "sure").tags, ["tagcccc"]);
    assert.deepEqual(cls(W, "a", "r1", "sure"), { cls: "pass", ans: true, rsn: true, tags: [] });
    assert.deepEqual(cls(W, "b", "r1", "sure").tags, ["tagaaaa"]);
  });
  it("没有理由这一段的题：只看答案和把握，rs 被忽略", function () {
    var N = syn("syn-noreason", { noReason: true });
    assert.deepEqual(cls(N, "a", "", "sure"), { cls: "pass", ans: true, rsn: true, tags: [] });
    assert.deepEqual(cls(N, "a", "r9", "sure"), { cls: "pass", ans: true, rsn: true, tags: [] });
    assert.deepEqual(cls(N, "a", "", "unsure"), { cls: "unsure", ans: true, rsn: true, tags: [] });
    assert.deepEqual(cls(N, "b", "", "sure"), { cls: "mc", ans: false, rsn: true, tags: ["tagaaaa"] });
    assert.deepEqual(cls(N, "b", "", "unsure"), { cls: "gap", ans: false, rsn: true, tags: ["tagaaaa"] });
    assert.deepEqual(cls(N, "c", "", "sure"), { cls: "gap", ans: false, rsn: true, tags: [] });
  });
  it("真实题库：题 1（预测，无理由）", function () {
    assert.equal(cls(POE, "a", "", "sure").cls, "pass");
    assert.equal(cls(POE, "a", "", "unsure").cls, "unsure");
    assert.deepEqual(cls(POE, "b", "", "sure").tags, ["graphaspath"]);
    assert.equal(cls(POE, "b", "", "sure").cls, "mc");
    assert.equal(cls(POE, "d", "", "sure").cls, "gap"); // d 没有标签
    assert.deepEqual(cls(POE, "c", "", "unsure"), { cls: "gap", ans: false, rsn: true, tags: ["graphaspath"] });
  });
  it("真实题库：题 2（二段式）", function () {
    assert.equal(cls(TT, "b", "r2", "sure").cls, "pass");
    assert.equal(cls(TT, "b", "r2", "unsure").cls, "unsure");
    assert.deepEqual(cls(TT, "a", "r1", "sure"), { cls: "mc", ans: false, rsn: false, tags: ["graphaspath"] });
    assert.deepEqual(cls(TT, "b", "r1", "unsure"), { cls: "mc", ans: true, rsn: false, tags: ["graphaspath"] });
    assert.deepEqual(cls(TT, "b", "r3", "sure"), { cls: "gap", ans: true, rsn: false, tags: [] });
    assert.deepEqual(cls(TT, "d", "r3", "unsure"), { cls: "gap", ans: false, rsn: false, tags: [] });
  });
});

/* ================================================================ */
describe("schedule / manualStatus：7.2 重测排期", function () {
  it("间隔集中在一个常量里：[1, 3, 7, 14]", function () {
    assert.deepEqual(core.INTERVALS, [1, 3, 7, 14]);
  });
  it("newReview：step 0，明天到期", function () {
    assert.deepEqual(core.newReview(D), { step: 0, due: plus(1), last: D, stable: false, hist: [] });
  });
  it("pass 逐档推进：step 0→1→2→3，due = 今天 +3 / +7 / +14，第一次通过 status 0→1", function () {
    var r = core.newReview(D), st = 0, day = D, res;
    var expect = [[1, 3], [2, 7], [3, 14]];
    expect.forEach(function (e, i) {
      res = core.schedule(r, st, "pass", day);
      assert.equal(res.review.step, e[0]);
      assert.equal(res.review.due, core.addDays(day, e[1]));
      assert.equal(res.review.last, day);
      assert.equal(res.status, 1, "第 " + (i + 1) + " 次通过后应为已订正");
      r = res.review; st = res.status; day = res.review.due;
    });
    // 通过最后一档（14 天那一档）：不再安排，已掌握
    res = core.schedule(r, st, "pass", day);
    assert.equal(res.review.due, "");
    assert.equal(res.status, 2);
    assert.equal(res.review.last, day);
    assert.equal(core.isDue(res.review, "2099-12-31"), false);
  });
  it("已订正（status 1）再通过：仍是 1，不会提前变成已掌握", function () {
    var res = core.schedule({ step: 1, due: D }, 1, "pass", D);
    assert.equal(res.status, 1);
    assert.equal(res.review.step, 2);
  });
  it("unsure：step 不变，due = 今天 +1，状态不变（不算通过）", function () {
    var res = core.schedule({ step: 2, due: D, last: plus(-7) }, 1, "unsure", D);
    assert.equal(res.review.step, 2);
    assert.equal(res.review.due, plus(1));
    assert.equal(res.review.last, D);
    assert.equal(res.status, 1);
    var res0 = core.schedule(core.newReview(plus(-1)), 0, "unsure", D);
    assert.equal(res0.review.step, 0);
    assert.equal(res0.status, 0, "没把握不能把未订正改成已订正");
  });
  ["mc", "gap"].forEach(function (c) {
    it(c + "：step 归零，due = 今天 +1，status → 0", function () {
      var res = core.schedule({ step: 3, due: D, stable: true }, 1, c, D);
      assert.equal(res.review.step, 0);
      assert.equal(res.review.due, plus(1));
      assert.equal(res.status, 0);
      assert.equal(res.review.stable, true, "排期不改稳定迷思标记");
      var res2 = core.schedule({ step: 4, due: "" }, 2, c, D);
      assert.equal(res2.status, 0, "已掌握后又错：回到未订正");
      assert.equal(res2.review.due, plus(1));
    });
  });
  it("不改传入的 review 对象", function () {
    var r = { step: 1, due: D, last: plus(-3), stable: false, hist: [{ d: plus(-3), qid: "m-dd-st-twotier", cls: "pass" }] };
    var snap = clone(r);
    core.schedule(r, 1, "pass", D);
    core.schedule(r, 1, "mc", D);
    assert.deepEqual(r, snap);
  });
  it("review 缺失或不合格时按新的处理", function () {
    var res = core.schedule(null, undefined, "pass", D);
    assert.equal(res.review.step, 1);
    assert.equal(res.review.due, plus(3));
    assert.equal(res.status, 1);
    assert.equal(core.schedule({ step: "x", due: "bad" }, 0, "unsure", D).review.step, 0);
  });
  it("manualStatus(…, 2)：手动标为已掌握 → due 为空，停止安排", function () {
    var r = core.manualStatus({ step: 1, due: plus(3), last: D }, 2, D);
    assert.equal(r.due, "");
    assert.equal(r.step, 1);
    assert.equal(core.isDue(r, "2099-12-31"), false);
    var m = { id: "mc-graphaspath", origin: "quiz", status: 2, subject: "math", review: r };
    assert.deepEqual(core.dueList([m], "2099-12-31", LIB, ITEMS), []);
    assert.equal(core.nextDue([m], D, LIB), null);
  });
  it("manualStatus：从已掌握改回未订正 / 已订正且 due 为空 → 明天接着测；已有 due 不动", function () {
    assert.equal(core.manualStatus({ step: 2, due: "" }, 1, D).due, plus(1));
    assert.equal(core.manualStatus({ step: 2, due: "" }, 0, D).due, plus(1));
    assert.equal(core.manualStatus({ step: 2, due: plus(5) }, 0, D).due, plus(5));
  });
});

/* ================================================================ */
describe("stableFor：稳定迷思", function () {
  var S1 = syn("syn-s1", { context: "ctxA" });
  var S2 = syn("syn-s2", { context: "ctxA" });
  var S3 = syn("syn-s3", { context: "ctxB" });
  var items = [S1, S2, S3];
  var mcA = function (day) { return att(day, "mc", { tags: ["tagaaaa"] }); };

  it("两道 context 相同的题都 mc → 不算", function () {
    assert.equal(core.stableFor("tagaaaa", recs(["syn-s1", mcA(D)], ["syn-s2", mcA(plus(1))]), items), false);
  });
  it("两道 context 不同的题都 mc → 算", function () {
    assert.equal(core.stableFor("tagaaaa", recs(["syn-s1", mcA(D)], ["syn-s3", mcA(plus(1))]), items), true);
  });
  it("同一道题错两次 → 不算（错一次 / 同一题反复错都不能定为稳定迷思）", function () {
    assert.equal(core.stableFor("tagaaaa", recs(["syn-s1", mcA(D)], ["syn-s1", mcA(plus(1))]), items), false);
    assert.equal(core.stableFor("tagaaaa", recs(["syn-s1", mcA(D)]), items), false);
  });
  it("只有 mc 才算：gap（即使带标签）、别的标签的 mc 都不算", function () {
    var r = recs(["syn-s1", mcA(D)], ["syn-s3", att(D, "gap", { tags: ["tagaaaa"] })]);
    assert.equal(core.stableFor("tagaaaa", r, items), false);
    var r2 = recs(["syn-s1", mcA(D)], ["syn-s3", att(D, "mc", { tags: ["tagcccc"] })]);
    assert.equal(core.stableFor("tagaaaa", r2, items), false);
  });
  it("题库里找不到的题不算", function () {
    assert.equal(core.stableFor("tagaaaa", recs(["syn-s1", mcA(D)], ["gone-item", mcA(D)]), items), false);
  });
  it("真实题库：题 1 + 题 3（都是动点面积）→ false；题 1 + 题 2（距离—时间读图）→ true", function () {
    var g = function (day) { return att(day, "mc", { tags: ["graphaspath"] }); };
    assert.equal(core.stableFor("graphaspath", recs([POE.id, g(D)], [TR.id, g(plus(1))]), ITEMS), false);
    assert.equal(core.stableFor("graphaspath", recs([POE.id, g(D)], [INV.id, g(plus(1))], [TR.id, g(plus(2))]), ITEMS), false);
    assert.equal(core.stableFor("graphaspath", recs([POE.id, g(D)], [TT.id, g(plus(1))]), ITEMS), true);
  });
});

/* ================================================================ */
describe("levelAllowed：初中 / 高中", function () {
  function lv(subject, level) { return { id: "x-" + subject, subject: subject, level: level }; }
  var ALL_ON = { physics: true, chemistry: true, math: true, biology: true };
  it("初中题（或没写 level）总是允许", function () {
    ["physics", "chemistry", "math", "biology"].forEach(function (s) {
      assert.equal(core.levelAllowed(lv(s, "junior"), {}), true);
      assert.equal(core.levelAllowed(lv(s, undefined), undefined), true);
    });
  });
  it("物理、化学的高中题：只有该科开关开着才出", function () {
    assert.equal(core.levelAllowed(lv("physics", "senior"), { physics: true }), true);
    assert.equal(core.levelAllowed(lv("physics", "senior"), { physics: false }), false);
    assert.equal(core.levelAllowed(lv("physics", "senior"), { chemistry: true }), false);
    assert.equal(core.levelAllowed(lv("physics", "senior"), undefined), false);
    assert.equal(core.levelAllowed(lv("chemistry", "senior"), { chemistry: true }), true);
    assert.equal(core.levelAllowed(lv("chemistry", "senior"), { physics: true }), false);
  });
  it("数学、生物的高中题：一律不出", function () {
    assert.equal(core.levelAllowed(lv("math", "senior"), ALL_ON), false);
    assert.equal(core.levelAllowed(lv("biology", "senior"), ALL_ON), false);
  });
});

/* ================================================================ */
describe("pickRetest：选重测题", function () {
  // P：带这个标签、但不能重测的预测关卡（context c1），学生最近一次做的就是它
  var P = syn("zz-pred", { context: "c1", retest: false, widget: "math-dd-area", type: "predict" });
  var lastP = function () { return [P.id, att(D, "mc", { tags: ["tagaaaa"], t: at(D, "09") })]; };

  it("优先选 context 与该标签最近一次作答的题不同的（即使 id 靠后、即使最近做过）", function () {
    var Q1 = syn("aa-same", { context: "c1" });
    var Q2 = syn("bb-diff", { context: "c2" });
    var items = [P, Q1, Q2];
    assert.equal(core.pickRetest("tagaaaa", items, recs(lastP()), {}).id, "bb-diff");
    // Q2 当天早些时候做过、Q1 从没做过：仍然先换情境
    var r = recs([Q2.id, att(D, "pass", { t: at(D, "01") })], lastP());
    assert.equal(core.pickRetest("tagaaaa", items, r, {}).id, "bb-diff");
    // 完全没有记录：不分情境，按 id
    assert.equal(core.pickRetest("tagaaaa", items, {}, {}).id, "aa-same");
  });
  it("「最近一次」先比日期 d，同一天再比服务器时间 t", function () {
    var Q1 = syn("q1-item", { context: "c1" });
    var Q2 = syn("q2-item", { context: "c2" });
    var Q3 = syn("q3-item", { context: "c2" });
    var items = [Q1, Q2, Q3];
    var r = recs([Q1.id, att(D, "mc", { t: at(D, "10") })], [Q2.id, att(D, "mc", { t: at(D, "11") })]);
    assert.equal(core.pickRetest("tagaaaa", items, r, {}).id, "q1-item"); // 最近是 Q2（c2）→ 选 c1
    var r2 = recs([Q1.id, att(D, "mc", { t: at(D, "12") })], [Q2.id, att(D, "mc", { t: at(D, "11") })]);
    assert.equal(core.pickRetest("tagaaaa", items, r2, {}).id, "q3-item"); // 最近是 Q1（c1）→ c2 里没做过的 Q3
    // 日期比时间优先：Q2 的 d 更晚，即使 t 更早
    var r3 = recs([Q1.id, att(D, "mc", { t: at(D, "23") })], [Q2.id, att(plus(1), "mc", { t: at(D, "01") })]);
    assert.equal(core.pickRetest("tagaaaa", items, r3, {}).id, "q1-item");
  });
  it("排除 retest:false 的题", function () {
    var R1 = syn("r1-item", { context: "c1" });
    var R2 = syn("r2-item", { context: "c2", retest: false });
    assert.equal(core.pickRetest("tagaaaa", [P, R1, R2], recs(lastP()), {}).id, "r1-item");
    assert.equal(core.pickRetest("tagaaaa", [P, R2], recs(lastP()), {}), null);
    var R3 = syn("r3-item", { context: "c2" });
    delete R3.retest; // 没写 retest 也不能重测（必须明确 true）
    assert.equal(core.pickRetest("tagaaaa", [P, R3], recs(lastP()), {}), null);
  });
  it("排除带交互部件的题（即使 retest 误写成 true）", function () {
    var W = syn("w-item", { context: "c2", widget: "math-dd-area" });
    var R1 = syn("r1-item", { context: "c1" });
    assert.equal(core.pickRetest("tagaaaa", [P, W, R1], recs(lastP()), {}).id, "r1-item");
    assert.equal(core.pickRetest("tagaaaa", [P, W], recs(lastP()), {}), null);
  });
  it("排除不允许的高中题：物理 / 化学看开关，数学 / 生物一律不出", function () {
    var SP = syn("sp-item", { context: "c2", subject: "physics", level: "senior" });
    var SC = syn("sc-item", { context: "c2", subject: "chemistry", level: "senior" });
    var SM = syn("sm-item", { context: "c2", subject: "math", level: "senior" });
    var SB = syn("sb-item", { context: "c2", subject: "biology", level: "senior" });
    var r = recs(lastP());
    assert.equal(core.pickRetest("tagaaaa", [P, SP], r, { hs: { physics: true } }).id, "sp-item");
    assert.equal(core.pickRetest("tagaaaa", [P, SP], r, { hs: { physics: false } }), null);
    assert.equal(core.pickRetest("tagaaaa", [P, SP], r, { hs: { chemistry: true } }), null);
    assert.equal(core.pickRetest("tagaaaa", [P, SP], r, {}), null);
    assert.equal(core.pickRetest("tagaaaa", [P, SP], r), null);
    assert.equal(core.pickRetest("tagaaaa", [P, SC], r, { hs: { chemistry: true } }).id, "sc-item");
    assert.equal(core.pickRetest("tagaaaa", [P, SC], r, { hs: { physics: true } }), null);
    var everything = { hs: { physics: true, chemistry: true, math: true, biology: true } };
    assert.equal(core.pickRetest("tagaaaa", [P, SM, SB], r, everything), null);
    // 高中题被排除时退到别的可用题
    var J = syn("j-item", { context: "c1" });
    assert.equal(core.pickRetest("tagaaaa", [P, SM, J], r, everything).id, "j-item");
  });
  it("情境相同时：最久没做过的优先（没做过的最先），再按 id", function () {
    var Y1 = syn("y1-item", { context: "c2" });
    var Y2 = syn("y2-item", { context: "c2" });
    var Y3 = syn("y3-item", { context: "c2" });
    var Y0 = syn("y0-item", { context: "c2" });
    var base = [[Y1.id, att(plus(-3), "pass")], [Y2.id, att(plus(-5), "pass")], lastP()];
    assert.equal(core.pickRetest("tagaaaa", [P, Y1, Y2, Y3, Y0], recs.apply(null, base), {}).id, "y0-item");
    assert.equal(core.pickRetest("tagaaaa", [P, Y1, Y2], recs.apply(null, base), {}).id, "y2-item");
    // 「最久没做过」看的是每道题最近一次：Y2 前天又做了一次，就轮到 Y1
    var more = base.concat([[Y2.id, att(plus(-2), "pass")]]);
    assert.equal(core.pickRetest("tagaaaa", [P, Y1, Y2], recs.apply(null, more), {}).id, "y1-item");
    // 同一天：比时间
    var same = [[Y1.id, att(plus(-3), "pass", { t: at(plus(-3), "08") })], [Y2.id, att(plus(-3), "pass", { t: at(plus(-3), "07") })], lastP()];
    assert.equal(core.pickRetest("tagaaaa", [P, Y1, Y2], recs.apply(null, same), {}).id, "y2-item");
    // 完全并列：按 id
    var Z2 = syn("zb-item", { context: "c2" }), Z1 = syn("za-item", { context: "c2" });
    assert.equal(core.pickRetest("tagaaaa", [P, Z2, Z1], recs(lastP()), {}).id, "za-item");
  });
  it("只在带这个标签的题里选；没有可用题 → null", function () {
    var other = syn("o-item", { context: "c2", tag: "tagcccc" });
    assert.equal(core.pickRetest("tagaaaa", [P, other], recs(lastP()), {}), null);
    assert.equal(core.pickRetest("vertexismax", ITEMS, {}, {}), null);
  });
  it("key 为 q:<题目 id>：能重测就返回这道题，否则 null", function () {
    assert.equal(core.pickRetest("q:" + TT.id, ITEMS, {}, {}).id, TT.id);
    assert.equal(core.pickRetest("q:" + POE.id, ITEMS, {}, {}), null); // 有部件、retest:false
    assert.equal(core.pickRetest("q:no-such-item", ITEMS, {}, {}), null);
    var SM = syn("sm-item", { subject: "math", level: "senior" });
    assert.equal(core.pickRetest("q:sm-item", [SM], {}, { hs: { math: true } }), null);
  });
  it("真实题库：题 1 答错之后重测出的是题 2（换情境），不是题 1", function () {
    var r = recs([POE.id, att(D, "mc", { ch: "b", tags: ["graphaspath"], mode: "poe" })]);
    assert.equal(core.pickRetest("graphaspath", ITEMS, r, { hs: {} }).id, TT.id);
  });
  it("不改传入的题目和记录", function () {
    var items = clone(ITEMS), r = recs([POE.id, att(D, "mc", { tags: ["graphaspath"] })]);
    var si = clone(items), sr = clone(r);
    core.pickRetest("graphaspath", items, r, {});
    assert.deepEqual(items, si);
    assert.deepEqual(r, sr);
  });
});

/* ================================================================ */
describe("interleave：交错", function () {
  // 条目 = { key, item:{ subject, module } }；名字的第一个字母代表 module
  function E(key, subject, module) { return { key: key, item: { id: key, subject: subject || "math", module: module || key.charAt(0) } }; }
  function keys(list) { return list.map(function (e) { return e.key; }); }
  function modOf(e) { return e.item.subject + "/" + e.item.module; }
  function sameAdj(list) {
    var n = 0;
    for (var i = 1; i < list.length; i++) if (modOf(list[i]) === modOf(list[i - 1])) n++;
    return n;
  }
  // 不可避免的相邻同 module 对数：最多的一类有 k 个、总数 n 时至少 max(0, 2k − n − 1)
  function minSameAdj(list) {
    var c = {}, k = 0;
    list.forEach(function (e) { c[modOf(e)] = (c[modOf(e)] || 0) + 1; k = Math.max(k, c[modOf(e)]); });
    return Math.max(0, 2 * k - list.length - 1);
  }

  it("[A, A, B] → A B A", function () {
    assert.deepEqual(keys(core.interleave([E("a1"), E("a2"), E("b1")], 10)), ["a1", "b1", "a2"]);
  });
  it("[B, A, A] → A B A（多的一类先出，才排得开）", function () {
    assert.deepEqual(keys(core.interleave([E("b1"), E("a1"), E("a2")], 10)), ["a1", "b1", "a2"]);
  });
  it("[A, A, A, B, B] → A B A B A", function () {
    assert.deepEqual(keys(core.interleave([E("a1"), E("a2"), E("a3"), E("b1"), E("b2")], 10)), ["a1", "b1", "a2", "b2", "a3"]);
  });
  it("[A, A, B, B, C] 相邻都不同", function () {
    var out = core.interleave([E("a1"), E("a2"), E("b1"), E("b2"), E("c1")], 10);
    assert.equal(sameAdj(out), 0);
  });
  it("排不开时照样给出全部题目，相邻同 module 尽量少", function () {
    assert.deepEqual(keys(core.interleave([E("a1"), E("a2")], 10)), ["a1", "a2"]);
    var out = core.interleave([E("a1"), E("a2"), E("a3"), E("b1")], 10);
    assert.equal(out.length, 4);
    assert.equal(sameAdj(out), 1);
  });
  it("穷举 3 个 module、长度 1–7 的全部输入：相邻同 module 的对数都达到下限，输出是输入的重排", function () {
    var letters = ["a", "b", "c"];
    for (var n = 1; n <= 7; n++) {
      var total = Math.pow(3, n);
      for (var code = 0; code < total; code++) {
        var x = code, list = [];
        for (var i = 0; i < n; i++) { list.push(E(letters[x % 3] + i)); x = Math.floor(x / 3); }
        var out = core.interleave(list, 10);
        assert.equal(out.length, n);
        assert.deepEqual(keys(out).slice().sort(), keys(list).slice().sort());
        assert.equal(sameAdj(out), minSameAdj(list), "输入 " + keys(list).join(",") + " 输出 " + keys(out).join(","));
      }
    }
  });
  it("不同学科算不同类：module 名相同、学科不同的题也会被隔开（退到不同学科）", function () {
    var out = core.interleave([E("m1", "math", "demo"), E("m2", "math", "demo"), E("p1", "physics", "demo")], 10);
    assert.deepEqual(out.map(function (e) { return e.item.subject; }), ["math", "physics", "math"]);
    var out2 = core.interleave([E("m1", "math", "x"), E("m2", "math", "x"), E("m3", "math", "x"), E("p1", "physics", "x"), E("c1", "chemistry", "x")], 10);
    assert.equal(sameAdj(out2), 0);
  });
  it("结果确定：同样的输入两次给出同样的输出，且不改输入数组", function () {
    var input = [E("b1"), E("a1"), E("c1"), E("a2"), E("b2"), E("a3"), E("c2")];
    var snap = keys(input);
    var o1 = keys(core.interleave(input, 10));
    var o2 = keys(core.interleave(input, 10));
    assert.deepEqual(o1, o2);
    assert.deepEqual(keys(input), snap);
    // 并列时按输入顺序
    assert.deepEqual(keys(core.interleave([E("b1"), E("a1")], 10)), ["b1", "a1"]);
    assert.deepEqual(keys(core.interleave([E("a1"), E("b1")], 10)), ["a1", "b1"]);
  });
  it("一次最多 10 题：取前 10 个再排；不给 limit 也按 10", function () {
    var list = [];
    for (var i = 0; i < 12; i++) list.push(E((i % 2 ? "b" : "a") + i));
    var out = core.interleave(list, 10);
    assert.equal(out.length, 10);
    assert.deepEqual(keys(out).slice().sort(), keys(list.slice(0, 10)).sort());
    assert.equal(core.interleave(list).length, 10);
    assert.equal(core.MAX_RETEST, 10);
    assert.equal(core.interleave(list, 3).length, 3);
    assert.deepEqual(core.interleave([], 10), []);
  });
});

/* ================================================================ */
describe("mastery：掌握门槛", function () {
  var KP = "math:c22-2-2"; // 题 1–4 都覆盖；二段式只有题 2，迁移只有题 3
  // 某天先后通过题 2（二段式）和题 3（迁移）
  function passDay(day, h1, h2) {
    return [
      [TT.id, att(day, "pass", { ch: "b", rs: "r2", t: at(day, h1 || "02") })],
      [TR.id, att(day, "pass", { ch: "a", rs: "r1", t: at(day, h2 || "03") })]
    ];
  }
  function M(list, items) { return core.mastery(KP, items || ITEMS, recs.apply(null, list)); }

  it("什么都没做 → none", function () {
    assert.deepEqual(core.mastery(KP, ITEMS, {}), { state: "none", dates: [], tried: false });
    assert.deepEqual(core.mastery("math:no-such-kp", ITEMS, recs(passDay(D)[0])), { state: "none", dates: [], tried: false });
  });
  it("只通过二段式、或只通过迁移 → none（每天两种都要有）", function () {
    assert.equal(M([passDay(D)[0], passDay(plus(2))[0]]).state, "none");
    assert.equal(M([passDay(D)[1], passDay(plus(2))[1]]).state, "none");
  });
  it("二段式和迁移不在同一天 → none", function () {
    assert.deepEqual(M([passDay(D)[0], passDay(plus(1))[1]]), { state: "none", dates: [], tried: true });
  });
  it("预测、逆向题通过不计；unsure 不算通过", function () {
    assert.equal(M([[POE.id, att(D, "pass")], [INV.id, att(D, "pass")], [POE.id, att(plus(2), "pass")], [INV.id, att(plus(2), "pass")]]).state, "none");
    // 逆向题不能顶替迁移题：两天都是「二段式 + 逆向」→ 仍是 none
    assert.equal(M([passDay(D)[0], [INV.id, att(D, "pass")], passDay(plus(2))[0], [INV.id, att(plus(2), "pass")]]).state, "none");
    assert.equal(M([passDay(D)[0], [TR.id, att(D, "unsure")]]).state, "none");
  });
  it("同一天做两遍 → partial（只算一个日期）", function () {
    var r = M(passDay(D, "02", "03").concat(passDay(D, "06", "07")));
    assert.deepEqual(r, { state: "partial", dates: [D], tried: true });
  });
  it("两个不同日期 → passed（dates 按日期排序）", function () {
    assert.deepEqual(M(passDay(D).concat(passDay(plus(2)))), { state: "passed", dates: [D, plus(2)], tried: true });
    assert.deepEqual(M(passDay(plus(2)).concat(passDay(D))), { state: "passed", dates: [D, plus(2)], tried: true });
  });
  it("最近一个达标日期之后，这个知识点的题上又出现 mc → 退回 partial", function () {
    var base = passDay(D).concat(passDay(plus(2)));
    var later = base.concat([[POE.id, att(plus(3), "mc", { tags: ["graphaspath"] })]]);
    assert.deepEqual(M(later), { state: "partial", dates: [D, plus(2)], tried: true });
    // 同一天、在达标之后（时间更晚）出现 mc 也算
    var sameDay = base.concat([[INV.id, att(plus(2), "mc", { tags: ["graphaspath"], t: at(plus(2), "05") })]]);
    assert.equal(M(sameDay).state, "partial");
  });
  it("mc 在最近一次达标之前、或是 gap、或在不覆盖该知识点的题上 → 仍是 passed", function () {
    var base = passDay(D).concat(passDay(plus(2)));
    assert.equal(M(base.concat([[TT.id, att(plus(1), "mc", { tags: ["graphaspath"] })]])).state, "passed");
    assert.equal(M(base.concat([[TT.id, att(plus(2), "mc", { tags: ["graphaspath"], t: at(plus(2), "01") })]])).state, "passed");
    assert.equal(M(base.concat([[TT.id, att(plus(5), "gap")]])).state, "passed");
    var O = syn("other-kp", { kp: ["math:c99-9-9"] });
    var items = ITEMS.concat([O]);
    assert.equal(M(base.concat([[O.id, att(plus(5), "mc", { tags: ["tagaaaa"] })]]), items).state, "passed");
  });
  it("退回 partial 以后，再有一天达标 → 重新 passed", function () {
    var list = passDay(D).concat(passDay(plus(2)), [[TR.id, att(plus(3), "mc", { tags: ["graphaspath"] })]], passDay(plus(4)));
    assert.deepEqual(M(list), { state: "passed", dates: [D, plus(2), plus(4)], tried: true });
  });
  it("题 2 也覆盖 c23-4-2：两天都做对题 2、题 3，c23-4-2 同样达标", function () {
    assert.deepEqual(TT.kp, ["math:c22-2-2", "math:c23-4-2"]);
    var r = core.mastery("math:c23-4-2", ITEMS, recs.apply(null, passDay(D).concat(passDay(plus(2)))));
    assert.equal(r.state, "passed");
  });
  it("没有二段式题覆盖的知识点永远到不了 passed（合成题）", function () {
    var only = [syn("tr-only", { type: "transfer", kp: ["math:k77"] })];
    var r = core.mastery("math:k77", only, recs(["tr-only", att(D, "pass")], ["tr-only", att(plus(2), "pass")]));
    assert.deepEqual(r, { state: "none", dates: [], tried: true });
  });
  it("tried：覆盖这个知识点的题做过（任何题型、任何结果）才为真——导图据此区分「未测」和「测试 0 / 2」", function () {
    assert.equal(core.mastery(KP, ITEMS, {}).tried, false);
    // 只做了预测关卡（不计入达标）也算做过
    assert.deepEqual(M([[POE.id, att(D, "mc", { tags: ["graphaspath"] })]]), { state: "none", dates: [], tried: true });
    // 只做了二段式、答错
    assert.equal(M([[TT.id, att(D, "gap")]]).tried, true);
    // 做的题不覆盖这个知识点：不算
    var O = syn("other-kp2", { kp: ["math:c99-9-9"] });
    assert.equal(core.mastery(KP, ITEMS.concat([O]), recs([O.id, att(D, "pass")])).tried, false);
  });
});

/* ================================================================ */
describe("buildMistakes：进错题本（7.1）与重测（7.2）", function () {
  function ctx(o) {
    return {
      item: o.item, attempt: o.attempt, mode: o.mode, retestKey: o.retestKey,
      existing: o.existing || {}, tags: o.tags || LIB, names: o.names || NAMES,
      records: o.records, items: o.items || ITEMS, today: o.today
    };
  }
  function answer(item, ch, rs, cf, day, mode, ex) {
    var c = core.classify(item, { ch: ch, rs: rs, cf: cf });
    return { d: day, t: at(day, "03"), cls: c.cls, ch: ch, rs: rs, cf: cf, tags: c.tags, ex: ex || "", mode: mode };
  }
  function byIdMap(list) { var m = {}; list.forEach(function (x) { m[x.id] = x; }); return m; }
  function correctOf(item) { return { ch: item.answer.correct, rs: item.reason ? item.reason.correct : "" }; }

  // 第 D 天：题 1 预测选 b、有把握 → mc（图象即轨迹）
  var EX = "P 在 CD 上是往上走的";
  var a1 = answer(POE, "b", "", "sure", D, "poe", EX);
  var recs1 = recs([POE.id, a1]);
  var m1 = core.buildMistakes(ctx({ item: POE, attempt: a1, mode: "poe", records: recs1, today: D }));

  it("新错误概念 → 新建 mc-graphaspath：origin quiz、mc、status 0、review.step 0、明天到期、kp c22-2-2", function () {
    assert.equal(a1.cls, "mc");
    assert.equal(m1.length, 1);
    var m = m1[0];
    assert.equal(m.id, "mc-graphaspath");
    assert.match(m.id, MISTAKE_ID_RE);
    assert.equal(m.origin, "quiz");
    assert.deepEqual(m.mc, ["graphaspath"]);
    assert.equal(m.status, 0);
    assert.deepEqual(m.review, { step: 0, due: plus(1), last: D, stable: false, hist: [{ d: D, qid: POE.id, cls: "mc" }] });
    assert.equal(m.subject, "math");
    assert.equal(m.kp, "c22-2-2"); // 标签主学科（math）里的第一个 kp，去掉前缀
    assert.equal(m.kpName, "画函数图象与读图");
    assert.equal(m.chapter, "第二十二章 函数");
    assert.equal(m.source, "理解测试");
    assert.deepEqual(m.tags, ["概念不清"]);
    assert.equal(m.date, D);
    assert.deepEqual(m.qids, [POE.id]);
  });
  it("错题文字：question「【错误概念】名称｜最近一次：题干前 60 字」、wrong、fix = refute + 参考解释", function () {
    var m = m1[0];
    assertQuestion(m.question, "【错误概念】图象即轨迹｜最近一次：", POE.stem);
    // 预测题没有理由这一段，wrong 里就不写「理由」
    assert.equal(m.wrong, "答案：先保持 0，再上升；把握：有把握；我的解释：" + EX);
    assert.equal(m.fix, LIB.graphaspath.refute + "\n" + POE.feedback.ref);
  });
  it("刚进错题本：今天不到期，明天到期；重测出的是题 2", function () {
    assert.deepEqual(core.dueList(m1, D, LIB, ITEMS), []);
    var due = core.dueList(m1, plus(1), LIB, ITEMS);
    assert.equal(due.length, 1);
    assert.equal(due[0].key, "graphaspath");
    assert.equal(due[0].name, "图象即轨迹");
    assert.equal(core.pickRetest(due[0].key, ITEMS, recs1, { hs: {} }).id, TT.id);
  });

  it("D+1 重测题 2 答对（b、r2、有把握）→ step 1、due D+4、status 1，不改传入的 existing", function () {
    var a2 = answer(TT, "b", "r2", "sure", plus(1), "retest");
    assert.equal(a2.cls, "pass");
    var recs2 = core.addAttempt(recs1, TT.id, a2);
    var existing = byIdMap(m1);
    var snap = clone(existing);
    var out = core.buildMistakes(ctx({ item: TT, attempt: a2, mode: "retest", retestKey: "graphaspath", existing: existing, records: recs2, today: plus(1) }));
    assert.deepEqual(existing, snap);
    assert.equal(out.length, 1);
    var m = out[0];
    assert.equal(m.id, "mc-graphaspath");
    assert.equal(m.review.step, 1);
    assert.equal(m.review.due, plus(4));
    assert.equal(m.review.last, plus(1));
    assert.equal(m.status, 1);
    assert.equal(m.review.stable, false);
    assert.deepEqual(m.review.hist, [{ d: D, qid: POE.id, cls: "mc" }, { d: plus(1), qid: TT.id, cls: "pass" }]);
    assert.deepEqual(m.qids, [POE.id, TT.id]);
    assert.deepEqual(m.mc, ["graphaspath"]);
    assert.equal(m.question, m1[0].question, "答对不改错题文字");
    assert.equal(m.date, D, "date 保留第一次出现的日期");
    assert.deepEqual(core.dueList(out, plus(1), LIB, ITEMS), []);
    assert.equal(core.nextDue(out, plus(1), LIB).due, plus(4));
  });

  it("按计划一路答对：D+4、D+11、D+25 依次换情境出题，最后一档通过后已掌握、不再安排", function () {
    var a2 = answer(TT, "b", "r2", "sure", plus(1), "retest");
    var records = core.addAttempt(recs1, TT.id, a2);
    var m = core.buildMistakes(ctx({ item: TT, attempt: a2, mode: "retest", retestKey: "graphaspath", existing: byIdMap(m1), records: records, today: plus(1) }))[0];
    var plan = [
      { day: 4, pick: INV.id, step: 2, due: plus(11), status: 1 },
      { day: 11, pick: TT.id, step: 3, due: plus(25), status: 1 },
      { day: 25, pick: TR.id, step: 4, due: "", status: 2 }
    ];
    plan.forEach(function (p) {
      var today = plus(p.day);
      var due = core.dueList([m], today, LIB, ITEMS);
      assert.equal(due.length, 1, "第 D+" + p.day + " 天应到期");
      assert.deepEqual(core.dueList([m], core.addDays(today, -1), LIB, ITEMS), [], "前一天还不到期");
      var item = core.pickRetest("graphaspath", ITEMS, records, { hs: {} });
      assert.equal(item.id, p.pick);
      var c = correctOf(item);
      var a = answer(item, c.ch, c.rs, "sure", today, "retest");
      assert.equal(a.cls, "pass");
      records = core.addAttempt(records, item.id, a);
      m = core.buildMistakes(ctx({ item: item, attempt: a, mode: "retest", retestKey: "graphaspath", existing: byIdMap([m]), records: records, today: today }))[0];
      assert.equal(m.review.step, p.step);
      assert.equal(m.review.due, p.due);
      assert.equal(m.status, p.status);
    });
    assert.deepEqual(core.dueList([m], "2099-01-01", LIB, ITEMS), []);
    assert.equal(core.nextDue([m], plus(26), LIB), null);
    assert.equal(m.review.hist.length, 5);
  });

  it("稳定迷思：D+1 重测题 2 又错（a、r1、有把握）→ stable true、step 0、due D+2、status 0", function () {
    var a3 = answer(TT, "a", "r1", "sure", plus(1), "retest");
    assert.equal(a3.cls, "mc");
    assert.deepEqual(a3.tags, ["graphaspath"]);
    var recs3 = core.addAttempt(recs1, TT.id, a3);
    var out = core.buildMistakes(ctx({ item: TT, attempt: a3, mode: "retest", retestKey: "graphaspath", existing: byIdMap(m1), records: recs3, today: plus(1) }));
    assert.equal(out.length, 1, "重测题和作答带出的是同一个标签，只写一条");
    var m = out[0];
    assert.equal(m.review.stable, true);
    assert.equal(m.review.step, 0);
    assert.equal(m.review.due, plus(2));
    assert.equal(m.status, 0);
    assert.deepEqual(m.qids, [POE.id, TT.id]);
    assertQuestion(m.question, "【错误概念】图象即轨迹｜最近一次：", TT.stem);
    assert.equal(m.wrong, "答案：在一段平路上走；理由：这段图象是水平的，所以他走的路是平的；把握：有把握");
    assert.equal(m.fix, LIB.graphaspath.refute + "\n" + TT.feedback.ref);
    var due = core.dueList(out, plus(2), LIB, ITEMS);
    assert.equal(due.length, 1);
    assert.equal(due[0].stable, true);
    assert.equal(core.nextDue(out, plus(1), LIB).stable, true);
  });
  it("同一情境（题 1 和题 3 都是动点面积）错两次 → 不是稳定迷思，但照样按失败排期", function () {
    var a = answer(TR, "b", "r2", "sure", plus(1), "practice");
    assert.equal(a.cls, "mc");
    var r = core.addAttempt(recs1, TR.id, a);
    var m = core.buildMistakes(ctx({ item: TR, attempt: a, mode: "practice", existing: byIdMap(m1), records: r, today: plus(1) }))[0];
    assert.equal(m.review.stable, false);
    assert.equal(m.review.step, 0);
    assert.equal(m.review.due, plus(2));
    assert.equal(m.status, 0);
  });
  it("已经是稳定迷思的条目不会被改回 false", function () {
    var old = clone(m1[0]); old.review.stable = true;
    var a = answer(TR, "b", "r2", "sure", plus(1), "practice");
    var m = core.buildMistakes(ctx({ item: TR, attempt: a, mode: "practice", existing: { "mc-graphaspath": old }, records: core.addAttempt(recs1, TR.id, a), today: plus(1) }))[0];
    assert.equal(m.review.stable, true);
  });

  it("没有标签的 gap → 按题一条 qz-<题目 id>（知识缺漏）", function () {
    var a = answer(TT, "d", "r3", "unsure", D, "practice");
    assert.equal(a.cls, "gap");
    assert.deepEqual(a.tags, []);
    var out = core.buildMistakes(ctx({ item: TT, attempt: a, mode: "practice", records: recs([TT.id, a]), today: D }));
    assert.equal(out.length, 1);
    var m = out[0];
    assert.equal(m.id, "qz-mddsttwotier");
    assert.equal(m.id, core.qzId(TT.id));
    assert.match(m.id, MISTAKE_ID_RE);
    assert.equal(m.origin, "quiz");
    assert.deepEqual(m.mc, []);
    assert.equal(m.subject, "math");
    assert.equal(m.kp, "c22-2-2"); // 没有标签：取题目在主学科的第一个 kp
    assert.equal(m.status, 0);
    assert.deepEqual(m.review, { step: 0, due: plus(1), last: D, stable: false, hist: [{ d: D, qid: TT.id, cls: "gap" }] });
    assertQuestion(m.question, "【知识缺漏】｜最近一次：", TT.stem);
    assert.equal(m.wrong, "答案：在往家走；理由：这段时间 t 没有变；把握：没把握");
    assert.equal(m.fix, TT.feedback.ref);
    assert.equal(core.keyOfMistake(m), "q:" + TT.id);
    var due = core.dueList(out, plus(1), LIB, ITEMS);
    assert.equal(due.length, 1);
    assert.equal(due[0].kind, "item");
    assert.equal(due[0].key, "q:" + TT.id);
    // 按题记的错题，重测就出这道题本身；答对进一档
    assert.equal(core.pickRetest(due[0].key, ITEMS, {}, {}).id, TT.id);
    var a2 = answer(TT, "b", "r2", "sure", plus(1), "retest");
    var m2 = core.buildMistakes(ctx({ item: TT, attempt: a2, mode: "retest", retestKey: "q:" + TT.id, existing: byIdMap(out), records: recs([TT.id, a]), today: plus(1) }))[0];
    assert.equal(m2.id, m.id);
    assert.equal(m2.review.step, 1);
    assert.equal(m2.review.due, plus(4));
    assert.equal(m2.status, 1);
  });
  it("判为 mc 但没有标签（答案对、理由选了不带标签的错项）→ 按 gap 记成 qz- 条目", function () {
    var a = answer(TT, "b", "r3", "sure", D, "practice");
    assert.equal(a.cls, "gap");
    var out = core.buildMistakes(ctx({ item: TT, attempt: a, mode: "practice", records: recs([TT.id, a]), today: D }));
    assert.deepEqual(out.map(function (x) { return x.id; }), ["qz-mddsttwotier"]);
  });
  it("带标签的 gap（答错、没把握）→ 仍按标签聚合成 mc- 条目", function () {
    var a = answer(TT, "a", "r2", "unsure", D, "practice");
    assert.equal(a.cls, "gap");
    var out = core.buildMistakes(ctx({ item: TT, attempt: a, mode: "practice", records: recs([TT.id, a]), today: D }));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "mc-graphaspath");
    assert.deepEqual(out[0].review.hist, [{ d: D, qid: TT.id, cls: "gap" }]);
    assert.equal(out[0].review.stable, false, "gap 不算稳定迷思的证据");
  });
  it("标签库里没有的标签不建 mc- 条目，退回按题记", function () {
    var a = { d: D, t: at(D, "03"), cls: "mc", ch: "b", rs: "r2", cf: "sure", tags: ["notinlibrary"], ex: "", mode: "practice" };
    var out = core.buildMistakes(ctx({ item: TT, attempt: a, mode: "practice", records: recs([TT.id, a]), today: D }));
    assert.deepEqual(out.map(function (x) { return x.id; }), ["qz-mddsttwotier"]);
  });
  it("练习 / 预测里答对或没把握 → 不动错题本", function () {
    ["pass", "unsure"].forEach(function (c) {
      var a = att(D, c, { mode: "practice" });
      assert.deepEqual(core.buildMistakes(ctx({ item: TT, attempt: a, mode: "practice", existing: byIdMap(m1), records: recs([TT.id, a]), today: D })), []);
      assert.deepEqual(core.buildMistakes(ctx({ item: POE, attempt: a, mode: "poe", existing: byIdMap(m1), records: recs([POE.id, a]), today: D })), []);
    });
  });
  it("重测没把握 → step 不变、明天再测、状态不变", function () {
    var old = clone(m1[0]); old.review.step = 2; old.review.due = plus(1); old.status = 1;
    var a = answer(TT, "b", "r2", "unsure", plus(1), "retest");
    assert.equal(a.cls, "unsure");
    var m = core.buildMistakes(ctx({ item: TT, attempt: a, mode: "retest", retestKey: "graphaspath", existing: { "mc-graphaspath": old }, records: core.addAttempt(recs1, TT.id, a), today: plus(1) }))[0];
    assert.equal(m.review.step, 2);
    assert.equal(m.review.due, plus(2));
    assert.equal(m.status, 1);
  });
  it("重测答对、但这条错题已被删掉 → 不新建", function () {
    var a = answer(TT, "b", "r2", "sure", plus(1), "retest");
    assert.deepEqual(core.buildMistakes(ctx({ item: TT, attempt: a, mode: "retest", retestKey: "graphaspath", existing: {}, records: recs([TT.id, a]), today: plus(1) })), []);
  });
  it("重测答错且带出别的标签：重测的那一项记失败，别的标签也各记一条（新建或失败）", function () {
    var S = syn("syn-multi", { tag: "tagaaaa", rtag: "tagbbbb" });
    var items = [S];
    var oldA = { id: "mc-tagaaaa", subject: "math", kp: "k1", origin: "quiz", status: 1, mc: ["tagaaaa"], qids: ["syn-multi"],
      question: "旧", wrong: "旧", fix: "旧", review: { step: 2, due: D, last: plus(-7), stable: false, hist: [] } };
    var c = core.classify(S, { ch: "b", rs: "r2", cf: "sure" });
    assert.deepEqual(c.tags, ["tagaaaa", "tagbbbb"]);
    var a = { d: D, t: at(D, "03"), cls: c.cls, ch: "b", rs: "r2", cf: "sure", tags: c.tags, ex: "", mode: "retest" };
    var out = core.buildMistakes(ctx({ item: S, attempt: a, mode: "retest", retestKey: "tagaaaa", existing: { "mc-tagaaaa": oldA },
      tags: SYN_LIB, names: {}, records: recs([S.id, a]), items: items, today: D }));
    assert.deepEqual(out.map(function (x) { return x.id; }), ["mc-tagaaaa", "mc-tagbbbb"]);
    assert.equal(out[0].review.step, 0);
    assert.equal(out[0].status, 0);
    assert.equal(out[0].review.due, plus(1));
    assert.equal(out[1].subject, "physics");
    assert.equal(out[1].kp, "p1", "取标签主学科里的第一个 kp");
    assert.equal(out[1].kpName, "");
    assert.deepEqual(out[1].review, { step: 0, due: plus(1), last: D, stable: false, hist: [{ d: D, qid: S.id, cls: "mc" }] });
    // 答案对、理由选了别的标签：重测的那一项也算失败
    var c2 = core.classify(S, { ch: "a", rs: "r2", cf: "sure" });
    var a2 = { d: D, t: at(D, "05"), cls: c2.cls, ch: "a", rs: "r2", cf: "sure", tags: c2.tags, ex: "", mode: "retest" };
    var out2 = core.buildMistakes(ctx({ item: S, attempt: a2, mode: "retest", retestKey: "tagaaaa", existing: { "mc-tagaaaa": oldA },
      tags: SYN_LIB, names: {}, records: recs([S.id, a2]), items: items, today: D }));
    assert.deepEqual(out2.map(function (x) { return x.id; }), ["mc-tagaaaa", "mc-tagbbbb"]);
    assert.equal(out2[0].review.step, 0);
  });
  it("合并不覆盖：qids 去重、本题挪到最后、最多 20；hist 最多 20；mc 不重复", function () {
    var old = clone(m1[0]);
    old.qids = [];
    for (var i = 0; i < 20; i++) old.qids.push("q-old-" + i);
    old.qids[5] = TT.id; // 本题已在中间
    old.review.hist = [];
    for (var j = 0; j < 20; j++) old.review.hist.push({ d: D, qid: "q-old-" + j, cls: "mc" });
    var a = answer(TT, "a", "r1", "sure", plus(1), "practice");
    var m = core.buildMistakes(ctx({ item: TT, attempt: a, mode: "practice", existing: { "mc-graphaspath": old }, records: core.addAttempt(recs1, TT.id, a), today: plus(1) }))[0];
    assert.equal(m.qids.length, 20);
    assert.equal(m.qids[m.qids.length - 1], TT.id);
    assert.equal(m.qids.filter(function (q) { return q === TT.id; }).length, 1);
    assert.equal(m.review.hist.length, 20);
    assert.deepEqual(m.review.hist[19], { d: plus(1), qid: TT.id, cls: "mc" });
    assert.deepEqual(m.mc, ["graphaspath"]);
    assert.equal(m.date, D);
  });
  it("旧条目缺少测试字段（mc / qids / review 为空）也能合并", function () {
    var old = { id: "mc-graphaspath", subject: "math", kp: "c22-2-2", origin: "", status: 1, question: "x", wrong: "", fix: "", review: null };
    var a = answer(TT, "a", "r1", "sure", plus(1), "practice");
    var m = core.buildMistakes(ctx({ item: TT, attempt: a, mode: "practice", existing: { "mc-graphaspath": old }, records: core.addAttempt(recs1, TT.id, a), today: plus(1) }))[0];
    assert.equal(m.origin, "quiz");
    assert.deepEqual(m.mc, ["graphaspath"]);
    assert.deepEqual(m.qids, [TT.id]);
    assert.equal(m.review.step, 0);
    assert.equal(m.review.due, plus(2));
    assert.equal(m.status, 0);
  });
});

/* ================================================================ */
describe("dueList / nextDue：到期列表", function () {
  function mk(id, status, review, extra) {
    var m = { id: id, subject: "math", origin: "quiz", status: status, mc: [], qids: [], review: review };
    Object.keys(extra || {}).forEach(function (k) { m[k] = extra[k]; });
    return m;
  }
  function rv(step, due, stable) { return { step: step, due: due, last: "", stable: !!stable, hist: [] }; }
  var list = [
    mk("mc-graphaspath", 0, rv(0, D)),
    mk("mc-vertexismax", 1, rv(2, plus(-1), true)),
    mk("qz-mddsttwotier", 0, rv(0, D), { qids: [POE.id, TT.id] }),
    mk("mc-altitudeinside", 1, rv(1, plus(3))),                    // 还没到期
    mk("mc-currentconsumed", 2, rv(4, plus(-2))),                  // 已掌握
    mk("mc-lampresistance", 1, rv(1, plus(-1)), { origin: "" }),   // 不是测试来的
    mk("mc-deeperbuoyancy", 0, null),                              // 没有排期
    mk("mc-zzunknowntag", 0, rv(0, D)),                            // 标签库里没有
    mk("qz-noqids00", 0, rv(0, plus(-1))),                         // qz- 条目没有 qids，找不到题
    mk("mc-armtopoint", 1, rv(1, "")),                             // due 为空
    { id: "ab-manual01", subject: "math", status: 0, question: "手动录入的旧错题" } // 旧格式
  ];
  var snap = clone(list);

  it("只列来自测试、未掌握、due ≤ 今天的条目；按到期日再按 key 排", function () {
    var out = core.dueList(list, D, LIB, ITEMS);
    assert.deepEqual(out.map(function (x) { return x.key; }), ["vertexismax", "graphaspath", "q:" + TT.id, "zzunknowntag"]);
    // 名称取标签库里的 name（第 1 批 B 按任务书把 vertexismax 的名称改成了「顶点处一定取到最值」）
    assert.deepEqual(out[0], { key: "vertexismax", kind: "tag", mistakeId: "mc-vertexismax", name: "顶点处一定取到最值", stable: true, due: plus(-1), step: 2, subject: "math" });
    assert.equal(out[1].name, "图象即轨迹");
    assert.equal(out[2].kind, "item");
    assert.equal(out[2].mistakeId, "qz-mddsttwotier");
    assert.equal(out[2].name.indexOf(TT.stem.slice(0, 24)), 0, "按题的条目用题干开头作名称");
    assert.equal(out[3].name, "zzunknowntag", "标签库里没有：名称退回标签 id");
    assert.deepEqual(list, snap);
  });
  it("到期边界：due 等于今天算到期，前一天不算", function () {
    var one = [mk("mc-graphaspath", 0, rv(0, D))];
    assert.equal(core.dueList(one, D, LIB, ITEMS).length, 1);
    assert.equal(core.dueList(one, plus(-1), LIB, ITEMS).length, 0);
    assert.equal(core.dueList(one, plus(30), LIB, ITEMS).length, 1);
  });
  it("nextDue：还没到期的里面最近的一个；没有 → null", function () {
    assert.deepEqual(core.nextDue(list, D, LIB), { key: "altitudeinside", due: plus(3), stable: false, name: "高一定在三角形内部" });
    var more = list.concat([mk("mc-moleculecount", 0, rv(0, plus(1), true))]);
    assert.deepEqual(core.nextDue(more, D, LIB), { key: "moleculecount", due: plus(1), stable: true, name: "化学反应前后分子个数守恒" });
    assert.equal(core.nextDue(list, plus(3), LIB), null, "due 等于今天的已经到期，不算「下一个」");
    assert.equal(core.nextDue([], D, LIB), null);
    assert.equal(core.nextDue(null, D), null);
  });
  it("空输入", function () {
    assert.deepEqual(core.dueList([], D, LIB, ITEMS), []);
    assert.deepEqual(core.dueList(null, D), []);
  });
});

/* ================================================================ */
describe("日期：addDays / today / fmtMD", function () {
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  // 独立的日历推算（不用 Date），用来核对 addDays
  function nextDay(s) {
    var p = s.split("-").map(Number), y = p[0], m = p[1], d = p[2];
    var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    var len = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    d++;
    if (d > len) { d = 1; m++; if (m > 12) { m = 1; y++; } }
    return y + "-" + pad(m) + "-" + pad(d);
  }
  // 在指定时区下运行（Node 支持运行中改 process.env.TZ）；时区数据不可用时返回 false
  function withTZ(tz, fn) {
    var old = process.env.TZ;
    process.env.TZ = tz;
    try {
      if (tz === "Asia/Shanghai" && new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset() !== -480) return false;
      fn();
      return true;
    } finally {
      if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
    }
  }

  it("跨月、跨年、闰年", function () {
    assert.equal(core.addDays("2026-11-30", 1), "2026-12-01");
    assert.equal(core.addDays("2026-01-31", 1), "2026-02-01");
    assert.equal(core.addDays("2026-02-28", 1), "2026-03-01");
    assert.equal(core.addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(core.addDays("2100-02-28", 1), "2100-03-01");
    assert.equal(core.addDays("2000-02-28", 1), "2000-02-29");
    assert.equal(core.addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(core.addDays("2026-12-25", 14), "2027-01-08");
    assert.equal(core.addDays("2026-11-24", 7), "2026-12-01");
    assert.equal(core.addDays("2027-01-01", -1), "2026-12-31");
    assert.equal(core.addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(core.addDays("2026-11-24", 0), "2026-11-24");
  });
  it("格式不对 → 空串", function () {
    assert.equal(core.addDays("", 1), "");
    assert.equal(core.addDays("2026-1-5", 1), "");
    assert.equal(core.addDays(undefined, 1), "");
    assert.equal(core.addDays(null, 1), "");
  });
  it("夏令时：在几个有夏令时的时区里逐日推 800 天，都与日历一致", function () {
    var zones = ["UTC", "Europe/Berlin", "America/New_York", "America/Sao_Paulo", "Australia/Lord_Howe", "Asia/Shanghai"];
    zones.forEach(function (tz) {
      withTZ(tz, function () {
        // 切换日附近的固定用例（欧洲 2026-03-29 / 10-25，美国 03-08 / 11-01，巴西旧规则午夜切换 2018-11-04）
        assert.equal(core.addDays("2026-03-28", 1), "2026-03-29", tz);
        assert.equal(core.addDays("2026-03-29", 1), "2026-03-30", tz);
        assert.equal(core.addDays("2026-10-24", 2), "2026-10-26", tz);
        assert.equal(core.addDays("2026-11-01", -1), "2026-10-31", tz);
        assert.equal(core.addDays("2026-03-07", 3), "2026-03-10", tz);
        assert.equal(core.addDays("2018-11-03", 1), "2018-11-04", tz);
        assert.equal(core.addDays("2018-11-04", 1), "2018-11-05", tz);
        var cur = "2025-12-01";
        for (var i = 0; i < 800; i++) {
          var nx = nextDay(cur);
          assert.equal(core.addDays(cur, 1), nx, tz + " " + cur);
          assert.equal(core.addDays(nx, -1), cur, tz + " " + nx);
          cur = nx;
        }
        var c14 = "2026-01-01", e14 = c14;
        for (var k = 0; k < 14; k++) e14 = nextDay(e14);
        assert.equal(core.addDays(c14, 14), e14, tz);
      });
    });
  });
  it("today()：取设备本地日期（不是 UTC 日期）", function (t) {
    var instant = new Date(Date.UTC(2026, 10, 24, 16, 30)); // 北京时间 11 月 25 日 00:30
    var ok = withTZ("Asia/Shanghai", function () { assert.equal(core.today(instant), "2026-11-25"); });
    if (!ok) { t.skip("本机 Node 没有时区数据"); return; }
    withTZ("Europe/Berlin", function () {
      assert.equal(core.today(instant), "2026-11-24");
      assert.equal(core.today(new Date(2026, 2, 29, 12)), "2026-03-29"); // 夏令时切换当天
    });
    withTZ("America/New_York", function () { assert.equal(core.today(new Date(Date.UTC(2026, 10, 25, 3))), "2026-11-24"); });
    assert.match(core.today(), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(core.today(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  });
  it("fmtMD：「11 月 25 日」，不补零；不合格 → 空串", function () {
    assert.equal(core.fmtMD("2026-11-25"), "11 月 25 日");
    assert.equal(core.fmtMD("2027-01-05"), "1 月 5 日");
    assert.equal(core.fmtMD("2026-12-31"), "12 月 31 日");
    assert.equal(core.fmtMD(""), "");
    assert.equal(core.fmtMD("bad"), "");
    assert.equal(core.fmtMD(undefined), "");
  });
});

/* ================================================================ */
describe("测试记录与小工具：addAttempt / doneBefore / qzId / itemTags / firstKp", function () {
  it("addAttempt：追加、最多 20 次（去掉最旧）、不改传入对象", function () {
    var r = {};
    for (var i = 0; i < 25; i++) r = core.addAttempt(r, TT.id, att(D, "pass", { t: "t" + (i < 10 ? "0" : "") + i }));
    assert.equal(r[TT.id].qid, TT.id);
    assert.equal(r[TT.id].tries.length, 20);
    assert.equal(r[TT.id].tries[0].t, "t05");
    assert.equal(r[TT.id].tries[19].t, "t24");
    var before = clone(r);
    var r2 = core.addAttempt(r, POE.id, att(D, "mc"));
    assert.deepEqual(r, before);
    assert.equal(r2[TT.id], r[TT.id]);
    assert.equal(r2[POE.id].tries.length, 1);
  });
  it("doneBefore", function () {
    assert.equal(core.doneBefore({}, TT.id), false);
    assert.equal(core.doneBefore(null, TT.id), false);
    assert.equal(core.doneBefore(recs([TT.id, att(D, "gap")]), TT.id), true);
    assert.equal(core.doneBefore({ x: { qid: "x", tries: [] } }, "x"), false);
  });
  it("qzId：去掉非字母数字、截到 32、不足 6 位补 0，符合 api/mistakes 的 id 格式", function () {
    assert.equal(core.qzId("m-dd-st-twotier"), "qz-mddsttwotier");
    assert.equal(core.qzId("ab-c"), "qz-abc000");
    var long = core.qzId("a123456789-b123456789-c123456789-d123456789-e12");
    assert.equal(long, "qz-a123456789b123456789c123456789d1");
    [TT.id, POE.id, TR.id, INV.id, "ab-c", "a123456789-b123456789-c123456789-d123456789-e12"].forEach(function (q) {
      assert.match(core.qzId(q), MISTAKE_ID_RE);
    });
  });
  it("itemTags / firstKp", function () {
    assert.deepEqual(core.itemTags(TT), ["graphaspath"]);
    assert.deepEqual(core.itemTags(POE), ["graphaspath"]);
    assert.deepEqual(core.itemTags(syn("x-item", { tag: "tagaaaa", rtag: "tagbbbb" })), ["tagaaaa", "tagbbbb"]);
    assert.equal(core.firstKp(["physics:k1", "math:c22-2-2", "math:c23-4-2"], "math"), "c22-2-2");
    assert.equal(core.firstKp(["physics:k1"], "math"), "");
    assert.equal(core.firstKp(null, "math"), "");
  });
});

describe("补充：情境缺省、跨学科同名 module、nextDue 名称、addDays 非法参数", function () {
  it("pickRetest：题目没写 context 时各算各的情境，不会把所有没写的都当成「和上次相同」", function () {
    var a = syn("nc-a", { context: "" }), b = syn("nc-b", { context: "" });
    delete a.context; delete b.context;
    // 上次做的是 nc-a：nc-b 情境不同（各算各的），应优先选 nc-b，即使 nc-a 的 id 更靠前
    var r = recs(["nc-a", att(D, "mc", { tags: ["tagaaaa"] })]);
    assert.equal(core.pickRetest("tagaaaa", [a, b], r, {}).id, "nc-b");
    assert.equal(core.ctxOf(a), "nc-a");
  });
  it("interleave：不同学科用了同名 module 时也尽量错开；实在错不开再退到不同学科", function () {
    var m1 = syn("x-m1", { subject: "math", module: "demo" });
    var p1 = syn("x-p1", { subject: "physics", module: "demo" });
    var m2 = syn("x-m2", { subject: "math", module: "other" });
    // 三题里两题同名 module：能错开就错开
    var out = core.interleave([{ item: m1 }, { item: p1 }, { item: m2 }], 10).map(function (e) { return e.item.id; });
    var by = { "x-m1": m1, "x-p1": p1, "x-m2": m2 };
    assert.equal(out.length, 3);
    for (var i = 1; i < out.length; i++) {
      assert.notEqual(by[out[i]].module, by[out[i - 1]].module, "相邻同 module：" + out.join(","));
    }
    // 全是同名 module：错不开时，优先让相邻两题来自不同学科
    var m3 = syn("y-m3", { subject: "math", module: "demo" });
    var m4 = syn("y-m4", { subject: "math", module: "demo" });
    var p2 = syn("y-p2", { subject: "physics", module: "demo" });
    var out2 = core.interleave([{ item: m3 }, { item: m4 }, { item: p2 }], 10).map(function (e) { return e.item.subject; });
    assert.deepEqual(out2, ["math", "physics", "math"]);
    // 同样的输入，同样的输出
    assert.deepEqual(core.interleave([{ item: m3 }, { item: m4 }, { item: p2 }], 10).map(function (e) { return e.item.id; }),
      core.interleave([{ item: m3 }, { item: m4 }, { item: p2 }], 10).map(function (e) { return e.item.id; }));
  });
  it("nextDue：按题记的错题显示题干开头，而不是题目 id", function () {
    var m = { id: core.qzId(TT.id), origin: "quiz", status: 0, qids: [TT.id], review: { step: 0, due: plus(3), last: D, stable: false, hist: [] } };
    var nx = core.nextDue([m], D, LIB, ITEMS);
    assert.equal(nx.key, "q:" + TT.id);
    assert.equal(nx.name.indexOf("小明从家出发"), 0);
  });
  it("addDays：天数不是有限数时返回空串", function () {
    assert.equal(core.addDays(D, NaN), "");
    assert.equal(core.addDays(D, "x"), "");
    assert.equal(core.addDays(D, Infinity), "");
  });
});
