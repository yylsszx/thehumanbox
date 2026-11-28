/**
 * TheHumanBox super developer agent v5 — Cloudflare Agents SDK.
 *
 * v5 focus (player feedback: "工作流会莫名其妙断掉，极其脆弱" / "功能和控制强度还是很差"):
 *   · NEVER DROP A TURN — every frame is BROADCAST to all live connections;
 *     a reconnecting page gets a `turn_live` snapshot plus re-issued pending
 *     tool calls (the page de-dupes by id, so nothing runs twice). The reply
 *     lands in history even if the page was gone when it finished.
 *   · PROTOCOL HARDENING — models trained with native function calling
 *     (NaiveAI N0.5 emits literal `<function=backend_chronicle>{...}</function>`
 *     in plain chat, seen live in the panel) now parse too: JSON args,
 *     key=value / key: value pairs, unterminated tails. Plus a SELF-HEAL
 *     round: an unreadable tool attempt gets one corrective exchange instead
 *     of leaking raw code as the answer.
 *   · TIMEOUT BY WATCHDOG, NOT BY WALL CLOCK — the old fixed 60s cap cut
 *     long streaming replies mid-sentence ("断掉"). Now: 30s to the first
 *     token, then a 90s stall watchdog re-armed on EVERY piece (thinking
 *     tokens count as activity), with a 300s hard cap. Transient failures
 *     (429 / 5xx / network / empty) retry once silently.
 *   · HEARTBEAT — `{type:"ping"}` → pong keeps the Pages-Function WS splice
 *     from being reaped as idle while a slow model thinks.
 *   · DEEP CONTROL — new page tools game_deep / game_scan / game_find /
 *     game_focus (positions from the engine's own full frame), so the model
 *     can aim commands at real coordinates instead of guessing.
 *   · Everything from v4: BYOK provider direct-connect, parallel tools keyed
 *     by request id, the 94-command catalog, live world snapshot per message.
 *
 * Routes: /agents/dev-agent/{name} (WebSocket) · /chat (HTTP, ?stream=1 SSE)
 *         /models · /commands · /health · /
 */
import { Agent, routeAgentRequest } from "agents";

const VERSION = "5.0.0";
const SERVICE = "thehumanbox-agent";
const MAX_ROUNDS = 10;
const MAX_CALLS_PER_ROUND = 5;
// v5: a budget to the FIRST token, then a stall watchdog re-armed on every
// piece (thinking included), then one generous hard cap. A fixed total cap
// cut slow streaming replies mid-sentence — the "workflow mysteriously
// breaks" bug.
const TTFT_MS = 30000;
const STALL_MS = 90000;
const HARD_CAP_MS = 300000;
const RETRY_DELAY_MS = 900;
const TOOL_TIMEOUT_MS = 45000;
const HISTORY_CAP = 40;
const REPLAY_CAP = 30;
const MAX_TOKENS = 1600;

// Curated + live-verified on this account; speed notes are MEASURED full
// round-trip latencies through /agent/chat on 2026-11-26 (Workers AI free
// tier congestion varies by hour — llama-3.3-70b-fp8-fast was 12x faster
// than glm-4.7-flash that day). speed: 3 = fast.
const MODEL_CATALOG = [
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B fp8-fast", tier: "light", vision: false, speed: 3, note: "⚡⚡⚡ 实测 3s·默认" },
  { id: "@cf/aisingapore/gemma-sea-lion-v4-27b-it", label: "SEA-LION v4 27B", tier: "light", vision: false, speed: 3, note: "⚡⚡⚡ 实测 2s" },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", label: "Qwen2.5 Coder 32B", tier: "light", vision: false, speed: 3, note: "⚡⚡⚡ 实测 3s·代码强" },
  { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B", tier: "light", vision: false, speed: 2, note: "⚡⚡ 实测 10s" },
  { id: "@cf/qwen/qwen3.8-27b", label: "Qwen3.8 27B", tier: "light", vision: false, speed: 2, note: "⚡⚡ 实测 11s·通义" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B", tier: "standard", vision: false, speed: 2, note: "⚡⚡ 实测 15s·MoE" },
  { id: "@cf/openai/gpt-oss-20b", label: "GPT-OSS 20B", tier: "standard", vision: false, speed: 2, note: "⚡⚡ 实测 16s" },
  { id: "@cf/zai-org/glm-4.7-flash", label: "GLM-4.7 Flash", tier: "standard", vision: false, speed: 1, note: "⚡ 中文好·实测波动 6-32s" },
  { id: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B", tier: "flagship", vision: false, speed: 1, note: "⚡ 最强·实测 63s·复杂编排用" },
  { id: "@cf/meta/llama-3.2-11b-vision-instruct", label: "Llama 3.2 11B 视觉", tier: "vision", vision: true, speed: 2, note: "👁 能看截图·实测 8s" },
];
// mistral-small / granite-4.0-micro / phonellm-mini were removed from the
// catalog after live measurement (63s+ / empty replies on 2026-11-26);
// any @cf/ id still works via the free-text picker.
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TIER_ORDER = ["light", "standard", "flagship", "vision"];

// ── BYOK provider direct-connect (official endpoints, called straight ──
// ── from this worker — no gateway, no middleman) ────────────────────────
// Model ids on the wire: "provider:<providerId>:<model-id>".
// Verified live on 2026-11-27 (all four endpoints answer 401 without a key).
const PROVIDER_TIMEOUT_MS = 60000;
const PROVIDERS = {
  zhipu: {
    label: "智谱 GLM",
    endpoint: "https://open.bigmodel.cn/api/paas/v4",
    keyHint: "bigmodel.cn 控制台 → API Keys（sk-…）",
    models: [
      { id: "glm-5.3", label: "GLM-5.3 旗舰", vision: false, note: "1M 上下文·最强" },
      { id: "glm-5.3-flash", label: "GLM-5.3-Flash", vision: true, note: "多模态·0.8元/M·推荐" },
      { id: "glm-5.3-flashx", label: "GLM-5.3-FlashX", vision: true, note: "200 tok/s·极快" },
      { id: "glm-5.2", label: "GLM-5.2", vision: false, note: "1M 上下文" },
      { id: "glm-5.1", label: "GLM-5.1", vision: false, note: "6元/M" },
      { id: "glm-5-turbo", label: "GLM-5-Turbo", vision: false, note: "5元/M" },
      { id: "glm-5", label: "GLM-5", vision: false, note: "4元/M" },
      { id: "glm-4.7", label: "GLM-4.7", vision: false, note: "2-3元/M" },
      { id: "glm-4.7-flash", label: "GLM-4.7-Flash", vision: false, note: "免费" },
      { id: "glm-4.7-flashx", label: "GLM-4.7-FlashX", vision: false, note: "0.5元/M·快" },
      { id: "glm-4.5-air", label: "GLM-4.5-Air", vision: false, note: "0.8元/M" },
      { id: "glm-4-plus", label: "GLM-4-Plus", vision: false, note: "5元/M" },
      { id: "glm-4-air-250414", label: "GLM-4-Air", vision: false, note: "0.5元/M" },
      { id: "glm-4-long", label: "GLM-4-Long", vision: false, note: "1M 上下文" },
      { id: "glm-4-flash-250414", label: "GLM-4-Flash", vision: false, note: "免费" },
      { id: "glm-4-flashx-250414", label: "GLM-4-FlashX", vision: false, note: "0.1元/M" },
      { id: "glm-5v-turbo", label: "GLM-5V-Turbo", vision: true, note: "视觉" },
      { id: "glm-4.6v-flash", label: "GLM-4.6V-Flash", vision: true, note: "视觉·免费" },
      { id: "glm-4.6v-flashx", label: "GLM-4.6V-FlashX", vision: true, note: "视觉·0.15元/M" },
      { id: "glm-4.5v", label: "GLM-4.5V", vision: true, note: "视觉" },
      { id: "glm-4.1v-thinking-flash", label: "GLM-4.1V-Thinking-Flash", vision: true, note: "视觉·免费·思考" },
      { id: "glm-4v-flash", label: "GLM-4V-Flash", vision: true, note: "视觉·免费·4K" },
    ],
  },
  naive: {
    label: "NaiveAI",
    endpoint: "https://api.naive.ai/v1",
    keyHint: "platform.naive.ai → API Key",
    models: [
      { id: "naive-n0.5-flash", label: "Naive N0.5 Flash", vision: false, note: "至高 ~2000 tok/s·思考" },
      { id: "naive-n0.5-lite", label: "Naive N0.5 Lite", vision: false, note: "同款·关思考·低延迟" },
    ],
  },
  agnes: {
    label: "Agnes（国内）",
    endpoint: "https://api.agnes-ai.cn/v1",
    keyHint: "agnes-ai.cn 控制台 → API Key",
    models: [
      { id: "agnes-3.0-flash", label: "Agnes 3.0 Flash", vision: false, note: "Agent/代码·当前免费" },
      { id: "agnes-2.5-flash", label: "Agnes 2.5 Flash", vision: false, note: "512K 上下文·免费" },
      { id: "agnes-2.5-pro", label: "Agnes 2.5 Pro", vision: false, note: "1M 上下文·付费" },
      { id: "agnes-2.5-pro-beta", label: "Agnes 2.5 Pro Beta", vision: false, note: "付费·低价" },
    ],
  },
  "agnes-intl": {
    label: "Agnes（国际）",
    endpoint: "https://apihub.agnes-ai.com/v1",
    keyHint: "agnes-ai.com 控制台 → API Key",
    models: [
      { id: "agnes-3.0-flash", label: "Agnes 3.0 Flash", vision: false, note: "海外线路" },
      { id: "agnes-2.5-flash", label: "Agnes 2.5 Flash", vision: false, note: "海外线路" },
      { id: "agnes-2.5-pro", label: "Agnes 2.5 Pro", vision: false, note: "海外线路" },
      { id: "agnes-2.5-pro-beta", label: "Agnes 2.5 Pro Beta", vision: false, note: "海外线路" },
    ],
  },
};

function providerModelList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    endpoint: p.endpoint,
    key_hint: p.keyHint || "",
    models: p.models,
  }));
}

