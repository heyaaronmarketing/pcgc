#!/usr/bin/env python3
"""
Static-site builder for Polk County Golf Carts.

One Python file generates every HTML page from shared header / footer /
contact strip fragments, so nav stays in sync across the site. Output
is plain HTML in site/ (no build chain on Cloudflare — wrangler just
uploads the directory).

Run:  python3 build.py
"""
import os
import re
from textwrap import dedent

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")

# Short content hash of site.css for cache-busting the <link> tag. The
# CSS file itself is served unchanged; browsers see a new URL when the
# file content changes, so they fetch the new bytes instead of reusing
# a stale cached copy.
def _site_css_version():
    import hashlib
    css_path = os.path.join(ROOT, "assets", "site.css")
    try:
        with open(css_path, "rb") as f:
            return hashlib.sha1(f.read()).hexdigest()[:8]
    except FileNotFoundError:
        return "0"
SITE_CSS_VER = _site_css_version()

def _track_js_version():
    import hashlib
    p = os.path.join(ROOT, "assets", "track.js")
    if not os.path.exists(p): return "0"
    with open(p, "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()[:8]
TRACK_JS_VER = _track_js_version()

BIZ = {
    "name": "Polk County Golf Carts",
    "short": "PCGC",
    "addr": "1732 FM 3277, Livingston, TX 77351",
    "phone_primary": "936-223-1182",
    "phone_secondary": "936-566-5069",
    "email": "polkcountygolfcarts@yahoo.com",
    "owner": "John",
    "founded": 2020,
    "service_area": "San Jacinto, Polk, Walker, Trinity & Angelina counties",
    "delivery_radius": 25,
    "extended_radius": 75,
    "bbb_url": "https://www.bbb.org/us/tx/livingston/profile/recreational-vehicles/polk-county-golf-carts-0825-1000223827",
    # Family-shop tagline used wherever we used to say "Family-owned since 2020".
    "tagline": "Serving our community as a family owned business since 2020",
    # Brand inventory line — repeated across hero copy and the carts page.
    "inventory_line": "We sell brand-new Breezy EV carts, refurbished carts, and used carts — electric and gas.",
}

NAV = [
    ("Home", "/"),
    ("Carts", "/carts/"),
    ("Rentals", "/rentals/"),
    ("Service", "/services/"),
    ("Financing", "/financing/"),
    ("About", "/about-us/"),
    ("Contact", "/contact/"),
]


def head(title, desc, path="/", og_slug=None, noindex=False, structured_data=None):
    canonical = f"https://polkcountygolfcarts.com{path}"
    og_image = f"/assets/og/{og_slug}.png" if og_slug else "/assets/og/home.png"
    robots = '<meta name="robots" content="noindex, nofollow">' if noindex else ''
    sd = ""
    if structured_data:
        sd = f'<script type="application/ld+json">{structured_data}</script>'
    # Verification meta tags — only emit when the constant is set,
    # so an unclaimed property doesn't leak an empty tag into the page.
    verify = ""
    if GOOGLE_SITE_VERIFICATION:
        verify += f'\n  <meta name="google-site-verification" content="{GOOGLE_SITE_VERIFICATION}">'
    if BING_SITE_VERIFICATION:
        verify += f'\n  <meta name="msvalidate.01" content="{BING_SITE_VERIFICATION}">'
    # Cloudflare Web Analytics — beacon fires on every pageview, no
    # cookies, no fingerprint. Deferred so it never blocks render.
    analytics = ""
    if CLOUDFLARE_ANALYTICS_TOKEN:
        analytics = (
            f'\n  <script defer src="https://static.cloudflareinsights.com/beacon.min.js" '
            f"data-cf-beacon='{{\"token\": \"{CLOUDFLARE_ANALYTICS_TOKEN}\"}}'></script>"
        )
    return dedent(f"""\
        <!doctype html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>{title} | {BIZ['name']}</title>
          <meta name="description" content="{desc}">
          {robots}
          <link rel="canonical" href="{canonical}">
          <link rel="icon" type="image/svg+xml" href="/assets/logos/logo-color.svg">
          <link rel="icon" type="image/png" sizes="256x256" href="/assets/logos/favicon.png">
          <link rel="preconnect" href="https://fonts.cdnfonts.com">
          <link rel="stylesheet" href="https://fonts.cdnfonts.com/css/grobold">
          <link rel="stylesheet" href="/assets/site.css?v={SITE_CSS_VER}">
          <meta property="og:title" content="{title} | {BIZ['name']}">
          <meta property="og:description" content="{desc}">
          <meta property="og:image" content="https://polkcountygolfcarts.com{og_image}">
          <meta property="og:image:width" content="1200">
          <meta property="og:image:height" content="630">
          <meta property="og:type" content="website">
          <meta property="og:url" content="{canonical}">
          <meta name="twitter:card" content="summary_large_image">
          <meta name="twitter:title" content="{title} | {BIZ['name']}">
          <meta name="twitter:description" content="{desc}">
          <meta name="twitter:image" content="https://polkcountygolfcarts.com{og_image}">
          {sd}{verify}{analytics}
          <script defer src="/assets/track.js?v={TRACK_JS_VER}"></script>
        </head>
        <body>
        <div class="banner">FREE WARRANTIES on every cart purchased through PCGC · BBB Accredited · {BIZ['tagline']}</div>
        """)


def header(current_path):
    def link(label, href):
        cur = ' aria-current="page"' if href == current_path else ''
        return f'    <a href="{href}"{cur}>{label}</a>'
    nav_html = "\n".join(link(label, href) for label, href in NAV)
    return dedent(f"""\
        <header class="site-header">
          <div class="container">
            <a class="brand" href="/">
              <img class="brand-mark" src="/assets/logos/logo-color.svg" alt="" width="144" height="112" aria-hidden="true">
              <span class="brand-text">{BIZ['name']}<small>Livingston, Texas</small></span>
            </a>
            <nav class="primary">
        {nav_html}
              <a class="cta" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 {BIZ['phone_primary']}</a>
            </nav>
          </div>
        </header>
        """)


def bbb_seal(klass=""):
    """Official BBB Accredited Business seal. Pulled from BBB's own
    CDN per their attribution requirements (rel="nofollow" + target=
    "_blank" + linked back to the PCGC BBB profile). Pass an optional
    class to scope the wrapper (e.g. "bbb-seal-foot" for the dark
    footer treatment)."""
    return (
        f'<a class="bbb-seal {klass}" '
        f'href="{BIZ["bbb_url"]}/#sealclick" '
        f'target="_blank" rel="nofollow">'
        f'<img src="https://seal-austin.bbb.org/seals/blue-seal-280-80-bbb-1000223827.png" '
        f'alt="Polk County Golf Carts BBB Business Review" '
        f'width="280" height="80" loading="lazy" '
        f'style="border:0;"></a>'
    )


def footer():
    nav_links = "\n".join(f'      <li><a href="{href}">{label}</a></li>' for label, href in NAV)
    return dedent(f"""\
        <footer class="site-footer">
          <div class="container">
            <div class="foot-grid">
              <div>
                <img class="foot-mark" src="/assets/logos/logo-white.svg" alt="{BIZ['name']}" width="120" height="92">
                <h4 class="brand-text-foot">{BIZ['name']}</h4>
                <p>{BIZ['tagline']} in Livingston, Texas. {BIZ['inventory_line']} Free pickup &amp; delivery within {BIZ['delivery_radius']} miles, extended service up to {BIZ['extended_radius']} miles for an additional charge.</p>
                {bbb_seal("bbb-seal-foot")}
              </div>
              <div>
                <h4>Site</h4>
                <ul>
        {nav_links}
                </ul>
              </div>
              <div>
                <h4>Reach us</h4>
                <ul>
                  <li><a href="tel:{BIZ['phone_primary'].replace('-','')}">{BIZ['phone_primary']}</a></li>
                  <li><a href="tel:{BIZ['phone_secondary'].replace('-','')}">{BIZ['phone_secondary']}</a></li>
                  <li><a href="mailto:{BIZ['email']}">Email us</a></li>
                </ul>
              </div>
              <div>
                <h4>Visit</h4>
                <p><a href="https://maps.google.com/?q={BIZ['addr'].replace(' ','+')}">{BIZ['addr']}</a></p>
              </div>
              <div>
                <h4>Hours</h4>
                <ul class="foot-hours">
                  <li>Tue–Fri · 9a–4p</li>
                  <li>Saturday · 9a–2p</li>
                  <li class="muted">Closed Sun–Mon &amp; holidays</li>
                  <li class="muted">Emergency calls billed at additional rate</li>
                </ul>
              </div>
            </div>
            <div class="foot-bot">
              <span>© 2026 {BIZ['name']}. All rights reserved.</span>
              <span><a href="/privacy/">Privacy Policy</a></span>
            </div>
          </div>
        </footer>
        </body></html>
        """)




# ---------------- Breezy EV product catalog ---------------- #
#
# Source: https://breezyev.com/ (verified specs as of June 2026).
# Per the owner: don't quote per-model prices on the page.  All four
# models share the same "Prices start at $12,500 and up depending on
# the model chosen — call for current pricing" framing.  Capture this
# floor in ONE constant so the language stays consistent and any
# future change is a single-line edit.
PRICE_FROM = 12500
PRICE_TEXT = "Prices start at $12,500 and up depending on the model chosen — call for current pricing."

# Live kiosk URL for the Lendmark Financial pre-qualification flow. Owner
# supplied this and it's specific to PCGC's dealer code — don't change
# without confirming with John.
LENDMARK_APPLY_URL = "https://securedlr.lendmarkfinancial.com/Kiosk/Home/Default/d58459a1"
# Owner-supplied Dealer Direct guest application URL (apptraker.com),
# scoped to PCGC's dealer code 11194.
DEALER_DIRECT_APPLY_URL = "https://dealerdirect.apptraker.com/my/guest?dealer=11194"

# ---------------- Analytics + verification (Tier 1 SEO) ---------------- #
#
# Each of these emits one line in the <head> of every page WHEN SET.
# Leave empty to skip. Fill in the value from the respective dashboard:
#
#   GOOGLE_SITE_VERIFICATION
#     Search Console -> https://search.google.com/search-console
#     Add property (Domain type, "polkcountygolfcarts.com") or URL prefix
#     ("https://polkcountygolfcarts.com"). Pick "HTML tag" verification.
#     Google shows a tag like:
#       <meta name="google-site-verification" content="ABCDEF123..." />
#     Paste ONLY the content value below.
#
#   BING_SITE_VERIFICATION
#     Bing Webmaster Tools -> https://www.bing.com/webmasters
#     Fastest path: click "Import from Google Search Console" once GSC is
#     verified — no code change needed. Otherwise pick "Meta tag"
#     verification, paste the content value below.
#
#   CLOUDFLARE_ANALYTICS_TOKEN
#     Cloudflare dashboard -> Analytics & Logs -> Web Analytics ->
#     Add a site -> polkcountygolfcarts.com. Cloudflare gives a
#     <script> tag with data-cf-beacon='{"token":"XXXX"}'. Paste the
#     token below. Free, no cookies, no perf hit, zero PII.
GOOGLE_SITE_VERIFICATION = ""
BING_SITE_VERIFICATION = ""
CLOUDFLARE_ANALYTICS_TOKEN = "fd4f94c888f9437ba7a7b44e9dd051fa"

import json as _json

TOWN_PAGES = {
    "livingston-tx": {
        "name": "Livingston, TX",
        "short_name": "Livingston",
        "county": "Polk County",
        "distance_mi": 0,
        "delivery": "free",
        "hook": "We're right here. Our shop is on FM 3277 — the showroom you can be at in five minutes.",
        "use_cases": [
            ("Neighborhood cruising", "Cul-de-sac runs, kids to school, the trip to the mailbox that becomes the long way around."),
            ("Lake Livingston access", "Dock-to-driveway runs in summer, ramp shuttles in tournament season."),
            ("Polk County events", "Tailgates, parades, the fairgrounds, anywhere a golf cart can fit through a gate."),
        ],
        "nearby": "Lake Livingston State Park · Polk County Courthouse · US-59 corridor · Naskila Casino",
        "lifestyle_angle": "hometown advantage",
    },
    "onalaska-tx": {
        "name": "Onalaska, TX",
        "short_name": "Onalaska",
        "county": "Polk County",
        "distance_mi": 16,
        "delivery": "free",
        "hook": "Lake Livingston cart life starts in Onalaska. We deliver free across the lake's west and south shores.",
        "use_cases": [
            ("Lake-house lifestyle", "Dock-to-cabin runs, neighborhood cruising on the lakefront streets, ramp-to-house haul on tournament weekends."),
            ("Weekend property maintenance", "A 6-seater carries the cooler, the kids, the dog, and the fishing rods in one trip."),
            ("Yaupon Cove & Beacon Bay", "The kind of subdivisions where a golf cart is the right second vehicle, not a luxury."),
        ],
        "nearby": "Lake Livingston west shore · Lake Livingston Resort · Yaupon Cove · Beacon Bay",
        "lifestyle_angle": "lake life",
    },
    "coldspring-tx": {
        "name": "Coldspring, TX",
        "short_name": "Coldspring",
        "county": "San Jacinto County",
        "distance_mi": 22,
        "delivery": "free",
        "hook": "Coldspring ranches and acreage. The kind of property where a lifted cart is the truck before the truck.",
        "use_cases": [
            ("Ranch & deer-lease use", "Feed runs, fence checks, hunting season hauling — the Breeze 4L and Terrain 6 are built for this."),
            ("Sam Houston National Forest access", "Trailheads, primitive camping, the back roads that pavement forgot."),
            ("South shore Lake Livingston", "The quieter side of the lake, where deliveries are still inside our free 25-mile range."),
        ],
        "nearby": "Sam Houston National Forest · Trinity River · Lake Livingston south shore",
        "lifestyle_angle": "ranch country",
    },
    "huntsville-tx": {
        "name": "Huntsville, TX",
        "short_name": "Huntsville",
        "county": "Walker County",
        "distance_mi": 30,
        "delivery": "extended",
        "hook": "Sam Houston State, tailgating, and the rolling hills outside town. Just inside our extended service area.",
        "use_cases": [
            ("SHSU tailgating", "Bowers Stadium and the rest — a 6-seater Breezy EV beats a folding chair, every time."),
            ("Huntsville State Park", "Roads, trails, a place to park the camper. Carts that handle gravel matter here."),
            ("Acreage outside town", "The five-acre lots off the loop — the place where 5\" street stance stops being enough."),
        ],
        "nearby": "Sam Houston State University · Huntsville State Park · Sam Houston statue · I-45 corridor",
        "lifestyle_angle": "college town + state park",
    },
    "lufkin-tx": {
        "name": "Lufkin, TX",
        "short_name": "Lufkin",
        "county": "Angelina County",
        "distance_mi": 50,
        "delivery": "extended",
        "hook": "Deep East Texas. We deliver to Lufkin — flat $75 extended fee, no surprise charges.",
        "use_cases": [
            ("Retiree neighborhoods", "Pinetop, Crown Colony, Walnut Hill — communities where carts replace second cars."),
            ("Acreage & timber-country properties", "Lufkin's outskirts run to thousands of acres. A Terrain 6 covers it."),
            ("Angelina College tailgating", "Same script as Huntsville: a six-seater wins."),
        ],
        "nearby": "Angelina College · Ellen Trout Zoo · US-59 corridor · Sam Rayburn Reservoir",
        "lifestyle_angle": "the big East Texas town",
    },
    "woodville-tx": {
        "name": "Woodville, TX",
        "short_name": "Woodville",
        "county": "Tyler County",
        "distance_mi": 45,
        "delivery": "extended",
        "hook": "Dogwood Trails country. The lake-and-pines life that an electric cart was built for.",
        "use_cases": [
            ("Lake Tejas & B.A. Steinhagen Lake", "Two of the prettiest lakes in East Texas. A lifted Breezy EV handles the gravel roads in."),
            ("Dogwood Trails Festival", "The kind of small-town event where everyone notices a custom-painted cart."),
            ("Big Thicket access", "Trail-adjacent properties where a 7-inch ground-clearance cart is the right tool."),
        ],
        "nearby": "B.A. Steinhagen Lake · Lake Tejas · Big Thicket National Preserve · Dogwood Trails",
        "lifestyle_angle": "small-town lake & pines",
    },
}


BREEZY_EV_MODELS = {
    "breeze-4": {
        "name": "Breeze 4",
        "tagline": "The everyday 4-seater. Street-cruiser stance, family-cruiser comfort.",
        "summary": "Our entry into the Breezy EV lineup. Four passengers, low-profile street stance, all the modern touches (Lithium battery, CarPlay, Bluetooth sound bar) without the lift kit. Perfect for the neighborhood, the cul-de-sac, and the front-nine path.",
        "seats": 4,
        "lifted": False,
        "ground_clearance_in": 5.0,
        "tire": "215/35 R14 DOT",
        "weight_lbs": 1102,
        "length_in": 116.7,
        "width_in": 48.8,
        "height_in": 78.0,
        "range_mi": "45–55",
        "best_for": "Neighborhood cruising · golf course paths · low-speed in-town runs · first-time golf cart owners",
        "color_swatches": True,
    },
    "breeze-4l": {
        "name": "Breeze 4L",
        "tagline": "The 4-seater, lifted. Off-road tires, lake-life attitude.",
        "summary": "Same Breeze 4 platform with a lift kit and aggressive 23x10-14 DOT tires. Ride higher, see further, hit gravel roads and grass and the trail to the deer lease without thinking twice. Same Lithium powertrain, same warranty, more capability.",
        "seats": 4,
        "lifted": True,
        "ground_clearance_in": 6.85,
        "tire": "23x10-14 DOT off-road",
        "weight_lbs": 1213,
        "length_in": 119.3,
        "width_in": 51.6,
        "height_in": 82.5,
        "range_mi": "35–50",
        "best_for": "Lake Livingston · ranch & deer-lease · gravel-road cruising · weekends at the cabin",
        "color_swatches": True,
    },
    "breeze-6l": {
        "name": "Breeze 6L",
        "tagline": "Six seats. Lifted. Built for the whole family.",
        "summary": "The family flagship. Six forward-facing seats with quilted upholstery, the same lift and tire package as the Breeze 4L, and the room to load up the kids, the cousins, and a cooler. Our best-selling rental fleet model and our most-asked-for new cart.",
        "seats": 6,
        "lifted": True,
        "ground_clearance_in": 6.85,
        "tire": "23x10-14 DOT off-road",
        "weight_lbs": 1389,
        "length_in": 149.0,
        "width_in": 51.6,
        "height_in": 82.2,
        "range_mi": "45–55",
        "best_for": "Family lake days · resort & event fleets · group hauling · rental income properties",
        "color_swatches": True,
    },
    "terrain-6": {
        "name": "Terrain 6",
        "tagline": "When you need to go places golf carts don't go.",
        "summary": "Six seats and the highest ground clearance in the Breezy EV lineup. Built for the customer who wants the lift, the room, and the toughest stance we sell. Ranches, deer leases, beach houses, sand — the Terrain 6 is the cart that gets there.",
        "seats": 6,
        "lifted": True,
        "ground_clearance_in": 7.1,
        "tire": "23x10-14 DOT off-road (heavy-duty)",
        "weight_lbs": 1299,
        "length_in": 146.0,
        "width_in": 51.8,
        "height_in": 80.4,
        "range_mi": "35–50",
        "best_for": "Ranch & ag use · sand & beach · trail riding · the most demanding terrain",
        "color_swatches": True,
    },
}

# Spec fields shared across every Breezy EV model.
BREEZY_EV_COMMON = {
    "motor": "5 kW AC induction (Navitas 600A controller)",
    "battery": "48V · 125Ah Lithium",
    "charger": "Smart on-board (120V / 220V AC)",
    "drive": "Rear-wheel drive",
    "brakes": "4-wheel disc + electronic parking brake",
    "warranty": "2-year bumper-to-bumper · 8-year Lithium battery",
    "tech": "Wireless CarPlay/Android Auto display · Bluetooth sound bar · LED lighting",
    "storage": "39-gallon rear trunk with drain holes",
    "speed_lsv": "Programmable up to 25 mph (Texas LSV limit)",
}


def breezy_color_swatches_html():
    """Eight color chips matching the carts page color section."""
    colors = [
        ("Vibrant Orange", "#ff7d28"),
        ("Candy Apple Red", "#c8102e"),
        ("Ocean Blue", "#0a4d8c"),
        ("Electric Blue", "#00a3d9"),
        ("Green Apple", "#5fa830"),
        ("Pearl White", "#f7f5ec"),
        ("Matte Black", "#1d1d1d"),
        ("Gun Metal Grey", "#4a4d52"),
    ]
    return "\n".join(
        f'<span class="swatch"><span class="dot" style="background:{hex_};{"border-color:#cdcdc0" if hex_ == "#f7f5ec" else ""}"></span>{name}</span>'
        for name, hex_ in colors
    )


def breezy_model_faqs(model):
    """Five FAQ entries per model — written for AEO (clear answer in
    the first sentence) AND as schema.org FAQPage entries."""
    name = model["name"]
    seats = model["seats"]
    lifted = model["lifted"]
    range_mi = model["range_mi"]
    gc = model["ground_clearance_in"]
    return [
        {
            "q": f"How fast does the {name} go?",
            "a": f"The {name} is programmable up to <b>25 mph</b>, which is the maximum allowed for a Low Speed Vehicle (LSV) on Texas streets. We program every cart at delivery to match how you plan to drive it — slower for kid-driving, faster for property use.",
        },
        {
            "q": f"What's the range on a single charge?",
            "a": f"Breezy EV rates the {name} at <b>{range_mi} miles</b> per charge on the standard 48V 125Ah Lithium pack. Real-world range depends on terrain, payload, and speed — Lake Livingston customers typically get a full weekend of cruising without needing to plug in.",
        },
        {
            "q": "Is it street legal in Texas?",
            "a": "Yes — with the optional <b>street-legal kit</b> the {0} is registered as a Low Speed Vehicle, which Texas allows on roads posted 35 mph or less. The kit adds headlights, turn signals, mirrors, seat belts, a horn, and a license-plate mount. We handle the install and the paperwork.".format(name),
        },
        {
            "q": "What's the warranty?",
            "a": "Every new Breezy EV comes with a <b>2-year bumper-to-bumper warranty</b> on the cart and an <b>8-year warranty</b> on the Lithium battery pack. PCGC backs the warranty locally — call us, we pick the cart up, we fix it, we bring it back.",
        },
        {
            "q": (
                f"Is the {name} good for off-road and ranch use?"
                if lifted else
                f"Can I take the {name} off-road?"
            ),
            "a": (
                f"Yes — the {name} ships lifted from the factory with <b>{gc} inches of ground clearance</b> and 23x10-14 DOT-rated off-road tires. It's the right fit for gravel roads, pasture, and the trail to the dock or the deer blind."
                if lifted else
                f"The {name} is the non-lifted street model with <b>{gc} inches of ground clearance</b>, which is plenty for paved roads and golf paths but not the right cart for ranch or trail use. If you need a lift, look at the Breeze 4L, Breeze 6L, or Terrain 6."
            ),
        },
    ]


def faq_schema(faqs):
    """JSON-LD FAQPage schema (returns the dict; caller serializes)."""
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": _strip_tags(f["q"]),
                "acceptedAnswer": {"@type": "Answer", "text": _strip_tags(f["a"])},
            }
            for f in faqs
        ],
    }


