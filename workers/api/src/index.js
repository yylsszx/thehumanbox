/**
 * TheHumanBox super backend — one Cloudflare Worker, five free services.
 *
 *   Workers      the API itself                       (100k requests/day)
 *   KV           cloud saves + cached stats snapshots  (100k reads/day, 25 MiB values)
 *   D1           SQLite: save index / leaderboard / events (100k writes/day)
 *   Workers AI   civilization chronicle generation    (10k neurons/day)
 *   Cron         daily stats rollup + retention prune (free)
 *
 * The browser game is a static SPA on Cloudflare Pages; this worker gives it
 * an optional server side without any server to run. Every endpoint is
 * unauthenticated but validated + rate limited, because this is a public
 * game backend, not a bank. Cloud save "codes" act as bearer secrets.
 *
 * Endpoints (full docs: docs/SUPER_BACKEND.md):
 *   GET  /                     landing page + live endpoint tester
 *   GET  /health               liveness + version
 *   POST /v1/saves             {code, data}        upsert a cloud save (≤ 8 MiB, stored in KV)
 *   GET  /v1/saves/:code       -> {code, data, updated_at}
 *   POST /v1/scores            {name, score, ...}  submit a leaderboard run
 *   GET  /v1/scores?limit=10   -> leaderboard
 *   POST /v1/events            {kind, payload}     telemetry ingest
 *   GET  /v1/stats             global counters (KV snapshot, cron-refreshed)
 *   POST /v1/chronicle         rich live-world chronicle — living OR fallen
 *
 * Chronicle v2 (player feedback: "编年史怎么能只给灭亡文明？还要手填数据？"):
 *   the panel auto-attaches the civilization's LIVE data (tribes with names
 *   and populations, era, weather, season, tick, recent events); living
 *   civilizations get an ongoing-era chronicle, fallen ones an epilogue.
 *   {name, score, epoch} alone still works (v1 clients / smoke tests).
 */

const VERSION = "1.2.0";
const SERVICE = "thehumanbox-api";

// 8 MiB — well under KV's 25 MiB value cap, and roomy for a compressed
// world blob base64'd (a 0.9.x own-world save packs to a few hundred KiB).
// v1.0.0 kept saves in D1 rows, which capped them at 256 KiB; v1.1.0 stores
// the payload in KV and leaves a tiny index row in D1 for counting + the
// backward-compatible read path.
const MAX_SAVE_BYTES = 8388608;
const MAX_EVENT_BYTES = 8192;
const MAX_NAME_CHARS = 24;
const TOP_SCORES_KEPT = 100;
const EVENT_RETENTION_DAYS = 30;
const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/;
// Verified against GET /accounts/{id}/ai/models/search on 2026-11-25
// (llama-3.1-8b-instruct has been retired from Workers AI).
// Measured 2026-11-26: llama-4-scout ≈15s full round-trip vs fp8-fast ≈2-4s —
// the chronicle is a click-and-read feature, so it uses the fast one.
const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Best-effort, per-isolate rate limiting. Not a security boundary —
// just keeps a single enthusiastic client from melting the free quotas.
const buckets = new Map();
function allow(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    if (buckets.size > 8192) {
      for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
    }
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      ...extra,
    },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_SAVE_BYTES + 65536) throw new ApiError(413, "body too large");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid JSON body");
  }
}

function sanitizeName(raw) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_NAME_CHARS);
}

