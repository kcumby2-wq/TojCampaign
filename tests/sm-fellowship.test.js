// Fellowship applications: the form's rules, what alerts may say, the approval
// note, and the routes (in-process, on the fake Supabase).
//
//   node --test tests/sm-fellowship.test.js

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.ADMIN_EMAILS = "kyron@toj.test";
process.env.SM_BOOKINGS_SECRET = "test-secret-0123456789-abcdefgh";
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.FELLOWSHIP_PAY_TOOLS;
delete process.env.FELLOWSHIP_PAY_MEETINGS;

const express = require("express");
const session = require("express-session");
const F = require("../utils/sm-fellowship");
const { setSupabase } = require("../utils/supabase");
const { fakeSupabase } = require("./helpers/fake-supabase");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const router = require("../routes/sm-fellowship");

const SECRET = process.env.SM_BOOKINGS_SECRET;
const ID = "8f14e45f-ceea-467e-a1d0-6f1d4c6b2a01";
const adult = (over = {}) => ({
  name: "Jordan Reyes",
  email: "Jordan@Example.com",
  phone: "(555) 010-2030",
  handle: "@Jordan.Shoots",
  city: "Houston",
  state: "tx",
  age_group: "adult",
  seat: "shooter",
  plan: "tools",
  links: ["instagram.com/jordan.shoots", "http://vimeo.com/123456", ""],
  gear: "Sony a7 III, 70-200",
  about: "I shoot my brother's 7v7 games.\r\n\r\n\r\nI want to learn the sideline.",
  confirmed: true,
  ...over,
});
const teen = (over = {}) =>
  adult({
    name: "Riley Park",
    email: "riley@example.com",
    age_group: "teen",
    seat: "photographer",
    guardian_name: "Dana Park",
    guardian_email: "Dana@Example.com",
    guardian_phone: "555-010-4040",
    ...over,
  });

// ── The rules ────────────────────────────────────────────────────────────
test("a good adult application passes, cleaned up", () => {
  const { errors, value } = F.normalize(adult());
  assert.deepEqual(errors, []);
  assert.equal(value.email, "jordan@example.com");
  assert.equal(value.handle, "jordan.shoots");
  assert.equal(value.state, "TX");
  assert.equal(value.region, "south_central");
  assert.deepEqual(value.links, ["https://instagram.com/jordan.shoots", "https://vimeo.com/123456"]);
  assert.equal(value.about, "I shoot my brother's 7v7 games.\n\nI want to learn the sideline.");
  assert.equal(value.guardian_name, null);
  assert.equal(value.confirmed, true);
});

test("every missing or wrong field is named", () => {
  const { errors } = F.normalize({ email: "nope", phone: "12", handle: "no spaces allowed", state: "ZZ", age_group: "kid", links: ["javascript:alert(1)"] });
  for (const f of ["name", "email", "phone", "handle", "city", "state", "age_group", "link1", "confirmed"]) assert.ok(errors.includes(f), f);
});

test("odd JSON (objects, arrays, numbers) is treated as missing, never thrown on", () => {
  const evil = { toString: 1, valueOf: 1 };
  const raw = { name: evil, email: {}, phone: evil, handle: evil, city: ["x"], state: evil, age_group: evil, seat: evil, plan: evil, links: [evil, ["a"], 7], gear: evil, about: evil, confirmed: evil, guardian_name: evil };
  const { errors, value } = F.normalize(raw);
  for (const f of ["name", "email", "city", "state", "age_group", "confirmed"]) assert.ok(errors.includes(f), f);
  assert.equal(value.seat, "unsure");
  assert.equal(value.plan, "unsure");
  assert.doesNotThrow(() => F.normalize(null));
  assert.doesNotThrow(() => F.normalize([1, 2]));
  assert.doesNotThrow(() => F.normalize({ links: "https://a.co" }));
});

test("16 or 17: a parent or guardian on the application, with their own email", () => {
  const ok = F.normalize(teen());
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.guardian_email, "dana@example.com");
  const none = F.normalize(teen({ guardian_name: "", guardian_email: "" }));
  assert.ok(none.errors.includes("guardian_name") && none.errors.includes("guardian_email"));
  // The applicant's own address doesn't count as the guardian's.
  assert.ok(F.normalize(teen({ guardian_email: "RILEY@example.com" })).errors.includes("guardian_email"));
});