def product_schema(slug, model):
    return {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": f"Breezy EV {model['name']}",
        "description": _strip_tags(model["summary"]),
        "brand": {"@type": "Brand", "name": "Breezy EV"},
        "image": f"https://polkcountygolfcarts.com/assets/photos/breezy-ev/{slug}.jpg",
        "sku": slug,
        # AggregateOffer is the right schema.org type when pricing varies
        # by configuration (color, options, lift kits, etc.). It tells
        # search engines the cart "starts at" the floor without locking
        # in a specific number.
        "offers": {
            "@type": "AggregateOffer",
            "url": f"https://polkcountygolfcarts.com/breezy-ev/{slug}/",
            "priceCurrency": "USD",
            "lowPrice": str(PRICE_FROM),
            "offerCount": 1,
            "availability": "https://schema.org/InStock",
            "seller": {"@id": ENTITY_BUSINESS},
        },
    }


def breadcrumb_schema(crumbs):
    return {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {
                "@type": "ListItem",
                "position": i + 1,
                "name": name,
                "item": f"https://polkcountygolfcarts.com{path}",
            }
            for i, (name, path) in enumerate(crumbs)
        ],
    }


def _strip_tags(s):
    return re.sub(r"<[^>]+>", "", s)


# Stable @id anchors used to wire entity references between the three
# site-wide schemas and the per-page Product/Offer schemas. Search
# engines de-dupe references by @id, so using these consistently
# tells them the dealer mentioned in a Product offer is the same
# entity described on the home page.
ENTITY_BUSINESS = "https://polkcountygolfcarts.com/#business"
ENTITY_ORG      = "https://polkcountygolfcarts.com/#org"
ENTITY_WEBSITE  = "https://polkcountygolfcarts.com/#website"


def site_entity_schemas():
    """Returns the site-wide schema.org @graph: AutoDealer (a
    LocalBusiness subtype), Organization, and WebSite. Emitted on the
    home page so search engines and AI engines have a single
    authoritative entity to dedupe against."""
    return {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "AutoDealer",
                "@id": ENTITY_BUSINESS,
                "name": BIZ["name"],
                "alternateName": BIZ["short"],
                "description": BIZ["tagline"] + ". " + BIZ["inventory_line"],
                "url": "https://polkcountygolfcarts.com/",
                "telephone": BIZ["phone_primary"],
                "email": BIZ["email"],
                "image": "https://polkcountygolfcarts.com/assets/logos/logo-color.png",
                "logo": "https://polkcountygolfcarts.com/assets/logos/logo-color.png",
                "priceRange": "$$",
                "paymentAccepted": "Cash, Credit Card, Financing",
                "currenciesAccepted": "USD",
                "foundingDate": str(BIZ["founded"]),
                "founder": {"@type": "Person", "name": BIZ["owner"]},
                "address": {
                    "@type": "PostalAddress",
                    "streetAddress": "1732 FM 3277",
                    "addressLocality": "Livingston",
                    "addressRegion": "TX",
                    "postalCode": "77351",
                    "addressCountry": "US",
                },
                "geo": {
                    "@type": "GeoCoordinates",
                    "latitude": 30.7128,
                    "longitude": -94.9319,
                },
                "hasMap": "https://maps.google.com/?q=1732+FM+3277+Livingston+TX+77351",
                "openingHoursSpecification": [
                    {
                        "@type": "OpeningHoursSpecification",
                        "dayOfWeek": ["Tuesday", "Wednesday", "Thursday", "Friday"],
                        "opens": "09:00",
                        "closes": "16:00",
                    },
                    {
                        "@type": "OpeningHoursSpecification",
                        "dayOfWeek": "Saturday",
                        "opens": "09:00",
                        "closes": "14:00",
                    },
                ],
                "areaServed": [
                    {"@type": "AdministrativeArea", "name": "Polk County, Texas"},
                    {"@type": "AdministrativeArea", "name": "San Jacinto County, Texas"},
                    {"@type": "AdministrativeArea", "name": "Walker County, Texas"},
                    {"@type": "AdministrativeArea", "name": "Trinity County, Texas"},
                    {"@type": "AdministrativeArea", "name": "Angelina County, Texas"},
                ],
                "serviceArea": {
                    "@type": "GeoCircle",
                    "geoMidpoint": {
                        "@type": "GeoCoordinates",
                        "latitude": 30.7128,
                        "longitude": -94.9319,
                    },
                    "geoRadius": "120700",  # 75 miles in meters
                },
                "knowsAbout": [
                    "Breezy EV golf carts",
                    "Golf cart sales",
                    "Golf cart service and repair",
                    "Golf cart customization",
                    "Lithium battery upgrades",
                    "Lifted golf carts",
                    "Street-legal golf cart conversions",
                ],
                "brand": {"@type": "Brand", "name": "Breezy EV"},
                "sameAs": [BIZ["bbb_url"]],
                "parentOrganization": {"@id": ENTITY_ORG},
            },
            {
                "@type": "Organization",
                "@id": ENTITY_ORG,
                "name": BIZ["name"],
                "url": "https://polkcountygolfcarts.com/",
                "logo": {
                    "@type": "ImageObject",
                    "url": "https://polkcountygolfcarts.com/assets/logos/logo-color.png",
                    "width": 1200,
                    "height": 1200,
                },
                "contactPoint": {
                    "@type": "ContactPoint",
                    "telephone": BIZ["phone_primary"],
                    "contactType": "sales",
                    "email": BIZ["email"],
                    "areaServed": "US-TX",
                    "availableLanguage": "English",
                },
                "sameAs": [BIZ["bbb_url"]],
            },
            {
                "@type": "WebSite",
                "@id": ENTITY_WEBSITE,
                "url": "https://polkcountygolfcarts.com/",
                "name": BIZ["name"],
                "publisher": {"@id": ENTITY_ORG},
                "inLanguage": "en-US",
            },
        ],
    }


# ---------------- Pages ---------------- #

def page_home():
    return (
        head(
            "Golf Cart Sales, Service & Custom Builds in Livingston, TX",
            "Polk County Golf Carts: brand-new Breezy EV, refurbished, and used carts — electric and gas — plus full service, custom builds, and free pickup & delivery within 25 miles of Livingston, TX (extended service up to 75 miles).",
            "/",
            og_slug="home",
            structured_data=_json.dumps(site_entity_schemas()),
        )
        + header("/")
        + dedent(f"""\
        <section class="hero">
          <div class="container hero-split">
            <div>
              <h1>The cart you want, built and serviced by a neighbor you trust.</h1>
              <p class="lede">{BIZ['tagline']}. {BIZ['inventory_line']} Plus full service and custom builds from a fresh paint job to a full lift kit, with free pickup &amp; delivery within {BIZ['delivery_radius']} miles of Livingston — extended service up to {BIZ['extended_radius']} miles for an additional charge.</p>
              <div class="hero-ctas">
                <a class="btn btn-coral" href="/carts/">See the new Breezy EV →</a>
                <a class="btn btn-outline" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 {BIZ['phone_primary']}</a>
              </div>
              <div class="hero-meta">
                <span><b>★★★★★</b> 5.0 reviews · BBB Accredited</span>
                <span><b>2-year</b> bumper-to-bumper warranty</span>
              </div>
            </div>
            <img src="/assets/photos/breezy-ev-lake-grass.jpg" alt="Teal 6-seater Breezy EV golf cart with lifted off-road tires beside East Texas lake" width="800" height="600" fetchpriority="high">
          </div>
        </section>

        <section class="band" style="padding:0; background:#000;">
          <img src="/assets/photos/hero-sign-corvette.jpg" alt="Polk County Golf Carts shop sign with a blue Breezy EV cart parked next to a blue Corvette with BREEZY license plate" style="width:100%; display:block; max-height:520px; object-fit:cover;" loading="lazy">
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">What we do</span>
              <h2>One small shop. Three things we do better than anyone in East Texas.</h2>
            </div>
            <div class="cards">
              <div class="card">
                <div class="icon">1</div>
                <h3>Carts for every budget</h3>
                <p>Brand-new 2026 Breezy EV carts, refurbished carts, and used carts — electric and gas. 4- or 6-seater, eight color options, financing through Lendmark Financial or Dealer Direct.</p>
              </div>
              <div class="card alt">
                <div class="icon">2</div>
                <h3>Service &amp; maintenance</h3>
                <p>Batteries, brakes, motors, controllers, electrical, tune-ups. Full-service package starting at $165. Gas or electric, any brand.</p>
              </div>
              <div class="card">
                <div class="icon">3</div>
                <h3>Custom builds</h3>
                <p>Custom paint, lift kits, wheels &amp; tires, sound bars, seats, Navitas controllers. We turn carts into rolling personality — for your team, your hobby, your style.</p>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div class="container split">
            <div>
              <span class="eyebrow">Featured</span>
              <h2>The brand-new 2026 Breezy EV.</h2>
              <p class="lede-text">Style. Comfort. Speed. Fun. The Breezy EV is the cart we built our reputation around — and the one we&rsquo;d recommend to a friend without hesitation.</p>
              <ul class="checks">
                <li>Lithium battery with 8-year warranty</li>
                <li>2-year bumper-to-bumper warranty</li>
                <li>Top speed 37 mph — or lock kids to 5 mph from your phone</li>
                <li>Bluetooth sound bar, LED lights, CarPlay touchscreen</li>
                <li>Optional full street-legal kit</li>
              </ul>
              <a class="btn btn-coral" href="/carts/">See all specs &amp; colors →</a>
            </div>
            <div class="price-box">
              <span class="eyebrow">Financing available</span>
              <h3 class="mt-0" style="color:var(--ink)">Pay over time.</h3>
              <p class="muted">Apply through <b>Lendmark Financial</b> or <b>Dealer Direct</b> — answer in minutes, pay over time.</p>
              <a class="btn btn-teal" href="/contact/">Get a quote</a>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">What customers say</span>
              <h2>Five-star service, repeat after repeat.</h2>
            </div>
            <div class="tm-grid">
              <div class="tm">
                <div class="stars">★★★★★</div>
                <p class="quote">"Our cart was completely non-functioning. We messaged this golf cart company in Livingston and the owner came out TO OUR HOUSE this morning and diagnosed the problem in 5 minutes. Fast, friendly, and so helpful!"</p>
                <p class="cite">— E. Murray</p>
              </div>
              <div class="tm">
                <div class="stars">★★★★★</div>
                <p class="quote">"If you&rsquo;re in the Livingston area and need a golf cart or any work done on yours, please don&rsquo;t hesitate to give John a call! He loves what he does and does great work. We won&rsquo;t take ours to anyone else."</p>
                <p class="cite">— Carrie</p>
              </div>
              <div class="tm">
                <div class="stars">★★★★★</div>
                <p class="quote">"What phenomenal service. He took an ugly duckling and brought back a swan. If you want superior service by an honest and reliable expert, then John&rsquo;s your man."</p>
                <p class="cite">— H&amp;M</p>
              </div>
            </div>
            <p class="center" style="margin-top:2rem"><a href="/about-us/">Read more reviews →</a></p>
          </div>
        </section>

        <section>
          <div class="container">
            <div class="section-head center" style="margin-left:auto; margin-right:auto; text-align:center">
              <span class="eyebrow">Service area</span>
              <h2>Free within 25 miles. Extended up to 75.</h2>
              <p class="lede-text"><b>Free pickup &amp; delivery</b> for any service within {BIZ['delivery_radius']} miles of our Livingston shop. <b>Extended service area</b> up to {BIZ['extended_radius']} miles for an additional charge — just call us for a quote. Proudly serving {BIZ['service_area']} and beyond.</p>
              <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
            </div>
          </div>
        </section>
        """)
        + footer()
    )


