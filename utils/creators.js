// The Creator Club, phase 1 — the pure parts: intake → profile, the checks a
// profile must pass before its page can go live, codes, the split, and CSVs.
// No network, no database. routes/creators.js does the storing.
//
// Ported from Kyron's onboarding-to-config.js and creator.config.js, with
// three changes: package names don't use banned TOJ words ("Elite Coverage"
// became "Full Coverage"), the price is cents in storage, and every profile
// carries the checks it failed so a person sees them before approving.

"use strict";

const crypto = require("crypto");

// TOJ-wide banned words (CLAUDE.md in every TOJ repo) and phrases.
// A dash or a space between words matches either ("next level" = "next-level").
const BANNED_WORDS = ["elite", "generational", "next-level", "phenom", "future star", "premier", "top-notch", "state-of-the-art", "revolutionize", "revolutionise", "unlock", "unleash", "transform", "game-changing", "supercharge"];
const BANNED_PHRASES = ["guaranteed exposure", "guaranteed placement", "guaranteed scholarship", "guaranteed offer"];
const WARN_WORDS = ["guarantee", "exposure", "viral", "go viral"];

// Fonts a page may load from Google Fonts. Anything else falls back.
const FONTS = ["Anton", "Bebas Neue", "Oswald", "Archivo", "Archivo Black", "Barlow", "Barlow Condensed", "DM Sans", "Inter", "Montserrat", "Roboto", "Roboto Condensed", "Space Grotesk", "Space Mono", "Teko", "Saira Condensed"];

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0, I/1
const CREW_ROLES = ["lead", "support", "photographer", "coordinator", "editor", "designer"];
const ORDER_STAGES = ["Paid", "Shooting", "Editing", "Delivered", "Refunded"];

const RUNGS = [
  { n: 1, name: "Join the club", unlocks: "The dashboard, the SOPs, catalog assignments", gate: "Kyron reviews the application; agreement signed; club fee paid" },
  { n: 2, name: "Landing page, on request", unlocks: "A page with packages and checkout; payouts to their Stripe account", gate: "Profile passes its checks; the owner approves" },
  { n: 3, name: "Event QR codes", unlocks: "A QR code per event, consent at checkout, a sales CSV per event", gate: "A live page" },
  { n: 4, name: "SportsClippers", unlocks: "Selling content on SportsClippers", gate: "An approved camera and work that meets SOP 3" },
  { n: 5, name: "A team", unlocks: "Crew under their brand, each with a code that credits their sales", gate: "A season of on-time deliveries and working payouts" },
  { n: 6, name: "Their own site", unlocks: "A website like subjectmedias.com", gate: "A proven audience and a clear return" },
];

const DEFAULT_PACKAGES = [
  { id: "photo", name: "Photo Coverage", price: 49, desc: "Game-day photo coverage, edited and delivered.", features: ["Full event coverage", "15+ professionally edited photos", "Labeled and organized delivery"], featured: false },
  { id: "video", name: "Video Coverage", price: 99, desc: "Highlight-ready video, shot and edited for coaches.", features: ["Game or event coverage", "Color-graded highlight video", "Raw edited footage", "Clips sized for social"], featured: true },
  { id: "full", name: "Full Coverage", price: 139, desc: "Photo and video in one package.", features: ["Photo and video coverage", "Highlights and social clips", "Organized delivery"], featured: false },
];

// Jotform question label → field (kept from onboarding-to-config.js, plus
// the questions the club adds).
const FIELD_MAP = {
  "Business name": "brandName",
  "Instagram / social handle": "handle",
  "Coverage area": "location",
  "One-line tagline": "tagline",
  "Primary color (hex)": "primary",
  "Accent color (hex)": "accent",
  "Light or dark site?": "mode",
  "Photo package price": "photoPrice",
  "Video package price": "videoPrice",
  "Elite package price": "fullPrice",
  "Full package price": "fullPrice",
  "Team package price": "teamPrice",
  "Show team package?": "showTeam",
  "Creator email": "creatorEmail",
  "Parent / guardian email": "guardianEmail",
  "Under 18?": "under18",
  "Camera body": "camera",
};

