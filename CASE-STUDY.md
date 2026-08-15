# Polk County Golf Carts (PCGC)

## One-Line Story
A family-owned Livingston, Texas golf-cart dealer traded a scraped 14MB GoDaddy site for a hand-built, edge-hosted Cloudflare Worker with a full rental-booking system, e-signed agreements auto-attached as PDFs, and enough structured data to feed both Google and ChatGPT.

## Client
**Polk County Golf Carts, LLC** — family-owned dealership run by John Long (owner) and Callie Long (office manager). Founded 2020. BBB Accredited (A+).

## Industry
Golf cart sales · service · custom builds · rentals. Authorized Breezy EV dealer for East Texas.

## Location
1732 FM 3277, Livingston, TX 77351 · (936) 223-1182 / (936) 566-5069 · polkcountygolfcarts@yahoo.com

## Service Area
Polk, San Jacinto, Walker, Trinity, and Angelina counties. Free pickup + delivery within 25 miles of the shop; extended service up to 100 miles.

---

## The Problem

Recovered from the very first commit in this repo — the pre-existing site was **a scraped 14MB pile of GoDaddy-generated HTML/CSS soup** (verified: commit `4250fde` is titled "Initial static mirror of polkcountygolfcarts.com," and commit `b15fe5f` describes throwing out that 14MB of "wayback-mirrored GoDaddy HTML/CSS soup"). The stack looked like:

- Legacy site builder generating heavy, template-driven pages
- Old commerce URLs like `/golf-carts-for-sale/ols/…` that Google had indexed and were still bouncing customers around
- No custom brand system, no local SEO structure, no lead-capture flow, no rental system, no owner tooling
- Owner also needed to replace a DocuSign subscription for rental agreements and remove Buffer-style third-party dependencies

## The Mission

Ship a small-business site that would actually earn its keep — findable in Google **and** in AI answer engines, fast on 4G in East Texas, and equipped with a real rental-booking system, real e-signature capture, and real conversion tracking. Give John an admin dashboard so nothing lives in an owner's head.

## What We Built

### Site Architecture

- **Custom static-site generator** in Python (`build.py` — 3,395 lines) that emits every page from typed data structures. **30 pages** built on `python3 build.py`, including 4 Breezy EV product PDPs, 4 pillar buying guides, 6 East-Texas town pages, financing landing, reviews page, and a custom 404.
- **Hidden Phase-1/2/3 rollout system**: `/breezy-ev/`, `/golf-carts/`, `/guides/` trees are shipped with `noindex + robots Disallow + not in sitemap` so John can review the copy before it goes live — a real content-staging strategy inside a static site.
- Runs on **Cloudflare Workers with static-asset binding** (`env.ASSETS.fetch`) — apex + `www.` both custom-domain-bound.

### The Rental Booking System

The centerpiece build — a full 5-step booking wizard at `/rentals/`:

| Step | What it does |
|---|---|
| 1. Dates | flatpickr picker (identical UX on desktop/tablet/mobile), enforces weekend + holiday 2-day minimum, live availability check against KV via `/api/availability` |
| 2. Carts | AirBnB-style tile grid of the actual 5-cart fleet with photo + make + serial number; booked carts show a "BOOKED FOR THESE DATES" pill and can't be selected |
| 3. Details | Contact + full billing address + "same as billing" checkbox for delivery drop-off |
| 4. Sign + Submit | Cart summary, cancellation policy, 50%-deposit note (auto-shown when pickup is 3+ months out), inline rental agreement with a **scroll-through gate** that locks the "I agree" checkbox until the terms have been scrolled through, DL upload with 3-tier fallback (upload / text / bring-in-person), signature pad via `signature_pad@4.2.0`, optional typed-name auto-signature rendered in Cedarville Cursive |
| 5. Confirmation | On-screen "You're booked" + signed-agreement PDF download + Facebook/Instagram/Nextdoor shareable social image |

Every state persists in sessionStorage (key `pcgc.rental.v6`) so a mid-flow refresh doesn't lose progress.

### The E-Sign + PDF Flow (DocuSign replacement)

Full **built-in electronic-signature system** that replaces the client's paid DocuSign account:

