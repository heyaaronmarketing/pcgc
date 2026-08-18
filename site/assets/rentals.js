/* Polk County Golf Carts — rental flow controller.
 *
 * Single-page, four-step wizard backed by sessionStorage. Carts FIRST
 * (AirBnB-style browse), then dates, contact, payment. Posts the
 * final booking to /api/booking (handled by src/worker.js). All
 * pricing math lives in computePrice(); change the rules there.
 *
 * Inventory: 4 × 4-seater carts @ $75/day + 1 × 6-seater Limo
 * @ $125/day. Free pickup & delivery within 25 miles of Livingston;
 * extended delivery (25–100 mi) is an extra charge quoted separately
 * by PCGC (not auto-billed in checkout).
 *
 * The four 4-seaters re-use two source photos (a + b) — the carts
 * are similar enough that not every one needs a unique shot.
 */

// Fleet — matches the physical inventory numbered by John. Cart #2 is
// the Limo; #3-#6 are the four Yamahas. Make/model/serial are shown on
// the /rentals/ Step 2 tile and on the /agreement/ page so the rental
// agreement always identifies the exact cart(s) leaving the lot.
const CARTS = [
  { id: "cart-2", cartNo: 2, name: "Cart #2 — The Limo", seats: 6, price: 125,
    make: "Club Car Limo", modelDetails: "Gas · White", serial: "LG9939-808771",
    img: "/assets/photos/rentals/limo.jpg", desc: "6-seater Limo. Three rows of seating for the whole crew." },
  { id: "cart-3", cartNo: 3, name: "Cart #3", seats: 4, price: 75,
    make: "Yamaha", modelDetails: "Gas · Tan", serial: "J0B-001578",
    img: "/assets/photos/rentals/4-seater-a.jpg", desc: "4-seater golf cart with rear flip seat." },
  { id: "cart-4", cartNo: 4, name: "Cart #4", seats: 4, price: 75,
    make: "Yamaha", modelDetails: "Gas · Tan", serial: "J0B-105687",
    img: "/assets/photos/rentals/4-seater-b.jpg", desc: "4-seater golf cart with rear flip seat." },
  { id: "cart-5", cartNo: 5, name: "Cart #5", seats: 4, price: 75,
    make: "Yamaha", modelDetails: "Gas · Tan", serial: "J0B-105659",
    img: "/assets/photos/rentals/4-seater-a.jpg", desc: "4-seater golf cart with rear flip seat." },
  { id: "cart-6", cartNo: 6, name: "Cart #6", seats: 4, price: 75,
    make: "Yamaha", modelDetails: "Gas · Grey", serial: "J0K-203736",
    img: "/assets/photos/rentals/4-seater-b.jpg", desc: "4-seater golf cart with rear flip seat." },
];

// One copy of each cart exists in the fleet — a renter can pick up to
// 1 of each. (Total fleet = 6.)
const PER_CART_MAX_QTY = 1;
const MAX_CARTS = CARTS.length;
// Extended delivery (25-100 mi) is billed separately by PCGC — we don't
// auto-charge a number that contradicts the "extra charge" label.
const DELIVERY_EXTENDED_FEE = 0;
const TAX_RATE = 0.0825;

// ---------- State ----------
// Bumped to v5 for the address-split schema change (street/city/state/
// zip are now separate fields; the old `address` slot is repurposed as
// the delivery drop-off location). v4 sessions get a clean slate.
const STORAGE_KEY = "pcgc.rental.v6";
const state = loadState() || {
  step: 1,
  dates: { start: "", end: "", pickupTime: "am", dropoffTime: "am" },
  selection: {},          // { cartId: qty }
  bookedIds: [],          // cart ids unavailable for the selected dates
  availabilityOk: true,   // false if /api/availability errored
  delivery: "pickup",
  contact: {
    name: "", email: "", phone: "", guests: 2,
    street: "", city: "", state: "", zip: "",
    address: "",  // delivery drop-off (only used when delivery != "pickup")
    notes: "",
  },
};

function saveState() {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}
function loadState() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)); } catch (_) { return null; }
}

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function fmtMoney(n) { return "$" + n.toFixed(2); }
function fmtMoneyShort(n) {
  // Drop trailing .00 for clean per-day display ($75 not $75.00)
  return "$" + n.toFixed(2).replace(/\.00$/, "");
}

function daysBetween(a, b) {
  if (!a || !b) return 0;
  const start = new Date(a + "T00:00:00");
  const end = new Date(b + "T00:00:00");
  return Math.max(0, Math.round((end - start) / 86400000));
}

// Charged rental length in half-day units. Standard rental math:
//   pickup before noon  → full day counted for pickup day
//   pickup after noon   → half day counted for pickup day
//   dropoff before noon → half day counted for dropoff day
//   dropoff after noon  → full day counted for dropoff day
// Base = inclusive-day count (Fri→Sat = 2). Subtract 0.5 for an
// afternoon pickup or a morning dropoff. Same-day rentals collapse
// naturally (Fri am→Fri pm = 1, Fri pm→Fri pm = 0.5, etc.).
function chargedDays(startIso, endIso, pickupTime, dropoffTime) {
  if (!startIso || !endIso) return 0;
  const inclusive = daysBetween(startIso, endIso) + 1;
  let d = inclusive;
  if (pickupTime === "pm") d -= 0.5;
  if (dropoffTime === "am") d -= 0.5;
  return Math.max(0, d);
}

// Human label for fractional days: "1 day", "1.5 days", "0.5 day".
function fmtDaysLabel(d) {
  return `${d} day${d === 1 ? "" : "s"}`;
}

// US federal + observable holidays that trigger the 2-day minimum.
// Kept as MM-DD strings so any year matches without maintenance for
// fixed-date holidays. Floating holidays (Memorial Day, Thanksgiving)
// are handled below in the "special weeks" check.
const HOLIDAYS_FIXED = new Set([
  "01-01", // New Year's Day
  "07-03", "07-04", "07-05", // July 4th window
  "12-24", "12-25", "12-26", // Christmas window
  "12-31", // New Year's Eve
]);

function isHoliday(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  if (HOLIDAYS_FIXED.has(`${mm}-${dd}`)) return true;
  // Memorial Day: last Monday of May
  if (date.getMonth() === 4 && date.getDay() === 1 && date.getDate() >= 25) return true;
  // Labor Day: first Monday of September
  if (date.getMonth() === 8 && date.getDay() === 1 && date.getDate() <= 7) return true;
  // Thanksgiving + Black Friday: 4th Thursday of Nov and the Friday after
  if (date.getMonth() === 10) {
    if (date.getDay() === 4 && date.getDate() >= 22 && date.getDate() <= 28) return true;
    if (date.getDay() === 5 && date.getDate() >= 23 && date.getDate() <= 29) return true;
  }
  return false;
}

// Walks the date range inclusively and returns true if ANY day falls on
// Saturday, Sunday, or a recognized holiday.
function rangeHitsWeekendOrHoliday(startIso, endIso) {
  const start = new Date(startIso + "T00:00:00");
  const end = new Date(endIso + "T00:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return true;
    if (isHoliday(d)) return true;
  }
  return false;
}

function totalCarts() {
  return Object.values(state.selection).reduce((s, n) => s + (n | 0), 0);
}

function perDayCarts() {
  // Sum of (per-day price × qty) — independent of trip length.
  let sum = 0;
  for (const cart of CARTS) {
    const qty = state.selection[cart.id] | 0;
    if (qty > 0) sum += cart.price * qty;
  }
  return sum;
}

function computePrice() {
  const days = chargedDays(state.dates.start, state.dates.end, state.dates.pickupTime, state.dates.dropoffTime);
  const perDay = perDayCarts();
  const subtotal = perDay * Math.max(0, days);
  const deliveryFee = state.delivery === "extended" ? DELIVERY_EXTENDED_FEE : 0;
  const afterDelivery = subtotal + deliveryFee;
  const tax = afterDelivery * TAX_RATE;
  const grand = afterDelivery + tax;
  return { days, perDay, subtotal, deliveryFee, tax, grand, total: totalCarts() };
}