def page_carts():
    return (
        head(
            "Brand-New, Refurbished & Used Golf Carts",
            "We sell brand-new Breezy EV carts, refurbished carts, and used carts — electric and gas — out of Livingston, TX. Lithium battery, 2-year warranty, app speed lock, CarPlay, street-legal option.",
            "/carts/",
            og_slug="carts",
        )
        + header("/carts/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container hero-split">
            <div>
              <h1>Brand-new. Refurbished. Used.</h1>
              <p class="lede">{BIZ['inventory_line']} Below: the cart we built our reputation around — the 2026 Breezy EV.</p>
              <div class="hero-ctas">
                <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">Call {BIZ['phone_primary']}</a>
                <a class="btn btn-outline" href="/contact/">Get a quote</a>
              </div>
            </div>
            <img src="/assets/photos/breezy-ev-lake-grass.jpg" alt="Teal 6-seater Breezy EV golf cart with off-road tires" width="800" height="752" fetchpriority="high">
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="cards">
              <div class="card">
                <div class="icon">⚡</div>
                <h3>Lithium battery</h3>
                <p><b>8-year warranty</b> on the battery alone. Charges fast, lasts long, no acid topping.</p>
              </div>
              <div class="card alt">
                <div class="icon">📱</div>
                <h3>App speed control</h3>
                <p>Lock the cart to 5 mph for the kids. Open it up to 37 mph for the parents. Lock the whole cart from your phone when you walk away.</p>
              </div>
              <div class="card">
                <div class="icon">🎵</div>
                <h3>Sound bar + CarPlay</h3>
                <p>LED-lit Bluetooth sound bar plus a touchscreen with Apple &amp; Android CarPlay. Music, GPS, the works.</p>
              </div>
              <div class="card alt">
                <div class="icon">🛡️</div>
                <h3>2-year warranty</h3>
                <p>Full bumper-to-bumper warranty on the cart, eight years on the battery. Backed locally — call us, we pick up.</p>
              </div>
              <div class="card">
                <div class="icon">🛣️</div>
                <h3>Street-legal kit</h3>
                <p>Optional full street-legal package. Headlights, turn signals, mirrors — everything Texas DMV needs.</p>
              </div>
              <div class="card alt">
                <div class="icon">👥</div>
                <h3>4 or 6 seats</h3>
                <p>Four-seater or six-seater, all seats facing forward. Pick your family layout.</p>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div class="container">
            <div class="split">
              <div>
                <span class="eyebrow">Eight colors</span>
                <h2>Pick your finish.</h2>
                <p class="lede-text">Every Breezy EV ships in one of eight colors. Want something else? We can custom-paint any cart in our shop.</p>
                <div class="swatches">
                  <span class="swatch"><span class="dot" style="background:#ff7d28"></span>Vibrant Orange</span>
                  <span class="swatch"><span class="dot" style="background:#c8102e"></span>Candy Apple Red</span>
                  <span class="swatch"><span class="dot" style="background:#0a4d8c"></span>Ocean Blue</span>
                  <span class="swatch"><span class="dot" style="background:#00a3d9"></span>Electric Blue</span>
                  <span class="swatch"><span class="dot" style="background:#5fa830"></span>Green Apple</span>
                  <span class="swatch"><span class="dot" style="background:#f7f5ec; border-color:#cdcdc0"></span>Pearl White</span>
                  <span class="swatch"><span class="dot" style="background:#1d1d1d"></span>Matte Black</span>
                  <span class="swatch"><span class="dot" style="background:#4a4d52"></span>Gun Metal Grey</span>
                </div>
              </div>
              <div class="price-box">
                <span class="eyebrow">Financing</span>
                <h3 class="mt-0" style="color:var(--ink)">Pay over time.</h3>
                <p class="muted">We work with <b>Lendmark Financial</b> and <b>Dealer Direct</b>. Apply in minutes, answer same-day.</p>
                <a class="btn btn-teal" href="tel:{BIZ['phone_primary'].replace('-','')}">Apply by phone</a>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div class="container split">
            <div class="photo-block">
              <img src="/assets/photos/breezy-ev-colors-grid.jpg" alt="Four Breezy EV golf carts in green, red, light blue, and dark blue showing color and seating options" width="800" height="640" loading="lazy">
            </div>
            <div>
              <span class="eyebrow">Built for the whole family</span>
              <h2>Room for six. Comfort for all of them.</h2>
              <p class="lede-text">The six-seater configuration adds a rear flip seat with the same quilted upholstery as the front. Pick a 4-seater for everyday cruising, a 6-seater for the whole family.</p>
              <ul class="checks">
                <li>Independent rear suspension for a smoother ride</li>
                <li>Quilted vinyl seats — easy to clean, hot-weather friendly</li>
                <li>Brake lights, turn signals, license-plate mount</li>
                <li>Trailer hitch receiver standard</li>
              </ul>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head center" style="margin-left:auto; margin-right:auto; text-align:center">
              <span class="eyebrow">Gallery</span>
              <h2>Real carts. Real customers.</h2>
              <p class="lede-text">A few that have rolled out of our Livingston shop.</p>
            </div>
            <div class="photo-grid">
              <img src="/assets/photos/sunset-carts-sign.jpg" alt="Two lifted Breezy EV carts photographed at sunset with the PCGC sign between them" loading="lazy">
              <img src="/assets/photos/texas-cart-alamo.jpg" alt="Yamaha golf cart with a Texas-flag wrap parked in front of the Alamo" loading="lazy">
              <img src="/assets/photos/breezy-ev-lakeside.jpg" alt="Teal Breezy EV golf cart with quilted leather seats by a lake" loading="lazy">
              <img src="/assets/photos/cart-red-lifted.jpg" alt="Red lifted EZGO golf cart with off-road tires" loading="lazy">
              <img src="/assets/photos/cart-blue-tempo.jpg" alt="Blue Club Car Tempo with chrome wheels" loading="lazy">
              <img src="/assets/photos/cart-white-chrome.jpg" alt="White Club Car Tempo with chrome wheels and grey upholstery" loading="lazy">
            </div>
          </div>
        </section>

        <section>
          <div class="container center">
            <h2>Ready to see one in person?</h2>
            <p class="lede-text">We're in Livingston, just off FM 3277. Stop by, take one for a spin, ask anything.</p>
            <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
            &nbsp;
            <a class="btn btn-ghost" href="/contact/">Directions</a>
          </div>
        </section>
        """)
        + footer()
    )


def page_services():
    return (
        head(
            "Golf Cart Service, Custom Builds & Repairs",
            "Full-service golf cart maintenance and custom builds in Livingston, TX. Batteries, brakes, motors, controllers, lift kits, custom paint, wheels & tires. Service package from $165.",
            "/services/",
            og_slug="services",
        )
        + header("/services/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container">
            <h1>Service. Custom. Anything cart.</h1>
            <p class="lede">Tune-ups, batteries, motors, paint, lift kits — gas or electric, any brand. We service what we sell, plus everyone else's too.</p>
          </div>
        </section>

        <section>
          <div class="container split">
            <div>
              <span class="eyebrow">Full Service Package · 20-Point Inspection</span>
              <h2>Get your cart road-ready.</h2>
              <p class="lede-text">Our 20-point service package covers every system on your cart, top to bottom. Drop it off — or let us pick it up <b>free within {BIZ['delivery_radius']} miles</b> (extended up to {BIZ['extended_radius']} miles for an additional charge).</p>
              <ul class="checks">
                <li>Check &amp; refill rear-end gear oil</li>
                <li>Clean &amp; adjust brake shoes</li>
                <li>Check &amp; adjust front-end alignment</li>
                <li>Grease the front end</li>
                <li>Test all accessories</li>
                <li>Clean &amp; coat battery terminals</li>
                <li>Check &amp; adjust battery H₂O level</li>
                <li>Air &amp; rotate tires (if needed)</li>
                <li>Full battery charge</li>
                <li>Cart cleaned and returned</li>
              </ul>
              <p><b>10% off Parts &amp; Labor</b> — valid for 1 year from the date of your initial service.</p>
            </div>
            <div class="price-box">
              <span class="eyebrow">Starting at</span>
              <span class="price">$165<small> + tax</small></span>
              <p class="muted">Full Service Package · 20-Point Inspection</p>
              <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">Schedule today</a>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">Repairs we do every day</span>
              <h2>Common service work.</h2>
            </div>
            <div class="cards">
              <div class="card">
                <h3>New batteries</h3>
                <p>Lead-acid or Lithium, including <b>Bolt Energy</b> and <b>White Lightening</b>'s new line of Lithium batteries. We size, install, and dispose of the old set.</p>
              </div>
              <div class="card">
                <h3>Battery problems</h3>
                <p>Won't hold a charge? Won't take one? We diagnose chargers, cables, and terminals in one visit.</p>
              </div>
              <div class="card">
                <h3>Electrical shorts</h3>
                <p>Burnt fuses, flaky wiring, dead controllers — we trace it and fix it. (Yes, including the one your neighbor &ldquo;already looked at.&rdquo;)</p>
              </div>
              <div class="card">
                <h3>Engine tune-ups</h3>
                <p>Gas-powered carts get spark, fuel, filters, and timing dialed in for fresh-from-the-factory feel.</p>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div class="container">
            <div class="split">
              <div>
                <span class="eyebrow">Custom builds</span>
                <h2>You are not ordinary. So why should your cart be?</h2>
                <p class="lede-text">Whether you want a rear flip seat added or a full ground-up build with custom paint and a Navitas controller, we'll work to your budget and your taste.</p>
                <p>Lifts. Sound systems. Wheels. Paint. Controllers. Seats. We've done it. Look through real builds we've delivered to East Texas customers — yours could be next.</p>
                <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">Book a free consultation</a>
              </div>
              <div class="photo-block">
                <img src="/assets/photos/texas-cart-alamo.jpg" alt="Yamaha golf cart with a Texas-flag wrap parked in front of the Alamo" width="800" height="1200" loading="lazy">
              </div>
            </div>
            <div class="cards" style="margin-top:3rem">
              <div class="card">
                <div class="icon">🎨</div>
                <h3>Custom paint</h3>
                <p>Favorite team, hobby, cartoon, patriotic theme — paint it however you picture it. Full prep, multi-stage finish.</p>
              </div>
              <div class="card alt">
                <div class="icon">⬆️</div>
                <h3>Lift kits</h3>
                <p>Get the stance and ground clearance for off-road use. Paired with the right tires &amp; wheels for the look you want.</p>
              </div>
              <div class="card">
                <div class="icon">🛞</div>
                <h3>Wheels &amp; tires</h3>
                <p>Off-road, street, low-pro — the right tire-and-wheel combo turns heads. We carry options for every budget.</p>
              </div>
              <div class="card alt">
                <div class="icon">⚙️</div>
                <h3>Controllers &amp; motors</h3>
                <p>Full <b>Navitas</b> DC &amp; AC controller line plus <b>White Lightening</b> motor upgrades. More torque, smoother throttle, higher top speed.</p>
              </div>
              <div class="card">
                <div class="icon">🔋</div>
                <h3>Lithium battery upgrades</h3>
                <p>Premium Lithium packs from <b>Bolt Energy</b> and <b>White Lightening</b>'s new line — drop-in replacements, longer range, no acid topping.</p>
              </div>
              <div class="card alt">
                <div class="icon">🔊</div>
                <h3>Sound systems</h3>
                <p>Bluetooth sound bars with LEDs, marine-grade speakers, sub-amp combos. Built to last in the elements.</p>
              </div>
              <div class="card">
                <div class="icon">💺</div>
                <h3>Seats &amp; rear flip seats</h3>
                <p>Re-upholster, swap, or add. Rear flip seats, color-matched quilted vinyl in any color you want.</p>
              </div>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container split">
            <div>
              <span class="eyebrow">Pickup &amp; delivery</span>
              <h2>Free within 25 miles. Extended up to 75.</h2>
              <p class="lede-text">Our branded rig and trailer is on the road every week serving {BIZ['service_area']}. Free pickup &amp; delivery for any service within {BIZ['delivery_radius']} miles of Livingston, with an <b>extended service area up to {BIZ['extended_radius']} miles</b> for an additional charge.</p>
              <ul class="checks">
                <li><b>Free</b> roundtrip pickup &amp; delivery within {BIZ['delivery_radius']} miles of our shop</li>
                <li><b>Extended service</b> up to {BIZ['extended_radius']} miles for an additional charge — call us for a flat-rate quote</li>
                <li>Event &amp; resort fleet delivery available across the entire service area</li>
              </ul>
              <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
            </div>
            <div class="photo-block">
              <img src="/assets/photos/truck-towing-orange-cart.jpg" alt="PCGC branded 'Cruise Different' GMC truck hitched to a trailer with an orange Breezy EV cart" width="1600" height="1200" loading="lazy">
            </div>
          </div>
        </section>

        <section>
          <div class="container split reverse">
            <div class="photo-block">
              <img src="/assets/photos/rental-fleet-resort.jpg" alt="Fleet of Yamaha golf carts at Two Creeks Crossing Resort" width="1200" height="675" loading="lazy">
            </div>
            <div>
              <span class="eyebrow">Resort &amp; event service</span>
              <h2>Fleet maintenance for the people who need it most.</h2>
              <p class="lede-text">Resorts, RV parks, events — wherever golf carts run all day, every day. We service whole fleets on regular schedules, plus emergency calls.</p>
              <p>If you run a property in East Texas with carts, let's talk about a maintenance contract that keeps your fleet on the path instead of in the shop.</p>
              <a class="btn btn-ghost" href="/contact/">Get a fleet quote</a>
            </div>
          </div>
        </section>
        """)
        + footer()
    )


def page_about():
    return (
        head(
            "About Polk County Golf Carts",
            "Serving our community as a family owned business since 2020. Read our story, see what customers say, and meet John — owner and lead mechanic.",
            "/about-us/",
            og_slug="about",
        )
        + header("/about-us/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container">
            <h1>A family shop that started with one custom cart.</h1>
            <p class="lede">Polk County Golf Carts opened in {BIZ['founded']} when we built our own custom cart and friends started asking if they could buy it. {BIZ['tagline']}.</p>
          </div>
        </section>

        <section>
          <div class="container split">
            <div>
              <span class="eyebrow">Our story</span>
              <h2>Built one cart. Then another. Then a business.</h2>
              <p>We're a family-owned shop in Polk County, Texas — serving our community as a family owned business since {BIZ['founded']}. The business began when we built our own custom golf cart. Before long, friends and neighbors started asking if they could buy our cart — or if we'd build one for them.</p>
              <p>What started as a hobby quickly turned into a thriving business. But our goal hasn't changed: <b>make sure you, our customer, are satisfied</b>. We do that by providing honest and quick service at a reasonable price, with options for every budget.</p>
              <p>You have a lot of choices when it comes to customizing or servicing your golf cart. We're grateful you'd consider us for yours.</p>
              <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Talk to Us today</a>
            </div>
            <div class="photo-block">
              <img src="/assets/photos/owner-john.jpg" alt="John, owner of Polk County Golf Carts, in front of the shop" width="1024" height="768" loading="lazy">
              <div class="caption">John — owner and lead mechanic at Polk County Golf Carts.</div>
            </div>
          </div>
        </section>

        <section class="band" style="padding:0; background:#000;">
          <img src="/assets/photos/shop-exterior.jpg" alt="The Polk County Golf Carts shop building with a teal cart parked out front" style="width:100%; display:block; max-height:480px; object-fit:cover;" loading="lazy">
        </section>

        <section class="alt">
          <div class="container split">
            <div>
              <span class="eyebrow">Why us</span>
              <h2>Family-shop attitude. Dealer-grade work.</h2>
              <p class="lede-text">We're not a chain. We're not a franchise. We're the people next door who happen to be very good at golf carts — and who'll still answer when you call back two years later.</p>
            </div>
            <div>
              <div class="price-box" style="text-align:left">
                <h3 class="mt-0">Why choose PCGC</h3>
                <ul class="checks">
                  <li>BBB Accredited business</li>
                  <li>5.0-star customer reviews</li>
                  <li>Serving our community as a family owned business since {BIZ['founded']}</li>
                  <li>Free pickup &amp; delivery within {BIZ['delivery_radius']} miles; extended up to {BIZ['extended_radius']} miles</li>
                  <li>Service for any make of cart</li>
                  <li>2-year warranty on new Breezy EV carts</li>
                </ul>
                {bbb_seal()}
              </div>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">In their own words</span>
              <h2>What our customers say.</h2>
            </div>
            <div class="tm-grid">
              <div class="tm">
                <div class="stars">★★★★★</div>
                <p class="quote">"We got home from hill country and our golf cart was completely non-functioning. We messaged this golf cart company (located here in Livingston) and the owner came out TO OUR HOUSE this morning and diagnosed our problem within 5 minutes — burnt fuse box. Fast, friendly, and so helpful!"</p>
                <p class="cite">— E. Murray</p>
              </div>
              <div class="tm">
                <div class="stars">★★★★★</div>
                <p class="quote">"Super friendly and knowledgeable — would recommend to anyone. Great experience buying a golf cart."</p>
                <p class="cite">— J. Waite</p>
              </div>
              <div class="tm">
                <div class="stars">★★★★★</div>
                <p class="quote">"If you are ever near or around the Livingston area and are looking for a golf cart or need ANY work done on yours, please don't hesitate to give John a call! He loves what he does and does great work. We won't take ours to anyone else. Such a great family and good friends!"</p>
                <p class="cite">— Carrie</p>
              </div>
              <div class="tm">
                <div class="stars">★★★★★</div>
                <p class="quote">"John is amazing. You can truly see how much he knows about carts — he got my old EZGO going and we couldn't be happier with the outcome. If you need one fixed, John is your man!"</p>
                <p class="cite">— The Bakers</p>
              </div>
              <div class="tm">
                <div class="stars">★★★★★</div>
                <p class="quote">"What phenomenal service! He took an ugly duckling and brought back a swan. If you want superior service by an honest and reliable expert, then John's your man. I called him late on a Friday afternoon and he arrived first thing Saturday morning. He could have easily taken advantage of my circumstances, but never tried to."</p>
                <p class="cite">— Reggie &amp; Marilynn</p>
              </div>
              <div class="tm">
                <div class="stars">★★★★★</div>
                <p class="quote">"Awesome people, awesome carts — thanks for delivery! Ole long John offers top notch service."</p>
                <p class="cite">— B. Bentley</p>
              </div>
              <div class="tm">
                <div class="stars">★★★★★</div>
                <p class="quote">"John with Polk County Golf Carts is awesome — he did a great job painting, lifting, installing wheels and a sound bar on our cart. The before and after is 😳🤩"</p>
                <p class="cite">— L. Brown</p>
              </div>
            </div>
          </div>
        </section>
        """)
        + footer()
    )


def page_contact():
    return (
        head(
            "Contact Polk County Golf Carts",
            f"Reach Polk County Golf Carts in Livingston, TX. Call {BIZ['phone_primary']}, email {BIZ['email']}, or visit us at {BIZ['addr']}.",
            "/contact/",
            og_slug="contact",
        )
        + header("/contact/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container hero-split">
            <div>
              <h1>Let's talk carts.</h1>
              <p class="lede">Call, text, or email. We answer fast — and offer free pickup &amp; delivery within {BIZ['delivery_radius']} miles of Livingston, plus an extended service area up to {BIZ['extended_radius']} miles for an additional charge.</p>
              <div class="hero-ctas">
                <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 {BIZ['phone_primary']}</a>
                <a class="btn btn-outline" href="mailto:{BIZ['email']}">Email us</a>
              </div>
            </div>
            <img src="/assets/photos/shop-exterior.jpg" alt="The Polk County Golf Carts shop in Livingston, TX" width="1024" height="500" fetchpriority="high">
          </div>
        </section>

        <section>
          <div class="container">
            <div class="cards">
              <div class="card">
                <div class="icon">📞</div>
                <h3>Call us</h3>
                <p><a href="tel:{BIZ['phone_primary'].replace('-','')}" style="font-weight:600">{BIZ['phone_primary']}</a><br>
                <a href="tel:{BIZ['phone_secondary'].replace('-','')}">{BIZ['phone_secondary']}</a></p>
              </div>
              <div class="card alt">
                <div class="icon">✉️</div>
                <h3>Email</h3>
                <p><a href="mailto:{BIZ['email']}">{BIZ['email']}</a></p>
              </div>
              <div class="card">
                <div class="icon">📍</div>
                <h3>Visit</h3>
                <p><a href="https://maps.google.com/?q={BIZ['addr'].replace(' ','+').replace(',','')}">{BIZ['addr']}</a></p>
              </div>
              <div class="card alt">
                <div class="icon">🕘</div>
                <h3>Hours</h3>
                <p>
                  Tue–Fri · 9a–4p<br>
                  Saturday · 9a–2p<br>
                  <span class="muted">Closed Sun–Mon &amp; holidays. Emergency calls billed at additional rate.</span>
                </p>
              </div>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container split">
            <div>
              <span class="eyebrow">Service area</span>
              <h2>Free within 25 miles. Extended up to 75.</h2>
              <p class="lede-text"><b>Free</b> pickup &amp; delivery for any service within {BIZ['delivery_radius']} miles of our Livingston shop. <b>Extended service area</b> up to {BIZ['extended_radius']} miles for an additional charge — give us a call for a flat-rate quote. We proudly serve {BIZ['service_area']} and beyond.</p>
              <ul class="checks">
                <li>Polk County</li>
                <li>San Jacinto County</li>
                <li>Walker County</li>
                <li>Trinity County</li>
                <li>Angelina County</li>
              </ul>
            </div>
            <div>
              <iframe
                src="https://www.google.com/maps?q=1732+FM+3277+Livingston+TX+77351&output=embed"
                width="100%" height="380" style="border:0; border-radius:var(--radius); box-shadow:var(--shadow-lg);"
                loading="lazy" referrerpolicy="no-referrer-when-downgrade"
                title="PCGC location"></iframe>
            </div>
          </div>
        </section>
        """)
        + footer()
    )


def page_privacy():
    return (
        head(
            "Privacy Policy",
            "Privacy policy for Polk County Golf Carts.",
            "/privacy/",
            og_slug="privacy",
        )
        + header("/privacy/")
        + dedent(f"""\
        <section style="padding-top:3rem">
          <div class="container" style="max-width:780px">
            <h1>Privacy Policy</h1>
            <p class="muted">Last updated: June 2026</p>
            <p>Polk County Golf Carts (&ldquo;we,&rdquo; &ldquo;us&rdquo;) respects your privacy. This policy explains what we collect when you use our website and how we use it.</p>

            <h2>Information we collect</h2>
            <p>When you contact us by phone, email, or our contact forms, we collect the information you choose to share — typically your name, phone number, email, and a description of what you need help with.</p>
            <p>Our website may set basic cookies to remember your preferences and measure traffic. We do not sell or rent your information.</p>

            <h2>How we use it</h2>
            <p>We use your information to respond to your inquiry, schedule service or delivery, process financing applications through our partners (Lendmark Financial and Dealer Direct), and follow up on your purchase.</p>

            <h2>Sharing</h2>
            <p>We share information only with the financing partner you choose to apply with, and only with your consent.</p>

            <h2>Contact us</h2>
            <p>Questions about this policy? Email <a href="mailto:{BIZ['email']}">{BIZ['email']}</a> or call <a href="tel:{BIZ['phone_primary'].replace('-','')}">{BIZ['phone_primary']}</a>.</p>
          </div>
        </section>
        """)
        + footer()
    )


