// Ground Floor Sports · Pylon events: the public stop page its QR codes open
// (/e/<event code>, routes/gfs-page.js), the print cards, and the link rules
// behind both. Migration 025 holds the same link rules in the database.
//
// The page is Pylon's: Pylon's name and colors, Ground Floor Sports as the
// crew, SportsClippers as the store. Nothing on it is about an athlete. A
// creator appears only when the code scanned is theirs, and only if they're
// an adult on the stop's crew with their own SportsClippers page, by first
// name. Every value is escaped, and links leave only for sportsclippers.com,
// email, text and phone.

"use strict";

// The codes every stop has besides its main one ("stop"). Placements a
// director adds are stored on the event (gfs_events.qr_sources).
const QR_PRESETS = Object.freeze([
  { key: "booth", label: "Booth", use: "The GFS booth at the stop" },
  { key: "wristband", label: "Wristbands", use: "Athlete and family wristbands" },
  { key: "team-packet", label: "Team packets", use: "Each team's check-in packet" },
]);
const PRESET_KEYS = QR_PRESETS.map((p) => p.key);
const MAX_PLACEMENTS = 20;
const HELP_EMAIL_DEFAULT = "support@groundfloorsports.com";
const SC_HOST = /^([a-z0-9-]+\.)*sportsclippers\.com$/;
const SC_URL = /^https:\/\/([a-z0-9-]+\.)*sportsclippers\.com(\/[^\s"<>]*)?$/;
const PLACEMENT = /^[a-z0-9][a-z0-9-]{1,23}$/;
const CREATOR_CODE = /^[A-Z0-9]{4,8}$/;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function h(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Where the pages live. Set GFS_PAGE_BASE to a GFS address before codes are
// printed, so TOJ's own domain stays off Pylon's signs.
function pageBase() {
  return String(process.env.GFS_PAGE_BASE || process.env.CREATOR_PAGE_BASE || "https://tojcampaign.com").trim().replace(/\/+$/, "");
}
function helpEmail() {
  const e = String(process.env.GFS_HELP_EMAIL || "").trim().toLowerCase();
  return EMAIL.test(e) ? e : HELP_EMAIL_DEFAULT;
}

// A SportsClippers page, or null to clear it. Only https on sportsclippers.com
// (or a subdomain), with no login part or port. { url } or { error }.
function sportsClippersUrl(v) {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return { url: null };
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return { error: "not_a_link" };
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !SC_HOST.test(u.hostname)) return { error: "not_sportsclippers" };
  const url = `https://${u.hostname}${u.pathname}${u.search}${u.hash}`;
  if (url.length > 300 || !SC_URL.test(url)) return { error: "not_sportsclippers" };
  return { url };
}

// A number families can text: US numbers in any common format, or full
// international form. "+15551234567", or null to clear. { phone } or { error }.
function phone(v) {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return { phone: null };
  const digits = raw.replace(/[^\d]/g, "");
  if (/^\+/.test(raw)) return /^[1-9]\d{7,14}$/.test(digits) ? { phone: "+" + digits } : { error: "phone" };
  if (/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return { phone: "+1" + digits };
  if (/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return { phone: "+" + digits };
  return { error: "phone" };
}
function phoneWords(p) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(p || ""));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(p || "");
}

// A placement's key from what a director typed: "Field 3 sign" → "field-3-sign".
function placementKey(label) {
  const k = String(label == null ? "" : label).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  return PLACEMENT.test(k) ? k : null;
}
function placementLabel(key) {
  const p = QR_PRESETS.find((x) => x.key === key);
  if (p) return p.label;
  const s = String(key || "").replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// The stop's placements: the presets, then the ones added for it.
function placementsOf(ev) {
  const added = (ev.qr_sources || []).filter((k) => PLACEMENT.test(k) && !PRESET_KEYS.includes(k));
  return [...QR_PRESETS.map((p) => ({ key: p.key, label: p.label, use: p.use, custom: false })), ...added.map((k) => ({ key: k, label: placementLabel(k), use: null, custom: true }))];
}

// A code's key in the app's URLs: "stop", "s-<placement>" or "c-<creator code>";
// its source in the counts: "stop", "s:<placement>" or "c:<creator code>".
function parseKey(key) {
  const k = String(key || "");
  if (k === "stop") return { kind: "stop", source: "stop" };
  let m = /^s-([a-z0-9][a-z0-9-]{1,23})$/.exec(k);
  if (m) return { kind: "placement", placement: m[1], source: "s:" + m[1] };
  m = /^c-([A-Z0-9]{4,8})$/.exec(k);
  if (m) return { kind: "creator", creator: m[1], source: "c:" + m[1] };
  return null;
}
function keyOf(src) {
  return src.kind === "placement" ? "s-" + src.placement : src.kind === "creator" ? "c-" + src.creator : "stop";
}
// Which code a visitor came in on, from the page's own query string. Unknown
// values count as the stop's main code.
function sourceFromQuery(q, ev) {
  const s = String((q && q.s) || "").toLowerCase();
  if (s && PLACEMENT.test(s) && placementsOf(ev).some((p) => p.key === s)) return { kind: "placement", placement: s, source: "s:" + s };
  const c = String((q && q.c) || "").toUpperCase();
  if (c && CREATOR_CODE.test(c)) return { kind: "creator", creator: c, source: "c:" + c };
  return { kind: "stop", source: "stop" };
}

// The page a code opens.
function stopUrl(ev, src) {
  const base = `${pageBase()}/e/${encodeURIComponent(ev.code)}`;
  if (src && src.kind === "placement") return `${base}?s=${encodeURIComponent(src.placement)}`;
  if (src && src.kind === "creator") return `${base}?c=${encodeURIComponent(src.creator)}`;
  return base;
}
// A SportsClippers link, tagged so SportsClippers' own reports show the stop
// and the code a sale came from.
function tagged(url, ev, src) {
  const u = new URL(url);
  u.searchParams.set("utm_source", "pylon");
  u.searchParams.set("utm_medium", "stop_page");
  u.searchParams.set("utm_campaign", String(ev.code).toLowerCase());
  u.searchParams.set("utm_content", keyOf(src || { kind: "stop" }).toLowerCase());
  return u.toString();
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0].replace(/[^\p{L}\p{M}'’-]/gu, "").slice(0, 30);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateSpan(ev) {
  const p = (d) => String(d || "").slice(0, 10).split("-").map(Number);
  const [y1, m1, d1] = p(ev.starts_on);
  const [y2, m2, d2] = p(ev.ends_on || ev.starts_on);
  if (!y1 || !m1 || !d1) return "";
  if (!y2 || (y1 === y2 && m1 === m2 && d1 === d2)) return `${MONTHS[m1 - 1]} ${d1}, ${y1}`;
  if (y1 === y2 && m1 === m2) return `${MONTHS[m1 - 1]} ${d1}–${d2}, ${y1}`;
  if (y1 === y2) return `${MONTHS[m1 - 1]} ${d1} – ${MONTHS[m2 - 1]} ${d2}, ${y1}`;
  return `${MONTHS[m1 - 1]} ${d1}, ${y1} – ${MONTHS[m2 - 1]} ${d2}, ${y2}`;
}
// "Legacy Tour · Indianapolis" under a "Legacy Tour" kicker reads as "Indianapolis".
function titleOf(ev) {
  const name = String(ev.name || "");
  const pre = ev.series ? `${ev.series} · ` : "";
  return pre && name.startsWith(pre) && name.length > pre.length ? name.slice(pre.length) : name;
}
function placeWords(ev) {
  const city = [ev.city, ev.state].filter(Boolean).join(", ");
  return ev.venue ? `${ev.venue} · ${city}` : city;
}
function mailto(email, subject, body) {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}${body ? "&body=" + encodeURIComponent(body) : ""}`;
}

const FONTS = "https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800&display=swap";
const BASE_CSS = `:root{--black:#0A0A0A;--surface:#161616;--line:#2A2A2A;--white:#FFFFFF;--muted:#B5B5B5;--yellow:#F4C82E}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--black);color:var(--white);font-family:Inter,system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5;-webkit-text-size-adjust:100%}
a{color:inherit}
.wrap{max-width:560px;margin:0 auto;padding:28px 16px 48px}
.mark{font-family:Anton,Impact,sans-serif;font-size:28px;letter-spacing:.06em;color:var(--yellow);text-transform:uppercase;line-height:1}
.kicker{margin-top:22px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
h1{font-family:Anton,Impact,sans-serif;font-weight:400;font-size:44px;line-height:1.02;text-transform:uppercase;margin-top:6px}
.where{margin-top:8px;color:var(--muted);font-size:15px}
.lede{margin-top:18px;font-size:16px}
.btn{display:block;margin-top:18px;padding:16px 18px;border-radius:12px;background:var(--yellow);color:var(--black);font-weight:800;font-size:17px;text-align:center;text-decoration:none}
.btn.ghost{background:transparent;color:var(--white);border:1px solid var(--line)}
.btn:focus-visible{outline:3px solid var(--white);outline-offset:3px}
.card{margin-top:22px;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
.card h2{font-size:17px;font-weight:800}
.card p{margin-top:6px;color:var(--muted);font-size:15px}
.card .btn{margin-top:14px}
ul{margin-top:10px;padding-left:20px;color:var(--muted);font-size:15px}
li{margin-top:6px}
.note{margin-top:18px;padding:14px 16px;border-radius:12px;border:1px dashed var(--line);color:var(--muted);font-size:15px}
.links{display:flex;flex-direction:column;gap:10px;margin-top:12px}
.links a{display:block;padding:13px 14px;border-radius:10px;border:1px solid var(--line);text-decoration:none;font-weight:700;font-size:15px}
.links a span{display:block;font-weight:500;color:var(--muted);font-size:13.5px;margin-top:2px}
.links.top{margin-top:18px}
footer{margin-top:30px;color:var(--muted);font-size:13px}`;

// The stop page. opts: { nonce, creator: { first, code } | null, source,
// footageHref, creatorHref, email, phone }
function renderStopPage(ev, opts = {}) {
  const n = h(opts.nonce || "");
  const email = opts.email || helpEmail();
  const cancelled = ev.status === "cancelled";
  const cr = opts.creator && !cancelled ? opts.creator : null;
  const help = [
    `<a href="${h(mailto(email, `Footage help · ${ev.name}`, "Team:\nJersey number:\nWhat you need:\n"))}">Email Ground Floor Sports<span>Tell us the team and jersey number, and what you're looking for.</span></a>`,
    opts.phone ? `<a href="sms:${h(opts.phone)}">Text the on-site team<span>${h(phoneWords(opts.phone))}</span></a>` : "",
    cr ? `<a href="${h(opts.creatorHref)}">Reach ${h(cr.first)} on SportsClippers<span>${h(cr.first)} filmed at this stop.</span></a>` : "",
  ].filter(Boolean).join("");
  const footage = cancelled
    ? `<p class="note">This stop was cancelled. If you have footage from it or a question, email Ground Floor Sports below.</p>`
    : opts.footageHref
      ? `<a class="btn" href="${h(opts.footageHref)}">Find your footage on SportsClippers</a>`
      : `<p class="note">The footage page for this stop isn't up yet. Save this page: the link will be here once the first clips are.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${h(ev.name)} · Find your footage</title>
<link rel="stylesheet" href="${FONTS}">
<style nonce="${n}">${BASE_CSS}</style></head><body><main class="wrap">
<p class="mark">Pylon</p>
<p class="kicker">${h(ev.series || "Pylon")} · ${h(dateSpan(ev))}</p>
<h1>${h(titleOf(ev))}</h1>
<p class="where">${h(placeWords(ev))}</p>
<p class="lede">Ground Floor Sports films this stop for Pylon. Clips are sold on SportsClippers, Pylon's official storefront.</p>
${footage}
${cr ? `<section class="card"><h2>Filmed by ${h(cr.first)}</h2><p>${h(cr.first)} is one of the Ground Floor Sports creators at this stop.</p><a class="btn ghost" href="${h(opts.creatorHref)}">See ${h(cr.first)}'s SportsClippers page</a></section>` : ""}
<section class="card"><h2>How clips reach you</h2><ul>
<li>Clips go up after each game is filmed, tagged by jersey number and checked.</li>
<li>An athlete's clips are listed only with the permissions a parent gave at registration.</li>
<li>Clips of an athlete under 13, or of one whose parent didn't choose public display, aren't on the public storefront. They reach the family by a private link.</li>
</ul></section>
<section class="card"><h2>Need help?</h2><div class="links">${help}</div></section>
<section class="card"><h2>Want a clip taken down?</h2><p>Email us the team and jersey number, and which clip. Clips come down within 72 hours of a request, and sooner for a safety concern.</p>
<div class="links"><a href="${h(mailto(email, `Takedown request · ${ev.name}`, "Team:\nJersey number:\nThe clip (a link or what it shows):\n"))}">Ask for a takedown<span>${h(email)}</span></a></div></section>
<footer>Filmed by Ground Floor Sports for Pylon. Sales run on SportsClippers.</footer>
</main></body></html>`;
}

// A page for a code that doesn't lead anywhere (a stop that isn't in the app).
function renderMissingPage(nonce) {
  const email = helpEmail();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Pylon · Footage</title>
<link rel="stylesheet" href="${FONTS}"><style nonce="${h(nonce || "")}">${BASE_CSS}</style></head><body><main class="wrap">
<p class="mark">Pylon</p><h1>This page isn't here</h1>
<p class="lede">Check the code you scanned, or email Ground Floor Sports and we'll point you to your stop's footage.</p>
<div class="links top"><a href="${h(mailto(email, "Footage help"))}">Email Ground Floor Sports<span>${h(email)}</span></a></div>
</main></body></html>`;
}

// A printable code: a letter-size sign for the stop and its placements, or a
// 4×6 card for a creator's lanyard. opts: { nonce, qrSvg, url, kind, label, creatorFirst }
function renderPrintCard(ev, opts = {}) {
  const n = h(opts.nonce || "");
  const creator = opts.kind === "creator" && opts.creatorFirst;
  const short = String(opts.url || "").replace(/^https?:\/\//, "");
  const css = creator
    ? `.sheet{width:min(4in,100%);min-height:6in;padding:26px 22px}.qr{width:min(2.7in,100%)}.big{font-size:30px}`
    : `.sheet{width:min(8.5in,100%);min-height:11in;padding:56px 48px}.qr{width:min(5.2in,100%)}.big{font-size:clamp(34px,10vw,64px)}@media print{.sheet{padding:56px 48px}}@media screen and (max-width:600px){.sheet{min-height:0;padding:28px 18px}}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${h(ev.name)} · ${h(creator ? "Card for " + opts.creatorFirst : opts.label || "Sign")}</title>
<link rel="stylesheet" href="${FONTS}">
<style nonce="${n}">*{box-sizing:border-box;margin:0;padding:0}body{background:#ddd;font-family:Inter,Arial,sans-serif;color:#0A0A0A;padding:24px}
.sheet{margin:0 auto;background:#fff;text-align:center;border-top:14px solid #F4C82E;display:flex;flex-direction:column;align-items:center}
.mark{font-family:Anton,Impact,sans-serif;font-size:26px;letter-spacing:.06em;text-transform:uppercase}
.ev{margin-top:8px;font-size:15px;font-weight:600}.when{font-size:13px;color:#444;margin-top:2px}
.big{font-family:Anton,Impact,sans-serif;font-weight:400;text-transform:uppercase;line-height:1;margin-top:22px}
.qr{margin:22px auto 0;aspect-ratio:1/1}.qr svg{display:block;width:100%;height:100%}
.ask{margin-top:18px;font-size:15px;font-weight:600;max-width:5.5in}.url{margin-top:10px;font-size:12px;color:#444;word-break:break-all}
.by{margin-top:14px;font-size:12px;color:#444}
.print{display:block;margin:18px auto 0;padding:10px 20px;font-size:15px}
${css}
@media print{body{background:#fff;padding:0}.print{display:none}}</style></head><body>
<div class="sheet"><p class="mark">Pylon</p><p class="ev">${h(ev.name)}</p><p class="when">${h(dateSpan(ev))} · ${h([ev.city, ev.state].filter(Boolean).join(", "))}</p>
<p class="big">${creator ? "Filmed by " + h(opts.creatorFirst) : "Find your footage"}</p>
<div class="qr" role="img" aria-label="QR code for this stop's footage page">${opts.qrSvg || ""}</div>
<p class="ask">${creator ? `Scan for this stop's footage and ${h(opts.creatorFirst)}'s SportsClippers page.` : "Scan to find your athlete's clips on SportsClippers, or to reach Ground Floor Sports for help."}</p>
<p class="url">${h(short)}</p><p class="by">Filmed by Ground Floor Sports for Pylon</p></div>
<button type="button" class="print" id="p">Print</button>
<script nonce="${n}">document.getElementById('p').addEventListener('click',function(){window.print();});</script>
</body></html>`;
}

module.exports = {
  QR_PRESETS,
  PRESET_KEYS,
  MAX_PLACEMENTS,
  HELP_EMAIL_DEFAULT,
  SC_URL,
  pageBase,
  helpEmail,
  sportsClippersUrl,
  phone,
  phoneWords,
  placementKey,
  placementLabel,
  placementsOf,
  parseKey,
  keyOf,
  sourceFromQuery,
  stopUrl,
  tagged,
  firstName,
  dateSpan,
  renderStopPage,
  renderMissingPage,
  renderPrintCard,
};