/** Parse "provider:zhipu:glm-5.3-flash" → routing info (or {error}). */
function providerModel(model) {
  if (typeof model !== "string") return null;
  const m = /^provider:([a-z0-9-]+):([A-Za-z0-9._\/-]+)$/.exec(model);
  if (!m) return null;
  const provider = PROVIDERS[m[1]];
  if (!provider) return { error: `unknown provider "${m[1]}" — 可用: ${Object.keys(PROVIDERS).join(" / ")}` };
  return { providerId: m[1], provider, modelId: m[2], entry: provider.models.find((x) => x.id === m[2]) || null };
}

// ── the sandbox command registry (verbatim from crates/sim-core registry.rs) ─
// [cmd]{args} — args mark required fields; ? = optional.
const COMMAND_CATALOG = {
  commands: [
    { cmd: "spawn", args: "x,y,count?,lineage?,speak_like?", desc: "在 (x,y) 生成 count 个人类（lineage=部落 id 可指定归属）" },
    { cmd: "family", args: "x,y", desc: "在最近的人处组建家庭" },
    { cmd: "teleport", args: "x,y,radius", desc: "传送范围内的人到 (x,y)" },
    { cmd: "make_leader", args: "x,y,radius", desc: "任命范围内的人为领袖" },
    { cmd: "place_building", args: "x,y,kind", desc: "放置建筑（kind 见枚举）" },
    { cmd: "place_boat", args: "x,y", desc: "放一条船" },
    { cmd: "heal_one", args: "x,y,radius", desc: "治愈最近的一个人" },
    { cmd: "gift", args: "x,y,radius,what", desc: "送礼物 what=food|tool" },
    { cmd: "set_time_of_day", args: "phase", desc: "phase=dawn|noon|dusk|midnight" },
    { cmd: "hail", args: "x,y,radius", desc: "冰雹" },
    { cmd: "nuke", args: "x,y,radius", desc: "核弹（radius 建议 10-30）" },
    { cmd: "eclipse", args: "", desc: "日食" },
    { cmd: "rain_patch", args: "x,y,radius", desc: "局部降雨" },
    { cmd: "cure_tribe", args: "x,y", desc: "治愈该点所在部落" },
    { cmd: "guardian", args: "x,y", desc: "召唤守护者" },
    { cmd: "aurora", args: "", desc: "极光" },
    { cmd: "heat_wave", args: "", desc: "热浪（全图）" },
    { cmd: "freeze", args: "x,y,radius", desc: "冻结区域" },
    { cmd: "bless_river", args: "x,y,radius", desc: "祝福河流" },
    { cmd: "bless_forest", args: "x,y,radius", desc: "祝福森林" },
    { cmd: "talent", args: "x,y,radius", desc: "赐予天赋" },
    { cmd: "shape_land", args: "x,y,radius,by", desc: "抬升/降低地形 by=±格数" },
    { cmd: "bless_soil", args: "x,y,radius", desc: "祝福土壤" },
    { cmd: "spring", args: "x,y", desc: "在 (x,y) 造泉眼" },
    { cmd: "bountiful_hunt", args: "x,y,radius", desc: "丰饶狩猎" },
    { cmd: "era_tribe", args: "x,y,era", desc: "把部落直接推进到 era 时代" },
    { cmd: "set_world_mods", args: "mods", desc: "世界修正（高级）" },
    { cmd: "tribe_gift", args: "x,y,radius,what", desc: "给部落送 what=food|tool" },
    { cmd: "migrate_tribe", args: "x,y,radius", desc: "部落迁徙" },
    { cmd: "trade_gift", args: "ax,ay,bx,by", desc: "在两个部落间建立贸易" },
    { cmd: "clear_region", args: "x,y,radius", desc: "清空区域（拆建筑/植物）" },
    { cmd: "mutate", args: "x,y,radius", desc: "变异范围内的人" },
    { cmd: "merge_tribes", args: "ax,ay,bx,by", desc: "合并两个部落" },
    { cmd: "split_tribe", args: "x,y,radius", desc: "分裂部落" },
    { cmd: "teach_nearby", args: "x,y,radius", desc: "教导附近部落" },
    { cmd: "curse", args: "x,y,radius", desc: "诅咒" },
    { cmd: "comet", args: "x,y,radius", desc: "彗星撞击" },
    { cmd: "smite", args: "x,y,radius", desc: "天罚（雷击）" },
    { cmd: "heal", args: "x,y,radius", desc: "群体治愈" },
    { cmd: "paint", args: "x,y,tile,radius", desc: "画地块（tile 见枚举）" },
    { cmd: "ignite", args: "x,y,radius", desc: "点火" },
    { cmd: "weather", args: "kind", desc: "kind=clear|rain|storm|snow|fog|monsoon|cold_snap" },
    { cmd: "drought", args: "active", desc: "干旱开关 active=true|false" },
    { cmd: "sinkhole", args: "x,y,radius", desc: "天坑" },
    { cmd: "black_hole", args: "x,y,radius", desc: "黑洞" },
    { cmd: "acid_rain", args: "x,y,radius", desc: "酸雨" },
    { cmd: "spawn_animal", args: "x,y,kind,count,radius", desc: "生成动物（kind 见枚举）" },
    { cmd: "poison", args: "x,y,radius", desc: "毒雾" },
    { cmd: "bless", args: "x,y,radius", desc: "祝福" },
    { cmd: "long_life", args: "x,y,radius", desc: "赐长寿" },
    { cmd: "courage", args: "x,y,radius", desc: "赐勇气" },
    { cmd: "sunshine", args: "x,y,radius", desc: "阳光普照区域" },
    { cmd: "inspire", args: "x,y,radius", desc: "赐灵感（加速学习）" },
    { cmd: "earthquake", args: "x,y,radius", desc: "地震" },
    { cmd: "war", args: "x,y", desc: "对该点部落宣战（周边部落）" },
    { cmd: "peace", args: "x,y", desc: "和平" },
    { cmd: "meteor", args: "x,y,radius", desc: "陨石" },
    { cmd: "harvest", args: "x,y,radius", desc: "立即丰收" },
    { cmd: "cure", args: "x,y,radius", desc: "治疗（含疾病）" },
    { cmd: "arm", args: "x,y,radius", desc: "武装" },
    { cmd: "bounty", args: "x,y,radius", desc: "赏金（食物）" },
    { cmd: "douse", args: "x,y,radius", desc: "灭火" },
    { cmd: "ward", args: "x,y,radius", desc: "结界防护" },
    { cmd: "teach", args: "lineage", desc: "教导整个部落" },
    { cmd: "revive", args: "x,y", desc: "复活 (x,y) 的死者" },
    { cmd: "banish", args: "x,y,radius", desc: "放逐" },
    { cmd: "blight", args: "x,y,radius", desc: "枯萎病" },
    { cmd: "frenzy", args: "x,y,radius", desc: "狂乱" },
    { cmd: "flood", args: "x,y,radius", desc: "洪水" },
    { cmd: "blizzard", args: "x,y,radius", desc: "暴风雪" },
    { cmd: "thunder", args: "x,y,radius", desc: "雷暴" },
    { cmd: "plant", args: "x,y,kind,radius", desc: "种植（kind 见枚举）" },
    { cmd: "rename_tribe", args: "lineage,name", desc: "重命名部落" },
    { cmd: "paint_biome", args: "x,y,biome,radius", desc: "改生态（biome 见枚举）" },
    { cmd: "volcano", args: "x,y,radius", desc: "火山喷发" },
    { cmd: "meteor_shower", args: "x,y,radius", desc: "陨石雨" },
    { cmd: "love", args: "x,y,radius", desc: "爱之祝福" },
    { cmd: "marry", args: "ax,ay,bx,by", desc: "撮合两人成婚" },
    { cmd: "rename_person", args: "id,name", desc: "重命名人物" },
    { cmd: "follow", args: "id", desc: "镜头跟随某人" },
    { cmd: "tame", args: "x,y,radius", desc: "驯服动物" },
    { cmd: "road", args: "x,y,radius,kind", desc: "修路 kind=road|bridge|erase" },
    { cmd: "demolish", args: "x,y,radius", desc: "拆除建筑" },
    { cmd: "repair", args: "x,y,radius", desc: "修复建筑" },
    { cmd: "restore", args: "x,y,radius", desc: "复原区域" },
    { cmd: "gale", args: "", desc: "大风（全图）" },
    { cmd: "tornado", args: "x,y,radius", desc: "龙卷风" },
    { cmd: "tsunami", args: "x,y,radius", desc: "海啸" },
    { cmd: "locusts", args: "x,y,radius", desc: "蝗灾" },
    { cmd: "wildfire", args: "x,y,radius", desc: "野火" },
    { cmd: "guide", args: "lineage,strategy,duration_ticks", desc: "指引部落 strategy=hunt|explore|settle|trade|defend" },
    { cmd: "composite", args: "steps[≤8]", desc: "批量编排（一次原子执行 ≤8 步，不可嵌套）" },
    { cmd: "set_difficulty", args: "level", desc: "level=calm|normal|harsh" },
    { cmd: "outbreak", args: "count,x?,y?,radius", desc: "疫情（可全图或定点）" },
  ],
  aliases: { time_of_day: "set_time_of_day", set_strategy: "guide" },
  enums: {
    weather: "clear|rain|storm|snow|fog|monsoon|cold_snap",
    phase: "dawn|noon|dusk|midnight",
    gift: "food|tool",
    road: "road|bridge|erase",
    strategy: "hunt|explore|settle|trade|defend",
    difficulty: "calm|normal|harsh",
    plant: "crop|orchard|sapling|flower|berry|mushroom|oak|pine|palm",
    tile: "grass|water|food|fire|rock|ash|campfire|hut|flooded|mineral|scorched|snow|sand|lava|ice",
    biome: "grassland|forest|desert|wetland|tundra|volcanic|jungle|savanna|taiga|badlands",
    animal: "rabbit|deer|boar|bird|fish|wolf|dog|bear|sheep|cow|horse|chicken|fox|cat|penguin|camel|frog|whale|duck|bee|owl|eagle|snake|crocodile|monkey|goat|elephant|lion",
    era: "pre-stone|stone|bronze|iron|classical|medieval|renaissance|industrial|modern|information|atomic|space|digital|quantum|solar|fusion|genetic|orbital|lunar|martian|cyber|neural|posthuman|interstellar|singularity|galactic|dyson|kardashev-2|kardashev-3|stellar|nebular|universal|multiverse|transcendent|eldritch|voidborn|chronal|akashic|entropic|oneiric|mythic|demiurge|pantheon|omega|rebirth",
    building: "hut|house|manor|townhouse|apartment|school|university|library|market|temple|factory|hospital|forge|mill|bakery|inn|bank|workshop|granary|barracks|lighthouse|windmill|watermill|aqueduct|bridge|wall|tower|plaza|statue|fountain|train_station|airport|port|stadium|museum|cathedral|castle|theatre|observatory|tavern|brewery|pyramid|ziggurat|coliseum|clock_tower|mosque|synagogue|pagoda|stupa|mausoleum|hangar|silo|warehouse|dock|marina|shipyard|crane|radio_tower|satellite_dish|wind_turbine|solar_panel|monument|obelisk|shrine|garden|pond|well|fence|gate|watchtower|gallows|camp 特殊见源码（170+ 种）",
  },
};

