/**
 * PCGC site Worker — serves the static asset directory and exposes two
 * JSON endpoints used by the hidden rental flow:
 *
 *   POST /api/booking   public; saves a rental booking record
 *   GET  /api/booking   admin; lists recent bookings (basic auth)
 *
 * Admin endpoints require HTTP basic auth against the
 * FEEDBACK_ADMIN_USER (default "admin") + FEEDBACK_ADMIN_PASS secrets
 * configured via the Cloudflare dashboard.
 *
 * Storage: env.FEEDBACK_KV — one entry per booking under the
 * `booking:<iso-ts>:<6-char-id>` key, JSON value.
 */

const KV_LIST_LIMIT = 200;
// 8 hours. Long enough that the owner isn't logging in repeatedly,
// short enough that an unlocked laptop doesn't stay open all week.
const ADMIN_SESSION_TTL_SEC = 60 * 60 * 8;
const ADMIN_COOKIE = "pcgc_admin";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Force everything onto the canonical apex hostname. Google (and
    // some directory backfills) had www.polkcountygolfcarts.com in
    // the index against a hostname that wasn't bound to the Worker;
    // customers who clicked those results hit a raw Cloudflare 522.
    // Now www is routed here, and we 301 straight to the apex so
    // there's exactly one canonical version of every URL.
    if (url.hostname === "www.polkcountygolfcarts.com") {
      const canonical = new URL(url);
      canonical.hostname = "polkcountygolfcarts.com";
      return Response.redirect(canonical.toString(), 301);
    }

    if (url.pathname === "/api/booking" && request.method === "POST") {
      return submitBooking(request, env);
    }
    if (url.pathname === "/api/booking" && request.method === "GET") {
      return listBookings(request, env);
    }
    if (url.pathname === "/api/attempts" && request.method === "GET") {
      return listBookingAttempts(request, env);
    }
    if (url.pathname === "/api/client-error" && request.method === "POST") {
      return receiveClientError(request, env);
    }
    if (url.pathname === "/api/session-checkpoint" && request.method === "POST") {
      return receiveSessionCheckpoint(request, env);
    }
    if (url.pathname === "/api/sessions" && request.method === "GET") {
      return listSessions(request, env);
    }
    if (url.pathname === "/api/service-request" && request.method === "POST") {
      return submitServiceRequest(request, env);
    }
    if (url.pathname === "/api/service-requests" && request.method === "GET") {
      return listServiceRequests(request, env);
    }
    if (url.pathname.startsWith("/api/service-requests/") && request.method === "DELETE") {
      return deleteServiceRequest(request, env, url);
    }
    // ---------- Inventory listings (new + used golf carts) ----------
    if (url.pathname === "/api/listings" && request.method === "GET") {
      return listListings(request, env, url);
    }
    if (url.pathname === "/api/listings" && request.method === "POST") {
      return createListing(request, env);
    }
    const listingSlugMatch = url.pathname.match(/^\/api\/listings\/([a-z0-9-]{2,80})(?:\/(.+))?$/);
    if (listingSlugMatch) {
      const slug = listingSlugMatch[1];
      const sub = listingSlugMatch[2] || "";
      if (!sub && request.method === "GET")    return getListing(request, env, slug);
      if (!sub && request.method === "PATCH")  return updateListing(request, env, slug);
      if (!sub && request.method === "DELETE") return deleteListing(request, env, slug);
      if (sub === "images" && request.method === "POST") return addListingImage(request, env, slug);
      const imgMatch = sub.match(/^image\/([A-Za-z0-9_-]{2,40})$/);
      if (imgMatch && request.method === "GET") return getListingImage(request, env, slug, imgMatch[1]);
      const imgDel = sub.match(/^images\/([A-Za-z0-9_-]{2,40})$/);
      if (imgDel && request.method === "DELETE") return deleteListingImage(request, env, slug, imgDel[1]);
    }
    // Server-render the detail page so Google + ChatGPT see real HTML
    // with full meta tags + JSON-LD, not an empty SPA shell.
    const carts2DetailMatch = url.pathname.match(/^\/carts2\/([a-z0-9-]{2,80})\/?$/);
    if (carts2DetailMatch) {
      return renderListingDetailPage(request, env, carts2DetailMatch[1]);
    }
    if (url.pathname.startsWith("/api/booking/") && request.method === "PATCH") {
      return updateBookingStatus(request, env, url);
    }
    if (url.pathname.startsWith("/api/booking/") && request.method === "DELETE") {
      return deleteBooking(request, env, url);
    }
    if (url.pathname === "/api/availability" && request.method === "GET") {
      return checkAvailability(request, env, url);
    }
    if (url.pathname === "/api/admin/login" && request.method === "POST") {
      return adminLogin(request, env);
    }
    if (url.pathname === "/api/admin/logout" && request.method === "POST") {
      return adminLogout();
    }
    if (url.pathname === "/api/admin/test-email" && request.method === "POST") {
      return sendTestEmail(request, env);
    }
    if (url.pathname === "/api/track" && request.method === "POST") {
      return trackEvent(request, env);
    }
    if (url.pathname === "/api/track/summary" && request.method === "GET") {
      return trackSummary(request, env, url);
    }
    if (url.pathname.startsWith("/api/agreement/") && request.method === "GET") {
      return getAgreement(request, env, url);
    }
    if (url.pathname.startsWith("/api/agreement/") && request.method === "POST") {
      return signAgreement(request, env, url);
    }
    if (url.pathname === "/api/payment/create-checkout" && request.method === "POST") {
      return createCloverCheckout(request, env);
    }
    if (url.pathname === "/api/payment/webhook" && request.method === "POST") {
      return handleCloverWebhook(request, env);
    }
    if (url.pathname === "/api/config" && request.method === "GET") {
      return getConfig(request, env);
    }

    // Legacy URLs from the original site — 301 to the new locations
    // so search engines (and bookmarks) move with us.
    if (url.pathname === "/about" || url.pathname === "/about/") {
      return Response.redirect(`${url.origin}/about-us/`, 301);
    }

    // Everything else flows to the static assets bound at env.ASSETS.
    return env.ASSETS.fetch(request);
  },
};

// Public entry point — wraps the real impl so every failure and every
// uncaught exception gets logged to KV under `attempt:<ts>:<id>` with a
// 30-day TTL. The impl mutates `payload` via a callback so we can
// include contact + dates + item count in the log even when validation
// rejects the submission BEFORE those fields are persisted anywhere.
async function submitBooking(request, env) {
  let payload = null;
  const setPayload = (p) => { payload = p; };
  let response;
  try {
    response = await _submitBookingCore(request, env, setPayload);
  } catch (e) {
    console.error("booking uncaught:", e?.stack || e);
    // Fire-and-forget log; never let a logging error mask the caller's failure.
    logBookingAttempt(env, request, {
      outcome: "throw",
      code: 500,
      error: String(e?.message || e).slice(0, 400),
      payload,
    }).catch((err) => console.error("attempt log (throw) failed:", err));
    return json({ error: "internal error — please try again or call 936-223-1182" }, 500);
  }
  if (!response.ok) {
    // Clone so we can peek at the body without consuming it for the caller.
    let bodyErr = null;
    try { bodyErr = (await response.clone().json())?.error || null; } catch {}
    console.error(`booking failed [${response.status}] ${bodyErr || ""}`);
    logBookingAttempt(env, request, {
      outcome: "fail",
      code: response.status,
      error: bodyErr || `HTTP ${response.status}`,
      payload,
    }).catch((err) => console.error("attempt log (fail) failed:", err));
  }
  return response;
}

// Log ONE booking attempt (fail / throw) to KV. Successful bookings
// already persist under `booking:*` so we don't double-log them.
// Redacts payload down to just the diagnostic fields — never persists
// the driver's-license image, signature, agreement PDF, or tax-exempt
// certificate. TTL is 30 days.
async function logBookingAttempt(env, request, entry) {
  if (!env?.FEEDBACK_KV) return;
  const ts = new Date().toISOString();
  const idSuffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  const key = `attempt:${ts}:${idSuffix}`;
  const p = entry.payload || {};
  const c = p.contact || {};
  const record = {
    ts,
    outcome: entry.outcome || "fail",
    code: entry.code || null,
    error: entry.error || null,
    ip: request.headers.get("cf-connecting-ip") || "",
    ua: (request.headers.get("user-agent") || "").slice(0, 500),
    country: request.cf?.country || "",
    // Diagnostic slice of the payload — enough to identify the customer
    // and reproduce the shape, without persisting sensitive artifacts.
    contact: {
      name: c.name || null,
      email: c.email || null,
      phone: c.phone || null,
      city: c.city || null,
      state: c.state || null,
    },
    dates: p.dates || null,
    delivery: p.delivery || null,
    itemCount: Array.isArray(p.items) ? p.items.length : null,
    itemIds: Array.isArray(p.items) ? p.items.map((i) => i?.id || null).slice(0, 10) : null,
    subtotal: p.pricing?.subtotal ?? null,
    grand: p.pricing?.grand ?? p.pricing?.total ?? null,
    hasSignature: !!p.signedAgreement?.signatureDataUrl,
    signatureBytes: p.signedAgreement?.signatureDataUrl?.length || 0,
    hasDlImage: !!p.signedAgreement?.dlImageDataUrl,
    hasAgreementPdf: !!p.signedAgreement?.pdfBase64,
    agreementPdfBytes: p.signedAgreement?.pdfBase64?.length || 0,
    taxExempt: !!p.contact?.taxExempt,
    hasTaxCert: !!p.contact?.taxExemptFileDataUrl,
  };
  await env.FEEDBACK_KV.put(key, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 30,  // 30 days
  });
}

async function _submitBookingCore(request, env, setPayload) {
  if (!env.FEEDBACK_KV) return json({ error: "storage not configured" }, 503);
  let payload;
  try {
    payload = await request.json();
    setPayload(payload);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!payload || !payload.items || !Array.isArray(payload.items) || payload.items.length === 0) {
    return json({ error: "no items in booking" }, 400);
  }
  if (!payload.contact || !payload.contact.name || !payload.contact.email) {
    return json({ error: "missing contact details" }, 400);
  }

  // Inline rental agreement — validated on the client too, but never
  // trust the client. If it's missing or malformed the booking is
  // rejected outright; the customer sees the error and fills it in.
  const sa = payload.signedAgreement || {};
  if (!sa.signatureDataUrl || typeof sa.signatureDataUrl !== "string" || !sa.signatureDataUrl.startsWith("data:image/")) {
    return json({ error: "signature required" }, 400);
  }
  if (sa.signatureDataUrl.length > 250_000) {
    return json({ error: "signature too large" }, 413);
  }
  if (!sa.typedName || !sa.typedName.trim()) return json({ error: "typed name required on agreement" }, 400);
  if (!sa.dlNumber || !sa.dlState) return json({ error: "driver's license number and state required" }, 400);
  const ALLOWED_DL_METHODS = ["upload", "text", "in-person"];
  const dlMethod = ALLOWED_DL_METHODS.includes(sa.dlMethod) ? sa.dlMethod : "text";
  if (dlMethod === "upload") {
    if (!sa.dlImageDataUrl || typeof sa.dlImageDataUrl !== "string" || !sa.dlImageDataUrl.startsWith("data:image/")) {
      return json({ error: "driver's license photo required for the 'upload now' option" }, 400);
    }
    if (sa.dlImageDataUrl.length > 1_500_000) {
      return json({ error: "driver's license photo too large" }, 413);
    }
  }
  if (sa.agreed !== true) return json({ error: "you must agree to the terms" }, 400);
  // Optional signed-agreement PDF (base64) generated client-side.
  // Bounded at ~5MB to keep the KV write under the 25MB per-value cap
  // even with the rest of the record.
  if (sa.pdfBase64 && (typeof sa.pdfBase64 !== "string" || sa.pdfBase64.length > 5_000_000)) {
    return json({ error: "signed agreement PDF too large" }, 413);
  }

  // Tax-exempt booking: require an org name AND an exemption
  // certificate file so we can defend a $0-tax rental at audit. The
  // certificate data-URL is bounded like the driver's license upload.
  const contact = payload.contact || {};
  if (contact.taxExempt) {
    if (!contact.taxExemptOrg || !String(contact.taxExemptOrg).trim()) {
      return json({ error: "tax-exempt organization name is required" }, 400);
    }
    const fileDataUrl = contact.taxExemptFileDataUrl;
    if (!fileDataUrl || typeof fileDataUrl !== "string" || !/^data:(image\/|application\/pdf)/i.test(fileDataUrl)) {
      return json({ error: "tax-exempt certificate file is required (image or PDF)" }, 400);
    }
    if (fileDataUrl.length > 2_500_000) {
      return json({ error: "tax-exempt certificate too large" }, 413);
    }
  }

  const ts = new Date().toISOString();
  const idSuffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  const id = "PCGC-" + idSuffix;

  // Payment step (Clover embedded flow). Runs BEFORE we save the
  // booking so a failed charge doesn't leave an orphaned reservation
  // in KV. If Clover isn't configured yet, we skip and save the
  // booking anyway — the site falls back to "we'll follow up by
  // phone for payment" behavior. Once the secrets land, every
  // /api/booking POST is expected to include a sourceToken.
  const sourceToken = payload.paymentSourceToken;
  let charge = null;
  if (env.CLOVER_ACCESS_TOKEN && sourceToken) {
    // Amount = grand total for now. Deposit-only split (50% now,
    // 50% at pickup for 3+-month-out bookings) is a future
    // enhancement — will need a second /v1/charges call at pickup
    // time triggered by the admin.
    const grandCents = Math.round(((payload?.pricing?.grand ?? payload?.pricing?.total) || 0) * 100);
    if (!grandCents) {
      return json({ error: "no amount to charge" }, 400);
    }
    charge = await chargeCard(env, {
      sourceToken,
      amountCents: grandCents,
      bookingId: id,
      customerEmail: payload?.contact?.email,
      description: `PCGC rental ${id} · ${payload?.dates?.start || "?"} to ${payload?.dates?.end || "?"}`,
    });
    if (!charge.ok) {
      // Booking is NOT saved. Return the error so the client can
      // surface it inline (bad card, insufficient funds, etc.).
      return json({ error: charge.error || "payment_declined", clover: charge.raw || null }, 402);
    }
  }

  const record = {
    ...payload,
    id,
    ts,
    status: "new",
    statusUpdatedAt: ts,
    ua: (request.headers.get("user-agent") || "").slice(0, 500),
    ip: request.headers.get("cf-connecting-ip") || "",
    country: request.cf?.country || "",
    payment: charge?.ok ? {
      status: "paid",
      chargeId: charge.chargeId,
      amountCents: Math.round(((payload?.pricing?.grand ?? payload?.pricing?.total) || 0) * 100),
      chargedAt: ts,
    } : null,
    agreement: {
      version: AGREEMENT_VERSION,
      signedAt: ts,
      typedName: String(sa.typedName).slice(0, 200),
      dlNumber: String(sa.dlNumber).slice(0, 40),
      dlState: String(sa.dlState).slice(0, 4).toUpperCase(),
      dlMethod,
      dlImageDataUrl: dlMethod === "upload" ? sa.dlImageDataUrl : null,
      signatureDataUrl: sa.signatureDataUrl,
      // Optional full signed-doc PDF generated client-side. Stored
      // alongside the record + emailed to the customer as an
      // attachment. Presence is optional — a booking without the
      // PDF is still valid; the pieces to regenerate one live in
      // the record too.
      pdfBase64: sa.pdfBase64 || null,
      signedIp: request.headers.get("cf-connecting-ip") || "",
      signedUa: (request.headers.get("user-agent") || "").slice(0, 500),
    },
  };
  // Never persist single-use fields alongside the record.
  delete record.paymentSourceToken;
  delete record.signedAgreement;
  await env.FEEDBACK_KV.put(`booking:${ts}:${idSuffix}`, JSON.stringify(record));

  // Mint the agreement token now so the on-screen confirmation + both
  // emails can link the customer straight to the signature page.
  const agreementToken = await mintAgreementToken(id, env);
  const agreementPath = agreementToken
    ? `/agreement/?id=${encodeURIComponent(id)}&t=${agreementToken}`
    : null;

  // Notify the owner via Resend. Failure here must NEVER fail the
  // booking — the record is already saved in KV; the email is a
  // convenience layer on top. Outcome is echoed in the response so
  // the owner can inspect the network tab if a submission looks like
  // it "worked" but no email arrived.
  // Two emails go out on submit: (1) owner notification -> Yahoo,
  // (2) customer confirmation -> the customer, with Reply-To pointed
  // back at the Yahoo address so any customer reply lands in John's
  // inbox instead of bouncing off an unmonitored bookings@ mailbox.
  // Both are independent — one failing doesn't block the other, and
  // neither failing blocks the booking (already saved in KV).
  let ownerEmailResult;
  let customerEmailResult;
  if (!env.RESEND_API_KEY) {
    ownerEmailResult = "skipped: RESEND_API_KEY not set in Cloudflare Worker secrets";
    customerEmailResult = ownerEmailResult;
  } else {
    try {
      await sendBookingEmail(record, env, agreementPath);
      ownerEmailResult = "sent";
    } catch (e) {
      ownerEmailResult = "failed: " + (e?.message || String(e));
      console.error("owner booking email failed:", ownerEmailResult);
    }
    try {
      await sendCustomerConfirmationEmail(record, env, agreementPath);
      customerEmailResult = "sent";
    } catch (e) {
      customerEmailResult = "failed: " + (e?.message || String(e));
      console.error("customer confirmation email failed:", customerEmailResult);
    }
  }

  return json({
    ok: true,
    id,
    email: ownerEmailResult,
    customerEmail: customerEmailResult,
    agreementPath, // absolute path (e.g. "/agreement/?id=...&t=...") for the confirmation page to link to
  });
}

