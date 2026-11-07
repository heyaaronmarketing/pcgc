// =====================================================================
// PCGC Case-Study Pipeline — module
// =====================================================================
// Ported from the midwestcnc reference implementation
// (github.com/heyaaronmarketing/midwestcnc/public/worker.js lines 939-1950)
// Keep this file self-contained: all helpers it needs live below, so the
// main worker.js just has to import the handlers and route to them.
// =====================================================================

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function b64UrlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    },
  });
}

const BASE_CSS = `
  :root {
    --accent: #e85a4f; --accent-dark: #c2473e; --line: #e4e2df;
    --surface: #ffffff; --surface-2: #fbf8f3; --bg: #fdfbf7;
    --fg: #1a1a1a; --muted: #6b6b6b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.55 -apple-system, BlinkMacSystemFont,
    "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg); color: var(--fg); }
  a { color: var(--accent-dark); }
  header.admin-nav { background: #1f5a68; color: #fff; padding: 12px 24px;
    display: flex; align-items: center; gap: 20px; }
  header.admin-nav a { color: #fff; text-decoration: none; opacity: 0.85; }
  header.admin-nav a:hover { opacity: 1; }
  header.admin-nav .brand { font-weight: 700; letter-spacing: 0.02em; }
  header.admin-nav .spacer { flex: 1; }
  main.admin { max-width: 1200px; margin: 0 auto; padding: 24px; }
  h1 { margin: 0 0 16px 0; font-size: 1.5rem; }
  h2 { margin: 24px 0 8px 0; font-size: 1.1rem; }
  .btn { display: inline-block; padding: 8px 14px; background: var(--accent);
    color: #fff; text-decoration: none; border: 0; border-radius: 6px;
    cursor: pointer; font: inherit; font-weight: 600; }
  .btn:hover { background: var(--accent-dark); }
  .btn.secondary { background: #fff; color: var(--fg); border: 1px solid var(--line); }
  table.admin-table { width: 100%; border-collapse: collapse; background: #fff;
    border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  table.admin-table th, table.admin-table td {
    padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; }
  table.admin-table th { background: var(--surface-2); font-weight: 600;
    font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  table.admin-table tr:last-child td { border-bottom: 0; }
  .empty { padding: 40px; text-align: center; color: var(--muted); background: #fff;
    border-radius: 8px; border: 1px dashed var(--line); }
  .toast { padding: 10px 14px; background: #e6f9ee; border: 1px solid #b8e6c5;
    border-radius: 6px; color: #1b7a3a; margin-bottom: 16px; }
  .detail { background: #fff; border-radius: 8px; padding: 24px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  form.update-form { display: flex; flex-direction: column; gap: 12px; }
  form.update-form textarea { font: inherit; padding: 8px 10px;
    border: 1px solid var(--line); border-radius: 6px; background: #fff;
    min-height: 120px; resize: vertical; }
`;

function renderLayout(title, body, opts = {}) {
  const nav = opts.hideNav ? "" : `
    <header class="admin-nav">
      <span class="brand">Polk County Golf Carts — Admin</span>
      <a href="/admin/">Bookings</a>
      <a href="/admin/case-study">Case Study</a>
      <a href="/admin/traffic">Traffic</a>
      <span class="spacer"></span>
    </header>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${BASE_CSS}</style>
</head><body>
${nav}
<main class="admin">${body}</main>
</body></html>`;
}
// =====================================================================
// Case study data — /api/case-study.json + /admin/case-study
// =====================================================================
// Public JSON endpoint consumed by heyaaronmarketing.com case study
// pages. Data lives in D1 (gsc_daily, gsc_queries, gsc_pages, ai_daily).
// Admin page lets Aaron paste CSV exports from GSC + the AI Performance
// Overview to refresh the data until API crons are wired up.
// =====================================================================

