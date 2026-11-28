/**
 * TheHumanBox SUPER panel v5 — cloud sync + leaderboard + chronicle + the
 * live DevAgent console, styled with the game's own pixel theme.
 *
 * Injected into dist/index.html by the deploy workflow (before every other
 * script), so it can patch `window.Worker` before the app creates its
 * simulation worker and thereby capture the sim's private command channel:
 * {type:'command', json, requestId} / command_result.
 *
 * v5 changes (player feedback: "工作流会莫名其妙断掉，极其脆弱" / "功能和控制强度还是很差"):
 *   · ENGINE FRAME MIRROR (the deep-control core) — we now OBSERVE the sim
 *     worker's own world frames (envelope byte + msgpack, gunzipped with the
 *     browser's native DecompressionStream, decoded by a tiny built-in
 *     msgpack reader) and can demand a fresh FULL frame any time
 *     ({type:'full_frame'}). That yields REAL positions — every person's
 *     x/y, every tribe's centroid, every building — straight out of the
 *     engine, feeding four new tools: game_deep / game_scan / game_find /
 *     game_focus. The AI can finally aim commands precisely.
 *   · NEVER LOSE A TURN — a 20s heartbeat ping keeps the Pages-Function WS
 *     splice alive; when the connection still drops mid-turn, the worker
 *     keeps working and BROADCASTS to every live connection; on reconnect we
 *     receive a turn_live snapshot plus re-issued tool calls, which replay
 *     cached results by id (an interrupted nuke never fires twice).
 *   · OUTPUT HYGIENE — native <function=…> call syntax renders as ⚙ lines in
 *     the work log and is stripped from final bubbles (raw code never leaks
 *     into the answer again).
 *
 * v4 keeps: BYOK provider models (智谱/NaiveAI/Agnes), live world data
 * attached to every message, WebGL screenshot fix, chronicle for living
 * worlds, parallel tool_result protocol by id.
 *
 * Everything is dependency-free vanilla JS; the game build is untouched.
 */