function commandReference() {
  const lines = COMMAND_CATALOG.commands.map((c) => `  ${c.cmd}{${c.args}} — ${c.desc}`);
  const enums = Object.entries(COMMAND_CATALOG.enums).map(([k, v]) => `  ${k}: ${v}`);
  return `Commands (EXACT names, copy them verbatim; x∈[0,800) y∈[0,400), origin top-left):\n${lines.join("\n")}\nEnum values:\n${enums.join("\n")}`;
}

function systemPrompt() {
  return `You are THB DevAgent — the god-hand of The Human Box, a browser civilization sim (800x400 tiles, Q-learning humans, tribes, cities, war). You are LIVE-connected to the player's game page.

## Tool protocol (STRICT)
Reply with EITHER the final answer (plain text, short), OR one or more tool actions — each as ONE line, nothing else around them:
TOOL: {"tool":"game_command","args":{"command":{"cmd":"nuke","x":400,"y":200,"radius":18}}}
TOOL: {"tool":"game_control","args":{"action":"speed10"}}
Multiple TOOL lines in one reply run in parallel. Max ${MAX_ROUNDS} rounds × ${MAX_CALLS_PER_ROUND} calls, then answer.
NEVER emit tool calls in any other syntax — no <function=...> XML, no fenced json code blocks carrying a lone call, no prose around a call. Plain TOOL: lines only.

## Tools
- game_deep {} — the engine's own full frame: every tribe's NAME + POPULATION + CENTROID (cx,cy) + avg health, buildings by kind with centroids, animals. Call this FIRST whenever you need coordinates — never guess them.
- game_scan {x,y,radius} — who and what is around a point (people by tribe, buildings, nearest people with ids).
- game_find {kind,name} — locate by name: kind=tribe|person|building (substring ok) → positions.
- game_focus {name} — swing the player's camera to a named tribe.
- game_command {command} — a sandbox command object {"cmd":name, ...args} or an ARRAY of them (up to 20, they run together). ${commandReference()}
- game_control {action} — pause|resume|speed1|speed2|speed4|speed10|save|checkpoint
- game_state {} — page-level snapshot (population, era, save, headline, event log tail).
- game_screenshot {} — JPEG of the world right now (vision models see it attached to the next call).
- game_key {key} — game hotkey: 1/2/3/4 speed · 0 fit world · WASD pan · p prayer · b brink.
- game_log {limit?} — recent world event log lines.
- org_detail {id} / org_life {id} — person/tribe dossier or life story (ids appear in game_deep/game_scan and command outcomes).
- page_click {selector,index?} / page_read {selector} — DOM (needs permission).
- page_eval {code} — JS in the page (needs the dev-console permission).
- cloud_save {} — push the world to the player's cloud slot.
- backend_stats {} / backend_leaderboard {limit?} / backend_chronicle {name?,score?,epoch?} — backend_chronicle auto-fills EVERYTHING from the live world snapshot when called with empty args (recommended: {"tool":"backend_chronicle","args":{}}).

## World snapshot
A fresh snapshot rides along with every player message (population, era, recent events). Use it and ACT on round 1. When it lacks coordinates you need, call game_deep first — one call, then aim precisely at the tribe centroids it reports.

## Playbook
- 精准打击/祝福某部落: game_deep → 该部落 cx,cy → e.g. bless {x:cx,y:cy,radius:16} or nuke.
- 建城: game_deep → 挑人口最多部落的质心附近空地 → place_building 数组 (house/market/well/school/road + plant trees) 一次执行.
- 史诗天灾: composite 或命令数组，多组坐标沿质心错落分布 (地震+火山+海啸).
- 查人物故事: game_scan 找到 id → org_life.

## Style
Decisive: when asked to do something, DO it, then confirm in 1-3 short sentences what actually happened (cite the outcome codes). For plain chat, greetings, questions about yourself or general talk with NO world action needed: answer directly in one short line WITHOUT any tool. Keep answers under ~120 words unless asked for detail. Answer in the player's language (usually Chinese).`;
}

