#!/usr/bin/env python3
"""生成全站搜索用的知识点索引 shared/search-index.json、关联表和题库用到的知识点名称
shared/link-names.json、理解测试题库索引 shared/quiz/index.json，并检查关联表 shared/links.json
和题库 shared/quiz/items/*.json、错误概念标签库 shared/quiz/misconceptions.json。

用法（在仓库根目录）：
    python3 tools/build-index.py            # 生成索引 + 检查关联表和题库
    python3 tools/build-index.py --check    # 只检查，不写文件（题库索引过期也算问题）

需要 Playwright（pip install playwright && playwright install chromium）。
四张导图的知识点是页面脚本渲染出来的，所以用无头浏览器打开页面再读取：
  物理、化学  article.kp[id]、各节 li[id^=toc-ch]（物理）、必做实验 .exp[id]、高中衔接 .b-item[id]
  数学        li.ok[data-key]
  生物        li.ok[data-kid]
索引里每条：s 学科、k 知识点键（与学习状态、错题本用的键相同）、a 页面锚点 id、
n 名称、c 所在章、x 摘要、t 类型（kp 知识点 / sec 节 / exp 必做实验 / hs 高中衔接）。

检查关联表：每条关联指向的知识点必须在索引里，指向的实验模块或任务必须在实验页里存在。
实验页的名单从 shared/links.json 的 labs 读（新实验页登记进 labs 就自动进检查范围），
在每个实验页的源码里找 <section id="mN">（模块）和 data-task="..."（任务）。
检查题库：题目 id、题型、正确选项、错误概念标签、知识点、页面等（见 check_quiz），另外两条：
  · 被题目引用的错误概念标签至少要有 2 道题、2 种情境（context），否则判不了稳定迷思、换不了情境重测；
  · 模块完整性：MODULE_RULES 里列出的模块（题目的 module 字段），每个至少要有 1 道预测关卡、
    6 道二段式题（每道的答案或理由至少有一个选项带错误概念标签 mc）、2 道迁移题、1 道逆向题；
  · 正确选项的位置（同样只查 MODULE_RULES 里的模块）：按题库顺序，正确答案排在同一个位置（第几个选项）
    的题不超过一半（题数是奇数时向上取整），也不能连续 3 道题落在同一个位置；正确理由同样检查（只看有理由的题）。
    否则学生做几题就会发现「总选第一个」，测出来的不是真实想法。
有问题时列出来并以非 0 退出，避免导图改版后链接悄悄失效、题库写错了没人发现。

生成的文件只随内容变化：导图没变时 search-index.json 保留原来的 built 日期，
link-names.json 的知识点没变时也保留原日期，题库索引 index.json 不带日期——
这样重新运行一遍不会产生无意义的改动。
"""
import json
import math
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAPS = {
    "physics": "physics/knowledge-map.html",
    "chemistry": "chemistry/knowledge-map.html",
    "math": "math/knowledge-map.html",
    "biology": "biology/knowledge-map.html",
}
SUBJECTS = list(MAPS.keys())

QUIZ_DIR = ROOT / "shared/quiz"
QUIZ_INDEX = QUIZ_DIR / "index.json"
QUIZ_TAGS = QUIZ_DIR / "misconceptions.json"
# 与 shared/quiz/core.js、api/quiz.js、api/mistakes.js 用的格式一致。
# 只能用 .fullmatch() 检查：Python 的 $ 在结尾的换行符前面也算匹配，.match() 会放过 "graphaspath\n"，
# 而 JS 的 $ 不放过——这样的 id 能通过 --check，到了线上却被接口和引擎拒掉
QID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,47}$")
TAG_RE = re.compile(r"^[a-z][a-z0-9]{5,31}$")
QUIZ_TYPES = ("predict", "twotier", "transfer", "inverse")
QUIZ_LEVELS = ("junior", "senior")