function clampInt(raw, min, max, dflt) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function ip(request) {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function bump(env, name, by = 1) {
  try {
    await env.DB.prepare(
      "INSERT INTO counters (name, n) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET n = n + excluded.n",
    )
      .bind(name, by)
      .run();
  } catch {
    // counters are best-effort telemetry, never fail a request over them
  }
}

// ── saves (KV payload + D1 index row) ─────────────────────────────────

const SAVE_KEY = (code) => "save:" + code;

async function putSave(env, ctx, body) {
  const code = body?.code;
  if (typeof code !== "string" || !CODE_RE.test(code)) {
    throw new ApiError(400, "code must match ^[A-Za-z0-9_-]{16,128}$ (generate one with crypto.randomUUID())");
  }
  if (body?.data === undefined || body?.data === null) {
    throw new ApiError(400, "data is required");
  }
  const serialized = JSON.stringify(body.data);
  if (serialized.length > MAX_SAVE_BYTES) {
    throw new ApiError(413, `save too large: ${serialized.length} > ${MAX_SAVE_BYTES} bytes`);
  }
  const now = new Date().toISOString();
  // KV holds the payload; D1 keeps a tiny index row so COUNT(*) still works
  // and older readers (v1.0.0) keep functioning during the transition.
  await Promise.all([
    env.KV.put(SAVE_KEY(code), serialized, { metadata: { updated_at: now, bytes: serialized.length } }),
    env.DB.prepare(
      "INSERT INTO saves (code, data, updated_at) VALUES (?, '[]', ?) " +
        "ON CONFLICT(code) DO UPDATE SET updated_at = excluded.updated_at",
    )
      .bind(code, now)
      .run(),
  ]);
  ctx.waitUntil(bump(env, "saves_written"));
  return json({ ok: true, code, bytes: serialized.length, updated_at: now }, 200, {
    "Cache-Control": "no-store",
  });
}

async function getSave(env, ctx, code) {
  if (!CODE_RE.test(code)) throw new ApiError(400, "bad save code");
  // KV first (v1.1.0 layout) ...
  const { value, metadata } = await env.KV.getWithMetadata(SAVE_KEY(code), "text");
  if (value !== null) {
    return json({ ok: true, code, updated_at: metadata?.updated_at ?? null, data: JSON.parse(value) });
  }
  // ... then a v1.0.0 row in D1, lazily migrated into KV.
  const row = await env.DB.prepare("SELECT data, updated_at FROM saves WHERE code = ?")
    .bind(code)
    .first();
  if (!row || row.data === "[]") throw new ApiError(404, "no save stored under this code");
  ctx.waitUntil(
    env.KV.put(SAVE_KEY(code), row.data, { metadata: { updated_at: row.updated_at, bytes: row.data.length } }).catch(() => {}),
  );
  return json({ ok: true, code, updated_at: row.updated_at, data: JSON.parse(row.data) });
}

// ── leaderboard ───────────────────────────────────────────────────────

async function postScore(env, ctx, body) {
  const name = sanitizeName(body?.name);
  if (!name) throw new ApiError(400, "name is required (1-24 chars)");
  const score = Number(body?.score);
  if (!Number.isFinite(score) || score < 0 || score > 1e12) {
    throw new ApiError(400, "score must be a number in [0, 1e12]");
  }
  const tick = clampInt(body?.tick, 0, 1e12, 0);
  const epoch = clampInt(body?.epoch, 0, 1e12, 0);
  const now = new Date().toISOString();
  const meta = await env.DB.prepare(
    "INSERT INTO scores (name, score, tick, epoch, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(name, score, tick, epoch, now)
    .run();
  ctx.waitUntil(
    (async () => {
      await bump(env, "scores_written");
      // keep the table at the TOP_SCORES_KEPT best runs
      await env.DB.prepare(
        "DELETE FROM scores WHERE id NOT IN " +
          "(SELECT id FROM scores ORDER BY score DESC, created_at ASC LIMIT ?)",
      )
        .bind(TOP_SCORES_KEPT)
        .run();
    })(),
  );
  return json({ ok: true, id: meta?.meta?.last_row_id ?? null }, 201, { "Cache-Control": "no-store" });
}

async function getScores(env, url) {
  const limit = clampInt(url.searchParams.get("limit"), 1, 50, 10);
  const { results } = await env.DB.prepare(
    "SELECT name, score, tick, epoch, created_at FROM scores " +
      "ORDER BY score DESC, created_at ASC LIMIT ?",
  )
    .bind(limit)
    .all();
  return json({ ok: true, leaderboard: results ?? [] }, 200, {
    "Cache-Control": "public, max-age=30",
  });
}

// ── events ────────────────────────────────────────────────────────────

async function postEvent(env, ctx, body) {
  const kind = String(body?.kind ?? "").trim().slice(0, 32);
  if (!kind) throw new ApiError(400, "kind is required");
  let payload = null;
  if (body?.payload !== undefined && body?.payload !== null) {
    payload = JSON.stringify(body.payload).slice(0, MAX_EVENT_BYTES);
  }
  const now = new Date();
  await env.DB.prepare("INSERT INTO events (kind, payload, day, ts) VALUES (?, ?, ?, ?)")
    .bind(kind, payload, now.toISOString().slice(0, 10), now.toISOString())
    .run();
  ctx.waitUntil(bump(env, "events_ingested"));
  return json({ ok: true }, 202, { "Cache-Control": "no-store" });
}

// ── stats ─────────────────────────────────────────────────────────────

async function statsFromD1(env) {
  const [saves, scores, events, top] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM saves").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM scores").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM events").first(),
    env.DB.prepare(
      "SELECT name, score, tick, epoch, created_at FROM scores ORDER BY score DESC LIMIT 1",
    ).first(),
  ]);
  return {
    version: VERSION,
    generated_at: new Date().toISOString(),
    saves: saves?.n ?? 0,
    scores: scores?.n ?? 0,
    events: events?.n ?? 0,
    top_run: top ?? null,
  };
}

