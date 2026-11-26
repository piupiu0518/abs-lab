(function () {
  var ACCOUNTS_KEY = "abs_lab_v1_accounts";
  var CURRENT_KEY = "abs_lab_v1_current_user";
  var TOKEN_KEY = "abs_lab_v1_cloud_token";
  var GUEST_KEY = "abs_lab_v1_guest_data";

  // 需要跟账号走、跨设备同步的本地存储键（四科知识导图的学习状态与状态名称等）
  var BRIDGED_KEYS = [
    "wlzs.status",
    "wlzs.statusNames",
    "wlzs.showHS",
    "hxzs.status",
    "hxzs.statusNames",
    "hxzs.showHS",
    "sxzs.status",
    "sxzs.statusNames",
    "swzs.status",
    "swzs.statusNames",
    "mx_lab_cur"
  ];

  // 计算相对的 API 根路径（支持 file://、*.vercel.app 以及 wenzheng.eu/abs-lab/）
  var API_BASE = null;
  try {
    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      var scriptEl = document.currentScript;
      if (scriptEl && scriptEl.src) {
        API_BASE = scriptEl.src.replace(/shared\/auth\.js(\?.*)?$/, "api/");
      }
    }
  } catch (e) {}

  var rawGet = Storage.prototype.getItem;
  var rawSet = Storage.prototype.setItem;
  var rawRemove = Storage.prototype.removeItem;

  function safeGet(storage, key) {
    try { return rawGet.call(storage, key); } catch (e) { return null; }
  }
  function safeSet(storage, key, val) {
    try { rawSet.call(storage, key, val); return true; } catch (e) { return false; }
  }
  function safeRemove(storage, key) {
    try { rawRemove.call(storage, key); } catch (e) {}
  }

  function hashPassword(username, password) {
    var input = "abs-lab::" + username.toLowerCase() + "::" + password + "::2026";
    var h1 = 0xdeadbeef ^ input.length;
    var h2 = 0x41c6ce57 ^ input.length;
    for (var i = 0; i < input.length; i++) {
      var ch = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  }

  function readJSON(key, fallback) {
    var raw = safeGet(window.localStorage, key);
    if (raw === null) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function writeJSON(key, val) {
    safeSet(window.localStorage, key, JSON.stringify(val));
  }

  function getAccounts() {
    var obj = readJSON(ACCOUNTS_KEY, {});
    return obj && typeof obj === "object" ? obj : {};
  }

  function saveAccounts(accounts) {
    writeJSON(ACCOUNTS_KEY, accounts);
  }

  function normalizeName(name) {
    return String(name || "").trim();
  }

  // 会话读写（支持 Remember Me：勾选存 localStorage，不勾选仅存 sessionStorage）
  function getSessionUser() {
    return safeGet(window.sessionStorage, CURRENT_KEY) || safeGet(window.localStorage, CURRENT_KEY) || null;
  }

  function getSessionToken() {
    return safeGet(window.sessionStorage, TOKEN_KEY) || safeGet(window.localStorage, TOKEN_KEY) || null;
  }

  function setSession(username, token, rememberMe) {
    safeRemove(window.localStorage, CURRENT_KEY);
    safeRemove(window.localStorage, TOKEN_KEY);
    safeRemove(window.sessionStorage, CURRENT_KEY);
    safeRemove(window.sessionStorage, TOKEN_KEY);

    var target = rememberMe ? window.localStorage : window.sessionStorage;
    safeSet(target, CURRENT_KEY, username);
    if (token) safeSet(target, TOKEN_KEY, token);
  }

  function clearSession() {
    safeRemove(window.localStorage, CURRENT_KEY);
    safeRemove(window.localStorage, TOKEN_KEY);
    safeRemove(window.sessionStorage, CURRENT_KEY);
    safeRemove(window.sessionStorage, TOKEN_KEY);
  }

  function getCurrentUsername() {
    var u = getSessionUser();
    if (!u) return null;
    var accounts = getAccounts();
    if (accounts[u]) return u;
    // 云端 token 存在时自动补本地缓存桶
    if (getSessionToken()) {
      accounts[u] = { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), data: createEmptyData() };
      saveAccounts(accounts);
      return u;
    }
    return null;
  }

  function createEmptyData() {
    return {
      lang: "bilingual",
      visited: {},
      circuits_learned: {},
      hs_elec_tasks: { close: false, open: false, ohm: false, flip: false },
      chem_neut_tasks: { drip: false, jump: false, indicator: false },
      bio_micro_tasks: { focus_low: false, high_mag: false, animal_cell: false, organelle: false },
      math_mpoint_tasks: { rect: false, pq: false, time: false },
      math_quad_tasks: { vertex: false, interval: false, abc: false },
      chem_solub_tasks: { cool: false, compare: false, nacl: false },
      chem_solute_tasks: { curve: false, spoil: false },
      bridged: {}
    };
  }

  function getActiveBucket() {
    var username = getCurrentUsername();
    if (username) {
      var accounts = getAccounts();
      if (!accounts[username].data) accounts[username].data = createEmptyData();
      return { username: username, data: accounts[username].data, accounts: accounts };
    }
    var guest = readJSON(GUEST_KEY, null) || createEmptyData();
    return { username: null, data: guest, accounts: null };
  }

  // 防抖云端同步
  var cloudState = { checked: false, enabled: false };
  var pushTimer = null;

  function scheduleCloudPush(data) {
    var token = getSessionToken();
    if (!API_BASE || !token || !cloudState.enabled) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      fetch(API_BASE + "progress", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ data: data })
      }).catch(function () {});
    }, 600);
  }

  function saveActiveBucket(bucket, skipCloud) {
    bucket.data.updatedAt = new Date().toISOString();
    if (bucket.username && bucket.accounts) {
      bucket.accounts[bucket.username].data = bucket.data;
      bucket.accounts[bucket.username].updatedAt = bucket.data.updatedAt;
      saveAccounts(bucket.accounts);
      if (!skipCloud) scheduleCloudPush(bucket.data);
    } else {
      writeJSON(GUEST_KEY, bucket.data);
    }
  }

  function hydrateBridgedToStorage(data) {
    var bridged = (data && data.bridged) || {};
    for (var i = 0; i < BRIDGED_KEYS.length; i++) {
      var k = BRIDGED_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(bridged, k) && bridged[k] !== null && bridged[k] !== undefined) {
        safeSet(window.localStorage, k, bridged[k]);
      } else {
        safeRemove(window.localStorage, k);
      }
    }
  }

  function snapshotBridgedFromStorage(bucket) {
    if (!bucket.data.bridged) bucket.data.bridged = {};
    var changed = false;
    for (var i = 0; i < BRIDGED_KEYS.length; i++) {
      var k = BRIDGED_KEYS[i];
      var val = safeGet(window.localStorage, k);
      if (val !== null && bucket.data.bridged[k] !== val) {
        bucket.data.bridged[k] = val;
        changed = true;
      }
    }
    if (changed) saveActiveBucket(bucket);
  }

  var syncingNow = false;
  try {
    Storage.prototype.setItem = function (key, value) {
      rawSet.call(this, key, value);
      if (this === window.localStorage && !syncingNow && BRIDGED_KEYS.indexOf(key) !== -1) {
        syncingNow = true;
        try {
          var bucket = getActiveBucket();
          if (!bucket.data.bridged) bucket.data.bridged = {};
          bucket.data.bridged[key] = String(value);
          saveActiveBucket(bucket);
        } finally {
          syncingNow = false;
        }
      }
    };
  } catch (e) {}

  (function bootstrap() {
    var username = getCurrentUsername();
    if (username) {
      var accounts = getAccounts();
      if (accounts[username] && accounts[username].data) {
        hydrateBridgedToStorage(accounts[username].data);
      }
    } else {
      var guestBucket = getActiveBucket();
      snapshotBridgedFromStorage(guestBucket);
    }
  })();

  var listeners = [];
  function notifyChange() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](api.getCurrentUser()); } catch (e) {}
    }
    try { window.dispatchEvent(new CustomEvent("abs-auth-changed")); } catch (e) {}
  }

  // 启动时探测云端数据库状态；若已登录且有 token，拉取云端最新进度
  async function initCloud() {
    if (!API_BASE) {
      cloudState.checked = true;
      cloudState.enabled = false;
      return;
    }
    try {
      var res = await fetch(API_BASE + "auth", { method: "GET" });
      if (res.ok) {
        var json = await res.json();
        cloudState.checked = true;
        cloudState.enabled = !!json.cloudEnabled;
      }
    } catch (e) {
      cloudState.checked = true;
      cloudState.enabled = false;
    }

    var token = getSessionToken();
    var username = getCurrentUsername();
    if (cloudState.enabled && token && username) {
      try {
        var pr = await fetch(API_BASE + "progress", {
          method: "GET",
          headers: { Authorization: "Bearer " + token }
        });
        if (pr.ok) {
          var pJson = await pr.json();
          if (pJson.ok && pJson.data) {
            var bucket = getActiveBucket();
            var localTs = bucket.data.updatedAt ? Date.parse(bucket.data.updatedAt) : 0;
            var cloudTs = pJson.updatedAt ? Date.parse(pJson.updatedAt) : 0;
            if (cloudTs > localTs) {
              bucket.data = Object.assign(createEmptyData(), pJson.data);
              saveActiveBucket(bucket, true);
              hydrateBridgedToStorage(bucket.data);
              notifyChange();
            } else if (localTs > cloudTs) {
              scheduleCloudPush(bucket.data);
            }
          }
        }
      } catch (e) {}
    }
  }
  initCloud();

  var api = {
    isCloudEnabled: function () {
      return cloudState.enabled;
    },

    // 云端登录令牌（错题本等按条读写的接口使用）；本地账号或游客返回 null
    getToken: function () {
      return getCurrentUsername() ? getSessionToken() : null;
    },

    getApiBase: function () {
      return API_BASE;
    },

    getCurrentUser: function () {
      var u = getCurrentUsername();
      if (!u) return null;
      var accounts = getAccounts();
      return {
        username: u,
        cloud: cloudState.enabled && Boolean(getSessionToken()),
        createdAt: accounts[u] ? accounts[u].createdAt : null,
        updatedAt: accounts[u] ? accounts[u].updatedAt : null
      };
    },

    listUsernames: function () {
      return Object.keys(getAccounts());
    },

    register: async function (rawName, rawPassword, options) {
      options = options || {};
      var inheritGuest = options.inheritGuest !== false;
      var rememberMe = options.rememberMe !== false;
      var username = normalizeName(rawName);
      var password = String(rawPassword || "");

      if (username.length < 2 || username.length > 20) {
        return { ok: false, message: "用户名长度需为 2～20 个字符。" };
      }
      if (password.length < 4) {
        return { ok: false, message: "密码请至少设置 4 位字符或数字。" };
      }

      var currentBucket = getActiveBucket();
      snapshotBridgedFromStorage(currentBucket);
      var initData = inheritGuest && !getCurrentUsername()
        ? JSON.parse(JSON.stringify(currentBucket.data))
        : createEmptyData();

      // 优先走云端数据库
      if (API_BASE && (!cloudState.checked || cloudState.enabled)) {
        try {
          var r = await fetch(API_BASE + "auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "register", username: username, password: password, initialData: initData })
          });
          var j = await r.json();
          if (r.status !== 503 && j.cloudEnabled !== false) {
            cloudState.checked = true;
            cloudState.enabled = true;
            if (!r.ok || !j.ok) return { ok: false, message: j.message || "注册失败" };

            var accounts = getAccounts();
            var now = new Date().toISOString();
            accounts[j.username] = {
              passwordHash: hashPassword(j.username, password),
              createdAt: now,
              updatedAt: now,
              data: Object.assign(createEmptyData(), j.data || initData)
            };
            saveAccounts(accounts);
            setSession(j.username, j.token, rememberMe);
            hydrateBridgedToStorage(accounts[j.username].data);
            notifyChange();
            return { ok: true, username: j.username, cloud: true, message: "注册成功！" };
          }
          cloudState.checked = true;
          cloudState.enabled = false;
        } catch (e) {}
      }

      // 本地模式兜底
      var localAccounts = getAccounts();
      var lower = username.toLowerCase();
      var existing = Object.keys(localAccounts).find(function (k) { return k.toLowerCase() === lower; });
      if (existing) {
        return { ok: false, message: "用户名「" + existing + "」已存在，请直接登录或换一个名字。" };
      }
      var ts = new Date().toISOString();
      localAccounts[username] = {
        passwordHash: hashPassword(username, password),
        createdAt: ts,
        updatedAt: ts,
        data: initData
      };
      saveAccounts(localAccounts);
      setSession(username, null, rememberMe);
      hydrateBridgedToStorage(initData);
      notifyChange();
      return { ok: true, username: username, cloud: false, message: "注册成功！" };
    },

    login: async function (rawName, rawPassword, options) {
      options = options || {};
      var rememberMe = options.rememberMe !== false;
      var username = normalizeName(rawName);
      var password = String(rawPassword || "");

      var prevBucket = getActiveBucket();
      snapshotBridgedFromStorage(prevBucket);

      // 优先走云端数据库
      if (API_BASE && (!cloudState.checked || cloudState.enabled)) {
        try {
          var r = await fetch(API_BASE + "auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "login", username: username, password: password })
          });
          var j = await r.json();
          if (r.status !== 503 && j.cloudEnabled !== false) {
            cloudState.checked = true;
            cloudState.enabled = true;
            if (!r.ok || !j.ok) return { ok: false, message: j.message || "登录失败" };

            var accounts = getAccounts();
            var now = new Date().toISOString();
            var merged = Object.assign(createEmptyData(), j.data || {});
            accounts[j.username] = {
              passwordHash: hashPassword(j.username, password),
              createdAt: (accounts[j.username] && accounts[j.username].createdAt) || now,
              updatedAt: now,
              data: merged
            };
            saveAccounts(accounts);
            setSession(j.username, j.token, rememberMe);
            hydrateBridgedToStorage(merged);
            notifyChange();
            return { ok: true, username: j.username, cloud: true, message: "欢迎回来，" + j.username + "！" };
          }
          cloudState.checked = true;
          cloudState.enabled = false;
        } catch (e) {}
      }

      // 本地模式兜底
      var localAccounts = getAccounts();
      var lower = username.toLowerCase();
      var matchedKey = Object.keys(localAccounts).find(function (k) { return k.toLowerCase() === lower; });
      if (!matchedKey) return { ok: false, message: "未找到该用户名，请先注册。" };
      if (hashPassword(matchedKey, password) !== localAccounts[matchedKey].passwordHash) {
        return { ok: false, message: "密码不正确，请重试。" };
      }

      setSession(matchedKey, null, rememberMe);
      if (!localAccounts[matchedKey].data) localAccounts[matchedKey].data = createEmptyData();
      hydrateBridgedToStorage(localAccounts[matchedKey].data);
      notifyChange();
      return { ok: true, username: matchedKey, cloud: false, message: "欢迎回来，" + matchedKey + "！" };
    },

    logout: function () {
      var prevBucket = getActiveBucket();
      snapshotBridgedFromStorage(prevBucket);
      clearSession();
      var guest = readJSON(GUEST_KEY, null) || createEmptyData();
      hydrateBridgedToStorage(guest);
      notifyChange();
    },

    getProgress: function (key, fallback) {
      var bucket = getActiveBucket();
      if (Object.prototype.hasOwnProperty.call(bucket.data, key)) return bucket.data[key];
      return fallback;
    },

    setProgress: function (key, value) {
      var bucket = getActiveBucket();
      bucket.data[key] = value;
      saveActiveBucket(bucket);
    },

    markVisited: function (moduleId) {
      var bucket = getActiveBucket();
      if (!bucket.data.visited) bucket.data.visited = {};
      bucket.data.visited[moduleId] = new Date().toISOString();
      saveActiveBucket(bucket);
    },

    getSummary: function () {
      var bucket = getActiveBucket();
      snapshotBridgedFromStorage(bucket);
      var data = bucket.data;
      var bridged = data.bridged || {};

      // 知识导图：各科「已掌握」（第 4 档）和「已标状态」的知识点数
      function countMap(key) {
        var out = { mastered: 0, marked: 0 };
        if (!bridged[key]) return out;
        try {
          var st = JSON.parse(bridged[key]);
          Object.keys(st).forEach(function (k) {
            if (+st[k] > 0) out.marked++;
            if (+st[k] === 3) out.mastered++;
          });
        } catch (e) {}
        return out;
      }
      var kmPhy = countMap("wlzs.status"), kmChem = countMap("hxzs.status"), kmMath = countMap("sxzs.status"), kmBio = countMap("swzs.status");
      var kmMastered = kmPhy.mastered, kmMarked = kmPhy.marked;

      var mxCur = bridged["mx_lab_cur"] !== undefined ? parseInt(bridged["mx_lab_cur"], 10) + 1 : null;
      if (isNaN(mxCur)) mxCur = null;

      var circuitsLearned = data.circuits_learned || {};
      var circuitsDone = Object.keys(circuitsLearned).filter(function (k) { return !!circuitsLearned[k]; }).length;

      var hsTasks = data.hs_elec_tasks || {};
      var hsDone = ["close", "open", "ohm", "flip"].filter(function (k) { return !!hsTasks[k]; }).length;

      var chemTasks = data.chem_neut_tasks || {};
      var chemDone = Object.keys(chemTasks).filter(function (k) { return !!chemTasks[k]; }).length;

      var bioTasks = data.bio_micro_tasks || {};
      var bioDone = Object.keys(bioTasks).filter(function (k) { return !!bioTasks[k]; }).length;

      var mpointTasks = data.math_mpoint_tasks || {};
      var mpointDone = ["rect", "pq", "time"].filter(function (k) { return !!mpointTasks[k]; }).length;

      var quadTasks = data.math_quad_tasks || {};
      var quadDone = ["vertex", "interval", "abc"].filter(function (k) { return !!quadTasks[k]; }).length;

      var solubTasks = data.chem_solub_tasks || {};
      var solubDone = ["cool", "compare", "nacl"].filter(function (k) { return !!solubTasks[k]; }).length;

      var soluteTasks = data.chem_solute_tasks || {};
      var soluteDone = ["curve", "spoil"].filter(function (k) { return !!soluteTasks[k]; }).length;

      return {
        username: bucket.username,
        cloud: cloudState.enabled && Boolean(getSessionToken()),
        kmMastered: kmMastered,
        kmMarked: kmMarked,
        maps: { physics: kmPhy, chemistry: kmChem, math: kmMath, biology: kmBio },
        mxCur: mxCur,
        circuitsDone: circuitsDone,
        circuitsTotal: 21,
        hsDone: hsDone,
        hsTotal: 4,
        chemDone: chemDone,
        chemTotal: 3,
        bioDone: bioDone,
        bioTotal: 4,
        mpointDone: mpointDone,
        mpointTotal: 3,
        quadDone: quadDone,
        quadTotal: 3,
        solubDone: solubDone,
        solubTotal: 3,
        soluteDone: soluteDone,
        soluteTotal: 2,
        updatedAt: data.updatedAt || null
      };
    },

    exportBackup: function () {
      var bucket = getActiveBucket();
      snapshotBridgedFromStorage(bucket);
      return JSON.stringify({
        app: "abs-lab",
        version: 1,
        username: bucket.username || "guest",
        exportedAt: new Date().toISOString(),
        data: bucket.data
      }, null, 2);
    },

    importBackup: function (jsonText) {
      try {
        var parsed = JSON.parse(jsonText);
        if (!parsed || parsed.app !== "abs-lab" || !parsed.data) {
          return { ok: false, message: "文件格式不正确，请选择 ABS-LAB 导出的备份文件。" };
        }
        var bucket = getActiveBucket();
        bucket.data = Object.assign(createEmptyData(), parsed.data);
        saveActiveBucket(bucket);
        hydrateBridgedToStorage(bucket.data);
        notifyChange();
        return { ok: true, message: "学习记录已恢复！" };
      } catch (e) {
        return { ok: false, message: "文件读取失败，请确认 JSON 格式完整。" };
      }
    },

    onChange: function (fn) {
      if (typeof fn === "function") listeners.push(fn);
    }
  };

  window.ABSLabAuth = api;
})();