# 模块完整性检查的名单：模块代号（题目的 module 字段）→ 名称（只用在报错文字里）。新模块上线时往里加。
MODULE_RULES = {
    "pa": "电学实验台 3 号 · 小灯泡",
    "pe": "电学实验台 13 号 · 传感器",
    "m1": "动点与函数图象",
    "m2": "二次函数实验室",
    "cb": "溶解度曲线",
    "cc": "反应后溶质成分",
}
# 每个模块至少要有的题（研究计划里的完成标准）：题型、道数、名称
MODULE_MIN = (
    ("predict", 1, "预测关卡"),
    ("twotier", 6, "二段式题"),
    ("transfer", 2, "迁移题"),
    ("inverse", 1, "逆向题"),
)
# 正确选项的位置（MODULE_RULES 里的模块）：同一位置的题最多占一半；连续落在同一位置的题最多 2 道。
# 题数是奇数时「一半」向上取整：例如 pe 模块 9 道有理由的题全是二选一，怎么排都有一个位置占 5 道，
# 严格的 4.5 道做不到，5 / 9 已经是最均匀的分法
POS_MAX_SHARE = 0.5
POS_MAX_RUN = 2

EXTRACT_JS = r"""
(subject) => {
  const T = el => el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  const strip = (el, sel) => { if (!el) return ''; const c = el.cloneNode(true); c.querySelectorAll(sel).forEach(x => x.remove()); return T(c); };
  const cut = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
  // 公式排版拍平成一行文字：分数写成 a/b，化学方程式的等号写成「=」
  const TX = el => {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll('.frac').forEach(f => { const s = [...f.children].map(T); f.replaceWith(s.length === 2 ? s[0] + '/' + s[1] : T(f)); });
    c.querySelectorAll('.eqs').forEach(e => e.replaceWith(' = '));
    return T(c);
  };
  const out = [];
  if (subject === 'physics' || subject === 'chemistry') {
    const chapOf = el => {
      if (subject === 'physics') { const ch = window.CH17; return ch ? '第十七章 ' + ch.name : ''; }
      const u = el.closest('section.unit'); return u ? T(u.querySelector('.unit-head h2')) : '';
    };
    document.querySelectorAll('article.kp[id]').forEach(el => {
      const name = strip(el.querySelector('.kp-head h4'), '.st,.mk-kp');
      out.push({ k: el.id, a: el.id, n: name, c: chapOf(el), x: cut(TX(el.querySelector('.core')), 60), t: 'kp' });
    });
    document.querySelectorAll('.exp[id]').forEach(el => {
      out.push({ k: el.id, a: el.id, n: strip(el.querySelector('h4'), '.tag,.lk-row'), c: chapOf(el), x: '课本必做实验', t: 'exp' });
    });
    document.querySelectorAll('.b-item[id]').forEach(el => {
      const dd = [...el.querySelectorAll('dt')].reduce((m, dt) => { m[T(dt)] = T(dt.nextElementSibling); return m; }, {});
      const sec = el.closest('section.unit');
      out.push({ k: el.id, a: el.id, n: cut(dd['高中怎么深化'] || '', 40), c: dd['对应教材'] || '', x: cut('初中：' + (dd['初中怎么说'] || '').replace(/高中会修正.*$/, ''), 60), t: 'hs',
                 u: sec ? T(sec.querySelector('.unit-head h2')) : '' });
    });
    if (subject === 'physics') {
      document.querySelectorAll('li[id^="toc-ch"]').forEach(el => {
        if (!/^toc-ch\d+-s\d+$/.test(el.id)) return;
        const chap = el.closest('details[id^="toc-ch"]');
        const name = T(el.querySelector(':scope > details > summary')) || strip(el, 'ul,.lk-row,.st');
        out.push({ k: el.id, a: el.id, n: name, c: chap ? T(chap.querySelector('summary .chap')) : '', x: '', t: 'sec' });
      });
    }
  } else {
    const keyAttr = subject === 'math' ? 'data-key' : 'data-kid';
    document.querySelectorAll('li.ok[' + keyAttr + ']').forEach(el => {
      const oc = el.closest('li.oc'), os = el.closest('li.os');
      const chap = oc ? T(oc.querySelector('summary .chap')) : '';
      const sec = os ? T(os.querySelector(':scope > details > summary')) : '';
      let name, x;
      if (subject === 'math') { name = T(el.querySelector('.kn')); x = TX(el.querySelector('.kt')); }
      else { name = T(el.querySelector('.okt b')); x = strip(el.querySelector('.okt'), 'b'); }
      out.push({ k: el.getAttribute(keyAttr), a: el.id, n: name, c: chap, sc: sec, x: cut(x, 60), t: 'kp' });
    });
  }
  return out;
}
"""