def page_financing():
    """Top-level /financing/ landing — public, indexed, in the main
    nav. Designed for both usability (clear "Apply Now" CTA at the top,
    no scroll-hunting) and SEO/AEO ("golf cart financing Texas", "0
    down golf cart financing", "golf cart financing bad credit", etc.).

    The /breezy-ev/financing/ deep page stays as the Breezy-specific
    drill-down. This page links into it for buyers who already know
    they want a Breezy."""
    apply_lendmark = LENDMARK_APPLY_URL
    apply_dealer = DEALER_DIRECT_APPLY_URL
    faqs = [
        ("How do I apply for golf cart financing?",
         f"Click <b>Apply Now</b> at the top of this page — it opens the Lendmark Financial pre-qualification form. It takes about five minutes, runs a <b>soft credit pull</b> (no impact to your score), and most applicants get a decision the same business day. Prefer to apply in person? Call <a href='tel:{BIZ['phone_primary'].replace('-','')}'>{BIZ['phone_primary']}</a> or stop by 1732 FM 3277 in Livingston."),
        ("Will applying hurt my credit score?",
         "No. The initial application runs a <b>soft pull</b>, which doesn't show on your credit report and doesn't affect your score. A hard pull only happens after you've reviewed an offer and decided to move forward."),
        ("What credit score do I need to finance a golf cart?",
         "There's no single cutoff. We've placed loans across a wide range of credit profiles. Lendmark in particular works with <b>customers who have less-than-perfect credit</b>, including scores in the 500s and low 600s. Stronger credit usually means a lower APR and a longer term, but we won't know until we look at the application."),
        ("Can I finance a golf cart with bad credit?",
         "Often, yes. Lendmark Financial's program is built specifically for credit profiles that conventional banks turn down. We'll shop your application and tell you straight up what you'll qualify for. If we can't get you approved, we'll tell you that too instead of stringing you along."),
        ("How much down payment do I need?",
         "<b>10–20% is typical</b>, but it varies by lender, credit profile, and the specific cart. Cash, trade-in, or a combination — all work. We'll quote the monthly with and without a down payment so you can compare."),
        ("What's the term length on a golf cart loan?",
         "<b>24 to 84 months</b> depending on the lender, the cart, and your credit. Longer terms mean a lower monthly payment but more total interest. We help you find the right balance for your situation."),
        ("Is there a prepayment penalty?",
         "No. Both Lendmark Financial and Dealer Direct allow <b>early payoff with no prepayment penalty</b>. Pay it off whenever you want and you only owe the interest accrued to that date."),
        ("What documents do I need to apply?",
         "Lendmark's online application asks for the basics — driver's license, social security number, employer info, and contact details. If you'd like the strongest application, have a recent pay stub or two months of bank statements handy. For in-person applications, bring those plus the driver's license."),
        ("Do you finance used golf carts?",
         "Yes. Both lenders cover new <b>and</b> used carts, including refurbished units we've serviced in our shop. Used-cart APRs are usually a touch higher than new, but the lower price often makes the monthly payment <b>lower than financing a brand-new cart</b>."),
        ("How quickly can I take delivery after I'm approved?",
         "Often <b>same week</b>. Once the loan funds (usually one business day after you accept the offer), we coordinate pickup at our Livingston shop or free delivery within 25 miles. Extended delivery up to 100 miles is also available."),
    ]
    faq_sd = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": q,
                "acceptedAnswer": {"@type": "Answer", "text": a},
            } for q, a in faqs
        ],
    }
    breadcrumb_sd = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://polkcountygolfcarts.com/"},
            {"@type": "ListItem", "position": 2, "name": "Financing", "item": "https://polkcountygolfcarts.com/financing/"},
        ],
    }
    return (
        head(
            "Golf Cart Financing in Texas — Apply Now · Polk County Golf Carts",
            "Finance a golf cart in Texas through Polk County Golf Carts. Soft credit pull, same-day decisions, terms 24-84 months. Apply online with Lendmark Financial or talk to us about Dealer Direct.",
            "/financing/",
            og_slug="financing",
            # JSON-LD supports an array of top-level entities — encode
            # the FAQPage + BreadcrumbList together. head() injects the
            # string verbatim into a single <script> tag.
            structured_data=_json.dumps([faq_sd, breadcrumb_sd]),
        )
        + header("/financing/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:2.5rem">
          <div class="container hero-split">
            <div>
              <span class="eyebrow">Pay over time</span>
              <h1>Golf cart financing, made simple.</h1>
              <p class="lede">Soft credit pull, same-day decisions, terms 24&ndash;84 months, and a shop that <b>walks you through the application</b> instead of pointing you at a form. {PRICE_TEXT}</p>
              <div class="hero-ctas">
                <a class="btn btn-coral" href="#partners" data-cta="finance-apply-hero">Apply Now &rarr;</a>
                <a class="btn btn-outline" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
              </div>
              <p style="margin-top:1rem; font-size:.92rem; color:#fff; opacity:.85;">Application takes ~5 minutes &middot; Soft pull, no credit score impact &middot; Most decisions same business day</p>
            </div>
            <img src="/assets/photos/breezy-ev-lake-grass.jpg" alt="Breezy EV golf cart by the lake" width="800" height="600" fetchpriority="high">
          </div>
        </section>

        <section class="alt" id="partners" style="scroll-margin-top:5rem;">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">Our partners</span>
              <h2>Two lenders. We shop both for you.</h2>
              <p class="lede-text">We don't make money on financing &mdash; we work with two lenders because their programs fit different customers, and we want to put you with the one that gives you the best terms.</p>
            </div>
            <div class="cards">
              <div class="card" style="display:flex; flex-direction:column;">
                <span class="eyebrow">Apply online</span>
                <h3>Lendmark Financial</h3>
                <p>National lender with a golf-cart-specific program. Works across the credit spectrum &mdash; often the right fit for customers with less-than-perfect credit, or for buyers who want a longer term to lower the monthly payment.</p>
                <ul class="checks">
                  <li>Soft pull pre-qualification</li>
                  <li>Same-day decision in most cases</li>
                  <li>Terms 24&ndash;84 months</li>
                  <li>No prepayment penalty</li>
                </ul>
                <div style="margin-top:auto; padding-top:1rem;">
                  <a class="btn btn-coral" href="{apply_lendmark}" target="_blank" rel="noopener" data-cta="finance-apply-lendmark" style="width:100%; text-align:center;">Apply with Lendmark &rarr;</a>
                </div>
              </div>
              <div class="card alt" style="display:flex; flex-direction:column;">
                <span class="eyebrow">Talk to us</span>
                <h3>Dealer Direct</h3>
                <p>Manufacturer-backed program with competitive rates on new Breezy EV carts. Often the better fit for customers with <b>stronger credit who want the lowest APR</b>, especially on the new Breeze 4, 4L, 6L, and Terrain 6.</p>
                <ul class="checks">
                  <li>Soft pull pre-qualification</li>
                  <li>Manufacturer-backed rates on new carts</li>
                  <li>Terms 24&ndash;72 months</li>
                  <li>No prepayment penalty</li>
                </ul>
                <div style="margin-top:auto; padding-top:1rem;">
                  <a class="btn btn-ghost" href="{apply_dealer}" target="_blank" rel="noopener" data-cta="finance-apply-dealer-direct" style="width:100%; text-align:center;">Apply with Dealer Direct &rarr;</a>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">How it works</span>
              <h2>Four steps, one afternoon.</h2>
            </div>
            <div class="cards">
              <div class="card">
                <div class="icon">1</div>
                <h3>Apply online or by phone</h3>
                <p>Click <b>Apply Now</b> for the Lendmark form (about five minutes), or call us and we'll walk through it together. Driver's license, employer info, and contact details &mdash; that's it.</p>
              </div>
              <div class="card">
                <div class="icon">2</div>
                <h3>Get a soft-pull decision</h3>
                <p>Most applicants hear back the <b>same business day</b>. Soft pull only, so there's no impact to your credit score while you decide.</p>
              </div>
              <div class="card">
                <div class="icon">3</div>
                <h3>Pick your cart</h3>
                <p>New Breezy EV, refurbished, used &mdash; whatever fits your budget. We'll quote the monthly with and without a down payment so you can compare.</p>
              </div>
              <div class="card">
                <div class="icon">4</div>
                <h3>Drive it home</h3>
                <p>Loan funds typically next business day. Pick up at our Livingston shop, or we'll deliver it free within 25 miles.</p>
              </div>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container" style="max-width:880px">
            <div class="section-head">
              <span class="eyebrow">Real numbers</span>
              <h2>What does the monthly payment look like?</h2>
              <p class="lede-text">Rough estimates assuming <b>10% down</b> and average credit. Actual rate depends on your application &mdash; this is just to give you a feel.</p>
            </div>
            <div class="finance-table-wrap">
              <table class="compare-table" style="width:100%; max-width:760px; margin:0 auto;">
                <thead>
                  <tr>
                    <th>Cart price</th>
                    <th>36 months</th>
                    <th>60 months</th>
                    <th>84 months</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td><b>$10,000</b></td><td>~$305 / mo</td><td>~$200 / mo</td><td>~$155 / mo</td></tr>
                  <tr><td><b>$13,000</b></td><td>~$395 / mo</td><td>~$260 / mo</td><td>~$200 / mo</td></tr>
                  <tr><td><b>$16,000</b></td><td>~$485 / mo</td><td>~$320 / mo</td><td>~$245 / mo</td></tr>
                  <tr><td><b>$20,000</b></td><td>~$605 / mo</td><td>~$400 / mo</td><td>~$305 / mo</td></tr>
                </tbody>
              </table>
            </div>
            <p class="muted" style="text-align:center; margin-top:1.25rem; font-size:.9rem;">Estimates based on 12% APR and 10% down. Your actual rate, term, and monthly will be quoted after your application is reviewed.</p>
          </div>
        </section>

        <section>
          <div class="container" style="max-width:880px">
            <div class="section-head">
              <span class="eyebrow">Common questions</span>
              <h2>Golf cart financing, FAQ.</h2>
            </div>
            <div class="faq">
              {''.join(f'<details><summary>{q}</summary><div class="faq-body"><p>{a}</p></div></details>' for q, a in faqs)}
            </div>
          </div>
        </section>

        <section class="alt cta-strip">
          <div class="container center" style="max-width:760px">
            <h2>Ready to put it in writing?</h2>
            <p class="lede-text">Apply online in five minutes, or call us and we'll walk through it together. Either way, you'll know what you qualify for the same business day.</p>
            <div class="hero-ctas center">
              <a class="btn btn-coral" href="{apply_lendmark}" target="_blank" rel="noopener" data-cta="finance-apply-bottom">Apply with Lendmark &rarr;</a>
              <a class="btn btn-ghost" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
            </div>
          </div>
        </section>
        """)
        + footer()
    )


# ---------------- Hidden /breezy-ev/ pages ---------------- #
#
# These render with noindex+nofollow, are not linked from the primary
# nav, are not in sitemap.xml, and robots.txt Disallows /breezy-ev/.
# They're meant to be reviewed via direct URL before being unhidden.

def _format_dollars(n):
    return "${:,}".format(int(n))


def page_breezy_lineup():
    """Overview page at /breezy-ev/ — the lineup hub."""
    cards = []
    for slug, m in BREEZY_EV_MODELS.items():
        cards.append(dedent(f"""\
            <a class="card breezy-card{' alt' if m['seats'] == 6 else ''}" href="/breezy-ev/{slug}/">
              <img src="/assets/photos/breezy-ev/{slug}.jpg" alt="Breezy EV {m['name']}" width="800" height="600" loading="lazy">
              <div class="card-body">
                <span class="eyebrow">{'Lifted' if m['lifted'] else 'Street'}</span>
                <h3>{m['name']}</h3>
                <p class="muted">{m['tagline']}</p>
                <ul class="checks compact">
                  <li>{m['seats']}-seater · {m['ground_clearance_in']}" clearance</li>
                  <li>{m['range_mi']} mi range · 48V Lithium</li>
                </ul>
                <p class="price-line">Prices from <b>{_format_dollars(PRICE_FROM)}</b> · <span class="muted">call for current pricing</span></p>
              </div>
            </a>"""))
    cards_html = "\n".join(cards)
    sd = breadcrumb_schema([("Home", "/"), ("Breezy EV", "/breezy-ev/")])
    return (
        head(
            "Breezy EV Golf Carts — The Lineup",
            "PCGC carries the full Breezy EV lineup: Breeze 4, Breeze 4L, Breeze 6L, and Terrain 6. Authorized dealer, Texas-based service, free pickup & delivery within 25 miles of Livingston.",
            "/breezy-ev/",
            og_slug="carts",

            structured_data=_json.dumps(sd),
        )
        + header("/breezy-ev/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container hero-split">
            <div>
              <h1>Breezy EV at Polk County Golf Carts.</h1>
              <p class="lede">Authorized Breezy EV dealer in Livingston, Texas. Four models, eight colors, one shop that delivers them to you. Test-drive any of them in person.</p>
              <div class="hero-ctas">
                <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
                <a class="btn btn-outline" href="/breezy-ev/compare/">Compare all four →</a>
              </div>
            </div>
            <div class="lineup-slideshow"
                 role="region" aria-roledescription="carousel" aria-label="Breezy EV lineup"
                 data-autoplay="5000">
              <div class="slideshow-stage">
                {''.join(
                  f'<a class="slide{" is-active" if i == 0 else ""}" href="/breezy-ev/{slug}/" aria-hidden="{"false" if i == 0 else "true"}" tabindex="{"0" if i == 0 else "-1"}" data-slug="{slug}" data-name="{m["name"]}" data-meta="{"Lifted" if m["lifted"] else "Street"} · {m["seats"]}-seater · {m["range_mi"]} mi range">'
                  f'<img src="/assets/photos/breezy-ev/{slug}.jpg" alt="Breezy EV {m["name"]}" loading="{"eager" if i == 0 else "lazy"}" fetchpriority="{"high" if i == 0 else "auto"}">'
                  f'</a>'
                  for i, (slug, m) in enumerate(BREEZY_EV_MODELS.items())
                )}
                <button class="slide-arrow slide-prev" type="button" aria-label="Previous cart">‹</button>
                <button class="slide-arrow slide-next" type="button" aria-label="Next cart">›</button>
              </div>
              <div class="slide-info" aria-live="polite">
                <div class="slide-info-text">
                  <b class="slide-info-name">Breeze 4</b>
                  <small class="slide-info-meta">Street · 4-seater · 45–55 mi range</small>
                </div>
                <a class="slide-info-link" href="/breezy-ev/breeze-4/">View &rarr;</a>
              </div>
              <div class="slide-controls">
                <div class="slide-dots" role="tablist" aria-label="Choose a cart">
                  {''.join(
                    f'<button class="slide-dot{" is-active" if i == 0 else ""}" type="button" role="tab" aria-selected="{"true" if i == 0 else "false"}" aria-label="Show {m["name"]}" data-slide="{i}"></button>'
                    for i, (slug, m) in enumerate(BREEZY_EV_MODELS.items())
                  )}
                </div>
                <div class="slide-countdown" aria-hidden="true">
                  <span class="slide-countdown-label">Next in <b class="slide-countdown-num">5</b>s</span>
                  <div class="slide-countdown-track"><div class="slide-countdown-bar"></div></div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <script>
        (function(){{
          const root = document.querySelector('.lineup-slideshow');
          if (!root) return;
          const slides = root.querySelectorAll('.slide');
          const dots = root.querySelectorAll('.slide-dot');
          const nameEl = root.querySelector('.slide-info-name');
          const metaEl = root.querySelector('.slide-info-meta');
          const linkEl = root.querySelector('.slide-info-link');
          const numEl = root.querySelector('.slide-countdown-num');
          const barEl = root.querySelector('.slide-countdown-bar');
          const total = slides.length;
          let i = 0, autoTimer = null, tickTimer = null, remaining = 0, startedAt = 0;
          const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          const delay = reduced ? 0 : (parseInt(root.dataset.autoplay, 10) || 5000);

          function syncInfo(){{
            const s = slides[i];
            nameEl.textContent = s.dataset.name;
            metaEl.textContent = s.dataset.meta;
            linkEl.href = '/breezy-ev/' + s.dataset.slug + '/';
          }}
          function show(next){{
            slides[i].classList.remove('is-active');
            slides[i].setAttribute('aria-hidden', 'true');
            slides[i].setAttribute('tabindex', '-1');
            dots[i].classList.remove('is-active');
            dots[i].setAttribute('aria-selected', 'false');
            i = (next + total) % total;
            slides[i].classList.add('is-active');
            slides[i].setAttribute('aria-hidden', 'false');
            slides[i].setAttribute('tabindex', '0');
            dots[i].classList.add('is-active');
            dots[i].setAttribute('aria-selected', 'true');
            syncInfo();
            resetCountdown();
          }}

          function resetCountdown(){{
            if (!delay) {{ if (numEl) numEl.textContent = '–'; if (barEl) barEl.style.width = '0%'; return; }}
            // Trigger reflow + restart the bar animation
            if (barEl) {{
              barEl.style.transition = 'none';
              barEl.style.width = '100%';
              barEl.offsetHeight;  // flush
              barEl.style.transition = `width ${{delay}}ms linear`;
              barEl.style.width = '0%';
            }}
            startedAt = Date.now();
            remaining = delay;
            if (numEl) numEl.textContent = Math.ceil(delay / 1000);
            if (tickTimer) clearInterval(tickTimer);
            tickTimer = setInterval(() => {{
              const left = Math.max(0, delay - (Date.now() - startedAt));
              if (numEl) numEl.textContent = Math.ceil(left / 1000);
              if (left <= 0 && tickTimer) {{ clearInterval(tickTimer); tickTimer = null; }}
            }}, 200);
          }}
          function start(){{
            if (!delay || autoTimer) return;
            autoTimer = setInterval(() => show(i + 1), delay);
            resetCountdown();
          }}
          function stop(){{
            if (autoTimer) {{ clearInterval(autoTimer); autoTimer = null; }}
            if (tickTimer) {{ clearInterval(tickTimer); tickTimer = null; }}
            // Freeze the bar where it is
            if (barEl) {{
              const cs = getComputedStyle(barEl);
              barEl.style.transition = 'none';
              barEl.style.width = cs.width;
            }}
          }}

          dots.forEach((d) => d.addEventListener('click', () => {{ stop(); show(parseInt(d.dataset.slide, 10)); start(); }}));
          root.querySelector('.slide-prev').addEventListener('click', () => {{ stop(); show(i - 1); start(); }});
          root.querySelector('.slide-next').addEventListener('click', () => {{ stop(); show(i + 1); start(); }});
          root.addEventListener('mouseenter', stop);
          root.addEventListener('mouseleave', start);
          root.addEventListener('focusin', stop);
          root.addEventListener('focusout', start);

          // Touch swipe (mobile)
          let touchX = null;
          root.addEventListener('touchstart', (e) => {{ touchX = e.touches[0].clientX; stop(); }}, {{passive:true}});
          root.addEventListener('touchend', (e) => {{
            if (touchX === null) return;
            const dx = e.changedTouches[0].clientX - touchX;
            if (Math.abs(dx) > 40) show(dx < 0 ? i + 1 : i - 1);
            touchX = null;
            start();
          }});

          syncInfo();
          start();
        }})();
        </script>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">The lineup</span>
              <h2>Four carts. One platform. Pick the one that fits the way you ride.</h2>
              <p class="lede-text">Every Breezy EV shares the same Lithium powertrain, the same 2-year + 8-year warranty, and the same CarPlay-equipped infotainment. What changes is the stance, the seats, and the terrain it's built for.</p>
            </div>
            <div class="cards breezy-grid">
              {cards_html}
            </div>
            <p class="center" style="margin-top:2rem"><a class="btn btn-ghost" href="/breezy-ev/compare/">Compare side-by-side →</a></p>
          </div>
        </section>

        <section>
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">Before you buy</span>
              <h2>Three things worth knowing first.</h2>
            </div>
            <div class="cards">
              <a class="card" href="/breezy-ev/financing/">
                <div class="card-body">
                  <span class="eyebrow">Financing</span>
                  <h3>Pay over time</h3>
                  <p>Lendmark Financial &amp; Dealer Direct — soft pulls, same-day decisions, terms 24-84 months.</p>
                </div>
              </a>
              <a class="card alt" href="/breezy-ev/street-legal/">
                <div class="card-body">
                  <span class="eyebrow">Texas LSV</span>
                  <h3>Street-legal in three steps</h3>
                  <p>The kit we install, what Texas requires, and where you can legally drive an LSV-registered cart.</p>
                </div>
              </a>
              <a class="card" href="/breezy-ev/lithium-vs-lead-acid/">
                <div class="card-body">
                  <span class="eyebrow">Battery tech</span>
                  <h3>Lithium vs Lead-acid</h3>
                  <p>Real numbers on cost, range, lifespan, and which one actually saves money over the life of the cart.</p>
                </div>
              </a>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container split">
            <div>
              <span class="eyebrow">Why buy from PCGC</span>
              <h2>The only Breezy EV dealer with boots on the ground in East Texas.</h2>
              <p>Buying a $12,000+ golf cart shouldn't mean waiting on a freight truck from another state and crossing your fingers. We stock Breezy EVs in Livingston, deliver them free within 25 miles, service them in our shop, and pick them up free under warranty.</p>
              <ul class="checks">
                <li>BBB Accredited · 5.0-star Google reviews</li>
                <li>Free pickup &amp; delivery within 25 miles, extended up to 75 miles</li>
                <li>Financing through Lendmark Financial &amp; Dealer Direct</li>
                <li>Custom paint, lift kits, sound systems &amp; more in-house</li>
              </ul>
              <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Talk to Us today</a>
            </div>
            <div class="photo-block">
              <img src="/assets/photos/shop-exterior.jpg" alt="Polk County Golf Carts shop in Livingston, Texas" width="1024" height="500" loading="lazy">
            </div>
          </div>
        </section>
        """)
        + footer()
    )


