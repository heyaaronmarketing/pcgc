#!/usr/bin/env python3
"""
PCGC weekly SERP rank tracker.

For each keyword in keywords.json, hit the DataForSEO Google-organic
SERP endpoint from a Livingston, TX viewpoint, find the highest
polkcountygolfcarts.com result on the first 100 positions, and append
one row per keyword to history.json.

Run weekly:

    python3 seo/track.py

Then rebuild the dashboard:

    python3 seo/dashboard.py

Creds: two-line file at ~/.dataforseo — login on line 1, password on
line 2. Never printed, never committed.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

SEO_DIR = Path(__file__).resolve().parent
KEYWORDS_PATH = SEO_DIR / "keywords.json"
HISTORY_PATH = SEO_DIR / "history.json"
CREDS_PATH = Path.home() / ".dataforseo"

DATAFORSEO_HOST = "api.dataforseo.com"
LIVE_ENDPOINT = "/v3/serp/google/organic/live/advanced"


def load_creds() -> tuple[str, str]:
    if not CREDS_PATH.exists():
        sys.exit(f"missing DataForSEO creds at {CREDS_PATH} (login on line 1, password on line 2)")
    lines = [ln.strip() for ln in CREDS_PATH.read_text().splitlines() if ln.strip()]
    if len(lines) < 2:
        sys.exit(f"{CREDS_PATH} must have login on line 1, password on line 2")
    return lines[0], lines[1]


def basic_auth_header(login: str, password: str) -> str:
    token = base64.b64encode(f"{login}:{password}".encode()).decode()
    return f"Basic {token}"


def post_json(auth: str, path: str, payload: list[dict]) -> dict:
    """POST an array-of-tasks payload to DataForSEO and return the JSON."""
    body = json.dumps(payload)
    conn = http.client.HTTPSConnection(DATAFORSEO_HOST, timeout=60)
    try:
        conn.request(
            "POST",
            path,
            body=body,
            headers={
                "Authorization": auth,
                "Content-Type": "application/json",
            },
        )
        res = conn.getresponse()
        raw = res.read()
        if res.status != 200:
            raise RuntimeError(f"DataForSEO HTTP {res.status}: {raw[:400]!r}")
        return json.loads(raw)
    finally:
        conn.close()


def rank_for_domain(items: list[dict], domain: str) -> tuple[int | None, str | None]:
    """
    Return (rank_absolute, url) for the FIRST organic item whose parsed
    hostname ends with `domain`. `rank_absolute` is 1-indexed across the
    whole SERP (all item types). If not found, returns (None, None).
    """
    for it in items or []:
        if it.get("type") != "organic":
            continue
        url = it.get("url") or ""
        if not url:
            continue
        host = urlparse(url).netloc.lower()
        if host == domain or host.endswith("." + domain):
            rank = it.get("rank_absolute") or it.get("rank_group")
            return (int(rank) if rank is not None else None, url)
    return (None, None)


def load_history() -> list[dict]:
    if HISTORY_PATH.exists():
        try:
            return json.loads(HISTORY_PATH.read_text())
        except Exception:
            return []
    return []


def save_history(rows: list[dict]) -> None:
    HISTORY_PATH.write_text(json.dumps(rows, indent=2, sort_keys=False) + "\n")


def main() -> int:
    cfg = json.loads(KEYWORDS_PATH.read_text())
    target_domain = cfg["target_domain"].lower()
    login, password = load_creds()
    auth = basic_auth_header(login, password)

    run_ts = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    print(f"[{run_ts}] Tracking {len(cfg['keywords'])} keywords → {target_domain}")

    # DataForSEO's live/advanced endpoint accepts exactly ONE task per
    # POST (extras return "You can set only one task at a time."). Loop
    # sequentially — 30 keywords x ~1s each is fine for a weekly run.
    history = load_history()
    new_rows = 0
    misses = 0
    api_errors = 0
    for row in cfg["keywords"]:
        kw = row["kw"]
        task = [{
            "language_code": "en",
            "location_name": cfg["location_name"],
            "keyword": kw,
            "depth": 100,
            "device": "desktop",
            "os": "windows",
        }]
        try:
            resp = post_json(auth, LIVE_ENDPOINT, task)
        except Exception as e:
            print(f"  !! {kw}  (network error: {e})")
            api_errors += 1
            continue

        status_code = resp.get("status_code")
        if status_code != 20000:
            print(f"  !! {kw}  (api {status_code}: {resp.get('status_message')})")
            api_errors += 1
            continue

        result = None
        for t in resp.get("tasks") or []:
            if t.get("status_code") != 20000:
                print(f"  !! {kw}  (task {t.get('status_code')}: {t.get('status_message')})")
                api_errors += 1
                break
            for r in t.get("result") or []:
                result = r
                break
        if not result:
            misses += 1
            rank, url = None, None
            serp_features = []
            total_results = None
        else:
            rank, url = rank_for_domain(result.get("items") or [], target_domain)
            serp_features = result.get("item_types") or []
            total_results = result.get("se_results_count")

        history.append({
            "run": run_ts,
            "kw": kw,
            "cat": row["cat"],
            "rank": rank,
            "url": url,
            "total_serp_results": total_results,
            "item_types": serp_features,
        })
        new_rows += 1
        mark = f"#{rank}" if rank else "—"
        print(f"  {mark:>4}  {kw}")
        # Politeness delay so we don't hammer the endpoint.
        time.sleep(0.35)

    save_history(history)
    print(f"\nAppended {new_rows} rows to {HISTORY_PATH.name} (misses: {misses}, api errors: {api_errors}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