const CASE_STUDY_SCHEMA = `
CREATE TABLE IF NOT EXISTS cs_gsc_daily (
  date TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cs_gsc_queries (
  query TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cs_gsc_pages (
  page TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cs_ai_daily (
  date TEXT PRIMARY KEY,
  citations INTEGER NOT NULL DEFAULT 0,
  cited_pages INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cs_meta (
  k TEXT PRIMARY KEY,
  v TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

async function ensureCaseStudySchema(env) {
  if (!env.DB) return false;
  await env.DB.exec(CASE_STUDY_SCHEMA.replace(/\n/g, " ")).catch(() => {});
  return true;
}

async function handleCaseStudyJson(env) {
  if (!env.DB) return jsonResponse({ error: "database not configured" }, 503);
  await ensureCaseStudySchema(env);

  const [daily, queries, pages, ai, metaRows, leads, traffic] = await Promise.all([
    env.DB.prepare("SELECT date, clicks, impressions, position FROM cs_gsc_daily ORDER BY date").all(),
    env.DB.prepare("SELECT query, clicks, position FROM cs_gsc_queries WHERE clicks > 0 ORDER BY clicks DESC LIMIT 25").all(),
    env.DB.prepare("SELECT page, clicks, impressions, position FROM cs_gsc_pages WHERE clicks > 0 ORDER BY clicks DESC LIMIT 25").all(),
    env.DB.prepare("SELECT date, citations, cited_pages FROM cs_ai_daily ORDER BY date").all(),
    env.DB.prepare("SELECT k, v FROM cs_meta").all(),
    countKvLeads(env).catch(() => ({ total: 0, breakdown: {} })),
    caseStudyTrafficSection(env),
  ]);

  const meta = {};
  for (const row of metaRows.results || []) meta[row.k] = row.v;

  const dailyRows = daily.results || [];
  const gsc = summarizeGsc(dailyRows);
  const aiRows = ai.results || [];
  const aiSummary = summarizeAi(aiRows);
  const allTime = totals(dailyRows);
  const firstDate = dailyRows.length ? dailyRows[0].date : null;
  const lastDate = dailyRows.length ? dailyRows[dailyRows.length - 1].date : null;

  const headline = [];
  if (aiSummary.delta.citations_pct !== null && aiSummary.delta.citations_pct !== undefined) {
    headline.push({ label: "AI citations, last 30d vs prior 30d", value: aiSummary.last30.citations, delta_pct: aiSummary.delta.citations_pct, source: "Bing AI Performance Overview" });
  }
  if (gsc.delta.clicks_pct !== null && gsc.delta.clicks_pct !== undefined) {
    headline.push({ label: "Google clicks, last 90d vs prior 90d", value: gsc.last90.clicks, delta_pct: gsc.delta.clicks_pct, source: "Google Search Console" });
  }
  headline.push(
    { label: "AI citations, all-time", value: aiSummary.total, source: "Bing AI Performance Overview" },
    { label: "Google clicks, all-time", value: allTime.clicks, source: "Google Search Console" },
    { label: "Google impressions, all-time", value: allTime.impressions, source: "Google Search Console" },
    { label: "Avg Google rank, last 90d", value: round(gsc.last90.position, 1), source: "Google Search Console" },
    { label: "Total leads captured", value: leads.total, source: "Cloudflare KV (bookings + service + payment leads)" },
  );

  return jsonResponse({
    schema_version: "1.1",
    slug: "polkcountygolfcarts",
    last_updated: new Date().toISOString(),
    data_as_of: meta.data_as_of || null,
    client: {
      name: "Polk County Golf Carts",
      industry: "Golf cart sales · service · rentals · Breezy EV authorized dealer",
      location: "Livingston, Texas",
      service_area_states: 1,
      website: "https://polkcountygolfcarts.com",
      launched: "2026-06-10",
      bing_portfolio_topic: {
        primary: meta.bing_topic_primary || null,
        volume_range: meta.bing_topic_volume_range || null,
        queries_range: meta.bing_topic_queries_range || null,
        sites_range: meta.bing_topic_sites_range || null,
      },
    },
    headline_stats: headline,
    google_search: {
      all_time: { clicks: allTime.clicks, impressions: allTime.impressions,
        avg_position: round(allTime.position, 1), days: dailyRows.length,
        first_date: firstDate, last_date: lastDate },
      last_90d: { clicks: gsc.last90.clicks, impressions: gsc.last90.impressions, avg_position: round(gsc.last90.position, 1) },
      prior_90d: { clicks: gsc.prior90.clicks, impressions: gsc.prior90.impressions, avg_position: round(gsc.prior90.position, 1) },
      delta_90d: { clicks_pct: gsc.delta.clicks_pct, impressions_pct: gsc.delta.impressions_pct },
      queries_ranking: (queries.results || []).length,
      top_queries: (queries.results || []).slice(0, 25).map((q) => ({ query: q.query, clicks: q.clicks, position: round(q.position, 1) })),
      top_pages: (pages.results || []).slice(0, 25).map((p) => ({ page: p.page, clicks: p.clicks, position: round(p.position, 1) })),
      daily: dailyRows.map((d) => ({ date: d.date, clicks: d.clicks, impressions: d.impressions })),
      source: "Google Search Console",
      updated: meta.gsc_updated || null,
      last_error: meta.gsc_last_error || null,
    },
    ai_search: {
      all_time: { total_citations: aiSummary.total, days: aiRows.length,
        first_date: aiRows.length ? aiRows[0].date : null,
        last_date: aiRows.length ? aiRows[aiRows.length - 1].date : null },
      last_30d: { citations: aiSummary.last30.citations, pages_cited: aiSummary.last30.pages },
      prior_30d_citations: aiSummary.prior30,
      delta_30d_pct: aiSummary.delta.citations_pct,
      best_day: aiSummary.best_day,
      monthly: aiSummary.monthly,
      daily: aiRows.map((d) => ({ date: d.date, citations: d.citations, cited_pages: d.cited_pages })),
      source: "Bing — AI Performance Overview",
      updated: meta.ai_updated || null,
      last_error: meta.ai_last_error || null,
    },
    leads: {
      total_submissions: leads.total,
      by_type: leads.breakdown,
      source: "Cloudflare KV",
    },
    traffic_signals: traffic,
    site_structure: {
      pages: 40,
      static_generator_lines: 2961,
      guides: 4,
      town_pages: 11,
      product_pages: 4,
    },
    capabilities_shown: [
      "Static-site build system → Cloudflare Workers (apex + www bound)",
      "KV-backed rental booking + e-signed agreement PDFs",
      "Payment calculator + lead-form hidden page with Resend email",
      "Review request pipeline with scheduled follow-ups via Resend",
      "GSC + Bing cron fetchers feeding /api/case-study.json",
      "IndexNow protocol pings Bing/Yandex on every content refresh",
      "Server-side AI-bot traffic log (GPTBot, ClaudeBot, PerplexityBot)",
    ],
  });
}

// Count leads across the three PCGC KV key prefixes.
async function countKvLeads(env) {
  if (!env.FEEDBACK_KV) return { total: 0, breakdown: {} };
  const breakdown = { booking: 0, "service-request": 0, "payment-lead": 0 };
  for (const prefix of Object.keys(breakdown)) {
    let cursor = undefined, count = 0;
    while (true) {
      const r = await env.FEEDBACK_KV.list({ prefix: prefix + ":", cursor, limit: 1000 });
      count += r.keys.length;
      if (r.list_complete || !r.cursor) break;
      cursor = r.cursor;
    }
    breakdown[prefix] = count;
  }
  return { total: Object.values(breakdown).reduce((a, b) => a + b, 0), breakdown };
}
function round(n, dp) {
  if (n === null || n === undefined || !isFinite(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function summarizeGsc(rows) {
  if (!rows.length) {
    return {
      last90:  { clicks: 0, impressions: 0, position: 0 },
      prior90: { clicks: 0, impressions: 0, position: 0 },
      delta:   { clicks_pct: 0, impressions_pct: 0 },
    };
  }
  const last90 = totals(rows.slice(-90));
  const prior90 = totals(rows.slice(-180, -90));
  return {
    last90, prior90,
    delta: {
      clicks_pct: prior90.clicks ? Math.round(((last90.clicks - prior90.clicks) / prior90.clicks) * 100) : null,
      impressions_pct: prior90.impressions ? Math.round(((last90.impressions - prior90.impressions) / prior90.impressions) * 100) : null,
    },
  };
}

function totals(rows) {
  if (!rows.length) return { clicks: 0, impressions: 0, position: 0 };
  let c = 0, i = 0, p = 0;
  for (const r of rows) { c += r.clicks; i += r.impressions; p += r.position; }
  return { clicks: c, impressions: i, position: p / rows.length };
}

function summarizeAi(rows) {
  if (!rows.length) {
    return {
      total: 0,
      last30: { citations: 0, pages: 0 },
      prior30: 0,
      delta: { citations_pct: null },
      best_day: null,
      monthly: [],
    };
  }
  const last30 = rows.slice(-30);
  const prior30 = rows.slice(-60, -30);
  const sumC = (rs) => rs.reduce((a, r) => a + r.citations, 0);
  const total = sumC(rows);
  const l30 = sumC(last30);
  const p30 = sumC(prior30);
  const bestDay = rows.reduce((best, r) => (r.citations > (best?.citations || 0) ? r : best), null);
  const byMonth = {};
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { month: m, citations: 0, days: 0 };
    byMonth[m].citations += r.citations;
    byMonth[m].days += 1;
  }
  return {
    total,
    last30: { citations: l30, pages: Math.max(0, ...last30.map((r) => r.cited_pages)) },
    prior30: p30,
    delta: { citations_pct: p30 ? Math.round(((l30 - p30) / p30) * 100) : null },
    best_day: bestDay
      ? { date: bestDay.date, citations: bestDay.citations, cited_pages: bestDay.cited_pages }
      : null,
    monthly: Object.values(byMonth),
  };
}

// ---------- Admin case-study page ----------

async function handleCaseStudyAdminPage(env) {
  if (!env.DB) {
    return htmlResponse(renderLayout("Case Study", `<p>DB not configured.</p>`));
  }
  await ensureCaseStudySchema(env);
  const [daily, ai, meta] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM cs_gsc_daily").first(),
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM cs_ai_daily").first(),
    env.DB.prepare("SELECT k, v FROM cs_meta").all(),
  ]);
  const metaMap = {};
  for (const r of meta.results || []) metaMap[r.k] = r.v;

  const body = `
    <p><a href="/admin">&larr; All leads</a></p>
    <h1>Case Study Data</h1>
    <p style="color:var(--muted);">
      Powers <code>/api/case-study.json</code>. Weekly cron (Mon 7 AM Central)
      pulls GSC + Bing automatically. Paste CSVs below for one-off AI
      Overview refreshes or manual catch-up.
    </p>

    <div class="detail">
      <h2>Current data</h2>
      <dl class="kv">
        <dt>GSC daily rows</dt>   <dd>${daily?.n || 0} ${daily?.first ? `(${daily.first} → ${daily.last})` : ""}</dd>
        <dt>AI daily rows</dt>    <dd>${ai?.n || 0} ${ai?.first ? `(${ai.first} → ${ai.last})` : ""}</dd>
        <dt>GSC last updated</dt> <dd>${esc(metaMap.gsc_updated || "never")} ${metaMap.gsc_last_error ? `<span class="email-badge fail">error</span> <small style="color:var(--muted);">${esc(metaMap.gsc_last_error)}</small>` : ""}</dd>
        <dt>Bing last updated</dt><dd>${esc(metaMap.bing_updated || "never")} ${metaMap.bing_last_error ? `<span class="email-badge fail">error</span> <small style="color:var(--muted);">${esc(metaMap.bing_last_error)}</small>` : ""}</dd>
        <dt>Data as of</dt>       <dd>${esc(metaMap.data_as_of || "never")}</dd>
        <dt>Live JSON</dt>        <dd><a href="/api/case-study.json" target="_blank">/api/case-study.json</a></dd>
      </dl>

      <form method="POST" action="/admin/case-study/refresh" style="margin-top:16px;">
        <button type="submit" class="btn">Refresh GSC + Bing now</button>
        <small style="color:var(--muted);margin-left:12px;">Pulls latest 90 days. Runs automatically every Monday.</small>
      </form>

      <form class="update-form" method="POST" action="/admin/case-study" enctype="multipart/form-data">
        <label for="csv_type">Which CSV is this?</label>
        <select id="csv_type" name="csv_type">
          <option value="gsc_chart">GSC — Chart.csv (daily clicks/impressions/CTR/position)</option>
          <option value="gsc_queries">GSC — Queries.csv (query / clicks / impressions / CTR / position)</option>
          <option value="gsc_pages">GSC — Pages.csv (page / clicks / impressions / CTR / position)</option>
          <option value="ai_overview">AI Performance Overview (Date / Citations / Cited Pages)</option>
        </select>

        <label for="csv_text">Paste CSV content here:</label>
        <textarea id="csv_text" name="csv_text" placeholder="Copy the CSV file contents and paste here.&#10;First row = headers, same as GSC exports."></textarea>

        <button type="submit" class="btn">Upload &amp; refresh</button>
      </form>
    </div>
  `;
  return htmlResponse(renderLayout("Case Study — Admin", body));
}

async function handleCaseStudyUpload(request, env, url) {
  await ensureCaseStudySchema(env);
  const form = await request.formData().catch(() => null);
  if (!form) return new Response("Bad request", { status: 400 });
  const csvType = (form.get("csv_type") || "").toString();
  const csvText = (form.get("csv_text") || "").toString().trim();
  if (!csvText) {
    return htmlResponse(renderLayout("Case Study", `<p>No CSV content.</p><p><a href="/admin/case-study">Back</a></p>`));
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return htmlResponse(renderLayout("Case Study", `<p>CSV had no data rows.</p><p><a href="/admin/case-study">Back</a></p>`));
  }
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const dataRows = rows.slice(1);
  let inserted = 0;

  if (csvType === "gsc_chart") {
    const stmts = dataRows
      .filter((r) => r[0])
      .map((r) => env.DB.prepare(
        "INSERT INTO cs_gsc_daily (date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(date) DO UPDATE SET clicks=excluded.clicks, impressions=excluded.impressions, ctr=excluded.ctr, position=excluded.position"
      ).bind(r[0], intOr0(r[1]), intOr0(r[2]), pctOr0(r[3]), floatOr0(r[4])));
    await env.DB.batch(stmts);
    inserted = stmts.length;
  } else if (csvType === "gsc_queries") {
    await env.DB.exec("DELETE FROM cs_gsc_queries");
    const stmts = dataRows
      .filter((r) => r[0])
      .map((r) => env.DB.prepare(
        "INSERT OR REPLACE INTO cs_gsc_queries (query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?)"
      ).bind(r[0], intOr0(r[1]), intOr0(r[2]), pctOr0(r[3]), floatOr0(r[4])));
    await env.DB.batch(stmts);
    inserted = stmts.length;
  } else if (csvType === "gsc_pages") {
    await env.DB.exec("DELETE FROM cs_gsc_pages");
    const stmts = dataRows
      .filter((r) => r[0])
      .map((r) => env.DB.prepare(
        "INSERT OR REPLACE INTO cs_gsc_pages (page, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?)"
      ).bind(r[0], intOr0(r[1]), intOr0(r[2]), pctOr0(r[3]), floatOr0(r[4])));
    await env.DB.batch(stmts);
    inserted = stmts.length;
  } else if (csvType === "ai_overview") {
    const stmts = dataRows
      .filter((r) => r[0])
      .map((r) => env.DB.prepare(
        "INSERT INTO cs_ai_daily (date, citations, cited_pages) VALUES (?, ?, ?) " +
        "ON CONFLICT(date) DO UPDATE SET citations=excluded.citations, cited_pages=excluded.cited_pages"
      ).bind(normalizeDate(r[0]), intOr0(r[1]), intOr0(r[2])));
    await env.DB.batch(stmts);
    inserted = stmts.length;
  } else {
    return new Response("Unknown csv_type", { status: 400 });
  }

  const now = new Date().toISOString();
  const metaKey = csvType.startsWith("gsc_") ? "gsc_updated" : "ai_updated";
  await env.DB.prepare(
    "INSERT INTO cs_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=CURRENT_TIMESTAMP"
  ).bind(metaKey, now).run();
  await env.DB.prepare(
    "INSERT INTO cs_meta (k, v) VALUES ('data_as_of', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=CURRENT_TIMESTAMP"
  ).bind(now).run();

  return new Response(null, {
    status: 303,
    headers: { Location: new URL(`/admin/case-study?uploaded=${inserted}`, url).toString() },
  });
}

function parseCsv(text) {
  // Minimal RFC-4180 parser: handles quoted fields with embedded commas/quotes.
  const rows = [];
  let row = [], field = "", inQuotes = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ""; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0]));
}

function intOr0(v) { const n = parseInt(String(v || "").replace(/,/g, ""), 10); return isNaN(n) ? 0 : n; }
function floatOr0(v) { const n = parseFloat(String(v || "").replace(/,/g, "")); return isNaN(n) ? 0 : n; }
function pctOr0(v) {
  const s = String(v || "").replace(/,/g, "").replace("%", "").trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : (n > 1 ? n / 100 : n);
}
function normalizeDate(v) {
  // Accepts "YYYY-MM-DD", "M/D/YYYY", "M/D/YYYY 12:00:00 AM" → YYYY-MM-DD
  const s = String(v || "").trim().split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s;
}

// =====================================================================
// Case-study refresh — pulls GSC + Bing via their APIs on cron
// =====================================================================
// Called by scheduled() weekly, and by POST /admin/case-study/refresh
// for manual triggering. Each source is independent — one failing does
// not block the other. Errors are written to cs_meta.last_error_<src>
// so the admin page can show them.
// =====================================================================

const GSC_PROPERTY = "sc-domain:polkcountygolfcarts.com";
const BING_SITE_URL = "https://polkcountygolfcarts.com";

// IndexNow — Microsoft/Bing + Yandex + others' push-crawl protocol.
// Instead of waiting for crawlers to discover new/updated URLs, we
// POST a list of URLs to the IndexNow API and participating engines
// re-crawl within minutes. Key verification file lives at
// public/<KEY>.txt and must return the key with no whitespace or BOM.
const INDEXNOW_KEY = "60771a6fab35c8d2671dea73fb57908c";
const INDEXNOW_HOST = "polkcountygolfcarts.com";

async function runCaseStudyRefresh(env, meta = {}) {
  await ensureCaseStudySchema(env);
  const results = { source: meta.source || "manual", started: new Date().toISOString() };

  // Rate-limit guard: refuse to refresh if we ran successfully in the
  // last 60 minutes. Prevents Bing ThrottleIP + IndexNow 429 errors
  // from someone clicking "Refresh now" repeatedly. Cron trigger
  // bypasses this (source === "cron") since it fires weekly.
  if (meta.source !== "cron") {
    const lastRow = await env.DB.prepare(
      "SELECT v FROM cs_meta WHERE k = 'last_refresh_ok_at'"
    ).first();
    if (lastRow && lastRow.v) {
      const lastMs = Date.parse(lastRow.v);
      const ageMin = Math.floor((Date.now() - lastMs) / 60000);
      if (ageMin < 60) {
        results.skipped = `rate-limited: last successful refresh was ${ageMin} min ago (60 min minimum)`;
        results.retry_after_min = 60 - ageMin;
        results.finished = new Date().toISOString();
        return results;
      }
    }
  }

  try {
    const g = await pullGsc(env);
    results.gsc = g;
    await setMeta(env, "gsc_updated", new Date().toISOString());
    await setMeta(env, "gsc_last_error", "");
  } catch (e) {
    results.gsc = { error: String(e && e.message || e) };
    await setMeta(env, "gsc_last_error", results.gsc.error);
    console.log("GSC pull failed:", results.gsc.error);
  }

  try {
    const b = await pullBing(env);
    results.bing = b;
    await setMeta(env, "bing_updated", new Date().toISOString());
    await setMeta(env, "bing_last_error", "");
  } catch (e) {
    results.bing = { error: String(e && e.message || e) };
    await setMeta(env, "bing_last_error", results.bing.error);
    console.log("Bing pull failed:", results.bing.error);
  }

  try {
    const inx = await pingIndexNow(env);
    results.indexnow = inx;
    await setMeta(env, "indexnow_updated", new Date().toISOString());
    await setMeta(env, "indexnow_last_error", "");
  } catch (e) {
    results.indexnow = { error: String(e && e.message || e) };
    await setMeta(env, "indexnow_last_error", results.indexnow.error);
    console.log("IndexNow push failed:", results.indexnow.error);
  }

  await setMeta(env, "data_as_of", new Date().toISOString());
  // Only mark a successful refresh when GSC actually pulled (the money
  // source). Bing or IndexNow throttles don't block subsequent retries.
  if (results.gsc && !results.gsc.error) {
    await setMeta(env, "last_refresh_ok_at", new Date().toISOString());
  }
  results.finished = new Date().toISOString();
  return results;
}

// ---------- IndexNow ----------

async function pingIndexNow(env) {
  // Parse the sitemap at /sitemap.xml and push every URL to IndexNow.
  // Bing + Yandex + Seznam.cz + Naver all participate and re-crawl
  // within minutes. Google does not participate yet — GSC's own
  // "URL inspection" tool is Google's equivalent (manual only).
  const sitemapReq = new Request(`https://${INDEXNOW_HOST}/sitemap.xml`, { method: "GET" });
  const smResp = await env.ASSETS.fetch(sitemapReq);
  if (!smResp.ok) {
    throw new Error(`sitemap fetch failed: ${smResp.status}`);
  }
  const xml = await smResp.text();
  const urls = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]);
  if (!urls.length) return { skipped: "no URLs in sitemap" };

  const resp = await fetch("https://api.indexnow.org/IndexNow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: INDEXNOW_HOST,
      key: INDEXNOW_KEY,
      keyLocation: `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`,
      urlList: urls,
    }),
  });
  // IndexNow accepted codes: 200 (ok), 202 (accepted, processing),
  // 422 (invalid URLs — partial success). 400+ else is an error.
  if (resp.status === 200 || resp.status === 202) {
    return { urls_submitted: urls.length, status: resp.status };
  }
  const body = await resp.text().catch(() => "");
  throw new Error(`IndexNow HTTP ${resp.status}: ${body.slice(0, 200)}`);
}

