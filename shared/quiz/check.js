/* ABS-LAB 理解小测（check.html）→ 测试钩子 window.__check
 *
 * 用途：给一个班做前测、后测，比较正确率和「有把握却答错」的比例怎么变（任务书第 3.2 节）。
 *   地址 check.html?m=pa|pe|m1|m2|cb|cc&t=pre|post（模块名单见下面的 MODS）。模块不认识：列出全部模块让人选；t 不认识：让人选前测还是后测。
 *   出题：该模块全部 retest: true 的题，按题库顺序（二段式、迁移、逆向；预测关卡不出）。
 *
 * 为什么不用引擎的 mount：mount 每答一题就判定、给反馈、写记录（登录时还调接口、写错题本）。
 *   小测要的恰好相反：作答时不给反馈、不标对错，交卷后才统一判定，数据只留在本机。
 *   所以这里只用 ABSLabQuiz.load() 读静态题库（index.json、题库、misconceptions.json、link-names.json），
 *   判定用 ABSLabQuizCore.classify（和理解测试同一份规则），界面沿用 quiz.css 的 .qz-opt / .qz-cf / .qz-btn，外观一致。
 *   不调用任何接口：不 mount、不 request、不碰 api/quiz、api/mistakes，也不需要登录。
 *
 * 存储：只写 localStorage["abslab.check.v1"]（无痕模式、存储满了都可能抛错，一律吞掉，页面照常能做、能导出）：
 *   { v: 1,
 *     runs:   { <模块>: { pre: 一次小测, post: 一次小测 } },   // 每个模块的前测、后测各留最近交卷的一次
 *     drafts: { <模块>: { pre: 没做完的, post: 没做完的 } } }  // 微信切到后台常被杀掉页面，回来能接着做
 *   一次小测 = { v: 1, m, t, date: 交卷那天的本地日期 YYYY-MM-DD, at: 交卷时刻（ISO）, code: 编号（可不填）,
 *               items: [{ id, ch: 答案选项 id, rs: 理由选项 id（没有理由这一段时为 ""）, cf: "sure"|"unsure",
 *                         cls: "pass"|"unsure"|"mc"|"gap", ans: 答案对不对, tags: [错误概念标签], ms: 用时（毫秒）,
 *                         chKey, rsKey: 学生看到的字母 / 序号（见 SHUFFLE；没有理由这一段时没有 rsKey） }] }
 *   判定结果、显示的字母在交卷时就存下：以后题库改了、SHUFFLE 改了，旧的小结和 CSV 也不会跟着变。
 *   同一模块、同一种测（前测或后测）再做一次，确认以后，交卷时替换上一次的记录。
 *
 * 语法不超过 ES2019（不用 ?. 和 ??），与 shared/*.js 一样用 var + function，兼容较旧的微信内置浏览器。
 */
