"use strict";
// Subject Medias bookings: what a booking may hold, which creators to suggest
// for it, and what an alert may say. Used by routes/sm-bookings.js; the table
// is migration 030.
//
// Alerts never carry athlete details. A push names the package, sport, place
// and date. The email adds the booker's own contact so Kyron can call back.
// Notes and the athlete's team and jersey stay in the app.

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
const STATUSES = Object.freeze(["new", "contacted", "offered", "staffed", "delivered", "cancelled"]);
const OPEN = Object.freeze(["new", "contacted", "offered"]);
const REGION_WORDS = Object.freeze({ west: "West", south_central: "South Central", northeast: "Northeast", southeast: "Southeast", midwest: "Midwest" });

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
const clean = (s, max) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const regionFor = (state) => STATE_REGION[String(state || "").toUpperCase()] || null;

// 'YYYY-MM-DD' → a UTC midnight timestamp, or null for anything else.
function dayValue(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
}
const todayValue = (now) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

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
  const r = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const v = {};

  v.kind = KINDS.includes(r.kind) ? r.kind : (errors.push("kind"), null);
  v.package = Object.prototype.hasOwnProperty.call(PACKAGES, r.package) ? r.package : "unsure";
  v.sport = clean(r.sport, 40) || null;
  v.event_name = clean(r.event_name, 120) || null;

  const day = dayValue(r.event_date);
  const today = todayValue(now);
  // A day's grace for time zones behind UTC; nothing more than two years out.
  if (day === null || day < today - DAY || day > today + 730 * DAY) errors.push("event_date");
  else v.event_date = r.event_date;

  v.event_city = clean(r.event_city, 80) || (errors.push("event_city"), null);
  const st = clean(r.event_state, 2).toUpperCase();
  v.event_state = STATE_REGION[st] ? st : (errors.push("event_state"), null);
  v.region = regionFor(v.event_state);

  if (r.athletes !== undefined && r.athletes !== null && r.athletes !== "") {
    const n = Number(r.athletes);
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
  v.notes = String(r.notes == null ? "" : r.notes).trim().slice(0, 1000) || null;
  v.adult_confirmed = r.adult_confirmed === true || r.adult_confirmed === "true" || r.adult_confirmed === "on";
  if (!v.adult_confirmed) errors.push("adult_confirmed");

  return { errors, value: v };
}

// A paid package, sent by subjectmedias.com's Stripe webhook. Stripe has the
// buyer's email; the rest comes from the checkout's own fields when it has them.
function normalizePaid(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const v = { source: "stripe" };
  const sid = String(r.stripe_session_id || "");
  if (/^cs_[A-Za-z0-9_]{8,200}$/.test(sid)) v.stripe_session_id = sid;
  else errors.push("stripe_session_id");
  v.package = Object.prototype.hasOwnProperty.call(PACKAGES, r.package) ? r.package : "unsure";
  v.kind = v.package === "team" ? "team" : v.package === "event" ? "event" : "athlete";
  const cents = Number(r.amount_cents);
  v.amount_cents = Number.isInteger(cents) && cents >= 0 ? cents : null;
  v.contact_name = clean(r.contact_name, 80) || "Stripe customer";
  const email = clean(r.contact_email, 200).toLowerCase();
  v.contact_email = isEmail(email) ? email : (errors.push("contact_email"), null);
  v.contact_phone = phone(r.contact_phone);
  v.sport = clean(r.sport, 40) || null;
  v.event_name = clean(r.event_name, 120) || null;
  v.event_date = dayValue(r.event_date) === null ? null : r.event_date;
  v.event_city = clean(r.event_city, 80) || null;
  const st = clean(r.event_state, 2).toUpperCase();
  v.event_state = STATE_REGION[st] ? st : null;
  v.region = regionFor(v.event_state);
  v.team_jersey = clean(r.team_jersey, 60) || null;
  return { errors, value: v };
}

// Screened on the game's date (today when it has none): a contract, a
// background check and safety training, each under a year old. Same rule as
// a Pylon stop.
function screened(c, onDay) {
  const day = dayValue(onDay) ?? todayValue(new Date());
  return ["contract_signed_on", "background_check_on", "safety_training_on"].every((k) => {
    const t = dayValue(c && c[k]);
    return t !== null && t <= day && day - t < 365 * DAY;
  });
}

