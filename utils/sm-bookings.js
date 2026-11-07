"use strict";
// Subject Medias bookings: what a booking may hold, which creators to suggest
// for it, and what an alert may say. Used by routes/sm-bookings.js; the table
// is migration 030.
//
// Alerts never carry athlete details. A push names the package, sport, state
// and date, all from fixed lists, so nothing anyone typed goes out through a
// push service. The email adds the city and the booker's own contact so Kyron
// can call back. Notes and the athlete's team and jersey stay in the app.
//
// The booker's own note (we got your request; thanks for booking) goes to an
// address someone typed, so it carries fixed words only, like a push.

const { credentialProblems } = require("./gfs");

const KINDS = Object.freeze(["athlete", "team", "event"]);
const KIND_WORDS = Object.freeze({ athlete: "Athlete coverage", team: "Team coverage", event: "Event coverage" });
const PACKAGES = Object.freeze({
  unsure: "Not sure yet",
  photo: "Photo coverage",
  video: "Video coverage",
  elite: "Elite coverage",
  transcript: "Player transcript",
  team: "Team package",
  event: "Event coverage",
});
// The booking form's sport list (subjectmedias.com). Anything else is "Other".
const SPORTS = Object.freeze(["7v7 Football", "Football", "Girls Flag Football", "Basketball", "Volleyball", "Soccer", "Lacrosse", "Track & Field", "Baseball", "Softball", "Wrestling", "Other"]);
const STATUSES = Object.freeze(["new", "contacted", "offered", "staffed", "delivered", "cancelled"]);
const OPEN = Object.freeze(["new", "contacted", "offered"]);
const CLOSED = Object.freeze(["delivered", "cancelled"]);
const REGION_WORDS = Object.freeze({ west: "West", south_central: "South Central", northeast: "Northeast", southeast: "Southeast", midwest: "Midwest" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The homepage's offers a request can claim (migration 034).
const OFFERS = Object.freeze(["first10"]);
// A paid booking's name when the checkout had none.
const STRIPE_NAME = "Stripe customer";
// Stripe's own ceiling for one charge, and well inside the int column.
const MAX_CENTS = 99999999;

// Which of the five Pylon regions a state's games fall in, so a booking can
// suggest the creators who already work there (gfs_creators.region).
const STATE_REGION = Object.freeze({
  AK: "west", AZ: "west", CA: "west", CO: "west", HI: "west", ID: "west", MT: "west", NM: "west", NV: "west", OR: "west", UT: "west", WA: "west", WY: "west",
  AR: "south_central", LA: "south_central", OK: "south_central", TX: "south_central",
  AL: "southeast", FL: "southeast", GA: "southeast", KY: "southeast", MS: "southeast", NC: "southeast", SC: "southeast", TN: "southeast", VA: "southeast", WV: "southeast",
  CT: "northeast", DC: "northeast", DE: "northeast", MA: "northeast", MD: "northeast", ME: "northeast", NH: "northeast", NJ: "northeast", NY: "northeast", PA: "northeast", RI: "northeast", VT: "northeast",
  IA: "midwest", IL: "midwest", IN: "midwest", KS: "midwest", MI: "midwest", MN: "midwest", MO: "midwest", ND: "midwest", NE: "midwest", OH: "midwest", SD: "midwest", WI: "midwest",
});

const DAY = 864e5;
// Only strings and finite numbers are values. Anything else in the JSON (an
// object, an array) counts as missing, so no input can make these throw.
const text = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
// One line: control characters out (Postgres refuses NUL), single spaces.
// At most max characters, counted as Postgres counts them (code points), so a
// cut never leaves half an emoji, which Postgres refuses.
const clip = (s, max) => {
  const t = String(s);
  return t.length <= max ? t : Array.from(t).slice(0, max).join("");
};
const clean = (s, max) => clip(text(s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(), max);
// Free text that keeps its line breaks.
const cleanNotes = (s, max) => clip(text(s).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim(), max);
// Notes from more than one place, each once, within the column's 1000.
const joinNotes = (...parts) => clip(parts.filter(Boolean).join("\n\n"), 1000) || null;
// The mailbox an address delivers to, for limits: lowercase, no +tag, and for
// Gmail no dots (Gmail ignores both, so they'd let one inbox count as many).
function mailbox(address) {
  const a = String(address || "").trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1) return a;
  let user = a.slice(0, at).split("+")[0];
  let domain = a.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") user = user.replace(/\./g, "");
  return user + "@" + domain;
}
const has = (obj, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(obj, k);
// A plain address, lowercase: nothing that could add recipients or text to a
// mailto: link (no ? & # % / or spaces). Migration 030 checks the same.
const EMAIL = /^[a-z0-9._+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const isEmail = (s) => typeof s === "string" && s.length <= 200 && EMAIL.test(s);
const regionFor = (state) => STATE_REGION[String(state || "").toUpperCase()] || null;
const sportOf = (s) => {
  const v = clean(s, 40).toLowerCase();
  if (!v) return null;
  return SPORTS.find((x) => x.toLowerCase() === v) || "Other";
};

// 'YYYY-MM-DD' → a UTC midnight timestamp, or null for anything else.
function dayValue(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(s));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
}
const todayValue = (now) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

// The game's day: real, from yesterday (a day's grace for time zones behind
// UTC) to two years out. Returns 'YYYY-MM-DD', or null.
function eventDay(s, now) {
  const day = dayValue(s);
  const today = todayValue(now);
  return day === null || day < today - DAY || day > today + 730 * DAY ? null : isoDay(day);
}
// How many athletes, 1 to 500. Blank is null; anything else is false.
function athleteCount(s) {
  const count = clean(s, 10);
  if (!count) return null;
  const n = Number(count);
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : false;
}

function phone(s) {
  const p = clean(s, 30).replace(/[^0-9+().\- ]/g, "");
  return (p.match(/\d/g) || []).length >= 7 ? p : null;
}

function dateWords(s, { weekday = false } = {}) {
  const t = dayValue(s);
  if (t === null) return "";
  return new Date(t).toLocaleDateString("en-US", Object.assign({ timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }, weekday ? { weekday: "short" } : {}));
}

// The booking form on subjectmedias.com. Returns the row to store and the
// fields that were wrong (by name, so the form can point at them).
function normalize(raw, { now = new Date() } = {}) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const v = {};

  v.kind = KINDS.includes(r.kind) ? r.kind : (errors.push("kind"), null);
  v.package = has(PACKAGES, r.package) ? r.package : "unsure";
  v.sport = sportOf(r.sport);
  v.event_name = clean(r.event_name, 120) || null;

  v.event_date = eventDay(r.event_date, now) || (errors.push("event_date"), null);

  v.event_city = clean(r.event_city, 80) || (errors.push("event_city"), null);
  const st = clean(r.event_state, 2).toUpperCase();
  v.event_state = STATE_REGION[st] ? st : (errors.push("event_state"), null);
  v.region = regionFor(v.event_state);

  const n = athleteCount(r.athletes);
  if (n === false) errors.push("athletes");
  v.athletes = n || null;

  v.team_jersey = clean(r.team_jersey, 60) || null;
  v.contact_name = clean(r.contact_name, 80) || (errors.push("contact_name"), null);
  const email = clean(r.contact_email, 200).toLowerCase();
  v.contact_email = isEmail(email) ? email : (errors.push("contact_email"), null);
  if (clean(r.contact_phone, 40)) {
    v.contact_phone = phone(r.contact_phone);
    if (!v.contact_phone) errors.push("contact_phone");
  } else v.contact_phone = null;
  v.notes = cleanNotes(r.notes, 1000) || null;
  v.adult_confirmed = r.adult_confirmed === true || r.adult_confirmed === "true" || r.adult_confirmed === "on";
  if (!v.adult_confirmed) errors.push("adult_confirmed");
  // The homepage's 10% first-package offer, claimed with this request.
  v.offer = OFFERS.includes(r.offer) ? r.offer : null;

  return { errors, value: v };
}

// A paid package, sent by subjectmedias.com's Stripe webhook. Only the
// checkout id is required: a payment always lands, even with little else.
// booking_id is the request the buyer paid for from the form's success panel
// (the checkout's client_reference_id); the route joins the two.
//
// With details: true it's the buyer telling us about their game after a
// direct Buy (the site's /api/details, which checked the payment with Stripe
// first and sends the checkout along with the answers). Then, as on the
// booking form, the date, city and state are required, and the adult box.
function normalizePaid(raw, { now = new Date() } = {}) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const v = { source: "stripe" };
  const details = r.details === true;
  const sid = text(r.stripe_session_id);
  if (/^cs_[A-Za-z0-9_]{8,200}$/.test(sid)) v.stripe_session_id = sid;
  else errors.push("stripe_session_id");
  const req = text(r.booking_id).toLowerCase();
  v.booking_id = UUID.test(req) ? req : null;
  v.package = has(PACKAGES, r.package) ? r.package : "unsure";
  v.kind = v.package === "team" ? "team" : v.package === "event" ? "event" : "athlete";
  const cents = Number(text(r.amount_cents) || NaN);
  v.amount_cents = Number.isInteger(cents) && cents >= 0 && cents <= MAX_CENTS ? cents : null;
  v.contact_name = clean(r.contact_name, 80) || STRIPE_NAME;
  const email = clean(r.contact_email, 200).toLowerCase();
  // Stripe nearly always has the buyer's email. Without one the booking still
  // lands; staff find the buyer in Stripe by the checkout id.
  v.contact_email = isEmail(email) ? email : null;
  v.contact_phone = phone(r.contact_phone);
  v.sport = sportOf(r.sport);
  v.event_name = clean(r.event_name, 120) || null;
  const st = clean(r.event_state, 2).toUpperCase();
  v.event_state = STATE_REGION[st] ? st : null;
  v.region = regionFor(v.event_state);
  v.event_city = clean(r.event_city, 80) || null;
  v.team_jersey = clean(r.team_jersey, 60) || null;
  v.notes = cleanNotes(r.notes, 1000) || null;
  const n = athleteCount(r.athletes);
  v.athletes = n || null;
  if (details) {
    v.details = true;
    v.event_date = eventDay(r.event_date, now) || (errors.push("event_date"), null);
    if (!v.event_city) errors.push("event_city");
    if (!v.event_state) errors.push("event_state");
    if (n === false) errors.push("athletes");
    if (clean(r.contact_phone, 40) && !v.contact_phone) errors.push("contact_phone");
    const adult = r.adult_confirmed === true || r.adult_confirmed === "true" || r.adult_confirmed === "on";
    if (adult) v.adult_confirmed = true;
    else errors.push("adult_confirmed");
    // What the checkout's own fields said beyond the event: kept apart from the
    // buyer's notes, so whichever of the webhook and this comes second can see
    // it's there already. Not a column.
    v.checkout_notes = cleanNotes(r.checkout_notes, 1000) || null;
  } else {
    const day = dayValue(r.event_date);
    v.event_date = day === null ? null : isoDay(day);
  }
  return { errors, value: v };
}

// A second word about a booking we already have: the webhook after the
// details form, or the details form after the webhook. The buyer's own answers
// win (override: the details form): what they typed about their game beats
// what the checkout's fields said. The webhook only fills what's missing.
// Notes add on, marked with where they came from, each only once. Returns the
// changes (maybe none).
const FILLS = ["sport", "event_name", "event_date", "event_city", "event_state", "athletes", "team_jersey", "contact_email", "contact_phone"];
// What the buyer answers on the details form; never their email or the payment.
const ANSWERED = ["sport", "event_name", "event_date", "event_city", "event_state", "athletes", "team_jersey", "contact_phone"];
const blank = (x) => x === null || x === undefined || x === "";
function fillPatch(b, inc, { from = "the checkout", override = false, checkoutNotes = null } = {}) {
  const patch = {};
  for (const k of FILLS) {
    if (blank(inc[k])) continue;
    if (blank(b[k]) || (override && ANSWERED.includes(k) && inc[k] !== b[k])) patch[k] = inc[k];
  }
  if (patch.event_state) patch.region = regionFor(patch.event_state);
  if (b.package === "unsure" && has(PACKAGES, inc.package) && inc.package !== "unsure") {
    patch.package = inc.package;
    if (b.source === "stripe" && KINDS.includes(inc.kind)) patch.kind = inc.kind;
  }
  if ((blank(b.contact_name) || b.contact_name === STRIPE_NAME) && !blank(inc.contact_name) && inc.contact_name !== STRIPE_NAME) patch.contact_name = inc.contact_name;
  if (inc.adult_confirmed === true && b.adult_confirmed !== true) patch.adult_confirmed = true;
  let notes = b.notes || "";
  if (!blank(inc.notes) && !notes.includes(inc.notes)) notes = joinNotes(notes, `From ${from}: ${inc.notes}`) || "";
  if (!blank(checkoutNotes) && !notes.includes(checkoutNotes)) notes = joinNotes(notes, `From the checkout: ${checkoutNotes}`) || "";
  if (notes !== (b.notes || "")) patch.notes = notes;
  return patch;
}

// The Pylon screening rule (utils/gfs.js, credentialProblems): active, a
// contract, a background check and safety training within the year before the
// game, an age check, and a guardian of record for a youth creator. Judged on
// the game's date, or today when the booking has none.
function screeningProblems(c, onDay) {
  const day = dayValue(onDay) === null ? isoDay(todayValue(new Date())) : isoDay(dayValue(onDay));
  return credentialProblems(c, { ends_on: day }, null);
}
function screened(c, onDay) {
  return screeningProblems(c, onDay).length === 0;
}
// Who can be staffed on a booking: a booking is one creator at someone's
// game, so an adult whose screening is current. A youth creator only ever
// works beside a screened adult, which a booking doesn't have.
function staffProblems(c, onDay) {
  const out = screeningProblems(c, onDay);
  if (c && c.tier !== "adult") out.push("youth_alone");
  return out;
}

// Creators to suggest: the crew pool in the booking's region (same city first,
// then screened, then adults), and creators with a live page of their own
// whose coverage area names the city or the state.
function rankCreators(booking, crewPool, clubCreators) {
  const b = booking || {};
  const city = String(b.event_city || "").toLowerCase();
  const crew = (crewPool || [])
    .filter((c) => c && c.status === "active" && b.region && c.region === b.region)
    .map((c) => {
      const ok = screened(c, b.event_date);
      return {
        id: c.id,
        name: c.name,
        home_city: c.home_city || null,
        tier: c.tier === "adult" ? "adult" : "youth",
        screened: ok,
        can_staff: ok && c.tier === "adult",
        same_city: !!city && String(c.home_city || "").toLowerCase() === city,
      };
    })
    .sort((a, z) => (z.same_city - a.same_city) || (z.screened - a.screened) || ((a.tier === "adult" ? 0 : 1) - (z.tier === "adult" ? 0 : 1)) || String(a.name).localeCompare(String(z.name)))
    .slice(0, 6);
  const st = String(b.event_state || "").toUpperCase();
  const pages = (clubCreators || [])
    .filter((c) => c && c.status === "active" && c.page_status === "live" && c.location)
    .filter((c) => {
      const loc = String(c.location);
      return (city && loc.toLowerCase().includes(city)) || (/^[A-Z]{2}$/.test(st) && new RegExp("\\b" + st + "\\b").test(loc.toUpperCase()));
    })
    .map((c) => ({ slug: c.slug, brand_name: c.brand_name, location: c.location }))
    .slice(0, 3);
  return { crew, pages };
}

const paid = (b) => Boolean(b && (b.paid === true || b.stripe_session_id));
function what(b) {
  return b.package && b.package !== "unsure" ? PACKAGES[b.package] || "Coverage" : KIND_WORDS[b.kind] || "Coverage";
}
function place(b) {
  return [b.event_city, b.event_state].filter(Boolean).join(", ");
}
// One line for the app's lists: what, sport, where, when.
function summary(b) {
  return [what(b), b.sport, place(b), dateWords(b.event_date)].filter(Boolean).join(" · ");
}
// The push version: fixed words only (the package, a sport from the list, a
// state code, a date). No city, no event name: nothing typed by anyone.
function pushLine(b) {
  const sport = SPORTS.includes(b.sport) ? b.sport : null;
  const st = STATE_REGION[b.event_state] ? b.event_state : null;
  return [what(b), sport, st, dateWords(b.event_date)].filter(Boolean).join(" · ");
}

// The push to the TOJ app. No names, no contact, no notes, no free text.
// detailsIn: the buyer of a paid package just told us about their game.
function pushPayload(b, crewCount, { detailsIn = false } = {}) {
  const n = Number(crewCount) || 0;
  const near = b.region ? (n ? `${n} ${n === 1 ? "creator" : "creators"} in the region` : "no creators in that region yet") : "no place given";
  return {
    title: detailsIn ? "Event details in" : paid(b) ? "Paid booking" : "New booking",
    body: `${pushLine(b)} · ${near}`,
    url: `/app/#booking/${b.id}`,
    tag: `sm-booking-${b.id}${detailsIn ? "-details" : ""}`,
  };
}

function money(cents) {
  return "$" + (Number(cents || 0) / 100).toFixed(2);
}

// The staff email: enough to call the booker back and to know who to ask.
// matches null means nobody was looked up (the booking isn't stored). With
// saved false the email is the only copy, so it carries the whole booking.
// detailsIn: the buyer of a paid package just told us about their game.
function emailText(b, matches, appBase, { saved = true, detailsIn = false } = {}) {
  const base = String(appBase || "https://tojcampaign.com").replace(/\/+$/, "");
  const subject = `${detailsIn ? "Event details in" : paid(b) ? "Paid booking" : "New booking"}: ${[what(b), place(b), dateWords(b.event_date)].filter(Boolean).join(", ")}`;
  const lines = [];
  if (detailsIn) lines.push(`The buyer of a paid package (${money(b.amount_cents)}) told us about their game.`);
  else if (paid(b)) lines.push(`Paid on subjectmedias.com: ${money(b.amount_cents)}${b.source === "form" ? ", for the request they sent from the booking form" : ""}.`);
  else lines.push("A new booking request from subjectmedias.com.");
  lines.push("");
  lines.push(`What: ${[what(b), b.sport].filter(Boolean).join(", ")}`);
  if (b.event_name) lines.push(`Event: ${b.event_name}`);
  lines.push(`Where: ${place(b) || "not given"}${b.region ? ` (${REGION_WORDS[b.region]})` : ""}`);
  lines.push(`When: ${dateWords(b.event_date, { weekday: true }) || "not given"}`);
  if (b.athletes) lines.push(`Athletes: ${b.athletes}`);
  if (b.offer === "first10") lines.push("Offer: claimed 10% off the first package. Take it off when you confirm.");
  lines.push(`Booked by: ${[b.contact_name, b.contact_email || "no email on the checkout", b.contact_phone].filter(Boolean).join(", ")}`);
  if (b.stripe_session_id) lines.push(`Stripe checkout: ${b.stripe_session_id}`);
  if (!saved) {
    if (b.team_jersey) lines.push(`Team and jersey: ${b.team_jersey}`);
    if (b.notes) lines.push(`Notes: ${b.notes}`);
  }
  lines.push("");
  if (!matches) {
    lines.push("No creators were looked up: the app's database didn't take this booking.");
  } else if (matches.crew.length) {
    lines.push(`Creators in the ${REGION_WORDS[b.region]}:`);
    for (const c of matches.crew) {
      const notes = [c.home_city, c.tier === "youth" ? "youth, needs a screened adult" : null, c.screened ? "screened" : "screening not current"].filter(Boolean).join("; ");
      lines.push(`- ${c.name} (${notes})`);
    }
  } else {
    lines.push(b.region ? `No creator in the ${REGION_WORDS[b.region]} yet. Reach out to the pool.` : "No place given, so no creators suggested.");
  }
  if (matches && matches.pages.length) {
    lines.push("");
    lines.push("Creators with their own page nearby:");
    for (const p of matches.pages) lines.push(`- ${p.brand_name} (${p.location})`);
  }
  lines.push("");
  if (saved) {
    lines.push(`Open it in the TOJ app: ${base}/app/#booking/${b.id}`);
    lines.push("Notes and the athlete's team and jersey are in the app.");
  } else {
    lines.push("This booking is NOT in the app. Reply to the booker from here.");
  }
  return { subject, text: lines.join("\n") };
}

// The booker's own note: we got your request (the form), or thanks for
// booking (a package bought straight from a payment link, with a link to tell
// us about the game when we don't know yet). It goes to an address someone
// typed into a form, so like a push it carries fixed words only: the package,
// a sport from the list, the date, the state code, the offer. No name, city,
// event name, team, jersey or notes: nothing anyone typed, so nobody can use
// the form to send our email with their words in it to someone else.
function bookerEmail(b, { detailsUrl = null, help = "hello@subjectmedias.com", site = "https://www.subjectmedias.com" } = {}) {
  const bought = b.source === "stripe";
  const lines = [bought ? "Thanks for booking with Subject Medias. Your payment came through." : "Thanks for reaching out to Subject Medias. We got your booking request.", ""];
  const facts = [
    ["What", what(b)],
    ["Sport", SPORTS.includes(b.sport) && b.sport !== "Other" ? b.sport : null],
    ["Game day", dateWords(b.event_date, { weekday: true })],
    ["State", STATE_REGION[b.event_state] ? b.event_state : null],
    ["Paid", bought && Number.isInteger(b.amount_cents) ? money(b.amount_cents) : null],
    ["Offer", !bought && b.offer === "first10" ? "10% off your first package, taken off when we confirm your booking" : null],
  ];
  for (const [k, v] of facts) if (v) lines.push(`${k}: ${v}`);
  lines.push("");
  if (bought && detailsUrl) {
    lines.push("One more step: tell us about your game (the date, where it is, and the team and jersey number) so we can line up your creator:");
    lines.push(detailsUrl);
    lines.push("");
    lines.push("Already told us? Then you're all set. We'll be in touch within 24 hours.");
  } else if (bought) {
    lines.push("We'll be in touch within 24 hours to confirm the details and line up your creator.");
  } else {
    lines.push("What happens next: we'll reply within 24 hours to confirm the details and send your payment link. Nothing is booked or charged until then.");
    lines.push("");
    lines.push("Didn't send this? You can ignore this email.");
  }
  lines.push("");
  lines.push(`Questions? Reply to this email, write to ${help}, or DM @subjectmedias on Instagram.`);
  lines.push("");
  lines.push("Subject Medias");
  lines.push(String(site).replace(/\/+$/, ""));
  return { subject: bought ? "Subject Medias: thanks for booking" : "Subject Medias: we got your booking request", text: lines.join("\n") };
}

module.exports = {
  KINDS,
  PACKAGES,
  SPORTS,
  STATUSES,
  OPEN,
  CLOSED,
  REGION_WORDS,
  STATE_REGION,
  UUID,
  OFFERS,
  clip,
  joinNotes,
  mailbox,
  STRIPE_NAME,
  isEmail,
  regionFor,
  normalize,
  normalizePaid,
  fillPatch,
  screened,
  staffProblems,
  rankCreators,
  paid,
  summary,
  pushPayload,
  emailText,
  bookerEmail,
  dateWords,
};
