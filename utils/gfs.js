// Ground Floor Sports · Pylon events — the pure rules behind the event-media
// system (routes/gfs.js stores, public/app/gfs.js shows). No network, no
// database. Migration 024 enforces the same rules in Postgres, so a bug here
// can't list a held clip or approve a piece without consent.
//
// Where each rule comes from (Oct 2026 drafts; bracketed numbers are still
// open in the paper and editable per event):
//   Pylon × GFS Partnership Agreement v11
//     Schedule C-1/C-2  what every event owes Pylon, how many, by when
//     Schedule F, L-5   the eight Guardian Consent permissions; the under-13 rule
//     Section 11        withdrawal, minors, screened operators
//   GFS Digital Scout Agreement v1.6
//     §4                the four creator measures (95% · 90% · 90% · 4.2)
//     §6                background check and minor-safety training, yearly
//     Schedule B-1/B-5  angles, upload within 12 hours, clip labels
//   GFS × SportsClippers Agreement v1.1
//     §5                what a listing may carry (no birth dates, no contact)
//     Schedule A        consent first, family-only by default, never public under 13
//   GFS Subject Media Creator Playbook v1.5   adult and youth creators
//   pylon-os config (Kyron, Oct 18)           takedown windows: 2h/24h, 24h/72h

"use strict";

const crypto = require("crypto");

// ── Regions, sizes, roles ────────────────────────────────────────────────
const REGIONS = Object.freeze({ west: "West", south_central: "South Central", northeast: "Northeast", southeast: "Southeast", midwest: "Midwest" });
const SIZES = Object.freeze({ premier: "Premier Event", one_day: "One-Day Tournament", clinic: "Clinic" });
const STATUSES = Object.freeze(["planning", "live", "wrapped", "closed", "cancelled"]);

// Schedule C-2: named, screened operators on site per event day.
const CREW_TARGET = Object.freeze({ premier: 3, one_day: 2, clinic: 1 });
const CREW_ROLES = Object.freeze({ lead: "Lead", shooter: "Shooter", photographer: "Photographer", story: "Story camera", editor: "Editor", shadow: "Shadow" });
const ON_SITE = Object.freeze(["lead", "shooter", "photographer", "story", "shadow"]);
// Creator Playbook v1.5 Part 2: a youth creator (16–17) shoots alongside an
// adult and never works alone with a minor, so never the lead or the editor.
const YOUTH_ROLES = Object.freeze(["shooter", "photographer", "shadow"]);
const ADULT_ON_SITE = Object.freeze(["lead", "shooter", "photographer", "story"]);

// Schedule B-1: Sideline, End Zone, Eagle Eye; B-1A adds a Story angle that
// never replaces the two wide ones.
const ANGLES = Object.freeze(["Sideline", "EndZone", "EagleEye", "Story"]);
const WIDE = Object.freeze(["Sideline", "EndZone", "EagleEye"]);

// Schedule F's eight permissions, plus two SportsClippers needs (§6 commercial
// licenses; Schedule A public display). All false unless the roster says yes.
const CONSENTS = Object.freeze({
  consent_capture: "Capture",
  consent_recruiting: "Recruiting distribution",
  consent_marketing: "Marketing and social",
  consent_sale: "Sale of media",
  consent_training: "Training-session footage",
  consent_3d: "3D and AI-reconstructed media",
  consent_nft: "Narrative NFT",
  consent_feature: "Pylon Scouting feature",
  consent_commercial: "Commercial licenses",
  public_display: "Public display",
});
const FLAGS = Object.freeze({ do_not_publish: "Do not publish", low_profile: "Low-profile family", priority: "Pre-sold package" });

// Scout Agreement v1.6 §4.
const STANDARD = Object.freeze({ on_time: 0.95, angles_hit: 0.9, usable: 0.9, rating: 4.2 });
const UPLOAD_HOURS = 12;

// pylon-os config.md, decided Oct 18 (stricter than Section 11's 72 hours).
// "Off-site" is a removal request to accounts Pylon doesn't run.
const TAKEDOWN = Object.freeze({
  safety_request: { label: "Safety request", pylon: 2, other: 24, offsite: 24 },
  consent_withdrawn: { label: "Consent withdrawn", pylon: 24, other: 72, offsite: 24 },
});

// Schedule C-1 (Must Captures) and C-2 (baseline coverage). counts are
// [Premier, One-day, Clinic]; 0 means the size doesn't owe it. Deadlines run
// from the end of the event (the last day's wrap) unless stated.
// publishes: posted on Pylon's channels, so a Pylon approver clears it first.
// featured: names the athletes it features, and each needs capture and
// marketing consent (C-1 "Consent").
const DELIVERABLES = Object.freeze([
  { kind: "top_performers", group: "01 Top Performers", name: "Top Performers tracked", counts: [12, 4, 3], hours: 0, note: "Tracked across every game; logged the same day", publishes: false, featured: true },
  { kind: "who_is", group: "01 Top Performers", name: "“Who Is ___?” player features", counts: [6, 2, 1], hours: 120, publishes: true, featured: true },
  { kind: "interviews", group: "02 Personality", name: "On-camera interviews", counts: [8, 3, 2], hours: 24, note: "Raw upload within 24 hours", publishes: false, featured: true },
  { kind: "winner_montage", group: "03 Winner Montage", name: "Winner Montage", counts: [1, 1, 0], hours: 48, publishes: true },
  { kind: "championship_photos", group: "03 Winner Montage", name: "Championship photoshoot", counts: [30, 15, 0], hours: 48, note: "10 selects the same night", publishes: true },
  { kind: "recap", group: "04 Recap", name: "Recap", counts: [1, 1, 1], hours: 72, publishes: true },
  { kind: "recap_ad", group: "04 Recap", name: "Recap recut as an ad for the next stop", counts: [1, 1, 1], hours: 120, publishes: true },
  { kind: "cutdowns", group: "Baseline", name: "Same-day social cut-downs", counts: [6, 3, 2], perDay: true, localTime: "21:00", note: "By 9:00 p.m. local, each event day", publishes: true },
  { kind: "stills", group: "Baseline", name: "Edited stills", counts: [150, 40, 25], hours: 72, publishes: true },
  { kind: "championship_games", group: "Baseline", name: "Championship games, full game on two angles", counts: [3, 1, 0], hours: 12, note: "Semis and final (Premier) · the final (One-day)", publishes: false },
  { kind: "tagging", group: "Baseline", name: "Athlete tagging by jersey number", counts: [1, 1, 1], hours: 168, note: "Done when the game's tags are approved", publishes: false },
  { kind: "sponsor_proof", group: "Baseline", name: "Sponsor proof of performance", counts: [0, 0, 0], hours: 336, note: "One per sold sponsorship", publishes: false, keepZero: true },
  { kind: "event_report", group: "Baseline", name: "Event report", counts: [1, 1, 1], hours: 168, publishes: false },
]);
const DELIVERABLE_KINDS = Object.freeze(DELIVERABLES.map((d) => d.kind));
const SIZE_INDEX = { premier: 0, one_day: 1, clinic: 2 };