// Send the booking notification through Resend's HTTP API. The owner
// receives a single email at BOOKING_TO_EMAIL with the customer's
// name in the From display and the customer's email in Reply-To, so
// hitting "Reply" in Yahoo Mail goes straight to the customer.
//
// Requires Cloudflare Worker secrets:
//   RESEND_API_KEY       — from resend.com/api-keys
//   BOOKING_FROM_EMAIL   — verified sender, e.g. bookings@polkcountygolfcarts.com
//   BOOKING_TO_EMAIL     — recipient, defaults to polkcountygolfcarts@yahoo.com
async function sendBookingEmail(record, env, _agreementPath) {
  // _agreementPath is currently unused for the OWNER email — the
  // owner sees agreement status in /admin/rentals/, not in email.
  // Kept in the signature so callers can pass it uniformly with
  // sendCustomerConfirmationEmail.
  const from = env.BOOKING_FROM_EMAIL || "bookings@polkcountygolfcarts.com";
  const to = env.BOOKING_TO_EMAIL || "polkcountygolfcarts@yahoo.com";
  const customer = record.contact || {};
  // Clean brand-only sender name — owner's question: "why does the
  // inbox show 'Melissa D. Long via PCGC Bookings'?" Original design
  // was to surface the customer name in the From line, but the
  // subject already names the customer ("New rental booking · Melissa
  // D. Long · Aug 15 -> Aug 17") and Reply-To routes back to them, so
  // there's no reason to duplicate. Sender is now just the shop.
  const fromWithName = `Online Cart Rentals <${from}>`;
  const replyTo = customer.email
    ? `${displayName(customer.name)} <${customer.email}>`
    : undefined;

  const dates = record.dates || {};
  const subject = `New rental booking · ${customer.name || "(no name)"} · ${dates.start || "?"} → ${dates.end || "?"}`;

  const body = {
    from: fromWithName,
    to: [to],
    subject,
    html: renderBookingHtml(record),
    text: renderBookingText(record),
  };
  if (replyTo) body.reply_to = replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`resend ${res.status}: ${text}`);
  }
}

// Customer confirmation email sent immediately after a booking is
// submitted. Distinct from the owner notification: this goes TO the
// customer, and its Reply-To is polkcountygolfcarts@yahoo.com so any
// customer reply lands in John's inbox instead of bouncing off the
// bookings@ mailbox (which doesn't need to exist).
//
// Body mirrors the on-screen /rentals/ confirmation: booking code,
// dates + cart list, per-delivery requirements (DL / insurance /
// plate photo for pickup; DL only for delivery), and a note about
// the DocuSign rental agreement.
async function sendCustomerConfirmationEmail(record, env, agreementPath) {
  const customer = record.contact || {};
  const to = customer.email;
  if (!to) throw new Error("no customer email on booking");
  const from = env.BOOKING_FROM_EMAIL || "bookings@polkcountygolfcarts.com";
  const ownerEmail = env.BOOKING_TO_EMAIL || "polkcountygolfcarts@yahoo.com";
  const isPickup = record.delivery === "pickup";

  const dates = record.dates || {};
  const subject = `Your Polk County Golf Carts rental is booked · ${record.id}`;
  const firstName = (customer.name || "").split(/\s+/)[0] || "there";

  const requirements = isPickup
    ? [
        "Driver's license (photo or scan) for everyone who will be driving the cart",
        "Auto insurance (photo or scan)",
        "Photo of your vehicle's license plate (the vehicle we'll be loading the cart onto)",
      ]
    : [
        "Driver's license (photo or scan) for everyone who will be driving the cart",
      ];

  // 50%-deposit note only shows on the customer email if the pickup is
  // 3+ months out (matches the on-screen review step).
  let farOutNote = false;
  if (dates.start) {
    const startMs = Date.parse(dates.start + "T00:00:00");
    if (Number.isFinite(startMs) && (startMs - Date.now()) / 86400000 >= 90) {
      farOutNote = true;
    }
  }

  const itemRows = (record.items || []).map(it => `
    <tr>
      <td style="padding:4px 0;">${escHtml(it.name)} × ${it.qty}</td>
      <td style="padding:4px 0; text-align:right;">${fmtMoney(it.lineTotal)}</td>
    </tr>
  `).join("");

  const p = record.pricing || {};
  const html = `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif; max-width:560px; margin:0 auto; padding:1rem; color:#222;">
    <h2 style="color:#1f5a68; margin:0 0 .5rem;">You're booked, ${escHtml(firstName)}!</h2>
    <p style="margin:.25rem 0 1rem; color:#666;">Confirmation code: <b>${escHtml(record.id)}</b></p>

    <table style="width:100%; border-collapse:collapse; font-size:14px; margin-bottom:1rem;">
      <tr><td style="width:100px; color:#888; padding:4px 0;">Pickup</td><td style="padding:4px 0;"><b>${escHtml(dates.start)}</b> · ${dates.pickupTime === "pm" ? "after noon (half day)" : "before noon (full day)"}</td></tr>
      <tr><td style="color:#888; padding:4px 0;">Return</td><td style="padding:4px 0;"><b>${escHtml(dates.end)}</b> · ${dates.dropoffTime === "pm" ? "after noon (full day)" : "before noon (half day)"}</td></tr>
      ${dates.days ? `<tr><td style="color:#888; padding:4px 0;">Length</td><td style="padding:4px 0;"><b>${dates.days} day${dates.days === 1 ? "" : "s"}</b> charged</td></tr>` : ""}
    </table>

    <table style="width:100%; border-collapse:collapse; font-size:14px; border-top:1px solid #ddd;">
      ${itemRows}
      ${customer.taxExempt ? `<tr><td style="padding:4px 0; color:#8a4a00;">Tax (exempt — ${escHtml(customer.taxExemptOrg || "")})</td><td style="padding:4px 0; text-align:right; color:#8a4a00;"><b>Waived</b></td></tr>` : `<tr><td style="padding:4px 0; color:#888;">Tax</td><td style="padding:4px 0; text-align:right;">${fmtMoney(p.tax)}</td></tr>`}
      <tr style="border-top:1px solid #ddd;"><td style="padding:8px 0;"><b>Total</b></td><td style="padding:8px 0; text-align:right;"><b>${fmtMoney(p.total)}</b></td></tr>
    </table>

    <p style="margin-top:1.5rem;"><b>What happens next:</b> We'll follow up by phone or text within a day to confirm your booking and take payment. ${farOutNote ? "Since your pickup is more than 3 months out, we'll collect a <b>50% deposit</b> to hold the reservation and the balance at pickup." : ""}</p>

    ${agreementPath ? `<div style="background:#e6f1f3; border:1px solid #9fcfd7; border-radius:8px; padding:1rem 1.2rem; margin-top:1.5rem;">
      <h3 style="margin:0 0 .5rem; color:#1f5a68;">Your signed agreement</h3>
      <p style="margin:.35rem 0 .85rem;">You signed the rental agreement during checkout — a copy is available online for your records anytime.</p>
      <p style="margin:0;">
        <a href="https://polkcountygolfcarts.com${agreementPath}" style="display:inline-block; background:#1f5a68; color:#fff; padding:.7rem 1.25rem; border-radius:8px; text-decoration:none; font-weight:600;">View your signed agreement &rarr;</a>
      </p>
    </div>` : ""}

    <div style="background:#fff9f4; border:1px solid #f3c3bc; border-radius:8px; padding:1rem 1.2rem; margin-top:1.5rem;">
      <h3 style="margin:0 0 .5rem; color:#1f5a68;">At time of payment — please text these to 936-223-1182</h3>
      <ul style="margin:.35rem 0 0; padding-left:1.2rem;">
        ${requirements.map(r => `<li>${escHtml(r)}</li>`).join("")}
      </ul>
    </div>

    <div style="background:#f4f0e8; border:1px solid #d6cdb8; border-radius:8px; padding:1rem 1.2rem; margin-top:1rem;">
      <b>Cancellation policy</b>
      <ul style="margin:.35rem 0 0; padding-left:1.2rem;">
        <li><b>7+ days</b> before your first rental day — <b>100% refund</b></li>
        <li><b>4&ndash;6 days</b> before — <b>50% refund</b></li>
        <li><b>3 days or less</b> — <b>no refund</b></li>
      </ul>
    </div>

    <p style="margin-top:1.5rem;">Questions or changes? Just reply to this email — it goes straight to John — or give us a ring at <a href="tel:9362231182">936-223-1182</a>.</p>
    <p style="margin-top:1.5rem;">— The Polk County Golf Carts crew<br>1732 FM 3277 · Livingston, TX</p>
  </body></html>`;

  const text = [
    `You're booked, ${firstName}!`,
    ``,
    `Confirmation code: ${record.id}`,
    ``,
    `Pickup: ${dates.start} · ${dates.pickupTime === "pm" ? "after noon (half day)" : "before noon (full day)"}`,
    `Return: ${dates.end} · ${dates.dropoffTime === "pm" ? "after noon (full day)" : "before noon (half day)"}`,
    dates.days ? `Length: ${dates.days} day${dates.days === 1 ? "" : "s"} charged` : null,
    ``,
    ...(record.items || []).map(it => `  ${it.name} x ${it.qty}  ${fmtMoney(it.lineTotal)}`),
    customer.taxExempt ? `  Tax  WAIVED (exemption on file — ${customer.taxExemptOrg || ""})` : `  Tax  ${fmtMoney(p.tax)}`,
    `  Total  ${fmtMoney(p.total)}`,
    ``,
    `What happens next: We'll follow up by phone or text within a day to confirm your booking and take payment.`,
    farOutNote ? `Since your pickup is more than 3 months out, we'll collect a 50% deposit to hold the reservation and the balance at pickup.` : null,
    ``,
    agreementPath ? `Sign your rental agreement (takes about a minute):` : null,
    agreementPath ? `  https://polkcountygolfcarts.com${agreementPath}` : null,
    agreementPath ? `` : null,
    `At time of payment — please text these to 936-223-1182:`,
    ...requirements.map(r => `  - ${r}`),
    ``,
    `Cancellation policy:`,
    `  - 7+ days before your first rental day: 100% refund`,
    `  - 4-6 days before: 50% refund`,
    `  - 3 days or less: no refund`,
    ``,
    `Questions or changes? Just reply to this email — it goes straight to John — or give us a ring at 936-223-1182.`,
    ``,
    `— The Polk County Golf Carts crew`,
    `1732 FM 3277 · Livingston, TX`,
  ].filter(Boolean).join("\n");

  // Attach the signed-agreement PDF if the client uploaded one.
  // Resend accepts up to ~40MB total per email; our client-side cap
  // is 5MB so we're safely inside.
  const attachments = [];
  const pdfB64 = record?.agreement?.pdfBase64;
  if (pdfB64 && typeof pdfB64 === "string" && pdfB64.length > 100) {
    attachments.push({
      filename: `pcgc-agreement-${record.id || "signed"}.pdf`,
      content: pdfB64,
      contentType: "application/pdf",
    });
  }

  const emailBody = {
    from: `Online Cart Rentals <${from}>`,
    to: [to],
    subject,
    html,
    text,
    reply_to: ownerEmail,
  };
  if (attachments.length) emailBody.attachments = attachments;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(emailBody),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`resend ${res.status}: ${t}`);
  }
}