const clean = (s, max = 200) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
const isHex = (s) => /^#[0-9a-fA-F]{6}$/.test(String(s || ""));
const yes = (s) => /^(y|yes|true|1|on)$/i.test(String(s == null ? "" : s).trim());

function slugify(name) {
  const s = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return s.length >= 3 ? s : "";
}

function code(length) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function price(v, fallback) {
  const n = Number(String(v == null ? "" : v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : fallback;
}

// A Jotform export ({ answers: { "3": { text, answer } } }, or flat
// { "Business name": "..." }) → { field: value }.
function flattenJotform(raw) {
  const out = {};
  const data = (raw && (raw.formData || raw.answers || raw)) || {};
  for (const [key, val] of Object.entries(data)) {
    if (val && typeof val === "object" && val.text && val.answer !== undefined) {
      const k = FIELD_MAP[String(val.text).trim()];
      if (k) out[k] = typeof val.answer === "object" ? Object.values(val.answer).join(" ") : String(val.answer).trim();
    } else if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      const k = FIELD_MAP[key] || (Object.values(FIELD_MAP).includes(key) ? key : null);
      if (k) out[k] = String(val).trim();
    }
  }
  return out;
}

function lighten(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, (n >> 16) + amount);
  const g = Math.min(255, ((n >> 8) & 0xff) + amount);
  const b = Math.min(255, (n & 0xff) + amount);
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}

// Intake answers → a profile, the shape the creators table stores.
function buildProfile(a) {
  const get = (k) => clean(a[k], k === "tagline" ? 160 : 120);
  const brand = get("brandName") || "New Creator";
  const primary = isHex(get("primary")) ? get("primary").toLowerCase() : "#e10f1c";
  const light = get("mode").toLowerCase() === "light";
  const packages = DEFAULT_PACKAGES.map((p) => ({ ...p, features: [...p.features] }));
  packages[0].price = price(a.photoPrice, 49);
  packages[1].price = price(a.videoPrice, 99);
  packages[2].price = price(a.fullPrice, 139);
  const handle = get("handle");
  return {
    slug: slugify(brand),
    brand_name: brand,
    handle: handle ? (handle.startsWith("@") ? handle : "@" + handle) : null,
    location: get("location") || null,
    tagline: get("tagline") || "Photo and video coverage for your athlete, delivered fast.",
    hero_lines: ["PROFESSIONAL", "SPORTS MEDIA", "COVERAGE"],
    theme: {
      primary,
      accent: isHex(get("accent")) ? get("accent").toLowerCase() : lighten(primary, 24),
      bg: light ? "#ffffff" : "#0a0a0a",
      bgCard: light ? "#f2f2f2" : "#1a1a1a",
      text: light ? "#111111" : "#f5f5f5",
      gold: "#ffcc55",
      displayFont: "Anton",
      bodyFont: "DM Sans",
      mode: light ? "light" : "dark",
    },
    packages,
    team_tier: { show: String(a.showTeam || "yes").toLowerCase() !== "no", name: "Team Package", price: price(a.teamPrice, 399), desc: "Full team coverage: coaches, roster and game film." },
    footer_note: "Creator-owned coverage · Built for athletes",
    creator_email: isEmail(get("creatorEmail")) ? get("creatorEmail").toLowerCase() : null,
    under_18: yes(a.under18),
    guardian_email: isEmail(get("guardianEmail")) ? get("guardianEmail").toLowerCase() : null,
    camera: get("camera") || null,
  };
}