test("16 or 17: only the seats open at 16 or 17", () => {
  for (const seat of ["unsure", "shadow", "shooter", "photographer"]) assert.ok(!F.normalize(teen({ seat })).errors.includes("seat"), seat);
  for (const seat of ["lead", "editor", "story"]) assert.ok(F.normalize(teen({ seat })).errors.includes("seat"), seat);
  assert.deepEqual(F.normalize(adult({ seat: "lead" })).errors, []);
});

test("an adult's application carries no guardian, whatever was sent", () => {
  const { value } = F.normalize(adult({ guardian_name: "Someone", guardian_email: "someone@example.com", guardian_phone: "5550102030" }));
  assert.equal(value.guardian_name, null);
  assert.equal(value.guardian_email, null);
  assert.equal(value.guardian_phone, null);
});

test("links: https, a real host, no sign-in details, three at most", () => {
  assert.equal(F.linkOf("youtube.com/@jordan"), "https://youtube.com/@jordan");
  assert.equal(F.linkOf("HTTP://Example.com/a b"), "https://example.com/a%20b");
  assert.equal(F.linkOf("www.dropbox.com:443/s/abc"), "https://www.dropbox.com/s/abc");
  assert.equal(F.linkOf(""), "");
  for (const bad of ["javascript:alert(1)", "mailto:a@b.co", "data:text/html,hi", "https://user:pass@example.com/x", "https://localhost/x", "ftp://example.com/x", "https://" + "a".repeat(500) + ".com"]) {
    assert.equal(F.linkOf(bad), null, bad);
  }
  const { errors, value } = F.normalize(adult({ links: ["https://a.co/1", "nope", "https://a.co/1", "https://b.co/4"] }));
  assert.deepEqual(errors, ["link2"], "the link to fix is named by its place");
  assert.deepEqual(value.links, ["https://a.co/1"], "repeats count once; past three are ignored");
  assert.ok(F.normalize(adult({ links: ["", "", ""] })).errors.includes("link1"), "one link is needed");
});

test("handles: @name, name or a pasted Instagram link, for the credit line", () => {
  assert.deepEqual(F.handleOf("@Sky.Lens_"), { ok: true, value: "sky.lens_" });
  assert.deepEqual(F.handleOf("https://www.instagram.com/sky.lens/?hl=en"), { ok: true, value: "sky.lens" });
  assert.deepEqual(F.handleOf(""), { ok: true, value: null });
  assert.equal(F.handleOf("two words").ok, false);
});

test("a push carries fixed words only: no name, no city, nothing typed", () => {
  const a = { ...F.normalize(teen({ city: "Riley's Town" })).value, id: ID };
  const p = F.pushPayload(a);
  assert.equal(p.title, "New fellowship application");
  assert.equal(p.body, "Photographer · 16 or 17, guardian on file · TX");
  assert.equal(p.url, `/app/#application/${ID}`);
  const s = JSON.stringify(p);
  for (const typed of ["Riley", "Dana", "Houston", "example.com", "Sony"]) assert.ok(!s.includes(typed), typed);
});

test("the staff email names an adult; a 16- or 17-year-old's details stay in the app", () => {
  const a = { ...F.normalize(adult()).value, id: ID };
  const m = F.emailText(a, "https://app.test/");
  assert.match(m.subject, /^New fellowship application: Shooter, Houston, TX$/);
  assert.match(m.text, /From: Jordan Reyes \(18 or older\)/);
  assert.match(m.text, /Reach them: jordan@example.com, \(555\) 010-2030/);
  assert.match(m.text, new RegExp(`https://app.test/app/#application/${ID}`));
  assert.ok(!m.text.includes("instagram.com"), "links stay in the app");
  assert.ok(!m.text.includes("brother"), "what they wrote stays in the app");

  const t = { ...F.normalize(teen()).value, id: ID };
  const tm = F.emailText(t, "https://app.test");
  for (const hidden of ["Riley", "riley@", "Dana", "dana@", "555-010-4040", "instagram.com"]) assert.ok(!tm.text.includes(hidden) && !tm.subject.includes(hidden), hidden);
  assert.match(tm.text, /a 16- or 17-year-old, with a parent or guardian/);
});

test("when the database didn't take it, the email is the only copy and carries all of it", () => {
  const t = { ...F.normalize(teen()).value, id: "not-saved" };
  const m = F.emailText(t, "https://app.test", { saved: false });
  for (const shown of ["Riley Park", "riley@example.com", "Dana Park, dana@example.com, 555-010-4040", "https://instagram.com/jordan.shoots", "Sony a7 III", "sideline"]) assert.ok(m.text.includes(shown), shown);
  assert.match(m.text, /NOT in the app/);
});