def extract():
    from playwright.sync_api import sync_playwright

    items = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for subject, rel in MAPS.items():
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page.goto((ROOT / rel).as_uri())
            page.wait_for_timeout(1200)
            rows = page.evaluate(EXTRACT_JS, subject)
            page.close()
            for r in rows:
                r = {k: v for k, v in r.items() if v not in ("", None)}
                r["s"] = subject
                items.append(r)
            print(f"  {subject}: {len(rows)} 条", file=sys.stderr)
        browser.close()
    return items


def experiment_anchors(labs):
    """实验页里实际存在的模块和任务。实验页名单取自 links.json 的 labs，不再写死。
    每个实验页都收两种锚点：<section id="mN">（电学实验台这类按模块分的页面）和
    data-task="..."（按任务分的页面；任务名是小写字母、数字、下划线或连字符）。
    返回 (found, problems)：found 是 页面 → 锚点集合；labs 写错、页面不存在时记为问题。"""
    found = {}
    problems = []
    if not isinstance(labs, dict):
        return found, ["links.json：labs 应是对象"]
    for lab, info in labs.items():
        rel = info.get("page") if isinstance(info, dict) else None
        if not isinstance(rel, str) or not rel or rel.startswith("/") or ".." in rel:
            problems.append(f"实验页 {lab}：page 应是相对仓库根目录的页面路径")
            continue
        if rel in found:
            continue
        try:
            s = (ROOT / rel).read_text(encoding="utf8")
        except OSError:
            problems.append(f"实验页 {lab}：页面 {rel} 不存在")
            continue
        found[rel] = set(re.findall(r'<section[^>]*\bid="(m\d+)"', s)) | set(re.findall(r'data-task="([a-z0-9_-]+)"', s))
    return found, problems


def check(items):
    links = json.loads((ROOT / "shared/links.json").read_text(encoding="utf8"))
    keys = {(it["s"], it["k"]) for it in items}
    anchors, problems = experiment_anchors(links.get("labs", {}))
    targets = links.get("targets", {})
    for tid, t in targets.items():
        page = t.get("page")
        if page not in anchors:
            problems.append(f"实验 {tid}：页面 {page} 不在检查范围内")
            continue
        anchor = t.get("module") or t.get("task")
        if anchor not in anchors[page]:
            problems.append(f"实验 {tid}：{page} 里找不到 {anchor}")
        if t.get("level") not in ("junior", "senior", "mixed"):
            problems.append(f"实验 {tid}：level 应为 junior / senior / mixed")

    def kp_ok(ref):
        if ":" not in ref:
            return False
        s, k = ref.split(":", 1)
        return (s, k) in keys

    for i, l in enumerate(links.get("links", [])):
        where = f"第 {i + 1} 条关联（{l.get('kp')} → {l.get('to')}）"
        if not kp_ok(l.get("kp", "")):
            problems.append(where + "：知识点不存在")
        to = l.get("to", "")
        if to not in targets and not kp_ok(to):
            problems.append(where + "：去处既不是实验也不是知识点")
        if l.get("level") and l["level"] not in ("junior", "senior"):
            problems.append(where + "：level 应为 junior 或 senior")
    return links, problems


# ---------- 理解测试题库 ----------

