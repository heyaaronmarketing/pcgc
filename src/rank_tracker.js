/* PCGC rank tracker — DataForSEO SERP scanner.
 *
 * Adapted from jacbuildersfl-rebuild/worker/rank.js (proven pattern, ported
 * for PCGC's single-location geography and smaller keyword universe).
 *
 * Two numbers per keyword per sweep:
 *   position  — organic rank of a polkcountygolfcarts.com URL in SERPs
 *   map_pack  — rank in Google's local pack (3-pack), matched on PCGC's
 *               Google Business Profile CID if GBP_CID env is set; falls back
 *               to domain match (looser, but better than nothing).
 *
 * Cost math — DataForSEO live-advanced depth-100 is ~$0.0155 per keyword.
 * A full 40-keyword sweep at depth=100 is ~$0.62. Default cadence: monthly.
 *
 * Chunked execution so the Worker doesn't run out of time on a single
 * invocation. Cursor lives in cs_meta (same k/v table the case-study feed uses).
 */

const API = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
const OUR_DOMAIN = "polkcountygolfcarts.com";
const CURSOR_KEY = "rank_cursor";
const LAST_DONE_KEY = "rank_last_completed";
const PERIOD_DAYS = 28;

// Livingston, TX anchor — serves as the default geo for every keyword
// unless a specific town is attached below. Latitude/longitude are the
// published coordinates of the PCGC shop (1732 FM 3277, Livingston TX 77351).
const DEFAULT_LAT = 30.7108;
const DEFAULT_LNG = -94.9336;

// Keyword universe. Each entry: { keyword, url (what we want to rank),
// lat/lng (optional — defaults to the shop). Secondary variants are allowed
// so the tracker counts a page's spread of queries, not just the headline.
//
// Add/remove here and run /api/rank-sync?reset=1&t=TOKEN to re-baseline.
const TARGETS = [
  // Brand (should be #1 everywhere — baseline for sanity)
  { url: "/", keyword: "polk county golf carts" },
  { url: "/", keyword: "polk county golf carts llc" },
  { url: "/", keyword: "golf carts livingston tx" },
  { url: "/", keyword: "livingston golf carts" },
  { url: "/", keyword: "golf cart dealer livingston" },

  // Core service — the ROI machine per growth plan
  { url: "/services/", keyword: "golf cart repair" },
  { url: "/services/", keyword: "golf cart repair near me" },
  { url: "/services/", keyword: "golf cart service livingston tx" },
  { url: "/services/", keyword: "golf cart battery replacement" },
  { url: "/services/", keyword: "golf cart mechanic near me" },
  { url: "/services/", keyword: "golf cart tune up" },

  // Sales — used and new
  { url: "/carts/", keyword: "golf carts for sale" },
  { url: "/carts/", keyword: "golf carts for sale livingston tx" },
  { url: "/carts/", keyword: "used golf carts for sale" },
  { url: "/carts/", keyword: "used golf carts livingston tx" },
  { url: "/carts/", keyword: "4 seater golf cart for sale" },
  { url: "/carts/", keyword: "6 seater golf cart for sale" },

  // Rentals — lake-driven seasonality
  { url: "/rentals/", keyword: "golf cart rental lake livingston" },
  { url: "/rentals/", keyword: "golf cart rental livingston tx" },
  { url: "/rentals/", keyword: "rent golf cart lake livingston" },

  // Breezy EV authorized dealer — brand defense
  { url: "/breezy-ev/", keyword: "breezy ev dealer" },
  { url: "/breezy-ev/", keyword: "breezy ev livingston" },
  { url: "/breezy-ev/", keyword: "breezy ev texas" },

  // Lithium — highest-margin service line
  { url: "/guides/", keyword: "golf cart lithium conversion" },
  { url: "/guides/", keyword: "lithium battery golf cart" },
  { url: "/guides/", keyword: "lithium conversion kit golf cart" },

  // Street legal / LSV — sits on the dedicated hub page
  { url: "/street-legal-texas/", keyword: "street legal golf cart texas" },
  { url: "/street-legal-texas/", keyword: "lsv texas" },
  { url: "/street-legal-texas/", keyword: "are golf carts street legal in texas" },

  // Financing / RTO — the John-pitch anchor
  { url: "/rent-to-own/", keyword: "golf cart rent to own" },
  { url: "/rent-to-own/", keyword: "rent to own golf cart texas" },
  { url: "/financing/", keyword: "golf cart financing bad credit" },

  // Town-geo pages — one each, highest-value towns
  { url: "/golf-carts/coldspring-tx/", keyword: "golf carts coldspring tx",
    lat: 30.5929, lng: -95.1261 },
  { url: "/golf-carts/onalaska-tx/", keyword: "golf carts onalaska tx",
    lat: 30.8085, lng: -95.1127 },
  { url: "/golf-carts/shepherd-tx/", keyword: "golf carts shepherd tx",
    lat: 30.4916, lng: -94.9955 },
  { url: "/golf-carts/huntsville-tx/", keyword: "golf cart repair huntsville tx",
    lat: 30.7235, lng: -95.5508 },
  { url: "/golf-carts/point-blank-tx/", keyword: "golf cart lake livingston",
    lat: 30.7563, lng: -95.2197 },
  { url: "/golf-carts/livingston-tx/", keyword: "golf cart delivery livingston tx" },

  // Houston DMA — the volume play per the plan
  { url: "/carts/", keyword: "golf cart dealer houston",
    lat: 29.7604, lng: -95.3698 },
  { url: "/carts/", keyword: "golf carts near houston",
    lat: 29.7604, lng: -95.3698 },
];

