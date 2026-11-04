"use strict";
// The Subject Medias marketplace: the rules. Used by routes/sm-market.js
// (staff), routes/sm-market-public.js (families) and utils/sm-market-worker.js
// (previews and jersey suggestions). The tables are migration 033.
//
// Who may see and buy what:
// - Every athlete is a team and a jersey number at one event. A parent or
//   guardian chooses for them: family only, OK to sell, OK to show publicly,
//   or keep out. The most careful answer among the guardians wins; a keep-out
//   counts the moment it's asked for, the rest once confirmed from the
//   guardian's email (or recorded by staff). Staff keep-out beats everything.
//   No confirmed consent means nothing is shown or sold.
// - Under 13 (any guardian saying so) is never public.
// - A clip or photo belongs to the athletes whose tags a person confirmed. It
//   is shown, and sold, only where every one of them allows it:
//     the store (anyone browsing)        every athlete in it: public
//     the event link (team and jersey)   every athlete in it: OK to sell or public
//     a family's own link                that family's athlete: family or more;
//                                        everyone else in it: OK to sell or more
//   An item with no confirmed tag is shown nowhere.

const crypto = require("crypto");
const { line } = require("./tools");
const { STATE_REGION, isEmail } = require("./sm-bookings");

const BUCKET = "sm-market";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const LEVELS = Object.freeze(["out", "family", "sell", "public"]);
const RANK = Object.freeze({ out: 0, none: 0, family: 1, sell: 2, public: 3 });
const LEVEL_WORDS = Object.freeze({
  none: "No consent yet",
  out: "Kept out",
  family: "Family only",
  sell: "OK to sell",
  public: "OK to show publicly",
});
const STATUSES = Object.freeze(["draft", "live", "closed"]);
const MEDIA_STATUSES = Object.freeze(["uploaded", "processing", "review", "approved", "hidden", "failed"]);
const DEFAULT_PRICES = Object.freeze({ clip: 1200, photo: 800 });
const KIND_OF_EXT = Object.freeze({ mp4: "clip", mov: "clip", m4v: "clip", jpg: "photo", jpeg: "photo", png: "photo" });
const TYPE_OF_EXT = Object.freeze({ mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" });
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const text = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const one = (v, max) => line(text(v), max);
const has = (obj, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(obj, k);

// ── Codes and tokens ─────────────────────────────────────────────────────
function newCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
const codeOf = (v) => {
  const s = one(v, 12).toUpperCase();
  return CODE.test(s) ? s : null;
};
// A link token: 32 random bytes. The database keeps only its hash.
function newToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}
const tokenOk = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t);

// ── Dates and money ──────────────────────────────────────────────────────
function dayValue(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(s));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
}
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
// "$12", "12", "12.5" or 1250 cents → cents, or null.
function centsOf(v, { isCents = false } = {}) {
  if (isCents) {
    const n = Number(v);
    return Number.isInteger(n) && n >= 100 && n <= 100000 ? n : null;
  }
  const s = one(v, 12).replace(/^\$/, "");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) return null;
  const n = Math.round(Number(s) * 100);
  return n >= 100 && n <= 100000 ? n : null;
}
const money = (cents) => "$" + (Number(cents || 0) / 100).toFixed(2);