// Majority time zone per state (an event can override it).
const STATE_TZ = Object.freeze({
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York",
  DC: "America/New_York", DE: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Boise", IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis", IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York", MD: "America/New_York",
  MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago", MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago",
  OH: "America/New_York", OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago",
  TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York",
  WI: "America/Chicago", WY: "America/Denver",
});

// ── Small helpers ────────────────────────────────────────────────────────
function clean(s, max = 120) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function code(n = 5) {
  const bytes = crypto.randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function validTz(tz) {
  if (!tz || typeof tz !== "string" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}
function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const v = {};
  for (const p of parts) v[p.type] = p.value;
  return Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour % 24, +v.minute, +v.second) - Math.floor(date.getTime() / 1000) * 1000;
}
// A wall-clock time in a zone → the instant (what Postgres does with
// (date + time) AT TIME ZONE tz).
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall;
  for (let i = 0; i < 4; i++) {
    const next = wall - tzOffsetMs(new Date(guess), tz);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}
function addDays(dateStr, n) {
  const t = new Date(dateStr + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}
// The same day one year earlier (Feb 29 → Feb 28), as Postgres's
// (date - interval '1 year')::date does.
function yearBefore(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${String(y - 1).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
function hoursAfter(iso, h) {
  return new Date(new Date(iso).getTime() + h * 3600000).toISOString();
}

// ── Access by region ─────────────────────────────────────────────────────
// Owner and approvers see every region (approvers clear the national queue);
// a Regional Director (member) or viewer sees only their own regions.
function seesAll(access) {
  return !!access && (access.owner || access.role === "approver");
}
function regionsOf(access) {
  if (!access) return [];
  if (seesAll(access)) return Object.keys(REGIONS);
  return (Array.isArray(access.regions) ? access.regions : []).filter((r) => REGIONS[r]);
}
function canSee(access, region) {
  return regionsOf(access).includes(region);
}
function validRegions(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(String).filter((r) => REGIONS[r]))];
}

// ── Events ───────────────────────────────────────────────────────────────
function endsAt(ev) {
  return zonedToUtc(ev.ends_on, String(ev.wraps_at || "18:00").slice(0, 5), ev.tz).toISOString();
}
function eventDays(ev) {
  return daysBetween(ev.starts_on, ev.ends_on) + 1;
}
// A label prefix: letters and digits only (B-5), e.g. Geneva2026.
function eventCode(city, startsOn) {
  const base = String(city || "Event").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "Event";
  return base[0].toUpperCase() + base.slice(1) + String(startsOn || "").slice(0, 4);
}

// The deliverable rows an event owes, with deadlines.
function deliverablesFor(ev) {
  const i = SIZE_INDEX[ev.size];
  const end = endsAt(ev);
  const out = [];
  for (const d of DELIVERABLES) {
    const n = d.counts[i];
    if (!n && !d.keepZero) continue;
    if (d.perDay) {
      const days = eventDays(ev);
      for (let k = 1; k <= days; k++) {
        out.push({ kind: d.kind, day: k, required: n, publishes: d.publishes, due_at: zonedToUtc(addDays(ev.starts_on, k - 1), d.localTime, ev.tz).toISOString() });
      }
    } else {
      out.push({ kind: d.kind, day: 0, required: n, publishes: d.publishes, due_at: hoursAfter(end, d.hours) });
    }
  }
  return out;
}
function deliverableInfo(kind) {
  return DELIVERABLES.find((d) => d.kind === kind) || null;
}

// ── The roster (Sports Thread export) ────────────────────────────────────
// Kept: roster ID, team, division, jersey, position and the permission flags.
// Everything else (names, birth dates, emails, phones, addresses, guardians,
// schools, hometowns, class years) is dropped before anything is stored, and
// a birth date is never read: Sports Thread passes an under-13 flag (L-5).
const ROSTER_COLUMNS = {
  roster_id: ["rosterid", "athleteid", "playerid", "sportsthreadid", "stid", "participantid", "registrationid", "id"],
  team: ["team", "teamname", "teamid", "club"],
  division: ["division", "agedivision", "agegroup", "ageclass", "bracket"],
  jersey: ["jersey", "jerseynumber", "jerseyno", "jerseynum", "number", "num", "no", "uniformnumber", "#"],
  position: ["position", "pos", "primaryposition"],
  under_13: ["under13", "u13", "isunder13", "under13flag"],
  consent_capture: ["capture", "captureconsent", "consentcapture", "permissioncapture"],
  consent_recruiting: ["recruiting", "recruitingdistribution", "consentrecruiting", "permissionrecruiting"],
  consent_marketing: ["marketing", "marketingandsocial", "marketingsocial", "consentmarketing", "permissionmarketing"],
  consent_sale: ["sale", "saleofmedia", "mediasale", "consentsale", "permissionsale"],
  consent_training: ["training", "trainingfootage", "trainingsessionfootage", "consenttraining"],
  consent_3d: ["3d", "3dscope", "3dandaireconstructedmedia", "aireconstructed", "consent3d"],
  consent_nft: ["nft", "narrativenft", "consentnft"],
  consent_feature: ["feature", "featurepermission", "pylonscouting", "pylonscoutingfeature", "consentfeature"],
  consent_commercial: ["commercial", "commerciallicense", "commercialconsent", "consentcommercial"],
  public_display: ["public", "publicdisplay", "showpublicly", "consentpublic"],
  do_not_publish: ["donotpublish", "dnp", "nopublish", "donotpost"],
  low_profile: ["lowprofile", "lowprofilefamily"],
  priority: ["priority", "presold", "playerpackage", "presoldpackage"],
};
const BOOL_TRUE = /^(y|yes|true|t|1|x|✓|✔|checked|on|consented|granted)$/i;
const BOOL_FALSE = /^(n|no|false|f|0|unchecked|off|declined|denied)$/i;
function bool(v) {
  return BOOL_TRUE.test(String(v == null ? "" : v).trim());
}
function triState(v) {
  const s = String(v == null ? "" : v).trim();
  if (BOOL_TRUE.test(s)) return true;
  if (BOOL_FALSE.test(s)) return false;
  return null;
}
function jerseyOf(v) {
  const s = String(v == null ? "" : v).replace(/[#\s]/g, "");
  return /^[0-9]{1,2}$/.test(s) ? s : null;
}
const POSITIONS = { quarterback: "QB", receiver: "WR", widereceiver: "WR", runningback: "RB", tightend: "TE", center: "C", lineman: "OL", offensiveline: "OL", defensiveline: "DL", linebacker: "LB", defensiveback: "DB", cornerback: "CB", corner: "CB", safety: "S", rusher: "R", athlete: "ATH", kicker: "K" };
function positionOf(v) {
  const s = clean(v, 40);
  if (!s) return null;
  if (/^[A-Za-z0-9]{1,6}$/.test(s)) return s.toUpperCase();
  const known = POSITIONS[norm(s)];
  if (known) return known;
  const words = s.split(/[\s/,-]+/).filter(Boolean);
  const initials = words.map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  return initials || null;
}
// L-5: no verified age counts as under 13, and so does a division with any
// standalone number of 12 or less, however it's written: 12U, U12, U-12,
// "Under 12", "12 & Under", "Girls U-10". (A year like 2026 isn't standalone
// 1–2 digits, so it doesn't count.) Mirrors public.gfs_under_13.
const DIVISION_NUMBER = /(?:^|\D)(\d{1,2})(?!\d)/g;
function under13(row) {
  if (!row) return true;
  if (row.under_13 !== false) return true;
  const d = String(row.division || "");
  for (const m of d.matchAll(DIVISION_NUMBER)) if (Number(m[1]) <= 12) return true;
  return false;
}

// ── CSV in (comma or tab) ────────────────────────────────────────────────
function parseTable(text) {
  let s = String(text || "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const first = s.split(/\r?\n/, 1)[0] || "";
  const delim = first.includes("\t") && !first.includes(",") ? "\t" : ",";
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
      continue;
    }
    if (c === '"' && field === "") q = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => String(v).trim() !== ""));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  return { headers: nonEmpty[0].map((h) => String(h).trim()), rows: nonEmpty.slice(1) };
}
// Which header becomes which field. Each field takes the header its alias
// list prefers, not whichever comes first in the file: with both "Registration
// ID" and "Athlete ID", the athlete ID is the roster ID.
function columnMap(headers, spec) {
  const normed = headers.map((h) => (String(h).trim() === "#" ? "#" : norm(h)));
  const map = {};
  const used = new Set();
  for (const [key, names] of Object.entries(spec)) {
    for (const n of names) {
      const i = normed.findIndex((x, j) => x === n && !used.has(j));
      if (i >= 0) {
        map[key] = i;
        used.add(i);
        break;
      }
    }
  }
  const dropped = headers.filter((_h, i) => !used.has(i)).map((h) => clean(h, 40)).filter(Boolean);
  return { map, dropped };
}

const ROSTER_MAX = 5000;
function parseRoster(text) {
  const { headers, rows } = parseTable(text);
  const { map, dropped } = columnMap(headers, ROSTER_COLUMNS);
  const problems = [];
  if (map.roster_id === undefined) problems.push("no_roster_id_column");
  if (map.team === undefined) problems.push("no_team_column");
  const warnings = [];
  if (map.consent_capture === undefined) warnings.push("no_capture_column");
  if (map.under_13 === undefined) warnings.push("no_under_13_column");
  if (map.jersey === undefined) warnings.push("no_jersey_column");
  if (problems.length) return { ok: false, problems, warnings, dropped, rows: [], skipped: [] };
  const out = [];
  const skipped = [];
  const seen = new Set();
  const get = (r, k) => (map[k] === undefined ? "" : r[map[k]]);
  rows.slice(0, ROSTER_MAX).forEach((r, i) => {
    const line = i + 2;
    const rid = clean(get(r, "roster_id"), 64);
    const team = clean(get(r, "team"), 80);
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(rid)) return skipped.push({ line, why: "roster_id" });
    if (!team) return skipped.push({ line, why: "team" });
    if (seen.has(rid)) return skipped.push({ line, why: "duplicate_roster_id" });
    seen.add(rid);
    const row = {
      roster_id: rid,
      team,
      division: clean(get(r, "division"), 24) || null,
      jersey: jerseyOf(get(r, "jersey")),
      position: positionOf(get(r, "position")),
      under_13: map.under_13 === undefined ? null : triState(get(r, "under_13")),
    };
    for (const k of [...Object.keys(CONSENTS), ...Object.keys(FLAGS)]) row[k] = map[k] === undefined ? false : bool(get(r, k));
    out.push(row);
  });
  if (rows.length > ROSTER_MAX) skipped.push({ line: ROSTER_MAX + 2, why: "too_many_rows" });
  return { ok: true, problems, warnings, dropped, rows: out, skipped };
}