def qz_id(qid):
    """没有错误概念标签的错题按题记，错题 id 是 "qz-" + 题目 id 去掉非字母数字。
    照抄 shared/quiz/core.js 的 qzId()（转小写 → 去掉非 [a-z0-9] → 截到 32 位 → 不足 6 位补 0），
    两边必须一致：这里查出的冲突就是线上错题本里两道题会写进同一条错题的情况。"""
    s = re.sub(r"[^a-z0-9]", "", str(qid or "").lower())[:32]
    while len(s) < 6:
        s += "0"
    return "qz-" + s


def item_tags(item):
    """题目选项上出现过的全部错误概念标签（同 core.itemTags）。
    只收字符串：mc 写成数组、数字等由 check_quiz 报成问题，这里收进来会在后面当字典键、排序时抛异常。"""
    out = []
    for sec in (item.get("answer"), item.get("reason")):
        if not isinstance(sec, dict) or not isinstance(sec.get("options"), list):
            continue
        for o in sec["options"]:
            mc = o.get("mc") if isinstance(o, dict) else None
            if isinstance(mc, str) and mc and mc not in out:
                out.append(mc)
    return out


def context_of(item):
    """判稳定迷思、换情境重测用的情境：context 不是非空字符串时按题目 id 算（同 core 的做法）。
    context 写成数组、对象时不能放进集合，check_quiz 另外把它报成问题。"""
    c = item.get("context")
    return c if isinstance(c, str) and c else item.get("id")


def load_quiz():
    """读题库文件和标签库。返回 (files, items, tags, problems)；文件读不了就记为问题。"""
    problems = []
    files = []
    items = []
    tags = {}
    try:
        root = json.loads(QUIZ_TAGS.read_text(encoding="utf8"))
        # 根是数组、null 等时不能 .get()：报成问题，不让作者看到一屏 Python 报错
        if not isinstance(root, dict):
            problems.append("misconceptions.json：根应是对象")
        else:
            tags = root.get("tags") or {}
            if not isinstance(tags, dict):
                problems.append("misconceptions.json：tags 应是对象")
                tags = {}
    except FileNotFoundError:
        problems.append("找不到 shared/quiz/misconceptions.json")
    except ValueError as e:
        problems.append(f"misconceptions.json 不是合法的 JSON：{e}")
    except OSError as e:
        problems.append(f"读不了 shared/quiz/misconceptions.json：{e}")
    # 题库文件按文件名排序，保证 index.json 的内容与文件系统的列举顺序无关
    for path in sorted((QUIZ_DIR / "items").glob("*.json")):
        rel = path.relative_to(QUIZ_DIR).as_posix()
        try:
            data = json.loads(path.read_text(encoding="utf8"))
        except ValueError as e:
            problems.append(f"题库 {rel} 不是合法的 JSON：{e}")
            continue
        except OSError as e:
            problems.append(f"读不了题库 {rel}：{e}")
            continue
        lst = data.get("items") if isinstance(data, dict) else None
        if not isinstance(lst, list):
            problems.append(f"题库 {rel}：缺少 items 数组")
            continue
        files.append(rel)
        for it in lst:
            items.append((rel, it))
    return files, items, tags, problems


def correct_pos(sec):
    """正确选项在选项列表里排第几个（从 0 数）；数据不对时返回 None（check_quiz 另外报问题）。"""
    if not isinstance(sec, dict) or not isinstance(sec.get("options"), list):
        return None
    for i, o in enumerate(sec["options"]):
        if isinstance(o, dict) and o.get("id") == sec.get("correct"):
            return i
    return None