async function getStats(env, ctx) {
  let cached = null;
  try {
    cached = await env.KV.get("stats:latest", "json");
  } catch {
    // KV hiccup is not fatal — fall through to a live D1 read
  }
  if (cached && cached.version === VERSION) {
    return json({ ok: true, source: "kv", ...cached }, 200, {
      "Cache-Control": "public, max-age=60",
    });
  }
  const snapshot = await statsFromD1(env);
  ctx.waitUntil(
    env.KV.put("stats:latest", JSON.stringify(snapshot)).catch(() => {}),
  );
  return json({ ok: true, source: "d1", ...snapshot });
}

// ── chronicle v2 (Workers AI) ────────────────────────────────────────

function isLiving(body) {
  if (typeof body?.status === "string" && body.status) return body.status !== "fallen";
  // v1 clients send no world at all — keep the old (fallen) semantics.
  if (!body?.world || typeof body.world !== "object") return false;
  const pop = Number(body.world.population);
  return Number.isFinite(pop) ? pop > 0 : true;
}

/** The civilization's live data, as one compact block for the prompt. */
function worldDataLines(body) {
  const w = body?.world && typeof body.world === "object" ? body.world : null;
  if (!w) return "";
  const lines = [];
  if (w.population != null) lines.push(`- 人口：${w.population}`);
  if (w.era) lines.push(`- 时代：${w.era}`);
  if (w.season) lines.push(`- 季节/昼夜：${w.season}${w.dayPhase ? "，" + w.dayPhase : ""}`);
  if (w.weather) lines.push(`- 天气：${w.weather}`);
  if (w.tick != null) lines.push(`- 存续 tick：${w.tick}`);
  if (Array.isArray(w.tribes) && w.tribes.length) {
    lines.push("- 部族：" + w.tribes.slice(0, 8).map((t) => `${t.name}（${t.count} 人${t.mood ? "，" + t.mood : ""}）`).join("、"));
  }
  if (Array.isArray(w.events) && w.events.length) {
    lines.push("- 近期大事：\n" + w.events.slice(-8).map((e) => "  · " + String(e).slice(0, 120)).join("\n"));
  }
  return lines.length ? lines.join("\n") : "";
}

function chronicleMessages(body) {
  const living = isLiving(body);
  const name = String(body?.name ?? "").trim() || "无名文明";
  const score = Number(body?.score) || 0;
  const epoch = Number(body?.epoch) || 0;
  const data = worldDataLines(body);
  return [
    {
      role: "system",
      content:
        "你是《The Human Box》浏览器文明模拟游戏的编年史官，用中文写史。规则：只忠实使用给定的真实数据（人口、时代、部族、事件、tick），不得编造具体数字；像史书一样有画面感；不用列表、不用标题、不用英文；总长 5 到 8 句。",
    },
    {
      role: "user",
      content:
        `为文明「${name}」撰写编年史。存续 tick：${score}；历经时代数：${epoch}；状态：${living ? "存续中（写当下的格局，结尾展望它的未来）" : "已陨落（写它的落幕与留下的遗产）"}。\n` +
        (data ? `真实世界数据（必须使用这些数据）：\n${data}\n` : "没有实时数据，只依据 tick 与时代数写作。\n") +
        "现在写下这部编年史。",
    },
  ];
}