// Why a matched clip can't go out. Mirrors public.gfs_hold_reason.
function holdReason(row) {
  if (!row) return null;
  if (row.takedown_at) return "takedown";
  if (row.do_not_publish) return "do_not_publish";
  if (!row.consent_capture) return "no_capture_consent";
  return null;
}
// A clip's hold: the athlete's record first, then "roster_changed" for a clip
// that was out when the roster changed its athlete's number or team (it may
// show someone else, so it stays held until it's taken down and tagged again).
function clipHold(row, retag) {
  return holdReason(row) || (retag ? "roster_changed" : null);
}
// SportsClippers Schedule A: family-only links unless the guardian chose
// public display; never public under 13.
function visibilityFor(row) {
  return row && row.public_display && !under13(row) ? "public" : "family";
}
// A live listing the roster no longer allows: no sale consent means it comes
// down; a public listing that lost public display (or turned out to be under
// 13) goes family-only. Mirrors the pull_reason in public.gfs_clips_gate.
function pullReason(clip, row) {
  if (!clip || !clip.listed_at || clip.removed_at) return null;
  if (!row || !row.consent_sale) return "no_sale_consent";
  if (clip.visibility === "public" && visibilityFor(row) !== "public") return "not_public";
  return null;
}
// Out means a family or SportsClippers has it, and it hasn't been taken down.
function isOut(clip) {
  return !!clip && !!(clip.delivered_at || clip.listed_at) && !clip.removed_at;
}
function featureBlock(row) {
  if (!row) return "not_on_roster";
  return holdReason(row) || (!row.consent_marketing ? "no_marketing_consent" : null);
}

// ── The upload log (GFS storage export) ──────────────────────────────────
// Scout Agreement Schedule B:
//   game files  TEAM-A_vs_TEAM-B_YYYYMMDD_ANGLE.mp4, in the angle's folder
//   clips       Jersey#-Angle-Clip# (11-EndZone-042) in a Jersey# folder;
//               missed or non-graded plays in 00-unassigned
//   second round  Event-Position-Jersey#-Angle-Clip# (Dallas2027-WR-11-EndZone-042)
const UPLOAD_COLUMNS = {
  path: ["path", "file", "filename", "name", "key", "filepath", "object"],
  uploaded_at: ["uploadedat", "uploaded", "uploadtime", "uploadedtime", "createdat", "created", "modified", "lastmodified", "timestamp"],
  creator: ["creator", "creatorcode", "uploader", "uploadedby", "scout", "operator", "by"],
  team: ["team", "teamname"],
  game: ["game", "gamename", "match"],
  final_whistle: ["finalwhistle", "finalwhistleat", "gameend", "gameended", "endedat", "ended"],
  usable: ["usable", "gradeable", "gradable", "ingested"],
};
const ANGLE_ALIASES = { sideline: "Sideline", side: "Sideline", sl: "Sideline", endzone: "EndZone", ez: "EndZone", end: "EndZone", eagleeye: "EagleEye", eagle: "EagleEye", ee: "EagleEye", pressbox: "EagleEye", press: "EagleEye", story: "Story", closeup: "Story" };
function angleOf(s) {
  return ANGLE_ALIASES[norm(s)] || null;
}
const ANGLE_RE = "(Sideline|EndZone|End-Zone|EagleEye|Eagle-Eye|Story|EZ|SL|EE)";
const GAME_FILE = new RegExp(`^(.+?)_vs_(.+?)_(\\d{8})_${ANGLE_RE}$`, "i");
const GAME_DIR = /^(.+?)_vs_(.+?)_(\d{8})$/i;
const CLIP_SCOUT = new RegExp(`^(\\d{1,2})-${ANGLE_RE}-(\\d{1,4})$`, "i");
const CLIP_FINAL = new RegExp(`^([A-Za-z0-9]{2,24})-([A-Za-z0-9]{1,6})-(\\d{1,2})-${ANGLE_RE}-(\\d{1,4})$`, "i");
const CLIP_BARE = new RegExp(`^${ANGLE_RE}-(\\d{1,4})$`, "i");
const SAFE_NAME = /^[A-Za-z0-9._-]{1,120}$/;
// The only folder names kept: a jersey folder (B-5) or 00-unassigned. Any
// other folder could be named for a person, so it isn't stored.
function safeFolder(f) {
  return f && (/^\d{1,2}$/.test(f) || /^00-?unassigned$/i.test(f)) ? f : null;
}

