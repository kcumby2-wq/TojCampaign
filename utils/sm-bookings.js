"use strict";
// Subject Medias bookings: what a booking may hold, which creators to suggest
// for it, and what an alert may say. Used by routes/sm-bookings.js; the table
// is migration 030.
//
// Alerts never carry athlete details. A push names the package, sport, state
// and date, all from fixed lists, so nothing anyone typed goes out through a
// push service. The email adds the city and the booker's own contact so Kyron
// can call back. Notes and the athlete's team and jersey stay in the app.

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
const clean = (s, max) => text(s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
// Free text that keeps its line breaks.
const cleanNotes = (s, max) => text(s).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max);
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

  const day = dayValue(r.event_date);
  const today = todayValue(now);
  // A day's grace for time zones behind UTC; nothing more than two years out.
  if (day === null || day < today - DAY || day > today + 730 * DAY) errors.push("event_date");
  else v.event_date = isoDay(day);

  v.event_city = clean(r.event_city, 80) || (errors.push("event_city"), null);
  const st = clean(r.event_state, 2).toUpperCase();
  v.event_state = STATE_REGION[st] ? st : (errors.push("event_state"), null);
  v.region = regionFor(v.event_state);

  const count = clean(r.athletes, 10);
  if (count) {
    const n = Number(count);
    if (Number.isInteger(n) && n >= 1 && n <= 500) v.athletes = n;
    else errors.push("athletes");
  } else v.athletes = null;

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

  return { errors, value: v };
}

// A paid package, sent by subjectmedias.com's Stripe webhook. Only the
// checkout id is required: a payment always lands, even with little else.
// booking_id is the request the buyer paid for from the form's success panel
// (the checkout's client_reference_id); the route joins the two.
function normalizePaid(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const v = { source: "stripe" };
  const sid = text(r.stripe_session_id);
  if (/^cs_[A-Za-z0-9_]{8,200}$/.test(sid)) v.stripe_session_id = sid;
  else errors.push("stripe_session_id");
  const req = text(r.booking_id).toLowerCase();
  v.booking_id = UUID.test(req) ? req : null;
  v.package = has(PACKAGES, r.package) ? r.package : "unsure";
  v.kind = v.package === "team" ? "team" : v.package === "event" ? "event" : "athlete";
  const cents = Number(text(r.amount_cents) || NaN);
  v.amount_cents = Number.isInteger(cents) && cents >= 0 && cents <= MAX_CENTS ? cents : null;
  v.contact_name = clean(r.contact_name, 80) || "Stripe customer";
  const email = clean(r.contact_email, 200).toLowerCase();
  // Stripe nearly always has the buyer's email. Without one the booking still
  // lands; staff find the buyer in Stripe by the checkout id.
  v.contact_email = isEmail(email) ? email : null;
  v.contact_phone = phone(r.contact_phone);
  v.sport = sportOf(r.sport);
  v.event_name = clean(r.event_name, 120) || null;
  const day = dayValue(r.event_date);
  v.event_date = day === null ? null : isoDay(day);
  v.event_city = clean(r.event_city, 80) || null;
  const st = clean(r.event_state, 2).toUpperCase();
  v.event_state = STATE_REGION[st] ? st : null;
  v.region = regionFor(v.event_state);
  v.team_jersey = clean(r.team_jersey, 60) || null;
  v.notes = cleanNotes(r.notes, 1000) || null;
  return { errors, value: v };
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
function pushPayload(b, crewCount) {
  const n = Number(crewCount) || 0;
  const near = b.region ? (n ? `${n} ${n === 1 ? "creator" : "creators"} in the region` : "no creators in that region yet") : "no place given";
  return {
    title: paid(b) ? "Paid booking" : "New booking",
    body: `${pushLine(b)} · ${near}`,
    url: `/app/#booking/${b.id}`,
    tag: `sm-booking-${b.id}`,
  };
}

function money(cents) {
  return "$" + (Number(cents || 0) / 100).toFixed(2);
}

// The staff email: enough to call the booker back and to know who to ask.
// matches null means nobody was looked up (the booking isn't stored). With
// saved false the email is the only copy, so it carries the whole booking.
function emailText(b, matches, appBase, { saved = true } = {}) {
  const base = String(appBase || "https://tojcampaign.com").replace(/\/+$/, "");
  const subject = `${paid(b) ? "Paid booking" : "New booking"}: ${[what(b), place(b), dateWords(b.event_date)].filter(Boolean).join(", ")}`;
  const lines = [];
  if (paid(b)) lines.push(`Paid on subjectmedias.com: ${money(b.amount_cents)}${b.source === "form" ? ", for the request they sent from the booking form" : ""}.`);
  else lines.push("A new booking request from subjectmedias.com.");
  lines.push("");
  lines.push(`What: ${[what(b), b.sport].filter(Boolean).join(", ")}`);
  if (b.event_name) lines.push(`Event: ${b.event_name}`);
  lines.push(`Where: ${place(b) || "not given"}${b.region ? ` (${REGION_WORDS[b.region]})` : ""}`);
  lines.push(`When: ${dateWords(b.event_date, { weekday: true }) || "not given"}`);
  if (b.athletes) lines.push(`Athletes: ${b.athletes}`);
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
  isEmail,
  regionFor,
  normalize,
  normalizePaid,
  screened,
  staffProblems,
  rankCreators,
  paid,
  summary,
  pushPayload,
  emailText,
  dateWords,
};