/** Deterministic fallback — also built from the LIVE world data. */
function fallbackChronicle(body) {
  const living = isLiving(body);
  const name = String(body?.name ?? "").trim() || "无名文明";
  const score = Number(body?.score) || 0;
  const epoch = Number(body?.epoch) || 0;
  const w = body?.world && typeof body.world === "object" ? body.world : null;
  const tribes = Array.isArray(w?.tribes) ? w.tribes.filter((t) => t && t.name) : [];
  const lead = tribes[0] ? tribes[0].name : "";
  const names = tribes.slice(0, 4).map((t) => t.name);
  const events = Array.isArray(w?.events) ? w.events.filter(Boolean) : [];
  const facts = [];
  if (w?.population != null) facts.push(`如今人口 ${w.population}`);
  if (w?.era) facts.push(`身处 ${w.era} 时代`);
  if (w?.season) facts.push(`值此${w.season}`);
  if (w?.weather) facts.push(`天地${w.weather}`);
  if (score) facts.push(`史册记到第 ${score} 个 tick`);
  const factLine = facts.length ? facts.join("，") + "。" : "";
  const tribeLine = names.length ? (names.length > 1 ? `诸部族之中，${lead} 声势最盛，${names.slice(1).join("、")} 各据一方。` : `${lead} 一族独大。`) : "";
  const eventLine = events.length ? `近来之事：${events.slice(-3).join("；")}。` : "";
  const seed = Array.from(String(body?.name ?? "") + ":" + score + ":" + epoch + (living ? "L" : "F")).reduce((a, c) => a + c.charCodeAt(0), 0);
  if (living) {
    const endings = [
      `史官搁笔于此：${name} 的故事还没有讲完，下一页留给明天。`,
      `这一页写完了，而 ${name} 的火还在烧。`,
      `卷末只留一句：${name}，继续。`,
    ];
    return `${name} 的故事仍在书写。${factLine}${tribeLine}${eventLine}${endings[seed % endings.length]}`;
  }
  const endings = [
    `${name} 的终章就此合卷，此后只有风替它翻页。`,
    `没有人为 ${name} 收起最后一盏灯，但史册记下了它的名字。`,
    `${name} 沉入沉默，正如它曾经悄悄燃起。`,
  ];
  const tally = `它的存续刻度停在 ${score} 个 tick、${epoch} 个时代。`;
  return `${name} 已成过往。${factLine}${tribeLine}${eventLine}${tally}${endings[seed % endings.length]}`;
}

async function postChronicle(request, env, ctx, clientIp) {
  if (!allow("chronicle:" + clientIp, 10, 3600000)) {
    throw new ApiError(429, "rate limit: 10 chronicles per hour");
  }
  const body = await readJson(request);
  const name = sanitizeName(body?.name) || "The Nameless";
  const score = Number.isFinite(Number(body?.score)) ? Number(body.score) : 0;
  const epoch = clampInt(body?.epoch, 0, 1e9, 0);
  let text = null;
  let source = "fallback";
  if (env.AI) {
    try {
      const out = await env.AI.run(AI_MODEL, {
        messages: chronicleMessages(body),
        max_tokens: 420,
      });
      const t = out && out.response ? String(out.response).trim() : null;
      if (t) {
        text = t;
        source = "workers-ai";
      }
    } catch {
      // AI unavailable (quota, region, model) — deterministic fallback below
    }
  }
  if (!text) text = fallbackChronicle(body);
  ctx.waitUntil(bump(env, "chronicles_served"));
  return json({ ok: true, source, name, score, epoch, status: isLiving(body) ? "living" : "fallen", chronicle: text });
}

// ── cron: daily rollup + retention ────────────────────────────────────

async function rollup(env) {
  const today = new Date().toISOString().slice(0, 10);
  const [saves, scores, events, eventsToday, top] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM saves").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM scores").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM events").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE day = ?").bind(today).first(),
    env.DB.prepare(
      "SELECT name, score, tick, epoch, created_at FROM scores ORDER BY score DESC LIMIT 1",
    ).first(),
  ]);
  const snapshot = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    saves: saves?.n ?? 0,
    scores: scores?.n ?? 0,
    events: events?.n ?? 0,
    events_today: eventsToday?.n ?? 0,
    top_run: top ?? null,
  };
  await env.KV.put("stats:latest", JSON.stringify(snapshot));
  await env.KV.put("stats:daily:" + today, JSON.stringify(snapshot));
  await env.DB.prepare("DELETE FROM events WHERE ts < datetime('now', ?)")
    .bind("-" + EVENT_RETENTION_DAYS + " days")
    .run();
  await env.DB.prepare(
    "DELETE FROM scores WHERE id NOT IN " +
      "(SELECT id FROM scores ORDER BY score DESC, created_at ASC LIMIT ?)",
  )
    .bind(TOP_SCORES_KEPT)
    .run();
}