function parseUploadPath(raw, eventCode) {
  const parts = String(raw || "").trim().split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  const file = parts[parts.length - 1];
  if (!SAFE_NAME.test(file)) return { kind: "skip", why: "file_name" };
  const base = file.replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const rawFolder = parts.length > 1 ? parts[parts.length - 2] : null;
  const folder = safeFolder(rawFolder);
  let game = null;
  let teams = null;
  let gameAt = -1;
  parts.slice(0, -1).forEach((p, i) => {
    const g = GAME_DIR.exec(p);
    if (g) { game = p; teams = [g[1], g[2]]; gameAt = i; }
  });
  // B-5 keeps one folder per jersey number per game, which can't tell two
  // teams' #7 apart; a team folder above the jersey folder (or a team column)
  // settles it. This is the raw folder name: teamHintOf keeps it only when it
  // names one of the game's teams or a team on the roster.
  const teamHint = parts.length > 2 && parts.length - 3 > gameAt ? parts[parts.length - 3] : null;
  let m = GAME_FILE.exec(base);
  if (m) {
    const angle = angleOf(m[4]);
    if (!angle) return { kind: "skip", why: "angle" };
    return { kind: "game", file, game: `${m[1]}_vs_${m[2]}_${m[3]}`, teams: [m[1], m[2]], date: m[3], angle };
  }
  const unassigned = !!folder && /^00-?unassigned$/i.test(folder);
  m = CLIP_SCOUT.exec(base);
  if (m) {
    const angle = angleOf(m[2]);
    if (!angle) return { kind: "skip", why: "angle" };
    return { kind: "clip", file, folder, keyFolder: rawFolder, game, teams, teamHint, jersey: unassigned ? null : jerseyOf(m[1]), angle, clip_no: Number(m[3]) };
  }
  m = CLIP_FINAL.exec(base);
  if (m) {
    if (eventCode && m[1].toLowerCase() !== String(eventCode).toLowerCase()) return { kind: "skip", why: "other_event" };
    const angle = angleOf(m[4]);
    if (!angle) return { kind: "skip", why: "angle" };
    return { kind: "clip", file, folder, keyFolder: rawFolder, game, teams, teamHint, jersey: unassigned ? null : jerseyOf(m[3]), angle, clip_no: Number(m[5]) };
  }
  m = CLIP_BARE.exec(base);
  if (m) {
    const angle = angleOf(m[1]);
    if (!angle) return { kind: "skip", why: "angle" };
    return { kind: "clip", file, folder, keyFolder: rawFolder, game, teams, teamHint, jersey: unassigned || !folder ? null : jerseyOf(folder), angle, clip_no: Number(m[2]) };
  }
  return { kind: "skip", why: "not_a_label" };
}

// The team folder, kept only when it names one of the game's teams or a team
// on the roster (rosterTeams: a Set of norm()'d team names). Anything else,
// an angle folder or a folder named for a person, is dropped.
function teamHintOf(clip, rosterTeams) {
  if (!clip || !clip.teamHint) return null;
  const n = norm(clip.teamHint);
  if (!n) return null;
  const inGame = (clip.teams || []).some((t) => norm(t) === n);
  return inGame || (rosterTeams && rosterTeams.has(n)) ? clean(clip.teamHint, 80) : null;
}
// The upload log's team column, kept as given only when it names one of the
// game's teams or a roster team. A team column naming anything else is still
// a team the clip says it belongs to, so it's kept as UNKNOWN_TEAM ("?"): the
// clip won't match until a person looks, and the text itself (which could be
// anything, a name included) isn't stored.
const UNKNOWN_TEAM = "?";
function teamGivenOf(clip, rosterTeams) {
  if (!clip || !clip.team) return null;
  const n = norm(clip.team);
  if (!n) return null;
  const inGame = (clip.teams || []).some((t) => norm(t) === n);
  return inGame || (rosterTeams && rosterTeams.has(n)) ? clean(clip.team, 80) : UNKNOWN_TEAM;
}
const shownTeam = (t) => (t && t !== UNKNOWN_TEAM ? t : null);

// A time from the export: ISO with an offset, or a local "YYYY-MM-DD HH:MM"
// in the event's zone.
function timeOf(v, tz) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    return isNaN(t) ? null : new Date(t).toISOString();
  }
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(s);
  if (m && tz) return zonedToUtc(m[1], `${m[2].padStart(2, "0")}:${m[3]}`, tz).toISOString();
  return null;
}

const UPLOAD_MAX = 10000;
function parseUploads(text, ev) {
  const { headers, rows } = parseTable(text);
  const { map } = columnMap(headers, UPLOAD_COLUMNS);
  if (map.path === undefined) return { ok: false, problems: ["no_path_column"], games: [], clips: [], skipped: [] };
  const get = (r, k) => (map[k] === undefined ? "" : r[map[k]]);
  const games = [];
  const clips = [];
  const skipped = [];
  rows.slice(0, UPLOAD_MAX).forEach((r, i) => {
    const line = i + 2;
    const p = parseUploadPath(get(r, "path"), ev.code);
    if (!p || p.kind === "skip") return skipped.push({ line, why: p ? p.why : "empty" });
    const common = {
      creator: clean(get(r, "creator"), 200) || null,
      uploaded_at: timeOf(get(r, "uploaded_at"), ev.tz),
      team: clean(get(r, "team"), 80) || null,
    };
    if (p.kind === "game") {
      games.push({ ...p, ...common, final_whistle_at: timeOf(get(r, "final_whistle"), ev.tz), usable: map.usable === undefined ? null : triState(get(r, "usable")) });
    } else {
      // A game column counts only when it's a game name (TEAM-A_vs_TEAM-B_DATE).
      const g = clean(get(r, "game"), 160);
      const gm = g ? GAME_DIR.exec(g) : null;
      clips.push({ ...p, ...common, game: p.game || (gm ? g : null), teams: p.teams || (gm ? [gm[1], gm[2]] : null) });
    }
  });
  if (rows.length > UPLOAD_MAX) skipped.push({ line: UPLOAD_MAX + 2, why: "too_many_rows" });
  return { ok: true, problems: [], games, clips, skipped };
}

