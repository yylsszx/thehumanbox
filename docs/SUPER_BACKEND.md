# TheHumanBox Super Backend

This repo is a **mirror of upstream [`1homsi/thehumanbox`](https://github.com/1homsi/thehumanbox)**,
kept current by a daily GitHub Actions sync, deployed to **Cloudflare Pages**, and backed by a
**free-tier serverless backend** built out of Cloudflare Workers and friends.

| Piece | URL / resource |
| --- | --- |
| The game (Cloudflare Pages) | https://thehumanbox-upstream.pages.dev |
| Same-origin API proxy | `https://thehumanbox-upstream.pages.dev/api/*` → the API worker |
| Same-origin agent proxy | `https://thehumanbox-upstream.pages.dev/agent/*` → the DevAgent (WS included) |
| The API (Workers) | https://thehumanbox-api.yeyilin2010.workers.dev |
| API landing page + live tester | https://thehumanbox-api.yeyilin2010.workers.dev/ |
| The DevAgent (Agents SDK) | https://thehumanbox-agent.yeyilin2010.workers.dev |
| In-game ⚡ SUPER panel | `apps/web/public/cloud-sync.js`, injected into `dist/index.html` at deploy |
| Mirror branch (pure upstream) | branch `upstream` in this repo |
| Sync workflow | `.github/workflows/upstream-sync.yml` (daily 01:00 UTC = 09:00 Beijing) |
| Deploy workflow | `.github/workflows/deploy-site.yml` (on code pushes to `main` + same-origin verification job) |

## The free-tier stack

Five Cloudflare services, all on the free plan, wired together by one Worker:

```
                      ┌────────────────────────────────────────────┐
 browser (the game)   │  thehumanbox-api (Cloudflare Worker)       │
 on Pages ── fetch ──▶│                                            │
                      │  /v1/saves      /v1/scores    /v1/events   │
                      │  /v1/stats      /v1/chronicle  /health     │
                      │       │             │            │         │
                      │       ▼             ▼            ▼         │
                      │   D1 (SQLite)   D1          Workers AI    │
                      │   saves table   scores,     chronicle      │
                      │                  events       generation   │
                      │       ▲                                      │
                      │       └── KV: stats snapshots + config     │
                      │                                            │
                      │  Cron Trigger 02:30 UTC daily:             │
                      │  rollup counters → KV, prune events/scores │
                      └────────────────────────────────────────────┘
```

| Service | Free allowance | What it does here |
| --- | --- | --- |
| Workers | 100k requests/day | the API itself, `workers/api/src/index.js` |
| KV | 100k reads, 1k writes/day | cloud save payloads (≤ 8 MiB each, since v1.1.0), cached `stats:latest` snapshot, daily `stats:daily:<date>` archives |
| D1 | 5M reads, 100k writes/day, 5 GB | save index rows, leaderboard, telemetry events |
| Workers AI | 10k neurons/day | `/v1/chronicle` — AI-written closing chronicles for a run |
| Cron Triggers | included | daily stats rollup + retention pruning |
| Pages | unlimited bandwidth | the game itself |

Write-heavy data goes to D1 (its 100k writes/day beat KV's 1k); KV holds the
read-heavy, cron-refreshed stats snapshot. Quotas are respected by design.

### Same-origin proxies (why the panel never talks to workers.dev)

`*.workers.dev` hostnames are not resolvable on many mainland-China
networks, while the game's `pages.dev` host is. Since v2 the SUPER panel
therefore talks to **same-origin** paths, served by two Pages Functions
(`apps/web/functions/`) routed via `public/_routes.json`:

| Path | Forwards to | Notes |
| --- | --- | --- |
| `/api/*` | the API worker | plain HTTP passthrough (method, headers, body) |
| `/agent/*` | the DevAgent worker | HTTP passthrough; `/agent/ws` is a full WebSocket proxy — the function `fetch`es the DO route with `Upgrade: websocket` and hands the returned 101 socket straight back to the browser, so the DO and the page communicate directly |

A "direct mode" toggle in the panel's settings switches back to the raw
workers.dev URLs (useful on networks where pages.dev is the slow one). The
`verify-same-origin` CI job re-tests the whole chain — API proxy, model
catalog, COOP/COEP headers on static assets, and a live chat round-trip
through the proxied WebSocket — after every deploy.

## Endpoints

All responses are JSON with `ok: true|false`; errors are `{ok:false, error}` with a
4xx/5xx status. CORS is open (`*`), no auth — the game is public. Validation and
best-effort per-IP rate limits (saves 30/min, scores 10/min, events 60/min,
chronicle 5/hour) keep the free quotas safe.

| Method & path | Body | Result |
| --- | --- | --- |
| `GET /health` | — | `{ok, service, version, time}` |
| `POST /v1/saves` | `{code, data}` | upserts a cloud save (≤ 8 MiB, payload in KV since v1.1.0). `code` is the client's secret: `^[A-Za-z0-9_-]{16,128}$`, e.g. `crypto.randomUUID()` |
| `GET /v1/saves/:code` | — | `{ok, code, updated_at, data}` or 404 |
| `POST /v1/scores` | `{name, score, tick?, epoch?}` | submits a finished run; name ≤ 24 chars, score 0..1e12; top 100 kept |
| `GET /v1/scores?limit=10` | — | leaderboard, `score DESC`, cached 30 s |
| `POST /v1/events` | `{kind, payload}` | telemetry ingest; payload capped at 8 KiB, pruned after 30 days |
| `GET /v1/stats` | — | global counters (KV snapshot, cron-refreshed, live D1 fallback) |
| `POST /v1/chronicle` | `{name, score?, epoch?, status?, lang?, world?}` | v2: AI 编年史 for living OR fallen civilizations, woven from the auto-attached live world data (population, era, tribes, events); deterministic fallback built from the same data. `{name,score,epoch}` alone (v1 shape) still works |

### Using it from the game (or anywhere)

```js
// From the game page (same origin — the Pages Function proxies to the API):
const API = "/api"; // or https://thehumanbox-api.yeyilin2010.workers.dev directly

// 1. Cloud saves — generate a sync code once, keep it in localStorage.
const code = localStorage.getItem("sync-code") ?? crypto.randomUUID();
localStorage.setItem("sync-code", code);
await fetch(`${API}/v1/saves`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code, data: { world: serializedSave, version: 7 } }),
});
// ...on a new device:
const { data } = await (await fetch(`${API}/v1/saves/${code}`)).json();

// 2. Leaderboard.
await fetch(`${API}/v1/scores`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: tribeName, score, tick, epoch }),
});
const { leaderboard } = await (await fetch(`${API}/v1/scores?limit=10`)).json();

// 3. An AI-written epilogue when a civilization falls.
const { chronicle } = await (
  await fetch(`${API}/v1/chronicle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: tribeName, score, epoch }),
  })
).json();
```

The game client stays untouched at the source level (this repo mirrors
upstream). Instead, `deploy-site.yml` injects one script tag into the built
`dist/index.html`: `apps/web/public/cloud-sync.js` — the **⚡ SUPER panel**
(bottom-right of the game) with four tabs:

- **云存档** — one-click world sync: checkpoints the sim, packs the
  compressed world blob (IndexedDB `thb-own-world` / `browser-own`) into
  base64 and PUTs it to `/v1/saves` under a locally-generated sync code;
  restoring writes it back and reloads.
- **排行榜** — submits the current world (score = tick) and shows the top 10.
- **编年史** — one click: the panel auto-reads the live world (biggest tribe name, population, era, season, events, tick) and generates a Chinese chronicle for the civilization — living or fallen. No manual typing.
- **Agent** — the DevAgent console (next section).

The script also exposes `window.__THB__`, the bridge the agent drives (see
below), and — because it loads before the app — patches `window.Worker` to
capture the simulation worker's private message channel, gaining access to
the full ~100-command sandbox protocol (`SandboxCommand` in
`apps/web/src/simulation/sandbox.ts`) with true world coordinates.

Since v2 the panel uses the game's own pixel design tokens (`--px-wood`,
`--px-brass`, `--px-gold`, `--px-grain` … defined by the game's
`index.css`), so it looks like part of the game: wood frames, brass inner
lines, gold active states, notched buttons, parchment text.

## The DevAgent (super developer agent) — v4

`workers/agent` is a **Cloudflare Agents SDK** Durable Object
(`thehumanbox-agent.yeyilin2010.workers.dev`, same-origin at
`/agent/*` on the game host) that turns any chat model into a developer-level
agent that can drive the live game:

- **Model routing, per request — four ways**:
  1. any **curated Workers AI model** — each one live-verified on this
     account, grouped by tier — via the `AI` binding (free tier).
  2. **any other `@cf/...` model id** typed into the free-text field —
     validated only by shape, so new models work before the catalog catches
     up,
  3. **`provider:厂商:模型名` — BYOK provider direct connect** (v4): the
     worker calls the provider's OFFICIAL endpoint directly, streaming, no
     middleman. Providers: **智谱 GLM 全系** (`glm-5.3` / `glm-5.3-flash` /
     `glm-5.3-flashx` / `glm-5.2` / `glm-4.7-flash`（免费）/ GLM-4.x & V 系列…),
     **NaiveAI** (`naive-n0.5-flash` — up to ~2000 tok/s, `naive-n0.5-lite`),
     **Agnes 国内/国际** (`agnes-3.0-flash`（当前免费）/ `agnes-2.5-flash` /
     Pro 系列). The player's key lives in the browser's localStorage and
     travels only with each request; the agent never stores or logs it.
  4. **`custom`** — any other OpenAI-compatible endpoint (OpenAI, DeepSeek,
     Kimi, Qwen, OpenRouter, Groq, SiliconFlow, your AI Gateway, an
     Ollama/vLLM behind a tunnel…).
- **Parallel tool protocol, FIXED in v4**: v3 kept one pending slot for page
  tools, so 2+ parallel tool calls produced `unknown message type
  tool_result` errors, cross-wired results and 30s stalls. Each call now has
  its own slot keyed by request id; stale frames are dropped silently.
- **Deep engine data (v4)**: every chat message auto-attaches the civilization's
  LIVE data — tribe list with names/populations/moods (read from the game's
  own TribeList DOM), era, weather, season/day-phase, tick, recent events —
  injected into the system prompt so the model can act on round 1.
- **Screenshots fixed in v4**: the engine draws with WebGL without
  `preserveDrawingBuffer`, so reading the canvas between frames returned an
  all-black image. The panel patches `getContext` at load to keep the buffer
  readable, wakes the engine's sleeping render loop with a `pointermove`,
  reads on the next frame and retries while the capture is blank.
- **Agentic tool loop** (model-agnostic, no native tool-calling needed): the
  model answers either in plain text or with `TOOL: {"tool":…,"args":…}`
  lines; several TOOL lines run in parallel; up to 8 rounds × 5 calls; json
  fences and small-model malformed JSON tolerated.
- **Vision**: `game_screenshot` returns a downscaled JPEG of the world; when
  the current model can see it is attached to the next model call as an
  image part — the agent literally looks at the world.
- **Page tools** (executed by the browser bridge, permission-gated in the
  panel; game tools on by default): `game_command` (any sandbox command,
  true coordinates, arrays and `composite` batches), `game_control`
  (pause/resume/speed×1/×2/×4/×10/save/checkpoint), `game_state`,
  `game_screenshot`, `game_key`, `game_log`, `org_detail`/`org_life`,
  `page_key` / `page_click` / `page_read`, `page_eval` (only with the dev
  console toggle on), `cloud_save`.
- **Server tools** (run in the agent): `backend_stats`, `backend_leaderboard`,
  `backend_chronicle` — the chronicle auto-fills EVERYTHING from the live
  world snapshot when called with empty args.
- **Conversation persistence**: history lives in the DO (capped) and is
  replayed to the panel on reconnect; the panel also keeps a local log.
- **Console UX**: auto-connect on first open, auto-reconnect with backoff,
  quick-action chips (看世界 / 简报 / 编年史 / 天灾 / 福佑 / 建城 / 战争 /
  夜·昼·雨·雪·极光 / ×10 / 暂停 / 云存档), collapsible tool-call cards with
  results and screenshot thumbnails, per-reply meta (model · tool count ·
  total ms · ttft), the zero-latency direct command bar (⌘) with 94-command
  autocomplete.

Routes: `/agents/dev-agent/{name}` (WebSocket), `POST /chat` (stateless HTTP
smoke, server tools only), `GET /models` (catalog + providers), `/commands`,
`/health`, `/`.

## How the daily sync works

`.github/workflows/upstream-sync.yml` runs at 01:00 UTC (09:00 Asia/Shanghai)
and on demand. It executes `scripts/sync_upstream.py`, which talks to the
GitHub **Git Data API** only — no `git push` anywhere:

1. reads upstream `1homsi/thehumanbox`'s `main` tip and tree
2. collects our additions overlay from the current `main`
   (`workers/**`, `scripts/sync_upstream.py`, `docs/SUPER_BACKEND.md`,
   `apps/web/public/cloud-sync.js`, `apps/web/public/_routes.json`,
   `apps/web/functions/api/**`, `apps/web/functions/agent/**`, the two
   workflows, `.last-sync`) — blob shas are reused verbatim
3. builds a tree = upstream's tree + the overlay, commits it **on top of the
   upstream tip**, and force-updates `main` (one commit: upstream + us)
4. points the pure `upstream` branch at the upstream tip
5. stamps `.last-sync` with the run time (keeps the repo active so GitHub
   never auto-disables the schedule after 60 idle days)

Two reasons it is built this way, both learned the hard way:

- **Rebase, not merge**: upstream rewrites history (release automation), so
  a `git merge` / `merge-upstream` eventually conflicts; replaying our small
  additive overlay onto whatever their tip is never does.
- **API, not git push**: the PAT has no `workflows` permission (its backing
  GitHub App), and GitHub rejects any git push that carries
  `.github/workflows` changes — which upstream touches regularly. The API
  path accepts those commits fine, and ref updates through it still fire
  push events.

`deploy-site.yml` triggers off those pushes. Manual commits are filtered by
path (only `crates/**`, `apps/**`, `workers/**`, `scripts/**`, lockfiles and
the workflow itself rebuild the site); the daily sync rewrites history, so
its push always rebuilds — which is free on a public repo and guarantees the
site is rebuilt fresh from each morning's upstream tip. If `GH_PAT` is ever
missing, the sync falls back to the built-in `GITHUB_TOKEN` (whose pushes
don't trigger workflows) and kicks the deploy itself with `gh workflow run`.

## Repo secrets

| Secret | Used by | Notes |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | deploy-site.yml | Pages deploys + Worker deploys |
| `CLOUDFLARE_ACCOUNT_ID` | deploy-site.yml | account `caa845f8…` |
| `GH_PAT` | upstream-sync.yml | a GitHub PAT with repo contents write, so sync pushes trigger the deploy workflow; without it the sync still works, it just kicks the deploy itself |

## Cloudflare resources (account caa845f848f2c4f9bdd61956e9254b4a)

| Resource | Name | ID |
| --- | --- | --- |
| Pages project | `thehumanbox-upstream` | — (thehumanbox-upstream.pages.dev) |
| Worker | `thehumanbox-api` | — (thehumanbox-api.yeyilin2010.workers.dev) |
| Worker (Agents SDK) | `thehumanbox-agent` | — (thehumanbox-agent.yeyilin2010.workers.dev, DO class `DevAgent`) |
| KV namespace | `thehumanbox_kv` | `8b58656e233947f19bcf3dc564f302fb` |
| D1 database | `thehumanbox_db` | `0367064a-970b-47f0-aca0-0b7553424f50` |

D1 schema (`saves`, `scores`, `events`, `counters`) is created; the worker is
idempotent against it. `wrangler.toml` pins every binding and the daily
cron (`30 2 * * *`).

## Local development

```bash
cd workers/api
npx wrangler dev      # local dev server with live bindings
npx wrangler deploy   # deploy by hand (CI does this on every push)
npx wrangler tail     # live logs

cd ../agent
npm install
npx wrangler dev      # the DevAgent locally
npx wrangler deploy   # deploy by hand (CI does this on every push)
```