// ── router ────────────────────────────────────────────────────────────

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } });

  if (path === "/" && method === "GET") return landingPage();

  if (path === "/health" && method === "GET") {
    return json({ ok: true, service: SERVICE, version: VERSION, time: new Date().toISOString() });
  }

  if (path === "/v1/saves" && method === "POST") {
    if (!allow("saves:" + ip(request), 30, 60000)) throw new ApiError(429, "rate limit: 30 saves/min");
    return putSave(env, ctx, await readJson(request));
  }
  const saveMatch = /^\/v1\/saves\/([A-Za-z0-9_-]{16,128})$/.exec(path);
  if (saveMatch && method === "GET") return getSave(env, ctx, saveMatch[1]);

  if (path === "/v1/scores" && method === "GET") return getScores(env, url);
  if (path === "/v1/scores" && method === "POST") {
    if (!allow("scores:" + ip(request), 10, 60000)) throw new ApiError(429, "rate limit: 10 scores/min");
    return postScore(env, ctx, await readJson(request));
  }

  if (path === "/v1/events" && method === "POST") {
    if (!allow("events:" + ip(request), 60, 60000)) throw new ApiError(429, "rate limit: 60 events/min");
    return postEvent(env, ctx, await readJson(request));
  }

  if (path === "/v1/stats" && method === "GET") return getStats(env, ctx);

  if (path === "/v1/chronicle" && method === "POST") {
    return postChronicle(request, env, ctx, ip(request));
  }

  throw new ApiError(404, "not found — see / for the endpoint list");
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) console.error("unhandled:", err);
      return json({ ok: false, error: String(err?.message ?? err) }, status);
    }
  },
  async scheduled(_event, env, _ctx) {
    await rollup(env);
  },
};

// ── landing page (inline, dependency-free) ────────────────────────────

