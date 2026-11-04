"use strict";
// The Subject Medias creator fellowship: what an application may hold, what its
// alerts may say, and the note staff send when they approve someone. Used by
// routes/sm-fellowship.js; the table is migration 032.
//
// - Applicants are 16 or older. At 16 or 17 a parent or guardian is on the
//   application, and only the seats open at 16 or 17 can be asked for
//   (shadow, shooter, photographer), as on the crews.
// - A push carries fixed words only: the seat, the age group and a state code.
//   Never a name or anything someone typed.
// - The staff email names an adult applicant and the city. A 16- or
//   17-year-old's name and contact, the links and what anyone wrote stay in
//   the app, unless the database couldn't take the application: then the
//   email is the only copy and carries all of it.
// - The approval note goes to the applicant, or at 16 or 17 to their parent or
//   guardian and the applicant, with the payment link for their plan when it's
//   set on the server (FELLOWSHIP_PAY_TOOLS, FELLOWSHIP_PAY_MEETINGS).

const { line, cleanUrl } = require("./tools");
const { STATE_REGION, REGION_WORDS, UUID, isEmail, regionFor } = require("./sm-bookings");

const SEATS = Object.freeze({
  unsure: "Not sure yet",
  shadow: "Shadow",
  shooter: "Shooter",
  photographer: "Photographer",
  story: "Story camera",
  editor: "Editor",
  lead: "Lead",
});
// The seats open at 16 or 17 (the creators page, "Six seats on a crew").
const TEEN_SEATS = Object.freeze(["unsure", "shadow", "shooter", "photographer"]);
const PLANS = Object.freeze({
  unsure: Object.freeze({ name: "Not sure yet" }),
  tools: Object.freeze({ name: "Tools + Community", price: "$29 a month", what: "the dashboard, the playbooks, assignments from the catalog and the group", env: "FELLOWSHIP_PAY_TOOLS" }),
  meetings: Object.freeze({ name: "Community + 2 Meetings a Week", price: "$79 a month", what: "the community, plus two meetings every week", env: "FELLOWSHIP_PAY_MEETINGS" }),
});
const AGES = Object.freeze({ adult: "18 or older", teen: "16 or 17" });
const STATUSES = Object.freeze(["new", "talking", "approved", "joined", "declined", "withdrawn"]);
const OPEN = Object.freeze(["new", "talking", "approved"]);
const MAX_LINKS = 3;

// Only strings and finite numbers are values. Anything else in the JSON (an
// object, an array) counts as missing, so no input can make these throw.
const text = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
// One line: control and invisible characters out, single spaces, capped.
const one = (v, max) => line(text(v), max);
// Free text that keeps its line breaks (at most one blank line in a row).
const many = (v, max) =>
  text(v)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
