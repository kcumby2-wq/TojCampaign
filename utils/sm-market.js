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
// - 12 or younger (any guardian saying so, confirmed or not) is family only:
//   never sold to other families, never public. Guardians also give an age
//   band (12 or younger, 13 to 15, 16 or 17, 18 or older).
// - A clip or photo belongs to the athletes whose tags a person confirmed. It
//   is shown, and sold, only where every one of them allows it:
//     the store (anyone browsing)        every athlete in it: public
//     the event link (team and jersey,   every athlete in it: OK to sell or public
//       with the event's access code)
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
const AGE_BANDS = Object.freeze(["u13", "13_15", "16_17", "18_plus"]);
const AGE_RANK = Object.freeze({ u13: 0, "13_15": 1, "16_17": 2, "18_plus": 3 });
const AGE_WORDS = Object.freeze({ u13: "12 or younger", "13_15": "13 to 15", "16_17": "16 or 17", "18_plus": "18 or older" });
// The event clips page's access code: 8 letters and digits, no 0/O or 1/I.
const VIEW_KEY = /^[A-HJ-NP-Z2-9]{8}$/;
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
// The clips page's access code. Families type it as they see it, "ABCD-EFGH".
function newViewKey() {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
const viewKeyOf = (v) => {
  const s = one(v, 24).toUpperCase().replace(/[\s-]/g, "");
  return VIEW_KEY.test(s) ? s : null;
};
const viewKeyShown = (k) => (VIEW_KEY.test(String(k || "")) ? `${k.slice(0, 4)}-${k.slice(4)}` : "");
// Compared in constant time, so it can't be found a letter at a time. Only
// a string is a code (a form field or a link's ?k=).
function viewKeyMatches(given, ev) {
  if (typeof given !== "string") return false;
  const k = viewKeyOf(given);
  const want = ev && String(ev.view_key || "");
  if (!k || !VIEW_KEY.test(want)) return false;
  return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want));
}
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
// "#07" is 7, but 0 and 00 are two different numbers on a court.
const jerseyOf = (v) => {
  const s = one(v, 4).replace(/^#/, "");
  if (!/^[0-9]{1,3}$/.test(s)) return null;
  if (/^0+$/.test(s)) return s.length <= 2 ? s : null;
  return s.replace(/^0+/, "");
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
  if (AGE_BANDS.includes(r.age)) v.age_band = r.age;
  // A keep-out doesn't wait on an age: without one, it's taken as the
  // youngest band, the most careful reading.
  else if (v.level === "out") v.age_band = "u13";
  else errors.push("age");
  if (v.age_band) v.under_13 = v.age_band === "u13";
  // 12 or younger is family only (or kept out): the form says so, and
  // selling to other families or showing publicly isn't taken.
  if (v.under_13 && (v.level === "sell" || v.level === "public")) errors.push("level");
  // Who's answering: a parent or legal guardian (18 or older), or the
  // athlete as a legal adult, and then only at 18 or older. A keep-out is
  // taken from anyone: it only ever protects.
  if (v.level !== "out") {
    if (r.who === "self") {
      if (v.age_band && v.age_band !== "18_plus") errors.push("who");
    } else if (r.who !== "guardian") errors.push("who");
  }
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
  // Any guardian saying 12 or younger (confirmed or not) makes it family only.
  if (RANK[level] > RANK.family && list.some((c) => c.under_13 !== false)) level = "family";
  return level;
}
const levelAtLeast = (level, want) => (RANK[level] || 0) >= RANK[want] && level !== "none" && level !== "out";

// The age band an answer stands for. A row without one reads carefully: 12
// or younger unless it says otherwise, and then the youngest band above that.
const bandOf = (row) => (row && AGE_BANDS.includes(row.age_band) ? row.age_band : row && row.under_13 === false ? "13_15" : "u13");
const youngerBand = (a, b) => (AGE_RANK[a] <= AGE_RANK[b] ? a : b);
const withBand = (b) => ({ age_band: b, under_13: b === "u13" });
// 12 or younger is family only, so a row saying so never holds more.
const capU13 = (level, band) => (band === "u13" && RANK[level] > RANK.family ? "family" : level);

// Would a guardian's new answer loosen the one of theirs that counts now? A
// keep-out never does. A higher level does, and so does an older age band
// ("16 or 17" after "12 or younger"). What loosens waits for their email;
// the rest counts at once.
function looser(current, answer) {
  if (answer.level === "out") return false;
  return RANK[answer.level] > RANK[current.level] || AGE_RANK[answer.age_band] > AGE_RANK[bandOf(current)];
}

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
// One mailbox, however it's written: no +tag, and Gmail ignores dots. For
// counting what's sent to someone, never for sending.
function mailboxOf(e) {
  const [local, domain] = String(e || "").toLowerCase().split("@");
  if (!domain) return String(e || "").toLowerCase();
  let l = local.split("+")[0];
  let d = domain;
  if (d === "gmail.com" || d === "googlemail.com") {
    l = l.replace(/\./g, "");
    d = "gmail.com";
  }
  return l + "@" + d;
}

// What a guardian's QR answer does to their answer so far (was: their row,
// or null). It returns the fields to write, a confirm token when the answer
// needs their email to count, and whether it counts now.
//   - A keep-out counts at once, over anything. The youngest age band said so
//     far stays.
//   - Nothing of theirs counts yet: the new answer waits for their email. An
//     unconfirmed "12 or younger" already counts, so it carries over until a
//     change to it is confirmed.
//   - Their answer counts: what's more careful (a lower level, a younger
//     band) counts now; what loosens (or the same answer again, for a fresh
//     family link) waits for their email.
// A row saying 12 or younger never holds more than family only. Whatever
// counts now is the guardian's QR answer, so a staff-recorded row becomes
// theirs; a change still waiting leaves it as it was.
function answerPlan(was, value, at) {
  const wasBand = was ? bandOf(was) : null;
  if (value.level === "out") {
    const b = wasBand ? youngerBand(wasBand, value.age_band) : value.age_band;
    return { tok: null, now: true, write: { level: "out", ...withBand(b), pending_level: null, pending_under_13: null, pending_age_band: null, confirm_hash: null, confirm_sent_at: null, source: "qr", recorded_by: null } };
  }
  const counts = !!was && (!!was.confirmed_at || was.level === "out");
  if (!counts) {
    const tok = newToken();
    const keepU13 = wasBand === "u13" && value.age_band !== "u13";
    const b = keepU13 ? "u13" : value.age_band;
    return {
      tok,
      now: false,
      write: {
        level: capU13(value.level, b),
        ...withBand(b),
        pending_level: keepU13 ? value.level : null,
        pending_under_13: keepU13 ? false : null,
        pending_age_band: keepU13 ? value.age_band : null,
        confirm_hash: tok.hash,
        confirm_sent_at: at,
        confirmed_at: null,
        family_hash: null,
        source: "qr",
        recorded_by: null,
      },
    };
  }
  const same = value.level === was.level && value.age_band === wasBand;
  const b = youngerBand(wasBand, value.age_band);
  const level = capU13(RANK[value.level] < RANK[was.level] ? value.level : was.level, b);
  if (same || looser(was, value)) {
    const tok = newToken();
    return { tok, now: false, write: { level, ...withBand(b), pending_level: value.level, pending_under_13: value.age_band === "u13", pending_age_band: value.age_band, confirm_hash: tok.hash, confirm_sent_at: at } };
  }
  return { tok: null, now: true, write: { level, ...withBand(b), pending_level: null, pending_under_13: null, pending_age_band: null, confirm_hash: null, confirm_sent_at: null, source: "qr", recorded_by: null } };
}

function helpEmail(env = process.env) {
  const e = String(env.SM_HELP_EMAIL || "").trim().toLowerCase();
  return isEmail(e) ? e : "hello@subjectmedias.com";
}
function siteBase(env = process.env) {
  return String(env.SM_SITE_BASE || "https://www.subjectmedias.com").replace(/\/+$/, "");
}
// The family-facing addresses, on subjectmedias.com (its /m/ rewrite reaches
// routes/sm-market-public.js). A token in a link is never stored, only its hash.
const linkTo = {
  // With the access code: the link on the clips QR and the check-in handout.
  event: (code, key) => `${siteBase()}/m/${code}${VIEW_KEY.test(String(key || "")) ? `?k=${key}` : ""}`,
  consent: (code) => `${siteBase()}/m/${code}/consent`,
  confirm: (token) => `${siteBase()}/m/confirm/${token}`,
  family: (token) => `${siteBase()}/m/f/${token}`,
  order: (token) => `${siteBase()}/m/o/${token}`,
};
// who: "guardian" (a parent or legal guardian) or "self" (the athlete, as an adult).
function consentEmail(event, team, jersey, level, link, who = "guardian") {
  const what = {
    out: "keep them out of everything we sell",
    family: "only your family sees and buys their footage",
    sell: "people with the event's access code can find and buy their footage by team and jersey number",
    public: "their footage can also be shown where anyone can see it, like our online store and our social pages",
  }[level];
  return {
    subject: `Confirm your choice for ${team} #${jersey} at ${event.name}`,
    text: [
      "Hi,",
      "",
      who === "self"
        ? `Someone using this email said they're ${team} #${jersey} at ${event.name}, answering as an adult athlete, and chose: ${LEVEL_WORDS[level]} (${what}).`
        : `Someone using this email said they're the parent or guardian of ${team} #${jersey} at ${event.name}, and chose: ${LEVEL_WORDS[level]} (${what}).`,
      "",
      "If that was you, confirm it here:",
      link,
      "",
      `If it wasn't you, ignore this email and nothing changes. You can change your choice any time from the same form, or by emailing ${helpEmail()}.`,
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
      `Keep it to your family: anyone with the link sees what it shows. To change your choice, or to have your athlete kept out, email ${helpEmail()}.`,
      "",
      "Subject Medias",
    ].join("\n"),
  };
}
// A keep-out, or a more careful choice: it counts at once, so this only tells
// the address given what happened.
function keptOutEmail(event, team, jersey) {
  return {
    subject: `Kept out: ${team} #${jersey} at ${event.name}`,
    text: [
      `Someone using this email asked us to keep ${team} #${jersey} out of everything from ${event.name}. Done: nothing of them is shown or sold.`,
      "",
      `If that wasn't you, or you want to change it, email ${helpEmail()}.`,
      "",
      "Subject Medias",
    ].join("\n"),
  };
}
function changedEmail(event, team, jersey, level, band) {
  return {
    subject: `Changed: ${team} #${jersey} at ${event.name}`,
    text: [
      `Someone using this email changed the choice for ${team} #${jersey} at ${event.name} to: ${LEVEL_WORDS[level]}${AGE_WORDS[band] ? `, ${AGE_WORDS[band]}` : ""}.`,
      "",
      "A more careful choice counts at once, so it's in effect now.",
      "",
      `If that wasn't you, or you want to change it back, email ${helpEmail()}.`,
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
      `Keep this email: the link is how you get back to them. Questions? Email ${helpEmail()}.`,
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
  RANK,
  AGE_BANDS,
  AGE_WORDS,
  VIEW_KEY,
  STATUSES,
  MEDIA_STATUSES,
  DEFAULT_PRICES,
  MAX_UPLOAD_BYTES,
  newCode,
  codeOf,
  newViewKey,
  viewKeyOf,
  viewKeyShown,
  viewKeyMatches,
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
  bandOf,
  looser,
  youngerBand,
  answerPlan,
  mailboxOf,
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
  helpEmail,
  siteBase,
  linkTo,
  consentEmail,
  familyEmail,
  keptOutEmail,
  changedEmail,
  orderEmail,
};
