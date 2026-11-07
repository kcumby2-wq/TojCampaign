"use strict";
// The rules for what people send from the public Pylon pages (migration 036;
// the API is routes/pylon.js): the packages and their prices, what each form
// must carry, the consent words, and the emails.
//
// Prices live here and only here. A page shows them, but what a request is
// charged comes from this list, never from the page.

const KINDS = Object.freeze(["team_package", "player_package", "transcript", "recruiting", "newsletter_premium", "ambassador"]);
const KIND_WORDS = Object.freeze({
  team_package: "Team coverage",
  player_package: "Player coverage",
  transcript: "Athlete Transcript",
  recruiting: "Recruiting Concierge",
  newsletter_premium: "Newsletter Premium",
  ambassador: "Ambassador application",
});
// The page each kind comes from: where Stripe sends people back to.
const PAGES = Object.freeze({
  team_package: "/pylon-team-packages.html",
  player_package: "/pylon-player-packages.html",
  transcript: "/pylon-athlete-subscribe.html",
  recruiting: "/pylon-recruiting.html",
  newsletter_premium: "/pylon-newsletter.html",
  ambassador: "/pylon-ambassadors.html",
});

// cadence: "once" is one payment, "season" is one payment for the season,
// "month" is a monthly subscription. per: what the price covers.
const p = (name, cents, cadence, per) => Object.freeze({ name, cents, cadence, per });
const CATALOG = Object.freeze({
  team_package: Object.freeze({
    "1a": p("Pylon Team Recap", 29900, "once", "per team, per event"),
    "1b": p("Pylon Team Season Pack", 149900, "once", "per team, per season"),
    "1c": p("Pylon Combine Book", 299900, "once", "per team, per season"),
  }),
  player_package: Object.freeze({
    "12": p("Pylon Player Snapshot", 6900, "once", "per athlete, per event"),
    "13": p("Pylon Player Story", 9900, "once", "per athlete, per event"),
    "14": p("Pylon Player Feature", 19900, "once", "per athlete, per event"),
  }),
  transcript: Object.freeze({
    individual: p("Pylon Athlete Transcript: Individual", 9900, "season", "per athlete, per season"),
    combine: p("Pylon Athlete Transcript: Combine", 24900, "season", "per athlete, per season"),
  }),
  recruiting: Object.freeze({
    standard_monthly: p("Recruiting Concierge: Standard, monthly", 9900, "month", "per athlete"),
    standard_season: p("Recruiting Concierge: Standard, season", 49900, "season", "per athlete"),
    hbcu_monthly: p("Recruiting Concierge: HBCU Premium, monthly", 14900, "month", "per athlete"),
    hbcu_season: p("Recruiting Concierge: HBCU Premium, season", 74900, "season", "per athlete"),
  }),
  newsletter_premium: Object.freeze({
    premium: p("The Off-Season Signal: Premium", 999, "month", "per subscriber"),
  }),
  // An application: the tier is what the athlete is applying for (the stipend
  // is paid to them), so there's no price and no checkout.
  ambassador: Object.freeze({
    standard: p("Pylon Ambassador: Standard ($50 a month)", null, null, null),
    featured: p("Pylon Ambassador: Featured ($150 a month)", null, null, null),
    flagship: p("Pylon Ambassador: Flagship ($500 a month)", null, null, null),
  }),
});

