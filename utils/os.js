// The Operating System builder — the trail, the doors, the five pillars, the
// transcript's sections, the systems we install, and the operating brain.
//
// The order follows the site and its launch video:
//   pick the door → Foundation Score intake → five pillars scored →
//   Operational Transcript → Intake / Delivery / Follow-up installed →
//   running on the Trail of Joy.

"use strict";

const VERTICALS = Object.freeze({
  "personal-brand": { label: "Personal Brand", color: "#A85F26", for: "Trainers · Creators · Solo operators" },
  nonprofit: { label: "Non-profit", color: "#2F5D4E", for: "Youth programs · Sports orgs · Community events" },
  authority: { label: "Authority", color: "#1E3A5F", for: "Youth programs · Individual athletes · Creators" },
});

// The trail. `node` is the stage's place on the site's dotted trail.
const STAGES = Object.freeze([
  { key: "raw", n: 1, name: "Raw operation", what: "Pick the door", node: "Raw operation" },
  { key: "intake", n: 2, name: "Foundation Score", what: "The intake", node: "Foundation Score" },
  { key: "standard", n: 3, name: "The Standard", what: "Five pillars scored", node: "The Standard" },
  { key: "transcript", n: 4, name: "Operational Transcript", what: "The written report", node: "The Standard" },
  { key: "systemized", n: 5, name: "Systemized", what: "Intake, Delivery, Follow-up installed", node: "Systemized" },
  { key: "running", n: 6, name: "Trail of Joy", what: "Running, handed off", node: "Trail of Joy" },
]);
const STAGE_RANK = Object.freeze(Object.fromEntries(STAGES.map((s, i) => [s.key, i])));

const PILLARS = Object.freeze(["brand_identity", "operational_health", "revenue_architecture", "content_credibility", "growth_readiness"]);
const PILLAR_NAMES = Object.freeze({
  brand_identity: "Brand Identity",
  operational_health: "Operational Health",
  revenue_architecture: "Revenue Architecture",
  content_credibility: "Content & Credibility",
  growth_readiness: "Growth Readiness",
});
const PILLAR_SHORT = Object.freeze({ brand_identity: "Brand", operational_health: "Operations", revenue_architecture: "Revenue", content_credibility: "Credibility", growth_readiness: "Growth" });
// The intake pages name a pillar differently per lane (the pillars don't change).
const LANE_PILLAR = Object.freeze({
  nonprofit: { revenue_architecture: "Funding Architecture" },
  authority: { brand_identity: "Athlete Brand Identity" },
});
function pillarName(vertical, key) {
  return (LANE_PILLAR[vertical] && LANE_PILLAR[vertical][key]) || PILLAR_NAMES[key];
}

// agents/skills/five-pillars.md
const BANDS = Object.freeze([
  { min: 90, name: "Advantage", note: "a defensible advantage" },
  { min: 70, name: "Solid", note: "solid, minor gaps" },
  { min: 40, name: "Underperforming", note: "exists but underperforming" },
  { min: 0, name: "Broken or missing", note: "broken or doesn't exist" },
]);
function band(score) {
  const s = Number(score);
  return BANDS.find((b) => s >= b.min) || BANDS[BANDS.length - 1];
}
const EVIDENCE_CAP = 40; // no pillar above 40 without concrete evidence

// The transcript's seven sections, named per lane (from the public samples).
const SECTIONS = Object.freeze({
  "personal-brand": ["Executive summary", "Five-pillar radar", "Service-line health", "Revenue recovery opportunities", "Roster / portfolio", "Path forward", "Ranked action plan"],
  nonprofit: ["Executive summary", "Five-pillar radar", "Program-line health", "Funding architecture", "Participants & community reach", "Path forward", "Ranked action plan"],
  authority: ["Executive summary", "Five-pillar radar", "Portfolio numbers", "Documentation gap analysis", "Recruiting-cycle standing", "Path forward", "Ranked action plan"],
});
const LINE_COLUMNS = Object.freeze({
  "personal-brand": ["Service line", "Volume", "Standing"],
  nonprofit: ["Program", "Reach", "Standing"],
  authority: ["Measure", "Number", "Standing"],
});
const OWNERS = Object.freeze(["Client", "System", "TOJ"]);
const EASE = Object.freeze(["Easy", "Medium", "Hard"]);