// Index the roster for jersey matching.
function rosterIndex(rows) {
  const byTeam = new Map();
  for (const r of rows) {
    const t = norm(r.team);
    if (!byTeam.has(t)) byTeam.set(t, new Map());
    if (r.jersey == null) continue;
    const m = byTeam.get(t);
    if (!m.has(r.jersey)) m.set(r.jersey, []);
    m.get(r.jersey).push(r);
  }
  return byTeam;
}
// Match a clip by jersey number against the roster: no face matching
// (C-2 "matched by jersey number to the Pylon roster"). A clip matches only
// when its team is certain:
//   * a team column or a team folder names the team (they must agree), and
//     that team is on the roster;
//   * otherwise its game folder names two teams, and both are on the roster
//     (if one isn't, its #7 could be the kid in the clip);
//   * otherwise the roster has a single team.
// Anything else goes to tag review for a person to decide.
function matchClip(clip, index) {
  if (!index.size) return { match: "unmatched", why: "no_roster" };
  if (clip.jersey == null) return { match: "unmatched", why: "no_number" };
  // Filed in one jersey folder and named for another number: one of them is
  // wrong.
  if (clip.folder && /^\d{1,2}$/.test(clip.folder) && clip.folder !== clip.jersey) return { match: "unmatched", why: "number_conflict" };
  if (clip.team === UNKNOWN_TEAM) return { match: "unmatched", why: "team_not_on_roster" };
  const given = clip.team ? norm(clip.team) : "";
  const hint = clip.teamHint ? norm(clip.teamHint) : "";
  if (given && hint && given !== hint) return { match: "unmatched", why: "team_conflict" };
  let teams;
  if (given || hint) {
    const t = given || hint;
    if (!index.has(t)) return { match: "unmatched", why: "team_not_on_roster" };
    teams = [t];
  } else if (clip.teams && clip.teams.length) {
    teams = [...new Set(clip.teams.map(norm))];
    if (!teams.every((t) => index.has(t))) return { match: "unmatched", why: "team_not_on_roster" };
  } else if (index.size === 1) {
    teams = [...index.keys()];
  } else {
    return { match: "unmatched", why: "no_team" };
  }
  const hits = [];
  for (const t of teams) for (const r of index.get(t).get(clip.jersey) || []) hits.push(r);
  if (!hits.length) return { match: "unmatched", why: "not_on_roster" };
  if (hits.length > 1) return { match: "unmatched", why: new Set(hits.map((h) => norm(h.team))).size > 1 ? "two_teams" : "duplicate_number" };
  return { match: "matched", row: hits[0] };
}
// GFS's second-round label (B-5). Position "NA" when the roster has none.
function finalLabel(ev, row, clip) {
  const n = clip.clip_no == null ? "000" : String(clip.clip_no).padStart(3, "0");
  return `${ev.code}-${row.position || "NA"}-${row.jersey}-${clip.angle || "NA"}-${n}`;
}
// One key per file in the log, hashed so no folder name is stored with it.
function clipKey(eventId, c) {
  const raw = [eventId, norm(c.game || ""), norm(c.team || c.teamHint || ""), String(c.keyFolder || c.folder || "").toLowerCase(), String(c.file).toLowerCase()].join("|");
  return "c" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 40);
}
function uploadKey(eventId, g) {
  return [eventId, norm(g.game), g.angle].join("|");
}
// Jerseys on the clip's team(s) to offer in tag review: a swap of digits or
// one digit off first, then the rest.
function suggestions(clip, rosterRows, max = 3) {
  const given = shownTeam(clip.team);
  const teams = given ? [norm(given)] : clip.teams ? clip.teams.map(norm) : null;
  const pool = rosterRows.filter((r) => r.jersey != null && (!teams || teams.includes(norm(r.team))));
  const j = clip.jersey;
  const score = (r) => {
    if (!j) return 9;
    if (r.jersey === j.split("").reverse().join("")) return 0;
    if (r.jersey.length === j.length && [...r.jersey].filter((c, i) => c !== j[i]).length === 1) return 1;
    if (r.jersey.includes(j) || j.includes(r.jersey)) return 2;
    return 9;
  };
  return pool
    .map((r) => ({ r, s: score(r) }))
    .sort((a, b) => a.s - b.s || Number(a.r.jersey) - Number(b.r.jersey))
    .slice(0, max)
    .map((x) => ({ roster_row: x.r.id, team: x.r.team, jersey: x.r.jersey }));
}

// ── Creators ─────────────────────────────────────────────────────────────
// Scout Agreement §6: a background check and minor-safety training before
// the first Assignment and again each year; contract signed (Playbook step 4).
function credentialProblems(c, ev, role) {
  const out = [];
  if (!c || c.status !== "active") out.push("creator_not_active");
  if (!c) return out;
  if (!c.contract_signed_on) out.push("no_contract");
  const floor = yearBefore(ev.ends_on);
  if (!c.background_check_on || c.background_check_on < floor) out.push("background_check");
  if (!c.safety_training_on || c.safety_training_on < floor) out.push("safety_training");
  // Migration 028: nobody works before their age is checked, and a youth
  // creator needs a guardian of record (public.gfs_crew_age_check).
  if (!c.age_checked_on) out.push("age_not_checked");
  if (c.tier !== "adult" && !c.guardian_email) out.push("youth_no_guardian");
  if (c.tier === "youth" && role && !YOUTH_ROLES.includes(role)) out.push("youth_role");
  return out;
}
function credentialBadges(c, ev) {
  const floor = ev ? yearBefore(ev.ends_on) : yearBefore(new Date().toISOString().slice(0, 10));
  const exp = (d) => (d ? addDays(d, 365) : null);
  return [
    { key: "contract", ok: !!c.contract_signed_on, label: c.contract_signed_on ? "Contract signed" : "No contract" },
    { key: "background", ok: !!c.background_check_on && c.background_check_on >= floor, label: !c.background_check_on ? "No background check" : c.background_check_on >= floor ? "Background check" : "Background check expired", until: exp(c.background_check_on) },
    { key: "training", ok: !!c.safety_training_on && c.safety_training_on >= floor, label: !c.safety_training_on ? "No safety training" : c.safety_training_on >= floor ? "Safety trained" : "Training expired", until: exp(c.safety_training_on) },
    { key: "age", ok: !!c.age_checked_on, label: !c.age_checked_on ? "Age not checked" : c.tier === "adult" ? "Adult · age checked" : "Youth · age checked" },
    ...(c.tier !== "adult" ? [{ key: "guardian", ok: !!c.guardian_email, label: c.guardian_email ? "Guardian on file" : "No guardian on file" }] : []),
    ...(c.tier === "youth" ? [{ key: "youth", ok: true, label: `Youth · shadowed ${c.shadow_events || 0}` }] : []),
  ];
}

// Screening on file (dates or an age check): from then on, who the record
// belongs to (name, email, guardian) and whether it's active are the owner's
// to change.
function screeningOnFile(c) {
  return !!(c && (c.contract_signed_on || c.background_check_on || c.safety_training_on || c.age_checked_on));
}

