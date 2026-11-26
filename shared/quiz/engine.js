/* ABS-LAB 理解测试 · 作答界面（四科共用）→ window.ABSLabQuiz
 *
 * 页面加载顺序（见 math/demo-poe.html、review.html）：
 *   <head> theme.css、quiz/quiz.css、auth.js → <body> 开头 topbar.js → … → svgkit.js → quiz/core.js → 本文件
 *   → 部件脚本（registerWidget）→ 页面脚本（mount / mountReview）。
 *
 * 分工：判定、重测排期、选题、交错、掌握门槛、错题条目怎么写，全在 core.js（ABSLabQuizCore）；
 *   这里只管画界面、读写本机和接口。规则只有一份，单元测试测的就是界面用的那一份，改规则不会漏改。
 *
 * 存储：
 *   - 登录用户（有云端令牌）：作答 POST api/quiz；可能要进错题本时，再 GET api/mistakes 取最新 →
 *     core.buildMistakes → 逐条 POST api/mistakes upsert。几次保存排队串行，避免两张卡片同时改同一条错题。
 *   - 游客和本地账号（没有令牌）：作答只记在本机 localStorage["abslab.quiz.v1"]，不同步、不进错题本，一个 POST 都不发。
 *   - 登录以后不自动把游客记录并进账号：同一台设备可能是别人做的，并进去会弄乱这个账号的错题本和重测计划。
 *
 * 语法不超过 ES2019（不用 ?. 和 ??），与 shared/*.js 一样用 var + function，兼容较旧的微信内置浏览器。
 */