const json = (o, s = 200) =>
  new Response(JSON.stringify(o, null, 1),
    { status: s, headers: { "content-type": "application/json; charset=utf-8" } });

async function getMeta(env, key) {
  try {
    const r = await env.DB.prepare("SELECT v FROM cs_meta WHERE k = ?").bind(key).first();
    return r ? r.v : null;
  } catch (e) { return null; }
}

async function putMeta(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO cs_meta (k, v, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = CURRENT_TIMESTAMP`
  ).bind(key, String(value)).run();
}

// Ensure rank table exists. Called lazily on first sweep so there's no
// separate migration step to remember.
async function ensureRankSchema(env) {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS cs_rankings (" +
    "checked TEXT NOT NULL, url TEXT NOT NULL, keyword TEXT NOT NULL, " +
    "position INTEGER, map_pack INTEGER, source TEXT, " +
    "PRIMARY KEY (checked, url, keyword))"
  );
}

function readSerp(payload, cid) {
  const task = (payload?.tasks || [])[0] || {};
  const result = (task.result || [])[0] || {};
  const items = result.items || [];
  let position = null, mapPack = null;
  for (const it of items) {
    if (it.type === "organic" && position === null) {
      const d = String(it.domain || "");
      if (d === OUR_DOMAIN || d.endsWith("." + OUR_DOMAIN)) position = it.rank_group ?? null;
    }
    if (it.type === "local_pack" && mapPack === null) {
      const sameCid = cid && String(it.cid || "") === String(cid);
      const d = String(it.domain || "");
      const sameDomain = d === OUR_DOMAIN || d.endsWith("." + OUR_DOMAIN);
      if (sameCid || sameDomain) mapPack = it.rank_group ?? null;
    }
  }
  return { position, mapPack };
}

async function callSerp(env, task, depth, ms = 45000) {
  const auth = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const lat = task.lat || DEFAULT_LAT;
  const lng = task.lng || DEFAULT_LNG;
  const body = [{
    keyword: task.keyword,
    language_code: "en",
    device: "mobile",
    depth,
    location_coordinate: `${lat},${lng},20`,
  }];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(API, {
      method: "POST", signal: ctrl.signal,
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { payload: await r.json() };
  } catch (e) {
    return { error: String(e && e.message || e) };
  } finally { clearTimeout(timer); }
}

async function pooled(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

/**
 * Manual trigger. Query params:
 *   depth=100      (10|20|100 — cost tiers $0.002 / $0.0035 / $0.0155 per keyword)
 *   limit=40       (max keywords this invocation processes)
 *   dry=1          (price the sweep without calling the API)
 *   reset=1        (reset the cursor to 0 before running)
 *   t=TOKEN        (shared secret — env.RANK_TOKEN)
 */
export async function handleRankSync(request, url, env) {
  if (!env.RANK_TOKEN || url.searchParams.get("t") !== env.RANK_TOKEN) {
    return new Response("Not found", { status: 404 });
  }
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    return json({ ok: false, error: "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set" }, 400);
  }
  if (!env.DB) return json({ ok: false, error: "no DB binding" }, 400);
  await ensureRankSchema(env);

  const depth = Math.min(100, Math.max(10, Number(url.searchParams.get("depth")) || 100));
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get("limit")) || 40));
  const dry = url.searchParams.get("dry") === "1";
  const reset = url.searchParams.get("reset") === "1";

  const all = TARGETS.slice().sort((a, b) => (a.url + a.keyword).localeCompare(b.url + b.keyword));
  if (reset) await putMeta(env, CURSOR_KEY, 0);
  const cursor = reset ? 0 : Number(await getMeta(env, CURSOR_KEY)) || 0;
  const slice = all.slice(cursor, cursor + limit);

  if (dry) {
    const perKw = depth >= 100 ? 0.0155 : depth >= 20 ? 0.0035 : 0.002;
    return json({ ok: true, dry: true, total: all.length, cursor,
      wouldDo: slice.length, depth,
      estimatedCostUsd: +(slice.length * perKw).toFixed(4),
      sample: slice.slice(0, 5).map((t) => t.keyword) });
  }
  if (!slice.length) {
    await putMeta(env, CURSOR_KEY, 0);
    await putMeta(env, LAST_DONE_KEY, new Date().toISOString().slice(0, 10));
    return json({ ok: true, done: true, total: all.length, note: "sweep complete" });
  }

  const cid = env.GBP_CID || null;
  const checked = new Date().toISOString().slice(0, 10);
  const rows = await pooled(slice, 4, async (t) => {
    const { payload, error } = await callSerp(env, t, depth);
    if (error) return { ...t, error };
    const { position, mapPack } = readSerp(payload, cid);
    return { ...t, position, mapPack, cost: payload?.cost || 0 };
  });

  const ok = rows.filter((r) => !r.error);
  const stmts = [];
  for (const r of ok) {
    stmts.push(env.DB.prepare(
      `DELETE FROM cs_rankings WHERE checked = ? AND url = ? AND keyword = ?`
    ).bind(checked, r.url, r.keyword));
    stmts.push(env.DB.prepare(
      `INSERT INTO cs_rankings (checked, url, keyword, position, map_pack, source)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(checked, r.url, r.keyword, r.position, r.mapPack, `dataforseo:d${depth}`));
  }
  if (stmts.length) await env.DB.batch(stmts);

  const next = cursor + slice.length;
  const finished = next >= all.length;
  await putMeta(env, CURSOR_KEY, finished ? 0 : next);
  if (finished) await putMeta(env, LAST_DONE_KEY, checked);

  return json({
    ok: true, checked, depth, total: all.length,
    from: cursor, processed: slice.length, written: ok.length,
    failed: rows.length - ok.length,
    costUsd: +ok.reduce((a, r) => a + (r.cost || 0), 0).toFixed(4),
    ranked: ok.filter((r) => r.position != null).length,
    inPack: ok.filter((r) => r.mapPack != null).length,
    cursor: finished ? 0 : next, sweepComplete: finished,
    errors: rows.filter((r) => r.error).slice(0, 5).map((r) => `${r.keyword}: ${r.error}`),
  });
}