// Creator Playbook v1.5: a youth creator works only alongside a confirmed,
// screened adult on site (lead, shooter, photographer or story camera).
// Mirrors public.gfs_crew_check, which also locks the event so two changes
// can't race past it.
function isAnchor(row, creators, ev) {
  const c = row && creators.get(row.creator_id);
  return !!c && row.status === "confirmed" && ADULT_ON_SITE.includes(row.role) && c.tier === "adult" && !credentialProblems(c, ev, row.role).length;
}
const isYouth = (row, creators) => ((creators.get(row.creator_id) || {}).tier || "adult") === "youth";
// A confirmed youth creator with no screened adult on site (screening that
// lapsed, or a creator paused since, leaves them alone too).
function youthAlone(crew, creators, ev) {
  return crew.some((x) => x.status === "confirmed" && isYouth(x, creators)) && !crew.some((x) => isAnchor(x, creators, ev));
}
// What a crew change would break: next is the row as it would be.
function crewProblem(crew, creators, ev, next) {
  const prev = next.id ? crew.find((x) => x.id === next.id) || null : null;
  const others = crew.filter((x) => x.id !== next.id);
  const othersAnchor = others.some((x) => isAnchor(x, creators, ev));
  if (isYouth(next, creators) && next.status === "confirmed" && (!prev || prev.status !== "confirmed") && !othersAnchor) return "crew_youth_needs_adult";
  if (prev && isAnchor(prev, creators, ev) && !isAnchor(next, creators, ev) && !othersAnchor && others.some((x) => x.status === "confirmed" && isYouth(x, creators))) return "crew_youth_left_alone";
  return null;
}

// The four measures for one creator, from game uploads and family ratings.
// A game counts on time when every file the creator uploaded for it landed
// within 12 hours of the final whistle (games without both times are left
// out); angles hit when the game has two or more wide angles from the crew
// (gameAngles, when given, holds every creator's angles per game); usable
// when every reviewed file of theirs was usable (unreviewed games left out).
const gameKey = (u) => `${u.event_id}|${norm(u.game)}`;
function angleMap(uploads) {
  const m = new Map();
  for (const u of uploads) {
    if (!WIDE.includes(u.angle)) continue;
    const k = gameKey(u);
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(u.angle);
  }
  return m;
}
function scorecard(uploads, ratings, gameAngles) {
  const games = new Map();
  for (const u of uploads) {
    const k = gameKey(u);
    if (!games.has(k)) games.set(k, []);
    games.get(k).push(u);
  }
  const angles = gameAngles || angleMap(uploads);
  let timed = 0, onTime = 0, hit = 0, reviewed = 0, usable = 0;
  for (const [k, list] of games) {
    if (list.every((u) => u.final_whistle_at && u.uploaded_at)) {
      timed++;
      if (list.every((u) => new Date(u.uploaded_at) - new Date(u.final_whistle_at) <= UPLOAD_HOURS * 3600000)) onTime++;
    }
    if ((angles.get(k) || new Set()).size >= 2) hit++;
    const r = list.filter((u) => u.usable !== null && u.usable !== undefined);
    if (r.length) {
      reviewed++;
      if (r.every((u) => u.usable === true)) usable++;
    }
  }
  let rSum = 0, rCount = 0;
  for (const x of ratings || []) {
    if (x.family_rating == null) continue;
    const n = Math.max(1, Number(x.rating_count) || 1);
    rSum += Number(x.family_rating) * n;
    rCount += n;
  }
  const out = {
    games: games.size,
    on_time: timed ? onTime / timed : null,
    angles_hit: games.size ? hit / games.size : null,
    usable: reviewed ? usable / reviewed : null,
    rating: rCount ? Math.round((rSum / rCount) * 10) / 10 : null,
    ratings: rCount,
  };
  const checks = [["on_time", out.on_time], ["angles_hit", out.angles_hit], ["usable", out.usable], ["rating", out.rating]].filter(([, v]) => v !== null);
  out.below = checks.filter(([k, v]) => v < STANDARD[k]).map(([k]) => k);
  out.on_standard = out.games > 0 && !out.below.length;
  return out;
}