test("the approval note: the plan's link carries the application and the payer's email", () => {
  const env = { FELLOWSHIP_PAY_TOOLS: "https://buy.stripe.com/test_tools", FELLOWSHIP_PAY_MEETINGS: "https://buy.stripe.com/test_meet" };
  const a = { ...F.normalize(adult()).value, id: ID };
  const n = F.approvalNote(a, env);
  assert.deepEqual(n.to, ["jordan@example.com"]);
  assert.equal(n.subject, "You're in: the Subject Medias creator fellowship");
  assert.equal(n.link, `https://buy.stripe.com/test_tools?client_reference_id=${ID}&prefilled_email=jordan%40example.com`);
  assert.match(n.text, /^Hi Jordan,/);
  assert.match(n.text, /Tools \+ Community, \$29 a month\. Month to month, cancel anytime\./);
  assert.ok(n.text.includes(n.link));
  assert.match(n.text, /background check and minor-safety training/);

  const t = { ...F.normalize(teen({ plan: "meetings" })).value, id: ID };
  const tn = F.approvalNote(t, env);
  assert.deepEqual(tn.to, ["dana@example.com", "riley@example.com"], "the guardian first, then the applicant");
  assert.match(tn.text, /^Hi Dana,/);
  assert.match(tn.text, /Riley's plan: Community \+ 2 Meetings a Week, \$79 a month/);
  assert.match(tn.link, /prefilled_email=dana%40example.com/, "the guardian pays");
  assert.match(tn.text, /always works beside a screened adult and never leads or edits/);
  assert.equal(tn.subject, "Riley is in: the Subject Medias creator fellowship");
});

test("the approval note without a link: both plans, or a promise of the link", () => {
  const unsure = F.approvalNote({ ...F.normalize(adult({ plan: "unsure" })).value, id: ID }, {});
  assert.equal(unsure.link, null);
  assert.match(unsure.text, /Tools \+ Community, \$29 a month: the dashboard/);
  assert.match(unsure.text, /Community \+ 2 Meetings a Week, \$79 a month: the community, plus two meetings every week/);
  const noLink = F.approvalNote({ ...F.normalize(adult()).value, id: ID }, { FELLOWSHIP_PAY_TOOLS: "http://not-https.example" });
  assert.equal(noLink.link, null, "only an https link is used");
  assert.match(noLink.text, /We'll send the payment link in our next email\./);
});

test("a note staff edit: a one-line subject and a body, capped", () => {
  assert.deepEqual(F.noteInput({ subject: "Hi\nthere", text: "Body\r\n\r\n\r\nend" }), { errors: [], value: { subject: "Hi there", text: "Body\n\nend" } });
  assert.deepEqual(F.noteInput({ subject: "", text: "x".repeat(4001) }).errors, ["subject", "text"]);
});

// ── The routes ───────────────────────────────────────────────────────────
let server, base, db, pushes, mails, mailAnswer;
const wait = () => new Promise((r) => setTimeout(r, 60));
async function call(method, path, body, headers = {}, cookie) {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data, cookie: r.headers.get("set-cookie") };
}
// The site's /api/apply function: the secret, and the visitor as Vercel saw them.
const apply = (body, visitor = "203.0.113.7") => call("POST", "/api/sm/fellowship", body, { "X-SM-Secret": SECRET, "X-SM-Visitor": visitor });
async function cookieFor(email, role = "staff") {
  const r = await call("POST", "/__test/session", { email, role });
  return r.cookie.split(";")[0];
}
const staffCookie = () => cookieFor("kyron@toj.test");

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "sm-fellowship-test", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => {
    req.session.userEmail = req.body.email;
    req.session.userRole = req.body.role;
    res.json({ ok: true });
  });
  app.use("/api/sm/fellowship", router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  push.setSender(async (sub, payload) => { pushes.push({ to: sub.email, payload }); return {}; });
  mailer.setSender(async (m) => { mails.push(m); return mailAnswer(m); });
});
after(() => { server && server.close(); push.setSender(null); mailer.setSender(null); setSupabase(null); });
beforeEach(() => {
  router._resetLimits();
  pushes = [];
  mails = [];
  mailAnswer = () => ({ sent: true });
  delete process.env.FELLOWSHIP_PAY_TOOLS;
  db = fakeSupabase(
    { push_subscriptions: [{ id: "p1", email: "kyron@toj.test", endpoint: "https://push.test/1", p256dh: "k", auth: "a", kind: "web", fail_count: 0 }] },
    { unique: { sm_fellowship_applications: ["email"] } }
  );
  setSupabase(db);
});
const rows = () => db.tables.sm_fellowship_applications || [];

