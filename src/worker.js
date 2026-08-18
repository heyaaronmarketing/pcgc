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

async function submitBooking(request, env) {
  if (!env.FEEDBACK_KV) return json({ error: "storage not configured" }, 503);
  let payload;
  try {
    payload = await request.json();
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
  const fromWithName = `Polk County Golf Carts <${from}>`;
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
      <tr><td style="padding:4px 0; color:#888;">Tax</td><td style="padding:4px 0; text-align:right;">${fmtMoney(p.tax)}</td></tr>
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
    `  Tax  ${fmtMoney(p.tax)}`,
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
    from: `Polk County Golf Carts <${from}>`,
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
    extended: "Extended delivery (25–100 mi, fee quoted separately)",
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
      ${r.delivery === "extended" ? `<tr><td style="padding:6px 0; color:#888;">Extended delivery</td><td style="padding:6px 0; text-align:right;">Quoted separately</td></tr>` : ""}
      <tr><td style="padding:6px 0; color:#888;">Tax</td><td style="padding:6px 0; text-align:right;">${fmtMoney(p.tax)}</td></tr>
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
  const deliveryLabel = { pickup: "Pickup at shop", local: "Free delivery (within 25 mi)", extended: "Extended delivery (25-100 mi, fee quoted separately)" }[r.delivery] || r.delivery || "";
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
    r.delivery === "extended" ? `Extended:  Quoted separately` : null,
    `Tax:       ${fmtMoney(p.tax)}`,
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
const BOOKING_STATUSES = ["new", "picked-up", "delivered", "returned"];

async function updateBookingStatus(request, env, url) {
  const auth = await checkAdminAuth(request, env);
  if (auth) return auth;
  if (!env.FEEDBACK_KV) return json({ error: "kv not configured" }, 503);

  // Path is /api/booking/<PCGC-XXXXXX>; the id segment uniquely
  // identifies the booking but the KV key is booking:<ts>:<suffix>,
  // so we have to scan to find the right record.
  const id = decodeURIComponent(url.pathname.replace(/^\/api\/booking\//, ""));
  if (!id) return json({ error: "id required" }, 400);

  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid body" }, 400); }
  const newStatus = body?.status;
  if (!BOOKING_STATUSES.includes(newStatus)) {
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

  const prevStatus = match.rec.status || "new";
  if (prevStatus === newStatus) {
    return json({ ok: true, status: newStatus, unchanged: true });
  }
  match.rec.status = newStatus;
  match.rec.statusUpdatedAt = new Date().toISOString();
  await env.FEEDBACK_KV.put(match.key, JSON.stringify(match.rec));

  // Fire the thank-you email the first time a booking lands on
  // "returned". Skip if it was already returned (shouldn't happen via
  // the strict-equality check above, but cheap belt-and-suspenders).
  let emailResult = null;
  if (newStatus === "returned" && prevStatus !== "returned") {
    if (env.RESEND_API_KEY) {
      try {
        await sendThankYouEmail(match.rec, env);
        emailResult = "sent";
      } catch (e) {
        emailResult = "failed: " + (e?.message || String(e));
        console.error("thank-you email failed:", emailResult);
      }
    } else {
      emailResult = "skipped (no RESEND_API_KEY)";
    }
  }

  return json({ ok: true, status: newStatus, prevStatus, email: emailResult });
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

// Customer-facing thank-you email sent when status transitions to
// "returned". Asks for a Google review with a button that links
// directly to the PCGC review form (the owner-supplied share.google
// link bypasses the in-between /leave-a-review/ landing — one less
// click, higher conversion).
async function sendThankYouEmail(record, env) {
  const customer = record.contact || {};
  const to = customer.email;
  if (!to) throw new Error("no customer email on booking");
  const from = env.BOOKING_FROM_EMAIL || "bookings@polkcountygolfcarts.com";

  const subject = `Thanks for renting with Polk County Golf Carts!`;
  const reviewUrl = "https://share.google/RjxLOjukDYZrEakMq";
  const firstName = (customer.name || "").split(/\s+/)[0] || "there";

  const html = `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif; max-width:560px; margin:0 auto; padding:1rem; color:#222;">
    <h2 style="color:#1f5a68; margin:0 0 .75rem;">Thanks, ${escHtml(firstName)}!</h2>
    <p>The cart's back safely — hope you had a great time out there.</p>
    <p>If you've got a minute, the best thing you can do for a small family-owned shop like ours is leave a quick review on Google. It honestly makes a huge difference.</p>
    <p style="margin:1.5rem 0;">
      <a href="${reviewUrl}" style="display:inline-block; background:#e85a4f; color:#fff; padding:.85rem 1.4rem; border-radius:8px; text-decoration:none; font-weight:600;">Leave a quick review &rarr;</a>
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
    reviewUrl,
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
      from: `Polk County Golf Carts <${from}>`,
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
        from: `PCGC Booking Test <${from}>`,
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