def check_positions(where, its):
    """同一模块里正确答案、正确理由的位置不能太集中：按题库顺序（也就是练一练、小测出题的顺序），
    同一个位置的题不超过一半（POS_MAX_SHARE），也不能连续 3 道（超过 POS_MAX_RUN）落在同一个位置。"""
    out = []
    for key, name in (("answer", "正确答案"), ("reason", "正确理由")):
        seq = []
        for it in its:
            pos = correct_pos(it.get(key))
            if pos is not None:
                seq.append((it.get("id"), pos))
        if not seq:
            continue
        counts = {}
        for _, pos in seq:
            counts[pos] = counts.get(pos, 0) + 1
        limit = math.ceil(len(seq) * POS_MAX_SHARE)
        for pos in sorted(counts):
            if counts[pos] > limit:
                out.append(where + f"：{name}有 {counts[pos]} / {len(seq)} 道排在第 {pos + 1} 个，超过一半（最多 {limit} 道；学生容易猜出位置）")
        run = [seq[0]]
        for cur in seq[1:]:
            if cur[1] == run[-1][1]:
                run.append(cur)
            else:
                run = [cur]
            if len(run) == POS_MAX_RUN + 1:
                ids = "、".join(x[0] for x in run)
                out.append(where + f"：{name}连续 {len(run)} 道（{ids}）都排在第 {cur[1] + 1} 个")
    return out