def page_breezy_compare():
    """Side-by-side compare page at /breezy-ev/compare/."""
    headers = "".join(f'<th>{m["name"]}</th>' for m in BREEZY_EV_MODELS.values())
    def row(label, fn):
        cells = "".join(f"<td>{fn(m)}</td>" for m in BREEZY_EV_MODELS.values())
        return f"<tr><th>{label}</th>{cells}</tr>"
    rows = [
        row("Seats", lambda m: f"{m['seats']}-seater"),
        row("Lift", lambda m: "Lifted" if m["lifted"] else "Street stance"),
        row("Ground clearance", lambda m: f'{m["ground_clearance_in"]}"'),
        row("Tires", lambda m: m["tire"]),
        row("Range (per Breezy EV)", lambda m: f'{m["range_mi"]} mi'),
        row("Dry weight", lambda m: f'{m["weight_lbs"]:,} lbs'),
        row("Length", lambda m: f'{m["length_in"]}"'),
        row("Best for", lambda m: m["best_for"]),
        row("Pricing", lambda m: f"From {_format_dollars(PRICE_FROM)} · call for current pricing"),
    ]
    sd = breadcrumb_schema([("Home", "/"), ("Breezy EV", "/breezy-ev/"), ("Compare", "/breezy-ev/compare/")])
    return (
        head(
            "Compare Every Breezy EV Model",
            "Side-by-side comparison of the Breeze 4, Breeze 4L, Breeze 6L, and Terrain 6 — seats, lift, range, tires, dimensions, and price.",
            "/breezy-ev/compare/",
            og_slug="carts",

            structured_data=_json.dumps(sd),
        )
        + header("/breezy-ev/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container">
            <h1>Compare the Breezy EV lineup.</h1>
            <p class="lede">Four carts. One platform. Here's how they line up against each other so you can pick the one that fits the way you actually ride.</p>
          </div>
        </section>

        <section>
          <div class="container">
            <div class="compare-wrap">
              <table class="compare-table">
                <thead><tr><th></th>{headers}</tr></thead>
                <tbody>
                  {''.join(rows)}
                </tbody>
              </table>
            </div>
            <div class="cards breezy-grid" style="margin-top:3rem">
              {"".join(
                f'<a class="card" href="/breezy-ev/{slug}/"><img src="/assets/photos/breezy-ev/{slug}.jpg" alt="{m["name"]}" loading="lazy"><div class="card-body"><h3>{m["name"]}</h3><p class="muted">{m["tagline"]}</p></div></a>'
                for slug, m in BREEZY_EV_MODELS.items()
              )}
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container center">
            <h2>Still on the fence?</h2>
            <p class="lede-text">Come ride them all. We're in Livingston off FM 3277 and the shop is open Tue–Sat.</p>
            <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
          </div>
        </section>
        """)
        + footer()
    )


def page_breezy_model(slug):
    """Product detail page for one Breezy EV model."""
    m = BREEZY_EV_MODELS[slug]
    name = m["name"]
    faqs = breezy_model_faqs(m)
    faq_html = "\n".join(
        f'<details class="faq"><summary>{f["q"]}</summary><div class="faq-body"><p>{f["a"]}</p></div></details>'
        for f in faqs
    )
    sd_list = [
        product_schema(slug, m),
        faq_schema(faqs),
        breadcrumb_schema([
            ("Home", "/"),
            ("Breezy EV", "/breezy-ev/"),
            (name, f"/breezy-ev/{slug}/"),
        ]),
    ]
    sd = _json.dumps(sd_list)
    return (
        head(
            f"Breezy EV {name}",
            f"{name} at Polk County Golf Carts in Livingston, TX. {_strip_tags(m['summary'])[:120]}",
            f"/breezy-ev/{slug}/",
            og_slug="carts",

            structured_data=sd,
        )
        + header("/breezy-ev/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container hero-split">
            <div>
              <span class="eyebrow">Breezy EV · {'Lifted' if m['lifted'] else 'Street'}</span>
              <h1>{name}</h1>
              <p class="lede">{m['tagline']}</p>
              <div class="hero-meta">
                <span><b>{m['seats']}-seater</b></span>
                <span><b>{m['range_mi']} mi</b> range</span>
                <span><b>From {_format_dollars(PRICE_FROM)}</b></span>
              </div>
              <div class="hero-ctas">
                <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
                <a class="btn btn-outline" href="/contact/">Schedule a test drive</a>
              </div>
            </div>
            <img src="/assets/photos/breezy-ev/{slug}.jpg" alt="Breezy EV {name}" width="800" height="600" fetchpriority="high">
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">At a glance</span>
              <h2>{name} specifications.</h2>
              <p class="lede-text">{m['summary']}</p>
            </div>
            <div class="spec-grid">
              <div class="spec"><b>Seats</b><span>{m['seats']} passengers</span></div>
              <div class="spec"><b>Ground clearance</b><span>{m['ground_clearance_in']}"</span></div>
              <div class="spec"><b>Tires</b><span>{m['tire']}</span></div>
              <div class="spec"><b>Top speed</b><span>{BREEZY_EV_COMMON['speed_lsv']}</span></div>
              <div class="spec"><b>Range</b><span>{m['range_mi']} miles per charge</span></div>
              <div class="spec"><b>Motor</b><span>{BREEZY_EV_COMMON['motor']}</span></div>
              <div class="spec"><b>Battery</b><span>{BREEZY_EV_COMMON['battery']}</span></div>
              <div class="spec"><b>Charger</b><span>{BREEZY_EV_COMMON['charger']}</span></div>
              <div class="spec"><b>Brakes</b><span>{BREEZY_EV_COMMON['brakes']}</span></div>
              <div class="spec"><b>Warranty</b><span>{BREEZY_EV_COMMON['warranty']}</span></div>
              <div class="spec"><b>Tech</b><span>{BREEZY_EV_COMMON['tech']}</span></div>
              <div class="spec"><b>Storage</b><span>{BREEZY_EV_COMMON['storage']}</span></div>
              <div class="spec"><b>Dimensions (L × W × H)</b><span>{m['length_in']}" × {m['width_in']}" × {m['height_in']}"</span></div>
              <div class="spec"><b>Dry weight</b><span>{m['weight_lbs']:,} lbs</span></div>
            </div>
          </div>
        </section>

        <section>
          <div class="container split">
            <div>
              <span class="eyebrow">Pick your finish</span>
              <h2>Eight factory colors. Or pick your own.</h2>
              <p class="lede-text">Every Breezy EV ships in one of eight factory colors. Want a custom shade, a fade, or a team-flag wrap? We do that in-house too.</p>
              <div class="swatches">
                {breezy_color_swatches_html()}
              </div>
            </div>
            <div class="price-box">
              <span class="eyebrow">Pricing</span>
              <h3 class="mt-0" style="color:var(--ink)">From {_format_dollars(PRICE_FROM)}</h3>
              <p class="muted">{PRICE_TEXT}</p>
              <a class="btn btn-teal" href="tel:{BIZ['phone_primary'].replace('-','')}">Get a quote</a>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">Common questions</span>
              <h2>What people ask about the {name}.</h2>
            </div>
            <div class="faq-list">
              {faq_html}
            </div>
          </div>
        </section>

        <section>
          <div class="container split reverse">
            <div class="photo-block">
              <img src="/assets/photos/owner-john.jpg" alt="John, owner of Polk County Golf Carts" width="1024" height="768" loading="lazy">
            </div>
            <div>
              <span class="eyebrow">Authorized dealer · East Texas</span>
              <h2>Buy local. Service local.</h2>
              <p class="lede-text">Every {name} we sell comes with the same set of things you can't get online: free pickup &amp; delivery within 25 miles (75 with our extended service), in-house warranty work, financing through Lendmark or Dealer Direct, and the same family-owned shop standing behind it for the life of the cart.</p>
              <ul class="checks">
                <li>BBB Accredited · 5.0-star Google reviews</li>
                <li>Free pickup &amp; delivery within 25 miles</li>
                <li>Extended service up to 75 miles ($75 flat)</li>
                <li>Financing through Lendmark &amp; Dealer Direct</li>
                <li>{BREEZY_EV_COMMON['warranty']}</li>
              </ul>
              <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Talk to Us today</a>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container center">
            <h2>Ready to see the {name} in person?</h2>
            <p class="lede-text">We're in Livingston, just off FM 3277. Come take it for a spin.</p>
            <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
            &nbsp;
            <a class="btn btn-ghost" href="/breezy-ev/compare/">Compare with the other models →</a>
          </div>
        </section>
        """)
        + footer()
    )


# ---------------- Tier-2 supporting Breezy EV pages ---------------- #
#
# Three supporting topics that ride on top of the four PDPs:
#  - /breezy-ev/financing/                Lendmark + Dealer Direct deep-dive
#  - /breezy-ev/street-legal/             Texas LSV kit + registration
#  - /breezy-ev/lithium-vs-lead-acid/     Battery technology comparison
#
# Each is hidden alongside the rest of /breezy-ev/ until the client
# unhides the tree publicly. Each carries FAQPage + BreadcrumbList
# schema for AEO/SEO. Each ends with a CTA into the four PDPs.


def _breezy_faq_section(title, faqs):
    """Render an FAQ accordion block from a list of (q, a_html) tuples."""
    items = "\n".join(
        f'<details class="faq"><summary>{q}</summary><div class="faq-body"><p>{a}</p></div></details>'
        for q, a in faqs
    )
    return dedent(f"""\
        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">Common questions</span>
              <h2>{title}</h2>
            </div>
            <div class="faq-list">
              {items}
            </div>
          </div>
        </section>
        """)


def _breezy_supporting_schemas(crumbs, faqs):
    return _json.dumps([
        breadcrumb_schema(crumbs),
        {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [
                {
                    "@type": "Question",
                    "name": _strip_tags(q),
                    "acceptedAnswer": {"@type": "Answer", "text": _strip_tags(a)},
                }
                for q, a in faqs
            ],
        },
    ])


def page_breezy_financing():
    faqs = [
        ("How long does the application take?",
         "Online, about <b>five minutes</b>. We submit to Lendmark Financial or Dealer Direct (or both) and most applicants get a soft decision the same business day. Hand us a driver's license, proof of income, and your contact info and we handle the rest."),
        ("Will applying hurt my credit?",
         "Lendmark and Dealer Direct both run <b>soft pulls</b> for the initial pre-qualification, which doesn't affect your credit score. A hard pull only happens once you decide to move forward with a specific offer."),
        ("What credit score do I need?",
         "We've placed loans across a wide range of credit profiles — there's no single cutoff. Lendmark in particular works with customers who have less-than-perfect credit. We'll always shop the application across both lenders and pick the better offer for you."),
        ("How much down payment do I need?",
         "It depends on the lender and the cart, but <b>10–20%</b> is typical. Cash, trade-in, or a combination — all work. We'll quote the monthly with and without a down payment so you can decide."),
        ("What's the term length?",
         "Lendmark and Dealer Direct both offer terms from <b>24 to 84 months</b>. The longer the term, the lower the monthly — but the more interest paid over the life of the loan. We help you find the sweet spot."),
        ("Can I pay it off early?",
         "Yes. Both lenders allow <b>early payoff with no prepayment penalty</b>. Some customers refinance after 12-18 months once the cart is broken in and they know they're keeping it."),
    ]
    sd = _breezy_supporting_schemas(
        [("Home", "/"), ("Breezy EV", "/breezy-ev/"), ("Financing", "/breezy-ev/financing/")],
        faqs,
    )
    return (
        head(
            "Golf Cart Financing — Lendmark Financial & Dealer Direct",
            "Finance your Breezy EV at Polk County Golf Carts. We work with Lendmark Financial and Dealer Direct — soft credit pulls, same-day decisions, terms 24-84 months.",
            "/breezy-ev/financing/",
            og_slug="carts",

            structured_data=sd,
        )
        + header("/breezy-ev/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container hero-split">
            <div>
              <span class="eyebrow">Pay over time</span>
              <h1>Golf cart financing, made simple.</h1>
              <p class="lede">Two lenders, soft credit pulls, same-day decisions, and a shop that walks you through the application instead of pointing you at a form. {PRICE_TEXT}</p>
              <div class="hero-ctas">
                <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
                <a class="btn btn-outline" href="/breezy-ev/">See the lineup →</a>
              </div>
            </div>
            <img src="/assets/photos/breezy-ev/breeze-6l.jpg" alt="Breezy EV cart" width="800" height="600" fetchpriority="high">
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">Our partners</span>
              <h2>Two lenders. We shop both.</h2>
              <p class="lede-text">We don't make money on financing — we work with two lenders because their programs fit different customers, and we want to put you with the one that gives you the best terms.</p>
            </div>
            <div class="cards">
              <div class="card">
                <span class="eyebrow">Lender 1</span>
                <h3>Lendmark Financial</h3>
                <p>National lender, golf-cart-specific program, works across the credit spectrum. Often the better fit for customers with less-than-perfect credit, or for buyers who want a longer term to lower the monthly.</p>
                <ul class="checks">
                  <li>Soft pull pre-qualification</li>
                  <li>Same-day decision in most cases</li>
                  <li>Terms 24–84 months</li>
                  <li>No prepayment penalty</li>
                </ul>
              </div>
              <div class="card alt">
                <span class="eyebrow">Lender 2</span>
                <h3>Dealer Direct</h3>
                <p>Manufacturer-backed program with competitive rates on new Breezy EV carts. Often the better fit for customers with stronger credit who want the lowest APR, especially on the new Breeze 4, 4L, 6L, and Terrain 6.</p>
                <ul class="checks">
                  <li>Soft pull pre-qualification</li>
                  <li>Manufacturer-backed rates on new carts</li>
                  <li>Terms 24–72 months</li>
                  <li>No prepayment penalty</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">How it works</span>
              <h2>Three steps, one afternoon.</h2>
            </div>
            <div class="cards">
              <div class="card">
                <div class="icon">1</div>
                <h3>Bring three things</h3>
                <p>A driver's license, proof of income (a pay stub or two months of bank statements), and your contact info. We'll handle the rest of the paperwork.</p>
              </div>
              <div class="card alt">
                <div class="icon">2</div>
                <h3>Pick the cart</h3>
                <p>We'll match the cart to your budget rather than the other way around. Test-drive any of the four Breezy EV models in the showroom, walk the color options, decide on options like the street-legal kit.</p>
              </div>
              <div class="card">
                <div class="icon">3</div>
                <h3>Take it home</h3>
                <p>Most approvals come back the same business day. We deliver free within 25 miles of Livingston, $75 flat to anywhere inside our 75-mile extended area.</p>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div class="container split">
            <div>
              <span class="eyebrow">Estimating your monthly</span>
              <h2>Rates vary. The math doesn't.</h2>
              <p>We don't post specific monthly numbers because rates change with the market and depend on your credit profile. But the rough math: a $12,500 cart financed over 60 months at typical golf-cart rates lands in the <b>$230–$290/month</b> range for most customers. We'll quote your exact number after the soft pull.</p>
              <ul class="checks">
                <li>$0 down or 10-20% down — both options on the table</li>
                <li>24-, 36-, 48-, 60-, 72-, 84-month terms available</li>
                <li>Pay extra each month or refinance later — no penalty</li>
                <li>Bundle the street-legal kit, sound system, or lift into the loan if you want</li>
              </ul>
              <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Talk to Us today</a>
            </div>
            <div class="price-box">
              <span class="eyebrow">Apply by phone</span>
              <h3 class="mt-0" style="color:var(--ink)">{BIZ['phone_primary']}</h3>
              <p class="muted">We'll walk you through the application, submit to both lenders, and get back to you with the offers the same day.</p>
              <a class="btn btn-teal" href="tel:{BIZ['phone_primary'].replace('-','')}">Get pre-qualified</a>
            </div>
          </div>
        </section>
        """)
        + _breezy_faq_section(f"Financing questions.", faqs)
        + dedent(f"""\
        <section>
          <div class="container center">
            <h2>Ready to pick a cart?</h2>
            <p class="lede-text">Test-drive any of the four Breezy EV models, walk through the colors, and we'll quote the monthly while you're here.</p>
            <a class="btn btn-coral" href="/breezy-ev/">See the lineup →</a>
            &nbsp;
            <a class="btn btn-ghost" href="/breezy-ev/compare/">Compare side-by-side →</a>
          </div>
        </section>
        """)
        + footer()
    )


def page_breezy_street_legal():
    faqs = [
        ("Are golf carts street legal in Texas?",
         "Yes — with the right equipment. Under Texas Transportation Code §551.301-551.350, a golf cart qualifies as a <b>Low Speed Vehicle (LSV)</b> when it has the required safety equipment installed. LSVs can be driven on public roads with posted speed limits of <b>35 mph or less</b>."),
        ("What's included in the street-legal kit?",
         "<b>Headlights, turn signals, brake lights, side mirrors, a horn, a windshield, seat belts</b>, and a license-plate mount. The kit is installed at our shop and inspected as part of the LSV registration process. We handle the install and the paperwork."),
        ("Where can I legally drive an LSV in Texas?",
         "On any street with a <b>posted speed limit of 35 mph or less</b>. That includes neighborhood streets, most residential roads, and the side streets in most East Texas towns. You can also <b>cross</b> a higher-speed road (e.g. cross US-59 at an intersection) but can't drive along one."),
        ("Do I need insurance and a license?",
         "Yes to both. Texas requires <b>liability insurance</b> on LSVs and a <b>valid driver's license</b> to operate one. Insurance is typically <b>$10-20 / month</b> through any standard auto insurer — much cheaper than a car policy. The driver's license requirement is the same as a passenger car: 16+, class C, no special endorsement needed."),
        ("Do I need to register the cart?",
         "Yes. After we install the kit, you'll register the LSV at the Polk County tax office (or the county where you live). Registration is <b>~$50/year</b>. We provide the title and paperwork you need to walk into the office and walk out registered."),
        ("Can kids drive a street-legal cart?",
         "Only with a valid driver's license — same as a car. Kids under 16 can ride as passengers but can't be the driver on public roads. Off-road on private property, no license required."),
    ]
    sd = _breezy_supporting_schemas(
        [("Home", "/"), ("Breezy EV", "/breezy-ev/"), ("Street legal", "/breezy-ev/street-legal/")],
        faqs,
    )
    return (
        head(
            "Texas Street-Legal Golf Carts — LSV Kit & Registration",
            "Make your Breezy EV street legal in Texas. PCGC installs the LSV kit (lights, signals, mirrors, seat belts) and handles the registration paperwork. Drive on any road posted 35 mph or less.",
            "/breezy-ev/street-legal/",
            og_slug="carts",

            structured_data=sd,
        )
        + header("/breezy-ev/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container hero-split">
            <div>
              <span class="eyebrow">Texas LSV</span>
              <h1>Street-legal golf carts in Texas.</h1>
              <p class="lede">Texas law calls them Low Speed Vehicles. We install the kit, you drive it on any street posted 35 mph or less. Lights, signals, mirrors, seat belts, a horn, and the paperwork — done in one shop visit.</p>
              <div class="hero-ctas">
                <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
                <a class="btn btn-outline" href="/breezy-ev/">See the lineup →</a>
              </div>
            </div>
            <img src="/assets/photos/breezy-ev/breeze-6l.jpg" alt="Street-legal Breezy EV golf cart" width="800" height="600" fetchpriority="high">
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">What you get</span>
              <h2>The Texas LSV kit, item by item.</h2>
              <p class="lede-text">Every part of the kit exists because Texas Transportation Code §551.302 requires it. We don't bolt on parts you don't need — we install exactly what the LSV statute calls for, no more, no less.</p>
            </div>
            <div class="cards">
              <div class="card">
                <div class="icon">💡</div>
                <h3>Headlights &amp; tail lights</h3>
                <p>DOT-compliant LED headlamps and brake lights. Wired into the existing 12V system, no battery drain to speak of.</p>
              </div>
              <div class="card alt">
                <div class="icon">↩️</div>
                <h3>Turn signals &amp; brake lights</h3>
                <p>Front and rear turn signals with audible click, plus hazard flashers. Required by Texas LSV statute.</p>
              </div>
              <div class="card">
                <div class="icon">🪞</div>
                <h3>Side &amp; rearview mirrors</h3>
                <p>One rearview, two side mirrors. The same kind of glass that's on every passenger car.</p>
              </div>
              <div class="card alt">
                <div class="icon">📯</div>
                <h3>Horn</h3>
                <p>An audible horn — required, and useful when the neighbor's dog forgets you cross the street every morning.</p>
              </div>
              <div class="card">
                <div class="icon">🪟</div>
                <h3>Windshield</h3>
                <p>DOT-approved acrylic with wiper provision. Stock on most Breezy EVs; we upgrade if needed.</p>
              </div>
              <div class="card alt">
                <div class="icon">🔒</div>
                <h3>Seat belts</h3>
                <p>3-point belts on every forward-facing seat. The 6L and Terrain 6 get six belts; the 4 and 4L get four.</p>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div class="container split">
            <div>
              <span class="eyebrow">Where it drives</span>
              <h2>Any road posted 35 mph or less.</h2>
              <p>That's most of East Texas. Neighborhood streets in Livingston, Onalaska, Coldspring, Huntsville, Lufkin, Woodville — all green light. You can <b>cross</b> a higher-speed road at an intersection (e.g., crossing US-59 at a light), you just can't drive along one.</p>
              <p>Off-road and on private property, the speed limit and licensing rules don't apply at all. That's where the Terrain 6 really earns its name.</p>
              <ul class="checks">
                <li><b>Residential streets</b> — 25-30 mph speed limits, all legal</li>
                <li><b>Most downtown streets</b> in small East Texas towns</li>
                <li><b>Lake-house neighborhoods</b> on Lake Livingston, Sam Rayburn, B.A. Steinhagen</li>
                <li><b>Cross-traffic</b> on higher-speed roads at intersections — legal</li>
                <li><b>Not legal:</b> US-59, I-45, SH-19 — anywhere posted 40 mph or higher</li>
              </ul>
            </div>
            <div class="price-box">
              <span class="eyebrow">Add-on</span>
              <h3 class="mt-0" style="color:var(--ink)">Street-legal kit</h3>
              <p class="muted">Bundled with the cart, or added to an existing cart. We install, we hand you the paperwork, you drive home registered.</p>
              <a class="btn btn-teal" href="tel:{BIZ['phone_primary'].replace('-','')}">Quote the kit</a>
            </div>
          </div>
        </section>

        <section>
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">After the install</span>
              <h2>Registration, license, insurance.</h2>
              <p class="lede-text">Three things to handle after we hand you the kit and the title. We walk you through all three.</p>
            </div>
            <div class="cards">
              <div class="card">
                <h3>Title &amp; registration</h3>
                <p>Walk into the Polk County tax office with the title we provide. Registration is <b>~$50/year</b>. They issue a license plate; we mount it.</p>
              </div>
              <div class="card alt">
                <h3>Driver's license</h3>
                <p>Same Class C license you use for a passenger car. No special LSV endorsement needed. Passengers don't need a license.</p>
              </div>
              <div class="card">
                <h3>Liability insurance</h3>
                <p>Any standard auto insurer adds an LSV to your policy for <b>$10-20/month</b>. Bring proof to the tax office.</p>
              </div>
            </div>
          </div>
        </section>
        """)
        + _breezy_faq_section("Texas LSV questions.", faqs)
        + dedent(f"""\
        <section>
          <div class="container center">
            <h2>Ready to make it street legal?</h2>
            <p class="lede-text">Call us, schedule the install, drive home with the paperwork.</p>
            <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 {BIZ['phone_primary']}</a>
            &nbsp;
            <a class="btn btn-ghost" href="/breezy-ev/">Pick a cart first →</a>
          </div>
        </section>
        """)
        + footer()
    )