const STATUSES = Object.freeze(["new", "contacted", "confirmed", "done", "closed"]);
const STATUS_WORDS = Object.freeze({ new: "New", contacted: "Contacted", confirmed: "Confirmed", done: "Done", closed: "Closed" });
const OPEN = Object.freeze(["new", "contacted", "confirmed"]);
const REGION_WORDS = Object.freeze({ west: "West", south_central: "South Central", northeast: "Northeast", southeast: "Southeast", midwest: "Midwest" });
const POSITIONS = Object.freeze(["QB", "WR", "RB", "TE", "OL", "DL", "LB", "DB", "K/P", "ATH"]);
const LEVEL_WORDS = Object.freeze({ ncaa_d1: "NCAA D1", ncaa_d2: "NCAA D2", ncaa_d3: "NCAA D3", naia: "NAIA", juco: "JUCO", hbcu: "HBCU (any level)", mixed: "Mixed or open" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CENTS = 99999999;

// Who's filling the form in, for the kinds about one athlete. The answer is
// the contact's role, and the consent the request carries.
const WHO = Object.freeze({ parent: "parent", guardian: "guardian", adult: "athlete" });
const WHO_WORDS = Object.freeze({ parent: "the athlete's parent", guardian: "the athlete's legal guardian", adult: "the athlete, 18 or older" });
const ATHLETE_KINDS = Object.freeze(["player_package", "transcript", "recruiting", "ambassador"]);

// The words each answer agrees to, kept on the request as they were. They're
// fixed here, so what's on file is what the page showed (the pages carry the
// same sentences next to the question).
const I_AM = Object.freeze({ parent: "I'm the athlete's parent.", guardian: "I'm the athlete's legal guardian.", adult: "I'm the athlete and I'm 18 or older." });
const THEM = Object.freeze({ parent: "them", guardian: "them", adult: "me" });
function consentText(kind, who, { publicOk = false } = {}) {
  if (!has(I_AM, who)) return null;
  const them = THEM[who];
  const agree = {
    player_package:
      `I agree to Pylon filming and photographing ${them} at this event for this package.` +
      (publicOk ? " Pylon may also post the coverage on Pylon's own channels." : " Pylon won't post the coverage on its own channels."),
    transcript: `I agree to Pylon setting up a season-long recruiting profile for ${them}, which ${who === "adult" ? "I" : "we"} can share with coaches.`,
    recruiting: `I agree to the Recruiting Concierge contacting college coaches about ${them}. Nothing goes to a coach until I approve the exact message.`,
    ambassador: `I agree to this application${who === "adult" ? "" : " for them"}. Nothing starts until I review and sign an agreement.`,
  }[kind];
  return agree ? `${I_AM[who]} ${agree}` : null;
}

// ── Cleaning what came in ────────────────────────────────────────────────
// Only strings and finite numbers are values; anything else counts as
// missing, so no input can make these throw.
const text = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
// At most max characters, counted as Postgres counts them (code points).
const clip = (s, max) => {
  const t = String(s);
  return t.length <= max ? t : Array.from(t).slice(0, max).join("");
};
// One line: control characters out (Postgres refuses NUL), single spaces.
const clean = (s, max) => clip(text(s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(), max);
// Free text that keeps its line breaks.
const cleanNotes = (s, max) => clip(text(s).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim(), max);
const has = (obj, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(obj, k);
// A plain address, lowercase: nothing that could add recipients or text to a
// mailto: link (no ? & # % / or spaces). Migration 036 checks the same.
const EMAIL = /^[a-z0-9._+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const email = (v) => {
  const e = clean(v, 200).toLowerCase();
  return EMAIL.test(e) ? e : null;
};
// The mailbox an address delivers to, for limits and for telling two
// addresses apart: lowercase, no +tag, and for Gmail no dots.
function mailbox(address) {
  const a = String(address || "").trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1) return a;
  let user = a.slice(0, at).split("+")[0];
  let domain = a.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") user = user.replace(/\./g, "");
  return user + "@" + domain;
}
function phone(s) {
  const v = clean(s, 30).replace(/[^0-9+().\- ]/g, "").trim();
  return (v.match(/\d/g) || []).length >= 7 ? v : null;
}
const handle = (s) => {
  const v = clean(s, 40).replace(/^@+/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(v) ? v : null;
};
const year = (s) => {
  const v = clean(s, 4);
  return /^20\d\d$/.test(v) && +v >= 2024 && +v <= 2036 ? v : null;
};
const referral = (s) => {
  const v = clean(s, 30).toUpperCase();
  return /^[A-Z0-9_-]{2,30}$/.test(v) ? v : null;
};
const yes = (v) => v === true || v === "true" || v === "yes" || v === "on" || v === "1";

// What a form sent, checked: { errors: [field names], value: the row }.
// raw is the page's JSON. Nothing in it decides a price.
function normalize(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const need = (field, v) => {
    if (v === null || v === undefined || v === "") errors.push(field);
    return v;
  };
  const kind = clean(r.kind, 40);
  if (!KINDS.includes(kind)) return { errors: ["kind"], value: null };
  const pack = clean(r.package, 40);
  const item = has(CATALOG[kind], pack) ? CATALOG[kind][pack] : null;
  if (!item) errors.push("package");

  const details = {};
  const v = {
    kind,
    package: pack,
    package_name: item ? item.name : "",
    price_cents: item ? item.cents : null,
    cadence: item ? item.cadence : null,
    referral_code: null,
    contact_role: null,
    contact_name: null,
    contact_email: null,
    contact_phone: phone(r.contact_phone),
    athlete_name: null,
    consent: null,
    consent_text: null,
    details,
    notes: cleanNotes(r.notes, 1000) || null,
  };

  if (kind === "team_package") {
    v.contact_role = "coach";
    v.contact_name = need("contact_name", clean(r.contact_name, 80));
    v.contact_email = need("contact_email", email(r.contact_email));
    details.team_name = need("team_name", clean(r.team_name, 80));
    const region = clean(r.region, 20);
    details.region = need("region", has(REGION_WORDS, region) ? region : null);
    const ev = clean(r.event, 120);
    if (ev) details.event = ev;
  } else if (kind === "newsletter_premium") {
    v.contact_role = "subscriber";
    v.contact_name = need("contact_name", clean(r.contact_name, 80));
    v.contact_email = need("contact_email", email(r.contact_email));
  } else {
    // About one athlete: who's filling it in decides the contact and the consent.
    const who = clean(r.who, 20);
    if (!has(WHO, who)) errors.push("who");
    v.athlete_name = need("athlete_name", clean(r.athlete_name, 80));
    // An athlete of 18 or older is the contact: their own name, and for an
    // application their own address, when the form didn't repeat them.
    let name = clean(r.contact_name, 80);
    let address = email(r.contact_email);
    if (who === "adult") {
      if (!name) name = v.athlete_name;
      if (!address && kind === "ambassador") address = email(r.athlete_email);
    }
    v.contact_name = need("contact_name", name);
    v.contact_email = need("contact_email", address);
    if (has(WHO, who)) {
      v.contact_role = WHO[who];
      v.consent = who;
      // The consent question has to be answered yes: the form's box.
      if (!yes(r.consent_confirm)) errors.push("consent_confirm");
    }
    if (kind === "player_package") {
      const pos = clean(r.position, 4).toUpperCase();
      details.position = need("position", POSITIONS.includes(pos) ? pos : null);
      details.class_year = need("class_year", year(r.class_year));
      details.team_name = need("team_name", clean(r.team_name, 80));
      details.event = need("event", clean(r.event, 120));
      details.public_ok = yes(r.public_ok);
      v.referral_code = referral(r.referral_code);
    } else if (kind === "transcript") {
      details.position_class = need("position_class", clean(r.position_class, 40));
      details.team_name = need("team_name", clean(r.team_name, 80));
    } else if (kind === "recruiting") {
      details.position_class = need("position_class", clean(r.position_class, 40));
      const level = clean(r.target_level, 20);
      details.target_level = need("target_level", has(LEVEL_WORDS, level) ? level : null);
      // Hot replies from coaches go to the family by phone.
      need("contact_phone", v.contact_phone);
    } else if (kind === "ambassador") {
      const pos = clean(r.position, 4).toUpperCase();
      details.position = need("position", POSITIONS.includes(pos) ? pos : null);
      details.class_year = need("class_year", year(r.class_year));
      details.team_name = need("team_name", clean(r.team_name, 80));
      const own = email(r.athlete_email);
      if (who === "adult") {
        // The athlete is the contact; their own address is the one we use.
        if (own && v.contact_email && mailbox(own) !== mailbox(v.contact_email)) details.athlete_email = own;
      } else {
        details.athlete_email = need("athlete_email", own);
        // A parent's address has to be the parent's: not the athlete's own.
        if (own && v.contact_email && mailbox(own) === mailbox(v.contact_email)) errors.push("contact_email_same");
      }
      const ig = handle(r.ig_handle);
      const tt = handle(r.tiktok_handle);
      if (ig) details.ig_handle = ig;
      if (tt) details.tiktok_handle = tt;
      const n = Number(text(r.follower_count).replace(/[, ]/g, ""));
      if (text(r.follower_count) !== "" && Number.isInteger(n) && n >= 0 && n <= 1e9) details.follower_count = n;
      const why = cleanNotes(r.why, 1000);
      if (why) v.notes = why;
    }
    if (v.consent && item) v.consent_text = consentText(kind, v.consent, { publicOk: details.public_ok === true });
  }
  for (const k of Object.keys(details)) if (details[k] === null || details[k] === undefined || details[k] === "") delete details[k];
  return { errors: [...new Set(errors)], value: errors.length ? null : v };
}

// ── The newsletter ────────────────────────────────────────────────────────
const NEWSLETTER_SOURCES = Object.freeze(["newsletter_page", "premium_page"]);
const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const isToken = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

// ── Words ────────────────────────────────────────────────────────────────
function money(cents) {
  const n = Number(cents) || 0;
  const whole = n % 100 === 0;
  return "$" + (whole ? Math.round(n / 100).toLocaleString("en-US") : (n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}
const CADENCE_WORDS = Object.freeze({ once: "", season: " for the season", month: " a month" });
function priceWords(r) {
  if (r.price_cents === null || r.price_cents === undefined) return "";
  return money(r.price_cents) + (CADENCE_WORDS[r.cadence] || "");
}
const firstName = (s) => clean(s, 80).split(" ")[0] || "there";
// One line for staff lists and alerts: what, never who.
function summary(r) {
  const d = r.details || {};
  const where = r.kind === "team_package" ? [d.team_name, REGION_WORDS[d.region]] : r.kind === "player_package" ? [d.event] : [];
  const price = r.price_cents === null || r.price_cents === undefined ? "" : money(r.price_cents);
  return [r.package_name, price, ...where].filter(Boolean).join(", ");
}

// The push to staff: what came in, never who it's about.
function pushPayload(r) {
  return {
    title: r.paid_at ? "Pylon: paid" : "Pylon: new " + (KIND_WORDS[r.kind] || "request").toLowerCase(),
    body: summary(r),
    url: "/app/#pylon-request/" + r.id,
    tag: "pylon-" + r.id,
  };
}

// The email to staff. Saved: what came in and where to open it (names and
// contacts stay in the app). Not saved: the whole request, since the email is
// then the only copy.
function staffEmail(r, appBase, { saved = true, paid = false } = {}) {
  const subject = paid
    ? `Pylon payment: ${r.package_name} (${money(r.paid_cents)})`
    : `Pylon request: ${r.package_name}${r.price_cents ? " (" + priceWords(r) + ")" : ""}`;
  const lines = [];
  if (paid) lines.push(`Stripe confirmed ${money(r.paid_cents)} for ${r.package_name}.`, "");
  else lines.push(`New Pylon request: ${KIND_WORDS[r.kind] || r.kind}, from ${PAGES[r.kind] || "a Pylon page"}.`, "", `What: ${summary(r)}`);
  if (saved) {
    lines.push("", `Open it in the TOJ app: ${appBase}/app/#pylon-request/${r.id}`, "", "Names and contact details are in the app, not in this email.");
  } else {
    const d = r.details || {};
    lines.push(
      "",
      "THE APP'S DATABASE DIDN'T TAKE THIS REQUEST. This email is the only copy: add it by hand.",
      "",
      `Contact: ${r.contact_name} (${r.contact_role}), ${r.contact_email}${r.contact_phone ? ", " + r.contact_phone : ""}`,
      r.athlete_name ? `Athlete: ${r.athlete_name}` : null,
      r.consent_text ? `Consent, as agreed on the form: ${r.consent_text}` : null,
      ...Object.keys(d).map((k) => `${k}: ${typeof d[k] === "boolean" ? (d[k] ? "yes" : "no") : d[k]}`),
      r.referral_code ? `Creator code: ${r.referral_code}` : null,
      r.notes ? `Notes: ${r.notes}` : null
    );
  }
  return { subject, text: lines.filter((x) => x !== null).join("\n") };
}

const SIGN_OFF = "Pylon Football × Trail of Joy";
// What happens next, by kind, in the contact's note.
const NEXT = Object.freeze({
  team_package: "We'll email you within 24 hours to confirm the event and the details.",
  player_package: "We'll email you within 24 hours to confirm the event and the details.",
  transcript: "We'll email you within 24 hours to set up the profile.",
  recruiting: "We'll email you within 24 hours to get started. Nothing goes to a coach until you've approved the exact message.",
  newsletter_premium: "We'll email you within 24 hours to set up your subscription.",
  ambassador: "We review applications as they come in and reply within 7 days.",
});

// The contact's own note, once, when the request comes in. checkout: the page
// went on to Stripe's checkout. Fixed words, apart from what they told us.
function contactEmail(r, { checkout = false, help = "hello@pylonfootball.com" } = {}) {
  const lines = [`Hi ${firstName(r.contact_name)},`, ""];
  if (r.kind === "ambassador") {
    lines.push(`We got the Pylon Ambassador application for ${r.athlete_name} (${CATALOG.ambassador[r.package] ? CATALOG.ambassador[r.package].name.replace("Pylon Ambassador: ", "") : r.package}).`);
  } else {
    lines.push(`We got your request for ${r.package_name}${r.price_cents !== null && r.price_cents !== undefined ? " (" + priceWords(r) + ")" : ""}${r.athlete_name ? " for " + r.athlete_name : ""}.`);
  }
  lines.push("", NEXT[r.kind] || "We'll be in touch within 24 hours.");
  if (r.kind !== "ambassador") {
    lines.push(
      "",
      checkout
        ? "You went on to Stripe's secure checkout to pay. If the payment didn't go through, reply to this email and we'll send you a new link."
        : "We'll send a secure payment link with the confirmation. Nothing is charged until you pay it."
    );
  }
  if (r.referral_code) lines.push("", `Creator code on your request: ${r.referral_code}.`);
  if (r.kind === "team_package") {
    lines.push("", "We only post an athlete's footage publicly once their parent or guardian has said yes.");
  }
  if (r.consent_text) lines.push("", "What you agreed to on the form:", r.consent_text);
  lines.push(
    "",
    `Questions? Reply to this email or write to ${help}.`,
    "Didn't send this? Reply and tell us, and we'll delete it.",
    "",
    SIGN_OFF
  );
  return { subject: r.kind === "ambassador" ? "Pylon: we got the ambassador application" : "Pylon: we got your request", text: lines.join("\n") };
}

// Once Stripe confirms the payment.
function paidEmail(r, { help = "hello@pylonfootball.com" } = {}) {
  const lines = [
    `Hi ${firstName(r.contact_name)},`,
    "",
    `We received your payment of ${money(r.paid_cents)} for ${r.package_name}${r.athlete_name ? " for " + r.athlete_name : ""}. Stripe sends the receipt.`,
    "",
    NEXT[r.kind] || "We'll be in touch within 24 hours.",
  ];
  if (r.cadence === "month") lines.push("", `It renews each month. To cancel, reply to this email or write to ${help}.`);
  lines.push("", `Questions? Reply to this email or write to ${help}.`, "", SIGN_OFF);
  return { subject: "Pylon: payment received", text: lines.join("\n") };
}

// The newsletter's confirmation: the only email an address gets until its
// owner says yes.
function confirmEmail({ confirmUrl, help = "hello@pylonfootball.com" }) {
  return {
    subject: "Confirm your Off-Season Signal subscription",
    text: [
      "Someone asked to get The Off-Season Signal, Pylon's free recruiting newsletter, at this address.",
      "",
      "To confirm it was you, open this link and tap Confirm:",
      confirmUrl,
      "",
      "If it wasn't you, ignore this email and you won't hear from us. The link works for 7 days.",
      "",
      `Questions? Write to ${help}.`,
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

module.exports = {
  KINDS,
  KIND_WORDS,
  PAGES,
  CATALOG,
  STATUSES,
  STATUS_WORDS,
  OPEN,
  REGION_WORDS,
  POSITIONS,
  LEVEL_WORDS,
  WHO_WORDS,
  ATHLETE_KINDS,
  UUID,
  MAX_CENTS,
  NEWSLETTER_SOURCES,
  CONFIRM_TTL_MS,
  isToken,
  clean,
  cleanNotes,
  email,
  mailbox,
  consentText,
  normalize,
  money,
  priceWords,
  summary,
  pushPayload,
  staffEmail,
  contactEmail,
  paidEmail,
  confirmEmail,
};