function landingPage() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TheHumanBox · Super Backend</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         background: #0b0f14; color: #c9d4de; padding: 32px 16px 64px; }
  .wrap { max-width: 780px; margin: 0 auto; }
  h1 { font-size: 22px; color: #e8f0f8; margin: 0 0 4px; }
  h1 span { color: #f6a623; }
  .sub { color: #6d7f8f; margin: 0 0 20px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 28px; }
  .chip { border: 1px solid #22303c; border-radius: 999px; padding: 3px 12px; font-size: 12px; color: #8fa3b3; }
  .chip b { color: #6ee7a0; font-weight: 600; }
  section { border: 1px solid #1b2833; border-radius: 10px; padding: 16px 18px; margin: 14px 0; background: #0e141b; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #7fa0b8; margin: 0 0 8px; }
  code { color: #f6a623; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  button { font: inherit; font-size: 13px; background: #16222d; color: #cfe3f2; border: 1px solid #2a3d4d;
           border-radius: 7px; padding: 6px 14px; cursor: pointer; }
  button:hover { border-color: #f6a623; color: #fff; }
  pre { margin: 10px 0 0; padding: 12px; background: #080c10; border: 1px solid #16222d; border-radius: 7px;
        overflow: auto; max-height: 260px; font-size: 12.5px; color: #9fd0a8; white-space: pre-wrap; }
  .desc { color: #7d8f9e; font-size: 13px; margin: 0 0 8px; }
  footer { margin-top: 30px; color: #4e6070; font-size: 12px; }
  a { color: #f6a623; }
</style>
</head>
<body>
<div class="wrap">
  <h1>TheHumanBox <span>super backend</span></h1>
  <p class="sub">Free-tier Cloudflare stack behind the game: Workers + KV + D1 + Workers AI + Cron Triggers.</p>
  <div class="chips">
    <span class="chip">workers <b id="c-health">…</b></span>
    <span class="chip">kv · d1 <b id="c-stats">…</b></span>
    <span class="chip">workers-ai <b id="c-ai">…</b></span>
    <span class="chip">cron <b>daily 02:30 UTC</b></span>
  </div>

  <section>
    <h2>GET /health</h2>
    <div class="row"><button onclick="run(this, '/health')">Check</button><span class="desc">liveness + version</span></div>
    <pre class="out" hidden></pre>
  </section>

  <section>
    <h2>POST /v1/saves → GET /v1/saves/:code</h2>
    <p class="desc">Cloud saves. The client invents a random code (its secret), stores it in localStorage, and syncs the whole save object. Max 8 MiB, payload kept in KV.</p>
    <div class="row"><button onclick="saveRoundtrip(this)">Round-trip test</button></div>
    <pre class="out" hidden></pre>
  </section>

  <section>
    <h2>POST /v1/scores → GET /v1/scores</h2>
    <p class="desc">Leaderboard of finished runs. Top 100 kept, scores read-cached 30s.</p>
    <div class="row">
      <button onclick="postScore(this)">Submit random run</button>
      <button onclick="run(this, '/v1/scores?limit=5')">Leaderboard</button>
    </div>
    <pre class="out" hidden></pre>
  </section>

  <section>
    <h2>POST /v1/events</h2>
    <p class="desc">Telemetry ingest, batched into D1 and pruned after 30 days.</p>
    <div class="row"><button onclick="postEvent(this)">Send test event</button></div>
    <pre class="out" hidden></pre>
  </section>

  <section>
    <h2>GET /v1/stats</h2>
    <p class="desc">Global counters, served from KV after the daily cron rollup.</p>
    <div class="row"><button onclick="run(this, '/v1/stats')">Stats</button></div>
    <pre class="out" hidden></pre>
  </section>

  <section>
    <h2>POST /v1/chronicle</h2>
    <p class="desc">Workers AI writes a chronicle for a civilization — <b>living or fallen</b> — from the live world data the panel auto-attaches (tribes, population, era, events). Falls back to a deterministic one built from the same data if the AI quota is spent.</p>
    <div class="row"><button onclick="postChronicle(this)">Chronicle a civilization</button></div>
    <pre class="out" hidden></pre>
  </section>

  <footer>
    Game: <a href="https://thehumanbox-upstream.pages.dev">thehumanbox-upstream.pages.dev</a> ·
    Mirror repo: <a href="https://github.com/yylsszx/thehumanbox-upstream">yylsszx/thehumanbox-upstream</a> ·
    Docs: <a href="https://github.com/yylsszx/thehumanbox-upstream/blob/main/docs/SUPER_BACKEND.md">docs/SUPER_BACKEND.md</a>
  </footer>
</div>
<script>
  function show(btn, status, body) {
    var pre = btn.closest('section').querySelector('pre.out');
    pre.hidden = false;
    pre.textContent = 'HTTP ' + status + '\\n' + JSON.stringify(body, null, 2);
  }
  async function call(btn, path, opts) {
    btn.disabled = true;
    try {
      var r = await fetch(path, opts);
      var b = await r.json().catch(function () { return { raw: 'non-JSON' }; });
      show(btn, r.status, b);
      return b;
    } catch (e) {
      show(btn, 0, { error: String(e) });
    } finally {
      btn.disabled = false;
    }
  }
  function run(btn, path) { return call(btn, path); }
  function rnd(n) { var s = ''; var a = 'abcdefghijkmnpqrstuvwxyz23456789';
    for (var i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
  async function saveRoundtrip(btn) {
    var code = 'test-' + rnd(20);
    var b = await call(btn, '/v1/saves', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, data: { hello: 'super backend', at: Date.now() } }) });
    if (b && b.ok) await call(btn, '/v1/saves/' + code);
  }
  function postScore(btn) {
    return call(btn, '/v1/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'tester-' + rnd(4), score: Math.floor(Math.random() * 9000) + 100, tick: 5000, epoch: 3 }) });
  }
  function postEvent(btn) {
    return call(btn, '/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'backend_demo', payload: { page: 'landing' } }) });
  }
  function postChronicle(btn) {
    return call(btn, '/v1/chronicle', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' testers-of-' + rnd(3), score: Math.floor(Math.random() * 4000), epoch: 2 }) });
  }
  (async function () {
    try {
      var h = await (await fetch('/health')).json();
      document.getElementById('c-health').textContent = 'v' + h.version + ' ok';
    } catch (e) { document.getElementById('c-health').textContent = 'down'; }
    try {
      var s = await (await fetch('/v1/stats')).json();
      document.getElementById('c-stats').textContent = s.saves + ' saves · ' + s.scores + ' runs · ' + s.events + ' events';
    } catch (e) { document.getElementById('c-stats').textContent = '?'; }
    try {
      var c = await (await fetch('/v1/chronicle', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Boot Check', score: 42, epoch: 1 }) })).json();
      document.getElementById('c-ai').textContent = c.source === 'workers-ai' ? 'live' : 'fallback';
    } catch (e) { document.getElementById('c-ai').textContent = '?'; }
  })();
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}