// The Foundation Score intake questions, labelled as the site asks them.
const INTAKE_LABELS = Object.freeze({
  brand_name: "Name",
  business_name: "Business / organization / program",
  role: "Role",
  years_operating: "Years operating",
  year_founded: "Year founded",
  delivery_format: "Delivery format",
  what_you_do: "What they do",
  markets: "Markets",
  city: "City",
  state: "State",
  location: "Home base",
  reach: "Serving reach",
  ig: "Instagram",
  website: "Website",
  voice: "Brand voice today",
  mission_statement: "Mission",
  current_customers: "Active clients now",
  target_customers: "Target clients in 12 months",
  ttm_revenue: "Trailing 12-month revenue",
  revenue_goal: "Revenue goal, 12 months",
  current_revenue: "Current annual revenue",
  target_revenue: "Revenue target, 12 months",
  annual_budget: "Annual budget",
  funding_mix: "Funding mix",
  staff_fte: "Staff (FTE)",
  board_size: "Board size",
  num_programs: "Active programs",
  participants: "Participants a year",
  sport_position: "Sport / position",
  p_years: "Years coaching / playing",
  p_athletes_total: "Athletes worked with",
  p_active: "Active athletes",
  p_hs_aa: "High school All-Americans",
  p_college_aa: "College All-Americans",
  p_d1: "D1 athletes",
  p_pros: "Pros",
  p_stars: "Rated recruits",
  p_recognitions: "Recognitions",
  named_athletes: "Named athletes / results",
  playing_bg: "Background",
  methodology: "Signature methodology",
  media: "Media and partnerships",
  revenue_streams: "Revenue streams",
  archetype: "Archetype",
  modules: "Modules wanted",
  team: "Team",
  community_interest: "Community-building interest",
  licensing_interest: "Licensing interest",
  pipeline_interest: "Recruiting-pipeline interest",
  year_3_vision: "Year 3 vision",
  known_for: "Wants to be known for",
  timeline: "Timeline",
  biggest_goal: "Biggest goal",
  board_expectations: "Board expectations",
  success_vision: "Success in 12 months",
  blockers: "What's in the way",
  have: "Already has",
  pillars: "Pillars they want emphasized",
  photo_readiness: "Photo readiness",
  video_readiness: "Video readiness",
  testimonial_readiness: "Testimonial readiness",
  ready_photos: "Athlete photos",
  ready_video: "Video / film",
  ready_testimonials: "Testimonials",
  donor_data: "Donor data readiness",
  outcomes_readiness: "Outcomes readiness",
  financial_reporting: "Financial reporting readiness",
  governance_notes: "Governance notes",
  core_budget: "Core budget",
  ops_budget: "Monthly ops budget",
  custom_features: "Custom features",
  notes: "Notes",
  contact_email: "Email",
  contact_phone: "Phone",
  ein: "EIN",
});
// Never sent to the model, never in the brain or the transcript.
const PRIVATE_KEYS = Object.freeze(["contact_email", "contact_phone", "ein"]);
// Can name minors: withheld from the model, the brain and the transcript.
const MINOR_KEYS = Object.freeze(["named_athletes"]);

// The short in-app intake when there's no Foundation Score submission.
const APP_INTAKE = Object.freeze({
  "personal-brand": ["brand_name", "business_name", "what_you_do", "city", "state", "years_operating", "current_customers", "ttm_revenue", "revenue_goal", "biggest_goal", "blockers", "voice", "testimonial_readiness", "notes"],
  nonprofit: ["brand_name", "role", "business_name", "mission_statement", "city", "state", "staff_fte", "annual_budget", "num_programs", "participants", "biggest_goal", "blockers", "donor_data", "notes"],
  authority: ["brand_name", "business_name", "sport_position", "location", "playing_bg", "methodology", "current_revenue", "target_revenue", "year_3_vision", "known_for", "ready_testimonials", "notes"],
});