// Creators to suggest: the crew pool in the booking's region (same city first,
// then screened, then adults), and creators with a live page of their own
// whose coverage area names the city or the state.
function rankCreators(booking, crewPool, clubCreators) {
  const b = booking || {};
  const city = String(b.event_city || "").toLowerCase();
  const crew = (crewPool || [])
    .filter((c) => c && c.status === "active" && b.region && c.region === b.region)
    .map((c) => ({
      id: c.id,
      name: c.name,
      home_city: c.home_city || null,
      tier: c.tier === "adult" ? "adult" : "youth",
      screened: screened(c, b.event_date),
      same_city: !!city && String(c.home_city || "").toLowerCase() === city,
    }))
    .sort((a, z) => (z.same_city - a.same_city) || (z.screened - a.screened) || ((a.tier === "adult" ? 0 : 1) - (z.tier === "adult" ? 0 : 1)) || String(a.name).localeCompare(String(z.name)))
    .slice(0, 6);
  const st = String(b.event_state || "").toUpperCase();
  const pages = (clubCreators || [])
    .filter((c) => c && c.status === "active" && c.page_status === "live" && c.location)
    .filter((c) => {
      const loc = String(c.location);
      return (city && loc.toLowerCase().includes(city)) || (st && new RegExp("\\b" + st + "\\b").test(loc.toUpperCase()));
    })
    .map((c) => ({ slug: c.slug, brand_name: c.brand_name, location: c.location }))
    .slice(0, 3);
  return { crew, pages };
}

function what(b) {
  return b.package && b.package !== "unsure" ? PACKAGES[b.package] : KIND_WORDS[b.kind] || "Coverage";
}
function place(b) {
  return [b.event_city, b.event_state].filter(Boolean).join(", ");
}
// One line for lists and pushes: what, sport, where, when.
function summary(b) {
  return [what(b), b.sport, place(b), dateWords(b.event_date)].filter(Boolean).join(" · ");
}

// The push to the TOJ app. No names, no contact, no notes.
function pushPayload(b, crewCount) {
  const n = Number(crewCount) || 0;
  const near = b.region ? (n ? `${n} ${n === 1 ? "creator" : "creators"} in the region` : "no creators in that region yet") : "no place given";
  return {
    title: b.source === "stripe" ? "Paid booking" : "New booking",
    body: `${summary(b)} · ${near}`,
    url: `/app/#booking/${b.id}`,
    tag: `sm-booking-${b.id}`,
  };
}

function money(cents) {
  return "$" + (Number(cents || 0) / 100).toFixed(2);
}

// The staff email: enough to call the booker back and to know who to ask.
function emailText(b, matches, appBase) {
  const m = matches || { crew: [], pages: [] };
  const base = String(appBase || "https://tojcampaign.com").replace(/\/+$/, "");
  const subject = `${b.source === "stripe" ? "Paid booking" : "New booking"}: ${[what(b), place(b), dateWords(b.event_date)].filter(Boolean).join(", ")}`;
  const lines = [];
  lines.push(b.source === "stripe" ? `Paid on subjectmedias.com: ${money(b.amount_cents)}.` : "A new booking request from subjectmedias.com.");
  lines.push("");
  lines.push(`What: ${[what(b), b.sport].filter(Boolean).join(", ")}`);
  if (b.event_name) lines.push(`Event: ${b.event_name}`);
  lines.push(`Where: ${place(b) || "not given"}${b.region ? ` (${REGION_WORDS[b.region]})` : ""}`);
  lines.push(`When: ${dateWords(b.event_date, { weekday: true }) || "not given"}`);
  if (b.athletes) lines.push(`Athletes: ${b.athletes}`);
  lines.push(`Booked by: ${[b.contact_name, b.contact_email, b.contact_phone].filter(Boolean).join(", ")}`);
  lines.push("");
  if (m.crew.length) {
    lines.push(`Creators in the ${REGION_WORDS[b.region]}:`);
    for (const c of m.crew) {
      const notes = [c.home_city, c.tier === "youth" ? "youth, needs a screened adult" : null, c.screened ? "screened" : "screening not current"].filter(Boolean).join("; ");
      lines.push(`- ${c.name} (${notes})`);
    }
  } else {
    lines.push(b.region ? `No creator in the ${REGION_WORDS[b.region]} yet. Reach out to the pool.` : "No place given, so no creators suggested.");
  }
  if (m.pages.length) {
    lines.push("");
    lines.push("Creators with their own page nearby:");
    for (const p of m.pages) lines.push(`- ${p.brand_name} (${p.location})`);
  }
  lines.push("");
  lines.push(`Open it in the TOJ app: ${base}/app/#booking/${b.id}`);
  lines.push("Notes and the athlete's team and jersey are in the app.");
  return { subject, text: lines.join("\n") };
}

module.exports = {
  KINDS,
  PACKAGES,
  STATUSES,
  OPEN,
  REGION_WORDS,
  STATE_REGION,
  regionFor,
  normalize,
  normalizePaid,
  screened,
  rankCreators,
  summary,
  pushPayload,
  emailText,
  dateWords,
};