// ── model routing ──────────────────────────────────────────────────────

function jsonHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders() });
}

function buildContent(text, image) {
  if (!image) return text;
  return [
    { type: "text", text: String(text) },
    { type: "image_url", image_url: { url: image } },
  ];
}
function attachImage(messages, image) {
  const last = messages[messages.length - 1];
  if (image && last && last.role === "user" && typeof last.content === "string") {
    return [...messages.slice(0, -1), { role: "user", content: buildContent(last.content, image) }];
  }
  return messages;
}

/** Extract the text piece from one SSE data payload, whatever its shape. */
function pieceFromPayload(d) {
  if (!d || typeof d !== "object") return "";
  if (typeof d.response === "string") return d.response;
  const ch = Array.isArray(d.choices) ? d.choices[0] : null;
  if (ch?.delta?.content) return String(ch.delta.content);
  if (ch?.message?.content) return String(ch.message.content);
  if (typeof d.text === "string") return d.text;
  return "";
}

/** Reasoning tokens (GLM/DeepSeek-style `reasoning_content`, Naive thinking) —
 *  not part of the answer, but they prove the stream is alive, so the stall
 *  watchdog must see them (v4 killed thinking models mid-thought). */
function reasoningFromPayload(d) {
  if (!d || typeof d !== "object") return "";
  const ch = Array.isArray(d.choices) ? d.choices[0] : null;
  const r = ch?.delta?.reasoning_content ?? ch?.delta?.reasoning;
  return typeof r === "string" ? r : "";
}

/** Parse an SSE-ish byte/text stream; returns {text, raw, reasoning} — text is
 *  the concatenated token pieces, raw everything the body yielded (some
 *  endpoints ignore stream:true and answer one plain JSON object). */
async function pumpSse(body, onPiece, isAborted, onActivity, onReasoning) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = "";
  let raw = "";
  let think = 0;
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return;
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let d = null;
    try { d = JSON.parse(payload); } catch { return; }
    const reasoning = reasoningFromPayload(d);
    if (reasoning) {
      think += reasoning.length;
      if (onActivity) onActivity();
      if (onReasoning) onReasoning(reasoning);
      return;
    }
    const piece = pieceFromPayload(d);
    if (piece) {
      out += piece;
      if (onActivity) onActivity();
      if (onPiece) onPiece(piece);
    }
  };
  try {
    for (;;) {
      if (isAborted && isAborted()) { try { await reader.cancel(); } catch {} break; }
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buf += chunk;
      raw += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
    // v5: some endpoints end their last data: line with NO trailing newline —
    // the v4 parser dropped it, so a one-shot non-SSE answer inside an SSE
    // body could come back "empty". Flush the tail.
    if (buf.trim()) handleLine(buf);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return { text: out, raw, reasoning: think };
}

/** Call Workers AI with streaming; falls back to a non-streaming call. */
async function callWorkersAI(env, model, messages, image, onPiece, isAborted) {
  const payload = { messages: attachImage(messages, image), max_tokens: MAX_TOKENS, stream: true };
  let stream = null;
  try {
    stream = await env.AI.run(model, payload);
  } catch (error) {
    // some models reject stream:true — retry once without it
    try {
      const out = await env.AI.run(model, { messages: attachImage(messages, image), max_tokens: MAX_TOKENS });
      const text =
        typeof out?.response === "string"
          ? out.response
          : out?.choices?.[0]?.message?.content
            ? out.choices[0].message.content
            : null;
      if (!text) throw error;
      if (onPiece) onPiece(String(text));
      return String(text).trim();
    } catch {
      throw new Error(`Workers AI 调用失败（${model}）：${String(error?.message ?? error).slice(0, 200)}`);
    }
  }
  if (stream && typeof stream.getReader === "function") {
    const { text } = await pumpSse(stream, onPiece, isAborted);
    if (text.trim()) return text.trim();
    // empty stream — fall through to a plain call
  } else if (stream && typeof stream === "object") {
    // some models answer a plain object even with stream:true
    const text =
      typeof stream.response === "string"
        ? stream.response
        : stream?.choices?.[0]?.message?.content
          ? stream.choices[0].message.content
          : null;
    if (text) {
      if (onPiece) onPiece(String(text));
      return String(text).trim();
    }
  }
  const out = await env.AI.run(model, { messages: attachImage(messages, image), max_tokens: MAX_TOKENS });
  const text =
    typeof out?.response === "string"
      ? out.response
      : out?.choices?.[0]?.message?.content
        ? out.choices[0].message.content
        : null;
  if (!text) throw new Error(`模型 ${model} 未返回文本（可能不支持对话格式）— 请换一个模型`);
  if (onPiece) onPiece(String(text));
  return String(text).trim();
}

/** v5 watchdog: one budget to the first token, then a stall budget re-armed
 *  on every piece (content OR reasoning). A fixed total cap used to cut long
 *  streaming replies mid-sentence at exactly 60s — the visible "workflow
 *  breaks for no reason". */
function makeWatchdog(controller) {
  let phase = "ttft";
  let timer = null;
  const hard = setTimeout(() => { phase = "hard"; try { controller.abort(); } catch {} }, HARD_CAP_MS);
  const arm = (ms, why) => {
    phase = why;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { try { controller.abort(); } catch {} }, ms);
  };
  arm(TTFT_MS, "ttft");
  return {
    activity() { arm(STALL_MS, "stall"); },
    done() { if (timer) clearTimeout(timer); clearTimeout(hard); },
    describe(label) {
      if (phase === "ttft") return `${label} 首字超时（${TTFT_MS / 1000}s 无任何输出）— 换更快的模型或稍后再试`;
      if (phase === "stall") return `${label} 流中断（${STALL_MS / 1000}s 无新内容）— 网络拥堵，稍后再试`;
      return `${label} 超过总上限（${HARD_CAP_MS / 1000}s）`;
    },
  };
}

/** Call a custom OpenAI-compatible endpoint with streaming. */
async function callCustom(custom, messages, image, onPiece, isAborted) {
  const base = String(custom.baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("custom baseUrl 必须以 http(s):// 开头");
  const model = String(custom.model || "").trim();
  if (!model) throw new Error("请填写自定义模型名");
  const headers = { "Content-Type": "application/json" };
  if (custom.apiKey) headers.Authorization = "Bearer " + String(custom.apiKey);
  const body = { model, messages: attachImage(messages, image), max_tokens: MAX_TOKENS, stream: true };
  const controller = new AbortController();
  const wd = makeWatchdog(controller);
  try {
    const res = await fetch(base + "/chat/completions", {
      method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(`自定义端点 HTTP ${res.status}: ${String(errBody?.error?.message || "no content").slice(0, 200)}`);
    }
    if (res.body && typeof res.body.getReader === "function") {
      const { text, raw } = await pumpSse(res.body, onPiece, isAborted, () => wd.activity());
      if (text.trim()) return text.trim();
      // endpoint ignored stream:true and answered one plain JSON object
      if (raw.trim()) {
        try {
          const whole = JSON.parse(raw);
          const text2 = whole?.choices?.[0]?.message?.content;
          if (text2) {
            if (onPiece) onPiece(String(text2));
            return String(text2).trim();
          }
        } catch { /* not JSON either */ }
      }
    }
    throw new Error("自定义端点未返回内容");
  } catch (error) {
    if (String(error?.name) === "AbortError" || controller.signal.aborted) throw new Error(wd.describe("自定义端点"));
    throw error;
  } finally {
    wd.done();
  }
}

function catalogEntry(model) {
  return MODEL_CATALOG.find((m) => m.id === model) || null;
}

/** Call a BYOK provider's official endpoint directly (streaming, no middleman). */
async function callProvider(p, messages, image, onPiece, isAborted, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) {
    throw new Error(`${p.provider.label} 需要 API Key — 在面板的模型设置里填入（${p.provider.keyHint || "官方控制台"}）`);
  }
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + key };
  const body = { model: p.modelId, messages: attachImage(messages, image), max_tokens: MAX_TOKENS, stream: true };
  const controller = new AbortController();
  const wd = makeWatchdog(controller);
  try {
    const res = await fetch(p.provider.endpoint + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      const detail = String(errBody?.error?.message || errBody?.message || errBody?.error || "no content").slice(0, 260);
      const hint =
        res.status === 401 || res.status === 403
          ? "（Key 无效或未授权？）"
          : res.status === 429
            ? "（被限流：免费档 RPM 较低，稍候再试或换模型）"
            : res.status === 404
              ? "（模型 id 或路径不对？）"
              : "";
      throw new Error(`${p.provider.label} HTTP ${res.status}: ${detail}${hint}`);
    }
    if (res.body && typeof res.body.getReader === "function") {
      const { text, raw } = await pumpSse(res.body, onPiece, isAborted, () => wd.activity());
      if (text.trim()) return text.trim();
      // endpoint ignored stream:true and answered one plain JSON object
      if (raw.trim()) {
        try {
          const whole = JSON.parse(raw);
          const t2 = whole?.choices?.[0]?.message?.content;
          if (t2) {
            if (onPiece) onPiece(String(t2));
            return String(t2).trim();
          }
        } catch { /* not JSON either */ }
      }
    }
    throw new Error(`${p.provider.label} 未返回内容`);
  } catch (error) {
    if (String(error?.name) === "AbortError" || controller.signal.aborted) throw new Error(wd.describe(p.provider.label));
    throw error;
  } finally {
    wd.done();
  }
}