// What gets installed. "We install the intake, delivery, and follow-up systems
// your business runs on."
const SYSTEM_GROUPS = Object.freeze([
  { key: "intake", name: "Intake" },
  { key: "delivery", name: "Delivery" },
  { key: "follow_up", name: "Follow-up" },
]);
const SYSTEM_STATUS = Object.freeze(["todo", "building", "live"]);
const DEFAULT_SYSTEMS = Object.freeze({
  "personal-brand": {
    intake: ["Booking or inquiry form", "Instant reply with next steps", "Client record created automatically"],
    delivery: ["Service checklist for every session", "Delivery and handoff message", "Invoice and payment on time"],
    follow_up: ["Review request after delivery", "Referral prompt to happy clients", "Rebooking and win-back reminders"],
  },
  nonprofit: {
    intake: ["Program sign-up or application form", "Donor and volunteer inquiries routed", "Participant record with consent on file"],
    delivery: ["Program delivery checklist", "Outcomes tracked per program", "Board-ready monthly report"],
    follow_up: ["Donor thank-you within 48 hours", "Impact update to donors", "Re-enrollment and volunteer re-engagement"],
  },
  authority: {
    intake: ["Athlete or program intake with parent consent", "Film and stats request", "Records kept by ID, never names in logs"],
    delivery: ["Transcript and media package delivery", "Parent-approved outreach drafts only", "Season documentation checklist"],
    follow_up: ["Monthly progress update to the family", "Testimonial request, consent first", "Next-season renewal"],
  },
});
function defaultSystems(vertical) {
  const d = DEFAULT_SYSTEMS[vertical] || DEFAULT_SYSTEMS["personal-brand"];
  const out = [];
  for (const g of SYSTEM_GROUPS) {
    (d[g.key] || []).forEach((label, i) => out.push({ id: `${g.key}-${i + 1}`, group: g.key, label, status: "todo", owner: g.key === "delivery" ? "Client" : "System" }));
  }
  return out;
}

// TOJ-wide banned words (CLAUDE.md, every repo).
// Same lists and matching as the Creators checks (utils/creators.js).
const BANNED_WORDS = Object.freeze(["elite", "generational", "next-level", "phenom", "future star", "premier", "top-notch", "state-of-the-art", "revolutionize", "revolutionise", "unlock", "unleash", "transform", "game-changing", "supercharge"]);
const BANNED_PHRASES = Object.freeze(["guaranteed exposure", "guaranteed placement", "guaranteed scholarship", "guaranteed offer"]);
function bannedIn(text) {
  const t = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ")} `;
  const hits = BANNED_WORDS.filter((w) => new RegExp(`[\\s-]${w.replace(/[-\s]/g, "[-\\s]")}(s|d|ed|ing|es|er|ers|ation|ations|ative)?[\\s-]`).test(t));
  const low = String(text || "").toLowerCase();
  for (const p of BANNED_PHRASES) if (low.includes(p)) hits.push(p);
  return hits;
}

// ---------------------------------------------------------------- helpers
function clean(v, max = 2000) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => clean(x, 200)).filter(Boolean).join(", ").slice(0, max);
  if (typeof v === "object") return "";
  return String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}
function humanKey(k) {
  return INTAKE_LABELS[k] || String(k).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// The intake as labelled rows. `forModel` drops contact details and anything
// that can name a minor.
function intakeRows(intake, { forModel = false } = {}) {
  const out = [];
  for (const [k, v] of Object.entries(intake || {})) {
    if (forModel && (PRIVATE_KEYS.includes(k) || MINOR_KEYS.includes(k))) continue;
    const text = clean(v);
    if (!text) continue;
    out.push({ key: k, label: humanKey(k), value: text });
  }
  return out;
}
function intakeText(intake) {
  return intakeRows(intake, { forModel: true }).map((r) => `- ${r.label}: ${r.value}`).join("\n");
}
function cleanIntake(input, existing = {}) {
  const out = { ...existing };
  for (const [k, v] of Object.entries(input || {})) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(k)) continue;
    const text = clean(v);
    if (text) out[k] = text;
    else delete out[k];
  }
  return out;
}
function displayName(intake, fallback) {
  return clean((intake && (intake.business_name || intake.brand_name)) || fallback || "", 120) || "New operating system";
}