test("the form saves an application and alerts staff by push and email", async () => {
  const r = await apply(adult());
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true }, "the answer carries nothing else");
  assert.equal(rows().length, 1);
  const row = rows()[0];
  assert.equal(row.status, "new");
  assert.equal(row.region, "south_central");
  await wait();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].to, "kyron@toj.test");
  assert.ok(!JSON.stringify(pushes[0].payload).includes("Jordan"));
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ["kyron@toj.test"]);
  assert.match(mails[0].text, /Jordan Reyes/);
  assert.ok(rows()[0].alerted_at);
});

test("only the site's call gets in; bots get a quiet yes and nothing is saved", async () => {
  assert.equal((await call("POST", "/api/sm/fellowship", adult(), { "X-SM-Visitor": "1.2.3.4" })).status, 401);
  assert.equal((await call("POST", "/api/sm/fellowship", adult(), { "X-SM-Secret": SECRET.slice(0, -1) + "x" })).status, 401);
  const bot = await apply(adult({ company: "Acme" }));
  assert.equal(bot.status, 200);
  assert.equal(rows().length, 0);
});

test("a wrong application comes back with the fields to fix", async () => {
  const r = await apply(teen({ guardian_email: "", seat: "lead", links: ["javascript:x"] }));
  assert.equal(r.status, 400);
  assert.deepEqual(r.data.fields.sort(), ["guardian_email", "link1", "seat"]);
  assert.equal(rows().length, 0);
});

test("one open application per address: a second one gets the same yes and no second alert", async () => {
  assert.equal((await apply(adult())).status, 200);
  await wait();
  const again = await apply(adult({ links: ["https://other.example/x"] }));
  assert.equal(again.status, 200);
  assert.deepEqual(again.data, { ok: true });
  await wait();
  assert.equal(rows().length, 1);
  assert.equal(pushes.length, 1);
});

test("five a visitor per 10 minutes, then too many", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await apply(adult({ email: `p${i}@example.com` }))).status, 200);
  assert.equal((await apply(adult({ email: "p6@example.com" }))).status, 429);
  assert.equal((await apply(adult({ email: "p7@example.com" }), "198.51.100.9")).status, 200, "another visitor still gets in");
});

test("the database down: the email carries the application, or the form is told to use email", async () => {
  setSupabase(null);
  const r = await apply(teen());
  assert.equal(r.status, 200);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /not saved/);
  assert.match(mails[0].text, /Riley Park/);
  mailAnswer = () => ({ sent: false, reason: "email_not_configured" });
  assert.equal((await apply(teen({ email: "riley2@example.com" }), "198.51.100.10")).status, 503);
});

test("staff only: the list carries no contact, links or what anyone wrote", async () => {
  await apply(teen());
  assert.equal((await call("GET", "/api/sm/fellowship")).status, 401);
  assert.equal((await call("GET", "/api/sm/fellowship", undefined, {}, await cookieFor("stranger@example.com", "creator"))).status, 403);
  const list = await call("GET", "/api/sm/fellowship", undefined, {}, await staffCookie());
  assert.equal(list.status, 200);
  const a = list.data.applications[0];
  assert.equal(a.summary, "Photographer · 16 or 17 · Houston, TX");
  assert.equal(a.links, 2);
  const s = JSON.stringify(list.data);
  for (const hidden of ["riley@", "dana", "555", "instagram", "Sony", "brother"]) assert.ok(!s.toLowerCase().includes(hidden.toLowerCase()), hidden);
});

test("one application: everything in it, and the approval note to send", async () => {
  process.env.FELLOWSHIP_PAY_TOOLS = "https://buy.stripe.com/test_tools";
  await apply(adult());
  const cookie = await staffCookie();
  const id = rows()[0].id;
  const one = await call("GET", "/api/sm/fellowship/" + id, undefined, {}, cookie);
  assert.equal(one.status, 200);
  assert.equal(one.data.application.email, "jordan@example.com");
  assert.equal(one.data.plans.tools.link_set, true);
  assert.equal(one.data.plans.meetings.link_set, false);
  assert.match(one.data.note.link, new RegExp(`client_reference_id=${id}`));
  assert.equal(one.data.email_ready, false);
  assert.equal((await call("GET", "/api/sm/fellowship/not-a-uuid", undefined, {}, cookie)).status, 404);
  assert.equal((await call("GET", "/api/sm/fellowship/" + ID, undefined, {}, cookie)).status, 404);
});

