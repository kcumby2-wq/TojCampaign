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
// L-5: no verified age, or a 10U/12U division, counts as under 13. Mirrors
// public.gfs_under_13 (same two patterns, tried in the same order).
function under13(row) {
  if (!row) return true;
  if (row.under_13 !== false) return true;
  const d = String(row.division || "").toUpperCase();
  const m = /(\d{1,2}) ?U/.exec(d) || /U ?(\d{1,2})/.exec(d);
  return !!m && Number(m[1]) <= 12;
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
function columnMap(headers, spec) {
  const map = {};
  const used = new Set();
  headers.forEach((h, i) => {
    const n = h.trim() === "#" ? "#" : norm(h);
    for (const [key, names] of Object.entries(spec)) {
      if (map[key] === undefined && names.includes(n)) {
        map[key] = i;
        used.add(i);
        break;
      }
    }
  });
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
// SportsClippers Schedule A: family-only links unless the guardian chose
// public display; never public under 13.
function visibilityFor(row) {
  return row && row.public_display && !under13(row) ? "public" : "family";
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

function parseUploadPath(raw, eventCode) {
  const parts = String(raw || "").trim().split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  const file = parts[parts.length - 1];
  if (!SAFE_NAME.test(file)) return { kind: "skip", why: "file_name" };
  const base = file.replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const folder = parts.length > 1 ? parts[parts.length - 2] : null;
  let game = null;
  let teams = null;
  let gameAt = -1;
  parts.slice(0, -1).forEach((p, i) => {
    const g = GAME_DIR.exec(p);
    if (g) { game = p; teams = [g[1], g[2]]; gameAt = i; }
  });
  // B-5 keeps one folder per jersey number per game, which can't tell two
  // teams' #7 apart; a team folder above the jersey folder (or a team column)
  // settles it. It's a hint: used only when it names a team on the roster.
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
    return { kind: "clip", file, folder, game, teams, teamHint, jersey: unassigned ? null : jerseyOf(m[1]), angle, clip_no: Number(m[3]) };
  }
  m = CLIP_FINAL.exec(base);
  if (m) {
    if (eventCode && m[1].toLowerCase() !== String(eventCode).toLowerCase()) return { kind: "skip", why: "other_event" };
    const angle = angleOf(m[4]);
    if (!angle) return { kind: "skip", why: "angle" };
    return { kind: "clip", file, folder, game, teams, teamHint, jersey: unassigned ? null : jerseyOf(m[3]), angle, clip_no: Number(m[5]) };
  }
  m = CLIP_BARE.exec(base);
  if (m) {
    const angle = angleOf(m[1]);
    if (!angle) return { kind: "skip", why: "angle" };
    return { kind: "clip", file, folder, game, teams, teamHint, jersey: unassigned || !folder ? null : jerseyOf(folder), angle, clip_no: Number(m[2]) };
  }
  return { kind: "skip", why: "not_a_label" };
}

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
      const g = clean(get(r, "game"), 160);
      const gm = g ? GAME_DIR.exec(g) : null;
      clips.push({ ...p, ...common, game: p.game || (gm ? g : g || null), teams: p.teams || (gm ? [gm[1], gm[2]] : null) });
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
// (C-2 "matched by jersey number to the Pylon roster").
function matchClip(clip, index) {
  if (!index.size) return { match: "unmatched", why: "no_roster" };
  if (clip.jersey == null) return { match: "unmatched", why: "no_number" };
  let teams;
  const hint = clip.teamHint ? norm(clip.teamHint) : null;
  if (!clip.team && hint && index.has(hint)) {
    teams = [hint];
  } else if (clip.team) {
    teams = [norm(clip.team)];
    if (!index.has(teams[0])) return { match: "unmatched", why: "team_not_on_roster" };
  } else if (clip.teams) {
    teams = clip.teams.map(norm).filter((t) => index.has(t));
    if (!teams.length) teams = [...index.keys()];
  } else teams = [...index.keys()];
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
function clipKey(eventId, c) {
  return [eventId, norm(c.game || ""), norm(c.team || c.teamHint || ""), String(c.folder || "").toLowerCase(), String(c.file).toLowerCase()].join("|");
}
function uploadKey(eventId, g) {
  return [eventId, norm(g.game), g.angle].join("|");
}
// Jerseys on the clip's team(s) to offer in tag review: a swap of digits or
// one digit off first, then the rest.
function suggestions(clip, rosterRows, max = 3) {
  const teams = clip.team ? [norm(clip.team)] : clip.teams ? clip.teams.map(norm) : null;
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
    ...(c.tier === "youth" ? [{ key: "youth", ok: true, label: `Youth · shadowed ${c.shadow_events || 0}` }] : []),
  ];
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
  ROSTER_COLUMNS,
  parseRoster,
  bool,
  triState,
  jerseyOf,
  positionOf,
  under13,
  holdReason,
  visibilityFor,
  featureBlock,
  parseUploadPath,
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
  angleMap,
  scorecard,
  quarterOf,
  takedownDue,
  cell,
  toCsv,
};
