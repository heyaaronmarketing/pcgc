#!/usr/bin/env python3
"""
Render seo/history.json → site/admin/seo/index.html.

Groups keywords by category, shows current rank + delta vs. the prior
run, and colors improvements green / regressions coral. Sorted so the
biggest opportunities (top of page or near-miss) surface first.

Run after every seo/track.py cycle:

    python3 seo/dashboard.py
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from html import escape
from pathlib import Path

SEO_DIR = Path(__file__).resolve().parent
HISTORY_PATH = SEO_DIR / "history.json"
KEYWORDS_PATH = SEO_DIR / "keywords.json"
OUT_PATH = SEO_DIR.parent / "site" / "admin" / "seo" / "index.html"


CAT_LABELS = {
    "local-primary": "Local · Livingston primary",
    "local-service": "Local · Services",
    "town": "Neighboring towns",
    "rental": "Rentals",
    "finance": "Financing",
    "brand": "Brand / product (Breezy EV)",
    "guide": "Buyer's guides",
}


def rank_class(rank: int | None) -> str:
    if rank is None:
        return "off"
    if rank <= 3:
        return "top3"
    if rank <= 10:
        return "top10"
    if rank <= 30:
        return "near"
    return "far"


def delta_html(now: int | None, then: int | None) -> str:
    if now is None and then is None:
        return '<span class="delta muted">—</span>'
    if now is None and then is not None:
        return '<span class="delta down">dropped off</span>'
    if now is not None and then is None:
        return f'<span class="delta up">new @ #{now}</span>'
    if now == then:
        return '<span class="delta muted">no change</span>'
    if now < then:
        return f'<span class="delta up">▲ {then - now}</span>'
    return f'<span class="delta down">▼ {now - then}</span>'


def main() -> int:
    if not HISTORY_PATH.exists():
        print(f"no history yet at {HISTORY_PATH} — run seo/track.py first")
        return 1
    history = json.loads(HISTORY_PATH.read_text())
    cfg = json.loads(KEYWORDS_PATH.read_text())
    target = cfg["target_domain"]

    # Group history by keyword → sorted list of runs
    by_kw: dict[str, list[dict]] = defaultdict(list)
    for row in history:
        by_kw[row["kw"]].append(row)
    for kw in by_kw:
        by_kw[kw].sort(key=lambda r: r["run"])

    # Latest + previous rank per keyword
    all_runs = sorted({r["run"] for r in history})
    latest_run = all_runs[-1] if all_runs else None

    # Row per keyword (in declared order so dashboard matches keywords.json)
    rows_by_cat: dict[str, list[dict]] = defaultdict(list)
    for cfg_row in cfg["keywords"]:
        kw = cfg_row["kw"]
        runs = by_kw.get(kw, [])
        now = runs[-1] if runs else None
        prev = runs[-2] if len(runs) >= 2 else None
        rows_by_cat[cfg_row["cat"]].append({
            "kw": kw,
            "cat": cfg_row["cat"],
            "now_rank": now["rank"] if now else None,
            "now_url": now["url"] if now else None,
            "prev_rank": prev["rank"] if prev else None,
            "history_ranks": [r["rank"] for r in runs],
        })

    # Roll-up KPIs
    total_kws = len(cfg["keywords"])
    latest_rows = [r for cat in rows_by_cat.values() for r in cat]
    on_serp = sum(1 for r in latest_rows if r["now_rank"] is not None)
    top10 = sum(1 for r in latest_rows if r["now_rank"] is not None and r["now_rank"] <= 10)
    top3 = sum(1 for r in latest_rows if r["now_rank"] is not None and r["now_rank"] <= 3)

    updated_label = "never"
    if latest_run:
        try:
            dt = datetime.fromisoformat(latest_run.replace("Z", "+00:00"))
            updated_label = dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        except Exception:
            updated_label = latest_run

    def sparkline(vals: list) -> str:
        # Compact off/near/top10/top3 ribbon over the last 8 runs
        vs = vals[-8:]
        cells = []
        for v in vs:
            cls = rank_class(v)
            title = f"#{v}" if v else "off"
            cells.append(f'<span class="spark {cls}" title="{title}"></span>')
        return f'<span class="sparkbar">{"".join(cells) or "&nbsp;"}</span>'

    # Order categories the way the keywords.json declared them
    cat_order = []
    for r in cfg["keywords"]:
        if r["cat"] not in cat_order:
            cat_order.append(r["cat"])

    sections_html = []
    for cat in cat_order:
        rows = rows_by_cat.get(cat, [])
        # Sort within a category by rank (unranked last), so "wins first"
        rows.sort(key=lambda r: (r["now_rank"] is None, r["now_rank"] or 999))
        body = []
        for r in rows:
            klass = rank_class(r["now_rank"])
            rank_cell = (
                f'<span class="rank {klass}">#{r["now_rank"]}</span>'
                if r["now_rank"] is not None
                else '<span class="rank off">not ranking</span>'
            )
            url_cell = (
                f'<a href="{escape(r["now_url"])}" target="_blank" rel="noopener">{escape(r["now_url"])}</a>'
                if r["now_url"]
                else "<span class=\"muted\">—</span>"
            )
            body.append(f"""
              <tr>
                <td class="kw">{escape(r["kw"])}</td>
                <td class="rankcell">{rank_cell}</td>
                <td class="deltacell">{delta_html(r["now_rank"], r["prev_rank"])}</td>
                <td class="sparkcell">{sparkline(r["history_ranks"])}</td>
                <td class="urlcell">{url_cell}</td>
              </tr>""")
        sections_html.append(f"""
        <section class="cat">
          <h2>{escape(CAT_LABELS.get(cat, cat))}</h2>
          <table class="ranks">
            <thead>
              <tr><th>Keyword</th><th>Rank</th><th>Δ vs prior</th><th>Trend</th><th>Ranking URL</th></tr>
            </thead>
            <tbody>{''.join(body)}</tbody>
          </table>
        </section>
        """)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>SEO Rank Tracker · PCGC Admin</title>
  <link rel="stylesheet" href="/assets/site.css">
  <style>
    body {{ background:#fbf8f3; color:#222; font-family: system-ui,-apple-system,Segoe UI,sans-serif; }}
    .wrap {{ max-width: 1100px; margin: 0 auto; padding: 1.25rem 1rem 3rem; }}
    h1 {{ font: 700 1.9rem/1.15 Georgia, serif; color:#1f5a68; margin:.4rem 0 .1rem; }}
    .sub {{ color:#666; font-size:.9rem; margin-bottom:1.2rem; }}
    .kpis {{ display:grid; grid-template-columns: repeat(4,1fr); gap: .75rem; margin: .5rem 0 1.4rem; }}
    .kpi {{ background:#fff; border:1px solid #ecd9c7; border-radius:12px; padding: .9rem 1.05rem; }}
    .kpi b {{ display:block; font: 700 1.6rem/1.1 Georgia, serif; color:#1f5a68; }}
    .kpi span {{ color:#666; font-size:.8rem; text-transform:uppercase; letter-spacing:.05em; }}
    .cat {{ background:#fff; border:1px solid #ecd9c7; border-radius:12px; padding: 1rem 1.15rem; margin-bottom: 1rem; }}
    .cat h2 {{ font: 700 1.05rem/1.2 Georgia, serif; color:#1f5a68; margin:.15rem 0 .7rem; }}
    table.ranks {{ width:100%; border-collapse: collapse; font-size:.92rem; }}
    table.ranks th, table.ranks td {{ text-align:left; padding: .5rem .5rem; border-bottom:1px solid #f0e6d7; vertical-align: middle; }}
    table.ranks th {{ font-weight:600; color:#8a6d55; font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; }}
    td.kw {{ font-weight:500; }}
    td.urlcell a {{ color:#1f5a68; text-decoration:none; word-break: break-all; }}
    td.urlcell a:hover {{ text-decoration:underline; }}
    .rank {{ display:inline-block; padding: .2rem .55rem; border-radius: 999px; font-weight:700; font-size:.85rem; background:#f4efe4; color:#555; }}
    .rank.top3 {{ background:#dff0e1; color:#1c6b2a; }}
    .rank.top10 {{ background:#e6f1f3; color:#1f5a68; }}
    .rank.near {{ background:#fff2d6; color:#8a4a00; }}
    .rank.far {{ background:#f4efe4; color:#555; }}
    .rank.off {{ background:#f8e3e1; color:#8a2a20; }}
    .delta {{ font-weight:600; font-size:.85rem; }}
    .delta.up {{ color:#1c6b2a; }}
    .delta.down {{ color:#8a2a20; }}
    .delta.muted {{ color:#888; font-weight:500; }}
    .muted {{ color:#888; }}
    .sparkbar {{ display:inline-flex; gap:2px; align-items:center; }}
    .spark {{ display:inline-block; width:10px; height:14px; border-radius:2px; background:#eee; }}
    .spark.top3 {{ background:#4c9a5b; }}
    .spark.top10 {{ background:#3f7f8d; }}
    .spark.near {{ background:#e0b25e; }}
    .spark.far {{ background:#cfc6b6; }}
    .spark.off {{ background:#e5b8b1; }}
    nav.crumbs a {{ color:#1f5a68; text-decoration:none; margin-right:.7rem; }}
    nav.crumbs {{ font-size:.85rem; color:#888; margin-bottom:.9rem; }}
  </style>
</head>
<body>
<div class="wrap">
  <nav class="crumbs">
    <a href="/admin/dashboard/">← Dashboard</a>
    <a href="/admin/rentals/">Bookings</a>
    <a href="/admin/social-campaign/">Social campaign</a>
    <span>SEO ranks</span>
  </nav>
  <h1>Google rank tracker · {escape(target)}</h1>
  <p class="sub">Weekly SERP position for {total_kws} target keywords, run from a Livingston, TX viewpoint. Last updated <b>{updated_label}</b>.</p>

  <div class="kpis">
    <div class="kpi"><b>{on_serp}/{total_kws}</b><span>appearing on page 1–10</span></div>
    <div class="kpi"><b>{top10}</b><span>ranking in top 10</span></div>
    <div class="kpi"><b>{top3}</b><span>ranking in top 3</span></div>
    <div class="kpi"><b>{len(all_runs)}</b><span>tracker runs recorded</span></div>
  </div>

  {''.join(sections_html)}

  <p class="sub" style="margin-top:1.5rem;">Legend: <span class="rank top3">#1–3</span> <span class="rank top10">#4–10</span> <span class="rank near">#11–30</span> <span class="rank far">#31–100</span> <span class="rank off">not in top 100</span>. Trend shows last 8 runs, newest right.</p>
</div>
</body>
</html>
"""
    OUT_PATH.write_text(html)
    print(f"wrote {OUT_PATH.relative_to(SEO_DIR.parent)} ({len(latest_rows)} keywords across {len(cat_order)} categories)")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