test("status and a private note; approving stamps who and when", async () => {
  await apply(adult());
  const cookie = await staffCookie();
  const id = rows()[0].id;
  const patch = (body) => call("PATCH", "/api/sm/fellowship/" + id, body, {}, cookie);
  assert.equal((await patch({ status: "maybe" })).status, 400);
  assert.equal((await patch({})).status, 400);
  const ok = await patch({ status: "approved", staff_note: "Strong sideline work.\nCall Tuesday." });
  assert.equal(ok.status, 200);
  assert.equal(rows()[0].status, "approved");
  assert.ok(rows()[0].approved_at);
  assert.equal(rows()[0].status_by, "kyron@toj.test");
  assert.equal(rows()[0].staff_note, "Strong sideline work.\nCall Tuesday.");
  const first = rows()[0].approved_at;
  await patch({ status: "talking" });
  await patch({ status: "joined" });
  assert.equal(rows()[0].approved_at, first, "the first approval keeps its time");
  assert.equal((await patch({ staff_note: "x".repeat(1001) })).status, 400);
  await patch({ staff_note: "" });
  assert.equal(rows()[0].staff_note, null);
  assert.equal((await call("GET", "/api/sm/fellowship", undefined, {}, cookie)).data.applications.length, 0, "joined isn't open");
  assert.equal((await call("GET", "/api/sm/fellowship?all=1", undefined, {}, cookie)).data.applications.length, 1);
});

test("the approval note goes to the people on the application, never to anyone the request names", async () => {
  await apply(teen());
  await wait();
  mails = [];
  const cookie = await staffCookie();
  const id = rows()[0].id;
  const send = (body) => call("POST", `/api/sm/fellowship/${id}/note`, body, {}, cookie);
  assert.equal((await send({})).status, 409, "approve it first");
  await call("PATCH", "/api/sm/fellowship/" + id, { status: "approved" }, {}, cookie);
  const r = await send({ to: ["thief@evil.example"], cc: "x@evil.example", subject: "Riley is in", text: "Edited by Kyron." });
  assert.equal(r.status, 200);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ["dana@example.com", "riley@example.com"]);
  assert.equal(mails[0].subject, "Riley is in");
  assert.equal(mails[0].text, "Edited by Kyron.");
  assert.ok(rows()[0].emailed_at);
  // Nothing edited: the drafted note goes as it is.
  await send({});
  assert.match(mails[1].text, /^Hi Dana,/);
  assert.equal((await send({ subject: "" })).status, 400);
});

test("no email set up on the server: the note isn't marked sent and the app is told why", async () => {
  await apply(adult());
  const cookie = await staffCookie();
  const id = rows()[0].id;
  await call("PATCH", "/api/sm/fellowship/" + id, { status: "approved" }, {}, cookie);
  mailAnswer = () => ({ sent: false, reason: "email_not_configured" });
  const r = await call("POST", `/api/sm/fellowship/${id}/note`, {}, {}, cookie);
  assert.equal(r.status, 503);
  assert.equal(r.data.error, "email_not_configured");
  assert.equal(rows()[0].emailed_at, undefined);
  mailAnswer = () => { throw new Error("smtp down"); };
  assert.equal((await call("POST", `/api/sm/fellowship/${id}/note`, {}, {}, cookie)).data.error, "email_failed");
});

test("removing an application takes all of it", async () => {
  await apply(teen());
  const cookie = await staffCookie();
  const id = rows()[0].id;
  assert.equal((await call("DELETE", "/api/sm/fellowship/" + id)).status, 401);
  assert.equal((await call("DELETE", "/api/sm/fellowship/" + id, undefined, {}, cookie)).status, 200);
  assert.equal(rows().length, 0);
  assert.equal((await call("DELETE", "/api/sm/fellowship/" + id, undefined, {}, cookie)).status, 404);
});

test("before migration 032 the app says it isn't set up yet", async () => {
  const missing = { data: null, error: { code: "42P01", message: 'relation "sm_fellowship_applications" does not exist' } };
  const q = { select: () => q, order: () => q, limit: () => q, in: () => q, eq: () => q, maybeSingle: () => q, then: (res) => Promise.resolve(missing).then(res) };
  setSupabase({ from: () => q });
  const cookie = await staffCookie();
  const r = await call("GET", "/api/sm/fellowship", undefined, {}, cookie);
  assert.equal(r.status, 503);
  assert.equal(r.data.error, "not_set_up");
});