(function () {
  "use strict";

  var KEY = "abslab.check.v1";
  var MODS = ["pa", "pe", "m1", "m2", "cb", "cc"];
  // 模块的名字和「回到实验页」的地址（电学实验台的深链 #3、#13 由实验台自己处理）
  var MOD_INFO = {
    pa: { subject: "物理", name: "小灯泡与滑动变阻器的 I-U 图像", page: "physics/circuits-lab.html#3", lab: "电学实验台 3 号模块" },
    pe: { subject: "物理", name: "传感器：风速仪、电子秤等", page: "physics/circuits-lab.html#13", lab: "电学实验台 13 号模块" },
    m1: { subject: "数学", name: "动点与函数图象", page: "math/moving-point.html", lab: "动点与函数图象" },
    m2: { subject: "数学", name: "二次函数", page: "math/quadratic.html", lab: "二次函数实验室" },
    cb: { subject: "化学", name: "溶解度曲线", page: "chemistry/solubility.html", lab: "溶解度曲线" },
    cc: { subject: "化学", name: "反应后溶质成分", page: "chemistry/solute.html", lab: "反应后溶质成分" }
  };
  var T_NAME = { pre: "前测", post: "后测" };
  var CF_NAME = { sure: "有把握", unsure: "没把握" };
  // 选项的显示顺序（全页只看这一个开关）：
  //   false（现在）：按题库里的排列显示，和练一练、重测、预测关卡看到的一样。
  //         用户决定：在题库里打乱选项、理由的排列（id、对错、标签不变），tools/build-index.py 检查正确选项的位置不集中，
  //         所以这里不必再打乱。题库选项 id 和屏幕上的字母不一定对应（例如 id b 可能排第一、显示为 A），
  //         CSV 的答案、理由两格写「题库选项 id（显示为 字母）」，如「b（显示为 A）」「r2（显示为 1）」。
  //   true：在题库排列的基础上再按题目 id 固定打乱（前测、后测、每台设备上都一样）；CSV 写法同上。
  var SHUFFLE = false;
  // CSV 列名：任务书第 3.2 节的 10 列（原样照抄，含空格），再加「编号」（任务书说编号只写进 CSV），放在最后，前 10 列的位置不受影响
  var CSV_HEAD = ["模块", "前测 / 后测", "日期", "题目 id", "答案", "理由", "把握", "判定", "错误概念标签", "用时（秒）", "编号"];
  var CODE_MAX = 40;
  var ANS_KEYS = "ABCDEFGHIJ";

  var root = document.getElementById("ck-root");
  if (!root) return;

  var S = {
    view: "loading", m: "", t: "",
    bank: null, items: [], tags: [],
    i: 0, sel: [], code: "", t0: null,
    run: null, saved: true, confirm: false, err: "",
    figs: []
  };

  function K() { return window.ABSLabQuizCore; }

  /* ---------- DOM 小工具：一律用 textContent 写字，编号等自由文字原样显示、不会被当成 HTML ---------- */
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "text") n.textContent = String(v);
        else if (k === "cls") n.className = v;
        else n.setAttribute(k, v === true ? "" : String(v));
      });
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  // 只做瞬时滚动：平滑滚动在老机器上会和随后的 focus 抢位置
  function jumpTo(n) {
    if (!n || !n.scrollIntoView) return;
    try { n.scrollIntoView({ block: "start" }); } catch (e) { n.scrollIntoView(true); }
  }
  function focusQuiet(n) {
    if (!n) return;
    try { n.focus({ preventScroll: true }); } catch (e) { try { n.focus(); } catch (e2) { /* 无妨 */ } }
  }
  function param(name) {
    try { return new URLSearchParams(window.location.search).get(name) || ""; } catch (e) {
      var mm = new RegExp("[?&]" + name + "=([^&#]*)").exec(window.location.search);
      try { return mm ? decodeURIComponent(mm[1]) : ""; } catch (e2) { return ""; }
    }
  }
  function href(m, t) { return "check.html" + (m ? "?m=" + m + (t ? "&t=" + t : "") : ""); }
  function modTitle(m) { var x = MOD_INFO[m]; return x ? x.subject + " · " + x.name : m; }

  /* ---------- 本机存储 ---------- */
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function isObj(x) { return !!x && typeof x === "object" && !Array.isArray(x); }
  // 读出来的东西不一定可信（旧版本、手改过、别的页面写坏了）：形状不对的部分当作没有；
  // 不认识的模块原样留着（以后加了新模块，旧页面写回时不会把它们的记录抹掉）
  function readStore() {
    var s = null;
    var raw = lsGet(KEY);
    if (raw) { try { s = JSON.parse(raw); } catch (e) { s = null; } }
    if (!isObj(s)) s = {};
    s.v = 1;
    if (!isObj(s.runs)) s.runs = {};
    if (!isObj(s.drafts)) s.drafts = {};
    return s;
  }
  function writeStore(s) { return lsSet(KEY, JSON.stringify(s)); }
  function getRun(s, m, t) {
    var r = isObj(s.runs[m]) ? s.runs[m][t] : null;
    return isObj(r) && Array.isArray(r.items) ? r : null;
  }
  function getDraft(s, m, t) {
    var d = isObj(s.drafts[m]) ? s.drafts[m][t] : null;
    return isObj(d) && isObj(d.sel) ? d : null;
  }
  function putIn(s, k, m, t, v) {
    if (!isObj(s[k][m])) s[k][m] = {};
    if (v) s[k][m][t] = v; else delete s[k][m][t];
    if (!Object.keys(s[k][m]).length) delete s[k][m];
  }

  /* ---------- 选项的显示顺序（见文件开头 SHUFFLE） ---------- */
  function hash32(str) {
    var x = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
    return x >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shown(opts, seed) {
    var a = (opts || []).slice();
    if (!SHUFFLE) return a;
    var r = rng(hash32(seed));
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }
  // part："ans"（答案，标 A、B、C……）或 "rs"（理由，标 1、2、3……）
  var KEY_OF = {
    ans: function (k) { return ANS_KEYS.charAt(k); },
    rs: function (k) { return String(k + 1); }
  };
  function shownOpts(it, part) {
    var sec = part === "ans" ? it.answer : it.reason;
    return shown((sec && sec.options) || [], it.id + "|" + part);
  }
  // 某个选项在屏幕上标的字母 / 序号；找不到时为 ""
  function shownKey(it, part, id) {
    var opts = shownOpts(it, part);
    for (var k = 0; k < opts.length; k++) if (opts[k].id === id) return KEY_OF[part](k);
    return "";
  }

  /* ---------- 统计 ---------- */
  function pct(k, n) { return n > 0 ? Math.round(k / n * 100) : 0; }
  function frac(k, n) { return k + " / " + n + "（" + pct(k, n) + "%）"; }
  // 正确率 = 判为 pass 的题数 ÷ 总题数；有把握却答错 = 答案错且选了「有把握」的题数 ÷ 总题数；
  // 错误概念：每道题 classify 给出的标签各记一次（答案、理由都选到同一个标签时，classify 已经去重，只算一次）
  function stats(run) {
    var out = { n: 0, pass: 0, sureWrong: 0, tags: {} };
    (run && run.items || []).forEach(function (r) {
      out.n++;
      if (r.cls === "pass") out.pass++;
      if (!r.ans && r.cf === "sure") out.sureWrong++;
      (r.tags || []).forEach(function (t) { out.tags[t] = (out.tags[t] || 0) + 1; });
    });
    return out;
  }
  // 小结里列哪些错误概念：这个模块的题上出现过的全部标签（题库顺序，没答中的显示 0，前后测对比时一目了然），
  // 再补上记录里有、题库里已经没有的标签
  function tagList(runs) {
    var list = S.tags.slice();
    runs.forEach(function (run) {
      (run && run.items || []).forEach(function (r) {
        (r.tags || []).forEach(function (t) { if (list.indexOf(t) === -1) list.push(t); });
      });
    });
    return list;
  }
  function tagName(t) {
    var lib = (S.bank && S.bank.tags) || {};
    return (lib[t] && lib[t].name) || t;
  }

  /* ---------- CSV ---------- */
  function csvCell(v) {
    var s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
  }
  // 编号是自由文字：以 = + - @ 开头的，电子表格会当成公式执行，前面加一个 ' 让它按文字显示
  function plainText(s) { return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }
  // 答案、理由两格：题库选项 id；交卷时记下了显示的字母 / 序号（打乱顺序时）就跟在后面，如「b（显示为 C）」
  function optCell(id, key) {
    if (!id) return "";
    return key ? id + "（显示为 " + key + "）" : id;
  }
  // 每行以 CRLF 结尾（Excel、WPS 都认）；文件开头的 BOM 在下载时加，这里返回的是纯文字
  function csvOf(run) {
    if (!run) return "";
    var lines = [CSV_HEAD.join(",")];
    run.items.forEach(function (r) {
      lines.push([
        run.m, T_NAME[run.t] || run.t, run.date, r.id, optCell(r.ch, r.chKey), optCell(r.rs, r.rsKey), CF_NAME[r.cf] || "",
        r.cls || "", (r.tags || []).join(";"), Math.round((+r.ms || 0) / 1000), plainText(String(run.code || ""))
      ].map(csvCell).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }
  function csvName(run) { return "小测_" + run.m + "_" + run.t + "_" + run.date + ".csv"; }
  // BOM：没有它，Excel 会把 UTF-8 的中文当成本地编码，打开就是乱码（源码里写成转义，免得编辑器、diff 里看不见）
  var BOM = "\ufeff";
  function download(run) {
    try {
      var blob = new Blob([BOM + csvOf(run)], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = h("a", { href: url, download: csvName(run), hidden: true });
      document.body.appendChild(a);
      a.click();
      // 马上撤销地址，有的浏览器还没开始下载就拿不到文件了
      setTimeout(function () {
        try { URL.revokeObjectURL(url); } catch (e) { /* 无妨 */ }
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 4000);
      return true;
    } catch (e) {
      return false;
    }
  }
  // 复制：先用异步剪贴板接口；不行（微信、非 https）退到 execCommand；还不行就把文字选中，让人自己长按复制
  function copyText(text, ta, done) {
    function manual() {
      ta.hidden = false;
      ta.value = text;
      var ok = false;
      try {
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = document.execCommand("copy");
      } catch (e) { ok = false; }
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, manual);
    } else {
      manual();
    }
  }

  /* ---------- 作答状态 ---------- */
  function emptySel() { return { ch: "", rs: "", cf: "", ms: 0 }; }
  function complete(it, s) { return !!(s && s.ch && (!it.reason || s.rs) && s.cf); }
  function missing(it, s) {
    var miss = [];
    if (!s.ch) miss.push("答案");
    if (it.reason && !s.rs) miss.push("理由");
    if (!s.cf) miss.push("把握");
    return miss;
  }
  function doneCount() {
    var n = 0;
    S.items.forEach(function (it, k) { if (complete(it, S.sel[k])) n++; });
    return n;
  }
  function firstIncomplete() {
    for (var k = 0; k < S.items.length; k++) if (!complete(S.items[k], S.sel[k])) return k;
    return S.items.length - 1;
  }
  // 用时：这道题停在屏幕上的时间（切到后台、锁屏的那段不算），来回翻看累加
  function now() { return Date.now(); }
  function flushTime() {
    if (S.view !== "quiz" || S.t0 === null) return;
    var s = S.sel[S.i];
    var d = now() - S.t0;
    if (s && d > 0) s.ms += d;
    S.t0 = document.hidden ? null : now();
  }
  function saveDraft() {
    if (S.view !== "quiz") return;
    var sel = {};
    S.items.forEach(function (it, k) {
      var s = S.sel[k];
      if (s && (s.ch || s.rs || s.cf || s.ms)) sel[it.id] = { ch: s.ch, rs: s.rs, cf: s.cf, ms: Math.round(s.ms) };
    });
    var st = readStore();
    putIn(st, "drafts", S.m, S.t, { v: 1, code: S.code, i: S.i, at: new Date().toISOString(), sel: sel });
    writeStore(st);
  }
  function optIds(sec) { return ((sec && sec.options) || []).map(function (o) { return o.id; }); }
  // 草稿里的选择要和现在的题库对得上：选项已经不存在的当作没选
  function selFromDraft(d) {
    return S.items.map(function (it) {
      var x = d.sel[it.id];
      var s = emptySel();
      if (!isObj(x)) return s;
      if (optIds(it.answer).indexOf(x.ch) !== -1) s.ch = x.ch;
      if (it.reason && optIds(it.reason).indexOf(x.rs) !== -1) s.rs = x.rs;
      if (x.cf === "sure" || x.cf === "unsure") s.cf = x.cf;
      s.ms = Math.max(0, +x.ms || 0);
      return s;
    });
  }

  /* ---------- 画图 ---------- */
  function dropFigs() {
    S.figs.forEach(function (b) {
      if (b && typeof b.destroy === "function") { try { b.destroy(); } catch (e) { /* 已拆掉 */ } }
    });
    S.figs = [];
  }
  // 画板组件没加载成功时只是不画图，题目文字照常可用
  function drawFig(box, spec) {
    var G = window.ABSLabSVG;
    if (!box || !spec || !G || typeof G.figure !== "function") return;
    try { S.figs.push(G.figure(box, spec)); } catch (e) { /* 不画这张图 */ }
  }

  /* ==================== 各个画面 ==================== */
  function setView(v, kids) {
    if (S.view === "quiz" && v !== "quiz") flushTime();
    dropFigs();
    S.view = v;
    root.setAttribute("data-view", v);
    clear(root);
    (kids || []).forEach(function (k) { if (k) root.appendChild(k); });
  }

  function statusLine(m, t, st) {
    var run = getRun(st, m, t), d = getDraft(st, m, t);
    if (run) {
      var x = stats(run);
      return "这台设备上做过：" + K().fmtMD(run.date) + "，正确率 " + frac(x.pass, x.n);
    }
    if (d && Object.keys(d.sel).length) return "这台设备上有一次没做完";
    return "";
  }

  // 模块不认识：列出全部模块（MODS）
  function showChooser(tHint) {
    var st = readStore();
    var list = h("ul", { cls: "ck-mods" });
    MODS.forEach(function (m) {
      var acts = h("div", { cls: "ck-mod-acts" });
      ["pre", "post"].forEach(function (t) {
        var s = statusLine(m, t, st);
        acts.appendChild(h("a", {
          cls: "qz-btn" + (t === tHint ? " qz-primary" : ""), href: href(m, t), "data-ck-go": m + "-" + t,
          title: s || null
        }, [T_NAME[t] + (getRun(st, m, t) ? " ✓" : "")]));
      });
      list.appendChild(h("li", { cls: "ck-mod", "data-ck-mod": m }, [
        h("div", { cls: "ck-mod-name" }, [h("span", { cls: "ck-subj", text: MOD_INFO[m].subject }), h("b", { text: MOD_INFO[m].name })]),
        h("p", { cls: "ck-mod-meta", text: "配套：" + MOD_INFO[m].lab }),
        acts
      ]));
    });
    setView("choose", [h("div", { cls: "qz-panel" }, [
      h("h2", { cls: "qz-panel-title", text: "选一个模块" }),
      h("p", { text: "学这一部分之前做「前测」，学完以后做「后测」；两次都做完，小结会把前后的数字并排显示。" }),
      list,
      h("p", { cls: "qz-muted", text: "✓ 表示这台设备上已经做过。" })
    ])]);
  }

  // 模块认识、前测 / 后测不认识：让人选
  function showTypeChooser() {
    var st = readStore();
    var cards = h("div", { cls: "ck-types" });
    [["pre", "学这一部分之前做，看看自己原来怎么想。"], ["post", "学完以后再做一次，和前测比一比。"]].forEach(function (p) {
      var s = statusLine(S.m, p[0], st);
      cards.appendChild(h("a", { cls: "ck-type", href: href(S.m, p[0]), "data-ck-go": S.m + "-" + p[0] }, [
        h("b", { text: T_NAME[p[0]] }), h("span", { text: p[1] }), s ? h("span", { cls: "ck-type-st", text: s }) : null
      ]));
    });
    setView("type", [h("div", { cls: "qz-panel" }, [
      h("h2", { cls: "qz-panel-title", text: modTitle(S.m) }),
      h("p", { text: "你要做的是前测还是后测？" }),
      cards,
      h("p", { cls: "ck-small" }, [h("a", { cls: "ck-alt", href: href(), text: "换一个模块" })])
    ])]);
  }

  // 前测 / 后测的切换：两个链接，当前的那个高亮（换一个就是换一个地址，各存各的）
  function switcher() {
    var seg = h("div", { cls: "ck-seg", role: "group", "aria-label": "前测还是后测" });
    ["pre", "post"].forEach(function (t) {
      seg.appendChild(h("a", { href: href(S.m, t), "data-ck-switch": t, "aria-current": t === S.t ? "page" : null, text: T_NAME[t] }));
    });
    return h("div", { cls: "ck-which-row" }, [seg, h("a", { cls: "ck-small ck-alt", href: href(), text: "换一个模块" })]);
  }

  function showIntro() {
    var st = readStore();
    var old = getRun(st, S.m, S.t);
    var draft = getDraft(st, S.m, S.t);
    var draftSel = draft ? selFromDraft(draft) : null;
    var draftDone = 0;
    if (draftSel) S.items.forEach(function (it, k) { if (complete(it, draftSel[k])) draftDone++; });
    if (draftSel && !draftDone && !draftSel.some(function (s) { return s.ch || s.rs || s.cf; })) draftSel = null;
    var n = S.items.length;
    var withReason = S.items.filter(function (it) { return !!it.reason; }).length;
    var howTo = withReason === n ? "每题先选答案，再选理由，最后选「有把握」或「没把握」。"
      : withReason ? "每题选答案（有的题还要选理由），再选「有把握」或「没把握」。"
        : "每题选答案，再选「有把握」或「没把握」。";

    var input = h("input", {
      id: "ck-code", type: "text", maxlength: CODE_MAX, autocomplete: "off", autocapitalize: "off", spellcheck: "false",
      "aria-describedby": "ck-code-note"
    });
    input.value = draftSel && draft.code ? String(draft.code).slice(0, CODE_MAX) : "";
    // 有没做完的草稿时，主按钮是草稿提示里的「接着做」，这里的「重新开始」退成普通按钮，点了还要确认
    var startBtn = h("button", { type: "button", cls: draftSel ? "qz-btn" : "qz-btn qz-primary", "data-ck-start": true,
      text: draftSel ? "重新开始" : old ? "重新做" + T_NAME[S.t] : "开始" + T_NAME[S.t] });
    var acts = h("div", { cls: "qz-actions" }, [startBtn]);
    S.confirm = false;
    var confirmBox = h("div", { cls: "ck-confirm", role: "alert", hidden: true });

    var kids = [
      h("h2", { cls: "qz-panel-title", text: modTitle(S.m) + " · " + T_NAME[S.t] }),
      switcher(),
      h("ul", { cls: "ck-rules" }, [
        h("li", { text: "共 " + n + " 题，一屏一题。" + howTo }),
        h("li", { text: "做的时候不显示对错，可以退回去改；做完看小结，能下载 CSV 交给老师。" })
      ])
    ];
    if (old) {
      var ox = stats(old);
      kids.push(h("div", { cls: "ck-note", "data-ck-old": true }, [
        h("p", { text: "这台设备上已经有一次" + T_NAME[S.t] + "：" + K().fmtMD(old.date) + "交卷，正确率 " + frac(ox.pass, ox.n) + "。" }),
        h("div", { cls: "qz-actions" }, [h("button", { type: "button", cls: "qz-btn", "data-ck-view": true, text: "看上次的小结" })])
      ]));
    }
    if (draftSel) {
      kids.push(h("div", { cls: "ck-note", "data-ck-draft": true }, [
        h("p", { text: "上次没做完：已经答了 " + draftDone + " / " + n + " 题。" }),
        h("div", { cls: "qz-actions" }, [h("button", { type: "button", cls: "qz-btn qz-primary", "data-ck-resume": true, text: "接着做" })])
      ]));
    }
    kids.push(h("div", { cls: "ck-field" }, [
      h("label", { "for": "ck-code", text: "编号（可不填）" }),
      input,
      h("p", { id: "ck-code-note", cls: "qz-muted", text: "老师给了编号再填，用来对上同一个人的前测和后测。编号只写进导出的 CSV，不会上传。" })
    ]));
    kids.push(acts);
    kids.push(confirmBox);
    var panel = h("div", { cls: "qz-panel ck-intro" }, kids);
    setView("intro", [panel]);

    function readCode() { return String(input.value || "").replace(/\s+/g, " ").trim().slice(0, CODE_MAX); }
    function begin(fromDraft) {
      S.confirm = false;
      S.code = readCode();
      if (fromDraft && draftSel) {
        S.sel = draftSel;
        S.i = Math.max(0, Math.min(+draft.i || 0, firstIncompleteOf(draftSel)));
      } else {
        S.sel = S.items.map(emptySel);
        S.i = 0;
      }
      showQuiz(true);
      saveDraft();
    }
    function firstIncompleteOf(sel) {
      for (var k = 0; k < S.items.length; k++) if (!complete(S.items[k], sel[k])) return k;
      return S.items.length - 1;
    }
    // 会丢东西的「开始」先在页面里确认（不用 window.confirm：微信里样式怪，自动化测试也会默认点「取消」）：
    //   有没做完的草稿：重新开始会清掉它（「接着做」仍是主按钮）；已经有一次同样的测：交卷时会替换它
    startBtn.addEventListener("click", function () {
      if (!old && !draftSel) { begin(false); return; }
      S.confirm = true;
      clear(confirmBox);
      var msg = "";
      if (draftSel) {
        msg = draftDone ? "重新开始会清掉没做完的 " + draftDone + " 题，从第 1 题做起。"
          : "重新开始会清掉上次已经选了的答案，从第 1 题做起。";
        if (old) msg += "交卷时还会替换这台设备上上一次的" + T_NAME[S.t] + "记录，还没导出的话，先点「看上次的小结」下载 CSV。";
      } else {
        msg = "重新做，交卷时会替换这台设备上上一次的" + T_NAME[S.t] + "记录。还没导出的话，先点「看上次的小结」下载 CSV。";
      }
      confirmBox.appendChild(h("p", { text: msg }));
      var btns;
      var yes;
      if (draftSel) {
        yes = h("button", { type: "button", cls: "qz-btn", "data-ck-confirm": true, text: "确定，重新开始" });
        var keep = h("button", { type: "button", cls: "qz-btn qz-primary", "data-ck-keep": true, text: "接着做" });
        keep.addEventListener("click", function () { begin(true); });
        btns = [yes, keep];
      } else {
        yes = h("button", { type: "button", cls: "qz-btn qz-primary", "data-ck-confirm": true, text: "确定，重新做" });
        var no = h("button", { type: "button", cls: "qz-btn", "data-ck-cancel": true, text: "取消" });
        no.addEventListener("click", function () { S.confirm = false; confirmBox.hidden = true; acts.hidden = false; focusQuiet(startBtn); });
        btns = [yes, no];
      }
      yes.addEventListener("click", function () { begin(false); });
      confirmBox.appendChild(h("div", { cls: "qz-actions" }, btns));
      confirmBox.hidden = false;
      acts.hidden = true;
      focusQuiet(yes);
    });
    var viewBtn = panel.querySelector("[data-ck-view]");
    if (viewBtn) viewBtn.addEventListener("click", function () { S.run = old; S.saved = true; showSummary(); });
    var resumeBtn = panel.querySelector("[data-ck-resume]");
    if (resumeBtn) resumeBtn.addEventListener("click", function () { begin(true); });
  }

  /* ---------- 作答：一屏一题 ---------- */
  function showQuiz(scroll) {
    var it = S.items[S.i], sel = S.sel[S.i], n = S.items.length, last = S.i === n - 1;
    var head = h("p", { cls: "qz-run-head ck-num", tabindex: "-1", "data-ck-num": S.i + 1, text: "第 " + (S.i + 1) + " / " + n + " 题" });
    var barFill = h("span");
    var bar = h("div", { cls: "qz-run-bar", "aria-hidden": "true" }, [barFill]);

    var card = h("section", { cls: "qz-card ck-card", "data-qid": it.id, "data-type": it.type || "", "aria-labelledby": "ck-stem" });
    card.appendChild(h("p", { cls: "qz-stem", id: "ck-stem", text: it.stem || "" }));
    var figs = (it.figures || []).filter(Boolean);
    var figJobs = [];
    if (figs.length) {
      var fw = h("div", { cls: "qz-figs", "data-n": figs.length });
      figs.forEach(function (spec) {
        var f = h("div", { cls: "qz-fig", role: "img", "aria-label": "题目配图" });
        fw.appendChild(f);
        figJobs.push([f, spec]);
      });
      card.appendChild(fw);
    }

    var ans = h("div", { cls: "qz-answer" });
    function group(attr, label) {
      var keyOf = KEY_OF[attr];
      var lab = h("p", { cls: "qz-q", id: "ck-q-" + attr, text: label });
      var opts = shownOpts(it, attr);
      var hasFig = opts.some(function (o) { return !!o.figure; });
      var grid = h("div", { cls: "qz-opts " + (hasFig ? "qz-opts-fig" : "qz-opts-text"), role: "group", "aria-labelledby": lab.id, "data-n": opts.length });
      opts.forEach(function (o, k) {
        var b = h("button", { type: "button", cls: "qz-opt", "aria-pressed": "false" }, [
          h("span", { cls: "qz-opt-row" }, [
            h("span", { cls: "qz-opt-key", "aria-hidden": "true", text: keyOf(k) }),
            h("span", { cls: "qz-opt-text", text: o.text || "" })
          ])
        ]);
        b.setAttribute(attr === "ans" ? "data-qz-ans" : "data-qz-rs", o.id);
        if (o.figure) {
          // 缩略图只是选项文字的图示，读屏软件读文字就够了；点图等于点按钮（quiz.css 里缩略图不接指针事件）
          var f = h("span", { cls: "qz-fig qz-thumb", "aria-hidden": "true" });
          b.appendChild(f);
          figJobs.push([f, o.figure]);
        }
        b.addEventListener("click", function () { choose(attr, o.id); });
        grid.appendChild(b);
      });
      return h("div", { cls: "qz-part qz-part-" + attr }, [lab, grid]);
    }
    ans.appendChild(group("ans", "选一个答案"));
    if (it.reason) ans.appendChild(group("rs", "为什么？选一个理由"));
    var cfLab = h("p", { cls: "qz-q", id: "ck-q-cf", text: "你对上面的选择有把握吗？" });
    var cfs = h("div", { cls: "qz-cfs", role: "group", "aria-labelledby": "ck-q-cf" });
    ["sure", "unsure"].forEach(function (v) {
      var b = h("button", { type: "button", cls: "qz-cf", "data-qz-cf": v, "aria-pressed": "false", text: CF_NAME[v] });
      b.addEventListener("click", function () { choose("cf", v); });
      cfs.appendChild(b);
    });
    ans.appendChild(h("div", { cls: "qz-part qz-part-cf" }, [cfLab, cfs]));
    card.appendChild(ans);

    // 底部导航贴在屏幕下沿（sticky）：题目长、要往下翻时，「下一题」也一直看得见
    var need = h("p", { cls: "ck-need", "aria-live": "polite" });
    var prev = h("button", { type: "button", cls: "qz-btn ck-prev", "data-ck-prev": true, disabled: S.i === 0, text: "上一题" });
    var next = last
      ? h("button", { type: "button", cls: "qz-btn qz-primary ck-next", "data-ck-finish": true, text: "交卷，看小结" })
      : h("button", { type: "button", cls: "qz-btn qz-primary ck-next", "data-ck-next": true, text: "下一题" });
    var nav = h("div", { cls: "ck-nav" }, [need, h("div", { cls: "ck-nav-btns" }, [prev, next])]);

    var wrap = h("div", { cls: "ck-quiz" }, [
      h("div", { cls: "ck-qhead" }, [head, h("span", { cls: "ck-which", text: modTitle(S.m) + " · " + T_NAME[S.t] })]),
      bar, card, nav
    ]);
    setView("quiz", [wrap]);
    figJobs.forEach(function (j) { drawFig(j[0], j[1]); });

    function paint() {
      var s = S.sel[S.i];
      $$("[data-qz-ans]", card).forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-qz-ans") === s.ch ? "true" : "false"); });
      $$("[data-qz-rs]", card).forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-qz-rs") === s.rs ? "true" : "false"); });
      $$("[data-qz-cf]", card).forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-qz-cf") === s.cf ? "true" : "false"); });
      var miss = missing(it, s);
      next.disabled = miss.length > 0;
      need.textContent = miss.length ? "还没选：" + miss.join("、") : (last ? "都选好了，可以交卷。交卷后不能再改。" : "");
      barFill.style.width = pct(doneCount(), n) + "%";
    }
    function choose(kind, id) {
      var s = S.sel[S.i];
      if (kind === "ans") s.ch = id; else if (kind === "rs") s.rs = id; else s.cf = id;
      paint();
      flushTime();
      saveDraft();
    }
    paint();
    prev.addEventListener("click", function () {
      if (S.i === 0) return;
      flushTime();
      S.i -= 1;
      saveDraft();
      showQuiz(true);
    });
    next.addEventListener("click", function () {
      if (!complete(it, sel)) return;
      flushTime();
      if (last) { finish(); return; }
      S.i += 1;
      saveDraft();
      showQuiz(true);
    });
    S.t0 = document.hidden ? null : now();
    if (scroll) { jumpTo(wrap); focusQuiet(head); }
  }

  function finish() {
    var core = K();
    // 万一有没答完的题（例如题库在做题过程中更新了），回到第一道没答完的
    var k0 = -1;
    S.items.forEach(function (it, k) { if (k0 < 0 && !complete(it, S.sel[k])) k0 = k; });
    if (k0 >= 0) { S.i = k0; showQuiz(true); return; }
    var rows = S.items.map(function (it, k) {
      var s = S.sel[k];
      var res = core.classify(it, { ch: s.ch, rs: s.rs, cf: s.cf });
      var row = { id: it.id, ch: s.ch, rs: it.reason ? s.rs : "", cf: s.cf, cls: res.cls, ans: !!res.ans, tags: res.tags.slice(), ms: Math.round(s.ms) };
      // 记下学生看到的字母 / 序号，CSV 里和题库选项 id 一起写：题库的排列和 id 不对应，老师不会把「C」当成选项 c
      row.chKey = shownKey(it, "ans", s.ch);
      if (it.reason) row.rsKey = shownKey(it, "rs", s.rs);
      return row;
    });
    var run = { v: 1, m: S.m, t: S.t, date: core.today(), at: new Date().toISOString(), code: S.code, items: rows };
    var st = readStore();
    putIn(st, "runs", S.m, S.t, run);
    putIn(st, "drafts", S.m, S.t, null);
    S.saved = writeStore(st);
    S.run = run;
    S.view = "summary-pending"; // 先离开作答状态，后面不再计时、不再写草稿
    showSummary(true);
  }

  /* ---------- 小结 ---------- */
  function fracNode(k, n, attrs) {
    var a = attrs || {};
    a["data-n"] = k;
    a["data-total"] = n;
    return h("b", a, [h("span", { text: k + " / " + n }), h("span", { text: "（" + pct(k, n) + "%）" })]);
  }

  function showSummary(scroll) {
    var run = S.run;
    var st = readStore();
    var x = stats(run);
    var pre = getRun(st, S.m, "pre"), post = getRun(st, S.m, "post");
    // 刚交卷但没存上（无痕模式）：对比时用手上这一次
    if (run.t === "pre") pre = run; else post = run;

    var kids = [
      h("h2", { cls: "qz-panel-title", tabindex: "-1", text: "小结：" + modTitle(run.m) + " · " + T_NAME[run.t] }),
      h("p", { cls: "qz-muted", text: K().fmtMD(run.date) + "交卷 · 共 " + x.n + " 题 · 这是诊断小测，不计分" }),
      switcher()
    ];
    if (!S.saved) {
      kids.push(h("p", { cls: "qz-error", text: "这台设备没能保存这次记录（可能开了无痕模式或存储已满）。关掉页面前先下载或复制 CSV。" }));
    }
    kids.push(h("div", { cls: "ck-stats" }, [
      h("div", { cls: "ck-stat" }, [
        h("span", { cls: "ck-stat-lbl", text: "正确率" }),
        fracNode(x.pass, x.n, { cls: "ck-stat-val", "data-ck-acc": true }),
        h("span", { cls: "ck-stat-sub", text: "答案、理由都对，而且有把握" })
      ]),
      h("div", { cls: "ck-stat ck-stat-warn" }, [
        h("span", { cls: "ck-stat-lbl", text: "有把握却答错" }),
        fracNode(x.sureWrong, x.n, { cls: "ck-stat-val", "data-ck-surewrong": true }),
        h("span", { cls: "ck-stat-sub", text: "答案选错了，却选了「有把握」" })
      ])
    ]));

    var tags = tagList([pre, post]);
    if (tags.length) {
      var ul = h("ul", { cls: "ck-mcs" });
      tags.forEach(function (t) {
        var c = x.tags[t] || 0;
        ul.appendChild(h("li", { cls: "ck-mc", "data-ck-mc": t, "data-n": c, "data-zero": c ? null : "true" }, [
          h("span", { cls: "ck-mc-name", text: tagName(t) }),
          h("b", { cls: "ck-mc-n", text: c + " 次" })
        ]));
      });
      kids.push(h("h3", { cls: "ck-h3", text: "常见的错误想法：这次选到了几次" }));
      kids.push(h("p", { cls: "qz-muted ck-sub", text: "每道题里选到的错误想法各记一次（答案和理由指向同一个想法时只记一次）。" }));
      kids.push(ul);
    }

    if (pre && post) {
      kids.push(h("h3", { cls: "ck-h3", text: "前测和后测" }));
      kids.push(compareTable(pre, post, tags));
    } else {
      kids.push(h("p", { cls: "qz-muted ck-later", text: run.t === "pre"
        ? "学完以后在这台设备上做一次后测，这里会把前后两次的数字并排显示。"
        : "这台设备上没有前测的记录，所以没有前后对比。" }));
    }

    // 导出：下载 CSV；微信等不让下载的浏览器里，用「复制 CSV 文本」。keyed：这一次交卷时记了显示的字母（见 SHUFFLE）
    var keyed = run.items.some(function (r) { return !!r.chKey; });
    var dl = h("button", { type: "button", cls: "qz-btn qz-primary", "data-ck-csv": true, text: "下载 CSV" });
    var cp = h("button", { type: "button", cls: "qz-btn", "data-ck-copy": true, text: "复制 CSV 文本" });
    var msg = h("p", { cls: "ck-msg", "aria-live": "polite" });
    var ta = h("textarea", { cls: "ck-csvtext", "data-ck-csvtext": true, readonly: true, rows: 6, hidden: true, "aria-label": "CSV 文本" });
    dl.addEventListener("click", function () {
      msg.textContent = download(run)
        ? "已生成文件「" + csvName(run) + "」。没有开始下载的话（例如在微信里），点「复制 CSV 文本」。"
        : "这个浏览器不能下载文件，点「复制 CSV 文本」。";
    });
    cp.addEventListener("click", function () {
      var text = csvOf(run);
      copyText(text, ta, function (ok) {
        msg.textContent = ok ? "已复制。可以粘贴到电子表格，或发给老师。" : "没能自动复制：下面的文字已经选中，长按（电脑上按 Ctrl+C）复制。";
        if (ok) ta.hidden = true;
      });
    });
    kids.push(h("div", { cls: "ck-export" }, [
      h("h3", { cls: "ck-h3", text: "交给老师" }),
      h("p", { cls: "qz-muted ck-sub", text: "CSV 每题一行：答案、理由、把握、判定、错误概念标签、用时。" +
        (keyed ? "答案、理由写题库里的选项 id，括号里是屏幕上显示的字母或序号。" : "答案、理由写题库里的选项 id。") }),
      // 判定的四个代码（和 core.classify 一致：判为错误概念却对不上任何错误想法时记 gap）
      h("p", { cls: "qz-muted ck-sub ck-legend", "data-ck-legend": true,
        text: "「判定」一列：pass 答案、理由都对且有把握；unsure 都对但没把握；mc 错误概念（理由错，或答错却有把握，且选到的错项对应某个错误想法）；gap 知识缺漏（其余答错的情况，例如答错又没把握）。" }),
      h("div", { cls: "qz-actions" }, [dl, cp]),
      msg, ta
    ]));

    var links = [];
    if (run.t === "pre" && !getRun(st, run.m, "post")) links.push(h("a", { cls: "qz-btn", href: href(run.m, "post"), text: "学完了？做后测 →" }));
    links.push(h("a", { cls: "qz-btn", href: MOD_INFO[run.m].page,"data-ck-lab": true, text: "回到" + MOD_INFO[run.m].lab }));
    links.push(h("a", { cls: "qz-btn", href: href(), text: "换一个模块" }));
    kids.push(h("div", { cls: "qz-actions ck-links" }, links));

    var panel = h("div", { id: "ck-summary", cls: "qz-panel", "data-m": run.m, "data-t": run.t }, kids);
    setView("summary", [panel]);
    if (scroll) { jumpTo(panel); focusQuiet(panel.querySelector(".qz-panel-title")); }
  }

  function compareTable(pre, post, tags) {
    var a = stats(pre), b = stats(post);
    var tbody = h("tbody");
    function cell(col, k, n) {
      return h("td", { "data-ck-col": col, "data-n": k, "data-total": n }, [h("span", { text: k + " / " + n }), h("span", { text: "（" + pct(k, n) + "%）" })]);
    }
    function row(key, label, ka, kb, cls) {
      tbody.appendChild(h("tr", { "data-ck-row": key, cls: cls || null }, [
        h("th", { scope: "row", text: label }), cell("pre", ka, a.n), cell("post", kb, b.n)
      ]));
    }
    row("acc", "正确率", a.pass, b.pass);
    row("surewrong", "有把握却答错", a.sureWrong, b.sureWrong);
    tags.forEach(function (t) {
      var ka = a.tags[t] || 0, kb = b.tags[t] || 0;
      tbody.appendChild(h("tr", { "data-ck-row": "mc:" + t, cls: "ck-cmp-mc" + (ka || kb ? "" : " ck-zero") }, [
        h("th", { scope: "row", text: tagName(t) }),
        h("td", { "data-ck-col": "pre", "data-n": ka, text: ka + " 次" }),
        h("td", { "data-ck-col": "post", "data-n": kb, text: kb + " 次" })
      ]));
    });
    var thead = h("thead", null, [h("tr", null, [
      h("th", { scope: "col", text: "" }),
      h("th", { scope: "col" }, [T_NAME.pre, h("small", { text: K().fmtMD(pre.date) })]),
      h("th", { scope: "col" }, [T_NAME.post, h("small", { text: K().fmtMD(post.date) })])
    ])]);
    return h("div", { cls: "ck-cmp", "data-ck-compare": true }, [h("table", null, [thead, tbody])]);
  }

  function showError(text, retry) {
    var kids = [h("p", { cls: "qz-error", text: text })];
    if (retry) {
      var b = h("button", { type: "button", cls: "qz-btn", text: "重试" });
      b.addEventListener("click", retry);
      kids.push(h("div", { cls: "qz-actions" }, [b]));
    }
    setView("error", kids);
  }

  /* ---------- 启动 ---------- */
  function start() {
    var m = String(param("m") || "").toLowerCase();
    var t = String(param("t") || "").toLowerCase();
    S.m = MODS.indexOf(m) !== -1 ? m : "";
    S.t = t === "pre" || t === "post" ? t : "";
    if (!S.m) { showChooser(S.t); return; }
    if (!S.t) { showTypeChooser(); return; }
    if (!window.ABSLabQuiz || !K()) { showError("页面没有加载完整，请检查网络后刷新。"); return; }
    setView("loading", [h("p", { cls: "qz-loading", text: "正在读取题目……" })]);
    // 只读静态文件（ABSLabQuiz.load 读 index.json、题库、misconceptions.json、link-names.json），不调任何接口
    window.ABSLabQuiz.load().then(function (bank) {
      S.bank = bank;
      S.items = bank.items.filter(function (it) { return it.module === S.m && it.retest === true && it.type !== "predict"; });
      S.tags = [];
      S.items.forEach(function (it) {
        K().itemTags(it).forEach(function (tg) { if (S.tags.indexOf(tg) === -1) S.tags.push(tg); });
      });
      if (!S.items.length) { showError("这个模块还没有小测题。"); return; }
      showIntro();
    }, function () {
      showError("题目读取失败，请检查网络后重试。", start);
    });
  }

  // 切到后台、锁屏时停表并存草稿；回来接着计时。pagehide：微信、iOS 关页面时 beforeunload 不一定触发
  document.addEventListener("visibilitychange", function () {
    if (S.view !== "quiz") return;
    if (document.hidden) { flushTime(); S.t0 = null; saveDraft(); } else { S.t0 = now(); }
  });
  window.addEventListener("pagehide", function () {
    if (S.view !== "quiz") return;
    flushTime();
    saveDraft();
  });

  // 测试钩子（只读）：state() 给当前画面和作答状态的快照；csvText(m, t) 给某一次小测的 CSV 文本
  // （不带 BOM；下载的文件 = BOM + 这段文字）。不给参数时是小结里正在看的那一次。
  window.__check = {
    state: function () {
      var st = readStore();
      return JSON.parse(JSON.stringify({
        view: S.view, m: S.m, t: S.t, i: S.i, n: S.items.length,
        items: S.items.map(function (it) { return it.id; }),
        sel: S.sel, code: S.code, run: S.run,
        stats: S.run ? stats(S.run) : null,
        store: st
      }));
    },
    csvText: function (m, t) {
      if (m && t) return csvOf(getRun(readStore(), m, t));
      return S.run ? csvOf(S.run) : "";
    }
  };

  start();
})();