def check_quiz(search_items, files, items, tags):
    """题库和标签库的校验。返回 (problems, warnings)。"""
    keys = {(it["s"], it["k"]) for it in search_items}
    problems, warnings = [], []

    def kp_ok(ref):
        if not isinstance(ref, str) or ":" not in ref:
            return False
        s, k = ref.split(":", 1)
        return (s, k) in keys

    def first_kp(refs, subject):
        for r in refs or []:
            if isinstance(r, str) and r.split(":", 1)[0] == subject:
                return r
        return None

    # 标签库
    for tid, t in tags.items():
        where = f"错误概念 {tid}"
        if not TAG_RE.fullmatch(tid):
            problems.append(where + "：id 应为小写字母开头、6～32 位小写字母或数字")
        if not isinstance(t, dict):
            problems.append(where + "：内容应是对象")
            continue
        if t.get("subject") not in SUBJECTS:
            problems.append(where + "：subject 应为 physics / chemistry / math / biology")
        kps = t.get("kp")
        if not isinstance(kps, list) or not kps:
            problems.append(where + "：kp 至少要有一个知识点")
            kps = []
        for ref in kps:
            if not kp_ok(ref):
                problems.append(where + f"：知识点 {ref} 不在索引里")
        if kps and t.get("subject") in SUBJECTS and not first_kp(kps, t["subject"]):
            # 错题本条目的学科和知识点取「主学科里的第一个 kp」，没有就挂不到导图上
            warnings.append(where + "：kp 里没有主学科的知识点，进错题本时挂不到导图的知识点上")
        if not str(t.get("name") or "").strip():
            problems.append(where + "：缺少 name")

    # 题目
    seen = {}
    qz_seen = {}
    for rel, it in items:
        if not isinstance(it, dict):
            problems.append(f"题库 {rel}：有一道题不是对象")
            continue
        qid = it.get("id")
        where = f"题目 {qid}（{rel}）"
        if not isinstance(qid, str) or not QID_RE.fullmatch(qid):
            problems.append(where + "：id 应为 3～48 位小写字母、数字或连字符，且不以连字符开头")
            continue
        if qid in seen:
            problems.append(where + f"：id 与 {seen[qid]} 里的题目重复")
            continue
        seen[qid] = rel
        z = qz_id(qid)
        if z in qz_seen:
            problems.append(where + f"：按题记的错题 id {z} 与题目 {qz_seen[z]} 冲突（去掉连字符后相同）")
        else:
            qz_seen[z] = qid
        if it.get("type") not in QUIZ_TYPES:
            problems.append(where + "：type 应为 predict / twotier / transfer / inverse")
        if it.get("subject") not in SUBJECTS:
            problems.append(where + "：subject 应为 physics / chemistry / math / biology")
        if it.get("level") not in QUIZ_LEVELS:
            problems.append(where + "：level 应为 junior 或 senior")
        kps = it.get("kp")
        if not isinstance(kps, list) or not kps:
            problems.append(where + "：kp 至少要有一个知识点")
            kps = []
        for ref in kps:
            if not kp_ok(ref):
                problems.append(where + f"：知识点 {ref} 不在索引里")
        if kps and it.get("subject") in SUBJECTS and not first_kp(kps, it["subject"]):
            warnings.append(where + "：kp 里没有本学科的知识点，按题记的错题挂不到导图的知识点上")
        page = it.get("page")
        if not isinstance(page, str) or not page or page.startswith("/") or ".." in page:
            problems.append(where + "：page 应是相对仓库根目录的页面路径")
        elif not (ROOT / page).is_file():
            problems.append(where + f"：页面 {page} 不存在")
        ctx = it.get("context")
        if ctx is not None and not isinstance(ctx, str):
            problems.append(where + "：context 应是文字（情境名称）")
        if it.get("widget") and it.get("retest") is True:
            problems.append(where + "：有交互部件（widget）的题不能设 retest: true（重测页不加载部件）")
        if not isinstance(it.get("retest"), bool):
            problems.append(where + "：retest 应为 true 或 false")
        # 答案、理由：选项 id 不重复，correct 指向存在的选项，选项上的 mc 在标签库里
        for sec_name, need in (("answer", True), ("reason", False)):
            sec = it.get(sec_name)
            if sec is None and not need:
                continue
            if not isinstance(sec, dict) or not isinstance(sec.get("options"), list) or not sec["options"]:
                problems.append(where + f"：{sec_name} 缺少选项")
                continue
            ids = []
            for o in sec["options"]:
                oid = o.get("id") if isinstance(o, dict) else None
                if not isinstance(oid, str) or not oid:
                    problems.append(where + f"：{sec_name} 里有选项没有 id")
                    continue
                if oid in ids:
                    problems.append(where + f"：{sec_name} 的选项 id {oid} 重复")
                ids.append(oid)
                mc = o.get("mc")
                # 先看类型：mc 写成数组时 `mc not in tags` 本身就会抛 TypeError（不可哈希）
                if mc is not None and (not isinstance(mc, str) or mc not in tags):
                    problems.append(where + f"：{sec_name} 选项 {oid} 的错误概念 {mc} 不在标签库里")
            if sec.get("correct") not in ids:
                problems.append(where + f"：{sec_name}.correct 指向的选项 {sec.get('correct')} 不存在")
            else:
                for o in sec["options"]:
                    if isinstance(o, dict) and o.get("id") == sec.get("correct") and o.get("mc"):
                        problems.append(where + f"：{sec_name} 的正确选项上不能标错误概念")
        if it.get("type") == "predict" and it.get("widget") and not isinstance(it.get("explain"), dict):
            problems.append(where + "：预测关卡要有 explain（解释题）")

    # 被题目引用的标签：至少 2 道题、context 不止一种，才能按「两种情境都错」判稳定迷思、换情境重测。
    # 第 0 批只警告；第 1 批起是问题（退出码 1）。
    used = {}
    for rel, it in items:
        if not isinstance(it, dict) or not isinstance(it.get("id"), str):
            continue
        for tg in item_tags(it):
            used.setdefault(tg, []).append(it)
    for tg in sorted(used):
        its = used[tg]
        ctx = {context_of(i) for i in its}
        if len(its) < 2 or len(ctx) < 2:
            problems.append(f"错误概念 {tg}：只有 {len(its)} 道题、{len(ctx)} 种情境引用它，判不了稳定迷思（至少 2 道题、2 种情境）")
        if not any(i.get("retest") is True and not i.get("widget") for i in its):
            warnings.append(f"错误概念 {tg}：没有能重测的题（retest: true 且没有交互部件），到期后重测页出不了题")

    # 模块完整性：MODULE_RULES 里的每个模块，题型道数够不够；二段式题要带错误概念标签，否则判不出迷思
    for mod, mname in MODULE_RULES.items():
        its = [it for _, it in items if isinstance(it, dict) and it.get("module") == mod]
        where = f"模块 {mod}（{mname}）"
        if not its:
            problems.append(where + f"：题库里没有 module 为 {mod} 的题")
            continue
        for qtype, need, qname in MODULE_MIN:
            n = sum(1 for it in its if it.get("type") == qtype)
            if n < need:
                problems.append(where + f"：{qname}只有 {n} 道，至少要 {need} 道")
        for it in its:
            if it.get("type") == "twotier" and not item_tags(it):
                problems.append(where + f"：二段式题 {it.get('id')} 的答案和理由都没有带错误概念标签（mc）的选项")
        problems.extend(check_positions(where, its))

    # 掌握门槛（core.mastery）要同一天做对覆盖这个知识点的二段式题和迁移题；缺一种，导图上的测试标签永远到不了「测试达标」
    types_of = {}
    for rel, it in items:
        # 类型不对的 kp、type 上面已经报成问题；这里跳过，免得遍历数字、把数组放进集合时抛异常
        if not isinstance(it, dict) or not isinstance(it.get("kp"), list):
            continue
        t = it.get("type")
        for ref in it["kp"]:
            if isinstance(ref, str):
                got = types_of.setdefault(ref, set())
                if isinstance(t, str):
                    got.add(t)
    for ref in sorted(types_of):
        missing = [n for t, n in (("twotier", "二段式题"), ("transfer", "迁移题")) if t not in types_of[ref]]
        if missing:
            warnings.append(f"知识点 {ref}：没有覆盖它的{'、'.join(missing)}，导图上的测试标签到不了「测试达标」")
    return problems, warnings