// ── Events ───────────────────────────────────────────────────────────────
// A new event, or the fields being changed ({ partial: true }).
function eventInput(raw, { partial = false } = {}) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const v = {};
  const want = (k) => !partial || r[k] !== undefined;
  if (want("name")) v.name = one(r.name, 120) || (errors.push("name"), null);
  if (want("sport")) v.sport = one(r.sport, 40) || null;
  if (want("venue")) v.venue = one(r.venue, 120) || null;
  if (want("city")) v.city = one(r.city, 80) || null;
  if (want("state")) {
    const st = one(r.state, 2).toUpperCase();
    if (!st) v.state = null;
    else if (STATE_REGION[st]) v.state = st;
    else errors.push("state");
  }
  if (want("starts_on")) {
    const t = dayValue(r.starts_on);
    if (t === null) errors.push("starts_on");
    else v.starts_on = isoDay(t);
  }
  if (want("ends_on") || (!partial && r.ends_on === undefined)) {
    const t = r.ends_on === undefined || r.ends_on === "" ? dayValue(r.starts_on) : dayValue(r.ends_on);
    if (t === null) errors.push("ends_on");
    else v.ends_on = isoDay(t);
  }
  if (v.starts_on && v.ends_on) {
    const days = (dayValue(v.ends_on) - dayValue(v.starts_on)) / 864e5;
    if (days < 0 || days > 14) errors.push("ends_on");
  }
  for (const [k, def] of [["clip_cents", DEFAULT_PRICES.clip], ["photo_cents", DEFAULT_PRICES.photo]]) {
    if (r[k] === undefined) {
      if (!partial) v[k] = def;
      continue;
    }
    const c = centsOf(r[k], { isCents: true });
    if (c === null) errors.push(k);
    else v[k] = c;
  }
  if (r.status !== undefined) {
    if (STATUSES.includes(r.status)) v.status = r.status;
    else errors.push("status");
  }
  return { errors, value: v };
}

const teamName = (v) => one(v, 60) || null;
const jerseyOf = (v) => {
  const s = one(v, 4).replace(/^#/, "");
  return /^[0-9]{1,3}$/.test(s) ? String(Number(s)) : null;
};

// ── Consent ──────────────────────────────────────────────────────────────
// What a guardian sends from the QR form (or staff record in the app).
function consentInput(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const v = {};
  v.team_id = UUID.test(text(r.team_id)) ? text(r.team_id).toLowerCase() : (errors.push("team_id"), null);
  v.jersey = jerseyOf(r.jersey) || (errors.push("jersey"), null);
  const email = one(r.email, 200).toLowerCase();
  v.email = isEmail(email) ? email : (errors.push("email"), null);
  v.level = LEVELS.includes(r.level) ? r.level : (errors.push("level"), null);
  if (r.under_13 === true || r.under_13 === "yes") v.under_13 = true;
  else if (r.under_13 === false || r.under_13 === "no") v.under_13 = false;
  else errors.push("under_13");
  // Never public under 13: the form shouldn't offer it, and it isn't taken.
  if (v.level === "public" && v.under_13 === true) errors.push("level");
  const guardian = r.guardian === true || r.guardian === "yes" || r.guardian === "on";
  if (!guardian) errors.push("guardian");
  return { errors, value: v };
}

// The level an athlete's footage is shown and sold at, from their roster row
// and every consent given for them.
function effectiveLevel(athlete, consents) {
  if (!athlete || athlete.keep_out) return "out";
  const list = (consents || []).filter((c) => c && c.athlete_id === athlete.id);
  // A keep-out counts at once, confirmed or not: it only ever protects.
  if (list.some((c) => c.level === "out")) return "out";
  const confirmed = list.filter((c) => c.confirmed_at && LEVELS.includes(c.level));
  if (!confirmed.length) return "none";
  let level = confirmed.reduce((lo, c) => (RANK[c.level] < RANK[lo] ? c.level : lo), "public");
  // Any guardian saying under 13 makes the athlete under 13.
  if (level === "public" && list.some((c) => c.under_13 !== false)) level = "sell";
  return level;
}
const levelAtLeast = (level, want) => (RANK[level] || 0) >= RANK[want] && level !== "none" && level !== "out";

// Who's in an item: the athletes whose tags a person confirmed.
function itemAthletes(item, tags) {
  return (tags || []).filter((t) => t && t.media_id === item.id && t.confirmed).map((t) => t.athlete_id);
}

// May this item be shown (and sold) through this way in?
//   access: "store", "event" or "family"
//   forAthlete: the athlete the family link or the team-and-jersey search is for
function itemAllowed(item, { access, forAthlete = null, tags, levels }) {
  if (!item || item.status !== "approved") return false;
  const who = itemAthletes(item, tags);
  if (!who.length) return false;
  if (forAthlete && !who.includes(forAthlete)) return false;
  return who.every((id) => {
    const level = levels.get(id) || "none";
    if (access === "store") return levelAtLeast(level, "public");
    if (access === "family" && id === forAthlete) return levelAtLeast(level, "family");
    return levelAtLeast(level, "sell");
  });
}

// ── Media ────────────────────────────────────────────────────────────────
// A file staff are about to upload: its kind, extension and content type.
function uploadInput(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const name = one(r.filename, 200);
  const m = /\.([A-Za-z0-9]{2,4})$/.exec(name);
  const ext = m ? m[1].toLowerCase() : "";
  const bytes = Number(r.bytes);
  const errors = [];
  if (!name || !has(KIND_OF_EXT, ext)) errors.push("filename");
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_UPLOAD_BYTES) errors.push("bytes");
  return { errors, value: { filename: name || null, ext, kind: KIND_OF_EXT[ext] || null, content_type: TYPE_OF_EXT[ext] || null, bytes } };
}
const originalKey = (eventId, mediaId, ext) => `events/${eventId}/originals/${mediaId}.${ext}`;
const previewKey = (eventId, mediaId, kind) => `events/${eventId}/previews/${mediaId}.${kind === "clip" ? "mp4" : "jpg"}`;
const posterKey = (eventId, mediaId) => `events/${eventId}/previews/${mediaId}-poster.jpg`;
const priceOf = (event, kind) => (kind === "photo" ? event.photo_cents : event.clip_cents);