/**
 * Cron entry. Called from the weekly scheduled handler. Walks a chunk a week
 * until the sweep finishes, then sits idle until PERIOD_DAYS has passed.
 */
export async function scheduledRankSync(env, origin) {
  if (!env.DATAFORSEO_LOGIN || !env.DB || !env.RANK_TOKEN) return;
  await ensureRankSchema(env);
  const cursor = Number(await getMeta(env, CURSOR_KEY)) || 0;
  if (cursor === 0) {
    const last = await getMeta(env, LAST_DONE_KEY);
    if (last) {
      const days = (Date.now() - Date.parse(last + "T00:00:00Z")) / 86400000;
      if (days < PERIOD_DAYS) return;  // mid-period, nothing to do
    }
  }
  const u = new URL(origin + "/api/rank-sync");
  u.searchParams.set("t", env.RANK_TOKEN);
  await handleRankSync(new Request(u.toString()), u, env);
}

/**
 * Pull the latest full sweep + 30/60-day deltas for the case-study feed.
 * Called from handleCaseStudyJson to add a `rankings` block.
 */
export async function getRankingsForFeed(env) {
  if (!env.DB) return null;
  try {
    await ensureRankSchema(env);
    const [latest, prior, all] = await Promise.all([
      env.DB.prepare(
        `SELECT keyword, url, position, map_pack, checked FROM cs_rankings
         WHERE checked = (SELECT MAX(checked) FROM cs_rankings)`
      ).all(),
      env.DB.prepare(
        `SELECT keyword, url, position, map_pack FROM cs_rankings
         WHERE checked = (SELECT MAX(checked) FROM cs_rankings
                          WHERE checked < (SELECT MAX(checked) FROM cs_rankings))`
      ).all(),
      env.DB.prepare(
        `SELECT COUNT(DISTINCT checked) AS sweeps,
                MIN(checked) AS first, MAX(checked) AS last
         FROM cs_rankings`
      ).first(),
    ]);
    const now = latest.results || [];
    const before = new Map();
    for (const r of prior.results || []) before.set(r.url + "|" + r.keyword, r);
    const rankedCount = now.filter((r) => r.position != null).length;
    const inPackCount = now.filter((r) => r.map_pack != null).length;
    const movers = now.filter((r) => {
      const p = before.get(r.url + "|" + r.keyword);
      return p && p.position != null && r.position != null &&
             Math.abs(p.position - r.position) >= 3;
    }).slice(0, 10).map((r) => {
      const p = before.get(r.url + "|" + r.keyword);
      return { keyword: r.keyword, url: r.url, from: p.position, to: r.position,
               delta: p.position - r.position };
    });
    return {
      total_keywords: now.length,
      ranked_in_top_100: rankedCount,
      in_local_pack: inPackCount,
      sweeps_recorded: all?.sweeps || 0,
      first_sweep: all?.first || null,
      last_sweep: all?.last || null,
      top_wins: now.filter((r) => r.position != null && r.position <= 10)
        .sort((a, b) => a.position - b.position).slice(0, 10)
        .map((r) => ({ keyword: r.keyword, position: r.position, map_pack: r.map_pack })),
      biggest_movers: movers,
      source: "DataForSEO SERP Google organic (live/advanced)",
    };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}