/** Display label + vision capability for any route. */
function modelMeta(route) {
  if (route.model === "custom") {
    return { label: route.custom?.model || "custom", vision: route.custom?.vision !== false };
  }
  const p = providerModel(route.model);
  if (p) {
    if (p.error) return { label: route.model, vision: false };
    return { label: `${p.provider.label} ${p.entry?.label || p.modelId}`, vision: !!(p.entry && p.entry.vision) };
  }
  const entry = catalogEntry(route.model);
  return { label: entry?.label || route.model, vision: !!(entry && entry.vision) };
}

async function callModelOnce(env, route, messages, image, onPiece, isAborted, onActivity, onReasoning) {
  if (route.model === "custom") {
    if (!route.custom?.baseUrl) throw new Error("已选择自定义端点，但还没有配置 baseUrl / 模型名");
    return callCustom(route.custom, messages, image, onPiece, isAborted);
  }
  const p = providerModel(route.model);
  if (p) {
    if (p.error) throw new Error(p.error);
    return callProvider(p, messages, image, onPiece, isAborted, route.providerKey);
  }
  const model = route.model;
  if (typeof model !== "string" || !/^@cf\/[a-z0-9._/-]+$/i.test(model)) {
    throw new Error(`非法模型 id "${model}" — 用 @cf/... 、 provider:厂商:模型名 或 "custom"`);
  }
  return callWorkersAI(env, model, messages, image, onPiece, isAborted);
}

/** A failure worth one silent retry — free-tier 429s and provider hiccups
 *  used to kill whole turns ("工作流莫名其妙断掉"). Deliberately NOT
 *  retried: auth errors, bad model ids, timeouts (already waited long). */
function transientError(e) {
  const s = String(e?.message ?? e);
  return /HTTP 429|HTTP 5\d\d|network|failed to fetch|fetch failed|connection|reset|ECONN|未返回内容|超载|overload/i.test(s);
}

async function callModel(env, route, messages, image, onPiece, isAborted, onActivity, onReasoning) {
  try {
    return await callModelOnce(env, route, messages, image, onPiece, isAborted, onActivity, onReasoning);
  } catch (error) {
    if (!transientError(error) || (isAborted && isAborted())) throw error;
    try {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return await callModelOnce(env, route, messages, image, onPiece, isAborted, onActivity, onReasoning);
    } catch (e2) {
      throw e2;
    }
  }
}

// ── tool parsing (v3: multiple calls + bare command objects) ───────────

function asCall(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.tool === "string") {
    return { tool: obj.tool, args: obj.args && typeof obj.args === "object" ? obj.args : {} };
  }
  // A bare sandbox command {"cmd":...} → game_command
  if (typeof obj.cmd === "string") {
    return { tool: "game_command", args: { command: obj } };
  }
  // An array of commands
  if (Array.isArray(obj) && obj.length && obj.every((c) => c && typeof c.cmd === "string")) {
    return { tool: "game_command", args: { command: obj } };
  }
  return null;
}

function firstJsonObject(s, from = 0) {
  const start = s.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length && i < start + 8000; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return { obj: JSON.parse(s.slice(start, i + 1)), end: i + 1 }; } catch { return null; }
      }
    }
  }
  return null;
}

/** Repair the two malformations small models actually produce: unquoted
 *  keys and single-quoted strings (seen live from llama-3.2-11b-vision:
 *  TOOL: {"tool:game_control,args:{action:speed"}). */
function repairJsonish(raw) {
  let s = String(raw);
  try { return JSON.parse(s); } catch {}
  try {
    // single-quoted strings → double-quoted
    s = s.replace(/'([^']*)'/g, '"$1"');
    // quote bare keys: {name: or , name: → {"name":
    s = s.replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, '$1"$2"$3');
    return JSON.parse(s);
  } catch { return null; }
}

/** v5: native function-calling syntax — NaiveAI N0.5 emits literal
 *  `<function=backend_chronicle>{...}</function>` in plain chat mode (seen
 *  live in the player's panel). Parse JSON args, then key=value / key: value
 *  pairs, and accept unterminated tails (stream cut before `</function>`). */
function parseKeyValueArgs(s) {
  const out = {};
  const re = /([A-Za-z_][\w-]*)\s*(?:=|:)\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.+-]+))/g;
  let m;
  let n = 0;
  while ((m = re.exec(String(s))) && n < 24) {
    let v = m[2] ?? m[3] ?? m[4] ?? "";
    if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else if (v === "true" || v === "false") v = v === "true";
    out[m[1]] = v;
    n += 1;
  }
  return n ? out : null;
}

function argsFromBody(bodyRaw) {
  const s = String(bodyRaw || "").trim();
  if (!s) return {};
  // 1) the first complete JSON object inside
  const hit = firstJsonObject(s);
  if (hit && (hit.obj.tool || hit.obj.cmd || Array.isArray(hit.obj))) return hit.obj;
  // 2) repairable JSON (unquoted keys / single quotes)
  const repaired = repairJsonish(s);
  if (repaired && typeof repaired === "object") return repaired;
  // 3) key=value / key: value lines
  return parseKeyValueArgs(s);
}