const has = (obj, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(obj, k);

function phoneOf(v) {
  const p = one(v, 30).replace(/[^0-9+().\- ]/g, "").trim();
  return (p.match(/\d/g) || []).length >= 7 ? p : null;
}

// An Instagram handle, for the credit line. "@name", "name" or a pasted
// instagram.com/name link all come out as "name".
function handleOf(v) {
  let s = one(v, 120);
  if (!s) return { ok: true, value: null };
  const m = /instagram\.com\/([^/?#\s]+)/i.exec(s);
  if (m) s = m[1];
  s = s.replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(s) ? { ok: true, value: s } : { ok: false, value: null };
}

// A link to their work: https, a real host, no sign-in details in it. People
// type "instagram.com/name" or paste an http:// address; both come out as
// https. Any other scheme (mailto:, javascript:) is refused. "" for blank,
// null for a link that can't be used.
function linkOf(v) {
  let s = one(v, 501);
  if (!s) return "";
  if (/^http:\/\//i.test(s)) s = "https://" + s.slice(7);
  else if (!/^https:\/\//i.test(s)) {
    // "host.tld:443/path" has a colon too, but it's a host, not a scheme.
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+\.[^:/]+:\d/.test(s)) return null;
    s = "https://" + s.replace(/^\/+/, "");
  }
  const u = cleanUrl(s);
  if (!u || u.length > 500) return null;
  let host = "";
  try {
    host = new URL(u).hostname;
  } catch (e) {
    return null;
  }
  return /^[^.]+(\.[^.]+)+$/.test(host) ? u : null;
}

// The application form on subjectmedias.com/fellowship. Returns the row to
// store and the fields that were wrong (by name, so the form can point at them).
function normalize(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const v = {};

  v.name = one(r.name, 80) || (errors.push("name"), null);
  const email = one(r.email, 200).toLowerCase();
  v.email = isEmail(email) ? email : (errors.push("email"), null);
  if (one(r.phone, 40)) {
    v.phone = phoneOf(r.phone);
    if (!v.phone) errors.push("phone");
  } else v.phone = null;
  const handle = handleOf(r.handle);
  v.handle = handle.value;
  if (!handle.ok) errors.push("handle");

  v.city = one(r.city, 80) || (errors.push("city"), null);
  const st = one(r.state, 2).toUpperCase();
  v.state = STATE_REGION[st] ? st : (errors.push("state"), null);
  v.region = regionFor(v.state);

  v.age_group = has(AGES, r.age_group) ? r.age_group : (errors.push("age_group"), null);
  if (v.age_group === "teen") {
    v.guardian_name = one(r.guardian_name, 80) || (errors.push("guardian_name"), null);
    const g = one(r.guardian_email, 200).toLowerCase();
    // The guardian's own address, not the applicant's.
    v.guardian_email = isEmail(g) && g !== v.email ? g : (errors.push("guardian_email"), null);
    if (one(r.guardian_phone, 40)) {
      v.guardian_phone = phoneOf(r.guardian_phone);
      if (!v.guardian_phone) errors.push("guardian_phone");
    } else v.guardian_phone = null;
  } else {
    // An adult's application carries no guardian, whatever was sent.
    v.guardian_name = null;
    v.guardian_email = null;
    v.guardian_phone = null;
  }

  v.seat = has(SEATS, r.seat) ? r.seat : "unsure";
  if (v.age_group === "teen" && !TEEN_SEATS.includes(v.seat)) errors.push("seat");
  v.plan = has(PLANS, r.plan) ? r.plan : "unsure";

  // Up to three links, by position, so the form can point at the one to fix.
  const given = Array.isArray(r.links) ? r.links.slice(0, MAX_LINKS) : [];
  const links = [];
  given.forEach((x, i) => {
    const u = linkOf(x);
    if (u === null) errors.push("link" + (i + 1));
    else if (u && !links.includes(u)) links.push(u);
  });
  if (!links.length && !errors.some((e) => /^link\d$/.test(e))) errors.push("link1");
  v.links = links;

  v.gear = one(r.gear, 200) || null;
  v.about = many(r.about, 1000) || null;
  v.confirmed = r.confirmed === true || r.confirmed === "true" || r.confirmed === "on";
  if (!v.confirmed) errors.push("confirmed");
  return { errors, value: v };
}

const seatWords = (a) => (a && has(SEATS, a.seat) ? SEATS[a.seat] : SEATS.unsure);
const planWords = (a) => {
  const p = a && has(PLANS, a.plan) ? PLANS[a.plan] : PLANS.unsure;
  return p.price ? `${p.name}, ${p.price}` : p.name;
};
const ageWords = (a) => (a && has(AGES, a.age_group) ? AGES[a.age_group] : "");
const place = (a) => [a.city, a.state].filter(Boolean).join(", ");

// One line for the app's lists: the seat, the age group, where.
function summary(a) {
  return [seatWords(a), ageWords(a), place(a)].filter(Boolean).join(" · ");
}

// The push to the TOJ app: fixed words only (a seat, an age group, a state
// code). No name, no city, nothing typed by anyone.
function pushPayload(a) {
  const seat = a && has(SEATS, a.seat) && a.seat !== "unsure" ? SEATS[a.seat] : "Seat not picked";
  const age = a && a.age_group === "teen" ? "16 or 17, guardian on file" : "18 or older";
  const st = a && STATE_REGION[a.state] ? a.state : null;
  return {
    title: "New fellowship application",
    body: [seat, age, st].filter(Boolean).join(" · "),
    url: `/app/#application/${a.id}`,
    tag: `sm-fellowship-${a.id}`,
  };
}

// The staff email. With saved false the database didn't take the application,
// so the email is the only copy and carries all of it.
function emailText(a, appBase, { saved = true } = {}) {
  const base = String(appBase || "https://tojcampaign.com").replace(/\/+$/, "");
  const teen = a.age_group === "teen";
  const subject = `New fellowship application: ${seatWords(a)}, ${place(a) || "no place given"}`;
  const lines = ["A new application to the creator fellowship, from subjectmedias.com/fellowship.", ""];
  if (!saved || !teen) lines.push(`From: ${a.name} (${ageWords(a) || "age not given"})`);
  else lines.push("From: a 16- or 17-year-old, with a parent or guardian on the application");
  lines.push(`Where: ${place(a) || "not given"}${a.region ? ` (${REGION_WORDS[a.region]})` : ""}`);
  lines.push(`Seat they want: ${seatWords(a)}`);
  lines.push(`Plan they lean toward: ${planWords(a)}`);
  const n = Array.isArray(a.links) ? a.links.length : 0;
  if (saved) {
    lines.push(`Work: ${n} ${n === 1 ? "link" : "links"}`);
    if (!teen) lines.push(`Reach them: ${[a.email, a.phone].filter(Boolean).join(", ")}`);
    lines.push("");
    lines.push(`Open it in the TOJ app: ${base}/app/#application/${a.id}`);
    lines.push(teen ? "Their name, contact, guardian, links and what they wrote are in the app." : "Their links and what they wrote are in the app.");
  } else {
    lines.push(`Email: ${a.email}`);
    if (a.phone) lines.push(`Phone: ${a.phone}`);
    if (a.handle) lines.push(`Instagram: @${a.handle}`);
    if (teen) lines.push(`Parent or guardian: ${[a.guardian_name, a.guardian_email, a.guardian_phone].filter(Boolean).join(", ")}`);
    lines.push("Work:");
    for (const l of a.links || []) lines.push(`- ${l}`);
    if (a.gear) lines.push(`Gear: ${a.gear}`);
    if (a.about) lines.push("", "What they wrote:", a.about);
    lines.push("", "This application is NOT in the app: the database didn't take it. Reply to them from here.");
  }
  return { subject, text: lines.join("\n") };
}

const firstName = (s) => one(s, 80).split(" ")[0] || "there";

// The payment link for the application's plan, carrying the application's id
// (so a payment can be matched to it later) and the payer's email. Null when
// no plan was picked or the plan's link isn't set on the server.
function payLink(a, env = process.env) {
  const p = a && has(PLANS, a.plan) ? PLANS[a.plan] : null;
  if (!p || !p.env) return null;
  const base = cleanUrl(env[p.env]);
  if (!base) return null;
  const u = new URL(base);
  if (a.id && UUID.test(a.id)) u.searchParams.set("client_reference_id", a.id);
  const payer = a.age_group === "teen" ? a.guardian_email : a.email;
  if (payer) u.searchParams.set("prefilled_email", payer);
  return u.toString();
}

// Who the approval note goes to: the applicant, or at 16 or 17 their parent or
// guardian first, then the applicant. Addresses come from the application only.
function noteRecipients(a) {
  const list = a.age_group === "teen" ? [a.guardian_email, a.email] : [a.email];
  return [...new Set(list.filter((e) => isEmail(e)))];
}

// The note staff send when they approve someone. Staff can edit it in the app
// before it goes; the recipients can't be changed.
function approvalNote(a, env = process.env) {
  const teen = a.age_group === "teen";
  const first = firstName(a.name);
  const plan = has(PLANS, a.plan) ? PLANS[a.plan] : PLANS.unsure;
  const link = payLink(a, env);
  const L = [];
  L.push(`Hi ${teen ? firstName(a.guardian_name) : first},`, "");
  if (teen) L.push(`${first} applied to the Subject Medias creator fellowship, and we've approved the application.`);
  else L.push("Thanks for sending your work. You're approved for the Subject Medias creator fellowship.");
  L.push("");
  if (plan.price) {
    L.push(`${teen ? first + "'s" : "Your"} plan: ${plan.name}, ${plan.price}. Month to month, cancel anytime.`);
    if (link) L.push(teen ? `As ${first}'s parent or guardian, you start the plan here:` : "Start it here:", link);
    else L.push("We'll send the payment link in our next email.");
  } else {
    L.push("Pick the plan that fits:");
    for (const k of ["tools", "meetings"]) L.push(`- ${PLANS[k].name}, ${PLANS[k].price}: ${PLANS[k].what}.`);
    L.push("Month to month, cancel anytime. Reply with the one you want and we'll send the link.");
  }
  L.push("", "What's next:");
  L.push(`1. Start ${teen ? "the" : "your"} plan${plan.price && link ? " with the link above" : ""}.`);
  L.push(teen ? `2. Sign the creator agreement with ${first}. We'll send it over.` : "2. Sign the creator agreement. We'll send it over.");
  L.push(teen ? `3. You're the guardian on file with us, and any payouts from ${first}'s sales go to your account.` : "3. Get screened: a background check and minor-safety training.");
  L.push(teen ? `4. ${first} works a first stop, shadowing a screened lead. At 16 or 17, ${first} always works beside a screened adult and never leads or edits.` : "4. Work your first stop, shadowing a screened lead.");
  L.push("", "Questions? Reply to this email.", "", "Kyron", "Subject Medias");
  return {
    to: noteRecipients(a),
    subject: teen ? `${first} is in: the Subject Medias creator fellowship` : "You're in: the Subject Medias creator fellowship",
    text: L.join("\n"),
    link,
  };
}

// Staff's private note on an application: free text, cleared with "" or null.
function staffNoteOf(v) {
  if (v === null || v === undefined) return { ok: true, value: null };
  const n = many(v, 1001);
  if (n.length > 1000) return { ok: false, value: null };
  return { ok: true, value: n || null };
}

// What staff may change in a note before it goes: one-line subject, the body.
function noteInput(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const errors = [];
  const subject = one(b.subject, 151);
  if (!subject || subject.length > 150) errors.push("subject");
  const textOut = many(b.text, 4001);
  if (!textOut || textOut.length > 4000) errors.push("text");
  return { errors, value: { subject, text: textOut } };
}

module.exports = {
  SEATS,
  TEEN_SEATS,
  PLANS,
  AGES,
  STATUSES,
  OPEN,
  REGION_WORDS,
  UUID,
  MAX_LINKS,
  linkOf,
  handleOf,
  normalize,
  summary,
  seatWords,
  planWords,
  ageWords,
  pushPayload,
  emailText,
  payLink,
  noteRecipients,
  approvalNote,
  staffNoteOf,
  noteInput,
};