async function setMeta(env, k, v) {
  await env.DB.prepare(
    "INSERT INTO cs_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=CURRENT_TIMESTAMP"
  ).bind(k, v).run();
}

// ---------- GSC ----------

async function pullGsc(env) {
  if (!env.GSC_SERVICE_ACCOUNT_JSON) {
    return { skipped: "GSC_SERVICE_ACCOUNT_JSON not set" };
  }
  const sa = JSON.parse(env.GSC_SERVICE_ACCOUNT_JSON);
  const token = await mintGoogleAccessToken(sa, "https://www.googleapis.com/auth/webmasters.readonly");

  // Pull the full 16-month window the GSC API allows (480 days to
  // stay well under the 490-day ceiling). cs_gsc_daily upserts, so
  // historic rows outside the window are preserved.
  const today = new Date();
  const start = new Date(today.getTime() - 480 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const startDate = fmt(start);
  const endDate = fmt(today);

  const daily = await gscQuery(token, { startDate, endDate, dimensions: ["date"], rowLimit: 500 });
  const queries = await gscQuery(token, { startDate, endDate, dimensions: ["query"], rowLimit: 1000 });
  const pages = await gscQuery(token, { startDate, endDate, dimensions: ["page"], rowLimit: 1000 });

  // Upsert daily (preserves older rows outside the 90-day window)
  if (daily.rows?.length) {
    const stmts = daily.rows.map((r) => env.DB.prepare(
      "INSERT INTO cs_gsc_daily (date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(date) DO UPDATE SET clicks=excluded.clicks, impressions=excluded.impressions, ctr=excluded.ctr, position=excluded.position"
    ).bind(r.keys[0], r.clicks, r.impressions, r.ctr, r.position));
    await env.DB.batch(stmts);
  }

  // Replace queries + pages (they're a point-in-time top-N snapshot)
  if (queries.rows?.length) {
    await env.DB.exec("DELETE FROM cs_gsc_queries");
    const stmts = queries.rows.map((r) => env.DB.prepare(
      "INSERT INTO cs_gsc_queries (query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?)"
    ).bind(r.keys[0], r.clicks, r.impressions, r.ctr, r.position));
    await env.DB.batch(stmts);
  }
  if (pages.rows?.length) {
    await env.DB.exec("DELETE FROM cs_gsc_pages");
    const stmts = pages.rows.map((r) => env.DB.prepare(
      "INSERT INTO cs_gsc_pages (page, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?)"
    ).bind(r.keys[0], r.clicks, r.impressions, r.ctr, r.position));
    await env.DB.batch(stmts);
  }

  return {
    daily_rows: daily.rows?.length || 0,
    query_rows: queries.rows?.length || 0,
    page_rows: pages.rows?.length || 0,
    window: `${startDate} → ${endDate}`,
  };
}

async function gscQuery(token, body) {
  const url =
    "https://searchconsole.googleapis.com/webmasters/v3/sites/" +
    encodeURIComponent(GSC_PROPERTY) + "/searchAnalytics/query";
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`GSC ${resp.status}: ${t.slice(0, 300)}`);
  }
  return resp.json();
}