// Calendar quarter (the Scout Agreement measures by quarter).
function quarterOf(d = new Date()) {
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3);
  const start = new Date(Date.UTC(y, q * 3, 1));
  const end = new Date(Date.UTC(y, q * 3 + 3, 1));
  return { label: `Q${q + 1} ${y}`, from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

// ── Takedowns ────────────────────────────────────────────────────────────
function takedownDue(reason, receivedAt) {
  const w = TAKEDOWN[reason];
  return { pylon_due_at: hoursAfter(receivedAt, w.pylon), other_due_at: hoursAfter(receivedAt, w.other), offsite_due_at: hoursAfter(receivedAt, w.offsite) };
}

// ── The upload check ─────────────────────────────────────────────────────
// What the upload log says about capture, game by game: the two wide angles
// the standard asks for (Sideline and End Zone, or any two wide ones, as the
// scorecard counts them), files that landed more than 12 hours after their
// final whistle, games with no whistle logged, and files marked unusable.
// uploads: gfs_uploads rows for one event (game files).
function uploadCheck(uploads) {
  const games = new Map();
  for (const u of uploads || []) {
    const k = norm(u.game);
    if (!games.has(k)) games.set(k, { game: u.game, angles: new Set(), files: 0, late: 0, worst: 0, unwhistled: 0, unusable: 0 });
    const g = games.get(k);
    g.files++;
    if (WIDE.includes(u.angle)) g.angles.add(u.angle);
    if (!u.final_whistle_at) g.unwhistled++;
    else if (u.uploaded_at) {
      const over = (Date.parse(u.uploaded_at) - Date.parse(u.final_whistle_at)) / 3600000 - UPLOAD_HOURS;
      if (over > 0) {
        g.late++;
        g.worst = Math.max(g.worst, over);
      }
    }
    if (u.usable === false) g.unusable++;
  }
  const list = [...games.values()]
    .map((g) => ({
      game: g.game,
      angles: [...g.angles].sort(),
      missing: g.angles.size >= 2 ? [] : ["Sideline", "EndZone"].filter((a) => !g.angles.has(a)),
      files: g.files,
      late: g.late,
      hours_late: Math.round(g.worst * 10) / 10,
      files_no_whistle: g.unwhistled,
      unusable: g.unusable,
    }))
    .sort((a, b) => a.game.localeCompare(b.game));
  return {
    games: list.length,
    missing_angle: list.filter((g) => g.missing.length).length,
    late_files: list.reduce((s, g) => s + g.late, 0),
    late_games: list.filter((g) => g.late).length,
    hours_late: list.reduce((m, g) => Math.max(m, g.hours_late), 0),
    no_whistle: list.filter((g) => g.files_no_whistle).length,
    unusable: list.reduce((s, g) => s + g.unusable, 0),
    issues: list.filter((g) => g.missing.length || g.late || g.files_no_whistle || g.unusable),
  };
}

// ── The run sheet (docs/gfs-workflow-sop.md) ─────────────────────────────
// Twelve stages every stop runs, each with one deadline, one owner and one
// test for done. Before the event a deadline counts back from the first
// day's start; after it, from the wrap on the last day, in the stop's zone.
// A stage is "soon" from a week before its deadline (after-event stages only
// once the stop has wrapped) and "late" past it, until it's done. Capture and
// the Schedule C pieces are measured here but worked elsewhere (the upload
// check, and Deliver's own queue), so they never go to "Needs you".
// Staffing, screening, the crew and the brief can't be done once the stop
// has started: undone then, they're "missed", shown on the plan, not nagged.
// The roster and the storefront are still needed after it, for tags and sales.
const RUN_SHEET = Object.freeze([
  { key: "staff", label: "Staff the stop", owner: "director", who: "Director", from: "start", days: -45, when: "T-45 days", closes: true },
  { key: "screened", label: "Screening complete", owner: "owner", who: "Kyron", from: "start", days: -21, when: "T-21 days", closes: true },
  { key: "crew", label: "Crew confirmed", owner: "director", who: "Director", from: "start", days: -14, when: "T-14 days", closes: true },
  { key: "storefront", label: "QR codes and storefront", owner: "director", who: "Director, approver", from: "start", days: -7, when: "T-7 days" },
  { key: "roster", label: "Roster and consent", owner: "director", who: "Director", from: "start", hours: -72, when: "T-72 hours" },
  { key: "brief", label: "Crew brief sent", owner: "director", who: "Director", from: "start", hours: -48, when: "T-48 hours", closes: true },
  { key: "capture", label: "Capture", owner: "lead", who: "Crew lead", from: "wrap", hours: 0, when: "Event day", actionable: false },
  { key: "uploads", label: "Footage uploaded", owner: "director", who: "Crew, director", from: "wrap", hours: 12, when: "T+12 hours" },
  { key: "tags", label: "Tag review done", owner: "director", who: "Director", from: "wrap", hours: 24, when: "T+24 hours" },
  { key: "sale", label: "On sale and sent", owner: "approver", who: "Approver, director", from: "wrap", hours: 48, when: "T+48 hours" },
  { key: "deliverables", label: "Pylon deliverables", owner: "approver", who: "Approver", from: "wrap", hours: null, when: "Schedule C dates", actionable: false },
  { key: "review", label: "Stop review", owner: "owner", who: "Kyron", from: "wrap", days: 14, when: "T+14 days" },
]);
const SOON_MS = 7 * 86400000;
// "T-n days" is local midnight n calendar days before the first day, and
// "T+n days" the wrap time n days after the last, so a deadline lands on the
// same local date across a daylight-saving change. Hours are plain hours.
function daysBeforeStart(ev, n) {
  return zonedToUtc(addDays(ev.starts_on, -n), "00:00", ev.tz).getTime();
}
function daysAfterWrap(ev, n) {
  return zonedToUtc(addDays(ev.ends_on, n), String(ev.wraps_at || "18:00").slice(0, 5), ev.tz).getTime();
}
// ctx: checklist (the four pre-event checks), crew rows, creators (Map of id
// → row), counts (the clip pipeline), uploads (gfs_uploads rows) or an
// uploadCheck, deliverables (their views: required, cleared, due_at).
function runSheet(ev, ctx = {}, nowMs = Date.now()) {
  const startMs = zonedToUtc(ev.starts_on, "00:00", ev.tz).getTime();
  const wrapMs = Date.parse(ev.ends_at || endsAt(ev));
  const check = (k) => (ctx.checklist || []).find((c) => c.key === k) || {};
  const creators = ctx.creators || new Map();
  const active = (ctx.crew || []).filter((c) => c.status === "invited" || c.status === "confirmed");
  const onSite = active.filter((c) => ON_SITE.includes(c.role)).length;
  const target = Number(ev.crew_target) || 0;
  const lead = active.some((c) => c.role === "lead");
  const unscreened = active.filter((c) => credentialProblems(creators.get(c.creator_id), ev, c.role).length).length;
  const up = ctx.uploadCheck || uploadCheck(ctx.uploads || []);
  const n = (k) => Number((ctx.counts || {})[k]) || 0;
  const toEdit = Math.max(0, n("tagged") - n("edited"));
  const toApprove = Math.max(0, n("edited") - n("approved"));
  // Approved, not held, not taken down, and neither listed nor sent: the
  // count migration 029 adds (absent before it, when this check is skipped).
  const notOut = n("not_out");
  const toMark = n("to_list") + n("to_send");
  const owed = (ctx.deliverables || []).filter((d) => d.required > 0);
  const cleared = owed.filter((d) => d.cleared).length;
  const reviewTracked = Object.prototype.hasOwnProperty.call(ev, "reviewed_at");
  const some = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  const facts = {
    staff: { done: onSite >= target && (lead || target === 0), note: [`${onSite} of ${target} on site`, target && !lead ? "no lead yet" : null] },
    screened: { done: onSite >= target && !unscreened, note: [unscreened ? `${some(unscreened, "creator", "creators")} not screened for this stop` : null, onSite < target ? "crew not at target" : null] },
    crew: { done: !!check("crew").done, note: [check("crew").label ? String(check("crew").label).replace(/^Crew /, "") : null] },
    storefront: { done: !!check("storefront").done, note: [ev.sportsclippers_url ? null : "no SportsClippers page saved"] },
    roster: { done: !!check("roster").done, note: [] },
    brief: { done: !!check("brief").done, note: [] },
    capture: { done: up.games > 0 && !up.missing_angle, note: [up.games ? `${some(up.games, "game", "games")} logged` : "no game files logged yet", up.missing_angle ? `${up.missing_angle} missing an angle` : null] },
    uploads: { done: up.games > 0 || n("shot") > 0, note: [up.late_files ? `${some(up.late_files, "file", "files")} over 12 hours` : null, up.no_whistle ? `${some(up.no_whistle, "game", "games")} without a final whistle` : null] },
    tags: { done: n("shot") > 0 && !!ev.tags_approved_at && n("unmatched") === 0, note: [n("unmatched") ? `${n("unmatched")} to review` : null, n("shot") && !ev.tags_approved_at ? "tags not approved yet" : null] },
    sale: { done: n("approved") > 0 && !toEdit && !toApprove && !notOut && !toMark, note: [toEdit ? `${toEdit} to edit` : null, toApprove ? `${toApprove} to approve` : null, notOut ? `${notOut} approved, not out yet` : null, toMark ? `${toMark} to mark listed or sent` : null, n("listed") ? `${n("listed")} listed` : null] },
    deliverables: { done: cleared === owed.length, note: [owed.length ? `${cleared} of ${owed.length} cleared` : "nothing owed"] },
    review: { done: !!ev.reviewed_at, note: [reviewTracked ? null : "starts with migration 029"] },
  };
  return RUN_SHEET.map((s) => {
    const f = facts[s.key];
    const dueMs =
      s.hours === null ? (owed.length ? Math.max(...owed.map((d) => Date.parse(d.due_at))) : wrapMs)
      : s.days !== undefined ? (s.from === "start" ? daysBeforeStart(ev, -s.days) : daysAfterWrap(ev, s.days))
      : (s.from === "start" ? startMs : wrapMs) + s.hours * 3600000;
    const done = !!f.done;
    const open = s.from === "start" || nowMs >= wrapMs;
    const status = done ? "done" : s.closes && nowMs >= startMs ? "missed" : !open ? "upcoming" : nowMs > dueMs ? "late" : nowMs >= dueMs - SOON_MS ? "soon" : "upcoming";
    return {
      key: s.key,
      label: s.label,
      when: s.when,
      from: s.from,
      owner: s.owner,
      who: s.who,
      due_at: new Date(dueMs).toISOString(),
      done,
      status,
      note: f.note.filter(Boolean).join(" · ") || null,
      actionable: s.actionable !== false && (s.key !== "review" || reviewTracked),
    };
  });
}
// Whose "Needs you" a stage belongs in. The owner sees every stage; an
// approver, theirs and the storefront; a director, theirs and getting clips
// out (family links are theirs), for stops they direct or nobody does yet.
function stageIsMine(stage, access, ev, email) {
  if (!access || !stage.actionable) return false;
  if (access.owner) return true;
  if (access.role === "approver") return stage.owner === "approver" || stage.key === "storefront";
  if (access.role === "member") return (stage.owner === "director" || stage.key === "sale") && (!ev.director_email || ev.director_email === email);
  return false;
}

// ── The crew brief ───────────────────────────────────────────────────────
// Built from the stop's own data: when and where, the crew, the teams by
// their roster names, the pre-sold athletes to cover first and the ones no
// clip may feature (team and jersey only, never a name or a reason), the
// capture, naming and upload standards, and where help goes. Plain text, so
// it pastes into any email or message.
// info: { crew: [{ name, role_name, status, youth }], director: { name,
// email } | null, roster: rows, help: { email, phone, page } }
function briefDate(d) {
  return new Date(String(d).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function briefTime(hhmm) {
  const [h, m] = String(hhmm || "18:00").slice(0, 5).split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function zoneName(tz, dateStr) {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(String(dateStr).slice(0, 10) + "T18:00:00Z")).find((p) => p.type === "timeZoneName");
    return part ? part.value : tz;
  } catch (e) {
    return tz;
  }
}
function byTeam(rows) {
  const teams = new Map();
  for (const r of rows) {
    if (!teams.has(r.team)) teams.set(r.team, []);
    teams.get(r.team).push(r);
  }
  return [...teams.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([team, list]) => {
      const nums = list.filter((r) => r.jersey != null).sort((a, b) => Number(a.jersey) - Number(b.jersey)).map((r) => `#${r.jersey}${r.position ? " " + r.position : ""}`);
      const none = list.filter((r) => r.jersey == null).length;
      return `- ${team}: ${[...nums, none ? `${none} with no number on the roster` : null].filter(Boolean).join(", ")}`;
    });
}
function crewBrief(ev, info = {}) {
  const roster = info.roster || [];
  const teams = [...new Set(roster.map((r) => r.team))].sort((a, b) => a.localeCompare(b));
  const priority = roster.filter((r) => r.priority && !holdReason(r));
  const holds = roster.filter((r) => holdReason(r));
  const crew = (info.crew || []).filter((c) => c.status === "invited" || c.status === "confirmed");
  const help = info.help || {};
  const when = ev.starts_on === ev.ends_on ? briefDate(ev.starts_on) : `${briefDate(ev.starts_on)} to ${briefDate(ev.ends_on)}`;
  const place = [ev.venue, [ev.city, ev.state].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  const lines = [];
  const section = (title, body) => {
    if (!body.length) return;
    lines.push("", title.toUpperCase(), ...body);
  };
  lines.push(`CREW BRIEF · ${ev.name}`, `${when} · wraps ${briefTime(ev.wraps_at)} ${zoneName(ev.tz, ev.ends_on)} · ${place || "venue to come"}`);
  section("Crew", [
    ...crew.map((c) => `- ${c.name} · ${c.role_name}${c.youth ? " (youth creator)" : ""}${c.status === "invited" ? " · not confirmed yet" : ""}`),
    ...(crew.length ? [] : ["- Nobody is on the crew yet."]),
    ...(info.director ? [`Director: ${[info.director.name, info.director.email].filter(Boolean).join(" · ")}`] : []),
  ]);
  section("Cover first: pre-sold athletes, by team and jersey", priority.length ? [...byTeam(priority), "Get them clips in every game they play."] : []);
  section("No clips of these athletes (team and jersey only)", holds.length ? [...byTeam(holds), "Film the game as usual, but cut no clip that features them."] : []);
  section("Capture", [
    "- Two angles every game: Sideline and End Zone, plus Eagle Eye where the venue allows. One angle and the game isn't covered.",
    "- Full games at 1080p60.",
    "- A youth creator shoots beside a confirmed, screened adult, never alone with a minor, and never sells to or messages a family.",
  ]);
  section("Naming (Schedule B)", [
    `- Game folder: TEAM-A_vs_TEAM-B_YYYYMMDD, with the roster's team names exactly${teams.length ? ": " + teams.join(", ") : ""}.`,
    "- A team folder above each jersey folder. Clips are named Jersey#-Angle-Clip#, for example 11-EndZone-042.",
    "- Can't place a clip? Put it in 00-unassigned.",
  ]);
  section("Uploads", [
    "- At midday, upload the morning's games and check that both angles arrived.",
    "- Upload every file within 12 hours of its game's final whistle, and note each final whistle.",
  ]);
  section("Help", [
    ...(help.page ? [`- Families find their footage at ${help.page} (the QR codes open it).`] : []),
    `- Questions, help and takedown requests go to ${help.email || "Ground Floor Sports"}${help.phone ? ", or text " + help.phone : ""}. Don't promise a family anything on site.`,
  ]);
  return { text: lines.join("\n") + "\n", counts: { crew: crew.length, teams: teams.length, priority: priority.length, holds: holds.length } };
}

// ── CSV out ──────────────────────────────────────────────────────────────
// Quote when needed, and keep a spreadsheet from reading a cell as a formula.
function cell(v) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(columns, rows) {
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

module.exports = {
  REGIONS,
  SIZES,
  STATUSES,
  CREW_TARGET,
  CREW_ROLES,
  ON_SITE,
  YOUTH_ROLES,
  ADULT_ON_SITE,
  ANGLES,
  WIDE,
  CONSENTS,
  FLAGS,
  STANDARD,
  UPLOAD_HOURS,
  TAKEDOWN,
  DELIVERABLES,
  DELIVERABLE_KINDS,
  STATE_TZ,
  clean,
  norm,
  code,
  isDate,
  isTime,
  validTz,
  zonedToUtc,
  addDays,
  daysBetween,
  yearBefore,
  hoursAfter,
  seesAll,
  regionsOf,
  canSee,
  validRegions,
  endsAt,
  eventDays,
  eventCode,
  deliverablesFor,
  deliverableInfo,
  parseTable,
  columnMap,
  ROSTER_COLUMNS,
  parseRoster,
  bool,
  triState,
  jerseyOf,
  positionOf,
  under13,
  holdReason,
  clipHold,
  visibilityFor,
  pullReason,
  isOut,
  featureBlock,
  safeFolder,
  parseUploadPath,
  teamHintOf,
  UNKNOWN_TEAM,
  teamGivenOf,
  shownTeam,
  parseUploads,
  timeOf,
  rosterIndex,
  matchClip,
  finalLabel,
  clipKey,
  uploadKey,
  suggestions,
  credentialProblems,
  credentialBadges,
  screeningOnFile,
  isAnchor,
  youthAlone,
  crewProblem,
  angleMap,
  scorecard,
  quarterOf,
  takedownDue,
  daysBeforeStart,
  uploadCheck,
  RUN_SHEET,
  runSheet,
  stageIsMine,
  crewBrief,
  cell,
  toCsv,
};