// The download name a buyer sees: event, kind, a short id, the extension.
function downloadName(event, item) {
  const base = String(event.name || "Subject Medias").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "Subject-Medias";
  const ext = (/\.([a-z0-9]+)$/.exec(item.object_key) || [, "bin"])[1];
  return `${base}-${item.kind}-${String(item.id).slice(0, 8)}.${ext}`;
}

// ── Jersey suggestions ───────────────────────────────────────────────────
// The question for the model: which roster numbers can it read in these
// frames. It sees team names and numbers only; there are no names to see.
function tagPrompt(event, teams, roster) {
  const byTeam = teams.map((t) => {
    const nums = roster.filter((a) => a.team_id === t.id).map((a) => a.jersey).sort((a, b) => a - b);
    return `- ${t.name}: ${nums.length ? nums.join(", ") : "(no numbers yet)"}`;
  });
  return [
    `These are frames from one ${event.sport ? event.sport + " " : ""}clip at ${event.name}.`,
    "Read the jersey numbers you can see clearly on players in the frames.",
    "Only these teams and numbers are on the roster:",
    ...byTeam,
    "Answer with JSON only, no other text: {\"numbers\": [{\"jersey\": \"7\", \"team\": \"<team name or null>\", \"confidence\": 0.0}]}",
    "confidence is 0 to 1: how sure you are the number is right. Leave out numbers you can't read. Don't guess a team you can't tell; use null.",
  ].join("\n");
}

// The model's answer → suggestions on the roster. A number with no team goes
// to the one athlete wearing it, or to none when two teams share it.
function parseTagAnswer(answer, teams, roster, { min = 0.5 } = {}) {
  let data = null;
  const s = text(answer);
  const m = /\{[\s\S]*\}/.exec(s);
  if (m) {
    try {
      data = JSON.parse(m[0]);
    } catch (e) {
      data = null;
    }
  }
  const list = data && Array.isArray(data.numbers) ? data.numbers.slice(0, 40) : [];
  const out = new Map();
  for (const n of list) {
    if (!n || typeof n !== "object") continue;
    const jersey = jerseyOf(n.jersey);
    const conf = Number(n.confidence);
    if (!jersey || !Number.isFinite(conf) || conf < min || conf > 1) continue;
    const teamText = one(n.team, 60).toLowerCase();
    const team = teamText ? teams.find((t) => t.name.toLowerCase() === teamText) : null;
    const matches = roster.filter((a) => a.jersey === jersey && (!team || a.team_id === team.id));
    if (matches.length !== 1) continue;
    const id = matches[0].id;
    if (!out.has(id) || out.get(id) < conf) out.set(id, Math.round(conf * 100) / 100);
  }
  return [...out].map(([athlete_id, confidence]) => ({ athlete_id, confidence }));
}