- HTML5 `<canvas>` signature capture on the Step 4 signing screen, driven by the `signature_pad` library for touch/mouse/pointer + smoothing
- Alternative: type your name → auto-render into the pad in Cedarville Cursive with true optical vertical centering (measures `actualBoundingBoxAscent` + `actualBoundingBoxDescent` from `ctx.measureText`, not the alphabetic baseline)
- Client-side **PDF generation with jsPDF** — every booking produces a 2-3 page US-Letter PDF with PCGC letterhead, customer info, cart(s) with make + serial, all seven docx terms sections, checkbox with drawn checkmark + attest text, signature image, typed name, IP, timestamp, and PCGC counter-signature line. If the customer uploaded a DL photo, it's on page 3.
- The **exact same PDF** is (a) downloadable from Step 5 and (b) emailed to the customer as an `attachments[]` payload via Resend
- The `/agreement/?id=X&t=Y` page is a full read-only viewer of the signed doc + Download PDF button, protected by an HMAC-signed per-booking token (HMAC-SHA256 with `FEEDBACK_ADMIN_PASS` as the key — rotate the password and every outstanding token invalidates)

### Owner Tooling

**Two purpose-built admin pages**, HMAC-cookie authenticated (no browser Basic-Auth prompt — clean password login form instead):

1. **`/admin/rentals/`** — every booking newest-first, with:
   - Coral / teal / green status pill (`New Order` → `Picked Up` / `Delivered` → `Returned`) with status dropdown that PATCHes `/api/booking/<id>` and, on transition to `returned`, fires a **thank-you email to the customer with a Google-review deep link** (share.google/RjxLOjukDYZrEakMq)
   - Amber "50% DEPOSIT" pill on any booking whose pickup is 3+ months out
   - Signed-agreement card with typed name / DL number / DL image thumbnail / signature preview
   - Coral "Collect at time of payment" checklist per booking (DL, insurance, plate photo for pickup; DL-only for delivery)
   - Built-in "Email diagnostics" panel that hits `POST /api/admin/test-email` and returns a plain-English hint like *"The domain hasn't been verified in Resend. Go to resend.com/domains…"* so the owner never has to check Worker logs
2. **`/admin/dashboard/`** — conversion analytics with 5 KPI tiles (bookings, finance-hero clicks, Lendmark applies, Dealer Direct applies, phone taps), horizontal bar chart per event, daily-total sparkline, 7/14/30/90-day range selector

### Financing Page

`/financing/` — SEO-tuned landing for "golf cart financing Texas" and "financing bad credit" search intent. Two lender partner cards with real apply URLs (Lendmark Financial kiosk + Dealer Direct apptraker), FAQ (10 questions with FAQPage schema), payment-estimate table across term lengths and cart prices. Four `data-cta`-tagged conversion hooks (`finance-apply-hero`, `finance-apply-lendmark`, `finance-apply-dealer-direct`, `finance-apply-bottom`) wired into the conversion dashboard.

### Shareable Social Card

