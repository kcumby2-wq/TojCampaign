// Campaign intake tests — /intake.html, its 31 questions, and where the
// answers go (the onboarding intake → the Intake CRM → "Copy for TOJ").
//
// Runs the real onboarding route in-process on the JSON fallback (no Supabase,
// no network). db/onboarding_intakes.json is backed up and restored around the
// run, so a developer's local data is untouched.
//
//   node --test tests/campaign-intake.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Force the JSON fallback before any route is loaded.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const express = require("express");
const Q = require("../public/js/campaign-intake-questions.js");
const { payloadToProse } = require("../utils/embed");

const ROOT = path.join(__dirname, "..");
const DB_FILE = path.join(ROOT, "db", "onboarding_intakes.json");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// The "TOJ Agency Brief and Campaign Intake" doc asks its 31 questions under
// these topics, in this order. The form asks the same questions, word for word.
const DOC_TOPICS = [
  ...Array(4).fill("Goal"),
  ...Array(4).fill("Audience"),
  ...Array(4).fill("Brand"),
  ...Array(4).fill("Proof"),
  ...Array(4).fill("Assets"),
  ...Array(4).fill("Funnel"),
  "Channels", "Channels", "Scope", "Scope",
  "Approvals", "Approvals", "Approvals",
];

let server;
let base;
let dbBackup = null;