// ── Emails ───────────────────────────────────────────────────────────────
function siteBase(env = process.env) {
  return String(env.SM_SITE_BASE || "https://www.subjectmedias.com").replace(/\/+$/, "");
}
// The family-facing addresses, on subjectmedias.com (its /m/ rewrite reaches
// routes/sm-market-public.js). A token in a link is never stored, only its hash.
const linkTo = {
  event: (code) => `${siteBase()}/m/${code}`,
  consent: (code) => `${siteBase()}/m/${code}/consent`,
  confirm: (token) => `${siteBase()}/m/confirm/${token}`,
  family: (token) => `${siteBase()}/m/f/${token}`,
  order: (token) => `${siteBase()}/m/o/${token}`,
};
function consentEmail(event, team, jersey, level, link) {
  const what = {
    out: "keep them out of everything we sell",
    family: "only your family sees and buys their footage",
    sell: "anyone with their team and jersey number can see and buy their footage",
    public: "their footage can also be shown publicly in our store",
  }[level];
  return {
    subject: `Confirm your choice for ${team} #${jersey} at ${event.name}`,
    text: [
      "Hi,",
      "",
      `Someone using this email said they're the parent or guardian of ${team} #${jersey} at ${event.name}, and chose: ${LEVEL_WORDS[level]} (${what}).`,
      "",
      "If that was you, confirm it here:",
      link,
      "",
      "If it wasn't you, ignore this email and nothing changes. You can change your choice any time from the same form, or by replying to this email.",
      "",
      "Subject Medias",
    ].join("\n"),
  };
}
// The family link, once a choice counts: the athlete's own page.
function familyEmail(event, team, jersey, level, link) {
  return {
    subject: `Your family link for ${team} #${jersey} at ${event.name}`,
    text: [
      "Hi,",
      "",
      `Your choice for ${team} #${jersey} at ${event.name} is in: ${LEVEL_WORDS[level]}.`,
      "",
      "This is your family's own link. It shows the clips and photos of your athlete once our crew has checked them, and it's where you buy:",
      link,
      "",
      "Keep it to your family: anyone with the link sees what it shows. To change your choice, or to have your athlete kept out, reply to this email.",
      "",
      "Subject Medias",
    ].join("\n"),
  };
}
function orderEmail(event, order, link) {
  return {
    subject: `Your clips and photos from ${event.name}`,
    text: [
      "Thanks for your order.",
      "",
      `Your downloads from ${event.name} (${money(order.amount_cents)}) are here, in full resolution with no watermark:`,
      link,
      "",
      "Keep this email: the link is how you get back to them. Questions? Reply to this email.",
      "",
      "Subject Medias",
    ].join("\n"),
  };
}

module.exports = {
  BUCKET,
  UUID,
  CODE,
  LEVELS,
  LEVEL_WORDS,
  STATUSES,
  MEDIA_STATUSES,
  DEFAULT_PRICES,
  MAX_UPLOAD_BYTES,
  newCode,
  codeOf,
  newToken,
  hashToken,
  tokenOk,
  centsOf,
  money,
  eventInput,
  teamName,
  jerseyOf,
  consentInput,
  effectiveLevel,
  levelAtLeast,
  itemAthletes,
  itemAllowed,
  uploadInput,
  originalKey,
  previewKey,
  posterKey,
  priceOf,
  downloadName,
  tagPrompt,
  parseTagAnswer,
  siteBase,
  linkTo,
  consentEmail,
  familyEmail,
  orderEmail,
};