def page_breezy_lithium_vs_lead_acid():
    faqs = [
        ("Which is cheaper, lithium or lead-acid?",
         "Upfront, <b>lead-acid is cheaper</b> — a full lead-acid pack costs roughly $1,200-$1,800, vs. $3,500-$5,500 for an equivalent Lithium pack. Over the cart's lifetime, <b>Lithium wins on total cost of ownership</b> because you don't replace it every 3-5 years like you do with lead-acid."),
        ("How much longer does a Lithium battery last?",
         "Lead-acid packs typically last <b>3-5 years</b> with proper maintenance (watering, equalization charges). Lithium packs last <b>8-12 years</b> with virtually no maintenance. Over the same 10-year window, you'd replace lead-acid 2-3 times — that math is what makes Lithium cheaper long-term."),
        ("Will Lithium really give me more range?",
         "Yes — <b>30-50% more</b> in real-world conditions. A new Breezy EV with the standard 48V/125Ah Lithium pack delivers 45-55 miles per charge. The same cart with comparable lead-acid would do 25-35 miles before voltage sag becomes noticeable."),
        ("Is the Lithium battery safer?",
         "The cells we install — including the <b>Bolt Energy</b> and <b>White Lightening</b> lines — are LiFePO4 (Lithium Iron Phosphate). LiFePO4 is the safest Lithium chemistry on the market, with a much higher thermal-runaway threshold than the Lithium-ion in laptops or EVs. They're more thermally stable than a lead-acid pack actually."),
        ("Can I upgrade my existing cart to Lithium?",
         "Yes. We pull the lead-acid pack, install the Lithium pack and a compatible charger, and reprogram the controller for the Lithium voltage curve. <b>Typical conversion: $3,500-$5,500</b> depending on the pack size. Most customers see the range boost on the first drive."),
        ("What about charging — does Lithium charge faster?",
         "Yes. A flat-to-full charge on Lithium takes <b>4-6 hours</b> vs. <b>8-10 hours</b> for lead-acid. Lithium also accepts partial charges without damage — you can top up for 30 minutes between trips without shortening the battery life, which lead-acid hates."),
    ]
    sd = _breezy_supporting_schemas(
        [("Home", "/"), ("Breezy EV", "/breezy-ev/"), ("Lithium vs Lead-acid", "/breezy-ev/lithium-vs-lead-acid/")],
        faqs,
    )
    return (
        head(
            "Lithium vs Lead-Acid Golf Cart Batteries — Which Saves Money?",
            "Lithium vs lead-acid golf cart batteries: real numbers on cost, range, lifespan, and maintenance. Polk County Golf Carts breaks down the math, sells both, and tells you which to pick.",
            "/breezy-ev/lithium-vs-lead-acid/",
            og_slug="carts",

            structured_data=sd,
        )
        + header("/breezy-ev/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container">
            <span class="eyebrow">Battery tech</span>
            <h1>Lithium vs lead-acid: which actually saves you money?</h1>
            <p class="lede">Lithium costs more upfront. Lead-acid costs less. <b>Lithium wins on total cost of ownership</b> — here's the math, the real-world range, and how to decide for your cart.</p>
            <div class="hero-ctas">
              <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
              <a class="btn btn-outline" href="/breezy-ev/">See the lineup →</a>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">At a glance</span>
              <h2>The headline numbers.</h2>
            </div>
            <div class="compare-wrap">
              <table class="compare-table">
                <thead><tr><th></th><th>Lead-acid</th><th>Lithium (LiFePO4)</th></tr></thead>
                <tbody>
                  <tr><th>Upfront cost (48V pack)</th><td>$1,200-$1,800</td><td>$3,500-$5,500</td></tr>
                  <tr><th>Lifespan</th><td>3-5 years</td><td>8-12 years</td></tr>
                  <tr><th>Real-world range per charge</th><td>25-35 miles</td><td>45-55 miles</td></tr>
                  <tr><th>Weight</th><td>~300 lbs</td><td>~150 lbs</td></tr>
                  <tr><th>Charge time</th><td>8-10 hours</td><td>4-6 hours</td></tr>
                  <tr><th>Maintenance</th><td>Water levels, equalize, terminals</td><td>None</td></tr>
                  <tr><th>Partial charges OK?</th><td>No (damages battery)</td><td>Yes</td></tr>
                  <tr><th>10-year total cost of ownership</th><td>$3,600-$5,400 (2-3 replacements)</td><td>$3,500-$5,500 (one pack)</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section>
          <div class="container split">
            <div>
              <span class="eyebrow">The case for Lithium</span>
              <h2>Why most new carts ship Lithium now.</h2>
              <p>Five years ago Lithium was a premium upgrade. Today every Breezy EV ships Lithium standard — because the math finally caught up. Buy it once, get 8-12 years out of it, get 30-50% more range every charge, and never check water levels again.</p>
              <p>The Lithium packs we install — <b>Bolt Energy</b> and <b>White Lightening</b>'s new line — are LiFePO4 (Lithium Iron Phosphate), the safest and most stable Lithium chemistry. Same family as solar storage banks and grid backups, not the energy-dense Lithium-ion you'd find in a laptop.</p>
              <ul class="checks">
                <li>30-50% more range per charge</li>
                <li>Charges in half the time</li>
                <li>Half the weight = better cart handling</li>
                <li>No watering, no equalization, no maintenance</li>
                <li>Partial charges welcome — top up anytime</li>
                <li>8-12 year lifespan vs. 3-5 for lead-acid</li>
              </ul>
            </div>
            <div class="price-box">
              <span class="eyebrow">Lithium upgrade</span>
              <h3 class="mt-0" style="color:var(--ink)">Bolt Energy &amp; White Lightening</h3>
              <p class="muted">We install both lines. White Lightening's newest pack is particularly strong for the Breeze 6L and Terrain 6 — pairs with their motor-upgrade kit.</p>
              <a class="btn btn-teal" href="tel:{BIZ['phone_primary'].replace('-','')}">Quote a Lithium upgrade</a>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container split reverse">
            <div>
              <span class="eyebrow">The case for lead-acid</span>
              <h2>When lead-acid still makes sense.</h2>
              <p>Lead-acid isn't dead — it's just not the default anymore. There are real cases where lead-acid is the right call:</p>
              <ul class="checks">
                <li><b>Short-term ownership:</b> if you're flipping the cart in 1-2 years, you won't see the Lithium ROI.</li>
                <li><b>Light use:</b> if the cart sits in the garage and only comes out for the occasional weekend, the longer Lithium lifespan doesn't help you as much.</li>
                <li><b>Budget-first first cart:</b> if the cart needs to fit a tight upfront number, lead-acid gets you on the road for less.</li>
              </ul>
              <p>If any of those is you, lead-acid is fine — we install it, service it, and you'll get 3-5 good years before you decide between another lead-acid pack and a Lithium upgrade.</p>
            </div>
            <div class="photo-block">
              <img src="/assets/photos/breezy-ev/breeze-4.jpg" alt="Breezy EV Breeze 4 golf cart" width="800" height="600" loading="lazy">
            </div>
          </div>
        </section>
        """)
        + _breezy_faq_section("Battery questions.", faqs)
        + dedent(f"""\
        <section>
          <div class="container center">
            <h2>Not sure which to pick?</h2>
            <p class="lede-text">Tell us how you use the cart and we'll tell you which pack we'd actually buy if it were ours. Honest answers, no upsell.</p>
            <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
            &nbsp;
            <a class="btn btn-ghost" href="/breezy-ev/">See the lineup →</a>
          </div>
        </section>
        """)
        + footer()
    )


# ---------------- /guides/ pillar content (hidden) ---------------- #
#
# Phase-3 pillar guides — long-form buyer's-guide and local-flavor
# content that ranks for high-traffic informational queries and feeds
# AI-engine answers (ChatGPT, Perplexity, Google AI Overviews). Each
# guide is structured for AEO: leading sentence answers the headline
# query, FAQPage schema attached, internal links to PDPs at the end.

GUIDES = {
    "cost-of-owning-a-golf-cart": {
        "title": "What does it actually cost to own a golf cart?",
        "kicker": "Buyer's guide",
        "read_time": "9 min read",
        "lede": "Sticker price is one number. Total cost of ownership is another. Here's the real math — purchase, financing, insurance, batteries, maintenance, depreciation — from a Texas dealer who's been running the numbers since 2020.",
        "summary": "A 10-year, total-cost-of-ownership breakdown for a typical Breezy EV golf cart in East Texas: purchase price, financing, insurance, batteries, maintenance, electricity, depreciation, with real numbers from PCGC's books.",
        "sections": [
            ("The number most people miss", """
                <p>When someone asks "how much does a golf cart cost?", they usually mean the sticker price. That's a $12,500-$18,000 number for a new Breezy EV at our shop. But the right question is "how much does owning a golf cart cost <em>per year</em>?" Once you back out the resale value at the end and add in financing, insurance, batteries, electricity, and maintenance, the real number lands somewhere around <b>$1,600-$2,400 per year</b> for a new cart — less than most people spend on a streaming service stack.</p>
                <p>The math below is for a 4-seater lifted cart (Breeze 4L) bought new at our shop, financed over 60 months, and kept for 10 years. We'll break down what changes if you go used, if you skip financing, or if you stretch the ownership horizon out further.</p>
            """),
            ("Purchase price (year 1)", """
                <p>New Breezy EV carts at PCGC start at <b>$12,500</b> and run up to about $18,000 once you load options. Used and refurbished carts run $4,000-$10,000 depending on age, hours, and condition. We'll assume a $14,500 mid-trim new cart for this walkthrough — call it the median PCGC sale.</p>
                <p>Add Texas sales tax (~8.25% statewide-plus-local) and you're at roughly <b>$15,700 out the door</b>. If you finance through Lendmark Financial or Dealer Direct, you'll typically put 10-20% down and roll the rest. Standard golf-cart loans run 24-84 months at rates that depend on credit and the lender — for this exercise, assume $1,500 down and 60 months at 8.9% APR.</p>
            """),
            ("Financing cost over 5 years", """
                <p>$14,200 financed at 8.9% over 60 months = roughly <b>$294/month</b>, total paid <b>$17,640</b>. Subtract the principal ($14,200) and the cost of financing is about <b>$3,440 over five years</b>, or ~$690/year.</p>
                <p>That's a real number to plan around. It's not unique to golf carts — it's just what borrowing $14k looks like in 2026. If you pay cash, this line item is zero and the rest of the math gets friendlier. About 70% of our customers finance, so we lead with the financing case here.</p>
            """),
            ("Insurance: cheaper than people expect", """
                <p>If you want to drive the cart on Texas streets, you'll register it as a Low Speed Vehicle (LSV) and carry liability insurance. Most major insurers (State Farm, Allstate, Progressive, etc.) add an LSV to an existing auto policy for <b>$10-$25/month</b> — far less than a car policy because the speeds and damages are smaller.</p>
                <p>Annual cost: <b>$120-$300/year</b>. Many of our customers don't get insurance at all because they only use the cart on private property — in that case this line item is zero.</p>
            """),
            ("Battery replacement (the big one)", """
                <p>The battery is the single most expensive maintenance item, and it depends entirely on which chemistry you bought. Lead-acid packs last 3-5 years and cost $1,200-$1,800 to replace. Lithium packs last 8-12 years and cost $3,500-$5,500.</p>
                <p>Over 10 years of ownership, a lead-acid cart needs <b>2-3 replacements</b> ($2,400-$5,400 total). A Lithium cart needs <b>zero or one</b> replacements ($0-$5,500). The math basically breaks even — but Lithium gives you 30-50% more range every single ride and never needs water topped off or terminals cleaned. Every new Breezy EV ships with Lithium standard, so this isn't a decision most new buyers make.</p>
                <p>Annual cost (amortized over 10 years): <b>$350-$550/year</b> either way.</p>
            """),
            ("Maintenance and tires", """
                <p>Golf carts are mechanically simple compared to cars. There's no engine oil, no transmission fluid, no air filters, no spark plugs (on electric carts). What you do spend on:</p>
                <ul>
                    <li><b>20-Point Inspection / annual service</b> — $165-$300 at our shop. Recommended yearly. Covers brakes, suspension grease, battery health, tire rotation, accessory check.</li>
                    <li><b>Tires</b> — $60-$120 per tire, replaced every 3-5 years depending on use. Off-road tires on lifted carts wear faster.</li>
                    <li><b>Brake pads</b> — $80-$120 per axle, every 5-7 years for most drivers.</li>
                    <li><b>Random fix-it items</b> — fuses, bulbs, wiring, charger plugs. Budget $100/year.</li>
                </ul>
                <p>Total annual maintenance for a typical owner: <b>$300-$500/year</b>.</p>
            """),
            ("Electricity (it's basically free)", """
                <p>This is the line item that surprises new buyers in the best way. A full charge on a 48V/125Ah Lithium pack uses about <b>6 kWh</b> of electricity. At Texas's average residential rate of $0.14/kWh, that's <b>$0.84 per charge</b>. If you charge twice a week year-round, that's about <b>$90/year</b> in electricity — what you'd spend on a single tank of gas for a car.</p>
            """),
            ("Depreciation and resale", """
                <p>Here's the kindest line of the math: golf carts hold their value remarkably well. A well-maintained Breezy EV that was $14,500 new will typically resell for <b>$8,000-$10,500</b> after 10 years — depreciation of 30-45% over a decade. Compare that to a car, which loses 60% of its value in five years.</p>
                <p>Amortized over 10 years, that's roughly <b>$500-$700/year</b> in depreciation cost.</p>
            """),
            ("Adding it all up", """
                <p>Year-over-year ownership cost for our example $14,500 Breezy EV:</p>
                <ul>
                    <li>Financing (years 1-5 only): ~$690/year</li>
                    <li>Insurance: $120-$300/year</li>
                    <li>Battery (amortized): $350-$550/year</li>
                    <li>Maintenance: $300-$500/year</li>
                    <li>Electricity: $90/year</li>
                    <li>Depreciation: $500-$700/year</li>
                </ul>
                <p><b>Total: ~$2,050-$2,830/year while financing, ~$1,360-$2,140/year after the loan is paid off.</b></p>
                <p>That's lower than most boat-ownership numbers, lower than RV ownership, and competitive with a used car's total cost if you drove the same miles. And unlike all three of those, the cart is going to be the thing your kids ask to drive first.</p>
            """),
            ("Three ways to lower this number", """
                <p><b>1. Buy used or refurbished.</b> A 3-5 year-old refurbished cart at $7,500 cuts the financing and depreciation lines roughly in half. Total annual cost drops to $1,100-$1,600/year.</p>
                <p><b>2. Pay cash.</b> Skip the financing line entirely ($690/year). Reduces total to $1,360-$2,140/year while the cart is being amortized.</p>
                <p><b>3. Skip insurance.</b> If you only drive on private property, you don't need an LSV policy. Saves $120-$300/year. (We don't recommend skipping it if you ever take the cart on public roads.)</p>
            """),
        ],
        "faqs": [
            ("How much does a new golf cart cost in Texas?",
             "New Breezy EV golf carts at Polk County Golf Carts start at <b>$12,500</b> and run up to about <b>$18,000</b> depending on options (street-legal kit, lift, color, sound system, etc.). Used and refurbished carts run $4,000-$10,000."),
            ("Are golf carts cheaper to own than cars?",
             "Yes, by a wide margin. A new golf cart's total cost of ownership lands around <b>$1,600-$2,400 per year</b> over a 10-year horizon, vs. $7,000-$10,000+ for an equivalent-age compact car. The biggest savings are fuel ($90/year of electricity vs. $1,500+ of gas) and insurance ($10-$25/month vs. $80-$150/month)."),
            ("How long does a golf cart last?",
             "With basic maintenance, a quality cart from a reputable dealer lasts <b>15-20 years</b>. The battery is the consumable — lithium packs go 8-12 years before replacement, lead-acid 3-5. Everything else (frame, motor, controller, suspension) outlasts the battery several times over."),
            ("How much does insurance cost on a golf cart?",
             "If you register your cart as a Texas Low Speed Vehicle (LSV) and add it to an existing auto policy, expect <b>$10-$25 per month</b>. If you only use the cart on private property, you don't need insurance at all."),
            ("What's the biggest hidden cost?",
             "Battery replacement on lead-acid carts. A new lead-acid pack runs $1,200-$1,800 and needs replacement every 3-5 years — so over a 10-year ownership window you'll likely spend more on batteries than on the original cart's purchase price. This is the math that makes lithium worth the upfront premium for long-term owners."),
        ],
        "related": [
            ("Browse the Breezy EV lineup", "/breezy-ev/"),
            ("Financing options", "/breezy-ev/financing/"),
            ("Lithium vs lead-acid", "/breezy-ev/lithium-vs-lead-acid/"),
        ],
    },
    "4-seater-vs-6-seater": {
        "title": "4-seater vs 6-seater golf cart: how to pick the right one",
        "kicker": "Buyer's guide",
        "read_time": "6 min read",
        "lede": "Two passengers and a cooler, or six kids and a dog? Here's how to choose between a 4-seater and a 6-seater golf cart without buyer's remorse.",
        "summary": "Side-by-side comparison of 4-seater vs 6-seater golf carts: when each makes sense, what changes in handling and storage, what you actually pay extra for, and the real-world break-points for choosing one over the other.",
        "sections": [
            ("The honest answer", """
                <p>If you're buying for two adults and you occasionally have one or two passengers, a <b>4-seater is the right cart</b>. If you regularly carry more than four — or you have a multi-generation family that travels together — you want the <b>6-seater</b>. The break-point isn't usually about cost, it's about how often you'll wish you had the extra row.</p>
                <p>Below: when the 4 makes sense, when the 6 wins, and the three things that change when you go bigger.</p>
            """),
            ("When the 4-seater wins", """
                <p>The Breeze 4 and Breeze 4L are the right cart for most first-time buyers. Here's when:</p>
                <ul>
                    <li><b>Your household is 1-3 people.</b> You can fit four when guests come, but you don't routinely need to.</li>
                    <li><b>You park in a single-bay garage.</b> The 4-seater is 117-119" long. A 6-seater is 146-149" — that's <b>2.5 feet longer</b> and matters in tight garages.</li>
                    <li><b>You drive shorter trips.</b> Around the neighborhood, to the mailbox, to the lake dock. The 4 is more nimble for tight turns and back-in parking.</li>
                    <li><b>Price matters.</b> 4-seaters land near the $12,500 floor; 6-seaters typically run $1,500-$2,500 more.</li>
                </ul>
            """),
            ("When the 6-seater wins", """
                <p>The Breeze 6L and Terrain 6 are bigger, heavier, and more capable. Here's when the trade-off pays:</p>
                <ul>
                    <li><b>You have kids.</b> Two adults plus two kids plus two friends plus a cooler is a Saturday-morning lake run. The 6-seater carries all six without anyone sitting in a lap.</li>
                    <li><b>You host.</b> Lake house guests, tailgate buddies, grandkids visiting — if you regularly find yourself needing one more seat than you have, the 6 is the answer.</li>
                    <li><b>You haul.</b> The rear-facing flip seat folds down to a flat deck — perfect for coolers, groceries, beach gear, deer feeders, the dog crate. You can't do that with a 4-seater.</li>
                    <li><b>You run a rental or fleet.</b> Six seats × $X per day always beats four seats × $X per day. Every rental fleet we sell is heavy on 6-seaters.</li>
                </ul>
            """),
            ("Three things that change when you go bigger", """
                <p><b>1. The wheelbase.</b> A 6-seater has a wheelbase of 105"-106" vs. 81"-83" on a 4-seater. That's <b>~24" of extra wheelbase</b>. More stable at speed, less nimble in tight turns. You feel it the most backing up.</p>
                <p><b>2. The weight.</b> 6-seaters are about 200 lbs heavier (1,389 lbs vs 1,213 lbs on the lifted versions). That means slightly less range per charge, slightly slower acceleration, and slightly more energy needed to charge from empty. The difference is small but measurable: ~5-8 miles less range in real-world use.</p>
                <p><b>3. The footprint.</b> The 6-seater is roughly 30" longer overall. If your garage is short or your storage shed is sized for a 4-seater, measure twice before you buy.</p>
            """),
            ("Resale and rental value", """
                <p>6-seaters hold their value slightly better than 4-seaters because the market for them is broader — they appeal to families AND rental operators AND lake-house owners. If you think you might resell within 5 years, the 6-seater has the edge.</p>
                <p>If you rent the cart out (e.g. you have a vacation rental or Airbnb), the 6-seater earns more per booking and gets booked more often. Multi-cart group bookings at our rental fleet skew almost 80% toward 6-seaters.</p>
            """),
            ("Lifted vs. street: a different question", """
                <p>4 vs. 6 is one decision. Lifted (4L, 6L, Terrain 6) vs. street (4) is a separate one. Most customers who want a 6 also want the lift — there's no street-stance 6-seater in the Breezy EV lineup. If you want a non-lifted, non-aggressive cart, the Breeze 4 is the only option.</p>
            """),
        ],
        "faqs": [
            ("Is a 6-seater really worth the extra money?",
             "If you regularly carry more than 4 people — yes, every time. The $1,500-$2,500 premium pays for itself in convenience the first weekend you'd have otherwise had to take two trips. If you rarely carry more than 4, save the money and get a 4-seater."),
            ("Can a 6-seater fit in a standard garage?",
             "A typical 6-seater is about 149\" (12.4 ft) long. Most single-bay garages are 18-20 ft deep, so it fits. Two-bay garages handle it easily. Measure the depth (not just the door width) before you commit — and account for the windshield, which on some carts extends past the bumper."),
            ("How much faster is a 4-seater?",
             "Top speed is identical — both are programmable up to the Texas LSV limit of 25 mph. Acceleration on the 4 is slightly quicker because it's about 200 lbs lighter, but the difference is small. If you're not racing, you won't notice."),
            ("Can I put 6 adults in a 6-seater cart?",
             "Yes — Breezy EV rates the 6-seater for six adults. Range and acceleration decrease a bit at full load, and any cart feels different with six full-grown passengers vs. four, but it's designed for it."),
            ("Do 6-seaters need a stronger motor?",
             "No — the standard 5 kW AC motor and 48V/125Ah lithium pack are the same across the entire Breezy EV lineup. The 6-seater just gives up about 5-8 miles of range due to the extra weight."),
        ],
        "related": [
            ("Breeze 4 (4-seater, street)", "/breezy-ev/breeze-4/"),
            ("Breeze 6L (6-seater, lifted)", "/breezy-ev/breeze-6l/"),
            ("Compare every model", "/breezy-ev/compare/"),
        ],
    },
    "buying-a-used-golf-cart": {
        "title": "Buying a used golf cart: 8 things to check first",
        "kicker": "Buyer's guide",
        "read_time": "7 min read",
        "lede": "A good used cart is a great value. A bad used cart is a $5,000 lawn ornament with a dead battery. Here's how to tell the difference before you pay.",
        "summary": "A pre-purchase checklist for used golf carts: 8 specific things to inspect or ask about before handing over money. Written from the perspective of a Texas dealer who refurbishes and resells dozens of used carts per year.",
        "sections": [
            ("Why used can be a great deal — or a disaster", """
                <p>Golf carts depreciate slowly, which is bad if you're selling but great if you're buying used. A 3-5 year-old cart in good shape can save you 30-50% off the new-cart sticker — that's a $4,000-$8,000 swing.</p>
                <p>But there's a catch: the single most expensive maintenance item (the battery) wears with age. A used cart with a dying battery is a cart with a hidden $1,500-$5,500 invoice attached. Most other components last way longer than the battery, so battery condition is the question that decides whether a used cart is a deal or a money pit.</p>
                <p>Here's the 8-point inspection we run on every cart we take in as a trade-in at PCGC. Run through these before you write a check.</p>
            """),
            ("1. Ask for the battery's age", """
                <p>For lead-acid: when were the batteries last replaced? If the seller doesn't know, that's a yellow flag. If the batteries are 4+ years old, plan for replacement soon ($1,200-$1,800).</p>
                <p>For lithium: how old is the pack and what's the cycle count if known? Lithium is more forgiving — a 5-year-old pack might still have 80% of original capacity. But if the cart is more than 8 years old and still on the original lithium pack, factor in replacement.</p>
            """),
            ("2. Run a load test", """
                <p>The seller may say "the batteries are great." The cart may even start and roll fine in the driveway. The real test: drive it for <b>at least 15 minutes</b>, hills if available. A weak pack will surge fine off the line but bog down as voltage sags under continuous load.</p>
                <p>If the seller won't let you drive it for that long, walk away.</p>
            """),
            ("3. Check for water damage", """
                <p>East Texas carts get rained on. That's fine — they're designed for it. What's not fine is water sitting in the controller compartment for years. Lift the seat, look at the controller and wiring harness. Look for green corrosion on copper connections, white powder on aluminum, or any standing water. Any of those = walk away or negotiate hard.</p>
            """),
            ("4. Inspect the frame for corrosion", """
                <p>Lake carts especially. Get on your knees and look at the underside of the frame, the leaf spring mounts, and the steering linkage. Surface rust is normal. Deep pitting, cracked welds, or any structural rust around suspension mounts means the cart's life is shorter than the seller claims.</p>
            """),
            ("5. Listen to the controller and motor", """
                <p>With the cart running, listen for clicking, whining, or hesitation in the controller. Then ride it under load. A healthy AC motor (like the one in every Breezy EV) is nearly silent. A DC motor with brush wear will whine increasingly with age — replaceable, but factor in $300-$500 of work.</p>
                <p>Hard clunks when pressing the accelerator usually mean the rear-end gears need service. Not a deal-killer, but $400-$800 of work.</p>
            """),
            ("6. Check the tires and brakes", """
                <p>Tires aren't expensive but they're a tell. Mismatched tires, dry-rot cracks, or uneven wear all suggest the cart has been ridden hard or sat unused for years. Brakes should feel firm — a spongy pedal means rebuilds are needed.</p>
            """),
            ("7. Verify the title and ownership", """
                <p>If the cart has been street-legal-registered as a Low Speed Vehicle, there should be a title. Get it. If the seller says "I never registered it," that's fine for off-road use but means you can't easily register it later — Texas requires the manufacturer's certificate of origin to title an LSV, and that's often lost on older carts.</p>
                <p>Check that the VIN on the cart matches the title (or registration). Don't skip this.</p>
            """),
            ("8. Ask why they're selling", """
                <p>Best answer: "We're upgrading to a bigger cart" or "Moving and can't take it." Worst answer: "The batteries kept needing replacement" or "I never got around to fixing the controller."</p>
                <p>Listen for what they DON'T say. If they answer evasively or change topics, the cart probably has a story you don't want to inherit.</p>
            """),
            ("The dealer-vs-private alternative", """
                <p>One last thing. Every refurbished cart we sell at PCGC has been through this exact 8-point inspection plus a full 20-point service. We replace what needs replacing, document what we touched, and stand behind the cart with a limited warranty.</p>
                <p>That refurbished cart costs a few hundred more than the same cart in someone's driveway — but you don't inherit the surprises, and you have somewhere to bring it back if something goes wrong. For most first-time buyers, that math works out.</p>
            """),
        ],
        "faqs": [
            ("How can I tell how old a used golf cart is?",
             "Look for the manufacturer's date plate (usually under the seat or on the frame near the rear axle). Most Breezy EV, Yamaha, Club Car, and EZGO carts have a build date stamped. For more precise age, look up the serial number in the manufacturer's database — your local dealer can help with this in five minutes."),
            ("How much should a used golf cart cost?",
             "A 3-5 year-old quality cart in good shape with healthy batteries runs <b>$5,000-$8,000</b> at private sale, $6,500-$10,000 from a dealer (with warranty). Carts older than 7-8 years or with sketchy battery history can be had for $3,000-$5,000 — but plan to spend another $1,500-$5,500 to get them road-worthy."),
            ("Should I buy a used golf cart from a private seller or a dealer?",
             "Dealer carts cost 10-20% more but come with an inspection, a warranty, and someone to call if it breaks. Private-sale carts can be cheaper but you inherit every problem the seller didn't mention. First-time buyers — start at a dealer. Experienced buyers who can do their own inspection can save with a private deal."),
            ("Can I get financing on a used golf cart?",
             "Yes — Lendmark Financial finances used and refurbished carts the same way they finance new ones. Terms are typically a bit shorter (24-60 months vs. 24-84 for new) because the cart has fewer years of life left."),
            ("What's the most common thing wrong with a used cart?",
             "Tired batteries, by a wide margin. About 60% of the used carts we evaluate need a battery service or replacement to be road-worthy. Second most common: corroded electrical connections from sitting outside without a charger plugged in for months."),
        ],
        "related": [
            ("Browse used carts at PCGC", "/carts/"),
            ("Service & Custom builds", "/services/"),
            ("The Breezy EV lineup", "/breezy-ev/"),
        ],
    },
    "lake-livingston-golf-cart-life": {
        "title": "Lake Livingston golf cart life: where to ride, dock, and park",
        "kicker": "Local",
        "read_time": "5 min read",
        "lede": "Lake Livingston is a 90,000-acre lake with a thousand reasons to own a golf cart. Here's the local guide to riding, parking, and not getting stuck.",
        "summary": "A local guide to using a golf cart around Lake Livingston, Texas. Best neighborhoods to cruise, lake-house tips, what to know about the south shore vs. west shore, where to charge, and how to handle the unpaved roads.",
        "sections": [
            ("Why Lake Livingston is golf-cart country", """
                <p>Lake Livingston is the second-largest lake in Texas — 90,000 acres of impoundment on the Trinity River, ringed by hundreds of subdivisions, RV parks, marinas, and lake houses. The water draws the crowds, but the <b>way you get around</b> shore-side is mostly via golf cart. Streets are short, speed limits are low, and the distance from your dock to the marina to the boat ramp is exactly the distance a 48V Lithium cart was made for.</p>
                <p>If you own (or rent) a lake house, the question isn't whether you'll want a cart — it's which cart, and where you can take it.</p>
            """),
            ("The west shore: Onalaska and Yaupon Cove", """
                <p>The west side of the lake — Onalaska, Yaupon Cove, Beacon Bay, Lakeside Estates — is the densest cart community on the lake. Most of these subdivisions are <b>cart-friendly by design</b>: 20-25 mph speed limits, paved roads, lots that funnel toward the water. You can cruise from your house to the community ramp, to the local restaurant, to the gas station, to a neighbor's, and not need a car for an entire weekend.</p>
                <p>A standard Breeze 4 or 4L works great here. The roads are smooth, distances are short, and you'll never need the extreme ground clearance of a Terrain 6 unless you're hitting unpaved access lanes.</p>
            """),
            ("The south shore: Coldspring and Point Blank", """
                <p>The south end of the lake — toward Coldspring and Point Blank — runs to bigger lots, more wooded land, and a fair amount of gravel road. This is <b>lift territory</b>. The Breeze 4L, Breeze 6L, or Terrain 6 with the 23x10-14 off-road tires handle the rougher access roads, the loose gravel marina driveways, and the occasional 200-yard run from the cabin to the lake.</p>
                <p>If your property is on the south shore, plan on a lifted cart. The street stance carts can do it, but they'll bottom out on the worst sections.</p>
            """),
            ("Charging at the lake house", """
                <p>Every Breezy EV charges on standard 120V household outlets, so your existing lake house wiring is enough. A full 0%-to-100% charge takes 4-6 hours on the standard Lithium pack, so most lake-house owners plug in overnight Friday and have a full pack by Saturday morning.</p>
                <p>One tip: install a <b>dedicated outlet in the garage or under the carport</b>, not an extension cord across the driveway. Cleaner, safer, and your charger lives in one spot.</p>
            """),
            ("Dock-to-house runs", """
                <p>The single most common use case at the lake: parking the boat trailer at the ramp, then taking the cart to and from the dock. A 6-seater carries the family, the cooler, the floats, the dog, and the boat keys. A 4-seater carries the parents and the gear.</p>
                <p>Time saved per weekend: probably an hour and a half of walking, plus all the trips back to the car for stuff you forgot.</p>
            """),
            ("Tournament weekends and the marina shuttle", """
                <p>Lake Livingston hosts dozens of fishing tournaments a year. If you're tournament-active, a cart is the difference between waking up at 4:00 AM to drive to the ramp and waking up at 5:30 AM to roll the cart over.</p>
                <p>Most marinas around the lake — including the public ramps at Pine Island Park, Wolf Creek Park, and Cedar Point — are cart-accessible, with parking near the launch lanes.</p>
            """),
            ("What we deliver to the lake", """
                <p>PCGC delivers free to anywhere within 25 miles of our Livingston shop, which covers <b>most of Lake Livingston's east and north shores</b>. For the west shore (Onalaska, Point Blank), the south shore (Coldspring area), and out toward Lake Tejas — we're still inside the 75-mile extended service area, flat $75 delivery.</p>
                <p>We've delivered to most of the major Lake Livingston subdivisions enough times to know the access roads, the gate codes, and which streets the carts get to use. Tell us your subdivision, we'll quote you door-to-dock.</p>
            """),
        ],
        "faqs": [
            ("Can I drive a golf cart on Lake Livingston roads?",
             "Yes, on any road posted 35 mph or less, with the cart registered as a Texas LSV (Low Speed Vehicle). That includes nearly every street in Onalaska, Coldspring, Point Blank, and the lake-house subdivisions. For unregistered carts, you're limited to private property — which is still 90% of where most lake-house owners drive."),
            ("Do I need a lifted cart for Lake Livingston?",
             "Depends on your shore. The west shore (Onalaska, Yaupon Cove) is mostly paved and a street-stance Breeze 4 handles fine. The south shore (Coldspring, Point Blank) has more gravel and unpaved access roads — get a lifted cart (4L, 6L, or Terrain 6)."),
            ("Can I park my golf cart at the boat ramp?",
             "Yes at all the major public ramps (Wolf Creek Park, Pine Island Park, Cedar Point Park) and most private marinas. Check with your specific marina — some require you to park outside the trailer lanes."),
            ("How far can I drive on one charge around the lake?",
             "A typical Lake Livingston weekend (dock runs, marina trips, neighborhood cruising) uses 20-35 miles per day. The standard Breezy EV Lithium pack gives 35-55 miles per charge depending on model, so most owners only need to charge every other day or so."),
            ("Can I tow a golf cart from town to the lake?",
             "Yes, on a standard 14-16 ft trailer (a 6-seater is 12.4 ft long; a 4-seater is 9.7 ft). PCGC's rig and trailer can deliver any cart to anywhere on Lake Livingston for free (within 25 mi) or $75 flat (25-75 mi)."),
        ],
        "related": [
            ("Onalaska, TX golf carts", "/golf-carts/onalaska-tx/"),
            ("Coldspring, TX golf carts", "/golf-carts/coldspring-tx/"),
            ("The Breezy EV lineup", "/breezy-ev/"),
        ],
    },
}


def page_guide(slug):
    """Render a single pillar guide. Each guide is structured for AEO:
    leading-sentence answers, table-of-contents anchor links, FAQPage
    schema, and related-page links at the foot."""
    g = GUIDES[slug]
    toc = "\n".join(
        f'<a href="#section-{i}">{title}</a>'
        for i, (title, _) in enumerate(g["sections"])
    )
    body = "\n".join(
        f'<section class="guide-section" id="section-{i}"><h2>{title}</h2>{content}</section>'
        for i, (title, content) in enumerate(g["sections"])
    )
    faq_items = "\n".join(
        f'<details class="faq"><summary>{q}</summary><div class="faq-body"><p>{a}</p></div></details>'
        for q, a in g["faqs"]
    )
    related = "\n".join(
        f'<a class="card" href="{href}"><div class="card-body"><h3>{label} →</h3></div></a>'
        for label, href in g["related"]
    )
    sd = _json.dumps([
        breadcrumb_schema([
            ("Home", "/"),
            ("Guides", "/guides/"),
            (g["title"], f"/guides/{slug}/"),
        ]),
        {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [
                {
                    "@type": "Question",
                    "name": _strip_tags(q),
                    "acceptedAnswer": {"@type": "Answer", "text": _strip_tags(a)},
                }
                for q, a in g["faqs"]
            ],
        },
        {
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": g["title"],
            "description": g["summary"],
            "image": "https://polkcountygolfcarts.com/assets/og/home.png",
            "datePublished": "2026-06-01",
            "dateModified": "2026-06-19",
            "author": {"@type": "Organization", "name": BIZ["name"]},
            "publisher": {"@id": ENTITY_ORG},
            "mainEntityOfPage": f"https://polkcountygolfcarts.com/guides/{slug}/",
        },
    ])
    return (
        head(
            g["title"],
            g["summary"],
            f"/guides/{slug}/",
            og_slug="home",

            structured_data=sd,
        )
        + header(f"/guides/{slug}/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container" style="max-width: 880px;">
            <span class="eyebrow">{g['kicker']} · {g['read_time']}</span>
            <h1>{g['title']}</h1>
            <p class="lede">{g['lede']}</p>
          </div>
        </section>

        <article class="guide">
          <div class="container" style="max-width: 880px;">
            <nav class="guide-toc" aria-label="In this guide">
              <b>In this guide</b>
              {toc}
            </nav>
            {body}
          </div>
        </article>

        <section class="alt">
          <div class="container" style="max-width: 880px;">
            <div class="section-head">
              <span class="eyebrow">Common questions</span>
              <h2>FAQ</h2>
            </div>
            <div class="faq-list">
              {faq_items}
            </div>
          </div>
        </section>

        <section>
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">Related</span>
              <h2>Keep reading.</h2>
            </div>
            <div class="cards">
              {related}
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container center">
            <h2>Questions we didn't answer?</h2>
            <p class="lede-text">Call John. We answer the phone, we don't read scripts.</p>
            <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 {BIZ['phone_primary']}</a>
          </div>
        </section>
        """)
        + footer()
    )