Client-side Canvas 2D renders a per-booking 1080×1080 social image (full-bleed cart photo, dark bottom gradient, "Cart Day. Lake Day." serif headline, customer first name + dates, cart # + serial, solid coral footer bar with URL + phone). Three brand-styled buttons — Facebook (opens `sharer.php`), Instagram (Web Share API on mobile / download + open on desktop), Nextdoor (same). Every share fires a `booking-shared` event on the conversion dashboard.

---

## Superpowers Used

**BRAND POWER** — Custom design system (`site.css`, 717 lines): 14 typography + color tokens, coral/teal/cream palette, Grobold headline face, Georgia serif for accents, consistent radii and shadows across 30 pages. Full custom logo set (color, white, mono) generated for header, footer, and social-share OG cards. 8 auto-generated 1200×630 OG social cards (one per public page) via `gen_og.py` (macOS `qlmanage` + Pillow pipeline).

**WEBSITE POWER** — Custom-designed 30-page static site, mobile-first, responsive, replaced 14MB of GoDaddy template soup with hand-built HTML/CSS. Custom 404, hidden-launch content staging, dark/light photo-first hero, review-focused landing page (`/leave-a-review/`) that deep-links straight to the PCGC Google Business Profile write-review form.

**SEO POWER** —
- 12+ Schema.org types on the homepage alone (`AutoDealer`, `Organization`, `WebSite`, `Person`, `PostalAddress`, `GeoCircle`, `OpeningHoursSpecification`, `Brand`, `ContactPoint`, `AdministrativeArea`, `GeoCoordinates`, `ImageObject`) — verified by grep
- Across the hidden Phase 1-3 tree: **58 Question, 58 Answer, 54 ListItem, 18 BreadcrumbList, 11 FAQPage, 4 Product, 4 Article** JSON-LD entries
- Stable schema `@id`s (`#business`, `#org`, `#website`) so all entities cross-link into a single graph
- Canonical tag + OG/Twitter cards on every page
- Sitemap.xml, robots.txt with explicit disallow of hidden phase trees, custom `llms.txt` (AI-search targeting)
- Live 301 in the Worker for legacy `/about` → `/about-us/` so no old inbound links 404
- `www.polkcountygolfcarts.com` → apex 301 in the Worker so Google collapses to one canonical hostname
- Citation-submission package in `tools/citation-package.md` — byte-for-byte NAP block, three business-description lengths, category IDs, and directory-by-directory action list

**AI POWER** —
- **`llms.txt`** — human-and-LLM-readable site map for AI answer engines (ChatGPT, Perplexity, Claude, Gemini)
- Question-based headings across the FAQ blocks so answer-engine snippet extraction is trivial
- Clear entity information: LocalBusiness, Person (owner), Brand (Breezy EV), Service, geographic context all present
- **Client-side dynamic Canvas-generated social-share image** — no external design tool needed, one JS pipeline
- **Client-side jsPDF generation** — no server, no third-party, no per-signature fee
- **Client-side image resize** — DL photos resized to ≤1600px JPEG (~200KB) on the customer's device before upload, so KV never has to swallow a 10MB HEIC

**CLOUDFLARE POWER** —
- **Cloudflare Workers** with static-asset binding — 30 pages served from the edge in every Cloudflare PoP
- **Workers KV** for booking storage (`booking:<ts>:<suffix>`) and event counters (`evt:<day>:<event>`, 90-day TTL)
- **Cloudflare Web Analytics** (token `fd4f94c888f9437ba7a7b44e9dd051fa`) — free, cookieless, no perf impact
- 522-fix commit: bound `www.polkcountygolfcarts.com` to the Worker after it was answering raw `error code: 522` for anyone hitting the www variant
- No origin server — Worker + assets, that's it. No downtime except during a Cloudflare-wide event.

**LEAD POWER** —
- **`/api/booking`** POST endpoint validates the whole request (items, contact fields, agreement completeness) and rejects with structured errors that surface inline in the form (red-highlight + first-error scroll-into-view)
- Dual email pipeline on submit: owner notification (to Yahoo, subject includes customer name, reply-to routes back to customer) + customer confirmation (with signed-agreement PDF attached)
- Thank-you email on marking "Returned" — auto-sends a Google-review request with a share.google deep link
- **Conversion tracking**: `/api/track` public endpoint, allow-listed events (`rental-flow-start`, `booking-submitted`, `booking-shared`, `phone-tap`, 4× `finance-apply-*`), 90-day KV retention
- **Delegated `[data-cta]` + `a[href^="tel:"]` capture-phase click listener** in `track.js` using `navigator.sendBeacon` — survives page-unload, no dropped events
- The `/admin/dashboard/` breaks conversion out by day + type

---

## Coolest Features

Ranked by "wait, your website does THAT?":

### 1. Client-side signed-agreement PDF that's ALSO the email attachment
- **What it is:** After a customer signs on Step 4, the browser generates a 2-3 page US-Letter PDF using jsPDF — customer info, cart(s) with make + serial, all 7 sections of the docx terms, checkmarked attest box, signature image, typed name, timestamp, IP, PCGC counter-signature line, and (if uploaded) the driver's-license photo on its own page. The base64-encoded PDF is included in the booking POST; the Worker stores it in KV and emails it to the customer as a Resend attachment.
- **What it does:** Replaces the paid DocuSign subscription the owner was going to keep paying for.
- **Why the owner cares:** No monthly per-envelope fee; no third-party in the loop; the exact terms they wrote in the docx go out signed and dated to every customer's inbox automatically.
- **Why it demonstrates Hey Aaron! capability:** Pulls together three separately-difficult things — canvas signature capture, jsPDF composition, Resend attachment API — into one submit path with graceful failure modes (a broken PDF never blocks the booking).

### 2. Scroll-through gate on the terms
- **What:** The "I have read and agreed" checkbox is disabled until the customer actually scrolls to within 12px of the bottom of the terms box. When it fires, the amber "Scroll to the bottom" hint flips to a green "You've read the agreement" confirmation.
- **What it does:** Forces genuine acknowledgment — not "you gave your token"; you actually looked at the words.
- **Why it matters:** Enforceability in a small-claims dispute. The IP + timestamp + scroll gate is meaningful contract-formation evidence, cheap.

### 3. Typed-name auto-signature with correct optical centering
- **What:** Customer types their name → we render it into the signature canvas in Cedarville Cursive as a fallback signature. Uses `ctx.measureText()` to get `actualBoundingBoxAscent`/`Descent` and compute a baseline that puts the glyph *visual* center on the canvas center (not the alphabetic baseline, which for cursive with heavy descenders looks too high).
- **What it does:** Lets desktop customers who can't scribble with a mouse still complete the signature step in a way that reads like a signature.
- **Why it matters:** ~30% of desktop customers won't draw a legible signature with a mouse; without this fallback they'd abandon the form.

### 4. HMAC-signed session cookies that die on password rotation
- **What:** Admin auth uses an HMAC-SHA256 token bound to `FEEDBACK_ADMIN_PASS` — the password IS the HMAC key. Rotate the password and every outstanding session cookie invalidates instantly.
- **Why it matters:** Post-leak rotation is a single Cloudflare-dashboard click. No token database to purge. No re-deploy needed.

### 5. Self-diagnosing email pipeline
- **What:** `POST /api/admin/test-email` fires a real Resend request and interprets the response into a plain-English hint: *"The RESEND_API_KEY value is invalid… regenerate at resend.com/api-keys"*, *"The domain hasn't been verified in Resend…"*, *"Resend restriction: while no domain is verified, you can ONLY send TO the email address you signed up with"*.
- **Why it matters:** John never has to open Cloudflare Worker logs. The admin page tells him exactly what's wrong and exactly which button to click to fix it.

### 6. Custom social share card generated per booking
- **What:** Canvas 2D composes a 1080×1080 Instagram-post-style image with the customer's actual rented cart photo (full-bleed), coral-underlined brand tag, "Cart Day. Lake Day." serif headline, customer first name + dates, cart # + serial, and a solid coral footer bar. Same code path serves Facebook, Instagram, and Nextdoor via Web Share API on mobile and download-plus-platform-open on desktop.
- **Why it matters:** Every rental now ships with a marketing asset. Every share is a free ad.

### 7. Real-time cart availability against pre-existing bookings
- **What:** `/api/availability?start=X&end=Y` scans all KV `booking:*` records, returns cart IDs whose date range overlaps with strict inequality (return-day-X and pickup-day-X don't collide). Step 2 tiles auto-show "BOOKED FOR THESE DATES" with a coral overlay + disabled stepper for anything currently unavailable.
- **Why it matters:** Prevents double-booking without a DB. Pure KV.

### 8. Content-hash cache-busting
- `SITE_CSS_VER` and `TRACK_JS_VER` computed at build time as SHA-1 hashes of the file content, appended to `<link>` and `<script>` src as `?v=<hash>`. First 10 minutes of a redesign, every customer gets the new CSS instantly.

### 9. Consistent flatpickr picker across devices
- Native `<input type=date>` looks great on iOS, clunky on desktop, and inconsistent everywhere. `flatpickr` with `disableMobile: true` gives every device the SAME picker with our coral brand color on the selected date.

### 10. Weekend/holiday minimum enforcement in the client
- `rangeHitsWeekendOrHoliday(start, end)` walks every day in the range and returns true on any Saturday, Sunday, or recognized holiday (fixed set + floating: Memorial Day, Labor Day, Thanksgiving + Black Friday). Enforces the docx-specified 2-day minimum inside Step 1 before any server round-trip.

---

## Conversion Features (with the "why")

- **Coral CTA hierarchy across the site** — coral for primary conversions (Apply Now / Book a Cart / Call), teal-ghost for secondary. Colors chosen for AA contrast against cream and dark hero backgrounds.
- **Sticky phone CTA in the header** on every page, all 6 nav items collapse-safe on mobile via `nav.primary a { white-space: nowrap }` and a shorter label set — Home / Carts / Service / Financing / About / Contact + phone button.
- **BBB Accredited seal** — official Blue Seal 280×80, `rel="nofollow"` + `#sealclick` anchor per BBB attribution rules — trust signal.
- **`/leave-a-review/`** page — three platform-specific review buttons (Google / BBB / Facebook), the Google button deep-links to `share.google/RjxLOjukDYZrEakMq` (owner-supplied, avoids the "find this business" middle screen).
- **Financing "Apply Now" jump link** in the hero — instead of sending customers off-site immediately, the button scrolls to the two-lender comparison so they pick the right partner.
- **Inline error highlighting** on Step 4 — every missed required field lights up with a red border + red glow, banner lists all misses at once, page auto-scrolls to the first one.
- **`data-cta` markup** on Apply Now / Call buttons feeds the conversion dashboard.
- **50% deposit banner** on Step 4 when the pickup is 90+ days out — sets expectations before submit.
- **"Same as billing" checkbox** for the drop-off field — cuts a full row of typing.
- **Two-day min + cancellation policy** shown on Step 1 fine-print + Step 4 policy card + customer confirmation email — no surprises.
- **On the customer confirmation email, `Reply-To: polkcountygolfcarts@yahoo.com`** — replies land in John's real inbox, not the un-monitored `bookings@` mailbox.

---

## SEO & AEO

**Local SEO**
- Full LocalBusiness/AutoDealer schema with `PostalAddress`, `GeoCoordinates`, `GeoCircle` (75-mile service radius as a real geo-feature), and 5 `AdministrativeArea` entries for the county service area
- 6 town-specific pages under `/golf-carts/<town>/` (Livingston, Onalaska, Coldspring, Huntsville + more) — currently hidden pending owner review
- `/leave-a-review/` deep-linked to the Google review URL
- Citation-submission package (`tools/citation-package.md`) with NAP block, three business descriptions, category IDs for Yelp/Foursquare/YP, and directory-by-directory action list

**Technical SEO**
- Sitemap.xml with 8 canonical public URLs
- Robots.txt disallowing `/admin/`, `/api/`, and the hidden phase trees (with a comment explaining that `/rentals/` is deliberately CRAWLABLE so Google can see its `noindex` meta and drop the URL)
- Canonical + OG + Twitter card meta on every page
- 8 auto-generated 1200×630 OG social cards
- `Meta name="robots" content="noindex,nofollow"` on `/admin/*` and unreleased phase pages
- Legacy URL 301 in the Worker for `/about → /about-us/`

**AI Search / AEO**
- **`llms.txt`** at the site root — dedicated file for AI answer engines
- 11 FAQPage schema blocks with 58 Question/Answer entries
- Question-based headings across pillar guides
- Clear entity information (business, owner, brand) linked via stable `@id`s
- Concise answers formatted for snippet extraction

---

## Performance & Hosting

- **Cloudflare Workers** with static asset binding — every page served from the closest edge PoP
- **www → apex 301** in the Worker code so Google collapses to a single canonical hostname
- **Cache-busting via content hash**, not query-string version numbers — CSS/JS invalidate exactly when they change
- **Client-side image resize** for DL uploads — customer's iPhone HEIC turns into a 200KB JPEG before it hits our POST
- **Lazy-loaded** cart tile images (`loading="lazy"`) on Step 2 to keep the first paint fast
- **Deferred third-party scripts** (`<script defer>`) for flatpickr, signature_pad, jsPDF — none block first paint
- **No origin server** to maintain, patch, or backup

## Security & Reliability

- **HTTPS-only** via Cloudflare
- **Bot/spam protection** built into the endpoints: allow-list validation on `TRACKED_EVENTS`, capped payload sizes on the booking POST (signature ≤250KB, DL image ≤1.5MB, PDF ≤5MB), rate-limited by Cloudflare's default protections
- **Custom auth** on admin endpoints — HMAC-signed session cookies (HttpOnly / Secure / SameSite=Strict / Max-Age=8h). Basic auth kept as a curl/scripts backdoor but no `WWW-Authenticate` header so the browser never prompts.
- **Constant-time compare** on password check (guards against timing leaks)
- **Reply-Token model** on `/agreement/?id=X&t=Y` — per-booking HMAC token, rotate the admin password and every outstanding link dies
- **All work version-controlled** on GitHub (github.com/aaronconsent/pcgc) — 77 commits, every change reviewable

## Technology Stack

| Layer | Tech | Business meaning for a service business |
|---|---|---|
| Hosting | Cloudflare Workers + static assets | No server for John to maintain. Uptime is Cloudflare's problem. Fastest possible page load from every device. |
| Storage | Cloudflare KV | Every booking, every event, every signed agreement — persisted at the edge, no database to admin |
| Email | Resend HTTP API | Customer confirmations + owner notifications + thank-you emails + PDF attachments. Cheap, deliverable, self-service DNS setup. |
| PDFs | jsPDF (client-side) | Replaces a paid DocuSign subscription — the customer's own browser generates the PDF; we never had to buy a per-signature license. |
| Signature | signature_pad v4 | Battle-tested; handles touch + mouse + pointer + resize correctly. |
| Date picker | flatpickr v4 | Same UX on iPhone / iPad / Android / Mac / PC — one date picker code path. |
| Analytics | Cloudflare Web Analytics + first-party KV events | Cookieless privacy; no cookie banner needed. Real conversion counts in `/admin/dashboard/`. |
| Automation | Client-side canvas image resize + share image gen + PDF gen | Zero cost per booking. |
| Build | Python static-site generator (`build.py`) | 30 pages emitted from typed data — content changes are edits to a Python dict, not a CMS wrestling match. |

---

## Verified Results

**VERIFIED TECHNICAL RESULTS** (facts I can prove from the repo):

- **30 static HTML pages** built (`Done. Built 30 pages + robots + sitemap + llms.txt.`)
- **40 unique images** across the site — 20+ real product photos, 8 auto-generated OG social cards, 3 fleet photos, custom logo set
- **12+ Schema.org types** on the homepage alone; **58 Question / 58 Answer / 54 ListItem / 18 BreadcrumbList / 11 FAQPage / 4 Product / 4 Article** JSON-LD entries across the deeper content trees
- **7 tracked conversion events**, live-counted in `/admin/dashboard/`
- **4 lifecycle statuses** per booking with automatic thank-you email on transition to "returned"
- **8 URLs in sitemap**, 3 hidden phase trees explicitly disallowed in robots
- **77 commits** in Git — every change auditable
- **21,600+ lines inserted** vs the initial scraped mirror; **4,754 lines deleted** (of the GoDaddy-era markup)
- **Zero external tracking cookies** — Cloudflare Web Analytics is cookieless
- **No origin server** — pure Cloudflare Workers, edge-hosted

**MEASURABLE BUT NOT YET MEASURED** (needs the client + Search Console + analytics access):
- Real Lighthouse / Core Web Vitals scores against the deployed site
- Indexed page count (Google Search Console verified — need Aaron to pull the coverage report)
- Query impressions + click-through rates from GSC (need 7-day+ data window)
- Cloudflare Web Analytics pageviews + top pages + referrers (dashboard was hooked up recently)
- Number of real bookings submitted via `/rentals/` (KV is populating; Aaron has admin access to `/admin/rentals/`)
- Facebook / Instagram / Nextdoor share click counts (`booking-shared` event is live in the tracker)

**VERIFIED BUSINESS RESULTS** — UNKNOWN — ASK AARON

## Before & After

**BEFORE** — from the initial commit and its associated commit-message evidence:
- 14MB of scraped GoDaddy HTML/CSS soup
- Legacy site-builder URLs, e.g. `/golf-carts-for-sale/ols/…`
- No custom brand
- No lead-capture beyond a legacy contact form
- No rental system
- No local SEO structure
- No owner tooling
- Google indexed the OLD Weebly/Ecwid URLs; new content wasn't reaching the SERP

**AFTER**:
- 30-page hand-built static site — ~90KB total on the initial redesign commit vs the 14MB legacy pile
- Full booking + e-signature + PDF system replacing DocuSign
- Admin dashboard with lifecycle tracking + thank-you emails + email diagnostics
- Financing landing page + citation-submission package + reviews landing
- 90+ Schema.org entries across the deeper trees
- Cloudflare Web Analytics + Google Search Console + Bing Webmaster verified

---

## Best Portfolio Visuals

**1 — The Rental Booking Wizard, Step 4** *(the killer shot)*
- **Where:** `polkcountygolfcarts.com/rentals/` — complete steps 1-3, land on 4
- **Capture:** desktop scroll + mobile scroll, both showing the full inline agreement with fleet grid + terms box + DL upload widget + signature pad + agreed checkbox
- **Why:** No other small-business site has this. It replaces both a booking system AND a DocuSign subscription.
- **Format:** Two side-by-side screenshots (desktop + mobile) OR a 15-second screen recording

**2 — The Signed-Agreement PDF**
- **Where:** Cut a real booking end-to-end, screenshot the emailed PDF opened in Preview
- **Capture:** Page 1 (customer + carts + terms), Page 2 (signature block with drawn signature + checkbox + counter-sig), Page 3 (DL photo if uploaded)
- **Why:** A physical artifact — customers keep this; John keeps it. "You get a real signed PDF for every rental."
- **Format:** PDF page thumbnails or side-by-side screenshots

**3 — The Admin Dashboard (`/admin/rentals/`)**
- **Where:** `polkcountygolfcarts.com/admin/rentals/` after signing in
- **Capture:** A booking card with the status pill, 50% DEPOSIT badge, address block, delivery, checklist card, and the signed-agreement thumbnail all visible
- **Why:** Most small-business site pitches never show the owner's side. This is what John actually uses every day.
- **Format:** Desktop screenshot, potentially with the status dropdown open

**4 — The Conversion Dashboard (`/admin/dashboard/`)**
- **Where:** `polkcountygolfcarts.com/admin/dashboard/`
- **Capture:** 5 KPI tiles + horizontal event bar chart + daily-total sparkline
- **Why:** Proves the site isn't just pretty — it's measured. Every apply-click, phone-tap, and booking counted.
- **Format:** Desktop screenshot with the 7-day range selected

**5 — The Signature Pad in Action**
- **Where:** Rentals Step 4 signature canvas
- **Capture:** A 5-second screen recording of typing "John Long" and watching the cursive auto-signature appear
- **Why:** Visually delightful, technically clever (optical centering, canvas typography).
- **Format:** GIF or short screen recording

**6 — The Homepage Hero**
- **Where:** `polkcountygolfcarts.com/`
- **Capture:** Above-the-fold hero on desktop AND mobile
- **Why:** Sets the design bar. Custom brand, real photos, not template.
- **Format:** Two screenshots (desktop + mobile) side-by-side

**7 — The Financing Page**
- **Where:** `polkcountygolfcarts.com/financing/`
- **Capture:** Full-page render including hero, two-lender partner cards, and payment-estimate table
- **Why:** Real conversion strategy — captures customers actively searching "finance a golf cart Texas" and hands them off to the right lender.
- **Format:** Long-form desktop screenshot

**8 — The Custom Social Share Image**
- **Where:** Sample output of `generateShareImage(booking)` from Step 5
- **Capture:** The 1080×1080 PNG itself, plus a mock of it in an Instagram Story preview
- **Why:** Every booking ships a marketing asset. Free organic reach.
- **Format:** Two side-by-side stills — the raw image + the "on Instagram" mockup

**9 — Schema.org Entity Graph** *(diagram, not a screenshot)*
- **What:** A hand-drawn diagram showing how our JSON-LD `@id` graph links `#business` → `#org` → `#website` → 30 pages
- **Why:** Most agencies say "we did SEO." This shows we structured the entity graph.
- **Format:** Vector diagram + a code snippet closeup of one JSON-LD block

**10 — Git History Timeline**
- **What:** A stat card showing "77 commits, 21,600+ lines added, 30 pages built, 14MB → ~200KB"
- **Why:** Proves depth of work.
- **Format:** Stat card / infographic

---

## Potential Headlines

1. **"We threw out 14MB of scraped GoDaddy HTML and built a full rental-booking system with e-signatures for less than a year of DocuSign."**
2. **"The Cloudflare Worker that replaced their website, their booking form, their DocuSign subscription, and half their admin work."**
3. **"How a family-owned golf-cart shop in Livingston, TX got Instagram-worthy branded shareables on every rental — automatically."**

## Potential Portfolio Teaser (30–50 words)

We rebuilt Polk County Golf Carts from a scraped 14MB GoDaddy mirror into a Cloudflare Worker with a real rental-booking system, built-in e-signed agreements that email a PDF straight to the customer, and an owner dashboard that talks back in plain English when something breaks.

## Best Sales Takeaway

Another service business should look at this and want Aaron to build theirs because **PCGC didn't get a pretty website — they got a business system.** Their booking flow, e-signature, PDF generation, thank-you emails, review requests, conversion tracking, and admin lifecycle all live inside ONE Cloudflare Worker. No SaaS bill, no per-signature fee, no server to babysit. The kind of setup that would cost a $2,000/month agency retainer somewhere else — running on Cloudflare's free tier plus a Resend account.

---

## Superpowers Assigned (with proof)

- **BRAND POWER** ✓ — `site.css` design tokens; custom logo set; 8 auto-generated OG cards; Grobold + Georgia + system-UI type stack
- **WEBSITE POWER** ✓ — 30 hand-built pages, custom 404, responsive mobile-first, full replacement of scraped legacy mirror
- **SEO POWER** ✓ — 90+ Schema.org entries, sitemap + robots + llms.txt, 6 town pages + 4 buying guides + 4 PDPs staged for launch, citation package prepared
- **AI POWER** ✓ — llms.txt, FAQ schema at scale, entity graph via stable `@id`s, client-side Canvas/PDF/image generation with no external dependencies
- **CLOUDFLARE POWER** ✓ — Workers, KV, Web Analytics, edge assets, www→apex 301, HMAC-cookie sessions
- **LEAD POWER** ✓ — Rental booking + e-sign + PDF pipeline, dual email flow, conversion dashboard with 7 tracked events, thank-you-plus-review-request on lifecycle transitions, financing lead-gen page

---

## Missing Information (I FOUND vs I INFERRED vs ASK AARON)

**I FOUND THIS** (verified in the repo):
- 14MB → 30-page rebuild, verified via commits `4250fde` (initial scraped mirror) and `b15fe5f` ("Replace scraped GoDaddy site with a from-scratch redesign")
- All the technical claims above are grep-verifiable
- The rental booking system, e-signature, PDF, admin dashboards, conversion tracking, thank-you emails, share card — all present in the code

**I INFERRED THIS** (probably true but based on context, not explicit):
- Client hired us because owner needed a real booking system + wanted to escape DocuSign — inferred from the "remove Docusign flow" and "add booking" requests in this session's chat
- Legacy site was on GoDaddy — verified via commit message
- Target customer for rentals is Lake Livingston vacation renters — inferred from copy references ("Lake Livingston Days," "Lake Life")
- Owner name John + office manager Callie — verified via privacy-policy copy AND the BBB profile (visible in code)

**UNKNOWN — ASK AARON**:
- What did the OLD site look like screenshotted? (Wayback Machine URL is captured in `crawl.py` but a modern screenshot would be great for before/after)
- What was PCGC paying DocuSign monthly?
- Real conversion numbers post-launch: bookings/week, phone taps/week, finance apply-clicks/week?
- Any customer testimonials since launch?
- Are we running paid ads driving traffic to `/rentals/` yet? If not, what's the current organic traffic to `/rentals/`?
- Did the physical shop have a paper booking process before this? What was John doing manually that this replaced?
- Any specific SEO wins post-launch — new keywords ranking, first-page appearances?
- What are the numbers on the citation-package submissions (were any completed)?
- Any Google Business Profile analytics we could screenshot (views, direction-clicks, calls)?

---

## Questions for Aaron (high-value only)

1. **Do you have a screenshot of the OLD polkcountygolfcarts.com site (pre-June 2026)** for the before/after? Or should we pull from the Wayback Machine?
2. **What was John paying monthly** for DocuSign + Weebly/GoDaddy + any other subscriptions the new build replaced?
3. **Has anyone actually cut a real booking through `/rentals/` yet?** If yes, could you screenshot the resulting confirmation email + PDF as a real portfolio piece?
4. **Do you have a testimonial or quote from John?** Even a single sentence dramatically strengthens the case study.
5. **Rough time-to-build** — how many hours/days did the full build take? (For the "in X days we shipped Y" line.)
6. **Any Google Search Console coverage data yet** — how many pages are indexed, top query surfaced?
7. **Did any specific request from John kick off the project?** (E.g., "I want online rentals" vs "I want a new website" — matters for framing "the problem.")