// ---------- Step navigation ----------
function goTo(step) {
  state.step = step;
  saveState();
  $$(".rental-step").forEach(el => {
    el.hidden = (Number(el.dataset.step) !== step);
  });
  $$(".rental-progress li").forEach(li => {
    const n = Number(li.dataset.step);
    li.classList.toggle("active", n === step);
    li.classList.toggle("done", n < step);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (step === 1) syncDatesStep();
  if (step === 2) renderCartGrid();
  if (step === 4) {
    renderPaymentSummary();
    renderAgreementFleet();
    // Init or resize the signature pad now that Step 4 is visible.
    // signature_pad handles the DPI + pointer-event details; we just
    // need to make sure the canvas has real dimensions.
    initSignaturePad();
    resizeSigCanvas();
  }
  if (step === 5) renderConfirmation();
}

// ---------- Step 2: Carts (filtered by availability) ----------
function renderCartGrid() {
  const grid = $("#cart-grid");
  const allBooked = $("#all-booked");
  const availLine = $("#cart-availability-line");
  const warn = $("#availability-warning");
  grid.innerHTML = "";

  const booked = new Set(state.bookedIds || []);
  const availableCount = CARTS.filter(c => !booked.has(c.id)).length;

  // Empty state when literally nothing is left for those dates.
  if (availableCount === 0) {
    grid.hidden = true;
    allBooked.hidden = false;
    $("#rental-total").hidden = true;
  } else {
    grid.hidden = false;
    allBooked.hidden = true;
  }

  // Availability headline with the actual count.
  if (state.dates.start && state.dates.end) {
    const start = fmtDate(state.dates.start);
    const end = fmtDate(state.dates.end);
    availLine.innerHTML = `<b>${availableCount} of ${CARTS.length} carts</b> available ${start} → ${end}. 4-seaters $75/day, Limo $125/day.`;
  }
  warn.hidden = state.availabilityOk !== false;

  for (const cart of CARTS) {
    const qty = state.selection[cart.id] | 0;
    const isBooked = booked.has(cart.id);
    const tile = document.createElement("article");
    tile.className = "cart-tile" + (qty > 0 ? " selected" : "") + (isBooked ? " booked" : "");
    tile.innerHTML = `
      <img src="${cart.img}" alt="${cart.name}" loading="lazy">
      ${isBooked ? '<div class="cart-booked-overlay">Booked for these dates</div>' : ''}
      <div class="cart-tile-body">
        <h3>${cart.name}</h3>
        <div class="badges">
          <span class="badge">${cart.seats}-seater</span>
          <span class="badge">${cart.make}</span>
          <span class="badge cart-serial" title="Serial number">${cart.serial}</span>
        </div>
        <p class="desc">${cart.desc}</p>
        <div class="footer">
          <span class="price">${fmtMoneyShort(cart.price)}<small> / day</small></span>
          <div class="stepper" data-id="${cart.id}">
            <button type="button" data-act="dec" aria-label="Remove" ${qty === 0 || isBooked ? "disabled" : ""}>−</button>
            <b>${qty}</b>
            <button type="button" data-act="inc" aria-label="Add" ${qty >= PER_CART_MAX_QTY || isBooked ? "disabled" : ""}>+</button>
          </div>
        </div>
      </div>
    `;
    grid.appendChild(tile);
  }
  grid.addEventListener("click", onStepperClick);
  updateTotalBar();
}

function onStepperClick(ev) {
  const btn = ev.target.closest("button[data-act]");
  if (!btn || btn.disabled) return;
  const stepperEl = btn.closest(".stepper");
  if (!stepperEl) return;
  const id = stepperEl.dataset.id;
  // Booked carts can't be added (also protected by disabled, but
  // belt-and-suspenders against rapid clicks during re-renders).
  if ((state.bookedIds || []).includes(id)) return;
  const current = state.selection[id] | 0;
  let next = current;
  if (btn.dataset.act === "inc") {
    if (current >= PER_CART_MAX_QTY) return;
    next = current + 1;
  } else {
    next = Math.max(0, current - 1);
  }
  if (next === 0) delete state.selection[id];
  else state.selection[id] = next;
  saveState();
  renderCartGrid();
}

function updateTotalBar() {
  const bar = $("#rental-total");
  const total = totalCarts();
  if (total === 0) { bar.hidden = true; return; }
  bar.hidden = false;
  const days = chargedDays(state.dates.start, state.dates.end, state.dates.pickupTime, state.dates.dropoffTime);
  const perDay = perDayCarts();
  $("#total-count").textContent = total;
  $("#total-count-s").textContent = total === 1 ? "" : "s";
  // We have dates by the time we hit step 2 — show the trip total.
  if (days > 0) {
    $("#total-amount").textContent = `${fmtMoney(perDay * days)} (${fmtDaysLabel(days)})`;
  } else {
    $("#total-amount").textContent = `${fmtMoneyShort(perDay)} / day`;
  }
  $("#to-step-3").disabled = total === 0;
}

// Fetch which cart IDs are booked for the selected dates. Fail-open:
// any error → empty array + availabilityOk:false so the UI shows a
// "couldn't verify" notice but doesn't block bookings.
async function fetchAvailability() {
  if (!state.dates.start || !state.dates.end) return { booked: [], ok: true };
  try {
    const url = `/api/availability?start=${state.dates.start}&end=${state.dates.end}`;
    const res = await fetch(url);
    if (!res.ok) return { booked: [], ok: false };
    const data = await res.json();
    return { booked: data.booked || [], ok: true };
  } catch (e) {
    return { booked: [], ok: false };
  }
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ---------- Step 1: Dates ----------
function syncDatesStep() {
  const start = $("#date-start");
  const end = $("#date-end");
  const today = new Date().toISOString().slice(0, 10);
  start.min = today;
  end.min = today;
  if (state.dates.start) start.value = state.dates.start;
  if (state.dates.end) end.value = state.dates.end;
  updateDurationLine();
}

function updateDurationLine() {
  const start = $("#date-start").value;
  const end = $("#date-end").value;
  const pickupSel = $("#pickup-time");
  const dropoffSel = $("#dropoff-time");
  const pickupTime = pickupSel ? pickupSel.value : state.dates.pickupTime;
  const dropoffTime = dropoffSel ? dropoffSel.value : state.dates.dropoffTime;
  state.dates.start = start;
  state.dates.end = end;
  state.dates.pickupTime = pickupTime;
  state.dates.dropoffTime = dropoffTime;
  const d = chargedDays(start, end, pickupTime, dropoffTime);
  const out = $("#duration-out");
  // Show the charged length once both dates + times are chosen so the
  // customer sees the half-day math ("1.5 days") before continuing.
  if (start && end && d < 0.5) {
    out.textContent = "That's less than a half day — pick a later dropoff or move the dropoff to the afternoon.";
  } else if (start && end && d > 0) {
    out.textContent = `Charged length: ${fmtDaysLabel(d)}.`;
  } else {
    out.textContent = "";
  }
  saveState();
}

function initStep1() {
  // Once-per-session flow-start ping so the analytics dashboard has
  // a denominator for the booking-submission conversion rate.
  try {
    if (!sessionStorage.getItem("pcgc.rental.flow_started")) {
      sessionStorage.setItem("pcgc.rental.flow_started", "1");
      if (window.pcgcTrack) window.pcgcTrack("rental-flow-start");
    }
  } catch (_) {}

  const start = $("#date-start");
  const end = $("#date-end");
  const today = new Date().toISOString().slice(0, 10);

  // flatpickr gives us a consistent picker across desktop / tablet /
  // mobile. `disableMobile: true` forces flatpickr's own UI on mobile
  // too (default would fall back to native, which then looks different
  // from desktop). altInput swaps the visible field to a friendly
  // "Sat, Aug 15, 2026" string while keeping the underlying ISO
  // value the rest of the code reads via .value.
  function mountFlatpickr() {
    if (typeof flatpickr === "undefined") { setTimeout(mountFlatpickr, 100); return; }
    const startPicker = flatpickr(start, {
      minDate: "today",
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "l, F j, Y",
      disableMobile: true,
      defaultDate: state.dates.start || null,
      onChange: (dates) => {
        const iso = dates[0] ? formatIso(dates[0]) : "";
        start.value = iso;
        // Keep the end picker's min in sync so nothing before the
        // new start is selectable.
        if (endPicker) endPicker.set("minDate", iso || "today");
        // Clear a stale end that's now before the new start.
        if (iso && end.value && end.value < iso) {
          if (endPicker) endPicker.clear();
          end.value = "";
        }
        updateDurationLine();
      },
    });
    const endPicker = flatpickr(end, {
      minDate: state.dates.start || "today",
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "l, F j, Y",
      disableMobile: true,
      defaultDate: state.dates.end || null,
      onChange: (dates) => {
        end.value = dates[0] ? formatIso(dates[0]) : "";
        updateDurationLine();
      },
    });
  }
  mountFlatpickr();

  // Time-of-day selects (before-noon / after-noon) drive the half-day
  // pricing. Restore any saved selection and re-run the duration line
  // when either changes so the "Charged length" note updates live.
  const pickupSel = $("#pickup-time");
  const dropoffSel = $("#dropoff-time");
  if (pickupSel && state.dates.pickupTime) pickupSel.value = state.dates.pickupTime;
  if (dropoffSel && state.dates.dropoffTime) dropoffSel.value = state.dates.dropoffTime;
  if (pickupSel) pickupSel.addEventListener("change", updateDurationLine);
  if (dropoffSel) dropoffSel.addEventListener("change", updateDurationLine);

  function formatIso(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  $("#to-step-2").addEventListener("click", async () => {
    const errEl = $("#date-error");
    errEl.hidden = true;
    if (!state.dates.start || !state.dates.end) {
      errEl.textContent = "Pick both a pickup date and a return date.";
      errEl.hidden = false;
      return;
    }
    const days = chargedDays(state.dates.start, state.dates.end, state.dates.pickupTime, state.dates.dropoffTime);
    if (days < 0.5) {
      errEl.textContent = "Rental must be at least a half day. Pick a later dropoff date or set the dropoff time to after noon.";
      errEl.hidden = false;
      return;
    }
    // Weekend/holiday rentals need a 2-day minimum. Weekend = any day
    // in the rental range that falls on Saturday or Sunday; holidays
    // reuse the same rule via a US federal + Texas-notable holiday
    // list defined below.
    if (rangeHitsWeekendOrHoliday(state.dates.start, state.dates.end) && days < 2) {
      errEl.textContent = "Weekend and holiday rentals require a 2-day minimum.";
      errEl.hidden = false;
      return;
    }
    // Block the button while we check availability so a double-click
    // doesn't double-fetch and double-advance.
    const btn = $("#to-step-2");
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Checking availability…";
    const { booked, ok } = await fetchAvailability();
    state.bookedIds = booked;
    state.availabilityOk = ok;
    // Drop any selected cart that is now booked (handles the case
    // where the user came back, changed dates, and a cart they had
    // selected is no longer available for the new range).
    for (const id of booked) delete state.selection[id];
    saveState();
    btn.disabled = false;
    btn.textContent = prev;
    goTo(2);
  });
}

// Step 2 has its own "Continue → step 3" button inside the floating
// total bar. Wire it once at boot so the carts step can advance.
function initStep2Continue() {
  $("#to-step-3").addEventListener("click", () => {
    if (totalCarts() === 0) return;
    goTo(3);
  });
}

// ---------- Step 3: Details ----------
function initStep3() {
  $$('input[name="delivery"]').forEach(r => {
    r.checked = r.value === state.delivery;
    r.addEventListener("change", () => {
      state.delivery = r.value;
      $("#address-field").hidden = (state.delivery === "pickup");
      saveState();
    });
  });
  $("#address-field").hidden = (state.delivery === "pickup");

  const fields = {
    "contact-name":    "name",
    "contact-phone":   "phone",
    "contact-email":   "email",
    "contact-guests":  "guests",
    "contact-street":  "street",
    "contact-city":    "city",
    "contact-state":   "state",
    "contact-zip":     "zip",
    "contact-address": "address",
    "contact-notes":   "notes",
  };
  for (const [id, key] of Object.entries(fields)) {
    const el = $("#" + id);
    if (!el) continue;
    if (state.contact[key]) el.value = state.contact[key];
    el.addEventListener("input", () => {
      state.contact[key] = el.value;
      saveState();
    });
  }

  // "Same as billing" — when checked, drop-off input auto-fills
  // from billing (street + city, state zip) and the field hides.
  // Uncheck reveals + clears the field.
  const sameChk = $("#dropoff-same-as-billing");
  const dropoffWrap = $("#dropoff-field-wrap");
  const dropoffInput = $("#contact-address");
  function billingFormatted() {
    const c = state.contact;
    const line2 = [c.city, c.state].filter(Boolean).join(", ");
    return [c.street, [line2, c.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  }
  function applySameAsBilling() {
    if (!sameChk?.checked) {
      dropoffWrap.hidden = false;
      return;
    }
    const filled = billingFormatted();
    if (!filled) {
      // Nothing to copy yet — show a hint below the checkbox.
      dropoffWrap.hidden = false;
      dropoffInput.value = "";
      state.contact.address = "";
      saveState();
      return;
    }
    dropoffInput.value = filled;
    state.contact.address = filled;
    dropoffWrap.hidden = true;
    saveState();
  }
  sameChk?.addEventListener("change", applySameAsBilling);
  // Re-copy the billing address whenever any billing field changes,
  // so a customer who ticks the box THEN edits their address doesn't
  // end up with a stale drop-off value.
  ["contact-street", "contact-city", "contact-state", "contact-zip"].forEach(id => {
    $("#" + id)?.addEventListener("input", () => { if (sameChk?.checked) applySameAsBilling(); });
  });
  // Re-apply on radio flips too — the wrapper's visibility is
  // controlled by both delivery choice AND the checkbox.
  $$('input[name="delivery"]').forEach(r => r.addEventListener("change", () => {
    if (state.delivery !== "pickup" && sameChk?.checked) applySameAsBilling();
  }));

  $("#to-step-4").addEventListener("click", () => {
    const err = $("#details-error");
    err.hidden = true;
    const c = state.contact;
    if (!c.name || !c.email || !c.phone) {
      err.textContent = "Name, email, and phone are required.";
      err.hidden = false;
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(c.email)) {
      err.textContent = "That email doesn't look right.";
      err.hidden = false;
      return;
    }
    if (!c.street.trim() || !c.city.trim() || !c.state.trim() || !c.zip.trim()) {
      err.textContent = "Please fill in your full address (street, city, state, ZIP).";
      err.hidden = false;
      return;
    }
    if (!/^\d{5}(-\d{4})?$/.test(c.zip.trim())) {
      err.textContent = "ZIP should be 5 digits (or 5+4).";
      err.hidden = false;
      return;
    }
    if (state.delivery !== "pickup" && !c.address.trim()) {
      err.textContent = "Add the delivery drop-off location.";
      err.hidden = false;
      return;
    }
    if (Number(c.guests) < 1) {
      err.textContent = "Number of guests must be at least 1.";
      err.hidden = false;
      return;
    }
    goTo(4);
  });
}

// ---------- Step 4: Review & submit ----------
function renderPaymentSummary() {
  const out = $("#rental-summary");
  const p = computePrice();
  const lines = [];
  for (const cart of CARTS) {
    const qty = state.selection[cart.id] | 0;
    if (!qty) continue;
    const lineTotal = cart.price * qty * p.days;
    lines.push(`<div class="row"><span>${cart.name} × ${qty} · ${fmtDaysLabel(p.days)}</span><span>${fmtMoney(lineTotal)}</span></div>`);
  }
  lines.push(`<div class="row"><span>Subtotal</span><span>${fmtMoney(p.subtotal)}</span></div>`);
  if (state.delivery === "extended") {
    lines.push(`<div class="row muted"><span>Extended delivery (25–100 mi)</span><span>Quoted separately</span></div>`);
  }
  lines.push(`<div class="row"><span>Tax (${(TAX_RATE * 100).toFixed(2)}%)</span><span>${fmtMoney(p.tax)}</span></div>`);
  lines.push(`<div class="row total"><span>Total</span><span>${fmtMoney(p.grand)}</span></div>`);
  out.innerHTML = lines.join("");

  // Deposit note appears only when the pickup date is 3+ months out.
  const depositNote = $("#deposit-note");
  if (depositNote) depositNote.hidden = !bookingIsFarOut();
  // #review-requirements used to live in a dedicated info box on
  // Step 4; that box was removed (the DL delivery chooser inside the
  // rental agreement covers the same information). Leaving no code
  // that references it here.
}

// True when the pickup date is 3+ months (~90 days) after today. Owner's
// docx: 50% deposit required to book that far out.
function bookingIsFarOut() {
  if (!state.dates.start) return false;
  const start = new Date(state.dates.start + "T00:00:00");
  const now = new Date();
  const diffDays = (start - now) / 86400000;
  return diffDays >= 90;
}

function initStep4() {
  $("#pay-now").addEventListener("click", submitBooking);
  // Inline rental-agreement pieces (fleet grid, DL upload, signature).
  // Payment happens offline — PCGC calls the customer after the
  // booking lands. No inline card fields to wire.
  initAgreementUi();
}

// ---------- Inline rental agreement (moved from /agreement/ page) ----------
// State captured from the agreement UI at submit time.
let agreementDlImage = null;      // data URL of the uploaded DL photo (or null)
let sigCanvas = null;             // <canvas> element
let sigPad = null;                // SignaturePad instance (from CDN)
let sigTypedRendered = false;     // canvas holds a typed-name auto-render

function initAgreementUi() {
  renderAgreementFleet();

  // Read-through gate for the "I agree" checkbox — it stays locked
  // until the customer scrolls to the bottom of the terms box. The
  // hint above the checkbox flips from amber ("Scroll…") to green
  // once fulfilled.
  const termsBox = $("#agreement-terms-box");
  const agreedCheck = $("#agreed");
  const agreedWrap = agreedCheck?.closest(".agree-check");
  const scrollHint = $("#agreement-scroll-hint");
  function markAgreementRead() {
    if (!agreedCheck || !agreedWrap) return;
    agreedCheck.disabled = false;
    agreedWrap.classList.remove("locked");
    if (scrollHint) {
      scrollHint.classList.add("scroll-complete");
      scrollHint.textContent = "You've read the agreement — check the box to confirm.";
    }
  }
  if (termsBox && agreedCheck) {
    agreedWrap?.classList.add("locked");
    termsBox.addEventListener("scroll", () => {
      // Within 12px of the bottom counts as "read". Handles rounding
      // when devicePixelRatio doesn't divide the content height cleanly.
      const remaining = termsBox.scrollHeight - termsBox.scrollTop - termsBox.clientHeight;
      if (remaining < 12) markAgreementRead();
    });
    // Short-circuit for viewports where the terms don't overflow the
    // scroll box (unlikely at current copy length, but future-proof).
    if (termsBox.scrollHeight <= termsBox.clientHeight + 4) markAgreementRead();
  }
  if (agreedCheck) {
    agreedCheck.addEventListener("change", () => {
      agreedWrap?.classList.toggle("checked", agreedCheck.checked);
      clearFieldError(agreedWrap);
    });
  }

  sigCanvas = $("#sig-canvas");
  if (!sigCanvas) return;
  // signature_pad may not be loaded yet (defer'd on the <script>). If
  // so, wait one tick and try again — it's usually fine by the time
  // the customer navigates from step 1 to step 4.
  initSignaturePad();

  $("#sig-clear").addEventListener("click", () => {
    if (sigPad) sigPad.clear();
    sigTypedRendered = false;
  });

  // Auto-render the typed name into the canvas as a signature-style
  // preview whenever the customer types. If they draw over it, their
  // strokes replace the typed version; clearing + retyping renders again.
  const typed = $("#typed-name");
  if (typed) {
    typed.addEventListener("input", () => {
      // Only redraw if the canvas is empty OR currently shows a typed
      // render (never clobber a manually-drawn signature).
      if (!sigPad) return;
      if (sigPad.isEmpty() || sigTypedRendered) {
        renderTypedSignature(typed.value.trim());
      }
    });
  }

  window.addEventListener("resize", resizeSigCanvas);

  // DL delivery-method radios — show/hide the upload box.
  $$('input[name="dl-method"]').forEach(r => r.addEventListener("change", updateDlMethodUi));
  updateDlMethodUi();

  // DL upload — client-side resize + preview.
  $("#dl-file").addEventListener("change", handleDlFile);
}

function initSignaturePad() {
  if (sigPad || !sigCanvas) return;
  if (typeof SignaturePad === "undefined") {
    // Script hasn't loaded yet — retry shortly.
    setTimeout(initSignaturePad, 200);
    return;
  }
  resizeSigCanvas();
  sigPad = new SignaturePad(sigCanvas, {
    backgroundColor: "rgba(255,255,255,0)",
    penColor: "#1f5a68",
    minWidth: 1.2,
    maxWidth: 3.0,
    velocityFilterWeight: 0.7,
  });
  // If the canvas currently shows a typed-name auto-render, wipe the
  // painted glyphs (not signature_pad's stroke data) so the user's
  // freehand drawing lands on a clean surface instead of overlapping.
  sigPad.addEventListener("beginStroke", () => {
    if (sigTypedRendered) {
      const ctx = sigCanvas.getContext("2d");
      const ratio = window.devicePixelRatio || 1;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
      ctx.restore();
      sigTypedRendered = false;
    }
  });
}

// Resize the canvas to its CSS size scaled to the device pixel ratio.
// Uses signature_pad's own fromData()/toData() to preserve strokes
// across resize — no fragile drawImage() dance like the previous
// hand-rolled pad.
function resizeSigCanvas() {
  if (!sigCanvas) return;
  const rect = sigCanvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const ratio = window.devicePixelRatio || 1;
  const savedData = sigPad ? sigPad.toData() : null;
  const wasTyped = sigTypedRendered;
  const typed = $("#typed-name")?.value?.trim() || "";
  sigCanvas.width = Math.floor(rect.width * ratio);
  sigCanvas.height = Math.floor(rect.height * ratio);
  const ctx = sigCanvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (sigPad && savedData && savedData.length) sigPad.fromData(savedData);
  else if (wasTyped && typed) renderTypedSignature(typed);
}

function renderTypedSignature(name) {
  if (!sigPad || !sigCanvas) return;
  const ctx = sigCanvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const cssW = sigCanvas.width / ratio;
  const cssH = sigCanvas.height / ratio;
  sigPad.clear();
  if (!name) { sigTypedRendered = false; return; }
  ctx.save();
  const size = Math.max(30, Math.min(72, Math.floor(cssH * 0.6)));
  ctx.font = `${size}px "Cedarville Cursive", "Snell Roundhand", "Segoe Script", cursive`;
  ctx.fillStyle = "#1f5a68";
  ctx.textAlign = "left";
  // True optical centering: measure the actual glyph bounding box
  // (Cedarville Cursive has heavy descenders under the baseline —
  // textBaseline:"middle" alone leaves the visible mass too high).
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText(name);
  const ascent = m.actualBoundingBoxAscent  || size * 0.75;
  const descent = m.actualBoundingBoxDescent || size * 0.25;
  const glyphH = ascent + descent;
  // baseline Y so that (baseline - ascent) + glyphH/2 lands at cssH/2
  const baselineY = (cssH / 2) + (glyphH / 2) - descent;
  ctx.fillText(name, 24, baselineY);
  ctx.restore();
  // Tell signature_pad this counts as "not empty" for isEmpty().
  // signature_pad uses internal stroke data, so we mark our flag
  // instead and check both when we validate at submit time.
  sigTypedRendered = true;
}

function renderAgreementFleet() {
  const grid = $("#agreement-fleet-grid");
  if (!grid) return;
  const rented = new Set(Object.entries(state.selection || {}).filter(([, q]) => q > 0).map(([id]) => id));
  // Owner request: agreement should only show the cart(s) the
  // customer is actually renting, WITH the cart photo.
  const rentedCarts = CARTS.filter(c => rented.has(c.id));
  if (!rentedCarts.length) {
    grid.innerHTML = '<div class="fleet-cart" style="opacity:.7">No carts selected — go back and pick at least one.</div>';
    return;
  }
  grid.innerHTML = rentedCarts.map(cart => `
    <div class="fleet-cart rented">
      <img src="${cart.img}" alt="${cart.name}" loading="lazy" style="width:100%; aspect-ratio:4/3; object-fit:cover; border-radius:6px; margin-bottom:.4rem;">
      <h5>${cart.name}</h5>
      <div class="meta">${cart.make} · ${cart.modelDetails || ''}<br>Serial <code>${cart.serial}</code></div>
    </div>
  `).join("");
}

// Custom pointer handlers replaced by signature_pad — see
// initSignaturePad() above. sigStart/sigMove/sigEnd/sigPos removed.

function updateDlMethodUi() {
  const method = document.querySelector('input[name="dl-method"]:checked')?.value || "upload";
  const box = $("#dl-upload-box");
  if (!box) return;
  box.hidden = (method !== "upload");
  if (method !== "upload") {
    $("#dl-file").value = "";
    agreementDlImage = null;
    resetDlDropUi();
  }
}

function resetDlDropUi() {
  const dropEmpty = document.querySelector(".dl-drop-empty");
  const dropPreview = document.querySelector(".dl-drop-preview");
  const img = $("#dl-preview");
  if (dropEmpty) dropEmpty.hidden = false;
  if (dropPreview) dropPreview.hidden = true;
  if (img) img.removeAttribute("src"); // clearing src avoids the broken-image icon
}
function showDlDropPreview(dataUrl) {
  const dropEmpty = document.querySelector(".dl-drop-empty");
  const dropPreview = document.querySelector(".dl-drop-preview");
  const img = $("#dl-preview");
  if (img) img.src = dataUrl;
  if (dropEmpty) dropEmpty.hidden = true;
  if (dropPreview) dropPreview.hidden = false;
}

async function handleDlFile() {
  const file = $("#dl-file").files && $("#dl-file").files[0];
  if (!file) { agreementDlImage = null; resetDlDropUi(); return; }
  try {
    const url = await resizeImage(file, 1600, 0.72);
    if (!url || !url.startsWith("data:image/")) throw new Error("bad url");
    agreementDlImage = url;
    showDlDropPreview(url);
  } catch (_) {
    agreementDlImage = null;
    resetDlDropUi();
    alert("Could not process that image. iPhone HEIC photos sometimes fail — try picking a JPG/PNG from your photo library, or select 'text a photo to 936-223-1182' below.");
  }
}

function resizeImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode"));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Returns { ok: true, agreement } or { ok: false, msg }. Called from
// submitBooking() before we POST — surfaces inline errors on missing
// fields instead of round-tripping to the server.
function collectAgreement() {
  const dlNumber = $("#dl-number").value.trim();
  const dlState = $("#dl-state").value.trim();
  const typedName = $("#typed-name").value.trim();
  const agreed = $("#agreed").checked;
  const dlMethod = document.querySelector('input[name="dl-method"]:checked')?.value || "upload";

  // Collect ALL missing fields so we can red-highlight them at once
  // and let the customer fix everything in one pass, then jump to
  // the first one.
  const errors = []; // { field: <selector>, msg: string }
  if (!dlNumber) errors.push({ field: "#dl-number", msg: "Driver's license number" });
  if (!dlState) errors.push({ field: "#dl-state", msg: "State" });
  if (!agreed) errors.push({ field: ".agree-check", msg: "Read the agreement above and check the box to confirm" });
  const hasSignature = (sigPad && !sigPad.isEmpty()) || sigTypedRendered;
  if (!hasSignature) errors.push({ field: ".sig-box", msg: "Draw your signature — or type your name below to auto-generate one" });
  if (!typedName) errors.push({ field: "#typed-name", msg: "Type your full legal name" });
  if (dlMethod === "upload" && !agreementDlImage) {
    errors.push({ field: ".dl-drop", msg: "Attach your driver's license photo, or pick a different delivery option" });
  }

  if (errors.length) {
    // Build a friendly summary for the error banner too.
    const msg = errors.length === 1
      ? errors[0].msg + "."
      : `Please complete the highlighted field${errors.length > 1 ? "s" : ""}: ${errors.map(e => e.msg).join("; ")}.`;
    return { ok: false, msg, errors };
  }

  return {
    ok: true,
    agreement: {
      typedName,
      dlNumber,
      dlState,
      dlMethod,
      dlImageDataUrl: dlMethod === "upload" ? agreementDlImage : null,
      // signature_pad's toDataURL() is a thin wrapper around
      // canvas.toDataURL and captures both drawn strokes and any
      // typed-name auto-render we painted on top of the canvas.
      signatureDataUrl: (sigPad ? sigPad.toDataURL("image/png") : sigCanvas.toDataURL("image/png")),
      agreed: true,
    },
  };
}

// Red-highlight a field/element and set up a one-shot listener that
// clears the highlight as soon as the customer starts fixing it.
function markFieldError(selector) {
  const el = document.querySelector(selector);
  if (!el) return;
  // Prefer to highlight the enclosing .rental-field wrapper (so the
  // whole labeled row lights up); fall back to the element itself.
  const target = el.closest(".rental-field") || el;
  target.classList.add("field-error");
  const clearer = () => {
    target.classList.remove("field-error");
    el.removeEventListener("input", clearer);
    el.removeEventListener("change", clearer);
    el.removeEventListener("click", clearer);
  };
  el.addEventListener("input", clearer);
  el.addEventListener("change", clearer);
  el.addEventListener("click", clearer);
}
function clearFieldError(el) {
  if (!el) return;
  const target = el.closest ? (el.closest(".rental-field") || el) : el;
  target.classList?.remove?.("field-error");
}
function clearAllFieldErrors() {
  document.querySelectorAll(".field-error").forEach(el => el.classList.remove("field-error"));
}

async function submitBooking() {
  const err = $("#pay-error");
  err.hidden = true;
  clearAllFieldErrors();

  // Inline agreement validation runs first — nothing gets POSTed
  // until the customer has filled the license fields, drawn a
  // signature, and checked the "I agree" box. Any missed field
  // gets a red-border highlight that clears when they start
  // editing it.
  const collected = collectAgreement();
  if (!collected.ok) {
    err.textContent = collected.msg;
    err.hidden = false;
    (collected.errors || []).forEach(e => markFieldError(e.field));
    // Scroll the FIRST failed field into view so the customer sees
    // exactly where to start.
    const first = collected.errors?.[0]?.field
      ? document.querySelector(collected.errors[0].field)
      : err;
    (first || err).scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const btn = $("#pay-now");
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = "Submitting…";

  const booking = buildBookingRecord();
  // Attach the signed agreement to the booking POST so the Worker
  // stores it alongside the record. Server also validates.
  booking.signedAgreement = collected.agreement;

  // Generate the signed-agreement PDF client-side, attach it to the
  // POST as base64 (Worker stores + emails it as a Resend attachment),
  // and also stash the Blob so Step 5's Download button has it ready.
  // Never fail the booking on a PDF error — the KV record is what
  // matters; the PDF is a convenience layer.
  let pdfBlob = null;
  try {
    // Build a synthetic booking object shaped like the server-side
    // record so generateAgreementPdf sees the same fields it will
    // read out of KV later.
    const draft = {
      id: booking.id,
      dates: booking.dates,
      items: booking.items,
      delivery: booking.delivery,
      contact: booking.contact,
      agreement: {
        ...collected.agreement,
        signedAt: new Date().toISOString(),
      },
    };
    pdfBlob = await generateAgreementPdf(draft);
    if (pdfBlob) {
      const b64 = await blobToBase64(pdfBlob);
      // Cap outgoing payload — jsPDF should produce a small doc (<1MB),
      // but a DL image can bloat it. Anything over 5MB gets dropped
      // from the payload (customer can still download from Step 5).
      if (b64.length <= 5_000_000) {
        booking.signedAgreement.pdfBase64 = b64;
      } else {
        console.warn("Agreement PDF > 5MB, not uploading");
      }
    }
  } catch (e) {
    console.warn("Agreement PDF generation failed:", e?.message || e);
  }

  try {
    const res = await fetch("/api/booking", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(booking),
    });
    if (res.ok) {
      const body = await res.json();
      if (body.id) booking.id = body.id;
      // Stash the server-signed agreement URL so Step 5 can link to it.
      if (body.agreementPath) booking.agreementPath = body.agreementPath;
    } else {
      // 402 -> Clover declined the charge; the customer sees the
      // literal reason so they can try another card. Any other
      // failure is a generic retry prompt.
      let msg = "We couldn't reach our server. Please try again in a minute or call 936-223-1182.";
      try {
        const body = await res.json();
        if (res.status === 402) {
          msg = "Payment could not be completed" + (body.error ? `: ${body.error}` : "") + ". Please check your card details or try a different card. Call 936-223-1182 if you keep hitting this.";
        } else if (body.error) {
          msg = "Error: " + body.error;
        }
      } catch (_) {}
      err.textContent = msg;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = prevLabel;
      return;
    }
  } catch (_) {
    err.textContent = "Network error. Please try again or call 936-223-1182.";
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = prevLabel;
    return;
  }

  state.bookingId = booking.id;
  state.bookingRecord = booking;
  // Stash the PDF blob on a module-scoped map, keyed by booking id.
  // Not persisted to sessionStorage (would blow past its 5MB limit).
  // A user who bookmarks Step 5 and comes back can regen the PDF from
  // state.bookingRecord if we ever want that flow.
  if (pdfBlob) _pdfBlobs[booking.id] = pdfBlob;
  saveState();
  if (window.pcgcTrack) window.pcgcTrack("booking-submitted");
  goTo(5);
}

// Module-scoped cache: booking id -> agreement PDF Blob. Populated
// by submitBooking() after generation, read by the Step 5 download
// button. Not persisted to sessionStorage.
const _pdfBlobs = Object.create(null);

function buildBookingRecord() {
  const p = computePrice();
  const items = CARTS
    .filter(c => state.selection[c.id])
    .map(c => ({
      id: c.id, name: c.name, qty: state.selection[c.id],
      pricePerDay: c.price,
      lineTotal: c.price * state.selection[c.id] * p.days,
    }));
  const localId = "PCGC-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  return {
    id: localId,
    ts: new Date().toISOString(),
    dates: { ...state.dates, days: p.days },
    items,
    delivery: state.delivery,
    contact: { ...state.contact },
    pricing: {
      subtotal: p.subtotal,
      deliveryFee: p.deliveryFee,
      tax: p.tax,
      total: p.grand,
    },
  };
}

// ---------- Step 5: Confirmation ----------
function renderConfirmation() {
  const b = state.bookingRecord;
  if (!b) return;
  $("#booking-id").textContent = b.id;
  $("#confirm-email").textContent = b.contact.email || "your email";
  $("#confirm-phone").textContent = b.contact.phone || "your phone";
  const out = $("#confirm-summary");
  const lines = [];
  lines.push(`<div class="row"><span>Pickup</span><span>${fmtDate(b.dates.start)}</span></div>`);
  lines.push(`<div class="row"><span>Return</span><span>${fmtDate(b.dates.end)}</span></div>`);
  for (const it of b.items) {
    lines.push(`<div class="row"><span>${it.name} × ${it.qty}</span><span>${fmtMoney(it.lineTotal)}</span></div>`);
  }
  const deliveryLabel = {
    pickup: "Pickup at shop",
    local: "Free delivery (within 25 mi)",
    extended: "Extended delivery (25–100 mi)",
  }[b.delivery] || b.delivery;
  // For "extended" delivery the fee is quoted separately by PCGC; show
  // "Quoted separately" instead of $0 so the confirmation matches the
  // copy on step 3.
  const deliveryDisplay = b.delivery === "extended"
    ? "Quoted separately"
    : (b.pricing.deliveryFee ? fmtMoney(b.pricing.deliveryFee) : "Free");
  lines.push(`<div class="row"><span>${deliveryLabel}</span><span>${deliveryDisplay}</span></div>`);
  lines.push(`<div class="row total"><span>Total</span><span>${fmtMoney(b.pricing.total)}</span></div>`);
  out.innerHTML = lines.join("");

  // Per-delivery requirements. Owner's docx: everything goes to us by
  // text at time of payment. Pickup customers need DL + insurance +
  // plate photo; delivery only needs the driver's license of whoever
  // will drive.
  const isPickup = b.delivery === "pickup";
  $("#next-steps-title").textContent = "At time of payment — please text these to 936-223-1182";
  const requirements = isPickup
    ? [
        "Driver's license (photo or scan) for everyone who will be driving the cart",
        "Auto insurance (photo or scan)",
        "Photo of your vehicle's license plate (the vehicle we'll be loading the cart onto)",
      ]
    : [
        "Driver's license (photo or scan) for everyone who will be driving the cart",
      ];
  $("#requirements-list").innerHTML = requirements.map(r => `<li>${r}</li>`).join("");

  // Post-submit "Sign the agreement" CTA — the agreement is signed
  // inline on Step 4 now, so this becomes a "View your signed copy"
  // link instead of a call-to-action. Only surface when the Worker
  // returned an agreementPath (production only).
  const cta = document.getElementById("agreement-cta");
  const link = document.getElementById("agreement-link");
  if (b.agreementPath && cta && link) {
    link.href = b.agreementPath;
    link.textContent = "View your signed agreement →";
    const heading = cta.querySelector("h2");
    const body = cta.querySelector("p");
    if (heading) heading.textContent = "Your signed agreement";
    if (body) body.textContent = "A copy of the agreement you signed is available online — bookmark it or save it for your records.";
    cta.hidden = false;
  } else if (cta) {
    cta.hidden = true;
  }

  // Kick off the shareable-image generation — canvas draw is quick
  // (~200ms) but async because we wait on an <img> to load. The
  // share card unhides once the preview blob is ready.
  initShareCard(b);
  initPdfDownloadCta(b);
}

function initPdfDownloadCta(booking) {
  const cta = document.getElementById("pdf-cta");
  const btn = document.getElementById("pdf-download-btn");
  const emailTarget = document.getElementById("pdf-email-target");
  if (!cta || !btn) return;

  // Prefer the blob we already generated at submit time. If the
  // customer refreshed Step 5, that blob is gone — regenerate on
  // the fly from state.bookingRecord (which persists in
  // sessionStorage).
  const cached = booking.id ? _pdfBlobs[booking.id] : null;
  if (!cached && !booking.agreement && !state.contact) { cta.hidden = true; return; }

  if (emailTarget) emailTarget.textContent = booking.contact?.email || "your email";
  cta.hidden = false;

  btn.onclick = async () => {
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "Preparing…";
    try {
      let blob = cached;
      if (!blob) {
        // Reconstruct the draft shape generateAgreementPdf expects.
        // The signed-agreement fields live under state.contact + the
        // signed data captured at submit — we approximate from
        // whatever the booking record + state have.
        blob = await generateAgreementPdf({
          id: booking.id,
          dates: booking.dates,
          items: booking.items,
          delivery: booking.delivery,
          contact: booking.contact,
          agreement: booking.agreement || {
            signedAt: booking.ts,
            typedName: state.contact?.name || "",
            dlNumber: "", dlState: "",
            signatureDataUrl: null,
          },
        });
        _pdfBlobs[booking.id] = blob;
      }
      triggerDownload(blob, `pcgc-agreement-${booking.id || "signed"}.pdf`);
    } catch (e) {
      alert("Couldn't generate the PDF — please reload the page and try again, or check your email for the copy we sent.");
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  };
}

// ---------- Shareable social image (Step 5) ---------- //
//
// Zero-dependency Canvas 2D image composition + platform-specific
// share routing. Facebook uses their sharer URL (works everywhere).
// Instagram and Nextdoor have no web share URL, so we route through
// navigator.share() on mobile (which shows the native share sheet
// with those platforms as options) and download-the-image + open-
// the-platform on desktop.

const SHARE_URL     = "https://polkcountygolfcarts.com/rentals/";
const SHARE_CAPTION = () => (
  `Just booked a golf cart rental at Polk County Golf Carts for our Lake Livingston trip! 🚗⛳ Family-owned since 2020, best carts in East Texas.\n\nRent yours at ${SHARE_URL} · 936-223-1182`
);

let _shareBlob = null;

async function initShareCard(booking) {
  const card = $("#share-card");
  const previewImg = $("#share-preview-img");
  const previewLoading = $("#share-preview-loading");
  const toast = $("#share-toast");
  if (!card) return;

  card.hidden = false;
  previewImg.style.visibility = "hidden";
  previewLoading.hidden = false;

  try {
    _shareBlob = await generateShareImage(booking);
    previewImg.src = URL.createObjectURL(_shareBlob);
    previewImg.style.visibility = "visible";
    previewLoading.hidden = true;
  } catch (e) {
    previewLoading.textContent = "Couldn't generate share image — try refreshing.";
    return;
  }

  const flashToast = (html, ms = 5000) => {
    toast.innerHTML = html;
    toast.hidden = false;
    clearTimeout(flashToast._t);
    flashToast._t = setTimeout(() => { toast.hidden = true; }, ms);
  };

  // Wire each platform button. Using ONCE-registered listener via
  // dataset flag so re-rendering Step 5 doesn't double-fire.
  document.querySelectorAll(".share-btn").forEach(btn => {
    if (btn.dataset.wired === "1") return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => handleShareClick(btn.dataset.platform, flashToast));
  });
}

async function handleShareClick(platform, flashToast) {
  if (!_shareBlob) return;

  // Silent-copy the caption to clipboard on every click — makes
  // the "paste into the app" step frictionless.
  try { await navigator.clipboard.writeText(SHARE_CAPTION()); } catch (_) {}

  const file = new File([_shareBlob], "pcgc-rental.png", { type: "image/png" });
  const canWebShare = navigator.canShare && navigator.canShare({ files: [file] });

  // Universal path on mobile: native share sheet has all three
  // platforms as installed-app options. Cleanest UX by far.
  if (canWebShare) {
    try {
      await navigator.share({
        files: [file],
        title: "Polk County Golf Carts",
        text: SHARE_CAPTION(),
      });
      if (window.pcgcTrack) window.pcgcTrack("booking-shared");
      return;
    } catch (e) {
      // User cancelled — silent no-op. Anything else falls through
      // to the platform-specific desktop path below.
      if (e && e.name === "AbortError") return;
    }
  }

  // Desktop path — no Web Share API OR share failed. Route per
  // platform with a helpful toast + auto-download for platforms
  // that need the user to attach the image manually.
  if (window.pcgcTrack) window.pcgcTrack("booking-shared");

  // Desktop path — normal new-tab open (no popup dimensions), plus
  // auto-download the image for platforms that don't accept an image
  // via URL query.
  if (platform === "facebook") {
    // Facebook Sharer pulls OG image + title from the target URL.
    const u = encodeURIComponent(SHARE_URL);
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${u}`, "_blank", "noopener");
    flashToast(`Caption copied ✓ — paste into your Facebook post.`);
    return;
  }

  if (platform === "instagram") {
    triggerDownload(_shareBlob, "pcgc-rental.png");
    window.open("https://www.instagram.com/", "_blank", "noopener");
    flashToast(`Image downloaded + caption copied ✓ — post it as a Story on Instagram.`);
    return;
  }

  if (platform === "nextdoor") {
    triggerDownload(_shareBlob, "pcgc-rental.png");
    window.open("https://nextdoor.com/news_feed/", "_blank", "noopener");
    flashToast(`Image downloaded + caption copied ✓ — start a new post on your neighborhood feed.`);
    return;
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 1080x1080 share image — Instagram-post aesthetic with a solid
// coral footer bar at the bottom (URL + address + phone). Text no
// longer overlaps because the right-side stack was collapsed into a
// full-width centered footer.
//
// Layout, top -> bottom:
//   0-100   coral-underlined "POLK COUNTY GOLF CARTS" tag (top-left)
//   0-930   full-bleed cart photo with dark gradient over bottom half
//   ~590+   pre-header + "Cart Day. / Lake Day." + name + dates
//   930-1080 solid coral footer strip: URL · city · phone (centered)
async function generateShareImage(booking) {
  const W = 1080, H = 1080;
  const FOOTER_H = 150;              // solid coral bar at the very bottom
  const PHOTO_H = H - FOOTER_H;      // the photo/text zone lives above it
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");

  // 1. Full-bleed cart photo above the footer (object-fit: cover)
  const cart = (booking.items && booking.items[0]) || null;
  const cartMeta = cart ? CARTS.find(x => x.id === cart.id) : null;
  const imgSrc = (cartMeta && cartMeta.img) || "/assets/photos/rentals/limo.jpg";
  const cartImg = await loadImage(imgSrc).catch(() => null);
  if (cartImg) drawCover(ctx, cartImg, 0, 0, W, PHOTO_H);
  else { ctx.fillStyle = "#1f5a68"; ctx.fillRect(0, 0, W, PHOTO_H); }

  // 2. Dark gradient over the bottom half of the photo for text
  //    legibility (transparent up top, near-black at the footer join).
  const grad = ctx.createLinearGradient(0, PHOTO_H * 0.45, 0, PHOTO_H);
  grad.addColorStop(0.0, "rgba(0,0,0,0)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.55)");
  grad.addColorStop(1.0, "rgba(15,40,50,0.88)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, PHOTO_H);

  // 3. Top-left brand tag with coral underline
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.font = "700 28px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const brandText = "POLK COUNTY GOLF CARTS";
  ctx.fillText(brandText, 60, 78);
  const brandW = ctx.measureText(brandText).width;
  ctx.fillStyle = "#e85a4f";
  ctx.fillRect(60, 92, brandW, 3);

  // 4. Left text stack, anchored to the photo bottom (which is where
  //    the coral footer begins). Vertical order bottom-up so we can
  //    position by "distance from footer" cleanly.
  const c1 = booking.contact || {};
  const firstName = (c1.name || "").split(/\s+/)[0] || "";
  const start = fmtShort(booking.dates?.start);
  const end = fmtShort(booking.dates?.end);

  //   Row 5 (nearest footer): cart name (soft coral)
  if (cartMeta) {
    ctx.fillStyle = "#f8bcb6";
    ctx.font = "600 26px system-ui, sans-serif";
    ctx.fillText(cartMeta.name, 60, PHOTO_H - 30);
  }
  //   Row 4: first name · dates
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "500 34px system-ui, -apple-system, Segoe UI, sans-serif";
  const subline = firstName ? `${firstName} · ${start} → ${end}` : `${start} → ${end}`;
  ctx.fillText(subline, 60, PHOTO_H - 75);
  //   Row 3: "Lake Day." headline line 2
  ctx.fillStyle = "#fff";
  ctx.font = "800 92px Georgia, 'Times New Roman', serif";
  ctx.fillText("Lake Day.", 60, PHOTO_H - 145);
  //   Row 2: "Cart Day." headline line 1
  ctx.fillText("Cart Day.", 60, PHOTO_H - 240);
  //   Row 1: pre-header (coral small caps)
  ctx.fillStyle = "#e85a4f";
  ctx.font = "700 26px system-ui, sans-serif";
  ctx.fillText("JUST BOOKED WITH POLK COUNTY GOLF CARTS", 60, PHOTO_H - 305);

  // 5. Solid coral footer bar at the very bottom with URL + city +
  //    phone all on one centered line. Single stack — no overlap
  //    possible.
  ctx.fillStyle = "#e85a4f";
  ctx.fillRect(0, PHOTO_H, W, FOOTER_H);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.font = "700 34px Georgia, serif";
  ctx.fillText("polkcountygolfcarts.com", W / 2, PHOTO_H + 55);
  ctx.font = "500 24px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText("Livingston, TX  ·  936-223-1182", W / 2, PHOTO_H + 100);

  return new Promise((resolve) => c.toBlob(resolve, "image/png", 0.94));
}

// ---------- Signed-agreement PDF (jsPDF, client-side) ---------- //
//
// Builds a 2-3 page US Letter PDF of the signed rental agreement:
//   Page 1: Header + customer info + carts + dates + terms (part 1)
//   Page 2: Terms (continued) + signature block
//   Page 3 (if uploaded): Driver's license photo
//
// The PDF blob is then:
//   - stashed in state.bookingRecord.agreementPdfBlob for the
//     Step 5 "Download signed agreement" button
//   - base64-encoded and sent to the Worker in the booking POST
//     under signedAgreement.pdfBase64; server saves it in the
//     KV record + emails it as a Resend attachment to the customer

const AGREEMENT_TERMS = [
  { h: "Weekend / Holiday Rentals",
    t: "A two (2) day minimum rental is required for all weekend and holiday rentals." },
  { h: "Cancellation Policy",
    t: "If you cancel your rental seven (7) days prior to the first rental date you will be refunded 100%. If you cancel within four (4) days of the first rental date you will be refunded 50%. If your cancellation is three (3) days or less, no refund will be granted." },
  { h: "Return of Cart",
    t: "Make sure the cart is parked back at the office when finished. Thank you!" },
  { h: "Risk of Loss or Injury",
    t: "I will operate the golf cart(s) safely and responsibly and I will preserve and protect the golf cart(s) from loss or damage, my person or property, and the persons or property of others. I agree to be legally and financially liable for all damage and costs of repairs or total replacement for the golf cart(s), and for the loss, damage and/or injuries to my person or property and the persons or property of others regardless of fault. I agree to hold harmless, defend and indemnify PCGC, the owner of the golf cart(s) for all damages and claims of any nature whatsoever that may arise from the use of the golf cart(s) itself, my person and property, and the persons and property of others. Effective upon delivery or pick up of the golf cart(s) and until the golf cart is returned to PCGC, customer relieves PCGC of responsibility for all risk of physical damage to, or loss or destruction of the golf cart(s), regardless of who caused the damage. Acceptance of delivery includes customer not being present. Customer is responsible and liable for the golf cart(s) rented from the start and end dates listed in this agreement, not the number of days charged." },
  { h: "Operations",
    t: "I understand that if the golf cart(s) should be inoperable through no fault of mine, I will contact PCGC immediately upon discovery (936) 223-1182, as PCGC will take reasonable steps to have the vehicle repaired / serviced / replaced as soon as it is possible and during normal business hours. This does not relieve me of the responsibility to ensure the golf cart(s) is not damaged or stolen regardless of mechanical or damage failure." },
  { h: "Return of Equipment",
    t: "I promise to return the golf cart(s) to the location delivered from or picked up, in the same condition as I received it. Upon return, PCGC will perform an inspection to determine the condition of the golf cart(s). In the event of any damage, Customer agrees to pay for said damages including up to total replacement and hereby authorizes PCGC, in advance, to charge the credit card given at time of rental and/or the difference of the cash deposit, to make repairs or replace the entire unit(s) at full price in the event damage is beyond repair. If the cart is stolen or missing, customer agrees to pay for the unit(s) at full retail price as determined by PCGC's cart inventory log at the time of agreement." },
  { h: "Miscellaneous Terms",
    t: "I understand that a golf cart(s) is subject to laws and regulations by both local and the State of Texas authorities. Customer agrees that the golf cart(s) will be operated in accordance with the laws of the State, including but not limited to the requirement that persons driving the golf cart(s) must not be under the influence of alcohol and/or illegal drugs or prescribed medication that could cause impairment. Customer further agrees that they will be personally responsible for all moving and/or parking violations issued to said cart(s) while in their possession, under their control, or at any time during the rental / loaner / demonstration agreement.\n\nCustomer agrees that only person(s) who are 16 years of age and/or older will be permitted to operate the golf cart(s). Maximum occupancy is the number of available seats (NO STANDING ON THE FENDER OR FOOT PLATE).\n\nCustomer will remove the key from the golf cart(s) when not in use, will not sublease the golf cart(s), and will keep the golf cart(s) at the listed location of use." },
];

async function generateAgreementPdf(booking) {
  // jsPDF exports { jsPDF } via UMD → window.jspdf.jsPDF.
  const ns = (typeof window !== "undefined" && window.jspdf) || (typeof jspdf !== "undefined" ? jspdf : null);
  if (!ns || !ns.jsPDF) throw new Error("jsPDF not loaded");
  const { jsPDF } = ns;

  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const PAGE_W = 612, PAGE_H = 792;
  const M = 50;                       // margin
  const W = PAGE_W - M * 2;           // usable width
  const BOTTOM = PAGE_H - 60;         // where a new-page check should fire
  let y = M;

  const c = booking.contact || {};
  const ag = booking.agreement || {};

  // Helpers ---------------------------------------------------------
  const setFill = (r, g, b) => doc.setTextColor(r, g, b);
  const teal   = () => setFill(31, 90, 104);
  const coral  = () => setFill(232, 90, 79);
  const ink    = () => setFill(20, 20, 20);
  const muted  = () => setFill(90, 90, 90);
  const ensureSpace = (need) => {
    if (y + need > BOTTOM) { doc.addPage(); y = M; }
  };
  const paragraph = (text, size, opts = {}) => {
    doc.setFontSize(size);
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    if (opts.color === "teal") teal();
    else if (opts.color === "coral") coral();
    else if (opts.color === "muted") muted();
    else ink();
    const lines = doc.splitTextToSize(text, W);
    const need = lines.length * (size * 1.25);
    ensureSpace(need);
    doc.text(lines, M, y);
    y += need;
  };

  // Header ----------------------------------------------------------
  doc.setFontSize(20); doc.setFont("helvetica", "bold"); teal();
  doc.text("Polk County Golf Carts, LLC", M, y);
  y += 18;
  doc.setFontSize(10); doc.setFont("helvetica", "normal"); muted();
  doc.text("1732 FM 3277  ·  Livingston, TX 77351  ·  936-223-1182  ·  polkcountygolfcarts.com", M, y);
  y += 18;
  // Coral divider
  doc.setDrawColor(232, 90, 79); doc.setLineWidth(2);
  doc.line(M, y, M + W, y);
  y += 22;

  paragraph("Short Term Rental Agreement", 18, { bold: true, color: "teal" });
  paragraph(`Confirmation ${booking.id || "PCGC-—"}  ·  Signed ${new Date(ag.signedAt || Date.now()).toLocaleString()}`, 9, { color: "muted" });
  y += 6;

  // Customer info
  paragraph("Customer", 12, { bold: true, color: "teal" });
  const addressLine = [c.street, [c.city, c.state].filter(Boolean).join(", "), c.zip].filter(Boolean).join(" · ");
  const rows = [
    ["Name", c.name || "—"],
    ["Phone", c.phone || "—"],
    ["Email", c.email || "—"],
    ["Billing address", addressLine || "—"],
    ["Driver's license", (ag.dlNumber || "—") + "  (" + (ag.dlState || "—") + ")"],
    ["DL delivery", ({ upload: "Photo uploaded on the agreement page", text: "Customer will text photo to 936-223-1182 at payment", "in-person": "Customer will bring physical copy at pickup" }[ag.dlMethod]) || "—"],
  ];
  doc.setFontSize(10); doc.setFont("helvetica", "normal"); ink();
  for (const [k, v] of rows) {
    ensureSpace(14);
    muted(); doc.text(k, M, y);
    ink();  doc.text(String(v), M + 110, y);
    y += 14;
  }
  y += 8;

  // Cart(s)
  paragraph("Cart(s) Rented", 12, { bold: true, color: "teal" });
  const rentedIds = new Set((booking.items || []).map(it => it.id));
  const rentedCarts = CARTS.filter(x => rentedIds.has(x.id));
  for (const cart of rentedCarts) {
    ensureSpace(14);
    ink(); doc.setFontSize(10); doc.setFont("helvetica", "bold");
    doc.text(cart.name, M, y);
    doc.setFont("helvetica", "normal"); muted();
    doc.text(`${cart.make} · ${cart.modelDetails || ""} · Serial ${cart.serial}`, M + 200, y);
    y += 14;
  }
  y += 6;

  const pt = booking.dates?.pickupTime === "pm" ? "after noon" : "before noon";
  const dt = booking.dates?.dropoffTime === "pm" ? "after noon" : "before noon";
  paragraph(`Rental period: ${booking.dates?.start || "—"} (${pt}) → ${booking.dates?.end || "—"} (${dt})${booking.dates?.days ? ` — ${booking.dates.days} day${booking.dates.days === 1 ? "" : "s"} charged` : ""}`, 10);
  const locText = booking.delivery === "pickup"
    ? "Pickup at PCGC shop (1732 FM 3277, Livingston, TX)"
    : `Delivery drop-off: ${c.address || "—"}`;
  paragraph(locText, 10);
  y += 8;

  // Terms
  paragraph("Terms & Conditions", 12, { bold: true, color: "teal" });
  for (const term of AGREEMENT_TERMS) {
    ensureSpace(18);
    paragraph(term.h, 11, { bold: true });
    for (const para of term.t.split("\n\n")) {
      paragraph(para, 9);
    }
    y += 4;
  }

  // Signature block ------------------------------------------------
  ensureSpace(180);
  y += 10;
  paragraph("Signed Agreement", 12, { bold: true, color: "teal" });
  // Checkbox
  doc.setDrawColor(31, 90, 104); doc.setLineWidth(1);
  doc.rect(M, y - 10, 12, 12);
  // Check mark
  doc.setLineWidth(1.5);
  doc.line(M + 2, y - 5, M + 5, y - 2);
  doc.line(M + 5, y - 2, M + 10, y - 9);
  doc.setLineWidth(1);
  doc.setFontSize(10); doc.setFont("helvetica", "normal"); ink();
  const chkText = "The customer has read and agreed to the terms of this Short Term Rental Agreement, and confirms the information above is accurate.";
  const chkLines = doc.splitTextToSize(chkText, W - 20);
  doc.text(chkLines, M + 20, y);
  y += chkLines.length * 12 + 12;

  // Signature image
  const sig = ag.signatureDataUrl;
  ensureSpace(120);
  muted(); doc.setFontSize(9);
  doc.text("Customer signature:", M, y);
  y += 10;
  if (sig) {
    try { doc.addImage(sig, "PNG", M, y, 220, 70); } catch (_) {}
  }
  y += 74;
  doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.5);
  doc.line(M, y, M + 260, y);
  y += 12;
  ink(); doc.setFontSize(10); doc.setFont("helvetica", "bold");
  doc.text(ag.typedName || "—", M, y);
  y += 12;
  muted(); doc.setFontSize(9); doc.setFont("helvetica", "normal");
  doc.text(`Signed electronically on ${new Date(ag.signedAt || Date.now()).toLocaleString()}`, M, y);
  y += 12;
  if (ag.signedIp) { doc.text(`Signed from IP ${ag.signedIp}`, M, y); y += 12; }

  // Countersignature line (PCGC)
  y += 24;
  ensureSpace(60);
  doc.setDrawColor(150, 150, 150);
  doc.line(M + 320, y, M + 320 + 200, y);
  y += 12;
  ink(); doc.setFontSize(10); doc.setFont("helvetica", "bold");
  doc.text("Polk County Golf Carts, LLC", M + 320, y);
  y += 12;
  muted(); doc.setFontSize(9); doc.setFont("helvetica", "normal");
  doc.text("Callie Long, Office Manager", M + 320, y);

  // DL image on its own page (if uploaded)
  if (ag.dlMethod === "upload" && ag.dlImageDataUrl) {
    doc.addPage();
    y = M;
    paragraph("Driver's License on File", 14, { bold: true, color: "teal" });
    y += 6;
    try {
      // Fit inside the usable area at max 500px wide, preserving aspect.
      const imgProps = doc.getImageProperties(ag.dlImageDataUrl);
      const maxW = Math.min(W, 500);
      const scale = maxW / imgProps.width;
      const drawW = maxW;
      const drawH = imgProps.height * scale;
      doc.addImage(ag.dlImageDataUrl, "JPEG", M, y, drawW, drawH);
      y += drawH + 10;
      muted(); doc.setFontSize(9);
      doc.text(`DL number: ${ag.dlNumber || "—"} (${ag.dlState || "—"})  ·  Uploaded ${new Date(ag.signedAt || Date.now()).toLocaleString()}`, M, y);
    } catch (_) { /* ignore addImage failures — some browsers reject certain data URLs */ }
  }

  return doc.output("blob");
}

// Base64-encode a Blob so we can transport the PDF over JSON. Returns
// the "data:application/pdf;base64,..." portion (no data URL prefix).
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("read fail"));
    r.onload = () => {
      const dataUrl = String(r.result || "");
      const idx = dataUrl.indexOf(",");
      resolve(idx > -1 ? dataUrl.slice(idx + 1) : "");
    };
    r.readAsDataURL(blob);
  });
}

// Canvas draw helpers.
function roundRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}
// Object-fit: cover for canvas images.
function drawCover(ctx, img, dx, dy, dw, dh) {
  const sr = img.width / img.height;
  const dr = dw / dh;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (sr > dr) {
    // source wider than destination — crop sides
    sw = img.height * dr;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / dr;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
function fmtShort(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ---------- Boot ----------
document.addEventListener("DOMContentLoaded", () => {
  initStep1();         // dates (was initStep2)
  initStep2Continue(); // carts → details
  initStep3();
  initStep4();
  $("#back-to-1").addEventListener("click", () => goTo(1));
  $("#back-to-2").addEventListener("click", () => goTo(2));
  $("#back-to-3").addEventListener("click", () => goTo(3));
  // Restore previous step if user reloads mid-flow.
  goTo(state.step || 1);
});