function displayName(s) {
  // Strip anything that could mess up an RFC5322 display name. Quote
  // if it contains characters that need quoting.
  const cleaned = String(s || "Customer").replace(/[<>"]+/g, "").trim() || "Customer";
  return /[,;:()@\\]/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtMoney(n) { return "$" + Number(n || 0).toFixed(2); }

function renderBookingHtml(r) {
  const c = r.contact || {};
  const d = r.dates || {};
  const p = r.pricing || {};
  const deliveryLabel = {
    pickup: "Pickup at shop (1732 FM 3277, Livingston)",
    local: "Free delivery (within 25 mi)",
    mid: "Delivery 25–50 mi ($50 flat)",
    extended: "Delivery 50–100 mi ($75 flat)",
  }[r.delivery] || r.delivery || "(not specified)";

  const itemRows = (r.items || []).map(it => `
    <tr>
      <td style="padding:6px 0;">${escHtml(it.name)} × ${it.qty}</td>
      <td style="padding:6px 0; text-align:right;">${fmtMoney(it.lineTotal)}</td>
    </tr>
  `).join("");

  return `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif; max-width:560px; margin:0 auto; padding:1rem;">
    <h2 style="color:#1f5a68; margin:0 0 .5rem;">New rental booking</h2>
    <p style="margin:0 0 1rem; color:#666;">Confirmation code: <b>${escHtml(r.id)}</b></p>

    <h3 style="margin:1rem 0 .35rem;">Customer</h3>
    <table style="width:100%; border-collapse:collapse; font-size:14px;">
      <tr><td style="width:120px; color:#888;">Name</td><td><b>${escHtml(c.name)}</b></td></tr>
      <tr><td style="color:#888;">Phone</td><td><a href="tel:${escHtml(c.phone)}">${escHtml(c.phone)}</a></td></tr>
      <tr><td style="color:#888;">Email</td><td><a href="mailto:${escHtml(c.email)}">${escHtml(c.email)}</a></td></tr>
      ${c.guests ? `<tr><td style="color:#888;">Guests</td><td>${escHtml(c.guests)}</td></tr>` : ""}
      ${(c.street || c.city || c.state || c.zip) ? `<tr><td style="color:#888; vertical-align:top;">Address</td><td>${escHtml(c.street)}${(c.city || c.state || c.zip) ? "<br>" : ""}${escHtml(c.city)}${c.city && (c.state || c.zip) ? ", " : ""}${escHtml(c.state)} ${escHtml(c.zip)}</td></tr>` : ""}
      ${c.address ? `<tr><td style="color:#888; vertical-align:top;">Drop-off</td><td>${escHtml(c.address)}</td></tr>` : ""}
      ${c.notes ? `<tr><td style="color:#888; vertical-align:top;">Notes</td><td>${escHtml(c.notes)}</td></tr>` : ""}
    </table>

    <h3 style="margin:1rem 0 .35rem;">Booking</h3>
    <table style="width:100%; border-collapse:collapse; font-size:14px;">
      <tr><td style="width:120px; color:#888;">Pickup</td><td><b>${escHtml(d.start)}</b> · ${d.pickupTime === "pm" ? "after noon (half day)" : "before noon (full day)"}</td></tr>
      <tr><td style="color:#888;">Return</td><td><b>${escHtml(d.end)}</b> · ${d.dropoffTime === "pm" ? "after noon (full day)" : "before noon (half day)"}</td></tr>
      <tr><td style="color:#888;">Days</td><td>${d.days ?? p.days ?? ""}</td></tr>
      <tr><td style="color:#888;">Delivery</td><td>${escHtml(deliveryLabel)}</td></tr>
    </table>

    <h3 style="margin:1rem 0 .35rem;">Carts</h3>
    <table style="width:100%; border-collapse:collapse; font-size:14px;">${itemRows}</table>

    <table style="width:100%; border-collapse:collapse; font-size:14px; margin-top:1rem; border-top:1px solid #ddd;">
      <tr><td style="padding:6px 0; color:#888;">Subtotal</td><td style="padding:6px 0; text-align:right;">${fmtMoney(p.subtotal)}</td></tr>
      ${p.deliveryFee ? `<tr><td style="padding:6px 0; color:#888;">${escHtml(deliveryLabel)}</td><td style="padding:6px 0; text-align:right;">${fmtMoney(p.deliveryFee)}</td></tr>` : ""}
      ${c.taxExempt ? `<tr><td style="padding:6px 0; color:#8a4a00;"><b>Tax exempt</b> · ${escHtml(c.taxExemptOrg || "")}</td><td style="padding:6px 0; text-align:right; color:#8a4a00;"><b>WAIVED</b></td></tr>` : `<tr><td style="padding:6px 0; color:#888;">Tax</td><td style="padding:6px 0; text-align:right;">${fmtMoney(p.tax)}</td></tr>`}
      <tr style="border-top:1px solid #ddd;"><td style="padding:6px 0;"><b>Total</b></td><td style="padding:6px 0; text-align:right;"><b>${fmtMoney(p.grand)}</b></td></tr>
    </table>

    <p style="margin:1.5rem 0 .25rem; font-size:13px; color:#888;">Reply to this email to message ${escHtml(c.name)} directly.</p>
    <p style="margin:.25rem 0; font-size:12px; color:#aaa;">Booking received ${escHtml(r.ts)} · IP ${escHtml(r.ip || "?")} (${escHtml(r.country || "?")})</p>
  </body></html>`;
}

function renderBookingText(r) {
  const c = r.contact || {};
  const d = r.dates || {};
  const p = r.pricing || {};
  const deliveryLabel = { pickup: "Pickup at shop", local: "Free delivery (within 25 mi)", mid: "Delivery 25-50 mi ($50 flat)", extended: "Delivery 50-100 mi ($75 flat)" }[r.delivery] || r.delivery || "";
  const items = (r.items || []).map(it => `  - ${it.name} x ${it.qty}  ${fmtMoney(it.lineTotal)}`).join("\n");
  return [
    `New rental booking — ${r.id}`,
    ``,
    `Customer`,
    `  Name:     ${c.name}`,
    `  Phone:    ${c.phone}`,
    `  Email:    ${c.email}`,
    (c.street || c.city || c.state || c.zip) ? `  Address:  ${[c.street, [c.city, c.state].filter(Boolean).join(", "), c.zip].filter(Boolean).join(" · ")}` : null,
    c.address ? `  Drop-off: ${c.address}` : null,
    c.notes ? `  Notes:    ${c.notes}` : null,
    c.taxExempt ? `  TAX EXEMPT: ${c.taxExemptOrg || ""}${c.taxExemptNumber ? ` (cert # ${c.taxExemptNumber})` : ""} — certificate on file in /admin/rentals/` : null,
    ``,
    `Booking`,
    `  Pickup:   ${d.start} · ${d.pickupTime === "pm" ? "after noon (half day)" : "before noon (full day)"}`,
    `  Return:   ${d.end} · ${d.dropoffTime === "pm" ? "after noon (full day)" : "before noon (half day)"}`,
    `  Days:     ${d.days ?? p.days ?? ""}`,
    `  Delivery: ${deliveryLabel}`,
    ``,
    `Carts`,
    items,
    ``,
    `Subtotal:  ${fmtMoney(p.subtotal)}`,
    p.deliveryFee ? `Delivery:  ${fmtMoney(p.deliveryFee)}` : null,
    c.taxExempt ? `Tax:       WAIVED (exemption on file)` : `Tax:       ${fmtMoney(p.tax)}`,
    `Total:     ${fmtMoney(p.grand)}`,
    ``,
    `Reply to this email to message ${c.name} directly.`,
  ].filter(Boolean).join("\n");
}

async function listBookings(request, env) {
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  const result = await env.FEEDBACK_KV.list({ prefix: "booking:", limit: KV_LIST_LIMIT });
  const keys = result.keys.slice().reverse();
  const entries = await Promise.all(
    keys.map(async (k) => {
      const raw = await env.FEEDBACK_KV.get(k.name);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    })
  );
  return json({ entries: entries.filter(Boolean) });
}

// Admin-only listing of failed / uncaught booking attempts. Keys live
// under `attempt:<ts>:<id>` with a 30-day TTL. Newest first.
// Public — receives client-side JS errors from the /rentals/ wizard so
// a customer whose browser threw an uncaught exception (or whose
// booking submit never even fired a fetch) still leaves a trace in
// /admin/attempts/. Stored under the same `attempt:*` prefix as the
// server-side booking failures, tagged with outcome:"client".
// Kept public (no auth) so the browser can report errors without a
// session; body is size-capped and rate-limited by IP to keep it from
// being abused as a log pipe.
const CLIENT_ERROR_MAX_BODY = 8_000;
async function receiveClientError(request, env) {
  if (!env?.FEEDBACK_KV) return json({ ok: true }, 204);
  let body;
  try {
    const text = await request.text();
    if (text.length > CLIENT_ERROR_MAX_BODY) {
      return json({ error: "payload too large" }, 413);
    }
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const ip = request.headers.get("cf-connecting-ip") || "";
  // Cheap per-IP rate limit — max 20 client-error reports per hour.
  // Prevents a busted page from a single browser flooding KV.
  if (ip) {
    const key = `client-err-rate:${ip}`;
    const cur = parseInt((await env.FEEDBACK_KV.get(key)) || "0", 10) || 0;
    if (cur >= 20) {
      return json({ ok: true, throttled: true }, 200);
    }
    await env.FEEDBACK_KV.put(key, String(cur + 1), { expirationTtl: 3600 });
  }
  const ts = new Date().toISOString();
  const idSuffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  const record = {
    ts,
    outcome: "client",
    code: null,
    error: String(body?.msg || "client-side error").slice(0, 500),
    context: String(body?.context || "").slice(0, 100),
    stack: String(body?.stack || "").slice(0, 2000),
    pageUrl: String(body?.url || "").slice(0, 500),
    ip,
    ua: (request.headers.get("user-agent") || "").slice(0, 500),
    country: request.cf?.country || "",
    // Best-effort snapshot of the customer's rental state at error time
    contact: body?.state?.contact || null,
    dates: body?.state?.dates || null,
    delivery: body?.state?.delivery || null,
    itemCount: body?.state?.itemCount ?? null,
    step: body?.state?.step ?? null,
  };
  const key = `attempt:${ts}:${idSuffix}`;
  await env.FEEDBACK_KV.put(key, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 30,
  });
  console.error(`client error [${record.context}] ${record.error}`);
  return json({ ok: true, id: idSuffix });
}

// Public — receives per-step "I'm now on step N" beacons from the
// booking wizard. One rolling record per sessionId; each beacon upserts
// the record so /admin/sessions/ shows the latest known state per
// attempt. Also appends a lightweight steps[] audit trail (last 20
// entries) so you can see how someone hopped through the flow.
const SESSION_MAX_BODY = 6_000;
const SESSION_ID_RE = /^sess-[a-z0-9]{4,32}$/i;
async function receiveSessionCheckpoint(request, env) {
  if (!env?.FEEDBACK_KV) return json({ ok: true }, 204);
  let body;
  try {
    const text = await request.text();
    if (text.length > SESSION_MAX_BODY) {
      return json({ error: "payload too large" }, 413);
    }
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const sessionId = String(body?.sessionId || "");
  if (!SESSION_ID_RE.test(sessionId)) {
    return json({ error: "invalid sessionId" }, 400);
  }
  const step = Number.isFinite(+body?.step) ? Math.max(1, Math.min(9, +body.step)) : null;
  const ip = request.headers.get("cf-connecting-ip") || "";
  // Per-IP rate limit — 120/hour is enough for a browsy customer
  // (each step advance + every 400ms of email typing = ~30 beacons/session).
  if (ip) {
    const key = `sess-rate:${ip}`;
    const cur = parseInt((await env.FEEDBACK_KV.get(key)) || "0", 10) || 0;
    if (cur >= 120) return json({ ok: true, throttled: true }, 200);
    await env.FEEDBACK_KV.put(key, String(cur + 1), { expirationTtl: 3600 });
  }

  const key = `session:${sessionId}`;
  const raw = await env.FEEDBACK_KV.get(key);
  let prior = null;
  if (raw) { try { prior = JSON.parse(raw); } catch {} }

  const now = new Date().toISOString();
  const st = body?.state || {};
  const record = {
    sessionId,
    firstSeen: prior?.firstSeen || now,
    lastSeen: now,
    step: step ?? prior?.step ?? null,
    maxStep: Math.max(step || 0, prior?.maxStep || 0),
    // Rolling audit of the last 20 step advances — only push when the
    // step actually changed (avoids padding on every email keystroke).
    steps: (() => {
      const trail = Array.isArray(prior?.steps) ? [...prior.steps] : [];
      const last = trail[trail.length - 1];
      if (step && (!last || last.step !== step)) trail.push({ step, at: now });
      return trail.slice(-20);
    })(),
    contact: {
      name: st?.contact?.name || prior?.contact?.name || null,
      email: st?.contact?.email || prior?.contact?.email || null,
      phone: st?.contact?.phone || prior?.contact?.phone || null,
    },
    dates: st?.dates || prior?.dates || null,
    delivery: st?.delivery || prior?.delivery || null,
    selection: st?.selection || prior?.selection || null,
    ip,
    ua: (request.headers.get("user-agent") || "").slice(0, 500),
    country: request.cf?.country || "",
    // Once a session results in a real booking we don't need to keep
    // tracking it here. The client wipes state.sessionId after Step 5
    // so no more checkpoints arrive; the record just ages out via TTL.
  };
  await env.FEEDBACK_KV.put(key, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 30,  // 30 days
  });
  return json({ ok: true });
}

// Admin listing of all session breadcrumbs. Sorted by lastSeen desc so
// the most recent activity is on top.
async function listSessions(request, env) {
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  const result = await env.FEEDBACK_KV.list({ prefix: "session:", limit: KV_LIST_LIMIT });
  const entries = await Promise.all(
    result.keys.map(async (k) => {
      const raw = await env.FEEDBACK_KV.get(k.name);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    })
  );
  const sessions = entries
    .filter(Boolean)
    .sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  return json({ sessions });
}

async function listBookingAttempts(request, env) {
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  const result = await env.FEEDBACK_KV.list({ prefix: "attempt:", limit: KV_LIST_LIMIT });
  const keys = result.keys.slice().reverse();
  const entries = await Promise.all(
    keys.map(async (k) => {
      const raw = await env.FEEDBACK_KV.get(k.name);
      if (!raw) return null;
      try {
        const rec = JSON.parse(raw);
        rec._key = k.name;
        return rec;
      } catch { return null; }
    })
  );
  return json({ attempts: entries.filter(Boolean) });
}

// Public — used by the /rentals/ wizard to show booked carts as
// disabled tiles. No auth: this only reveals cart IDs and date ranges,
// never customer details. Two ranges overlap when start1 < end2 AND
// end1 > start2 (strict inequality so a return on Day X and a pickup
// on the same Day X don't conflict).
async function checkAvailability(request, env, url) {
  if (!env.FEEDBACK_KV) return json({ booked: [] }); // fail-open
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end) return json({ error: "start and end required" }, 400);

  const booked = new Set();
  let cursor;
  try {
    do {
      const page = await env.FEEDBACK_KV.list({ prefix: "booking:", cursor });
      for (const k of page.keys) {
        const raw = await env.FEEDBACK_KV.get(k.name);
        if (!raw) continue;
        let rec;
        try { rec = JSON.parse(raw); } catch { continue; }
        const bs = rec.dates?.start;
        const be = rec.dates?.end;
        if (bs && be && bs < end && be > start) {
          for (const item of rec.items || []) {
            if (item.id) booked.add(item.id);
          }
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (e) {
    // Anything goes wrong with KV → fail-open: return empty booked
    // list so the frontend shows all carts as available with a
    // "couldn't verify" notice.
    return json({ booked: [], error: String(e?.message || "unknown") });
  }

  return json({ booked: [...booked] });
}

// Lifecycle states the owner can assign from the admin UI. The set is
// closed — any other value gets rejected as a 400 — so we never end up
// with typos in KV that don't match the UI dropdown.
// Owner-facing lifecycle states, in order of progression.
//   new        — freshly submitted, no payment collected yet
//   paid-part  — deposit taken (e.g. 50% for a booking 3+ months out)
//   paid-full  — balance settled
//   complete   — cart returned, rental closed out (fires the customer
//                thank-you email on first transition into this state).
// Legacy records may still carry the older "picked-up", "delivered",
// or "returned" values from before 2026-09-10; those still render in
// the pill via the label map, but re-picking a status from the admin
// dropdown moves them onto the new set.
const BOOKING_STATUSES = ["new", "paid-part", "paid-full", "complete"];
const LEGACY_STATUSES = ["picked-up", "delivered", "returned"];

// Generic PATCH on /api/booking/<PCGC-XXXXXX>. Accepts:
//   - status: one of BOOKING_STATUSES  → runs the lifecycle update
//     (writes statusUpdatedAt; fires the customer thank-you email on
//     the first transition to "returned")
//   - edit:   { items, dates, contact, delivery, pricing, notes }
//             → merges the whitelisted fields onto the record so the
//             owner can swap a cart, correct a date, fix a typo in
//             contact info, etc., from /admin/rentals/. Fields not
//             listed here are ignored so a stray payload key can't
//             overwrite immutable data (id, ts, agreement, payment).
// A single PATCH may include both — status update + field edit — and
// they land in one KV write.
async function updateBookingStatus(request, env, url) {
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);

  const id = decodeURIComponent(url.pathname.replace(/^\/api\/booking\//, ""));
  if (!id) return json({ error: "id required" }, 400);

  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid body" }, 400); }

  const hasStatus = body && Object.prototype.hasOwnProperty.call(body, "status");
  const hasEdit = body && body.edit && typeof body.edit === "object";
  if (!hasStatus && !hasEdit) {
    return json({ error: "body must include 'status' and/or 'edit'" }, 400);
  }
  if (hasStatus && !BOOKING_STATUSES.includes(body.status)) {
    return json({ error: "invalid status", allowed: BOOKING_STATUSES }, 400);
  }

  // Linear scan KV for the matching id. Booking volume is low (single
  // dealer, manual workflow), so this is fine; if it ever grows we'd
  // add a secondary id->key index.
  let match = null;
  let cursor;
  do {
    const page = await env.FEEDBACK_KV.list({ prefix: "booking:", cursor });
    for (const k of page.keys) {
      const raw = await env.FEEDBACK_KV.get(k.name);
      if (!raw) continue;
      let rec;
      try { rec = JSON.parse(raw); } catch { continue; }
      if (rec.id === id) { match = { key: k.name, rec }; break; }
    }
    if (match) break;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (!match) return json({ error: "booking not found", id }, 404);

  const now = new Date().toISOString();
  let statusChange = null;
  let editApplied = null;

  // ---- Apply status change (if any) ----
  const prevStatus = match.rec.status || "new";
  if (hasStatus && body.status !== prevStatus) {
    match.rec.status = body.status;
    match.rec.statusUpdatedAt = now;
    statusChange = { prev: prevStatus, next: body.status };
  }

  // ---- Apply field edits (if any) ----
  if (hasEdit) {
    const EDITABLE = ["items", "dates", "contact", "delivery", "pricing", "notes"];
    const changed = [];
    for (const key of EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(body.edit, key)) {
        const val = body.edit[key];
        // Shallow validate a couple of shapes so a malformed payload
        // doesn't corrupt the record.
        if (key === "items" && !Array.isArray(val)) continue;
        if (key === "dates" && (val === null || typeof val !== "object")) continue;
        if (key === "contact" && (val === null || typeof val !== "object")) continue;
        if (key === "pricing" && (val === null || typeof val !== "object")) continue;
        match.rec[key] = val;
        changed.push(key);
      }
    }
    if (changed.length) {
      match.rec.editedAt = now;
      // Keep a small append-only audit trail so we can see who
      // touched what over time. Cap length so it can't balloon.
      const trail = Array.isArray(match.rec.edits) ? match.rec.edits : [];
      trail.push({ at: now, fields: changed });
      match.rec.edits = trail.slice(-20);
      editApplied = { fields: changed };
    }
  }

  if (!statusChange && !editApplied) {
    return json({ ok: true, unchanged: true, id });
  }

  await env.FEEDBACK_KV.put(match.key, JSON.stringify(match.rec));

  // Fire the thank-you email the first time a booking lands on
  // "complete". Cheap belt-and-suspenders equality check even though
  // the parent block already guarded `hasStatus && body.status !== prevStatus`.
  // At the same time, schedule the 5-day follow-up review email via
  // Resend's scheduled_at — the ONE-time transition guard prevents
  // a status toggle-and-toggle-back from queueing a second follow-up.
  let emailResult = null;
  let followupResult = null;
  if (statusChange && statusChange.next === "complete" && statusChange.prev !== "complete") {
    if (env.RESEND_API_KEY) {
      try {
        await sendThankYouEmail(match.rec, env);
        emailResult = "sent";
      } catch (e) {
        emailResult = "failed: " + (e?.message || String(e));
        console.error("thank-you email failed:", emailResult);
      }
      if (!match.rec.reviewFollowupScheduled) {
        try {
          const meta = await sendReviewFollowupEmail(match.rec, env);
          match.rec.reviewFollowupScheduled = true;
          match.rec.reviewFollowupAt = meta?.scheduledAt || null;
          match.rec.reviewFollowupResendId = meta?.resendId || null;
          followupResult = meta?.scheduledAt
            ? "scheduled for " + meta.scheduledAt
            : "sent immediately (end date already past)";
          // Persist the flag alongside the record so a toggle-back
          // + toggle-forward doesn't queue a duplicate followup.
          await env.FEEDBACK_KV.put(match.key, JSON.stringify(match.rec));
        } catch (e) {
          followupResult = "failed: " + (e?.message || String(e));
          console.error("review follow-up failed:", followupResult);
        }
      } else {
        followupResult = "skipped (already scheduled previously)";
      }
    } else {
      emailResult = "skipped (no RESEND_API_KEY)";
      followupResult = "skipped (no RESEND_API_KEY)";
    }
  }

  return json({
    ok: true,
    id,
    status: match.rec.status,
    prevStatus,
    statusChange,
    editApplied,
    email: emailResult,
    followup: followupResult,
  });
}

async function deleteBooking(request, env, url) {
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);

  const id = decodeURIComponent(url.pathname.replace(/^\/api\/booking\//, ""));
  if (!id) return json({ error: "id required" }, 400);

  let match = null;
  let cursor;
  do {
    const page = await env.FEEDBACK_KV.list({ prefix: "booking:", cursor });
    for (const k of page.keys) {
      const raw = await env.FEEDBACK_KV.get(k.name);
      if (!raw) continue;
      let rec;
      try { rec = JSON.parse(raw); } catch { continue; }
      if (rec.id === id) { match = { key: k.name, rec }; break; }
    }
    if (match) break;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (!match) return json({ error: "booking not found", id }, 404);

  await env.FEEDBACK_KV.delete(match.key);
  return json({ ok: true, deleted: id });
}

// -------------------- Service requests --------------------
// Public POST endpoint that captures a "please service my cart" lead
// from /services/request/. Sends the owner a notification email so it
// hits their inbox in real time, and persists the record under
// `service-request:<ts>:<id>` for the /admin/service-requests/ viewer.
// Field-size caps prevent someone from stuffing a novel into the notes.
const SR_MAX_LEN = { name: 200, phone: 40, email: 200, address: 400, cartType: 60, cartModel: 200, reason: 4000 };
async function submitServiceRequest(request, env) {
  if (!env.FEEDBACK_KV) return json({ error: "storage not configured" }, 503);
  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "invalid JSON" }, 400); }

  const clean = (v, cap) => String(v ?? "").slice(0, cap).trim();
  const rec = {
    name: clean(payload.name, SR_MAX_LEN.name),
    phone: clean(payload.phone, SR_MAX_LEN.phone),
    email: clean(payload.email, SR_MAX_LEN.email),
    address: clean(payload.address, SR_MAX_LEN.address),
    cartType: clean(payload.cartType, SR_MAX_LEN.cartType),
    cartModel: clean(payload.cartModel, SR_MAX_LEN.cartModel),
    reason: clean(payload.reason, SR_MAX_LEN.reason),
  };
  const missing = [];
  if (!rec.name) missing.push("name");
  if (!rec.phone) missing.push("phone");
  if (!rec.email) missing.push("email");
  if (!rec.address) missing.push("address");
  if (!rec.cartType) missing.push("cart type");
  if (!rec.reason) missing.push("reason");
  if (missing.length) return json({ error: `Missing: ${missing.join(", ")}` }, 400);
  if (!/^\S+@\S+\.\S+$/.test(rec.email)) return json({ error: "invalid email" }, 400);

  const ts = new Date().toISOString();
  const idSuffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  const id = "PCGC-SR-" + idSuffix;

  const record = {
    ...rec,
    id, ts,
    status: "new",
    ua: (request.headers.get("user-agent") || "").slice(0, 500),
    ip: request.headers.get("cf-connecting-ip") || "",
    country: request.cf?.country || "",
  };
  await env.FEEDBACK_KV.put(`service-request:${ts}:${idSuffix}`, JSON.stringify(record));

  // Notify the shop (owner + notification email). Failure here must
  // never fail the whole submit — the record's already saved in KV.
  let ownerEmailResult = null;
  if (env.RESEND_API_KEY) {
    try {
      await sendServiceRequestEmail(record, env);
      ownerEmailResult = "sent";
    } catch (e) {
      ownerEmailResult = "failed: " + (e?.message || String(e));
      console.error("service-request email failed:", ownerEmailResult);
    }
  } else {
    ownerEmailResult = "skipped (no RESEND_API_KEY)";
  }

  return json({ ok: true, id, ownerEmail: ownerEmailResult });
}

async function sendServiceRequestEmail(record, env) {
  const from = env.BOOKING_FROM_EMAIL || "bookings@polkcountygolfcarts.com";
  const to = env.BOOKING_TO_EMAIL || "polkcountygolfcarts@yahoo.com";
  const subject = `New service request · ${record.name} · ${record.cartType}`;
  const html = `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif; max-width:560px; margin:0 auto; padding:1rem; color:#222;">
    <h2 style="color:#1f5a68; margin:0 0 .5rem;">New service request</h2>
    <p style="margin:0 0 1rem; color:#666;">Reference: <b>${escHtml(record.id)}</b></p>

    <table style="width:100%; border-collapse:collapse; font-size:14px;">
      <tr><td style="width:130px; color:#888; padding:6px 0;">Name</td><td style="padding:6px 0;"><b>${escHtml(record.name)}</b></td></tr>
      <tr><td style="color:#888; padding:6px 0;">Phone</td><td style="padding:6px 0;"><a href="tel:${escHtml(record.phone)}">${escHtml(record.phone)}</a></td></tr>
      <tr><td style="color:#888; padding:6px 0;">Email</td><td style="padding:6px 0;"><a href="mailto:${escHtml(record.email)}">${escHtml(record.email)}</a></td></tr>
      <tr><td style="color:#888; padding:6px 0; vertical-align:top;">Address</td><td style="padding:6px 0;">${escHtml(record.address)}</td></tr>
      <tr><td style="color:#888; padding:6px 0;">Cart type</td><td style="padding:6px 0;"><b>${escHtml(record.cartType)}</b></td></tr>
      ${record.cartModel ? `<tr><td style="color:#888; padding:6px 0;">Model / year</td><td style="padding:6px 0;">${escHtml(record.cartModel)}</td></tr>` : ""}
    </table>

    <h3 style="margin:1.2rem 0 .35rem; color:#1f5a68; font-size:15px;">What they need</h3>
    <div style="background:#fbf8f3; border:1px solid #ecd9c7; border-radius:8px; padding:.85rem 1rem; white-space:pre-wrap; font-size:14px;">${escHtml(record.reason)}</div>

    <p style="margin:1.5rem 0 .25rem; font-size:13px; color:#888;">Reply to this email to message ${escHtml(record.name)} directly · or call <a href="tel:${escHtml(record.phone)}">${escHtml(record.phone)}</a>.</p>
    <p style="margin:.25rem 0; font-size:12px; color:#aaa;">Received ${escHtml(record.ts)} · ${escHtml(record.ip || "?")} (${escHtml(record.country || "?")}) · <a href="https://polkcountygolfcarts.com/admin/service-requests/" style="color:#1f5a68;">/admin/service-requests/</a></p>
  </body></html>`;

  const text = [
    `New service request — ${record.id}`,
    ``,
    `Name:      ${record.name}`,
    `Phone:     ${record.phone}`,
    `Email:     ${record.email}`,
    `Address:   ${record.address}`,
    `Cart type: ${record.cartType}`,
    record.cartModel ? `Model:     ${record.cartModel}` : null,
    ``,
    `What they need:`,
    record.reason,
    ``,
    `Received ${record.ts}`,
    `Reply to this email to message ${record.name} directly.`,
  ].filter(Boolean).join("\n");

  const replyTo = record.email
    ? `${record.name} <${record.email}>`
    : undefined;

  const body = {
    from: `Online Cart Rentals <${from}>`,
    to: [to],
    subject,
    html,
    text,
  };
  if (replyTo) body.reply_to = replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "authorization": `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`resend ${res.status}: ${t}`);
  }
}

// Admin listing of service requests, newest first.
async function listServiceRequests(request, env) {
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  const result = await env.FEEDBACK_KV.list({ prefix: "service-request:", limit: KV_LIST_LIMIT });
  const keys = result.keys.slice().reverse();
  const entries = await Promise.all(
    keys.map(async (k) => {
      const raw = await env.FEEDBACK_KV.get(k.name);
      if (!raw) return null;
      try {
        const rec = JSON.parse(raw);
        rec._key = k.name;
        return rec;
      } catch { return null; }
    })
  );
  return json({ entries: entries.filter(Boolean) });
}

// Admin delete of a service request by its PCGC-SR-XXXXXX id.
async function deleteServiceRequest(request, env, url) {
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const id = decodeURIComponent(url.pathname.replace(/^\/api\/service-requests\//, ""));
  if (!id) return json({ error: "id required" }, 400);
  let match = null;
  let cursor;
  do {
    const page = await env.FEEDBACK_KV.list({ prefix: "service-request:", cursor });
    for (const k of page.keys) {
      const raw = await env.FEEDBACK_KV.get(k.name);
      if (!raw) continue;
      let rec;
      try { rec = JSON.parse(raw); } catch { continue; }
      if (rec.id === id) { match = { key: k.name }; break; }
    }
    if (match) break;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (!match) return json({ error: "service request not found", id }, 404);
  await env.FEEDBACK_KV.delete(match.key);
  return json({ ok: true, deleted: id });
}

// -------------------- Cart listings (/carts2/) --------------------
// A listing is a single golf cart for sale. Records live under
// `listing:<slug>` as JSON (small — just text fields + image id
// references). Each uploaded image lives under its own key
// `listing-img:<slug>:<imgId>` holding a single data URL so a listing
// with lots of photos doesn't bloat the main record and images lazy-
// load as separate HTTP responses with cache headers.
//
// Fields on a listing record:
//   slug           URL-safe id (lowercase, 2-80 chars, user-set)
//   condition      "new" | "used"
//   status         "draft" | "active" | "sold"
//   make, model, year, color
//   seats, drivetrain ("electric" | "gas")
//   price_cents, msrp_cents (optional)
//   mileage_hours, condition_notes (used only)
//   top_speed_mph, range_mi, battery, motor, drive_type
//   street_legal (boolean)
//   headline, summary, description
//   features (array of strings)
//   images: [{ id, alt, order }]
//   seo_title, seo_description (optional overrides)
//   created_at, updated_at

const LISTING_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const LISTING_IMG_MAX = 20;
const LISTING_IMG_MAX_BYTES = 2_500_000;       // ~1.8 MB source → base64 ≈ 2.5 MB
const LISTING_RECORD_MAX_BYTES = 60_000;       // text record cap

async function listListings(request, env, url) {
  if (!env.FEEDBACK_KV) return json({ listings: [] });
  const condition = url.searchParams.get("condition");  // "new" | "used" | null
  const includeDraft = url.searchParams.get("includeDraft") === "1";
  // Draft inclusion requires admin auth so public /carts2/ listing
  // only ever sees published records.
  if (includeDraft) {
    const auth = await checkAdminAuth(request, env);
    if (auth) return auth;
  }

  const list = await env.FEEDBACK_KV.list({ prefix: "listing:", limit: 200 });
  const entries = await Promise.all(list.keys.map(async (k) => {
    const raw = await env.FEEDBACK_KV.get(k.name);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }));
  let listings = entries.filter(Boolean);
  if (!includeDraft) listings = listings.filter(l => l.status === "active");
  if (condition === "new" || condition === "used") {
    listings = listings.filter(l => l.condition === condition);
  }
  // Newest first by created_at
  listings.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  // Strip to the fields the landing-page tiles actually render; keep
  // things lean so the list request is a small payload.
  const trim = listings.map(l => ({
    slug: l.slug,
    condition: l.condition,
    status: l.status,
    year: l.year,
    make: l.make,
    model: l.model,
    color: l.color,
    seats: l.seats,
    drivetrain: l.drivetrain,
    price_cents: l.price_cents,
    msrp_cents: l.msrp_cents,
    mileage_hours: l.mileage_hours,
    headline: l.headline,
    hero_image_id: Array.isArray(l.images) && l.images[0] ? l.images[0].id : null,
    created_at: l.created_at,
  }));
  return json({ listings: trim });
}

async function getListing(request, env, slug) {
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const raw = await env.FEEDBACK_KV.get(`listing:${slug}`);
  if (!raw) return json({ error: "listing not found" }, 404);
  let rec;
  try { rec = JSON.parse(raw); } catch { return json({ error: "listing malformed" }, 500); }
  if (rec.status !== "active") {
    const auth = await checkAdminAuth(request, env);
    if (auth) return auth;
  }
  return json(rec);
}

function sanitizeListingPayload(body, existing) {
  // Whitelist + coerce. existing provided on PATCH so we can preserve
  // any field the client didn't send.
  const out = existing ? { ...existing } : {};
  const copy = (key, type = "string", opts = {}) => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return;
    const raw = body[key];
    if (raw === null) { out[key] = null; return; }
    if (type === "string") out[key] = String(raw).slice(0, opts.max || 2000);
    else if (type === "number") { const n = Number(raw); if (Number.isFinite(n)) out[key] = n; }
    else if (type === "int") { const n = parseInt(raw, 10); if (Number.isFinite(n)) out[key] = n; }
    else if (type === "bool") out[key] = !!raw;
    else if (type === "array") out[key] = Array.isArray(raw) ? raw.slice(0, 50).map(x => String(x).slice(0, 300)) : [];
    else if (type === "enum" && Array.isArray(opts.values) && opts.values.includes(raw)) out[key] = raw;
  };
  copy("condition", "enum", { values: ["new", "used"] });
  copy("status", "enum", { values: ["draft", "active", "sold"] });
  copy("make", "string", { max: 80 });
  copy("model", "string", { max: 120 });
  copy("year", "int");
  copy("color", "string", { max: 60 });
  copy("seats", "int");
  copy("drivetrain", "enum", { values: ["electric", "gas"] });
  copy("price_cents", "int");
  copy("msrp_cents", "int");
  copy("mileage_hours", "number");
  copy("condition_notes", "string", { max: 2000 });
  copy("top_speed_mph", "number");
  copy("range_mi", "string", { max: 60 });
  copy("battery", "string", { max: 200 });
  copy("motor", "string", { max: 200 });
  copy("drive_type", "string", { max: 60 });
  copy("ground_clearance_in", "number");
  copy("length_in", "number");
  copy("width_in", "number");
  copy("height_in", "number");
  copy("weight_lbs", "number");
  copy("tire", "string", { max: 120 });
  copy("warranty", "string", { max: 300 });
  copy("tech", "string", { max: 400 });
  copy("street_legal", "bool");
  copy("headline", "string", { max: 180 });
  copy("summary", "string", { max: 600 });
  copy("description", "string", { max: 8000 });
  copy("features", "array");
  copy("seo_title", "string", { max: 180 });
  copy("seo_description", "string", { max: 400 });
  return out;
}

async function createListing(request, env) {
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid JSON" }, 400); }
  const slug = String(body?.slug || "").toLowerCase().trim();
  if (!LISTING_SLUG_RE.test(slug)) {
    return json({ error: "slug must be lowercase letters, numbers and dashes, 2-80 chars" }, 400);
  }
  // Prevent clobbering an existing listing with a POST
  const existing = await env.FEEDBACK_KV.get(`listing:${slug}`);
  if (existing) return json({ error: `slug "${slug}" already exists; use PATCH to update` }, 409);

  const now = new Date().toISOString();
  const record = {
    slug,
    condition: "used",
    status: "draft",
    images: [],
    features: [],
    ...sanitizeListingPayload(body, {}),
    slug,  // ensure slug always matches the key
    created_at: now,
    updated_at: now,
  };
  const payload = JSON.stringify(record);
  if (payload.length > LISTING_RECORD_MAX_BYTES) return json({ error: "listing payload too large" }, 413);
  await env.FEEDBACK_KV.put(`listing:${slug}`, payload);
  return json({ ok: true, listing: record });
}

async function updateListing(request, env, slug) {
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const raw = await env.FEEDBACK_KV.get(`listing:${slug}`);
  if (!raw) return json({ error: "listing not found" }, 404);
  let existing;
  try { existing = JSON.parse(raw); } catch { return json({ error: "listing malformed" }, 500); }
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid JSON" }, 400); }
  const merged = sanitizeListingPayload(body, existing);
  merged.slug = slug;
  merged.updated_at = new Date().toISOString();
  // images[] is only edited through the dedicated endpoints below, so
  // a stray `images` field in a PATCH body is ignored.
  merged.images = existing.images || [];
  const payload = JSON.stringify(merged);
  if (payload.length > LISTING_RECORD_MAX_BYTES) return json({ error: "listing payload too large" }, 413);
  await env.FEEDBACK_KV.put(`listing:${slug}`, payload);
  return json({ ok: true, listing: merged });
}

async function deleteListing(request, env, slug) {
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const raw = await env.FEEDBACK_KV.get(`listing:${slug}`);
  if (!raw) return json({ error: "listing not found" }, 404);
  let rec;
  try { rec = JSON.parse(raw); } catch { rec = { images: [] }; }
  // Delete every image key for this listing + the record itself.
  for (const img of rec.images || []) {
    try { await env.FEEDBACK_KV.delete(`listing-img:${slug}:${img.id}`); } catch {}
  }
  await env.FEEDBACK_KV.delete(`listing:${slug}`);
  return json({ ok: true, deleted: slug });
}

// POST /api/listings/:slug/images  { data: "data:image/jpeg;base64,...", alt: "..." }
async function addListingImage(request, env, slug) {
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const raw = await env.FEEDBACK_KV.get(`listing:${slug}`);
  if (!raw) return json({ error: "listing not found" }, 404);
  let listing;
  try { listing = JSON.parse(raw); } catch { return json({ error: "listing malformed" }, 500); }
  listing.images = Array.isArray(listing.images) ? listing.images : [];
  if (listing.images.length >= LISTING_IMG_MAX) {
    return json({ error: `Max ${LISTING_IMG_MAX} images per listing — delete one first` }, 409);
  }
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid JSON" }, 400); }
  const dataUrl = String(body?.data || "");
  if (!/^data:image\/(jpeg|png|webp|gif);base64,/i.test(dataUrl)) {
    return json({ error: "image must be a JPG/PNG/WebP/GIF data URL" }, 400);
  }
  if (dataUrl.length > LISTING_IMG_MAX_BYTES) {
    return json({ error: `image too large (max ~1.8MB; got ${(dataUrl.length / 1_000_000).toFixed(1)}MB)` }, 413);
  }
  const imgId = "img_" + crypto.randomUUID().slice(0, 10);
  const alt = String(body?.alt || "").slice(0, 300);
  await env.FEEDBACK_KV.put(`listing-img:${slug}:${imgId}`, dataUrl);
  listing.images.push({ id: imgId, alt });
  listing.updated_at = new Date().toISOString();
  await env.FEEDBACK_KV.put(`listing:${slug}`, JSON.stringify(listing));
  return json({ ok: true, image: { id: imgId, alt } });
}

async function deleteListingImage(request, env, slug, imgId) {
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const raw = await env.FEEDBACK_KV.get(`listing:${slug}`);
  if (!raw) return json({ error: "listing not found" }, 404);
  let listing;
  try { listing = JSON.parse(raw); } catch { return json({ error: "listing malformed" }, 500); }
  listing.images = (listing.images || []).filter(i => i.id !== imgId);
  listing.updated_at = new Date().toISOString();
  await env.FEEDBACK_KV.put(`listing:${slug}`, JSON.stringify(listing));
  await env.FEEDBACK_KV.delete(`listing-img:${slug}:${imgId}`);
  return json({ ok: true, deleted: imgId });
}

async function getListingImage(request, env, slug, imgId) {
  if (!env.FEEDBACK_KV) return new Response("kv not configured", { status: 503 });
  const dataUrl = await env.FEEDBACK_KV.get(`listing-img:${slug}:${imgId}`);
  if (!dataUrl) return new Response("not found", { status: 404 });
  const match = dataUrl.match(/^data:(image\/[a-zA-Z]+);base64,(.*)$/);
  if (!match) return new Response("malformed image", { status: 500 });
  const contentType = match[1];
  const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      "content-type": contentType,
      // CF caches on the edge; browsers for a day. Images are mutable
      // via the admin, but delete-then-re-upload gets a new imgId so
      // the URL changes — safe to cache aggressively.
      "cache-control": "public, max-age=86400, s-maxage=86400",
    },
  });
}

// ----- Server-rendered /carts2/<slug>/ detail page (SEO/AEO) -----
function escHtmlNode(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

async function renderListingDetailPage(request, env, slug) {
  const raw = env.FEEDBACK_KV ? await env.FEEDBACK_KV.get(`listing:${slug}`) : null;
  if (!raw) {
    // Fall through to env.ASSETS for the 404 page
    return env.ASSETS.fetch(request);
  }
  let listing;
  try { listing = JSON.parse(raw); }
  catch { return env.ASSETS.fetch(request); }
  if (listing.status !== "active") return env.ASSETS.fetch(request);

  const dollars = c => c == null ? null : "$" + Math.round(Number(c) / 100).toLocaleString();
  const title = listing.seo_title
    || `${listing.year ? listing.year + " " : ""}${listing.make || "Golf cart"}${listing.model ? " " + listing.model : ""}${listing.color ? " · " + listing.color : ""} ${listing.condition === "new" ? "— New" : "— Used"} · Polk County Golf Carts`;
  const desc = listing.seo_description
    || listing.summary
    || `${listing.condition === "new" ? "Brand-new" : "Used"} ${listing.make || "golf cart"}${listing.model ? " " + listing.model : ""} for sale at Polk County Golf Carts in Livingston, TX. Free pickup within 25 mi, extended service up to 75.`;
  const url = `https://polkcountygolfcarts.com/carts2/${listing.slug}/`;
  const hero = listing.images && listing.images[0]
    ? `https://polkcountygolfcarts.com/api/listings/${listing.slug}/image/${listing.images[0].id}`
    : "https://polkcountygolfcarts.com/assets/og/carts.png?v=v2sunset";

  // Product JSON-LD — gives Google rich snippets + feeds ChatGPT/Perplexity
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": `${listing.year || ""} ${listing.make || ""} ${listing.model || ""}`.trim(),
    "description": desc,
    "url": url,
    "image": listing.images?.map(i => `https://polkcountygolfcarts.com/api/listings/${listing.slug}/image/${i.id}`) || [hero],
    "sku": listing.slug,
    "brand": { "@type": "Brand", "name": listing.make || "Polk County Golf Carts" },
    ...(listing.color ? { "color": listing.color } : {}),
    ...(listing.year ? { "productionDate": String(listing.year) } : {}),
    "offers": {
      "@type": "Offer",
      "url": url,
      "priceCurrency": "USD",
      ...(listing.price_cents ? { "price": (listing.price_cents / 100).toFixed(2) } : { "price": "0.00" }),
      "availability": listing.status === "sold" ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
      "itemCondition": listing.condition === "new"
        ? "https://schema.org/NewCondition" : "https://schema.org/UsedCondition",
      "seller": { "@type": "AutoDealer", "name": "Polk County Golf Carts",
        "telephone": "+1-936-223-1182",
        "address": { "@type": "PostalAddress", "streetAddress": "1732 FM 3277",
          "addressLocality": "Livingston", "addressRegion": "TX", "postalCode": "77351", "addressCountry": "US" } },
    },
  };

  const gallery = (listing.images || []).map(img => `
    <div class="d-gallery-item">
      <img src="/api/listings/${listing.slug}/image/${img.id}" alt="${escHtmlNode(img.alt || `${listing.make || ""} ${listing.model || ""}`.trim())}" loading="lazy">
    </div>`).join("");

  const specRow = (label, value) => value == null || value === "" ? "" :
    `<tr><th>${escHtmlNode(label)}</th><td>${escHtmlNode(value)}</td></tr>`;

  const featureBullets = (listing.features || []).map(f => `<li>${escHtmlNode(f)}</li>`).join("");

  const descriptionHtml = (listing.description || "")
    .split(/\n{2,}/).map(p => `<p>${escHtmlNode(p).replace(/\n/g, "<br>")}</p>`).join("");

  const priceLabel = dollars(listing.price_cents) || "Call for pricing";
  const msrpLabel = dollars(listing.msrp_cents);
  const savings = listing.msrp_cents && listing.price_cents && listing.msrp_cents > listing.price_cents
    ? dollars(listing.msrp_cents - listing.price_cents) : null;
  const conditionBadge = listing.condition === "new" ? "New" : "Used";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtmlNode(title)}</title>
  <meta name="description" content="${escHtmlNode(desc)}">
  <link rel="canonical" href="${url}">
  <meta name="theme-color" content="#e85a4f">
  <link rel="icon" type="image/png" href="/assets/logos/favicon.png">
  <meta property="og:title" content="${escHtmlNode(title)}">
  <meta property="og:description" content="${escHtmlNode(desc)}">
  <meta property="og:image" content="${hero}">
  <meta property="og:url" content="${url}">
  <meta property="og:type" content="product">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escHtmlNode(title)}">
  <meta name="twitter:description" content="${escHtmlNode(desc)}">
  <meta name="twitter:image" content="${hero}">
  <link rel="stylesheet" href="/assets/site.css?v=carts2v1">
  <style>
    .d-detail { max-width: 1120px; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
    .d-crumbs { font-size: .85rem; color: var(--ink-soft); margin-bottom: 1rem; }
    .d-crumbs a { color: var(--teal-dk); text-decoration: none; }
    .d-crumbs a:hover { text-decoration: underline; }

    .d-hero { display: grid; grid-template-columns: 1.1fr 1fr; gap: 2.5rem; margin-bottom: 3rem; align-items: start; }
    @media (max-width: 900px) { .d-hero { grid-template-columns: 1fr; gap: 1.5rem; } }

    .d-main-img { aspect-ratio: 4/3; border-radius: 16px; overflow: hidden; background: #f4efe4; box-shadow: 0 10px 40px rgba(31,90,104,.1); }
    .d-main-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .d-main-img.empty { display: flex; align-items: center; justify-content: center; color: var(--ink-soft); font-size: 1.1rem; }

    .d-thumbs { display: grid; grid-template-columns: repeat(5, 1fr); gap: .5rem; margin-top: .65rem; }
    .d-thumb { aspect-ratio: 1/1; border-radius: 8px; overflow: hidden; background: #f4efe4; cursor: pointer; opacity: .75; transition: opacity .15s; border: 2px solid transparent; }
    .d-thumb:hover, .d-thumb.active { opacity: 1; border-color: var(--coral); }
    .d-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

    .d-pitch .d-badges { display: flex; gap: .5rem; margin-bottom: .75rem; }
    .d-badge { display: inline-block; padding: .35rem .8rem; border-radius: 999px; font: 700 .78rem/1 system-ui, sans-serif; letter-spacing: .05em; text-transform: uppercase; }
    .d-badge.new { background: #dff0e1; color: #2f6b3b; }
    .d-badge.used { background: #e6f1f3; color: #1f5a68; }
    .d-badge.sold { background: #f8e3e1; color: #8a2a20; }
    .d-pitch h1 { font: 700 clamp(1.8rem, 4vw, 2.6rem)/1.1 Georgia, serif; color: var(--teal-dk); margin: 0 0 .5rem; }
    .d-pitch .d-headline { color: var(--ink); font-size: 1.1rem; margin: 0 0 1.25rem; }

    .d-price-block { background: #fbf8f3; border: 1px solid var(--line); border-radius: 12px; padding: 1.2rem 1.4rem; margin: 1.25rem 0; }
    .d-price-block .d-price { font: 800 2.2rem/1 Georgia, serif; color: var(--coral); display: block; }
    .d-price-block .d-msrp { color: var(--ink-soft); text-decoration: line-through; font-size: .95rem; margin-left: .55rem; }
    .d-price-block .d-savings { display: inline-block; margin-left: .55rem; background: #dff0e1; color: #2f6b3b; padding: .15rem .55rem; border-radius: 999px; font-size: .78rem; font-weight: 700; }
    .d-price-block .d-pcall { font: 700 1.5rem/1 Georgia, serif; color: var(--teal-dk); }

    .d-ctas { display: flex; gap: .75rem; flex-wrap: wrap; margin: 1rem 0 1.25rem; }
    .d-ctas .btn { font-size: .95rem; padding: .75rem 1.2rem; }

    .d-quickspecs { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--line); }
    .d-quickspecs .d-spec { color: var(--ink); }
    .d-quickspecs .d-spec b { display: block; color: var(--teal-dk); font-size: 1.05rem; }
    .d-quickspecs .d-spec span { color: var(--ink-soft); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }

    .d-section { margin: 3rem 0; }
    .d-section h2 { font: 700 clamp(1.4rem, 3vw, 1.8rem)/1.2 Georgia, serif; color: var(--teal-dk); margin: 0 0 1.25rem; }
    .d-split { display: grid; grid-template-columns: 1fr 1fr; gap: 2.5rem; align-items: start; }
    @media (max-width: 820px) { .d-split { grid-template-columns: 1fr; gap: 1.5rem; } }
    .d-split .d-split-img { aspect-ratio: 4/3; border-radius: 12px; overflow: hidden; background: #f4efe4; }
    .d-split .d-split-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .d-split p { color: var(--ink); font-size: 1rem; line-height: 1.6; margin: 0 0 1rem; }
    .d-split ul.d-features { list-style: none; padding: 0; margin: 1rem 0; }
    .d-split ul.d-features li { padding: .4rem 0 .4rem 1.75rem; position: relative; color: var(--ink); font-size: 1rem; }
    .d-split ul.d-features li::before { content: "✓"; position: absolute; left: 0; color: var(--coral); font-weight: 900; }

    .d-specs-table { width: 100%; border-collapse: collapse; font-size: .95rem; background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
    .d-specs-table th, .d-specs-table td { padding: .75rem 1rem; text-align: left; border-bottom: 1px solid var(--line); }
    .d-specs-table th { background: #fbf8f3; color: var(--ink-soft); font-weight: 600; width: 42%; }
    .d-specs-table tr:last-child th, .d-specs-table tr:last-child td { border-bottom: 0; }

    .d-gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: .75rem; margin-top: 1.5rem; }
    @media (max-width: 700px) { .d-gallery { grid-template-columns: repeat(2, 1fr); } }
    .d-gallery-item { aspect-ratio: 4/3; border-radius: 10px; overflow: hidden; background: #f4efe4; }
    .d-gallery-item img { width: 100%; height: 100%; object-fit: cover; display: block; }

    .d-cta-band { background: linear-gradient(135deg, var(--teal-dk) 0%, #164550 100%); color: #fff; border-radius: 16px; padding: 2.5rem 2rem; text-align: center; margin: 3rem 0; }
    .d-cta-band h2 { color: #fff; margin: 0 0 .5rem; font: 700 1.5rem/1.2 Georgia, serif; }
    .d-cta-band p { color: #d6ecf0; margin: 0 0 1.5rem; }
    .d-cta-band .btn { font-size: 1rem; padding: .85rem 1.6rem; }
    .d-cta-band .btn.btn-coral:hover { filter: brightness(1.1); }
  </style>
  <script type="application/ld+json">${JSON.stringify(jsonld)}</script>
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/">
        <img src="/assets/logos/logo-color.png" alt="Polk County Golf Carts" width="60" height="60">
        <span class="brand-word">Polk County Golf Carts<small>Livingston, TX</small></span>
      </a>
      <nav class="site-nav">
        <a href="/carts2/">Carts</a>
        <a href="/rentals/">Rentals</a>
        <a href="/services/">Service</a>
        <a href="/financing/">Financing</a>
        <a href="/about-us/">About</a>
        <a class="btn btn-coral" href="tel:9362231182">📞 936-223-1182</a>
      </nav>
    </div>
  </header>

  <main class="d-detail">
    <nav class="d-crumbs">
      <a href="/">Home</a> › <a href="/carts2/">Carts for sale</a> › ${escHtmlNode(`${listing.year || ""} ${listing.make || ""} ${listing.model || ""}`.trim() || listing.slug)}
    </nav>

    <!-- Hero -->
    <section class="d-hero">
      <div>
        <div class="d-main-img ${listing.images?.length ? "" : "empty"}" id="d-main">
          ${listing.images?.length
            ? `<img src="/api/listings/${listing.slug}/image/${listing.images[0].id}" alt="${escHtmlNode(listing.images[0].alt || title)}" id="d-main-img">`
            : "<span>No photos uploaded yet</span>"}
        </div>
        ${listing.images && listing.images.length > 1 ? `
          <div class="d-thumbs">
            ${listing.images.slice(0, 5).map((img, i) => `
              <div class="d-thumb ${i === 0 ? "active" : ""}" data-img="/api/listings/${listing.slug}/image/${img.id}">
                <img src="/api/listings/${listing.slug}/image/${img.id}" alt="${escHtmlNode(img.alt || "")}" loading="lazy">
              </div>`).join("")}
          </div>` : ""}
      </div>
      <div class="d-pitch">
        <div class="d-badges">
          <span class="d-badge ${listing.condition}">${conditionBadge}</span>
          ${listing.status === "sold" ? '<span class="d-badge sold">Sold</span>' : ""}
          ${listing.street_legal ? '<span class="d-badge" style="background:#fff2d6; color:#8a4a00;">Street legal</span>' : ""}
        </div>
        <h1>${escHtmlNode(`${listing.year || ""} ${listing.make || ""} ${listing.model || ""}`.trim())}${listing.color ? ' · <span style="color:var(--coral); font-size:.8em;">' + escHtmlNode(listing.color) + '</span>' : ""}</h1>
        ${listing.headline ? `<p class="d-headline">${escHtmlNode(listing.headline)}</p>` : ""}

        <div class="d-price-block">
          ${listing.price_cents
            ? `<span class="d-price">${priceLabel}</span>${msrpLabel ? `<span class="d-msrp">${msrpLabel} MSRP</span>` : ""}${savings ? `<span class="d-savings">Save ${savings}</span>` : ""}`
            : `<span class="d-pcall">Call for pricing</span>`}
        </div>

        <div class="d-ctas">
          <a class="btn btn-coral" href="tel:9362231182">📞 Call 936-223-1182</a>
          <a class="btn btn-outline" href="/services/#request">Request details</a>
          <a class="btn btn-outline" href="/financing/">Finance it</a>
        </div>

        <div class="d-quickspecs">
          ${listing.seats ? `<div class="d-spec"><b>${escHtmlNode(listing.seats)}</b><span>Seats</span></div>` : ""}
          ${listing.drivetrain ? `<div class="d-spec"><b>${escHtmlNode(listing.drivetrain === "electric" ? "Electric" : "Gas")}</b><span>Drivetrain</span></div>` : ""}
          ${listing.top_speed_mph ? `<div class="d-spec"><b>${escHtmlNode(listing.top_speed_mph)} mph</b><span>Top speed</span></div>` : ""}
          ${listing.range_mi ? `<div class="d-spec"><b>${escHtmlNode(listing.range_mi)} mi</b><span>Range</span></div>` : ""}
          ${listing.mileage_hours ? `<div class="d-spec"><b>${escHtmlNode(listing.mileage_hours)} hrs</b><span>Hours</span></div>` : ""}
        </div>
      </div>
    </section>

    <!-- Feature section 1: Summary + features -->
    ${(listing.summary || featureBullets) ? `
    <section class="d-section">
      <div class="d-split">
        <div>
          <h2>What makes this one special</h2>
          ${listing.summary ? `<p>${escHtmlNode(listing.summary)}</p>` : ""}
          ${featureBullets ? `<ul class="d-features">${featureBullets}</ul>` : ""}
        </div>
        <div>
          ${listing.images && listing.images.length > 1
            ? `<div class="d-split-img"><img src="/api/listings/${listing.slug}/image/${listing.images[1].id}" alt="${escHtmlNode(listing.images[1].alt || title)}"></div>`
            : listing.images && listing.images.length
            ? `<div class="d-split-img"><img src="/api/listings/${listing.slug}/image/${listing.images[0].id}" alt="${escHtmlNode(title)}"></div>`
            : ""}
        </div>
      </div>
    </section>` : ""}

    <!-- Feature section 2: Specs table (2-col layout) -->
    <section class="d-section">
      <div class="d-split">
        <div>
          <h2>Full specifications</h2>
          <p>Everything you need to compare — powertrain, dimensions, warranty. Questions on any of this? Call us.</p>
          ${listing.condition === "used" && listing.condition_notes ? `
            <h3 style="color:var(--teal-dk); margin:1.5rem 0 .5rem; font: 700 1rem Georgia, serif;">Condition notes</h3>
            <p style="color:var(--ink); font-size:.95rem;">${escHtmlNode(listing.condition_notes)}</p>
          ` : ""}
        </div>
        <div>
          <table class="d-specs-table">
            <tbody>
              ${specRow("Condition", listing.condition === "new" ? "New" : "Used")}
              ${specRow("Year", listing.year)}
              ${specRow("Make", listing.make)}
              ${specRow("Model", listing.model)}
              ${specRow("Color", listing.color)}
              ${specRow("Seats", listing.seats)}
              ${specRow("Drivetrain", listing.drivetrain === "electric" ? "Electric (Lithium)" : listing.drivetrain === "gas" ? "Gas" : "")}
              ${specRow("Top speed", listing.top_speed_mph ? listing.top_speed_mph + " mph" : "")}
              ${specRow("Range", listing.range_mi ? listing.range_mi + " mi" : "")}
              ${specRow("Battery", listing.battery)}
              ${specRow("Motor", listing.motor)}
              ${specRow("Drive type", listing.drive_type)}
              ${specRow("Ground clearance", listing.ground_clearance_in ? listing.ground_clearance_in + " in" : "")}
              ${specRow("Tires", listing.tire)}
              ${specRow("Length", listing.length_in ? listing.length_in + " in" : "")}
              ${specRow("Width", listing.width_in ? listing.width_in + " in" : "")}
              ${specRow("Height", listing.height_in ? listing.height_in + " in" : "")}
              ${specRow("Weight", listing.weight_lbs ? listing.weight_lbs + " lbs" : "")}
              ${specRow("Hours", listing.mileage_hours)}
              ${specRow("Street legal", listing.street_legal ? "Yes" : "")}
              ${specRow("Warranty", listing.warranty)}
              ${specRow("Tech", listing.tech)}
            </tbody>
          </table>
        </div>
      </div>
    </section>

    ${descriptionHtml ? `
    <section class="d-section">
      <h2>About this cart</h2>
      <div style="max-width: 820px; color: var(--ink); font-size: 1.02rem; line-height: 1.7;">
        ${descriptionHtml}
      </div>
    </section>` : ""}

    ${listing.images && listing.images.length > 1 ? `
    <section class="d-section">
      <h2>More photos</h2>
      <div class="d-gallery">${gallery}</div>
    </section>` : ""}

    <section class="d-cta-band">
      <h2>Interested? Give us a call.</h2>
      <p>Family-owned since 2020. Free pickup &amp; delivery within 25 mi of Livingston.</p>
      <a class="btn btn-coral" href="tel:9362231182">📞 936-223-1182</a>
      <a class="btn btn-outline" href="/services/#request" style="margin-left:.5rem; background:transparent; color:#fff; border-color:#fff;">Message us</a>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container"><p style="text-align:center; color:var(--ink-soft); font-size:.85rem;">Polk County Golf Carts · 1732 FM 3277, Livingston, TX 77351 · <a href="tel:9362231182" style="color:var(--teal-dk);">936-223-1182</a></p></div>
  </footer>

  <script>
    // Thumbnail click → swap hero image
    document.querySelectorAll(".d-thumb").forEach(t => {
      t.addEventListener("click", () => {
        const src = t.dataset.img;
        document.getElementById("d-main-img").src = src;
        document.querySelectorAll(".d-thumb").forEach(x => x.classList.remove("active"));
        t.classList.add("active");
      });
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=60",
    },
  });
}

// The single source of truth for the "leave us a Google review"
// call-to-action URL. Owner-supplied share.google link jumps directly
// to the review form (one fewer click than the /leave-a-review/ page).
const REVIEW_URL = "https://share.google/J5oRVdEykCo6Mbjrq";

// Customer-facing thank-you email sent when status transitions to
// "complete". Asks for a Google review with a button linking directly
// to the PCGC review form. A softer follow-up (below) is queued to
// send 5 days after the rental end date in case they don't act now.
async function sendThankYouEmail(record, env) {
  const customer = record.contact || {};
  const to = customer.email;
  if (!to) throw new Error("no customer email on booking");
  const from = env.BOOKING_FROM_EMAIL || "bookings@polkcountygolfcarts.com";

  const subject = `Thanks for renting with Polk County Golf Carts!`;
  const firstName = (customer.name || "").split(/\s+/)[0] || "there";

  const html = `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif; max-width:560px; margin:0 auto; padding:1rem; color:#222;">
    <h2 style="color:#1f5a68; margin:0 0 .75rem;">Thanks, ${escHtml(firstName)}!</h2>
    <p>The cart's back safely — hope you had a great time out there.</p>
    <p>If you've got a minute, the best thing you can do for a small family-owned shop like ours is leave a quick review on Google. It honestly makes a huge difference.</p>
    <p style="margin:1.5rem 0;">
      <a href="${REVIEW_URL}" style="display:inline-block; background:#e85a4f; color:#fff; padding:.85rem 1.4rem; border-radius:8px; text-decoration:none; font-weight:600;">Leave a quick review &rarr;</a>
    </p>
    <p>Booking <b>${escHtml(record.id)}</b> &middot; need anything else, just hit reply or call <a href="tel:9362231182">936-223-1182</a>.</p>
    <p style="margin-top:1.5rem;">— John &amp; the PCGC crew<br>Polk County Golf Carts &middot; Livingston, TX</p>
  </body></html>`;

  const text = [
    `Thanks, ${firstName}!`,
    ``,
    `The cart's back safely — hope you had a great time out there.`,
    ``,
    `If you've got a minute, the best thing you can do for a small family-owned shop like ours is leave a quick review on Google. It honestly makes a huge difference:`,
    ``,
    REVIEW_URL,
    ``,
    `Booking ${record.id} · need anything else, just hit reply or call 936-223-1182.`,
    ``,
    `— John & the PCGC crew`,
    `Polk County Golf Carts · Livingston, TX`,
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `Online Cart Rentals <${from}>`,
      to: [to],
      subject,
      html,
      text,
      reply_to: env.BOOKING_TO_EMAIL || "polkcountygolfcarts@yahoo.com",
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`resend ${res.status}: ${t}`);
  }
}

// Softer second ask — scheduled via Resend to land 5 days AFTER the
// rental end date (or immediately, if that time is already in the past
// when the booking is marked Complete). Same review CTA, slightly
// different framing so it doesn't feel like a copy of the first email.
async function sendReviewFollowupEmail(record, env) {
  const customer = record.contact || {};
  const to = customer.email;
  if (!to) throw new Error("no customer email on booking");
  const from = env.BOOKING_FROM_EMAIL || "bookings@polkcountygolfcarts.com";

  const subject = `One more ask — a quick Google review?`;
  const firstName = (customer.name || "").split(/\s+/)[0] || "there";

  // Trigger time: 5 days after dates.end at 16:00 UTC (~10-11am CT).
  // If that's already in the past, drop scheduled_at so Resend sends
  // now — happens when the owner marks Complete late.
  let scheduledAt = null;
  const endIso = record.dates?.end;
  if (endIso) {
    const target = new Date(endIso + "T16:00:00Z");
    target.setUTCDate(target.getUTCDate() + 5);
    if (target.getTime() > Date.now() + 60_000) {
      scheduledAt = target.toISOString();
    }
  }

  const html = `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif; max-width:560px; margin:0 auto; padding:1rem; color:#222;">
    <h2 style="color:#1f5a68; margin:0 0 .75rem;">Hey ${escHtml(firstName)},</h2>
    <p>Bumping this once — I know how fast a week goes.</p>
    <p>If your rental with us went well, a quick Google review is the single most helpful thing you can do for a small family shop like ours. Takes about 30 seconds.</p>
    <p style="margin:1.5rem 0;">
      <a href="${REVIEW_URL}" style="display:inline-block; background:#e85a4f; color:#fff; padding:.85rem 1.4rem; border-radius:8px; text-decoration:none; font-weight:600;">Leave a review &rarr;</a>
    </p>
    <p>Either way — thanks for renting with us. Hope we see you again next season.</p>
    <p style="margin-top:1.5rem;">— John<br>Polk County Golf Carts &middot; <a href="tel:9362231182">936-223-1182</a></p>
  </body></html>`;

  const text = [
    `Hey ${firstName},`,
    ``,
    `Bumping this once — I know how fast a week goes.`,
    ``,
    `If your rental with us went well, a quick Google review is the single most helpful thing you can do for a small family shop like ours. Takes about 30 seconds:`,
    ``,
    REVIEW_URL,
    ``,
    `Either way — thanks for renting with us. Hope we see you again next season.`,
    ``,
    `— John`,
    `Polk County Golf Carts · 936-223-1182`,
  ].join("\n");

  const body = {
    from: `Online Cart Rentals <${from}>`,
    to: [to],
    subject,
    html,
    text,
    reply_to: env.BOOKING_TO_EMAIL || "polkcountygolfcarts@yahoo.com",
  };
  if (scheduledAt) body.scheduled_at = scheduledAt;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`resend ${res.status}: ${t}`);
  }
  const data = await res.json().catch(() => ({}));
  return { scheduledAt, resendId: data?.id || null };
}

// Admin diagnostic: send a real Resend request and report exactly what
// happened. Owner clicks a button in /admin/rentals/ and gets a
// human-readable answer — no Worker-log spelunking. Returns config
// visibility (without leaking the API key), the raw Resend response,
// and a `hint` field that translates the common error messages into
// plain English + the next action to take.
async function sendTestEmail(request, env) {
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;

  const defaultFrom = "bookings@polkcountygolfcarts.com";
  const defaultTo = "polkcountygolfcarts@yahoo.com";
  const from = env.BOOKING_FROM_EMAIL || defaultFrom;
  const configuredTo = env.BOOKING_TO_EMAIL || defaultTo;

  let body = {};
  try { body = await request.json(); } catch {}
  // Allow overriding the recipient so the owner can test to their own
  // Gmail (Resend's test mode only allows sending to the Resend
  // account owner's email until a domain is verified).
  const to = (body?.to && String(body.to).trim()) || configuredTo;

  const config = {
    resendKeySet: !!env.RESEND_API_KEY,
    fromEmail: from,
    fromEmailIsDefault: !env.BOOKING_FROM_EMAIL,
    toEmail: to,
    toEmailIsConfigured: to === configuredTo,
  };

  if (!env.RESEND_API_KEY) {
    return json({
      ok: false,
      config,
      reason: "no_api_key",
      hint: "RESEND_API_KEY is not set in Cloudflare. From your terminal, run:  wrangler secret put RESEND_API_KEY  and paste your key from resend.com/api-keys, then redeploy with:  npx wrangler deploy",
    });
  }

  let res;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: `Online Cart Rentals (test) <${from}>`,
        to: [to],
        subject: "PCGC booking system — test email",
        html: `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif; max-width:520px; margin:0 auto; padding:1rem;">
          <h2 style="color:#1f5a68;">Test email received ✓</h2>
          <p>If you're reading this in your Yahoo inbox, the PCGC booking system's email pipeline is working — every new rental booking will land here from now on.</p>
          <p style="color:#666; font-size:.9rem;">Sent from <b>${escHtml(from)}</b>, delivered to <b>${escHtml(to)}</b> via Resend.</p>
        </body></html>`,
        text: `Test email received.\n\nIf you're reading this in your Yahoo inbox, the PCGC booking system's email pipeline is working — every new rental booking will land here from now on.\n\nSent from ${from}, delivered to ${to} via Resend.`,
      }),
    });
  } catch (e) {
    return json({
      ok: false,
      config,
      reason: "network_error",
      error: e?.message || String(e),
      hint: "Failed to reach api.resend.com at all — this is rare from a Cloudflare Worker. Try again in a minute; if it persists check https://status.resend.com.",
    });
  }

  const raw = await res.text();
  let parsed; try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }

  if (!res.ok) {
    const msg = String(parsed?.message || parsed?.error || raw).toLowerCase();
    let hint = "Unexpected Resend error — the full response is above. Common fixes: verify the from-domain at resend.com/domains, regenerate the API key, or set BOOKING_FROM_EMAIL to a sender you've verified.";
    if (res.status === 401 || res.status === 403 && msg.includes("api key")) {
      hint = "The RESEND_API_KEY value is invalid, revoked, or missing the 'sending' permission. Regenerate a Sending key at resend.com/api-keys and rerun:  wrangler secret put RESEND_API_KEY";
    } else if (msg.includes("verify") && msg.includes("domain")) {
      hint = `The domain in the from-address (${from}) hasn't been verified in Resend. Go to resend.com/domains, click "Add Domain", enter the domain, and add the three DNS records they show you (SPF, DKIM, return-path) at your domain registrar. Verification usually completes in under 10 minutes. Until then, you can temporarily set BOOKING_FROM_EMAIL to onboarding@resend.dev for testing.`;
    } else if (msg.includes("only send") || msg.includes("testing") || (msg.includes("verify") && msg.includes("resend.dev") === false)) {
      hint = `Resend restriction: while no domain is verified, you can ONLY send TO the email address you signed up with. This test tried to send to ${to}. Either (a) send the test to your Resend account email (change the To field), or (b) verify your domain at resend.com/domains so you can send to anyone.`;
    } else if (msg.includes("from") && msg.includes("verified")) {
      hint = `The from-address ${from} is not a verified sender. Verify the domain at resend.com/domains, or change BOOKING_FROM_EMAIL to a sender you've already verified.`;
    }
    return json({
      ok: false,
      config,
      reason: "resend_rejected",
      resendStatus: res.status,
      resendResponse: parsed,
      hint,
    });
  }

  return json({
    ok: true,
    config,
    resendId: parsed?.id,
    hint: `Resend accepted the email (id ${parsed?.id}). It should arrive at ${to} within about 60 seconds. Check the inbox, then the spam folder if it's not there. If it never arrives, the domain's DKIM/SPF records may not be validating on Yahoo's side — verify at resend.com/domains that the domain is green across all three records.`,
  });
}

// -------------------- Event tracking (Tier 2 analytics) -------------------- //
//
// Public POST /api/track logs one increment for a named event to KV under
// key `evt:<YYYY-MM-DD>:<event>`, kept for 90 days. Uses a closed
// allow-list so URL-crafters can't fill KV with junk.
//
// Admin GET /api/track/summary?days=N reads all evt:* keys in the window
// and returns { byDay, byEvent } aggregates for the dashboard.
const TRACKED_EVENTS = new Set([
  // Finance page CTAs — data-cta attributes already on the buttons.
  "finance-apply-hero",
  "finance-apply-lendmark",
  "finance-apply-dealer-direct",
  "finance-apply-bottom",
  // Universal — any a[href^="tel:"] click site-wide.
  "phone-tap",
  // Rentals — fired from rentals.js on successful submit.
  "booking-submitted",
  // Rental flow entry — fired from rentals.js on Step 1 first-view.
  "rental-flow-start",
  // Rental share — customer clicked Share / Download on Step 5.
  "booking-shared",
]);
const TRACK_TTL_SEC = 90 * 24 * 60 * 60; // 90-day retention

async function trackEvent(request, env) {
  // Public endpoint — no auth. Silently absorb errors so a broken KV
  // never bubbles up to the customer as a JS console error.
  if (!env.FEEDBACK_KV) return json({ ok: false }, 204);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false }, 400); }
  const event = String(body?.event || "").trim();
  if (!TRACKED_EVENTS.has(event)) return json({ ok: false, error: "unknown event" }, 400);

  const day = new Date().toISOString().slice(0, 10);
  const key = `evt:${day}:${event}`;
  const cur = parseInt((await env.FEEDBACK_KV.get(key)) || "0", 10) || 0;
  await env.FEEDBACK_KV.put(key, String(cur + 1), { expirationTtl: TRACK_TTL_SEC });
  return json({ ok: true });
}

async function trackSummary(request, env, url) {
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  if (!env.FEEDBACK_KV) return json({ events: [...TRACKED_EVENTS], byDay: {}, byEvent: {} });

  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") || "7", 10)));
  const startDay = new Date();
  startDay.setDate(startDay.getDate() - (days - 1));
  const startIso = startDay.toISOString().slice(0, 10);

  const byDay = {};   // { "2026-07-31": { "finance-apply-hero": 5, "phone-tap": 3 } }
  const byEvent = {}; // { "finance-apply-hero": 12 }

  let cursor;
  do {
    const page = await env.FEEDBACK_KV.list({ prefix: "evt:", cursor });
    for (const k of page.keys) {
      // Key format: evt:YYYY-MM-DD:event-name (event may contain hyphens
      // but no colons, so a 3-way split is enough).
      const parts = k.name.split(":");
      if (parts.length < 3) continue;
      const day = parts[1];
      const ev = parts.slice(2).join(":");
      if (day < startIso) continue;
      const val = parseInt(await env.FEEDBACK_KV.get(k.name), 10) || 0;
      if (!val) continue;
      byDay[day] = byDay[day] || {};
      byDay[day][ev] = (byDay[day][ev] || 0) + val;
      byEvent[ev] = (byEvent[ev] || 0) + val;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return json({
    days,
    startDay: startIso,
    endDay: new Date().toISOString().slice(0, 10),
    events: [...TRACKED_EVENTS],
    byDay,
    byEvent,
  });
}

// -------------- Clover payment integration (embedded flow) -------------- //
//
// Card entry happens ON the /rentals/ Step 4 page via Clover's Ecommerce
// SDK — the card number, expiry, CVV, and postal fields are iframed in
// from checkout.clover.com so raw card data never touches our JS or our
// server. Only the tokenized `source` reference (clv_XXXX...) flows
// through this Worker. This is the PCI SAQ-A path (same posture as
// Stripe Elements or Braintree Hosted Fields).
//
// Not yet activated — waiting on the following secrets in Cloudflare
// dashboard (Workers & Pages -> pcgc -> Settings -> Variables and
// Secrets):
//
//   CLOVER_MERCHANT_ID     — 13-char string from Clover Dashboard ->
//                            Setup -> Merchant Info. Public-ish; goes
//                            in the client-side SDK init.
//   CLOVER_PUBLIC_KEY      — the "pakms key" or Ecommerce public API
//                            key. Exposed to the browser via
//                            /api/config so the SDK can tokenize.
//                            Get it from Clover Dashboard ->
//                            Ecommerce -> API Tokens -> Public Key.
//   CLOVER_ACCESS_TOKEN    — Ecommerce server-side API token. SECRET.
//                            Get it from Clover Dashboard ->
//                            Ecommerce -> API Tokens -> Private Key
//                            (or via OAuth for a merchant-installed
//                            app). Used server-side to /v1/charges.
//   CLOVER_ENVIRONMENT     — "sandbox" or "production" (defaults to
//                            "sandbox" so no accidental live charges).
//   CLOVER_WEBHOOK_SECRET  — SECRET. Set at Clover -> Setup ->
//                            Webhooks after you subscribe our
//                            /api/payment/webhook endpoint. Verifies
//                            inbound events (chargebacks, disputes,
//                            refund confirmations).
//
// Merchant setup on the Clover side (John needs to do this):
//   1. Sign up for Clover Ecommerce (this is a separate module from
//      the physical Clover POS device — Ecommerce enables the SDK +
//      REST API). Sandbox account is free.
//   2. In Clover Dashboard -> Ecommerce -> API Tokens, generate a
//      public key + a private key. Public goes in CLOVER_PUBLIC_KEY,
//      private in CLOVER_ACCESS_TOKEN.
//   3. Subscribe a webhook at Clover -> Setup -> Webhooks:
//        URL:     https://polkcountygolfcarts.com/api/payment/webhook
//        Events:  PAYMENT (at minimum); also DISPUTE + REFUND if
//                 offered.
//      Copy the signing secret into CLOVER_WEBHOOK_SECRET.
//   4. In Cloudflare dashboard, add the four secrets as documented
//      above.
//
// Runtime flow (once the secrets exist):
//   1. /rentals/ Step 4 loads. rentals.js fetches /api/config;
//      if cloverPublicKey is set, it loads Clover.js SDK, mounts
//      four iframe fields (card number, exp, CVV, postal), and
//      switches the CTA to "Pay $X.XX now".
//   2. Customer clicks Pay. rentals.js calls clover.createToken()
//      -> gets a source token like clv_1TSTSABCD...
//   3. rentals.js POSTs to /api/booking with the source token +
//      booking data. Worker submitBooking() calls chargeCard()
//      before saving to KV: if the charge fails, we return an
//      error and the booking is NOT saved. If it succeeds, we
//      save the booking with paid: true + the Clover charge id.
//   4. Confirmation email + agreement link fire as usual.
//   5. Clover webhooks (chargebacks, disputes) hit
//      /api/payment/webhook and update the booking record.

async function getConfig(request, env) {
  // Public config — safe to expose. Never returns the private key.
  return json({
    clover: env.CLOVER_PUBLIC_KEY && env.CLOVER_MERCHANT_ID
      ? {
          publicKey: env.CLOVER_PUBLIC_KEY,
          merchantId: env.CLOVER_MERCHANT_ID,
          environment: env.CLOVER_ENVIRONMENT === "production" ? "production" : "sandbox",
        }
      : null,
  });
}

// Server-side charge. Called from submitBooking() when the client
// submits a source token. Returns { ok, chargeId, error } — never
// throws, so submitBooking can decide whether to reject or save.
async function chargeCard(env, { sourceToken, amountCents, bookingId, customerEmail, description }) {
  if (!env.CLOVER_ACCESS_TOKEN) {
    return { ok: false, error: "clover_not_configured" };
  }
  const base = env.CLOVER_ENVIRONMENT === "production"
    ? "https://scl.clover.com"
    : "https://scl-sandbox.dev.clover.com";
  try {
    const res = await fetch(`${base}/v1/charges`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${env.CLOVER_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        amount: amountCents,
        currency: "usd",
        source: sourceToken,
        description: description || `PCGC rental ${bookingId}`,
        ...(customerEmail ? { receipt_email: customerEmail } : {}),
        metadata: { bookingId },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: body.message || body.error || `clover ${res.status}`, raw: body };
    }
    return { ok: true, chargeId: body.id, raw: body };
  } catch (e) {
    return { ok: false, error: "network: " + (e?.message || String(e)) };
  }
}

async function createCloverCheckout(_request, _env) {
  // The old hosted-checkout stub. Kept 501 — the embedded flow
  // charges through submitBooking() instead of via a separate
  // create-checkout call, so this endpoint isn't used anymore.
  // Leaving the route registered in case a future integration
  // (e.g. a "pay by link" flow) wants it.
  return json({ ok: false, reason: "not_used_embedded_flow_charges_inline" }, 410);
}

async function handleCloverWebhook(request, env) {
  if (!env.CLOVER_WEBHOOK_SECRET) {
    return json({ ok: false, reason: "webhook_secret_not_set" }, 503);
  }
  // TODO once real Clover webhook payloads land:
  //   1. Verify the X-Clover-Signature header (HMAC-SHA256 of body
  //      with CLOVER_WEBHOOK_SECRET as the key)
  //   2. Parse the event { type, data: { object: { id, metadata } } }
  //   3. metadata.bookingId lets us look up the booking in KV
  //   4. Update rec.payment.chargeStatus / rec.refund etc.
  //   5. Return 200 OK so Clover doesn't retry
  return json({ ok: false, reason: "not_yet_implemented" }, 501);
}

// -------------- Rental agreement (built-in DocuSign replacement) -------------- //
//
// After a customer submits the booking, we mint a per-booking HMAC token
// bound to the booking id. The token goes in the customer confirmation
// email as a link to /agreement/?id=<id>&t=<token>. The page fetches
// GET /api/agreement/<id>?t=<token> to load the pre-filled booking data
// and the current signature (if already signed), then POSTs the drawn
// signature + typed name + agreement metadata back to the same URL.
//
// Once signed, the agreement is immutable — a second POST returns 409.

const AGREEMENT_VERSION = "2026-07-31"; // bump if terms change

// Physical fleet — mirrors site/assets/rentals.js CARTS. Kept in sync
// by hand; both places are short and rarely change. Used on the
// agreement page to show the full inventory with rented carts flagged.
const FLEET = [
  { id: "cart-2", cartNo: 2, name: "Cart #2 — The Limo", seats: 6,
    make: "Club Car Limo", modelDetails: "Gas · White", serial: "LG9939-808771" },
  { id: "cart-3", cartNo: 3, name: "Cart #3", seats: 4,
    make: "Yamaha", modelDetails: "Gas · Tan", serial: "J0B-001578" },
  { id: "cart-4", cartNo: 4, name: "Cart #4", seats: 4,
    make: "Yamaha", modelDetails: "Gas · Tan", serial: "J0B-105687" },
  { id: "cart-5", cartNo: 5, name: "Cart #5", seats: 4,
    make: "Yamaha", modelDetails: "Gas · Tan", serial: "J0B-105659" },
  { id: "cart-6", cartNo: 6, name: "Cart #6", seats: 4,
    make: "Yamaha", modelDetails: "Gas · Grey", serial: "J0K-203736" },
];

async function mintAgreementToken(bookingId, env) {
  if (!env.FEEDBACK_ADMIN_PASS) return null;
  return hmacHex(env.FEEDBACK_ADMIN_PASS, `agreement.${bookingId}`);
}

async function verifyAgreementToken(bookingId, token, env) {
  if (!token || !env.FEEDBACK_ADMIN_PASS) return false;
  const expected = await hmacHex(env.FEEDBACK_ADMIN_PASS, `agreement.${bookingId}`);
  return constantTimeEqual(token, expected);
}

// Look up a booking record + KV key by its PCGC-XXXXXX id. Booking keys
// are booking:<ts>:<suffix>, so we linear-scan; PCGC volume is single
// dealer / low double-digits per week, this is fine.
async function findBookingById(id, env) {
  let cursor;
  do {
    const page = await env.FEEDBACK_KV.list({ prefix: "booking:", cursor });
    for (const k of page.keys) {
      const raw = await env.FEEDBACK_KV.get(k.name);
      if (!raw) continue;
      let rec;
      try { rec = JSON.parse(raw); } catch { continue; }
      if (rec.id === id) return { key: k.name, rec };
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return null;
}

async function getAgreement(request, env, url) {
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const id = decodeURIComponent(url.pathname.replace(/^\/api\/agreement\//, ""));
  const token = url.searchParams.get("t");
  if (!id || !token) return json({ error: "id + token required" }, 400);
  if (!(await verifyAgreementToken(id, token, env))) {
    return json({ error: "bad token" }, 401);
  }
  const match = await findBookingById(id, env);
  if (!match) return json({ error: "booking not found" }, 404);
  const b = match.rec;
  // Return only what the agreement page needs — never send admin-only
  // fields like ua/ip/country back to the signature form.
  const c = b.contact || {};
  return json({
    id: b.id,
    agreementVersion: AGREEMENT_VERSION,
    dates: b.dates || {},
    items: b.items || [],
    delivery: b.delivery,
    contact: {
      name: c.name || "",
      email: c.email || "",
      phone: c.phone || "",
      street: c.street || "",
      city: c.city || "",
      state: c.state || "",
      zip: c.zip || "",
      address: c.address || "", // delivery drop-off
    },
    pricing: b.pricing || {},
    fleet: FLEET,
    agreement: b.agreement || null, // null if unsigned; object if already signed
  });
}

async function signAgreement(request, env, url) {
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);
  const id = decodeURIComponent(url.pathname.replace(/^\/api\/agreement\//, ""));
  const token = url.searchParams.get("t");
  if (!id || !token) return json({ error: "id + token required" }, 400);
  if (!(await verifyAgreementToken(id, token, env))) {
    return json({ error: "bad token" }, 401);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid body" }, 400); }
  const {
    signatureDataUrl,
    typedName,
    dlNumber,
    dlState,
    dlMethod,
    dlImageDataUrl,
    agreed,
  } = body || {};

  if (!signatureDataUrl || typeof signatureDataUrl !== "string" || !signatureDataUrl.startsWith("data:image/")) {
    return json({ error: "missing signature drawing" }, 400);
  }
  // Signature drawings are typically 5-30KB. Reject anything absurd —
  // keeps KV values inside the 25MB per-value cap with margin, and
  // stops a hostile client from ballooning storage.
  if (signatureDataUrl.length > 250_000) {
    return json({ error: "signature too large" }, 413);
  }
  if (!typedName || typeof typedName !== "string" || !typedName.trim()) {
    return json({ error: "typed name required" }, 400);
  }
  if (!dlNumber || !dlState) {
    return json({ error: "driver's license number and state required" }, 400);
  }
  const ALLOWED_DL_METHODS = ["upload", "text", "in-person"];
  const method = ALLOWED_DL_METHODS.includes(dlMethod) ? dlMethod : "text";
  if (method === "upload") {
    if (!dlImageDataUrl || typeof dlImageDataUrl !== "string" || !dlImageDataUrl.startsWith("data:image/")) {
      return json({ error: "driver's license photo required for the 'upload now' option" }, 400);
    }
    // Cap at ~1MB — client-side we resize to ~200KB JPEG, so anything
    // materially larger is either a bug or a client bypass. Still well
    // inside KV's 25MB per-value ceiling.
    if (dlImageDataUrl.length > 1_500_000) {
      return json({ error: "driver's license photo too large — try a smaller image" }, 413);
    }
  }
  if (agreed !== true) {
    return json({ error: "you must agree to the terms" }, 400);
  }

  const match = await findBookingById(id, env);
  if (!match) return json({ error: "booking not found" }, 404);
  if (match.rec.agreement && match.rec.agreement.signedAt) {
    // Idempotent-ish: return the existing signature timestamp instead
    // of overwriting. Prevents a double-submit or a re-signature attempt.
    return json({ error: "already signed", signedAt: match.rec.agreement.signedAt }, 409);
  }

  match.rec.agreement = {
    version: AGREEMENT_VERSION,
    signedAt: new Date().toISOString(),
    typedName: String(typedName).slice(0, 200),
    dlNumber: String(dlNumber).slice(0, 40),
    dlState: String(dlState).slice(0, 4).toUpperCase(),
    dlMethod: method,
    dlImageDataUrl: method === "upload" ? dlImageDataUrl : null,
    signatureDataUrl,
    signedIp: request.headers.get("cf-connecting-ip") || "",
    signedUa: (request.headers.get("user-agent") || "").slice(0, 500),
  };
  await env.FEEDBACK_KV.put(match.key, JSON.stringify(match.rec));

  return json({ ok: true, signedAt: match.rec.agreement.signedAt });
}

// Returns a Response if auth fails, or null if it passes. Accepts EITHER
// a valid pcgc_admin session cookie (used by the /admin/rentals/ UI) OR
// HTTP Basic credentials (kept as a programmatic backdoor for curl /
// scripts). We deliberately do NOT send a WWW-Authenticate header on
// failure — that's the trigger for the browser's native auth dialog,
// which is what the owner asked us to remove.
async function checkAdminAuth(request, env) {
  if (!env.FEEDBACK_ADMIN_PASS) {
    return json({ error: "admin password not configured" }, 503);
  }
  // 1) Cookie session — primary path used by the admin UI.
  const token = getCookie(request, ADMIN_COOKIE);
  if (token && await verifyAdminToken(token, env)) return null;

  // 2) HTTP Basic — fallback so curl / scripts still work.
  const expectedUser = env.FEEDBACK_ADMIN_USER || "admin";
  const header = request.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    let decoded = "";
    try { decoded = atob(header.slice(6)); } catch { decoded = ""; }
    const [user, pass] = decoded.split(":", 2);
    if (user === expectedUser && pass === env.FEEDBACK_ADMIN_PASS) return null;
  }

  return json({ error: "unauthorized" }, 401);
}

async function adminLogin(request, env) {
  if (!env.FEEDBACK_ADMIN_PASS) {
    return json({ error: "admin password not configured" }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid body" }, 400); }
  const submitted = body?.password ?? "";
  // Constant-time compare so password length / prefix doesn't leak
  // through timing. Both strings are encoded to bytes first.
  if (!constantTimeEqual(submitted, env.FEEDBACK_ADMIN_PASS)) {
    return json({ error: "wrong password" }, 401);
  }
  const token = await mintAdminToken(env);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${ADMIN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL_SEC}`,
    },
  });
}

function adminLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${ADMIN_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    },
  });
}

// Token format: "<exp_seconds>.<hex_hmac>" where the HMAC is computed
// over the literal string `admin.<exp_seconds>` with the admin password
// as the key. Rotating FEEDBACK_ADMIN_PASS therefore invalidates every
// existing session — which is exactly what you want after a leak.
async function mintAdminToken(env) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SEC;
  const sig = await hmacHex(env.FEEDBACK_ADMIN_PASS, `admin.${exp}`);
  return `${exp}.${sig}`;
}

async function verifyAdminToken(token, env) {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(env.FEEDBACK_ADMIN_PASS, `admin.${exp}`);
  return constantTimeEqual(sig, expected);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  const A = new TextEncoder().encode(a);
  const B = new TextEncoder().encode(b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