function parseFunctionBlocks(whole) {
  const calls = [];
  const push = (name, body) => {
    const args = argsFromBody(body);
    if (args && typeof args === "object" && (args.tool || args.cmd || Array.isArray(args))) {
      calls.push(asCall(args)); // already a tool/command object
    } else if (args && typeof args === "object" && Object.keys(args).length) {
      calls.push({ tool: name, args }); // bare args for the named function
    } else {
      calls.push({ tool: name, args: {} });
    }
  };
  const re = /<function\s*=\s*([A-Za-z0-9_.-]+)\s*\/?>([\s\S]*?)<\/function\s*>/gi;
  let m;
  while ((m = re.exec(whole))) push(m[1], m[2]);
  if (!calls.length) {
    // unterminated tail: the stream may have been cut before </function>
    const re2 = /<function\s*=\s*([A-Za-z0-9_.-]+)\s*\/?>\s*([\s\S]+)$/i;
    const m2 = re2.exec(whole.trim());
    if (m2 && /[\{\[\w]/.test(m2[2] || "")) push(m2[1], m2[2]);
  }
  return calls.filter(Boolean).slice(0, MAX_CALLS_PER_ROUND);
}

/** A reply that TRIED to call a tool but in an unreadable shape — v5 gives
 *  it one corrective exchange instead of leaking raw code as the answer. */
function looksLikeToolAttempt(text) {
  const s = String(text || "");
  if (/\bTOOL\s*:/i.test(s)) return false; // TOOL lines always parse
  if (/<function[\s=]/i.test(s)) return true;
  if (/<\|?(?:tool_call|function_call)\|?>/i.test(s)) return true;
  if (/"tool"\s*:/.test(s) && /game_|backend_|page_|cloud_|org_/.test(s)) return true;
  if (/```(?:json)?[\s\S]*?"cmd"[\s\S]*?```/.test(s)) return true;
  return false;
}

const REPAIR_HINT = `Your tool call above used a format this chat cannot read (it arrived as literal text). This chat understands EXACTLY one syntax — one line per action, nothing else around it:
TOOL: {"tool":"game_command","args":{"command":{"cmd":"nuke","x":400,"y":200,"radius":18}}}
Re-send your intended action(s) as TOOL: lines now (no XML, no code fences, no prose around them), or answer in plain text.`;

/** All tool calls in a model reply: TOOL: lines first, then <function=…>
 *  blocks, then fenced/bare JSON as fallbacks. */
function parseToolCalls(text) {
  const whole = String(text);
  const calls = [];
  const seen = new Set();
  const push = (call) => {
    const key = JSON.stringify(call);
    if (call && !seen.has(key)) { seen.add(key); calls.push(call); }
  };
  // 1) every line starting with TOOL:
  for (const rawLine of whole.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^TOOL\s*:/i.test(line)) continue;
    let payload = line.replace(/^TOOL\s*:/i, "").trim();
    payload = payload.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
    let hit = firstJsonObject(payload);
    if (!hit) {
      // malformed JSON from small models — try the repair pass
      const repaired = repairJsonish(payload);
      if (repaired) push(asCall(repaired));
      continue;
    }
    push(asCall(hit.obj));
  }
  // 2) v5: <function=name>…</function> native-calling syntax
  for (const call of parseFunctionBlocks(whole)) push(call);
  // 3) fenced ```json blocks containing tool/command objects
  if (!calls.length) {
    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    let m;
    while ((m = fence.exec(whole))) {
      let hit = firstJsonObject(m[1]);
      while (hit) { push(asCall(hit.obj)); hit = firstJsonObject(m[1], hit.end); }
    }
  }
  // 4) bare JSON objects anywhere (models that omit the TOOL: prefix)
  if (!calls.length) {
    let hit = firstJsonObject(whole);
    while (hit && calls.length < MAX_CALLS_PER_ROUND) { push(asCall(hit.obj)); hit = firstJsonObject(whole, hit.end); }
    // keep only real actions
    for (let i = calls.length - 1; i >= 0; i -= 1) if (!calls[i]) calls.splice(i, 1);
  }
  return calls.slice(0, MAX_CALLS_PER_ROUND).filter(Boolean);
}

const PAGE_TOOLS = new Set([
  "game_command", "game_control", "game_state", "game_screenshot", "game_key", "game_log",
  "game_deep", "game_scan", "game_find", "game_focus",
  "org_detail", "org_life", "page_key", "page_click", "page_read", "page_eval", "cloud_save",
]);

// ── server-side tools ──────────────────────────────────────────────────

async function serverTool(env, name, args, world) {
  const origin = (env.API_ORIGIN || "https://thehumanbox-api.yeyilin2010.workers.dev").replace(/\/+$/, "");
  if (name === "backend_stats") return await (await fetch(origin + "/v1/stats")).json();
  if (name === "backend_leaderboard") {
    const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 50);
    return await (await fetch(origin + `/v1/scores?limit=${limit}`)).json();
  }
  if (name === "backend_chronicle") {
    // Auto-fill EVERYTHING from the live world snapshot when args are empty.
    const name0 = String(args?.name ?? "").trim() || world?.tribes?.[0]?.name || "The Nameless";
    const score0 = Number.isFinite(Number(args?.score)) && Number(args?.score) > 0 ? Number(args.score) : Number(world?.tick) || 0;
    const epoch0 = Number.isFinite(Number(args?.epoch)) && Number(args?.epoch) > 0 ? Number(args.epoch) : Number(world?.epoch) || 0;
    const status = String(args?.status ?? (world?.population > 0 ? "living" : "fallen"));
    const r = await fetch(origin + "/v1/chronicle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name0.slice(0, 24),
        score: score0,
        epoch: epoch0,
        status,
        lang: "zh",
        world: world && typeof world === "object"
          ? {
              population: world.population ?? null,
              era: world.era ?? null,
              weather: world.weather ?? null,
              season: world.season ?? null,
              tick: world.tick ?? null,
              tribes: Array.isArray(world.tribes) ? world.tribes.slice(0, 8) : [],
              events: Array.isArray(world.events) ? world.events.slice(-10) : [],
            }
          : null,
      }),
    });
    return await r.json();
  }
  return { error: `unknown server tool "${name}"` };
}

// ── the agentic loop (v3: streaming + parallel calls + snapshot) ───────

function snapshotBlock(world) {
  if (!world || typeof world !== "object") return "";
  const bits = [];
  if (world.headline) bits.push(String(world.headline).slice(0, 200));
  if (world.population != null) bits.push(`population≈${world.population}`);
  if (world.era) bits.push(`era=${world.era}`);
  if (world.tick != null) bits.push(`tick≈${world.tick}`);
  if (world.weather) bits.push(`weather=${world.weather}`);
  if (world.season) bits.push(`season=${world.season}${world.dayPhase ? " " + world.dayPhase : ""}`);
  if (world.speed) bits.push(`speed=${world.speed}`);
  if (Array.isArray(world.tribes) && world.tribes.length) {
    const t = world.tribes.slice(0, 8).map((x) => `${x.name}=${x.count}${x.mood ? `(${x.mood})` : ""}`).join(", ");
    bits.push(`tribes: ${t}`);
  }
  if (Array.isArray(world.events) && world.events.length) bits.push(`recent events: ${world.events.slice(-6).join(" / ").slice(0, 400)}`);
  if (!bits.length) return "";
  return `\n\n## Current world (auto-attached, fresh — REAL live data from the player's page)\n${bits.join(" · ")}\nWorld coordinates: x 0-800, y 0-400, origin top-left. For chronicles/leaderboards of this world use backend_chronicle with EMPTY args (it auto-fills from this data).`;
}

/**
 * @param {object} route {model, custom?, providerKey?} — the model route
 * @param {function} runPageTool(tool, args) => Promise<result> (null on HTTP path)
 * @param {function} onEvent(evt) progress events for the UI
 * @param {function} isAborted() stop between rounds/chunks
 */
async function agentLoop(env, history, route, world, runPageTool, onEvent, isAborted) {
  const { label, vision: canSee } = modelMeta(route);
  const messages = [
    { role: "system", content: systemPrompt() + snapshotBlock(world) },
    ...history,
  ];
  const actions = [];
  let pendingImage = null;
  let ttft = null;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (isAborted && isAborted()) throw new Error("已中断");
    onEvent({ type: "stage", stage: "model", round, model: label });
    const roundStart = Date.now();
    let first = true;
    let thinkChars = 0;
    const reply = await callModel(env, route, messages, pendingImage, (piece) => {
      if (first) { first = false; ttft = Date.now() - roundStart; }
      onEvent({ type: "delta", round, phase: "act", text: piece });
    }, isAborted, () => {}, (r) => {
      thinkChars += r.length;
      if (first && thinkChars % 480 < r.length) {
        onEvent({ type: "thinking", round, chars: thinkChars });
      }
    });
    pendingImage = null;

    const calls = parseToolCalls(reply);
    if (!calls.length) {
      // v5 SELF-HEAL: the model TRIED to act but in an unreadable shape —
      // correct it once instead of leaking raw code as the answer.
      if (looksLikeToolAttempt(reply) && round < MAX_ROUNDS - 1) {
        onEvent({ type: "stage", stage: "repair", round, model: label });
        messages.push({ role: "assistant", content: reply });
        messages.push({ role: "user", content: REPAIR_HINT });
        continue;
      }
      return { reply, actions, ttft };
    }

    actions.push(...calls);
    messages.push({ role: "assistant", content: reply });

    // run this round's calls in parallel
    const results = await Promise.all(
      calls.map(async (call) => {
        onEvent({ type: "tool", round, tool: call.tool, args: call.args });
        let result;
        if (PAGE_TOOLS.has(call.tool)) {
          if (!runPageTool) {
            result = { error: "page tools need a live game page — open the in-game agent panel" };
          } else {
            try { result = await runPageTool(call.tool, call.args); }
            catch (error) { result = { error: String(error?.message ?? error).slice(0, 400) }; }
          }
        } else {
          try { result = await serverTool(env, call.tool, call.args, world); }
          catch (error) { result = { error: String(error?.message ?? error).slice(0, 400) }; }
        }
        onEvent({ type: "tool_done", round, tool: call.tool, ok: !(result && result.error) && !(result && result.ok === false), summary: summarizeResult(call, result) });
        return { call, result };
      }),
    );

    // screenshots: attach the image to the next call when the model can see
    const shot = results.find((r) => r.call.tool === "game_screenshot" && r.result && typeof r.result.image === "string");
    if (shot) pendingImage = canSee ? shot.result.image : null;

    const parts = results.map(({ call, result }) => {
      if (call.tool === "game_screenshot" && result && typeof result.image === "string") {
        return canSee
          ? `TOOL_RESULT (game_screenshot): captured — the image is attached to your next call`
          : `TOOL_RESULT (game_screenshot): captured, but the CURRENT model cannot see images; answer from other context`;
      }
      const serialized = typeof result === "string" ? result.slice(0, 3000) : JSON.stringify(result)?.slice(0, 3000) ?? String(result);
      return `TOOL_RESULT (${call.tool}): ${serialized}`;
    });
    messages.push({ role: "user", content: parts.join("\n") });
  }

  messages.push({ role: "user", content: "Tool budget exhausted. Answer the player now in plain text (no TOOL line)." });
  const final = await callModel(env, route, messages, null, (piece) => onEvent({ type: "delta", round: MAX_ROUNDS, phase: "final", text: piece }), isAborted);
  return { reply: final, actions, ttft };
}