// Words a profile shows to the public, with where they are.
function publicText(p) {
  const out = [];
  const add = (field, text) => text && out.push({ field, text: String(text) });
  add("tagline", p.tagline);
  (p.hero_lines || []).forEach((l, i) => add(`hero_lines[${i}]`, l));
  (p.packages || []).forEach((k, i) => {
    add(`packages[${i}].name`, k.name);
    add(`packages[${i}].desc`, k.desc);
    (k.features || []).forEach((f, j) => add(`packages[${i}].features[${j}]`, f));
  });
  if (p.team_tier && p.team_tier.show) {
    add("team_tier.name", p.team_tier.name);
    add("team_tier.desc", p.team_tier.desc);
  }
  add("footer_note", p.footer_note);
  return out;
}

function wordHits(text, list) {
  const t = ` ${String(text).toLowerCase().replace(/[^a-z0-9\s-]/g, " ")} `;
  return list.filter((w) => new RegExp(`[\\s-]${w.replace(/[-\s]/g, "[-\\s]")}(s|d|ed|ing|es|er|ers|ation|ations|ative)?[\\s-]`).test(t));
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// What has to be fixed (block) or looked at (warn) before the page goes live.
function checkProfile(p) {
  const out = [];
  const block = (field, message) => out.push({ level: "block", field, message });
  const warn = (field, message) => out.push({ level: "warn", field, message });

  if (!p.slug || !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(p.slug)) block("slug", "The page address needs 3 to 50 letters, numbers or dashes.");
  if (!clean(p.brand_name)) block("brand_name", "The business name is missing.");
  for (const w of wordHits(p.brand_name || "", BANNED_WORDS)) warn("brand_name", `The business name uses "${w}", a banned TOJ word. It's their brand, so it's allowed, but it can't appear anywhere else on the page.`);
  for (const { field, text } of publicText(p)) {
    for (const w of wordHits(text, BANNED_WORDS)) block(field, `"${w}" is a banned TOJ word. Say the concrete thing instead.`);
    for (const ph of BANNED_PHRASES) if (text.toLowerCase().includes(ph)) block(field, `"${ph}" is a banned promise.`);
    for (const w of wordHits(text, WARN_WORDS)) warn(field, `"${w}" reads as a promise. Check it says only what's delivered.`);
  }
  const t = p.theme || {};
  for (const k of ["primary", "accent", "bg", "bgCard", "text"]) if (!isHex(t[k])) block(`theme.${k}`, `${k} must be a hex color like #e10f1c.`);
  if (isHex(t.text) && isHex(t.bg) && contrast(t.text, t.bg) < 4.5) block("theme.text", "The text color is too close to the background to read.");
  if (isHex(t.accent) && isHex(t.bg) && contrast(t.accent, t.bg) < 3) warn("theme.accent", "The accent color is hard to see on the background.");
  if (t.displayFont && !FONTS.includes(t.displayFont)) warn("theme.displayFont", `"${t.displayFont}" isn't on the font list; the page uses Anton.`);
  if (t.bodyFont && !FONTS.includes(t.bodyFont)) warn("theme.bodyFont", `"${t.bodyFont}" isn't on the font list; the page uses DM Sans.`);

  const pk = Array.isArray(p.packages) ? p.packages : [];
  if (!pk.length || pk.length > 6) block("packages", "A page needs 1 to 6 packages.");
  const ids = new Set();
  pk.forEach((k, i) => {
    if (!/^[a-z0-9-]{2,24}$/.test(String(k.id || ""))) block(`packages[${i}].id`, "Each package needs a short id (letters, numbers, dashes).");
    if (ids.has(k.id)) block(`packages[${i}].id`, "Two packages share an id.");
    ids.add(k.id);
    if (!clean(k.name)) block(`packages[${i}].name`, "A package has no name.");
    if (!(Number(k.price) >= 5 && Number(k.price) <= 5000)) block(`packages[${i}].price`, "Prices must be between $5 and $5,000.");
  });
  if (p.team_tier && p.team_tier.show && !(Number(p.team_tier.price) >= 5 && Number(p.team_tier.price) <= 20000)) block("team_tier.price", "The team price must be between $5 and $20,000.");

  if (!isEmail(p.creator_email)) warn("creator_email", "No email for the creator yet.");
  if (p.under_18 && !isEmail(p.guardian_email)) block("guardian_email", "Under 18: a parent or guardian's email is required. They hold the Stripe account.");
  if (p.handle && !/^@[A-Za-z0-9._]{1,30}$/.test(p.handle)) warn("handle", "That doesn't look like an Instagram handle.");
  return out;
}

const blockers = (checks) => (checks || []).filter((c) => c.level === "block");

// The creator lane's split, in cents. The platform's share is what Stripe
// keeps as the application fee; Stripe's own fees come out of it.
function split(amountCents, percent) {
  const amount = Math.max(0, Math.round(Number(amountCents) || 0));
  const pct = Math.min(95, Math.max(50, Math.round(Number(percent) || 80)));
  const creator = Math.floor((amount * pct) / 100);
  return { amount, creator, platform: amount - creator, percent: pct };
}

// ── CSV ───────────────────────────────────────────────────────────────────
// Columns a person can pick for an event's sales CSV.
const CSV_COLUMNS = {
  date: { label: "Date", get: (o) => String(o.created_at || "").slice(0, 10) },
  event: { label: "Event", get: (o, x) => (x.events.get(o.event_id) || {}).name || "" },
  package: { label: "Package", get: (o) => o.package_name },
  amount: { label: "Amount", get: (o) => dollars(o.amount_cents) },
  creator_share: { label: "Creator share", get: (o) => dollars(o.creator_cents) },
  platform_share: { label: "Platform share", get: (o) => dollars(o.platform_cents) },
  buyer_name: { label: "Buyer", get: (o) => o.buyer_name || "" },
  buyer_email: { label: "Email", get: (o) => o.buyer_email || "" },
  buyer_phone: { label: "Phone", get: (o) => o.buyer_phone || "" },
  team_jersey: { label: "Team and jersey", get: (o) => o.team_jersey || "" },
  instagram: { label: "Instagram", get: (o) => (o.instagram ? "@" + String(o.instagram).replace(/^@/, "") : "") },
  crew: { label: "Crew", get: (o, x) => (o.crew_code ? `${(x.crew.get(o.crew_code) || {}).name || ""} (${o.crew_code})`.trim() : "") },
  status: { label: "Status", get: (o) => o.status },
  consent_public: { label: "OK to post", get: (o) => (o.consent_public ? "Yes" : "No") },
  mode: { label: "Mode", get: (o) => (o.mode === "test" ? "TEST" : "live") },
};
const DEFAULT_CSV = ["date", "event", "package", "amount", "creator_share", "buyer_name", "buyer_email", "team_jersey", "instagram", "crew", "status", "consent_public", "mode"];

function dollars(cents) {
  return (Math.round(Number(cents) || 0) / 100).toFixed(2);
}
function csvCell(v) {
  let s = String(v == null ? "" : v);
  // A cell a spreadsheet would run as a formula gets a leading quote mark.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(orders, { columns, events = [], crew = [] } = {}) {
  const cols = (Array.isArray(columns) && columns.length ? columns : DEFAULT_CSV).filter((c) => CSV_COLUMNS[c]);
  const ctx = { events: new Map(events.map((e) => [e.id, e])), crew: new Map(crew.map((c) => [c.code, c])) };
  const lines = [cols.map((c) => csvCell(CSV_COLUMNS[c].label)).join(",")];
  for (const o of orders) lines.push(cols.map((c) => csvCell(CSV_COLUMNS[c].get(o, ctx))).join(","));
  return lines.join("\r\n") + "\r\n";
}

module.exports = {
  BANNED_WORDS,
  FONTS,
  CREW_ROLES,
  ORDER_STAGES,
  RUNGS,
  DEFAULT_PACKAGES,
  FIELD_MAP,
  CSV_COLUMNS,
  DEFAULT_CSV,
  slugify,
  code,
  flattenJotform,
  buildProfile,
  checkProfile,
  blockers,
  split,
  toCsv,
  csvCell,
  isEmail,
  isHex,
  clean,
  contrast,
};