def page_guides_index():
    cards = "\n".join(
        f'<a class="card{" alt" if i % 2 else ""}" href="/guides/{slug}/">'
        f'<div class="card-body">'
        f'<span class="eyebrow">{g["kicker"]} · {g["read_time"]}</span>'
        f'<h3>{g["title"]}</h3>'
        f'<p class="muted">{g["lede"][:140].rsplit(" ", 1)[0]}…</p>'
        f'</div></a>'
        for i, (slug, g) in enumerate(GUIDES.items())
    )
    sd = breadcrumb_schema([("Home", "/"), ("Guides", "/guides/")])
    return (
        head(
            "Golf Cart Buyer's Guides & Local Tips",
            "Pillar buyer's guides from Polk County Golf Carts — costs, comparisons, used-cart inspections, and Lake Livingston local advice from a real Texas dealer.",
            "/guides/",
            og_slug="home",

            structured_data=_json.dumps(sd),
        )
        + header("/guides/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container">
            <span class="eyebrow">Guides</span>
            <h1>Buyer's guides and local advice.</h1>
            <p class="lede">Long-form answers to the questions customers ask us before they buy. Written by the shop, not a content mill.</p>
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="cards breezy-grid">
              {cards}
            </div>
          </div>
        </section>
        """)
        + footer()
    )


# ---------------- Hidden /golf-carts/<town>/ pages ---------------- #
#
# Geo landing pages, one per town in the service area. Hidden the same
# way as /breezy-ev/: noindex + robots Disallow + no sitemap + no nav.
# Each page is ~800-1200 words of town-specific copy that wraps the
# same lineup grid / contact CTA, so it reads as a real local page
# rather than a doorway.

def page_town(slug):
    t = TOWN_PAGES[slug]
    free = t["delivery"] == "free"
    delivery_line = (
        f"Free pickup &amp; delivery to {t['short_name']} — you're inside our {BIZ['delivery_radius']}-mile free zone."
        if free else
        f"{t['short_name']} sits in our extended service area. We deliver for a flat <b>$75</b> within {BIZ['extended_radius']} miles of Livingston."
    )
    use_case_html = "\n".join(
        f'<div class="card"><h3>{title}</h3><p>{copy}</p></div>'
        for title, copy in t["use_cases"]
    )
    lineup_cards = "\n".join(
        f'<a class="card breezy-card" href="/breezy-ev/{m_slug}/">'
        f'<img src="/assets/photos/breezy-ev/{m_slug}.jpg" alt="Breezy EV {m["name"]}" width="800" height="600" loading="lazy">'
        f'<div class="card-body"><span class="eyebrow">{"Lifted" if m["lifted"] else "Street"}</span>'
        f'<h3>{m["name"]}</h3><p class="muted">{m["tagline"]}</p></div>'
        f'</a>'
        for m_slug, m in BREEZY_EV_MODELS.items()
    )
    sd = breadcrumb_schema([
        ("Home", "/"),
        ("Golf carts by town", "/golf-carts/"),
        (t["name"], f"/golf-carts/{slug}/"),
    ])
    return (
        head(
            f"Golf Carts in {t['name']} — Sales, Service & Delivery",
            f"Polk County Golf Carts delivers brand-new Breezy EV carts, refurbished and used carts to {t['name']}. {t['hook']} Call {BIZ['phone_primary']} for a quote.",
            f"/golf-carts/{slug}/",
            og_slug="carts",

            structured_data=_json.dumps(sd),
        )
        + header(f"/golf-carts/{slug}/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container hero-split">
            <div>
              <span class="eyebrow">{t['county']} · {t['distance_mi']} mi from our shop</span>
              <h1>Golf carts in {t['name']}.</h1>
              <p class="lede">{t['hook']}</p>
              <p class="hero-meta">{delivery_line}</p>
              <div class="hero-ctas">
                <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
                <a class="btn btn-outline" href="/breezy-ev/">See the lineup →</a>
              </div>
            </div>
            <img src="/assets/photos/breezy-ev/breeze-6l.jpg" alt="Breezy EV cart for {t['short_name']} delivery" width="800" height="600" fetchpriority="high">
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">Why {t['short_name']} customers buy from PCGC</span>
              <h2>{t['short_name']}'s nearest Breezy EV dealer is in Livingston.</h2>
              <p class="lede-text">PCGC is an <b>authorized Breezy EV dealer</b> with a brick-and-mortar showroom on FM 3277 — {t['distance_mi']} miles from {t['short_name']}. {"You're inside our free 25-mile pickup-and-delivery zone." if free else f"You're inside our extended 75-mile service area — flat $75 delivery, no surprises."} Family-owned since {BIZ['founded']}, BBB Accredited, 5-star Google reviews, and the only Breezy EV dealer in East Texas with a service center to keep the cart running after the sale.</p>
            </div>
            <div class="cards">
              {use_case_html}
            </div>
          </div>
        </section>

        <section>
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">The lineup</span>
              <h2>Four Breezy EVs. One delivers to {t['short_name']} next week.</h2>
              <p class="lede-text">Every model ships with the same Lithium powertrain, the same 2-year + 8-year warranty, and the same CarPlay-equipped infotainment. What changes is the stance, the seats, and the terrain it's built for. <a href="/breezy-ev/compare/">Compare them side-by-side →</a></p>
            </div>
            <div class="cards breezy-grid">
              {lineup_cards}
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container split">
            <div>
              <span class="eyebrow">{t['lifestyle_angle']}</span>
              <h2>Built for the way {t['short_name']} actually rides.</h2>
              <p>{t['short_name']} sits near {t['nearby']}. PCGC builds and services carts for {t['short_name']}-area customers every week — from {t['use_cases'][0][0].lower()} to {t['use_cases'][1][0].lower()}, with the lift, tires, and powertrain to match.</p>
              <ul class="checks">
                <li><b>BBB Accredited · 5-star Google reviews</b></li>
                <li>{"Free pickup &amp; delivery to " + t['short_name'] if free else "$75 flat extended delivery to " + t['short_name']}</li>
                <li>Financing through Lendmark Financial &amp; Dealer Direct</li>
                <li>Custom paint, lift kits, sound systems &amp; more in-house</li>
                <li>2-year warranty + 8-year Lithium battery warranty</li>
              </ul>
              <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Talk to Us today</a>
            </div>
            <div class="photo-block">
              <img src="/assets/photos/shop-exterior.jpg" alt="Polk County Golf Carts shop in Livingston, Texas" width="1024" height="500" loading="lazy">
            </div>
          </div>
        </section>

        <section>
          <div class="container center">
            <h2>Ready to ride in {t['short_name']}?</h2>
            <p class="lede-text">Call us. We'll quote it, deliver it, and stand behind it for the life of the cart.</p>
            <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
            &nbsp;
            <a class="btn btn-ghost" href="/breezy-ev/">See the four-model lineup →</a>
          </div>
        </section>
        """)
        + footer()
    )