function summarizeResult(call, result) {
  if (!result) return "";
  if (call.tool === "game_screenshot" && result.image) return `截图 ${result.w}×${result.h}`;
  if (call.tool === "game_command") {
    const cmd = Array.isArray(call.args?.command) ? call.args.command[0] : call.args?.command;
    const name = cmd?.cmd || "?";
    const oc = result?.outcome || result;
    if (result?.ok === false || oc?.applied === false) return `${name} ✗ ${String(oc?.code || result?.error || "failed").slice(0, 80)}`;
    return `${name} ✓ ${String(oc?.code || "applied").slice(0, 80)}`;
  }
  if (result.error) return String(result.error).slice(0, 90);
  if (typeof result === "string") return result.slice(0, 90);
  return "ok";
}

function trimHistory(history) {
  return history.length > HISTORY_CAP ? history.slice(-HISTORY_CAP) : history;
}

// ── the Durable Object agent ───────────────────────────────────────────

/** Batches delta events to ~1 frame per BATCH_MS. The in-game panel goes
 *  through a Pages Function WebSocket splice; a frame per model token
 *  (100-400 per reply) burns the function invocation's CPU budget and the
 *  proxy silently drops the connection — batching keeps a full reply to
 *  ~20-40 frames while staying live. */
const BATCH_MS = 120;

function makeDeltaBatcher(send) {
  let buf = "";
  let round = 0;
  let last = 0;
  const flush = () => {
    if (buf) {
      send({ type: "delta", round, text: buf });
      buf = "";
    }
    last = Date.now();
  };
  return function (evt) {
    if (evt && evt.type === "delta") {
      buf += evt.text;
      round = evt.round;
      if (Date.now() - last >= BATCH_MS) flush();
      return;
    }
    flush(); // any other event first drains the pending text, in order
    send(evt);
  };
}

export class DevAgent extends Agent {
  initialState = { messages: [] };

  constructor(ctx, env) {
    super(ctx, env);
    this.abortChat = false;
    // v4: parallel page tools each get their own slot, keyed by request id.
    // v3 kept ONE slot — extra tool_result frames became
    // `unknown message type` errors and results got cross-wired.
    this.pendingTools = new Map();
    // v5: a mirror of the in-flight turn so a RECONNECTING page can pick the
    // workflow back up instead of watching it "mysteriously break".
    this.liveTurn = null;
  }

  send(connectionOrEvent, obj) {
    try { connectionOrEvent.send(JSON.stringify(obj)); } catch {}
  }

  /** v5: every frame goes to EVERY live page connection. The initiating
   *  connection is just one of them — proxy hiccups and tab switches no
   *  longer orphan a turn. */
  broadcast(obj) {
    for (const conn of this.getConnections()) {
      try { conn.send(JSON.stringify(obj)); } catch {}
    }
  }

  async onConnect(connection) {
    this.send(connection, {
      type: "welcome", service: SERVICE, version: VERSION,
      models: MODEL_CATALOG, default_model: DEFAULT_MODEL,
      providers: providerModelList(),
      connected_pages: this.getConnections().length,
    });
    // v5 TAKEOVER: a turn is in flight — hand the newcomer the live state and
    // re-issue any page tools still pending (the page de-dupes by id and
    // replays cached results, so nothing runs twice).
    if (this.busy && this.liveTurn) {
      const lt = this.liveTurn;
      this.send(connection, {
        type: "turn_live", model: lt.model, round: lt.round, since: lt.since,
        stage: lt.stage, text: lt.text, tools: lt.tools.slice(-12),
      });
      for (const [id, pending] of this.pendingTools) {
        if (pending.connection !== connection) {
          pending.connection = connection;
          this.send(connection, { type: "tool_call", id, tool: pending.tool, args: pending.args, reissue: true });
        }
      }
    }
  }

  async onClose(connection) {
    // v5: DO NOT reject pending tools on one connection's close — a busy
    // turn may be waiting on them and another page connection (or a
    // reconnecting one, see onConnect) can still serve them. Only clean up
    // when the LAST connection is gone do we let the timeout handle it.
  }

  async onMessage(connection, message) {
    let msg;
    try { msg = typeof message === "string" ? JSON.parse(message) : message; }
    catch { return this.send(connection, { type: "error", error: "invalid JSON message" }); }

    // v5 heartbeat: keeps the Pages-Function WS splice (and every proxy on
    // the way) from reaping the connection as idle while a slow model thinks.
    if (msg?.type === "ping") {
      return this.send(connection, { type: "pong", t: typeof msg.t === "number" ? msg.t : null, busy: !!this.busy });
    }

    if (msg?.type === "chat") {
      if (this.busy) {
        const lt = this.liveTurn;
        const forMs = lt ? Date.now() - lt.since : 0;
        return this.send(connection, {
          type: "error",
          error: `上一个请求还在执行（已进行 ${Math.round(forMs / 1000)} 秒，可点「停止」或等它完成），稍候再发`,
        });
      }
      this.busy = true;
      this.abortChat = false;
      try { await this.handleChat(connection, msg); }
      catch (error) { this.broadcast({ type: "error", error: String(error?.message ?? error).slice(0, 400) }); }
      finally { this.busy = false; this.liveTurn = null; }
      return;
    }
    if (msg?.type === "abort") {
      if (this.busy) {
        this.abortChat = true;
        // unblock any page tools still waiting so the loop can exit now
        for (const [id, pending] of this.pendingTools) {
          clearTimeout(pending.timer);
          this.pendingTools.delete(id);
          pending.reject(new Error("已中断"));
        }
        this.broadcast({ type: "status", text: "正在中断…" });
      }
      return;
    }
    if (msg?.type === "tool_result") {
      // Parallel tool calls answer out of order — look up by id. A stale or
      // unknown id (already timed out / aborted) is dropped silently instead
      // of surfacing as an "unknown message type" error, which v3 did.
      const pending = msg?.id != null ? this.pendingTools.get(String(msg.id)) : null;
      if (!pending) return;
      this.pendingTools.delete(String(msg.id));
      clearTimeout(pending.timer);
      if (msg.ok === false) pending.reject(new Error(String(msg.result ?? msg.error ?? "tool failed").slice(0, 500)));
      else pending.resolve(msg.result ?? null);
      return;
    }
    if (msg?.type === "sync") {
      const all = this.state?.messages ?? [];
      this.send(connection, { type: "history", messages: all.slice(Math.max(0, all.length - REPLAY_CAP)) });
      return;
    }
    if (msg?.type === "reset") {
      this.setState({ messages: [] });
      this.send(connection, { type: "status", text: "history cleared" });
      return;
    }
    this.send(connection, { type: "error", error: `unknown message type "${String(msg?.type)}"` });
  }