async function mintGoogleAccessToken(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const b64url = (bytes) => b64UrlEncode(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
  const hb = b64url(JSON.stringify(header));
  const cb = b64url(JSON.stringify(claims));
  const signingInput = `${hb}.${cb}`;

  // Import PEM private key
  const pem = sa.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBytes = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));
  const jwt = `${signingInput}.${b64url(sigBytes)}`;

  const tokResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!tokResp.ok) {
    throw new Error(`OAuth exchange failed ${tokResp.status}: ${(await tokResp.text()).slice(0, 300)}`);
  }
  const tok = await tokResp.json();
  return tok.access_token;
}

// ---------- Bing ----------

async function pullBing(env) {
  if (!env.BING_API_KEY) {
    return { skipped: "BING_API_KEY not set" };
  }
  // Bing Webmaster Tools API v1. GetRankAndTrafficStats returns daily
  // clicks + impressions for the site. GetQueryStats returns top queries.
  const base =
    "https://ssl.bing.com/webmaster/api.svc/json/" +
    "GetRankAndTrafficStats?siteUrl=" + encodeURIComponent(BING_SITE_URL) +
    "&apikey=" + encodeURIComponent(env.BING_API_KEY);
  const resp = await fetch(base);
  if (!resp.ok) {
    throw new Error(`Bing ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = await resp.json();
  const stats = (data && data.d) || [];
  // Upsert into cs_bing_daily (table created lazily below)
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS cs_bing_daily (" +
    "date TEXT PRIMARY KEY, clicks INTEGER NOT NULL DEFAULT 0, " +
    "impressions INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0);"
  );
  if (stats.length) {
    const stmts = stats.map((s) => {
      // Bing returns "Date":"/Date(1234567890000)/" epoch-ms
      const ms = parseInt(String(s.Date).replace(/[^0-9]/g, ""), 10);
      const date = new Date(ms).toISOString().slice(0, 10);
      return env.DB.prepare(
        "INSERT INTO cs_bing_daily (date, clicks, impressions, position) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(date) DO UPDATE SET clicks=excluded.clicks, impressions=excluded.impressions, position=excluded.position"
      ).bind(date, s.Clicks || 0, s.Impressions || 0, s.AvgImpressionPosition || 0);
    });
    await env.DB.batch(stmts);
  }
  return { bing_daily_rows: stats.length };
}
// =====================================================================
// Server-side traffic logging — AI bot crawls + external referrals
// =====================================================================
// Logs every HTML page request that has either (a) a classifiable
// AI-bot user agent or (b) an external referer from a known AI engine
// or major search engine. Skips static assets, /api/, /admin/,
// /cdn-cgi/ — those create noise, not signal.
//
// Writes are fire-and-forget via ctx.waitUntil so page response time
// is never affected by D1 latency. Logging failures are swallowed.
// =====================================================================

const TRAFFIC_SCHEMA = `
CREATE TABLE IF NOT EXISTS traffic_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  path TEXT NOT NULL,
  bot TEXT,
  referer_host TEXT,
  country TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_traffic_ts ON traffic_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_traffic_bot ON traffic_log(bot);
CREATE INDEX IF NOT EXISTS idx_traffic_ref ON traffic_log(referer_host);
`;

// AI bot user-agent patterns. Order matters — more specific first.
const AI_BOT_PATTERNS = [
  ["GPTBot",             /GPTBot/i],
  ["ChatGPT-User",       /ChatGPT-User/i],
  ["OAI-SearchBot",      /OAI-SearchBot/i],
  ["ClaudeBot",          /ClaudeBot/i],
  ["Claude-Web",         /Claude-Web/i],
  ["anthropic-ai",       /anthropic-ai/i],
  ["PerplexityBot",      /PerplexityBot/i],
  ["Perplexity-User",    /Perplexity-User/i],
  ["Google-Extended",    /Google-Extended/i],
  ["GoogleOther",        /GoogleOther/i],
  ["Applebot-Extended",  /Applebot-Extended/i],
  ["meta-externalagent", /meta-externalagent/i],
  ["FacebookBot",        /FacebookBot/i],
  ["Amazonbot",          /Amazonbot/i],
  ["cohere-ai",          /cohere-ai/i],
  ["CCBot",              /CCBot/i],
  ["Bytespider",         /Bytespider/i],
  ["MistralAI-User",     /MistralAI-User/i],
  ["Diffbot",            /Diffbot/i],
  // Traditional search bots — we track them separately but same table
  ["Googlebot",          /Googlebot(?!-Image)/i],
  ["Bingbot",            /Bingbot/i],
  ["DuckDuckBot",        /DuckDuckBot/i],
  ["YandexBot",          /YandexBot/i],
  ["Baiduspider",        /Baiduspider/i],
];

// Referer hosts that count as AI-engine traffic. Match on hostname only.
const AI_REFERER_HOSTS = new Set([
  "chat.openai.com",
  "chatgpt.com",
  "perplexity.ai",
  "gemini.google.com",
  "bard.google.com",
  "copilot.microsoft.com",
  "claude.ai",
  "poe.com",
  "you.com",
  "andisearch.com",
  "phind.com",
  "deepseek.com",
  "mistral.ai",
  "huggingface.co",
]);

function classifyBot(ua) {
  if (!ua) return null;
  for (const [name, pat] of AI_BOT_PATTERNS) {
    if (pat.test(ua)) return name;
  }
  return null;
}

function extractRefererHost(refererHeader, selfHost) {
  if (!refererHeader) return null;
  try {
    const h = new URL(refererHeader).hostname.toLowerCase().replace(/^www\./, "");
    if (!h) return null;
    if (h === selfHost || h.endsWith("." + selfHost)) return null;
    return h;
  } catch (_) {
    return null;
  }
}

function maybeLogTraffic(request, env, ctx, url) {
  if (!env.DB || !ctx) return;
  // Only HTML pages
  const path = url.pathname;
  if (
    path.startsWith("/assets/") ||
    path.startsWith("/api/") ||
    path.startsWith("/admin") ||
    path.startsWith("/cdn-cgi/") ||
    path === "/favicon.svg" ||
    path === "/robots.txt" ||
    path === "/sitemap.xml" ||
    path === "/llms.txt" ||
    path.endsWith(".webp") || path.endsWith(".png") || path.endsWith(".jpg") ||
    path.endsWith(".css") || path.endsWith(".js") || path.endsWith(".svg") ||
    path.endsWith(".txt") || path.endsWith(".xml") || path.endsWith(".ico")
  ) return;

  const ua = request.headers.get("user-agent") || "";
  const ref = request.headers.get("referer") || "";
  const bot = classifyBot(ua);
  const refererHost = extractRefererHost(ref, "midwestcncservices.com");

  // Only log when there's something interesting to log
  if (!bot && !refererHost) return;

  // If referer is a known AI engine, upgrade signal visibility
  const isAiReferer = refererHost && AI_REFERER_HOSTS.has(refererHost);

  // Cloudflare provides country in request.cf
  const country = (request.cf && request.cf.country) || null;

  ctx.waitUntil(
    (async () => {
      try {
        await env.DB.exec(TRAFFIC_SCHEMA.replace(/\n/g, " ")).catch(() => {});
        await env.DB.prepare(
          "INSERT INTO traffic_log (ts, path, bot, referer_host, country, user_agent) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(
          new Date().toISOString(),
          path,
          bot,
          refererHost,
          country,
          ua.slice(0, 500),
        ).run();
      } catch (e) {
        console.log("traffic_log insert failed:", e && e.message);
      }
    })()
  );
}

// ---------- /admin/traffic ----------

async function handleTrafficAdminPage(env) {
  if (!env.DB) {
    return htmlResponse(renderLayout("Traffic", `<p>DB not configured.</p>`));
  }
  await env.DB.exec(TRAFFIC_SCHEMA.replace(/\n/g, " ")).catch(() => {});

  // Last 7 days of each: AI bot crawls, external referrals, top pages
  const since = new Date(Date.now() - 7 * 86400000).toISOString();

  const [botSummary, refSummary, aiRefSummary, topPages, totals] = await Promise.all([
    env.DB.prepare(
      "SELECT bot, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND bot IS NOT NULL GROUP BY bot ORDER BY n DESC"
    ).bind(since).all(),
    env.DB.prepare(
      "SELECT referer_host, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND bot IS NULL AND referer_host IS NOT NULL GROUP BY referer_host ORDER BY n DESC LIMIT 25"
    ).bind(since).all(),
    env.DB.prepare(
      "SELECT referer_host, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND referer_host IN (" +
      Array.from(AI_REFERER_HOSTS).map((h) => `'${h}'`).join(",") +
      ") GROUP BY referer_host ORDER BY n DESC"
    ).bind(since).all(),
    env.DB.prepare(
      "SELECT path, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND bot IS NOT NULL GROUP BY path ORDER BY n DESC LIMIT 15"
    ).bind(since).all(),
    env.DB.prepare(
      "SELECT " +
      "(SELECT COUNT(*) FROM traffic_log WHERE ts > ? AND bot IS NOT NULL) AS crawls, " +
      "(SELECT COUNT(*) FROM traffic_log WHERE ts > ? AND bot IS NULL AND referer_host IS NOT NULL) AS referrals, " +
      "(SELECT COUNT(DISTINCT path) FROM traffic_log WHERE ts > ? AND bot IS NOT NULL) AS unique_pages_crawled, " +
      "(SELECT COUNT(*) FROM traffic_log) AS all_time"
    ).bind(since, since, since).first(),
  ]);

  const row = (label, n) => `
    <tr><td>${esc(label)}</td><td style="text-align:right;font-variant-numeric:tabular-nums;">${n.toLocaleString()}</td></tr>`;

  const body = `
    <p><a href="/admin">&larr; All leads</a></p>
    <h1>Traffic — last 7 days</h1>
    <p style="color:var(--muted);">
      Server-side log of AI bot crawls + external referrals.
      Updated live per request (fire-and-forget).
    </p>

    <div class="detail">
      <h2>Summary</h2>
      <table class="admin-table" style="max-width:500px;">
        <tbody>
          ${row("AI/search bot crawl hits", totals.crawls || 0)}
          ${row("External referrals", totals.referrals || 0)}
          ${row("Unique pages crawled by bots", totals.unique_pages_crawled || 0)}
          ${row("All-time logged events", totals.all_time || 0)}
        </tbody>
      </table>

      <h2>AI bot crawls by bot (last 7d)</h2>
      ${botSummary.results?.length ? `
        <table class="admin-table" style="max-width:500px;">
          <thead><tr><th>Bot</th><th style="text-align:right;">Hits</th></tr></thead>
          <tbody>${botSummary.results.map((r) => row(r.bot, r.n)).join("")}</tbody>
        </table>` : `<p class="empty">No bot crawls yet. Logging just started — check back in a day.</p>`}

      <h2>AI engine referrals (clicks from ChatGPT/Perplexity/Gemini/etc.)</h2>
      ${aiRefSummary.results?.length ? `
        <table class="admin-table" style="max-width:500px;">
          <thead><tr><th>AI engine</th><th style="text-align:right;">Clicks</th></tr></thead>
          <tbody>${aiRefSummary.results.map((r) => row(r.referer_host, r.n)).join("")}</tbody>
        </table>` : `<p class="empty">No AI referral clicks logged yet.</p>`}

      <h2>All external referrals (last 7d, top 25)</h2>
      ${refSummary.results?.length ? `
        <table class="admin-table" style="max-width:600px;">
          <thead><tr><th>Source</th><th style="text-align:right;">Visits</th></tr></thead>
          <tbody>${refSummary.results.map((r) => row(r.referer_host, r.n)).join("")}</tbody>
        </table>` : `<p class="empty">No external referrals logged yet.</p>`}

      <h2>Top pages crawled by bots (last 7d)</h2>
      ${topPages.results?.length ? `
        <table class="admin-table">
          <thead><tr><th>Path</th><th style="text-align:right;">Bot hits</th></tr></thead>
          <tbody>${topPages.results.map((r) => `<tr><td><code>${esc(r.path)}</code></td><td style="text-align:right;font-variant-numeric:tabular-nums;">${r.n.toLocaleString()}</td></tr>`).join("")}</tbody>
        </table>` : `<p class="empty">No bot crawls yet.</p>`}
    </div>
  `;
  return htmlResponse(renderLayout("Traffic — Midwest CNC Admin", body));
}

// ---------- /api/case-study.json: ai_crawls section ----------
// Called from handleCaseStudyJson to mix traffic data into the JSON.

async function caseStudyTrafficSection(env) {
  try {
    await env.DB.exec(TRAFFIC_SCHEMA.replace(/\n/g, " ")).catch(() => {});
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const [bots, refs, total] = await Promise.all([
      env.DB.prepare("SELECT bot, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND bot IS NOT NULL GROUP BY bot ORDER BY n DESC").bind(since).all(),
      env.DB.prepare(
        "SELECT referer_host, COUNT(*) AS n FROM traffic_log WHERE ts > ? AND referer_host IN (" +
        Array.from(AI_REFERER_HOSTS).map((h) => `'${h}'`).join(",") +
        ") GROUP BY referer_host ORDER BY n DESC"
      ).bind(since).all(),
      env.DB.prepare(
        "SELECT COUNT(*) AS crawls, COUNT(DISTINCT path) AS pages FROM traffic_log WHERE ts > ? AND bot IS NOT NULL"
      ).bind(since).first(),
    ]);
    return {
      window_days: 7,
      bot_crawls: total?.crawls || 0,
      pages_crawled: total?.pages || 0,
      by_bot: (bots.results || []).map((r) => ({ bot: r.bot, hits: r.n })),
      ai_engine_referrals: (refs.results || []).map((r) => ({ engine: r.referer_host, clicks: r.n })),
      source: "Cloudflare Worker traffic_log",
    };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}


// =====================================================================
// Public exports
// =====================================================================
export {
  ensureCaseStudySchema,
  handleCaseStudyJson,
  handleCaseStudyAdminPage,
  handleCaseStudyUpload,
  runCaseStudyRefresh,
  pingIndexNow,
  maybeLogTraffic,
  handleTrafficAdminPage,
};