def page_town_index():
    """Hub page at /golf-carts/ that links out to each town page."""
    items = "\n".join(
        f'<a class="card" href="/golf-carts/{slug}/"><div class="card-body"><span class="eyebrow">{t["county"]} · {t["distance_mi"]} mi</span><h3>{t["name"]}</h3><p class="muted">{t["hook"][:120]}</p></div></a>'
        for slug, t in TOWN_PAGES.items()
    )
    sd = breadcrumb_schema([("Home", "/"), ("Golf carts by town", "/golf-carts/")])
    return (
        head(
            "Golf Cart Delivery Across East Texas",
            "Polk County Golf Carts delivers and services golf carts across Livingston, Onalaska, Coldspring, Huntsville, Lufkin, and Woodville. Free pickup & delivery within 25 miles, extended up to 75.",
            "/golf-carts/",
            og_slug="carts",

            structured_data=_json.dumps(sd),
        )
        + header("/golf-carts/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container">
            <h1>Golf carts, delivered to your town.</h1>
            <p class="lede">We're based in Livingston, but we cover East Texas. Free pickup &amp; delivery within {BIZ['delivery_radius']} miles, extended service up to {BIZ['extended_radius']} miles for an additional charge.</p>
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head">
              <span class="eyebrow">Service area</span>
              <h2>Pick your town.</h2>
              <p class="lede-text">Each page covers what we deliver, who buys from us there, and how to schedule a test drive without crossing your fingers about whether we'll come out that far.</p>
            </div>
            <div class="cards">
              {items}
            </div>
          </div>
        </section>
        """)
        + footer()
    )


# ---------------- /leave-a-review/ + llms.txt + Reviews page ---------------- #

def page_reviews():
    """Public landing page at /leave-a-review/ — used as a tap target
    from QR codes, business cards, post-service emails. Three platform
    buttons + a soft escape hatch for "tell us first if something's
    wrong" feedback. NOT hidden — this one's meant to be linked from
    follow-up messages."""
    # Owner-supplied Google share link — resolves directly to the PCGC
    # review form. Shorter + more reliable than the placeid query-string
    # form (which sometimes shows an extra "find this business" step).
    google_review_url = "https://share.google/RjxLOjukDYZrEakMq"
    return (
        head(
            "Leave a Review · Polk County Golf Carts",
            "Help future customers find Polk County Golf Carts — leave a quick review on Google, BBB, or Facebook.",
            "/leave-a-review/",
            og_slug="contact",
            noindex=False,
        )
        + header("/leave-a-review/")
        + dedent(f"""\
        <section class="hero" style="padding-bottom:3rem">
          <div class="container">
            <h1>Tell folks about your cart.</h1>
            <p class="lede">A 30-second review on Google or BBB does more for our shop than any ad we could run. Pick the platform that's easiest for you — thank you in advance.</p>
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head center" style="margin-left:auto; margin-right:auto; text-align:center">
              <span class="eyebrow">One tap</span>
              <h2>Where would you like to leave it?</h2>
            </div>
            <div class="cards" style="max-width:880px; margin: 0 auto;">
              <a class="card" href="{google_review_url}" target="_blank" rel="noopener">
                <div class="card-body" style="text-align:center; padding:1.5rem;">
                  <div style="font-size:2.5rem; line-height:1; margin-bottom:.5rem;">⭐</div>
                  <h3>Google</h3>
                  <p class="muted">The big one. Most customers find us here. Search opens with our profile — tap "Write a review."</p>
                </div>
              </a>
              <a class="card alt" href="{BIZ['bbb_url']}#reviews" target="_blank" rel="noopener">
                <div class="card-body" style="text-align:center; padding:1.5rem;">
                  <div style="font-size:2.5rem; line-height:1; margin-bottom:.5rem;">★</div>
                  <h3>BBB</h3>
                  <p class="muted">Our Better Business Bureau profile — accredited since we opened.</p>
                </div>
              </a>
              <a class="card" href="https://www.facebook.com/polkcountygolfcarts/reviews" target="_blank" rel="noopener">
                <div class="card-body" style="text-align:center; padding:1.5rem;">
                  <div style="font-size:2.5rem; line-height:1; margin-bottom:.5rem;">👍</div>
                  <h3>Facebook</h3>
                  <p class="muted">Our Facebook page — the same place we post new builds and customer photos.</p>
                </div>
              </a>
            </div>
          </div>
        </section>

        <section>
          <div class="container split">
            <div>
              <span class="eyebrow">Something off?</span>
              <h2>Tell us first.</h2>
              <p class="lede-text">If anything didn't go right, we'd rather hear from you directly than read about it online. Call John — we'll make it right.</p>
              <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 {BIZ['phone_primary']}</a>
              &nbsp;
              <a class="btn btn-ghost" href="mailto:{BIZ['email']}">{BIZ['email']}</a>
            </div>
            <div class="photo-block">
              <img src="/assets/photos/owner-john.jpg" alt="John, owner of Polk County Golf Carts" width="1024" height="768" loading="lazy">
            </div>
          </div>
        </section>
        """)
        + footer()
    )


def page_404():
    """Custom 404 page. Served by Cloudflare's static-assets handler
    when not_found_handling = "404-page" is configured in wrangler.toml.
    Marked noindex so search engines don't try to rank the error page."""
    return (
        head(
            "Page Not Found",
            f"That page took a wrong turn. Back to the lineup, or call {BIZ['phone_primary']}.",
            "/404.html",
            og_slug="home",

        )
        + header("/404.html")
        + dedent(f"""\
        <section class="hero" style="padding: 5rem 0;">
          <div class="container">
            <div style="max-width: 760px; text-align: center; margin: 0 auto;">
              <p style="font: 700 6.5rem/1 Georgia, serif; color: #fff; margin: 0 0 .5rem; letter-spacing: -.04em;">404</p>
              <h1 style="color: #fff;">That page took a wrong turn.</h1>
              <p class="lede" style="max-width: 60ch; margin: 0 auto 2rem;">The URL you're looking for isn't here — it might have moved, been renamed, or never existed. Try one of the spots below, or give John a call.</p>
              <div class="hero-ctas" style="justify-content: center;">
                <a class="btn btn-coral" href="tel:{BIZ['phone_primary'].replace('-','')}">📞 Call {BIZ['phone_primary']}</a>
                <a class="btn btn-outline" href="/">Back to the home page</a>
              </div>
            </div>
          </div>
        </section>

        <section class="alt">
          <div class="container">
            <div class="section-head center" style="margin-left: auto; margin-right: auto; text-align: center;">
              <span class="eyebrow">Try one of these</span>
              <h2>Where were you headed?</h2>
            </div>
            <div class="cards">
              <a class="card" href="/carts/">
                <div class="card-body">
                  <span class="eyebrow">Carts</span>
                  <h3>Brand-new, refurbished, and used</h3>
                  <p>{BIZ['inventory_line']}</p>
                </div>
              </a>
              <a class="card alt" href="/services/">
                <div class="card-body">
                  <span class="eyebrow">Service</span>
                  <h3>20-Point Inspection &amp; custom builds</h3>
                  <p>Tune-ups from $165, plus lift kits, paint, sound systems, and more.</p>
                </div>
              </a>
              <a class="card" href="/about-us/">
                <div class="card-body">
                  <span class="eyebrow">Our story</span>
                  <h3>Family-owned since {BIZ['founded']}</h3>
                  <p>BBB Accredited, 5-star reviews, the only Breezy EV dealer in East Texas with a service center.</p>
                </div>
              </a>
              <a class="card alt" href="/contact/">
                <div class="card-body">
                  <span class="eyebrow">Contact</span>
                  <h3>Visit, call, or email</h3>
                  <p>1732 FM 3277, Livingston, TX 77351 · {BIZ['phone_primary']} · {BIZ['email']}</p>
                </div>
              </a>
            </div>
          </div>
        </section>
        """)
        + footer()
    )


# ---------------- Build ---------------- #

PAGES = {
    "index.html":         page_home,
    "carts/index.html":   page_carts,
    "services/index.html":page_services,
    "about-us/index.html": page_about,
    "404.html":           page_404,
    "contact/index.html": page_contact,
    "financing/index.html": page_financing,
    "privacy/index.html": page_privacy,
    # Hidden Breezy EV product tree (noindex + robots Disallow + no
    # sitemap + no nav link). Direct URL only until client signs off.
    "breezy-ev/index.html":                       page_breezy_lineup,
    "breezy-ev/compare/index.html":               page_breezy_compare,
    "breezy-ev/financing/index.html":             page_breezy_financing,
    "breezy-ev/street-legal/index.html":          page_breezy_street_legal,
    "breezy-ev/lithium-vs-lead-acid/index.html":  page_breezy_lithium_vs_lead_acid,
    # Hidden /guides/ pillar content (Phase 3) — same review-first flow.
    "guides/index.html":                          page_guides_index,
    # Hidden tier-3 town pages — same hidden-while-reviewing pattern.
    "golf-carts/index.html":         page_town_index,
    # Public review landing page — meant to be linked from post-sale
    # follow-ups and QR codes, NOT hidden.
    "leave-a-review/index.html":     page_reviews,
}
for _slug in BREEZY_EV_MODELS:
    PAGES[f"breezy-ev/{_slug}/index.html"] = (lambda s=_slug: page_breezy_model(s))
for _slug in TOWN_PAGES:
    PAGES[f"golf-carts/{_slug}/index.html"] = (lambda s=_slug: page_town(s))
for _slug in GUIDES:
    PAGES[f"guides/{_slug}/index.html"] = (lambda s=_slug: page_guide(s))


def main():
    for rel, fn in PAGES.items():
        out = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            f.write(fn())
        print(f"  wrote {rel}")
    # robots + sitemap
    with open(os.path.join(ROOT, "robots.txt"), "w") as f:
        f.write(
            "User-agent: *\n"
            "Allow: /\n"
            "Disallow: /admin/\n"
            "Disallow: /api/\n"
            # /rentals/ is left CRAWLABLE on purpose: the page itself
            # carries <meta name="robots" content="noindex, nofollow">,
            # and search engines need to be allowed to crawl the page
            # to see that directive and drop the URL from the index.
            # Blocking via robots.txt prevents the crawl, which is
            # exactly what causes Google to index the URL anyway when
            # it finds it via external links.
            #
            # Phase 1 (/breezy-ev/), Phase 2 (/golf-carts/), and
            # Phase 3 (/guides/) trees are now PUBLIC — the
            # `Disallow: /breezy-ev/`, `/golf-carts/`, `/guides/`
            # lines that used to live here were removed during the
            # SEO Priority 1 launch.
            "Sitemap: https://polkcountygolfcarts.com/sitemap.xml\n"
        )
    # Public URLs for the sitemap. Phase 1-3 pages (Breezy EV product
    # tree, town service-area pages, pillar guides) added below.
    urls = ["/", "/carts/", "/services/", "/rentals/", "/financing/", "/about-us/", "/contact/", "/privacy/", "/leave-a-review/"]
    urls += [
        "/breezy-ev/",
        "/breezy-ev/compare/",
        "/breezy-ev/financing/",
        "/breezy-ev/street-legal/",
        "/breezy-ev/lithium-vs-lead-acid/",
    ]
    urls += [f"/breezy-ev/{s}/" for s in BREEZY_EV_MODELS]
    urls += ["/guides/"] + [f"/guides/{s}/" for s in GUIDES]
    urls += ["/golf-carts/"] + [f"/golf-carts/{s}/" for s in TOWN_PAGES]
    sm = ['<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        sm.append(f"  <url><loc>https://polkcountygolfcarts.com{u}</loc></url>")
    sm.append("</urlset>")
    with open(os.path.join(ROOT, "sitemap.xml"), "w") as f:
        f.write("\n".join(sm))

    # llms.txt — concise summary for AI engines (ChatGPT, Perplexity,
    # Claude, Gemini) modeled on llmstxt.org. Lives at the site root.
    breezy_lines = "\n".join(
        f"- [{m['name']}](https://polkcountygolfcarts.com/breezy-ev/{slug}/) — {m['seats']}-seater, "
        f"{'lifted' if m['lifted'] else 'street'}, {m['range_mi']} mi range"
        for slug, m in BREEZY_EV_MODELS.items()
    )
    llms = f"""# {BIZ['name']}

> {BIZ['tagline']} in Livingston, Texas. Authorized Breezy EV golf cart dealer for East Texas — sales, service, custom builds, and rentals.

## About
- Founded {BIZ['founded']} · Family-owned · BBB Accredited
- Address: 1732 FM 3277, Livingston, TX 77351
- Phone: {BIZ['phone_primary']} (alt {BIZ['phone_secondary']})
- Email: {BIZ['email']}
- Hours: Tue-Fri 9a-4p, Saturday 9a-2p, Closed Sun-Mon and holidays
- Service area: {BIZ['service_area']} — free pickup & delivery within {BIZ['delivery_radius']} miles, extended up to {BIZ['extended_radius']} miles for a flat $75

## What we sell
{BIZ['inventory_line']}

### Breezy EV models we stock
{breezy_lines}

### Pricing
Prices start at $12,500 and up depending on the model chosen — call for current pricing.

## Services
- 20-Point Inspection (Full Service Package) from $165
- Battery service (lead-acid and Lithium — Bolt Energy + White Lightening)
- Custom paint, lift kits, wheels & tires, sound systems, rear flip seats
- Controller and motor upgrades (Navitas + White Lightening)
- 10% off Parts & Labor — valid 1 year from initial service

## Financing
- Lendmark Financial
- Dealer Direct

## Key pages
- [Home](https://polkcountygolfcarts.com/)
- [Carts for sale](https://polkcountygolfcarts.com/carts/)
- [Services & Custom Builds](https://polkcountygolfcarts.com/services/)
- [About / our story](https://polkcountygolfcarts.com/about/)
- [Contact](https://polkcountygolfcarts.com/contact/)
- [Leave a review](https://polkcountygolfcarts.com/leave-a-review/)
"""
    with open(os.path.join(ROOT, "llms.txt"), "w") as f:
        f.write(llms)

    print(f"\nDone. Built {len(PAGES)} pages + robots + sitemap + llms.txt.")


if __name__ == "__main__":
    main()