// Scores: whole numbers 0–100, an evidence line and a gap line each; no
// pillar above 40 without evidence.
function cleanScores(raw) {
  const src = raw && raw.pillars ? raw.pillars : raw || {};
  const out = {};
  const issues = [];
  for (const k of PILLARS) {
    const p = src[k] || {};
    let score = Math.round(Number(p.score));
    if (!Number.isFinite(score)) score = 0;
    score = Math.max(0, Math.min(100, score));
    const evidence = clean(p.evidence, 400);
    const gap = clean(p.gap, 400);
    const noEvidence = !evidence || /^(none|n\/a|insufficient|no evidence)/i.test(evidence);
    if (noEvidence && score > EVIDENCE_CAP) {
      issues.push({ pillar: k, issue: "capped_without_evidence", from: score });
      score = EVIDENCE_CAP;
    }
    out[k] = { score, evidence: noEvidence ? "Insufficient data in the intake." : evidence, gap };
  }
  return { pillars: out, issues };
}
function totalScore(pillars) {
  return PILLARS.reduce((s, k) => s + (pillars && pillars[k] ? Number(pillars[k].score) || 0 : 0), 0);
}
function weakest(pillars) {
  let w = null;
  for (const k of PILLARS) if (pillars && pillars[k] && (w === null || pillars[k].score < pillars[w].score)) w = k;
  return w;
}

// The transcript's content (not its layout). Text only; banned words flagged.
function cleanTranscript(raw, vertical) {
  const r = raw || {};
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const one = (v, opts, d) => (opts.includes(v) ? v : d);
  const t = {
    executive_summary: clean(r.executive_summary, 1600),
    lines: arr(r.lines, 8).map((x) => ({ name: clean(x && x.name, 120), figure: clean(x && x.figure, 60), standing: clean(x && x.standing, 60), note: clean(x && x.note, 300) })).filter((x) => x.name),
    recovery: arr(r.recovery, 6).map((x) => ({ title: clean(x && x.title, 200), value: clean(x && x.value, 60), ease: one(x && x.ease, EASE, "Medium"), note: clean(x && x.note, 300) })).filter((x) => x.title),
    roster: clean(r.roster, 1400),
    path: arr(r.path, 3).map((x, i) => ({ label: clean(x && x.label, 30) || ["Focus", "Secondary", "Backburner"][i], text: clean(x && x.text, 500) })).filter((x) => x.text),
    actions: arr(r.actions, 7).map((x) => ({ title: clean(x && x.title, 160), detail: clean(x && x.detail, 300), owner: one(x && x.owner, OWNERS, "Client") })).filter((x) => x.title),
  };
  t.banned = bannedIn(JSON.stringify(t));
  t.sections = SECTIONS[vertical] || SECTIONS["personal-brand"];
  return t;
}
function transcriptBlockers(t) {
  const out = [];
  if (!t) return ["no_transcript"];
  if (!t.executive_summary) out.push("executive_summary_missing");
  if (!t.actions || !t.actions.length) out.push("action_plan_missing");
  if (t.banned && t.banned.length) out.push("banned_words");
  return out;
}

// The site promises the written report inside 72 business hours of intake.
function transcriptDue(intakeAt) {
  if (!intakeAt) return null;
  const d = new Date(intakeAt);
  if (Number.isNaN(d.getTime())) return null;
  let left = 3;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d.toISOString();
}

function systemsProgress(systems) {
  const list = Array.isArray(systems) ? systems : [];
  const live = list.filter((s) => s.status === "live").length;
  return { total: list.length, live, building: list.filter((s) => s.status === "building").length, all_live: list.length > 0 && live === list.length };
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "client";
}

module.exports = {
  VERTICALS,
  STAGES,
  STAGE_RANK,
  PILLARS,
  PILLAR_NAMES,
  PILLAR_SHORT,
  pillarName,
  BANDS,
  band,
  EVIDENCE_CAP,
  SECTIONS,
  LINE_COLUMNS,
  OWNERS,
  EASE,
  INTAKE_LABELS,
  PRIVATE_KEYS,
  MINOR_KEYS,
  APP_INTAKE,
  SYSTEM_GROUPS,
  SYSTEM_STATUS,
  defaultSystems,
  BANNED_WORDS,
  bannedIn,
  clean,
  humanKey,
  intakeRows,
  intakeText,
  cleanIntake,
  displayName,
  cleanScores,
  totalScore,
  weakest,
  cleanTranscript,
  transcriptBlockers,
  transcriptDue,
  systemsProgress,
  slugify,
};