(function () {
  "use strict";

  var DIRECT_API = "https://thehumanbox-api.yeyilin2010.workers.dev";
  var DIRECT_AGENT = "https://thehumanbox-agent.yeyilin2010.workers.dev";
  var DIRECT_WS = "wss://thehumanbox-agent.yeyilin2010.workers.dev/agents/dev-agent/main";
  var OWN_ID = "browser-own";
  var DB_NAME = "thb-own-world";
  var STORE = "worlds";
  var LS_CODE = "thb.cloudCode";
  var LS_CUSTOM = "thb.customModel";
  var LS_KEYS = "thb.providerKeys";
  var LS_PERMS = "thb.agentPerms";
  var LS_SYNC = "thb.cloudLastSync";
  var LS_MODEL = "thb.agentModel";
  var LS_LOG = "thb.agentLog";
  var LS_DIRECT = "thb.agentDirect";
  var LS_SIZE = "thb.panelSize";
  var LS_CMDS = "thb.cmdHistory";
  var LS_SPEED = "thb.gameSpeed";

  function directMode() {
    try { return localStorage.getItem(LS_DIRECT) === "1"; } catch (e) { return false; }
  }
  function apiBase() {
    return directMode() ? DIRECT_API : "/api";
  }
  function agentBase() {
    return directMode() ? DIRECT_AGENT : "/agent";
  }
  function wsUrl() {
    return directMode() ? DIRECT_WS : (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/agent/ws";
  }

  // ── Part A: capture the simulation worker (runs before the app) ────────

  var simWorkers = []; // newest last
  var nextReqId = 1000000000; // far above the app's own request ids
  var pendingReplies = new Map();

  function isSimWorker(url) {
    return /wasmworker|sim-core|thb-sim/i.test(String(url));
  }

  function patchWorker(instance, url) {
    try {
      var currentListener = null;
      var appHandler = null;
      Object.defineProperty(instance, "onmessage", {
        configurable: true,
        get: function () { return appHandler; },
        set: function (fn) {
          appHandler = fn;
          if (currentListener) instance.removeEventListener("message", currentListener);
          currentListener = null;
          if (typeof fn === "function") {
            var wrapped = function (ev) {
              try {
                var d = ev.data;
                if (d && typeof d === "object" && d.requestId >= 1000000000) {
                  var p = pendingReplies.get(d.requestId);
                  if (p) {
                    pendingReplies.delete(d.requestId);
                    clearTimeout(p.timer);
                    p.resolve(d);
                    return; // ours: the app never sees it
                  }
                }
                noteFrame(d); // v5: observe the engine's world frames, never consume
              } catch (e) { /* fall through to the app handler */ }
              fn(ev);
            };
            currentListener = wrapped;
            instance.addEventListener("message", wrapped);
          }
        },
      });
    } catch (e) { /* prehistoric browser; the panel still works minus deep control */ }
    simWorkers.push({ worker: instance, url: String(url) });
  }

  var RealWorker = window.Worker;
  if (RealWorker) {
    try {
      Object.defineProperty(window, "Worker", {
        configurable: true,
        writable: true,
        value: function Worker(url, options) {
          var instance = new RealWorker(url, options);
          var u = typeof url === "string" ? url : url && url.href ? url.href : "";
          patchWorker(instance, u);
          return instance;
        },
      });
      Object.defineProperty(window.Worker, "prototype", { value: RealWorker.prototype });
      window.Worker.prototype = RealWorker.prototype;
      if (RealWorker.name) {
        try { Object.defineProperty(window.Worker, "name", { value: "Worker" }); } catch (e) {}
      }
    } catch (e) {
      window.Worker = RealWorker;
    }
  }

  // ── keep WebGL drawing buffers readable (screenshot fix) ──────────────
  // The engine draws with webgl2 and does NOT set preserveDrawingBuffer, so
  // canvas.toDataURL/drawImage called between frames reads a cleared buffer
  // — the all-black screenshot. Forcing the flag at context creation makes
  // the buffer readable at any time (same trick as the game's own capture.ts
  // workaround, minus the frame race). We run before the app, so its canvas
  // gets the patched context.
  try {
    var realGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
        options = Object.assign({}, options, { preserveDrawingBuffer: true });
      }
      return realGetContext.call(this, type, options);
    };
  } catch (e) { /* ancient browser: capture falls back to the rAF race */ }

  function liveSimWorker() {
    for (var i = simWorkers.length - 1; i >= 0; i -= 1) {
      var w = simWorkers[i].worker;
      try { w.postMessage({ type: "ping_super" }); return w; }
      catch (e) { simWorkers.splice(i, 1); }
    }
    return null;
  }

  // ── v5: the engine frame mirror (deep control) ──────────────────────────
  // The sim worker streams its own world frames to the app — an envelope
  // byte (0 = plain, 1 = gzip) + msgpack. We OBSERVE those frames (never
  // consume them) and can demand a fresh FULL frame any time with
  // {type:'full_frame'}. That gives the agent REAL positions — every person,
  // every tribe's centroid, every building — straight out of the engine,
  // which is what makes game_deep / game_scan / game_find able to aim
  // commands precisely instead of guessing coordinates.

  var lastFrame = null; // {bytes:Uint8Array, at:number} — the freshest frame seen
  var deepCache = null; // {data, at} — decoded people/buildings/names + aggregates

  function noteFrame(d) {
    try {
      if (d && typeof d === "object" && d.type === "frame" && d.frame && d.frame.byteLength > 1) {
        lastFrame = { bytes: d.frame, at: Date.now() };
      }
    } catch (e) { /* observing must never break the app's frames */ }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** Strip the frame envelope; gunzip via the browser's native stream when
   *  needed (same layout as the app's own decodeBinaryFrame). */
  async function gunzipFrame(bytes) {
    if (!bytes || !bytes.length) return bytes;
    var b0 = bytes[0];
    if (b0 === 0) return bytes.subarray(1);
    if (b0 === 1 && typeof DecompressionStream === "function") {
      try {
        var stream = new Blob([bytes.subarray(1)]).stream().pipeThrough(new DecompressionStream("gzip"));
        var buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) { /* fall through */ }
    }
    return bytes;
  }

  /** Minimal MessagePack decoder — the frame's subset (nil/bool/all int
   *  widths/float32/64, str 8-32, bin, array 16/32, map 16/32, fix-family,
   *  ext returned as a stub). Enough for the engine's frames, zero deps. */
  function decodeMsgpack(bytes) {
    var pos = 0;
    var TD = new TextDecoder("utf-8");
    function u8() { return bytes[pos++]; }
    function u16() { var v = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; return v; }
    function u32() { var v = ((bytes[pos] * 256 + bytes[pos + 1]) * 256 + bytes[pos + 2]) * 256 + bytes[pos + 3]; pos += 4; return v; }
    function u64() { var hi = u32(), lo = u32(); return hi * 4294967296 + lo; }
    function i8v() { var v = u8(); return v > 127 ? v - 256 : v; }
    function i16v() { var v = u16(); return v > 32767 ? v - 65536 : v; }
    function i32v() { var v = u32(); return v > 2147483647 ? v - 4294967296 : v; }
    function readStr(n) { var s = TD.decode(bytes.subarray(pos, pos + n)); pos += n; return s; }
    function readBin(n) { var v = bytes.subarray(pos, pos + n); pos += n; return v; }
    function readExt(n) { pos += 1; var v = readBin(n); return { __ext: v.length }; }
    function value() {
      var c = u8();
      if (c <= 0x7f) return c;
      if (c >= 0xe0) return c - 256;
      if (c >= 0x80 && c <= 0x8f) { var o = {}; for (var i = 0; i < (c & 15); i += 1) { o[value()] = value(); } return o; }
      if (c >= 0x90 && c <= 0x9f) { var a = []; for (var j = 0; j < (c & 15); j += 1) { a.push(value()); } return a; }
      if (c >= 0xa0 && c <= 0xbf) return readStr(c & 31);
      switch (c) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xc4: return readBin(u8());
        case 0xc5: return readBin(u16());
        case 0xc6: return readBin(u32());
        case 0xc7: return readExt(u8());
        case 0xc8: return readExt(u16());
        case 0xc9: return readExt(u32());
        case 0xca: { var b1 = readBin(4); return new DataView(b1.buffer, b1.byteOffset, 4).getFloat32(0, false); }
        case 0xcb: { var b2 = readBin(8); return new DataView(b2.buffer, b2.byteOffset, 8).getFloat64(0, false); }
        case 0xcc: return u8();
        case 0xcd: return u16();
        case 0xce: return u32();
        case 0xcf: return u64();
        case 0xd0: return i8v();
        case 0xd1: return i16v();
        case 0xd2: return i32v();
        case 0xd3: return u64();
        case 0xd4: return readExt(1);
        case 0xd5: return readExt(2);
        case 0xd6: return readExt(4);
        case 0xd7: return readExt(8);
        case 0xd8: return readExt(16);
        case 0xd9: return readStr(u8());
        case 0xda: return readStr(u16());
        case 0xdb: return readStr(u32());
        case 0xdc: { var n1 = u16(), a1 = []; for (var k1 = 0; k1 < n1; k1 += 1) { a1.push(value()); } return a1; }
        case 0xdd: { var n2 = u32(), a2 = []; for (var k2 = 0; k2 < n2; k2 += 1) { a2.push(value()); } return a2; }
        case 0xde: { var n3 = u16(), o3 = {}; for (var k3 = 0; k3 < n3; k3 += 1) { o3[value()] = value(); } return o3; }
        case 0xdf: { var n4 = u32(), o4 = {}; for (var k4 = 0; k4 < n4; k4 += 1) { o4[value()] = value(); } return o4; }
        default: throw new Error("msgpack 0x" + c.toString(16) + " @ " + (pos - 1));
      }
    }
    return value();
  }

  /** Decode a frame once, memoized per bytes object. */
  var frameDecodeMemo = { frame: null, obj: null };
  async function decodeFrame(frame) {
    if (frameDecodeMemo.frame === frame) return frameDecodeMemo.obj;
    var obj = null;
    try { obj = decodeMsgpack(await gunzipFrame(frame.bytes)); } catch (e) { obj = null; }
    frameDecodeMemo = { frame: frame, obj: obj };
    return obj;
  }

  /** The engine-deep world: demands a fresh FULL frame, decodes it, and
   *  aggregates every tribe (with centroid!), building kind and animal. */
  async function deepWorld() {
    var worker = liveSimWorker();
    if (!worker) throw new Error("模拟引擎未运行（先打开一个世界）");
    if (deepCache && Date.now() - deepCache.at < 2500) return deepCache;
    var t0 = Date.now();
    try { worker.postMessage({ type: "full_frame" }); } catch (e) {}
    var obj = null;
    var deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      await sleep(120);
      if (lastFrame && lastFrame.at >= t0) {
        obj = await decodeFrame(lastFrame);
        if (obj && obj.frame_kind === "full") break;
      }
    }
    if (!obj && lastFrame) obj = await decodeFrame(lastFrame);
    if (!obj || typeof obj !== "object") throw new Error("引擎帧解码失败（世界在运行吗？）");
    var names = obj.lineage_names || {};
    var orgs = Array.isArray(obj.organisms) ? obj.organisms : [];
    var people = [];
    var tribes = {};
    for (var i = 0; i < orgs.length; i += 1) {
      var o = orgs[i];
      if (!o || o.alive === false) continue;
      var lid = String(o.lineage_id || "");
      var t = tribes[lid];
      if (!t) t = tribes[lid] = { id: lid, name: names[lid] || lid, count: 0, sx: 0, sy: 0, hp: 0, en: 0 };
      t.count += 1;
      t.sx += Number(o.x) || 0;
      t.sy += Number(o.y) || 0;
      t.hp += Number(o.health) || 0;
      t.en += Number(o.energy) || 0;
      people.push({ id: String(o.id || ""), x: Math.round(Number(o.x) || 0), y: Math.round(Number(o.y) || 0), lid: lid });
    }
    var tribeRows = [];
    for (var key in tribes) {
      var tt = tribes[key];
      tribeRows.push({
        id: tt.id, name: tt.name, count: tt.count,
        cx: Math.round(tt.sx / tt.count), cy: Math.round(tt.sy / tt.count),
        avg_health: Math.round((tt.hp / tt.count) * 10) / 10,
        avg_energy: Math.round((tt.en / tt.count) * 10) / 10,
      });
    }
    tribeRows.sort(function (a, b) { return b.count - a.count; });
    var buildings = Array.isArray(obj.buildings) ? obj.buildings : [];
    var bKinds = {};
    var bList = [];
    for (var b = 0; b < buildings.length; b += 1) {
      var bb = buildings[b];
      if (!bb || bb.ruined) continue;
      var kd = bKinds[bb.kind || "?"];
      if (!kd) kd = bKinds[bb.kind || "?"] = { kind: bb.kind || "?", count: 0, cx: 0, cy: 0, decorative: !!bb.decorative };
      kd.count += 1;
      kd.cx += Number(bb.x) || 0;
      kd.cy += Number(bb.y) || 0;
      bList.push({ kind: bb.kind || "?", x: Number(bb.x) || 0, y: Number(bb.y) || 0 });
    }
    var buildingRows = [];
    for (var k2 in bKinds) {
      var k3 = bKinds[k2];
      buildingRows.push({ kind: k3.kind, count: k3.count, cx: Math.round(k3.cx / k3.count), cy: Math.round(k3.cy / k3.count), decorative: k3.decorative });
    }
    buildingRows.sort(function (a, b) { return b.count - a.count; });
    var data = {
      at: Date.now(),
      full: obj.frame_kind === "full",
      population: people.length,
      tribes: tribeRows,
      people: people,
      buildings: bList,
      building_kinds: buildingRows,
      animals: Array.isArray(obj.animals) ? obj.animals.length : null,
    };
    deepCache = data;
    return data;
  }

  /** Model-facing aggregate (no person-level dumps). */
  async function gameDeep() {
    var d = await deepWorld();
    return {
      ok: true,
      source: d.full ? "engine full frame" : "engine frame (partial)",
      population: d.population,
      animals: d.animals,
      tribes: d.tribes.map(function (t) {
        return { name: t.name, count: t.count, cx: t.cx, cy: t.cy, avg_health: t.avg_health, avg_energy: t.avg_energy };
      }).slice(0, 16),
      building_kinds: d.building_kinds.slice(0, 18),
      note: "坐标即各部落质心 cx,cy — 命令直接瞄准这些坐标（x 0-800, y 0-400）",
    };
  }

  /** Who/what is around a point. */
  async function gameScan(x, y, radius) {
    var cx = Number(x), cy = Number(y);
    var r = Math.min(Math.max(Number(radius) || 12, 1), 250);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { error: "x/y 需为数字" };
    var d = await deepWorld();
    var rr = r * r;
    var inR = [];
    var byTribe = {};
    for (var i = 0; i < d.people.length; i += 1) {
      var p = d.people[i];
      var dx = p.x - cx, dy = p.y - cy;
      if (dx * dx + dy * dy <= rr) {
        inR.push(p);
        byTribe[p.lid] = (byTribe[p.lid] || 0) + 1;
      }
    }
    var names = {};
    d.tribes.forEach(function (t) { names[t.id] = t.name; });
    var tribeBits = Object.keys(byTribe).map(function (lid) {
      return { name: names[lid] || lid, count: byTribe[lid] };
    }).sort(function (a, b) { return b.count - a.count; });
    var buildings = [];
    for (var b = 0; b < d.buildings.length; b += 1) {
      var bb = d.buildings[b];
      var bx = bb.x - cx, by = bb.y - cy;
      if (bx * bx + by * by <= rr) buildings.push(bb.kind);
    }
    var bCount = {};
    buildings.forEach(function (k) { bCount[k] = (bCount[k] || 0) + 1; });
    var nearest = inR.slice(0, 8).map(function (p) { return { id: p.id, x: p.x, y: p.y, tribe: names[p.lid] || p.lid }; });
    return {
      ok: true, x: Math.round(cx), y: Math.round(cy), radius: r,
      people_in_radius: inR.length,
      by_tribe: tribeBits.slice(0, 10),
      buildings_in_radius: Object.keys(bCount).map(function (k) { return { kind: k, count: bCount[k] }; }).slice(0, 10),
      nearest_people: nearest,
    };
  }

  /** Locate tribes / people / buildings by name (substring ok). */
  async function gameFind(kind, name) {
    var d = await deepWorld();
    var want = String(name || "").toLowerCase();
    if (kind === "tribe" || kind === "person" || kind === "building") {
      if (kind === "tribe") {
        var hits = d.tribes.filter(function (t) {
          return !want || String(t.name).toLowerCase().indexOf(want) !== -1 || String(t.id).toLowerCase().indexOf(want) !== -1;
        });
        return { ok: true, matches: hits.slice(0, 10).map(function (t) { return { name: t.name, count: t.count, cx: t.cx, cy: t.cy }; }), total: d.tribes.length };
      }
      if (kind === "person") {
        var ph = d.people.filter(function (p) { return !want || p.id.toLowerCase().indexOf(want) !== -1; }).slice(0, 10);
        var names = {};
        d.tribes.forEach(function (t) { names[t.id] = t.name; });
        return { ok: true, matches: ph.map(function (p) { return { id: p.id, x: p.x, y: p.y, tribe: names[p.lid] || p.lid }; }), total: d.people.length };
      }
      var bh = d.building_kinds.filter(function (k) { return !want || String(k.kind).toLowerCase().indexOf(want) !== -1; });
      return { ok: true, matches: bh.slice(0, 10), total: d.building_kinds.length };
    }
    // no kind — find everything matching the name
    var t2 = d.tribes.filter(function (t) { return want && String(t.name).toLowerCase().indexOf(want) !== -1; }).slice(0, 5);
    var b2 = d.building_kinds.filter(function (k) { return want && String(k.kind).toLowerCase().indexOf(want) !== -1; }).slice(0, 5);
    return { ok: true, tribes: t2, building_kinds: b2, hint: "kind=tribe|person|building" };
  }

  /** Swing the game's own camera onto a named tribe (clicks its row in the
   *  World panel — the game focuses the lineage itself). */
  function focusTribe(name) {
    var want = String(name || "").toLowerCase();
    if (!want) return { error: "name is required" };
    var rows = document.querySelectorAll(".wp-tribe-list .wp-tribe");
    for (var i = 0; i < rows.length; i += 1) {
      var nm = rows[i].querySelector(".wp-tribe-name");
      if (nm && String(nm.textContent || "").toLowerCase().indexOf(want) !== -1) {
        try { rows[i].click(); } catch (e) {}
        return { ok: true, focused: String(nm.textContent || "").trim(), note: "镜头已对准该部落" };
      }
    }
    return { ok: false, error: "部族列表里没有匹配「" + name + "」的部落" };
  }


  function workerRequest(payload, timeoutMs) {
    var worker = liveSimWorker();
    if (!worker) return Promise.reject(new Error("模拟 Worker 不可用（世界在运行吗？）"));
    return new Promise(function (resolve, reject) {
      var requestId = nextReqId++;
      var timer = setTimeout(function () {
        pendingReplies.delete(requestId);
        reject(new Error("模拟请求超时"));
      }, timeoutMs || 8000);
      pendingReplies.set(requestId, { resolve: resolve, timer: timer });
      try {
        worker.postMessage(Object.assign({ requestId: requestId }, payload));
      } catch (e) {
        clearTimeout(timer);
        pendingReplies.delete(requestId);
        reject(e);
      }
    });
  }

  // ── IndexedDB save access (same layout as the game's wasmDb.ts) ────────

  function openWorldDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    });
  }

  function idbOp(mode, run) {
    return openWorldDb().then(
      (db) =>
        new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, mode);
          var req;
          try { req = run(tx.objectStore(STORE)); }
          catch (e) { tx.abort(); reject(e); return; }
          tx.oncomplete = () => resolve(req ? req.result : null);
          tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
          tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
        }),
    );
  }

  function readOwnWorld() { return idbOp("readonly", (s) => s.get(OWN_ID)); }
  function writeOwnWorld(record) { return idbOp("readwrite", (s) => s.put(record, OWN_ID)); }

  function requestCheckpoint() {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      var timer = setTimeout(() => finish(false), 8000);
      var ev = new CustomEvent("thb:local-world-checkpoint", { cancelable: true, detail: { resolve: finish } });
      if (window.dispatchEvent(ev)) finish(false); // nobody is listening
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  function b64FromBytes(bytes) {
    var bin = "";
    var chunk = 32768;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function bytesFromB64(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return "?";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
    return (n / 1048576).toFixed(2) + " MiB";
  }

  function fmtTime(iso) {
    try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso); }
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // ── the sandbox command registry (UI copy; matches the game's Rust source) ──

  // [name, argsig, desc] — argsig lists fields in fill order.
  var CMDS = [
    ["spawn", "x,y,count?,lineage?", "生成人类"],
    ["family", "x,y", "组建家庭"],
    ["teleport", "x,y,radius", "传送人群"],
    ["make_leader", "x,y,radius", "任命领袖"],
    ["place_building", "x,y,kind", "放置建筑"],
    ["place_boat", "x,y", "放置船"],
    ["heal_one", "x,y,radius", "治愈一人"],
    ["gift", "x,y,radius,what", "送礼 food|tool"],
    ["set_time_of_day", "phase", "时间 dawn|noon|dusk|midnight"],
    ["hail", "x,y,radius", "冰雹"],
    ["nuke", "x,y,radius", "核弹"],
    ["eclipse", "", "日食"],
    ["rain_patch", "x,y,radius", "局部降雨"],
    ["cure_tribe", "x,y", "治愈部落"],
    ["guardian", "x,y", "召唤守护者"],
    ["aurora", "", "极光"],
    ["heat_wave", "", "热浪"],
    ["freeze", "x,y,radius", "冻结"],
    ["bless_river", "x,y,radius", "祝福河流"],
    ["bless_forest", "x,y,radius", "祝福森林"],
    ["talent", "x,y,radius", "赐天赋"],
    ["shape_land", "x,y,radius,by", "塑造地形 by=±"],
    ["bless_soil", "x,y,radius", "祝福土壤"],
    ["spring", "x,y", "造泉眼"],
    ["bountiful_hunt", "x,y,radius", "丰饶狩猎"],
    ["era_tribe", "x,y,era", "部落跃迁时代"],
    ["set_world_mods", "mods", "世界修正(高级)"],
    ["tribe_gift", "x,y,radius,what", "部落送礼"],
    ["migrate_tribe", "x,y,radius", "部落迁徙"],
    ["trade_gift", "ax,ay,bx,by", "建立贸易"],
    ["clear_region", "x,y,radius", "清空区域"],
    ["mutate", "x,y,radius", "变异"],
    ["merge_tribes", "ax,ay,bx,by", "合并部落"],
    ["split_tribe", "x,y,radius", "分裂部落"],
    ["teach_nearby", "x,y,radius", "教导"],
    ["curse", "x,y,radius", "诅咒"],
    ["comet", "x,y,radius", "彗星"],
    ["smite", "x,y,radius", "天罚"],
    ["heal", "x,y,radius", "群体治愈"],
    ["paint", "x,y,tile,radius", "画地块"],
    ["ignite", "x,y,radius", "点燃"],
    ["weather", "kind", "天气"],
    ["drought", "active", "干旱开关"],
    ["sinkhole", "x,y,radius", "天坑"],
    ["black_hole", "x,y,radius", "黑洞"],
    ["acid_rain", "x,y,radius", "酸雨"],
    ["spawn_animal", "x,y,kind,count,radius", "生成动物"],
    ["poison", "x,y,radius", "毒雾"],
    ["bless", "x,y,radius", "祝福"],
    ["long_life", "x,y,radius", "赐长寿"],
    ["courage", "x,y,radius", "赐勇气"],
    ["sunshine", "x,y,radius", "阳光"],
    ["inspire", "x,y,radius", "赐灵感"],
    ["earthquake", "x,y,radius", "地震"],
    ["war", "x,y", "宣战"],
    ["peace", "x,y", "和平"],
    ["meteor", "x,y,radius", "陨石"],
    ["harvest", "x,y,radius", "丰收"],
    ["cure", "x,y,radius", "治疗"],
    ["arm", "x,y,radius", "武装"],
    ["bounty", "x,y,radius", "赏金"],
    ["douse", "x,y,radius", "灭火"],
    ["ward", "x,y,radius", "结界"],
    ["teach", "lineage", "教导部落"],
    ["revive", "x,y", "复活"],
    ["banish", "x,y,radius", "放逐"],
    ["blight", "x,y,radius", "枯萎病"],
    ["frenzy", "x,y,radius", "狂乱"],
    ["flood", "x,y,radius", "洪水"],
    ["blizzard", "x,y,radius", "暴风雪"],
    ["thunder", "x,y,radius", "雷暴"],
    ["plant", "x,y,kind,radius", "种植"],
    ["rename_tribe", "lineage,name", "部落改名"],
    ["paint_biome", "x,y,biome,radius", "改生态"],
    ["volcano", "x,y,radius", "火山"],
    ["meteor_shower", "x,y,radius", "陨石雨"],
    ["love", "x,y,radius", "爱之祝福"],
    ["marry", "ax,ay,bx,by", "撮合婚姻"],
    ["rename_person", "id,name", "人物改名"],
    ["follow", "id", "跟随"],
    ["tame", "x,y,radius", "驯服"],
    ["road", "x,y,radius,kind", "修路 road|bridge|erase"],
    ["demolish", "x,y,radius", "拆除"],
    ["repair", "x,y,radius", "修复"],
    ["restore", "x,y,radius", "复原"],
    ["gale", "", "大风"],
    ["tornado", "x,y,radius", "龙卷风"],
    ["tsunami", "x,y,radius", "海啸"],
    ["locusts", "x,y,radius", "蝗灾"],
    ["wildfire", "x,y,radius", "野火"],
    ["guide", "lineage,strategy,duration_ticks", "指引部落"],
    ["composite", "steps", "批量编排 ≤8 步"],
    ["set_difficulty", "level", "难度 calm|normal|harsh"],
    ["outbreak", "count,x?,y?,radius", "疫情"],
  ];
  var CMD_MAP = {};
  CMDS.forEach(function (c) { CMD_MAP[c[0]] = { args: c[1], desc: c[2] }; });

  var CMD_ALIASES = {
    time_of_day: "set_time_of_day", set_strategy: "guide",
    // 中文别名 → 命令（部分带固定参数）
    核弹: "nuke", 原子弹: "nuke", 陨石: "meteor", 陨石雨: "meteor_shower", 彗星: "comet",
    火山: "volcano", 地震: "earthquake", 海啸: "tsunami", 龙卷风: "tornado", 飓风: "tornado",
    黑洞: "black_hole", 天坑: "sinkhole", 酸雨: "acid_rain", 雷击: "thunder", 闪电: "thunder", 雷: "thunder",
    暴风雪: "blizzard", 洪水: "flood", 野火: "wildfire", 火灾: "ignite", 点火: "ignite", 着火: "ignite",
    蝗虫: "locusts", 蝗灾: "locusts", 毒: "poison", 毒雾: "poison", 瘟疫: "outbreak", 疫情: "outbreak",
    干旱: "drought", 热浪: "heat_wave", 大风: "gale", 狂风: "gale", 日食: "eclipse", 极光: "aurora",
    冻结: "freeze", 冰冻: "freeze", 治愈: "heal", 治疗: "cure", 复活: "revive", 祝福: "bless", 诅咒: "curse",
    天赋: "talent", 勇气: "courage", 长寿: "long_life", 灵感: "inspire", 智慧: "inspire", 阳光: "sunshine",
    爱: "love", 丰收: "harvest", 守护: "guardian", 战争: "war", 开战: "war", 和平: "peace",
    合并: "merge_tribes", 分裂: "split_tribe", 迁徙: "migrate_tribe", 结婚: "marry", 婚礼: "marry",
    变异: "mutate", 放逐: "banish", 武装: "arm", 天罚: "smite", 教导: "teach_nearby", 驯服: "tame",
    跟随: "follow", 领袖: "make_leader", 拆除: "demolish", 修复: "repair", 恢复: "restore",
    清除: "clear_region", 灭火: "douse", 结界: "ward", 地形: "shape_land", 传送: "teleport",
    生成: "spawn", 人类: "spawn", 人口: "spawn", 动物: "spawn_animal", 船: "place_boat",
    时代: "era_tribe", 难度: "set_difficulty", 路: "road", 桥: "road",
  };
  // 别名 → 固定参数（天气/时间这类无坐标命令）
  var FIXED_ARGS = {
    下雨: { cmd: "weather", kind: "rain" }, 降雨: { cmd: "weather", kind: "rain" }, 雨: { cmd: "weather", kind: "rain" },
    下雪: { cmd: "weather", kind: "snow" }, 降雪: { cmd: "weather", kind: "snow" }, 雪: { cmd: "weather", kind: "snow" },
    放晴: { cmd: "weather", kind: "clear" }, 天晴: { cmd: "weather", kind: "clear" }, 晴: { cmd: "weather", kind: "clear" },
    雾: { cmd: "weather", kind: "fog" }, 起雾: { cmd: "weather", kind: "fog" },
    暴风雨: { cmd: "weather", kind: "storm" }, 风暴: { cmd: "weather", kind: "storm" },
    季风: { cmd: "weather", kind: "monsoon" }, 寒潮: { cmd: "weather", kind: "cold_snap" },
    白天: { cmd: "set_time_of_day", phase: "noon" }, 正午: { cmd: "set_time_of_day", phase: "noon" }, 中午: { cmd: "set_time_of_day", phase: "noon" },
    黎明: { cmd: "set_time_of_day", phase: "dawn" }, 清晨: { cmd: "set_time_of_day", phase: "dawn" },
    黄昏: { cmd: "set_time_of_day", phase: "dusk" }, 傍晚: { cmd: "set_time_of_day", phase: "dusk" },
    夜晚: { cmd: "set_time_of_day", phase: "midnight" }, 午夜: { cmd: "set_time_of_day", phase: "midnight" }, 夜: { cmd: "set_time_of_day", phase: "midnight" },
    树: { cmd: "plant", kind: "sapling" }, 种树: { cmd: "plant", kind: "sapling" }, 森林: { cmd: "paint_biome", biome: "forest" },
    花: { cmd: "plant", kind: "flower" }, 种花: { cmd: "plant", kind: "flower" },
    庄稼: { cmd: "plant", kind: "crop" }, 农田: { cmd: "plant", kind: "crop" },
    果园: { cmd: "plant", kind: "orchard" }, 蘑菇: { cmd: "plant", kind: "mushroom" },
    橡树: { cmd: "plant", kind: "oak" }, 松树: { cmd: "plant", kind: "pine" }, 棕榈: { cmd: "plant", kind: "palm" }, 浆果: { cmd: "plant", kind: "berry" },
    房子: { cmd: "place_building", kind: "house" }, 建筑: { cmd: "place_building", kind: "house" },
    小屋: { cmd: "place_building", kind: "hut" }, 神庙: { cmd: "place_building", kind: "temple" }, 寺庙: { cmd: "place_building", kind: "temple" },
    市场: { cmd: "place_building", kind: "market" }, 城堡: { cmd: "place_building", kind: "castle" },
    学校: { cmd: "place_building", kind: "school" }, 图书馆: { cmd: "place_building", kind: "library" },
    医院: { cmd: "place_building", kind: "hospital" }, 工厂: { cmd: "place_building", kind: "factory" },
    纪念碑: { cmd: "place_building", kind: "monument" }, 方尖碑: { cmd: "place_building", kind: "obelisk" },
    喷泉: { cmd: "place_building", kind: "fountain" }, 灯塔: { cmd: "place_building", kind: "lighthouse" },
    火车站: { cmd: "place_building", kind: "train_station" }, 摩天楼: { cmd: "place_building", kind: "skyscraper" },
    金字塔: { cmd: "place_building", kind: "pyramid" }, 竞技场: { cmd: "place_building", kind: "coliseum" },
    宝塔: { cmd: "place_building", kind: "pagoda" }, 大教堂: { cmd: "place_building", kind: "cathedral" },
    风: { cmd: "place_building", kind: "windmill" }, 水车: { cmd: "place_building", kind: "watermill" },
    狼: { cmd: "spawn_animal", kind: "wolf" }, 狼群: { cmd: "spawn_animal", kind: "wolf" },
    熊: { cmd: "spawn_animal", kind: "bear" }, 鹿: { cmd: "spawn_animal", kind: "deer" },
    兔子: { cmd: "spawn_animal", kind: "rabbit" }, 鱼: { cmd: "spawn_animal", kind: "fish" },
    马: { cmd: "spawn_animal", kind: "horse" }, 牛: { cmd: "spawn_animal", kind: "cow" },
    羊: { cmd: "spawn_animal", kind: "sheep" }, 鸡: { cmd: "spawn_animal", kind: "chicken" },
    鲸: { cmd: "spawn_animal", kind: "whale" }, 鲸鱼: { cmd: "spawn_animal", kind: "whale" },
    狮子: { cmd: "spawn_animal", kind: "lion" }, 大象: { cmd: "spawn_animal", kind: "elephant" },
    老鹰: { cmd: "spawn_animal", kind: "eagle" }, 蛇: { cmd: "spawn_animal", kind: "snake" },
    水: { cmd: "paint", tile: "water" }, 岩浆: { cmd: "paint", tile: "lava" }, 冰: { cmd: "paint", tile: "ice" },
    沙漠: { cmd: "paint_biome", biome: "desert" }, 雪原: { cmd: "paint_biome", biome: "tundra" },
    丛林: { cmd: "paint_biome", biome: "jungle" }, 草原: { cmd: "paint_biome", biome: "grassland" },
    沼泽: { cmd: "paint_biome", biome: "wetland" }, 稀树草原: { cmd: "paint_biome", biome: "savanna" },
    泰加林: { cmd: "paint_biome", biome: "taiga" }, 荒地: { cmd: "paint_biome", biome: "badlands" },
    食物: { cmd: "gift", what: "food" }, 工具: { cmd: "gift", what: "tool" },
  };

  /**
   * Parse a direct-bar input like `nuke 400 200 18`, `核弹`, `spawn 5 300 150`,
   * `weather rain`, `heal 400 200 radius=12`, `era_tribe 400 200 industrial`
   * into a sandbox command object. Returns {obj} or {error}.
   */
  function parseDirect(input) {
    var tokens = String(input || "").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { error: "空命令" };
    var head = tokens[0].toLowerCase();
    var rest = tokens.slice(1);
    var obj;
    if (FIXED_ARGS[head]) {
      obj = Object.assign({}, FIXED_ARGS[head]);
    } else {
      var name = CMD_ALIASES[head] || head;
      if (!CMD_MAP[name]) {
        // maybe the user typed a Chinese alias that needs coords → suggest
        return { error: '未知命令 "' + tokens[0] + '" — 输入命令名查看补全（如 nuke、火山、weather）' };
      }
      obj = { cmd: name };
    }
    var spec = CMD_MAP[obj.cmd];
    var argsig = spec ? spec.args : "";
    var needsXY = /(^|,)x,/.test(argsig) || argsig.startsWith("x,");
    var needsAB = /ax,ay/.test(argsig);
    var numbers = [];
    var strings = [];
    var kv = {};
    rest.forEach(function (t) {
      var m = /^([\w-]+)=([^=]+)$/.exec(t);
      if (m) { kv[m[1].toLowerCase()] = m[2]; return; }
      if (/^-?\d+(\.\d+)?$/.test(t)) numbers.push(parseFloat(t));
      else strings.push(t);
    });
    var ni = 0;
    function num(dflt) { return ni < numbers.length ? numbers[ni++] : dflt; }
    var DEFAULT_R = 8;
    if (needsAB) {
      obj.ax = kv.ax != null ? +kv.ax : num(400);
      obj.ay = kv.ay != null ? +kv.ay : num(200);
      obj.bx = kv.bx != null ? +kv.bx : num(430);
      obj.by = kv.by != null ? +kv.by : num(220);
    } else if (needsXY) {
      obj.x = kv.x != null ? +kv.x : num(400);
      obj.y = kv.y != null ? +kv.y : num(200);
    }
    if (/count\??,radius|,count,radius/.test("," + argsig)) { // spawn_animal
      if (obj.count == null) obj.count = kv.count != null ? +kv.count : num(3);
      if (obj.radius == null) obj.radius = kv.radius != null ? +kv.radius : num(DEFAULT_R);
    } else {
      if (/radius/.test(argsig) && obj.radius == null) obj.radius = kv.radius != null ? +kv.radius : (ni < numbers.length ? num(DEFAULT_R) : DEFAULT_R);
      if (/count/.test(argsig) && obj.count == null) obj.count = kv.count != null ? +kv.count : (ni < numbers.length ? num(1) : 1);
    }
    if (/by\b/.test(argsig) && obj.by == null) obj.by = kv.by != null ? +kv.by : num(3);
    var strFields = ["kind", "what", "era", "phase", "biome", "tile", "level", "strategy", "lineage", "name", "id", "active", "mods", "steps"];
    for (var i = 0; i < strFields.length; i += 1) {
      var f = strFields[i];
      if (obj[f] == null && (new RegExp("(^|,)" + f + "\\??(,|$)")).test(argsig)) {
        if (kv[f] != null) obj[f] = kv[f];
        else if (strings.length) obj[f] = strings.shift();
      }
    }
    if (/active/.test(argsig) && obj.active == null) obj.active = true;
    if (/duration_ticks/.test(argsig) && obj.duration_ticks == null) obj.duration_ticks = kv.duration_ticks != null ? +kv.duration_ticks : 3600;
    if (obj.cmd === "outbreak" && obj.count == null) obj.count = 5;
    return { obj: obj };
  }

  // ── the bridge the agent drives (window.__THB__) ────────────────────────

  function perms() {
    try { return JSON.parse(localStorage.getItem(LS_PERMS)) || {}; } catch (e) { return {}; }
  }

  function domHeadline() {
    var header = document.querySelector("header");
    return String((header && (header.innerText || header.textContent)) || "").replace(/\s+/g, " ").trim();
  }

  function eventLogLines(limit) {
    var log = document.querySelector(".event-log,[role=log]");
    if (!log || !log.children || !log.children.length) {
      var t = String(log && (log.innerText || log.textContent) || "").trim();
      return t ? t.split(/\n+/).slice(-limit) : [];
    }
    var out = [];
    for (var i = log.children.length - 1; i >= 0 && out.length < limit; i -= 1) {
      var line = String(log.children[i].innerText || log.children[i].textContent || "").replace(/\s+/g, " ").trim();
      if (line) out.unshift(line);
    }
    return out;
  }

  function domState() {
    var out = { url: location.href, title: document.title };
    var headline = domHeadline();
    if (headline) out.headline = headline.slice(0, 300);
    return out;
  }

  // ── deep engine data (v4): the game renders its live world into the DOM ─
  // (TribeList rows, the world feed, the header) — we read THAT instead of
  // asking the player to retype it. This is what auto-fills every chat
  // message, the chronicle and the leaderboard.
  var ERA_RE = /(pre-stone|stone|bronze|iron|classical|medieval|renaissance|industrial|modern|information|atomic|space|digital|quantum|solar|fusion|genetic|orbital|lunar|martian|cyber|neural|posthuman|interstellar|singularity|galactic|dyson|kardashev-?\d|stellar|nebular|universal|multiverse|transcendent|eldritch|voidborn|chronal|akashic|entropic|oneiric|mythic|demiurge|pantheon|omega|rebirth)/i;

  function readTribes() {
    var out = [];
    document.querySelectorAll(".wp-tribe-list .wp-tribe").forEach(function (row) {
      var name = row.querySelector(".wp-tribe-name");
      if (!name) return;
      var n = String(name.textContent || "").trim();
      if (!n) return;
      var countEl = row.querySelector(".wp-tribe-count");
      var c = parseInt(String(countEl && countEl.textContent || "").replace(/[^\d]/g, ""), 10);
      var moodEl = row.querySelector(".wp-mood");
      out.push({
        name: n,
        count: Number.isFinite(c) ? c : null,
        mood: moodEl ? String(moodEl.textContent || "").trim() : null,
      });
    });
    out.sort(function (a, b) { return (b.count || 0) - (a.count || 0); });
    return out;
  }

  /** All the live civilization data in one object (nulls when unknown). */
  async function readWorldData(opts) {
    opts = opts || {};
    var data = {
      headline: null, population: null, era: null, weather: null,
      season: null, dayPhase: null, when: null, year: null,
      tribes: readTribes(), events: eventLogLines(opts.events || 10), speed: lastSpeed(),
    };
    var headline = domHeadline();
    if (headline) {
      data.headline = headline.slice(0, 200);
      try {
        var pm = /(\d[\d,]*)\s*(?:people|人|humans)/i.exec(headline);
        if (pm) data.population = Number(pm[1].replace(/,/g, ""));
      } catch (e) {}
      try {
        var em = ERA_RE.exec(headline);
        if (em) data.era = em[1].toLowerCase();
      } catch (e) {}
      try {
        var wm = /\b(clear|rain|storm|snow|fog|monsoon|cold snap)\b|(晴朗|降雨|雨|雪|雾|风暴|季风|寒潮)/i.exec(headline);
        if (wm) data.weather = wm[1] || wm[2];
      } catch (e) {}
      try {
        var ym = /(\d+)\s*eras?/i.exec(headline);
        if (ym) data.epoch = Number(ym[1]);
      } catch (e) {}
    }
    // the World panel's "Y6 · 冬季 · 白天" line (falls back silently)
    try {
      var when = document.querySelector(".wp-now-when");
      if (when) {
        data.when = String(when.textContent || "").trim().slice(0, 48);
        var segs = data.when.split(/[·,，|/]+/).map(function (s) { return s.trim(); }).filter(Boolean);
        if (segs.length >= 2) {
          data.year = segs[0].slice(0, 12);
          data.season = segs[1].slice(0, 12);
        }
        if (segs.length >= 3) data.dayPhase = segs[2].slice(0, 12);
      }
    } catch (e) {}
    // "327 人 · 3 个部落" line as a population fallback
    if (data.population == null) {
      try {
        document.querySelectorAll(".wp-now-line").forEach(function (p) {
          if (data.population != null) return;
          var t = String(p.textContent || "");
          var m = /(\d[\d,]*)\s*(?:people|人|humans)/i.exec(t);
          if (m) data.population = Number(m[1].replace(/,/g, ""));
        });
      } catch (e) {}
    }
    try {
      var rec = await readOwnWorld();
      if (rec) { data.tick = rec.tick; data.seed = rec.seed; }
    } catch (e) {}
    return data;
  }

  function trackSpeed(action) {
    try { localStorage.setItem(LS_SPEED, String(action)); } catch (e) {}
  }
  function lastSpeed() {
    try { return localStorage.getItem(LS_SPEED) || "?"; } catch (e) { return "?"; }
  }

  /** Compact, fresh world snapshot riding along with every chat message. */
  async function worldSnapshot() {
    var data = await readWorldData({ events: 8 });
    var snap = {
      headline: data.headline,
      population: data.population,
      era: data.era,
      weather: data.weather,
      season: data.season,
      dayPhase: data.dayPhase,
      tick: data.tick != null ? data.tick : undefined,
      speed: data.speed,
      events: data.events,
      tribes: data.tribes.slice(0, 6).map(function (t) {
        return { name: t.name, count: t.count, mood: t.mood };
      }),
    };
    return snap;
  }

  async function gameState() {
    var data = await readWorldData({ events: 14 });
    var snap = {
      page: domState(),
      viewport: { w: innerWidth, h: innerHeight },
      headline: data.headline,
      population: data.population,
      era: data.era,
      weather: data.weather,
      season: data.season,
      dayPhase: data.dayPhase,
      when: data.when,
      speed: data.speed,
      events: data.events,
      tribes: data.tribes.slice(0, 10).map(function (t) {
        return { name: t.name, count: t.count, mood: t.mood };
      }),
      cloud_code_saved: !!localStorage.getItem(LS_CODE),
      last_cloud_sync: localStorage.getItem(LS_SYNC) || null,
    };
    try {
      var rec = await readOwnWorld();
      if (rec) {
        snap.save = {
          tick: rec.tick, seed: rec.seed,
          saved_at: rec.savedAt ? new Date(rec.savedAt).toISOString() : null,
          compressed_bytes: rec.blob ? rec.blob.byteLength : 0,
        };
      } else snap.save = null;
    } catch (e) { snap.save = { error: String(e) }; }
    return snap;
  }

  // ── screenshots (v4 fix: no more all-black captures) ─────────────────

  function biggestCanvas() {
    var best = null;
    var bestArea = 0;
    document.querySelectorAll("canvas").forEach(function (c) {
      var a = c.width * c.height;
      if (a > bestArea && c.width >= 100 && c.height >= 60) { best = c; bestArea = a; }
    });
    return best;
  }

  function grabCanvasImage(best) {
    var maxDim = 768;
    var scale = Math.min(1, maxDim / Math.max(best.width, best.height));
    var w = Math.max(1, Math.round(best.width * scale));
    var h = Math.max(1, Math.round(best.height * scale));
    var off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    var c2 = off.getContext("2d", { willReadFrequently: true });
    c2.drawImage(best, 0, 0, w, h);
    return { off: off, c2: c2, w: w, h: h };
  }

  /** Any non-black, non-transparent pixel means the capture has content. */
  function canvasIsBlank(shot) {
    try {
      var d = shot.c2.getImageData(0, 0, Math.min(shot.w, 24), Math.min(shot.h, 24)).data;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 8 && (d[i] > 12 || d[i + 1] > 12 || d[i + 2] > 12)) return false;
      }
      return true;
    } catch (e) {
      return false; // cannot tell (tainted?) — treat as non-blank, don't loop
    }
  }

  /** A downscaled JPEG of the biggest visible canvas — what a vision model "sees".
   *  The engine's render loop sleeps until pointer input and its WebGL buffer
   *  is only readable in the task that drew it, so: wake the loop with a
   *  pointermove, then read in the NEXT frame task (belt: we also patch
   *  getContext with preserveDrawingBuffer at load), and retry while blank. */
  async function captureScreenshot() {
    var best = biggestCanvas();
    if (!best) throw new Error("找不到游戏画布（世界尚未渲染？）");
    for (var attempt = 0; attempt < 3; attempt += 1) {
      try { best.dispatchEvent(new Event("pointermove")); } catch (e) {}
      var shot = await new Promise(function (resolve) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { resolve(grabCanvasImage(best)); });
        });
      });
      if (!canvasIsBlank(shot)) {
        var url = shot.off.toDataURL("image/jpeg", 0.62);
        if (url.length > 380000) url = shot.off.toDataURL("image/jpeg", 0.45);
        return { ok: true, image: url, w: shot.w, h: shot.h, source: best.width + "x" + best.height };
      }
    }
    throw new Error("截图全黑（引擎没有渲染新帧）— 在地图上滑动一下再试一次");
  }

  function orgQuery(kind, id) {
    if (!id) return Promise.resolve({ error: "id is required" });
    return workerRequest({ type: kind, id: String(id).slice(0, 64) }, 8000).then(function (d) {
      var out = { ok: true };
      try { out.detail = JSON.parse(d.json || "null"); }
      catch (e) { out.raw = String(d.json || "").slice(0, 2000) || null; }
      if (!out.detail && !out.raw) out.note = "no data for this id";
      return out;
    });
  }

  // Exact values the game's wasmSpeedConfig() picks for the 1/2/4/10 hotkeys
  // (base tick 120 ms, 16 ms floor — see src/simulation/runtimeControls.ts).
  var SPEED_PAYLOADS = {
    speed1: { type: "speed", tickMs: 120, stepsPerEmit: 1, speed: 1 },
    speed2: { type: "speed", tickMs: 60, stepsPerEmit: 1, speed: 2 },
    speed4: { type: "speed", tickMs: 30, stepsPerEmit: 1, speed: 4 },
    speed10: { type: "speed", tickMs: 24, stepsPerEmit: 2, speed: 10 },
  };

  async function gameControl(action) {
    var a = String(action);
    if (a === "checkpoint") return { ok: await requestCheckpoint() };
    if (a === "pause") { trackSpeed("paused"); return workerRequest({ type: "pause" }, 5000); }
    if (a === "resume") { trackSpeed("resumed"); return workerRequest({ type: "resume" }, 5000); }
    if (SPEED_PAYLOADS[a]) { trackSpeed(a.replace("speed", "×")); return workerRequest(SPEED_PAYLOADS[a], 5000); }
    if (a === "save") return workerRequest({ type: "save" }, 10000);
    throw new Error("unknown control action: " + a);
  }

  var GAME_KEYS = new Set(["1", "2", "3", "4", "0", "w", "a", "s", "d", "p", "b", "-", "+", "?", "W", "A", "S", "D"]);

  function pressKey(key) {
    var ev = new KeyboardEvent("keydown", { key: String(key), bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    var up = new KeyboardEvent("keyup", { key: String(key), bubbles: true, cancelable: true });
    window.dispatchEvent(up);
    return { ok: true, key: String(key) };
  }

  function clickSelector(selector, index) {
    var els = document.querySelectorAll(String(selector));
    var el = els[Number(index) || 0];
    if (!el) return { ok: false, error: "no element matches " + selector };
    el.click();
    return { ok: true };
  }

  function readSelector(selector) {
    var el = document.querySelector(String(selector));
    if (!el) return { ok: false, error: "no element matches " + selector };
    return { ok: true, text: String(el.innerText || el.textContent || "").slice(0, 1500) };
  }

  async function runToolOnPage(tool, args) {
    var p = perms();
    args = args || {};
    switch (tool) {
      case "game_state": return gameState();
      case "game_deep":
        try { return await gameDeep(); }
        catch (e) { return { error: String(e?.message ?? e) }; }
      case "game_scan":
        try { return await gameScan(args.x, args.y, args.radius); }
        catch (e) { return { error: String(e?.message ?? e) }; }
      case "game_find":
        try { return await gameFind(args.kind, args.name); }
        catch (e) { return { error: String(e?.message ?? e) }; }
      case "game_focus":
        return focusTribe(args.name);
      case "game_screenshot":
        try { return await captureScreenshot(); }
        catch (e) { return { error: String(e?.message ?? e) }; }
      case "game_command": {
        if (!p.game) return { error: "游戏操控已在 SUPER 面板中关闭（模式：观察者）" };
        var cmds = Array.isArray(args.command) ? args.command : args.command && typeof args.command === "object" ? [args.command] : null;
        if (!cmds) return { error: 'command 必须是对象或数组，如 {"cmd":"spawn","x":400,"y":200}' };
        var list = cmds.slice(0, 20);
        var results = await Promise.all(list.map((c) =>
          workerRequest({ type: "command", json: JSON.stringify(c), deadlineAt: Date.now() + 8000 }, 9000).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
        ));
        if (list.length === 1) return results[0];
        return { ok: results.every((r) => r && r.ok !== false), results: results.map((r) => r && r.outcome ? r.outcome : r) };
      }
      case "game_control":
        if (!p.game) return { error: "游戏操控已在 SUPER 面板中关闭（模式：观察者）" };
        return gameControl(args.action);
      case "game_key":
        if (!p.game) return { error: "游戏按键需要游戏操控权限" };
        if (!GAME_KEYS.has(String(args.key))) return { error: "仅允许游戏热键：1/2/3/4/0/WASD/p/b/-/+/?" };
        return pressKey(args.key);
      case "game_log":
        return { ok: true, lines: eventLogLines(Math.min(Number(args.limit) || 20, 60)) };
      case "org_detail":
      case "org_life":
        if (!p.game) return { error: "游戏操控已在 SUPER 面板中关闭（模式：观察者）" };
        return orgQuery(tool, args.id);
      case "cloud_save": return cloudUpload(true);
      case "page_key":
        if (!p.dom) return { error: "页面工具已在 SUPER 面板中关闭" };
        return pressKey(args.key);
      case "page_click":
        if (!p.dom) return { error: "页面工具已在 SUPER 面板中关闭" };
        return clickSelector(args.selector, args.index);
      case "page_read":
        if (!p.dom) return { error: "页面工具已在 SUPER 面板中关闭" };
        return readSelector(args.selector);
      case "page_eval":
        if (!p.eval) return { error: "page_eval 未开放（设置里打开开发者控制台）" };
        try {
          var result = eval(String(args.code));
          if (result && typeof result.then === "function") result = await result;
          return { ok: true, result: typeof result === "string" ? result.slice(0, 2000) : JSON.stringify(result)?.slice(0, 2000) ?? String(result) };
        } catch (e) { return { error: String(e) }; }
      default:
        return { error: "unknown page tool " + tool };
    }
  }

  window.__THB__ = {
    version: "5.0.0",
    runTool: runToolOnPage,
    state: gameState,
    snapshot: worldSnapshot,
    world: readWorldData,
    tribes: readTribes,
    control: gameControl,
    command: (cmd) => workerRequest({ type: "command", json: JSON.stringify(cmd), deadlineAt: Date.now() + 8000 }, 9000),
    parseDirect: parseDirect,
    checkpoint: requestCheckpoint,
    deep: deepWorld,
  };

  // ── Part B: cloud backend client ───────────────────────────────────────

  function apiFetch(path, opts) {
    return fetch(apiBase() + path, opts).then(async (r) => {
      var body = await r.json().catch(() => ({ raw: "non-JSON" }));
      if (!r.ok) throw new Error(body?.error || "HTTP " + r.status);
      return body;
    });
  }

  async function cloudUpload(fromAgent) {
    var code = localStorage.getItem(LS_CODE);
    if (!code && !fromAgent) throw new Error("先生成一个同步码");
    if (!code) {
      code = crypto.randomUUID().replace(/-/g, "");
      localStorage.setItem(LS_CODE, code);
    }
    var cp = await requestCheckpoint();
    var rec = await readOwnWorld();
    if (!rec) throw new Error("本地没有找到世界存档（先游玩并保存一次）");
    var payload = { v: 1, kind: "thb-own-world", blob_b64: b64FromBytes(rec.blob), seed: rec.seed, tick: rec.tick, savedAt: rec.savedAt };
    var out = await apiFetch("/v1/saves", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code, data: payload }),
    });
    localStorage.setItem(LS_SYNC, new Date().toISOString());
    return { ok: true, code: code, bytes: out.bytes, tick: rec.tick };
  }

  async function cloudDownload(code) {
    code = code || localStorage.getItem(LS_CODE);
    if (!code) throw new Error("没有同步码");
    var out = await apiFetch("/v1/saves/" + encodeURIComponent(code));
    var d = out.data;
    if (!d || d.kind !== "thb-own-world" || !d.blob_b64) throw new Error("云端存档格式不正确（可能来自旧版本）");
    var rec = { blob: bytesFromB64(d.blob_b64), seed: d.seed, tick: d.tick, savedAt: d.savedAt || Date.now() };
    try {
      var cur = await readOwnWorld();
      if (cur && cur.blob) await idbOp("readwrite", (s) => s.put(cur, "browser-own:recovery:" + Date.now() + ":before-cloud-restore"));
    } catch (e) { /* non-fatal */ }
    await writeOwnWorld(rec);
    return { ok: true, tick: d.tick, seed: d.seed };
  }

  // ── Part C: the UI panel ───────────────────────────────────────────────

  var FALLBACK_MODELS = [
    { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B fp8-fast", tier: "light", vision: false, speed: 3, note: "⚡⚡⚡ 实测 3s·默认" },
    { id: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B", tier: "flagship", vision: false, speed: 1, note: "⚡ 最强·慢" },
  ];
  // Client mirror of the worker's provider catalog (the live one arrives with
  // the welcome frame; this covers the first seconds + offline).
  var FALLBACK_PROVIDERS = [
    { id: "zhipu", label: "智谱 GLM", endpoint: "https://open.bigmodel.cn/api/paas/v4", key_hint: "bigmodel.cn 控制台 → API Keys（sk-…）", models: [
      { id: "glm-5.3", label: "GLM-5.3 旗舰", vision: false, note: "1M 上下文·最强" },
      { id: "glm-5.3-flash", label: "GLM-5.3-Flash", vision: true, note: "多模态·0.8元/M·推荐" },
      { id: "glm-5.3-flashx", label: "GLM-5.3-FlashX", vision: true, note: "200 tok/s·极快" },
      { id: "glm-5.2", label: "GLM-5.2", vision: false, note: "1M 上下文" },
      { id: "glm-5-turbo", label: "GLM-5-Turbo", vision: false, note: "" },
      { id: "glm-4.7", label: "GLM-4.7", vision: false, note: "" },
      { id: "glm-4.7-flash", label: "GLM-4.7-Flash", vision: false, note: "免费" },
      { id: "glm-4.7-flashx", label: "GLM-4.7-FlashX", vision: false, note: "0.5元/M·快" },
      { id: "glm-4.5-air", label: "GLM-4.5-Air", vision: false, note: "0.8元/M" },
      { id: "glm-4-long", label: "GLM-4-Long", vision: false, note: "1M 上下文" },
      { id: "glm-4-flash-250414", label: "GLM-4-Flash", vision: false, note: "免费" },
      { id: "glm-5v-turbo", label: "GLM-5V-Turbo", vision: true, note: "视觉" },
      { id: "glm-4.6v-flash", label: "GLM-4.6V-Flash", vision: true, note: "视觉·免费" },
      { id: "glm-4.6v-flashx", label: "GLM-4.6V-FlashX", vision: true, note: "视觉·0.15元/M" },
      { id: "glm-4.1v-thinking-flash", label: "GLM-4.1V-Thinking-Flash", vision: true, note: "视觉·免费·思考" },
      { id: "glm-4v-flash", label: "GLM-4V-Flash", vision: true, note: "视觉·免费" },
    ] },
    { id: "naive", label: "NaiveAI", endpoint: "https://api.naive.ai/v1", key_hint: "platform.naive.ai → API Key", models: [
      { id: "naive-n0.5-flash", label: "Naive N0.5 Flash", vision: false, note: "至高 ~2000 tok/s·思考" },
      { id: "naive-n0.5-lite", label: "Naive N0.5 Lite", vision: false, note: "同款·关思考·低延迟" },
    ] },
    { id: "agnes", label: "Agnes（国内）", endpoint: "https://api.agnes-ai.cn/v1", key_hint: "agnes-ai.cn 控制台 → API Key", models: [
      { id: "agnes-3.0-flash", label: "Agnes 3.0 Flash", vision: false, note: "Agent/代码·当前免费" },
      { id: "agnes-2.5-flash", label: "Agnes 2.5 Flash", vision: false, note: "512K 上下文·免费" },
      { id: "agnes-2.5-pro", label: "Agnes 2.5 Pro", vision: false, note: "1M 上下文·付费" },
      { id: "agnes-2.5-pro-beta", label: "Agnes 2.5 Pro Beta", vision: false, note: "付费·低价" },
    ] },
    { id: "agnes-intl", label: "Agnes（国际）", endpoint: "https://apihub.agnes-ai.com/v1", key_hint: "agnes-ai.com 控制台 → API Key", models: [
      { id: "agnes-3.0-flash", label: "Agnes 3.0 Flash", vision: false, note: "海外线路" },
      { id: "agnes-2.5-flash", label: "Agnes 2.5 Flash", vision: false, note: "海外线路" },
    ] },
  ];
  var TIER_LABELS = { light: "Workers AI · 快（免费）", flagship: "Workers AI · 旗舰", standard: "Workers AI · 标准", tiny: "Workers AI · 微型", vision: "Workers AI · 视觉" };
  var TIER_ORDER = ["light", "standard", "flagship", "tiny", "vision"];
  var agentCatalog = FALLBACK_MODELS;
  var agentProviders = FALLBACK_PROVIDERS;

  var ENDPOINT_PRESETS = [
    { label: "自定义…", baseUrl: "" },
    { label: "OpenAI", baseUrl: "https://api.openai.com/v1", hint: "gpt-4o / gpt-4o-mini …" },
    { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", hint: "glm-5.3 / glm-5.3-flash / glm-4.7-flash（免费）" },
    { label: "NaiveAI", baseUrl: "https://api.naive.ai/v1", hint: "naive-n0.5-flash / naive-n0.5-lite" },
    { label: "Agnes（国内）", baseUrl: "https://api.agnes-ai.cn/v1", hint: "agnes-3.0-flash（免费） / agnes-2.5-flash" },
    { label: "Agnes（国际）", baseUrl: "https://apihub.agnes-ai.com/v1", hint: "agnes-3.0-flash / agnes-2.5-flash" },
    { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", hint: "deepseek-chat / deepseek-reasoner" },
    { label: "Kimi 月之暗面", baseUrl: "https://api.moonshot.cn/v1", hint: "moonshot-v1-8k / kimi-latest" },
    { label: "通义 Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", hint: "qwen-plus / qwen-turbo" },
    { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", hint: "任意模型，如 anthropic/claude-3.5-sonnet" },
    { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", hint: "llama-3.3-70b-versatile（超快）" },
    { label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", hint: "Qwen/GLM/DeepSeek 系列低价" },
    { label: "CF AI Gateway", baseUrl: "https://gateway.ai.cloudflare.com/v1/<账户ID>/<网关名>/openai", hint: "你的 AI Gateway 地址" },
    { label: "Ollama（需公网隧道）", baseUrl: "http://127.0.0.1:11434/v1", hint: "本地模型需通过隧道暴露，Agent 在云端访问" },
  ];

  var CSS = [
    "#thb-super-btn{position:fixed;right:14px;bottom:14px;z-index:2147483646;width:44px;height:44px;",
    "border:2px solid var(--px-ink,#110c08);border-radius:0;clip-path:var(--px-notch,polygon(0 3px,3px 3px,3px 0,calc(100% - 3px) 0,calc(100% - 3px) 3px,100% 3px,100% calc(100% - 3px),calc(100% - 3px) calc(100% - 3px),calc(100% - 3px) 100%,3px 100%,3px calc(100% - 3px),0 calc(100% - 3px)));",
    "background:var(--px-raised,#45362a);box-shadow:var(--px-raised-shadow,inset 2px 2px 0 #6a5439,inset -2px -3px 0 #2a1f15);",
    "color:var(--px-gold,#e8b64c);font:700 19px/40px var(--dialog-font,ui-monospace,Menlo,monospace);text-shadow:0 2px 0 #000;cursor:pointer;}",
    "#thb-super-btn:hover{background:var(--px-raised-hover,#54422f);color:#fff3d6}",
    "#thb-super-btn:active{box-shadow:var(--px-pressed-shadow,inset 2px 3px 0 #2a1f15,inset -2px -2px 0 #6a5439)}",
    "#thb-super{position:fixed;right:14px;bottom:66px;z-index:2147483646;width:min(470px,calc(100vw - 20px));height:min(660px,82vh);min-width:320px;min-height:420px;",
    "display:none;flex-direction:column;resize:both;overflow:hidden;",
    "background:var(--px-wood,#2b2118);color:var(--px-text,#e7d8bc);border:2px solid var(--px-ink,#110c08);border-radius:0;",
    "box-shadow:var(--px-frame-shadow,inset 0 0 0 2px #8a6a3e,inset 0 0 0 4px rgba(0,0,0,.35),0 6px 0 rgba(0,0,0,.45),0 18px 48px rgba(0,0,0,.55));",
    "font:12.5px/1.55 var(--dialog-font,ui-monospace,Menlo,monospace);",
    "scrollbar-color:var(--px-brass,#8a6a3e) var(--px-inset,#1a130d);scrollbar-width:thin}",
    "#thb-super.open{display:flex}",
    "#thb-super .tabs{display:flex;gap:3px;padding:6px 6px 0;background:var(--px-grain,repeating-linear-gradient(0deg,#2b2118 0 22px,#231a13 22px 24px));border-bottom:2px solid var(--px-ink,#110c08);box-shadow:inset 0 -2px 0 var(--px-brass,#8a6a3e)}",
    "#thb-super .tab{flex:1;padding:7px 2px 6px;text-align:center;cursor:pointer;color:var(--px-text,#e7d8bc);font-weight:700;letter-spacing:.05em;",
    "border:2px solid var(--px-ink,#110c08);border-bottom:none;border-radius:0;background:var(--px-raised-lo,#2a1f15);",
    "clip-path:var(--px-notch,polygon(0 3px,3px 3px,3px 0,calc(100% - 3px) 0,calc(100% - 3px) 3px,100% 3px,100% calc(100% - 3px),calc(100% - 3px) calc(100% - 3px),calc(100% - 3px) 100%,3px 100%,3px calc(100% - 3px),0 calc(100% - 3px)))}",
    "#thb-super .tab.on{background:var(--px-active,#5c4527);color:var(--px-gold-text,#f3d17a);border-color:var(--px-gold,#e8b64c)}",
    "#thb-super .body{padding:12px;overflow-y:auto;flex:1;min-height:0}",
    "#thb-super .body.agent{display:flex;flex-direction:column;padding:8px 10px 10px;gap:0}",
    "#thb-super h4{margin:2px 0 6px;color:var(--px-gold-text,#f3d17a);font-size:12px;letter-spacing:.14em;text-shadow:0 2px 0 #000}",
    "#thb-super .muted{color:#a08a63;font-size:11px}",
    "#thb-super code{color:var(--px-gold-text,#f3d17a);word-break:break-all}",
    "#thb-super button{font:inherit;font-size:11.5px;background:var(--px-raised,#45362a);color:var(--px-text,#e7d8bc);",
    "border:2px solid var(--px-ink,#110c08);border-radius:0;padding:5px 10px;cursor:pointer;margin:2px 3px 4px 0;letter-spacing:.05em;",
    "clip-path:var(--px-notch,polygon(0 3px,3px 3px,3px 0,calc(100% - 3px) 0,calc(100% - 3px) 3px,100% 3px,100% calc(100% - 3px),calc(100% - 3px) calc(100% - 3px),calc(100% - 3px) 100%,3px 100%,3px calc(100% - 3px),0 calc(100% - 3px)));",
    "box-shadow:var(--px-raised-shadow,inset 2px 2px 0 #6a5439,inset -2px -3px 0 #2a1f15)}",
    "#thb-super button:hover{background:var(--px-raised-hover,#54422f);color:#fff3d6}",
    "#thb-super button:active{box-shadow:var(--px-pressed-shadow,inset 2px 3px 0 #2a1f15,inset -2px -2px 0 #6a5439)}",
    "#thb-super button.primary{background:#c9973f;color:#1f150b;box-shadow:inset 2px 2px 0 #f3d17a,inset -2px -3px 0 #7a5522}",
    "#thb-super button.primary:hover{background:#dcaa4c;color:#1f150b}",
    "#thb-super button.danger{background:#6a2d24;color:#ffd9cf;box-shadow:inset 2px 2px 0 #9c4a3c,inset -2px -3px 0 #3d150f}",
    "#thb-super button.tiny{padding:3px 8px;font-size:10.5px;margin:0}",
    "#thb-super input,#thb-super select,#thb-super textarea{font:inherit;font-size:12px;background:var(--px-inset,#1a130d);color:var(--px-text,#e7d8bc);",
    "border:2px solid var(--px-brass,#8a6a3e);border-radius:0;padding:5px 7px;width:100%;box-sizing:border-box;margin:2px 0 4px;",
    "box-shadow:var(--px-sunken-shadow,inset 2px 2px 0 rgba(0,0,0,.45),inset -1px -1px 0 rgba(255,255,255,.06))}",
    "#thb-super input:focus,#thb-super select:focus,#thb-super textarea:focus{outline:none;border-color:var(--px-gold,#e8b64c)}",
    "#thb-super .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
    "#thb-super .lbl{color:#b7a06a;font-size:11px;margin-top:7px;display:block;letter-spacing:.05em}",
    "#thb-super .switch{display:flex;gap:6px;align-items:center;margin:3px 0;font-size:11.5px;color:var(--px-text,#e7d8bc);cursor:pointer}",
    "#thb-super .switch input{width:auto;margin:0;accent-color:#c9973f}",
    "#thb-super ol,#thb-super ul{margin:4px 0 4px 18px;padding:0}#thb-super li{margin:3px 0}",
    // agent head + world bar
    "#thb-super .ag-head{display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap}",
    "#thb-super .ag-title{color:var(--px-gold-text,#f3d17a);font-weight:700;letter-spacing:.12em;text-shadow:0 2px 0 #000;font-size:12px}",
    "#thb-super .badge{font-size:11px;letter-spacing:.05em;padding:2px 8px;border:1px solid var(--px-brass,#8a6a3e);color:#a08a63;background:rgba(0,0,0,.25)}",
    "#thb-super .badge.on{color:#9fd0a8;border-color:#4c7a54}",
    "#thb-super .badge.mid{color:var(--px-gold,#e8b64c);border-color:var(--px-brass,#8a6a3e)}",
    "#thb-super .badge.err{color:#e08b7a;border-color:#7a3a2d}",
    "#thb-super .modes{display:flex;gap:0;margin-left:auto}",
    "#thb-super .modebtn{margin:0;padding:3px 9px;font-size:10.5px;color:#a08a63;background:var(--px-inset,#1a130d);border:1px solid var(--px-brass,#8a6a3e);clip-path:none;box-shadow:none}",
    "#thb-super .modebtn.on{color:#1f150b;background:var(--px-gold,#e8b64c);border-color:#e8b64c;font-weight:700}",
    "#thb-super .wbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:4px 9px;margin-bottom:6px;font-size:10.5px;color:#c9b489;",
    "background:var(--px-inset,#1a130d);border:1px solid var(--px-groove,#3f3022);box-shadow:var(--px-sunken-shadow,inset 2px 2px 0 rgba(0,0,0,.45),inset -1px -1px 0 rgba(255,255,255,.06));",
    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#thb-super .wbar b{color:var(--px-gold-text,#f3d17a);font-weight:700}",
    "#thb-super .wbar .wev{color:#8f7d5c;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:60px}",
    // chat log
    "#thb-super .chatlog{flex:1;min-height:120px;overflow-y:auto;margin:6px 0;padding:9px;background:var(--px-inset,#1a130d);",
    "border:2px solid var(--px-brass,#8a6a3e);box-shadow:var(--px-sunken-shadow,inset 2px 2px 0 rgba(0,0,0,.45),inset -1px -1px 0 rgba(255,255,255,.06));",
    "scrollbar-color:var(--px-brass,#8a6a3e) var(--px-inset,#1a130d);scrollbar-width:thin}",
    "#thb-super .msg{margin:5px 0;white-space:pre-wrap;word-break:break-word}",
    "#thb-super .msg.user{color:var(--px-gold-text,#f3d17a);background:rgba(201,151,63,.10);border-left:3px solid var(--px-brass,#8a6a3e);padding:3px 8px;margin:7px 0}",
    "#thb-super .msg.user::before{content:'▸ ';color:var(--px-brass,#8a6a3e)}",
    "#thb-super .msg.bot{color:var(--px-text,#e7d8bc)}",
    "#thb-super .msg.sys{color:#a08a63;font-size:11px;font-style:italic}",
    "#thb-super .msg.err{color:#e08b7a}",
    "#thb-super .msg.direct{color:#9fd0a8;font-size:11.5px;border-left:3px solid #4c7a54;padding:2px 8px}",
    "#thb-super .msg.direct b{color:#c9e8cc}",
    // streaming turn
    "#thb-super .turn{margin:7px 0}",
    "#thb-super .turn .status{color:#b7a06a;font-size:11px;margin-bottom:3px}",
    "#thb-super .turn .status .dot{display:inline-block;animation:thbspin 1s steps(2) infinite}",
    "#thb-super details.act{margin:2px 0 4px;border-left:3px solid var(--px-groove,#3f3022);background:rgba(0,0,0,.18);padding:2px 7px}",
    "#thb-super details.act summary{cursor:pointer;color:#8f7d5c;font-size:10.5px;list-style:none}",
    "#thb-super details.act summary::before{content:'» '}",
    "#thb-super details.act pre{margin:4px 0;font-size:10.5px;color:#8f7d5c;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto}",
    "#thb-super .livebox{margin:2px 0 4px;border-left:3px solid var(--px-brass,#8a6a3e);background:rgba(0,0,0,.2);padding:4px 8px;color:#b7a06a;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}",
    "#thb-super .livebox .gear{color:var(--px-gold,#e8b64c)}",
    "#thb-super .cursor{display:inline-block;width:7px;height:12px;background:var(--px-gold,#e8b64c);animation:thbspin .8s steps(2) infinite;vertical-align:-2px;margin-left:2px}",
    // tool cards
    "#thb-super .tcard{margin:3px 0;border:1px solid var(--px-groove,#3f3022);border-left:3px solid var(--px-brass,#8a6a3e);background:rgba(0,0,0,.22);padding:3px 8px;font-size:11px}",
    "#thb-super .tcard.ok{border-left-color:#4c7a54}",
    "#thb-super .tcard.err{border-left-color:#7a3a2d}",
    "#thb-super .tcard .trow{display:flex;gap:7px;align-items:baseline;flex-wrap:wrap}",
    "#thb-super .tcard .tname{color:var(--px-gold-text,#f3d17a);font-weight:700}",
    "#thb-super .tcard .targs{color:#a08a63;word-break:break-all}",
    "#thb-super .tcard .tstat{margin-left:auto;color:#a08a63;white-space:nowrap}",
    "#thb-super .tcard.ok .tstat{color:#9fd0a8}",
    "#thb-super .tcard.err .tstat{color:#e08b7a}",
    "#thb-super .tcard details{margin-top:2px}",
    "#thb-super .tcard details summary{cursor:pointer;color:#8f7d5c;font-size:10px;list-style:none}",
    "#thb-super .tcard pre{margin:3px 0;font-size:10px;color:#9fd0a8;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto}",
    "#thb-super .tcard img.shot{max-width:100%;margin-top:4px;border:1px solid var(--px-brass,#8a6a3e);cursor:zoom-in;image-rendering:pixelated}",
    // markdown bubble
    "#thb-super .bubble{color:var(--px-text,#e7d8bc);background:rgba(232,182,76,.05);border:1px solid var(--px-groove,#3f3022);padding:6px 9px;margin-top:4px}",
    "#thb-super .bubble p{margin:4px 0;white-space:pre-wrap}",
    "#thb-super .bubble .md-h{color:var(--px-gold-text,#f3d17a);font-weight:700;margin:7px 0 2px}",
    "#thb-super .bubble ul,#thb-super .bubble ol{margin:3px 0 3px 16px}",
    "#thb-super .bubble li{margin:2px 0}",
    "#thb-super .bubble code{background:rgba(0,0,0,.35);padding:0 4px;font-size:11px}",
    "#thb-super .bubble pre{background:rgba(0,0,0,.35);padding:6px 8px;margin:4px 0;overflow:auto;font-size:11px}",
    "#thb-super .bubble a{color:#7dd3fc}",
    "#thb-super .meta{display:flex;gap:5px;flex-wrap:wrap;margin-top:3px}",
    "#thb-super .meta span{font-size:9.5px;color:#8f7d5c;border:1px solid var(--px-groove,#3f3022);padding:1px 6px;background:rgba(0,0,0,.2)}",
    // chips + input
    "#thb-super .chips{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 2px}",
    "#thb-super .chips button{margin:0;padding:4px 9px;font-size:11px}",
    "#thb-super .chips button.instant{border-color:#4c7a54;color:#b9e2be}",
    "#thb-super .ag-inputrow{display:flex;gap:6px;align-items:flex-end}",
    "#thb-super .ag-inputrow textarea{flex:1;resize:none;height:44px;min-height:44px}",
    // direct command bar
    "#thb-super .cmdbar{position:relative;display:flex;gap:6px;align-items:center;margin:4px 0 6px}",
    "#thb-super .cmdbar .cico{color:var(--px-gold,#e8b64c);font-weight:700;font-size:13px;flex:none;text-shadow:0 2px 0 #000}",
    "#thb-super .cmdbar input{flex:1;margin:0;font-size:12px}",
    "#thb-super .cmdbar button{margin:0;flex:none}",
    "#thb-super .cmdlist{position:absolute;left:22px;right:64px;bottom:calc(100% + 4px);max-height:230px;overflow-y:auto;z-index:5;",
    "background:var(--px-wood,#2b2118);border:2px solid var(--px-brass,#8a6a3e);box-shadow:0 8px 24px rgba(0,0,0,.6);display:none}",
    "#thb-super .cmdlist .ci{padding:4px 9px;cursor:pointer;font-size:11px;border-bottom:1px solid rgba(138,106,62,.25);display:flex;gap:8px;align-items:baseline}",
    "#thb-super .cmdlist .ci .cn{color:var(--px-gold-text,#f3d17a);font-weight:700;white-space:nowrap}",
    "#thb-super .cmdlist .ci .cd{color:#a08a63;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "#thb-super .cmdlist .ci .ca{color:#8f7d5c;font-size:9.5px;white-space:nowrap}",
    "#thb-super .cmdlist .ci.sel,#thb-super .cmdlist .ci:hover{background:var(--px-active,#5c4527)}",
    // settings
    "#thb-super details.settings{margin:5px 0;border:1px solid var(--px-brass,#8a6a3e);background:rgba(0,0,0,.18);padding:4px 8px}",
    "#thb-super details.settings summary{cursor:pointer;color:#b7a06a;font-size:11px;letter-spacing:.05em}",
    "#thb-super .spin{display:inline-block;animation:thbspin 1s steps(2) infinite}@keyframes thbspin{50%{opacity:.35}}",
    // lightbox
    "#thb-shot-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(10,6,3,.88);display:none;align-items:center;justify-content:center;cursor:zoom-out;padding:24px}",
    "#thb-shot-overlay img{max-width:96vw;max-height:92vh;border:2px solid var(--px-brass,#8a6a3e);image-rendering:pixelated}",
  ].join("");

  function el(tag, attrs, html) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach((k) => node.setAttribute(k, attrs[k]));
    if (html != null) node.innerHTML = html;
    return node;
  }

  var panel, chatlog;
  var logEntries = [];

  function toast(sel, text, isError) {
    var node = panel.querySelector(sel);
    if (!node) return;
    node.textContent = text;
    node.style.color = isError ? "#e08b7a" : "#9fd0a8";
    clearTimeout(node._t);
    node._t = setTimeout(() => (node.textContent = ""), 6000);
  }

  function saveLog() {
    try { localStorage.setItem(LS_LOG, JSON.stringify(logEntries.slice(-120))); }
    catch (e) {
      try { localStorage.setItem(LS_LOG, JSON.stringify(logEntries.slice(-40))); } catch (e2) {}
    }
  }

  function pushLog(cls, text, meta) {
    logEntries.push({ c: cls, t: text, m: meta || null });
    if (logEntries.length > 240) logEntries = logEntries.slice(-120);
    saveLog();
  }

  function chatMsg(cls, text, meta, record) {
    if (record !== false) pushLog(cls, text, meta);
    if (!chatlog) return;
    renderMsg(cls, text, meta);
    chatlog.scrollTop = chatlog.scrollHeight;
  }

  function renderMsg(cls, text, meta) {
    var node;
    if (cls === "bot") {
      node = el("div", { class: "msg bot" });
      var b = el("div", { class: "bubble" }, mdToHtml(text));
      node.appendChild(b);
    } else {
      node = el("div", { class: "msg " + cls }, esc(text));
    }
    chatlog.appendChild(node);
    if (meta) chatlog.appendChild(el("div", { class: "msg meta", style: "color:#7d6b4d;font-size:10px" }, esc(meta)));
  }

  function clearChat() {
    logEntries = [];
    saveLog();
    if (chatlog) chatlog.innerHTML = "";
  }

  function restoreLog() {
    if (!chatlog) return;
    chatlog.innerHTML = "";
    logEntries.forEach(function (e) { renderMsg(e.c, e.t, e.m); });
    chatlog.scrollTop = chatlog.scrollHeight;
  }

  // ── markdown-lite renderer (escape-first, then whitelist tags) ─────────

  function inlineMd(safe) {
    var out = safe
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    return out;
  }

  function mdToHtml(src) {
    var lines = String(src ?? "").replace(/\r/g, "").split("\n");
    var html = [];
    var list = null; // "ul" | "ol"
    var code = null;
    var para = [];
    function flushPara() {
      if (para.length) { html.push("<p>" + inlineMd(esc(para.join(" "))) + "</p>"); para = []; }
    }
    function closeList() {
      if (list) { html.push("</" + list + ">"); list = null; }
    }
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (code !== null) {
        if (/^```/.test(line.trim())) { html.push("<pre>" + esc(code.join("\n")) + "</pre>"); code = null; }
        else code.push(line);
        continue;
      }
      var t = line.trim();
      if (!t) { flushPara(); closeList(); continue; }
      if (/^```/.test(t)) { flushPara(); closeList(); code = []; continue; }
      var h = /^(#{1,4})\s+(.*)$/.exec(t);
      if (h) { flushPara(); closeList(); html.push('<div class="md-h">' + inlineMd(esc(h[2])) + "</div>"); continue; }
      var ul = /^[-*·]\s+(.*)$/.exec(t);
      if (ul) {
        flushPara();
        if (list !== "ul") { closeList(); list = "ul"; html.push("<ul>"); }
        html.push("<li>" + inlineMd(esc(ul[1])) + "</li>");
        continue;
      }
      var ol = /^(\d+)[.、]\s+(.*)$/.exec(t);
      if (ol) {
        flushPara();
        if (list !== "ol") { closeList(); list = "ol"; html.push("<ol>"); }
        html.push("<li>" + inlineMd(esc(ol[2])) + "</li>");
        continue;
      }
      if (/^(===|---)$/.test(t)) { flushPara(); closeList(); html.push('<div class="md-h">—</div>'); continue; }
      closeList();
      para.push(t);
    }
    if (code !== null) html.push("<pre>" + esc(code.join("\n")) + "</pre>");
    flushPara();
    closeList();
    return html.join("");
  }

  // ── agent console: connection ──────────────────────────────────────────

  var ws = null;
  var wsAlive = false;
  var wsWant = false;
  var reconnectTries = 0;
  var reconnectTimer = null;
  var busy = false;
  var turn = null; // live streaming turn state
  var queuedChat = null; // v5: a chat that could not be sent — fired on reconnect
  var toolResults = new Map(); // v5: tool id → result — re-issued calls replay instead of re-running (no double nukes)

  function agentSend(obj) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
        return true;
      } catch (e) {
        // fall through to the offline path
      }
    }
    if (obj && obj.type === "chat") {
      queuedChat = obj;
      chatMsg("sys", "（未连接——已排队，重连后自动发送）");
      if (!wsAlive && wsWant) scheduleReconnect(0);
      return false;
    }
    chatMsg("sys", "（未连接 Agent——正在自动重连，稍候再试）");
    if (!wsAlive && wsWant) scheduleReconnect(0);
    return false;
  }

  function rememberToolResult(id, result) {
    try {
      if (toolResults.size > 60) {
        var first = toolResults.keys().next().value;
        toolResults.delete(first);
      }
      toolResults.set(id, { result: result, at: Date.now() });
    } catch (e) {}
  }

  // v5 heartbeat: a frame every 20s keeps the Pages-Function WS splice (and
  // every proxy on the way) from reaping the connection as idle while a
  // slow model thinks. Also doubles as a lag badge.
  setInterval(function () {
    if (ws && ws.readyState === 1 && wsWant) {
      try { ws.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch (e) {}
    }
  }, 20000);

  function setWsBadge(state) {
    var badge = panel.querySelector("#ag-ws");
    if (!badge) return;
    var map = { on: ["● 在线", "on"], mid: ["● 连接中", "mid"], off: ["○ 离线", ""], err: ["● 连接失败", "err"] };
    var it = map[state] || map.off;
    badge.textContent = it[0];
    badge.className = "badge " + it[1];
  }

  function setBusy(b) {
    busy = b;
    var send = panel.querySelector("#ag-send");
    if (send) {
      send.textContent = b ? "■ 停止" : "发送";
      send.className = b ? "danger" : "primary";
    }
  }

  function stopReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function scheduleReconnect(delaySec) {
    stopReconnect();
    if (!wsWant) return;
    var backoff = [2, 4, 8, 15, 30, 60];
    var delay = delaySec != null ? delaySec : backoff[Math.min(reconnectTries, backoff.length - 1)];
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (wsWant && !wsAlive) connectAgent(true);
    }, delay * 1000);
  }

  function nearBottom() {
    return chatlog && chatlog.scrollHeight - chatlog.scrollTop - chatlog.clientHeight < 90;
  }
  function scrollDown(force) {
    if (chatlog && (force || nearBottom())) chatlog.scrollTop = chatlog.scrollHeight;
  }

  /** Friendly one-line rendering of streamed model output (tool JSON and
   *  native <function=…> call syntax → ⚙ lines — never raw code). */
  function actHtml(text) {
    var lines = String(text).split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i += 1) {
      var l = lines[i];
      var f = /^<function\s*=\s*([A-Za-z0-9_.-]+)/i.exec(l.trim());
      if (f) { out.push('<span class="gear">⚙ ' + esc(f[1]) + "</span>"); continue; }
      var m = /"tool"\s*:\s*"([^"]+)"/.exec(l);
      if (m) { out.push('<span class="gear">⚙ ' + esc(m[1]) + "</span>"); continue; }
      var c = /"cmd"\s*:\s*"([^"]+)"/.exec(l);
      if (c) { out.push('<span class="gear">⌘ ' + esc(c[1]) + "</span>"); continue; }
      if (/^TOOL\s*:/i.test(l.trim())) { out.push('<span class="gear">⚙ …</span>'); continue; }
      if (/<\/function\s*>/i.test(l)) continue;
      if (l.trim()) out.push(esc(l));
    }
    return out.join("\n");
  }

  /** v5: what the player SEES as the final answer — tool-call syntax (TOOL:
   *  lines, <function=…> blocks, lone tool JSON) is plumbing, not prose. It
   *  stays in the model's history; it never reaches the bubble. */
  function sanitizeReply(text) {
    var s = String(text || "");
    s = s.replace(/<function\s*=\s*[A-Za-z0-9_.-]+\s*\/?>([\s\S]*?)(?:<\/function\s*>|$)/gi, "");
    s = s
      .split(/\r?\n/)
      .filter(function (l) {
        var t = l.trim();
        if (!t) return true;
        if (/^TOOL\s*:/i.test(t)) return false;
        if (/^<function[\s=]/i.test(t)) return false;
        if (/^\{\s*"tool"\s*:/.test(t)) return false;
        return true;
      })
      .join("\n");
    s = s.replace(/```(?:json)?\s*\n?\s*\{\s*"tool"[\s\S]*?```/gi, "");
    return s.replace(/\n{3,}/g, "\n\n").trim();
  }

  function ensureTurn(modelLabel) {
    if (turn && turn.node.isConnected) return turn;
    var node = el("div", { class: "turn" });
    var status = el("div", { class: "status" }, '<span class="dot">✦</span> 连接模型…');
    var live = el("div", { class: "livebox" });
    var tools = el("div", { class: "tools" });
    var bubble = el("div", { class: "bubble", style: "display:none" });
    var meta = el("div", { class: "meta", style: "display:none" });
    node.appendChild(status);
    node.appendChild(live);
    node.appendChild(tools);
    node.appendChild(bubble);
    node.appendChild(meta);
    chatlog.appendChild(node);
    scrollDown(true);
    turn = { node: node, status: status, live: live, tools: tools, bubble: bubble, meta: meta, actText: "", round: -1, t0: Date.now() };
    return turn;
  }

  function finishTurn() {
    if (!turn) return;
    var t = turn;
    turn = null;
    // fold the live box into a closed <details>
    var det = el("details", { class: "act" });
    det.appendChild(el("summary", null, "工作过程"));
    var pre = el("pre", null, actHtml(t.actText) || "（无）");
    det.appendChild(pre);
    if (t.live.parentNode) t.node.replaceChild(det, t.live);
    if (!t.actText && !t.tools.children.length) { det.style.display = "none"; }
  }

  function fmtMs(ms) {
    if (ms == null) return "";
    return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
  }

  function connectAgent(isRetry) {
    stopReconnect();
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch (e) {}
      ws = null;
    }
    setWsBadge("mid");
    if (!isRetry) chatMsg("sys", "连接 DevAgent（" + (directMode() ? "直连 workers.dev" : "同源代理") + "）…", null, false);
    try { ws = new WebSocket(wsUrl()); }
    catch (e) {
      setWsBadge("err");
      chatMsg("err", "连接失败: " + e.message);
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      wsAlive = true;
      reconnectTries = 0;
      setWsBadge("on");
      chatMsg("sys", "已连接。直接下达指令，AI 可以操控这个世界；或用下方 ⌘ 命令栏直接施法。", null, false);
      agentSend({ type: "sync" });
      // v5: fire a chat that was queued while offline
      if (queuedChat) {
        var q = queuedChat;
        queuedChat = null;
        try { ws.send(JSON.stringify(q)); } catch (e) { setBusy(false); }
      }
    };
    ws.onclose = () => {
      var wasAlive = wsAlive;
      wsAlive = false;
      setWsBadge(wsWant ? "err" : "off");
      if (busy) {
        // v5: do NOT fold the turn — the DO keeps working and broadcasts;
        // on reconnect we get turn_live and re-issued tool calls.
        if (turn && turn.status) turn.status.innerHTML = '<span class="dot">⟳</span> 连接中断，重连后自动接续工作流…';
        setBusy(false);
        turn = null; // let turn_live rebuild it on reconnect
      }
      if (wsWant) {
        reconnectTries += 1;
        chatMsg("sys", wasAlive ? "连接断开，" + Math.min(reconnectTries * 2, 12) + " 秒后重连（工作中断的流程会自动接续）…" : "暂时连不上，继续重试中…", null, false);
        scheduleReconnect();
      }
    };
    ws.onerror = () => setWsBadge("err");
    ws.onmessage = (ev) => {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      try { handleAgentEvent(m); }
      catch (e) { /* v5: one bad frame must never kill the whole handler */ }
    };
  }

  function handleAgentEvent(m) {
    if (m.type === "pong") {
      return; // heartbeat answered — nothing to render
    }
    if (m.type === "welcome") {
      if (m.models && m.models.length) { agentCatalog = m.models; }
      if (m.providers && m.providers.length) { agentProviders = m.providers; }
      buildModelSelect(m.default_model);
      setBusy(busy);
      chatMsg("sys", "DevAgent v" + (m.version || "?") + " · " + ((m.models && m.models.length) || 0) + " 个 Workers AI 模型 + " + ((m.providers && m.providers.length) || 0) + " 家直连厂商已就绪", null, false);
    } else if (m.type === "turn_live") {
      // v5: re-attach to a turn that was already in flight before a reconnect
      if (!busy) setBusy(true);
      var t0 = ensureTurn(m.model);
      t0.status.innerHTML = '<span class="dot">⟳</span> 已重连 · 第 ' + (m.round + 1) + ' 轮 · ' + esc(m.model || "") + '…接续中';
      if (m.text) {
        t0.actText = String(m.text);
        t0.live.innerHTML = actHtml(t0.actText) + '<span class="cursor"></span>';
      }
      (m.tools || []).forEach(function (tc) {
        var card = toolCard(tc.tool, null, m.round);
        t0.tools.appendChild(card);
        if (tc.ok !== null && tc.ok !== undefined) {
          card.removeAttribute("data-pending");
          var st = card.querySelector(".tstat");
          if (st) st.textContent = (tc.ok ? "✓ " : "✗ ") + String(tc.summary || "").slice(0, 70);
          card.classList.remove("run");
          card.classList.add(tc.ok ? "ok" : "err");
        }
      });
      scrollDown();
    } else if (m.type === "history") {
      var hasConversation = logEntries.some((e) => e.c === "user" || e.c === "bot");
      if (!hasConversation && m.messages && m.messages.length) {
        m.messages.forEach(function (h) {
          if (h.role === "user") chatMsg("user", h.content);
          else if (h.role === "assistant") chatMsg("bot", h.content);
        });
        chatMsg("sys", "（已恢复上次的对话）");
      }
    } else if (m.type === "stage") {
      var t = ensureTurn();
      t.round = m.round;
      var stageLabel = m.stage === "repair" ? "纠正格式 · " : "";
      t.status.innerHTML = '<span class="dot">✦</span> ' + stageLabel + (m.round > 0 ? "第 " + (m.round + 1) + " 轮 · " : "") + esc(m.model || "") + " 思考中…";
      scrollDown();
    } else if (m.type === "thinking") {
      var th = ensureTurn();
      th.status.innerHTML = '<span class="dot">✦</span> 思考中… 已推理 ' + (m.chars || 0) + ' 字（深度思考不动手）';
      scrollDown();
    } else if (m.type === "delta") {
      var t2 = ensureTurn();
      t2.actText += m.text;
      t2.live.innerHTML = actHtml(t2.actText) + '<span class="cursor"></span>';
      scrollDown();
    } else if (m.type === "tool") {
      var t3 = ensureTurn();
      t3.status.innerHTML = '<span class="dot">⚙</span> 执行 ' + esc(m.tool) + " …";
      t3.tools.appendChild(toolCard(m.tool, m.args, m.round));
      scrollDown();
    } else if (m.type === "tool_call") {
      // v5: a re-issued call (reconnect takeover) replays the cached result
      // instead of re-running — an interrupted nuke must not fire twice.
      var cached = m.id != null ? toolResults.get(m.id) : null;
      if (cached) {
        var box0 = toolCard(m.tool, m.args, null);
        chatlog.appendChild(box0);
        fillToolCard(box0, m.tool, cached.result, null, true);
        agentSend({ type: "tool_result", id: m.id, ok: true, result: cached.result });
        scrollDown();
        return;
      }
      var box = toolCard(m.tool, m.args, null);
      chatlog.appendChild(box);
      scrollDown();
      runToolOnPage(m.tool, m.args).then(
        (result) => {
          rememberToolResult(m.id, result);
          fillToolCard(box, m.tool, result, null);
          if (m.tool === "game_screenshot" && result && result.image) showThumb(box, result.image);
          agentSend({ type: "tool_result", id: m.id, ok: true, result: result });
        },
        (error) => {
          fillToolCard(box, m.tool, { error: String(error) }, null);
          agentSend({ type: "tool_result", id: m.id, ok: false, result: String(error) });
        },
      );
    } else if (m.type === "tool_done") {
      // find this round's matching running card(s) still pending
      if (turn) {
        var pend = turn.tools.querySelectorAll('.tcard[data-pending="1"]');
        for (var i = 0; i < pend.length; i += 1) {
          var nm = pend[i].getAttribute("data-tool");
          if (nm === m.tool) {
            pend[i].removeAttribute("data-pending");
            var st = pend[i].querySelector(".tstat");
            if (st) {
              st.textContent = (m.ok ? "✓ " : "✗ ") + String(m.summary || (m.ok ? "ok" : "failed")).slice(0, 70);
            }
            pend[i].classList.remove("run");
            pend[i].classList.add(m.ok ? "ok" : "err");
            break;
          }
        }
      }
    } else if (m.type === "assistant") {
      var tt = turn || ensureTurn();
      finishTurn();
      var show = sanitizeReply(m.text);
      tt.bubble.style.display = "";
      tt.bubble.innerHTML = show
        ? mdToHtml(show)
        : "<i style='opacity:.7'>（已执行完毕——本轮只有动作，没有文字说明）</i>";
      var chips = [];
      if (m.model) chips.push(esc(m.model));
      if (m.actions) chips.push(m.actions + " 次工具");
      if (m.ms) chips.push("共 " + fmtMs(m.ms));
      if (m.ttft) chips.push("首字 " + fmtMs(m.ttft));
      tt.meta.style.display = "";
      tt.meta.innerHTML = chips.map((c) => "<span>" + c + "</span>").join("");
      pushLog("bot", show || String(m.text).slice(0, 200), chips.join(" · "));
      setBusy(false);
      scrollDown(true);
    } else if (m.type === "status") {
      if (m.text && /中断/.test(m.text)) { finishTurn(); setBusy(false); }
      chatMsg("sys", "… " + (m.model ? "[" + m.model + "] " : "") + m.text, null, false);
    } else if (m.type === "error") {
      finishTurn();
      setBusy(false);
      chatMsg("err", "⚠ " + m.error);
    }
  }

  function toolCard(tool, args, round) {
    var card = el("div", { class: "tcard run", "data-tool": tool, "data-pending": "1" });
    var name = el("span", { class: "tname" }, esc(tool));
    var argStr = "";
    try {
      if (tool === "game_command") {
        var c = Array.isArray(args?.command) ? args.command : args?.command;
        if (Array.isArray(c)) argStr = c.map((x) => x.cmd).join(",") + " ×" + c.length;
        else if (c) argStr = c.cmd + " " + [c.x ?? c.ax, c.y ?? c.ay].filter((v) => v != null).join(",") + (c.radius != null ? " r" + c.radius : "") + (c.kind != null ? " " + c.kind : "");
        else argStr = "";
      } else if (tool === "game_control") argStr = String(args?.action || "");
      else argStr = JSON.stringify(args || {}).slice(0, 80);
    } catch (e) { argStr = ""; }
    var argsEl = el("span", { class: "targs" }, esc(argStr));
    var stat = el("span", { class: "tstat" }, "执行中…");
    var row = el("div", { class: "trow" });
    row.appendChild(el("span", { class: "gear", style: "color:#e8b64c" }, "⚙"));
    row.appendChild(name);
    if (argStr) row.appendChild(argsEl);
    row.appendChild(stat);
    card.appendChild(row);
    if (round != null) card.setAttribute("data-round", String(round));
    return card;
  }

  function fillToolCard(card, tool, result, round, replay) {
    card.removeAttribute("data-pending");
    var st = card.querySelector(".tstat");
    var ok = !(result && result.error) && !(result && result.ok === false);
    var summary = "";
    if (tool === "game_command") {
      var oc = result?.outcome || result;
      summary = ok ? String(oc?.code || "applied") : String(oc?.code || result?.error || "failed");
    } else if (result?.error) summary = String(result.error);
    else if (tool === "game_screenshot" && result?.image) summary = "截图 " + result.w + "×" + result.h;
    else summary = "ok";
    if (replay) summary = summary + "（重放结果，未重复执行）";
    if (st) st.textContent = (ok ? "✓ " : "✗ ") + summary.slice(0, 90);
    card.classList.remove("run");
    card.classList.add(ok ? "ok" : "err");
    var det = el("details");
    det.appendChild(el("summary", null, "结果"));
    var pre = document.createElement("pre");
    var txt;
    try {
      txt = result && result.image ? "（图像数据，已传给模型）" : typeof result === "string" ? result : JSON.stringify(result, null, 1);
    } catch (e) { txt = String(result); }
    pre.textContent = String(txt ?? "").slice(0, 1200);
    det.appendChild(pre);
    card.appendChild(det);
  }

  function showThumb(card, dataUrl) {
    var img = el("img", { class: "shot", src: dataUrl, alt: "world screenshot" });
    img.onclick = () => {
      var ov = document.getElementById("thb-shot-overlay");
      if (!ov) {
        ov = el("div", { id: "thb-shot-overlay" });
        ov.innerHTML = "<img>";
        ov.onclick = () => (ov.style.display = "none");
        document.body.appendChild(ov);
      }
      ov.querySelector("img").src = dataUrl;
      ov.style.display = "flex";
    };
    card.appendChild(img);
  }

  function disconnectAgent() {
    wsWant = false;
    stopReconnect();
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch (e) {}
      ws = null;
    }
    wsAlive = false;
    setWsBadge("off");
    chatMsg("sys", "已断开（打开 Agent 标签页会自动重连）", null, false);
  }

  // ── model selection ─────────────────────────────────────────────────────

  function currentCustom() {
    try { return JSON.parse(localStorage.getItem(LS_CUSTOM)); } catch (e) { return null; }
  }

  function providerKeys() {
    try { return JSON.parse(localStorage.getItem(LS_KEYS)) || {}; } catch (e) { return {}; }
  }
  function saveProviderKey(providerId, key) {
    var keys = providerKeys();
    if (key) keys[providerId] = key;
    else delete keys[providerId];
    try { localStorage.setItem(LS_KEYS, JSON.stringify(keys)); } catch (e) {}
  }

  function currentProvider() {
    var sel = panel.querySelector("#ag-model");
    var v = sel ? sel.value : "";
    var m = /^provider:([a-z0-9-]+):/.exec(v);
    if (!m) return null;
    var p = agentProviders.find(function (x) { return x.id === m[1]; });
    return p || { id: m[1], label: m[1], models: [] };
  }

  function buildModelSelect(defaultModel) {
    var sel = panel.querySelector("#ag-model");
    if (!sel) return;
    var saved = localStorage.getItem(LS_MODEL) || defaultModel || (agentCatalog[0] && agentCatalog[0].id);
    var html = "";
    TIER_ORDER.forEach(function (tier) {
      var items = agentCatalog.filter((m) => m.tier === tier);
      if (!items.length) return;
      html += '<optgroup label="' + esc(TIER_LABELS[tier] || tier) + '">';
      items.forEach(function (m) {
        var label = m.label + (m.note ? " · " + m.note : "");
        html += '<option value="' + esc(m.id) + '">' + esc(label) + "</option>";
      });
      html += "</optgroup>";
    });
    agentProviders.forEach(function (p) {
      if (!p.models || !p.models.length) return;
      var hasKey = !!providerKeys()[p.id];
      html += '<optgroup label="' + esc(p.label + " · 直连（自带 Key" + (hasKey ? "已填" : "未填") + "）") + '">';
      p.models.forEach(function (m) {
        var label = m.label + (m.note ? " · " + m.note : "");
        html += '<option value="' + esc("provider:" + p.id + ":" + m.id) + '">' + esc(label) + "</option>";
      });
      html += "</optgroup>";
    });
    html += '<option value="@cf/_free_">其他 @cf/ 模型（手填 id）…</option>';
    html += '<option value="custom">自定义端点（OpenAI 兼容）…</option>';
    sel.innerHTML = html;
    var known =
      saved === "custom" || saved === "@cf/_free_" ||
      agentCatalog.some((m) => m.id === saved) ||
      agentProviders.some((p) => p.models && p.models.some((m) => "provider:" + p.id + ":" + m.id === saved));
    sel.value = known ? saved : (agentCatalog[0] && agentCatalog[0].id) || "";
    modelVisibility();
  }

  function modelVisibility() {
    var sel = panel.querySelector("#ag-model");
    if (!sel) return;
    var v = sel.value;
    var freeBox = panel.querySelector("#ag-free-box");
    var customBox = panel.querySelector("#ag-custom-box");
    var keyBox = panel.querySelector("#ag-key-box");
    if (freeBox) freeBox.style.display = v === "@cf/_free_" ? "block" : "none";
    if (customBox) customBox.style.display = v === "custom" ? "block" : "none";
    if (keyBox) {
      var p = currentProvider();
      if (p) {
        keyBox.style.display = "block";
        var label = keyBox.querySelector(".lbl");
        if (label) label.innerHTML = esc(p.label) + " API Key（仅存本浏览器 · <span style='color:#8f7d5c'>" + esc(p.key_hint || p.endpoint || "") + "</span>）";
        var input = keyBox.querySelector("#ag-provider-key");
        if (input && input.dataset.provider !== p.id) {
          input.dataset.provider = p.id;
          input.value = providerKeys()[p.id] || "";
        }
      } else {
        keyBox.style.display = "none";
      }
    }
    localStorage.setItem(LS_MODEL, v);
  }

  function selectedModel() {
    var sel = panel.querySelector("#ag-model");
    var v = sel ? sel.value : "";
    if (v === "@cf/_free_") {
      var free = panel.querySelector("#ag-free-model");
      var id = free ? free.value.trim() : "";
      if (!id) return null;
      if (!id.startsWith("@cf/")) id = "@cf/" + id;
      return id;
    }
    if (/^provider:/.test(v)) {
      var m = /^provider:([a-z0-9-]+):/.exec(v);
      if (m && !providerKeys()[m[1]]) {
        chatMsg("err", "这个模型需要先在下方填入 " + ((agentProviders.find((p) => p.id === m[1]) || {}).label || m[1]) + " 的 API Key（只存在本浏览器）");
        return null;
      }
    }
    return v || null;
  }

  function currentModelCanSee() {
    var sel = panel.querySelector("#ag-model");
    var v = sel ? sel.value : "";
    if (v === "custom") { var c = currentCustom(); return !!(c && c.vision !== false); }
    if (/^provider:/.test(v)) {
      var parts = v.split(":");
      var p = agentProviders.find(function (x) { return x.id === parts[1]; });
      var entry = p && p.models.find(function (m) { return m.id === parts[2]; });
      return !!(entry && entry.vision);
    }
    var entry = agentCatalog.find((m) => m.id === v);
    return !!(entry && entry.vision);
  }

  function saveCustom() {
    var obj = {
      baseUrl: panel.querySelector("#ag-baseurl").value.trim(),
      model: panel.querySelector("#ag-modelname").value.trim(),
      apiKey: panel.querySelector("#ag-apikey").value.trim(),
      vision: panel.querySelector("#ag-vision").checked,
    };
    if (!/^https?:\/\//.test(obj.baseUrl)) { toast("#ag-msg", "Base URL 需以 http(s):// 开头", true); return null; }
    if (!obj.model) { toast("#ag-msg", "请填写模型名", true); return null; }
    localStorage.setItem(LS_CUSTOM, JSON.stringify(obj));
    toast("#ag-msg", "已保存（密钥只存本浏览器，仅随请求发送）");
    return obj;
  }

  function testCustom() {
    var c = currentCustom() || saveCustom();
    if (!c) return;
    toast("#ag-msg", "测试中…");
    fetch(agentBase() + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "回复两个字：正常", model: "custom", custom: c }),
    })
      .then((r) => r.json())
      .then(
        (out) => {
          if (out.ok) toast("#ag-msg", "端点正常：" + String(out.reply).slice(0, 40));
          else toast("#ag-msg", "端点报错：" + String(out.error).slice(0, 120), true);
        },
        (e) => toast("#ag-msg", "请求失败: " + e.message, true),
      );
  }

  function testProviderKey() {
    var sel = panel.querySelector("#ag-model");
    var v = sel ? sel.value : "";
    var m = /^provider:([a-z0-9-]+):([A-Za-z0-9._\/-]+)$/.exec(v);
    if (!m) return;
    var p = agentProviders.find(function (x) { return x.id === m[1]; }) || { label: m[1] };
    var key = providerKeys()[m[1]] || "";
    if (!key) { toast("#ag-key-msg", "先填入 " + p.label + " 的 API Key", true); return; }
    toast("#ag-key-msg", "测试中…");
    fetch(agentBase() + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "回复两个字：正常", model: v, providerKey: key }),
    })
      .then((r) => r.json())
      .then(
        (out) => {
          if (out.ok) toast("#ag-key-msg", "✓ " + p.label + " 直连正常：" + String(out.reply).slice(0, 40));
          else toast("#ag-key-msg", "✗ " + String(out.error).slice(0, 140), true);
        },
        (e) => toast("#ag-key-msg", "请求失败: " + e.message, true),
      );
  }

  function sendChat(text) {
    var input = panel.querySelector("#ag-input");
    if (text == null) {
      text = input.value.trim();
      if (!text) return;
      input.value = "";
      input.style.height = "44px";
    }
    chatMsg("user", text);
    var model = selectedModel();
    if (!model) { chatMsg("err", "请先选择模型（或填写 API Key / 自定义模型 id）"); return; }
    var msg = { type: "chat", text: text, model: model, v: "5.0.0" };
    if (model === "custom") {
      var c = currentCustom() || saveCustom();
      if (!c) { chatMsg("err", "先在设置里配置并保存自定义端点"); return; }
      msg.custom = c;
    }
    if (/^provider:/.test(model)) {
      var pm = /^provider:([a-z0-9-]+):/.exec(model);
      msg.providerKey = providerKeys()[pm[1]] || "";
    }
    setBusy(true);
    var entry = null;
    if (model === "custom") entry = "custom";
    else if (/^provider:/.test(model)) {
      var pparts = model.split(":");
      var pp = agentProviders.find(function (x) { return x.id === pparts[1]; });
      var mm = pp && pp.models.find(function (x) { return x.id === pparts[2]; });
      entry = (pp ? pp.label + " " : "") + (mm ? mm.label || mm.id : model);
    } else entry = (agentCatalog.find((m) => m.id === model) || {}).label || model;
    ensureTurn(entry);
    // gather the fresh world snapshot first, then send ONE message carrying it
    worldSnapshot()
      .then(function (world) { msg.world = world; })
      .catch(function () {})
      .then(function () {
        if (!agentSend(msg)) setBusy(false);
      });
    refreshWorldBar();
  }

  function stopChat() {
    agentSend({ type: "abort" });
    if (turn) turn.status.innerHTML = "⛔ 中断中…";
  }

  // ── direct command bar ──────────────────────────────────────────────────

  var cmdHistory = [];
  try { cmdHistory = JSON.parse(localStorage.getItem(LS_CMDS)) || []; } catch (e) { cmdHistory = []; }
  var histIdx = -1;
  var acIndex = -1;
  var acItems = [];

  function saveCmdHistory(line) {
    if (cmdHistory[cmdHistory.length - 1] !== line) cmdHistory.push(line);
    if (cmdHistory.length > 40) cmdHistory = cmdHistory.slice(-40);
    try { localStorage.setItem(LS_CMDS, JSON.stringify(cmdHistory)); } catch (e) {}
    histIdx = -1;
  }

  function cmdMatches(query) {
    var q = query.trim().toLowerCase();
    var head = q.split(/\s+/)[0] || "";
    var out = [];
    var push = function (name, desc, args) {
      out.push({ name: name, desc: desc, args: args });
    };
    if (!q) {
      ["nuke", "meteor", "volcano", "spawn", "bless", "weather", "set_time_of_day", "place_building", "spawn_animal", "era_tribe"].forEach(function (n) {
        var s = CMD_MAP[n]; if (s) push(n, s.desc, s.args);
      });
      return out.slice(0, 9);
    }
    // Chinese alias direct hits
    Object.keys(FIXED_ARGS).forEach(function (zh) {
      if (zh === head) {
        var fa = FIXED_ARGS[zh];
        var s2 = CMD_MAP[fa.cmd];
        push(zh + " → " + fa.cmd + (fa.kind ? " " + fa.kind : "") + (fa.phase ? " " + fa.phase : "") + (fa.tile ? " " + fa.tile : "") + (fa.biome ? " " + fa.biome : "") + (fa.what ? " " + fa.what : ""), s2 ? s2.desc : "", s2 ? s2.args : "");
      }
    });
    Object.keys(CMD_ALIASES).forEach(function (zh) {
      if (zh === head) { var s3 = CMD_MAP[CMD_ALIASES[zh]]; if (s3) push(zh + " → " + CMD_ALIASES[zh], s3.desc, s3.args); }
    });
    CMDS.forEach(function (c) {
      if (out.length >= 10) return;
      if (c[0].indexOf(head) === 0 || c[2].indexOf(head) !== -1) push(c[0], c[2], c[1]);
    });
    return out.slice(0, 9);
  }

  function renderAcList() {
    var list = panel.querySelector("#cmd-list");
    var input = panel.querySelector("#cmd-input");
    if (!list || !input) return;
    var v = input.value;
    var showCursor = /(\s|^)$/.test(v) || !/\s/.test(v.trim());
    if (!v.trim() || !showCursor) {
      // still show matches while typing the first word only
      if (!/^[^\s]+\s/.test(v)) { /* first word still being typed */ }
      else { list.style.display = "none"; acIndex = -1; acItems = []; return; }
    }
    acItems = cmdMatches(v);
    if (!acItems.length) { list.style.display = "none"; acIndex = -1; return; }
    if (acIndex >= acItems.length) acIndex = acItems.length - 1;
    list.innerHTML = "";
    acItems.forEach(function (it, i) {
      var row = el("div", { class: "ci" + (i === acIndex ? " sel" : "") });
      row.innerHTML = '<span class="cn">' + esc(it.name) + '</span><span class="cd">' + esc(it.desc) + '</span><span class="ca">' + esc(it.args) + "</span>";
      row.onclick = () => { applyAc(it); };
      list.appendChild(row);
    });
    list.style.display = "block";
  }

  function applyAc(it) {
    var input = panel.querySelector("#cmd-input");
    var v = input.value;
    var m = /^(\S*)(\s.*)?$/.exec(v);
    var name = it.name.split(" → ")[0];
    input.value = name + (m && m[2] ? m[2] : " ");
    panel.querySelector("#cmd-list").style.display = "none";
    acIndex = -1;
    input.focus();
  }

  function runDirect(line) {
    line = String(line || "").trim();
    if (!line) return;
    var input = panel.querySelector("#cmd-input");
    if (input) input.value = "";
    panel.querySelector("#cmd-list").style.display = "none";
    var parsed = parseDirect(line);
    if (parsed.error) {
      chatMsg("err", "⌘ " + parsed.error);
      return;
    }
    if (!perms().game) {
      chatMsg("err", "⌘ 游戏操控已关闭（当前为观察者模式，切换右上角模式）");
      return;
    }
    saveCmdHistory(line);
    var obj = parsed.obj;
    var label = obj.cmd + " " + [obj.x ?? obj.ax, obj.y ?? obj.ay].filter((v) => v != null).join(",") + (obj.radius != null ? " r" + obj.radius : "") + (obj.kind != null ? " " + obj.kind : "") + (obj.phase != null ? " " + obj.phase : "") + (obj.what != null ? " " + obj.what : "");
    chatMsg("direct", "⌘ 执行 " + label + " …", null, false);
    var node = chatlog.children[chatlog.children.length - 1];
    window.__THB__.command(obj).then(
      function (r) {
        var ok = r && r.ok !== false;
        var oc = r && r.outcome;
        var text = ok ? "✓ " + String((oc && oc.code) || "applied") : "✗ " + String((oc && oc.code) || (r && r.error) || "failed");
        if (node && node.classList.contains("direct")) node.innerHTML = "⌘ <b>" + esc(label) + "</b> → " + (ok ? '<span style="color:#9fd0a8">' : '<span style="color:#e08b7a">') + esc(text) + "</span>";
        pushLog("direct", "⌘ " + label + " → " + text);
        scrollDown(true);
        refreshWorldBar();
      },
      function (e) {
        if (node && node.classList.contains("direct")) node.innerHTML = "⌘ <b>" + esc(label) + "</b> → <span style='color:#e08b7a'>✗ " + esc(String(e?.message || e)) + "</span>";
        pushLog("direct", "⌘ " + label + " → ✗ " + String(e?.message || e));
        scrollDown(true);
      },
    );
  }

  // ── world bar ───────────────────────────────────────────────────────────

  function refreshWorldBar() {
    var bar = panel.querySelector("#wbar");
    if (!bar) return;
    var headline = domHeadline();
    var pop = "", era = "", weather = "";
    try {
      var m = headline.match(/(\d[\d,]*)\s*(?:people|人|humans)/i);
      if (m) pop = Number(m[1].replace(/,/g, "")).toLocaleString();
      var em = headline.match(/(pre-stone|stone|bronze|iron|classical|medieval|renaissance|industrial|modern|information|atomic|space|digital|quantum|solar|fusion|genetic|orbital|lunar|martian|cyber|neural|posthuman|interstellar|singularity|galactic|dyson|kardashev-?\d|stellar|nebular|universal|multiverse|transcendent|eldritch|voidborn|chronal|akashic|entropic|oneiric|mythic|demiurge|pantheon|omega|rebirth)/i);
      if (em) era = em[1];
    } catch (e) {}
    try {
      var wm = headline.match(/(clear|rain|storm|snow|fog|monsoon|cold snap|晴|雨|雪|雾|风暴)/i);
      if (wm) weather = wm[1];
    } catch (e) {}
    var ev = eventLogLines(1)[0] || "";
    var parts = [];
    if (pop) parts.push("👥 <b>" + esc(pop) + "</b>");
    if (era) parts.push("🏛 " + esc(era));
    if (weather) parts.push("🌤 " + esc(weather));
    parts.push("⏩ " + esc(lastSpeed()));
    bar.innerHTML = parts.join('<span style="color:#5c4a33">·</span>') + '<span class="wev">' + esc(ev).slice(0, 60) + "</span>";
  }

  // ── quick actions ───────────────────────────────────────────────────────

  function quickAction(kind) {
    // instant actions: no AI, no latency
    if (["speed1", "speed2", "speed4", "speed10", "pause", "resume"].indexOf(kind) !== -1) {
      var r = window.__THB__.control(kind);
      Promise.resolve(r).then(
        () => { refreshWorldBar(); },
        (e) => toast("#ag-msg", String(e.message || e), true),
      );
      return;
    }
    if (kind === "cloud") {
      cloudUpload(false).then(
        (r2) => toast("#ag-msg", "已上传 · tick " + r2.tick + " · " + fmtBytes(r2.bytes)),
        (e) => toast("#ag-msg", "上传失败: " + e.message, true),
      );
      return;
    }
    // instant world commands via the direct bar parser
    var instants = {
      night: "夜晚", noon: "正午", dawn: "黎明", dusk: "黄昏",
      rain: "下雨", snow: "下雪", clear: "放晴", storm: "暴风雨", fog: "起雾",
      aurora: "aurora", eclipse: "eclipse", gale: "gale", heat: "heat_wave",
    };
    if (instants[kind]) { runDirect(instants[kind]); return; }
    // AI prompts — the LIVE world data (tribes, era, events) rides along
    // with every message, so the model can act on round 1.
    var prompts = {
      look: currentModelCanSee()
        ? "先用 game_deep 拿到各部落坐标，再 game_screenshot 截图仔细看，然后用三四句话描述：地形、聚落与人口分布（引坐标）、正在发生什么。"
        : "先用 game_deep 拿到各部落坐标与建筑分布，结合随信附上的实时数据与 game_log，给我一份当前世界的简报（引坐标），并给玩家一条建议。",
      brief: "先用 game_deep 拿到全部落坐标/健康，结合随信实时数据给我一份文明简报：各部落位置与状况、建筑、风险点，并给出下一步建议。",
      disaster:
        "先用 game_deep 找到人口最稠密的区域，然后在那一带导演一场史诗级天灾：用 composite 或命令数组编排地震+火山+海啸/陨石雨的组合（坐标具体、错落分布），执行后总结景象与影响。",
      bless:
        "先用 game_deep 拿到全部落坐标，然后给这个世界降下一轮大祝福：按各部落质心分别施治愈、丰收、天赋、勇气、长寿、灵感，再召唤极光，执行后总结文明将迎来的变化。",
      city:
        "先用 game_deep 挑人口最多部落质心附近的空地，规划建造一座小城：place_building 编排 house/market/well/school 等 + road + plant 树木（用命令数组一次执行），然后介绍这座城（报坐标）。",
      war:
        "先用 game_deep 挑两个相邻且实力相当的部落，org_detail 看看双方实力，然后 war 宣战（用质心坐标），报告战争爆发的情况与你的预测。",
      chronicle: "用 backend_chronicle（空参数，会自动附上实时世界数据）为当前文明生成编年史，然后把编年史内容展示给我。",
    };
    if (prompts[kind]) sendChat(prompts[kind]);
  }

  // v5: quick positional hint — reads the engine frame and shows where the
  // action is, so the player sees the deep-control data flowing.
  function refreshDeepHint() {
    deepWorld().then(
      function (d) {
        if (d && d.tribes && d.tribes.length) {
          chatMsg("sys", "🧭 已读引擎全帧：人口 " + d.population + " · 部落 " + d.tribes.length + " 个（最大 " + d.tribes[0].name + " @" + d.tribes[0].cx + "," + d.tribes[0].cy + "）——AI 可直接用这些坐标施法", null, false);
        }
      },
      function () {},
    );
  }

  // ── permission modes ────────────────────────────────────────────────────

  function applyMode(mode) {
    var p = perms();
    if (mode === "god") p = { game: true, dom: false, eval: false };
    else if (mode === "observer") p = { game: false, dom: false, eval: false };
    else if (mode === "danger") p = { game: true, dom: true, eval: true };
    localStorage.setItem(LS_PERMS, JSON.stringify(p));
    var set = function (id, v) { var n = panel.querySelector(id); if (n) n.checked = !!v; };
    set("#pm-game", p.game); set("#pm-dom", p.dom); set("#pm-eval", p.eval);
    panel.querySelectorAll(".modebtn").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-mode") === mode);
    });
    var names = { god: "上帝", observer: "观察者", danger: "危险" };
    chatMsg("sys", "模式切换：" + (names[mode] || mode) + (mode === "danger" ? "（已开放 DOM 与 eval，注意安全）" : ""), null, false);
  }

  function currentMode() {
    var p = perms();
    if (p.game && p.eval) return "danger";
    if (p.game) return "god";
    return "observer";
  }

  // ── panel construction ──────────────────────────────────────────────────

  function buildPanel() {
    var style = el("style", null, CSS);
    document.head.appendChild(style);

    var btn = el("button", { id: "thb-super-btn", title: "TheHumanBox SUPER" }, "⚡");
    btn.onclick = () => {
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) {
        if (!wsAlive && !wsWant && isAgentTab()) { wsWant = true; connectAgent(false); }
        refreshWorldBar();
      }
    };
    document.body.appendChild(btn);

    panel = el("div", { id: "thb-super" });
    panel.innerHTML = [
      '<div class="tabs">',
      '  <div class="tab on" data-tab="agent">AI 代理</div>',
      '  <div class="tab" data-tab="cloud">云存档</div>',
      '  <div class="tab" data-tab="board">排行榜</div>',
      '  <div class="tab" data-tab="lore">编年史</div>',
      "</div>",
      '<div class="body agent" data-body="agent">',
      '  <div class="ag-head">',
      '    <span class="ag-title">✦ DEVAGENT</span>',
      '    <span id="ag-ws" class="badge">○ 离线</span>',
      '    <span class="modes">',
      '      <button class="modebtn tiny" data-mode="god">上帝</button>',
      '      <button class="modebtn tiny" data-mode="observer">观察</button>',
      '      <button class="modebtn tiny" data-mode="danger">危险</button>',
      "    </span>",
      '    <button id="ag-reset" class="tiny" style="margin-left:4px">清空</button>',
      "  </div>",
      '  <div class="wbar" id="wbar">读取世界中…</div>',
      '  <select id="ag-model"></select>',
      '  <div id="ag-free-box" style="display:none">',
      '    <span class="lbl">Workers AI 模型 id（任意 @cf/ 开头）</span>',
      '    <input id="ag-free-model" spellcheck="false" placeholder="@cf/meta/llama-3.1-8b-instruct …">',
      "  </div>",
      '  <div id="ag-custom-box" style="display:none">',
      '    <span class="lbl">端点预设</span>',
      "    <select id=\"ag-preset\">" + ENDPOINT_PRESETS.map((p, i) => '<option value="' + i + '">' + esc(p.label) + "</option>").join("") + "    </select>",
      '    <span class="lbl">Base URL（OpenAI 兼容）</span>',
      '    <input id="ag-baseurl" spellcheck="false" placeholder="https://api.openai.com/v1">',
      '    <span class="lbl">模型名</span>',
      '    <input id="ag-modelname" spellcheck="false" placeholder="gpt-4o-mini / deepseek-chat / glm-4-flash …">',
      '    <span class="lbl">API Key（仅存本浏览器）</span>',
      '    <input id="ag-apikey" type="password" spellcheck="false" placeholder="sk-…（本地 Ollama 可留空）">',
      '    <label class="switch"><input type="checkbox" id="ag-vision" checked>端点支持图片（视觉模型）</label>',
      '    <div class="row"><button id="ag-save" class="primary">保存端点</button><button id="ag-test">测试连接</button></div>',
      '    <div class="muted" id="ag-msg"></div>',
      "  </div>",
      '  <div id="ag-key-box" style="display:none">',
      '    <span class="lbl">API Key</span>',
      '    <input id="ag-provider-key" type="password" spellcheck="false" placeholder="sk-… / 填入后自动保存">',
      '    <div class="row"><button id="ag-key-test">测试直连</button></div>',
      '    <div class="muted" id="ag-key-msg"></div>',
      "  </div>",
      '  <details class="settings"><summary>⚙ 权限 · 连接 · 自定义模型</summary>',
      '    <span class="lbl">工具权限（页面侧强制执行；上方模式按钮可一键切换）</span>',
      '    <label class="switch"><input type="checkbox" id="pm-game">游戏操控（世界命令 / 变速 / 按键 / 截图 / 存档）</label>',
      '    <label class="switch"><input type="checkbox" id="pm-dom">页面（点击 / 读取）</label>',
      '    <label class="switch"><input type="checkbox" id="pm-eval">开发者控制台（page_eval，高危）</label>',
      '    <span class="lbl">连接方式</span>',
      '    <label class="switch"><input type="checkbox" id="ag-direct">直连 workers.dev（海外网络/代理下用；默认走本站同源代理）</label>',
      "  </details>",
      '  <div class="chips">',
      '    <button data-q="look">👁 看世界</button>',
      '    <button data-q="brief">📊 简报</button>',
      '    <button data-q="chronicle">📜 编年史</button>',
      '    <button data-q="disaster">🌋 天灾</button>',
      '    <button data-q="bless">🌸 福佑</button>',
      '    <button data-q="city">🏙 建城</button>',
      '    <button data-q="war">⚔ 战争</button>',
      '    <button data-q="night" class="instant">🌙 夜</button>',
      '    <button data-q="noon" class="instant">☀ 昼</button>',
      '    <button data-q="rain" class="instant">🌧 雨</button>',
      '    <button data-q="snow" class="instant">❄ 雪</button>',
      '    <button data-q="aurora" class="instant">🌌 极光</button>',
      '    <button data-q="speed10" class="instant">⚡×10</button>',
      '    <button data-q="pause" class="instant">⏸</button>',
      '    <button data-q="resume" class="instant">▶</button>',
      '    <button data-q="cloud" class="instant">💾 云存档</button>',
      "  </div>",
      '  <div class="chatlog" id="ag-log"></div>',
      '  <div class="cmdbar">',
      '    <span class="cico">⌘</span>',
      '    <input id="cmd-input" spellcheck="false" placeholder="直接施法，不经 AI：nuke 400 200 · 核弹 · weather rain · spawn 5 300 150（↑历史）">',
      '    <button id="cmd-run" class="primary">执行</button>',
      '    <div class="cmdlist" id="cmd-list"></div>',
      "  </div>",
      '  <div class="ag-inputrow">',
      '    <textarea id="ag-input" placeholder="对 AI 说…（回车发送，Shift+回车换行）"></textarea>',
      '    <button id="ag-send" class="primary">发送</button>',
      "  </div>",
      "</div>",
      '<div class="body" data-body="cloud" style="display:none">',
      '  <h4>☁ 云存档同步</h4>',
      '  <div class="muted">把这个世界压缩后存到 Cloudflare KV（上限 8 MiB）。换浏览器 / 换设备，输入同步码即可恢复；恢复前会自动备份本地原世界。</div>',
      '  <span class="lbl">同步码（就是密钥，别外传）</span>',
      '  <div class="row"><input id="cs-code" spellcheck="false" placeholder="点「生成」或粘贴已有同步码" style="flex:1"><button id="cs-gen">生成</button></div>',
      '  <div class="row"><button id="cs-up" class="primary">⬆ 上传当前世界</button><button id="cs-down">⬇ 恢复到本浏览器</button></div>',
      '  <div class="muted" id="cs-msg"></div>',
      '  <div class="muted" id="cs-info"></div>',
      "</div>",
      '<div class="body" data-body="board" style="display:none">',
      '  <h4>🏆 文明排行榜</h4>',
      '  <div class="row"><input id="lb-name" maxlength="24" placeholder="你的文明名" style="flex:1"><button id="lb-sub" class="primary">提交当前世界</button><button id="lb-ref">刷新</button></div>',
      '  <ol id="lb-list" class="muted"><li>…</li></ol>',
      '  <div class="muted" id="lb-msg"></div>',
      "</div>",
      '<div class="body" data-body="lore" style="display:none">',
      '  <h4>📜 文明编年史（AI · 实时数据）</h4>',
      '  <div class="muted">一键为<b>当前文明</b>立传：自动读取人口、时代、部族与近期事件，无需手动输入。存续与陨落文明都能写。</div>',
      '  <div class="row"><input id="lc-name" maxlength="24" placeholder="文明名（留空＝最大部族名）" style="flex:1"><select id="lc-status" style="width:106px"><option value="auto">自动判断</option><option value="living">存续文明</option><option value="fallen">陨落文明</option></select></div>',
      '  <div class="row"><button id="lc-go" class="primary">📜 为当前文明写编年史</button></div>',
      '  <div class="chips" id="lc-data" style="margin:2px 0 4px"></div>',
      '  <div id="lc-out" class="muted" style="margin-top:6px">尚未生成 — 打开游戏世界后点击上面的按钮，AI 会根据实时数据立传。</div>',
      "</div>",
    ].join("");
    document.body.appendChild(panel);

    // restore panel size
    try {
      var size = JSON.parse(localStorage.getItem(LS_SIZE));
      if (size && size.w) panel.style.width = Math.max(320, Math.min(size.w, innerWidth - 20)) + "px";
      if (size && size.h) panel.style.height = Math.max(420, Math.min(size.h, innerHeight - 20)) + "px";
    } catch (e) {}
    var saveSize = () => {
      try { localStorage.setItem(LS_SIZE, JSON.stringify({ w: panel.offsetWidth, h: panel.offsetHeight })); } catch (e) {}
    };
    panel.addEventListener("mouseup", saveSize);
    panel.addEventListener("touchend", saveSize);

    chatlog = panel.querySelector("#ag-log");

    // tabs
    panel.querySelectorAll(".tab").forEach(function (tab) {
      tab.onclick = () => {
        panel.querySelectorAll(".tab").forEach((t) => t.classList.remove("on"));
        tab.classList.add("on");
        panel.querySelectorAll(".body").forEach((b) => (b.style.display = b.getAttribute("data-body") === tab.getAttribute("data-tab") ? "" : "none"));
        if (tab.getAttribute("data-tab") === "agent") {
          if (!wsAlive && !wsWant) { wsWant = true; connectAgent(false); }
          refreshWorldBar();
          refreshDeepHint(); // v5: show where the action is
        }
      };
    });

    // cloud save tab
    var codeInput = panel.querySelector("#cs-code");
    codeInput.value = localStorage.getItem(LS_CODE) || "";
    var refreshInfo = () => {
      var last = localStorage.getItem(LS_SYNC);
      panel.querySelector("#cs-info").textContent = last ? "上次同步: " + fmtTime(last) : "";
    };
    refreshInfo();
    panel.querySelector("#cs-gen").onclick = () => {
      codeInput.value = crypto.randomUUID().replace(/-/g, "");
      localStorage.setItem(LS_CODE, codeInput.value);
      toast("#cs-msg", "已生成并保存到本浏览器");
    };
    codeInput.onchange = () => {
      var v = codeInput.value.trim();
      if (v) localStorage.setItem(LS_CODE, v);
    };
    panel.querySelector("#cs-up").onclick = () => {
      if (codeInput.value.trim()) localStorage.setItem(LS_CODE, codeInput.value.trim());
      toast("#cs-msg", "上传中…");
      cloudUpload(false).then(
        (r) => { toast("#cs-msg", "已上传 · tick " + r.tick + " · " + fmtBytes(r.bytes)); refreshInfo(); },
        (e) => toast("#cs-msg", "上传失败: " + e.message, true),
      );
    };
    panel.querySelector("#cs-down").onclick = () => {
      if (codeInput.value.trim()) localStorage.setItem(LS_CODE, codeInput.value.trim());
      if (!confirm("恢复会覆盖本浏览器当前世界（原世界已自动备份为恢复副本）。刷新页面后生效，继续？")) return;
      toast("#cs-msg", "下载中…");
      cloudDownload().then(
        (r) => {
          toast("#cs-msg", "已恢复 · tick " + r.tick + " · 刷新页面后生效");
          setTimeout(() => location.reload(), 1600);
        },
        (e) => toast("#cs-msg", "恢复失败: " + e.message, true),
      );
    };

    // leaderboard tab — auto-fills from the live world (deep engine data)
    var loadBoard = () => {
      apiFetch("/v1/scores?limit=10").then(
        (out) => {
          var list = panel.querySelector("#lb-list");
          list.innerHTML = (out.leaderboard || []).length
            ? out.leaderboard
                .map((r) => "<li><b>" + esc(r.name) + "</b> — " + Number(r.score).toLocaleString() + " <span class='muted'>(" + esc(r.epoch) + " eras · tick " + Number(r.tick).toLocaleString() + ")</span></li>")
                .join("")
            : "<li>还没有记录，成为第一个。</li>";
        },
        (e) => toast("#lb-msg", "读取失败: " + e.message, true),
      );
    };
    panel.querySelector("#lb-ref").onclick = loadBoard;
    panel.querySelector("#lb-sub").onclick = () => {
      toast("#lb-msg", "读取当前世界数据…");
      readWorldData({ events: 4 }).then(
        (data) => {
          var name = panel.querySelector("#lb-name").value.trim() ||
            (data.tribes[0] && data.tribes[0].name) || "";
          if (!name) {
            panel.querySelector("#lb-name").focus();
            return toast("#lb-msg", "没有读到部族名 — 手动填一个文明名再提交", true);
          }
          panel.querySelector("#lb-name").value = name;
          if (!data.tick) return toast("#lb-msg", "本地没有世界存档（先游玩并保存一次）", true);
          var body = {
            name: name,
            score: data.tick,
            tick: data.tick,
            epoch: data.epoch || 0,
          };
          return apiFetch("/v1/scores", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).then(
            (r) => {
              if (r && r.ok) {
                toast("#lb-msg", "已提交：" + name + " · tick " + data.tick + " · 时代 " + (data.era || "?"));
                loadBoard();
              }
            },
            (e) => toast("#lb-msg", "提交失败: " + e.message, true),
          );
        },
        (e) => toast("#lb-msg", "读取世界数据失败: " + e.message, true),
      );
    };
    // prefill the name from the live world once the tab is opened
    panel.querySelectorAll(".tab").forEach(function (tab) {
      var orig = tab.onclick;
      tab.onclick = () => {
        if (orig) orig();
        if (tab.getAttribute("data-tab") === "board" && !panel.querySelector("#lb-name").value) {
          readWorldData({ events: 2 }).then((data) => {
            if (!panel.querySelector("#lb-name").value && data.tribes[0]) {
              panel.querySelector("#lb-name").value = data.tribes[0].name;
              panel.querySelector("#lb-name").placeholder = data.tribes[0].name;
            }
          }).catch(() => {});
        }
      };
    });
    loadBoard();

    // chronicle tab v2 — one click, fed by the LIVE world (no manual typing)
    panel.querySelector("#lc-go").onclick = () => {
      var out = panel.querySelector("#lc-out");
      var dataBox = panel.querySelector("#lc-data");
      out.textContent = "读取当前世界数据…";
      readWorldData({ events: 12 }).then(
        (data) => {
          var nameInput = panel.querySelector("#lc-name");
          var name = nameInput.value.trim() || (data.tribes[0] && data.tribes[0].name) || "";
          if (name) nameInput.value = name;
          var statusSel = panel.querySelector("#lc-status");
          var status = statusSel.value;
          if (status === "auto") {
            status = data.population == null || data.population > 0 ? "living" : "fallen";
          }
          // show exactly what was auto-fed
          var chips = [];
          if (data.population != null) chips.push("人口 " + data.population);
          if (data.era) chips.push("时代 " + data.era);
          if (data.tick != null) chips.push("tick " + data.tick);
          chips.push("部族 " + data.tribes.length + " 个");
          chips.push("事件 " + data.events.length + " 条");
          dataBox.innerHTML = chips.map((c) => "<span class='badge mid'>" + esc(c) + "</span>").join(" ");
          out.innerHTML = '<span class="spin">✦</span> AI 撰写中…（约 2-5 秒）';
          var body = {
            name: name || "这个世界",
            score: data.tick || 0,
            epoch: data.epoch || 0,
            status: status,
            lang: "zh",
            world: {
              population: data.population,
              era: data.era,
              weather: data.weather,
              season: data.season,
              dayPhase: data.dayPhase,
              tick: data.tick,
              tribes: data.tribes.slice(0, 8).map((t) => ({ name: t.name, count: t.count, mood: t.mood })),
              events: data.events.slice(-10),
            },
          };
          apiFetch("/v1/chronicle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).then(
            (r) => {
              out.innerHTML =
                "<div class='bubble'>" + mdToHtml(r.chronicle) + "</div>" +
                "<div class='muted' style='margin-top:4px'>（" + (r.source === "workers-ai" ? "AI 生成" : "确定性回退") + " · " + (r.status === "living" ? "存续文明" : "陨落文明") + "）</div>";
              pushLog("sys", "📜 编年史已生成：" + String(r.chronicle).slice(0, 60) + "…");
            },
            (e) => { out.textContent = "失败: " + e.message; },
          );
        },
        (e) => { out.textContent = "读取世界数据失败: " + e.message; },
      );
    };

    // ── agent tab wiring ──
    if (!localStorage.getItem(LS_PERMS)) {
      localStorage.setItem(LS_PERMS, JSON.stringify({ game: true, dom: false, eval: false }));
    }
    var p = perms();
    panel.querySelector("#pm-game").checked = !!p.game;
    panel.querySelector("#pm-dom").checked = !!p.dom;
    panel.querySelector("#pm-eval").checked = !!p.eval;
    ["game", "dom", "eval"].forEach(function (k) {
      panel.querySelector("#pm-" + k).onchange = (ev) => {
        var cur = perms();
        cur[k] = ev.target.checked;
        localStorage.setItem(LS_PERMS, JSON.stringify(cur));
        if (k === "eval" && ev.target.checked) chatMsg("sys", "⚠ page_eval 已开放：AI 可在本页执行任意 JavaScript", null, false);
        panel.querySelectorAll(".modebtn").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-mode") === currentMode()); });
      };
    });
    panel.querySelectorAll(".modebtn").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-mode") === currentMode());
      b.onclick = () => applyMode(b.getAttribute("data-mode"));
    });

    panel.querySelector("#ag-direct").checked = directMode();
    panel.querySelector("#ag-direct").onchange = (ev) => {
      localStorage.setItem(LS_DIRECT, ev.target.checked ? "1" : "0");
      chatMsg("sys", "连接方式已切换为" + (ev.target.checked ? "直连 workers.dev" : "本站同源代理") + "，重新连接…", null, false);
      if (wsWant || wsAlive) { wsWant = true; connectAgent(false); }
    };

    buildModelSelect(null);

    var savedCustom = currentCustom();
    if (savedCustom) {
      panel.querySelector("#ag-baseurl").value = savedCustom.baseUrl || "";
      panel.querySelector("#ag-modelname").value = savedCustom.model || "";
      panel.querySelector("#ag-apikey").value = savedCustom.apiKey || "";
      panel.querySelector("#ag-vision").checked = savedCustom.vision !== false;
    }
    panel.querySelector("#ag-model").onchange = modelVisibility;
    modelVisibility();
    panel.querySelector("#ag-preset").onchange = (ev) => {
      var preset = ENDPOINT_PRESETS[Number(ev.target.value)];
      if (preset && preset.baseUrl) {
        panel.querySelector("#ag-baseurl").value = preset.baseUrl;
        if (preset.hint) panel.querySelector("#ag-modelname").placeholder = preset.hint;
      }
    };
    panel.querySelector("#ag-save").onclick = () => saveCustom();
    panel.querySelector("#ag-test").onclick = () => testCustom();
    panel.querySelector("#ag-key-test").onclick = () => testProviderKey();
    var providerKeyInput = panel.querySelector("#ag-provider-key");
    if (providerKeyInput) {
      providerKeyInput.addEventListener("change", function () {
        var p = currentProvider();
        if (!p) return;
        saveProviderKey(p.id, providerKeyInput.value.trim());
        buildModelSelect(null); // refresh the 已填/未填 group labels
        toast("#ag-key-msg", "Key 已保存到本浏览器（仅随请求发送，不存服务器）");
      });
    }
    panel.querySelector("#ag-reset").onclick = () => {
      agentSend({ type: "reset" });
      clearChat();
      chatMsg("sys", "对话已清空");
    };
    panel.querySelectorAll(".chips button").forEach(function (b) {
      b.onclick = () => quickAction(b.getAttribute("data-q"));
    });
    var sendBtn = panel.querySelector("#ag-send");
    sendBtn.onclick = () => { if (busy) stopChat(); else sendChat(); };
    var input = panel.querySelector("#ag-input");
    input.onkeydown = (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        if (!busy) sendChat();
      }
    };
    input.oninput = () => {
      input.style.height = "44px";
      input.style.height = Math.min(120, input.scrollHeight) + "px";
    };

    // direct command bar
    var cmdInput = panel.querySelector("#cmd-input");
    var cmdList = panel.querySelector("#cmd-list");
    panel.querySelector("#cmd-run").onclick = () => runDirect(cmdInput.value);
    cmdInput.oninput = () => { acIndex = -1; renderAcList(); };
    cmdInput.onfocus = () => renderAcList();
    cmdInput.onblur = () => setTimeout(() => { cmdList.style.display = "none"; }, 180);
    cmdInput.onkeydown = (ev) => {
      if (cmdList.style.display === "block" && acItems.length) {
        if (ev.key === "ArrowDown") { ev.preventDefault(); acIndex = Math.min(acIndex + 1, acItems.length - 1); renderAcList(); return; }
        if (ev.key === "ArrowUp") { ev.preventDefault(); acIndex = Math.max(acIndex - 1, 0); renderAcList(); return; }
        if (ev.key === "Tab" || (ev.key === "Enter" && acIndex >= 0)) { ev.preventDefault(); applyAc(acItems[acIndex >= 0 ? acIndex : 0]); return; }
        if (ev.key === "Escape") { cmdList.style.display = "none"; return; }
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        runDirect(cmdInput.value);
        return;
      }
      if (ev.key === "ArrowUp" && !cmdInput.value.trim()) {
        ev.preventDefault();
        if (cmdHistory.length) { histIdx = histIdx === -1 ? cmdHistory.length - 1 : Math.max(0, histIdx - 1); cmdInput.value = cmdHistory[histIdx]; }
        return;
      }
      if (ev.key === "ArrowDown" && histIdx !== -1) {
        ev.preventDefault();
        histIdx = Math.min(histIdx + 1, cmdHistory.length - 1);
        if (histIdx === cmdHistory.length - 1) { histIdx = -1; cmdInput.value = ""; }
        else cmdInput.value = cmdHistory[histIdx];
      }
    };

    // restore the local chat log
    try { logEntries = JSON.parse(localStorage.getItem(LS_LOG)) || []; } catch (e) { logEntries = []; }
    restoreLog();

    // live world bar
    refreshWorldBar();
    setInterval(refreshWorldBar, 2500);
  }

  function isAgentTab() {
    var t = panel && panel.querySelector(".tab.on");
    return !!t && t.getAttribute("data-tab") === "agent";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildPanel);
  } else {
    buildPanel();
  }
})();
