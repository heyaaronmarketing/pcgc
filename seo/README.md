# SEO rank tracker

Weekly Google-SERP rank tracker for polkcountygolfcarts.com. Reads the
target keywords from `keywords.json`, hits DataForSEO's live SERP
endpoint from a Livingston, TX viewpoint, and appends one row per
keyword to `history.json`. `dashboard.py` renders the current state to
`/admin/seo/` on the site.

## One-time setup

1. DataForSEO credentials at `~/.dataforseo` — login on line 1,
   password on line 2. Never commit or print.

## Weekly workflow

```bash
python3 seo/track.py       # ~30-60s, ~$0.60 in DataForSEO credits
python3 seo/dashboard.py   # regenerates site/admin/seo/index.html
python3 build.py           # rebuild the static site
git add -A && git commit -m "SEO ranks: weekly refresh" && git push
```

Then Cloudflare auto-deploys and `/admin/seo/` on the live site shows
the updated ranks + week-over-week deltas.

## Files

- `keywords.json` — target keyword list, category tags, location code
- `track.py` — the SERP poller
- `dashboard.py` — history.json → `site/admin/seo/index.html`
- `history.json` — append-only rank log (committed; safe, no secrets)

## Cost

Live SERP calls are ~$0.02 each on DataForSEO. 30 keywords = ~$0.60
per run. Weekly = ~$2.40/month.

## Adding / removing keywords

Edit `keywords.json`. Removing a keyword stops future tracking but
history.json keeps its historical rows so the dashboard can still show
prior trend if you re-add it.