  async handleChat(connection, msg) {
    const text = String(msg?.text ?? "").trim().slice(0, 4000);
    if (!text) throw new Error("empty message");
    const route = {
      model: String(msg?.model || DEFAULT_MODEL),
      custom: msg?.custom && typeof msg.custom === "object" ? msg.custom : null,
      providerKey: String(msg?.providerKey || "").slice(0, 220),
    };
    const world = msg?.world && typeof msg.world === "object" ? msg.world : null;
    const { label } = modelMeta(route);

    const history = (this.state?.messages ?? []).slice();
    history.push({ role: "user", content: text });

    const self = this;
    // v5: the live-turn mirror — updated on every event, replayed to any
    // connection that connects mid-turn (see onConnect).
    const lt = {
      model: label, since: Date.now(), round: 0, stage: "model",
      text: "", tools: [],
    };
    this.liveTurn = lt;
    const runPageTool = (tool, args) =>
      new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (self.pendingTools.delete(id)) reject(new Error(`page tool "${tool}" timed out（页面还在吗？）`));
        }, TOOL_TIMEOUT_MS);
        // v5: route to a LIVE connection — the initiating page may have
        // reconnected mid-turn; getConnections() is whoever is actually
        // connected right now.
        const target = self.getConnections()[0] ?? connection;
        self.pendingTools.set(id, { resolve, reject, timer, connection: target, tool, args });
        self.send(target, { type: "tool_call", id, tool, args });
      });

    const started = Date.now();
    const { reply, actions, ttft } = await agentLoop(
      this.env, history, route, world, runPageTool,
      makeDeltaBatcher((evt) => {
        try {
          if (evt.type === "delta") lt.text = (lt.text + evt.text).slice(-4000);
          else if (evt.type === "stage") { lt.round = evt.round ?? lt.round; lt.stage = evt.stage; }
          else if (evt.type === "thinking") lt.thinking = (lt.thinking ?? 0) + (evt.chars || 0);
          else if (evt.type === "tool") lt.tools.push({ tool: evt.tool, ok: null });
          else if (evt.type === "tool_done") {
            const open = [...lt.tools].reverse().find((t) => t.tool === evt.tool && t.ok === null);
            if (open) { open.ok = evt.ok; open.summary = evt.summary; }
          }
        } catch { /* the mirror must never break the real stream */ }
        self.broadcast(evt);
      }),
      () => this.abortChat,
    );

    if (this.abortChat) {
      this.broadcast({ type: "status", text: "已中断（本轮未完成的不计入历史）" });
      return;
    }

    history.push({ role: "assistant", content: reply });
    this.setState({ messages: trimHistory(history) });
    this.broadcast({
      type: "assistant", text: reply, model: label,
      actions: actions.length, ms: Date.now() - started, ttft: ttft ?? null,
    });
  }
}

// ── HTTP surface ───────────────────────────────────────────────────────

function landingPage() {
  const groups = TIER_ORDER.map((tier) => {
    const items = MODEL_CATALOG.filter((m) => m.tier === tier)
      .map((m) => `<li><code>${m.id}</code> — ${m.label}${m.note ? ` · ${m.note}` : ""}</li>`)
      .join("");
    return `<h2 style="font-size:13px;color:#7fa0b8;margin:14px 0 6px">${tier.toUpperCase()}</h2><ul>${items}</ul>`;
  }).join("");
  const providers = providerModelList()
    .map(
      (p) =>
        `<h2 style="font-size:13px;color:#7fa0b8;margin:14px 0 6px">${p.label} · BYOK 直连（${p.endpoint}）</h2>` +
        "<ul>" +
        p.models.map((m) => `<li><code>provider:${p.id}:${m.id}</code> — ${m.label}${m.note ? ` · ${m.note}` : ""}</li>`).join("") +
        "</ul>",
    )
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TheHumanBox · DevAgent</title>
<style>
  body { margin:0; font:15px/1.6 ui-monospace,Menlo,Consolas,monospace; background:#0b0f14; color:#c9d4de; padding:32px 16px; }
  .wrap { max-width:720px; margin:0 auto; }
  h1 { font-size:20px; color:#e8f0f8; } h1 span { color:#7dd3fc; }
  code, li { color:#9fd0a8; } a { color:#7dd3fc; }
  section { border:1px solid #1b2833; border-radius:10px; padding:14px 16px; margin:12px 0; background:#0e141b; }
  pre { background:#080c10; border:1px solid #16222d; border-radius:7px; padding:10px; overflow:auto; font-size:12.5px; color:#9fd0a8; }
  ul { margin:4px 0; padding-left:18px; }
</style></head><body><div class="wrap">
  <h1>TheHumanBox <span>DevAgent</span> <small style="color:#6d7f8f">v${VERSION}</small></h1>
  <p>Streaming super-agent on the Cloudflare Agents SDK. In-game: <a href="https://thehumanbox-upstream.pages.dev">thehumanbox-upstream.pages.dev</a> → ⚡ SUPER → <b>Agent</b> tab.</p>
  <section><h2 style="font-size:13px;color:#7fa0b8;margin:0 0 8px">V5 · 抗断 & 深控</h2>
    Broadcast to every live connection + turn takeover on reconnect · <code>&lt;function=…&gt;</code> native-calling syntax parsed + self-heal rounds · TTFT/stall watchdogs instead of one total timeout · silent retry on 429/5xx/network · heartbeat ping/pong · new page tools game_deep / game_scan / game_find / game_focus (real positions from the engine's own frame) · BYOK provider direct-connect (智谱 / NaiveAI / Agnes) · the 94-command catalog.</section>
  <section><h2 style="font-size:13px;color:#7fa0b8;margin:0 0 8px">WORKERS AI（免费，模型 id 原样使用）</h2>${groups}</section>
  <section><h2 style="font-size:13px;color:#7fa0b8;margin:0 0 8px">BYOK PROVIDERS（自带 Key，worker 直连官方端点）</h2>${providers}</section>
  <section><h2 style="font-size:13px;color:#7fa0b8;margin:0 0 8px">HTTP SMOKE</h2>
    <pre>GET  /health
GET  /models
GET  /commands
POST /chat  {"text":"hi","model":"@cf/meta/llama-3.3-70b-instruct-fp8-fast"}
POST /chat  {"text":"hi","model":"provider:zhipu:glm-5.3-flash","providerKey":"sk-…"}
POST /chat?stream=1   (SSE)</pre></section>
</div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: jsonHeaders() });
    if (path === "/health" && request.method === "GET") {
      return json({ ok: true, service: SERVICE, version: VERSION, models: MODEL_CATALOG.length + 2, providers: Object.keys(PROVIDERS).length, provider_models: Object.values(PROVIDERS).reduce((n, p) => n + p.models.length, 0), commands: COMMAND_CATALOG.commands.length, time: new Date().toISOString() });
    }
    if (path === "/models" && request.method === "GET") {
      return json({ ok: true, default_model: DEFAULT_MODEL, models: MODEL_CATALOG, tiers: TIER_ORDER, providers: providerModelList() });
    }
    if (path === "/commands" && request.method === "GET") {
      return json({ ok: true, version: VERSION, catalog: COMMAND_CATALOG });
    }
    if (path === "/" && request.method === "GET") return landingPage();

    if (path === "/chat" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const text = String(body?.text ?? "").trim().slice(0, 4000);
      if (!text) return json({ ok: false, error: "text is required" }, 400);
      const route = {
        model: String(body?.model || DEFAULT_MODEL),
        custom: body?.custom && typeof body.custom === "object" ? body.custom : null,
        providerKey: String(body?.providerKey || "").slice(0, 220),
      };
      const world = body?.world && typeof body.world === "object" ? body.world : null;
      const history = [{ role: "user", content: text }];
      const wantStream = url.searchParams.get("stream") === "1";
      try {
        if (wantStream) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              const send = (obj) => {
                try { controller.enqueue(encoder.encode("data: " + JSON.stringify(obj) + "\n\n")); } catch {}
              };
              try {
                const { reply, actions, ttft } = await agentLoop(env, history, route, world, null, makeDeltaBatcher(send), () => false);
                send({ type: "assistant", text: reply, actions: actions.length, ttft });
              } catch (error) {
                send({ type: "error", error: String(error?.message ?? error) });
              }
              try { controller.close(); } catch {}
            },
          });
          return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" } });
        }
        const { reply, actions } = await agentLoop(env, history, route, world, null, () => {}, () => false);
        return json({ ok: true, reply, actions: actions.map((a) => a.tool) });
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 502);
      }
    }

    const routed = await routeAgentRequest(request, env, { cors: { "Access-Control-Allow-Origin": "*" } });
    return routed ?? json({ ok: false, error: "not found — routes: /, /health, /models, /commands, /chat, /agents/dev-agent/{name}" }, 404);
  },
};

// Exposed for local tests (scripts/test-agent-core.mjs) and debugging.
export {
  agentLoop, parseToolCalls, parseFunctionBlocks, parseKeyValueArgs, looksLikeToolAttempt, callModel, callModelOnce, callProvider, pumpSse, pieceFromPayload, reasoningFromPayload, makeDeltaBatcher, makeWatchdog, transientError,
  MODEL_CATALOG, DEFAULT_MODEL, COMMAND_CATALOG, PROVIDERS, providerModel, modelMeta, systemPrompt, snapshotBlock,
};