def build_quiz_index(files, items):
    """shared/quiz/index.json：知识点 → 题目列表、题目摘要。只随题库变化，不带日期。
    items 里的字段够 core.mastery 用（id、type、kp），linker 不必下载题库全文。"""
    kps = {}
    summary = {}
    for rel, it in items:
        qid = it["id"]
        summary[qid] = {
            "subject": it.get("subject"),
            "type": it.get("type"),
            "kp": list(it.get("kp") or []),
            "page": it.get("page"),
            "level": it.get("level"),
            "retest": it.get("retest") is True,
            "context": it.get("context") or "",
            "module": it.get("module") or "",
        }
        for ref in it.get("kp") or []:
            lst = kps.setdefault(ref, [])
            if not any(x["id"] == qid for x in lst):
                lst.append({"id": qid, "type": it.get("type"), "page": it.get("page"), "level": it.get("level")})
    # 知识点按键排序、题目保持题库里的顺序：输出确定，同样的题库一定生成同样的文件
    return {"v": 1, "files": list(files), "kps": {k: kps[k] for k in sorted(kps)}, "items": summary}


def dump_quiz_index(index):
    return json.dumps(index, ensure_ascii=False, indent=1) + "\n"


def quiz_refs(items, tags):
    """题库用到的知识点：题目 kp + 标签 kp。写进 link-names.json，错题本条目的 kpName、chapter 从这里查。"""
    refs = set()
    # 题库有问题时也会走到这里（写 link-names.json 之前先算 refs）：不是对象的题、不是数组的 kp
    # 已经在 check_quiz 里报过，这里跳过，不抛异常
    for _, it in items:
        if not isinstance(it, dict) or not isinstance(it.get("kp"), list):
            continue
        for ref in it["kp"]:
            if isinstance(ref, str):
                refs.add(ref)
    for t in tags.values():
        if isinstance(t, dict) and isinstance(t.get("kp"), list):
            for ref in t["kp"]:
                if isinstance(ref, str):
                    refs.add(ref)
    return refs


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf8"))
    except (FileNotFoundError, ValueError):
        return None


