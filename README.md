# ABS-LAB · 数理化生互动实验平台

> 源于课本，高于课本——在线可视化原理探索与互动实验平台

- **在线访问**：`https://www.wenzheng.eu/abs-lab/`
- **GitHub 仓库**：`https://github.com/Pasdeau/abs-lab`
- **Authors**：Wenzheng Wang · Hang Li

---

## 一、如何加入这个仓库（首次接入，只需做一次）

### 1. 接受协作者邀请
1. 登录你的 GitHub 账号。
2. 打开注册邮箱里的邀请邮件，或直接访问 `https://github.com/Pasdeau/abs-lab/invitations`。
3. 点击 **Accept invitation** 接受邀请，即可获得本仓库的贡献权限。

### 2. 配置本地 Git 环境
如果你电脑上还没有 Git，先安装 Git（macOS 在终端运行 `xcode-select --install` 或用 Homebrew；Windows 下载 [Git for Windows](https://git-scm.com/)；不习惯命令行也可以直接安装 [GitHub Desktop](https://desktop.github.com/)）。

首次使用 Git 需设置姓名和邮箱（与你的 GitHub 账号一致）：
```bash
git config --global user.name "你的名字"
git config --global user.email "你的GitHub邮箱"
```

> **登录认证方式（二选一）**：
> - **方式 A（推荐，最省事）**：安装 **GitHub Desktop** 或 **VS Code**，登录 GitHub 账号后即可自动完成授权。
> - **方式 B（命令行 SSH）**：执行 `ssh-keygen -t ed25519` 生成密钥，将 `~/.ssh/id_ed25519.pub` 的内容粘贴到 GitHub 的 **Settings → SSH and GPG keys**。

### 3. 把仓库克隆（Clone）到本地电脑
在终端进入你想存放代码的目录（例如桌面或个人项目文件夹），执行：
```bash
# HTTPS 方式
git clone https://github.com/Pasdeau/abs-lab.git

# 如果配置了 SSH 密钥，也可以用：
# git clone git@github.com:Pasdeau/abs-lab.git

cd abs-lab
```

### 4. 本地预览网站
本仓库为纯静态前端 + Vercel Serverless API，无需安装 `node_modules`：
- **最简单**：直接用浏览器双击打开 `index.html` 即可离线浏览所有实验。
- **推荐（本地 HTTP 服务）**：在 `abs-lab` 目录下运行：
  ```bash
  python3 -m http.server 8080
  ```
  浏览器打开 `http://localhost:8080`。

---

## 二、在自己电脑上更新后，如何上传贡献代码（日常流程）

推荐采用 **「同步最新代码 → 切独立分支修改 → 推送分支 → 发 Pull Request (PR)」** 的标准协作流程，这样即使两人同时开发也不会互相覆盖，而且每次 PR 都会自动生成 Vercel 在线预览链接。

### 第 1 步：开始修改前，先同步最新代码
每次动手写新内容前，先把远程 `main` 分支的最新改动拉下来：
```bash
cd abs-lab
git checkout main
git pull origin main
```

### 第 2 步：新建一个本次修改的分支
根据你要做的内容起一个简短的英文分支名（例如新增光学实验或修改物理导图）：
```bash
git checkout -b feat/physics-optics
```
（常见前缀：`feat/` 新增实验或功能，`fix/` 修复问题，`docs/` 修改文档。）

### 第 3 步：在本地修改并自测
按学科目录编辑或新增文件（详见下方「项目结构与开发规范」），改完后在浏览器打开测试功能是否正常。

### 第 4 步：查看改动、提交并推送到 GitHub
```bash
# 1. 检查自己修改或新增了哪些文件
git status

# 2. 暂存所有改动（也可以只写具体文件名，如 git add physics/）
git add .

# 3. 写一句简明的提交说明
git commit -m "feat(physics): add optics refraction experiment"

# 4. 推送你的分支到 GitHub 远程仓库
git push -u origin feat/physics-optics
```

### 第 5 步：在 GitHub 发起 Pull Request (PR) 并上线
1. 推送成功后，打开 `https://github.com/Pasdeau/abs-lab`。
2. 页面上方会出现绿/黄色的 **Compare & pull request** 按钮，点击它。
3. 填写标题和简短说明（例如“新增高中物理光的折射实验”），点击 **Create pull request**。
4. 等待几秒后，PR 页面下方会自动出现 **Vercel Preview** 预览链接，可先在线核对效果。
5. 确认无误后点击 **Merge pull request** 合并进 `main` 分支，Vercel 会在约 10 秒内自动部署上线到 `https://www.wenzheng.eu/abs-lab/`。

> **合并后的清理**：下次再做新改动时，回到第 1 步执行 `git checkout main && git pull origin main` 再开新分支即可。

### 补充：使用 GitHub Desktop（纯图形界面，免记命令）
1. 打开 GitHub Desktop → **File → Clone Repository**，选择 `Pasdeau/abs-lab`。
2. 每次改动前点顶部 **Fetch origin / Pull origin** 同步最新代码。
3. 点左上角 **Current Branch → New Branch** 新建一个分支。
4. 在本地文件夹改好代码后，回到 GitHub Desktop，在左下角填写提交说明 → 点 **Commit to <分支名>** → 点右上角 **Publish branch / Push origin**。
5. 点击提示的 **Create Pull Request** 跳转到网页完成合并。

---

## 三、项目结构与开发规范

```text
abs-lab/
├── index.html                    # 平台总门户（按数学、物理、化学、生物排列，点学科进入学科页）
├── review.html                   # 今日重测（理解测试里记下的错误概念，按计划重测）
├── check.html                    # 理解小测（前测 / 后测，诊断用，不计分，数据只留在本机）
├── vercel.json                   # Vercel 部署配置
├── api/                          # 云端登录与进度同步接口（Upstash Redis）
│   ├── _redis.js
│   ├── auth.js
│   ├── progress.js
│   ├── mistakes.js               # 错题本（按账号保存，仅本人可读写）
│   └── quiz.js                   # 理解测试的作答记录（按账号、按题保存，仅本人可读写）
├── shared/
│   ├── theme.css                 # 公共样式与中英双语切换
│   ├── auth.js                   # 用户认证、记住我、跨设备进度同步
│   ├── topbar.js                 # 全站统一顶栏、账号弹窗、搜索入口（Ctrl / ⌘ K）
│   ├── mistakes.js               # 知识导图页面上的「我的错题」
│   ├── linker.js                 # 知识点 ↔ 实验互链（导图标签、预览卡、深链接、实验页的初中 / 高中标注）
│   ├── search.js                 # 全站搜索（第一次打开搜索时才加载）
│   ├── svgkit.js                 # 画板组件：坐标系、可拖动的点、约束、函数图象、静态图（window.ABSLabSVG）
│   ├── links.json                # 关联表：知识点 ↔ 实验模块、任务（手工维护）
│   ├── link-names.json           # 关联表、题库用到的知识点名称（脚本生成）
│   ├── search-index.json         # 四科知识点索引（脚本生成）
│   └── quiz/                     # 理解测试引擎（四科共用）
│       ├── core.js               # 纯逻辑：判定、重测排期、选题、交错、掌握门槛（node 也能用）
│       ├── engine.js             # 出题、预测关卡、反馈、存储、重测页（window.ABSLabQuiz）
│       ├── quiz.css              # 题目卡片样式（类名前缀 qz-）
│       ├── check.js              # 理解小测页（check.html）的脚本
│       ├── misconceptions.json   # 错误概念标签库
│       ├── index.json            # 知识点 → 题目（脚本生成）
│       └── items/                # 题库，一个学科或模块一个文件（math-demo.json 示范题；physics-pa / physics-pe / math-m1：第 1 批 A；
│                                 #   math-m2 / chemistry-cb / chemistry-cc：第 1 批 B）
├── math/                         # 📐 数学（学科页 index.html、知识导图、示范题 demo-poe.html、画板自测页 svgkit-demo.html、
│                                 #   动点与函数图象 moving-point.html、二次函数实验室 quadratic.html；js/*-model.js 是它们的模型）
├── physics/                      # ⚡ 物理（学科页、知识导图、电学实验台、电流的微观本质；js/sensor-models.js 是电学实验台 3、13 号的模型）
├── chemistry/                    # 🧪 化学（学科页、知识导图、中和反应实验台、溶解度曲线 solubility.html、反应后溶质成分 solute.html；
│                                 #   js/chem-models.js 是这两页的模型）
├── biology/                      # 🧬 生物（学科页、知识导图、显微镜实验台与标本图）
├── tests/                        # node --test tests/（单元测试）；e2e_batch0.py、e2e_batch1a.py、e2e_batch1b.py（端到端，Playwright）
├── tools/
│   ├── sync-maps.py              # 把项目里的知识导图同步成网站公开版
│   ├── build-index.py            # 生成搜索索引和题库索引，检查关联表和题库（导图、关联表、题库改动后运行）
│   └── dev-server.js             # 本地预览（含登录、进度同步、错题本、测试记录，数据库用内存模拟）
└── docs/操作日志.md               # 每次改动的记录
```

### 贡献代码时的 3 条关键约定
1. **所有链接与资源必须使用相对路径**
   - 正确写法：`../shared/theme.css`、`../index.html`、`specimens/onion-epidermis.jpg`
   - **禁止**以 `/` 开头的根路径（如 `/shared/theme.css`），否则通过 `https://www.wenzheng.eu/abs-lab/` 访问时会找不到资源。
2. **新页面接入统一顶栏与账号进度**
   - 在新 HTML 的 `<head>` 中加入：
     ```html
     <link rel="stylesheet" href="../shared/theme.css" />
     <script src="../shared/auth.js"></script>
     ```
   - 在 `<body>` 第一行加入：
     ```html
     <script src="../shared/topbar.js" data-root=".." data-page="你的模块名" data-bilingual="true"></script>
     ```
   - 如果是独立单文件整页集成（如知识导图），给 `topbar.js` 加上 `data-mode="compact"` 即可。
3. **尽量一实验一文件，减少冲突**
   - 新增实验放在对应学科文件夹下，并在 `index.html` 对应学科板块中增加入口卡片。

---

## 四、知识导图、错题本与互链

- 四科知识导图（`*/knowledge-map.html`）**不要直接改**：它们由 `tools/sync-maps.py` 从项目里的原始导图生成。改内容时先改原始导图，再运行：
  ```bash
  python3 tools/sync-maps.py --src <放原始导图的文件夹>          # 四科都同步
  python3 tools/sync-maps.py --src <文件夹> --only math            # 只同步一科
  ```
  脚本会去掉个人考试信息（阶段考试的日期、题号、分数、薄弱标记）和课堂进度，再插入站点顶栏、登录同步和错题本三行接入代码；对不上会报错停下。**原始导图含个人信息，不要放进仓库**（仓库是公开的）。
- 学习状态：四科分别存在浏览器的 `wlzs.` / `hxzs.` / `sxzs.` / `swzs.` 键里，已加入 `shared/auth.js` 的同步名单，登录后跨设备同步。
- 错题本：登录云端账号后，知识点旁出现「＋错题」，左下角「我的错题」查看、编辑、导出、导入。数据存在 Redis 的 `abslab:mistakes:<用户名>`，一条一个字段，只有本人的登录令牌能读写；游客和本地账号不能用。
- 本地预览（含登录和错题本）：`node tools/dev-server.js`，打开 `http://localhost:8080/abs-lab/`。

### 知识点与实验互链

- 关联表 `shared/links.json`：`targets` 是实验里的模块或任务（写明初中 / 高中和人教版教材位置），`links` 是「知识点 → 实验」或「知识点 → 另一科的知识点」，**每条只写一次**，导图上的标签、实验页上的「对应知识点」、首页和学科页上的统计都自动生成。
- 初中、高中按河南使用的人教版教材划分：七到九年级课本里有的算初中，只在高中课本（必修、选择性必修）里出现的算高中。高中的标签只在导图打开「显示高中内容」时出现；数学、生物导图没有这个开关，不显示高中标签。
- 链接格式：导图 `knowledge-map.html?kp=知识点键`（自动展开并定位），电学实验台 `circuits-lab.html#模块号`，其他实验页 `?task=任务名`；带 `from=` 时左下角出现「← 回到 …」。
- 导图同步或关联表改动后运行 `python3 tools/build-index.py`：重建搜索索引和名称表，并检查关联表里的知识点、实验模块和任务是否都还在（有问题会列出来并报错）。

---

## 五、理解测试引擎（`shared/quiz/`）

四科共用的「理解测试」：预测关卡、二段式 + 把握度题目、错误概念标签库，作答结果接到错题本和学习状态上。示范题：`math/demo-poe.html`；重测页：`review.html`；理解小测（前测 / 后测）：`check.html`。

### 1. 写题

题库放在 `shared/quiz/items/*.json`（一个学科或模块一个文件），格式：

```jsonc
{ "v": 1, "items": [ {
  "id": "m-dd-st-twotier",              // ^[a-z0-9][a-z0-9-]{2,47}$，全库唯一
  "subject": "math", "module": "demo",  // module 用于交错练习：相邻两题尽量不同 module
  "kp": ["math:c22-2-2"],               // 覆盖的知识点（学科:导图内的键，必须在 search-index.json 里）
  "type": "twotier",                    // predict 预测关卡 / twotier 二段式 / transfer 迁移 / inverse 逆向
  "level": "junior",                    // senior 只在物理、化学打开「显示高中内容」时出；数学、生物一律不出
  "context": "距离—时间读图",            // 情境：稳定迷思、重测选题都看它
  "retest": true,                       // true 的题会被 review.html 拿来重测，不能依赖交互部件（widget 为 null）
  "page": "math/demo-poe.html",         // 题目所在页面（导图上的「理解测试」标签点过去）
  "widget": null,                       // 预测关卡用的交互部件 id
  "stem": "题干", "figures": [ /* 静态图，见下 */ ],
  "answer": { "options": [ { "id": "a", "text": "…", "figure": null, "mc": "graphaspath" } ], "correct": "b" },
  "reason": { "options": [ … ], "correct": "r2" },       // 可以为 null
  "confidence": true,
  "explain": { "prompt": "用一句话说一说……", "min": 6 }, // 预测关卡的解释题，可以为 null
  "feedback": { "ref": "参考解释（正确的看法）" }
} ] }
```

- 选项上的 `mc` 是错误概念标签，写在**错误**的答案或理由上；标签必须在 `shared/quiz/misconceptions.json` 里。
- 选项、理由按数组顺序显示，字母 A、B、C（理由 1、2、3）按位置标，和选项 `id` 无关。**正确答案、正确理由不要总排在同一个位置**（见下面的位置检查）；改排列时 id、对错、标签都不用动。
- 理由写「方法」，不写「结果」：二段式题的答案和理由同屏出现，理由里写出答案的数值就等于把答案告诉了学生。几条理由写成并列的几种算法或想法。
- 预测关卡可以带可选的 `"ask"`：预测那一问的提问文字（缺省是「先预测：你认为图象是哪一个？」），预测的对象不是图象时用，例如电子秤的刻度疏密。
- 静态图（题图、选项缩略图）用声明式写法，由 `ABSLabSVG.figure` 画：
  `{ "view": [xmin, xmax, ymin, ymax], "aspect": "fill" | "equal", "axes": { "x": "x", "y": "y", "xt": [6, 10], "yt": [12] } 或 null, "items": [ {"t":"polyline","pts":[[0,0],[6,12]]}, {"t":"polygon","pts":[…],"fill":false}, {"t":"segment","a":[0,0],"b":[6,0],"dash":true}, {"t":"point","at":[2,0],"label":"P"}, {"t":"text","at":[0,4],"s":"A","pos":"nw"} ] }`；线条可加 `"dash": true`、`"accent": true`。
- **同一个错误概念至少配两道不同情境（context）的题**：两道都答成错误概念才标「稳定迷思」。从第 1 批起 `build-index.py` 对此报错（第 0 批只报警告）。
- **模块完整性**：`tools/build-index.py` 顶部的 `MODULE_RULES` 列出的模块（现在是 `pa`、`pe`、`m1`、`m2`、`cb`、`cc`），每个至少 1 道预测关卡（predict）、6 道二段式题（twotier，每道至少有一个答案或理由选项带 `mc` 标签）、2 道迁移题（transfer）、1 道逆向题（inverse），不够就报错。新模块上线时把它加进这个常量。
- **正确选项的位置**（同样只查 `MODULE_RULES` 里的模块）：按题库顺序，正确答案排在同一个位置的题不超过一半（题数是奇数时向上取整，例如 9 道二选一的理由最多 5 道同位），也不能连续 3 道落在同一个位置；正确理由同样检查。不满足就报错。

错误概念标签库 `shared/quiz/misconceptions.json`：

```json
{ "v": 1, "tags": { "graphaspath": {
  "name": "图象即轨迹", "subject": "math", "subjects": ["math", "physics"],
  "kp": ["math:c22-2-2", "math:c23-4-2"], "level": "junior",
  "desc": "一句话说明这个错误想法", "refute": "反驳性反馈：先点出常见想法，再说为什么不对、正确的看法是什么",
  "source": "确有其事的文献；不确定就留空字符串"
} } }
```

标签 id 匹配 `^[a-z][a-z0-9]{5,31}$`；`subject` 是主学科，错题本里这条错题记在它名下，知识点取 `kp` 里属于主学科的第一个。

改了题库或标签库，运行 `python3 tools/build-index.py`：检查题库（id、选项、标签、知识点、页面、可重测的题不能带部件……）并重新生成 `shared/quiz/index.json`（知识点 → 题目）。

### 2. 判定规则（`core.classify`）

| 答案 | 理由（没有理由这一段时算对） | 把握 | 结果 |
| --- | --- | --- | --- |
| 对 | 对 | 有把握 | `pass` 通过 |
| 对 | 对 | 没把握 | `unsure`：不算通过，也不进错题本 |
| 对 | 错 | 不论 | `mc` 错误概念 |
| 错 | — | 有把握 | `mc` 错误概念 |
| 错 | — | 没把握 | `gap` 知识缺漏 |

标签取所选错误答案、错误理由上的 `mc`，合并去重；判为 `mc` 却没有标签时改判 `gap`。预测关卡的解释是自由文字，不自动评分，只保存原文并给出参考解释让学生自己对照。

### 3. 交互部件（预测关卡）

```js
ABSLabQuiz.registerWidget("math-dd-area", function (el, api) {
  // 在 el 里画部件；api.onProgress(0~1) 报进度，api.done() 表示达到完成条件（「看对比」随之可用）
  return {
    lock: function () {}, unlock: function () {}, reset: function () {},
    result: function () { return { figure: { /* 静态图写法，「实际结果」 */ } }; }
  };
});
ABSLabQuiz.mount(el, { items: ["m-dd-area-poe"], mode: "poe" });   // 练习题 mode: "practice"
```

预测关卡第一次打开时锁定（「先预测，再动手」），提交预测后解锁；做过以后部件可以自由操作，旁边有「重新预测」。预测阶段只露出锁着的部件和作答区（进度提示、「看对比」在提交后才出现）；示范题的部件在手机上还会先藏起空的函数板，让预测选项紧跟在几何板下面。

**外部部件**：部件的 DOM 已经在页面上（例如电学实验台里现成的模块），不能交给引擎在卡片里新建时，用 `registerExternal`。引擎只负责锁定、解锁、读进度和结果，不建部件、不清空容器：

```js
ABSLabQuiz.registerExternal("phy-m3-lamp", {
  cover: document.querySelector("#m3 .stage"),  // 「先预测，再动手」遮罩盖在这里（元素，或返回元素的函数）
  scrollTarget: null,                           // 可选：提交预测后滚到哪里，缺省是 cover
  bind: function (api) {                        // 卡片挂上时调用；api.onProgress / api.done 同上
    return { lock: function () {}, unlock: function () {}, reset: function () {}, result: function () { return { figure: {} }; } };
  }
});
// 先注册，再 mount；promptHost 可选：题头、题干、题图放进 promptHost（页面把它放在模块图上方），
// 作答区留在 mount 的容器里（页面把它放在模块图紧下方，手机上预测选项就紧跟在模块图下面）
ABSLabQuiz.mount(answerEl, { items: ["p-pa-poe"], mode: "poe", promptHost: promptEl });
```

- 遮罩是 `cover > .qz-lock`，锁定时 cover 带 `data-qz-locked="true"`；cover 原来是 static 定位时引擎补一个 `position: relative`。控件由部件自己的 `lock()` / `unlock()` 锁住、放开（例如把滑块设成 disabled）。
- 题干块是 `promptHost > .qz-prompt#qz-<题目 id>`（锚点跟着题干走），作答块是 `section.qz-card.qz-card-ext`（没有 id）；两块都带 `data-stage`。
- 提交预测以后到解释之前，作答区收起成一行「你的预测：……」，不把模块的操作区隔开；反馈阶段再展开、在选项上标对错。
- 同一个外部部件同一时间只挂一张卡片：重新 mount 时自动撤掉上一张卡片的遮罩和题干。
- `result()` 除了 `figure` 还可以给 `note`：「实际结果」下面的说明文字（缺省是「你刚才拖出来的图象」）。普通部件也可以用。
- `registerWidget` 的写法和行为不变（第 0 批示范题、`tests/e2e_batch0.py` 不受影响）。

### 4. 记录、错题本、重测

- 登录（云端账号）后：作答记在 `api/quiz`（Redis `abslab:quiz:<用户名>`，每题最近 20 次）；答成 `mc` / `gap` 的按**错误概念**写进错题本（`mc-<标签>`，没有标签的按题 `qz-<题目>`），`origin: "quiz"`，带 `mc`、`qids`、`review` 字段。
- 游客：作答只记在本机 `localStorage["abslab.quiz.v1"]`，不同步、不进错题本；登录后不自动合并游客记录。
- 重测间隔在 `shared/quiz/core.js` 顶部的 `INTERVALS = [1, 3, 7, 14]`（天）。这只是工程设定，以后按数据调这一行即可。
  - 通过：进一档，下次 = 今天 + 这一档的间隔；第一次通过时错题变「已订正」；14 天那一档也通过了：「已掌握」，不再安排。
  - 没把握：不进档，明天再测。答错：回到第 0 档，明天再测，错题回到「未订正」。
  - 在错题本里手动标「已掌握」：停止安排。
  - 「稳定迷思」的记录一直保留；这条错题变成「已掌握」以后，错题本和重测页把徽标改成灰色的「曾是稳定迷思」。
  - 选题：带这个标签、可重测、级别允许的题里，情境和上次不同的优先，再是最久没做过的，最后按 id。一次最多 10 题，相邻两题尽量不同 module（不行再不同学科）。
- 日期一律用学生设备上的本地日期。

### 5. 掌握门槛和导图上的「理解测试」标签

某个知识点在**两个不同日期**里，每天都至少通过 1 道覆盖它的二段式题和 1 道迁移题，才算「测试达标」；只有一天是「测试 1 / 2」；达标之后在这个知识点的题上又答成错误概念，退回「测试 1 / 2」。
导图上有测试题的知识点会多一个标签：游客显示「理解测试 →」；登录后显示「测试达标 ✓」「测试 1 / 2」「测试 0 / 2」（做过题、但还没有一天达标）或「未测」（一道都没做过）；手动标了「已掌握」但测试没达标时显示「待验证」。导图上原有的手动学习状态不改、不拦。

### 6. 测试

```bash
node --test tests/                 # 单元测试（判定、排期、选题、交错、掌握门槛、几何函数、第 1 批 A / B 的模型和题目数值）
python3 tools/build-index.py --check
python3 tests/e2e_batch0.py        # 端到端（需要 Playwright；自己启动 dev-server 8090）
python3 tests/e2e_batch1a.py       # 第 1 批 A 的端到端（自己启动 dev-server 8092）
python3 tests/e2e_batch1b.py       # 第 1 批 B 的端到端（自己启动 dev-server 8093）
```

- `tests/batch1a-content.test.js`：用模型函数（`physics/js/sensor-models.js`、`math/js/moving-point-model.js`）把第 1 批 A 每道题里的数值、正确选项、缩略图折线点重新算一遍，和题库对上；改题库或模型以后先跑它。
- `tests/batch1b-content.test.js`：同样做法核对第 1 批 B 的三个题库（`math/js/quadratic-model.js`、`chemistry/js/chem-models.js`）；`tests/quadratic-model.test.js`、`tests/chem-models.test.js` 是这两个模型自己的测试（溶解度插值、析出量、试剂对粒子数守恒、变质规则和 judgeSample）。
- Python Playwright 要和本机浏览器的版本对得上（例如预装的是 Node Playwright 1.63 带的浏览器，就装 `pip install playwright==1.63.0`），否则 `chromium.launch()` 找不到浏览器。

### 7. 理解小测（`check.html`）

给一个班做前测、后测，比较正确率和「有把握却答错」的比例怎么变。地址 `check.html?m=pa|pe|m1|m2|cb|cc&t=pre|post`（缺 m 或 t 时页面让人选；模块名单是 `shared/quiz/check.js` 里的 `MODS`，新模块上线时加进去）。

- 按题库顺序出这个模块全部 `retest: true` 的题（二段式、迁移、逆向；不出预测关卡），一屏一题，作答时不给反馈、不标对错；可以退回去改。
- 不需要登录，不调 `api/quiz`、`api/mistakes`，不写错题本：只读题库，作答只存本机 `localStorage["abslab.check.v1"]`（`runs[模块][pre|post]`，另有没做完的草稿）。顶栏脚本带 `data-no-visit`，这一页不记「访问过」。
- 小结：正确率 = `pass` 题数 ÷ 总题数；有把握却答错 = 答案错且选了「有把握」的题数 ÷ 总题数；每个错误概念被答中的次数（同一题的答案和理由指向同一个错误概念时只记一次）。同一台设备上前测、后测都有时并排显示。
- 「下载 CSV」：列为 `模块,前测 / 后测,日期,题目 id,答案,理由,把握,判定,错误概念标签,用时（秒）,编号`（编号可不填，只写进 CSV）；答案、理由写「题库选项 id（显示为 字母）」，判定写 `pass` / `unsure` / `mc` / `gap`；UTF-8 带 BOM。微信里下载不了时用「复制 CSV 文本」。
- 选项的显示顺序就是题库的排列；`check.js` 顶部的 `SHUFFLE` 打开时会在这个基础上再按题目 id 固定打乱（现在关着）。

### 8. 第 1 批 A 的模块

| 模块 | 在哪里 | 模型 | 题库（module） | 预测关卡（部件 id） |
| --- | --- | --- | --- | --- |
| P-A 小灯泡的 I-U 图像 | `physics/circuits-lab.html` 3 号模块，「小灯泡 L（2.5 V）」模式 | `physics/js/sensor-models.js`（lampCircuit 等，二分法求工作点） | `physics-pa.json`（pa） | 外部部件 `phy-m3-lamp` |
| P-E 传感器模板 | `physics/circuits-lab.html` 13 号模块：风速仪（原样）、电子秤、酒精测试仪、身高测量仪 | `physics/js/sensor-models.js`（scaleState、alcoholState、heightState、dialTicks…） | `physics-pe.json`（pe） | 外部部件 `phy-m13-scale` |
| M1 动点与函数图象 | `math/moving-point.html`（任务 rect、pq、time，进度键 `math_mpoint_tasks`） | `math/js/moving-point-model.js` | `math-m1.json`（m1） | 外部部件 `m1-pq` |

- 电学实验台只在第一次打开 3 号或 13 号模块时才加载 `quiz.css`、`sensor-models.js`、`svgkit.js`、`core.js`、`engine.js`；打开别的模块一个都不多下载。3 号的「定值电阻 R₀」模式、13 号的风速仪仍走原来的代码，读数和改动前逐字一致（风速仪的式子在 `sensor-models.js` 里也有一份 `windState`，端到端测试用它核对页面）。
- 每个模块下面有可折叠的「理解测试（9 题）」（练一练）和「做小测（前测 / 后测）→」链接；深链 `circuits-lab.html#qz-<题目 id>` 会打开对应模块（预测关卡切到对应模式，其他题展开练一练）。
- 测试钩子（只给端到端测试用）：电学实验台 `window.__lab`（`assets()`、`m3()`、`m13()`），动点页 `window.__mp`，小测页 `window.__check`。

### 9. 第 1 批 B 的模块

| 模块 | 在哪里 | 模型 | 题库（module） | 预测关卡（部件 id） |
| --- | --- | --- | --- | --- |
| M2 二次函数实验室 | `math/quadratic.html`（情境 vertex 顶点式与平移、interval 区间最值、abc a、b、c 与图象；进度键 `math_quad_tasks`） | `math/js/quadratic-model.js` | `math-m2.json`（m2） | 外部部件 `m2-vertex` |
| C-B 溶解度曲线 | `chemistry/solubility.html`（情境 cool 降温结晶、compare 两条曲线与交点、nacl NaCl 与蒸发结晶；进度键 `chem_solub_tasks`） | `chemistry/js/chem-models.js`（溶解度表 + 单调三次插值、state、coolPath…） | `chemistry-cb.json`（cb） | 外部部件 `cb-state` |
| C-C 反应后溶质成分 | `chemistry/solute.html`（情境 curve 换试剂、曲线取样，spoil NaOH 变质探究；进度键 `chem_solute_tasks`） | `chemistry/js/chem-models.js`（pairState、phCurve、变质规则、judgeSample…） | `chemistry-cc.json`（cc） | 外部部件 `cc-curve` |

- 三个页面的结构照「动点与函数图象」：标签页切换情境（`section[data-task]`），`?task=` 打开对应情境，`#qz-<题目 id>` 定位到题；页面下方是练一练和「做小测（前测 / 后测）→」。
- 化学页只写初中说法：浓度只写「稀盐酸」「NaOH 溶液」和体积，离子数量用「示意粒子数」（1 个粒子 = 0.1 mmol，只在代码里换算）；pH 的算法、浓度只在 `chem-models.js` 里用。高中内容只出现在溶质页底部默认收起、标「高中」的小框里。
- 溶解度页：空心的「状态点」是一共加入的溶质（按每 100 g 水算），曲线上的实心点是溶液实际组成；两点之间的虚线旁写「析出 x g」（cool、compare，100 g 水）或「每 100 g 水多 x g」（nacl，水会蒸发），实际析出质量看读数和小烧杯。
- 变质探究的「核对」按「证据够了才算对」：`ABSLabChem.judgeSample` 把这份样品做过的每支试管按同样的试剂顺序套到三种情况上，只留下现象一致的；只剩一种且和选的相同才是 ✓，被现象排除时提示「和你看到的现象对不上」，还剩两三种时提示再设计一步实验。
- 中和反应实验台的任务卡片下面有一张「下一步」卡片，链到溶质页。
- 测试钩子：二次函数页 `window.__quad`，溶解度页 `window.__solub`，溶质页 `window.__solute`。

---

## 六、画板组件（`shared/svgkit.js` → `window.ABSLabSVG`）

自测页：`math/svgkit-demo.html`（不进导航、不进搜索引擎，只给开发者看）。只用原生 SVG，手机上单指拖动跟手；拖动时页面不滚动，手指落在板外或空白处时页面照常滚动。

```js
var b = ABSLabSVG.board(el, {
  view: [xmin, xmax, ymin, ymax], aspect: "equal" | "fill", height: 240 | "auto", maxHeight: "40vh",
  axes: { x: "x", y: "y", xt: [..], yt: [..] } | null, grid: true, pad: 24
});
b.toScreen([x, y]); b.toWorld([sx, sy]);
var P = b.point([0, 0], { label: "P", draggable: true, r: 6, hit: 22, step: 0.1,
                          constrain: ABSLabSVG.on.polyline([[0, 0], [6, 0], [6, 4]]),
                          ariaText: function (P, meta) { return "路程 x = " + meta.s.toFixed(1); } });  // 读屏软件念的文字，缺省念坐标
P.get(); P.set([x, y]); P.meta(); P.on("start" | "drag" | "end", fn); P.enable(false);
b.segment(A, B, opts); b.polyline(ptsOrFn, opts); b.polygon(ptsOrFn, { fill: true });
b.circle(cOrFn, rOrFn); b.text(atOrFn, strOrFn, { pos: "nw" });
b.fn(f, { domain: [a, b], upTo: function () { return maxX; } });
b.sketch({ onEnd: function (pts) {} });
b.update(); b.destroy();
// 通用 opts：cls、color（"blue" "green" "coral" "sun" "red" "purple" "cyan" "ink" "muted"）、dash、width、fill、accent
// 返回的元素 handle：{ node, show(bool), toggle(className, on), remove() }；高亮用 toggle("sk-hot", true)

ABSLabSVG.on.segment(A, B) / .polyline(pts) / .circle(c, r) / .fn(f, [a, b]) / .grid(step) / .box([x0, x1, y0, y1]);
ABSLabSVG.geo.dist / lerp / projectSegment / projectPolyline / param / foot / intersect / rotate / reflect / area / signedArea / angle;
ABSLabSVG.figure(el, spec);       // 声明式静态图（写法见上一节）
ABSLabSVG.controls(el, [{ id, label, min, max, step, value, advanced: false }], onChange);  // 默认最多显示 2 个滑块，其余收进「进阶」
```

- 可拖动的点带一个看不见的触控圈（半径 ≥ 22 px，直径 ≥ 44 px）；键盘可以用方向键沿约束移动，Home / End 跳到约束的两端。
- 线宽用 `width`（px）；高亮用 `toggle("sk-hot", true)`。`ABSLabSVG.perf` 记录拖动时每次 move 和每帧的耗时（端到端测试用）。
- 尺寸变化时重算坐标变换，点保持世界坐标不变，文字和线宽不随缩放变化；`maxHeight` 写成 `vh` 时，只改窗口高度也会重算（输入框有焦点时不算，避免软键盘弹出时画板跳动）。
- 几何函数（`ABSLabSVG.geo`）在 node 里也能 `require("./shared/svgkit.js")` 直接用。
- 一屏只放一个可拖动对象和一个联动图；滑块默认最多 2 个。

---

## 七、常见问题快速排查

- **`git push` 提示 `rejected (fetch first / non-fast-forward)`**
  说明远程 `main` 有别人新合并的更新，先同步再推：
  ```bash
  git pull --rebase origin main
  git push
  ```
- **想放弃本地改乱的某个文件**
  ```bash
  git checkout -- 文件路径
  ```
- **如何测试跨设备登录与进度同步？**
  本地双击 `file://` 打开时自动走浏览器本地存储模式；推送合并上线后访问 `https://www.wenzheng.eu/abs-lab/`，登录弹窗右上角显示绿色「云端已连接」，即可在电脑和手机间实时同步进度。