(function () {
  "use strict";
  if (window.ABSLabQuiz) return; // 重复加载时不重复挂监听

  var SCRIPT = document.currentScript;
  // 根路径从脚本自己的地址推出：线上在 /abs-lab/ 子路径下，页面又分布在不同层级的目录里
  var ROOT = SCRIPT && SCRIPT.src ? SCRIPT.src.replace(/shared\/quiz\/engine\.js(\?.*)?$/, "") : "";
  var API = ROOT + "api/";
  var QUIZ_DIR = ROOT + "shared/quiz/";
  var GUEST_KEY = "abslab.quiz.v1";
  var SEEN_KEY = "abslab.quiz.seen";
  // index.json 由 tools/build-index.py 生成；万一读不到（本地还没生成），至少能加载第 0 批题库，页面不至于空白
  var FALLBACK_FILES = ["items/math-demo.json"];
  var MODES = ["poe", "practice", "retest"];
  var TYPE_NAME = { predict: "预测关卡", twotier: "二段式", transfer: "迁移", inverse: "逆向" };
  var SUBJECT_NAME = { math: "数学", physics: "物理", chemistry: "化学", biology: "生物" };
  var ANS_KEYS = "ABCDEFGHIJ";
  var EX_MAX = 120;

  var WIDGETS = {};  // 部件 id → factory
  var EXTERNAL = {}; // 外部部件 id → { cover, bind, scrollTarget, card }（部件的 DOM 是页面自己的，见 registerExternal）
  var PENDING = {};  // 部件还没注册就已经渲染出来的卡片，注册时再挂上
  var CARDS = [];    // 页面上的卡片（登录状态变化时更新记录去向）
  var REVIEWS = [];  // mountReview 的实例（登录状态变化时重新渲染）
  var uidN = 0;

  function K() { return window.ABSLabQuizCore; }
  function noop() {}
  function uid(p) { uidN += 1; return (p || "qz") + "-u" + uidN; }

  /* ---------- DOM 小工具：全部用 textContent 写字，学生写的解释原样显示、不会被当成 HTML ---------- */
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
  function show(n, on) { if (n) n.hidden = !on; }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  // 只做瞬时滚动：平滑滚动会在 e2e 的拖动测试里改 scrollY，减弱动效的用户也不希望页面自己滑
  function jumpTo(n) {
    if (!n || !n.scrollIntoView) return;
    try { n.scrollIntoView({ block: "start" }); } catch (e) { n.scrollIntoView(true); }
  }
  function inDoc(n) { return !!(n && document.documentElement.contains(n)); }

  /* ---------- 本机存储（无痕模式、存储满了都可能抛错，一律吞掉） ---------- */
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsJSON(k) {
    var raw = lsGet(k);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function readGuest() {
    var g = lsJSON(GUEST_KEY);
    if (!g || typeof g !== "object" || !g.items || typeof g.items !== "object") g = { v: 1, items: {} };
    g.v = 1;
    return g;
  }
  function writeGuest(g) { lsSet(GUEST_KEY, JSON.stringify(g)); }
  function readSeen() {
    var s = lsJSON(SEEN_KEY);
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  }
  function markSeen(qid) {
    var s = readSeen();
    s[qid] = K().today();
    lsSet(SEEN_KEY, JSON.stringify(s));
  }
  // 「显示高中内容」开关存的是 JSON 字符串 "true"/"false"；只有物理、化学有这个开关
  function hsFlags() {
    return { physics: lsGet("wlzs.showHS") === "true", chemistry: lsGet("hxzs.showHS") === "true" };
  }

  /* ---------- 登录与接口 ---------- */
  // 有云端令牌才算登录用户；本地账号（没有令牌）和游客一样只记本机
  function token() {
    var A = window.ABSLabAuth;
    try { return (A && A.getToken && A.getToken()) || null; } catch (e) { return null; }
  }
  function httpError(status, j) {
    var msg = (j && j.message) || "";
    if (!msg) {
      msg = status === 401 ? "登录状态已过期，请重新登录" :
        status === 404 ? "接口不存在（" + status + "）" :
        status === 503 ? "云端数据库暂时没有连接" : "服务器返回 " + status;
    }
    var e = new Error(msg);
    e.status = status;
    return e;
  }
  function request(path, body) {
    var t = token();
    if (!t) return Promise.reject(new Error("没有登录"));
    var opt = { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + t } };
    if (body) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    return fetch(API + path, opt).then(function (r) {
      return r.json().then(null, function () { return null; }).then(function (j) {
        if (!r.ok || !j || j.ok === false) throw httpError(r.status, j);
        return j;
      });
    }, function () { throw new Error("网络连接失败"); });
  }
  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("读取失败（" + r.status + "）");
      return r.json();
    });
  }

  /* ---------- 题库：每页只取一次 ---------- */
  var LOAD = null;
  function load() {
    if (LOAD) return LOAD;
    var p = getJSON(QUIZ_DIR + "index.json").then(null, function () { return null; }).then(function (index) {
      var files = index && Array.isArray(index.files) && index.files.length ? index.files : FALLBACK_FILES;
      return Promise.all([
        Promise.all(files.map(function (f) { return getJSON(QUIZ_DIR + f).then(null, function () { return null; }); })),
        getJSON(QUIZ_DIR + "misconceptions.json").then(null, function () { return null; }),
        getJSON(ROOT + "shared/link-names.json").then(null, function () { return null; })
      ]).then(function (res) {
        var items = [], byId = {};
        res[0].forEach(function (bank) {
          ((bank && bank.items) || []).forEach(function (it) {
            if (it && it.id && !byId[it.id]) { byId[it.id] = it; items.push(it); }
          });
        });
        if (!items.length) throw new Error("题库读取失败");
        return {
          items: items, byId: byId,
          tags: (res[1] && res[1].tags) || {},
          // core.buildMistakes 按 "学科:键" 查知识点名称（n）和所在章（c），即 link-names.json 的 kps
          names: (res[2] && res[2].kps) || {},
          index: index || { v: 1, files: files }
        };
      });
    });
    LOAD = p;
    // 失败了不缓存，下一次调用（比如刷新列表）可以再试
    p.then(null, function () { if (LOAD === p) LOAD = null; });
    return p;
  }

  /* ---------- 测试记录 ---------- */
  // 登录用户：GET api/quiz 每页一次并缓存；保存作答后用接口返回的这道题的记录更新缓存
  var REC = { tok: null, data: null, p: null };
  function loadRecords() {
    var t = token();
    if (!t) return Promise.resolve(readGuest().items);
    if (REC.tok === t && REC.data) return Promise.resolve(REC.data);
    if (REC.tok === t && REC.p) return REC.p;
    REC.tok = t;
    REC.data = null;
    var p = request("quiz").then(function (j) {
      var items = j && j.items && typeof j.items === "object" ? j.items : {};
      if (REC.p === p) REC.data = items;
      return items;
    }, function () {
      // 读不到就当没有记录，题照样能做；不缓存失败，下次再试
      if (REC.p === p) REC.p = null;
      return {};
    });
    REC.p = p;
    return p;
  }
  function putRecord(qid, rec, attempt) {
    var base = REC.data || {};
    var next = {};
    Object.keys(base).forEach(function (k) { next[k] = base[k]; });
    next[qid] = rec && Array.isArray(rec.tries) ? rec : K().addAttempt(base, qid, attempt)[qid];
    REC.data = next;
    REC.tok = token();
    return next;
  }

  /* ---------- 保存一次作答 ---------- */
  var SAVEQ = Promise.resolve();
  function enqueue(fn) {
    var p = SAVEQ.then(fn, fn);
    SAVEQ = p.then(noop, noop);
    return p;
  }
  // → Promise<{ state: "guest" | "saved" | "error", mistakes: [写入的错题], retestKey, error }>，不会 reject
  //   retestKey：这次作答实际按哪一项重测排期（"" = 不是重测），记录去向那一行按它写
  function saveAttempt(bank, item, attempt, retestKey) {
    var core = K();
    if (!token()) {
      var g = readGuest();
      g.items = core.addAttempt(g.items, item.id, attempt);
      writeGuest(g);
      return Promise.resolve({ state: "guest", mistakes: [], retestKey: "" });
    }
    var fail = attempt.cls === "mc" || attempt.cls === "gap";
    var isRetest = attempt.mode === "retest" && !!retestKey;
    // 有部件或 retest!==true 的题，core.pickRetest 不会在 review.html 出它，按题记的 qz- 错题只能回原页面重做（契约 6.6）。
    // 所以在原页面重做这道题时，它自己的 qz- 错题若已到期，就把这次作答当作那条错题的重测；
    // 不这样做，这条错题会一直到期、怎么做对都推进不了。存进 api/quiz 的作答仍是原来的 mode（poe / practice）。
    var selfKey = !isRetest && (item.widget || item.retest !== true) ? "q:" + item.id : "";
    return enqueue(function () {
      // t 由服务器写（同一天里几次作答靠它排先后），这里不发
      var send = { d: attempt.d, cls: attempt.cls, ch: attempt.ch, rs: attempt.rs, cf: attempt.cf, tags: attempt.tags, ex: attempt.ex, mode: attempt.mode };
      var recs = null;
      var key = isRetest ? retestKey : "";
      return loadRecords().then(function () {
        return request("quiz", { op: "attempt", qid: item.id, attempt: send });
      }).then(function (j) {
        recs = putRecord(item.id, j && j.item, attempt);
        // 练习里答对（pass / unsure）不动错题本，就不必再取错题本；上面说的「只能回原页面重做的题」例外，要先看它的错题到没到期
        if (!isRetest && !fail && !selfKey) return [];
        // 每次都取最新的错题本再合并：别的设备、错题本抽屉可能刚改过同一条
        return request("mistakes").then(function (mj) {
          var existing = {};
          ((mj && mj.items) || []).forEach(function (m) { if (m && m.id) existing[m.id] = m; });
          var mode = attempt.mode;
          if (selfKey) {
            var own = existing[core.qzId(item.id)];
            // keyOfMistake 相同（含 origin "quiz"）才算这道题自己的错题，与 review.html 的到期列表认的是同一条
            if (own && core.keyOfMistake(own) === selfKey && +own.status !== 2 && core.isDue(core.normReview(own.review), attempt.d)) {
              mode = "retest";
              key = selfKey;
            } else if (!fail) {
              return [];
            }
          }
          var list = core.buildMistakes({
            item: item, attempt: attempt, mode: mode, retestKey: key,
            existing: existing, tags: bank.tags, names: bank.names,
            records: recs, items: bank.byId[item.id] ? bank.items : bank.items.concat([item]),
            today: attempt.d
          });
          return list.reduce(function (p, m) {
            return p.then(function () { return request("mistakes", { op: "upsert", item: m }); });
          }, Promise.resolve()).then(function () { return list; });
        });
      }).then(function (list) {
        return { state: "saved", mistakes: list || [], retestKey: key };
      }, function (err) {
        return { state: "error", mistakes: [], retestKey: key, error: err };
      });
    });
  }

  function tagName(bank, tag) { return (bank.tags[tag] && bank.tags[tag].name) || tag; }
  function mistakeName(bank, m) { return /^mc-/.test(m.id) ? tagName(bank, m.id.slice(3)) : "这道题"; }
  function mistakeIdOf(key) { return key.indexOf("q:") === 0 ? K().qzId(key.slice(2)) : "mc-" + key; }
  function findById(list, id) {
    for (var i = 0; i < (list || []).length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  // 记录去向那一行的文字（契约 6.3）。
  // retestKey 是 saveAttempt 给出的「实际按哪一项重测排期」：在原页面重做到期的预测关卡时，
  // 作答的 mode 仍是 poe，但这次推进了它自己的 qz- 错题，这一行要写「「这道题」下次重测：…」
  function recordText(bank, attempt, retestKey, out) {
    var core = K();
    if (out.state === "error") return "保存失败：" + ((out.error && out.error.message) || "未知原因") + "。";
    var list = out.mistakes || [];
    var fail = attempt.cls === "mc" || attempt.cls === "gap";
    if (retestKey && !fail) {
      var m = findById(list, mistakeIdOf(retestKey));
      if (!m) return "已记录这次作答";
      var nm = "「" + mistakeName(bank, m) + "」";
      var due = m.review && m.review.due ? m.review.due : "";
      if (+m.status === 2 || !due) return nm + "已掌握，不再安排重测";
      if (attempt.cls === "unsure") {
        return nm + (due === core.addDays(attempt.d, 1) ? "明天再测一次" : core.fmtMD(due) + "再测一次");
      }
      return nm + "下次重测：" + core.fmtMD(due);
    }
    if (fail && list.length) {
      var names = list.map(function (x) { return "「" + mistakeName(bank, x) + "」"; }).join("、");
      var first = "";
      list.forEach(function (x) { var d = x.review && x.review.due; if (d && (!first || d < first)) first = d; });
      return "已存入错题本" + names + (first ? "，" + core.fmtMD(first) + "重测" : "");
    }
    return "已记录这次作答";
  }

  function openLogin() {
    if (typeof window.ABSLabOpenAuth === "function") window.ABSLabOpenAuth("login");
  }
  function loginButton() {
    var b = h("button", { type: "button", cls: "qz-btn", "data-qz-login": true, text: "登录 / 注册" });
    b.addEventListener("click", openLogin);
    return b;
  }

  // 静态图交给画板组件；它没加载成功时只是不画图，题目文字照常可用
  function drawFig(box, spec) {
    var S = window.ABSLabSVG;
    if (!box || !spec || box.__qzFig) return;
    if (!S || typeof S.figure !== "function") return;
    try { box.__qzFig = S.figure(box, spec) || true; } catch (e) { box.__qzFig = null; }
  }
  function dropFig(box) {
    if (!box) return;
    var b = box.__qzFig;
    if (b && typeof b.destroy === "function") { try { b.destroy(); } catch (e) { /* 已拆掉 */ } }
    box.__qzFig = null;
    clear(box);
  }

  /* ==================== 卡片 ==================== */
  function verdictOf(item, res, cf, isPredict) {
    var right = isPredict ? "预测对了" : "答对了";
    if (res.cls === "pass") {
      return { tag: right, text: isPredict ? "你的预测和实际结果一样，你也有把握。" : (item.reason ? "答案和理由都对，你也有把握。" : "你选对了，也有把握。") };
    }
    if (res.cls === "unsure") {
      return { tag: right + " · 没把握", text: "不过你选了「没把握」，这次先不算通过。弄清楚下面的道理，下次争取有把握地答对。" };
    }
    if (res.ans && !res.rsn) {
      return { tag: "理由不对", text: "答案选对了，但理由不对。理由反映的是你背后的想法，看看下面哪里要调整。" };
    }
    var head = isPredict ? "实际结果和你的预测不一样。" : "这个答案不对。";
    if (cf === "sure") {
      return { tag: "不对", text: head + (res.tags.length ? "你选了「有把握」，这往往说明有一个常见的想法在起作用。" : "你选了「有把握」，对照下面的解释找一找原因。") };
    }
    return { tag: "不对", text: head + "你也说没把握，先看下面的解释，把这里弄清楚。" };
  }

  function buildCard(host, item, ctx) {
    var core = K();
    var bank = ctx.bank;
    var isPredict = item.type === "predict" && !!item.widget;
    // 外部部件（registerExternal）：部件的 DOM 是页面自己的（例如电学实验台里现成的模块），卡片里不放部件，
    // 引擎只负责锁定、解锁、读进度和结果。要在 mount 之前注册，卡片才会按外部部件排版（见 README 第五节）
    var extAtBuild = isPredict && !!EXTERNAL[item.widget];
    // 预测关卡的作答一律记成 poe（预测—观察—解释），其余按调用方给的模式
    var amode = isPredict ? "poe" : ctx.mode;
    var explain = item.explain || { prompt: "用一句话说一说你看到了什么。", min: 0 };
    var exMin = Math.max(0, Math.min(EX_MAX, +explain.min || 0));
    var c = {
      item: item, isPredict: isPredict, stage: "", sel: { ch: "", rs: "", cf: "" },
      w: null, wFail: false, widgetDone: false, optFigs: [], figs: [], recEl: null, dead: false,
      ext: false, xd: null, cover: null, promptEl: null
    };

    // 外部部件且页面给了 promptHost：题头、题干、题图放进 promptHost（页面把它放在模块图上方），
    // 作答区留在 mount 的容器里（页面把它放在模块图紧下方），手机上预测选项就能紧跟在模块图下面。
    // 锚点 #qz-<题目 id> 跟着题干走，定位时先看到题目
    var split = extAtBuild && !!ctx.promptHost;
    var sec = h("section", {
      cls: "qz-card" + (isPredict ? " qz-card-predict" : "") + (extAtBuild ? " qz-card-ext" : ""), id: split ? null : "qz-" + item.id,
      "data-qid": item.id, "data-type": item.type || "", "data-mode": ctx.mode
    });
    c.el = sec;
    var top = sec;
    if (split) {
      top = h("div", { cls: "qz-prompt", id: "qz-" + item.id, "data-qid": item.id, "data-type": item.type || "" });
      c.promptEl = top;
    }

    /* --- 头部 --- */
    var head = h("div", { cls: "qz-head" }, [
      h("span", { cls: "qz-kind", text: ctx.mode === "retest" ? "重测题" : (TYPE_NAME[item.type] || "理解测试") }),
      item.level === "senior" ? h("span", { cls: "qz-lv", text: "高中" }) : null
    ]);
    top.appendChild(head);
    var steps = null;
    if (isPredict) {
      // 步骤条：不用写长说明，学生一眼看到「先预测、再动手、再对比、最后解释」
      steps = h("ol", { cls: "qz-steps", "aria-label": "步骤" }, ["预测", "动手", "对比", "解释"].map(function (t, i) {
        return h("li", { "data-s": ["predict", "operate", "compare", "explain"][i], text: t });
      }));
      head.appendChild(steps);
    }
    top.appendChild(h("p", { cls: "qz-stem", text: item.stem || "" }));
    var figs = (item.figures || []).filter(Boolean);
    if (figs.length) {
      var fw = h("div", { cls: "qz-figs", "data-n": figs.length });
      figs.forEach(function (spec) {
        var f = h("div", { cls: "qz-fig", role: "img", "aria-label": "题目配图" });
        fw.appendChild(f);
        c.figs.push([f, spec]);
      });
      top.appendChild(fw);
    }

    /* --- 部件区（预测关卡） --- */
    var wBox = null, wEl = null, lockEl = null, prog = null, cmpBtn = null, freeNote = null, wActs = null;
    var repBtn = null;
    if (isPredict) {
      wEl = h("div", { cls: "qz-widget", "data-qz-widget": item.widget });
      lockEl = h("div", { cls: "qz-lock", text: "先预测，再动手" });
      prog = h("p", { cls: "qz-progress", "aria-live": "polite" });
      cmpBtn = h("button", { type: "button", cls: "qz-btn", "data-qz-compare": true, disabled: true, text: "看对比" });
      repBtn = h("button", { type: "button", cls: "qz-btn", "data-qz-repredict": true, text: "重新预测" });
      wActs = h("div", { cls: "qz-actions qz-wacts" }, [cmpBtn]);
      freeNote = h("p", { cls: "qz-free-note", hidden: true, text: extAtBuild
        ? "你做过这道题的预测。上面的模块可以随意操作；想再检验一次，点「重新预测」。"
        : "你做过这道题的预测。部件可以随意操作；想再检验一次，点「重新预测」。" });
      // 外部部件：卡片里没有部件容器，进度、「看对比」「重新预测」放在作答区后面（见下）
      wBox = extAtBuild ? h("div", { cls: "qz-stage qz-stage-ext" }, [prog, wActs, freeNote]) : h("div", { cls: "qz-stage" }, [wEl, prog, wActs, freeNote]);
      if (!extAtBuild) sec.appendChild(wBox);
      cmpBtn.addEventListener("click", showCompare);
      repBtn.addEventListener("click", function () { enterPredict(true); });
    }

    /* --- 作答区 --- */
    var ansWrap = h("div", { cls: "qz-answer" });
    // 外部部件提交预测以后，选项收起成一行「你的预测：……」，模块的操作区不被一大块选项隔开；到反馈阶段再展开、标对错
    var picked = extAtBuild ? h("p", { cls: "qz-picked" }) : null;
    if (picked) ansWrap.appendChild(picked);
    function optGroup(secData, attr, keyOf, label) {
      var wrap = h("div", { cls: "qz-part qz-part-" + attr });
      var lab = h("p", { cls: "qz-q", id: uid("qzq"), text: label });
      var opts = (secData && secData.options) || [];
      var hasFig = opts.some(function (o) { return !!o.figure; });
      var grid = h("div", { cls: "qz-opts " + (hasFig ? "qz-opts-fig" : "qz-opts-text"), role: "group", "aria-labelledby": lab.id, "data-n": opts.length });
      opts.forEach(function (o, i) {
        var b = h("button", { type: "button", cls: "qz-opt", "aria-pressed": "false" }, [
          h("span", { cls: "qz-opt-row" }, [
            h("span", { cls: "qz-opt-key", "aria-hidden": "true", text: keyOf(i) }),
            h("span", { cls: "qz-opt-text", text: o.text || "" })
          ])
        ]);
        b.setAttribute(attr === "ans" ? "data-qz-ans" : "data-qz-rs", o.id);
        if (o.figure) {
          // 缩略图只是选项文字的图示，读屏软件读文字就够了
          var f = h("span", { cls: "qz-fig qz-thumb", "aria-hidden": "true" });
          b.appendChild(f);
          c.optFigs.push([f, o.figure]);
        }
        b.addEventListener("click", function () { choose(attr, o.id); });
        grid.appendChild(b);
      });
      wrap.appendChild(lab);
      wrap.appendChild(grid);
      return wrap;
    }
    ansWrap.appendChild(optGroup(item.answer, "ans", function (i) { return ANS_KEYS.charAt(i); },
      // 预测关卡的提问可以由题目自己给（item.ask，可选）：不是每个预测都是「选图象」，例如电子秤的刻度疏密
      isPredict ? (item.ask || "先预测：你认为图象是哪一个？") : "选一个答案"));
    if (item.reason) {
      ansWrap.appendChild(optGroup(item.reason, "rs", function (i) { return String(i + 1); }, "为什么？选一个理由"));
    }
    var cfLab = h("p", { cls: "qz-q", id: uid("qzq"), text: isPredict ? "你对这个预测有把握吗？" : "你对上面的选择有把握吗？" });
    var cfSure = h("button", { type: "button", cls: "qz-cf", "data-qz-cf": "sure", "aria-pressed": "false", text: "有把握" });
    var cfUnsure = h("button", { type: "button", cls: "qz-cf", "data-qz-cf": "unsure", "aria-pressed": "false", text: "没把握" });
    cfSure.addEventListener("click", function () { choose("cf", "sure"); });
    cfUnsure.addEventListener("click", function () { choose("cf", "unsure"); });
    ansWrap.appendChild(h("div", { cls: "qz-part qz-part-cf" }, [
      cfLab, h("div", { cls: "qz-cfs", role: "group", "aria-labelledby": cfLab.id }, [cfSure, cfUnsure])
    ]));
    var subBtn = h("button", { type: "button", cls: "qz-btn qz-primary", "data-qz-submit": true, disabled: true, text: isPredict ? "提交预测" : "提交" });
    var need = h("span", { cls: "qz-need" });
    ansWrap.appendChild(h("div", { cls: "qz-actions" }, [subBtn, need]));
    sec.appendChild(ansWrap);
    if (extAtBuild) sec.appendChild(wBox);
    subBtn.addEventListener("click", function () { if (isPredict) submitPredict(); else submitAnswer(); });

    /* --- 对比、解释（预测关卡） --- */
    var cmp = null, exWrap = null, ta = null, exBtn = null, exCount = null;
    if (isPredict) {
      cmp = h("div", { cls: "qz-compare", hidden: true });
      var taId = uid("qzex");
      ta = h("textarea", { id: taId, "data-qz-ex": true, maxlength: EX_MAX, rows: 3, placeholder: exMin ? "至少 " + exMin + " 个字" : "" });
      exCount = h("span", { cls: "qz-count", text: "0 / " + EX_MAX });
      exBtn = h("button", { type: "button", cls: "qz-btn qz-primary", "data-qz-ex-submit": true, disabled: true, text: "提交解释" });
      exWrap = h("div", { cls: "qz-explain", hidden: true }, [
        h("label", { cls: "qz-q", "for": taId, text: explain.prompt || "用一句话说一说你看到了什么。" }),
        ta,
        h("div", { cls: "qz-ex-foot" }, [exCount, exMin ? h("span", { cls: "qz-ex-min", text: "至少 " + exMin + " 个字" }) : null]),
        h("div", { cls: "qz-actions" }, [exBtn])
      ]);
      sec.appendChild(cmp);
      sec.appendChild(exWrap);
      ta.addEventListener("input", updateExplain);
      exBtn.addEventListener("click", submitExplain);
    }

    /* --- 反馈 --- */
    var fb = h("div", { cls: "qz-feedback", "aria-live": "polite" });
    sec.appendChild(fb);

    if (c.promptEl) ctx.promptHost.appendChild(c.promptEl);
    host.appendChild(sec);

    /* ---------- 状态 ---------- */
    function setStage(s) {
      c.stage = s;
      sec.setAttribute("data-stage", s);
      if (c.promptEl) c.promptEl.setAttribute("data-stage", s);
      // 外部部件：提交预测到解释之间，选项收起成一行；预测、反馈阶段展开（反馈阶段要在选项上标对错）
      if (picked) {
        var fold = s === "operate" || s === "compare" || s === "explain";
        if (fold) ansWrap.setAttribute("data-collapsed", "true"); else ansWrap.removeAttribute("data-collapsed");
      }
      if (steps) {
        var order = ["predict", "operate", "compare", "explain"];
        var at = order.indexOf(s === "feedback" ? "explain" : s);
        show(steps, s !== "free");
        $$("li", steps).forEach(function (li, i) {
          var cur = order[i] === s;
          if (cur) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
          li.classList.toggle("is-done", s === "feedback" ? true : i < at);
        });
      }
    }
    function optButtons() { return $$(".qz-opt", ansWrap); }
    function allInputs() { return optButtons().concat([cfSure, cfUnsure]); }
    function choose(kind, id) {
      if (c.stage !== "answer" && c.stage !== "predict") return;
      if (kind === "ans") c.sel.ch = id;
      else if (kind === "rs") c.sel.rs = id;
      else c.sel.cf = id;
      var sel = kind === "cf" ? "[data-qz-cf]" : kind === "ans" ? "[data-qz-ans]" : "[data-qz-rs]";
      var attr = kind === "cf" ? "data-qz-cf" : kind === "ans" ? "data-qz-ans" : "data-qz-rs";
      $$(sel, ansWrap).forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute(attr) === id ? "true" : "false"); });
      updateSubmit();
    }
    function updateSubmit() {
      var miss = [];
      if (!c.sel.ch) miss.push(isPredict ? "预测" : "答案");
      if (item.reason && !c.sel.rs) miss.push("理由");
      if (!c.sel.cf) miss.push("把握度");
      var open = c.stage === "answer" || c.stage === "predict";
      subBtn.disabled = !open || miss.length > 0;
      need.textContent = open && miss.length ? "还没选：" + miss.join("、") : "";
    }
    function resetInputs() {
      c.sel = { ch: "", rs: "", cf: "" };
      allInputs().forEach(function (b) {
        b.disabled = false;
        b.setAttribute("aria-pressed", "false");
        b.removeAttribute("data-mark");
      });
    }
    function lockInputs() {
      allInputs().forEach(function (b) { b.disabled = true; });
      subBtn.disabled = true;
      need.textContent = "";
    }
    // 只在反馈阶段标对错：正确的选项标 right，选了却错的标 wrong
    function markOptions() {
      $$("[data-qz-ans]", ansWrap).forEach(function (b) {
        var id = b.getAttribute("data-qz-ans");
        if (id === item.answer.correct) b.setAttribute("data-mark", "right");
        else if (id === c.sel.ch) b.setAttribute("data-mark", "wrong");
      });
      if (item.reason) {
        $$("[data-qz-rs]", ansWrap).forEach(function (b) {
          var id = b.getAttribute("data-qz-rs");
          if (id === item.reason.correct) b.setAttribute("data-mark", "right");
          else if (id === c.sel.rs) b.setAttribute("data-mark", "wrong");
        });
      }
    }
    function drawOptFigs() { c.optFigs.forEach(function (p) { drawFig(p[0], p[1]); }); }

    /* ---------- 部件 ---------- */
    var wapi = {
      onProgress: function (f) {
        // free 阶段和锁定时照常会被调用，但不影响界面（契约 6.4 第 5 条）
        if (c.stage !== "operate" || c.widgetDone) return;
        f = Math.max(0, Math.min(1, Number(f) || 0));
        prog.textContent = "已完成 " + Math.round(f * 100) + "%";
      },
      done: function () {
        if (c.stage !== "operate") return;
        c.widgetDone = true;
        cmpBtn.disabled = false;
        // 下一步该点哪里，用按钮本身的样子提示，不另写说明
        cmpBtn.classList.add("qz-primary");
        prog.textContent = "已完成 100%：点「看对比」，看看实际结果和你的预测一样吗";
      }
    };
    function wcall(name) {
      var w = c.w;
      if (w && typeof w[name] === "function") {
        try { return w[name](); } catch (e) { if (window.console) console.warn("部件 " + item.widget + "." + name + " 出错", e); }
      }
      return null;
    }
    function setLock(on) {
      if (c.ext) { setExtLock(on); return; }
      if (on) {
        // 遮罩放在部件容器的最后，叠在最上层；部件若清空过容器，这里会把它补回来
        if (lockEl.parentNode !== wEl || wEl.lastChild !== lockEl) wEl.appendChild(lockEl);
        // 部件没加载成功、或还在加载（容器里只有 .qz-wait 提示）：遮罩会和那句提示叠在一起，看不清，这时不盖
        show(lockEl, !c.wFail && !wEl.querySelector(".qz-wait"));
        wEl.setAttribute("data-locked", "true");
        wcall("lock");
      } else {
        show(lockEl, false);
        wEl.removeAttribute("data-locked");
        wcall("unlock");
      }
    }
    // 外部部件：遮罩盖在页面指定的 cover（模块图）上；控件由部件自己的 lock() / unlock() 锁住、放开
    function setExtLock(on) {
      var cv = c.cover;
      if (on) {
        if (cv && inDoc(cv)) {
          // 遮罩是绝对定位的：cover 本来是 static 时补一个 relative（sticky、relative 都能当定位容器，不改）
          try { if (window.getComputedStyle(cv).position === "static") cv.style.position = "relative"; } catch (e) { /* 老浏览器 */ }
          cv.classList.add("qz-ext-cover");
          if (lockEl.parentNode !== cv || cv.lastChild !== lockEl) cv.appendChild(lockEl);
          cv.setAttribute("data-qz-locked", "true");
        }
        show(lockEl, !c.wFail && !!cv);
        wcall("lock");
      } else {
        show(lockEl, false);
        if (cv) cv.removeAttribute("data-qz-locked");
        wcall("unlock");
      }
    }
    function attachExternal(xd) {
      // 同一个外部部件同一时间只挂在一张卡片上（页面重新 mount 时）：先把上一张卡片的遮罩撤掉
      if (xd.card && xd.card !== c && typeof xd.card.detach === "function") xd.card.detach();
      xd.card = c;
      c.ext = true;
      c.xd = xd;
      c.cover = typeof xd.cover === "function" ? xd.cover() : xd.cover;
      // 卡片先按普通部件渲染、外部部件后注册的情况：卡片里空着的部件容器（只有「正在加载」）拿掉
      if (wEl && wEl.parentNode) wEl.parentNode.removeChild(wEl);
      try {
        c.w = xd.bind(wapi) || null;
      } catch (e) {
        c.w = null;
        c.wFail = true;
        if (window.console) console.warn("外部部件 " + item.widget + " 绑定失败", e);
      }
      setLock(c.stage === "predict");
    }
    c.detach = function () {
      c.dead = true;
      if (lockEl && lockEl.parentNode) lockEl.parentNode.removeChild(lockEl);
      if (c.cover) c.cover.removeAttribute("data-qz-locked");
      if (c.promptEl && c.promptEl.parentNode) c.promptEl.parentNode.removeChild(c.promptEl);
    };
    c.attach = function () {
      var xd = EXTERNAL[item.widget];
      if (xd) { attachExternal(xd); return; }
      var f = WIDGETS[item.widget];
      if (!f) {
        (PENDING[item.widget] = PENDING[item.widget] || []).push(c);
        if (!wEl.querySelector(".qz-wait")) wEl.appendChild(h("p", { cls: "qz-wait", text: "正在加载互动部件……" }));
        return;
      }
      $$(".qz-wait", wEl).forEach(function (n) { n.parentNode.removeChild(n); });
      try {
        c.w = f(wEl, wapi) || null;
      } catch (e) {
        c.w = null;
        c.wFail = true;
        if (window.console) console.warn("部件 " + item.widget + " 创建失败", e);
        wEl.appendChild(h("p", { cls: "qz-wait", text: "互动部件没有加载成功，请刷新页面再试。" }));
      }
      wEl.classList.add("qz-widget");
      setLock(c.stage === "predict");
    };

    function enterPredict(fromUser) {
      resetInputs();
      show(ansWrap, true);
      drawOptFigs();
      show(freeNote, false);
      show(cmp, false);
      if (cmp) { $$(".qz-fig", cmp).forEach(dropFig); clear(cmp); }
      show(exWrap, false);
      if (ta) { ta.value = ""; ta.disabled = false; updateExplain(); }
      clear(fb);
      c.recEl = null;
      c.widgetDone = false;
      show(cmpBtn, true);
      cmpBtn.disabled = true;
      cmpBtn.classList.remove("qz-primary");
      wActs.appendChild(cmpBtn);
      if (repBtn.parentNode) repBtn.parentNode.removeChild(repBtn);
      // 预测阶段只露出部件（锁着）和作答区：进度提示和「看对比」这时没有用，
      // 藏起来让预测选项紧跟在部件下面，手机上不用先翻过一屏（遮罩上已经写着「在下面选出你的预测并提交 ↓」）
      show(prog, false);
      show(wActs, false);
      prog.textContent = "";
      if (picked) picked.textContent = "";
      setStage("predict");
      wcall("reset");
      setLock(true);
      updateSubmit();
      if (fromUser) jumpTo(c.promptEl || ansWrap);
    }
    function enterFree() {
      show(ansWrap, false);
      show(cmp, false);
      show(exWrap, false);
      show(prog, false);
      show(cmpBtn, false);
      show(freeNote, true);
      show(wActs, true);
      wActs.appendChild(repBtn);
      setStage("free");
      setLock(false);
    }
    function submitPredict() {
      if (c.stage !== "predict" || subBtn.disabled) return;
      lockInputs();
      if (picked) {
        var po = core.findOpt(item.answer, c.sel.ch);
        var pi = (item.answer.options || []).indexOf(po);
        picked.textContent = "你的预测：" + (po ? ANS_KEYS.charAt(pi) + ". " + po.text : "") + "（" + (c.sel.cf === "sure" ? "有把握" : "没把握") + "）";
      }
      setStage("operate");
      setLock(false);
      show(prog, true);
      show(wActs, true);
      var progText = c.wFail ? "互动部件没有加载成功，请刷新页面再试。" : "现在动手验证你的预测：操作完成后点「看对比」。";
      // 进度提示是 aria-live 区域：先让它（空着）出现，隔一会儿再写字，读屏软件才会念出来；
      // 部件这期间若已经报了进度（onProgress 改了文字），就不覆盖
      prog.textContent = "";
      setTimeout(function () { if (c.stage === "operate" && !prog.textContent) prog.textContent = progText; }, 80);
      // 手机上部件在作答区上方：提交后函数板出现（部件解锁时），把几何板滚到屏幕顶上（瞬时滚动，不做动画）
      // 外部部件：滚到页面指定的位置（缺省是 cover，即模块图）
      if (c.ext) {
        var st = c.xd && c.xd.scrollTarget;
        jumpTo((typeof st === "function" ? st() : st) || c.cover || sec);
      } else {
        jumpTo(wBox);
      }
    }
    function showCompare() {
      if (c.stage !== "operate" || !c.widgetDone) return;
      setStage("compare");
      var opt = core.findOpt(item.answer, c.sel.ch);
      var res = wcall("result");
      var actual = res && res.figure ? res.figure : null;
      clear(cmp);
      var idx = (item.answer.options || []).indexOf(opt);
      // 预测选项没有缩略图（只有文字）时不留一块空白的图框，只写选了哪一项
      var mine = h("div", { cls: "qz-fig", role: "img", "aria-label": "你预测的图象", hidden: !(opt && opt.figure) });
      var real = h("div", { cls: "qz-fig", role: "img", "aria-label": "实际得到的图象" });
      cmp.appendChild(h("figure", { cls: "qz-cmp-col" }, [
        h("figcaption", { cls: "qz-cmp-title", text: "你的预测" }), mine,
        h("p", { cls: "qz-cmp-note", text: opt ? ANS_KEYS.charAt(idx) + ". " + opt.text : "" })
      ]));
      cmp.appendChild(h("figure", { cls: "qz-cmp-col" }, [
        h("figcaption", { cls: "qz-cmp-title", text: "实际结果" }), real,
        // 说明文字可以由部件给（result().note，可选），例如表盘刻度不是「拖出来的图象」
        h("p", { cls: "qz-cmp-note", text: actual ? (res.note ? String(res.note) : "你刚才拖出来的图象") : "部件没有给出结果图" })
      ]));
      show(cmp, true);
      if (opt && opt.figure) drawFig(mine, opt.figure);
      if (actual) drawFig(real, actual);
      show(cmpBtn, false);
      // 对比图出来，解释框紧跟着出现（契约 6.4 第 3 条：compare → explain）
      show(exWrap, true);
      setStage("explain");
      updateExplain();
      jumpTo(cmp);
    }
    function updateExplain() {
      if (!ta) return;
      var n = ta.value.length;
      exCount.textContent = n + " / " + EX_MAX;
      exBtn.disabled = c.stage !== "explain" || ta.value.trim().length < exMin;
    }
    function submitExplain() {
      if (c.stage !== "explain") return;
      var ex = ta.value.trim().slice(0, EX_MAX);
      if (ex.length < exMin) return;
      ta.disabled = true;
      exBtn.disabled = true;
      markSeen(item.id);
      finish({ ch: c.sel.ch, rs: "", cf: c.sel.cf }, ex);
    }
    function submitAnswer() {
      if (c.stage !== "answer" || subBtn.disabled) return;
      finish({ ch: c.sel.ch, rs: item.reason ? c.sel.rs : "", cf: c.sel.cf }, "");
    }

    /* ---------- 判定、反馈、保存 ---------- */
    function finish(resp, ex) {
      var res = core.classify(item, resp);
      var attempt = {
        d: core.today(), t: new Date().toISOString(), cls: res.cls,
        ch: resp.ch || "", rs: resp.rs || "", cf: resp.cf, tags: res.tags.slice(), ex: ex || "", mode: amode
      };
      lockInputs();
      markOptions();
      setStage("feedback");
      renderFeedback(res, attempt);
      // 记下这次作答自己的记录行：保存排队串行，可能要好几秒；这期间学生点了「再做一次」又交了一次，
      // 这次的结果就不能写到新那次的记录行上（否则新那次会过早显示 saved，契约 6.3）
      var recEl = c.recEl;
      saveAttempt(bank, item, attempt, ctx.retestKey).then(function (out) {
        renderRecord(attempt, out, recEl);
        if (typeof ctx.onAnswered === "function") {
          try {
            ctx.onAnswered({ item: item, attempt: attempt, saved: out.state === "saved", state: out.state, mistakes: out.mistakes, result: res, error: out.error || null });
          } catch (e) { if (window.console) console.warn(e); }
        }
      });
    }
    function block(cls, title, text) {
      return h("div", { cls: cls }, [h("p", { cls: "qz-fb-title", text: title }), h("p", { cls: "qz-fb-text", text: text })]);
    }
    function renderFeedback(res, attempt) {
      clear(fb);
      var v = verdictOf(item, res, attempt.cf, isPredict);
      var verdict = h("div", { cls: "qz-verdict", "data-cls": res.cls, tabindex: "-1" }, [
        h("b", { cls: "qz-verdict-tag", text: v.tag }), h("span", { cls: "qz-verdict-text", text: v.text })
      ]);
      fb.appendChild(verdict);
      if (!res.ans || !res.rsn) {
        var keys = h("div", { cls: "qz-key" });
        var o = core.findOpt(item.answer, item.answer.correct);
        var oi = (item.answer.options || []).indexOf(o);
        if (o) keys.appendChild(h("p", { text: (isPredict ? "实际图象：" : "正确答案：") + ANS_KEYS.charAt(oi) + ". " + o.text }));
        if (item.reason) {
          var r = core.findOpt(item.reason, item.reason.correct);
          var ri = (item.reason.options || []).indexOf(r);
          if (r) keys.appendChild(h("p", { text: "正确理由：" + (ri + 1) + ". " + r.text }));
        }
        fb.appendChild(keys);
      }
      // 反驳性反馈：先点出常见想法，再说为什么不对、该怎么看
      (res.tags || []).forEach(function (t) {
        var tg = bank.tags[t];
        if (tg && tg.refute) fb.appendChild(block("qz-refute", "常见想法：" + (tg.name || t), tg.refute));
      });
      var ref = h("div", { cls: "qz-ref" });
      if (isPredict && attempt.ex) ref.appendChild(block("qz-mine", "你的解释", attempt.ex));
      if (item.feedback && item.feedback.ref) ref.appendChild(block("qz-ref-main", "参考解释", item.feedback.ref));
      if (isPredict && attempt.ex) ref.appendChild(h("p", { cls: "qz-hint", text: "对照一下：你的解释说到「为什么」了吗？" }));
      if (ref.firstChild) fb.appendChild(ref);
      c.recEl = h("div", { cls: "qz-record", "data-state": "saving" }, [h("span", { cls: "qz-record-text", text: "正在保存……" })]);
      fb.appendChild(c.recEl);
      var after = h("div", { cls: "qz-after" });
      if (isPredict) {
        after.appendChild(repBtn);
      } else if (ctx.mode !== "retest") {
        var retry = h("button", { type: "button", cls: "qz-btn", "data-qz-retry": true, text: "再做一次" });
        retry.addEventListener("click", resetNormal);
        after.appendChild(retry);
      }
      if (after.firstChild) fb.appendChild(after);
      try { verdict.focus(); } catch (e) { /* 老浏览器不支持也无妨 */ }
    }
    function renderRecord(attempt, out, rec) {
      // 这次作答的反馈已被「再做一次」「重新预测」清掉（c.recEl 变成了 null 或新一次的记录行）：结果不再显示
      if (!rec || rec !== c.recEl) return;
      clear(rec);
      rec.setAttribute("data-state", out.state);
      if (out.state === "guest") {
        rec.appendChild(h("span", { cls: "qz-record-text", text: "登录后可以存入错题本并按计划重测" }));
        rec.appendChild(loginButton());
        return;
      }
      rec.appendChild(h("span", { cls: "qz-record-text", text: recordText(bank, attempt, out.retestKey || "", out) }));
    }
    function resetNormal() {
      resetInputs();
      clear(fb);
      c.recEl = null;
      setStage("answer");
      updateSubmit();
      jumpTo(sec);
    }

    // 登录状态变了：游客做完的题提示「这次没有存进账号」，不偷偷补存（登录后不合并游客记录）
    c.onAuth = function (t) {
      var rec = c.recEl;
      if (!t || c.stage !== "feedback" || !rec || rec.getAttribute("data-state") !== "guest") return;
      clear(rec);
      rec.appendChild(h("span", {
        cls: "qz-record-text",
        text: "已登录。这次是登录前做的，没有存入错题本；" + (isPredict ? "点「重新预测」" : "点「再做一次」") + "重新作答，就会记到你的账号里。"
      }));
    };

    /* ---------- 初始状态 ---------- */
    c.figs.forEach(function (p) { drawFig(p[0], p[1]); });
    if (isPredict) {
      if (ctx.seenBefore) {
        setStage("free");
        c.attach();
        enterFree();
      } else {
        setStage("predict");
        c.attach();
        enterPredict(false);
      }
    } else {
      drawOptFigs();
      setStage("answer");
      updateSubmit();
    }

    c.api = {
      qid: item.id, el: sec, item: item, prompt: c.promptEl,
      external: function () { return c.ext; },
      stage: function () { return c.stage; },
      reset: function () { if (isPredict) enterPredict(false); else resetNormal(); }
    };
    CARDS.push(c);
    return c;
  }

  /* ==================== 公开方法 ==================== */
  function registerWidget(id, factory) {
    if (!id || typeof factory !== "function") return;
    WIDGETS[id] = factory;
    var wait = PENDING[id] || [];
    PENDING[id] = [];
    wait.forEach(function (c) { if (inDoc(c.el)) c.attach(); });
  }

  // 外部部件：部件的 DOM 已经在页面上（例如电学实验台的模块），引擎不建部件、不清空容器，
  // 只负责锁定（在 cover 上盖「先预测，再动手」，并调部件的 lock）、解锁、读进度（api.onProgress / api.done）和结果（result）。
  //   def.cover        遮罩盖在哪个元素上（模块图）；可以是元素，也可以是返回元素的函数
  //   def.bind(api)    卡片挂上时调用（同一个外部部件同一时间只挂一张卡片），返回 { lock, unlock, reset, result }，与 registerWidget 的 factory 返回值一样
  //   def.scrollTarget 可选：提交预测后滚到哪里（缺省是 cover）
  // 要在 mount 之前注册：卡片按外部部件排版（mount 给了 promptHost 时题干放进 promptHost，作答区留在 mount 的容器里）。
  function registerExternal(id, def) {
    if (!id || !def || typeof def.bind !== "function") return;
    var old = EXTERNAL[id];
    EXTERNAL[id] = { cover: def.cover || null, bind: def.bind, scrollTarget: def.scrollTarget || null, card: old ? old.card : null };
    var wait = PENDING[id] || [];
    PENDING[id] = [];
    wait.forEach(function (c) { if (inDoc(c.el)) c.attach(); });
  }

  function mount(el, opts) {
    opts = opts || {};
    var mode = MODES.indexOf(opts.mode) !== -1 ? opts.mode : "practice";
    var ctrl = {
      el: el, cards: [],
      card: function (qid) { for (var i = 0; i < ctrl.cards.length; i++) if (ctrl.cards[i].qid === qid) return ctrl.cards[i]; return null; }
    };
    if (!el) return Promise.resolve(ctrl);
    clear(el);
    if (!K()) {
      el.appendChild(h("p", { cls: "qz-error", text: "题目引擎没有加载完整，请刷新页面再试。" }));
      return Promise.resolve(ctrl);
    }
    el.appendChild(h("p", { cls: "qz-loading", text: "正在加载题目……" }));
    var promptHost = opts.promptHost && opts.promptHost.nodeType === 1 ? opts.promptHost : null;
    return Promise.all([load(), loadRecords()]).then(function (r) {
      var bank = r[0], recs = r[1] || {}, core = K(), hs = hsFlags(), seen = readSeen();
      clear(el);
      if (promptHost) clear(promptHost);
      (opts.items || []).forEach(function (x) {
        var it = typeof x === "string" ? bank.byId[x] : x;
        if (!it || !it.id || !it.answer) {
          if (window.console) console.warn("ABSLabQuiz：找不到题目", x);
          return;
        }
        // 高中题：数学、生物一律不出；物理、化学要该科「显示高中内容」开着
        if (!core.levelAllowed(it, hs)) return;
        var c = buildCard(el, it, {
          mode: mode, bank: bank, retestKey: opts.retestKey || "", onAnswered: opts.onAnswered,
          seenBefore: !!seen[it.id] || core.doneBefore(recs, it.id), promptHost: promptHost
        });
        ctrl.cards.push(c.api);
      });
      return ctrl;
    }, function (err) {
      clear(el);
      el.appendChild(h("p", { cls: "qz-error", text: "题目加载失败：" + ((err && err.message) || "网络问题") + "。请检查网络后刷新页面。" }));
      return ctrl;
    });
  }

  function records() { return loadRecords(); }

  function mastery(kpRef) {
    return Promise.all([load(), loadRecords()]).then(function (r) {
      return K().mastery(kpRef, r[0].items, r[1] || {});
    });
  }

  function dueList() {
    if (!token()) return Promise.resolve([]);
    return Promise.all([load(), request("mistakes")]).then(function (r) {
      return K().dueList((r[1] && r[1].items) || [], K().today(), r[0].tags, r[0].items);
    });
  }

  function openReview(tag) {
    window.location.href = ROOT + "review.html" + (tag ? "?tag=" + encodeURIComponent(tag) : "");
  }

  /* ==================== 今日重测（review.html） ==================== */
  function mountReview(el, opts) {
    if (!el) return null;
    var box = el.querySelector(".qz-review");
    if (!box) { box = h("div", { cls: "qz-review" }); el.appendChild(box); }
    var R = { box: box, opts: opts || {}, gen: 0 };
    REVIEWS.push(R);
    renderReview(R);
    return { el: box, refresh: function () { renderReview(R); } };
  }

  function reviewState(R, state, kids) {
    R.box.setAttribute("data-state", state);
    clear(R.box);
    (kids || []).forEach(function (k) { if (k) R.box.appendChild(k); });
  }
  // 稳定迷思的记录一直保留（review.stable 不撤）；错题已经掌握（status 2）后改成灰色的「曾是稳定迷思」，
  // 既不抹掉这段经历，也不让已经过关的项目看着还像问题。错题本抽屉（shared/mistakes.js）用同一套文字
  function stableBadge(past) {
    return h("span", { cls: "qz-badge-stable" + (past ? " qz-badge-past" : ""), text: past ? "曾是稳定迷思" : "稳定迷思" });
  }
  function intervalsText() {
    var core = K();
    // 间隔都从 core.js 的常量读，改排期只改那一处
    var later = core.UNSURE_DAYS === 1 ? "明天" : core.UNSURE_DAYS + " 天后";
    return "答对且有把握，间隔按 " + core.INTERVALS.join(" → ") + " 天拉长；没把握，" + later + "再测；答错，从头开始。";
  }

  function renderReview(R) {
    var gen = ++R.gen;
    var core = K();
    if (!core) {
      reviewState(R, "error", [h("p", { cls: "qz-error", text: "页面没有加载完整，请刷新再试。" })]);
      return;
    }
    if (!token()) {
      var A = window.ABSLabAuth;
      var local = !!(A && A.getCurrentUser && A.getCurrentUser());
      reviewState(R, "guest", [h("div", { cls: "qz-panel" }, [
        h("h2", { cls: "qz-panel-title", text: "登录后才能按计划重测" }),
        h("p", { cls: "qz-muted", text: local
          ? "当前是本地账号：错题本和重测计划存在云端，需要用联网注册的账号登录。"
          : "登录后做错的理解测试题会按错误概念存进错题本，到期时在这里重测。" + intervalsText() }),
        h("div", { cls: "qz-actions" }, [loginButton()])
      ])]);
      return;
    }
    reviewState(R, "loading", [h("p", { cls: "qz-loading", text: "正在读取错题本……" })]);
    Promise.all([load(), request("mistakes"), loadRecords()]).then(function (r) {
      if (gen !== R.gen) return;
      showReviewList(R, r[0], (r[1] && r[1].items) || [], r[2] || {});
    }, function (err) {
      if (gen !== R.gen) return;
      var retry = h("button", { type: "button", cls: "qz-btn", text: "重试" });
      retry.addEventListener("click", function () { renderReview(R); });
      reviewState(R, "error", [h("div", { cls: "qz-panel" }, [
        h("p", { cls: "qz-error", text: "读取失败：" + ((err && err.message) || "网络问题") + "。" }),
        h("div", { cls: "qz-actions" }, [retry])
      ])]);
    });
  }

  function itemPageLink(item) {
    if (!item || !item.page) return null;
    return h("a", { cls: "qz-link", href: ROOT + item.page + "#qz-" + item.id, text: "回到题目所在页面 →" });
  }

  function showReviewList(R, bank, mistakes, recs) {
    var core = K(), today = core.today(), opts = R.opts;
    var tagF = opts.tag ? String(opts.tag) : "", itemF = opts.item ? String(opts.item) : "";
    // ?item= 指向的题需要动手操作（有部件）或不允许重测：不能在这里出，指回原页面
    if (itemF) {
      var it0 = bank.byId[itemF];
      if (it0 && (it0.widget || it0.retest !== true)) {
        reviewState(R, "empty", [h("div", { cls: "qz-panel" }, [
          h("p", { cls: "qz-empty-title", text: "这道题需要动手操作，请回到示范页再做一次" }),
          h("p", { cls: "qz-muted", text: it0.stem || "" }),
          h("div", { cls: "qz-actions" }, [itemPageLink(it0)])
        ])]);
        return;
      }
    }
    var keyF = tagF || (itemF ? "q:" + itemF : "");
    var due = core.dueList(mistakes, today, bank.tags, bank.items);
    if (keyF) due = due.filter(function (d) { return d.key === keyF; });

    if (!due.length) {
      var pool = keyF ? mistakes.filter(function (m) { return core.keyOfMistake(m) === keyF; }) : mistakes;
      var nx = core.nextDue(pool, today, bank.tags, bank.items);
      var kids = [h("p", { cls: "qz-empty-title", text: "今天没有要重测的" })];
      if (nx) {
        var nxName = nx.name;
        if (nx.key.indexOf("q:") === 0) {
          var itn = bank.byId[nx.key.slice(2)];
          nxName = itn ? cutText(itn.stem, 24) : "这道题";
        }
        // 文字包一层 span：.qz-next-due 用子项外边距代替 flex 的 gap（quiz.css 开头），裸文字节点没法带外边距
        kids.push(h("p", { cls: "qz-next-due" }, [h("span", { text: "最近一个到期日：" + core.fmtMD(nx.due) + " · " + nxName }), nx.stable ? " " : null, nx.stable ? stableBadge() : null]));
      } else {
        // 用 ?tag= / ?item= 打开、而这一项已经掌握：说清楚它为什么不在列表里（稳定迷思的记录照样显示，改成灰色）
        var done = keyF ? mistakes.filter(function (m) { return core.keyOfMistake(m) === keyF && +m.status === 2; })[0] : null;
        if (done) {
          var dName = keyF.indexOf("q:") === 0
            ? (bank.byId[keyF.slice(2)] ? cutText(bank.byId[keyF.slice(2)].stem, 24) : "这道题")
            : ((bank.tags[keyF] && bank.tags[keyF].name) || keyF);
          var dStable = !!(done.review && done.review.stable);
          kids.push(h("p", { cls: "qz-next-due" }, [h("span", { text: "「" + dName + "」已掌握，不再安排重测" }), dStable ? " " : null, dStable ? stableBadge(true) : null]));
        } else {
          kids.push(h("p", { cls: "qz-muted", text: "错题本里还没有来自理解测试、需要重测的项目。" }));
        }
      }
      if (keyF) kids.push(h("div", { cls: "qz-actions" }, [h("a", { cls: "qz-link", href: ROOT + "review.html", text: "看全部重测项目 →" })]));
      reviewState(R, "empty", [h("div", { cls: "qz-panel" }, kids)]);
      return;
    }

    var hs = hsFlags();
    // 同一次重测里同一道题只出一遍：先做的那张卡片的反馈会亮出正确答案和理由，第二遍等于白送一次「通过」。
    // q: 键只能出它自己那道题，先占上；标签键再从剩下的题里挑。core.js 不改：已经用掉的题克隆一份、标成 retest:false
    // 放回题库，pickRetest 仍拿它判断「这个标签最近一次做的是哪个情境」，只是不再把它当候选。
    // 挑不到题的项照常注明「暂时没有可用的重测题」，这次不测，错题保持到期，下次再出。
    var used = {}, picked = [];
    function pickFor(key) {
      var pool = bank.items.map(function (x) { return used[x.id] ? Object.assign({}, x, { retest: false }) : x; });
      var it = core.pickRetest(key, pool, recs, { hs: hs });
      if (it) used[it.id] = true;
      return it;
    }
    due.forEach(function (d, i) { if (d.kind === "item") picked[i] = pickFor(d.key); });
    due.forEach(function (d, i) { if (d.kind !== "item") picked[i] = pickFor(d.key); });
    var entries = due.map(function (d, i) {
      var name = d.name;
      var it = null;
      if (d.kind === "item") { it = bank.byId[d.key.slice(2)]; name = it ? cutText(it.stem, 24) : "这道题"; }
      return {
        key: d.key, kind: d.kind, name: name, stable: d.stable, due: d.due, subject: d.subject, origItem: it,
        item: picked[i] || null
      };
    });
    var ready = entries.filter(function (e) { return !!e.item; });
    var list = h("ul", { cls: "qz-due-list" });
    entries.forEach(function (e) {
      var li = h("li", { cls: "qz-due-item", "data-key": e.key }, [
        h("div", { cls: "qz-due-main" }, [h("b", { cls: "qz-due-name", text: e.name }), e.stable ? stableBadge() : null]),
        h("div", { cls: "qz-due-meta", text: "到期：" + core.fmtMD(e.due) + (SUBJECT_NAME[e.subject] ? " · " + SUBJECT_NAME[e.subject] : "") })
      ]);
      if (!e.item) {
        li.setAttribute("data-none", "true");
        li.appendChild(h("div", { cls: "qz-due-none" }, [
          "暂时没有可用的重测题",
          e.origItem && e.origItem.widget ? " · " : null,
          e.origItem && e.origItem.widget ? itemPageLink(e.origItem) : null
        ]));
      }
      list.appendChild(li);
    });
    var start = h("button", { type: "button", cls: "qz-btn qz-primary", "data-qz-start": true, text: "开始重测" });
    start.disabled = !ready.length;
    start.addEventListener("click", function () { runReview(R, bank, ready); });
    reviewState(R, "list", [h("div", { cls: "qz-panel" }, [
      h("h2", { cls: "qz-panel-title", text: "今天有 " + entries.length + " 项要重测" }),
      h("p", { cls: "qz-muted", text: "每项出一道换了情境的新题，一题一题做，做完一题马上看反馈。" + intervalsText() }),
      list,
      h("div", { cls: "qz-actions" }, [start, h("span", { cls: "qz-need", text: ready.length ? "共 " + Math.min(ready.length, core.MAX_RETEST) + " 题" : "现在没有可以出的重测题" })])
    ])]);
  }

  function cutText(s, n) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function runReview(R, bank, ready) {
    var core = K();
    // 每个到期项一题，最多 MAX_RETEST 题；相邻两题尽量换模块（交错练习）
    var queue = core.interleave(ready, core.MAX_RETEST);
    var results = [];
    var gen = ++R.gen;
    function step(i) {
      if (gen !== R.gen) return;
      var e = queue[i];
      var last = i === queue.length - 1;
      // 题号上不写「重测哪个错误概念」：先说出来等于提示了陷阱，重测就测不出真实想法
      var title = h("p", { cls: "qz-run-head", tabindex: "-1", text: "第 " + (i + 1) + " / " + queue.length + " 题" });
      var bar = h("div", { cls: "qz-run-bar", "aria-hidden": "true" }, [h("span", { style: "width:" + Math.round(i / queue.length * 100) + "%" })]);
      var host = h("div", { cls: "qz-run-card" });
      var next = h("button", { type: "button", cls: "qz-btn qz-primary", "data-qz-next": true, hidden: true, text: last ? "看小结" : "下一题" });
      next.addEventListener("click", function () {
        if (last) summary(); else step(i + 1);
      });
      reviewState(R, "run", [title, bar, host, h("div", { cls: "qz-actions qz-run-nav" }, [next])]);
      if (i > 0) { jumpTo(R.box); try { title.focus(); } catch (er) { /* 无妨 */ } }
      mount(host, {
        items: [e.item], mode: "retest", retestKey: e.key,
        onAnswered: function (info) {
          if (gen !== R.gen) return;
          results[i] = info;
          show(next, true);
        }
      });
    }
    function summary() {
      if (gen !== R.gen) return;
      reviewState(R, "loading", [h("p", { cls: "qz-loading", text: "正在整理小结……" })]);
      // 小结按错题本的最新状态写：一次重测里别的题也可能改动同一条错题
      request("mistakes").then(function (j) { return (j && j.items) || []; }, function () { return null; }).then(function (fresh) {
        if (gen !== R.gen) return;
        // 保存失败的那一项，错题本没有改：不能算进「通过」，也不能显示错题本里那条旧的到期日（看着像这次已经算数了）
        var pass = 0, unsure = 0, wrong = 0, failed = 0;
        results.forEach(function (x) {
          if (!x) return;
          if (x.state === "error") failed++;
          else if (x.attempt.cls === "pass") pass++; else if (x.attempt.cls === "unsure") unsure++; else wrong++;
        });
        var list = h("ul", { cls: "qz-sum-list" });
        queue.forEach(function (e, i) {
          var mid = mistakeIdOf(e.key);
          var m = fresh ? findById(fresh, mid) : null;
          if (!m && results[i]) m = findById(results[i].mistakes, mid);
          var err = !!(results[i] && results[i].state === "error");
          var cls = results[i] ? (err ? "error" : results[i].attempt.cls) : "";
          var txt;
          if (err) txt = "保存失败，这一项还没有更新，下次再测";
          else if (!m) txt = "已记录这次作答";
          else if (+m.status === 2 || !(m.review && m.review.due)) txt = "已掌握，不再安排";
          else txt = "下次重测：" + core.fmtMD(m.review.due);
          var stable = m && m.review && m.review.stable;
          // 这次重测过了最后一档、错题变成「已掌握」：徽标改成灰色的「曾是稳定迷思」
          list.appendChild(h("li", { cls: "qz-sum-item", "data-key": e.key, "data-cls": cls }, [
            h("div", { cls: "qz-due-main" }, [h("b", { cls: "qz-due-name", text: e.name }), stable ? stableBadge(+m.status === 2) : null,
              cls ? h("span", { cls: "qz-sum-res", "data-cls": cls, text: err ? "没保存上" : cls === "pass" ? "通过" : cls === "unsure" ? "没把握" : "还没掌握" }) : null]),
            h("div", { cls: "qz-due-meta", text: txt })
          ]));
        });
        reviewState(R, "summary", [h("div", { cls: "qz-panel" }, [
          h("h2", { cls: "qz-panel-title", tabindex: "-1", text: "重测小结" }),
          h("p", { text: "这次做了 " + queue.length + " 题：通过 " + pass + " 题" + (unsure ? "，没把握 " + unsure + " 题" : "") + (wrong ? "，还没掌握 " + wrong + " 题" : "") + (failed ? "，保存失败 " + failed + " 题" : "") + "。" }),
          list,
          h("p", { cls: "qz-muted", text: intervalsText() }),
          h("div", { cls: "qz-actions" }, [h("a", { cls: "qz-btn", href: ROOT + "index.html", text: "回到首页" })])
        ])]);
        jumpTo(R.box);
      });
    }
    if (queue.length) step(0);
  }

  /* ---------- 登录状态变化 ---------- */
  // abs-auth-changed 在页面打开时也可能因为云端进度同步而触发；令牌没变就什么都不做，免得重测做到一半被重画
  var LAST_TOK = token();
  window.addEventListener("abs-auth-changed", function () {
    var t = token();
    if (t === LAST_TOK) return;
    LAST_TOK = t;
    REC = { tok: null, data: null, p: null };
    CARDS = CARDS.filter(function (c) { return inDoc(c.el); });
    REVIEWS = REVIEWS.filter(function (r) { return inDoc(r.box); });
    // 页面上有卡片或重测页时才预取作答记录：只用 ABSLabQuiz.load() 读题库的页面（理解小测）登录时不发 GET api/quiz
    if (t && (CARDS.length || REVIEWS.length)) loadRecords();
    CARDS.forEach(function (c) { try { c.onAuth(t); } catch (e) { /* 一张卡片出错不影响别的 */ } });
    REVIEWS.forEach(function (r) { renderReview(r); });
  });

  window.ABSLabQuiz = {
    registerWidget: registerWidget,
    registerExternal: registerExternal,
    mount: mount,
    mountReview: mountReview,
    openReview: openReview,
    dueList: dueList,
    mastery: mastery,
    records: records,
    load: load
  };
})();