before(async () => {
  if (fs.existsSync(DB_FILE)) dbBackup = fs.readFileSync(DB_FILE);
  const app = express();
  app.use(express.json());
  app.use("/api/onboarding", require("../routes/onboarding"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  server && server.close();
  if (dbBackup) fs.writeFileSync(DB_FILE, dbBackup);
  else if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
});

function post(body) {
  return fetch(base + "/api/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

// ---------- the questions ----------

test("31 questions, numbered 1-31, in the brief's topic order", () => {
  assert.equal(Q.VERSION, "campaign-v1");
  assert.equal(Q.QUESTIONS.length, 31);
  Q.QUESTIONS.forEach((q, i) => {
    assert.equal(q.n, i + 1);
    assert.equal(q.topic, DOC_TOPICS[i], `question ${q.n} topic`);
    assert.ok(q.q.endsWith("?"), `question ${q.n} reads as a question`);
    assert.ok(q.hint, `question ${q.n} has a client-facing hint`);
    assert.ok(q.fields.length >= 1, `question ${q.n} has a field`);
  });
  assert.deepEqual(Q.STEPS.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const s of Q.STEPS) {
    assert.ok(Q.QUESTIONS.some((q) => q.step === s.n), `step ${s.n} has questions`);
    assert.ok(s.short && s.title && s.desc, `step ${s.n} has its labels`);
  }
  // Steps run in question order: no step goes backwards.
  for (let i = 1; i < Q.QUESTIONS.length; i++) {
    assert.ok(Q.QUESTIONS[i].step >= Q.QUESTIONS[i - 1].step);
  }
});

test("field keys are unique, and choices have options", () => {
  const keys = [
    ...Q.QUESTIONS.flatMap((q) => q.fields.map((f) => f.key)),
    ...Q.CONTACT.map((f) => f.key),
  ];
  assert.equal(new Set(keys).size, keys.length);
  for (const q of Q.QUESTIONS) {
    for (const f of q.fields) {
      assert.match(f.key, /^q\d{2}(_[a-z0-9]+)?$/, f.key);
      assert.equal(f.key.slice(1, 3), String(q.n).padStart(2, "0"), `${f.key} belongs to question ${q.n}`);
      if (["radio", "checks", "select"].includes(f.type)) {
        assert.ok(Array.isArray(f.options) && f.options.length >= 2, `${f.key} options`);
      }
    }
  }
  for (const f of Q.CONTACT) assert.match(f.key, /^contact_/);
  for (const k of ["contact_name", "contact_email", "contact_method"]) {
    assert.ok(Q.CONTACT.find((f) => f.key === k).required, `${k} is required`);
  }
});

test("no question asks for a minor's name: who's on camera is roles only", () => {
  const q15 = Q.QUESTIONS[14];
  assert.ok(q15.fields.every((f) => f.type === "checks" || f.type === "radio"));
  assert.match(q15.hint, /no names/i);
  assert.match(Q.QUESTIONS[12].hint, /under 18/); // results: leave minors' names out
});

// ---------- Copy for TOJ ----------

test("Copy for TOJ: numbered answers, blanks stay blank, no contact details", () => {
  const md = Q.toMarkdown(
    {
      q01: "Summer camp, $199\nTeam film, $499",
      q05: ["Parents", "Coaches"],
      q21_url: "not built yet",
      q21_working: "No",
      contact_name: "Pat Example",
      contact_role: "Owner",
      contact_method: "Text",
    },
    { brand: "Acme Sports", received: "2026-10-22 21:00" }
  );
  assert.match(md, /^# Campaign intake: Acme Sports\n/);
  for (let n = 1; n <= 31; n++) assert.ok(md.includes(`\n${n}. `), `question ${n} is listed`);
  assert.ok(md.includes("1. What are you selling in this campaign, and what does it cost?\n   Answer: Summer camp, $199\n   Team film, $499"));
  assert.ok(md.includes("Answer: Parents, Coaches"));
  assert.ok(md.includes("Answer: Where it goes: not built yet · Working today? No"));
  assert.ok(md.includes("2. What is the one action you want people to take: book, buy, sign up or call?\n   Answer: (blank)"));
  assert.ok(!md.includes("Pat Example"), "no contact name");
  assert.ok(!md.includes("prefers"), "no contact preference");
});

test("payloadToProse can keep contact details out of the agent RAG", () => {
  const p = { q01: "Camp", contact_name: "Pat Example", contact_method: "Text" };
  // Default is unchanged (the Foundation Score intake still embeds everything).
  assert.match(payloadToProse(p), /contact name: Pat Example/);
  const prose = payloadToProse(p, { omit: /^contact_/ });
  assert.match(prose, /^q01: Camp$/);
  assert.ok(!/contact|Pat Example/.test(prose));
  // The onboarding route passes the contact filter when it embeds.
  assert.match(read("routes", "onboarding.js"), /payloadToProse\(row\.payload \|\| \{\}, \{ omit: CONTACT_KEYS \}\)/);
});

// ---------- where a submission goes ----------

test("a campaign intake is stored as TOJ's own business intake for the CRM", async () => {
  const body = {
    audience: "business",
    branch: "trail-of-joy",
    subject_name: "Acme Sports",
    is_minor: false,
    contact_email: "Pat@Example.com",
    contact_phone: "555-0100",
    payload: {
      q01: "Summer camp, $199",
      q09_name: "Acme Sports",
      q15_releases: "Some on file",
      contact_name: "Pat Example",
      contact_method: "Email",
    },
    intake_version: Q.VERSION,
    source: "/intake.html",
  };
  const r = await post(body);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.consent_status, "not_required");

  const row = JSON.parse(fs.readFileSync(DB_FILE, "utf8")).find((x) => x.id === r.body.id);
  assert.ok(row, "row saved");
  assert.equal(row.audience, "business");
  assert.equal(row.branch, "trail-of-joy");
  assert.equal(row.intake_version, "campaign-v1");
  assert.equal(row.subject_name, "Acme Sports");
  assert.equal(row.is_minor, false);
  assert.equal(row.consent_token, null);
  assert.equal(row.contact_email, "pat@example.com");
  assert.equal(row.status, "new");
  assert.equal(row.source, "/intake.html");
  assert.deepEqual(row.payload, body.payload);
});

test("a campaign intake without a usable email is refused", async () => {
  const r = await post({
    audience: "business",
    branch: "trail-of-joy",
    subject_name: "Acme Sports",
    contact_email: "not-an-email",
    payload: { q01: "Camp" },
    intake_version: Q.VERSION,
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_email");
});

// ---------- the site ----------

test("/intake.html is the campaign intake again; the Foundation Score keeps its own URL", () => {
  const v = JSON.parse(read("vercel.json"));
  assert.ok(!v.redirects.some((r) => r.source === "/intake.html"), "nothing redirects /intake.html away");
  assert.ok(v.redirects.some((r) => r.source === "/intake" && r.destination === "/intake.html"), "/intake short link");
  const srv = read("server.js");
  assert.ok(!/"\/intake\.html"\s*:\s*"\/foundation-score\.html"/.test(srv), "server.js no longer redirects it");
  assert.match(srv, /res\.redirect\(302, "\/intake\.html"\)/);
  assert.ok(fs.existsSync(path.join(ROOT, "public", "foundation-score.html")));
  assert.match(read("middleware.js"), /'score\.tojcampaign\.com': '\/foundation-score\.html'/);
});

test("the page submits as TOJ's own campaign intake", () => {
  const html = read("public", "intake.html");
  assert.match(html, /<script src="\/js\/campaign-intake-questions\.js"><\/script>/);
  assert.match(html, /<script src="\/js\/onboarding-submit\.js"><\/script>/);
  assert.match(html, /cfg\.audience = "business";/);
  assert.match(html, /cfg\.branch = "trail-of-joy";/);
  assert.match(html, /intake_version: Q\.VERSION/);
  assert.match(html, /is_minor: false/);
  assert.match(html, /source: "\/intake\.html"/);
  assert.match(html, /href="\/privacy\.html"/);
});

test("the Intake CRM shows campaign answers and copies them for TOJ", () => {
  const crm = read("public", "admin", "intake-crm.html");
  assert.match(crm, /<script src="\/js\/campaign-intake-questions\.js"><\/script>/);
  assert.match(crm, /Copy for TOJ/);
  assert.match(crm, /TOJ_CAMPAIGN_INTAKE\.toMarkdown\(/);
  assert.match(crm, /function escHtml\(/);
});

test("client-facing copy: no banned words, no other brands", () => {
  const BANNED = [
    "elite", "generational", "next-level", "next level", "phenom", "future star",
    "premier", "top-notch", "state-of-the-art", "revolutionize", "unlock", "unleash",
    "transform", "game-changing", "game changing", "supercharge", "guarantee", "exposure",
  ];
  // Other brands and clients stay off TOJ's public intake (brand walls).
  const OTHER_BRANDS = [
    "Ground Floor", "Groundfloor", "Subject Report", "Subject Media", "SubjectSkillz",
    "Pylon", "Optimum", "Battle", "Xpand", "0routez", "STLpipeline", "Margin Hooks",
  ];
  const page = read("public", "intake.html").replace(/<style[\s\S]*?<\/style>/g, "");
  const questions = JSON.stringify({ steps: Q.STEPS, questions: Q.QUESTIONS, contact: Q.CONTACT });
  for (const [name, text] of [["intake.html", page], ["campaign-intake-questions.js", questions]]) {
    for (const w of BANNED) {
      assert.ok(!new RegExp("\\b" + w + "\\b", "i").test(text), `"${w}" in ${name}`);
    }
    for (const b of OTHER_BRANDS) {
      assert.ok(!text.toLowerCase().includes(b.toLowerCase()), `"${b}" in ${name}`);
    }
  }
});