def main():
    only_check = "--check" in sys.argv
    print("读取四张导图……", file=sys.stderr)
    items = extract()
    links, problems = check(items)
    n_links = len(links.get("links", []))
    n_targets = len(links.get("targets", {}))
    if problems:
        print(f"关联表有 {len(problems)} 处问题：", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)
    else:
        print(f"关联表检查通过：{n_targets} 个实验模块/任务，{n_links} 条关联。", file=sys.stderr)

    # 理解测试题库
    qfiles, qitems, qtags, qproblems = load_quiz()
    more, qwarnings = check_quiz(items, qfiles, qitems, qtags)
    qproblems += more
    quiz_ok = not qproblems
    qindex_text = dump_quiz_index(build_quiz_index(qfiles, qitems)) if quiz_ok else None
    if quiz_ok:
        old = QUIZ_INDEX.read_text(encoding="utf8") if QUIZ_INDEX.exists() else None
        if only_check and old != qindex_text:
            qproblems.append("shared/quiz/index.json 过期了（题库改过但没有重新生成），请运行 python3 tools/build-index.py")
    if qproblems:
        print(f"题库有 {len(qproblems)} 处问题：", file=sys.stderr)
        for p in qproblems:
            print("  - " + p, file=sys.stderr)
    else:
        print(f"题库检查通过：{len(qfiles)} 个题库文件，{len(qitems)} 道题，{len(qtags)} 个错误概念标签。", file=sys.stderr)
    if qwarnings:
        print(f"题库提示 {len(qwarnings)} 条（不影响退出码）：", file=sys.stderr)
        for w in qwarnings:
            print("  · " + w, file=sys.stderr)

    # 关联表用到的知识点 + 题库用到的知识点：名称、所在章、摘要。导图、实验页和测试引擎只读这个小文件，不必下载整份索引
    refs = set()
    for l in links.get("links", []):
        refs.add(l.get("kp", ""))
        if l.get("to", "") not in links.get("targets", {}):
            refs.add(l.get("to", ""))
    refs |= quiz_refs(qitems, qtags)
    names = {}
    for it in items:
        ref = it["s"] + ":" + it["k"]
        if ref in refs:
            names[ref] = {k: it[k] for k in ("n", "c", "sc", "x", "t", "a") if k in it}

    path = ROOT / "shared/search-index.json"
    npath = ROOT / "shared/link-names.json"
    old_index = read_json(path)
    old_names = read_json(npath)
    # 内容没变就沿用原来的 built 日期，保证导图没变时文件一个字节都不变（git 里没有无意义的改动）
    same_index = isinstance(old_index, dict) and old_index.get("items") == items and bool(old_index.get("built"))
    same_names = isinstance(old_names, dict) and old_names.get("kps") == names and bool(old_names.get("built"))
    built = old_index["built"] if same_index else date.today().isoformat()
    nbuilt = old_names["built"] if same_names else date.today().isoformat()

    if only_check:
        # 只提示，不算问题：导图改版后忘了重新生成，搜索和名称会旧，但不会坏
        if not same_index:
            print("提示：shared/search-index.json 与导图不一致，需要重新运行 python3 tools/build-index.py", file=sys.stderr)
        if quiz_ok and not same_names:
            print("提示：shared/link-names.json 与关联表或题库不一致，需要重新运行 python3 tools/build-index.py", file=sys.stderr)
    else:
        out = {"v": 1, "built": built, "items": items}
        path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
        print(f"已写入 {path.relative_to(ROOT)}（{len(items)} 条，{path.stat().st_size // 1024} KB" + (f"；导图没变，保留原日期 {built}" if same_index else "") + "）", file=sys.stderr)
        if quiz_ok:
            npath.write_text(json.dumps({"v": 1, "built": nbuilt, "kps": names}, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
            print(f"已写入 {npath.relative_to(ROOT)}（{len(names)} 个知识点" + (f"；没有变化，保留原日期 {nbuilt}" if same_names else "") + "）", file=sys.stderr)
            QUIZ_INDEX.write_text(qindex_text, encoding="utf8")
            print(f"已写入 {QUIZ_INDEX.relative_to(ROOT)}（{len(qitems)} 道题）", file=sys.stderr)
        else:
            # 题库有问题时不更新依赖题库的两个文件，免得把半截的索引发到线上
            print("题库有问题，没有更新 shared/link-names.json 和 shared/quiz/index.json。", file=sys.stderr)
    sys.exit(1 if problems or qproblems else 0)


if __name__ == "__main__":
    main()
