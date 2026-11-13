// A speaker's own page, against migrations 039–043 in a real Postgres: a link
// goes only to an email a card names (and the answer is the same either way),
// the page shows only that person's films, the cuts they're in, their own
// words, and nothing about anyone else, and taking consent back from it is
// the same pull staff make, only with a live link and only for their own
// person, once.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_studio_speaker_test), which it DROPS and recreates.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const crypto = require("crypto");

const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = "gfs_studio_speaker_test";
if (!URL_) {
  test("studio speaker page (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}
process.env.ADMIN_EMAILS = "kyron@toj.test";
process.env.STUDIO_SITE_BASE = "https://www.tojcampaign.com";
delete process.env.STUDIO_REVIEW_REPLY_TO;

const express = require("express");
const session = require("express-session");
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { fakeStorage } = require("./helpers/fake-storage");
const { setSupabase } = require("../utils/supabase");
const mailer = require("../utils/mailer");
const push = require("../utils/push");
const T = require("../utils/team");
const U = require("../utils/studio-films");
const W = require("../utils/studio-review-worker");
const speakerRouter = require("../routes/studio-speaker");

let pool, sb, store, server, base;
let mails = [];
let mailOk = true;
const cookies = {};
const as = { kyron: "kyron@toj.test", lead: "lead@toj.test", dir: "dir@toj.test", ed: "ed@toj.test" };

before(async () => {
  pool = await makeSchema(URL_, SCHEMA, ["018_studio_kits.sql", "019_team.sql", "020_native_push.sql", "039_studio_films.sql", "040_studio_craft.sql", "041_studio_words.sql", "043_studio_speaker.sql"]);
  sb = pgSupabase(pool, SCHEMA);
  store = fakeStorage();
  sb.storage = store;
  setSupabase(sb);
  await pool.query(`insert into team_members (email, role, tools) values
    ('lead@toj.test', 'approver', array['studio']), ('dir@toj.test', 'member', array['studio']), ('ed@toj.test', 'member', array['studio'])`);
  mailer.setSender(async (m) => {
    if (!mailOk) return { sent: false, reason: "email_not_configured" };
    mails.push(m);
    return { sent: true };
  });
  push.setSender(async () => ({}));
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(session({ secret: "speaker", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.email === as.kyron ? "staff" : "user"; res.json({ ok: true }); });
  app.use("/api/studio-films", require("../routes/studio-films"));
  app.use("/api/studio-review", require("../routes/studio-review"));
  app.use("/api/studio-speaker", speakerRouter);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of Object.entries(as)) {
    const r = await fetch(base + "/__test/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    cookies[k] = r.headers.get("set-cookie").split(";")[0];
  }
  const on = await films("POST", "/tools/review_copies", { on: true, note: "Supabase Storage terms checked: no training on stored files." }, "kyron");
  assert.equal(on.status, 200, JSON.stringify(on.data));
});
after(async () => {
  server && server.close();
  mailer.setSender(null);
  push.setSender(null);
  setSupabase(null);
  if (pool) await pool.end();
});
beforeEach(() => {
  T.forget();
  mails = [];
  mailOk = true;
  speakerRouter._reset();
  require("../routes/studio-review")._reset();
});

async function call(method, path, body, who = "kyron") {
  const r = await fetch(base + path, { method, headers: { Cookie: cookies[who], ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
const films = (method, path, body, who) => call(method, "/api/studio-films" + path, body, who);
async function pub(area, path, body, headers = {}) {
  const r = await fetch(base + `/api/${area}` + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
const page = (path, body, headers) => pub("studio-speaker", path, body, headers);
const reviewer = (path, body) => pub("studio-review", path, body);
const ok = (r, what) => { assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tokenFrom = (m) => (/#t=([0-9a-f]{64})/.exec(m.text) || [])[1];
async function step(id, key, who, extra = {}) { return ok(await films("POST", `/films/${id}/steps/${key}/done`, extra, who), key); }
async function mailTo(address, re = /./) {
  for (let i = 0; i < 40; i++) {
    const m = mails.find((x) => x.to.includes(address) && re.test(x.subject));
    if (m) return m;
    await wait(25);
  }
  return null;
}
async function linkFor(email) {
  ok(await page("/send-link", { email }), "send link");
  const m = await mailTo(email, /Your Same Work page/);
  assert.ok(m, "the page link went out");
  return tokenFrom(m);
}

// ffmpeg stood in: what the worker would make, without making it.
const fakeMedia = {
  ...require("../utils/sm-market-media"),
  async probe() { return { duration_ms: 75000, width: 1080, height: 1920 }; },
  async run(args) { const out = args[args.length - 1]; fs.writeFileSync(out, Buffer.from("made:" + out)); return { code: 0, stderr: "" }; },
};
async function uploadCut(film, { people, version }) {
  const file_name = `SW_YTH_${film.athlete_id}_HERO_9x16_v0${version}_20261117.mp4`;
  const up = ok(await films("POST", `/films/${film.id}/cuts/upload`, { format: "hero", ratio: "9x16", version, file_name, bytes: 4096, people }, "ed"), "upload link");
  store.put(U.BUCKET, up.key, Buffer.alloc(4096, version), "video/mp4");
  const reg = ok(await films("POST", `/films/${film.id}/cuts`, { id: up.id, key: up.key, format: "hero", ratio: "9x16", version, file_name, bytes: 4096, people }, "ed"), "register cut");
  const pass = await W.drain({ media: fakeMedia, fetch: store.serve });
  assert.equal(pass.results.find((x) => x.id === reg.cut.id).ok, true, JSON.stringify(pass));
  return reg.cut;
}
async function approve(film, cut, person, name) {
  mails = [];
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: person.id }, "lead"), "review link");
  const token = tokenFrom(mails[0]);
  assert.equal((await reviewer("/decide", { token, decision: "approved", name, confirm: true })).status, 200);
  await wait(60);
}

let n = 0;
async function aFilm(cards) {
  const code = "S" + String(1000 + ++n);
  let film = ok(await films("POST", "/films", { kit_slug: "same-work", title: `${code} hero`, lane: "youth", athlete_id: code, format: "hero" }, "lead"), "start").film;
  film = ok(await films("PATCH", `/films/${film.id}`, { seen: film.updated_at, director_email: "dir@toj.test", editor_email: "ed@toj.test", one_sentence: "The same drill, years apart, at the same hour." }, "lead"), "crew").film;
  const people = [];
  for (const c of cards(code)) {
    let p = ok(await films("POST", `/films/${film.id}/people`, c, "lead"), "card").person;
    p = ok(await films("POST", `/films/${film.id}/people/${p.id}/clear`, { seen: p.updated_at }, "lead"), "clear").person;
    people.push(p);
  }
  return { film, people, code };
}
const self = (code, name, email, extra = {}) => ({ person_code: code, name, role: "coach", speaker: true, release_on_file: true, covers: { face: true, name: true, voice: true, formats: ["hero"] }, reviewer_relation: "self", reviewer_name: name, reviewer_email: email, ...extra });

test("a page link goes only to an email a card names, and the answer is the same either way", async () => {
  // Nobody on a card: the same answer, and nothing is sent or kept.
  const before = (await pool.query("select count(*)::int as n from studio_speaker_links")).rows[0].n;
  assert.deepEqual(ok(await page("/send-link", { email: "nobody@x.test" }), "stranger"), { ok: true });
  await wait(150);
  assert.equal(mails.length, 0);
  assert.equal((await pool.query("select count(*)::int as n from studio_speaker_links")).rows[0].n, before);

  await aFilm(() => [self("C2001", "Alex Doe", "alex@x.test")]);
  assert.deepEqual(ok(await page("/send-link", { email: " Alex@X.test " }), "on a card"), { ok: true });
  const m = await mailTo("alex@x.test", /Your Same Work page/);
  assert.ok(m);
  assert.equal(m.replyTo, "alex@x.test", "a reply quotes the link: it goes back to them, never to staff");
  assert.match(m.text, /https:\/\/www\.tojcampaign\.com\/my-films\.html#t=[0-9a-f]{64}/);
  assert.match(m.text, /7 days/);
  assert.doesNotMatch(m.text, /Alex|Doe|C2001/);
  const token = tokenFrom(m);
  // The database keeps the hash of the token's hash, never the token.
  const row = (await pool.query("select * from studio_speaker_links where email = 'alex@x.test'")).rows[0];
  assert.equal(row.proof_hash, U.sha256(U.sha256(token)));
  assert.equal(row.sent_by, "self");
  assert.ok(Math.abs(new Date(row.expires_at) - new Date(row.created_at) - 7 * 86400000) < 2000);
  assert.ok(!JSON.stringify(row).includes(token));

  const view = ok(await page("/view", { token }), "view");
  assert.deepEqual(view.people.map((p) => [p.code, p.relation, p.is_minor]), [["C2001", "self", false]]);

  // A new link stops the old one.
  mails = [];
  const token2 = await linkFor("alex@x.test");
  assert.notEqual(token2, token);
  assert.equal((await page("/view", { token })).status, 404);
  ok(await page("/view", { token: token2 }), "the new link works");

  // Three links a day per email (two used above), the same answer for any email.
  assert.equal((await page("/send-link", { email: "alex@x.test" })).status, 200);
  assert.equal((await page("/send-link", { email: "alex@x.test" })).status, 429);
  assert.equal((await page("/send-link", { email: "not-an-email" })).status, 400);

  // Only JSON posts from the site's own pages.
  assert.equal((await fetch(base + "/api/studio-speaker/view")).status, 405);
  assert.equal((await fetch(base + "/api/studio-speaker/view", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await page("/view", { token: token2 }, { Origin: "https://elsewhere.example" })).status, 403);
  assert.equal((await page("/view", { token: "abc" })).status, 404);
  assert.equal((await page("/view", { token: crypto.randomBytes(32).toString("hex") })).status, 404);
});

test("a link that couldn't be emailed is stopped at once", async () => {
  await aFilm(() => [self("C2101", "Lane Moss", "lane@x.test")]);
  speakerRouter._reset();
  mailOk = false;
  assert.deepEqual(ok(await page("/send-link", { email: "lane@x.test" }), "same answer"), { ok: true });
  let rows = [];
  for (let i = 0; i < 40 && !(rows[0] && rows[0].revoked_at); i++) {
    await wait(25);
    rows = (await pool.query("select revoked_at from studio_speaker_links where email = 'lane@x.test'")).rows;
  }
  assert.equal(rows.length, 1);
  assert.ok(rows[0].revoked_at, "no email, no live link");
});

test("the page shows only their own films, the cuts they're in, their own words, and nothing about anyone else", async () => {
  const { film, people, code } = await aFilm((c) => [
    self("C3001", "Alex Doe", "alex3@x.test"),
    { person_code: c, name: "Kim Stone", role: "athlete", is_minor: true, speaker: true, release_on_file: true, covers: { voice: true, formats: ["hero"] }, reviewer_relation: "parent", reviewer_name: "Pat Stone", reviewer_email: "pat3@family.test" },
    { person_code: "C3002", name: "Sam Okafor", role: "coach", release_on_file: true, covers: { voice: true, formats: ["hero"] }, reviewer_relation: "self", reviewer_name: "Sam Okafor", reviewer_email: "sam3@x.test" },
  ]);
  const [alex, kim] = people;
  // The film up to its cuts.
  await step(film.id, "brief", "lead");
  await step(film.id, "board", "dir");
  await step(film.id, "clearance", "lead");
  await step(film.id, "shoot", "dir");
  await step(film.id, "selects", "dir");
  await step(film.id, "rough_cut", "ed");
  const both = await uploadCut(film, { people: [alex.id, kim.id], version: 3 });
  const kimOnly = await uploadCut(film, { people: [kim.id], version: 4 });
  await approve(film, both, alex, "Alex Doe");
  await approve(film, both, kim, "Pat Stone");
  await approve(film, kimOnly, kim, "Pat Stone");
  await step(film.id, "speaker_review", "lead", { cut_ids: [both.id, kimOnly.id] });
  await step(film.id, "rights_check", "lead");
  ok(await films("POST", `/films/${film.id}/second-yes`, { note: "Hooks said yes by text, Nov 17" }, "lead"), "second yes");
  await step(film.id, "final_signoff", "lead");
  ok(await films("POST", `/films/${film.id}/posts`, { cut_id: both.id, platform: "instagram", url: "https://instagram.com/p/both" }, "kyron"), "post 1");
  ok(await films("POST", `/films/${film.id}/posts`, { cut_id: kimOnly.id, platform: "tiktok", url: "https://tiktok.com/@sw/video/kim" }, "kyron"), "post 2");
  await step(film.id, "publish", "kyron");
  // Alex's words: a line, and a caption written around another line.
  const cues = [{ n: 1, s: 0, e: 4000, t: "I ran this drill before sunrise every day." }, { n: 2, s: 4000, e: 9000, t: "The work is the same work, wherever you are." }];
  const tr = (await pool.query("insert into studio_transcripts (film_id, person_id, label, cues, cue_count, words, duration_ms, created_by) values ($1, $2, 'Interview 1', $3::jsonb, 2, 18, 9000, 'ed@toj.test') returning id", [film.id, alex.id, JSON.stringify(cues)])).rows[0].id;
  await pool.query("insert into studio_words (film_id, kind, transcript_id, from_cue, to_cue, quote, start_ms, end_ms, made_by, created_by) values ($1, 'line', $2, 2, 2, 'The work is the same work, wherever you are.', 4000, 9000, 'claude', 'ed@toj.test')", [film.id, tr]);
  await pool.query("insert into studio_words (film_id, kind, transcript_id, from_cue, to_cue, quote, start_ms, end_ms, text, made_by, created_by) values ($1, 'caption', $2, 1, 1, 'I ran this drill before sunrise every day.', 0, 4000, $3, 'claude', 'ed@toj.test')", [film.id, tr, "“I ran this drill before sunrise every day.” Sunday mornings at the old track."]);

  // Alex: his card, the cut he's in, his own words as he said them.
  const a = ok(await page("/view", { token: await linkFor("alex3@x.test") }), "alex");
  assert.equal(a.people.length, 1);
  const ap = a.people[0];
  assert.deepEqual([ap.code, ap.relation, ap.is_minor, ap.pulled, ap.takedown], ["C3001", "self", false, false, null]);
  const af = ap.films[0];
  assert.deepEqual([af.format, af.state, af.state_label, af.cleared, af.waiting_for_you], ["Hero film", "published", "Done", true, false]);
  assert.deepEqual(af.covers, { face: true, name: true, jersey: false, voice: true });
  assert.deepEqual(af.approvals.map((x) => [x.cut, x.decision, x.withdrawn]), [["hero 9:16 v3", "approved", false]]);
  assert.deepEqual(af.posts.map((x) => [x.platform, x.url, x.removed]), [["instagram", "https://instagram.com/p/both", false]]);
  assert.deepEqual(af.words.map((w) => w.quote), ["I ran this drill before sunrise every day.", "The work is the same work, wherever you are."]);
  assert.ok(af.words.every((w) => typeof w.at === "string" && w.at.length));
  const aj = JSON.stringify(a);
  for (const not of ["Alex", "Doe", "Kim", "Stone", "Pat", "Sam", "Okafor", code, "C3002", "tiktok", `${code} hero`, "Sunday", "pat3@", "sam3@", "SW_YTH"]) assert.ok(!aj.includes(not), `Alex's page shows ${not}`);

  // Pat: Kim's films and both of Kim's cuts, and no words (adults first).
  const p = ok(await page("/view", { token: await linkFor("pat3@family.test") }), "pat");
  const pp = p.people[0];
  assert.deepEqual([pp.code, pp.relation, pp.is_minor], [code, "parent", true]);
  assert.deepEqual(pp.films[0].approvals.map((x) => x.cut), ["hero 9:16 v3", "hero 9:16 v4"]);
  assert.deepEqual(pp.films[0].posts.map((x) => x.platform).sort(), ["instagram", "tiktok"]);
  assert.deepEqual(pp.films[0].covers, { face: false, name: false, jersey: false, voice: true });
  assert.deepEqual(pp.films[0].words, []);
  const pj = JSON.stringify(p);
  for (const not of ["Alex", "Doe", "Kim", "Stone", "Pat", "Sam", "C3001", "C3002", "same work, wherever", "alex3@"]) assert.ok(!pj.includes(not), `Pat's page shows ${not}`);

  // Sam is on the film but in no cut: the film, and nothing posted.
  const s = ok(await page("/view", { token: await linkFor("sam3@x.test") }), "sam");
  assert.deepEqual([s.people[0].films.length, s.people[0].films[0].approvals.length, s.people[0].films[0].posts.length, s.people[0].films[0].words.length], [1, 0, 0, 0]);
});

test("a review copy waiting on them shows, without its link", async () => {
  const { film, people } = await aFilm(() => [self("C3501", "Remy Vance", "remy@x.test")]);
  await step(film.id, "brief", "lead");
  await step(film.id, "board", "dir");
  await step(film.id, "clearance", "lead");
  await step(film.id, "shoot", "dir");
  await step(film.id, "selects", "dir");
  await step(film.id, "rough_cut", "ed");
  const cut = await uploadCut(film, { people: [people[0].id], version: 3 });
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: people[0].id }, "lead"), "review link");
  const v = ok(await page("/view", { token: await linkFor("remy@x.test") }), "view");
  assert.equal(v.people[0].films[0].waiting_for_you, true);
  assert.equal(v.people[0].films[0].state, "active");
  assert.doesNotMatch(JSON.stringify(v), /film-review|#t=|link_hash/);
});

test("taking consent back from the page: only with a live link, only for their own person, once", async () => {
  const { film, people } = await aFilm(() => [self("C4001", "Lee Moe", "lee@x.test"), self("C4002", "Max Rowe", "max@x.test")]);
  const token = await linkFor("lee@x.test");
  const stranger = crypto.randomBytes(32).toString("hex");
  // No live link: nothing else is answered, even about a note.
  assert.equal((await page("/pull", { token: stranger, person_code: "C4002", confirm: true, note: "Max Rowe asked" })).status, 404);
  assert.equal((await page("/pull", { token: "short", person_code: "C4001", confirm: true })).status, 404);
  assert.equal((await page("/pull", { token, person_code: "C4001" })).data.error, "confirm_first");
  // Someone else's person: refused, and they're untouched.
  assert.equal((await page("/pull", { token, person_code: "C4002", confirm: true })).data.error, "not_yours");
  assert.equal((await page("/pull", { token, person_code: "ZZ999", confirm: true })).data.error, "not_yours");
  assert.equal((await pool.query("select count(*)::int as n from studio_film_people where consent_pulled_at is not null and film_id = $1", [film.id])).rows[0].n, 0);

  // A note with a name in it isn't refused (the page can't be used to check
  // a name): it's kept with the code instead.
  mails = [];
  const r = ok(await page("/pull", { token, person_code: "c4001", confirm: true, note: "Lee Moe changed his mind about being filmed." }), "pull");
  assert.ok(r.due_at);
  const td = (await pool.query("select * from studio_takedowns where person_code = 'C4001'")).rows[0];
  assert.deepEqual([td.source, td.requested_by], ["speaker", "the speaker, on their page"]);
  assert.equal(new Date(td.due_at) - new Date(td.requested_at), 72 * 3600 * 1000);
  const cards = (await pool.query("select person_code, consent_pulled_at, pulled_by from studio_film_people where film_id = $1 order by person_code", [film.id])).rows;
  assert.ok(cards[0].consent_pulled_at);
  assert.equal(cards[0].pulled_by, "the speaker, on their page");
  const kept = (await pool.query("select pulled_note from studio_film_people where film_id = $1 and person_code = 'C4001'", [film.id])).rows[0].pulled_note;
  assert.match(kept, /^C4001 changed his mind/);
  assert.doesNotMatch(kept, /Lee|Moe/);
  assert.equal(cards[1].consent_pulled_at, null, "Max is untouched");
  assert.ok((await pool.query("select pulled_at from studio_films where id = $1", [film.id])).rows[0].pulled_at, "the film stops");
  // Staff hear at once, as mail that must go, with the code and no name.
  const alert = await mailTo("kyron@toj.test", /Consent taken back: C4001/);
  assert.ok(alert);
  assert.equal(alert.critical, true);
  assert.doesNotMatch(alert.text, /Lee|Moe|lee@/);
  // Once.
  assert.equal((await page("/pull", { token, person_code: "C4001", confirm: true })).data.error, "already_taken_back");
  assert.equal((await pool.query("select count(*)::int as n from studio_takedowns where person_code = 'C4001'")).rows[0].n, 1);
  // The page says where it stands.
  const v = ok(await page("/view", { token }), "view after");
  assert.deepEqual([v.people[0].pulled, v.people[0].takedown.by_speaker, v.people[0].films[0].state], [true, true, "pulled"]);
  // Signing out stops the link.
  ok(await page("/sign-out", { token }), "sign out");
  assert.equal((await page("/view", { token })).status, 404);
  assert.equal((await page("/pull", { token, person_code: "C4001", confirm: true })).status, 404);
  assert.deepEqual(ok(await page("/sign-out", { token }), "again"), { ok: true });
});

test("two taps at once are one pull", async () => {
  await aFilm(() => [self("C4501", "Noor Vale", "noor@x.test")]);
  const token = await linkFor("noor@x.test");
  mails = [];
  const [a, b] = await Promise.all([page("/pull", { token, person_code: "C4501", confirm: true }), page("/pull", { token, person_code: "C4501", confirm: true })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  await wait(100);
  assert.equal(mails.filter((m) => /Consent taken back/.test(m.subject)).length, 1);
});

test("the producer sends the page from a card", async () => {
  const { film, people } = await aFilm(() => [self("C5001", "Ira Penn", "ira@x.test"), { person_code: "C5002", name: "Jo Park", role: "coach", release_on_file: true, covers: { voice: true, formats: ["hero"] } }]);
  assert.equal((await films("POST", `/films/${film.id}/people/${people[0].id}/page-link`, {}, "dir")).data.error, "producer_only");
  assert.equal((await films("POST", `/films/${film.id}/people/${people[1].id}/page-link`, {}, "lead")).data.error, "no_reviewer");
  ok(await films("POST", `/films/${film.id}/people/${people[0].id}/page-link`, {}, "lead"), "send");
  const m = mails.find((x) => x.to.includes("ira@x.test"));
  assert.ok(m);
  assert.match(m.text, /my-films\.html#t=/);
  assert.equal((await pool.query("select sent_by from studio_speaker_links where email = 'ira@x.test'")).rows[0].sent_by, "lead@toj.test");
  const act = JSON.stringify((await pool.query("select * from team_activity where action = 'sent_page_link'")).rows);
  assert.match(act, /C5001/);
  assert.doesNotMatch(act, /Ira|Penn|ira@x/);
  // No email, no link.
  mailOk = false;
  const r = await films("POST", `/films/${film.id}/people/${people[0].id}/page-link`, {}, "lead");
  assert.deepEqual([r.status, r.data.error], [502, "email_not_set_up"]);
  const live = (await pool.query("select count(*)::int as n from studio_speaker_links where email = 'ira@x.test' and revoked_at is null and expires_at > now()")).rows[0].n;
  assert.equal(live, 1, "the unsent link is stopped, and the one they have still works");
});

test("the database keeps every link as it was made, and only the server reaches it", async () => {
  const proof = U.sha256(crypto.randomBytes(32).toString("hex"));
  const id = (await pool.query("insert into studio_speaker_links (email, proof_hash, sent_by, expires_at, revoked_at) values ('db@x.test', $1, 'self', now() + interval '1 year', now()) returning *", [U.sha256(proof)])).rows[0];
  assert.equal(id.revoked_at, null, "a new link is live");
  assert.ok(new Date(id.expires_at) - Date.now() < 7 * 86400000 + 5000, "and lasts 7 days, whatever was asked");
  assert.equal((await pool.query("select studio_speaker_email($1) as e", [proof])).rows[0].e, "db@x.test");
  await assert.rejects(pool.query("delete from studio_speaker_links where id = $1", [id.id]), /kept/);
  await assert.rejects(pool.query("update studio_speaker_links set email = 'other@x.test' where id = $1", [id.id]), /as it was made/);
  await assert.rejects(pool.query("update studio_speaker_links set expires_at = now() + interval '1 year' where id = $1", [id.id]), /as it was made/);
  await assert.rejects(pool.query("truncate studio_speaker_links"));
  assert.equal((await pool.query("select studio_speaker_sign_out($1) as s", [proof])).rows[0].s, true);
  await assert.rejects(pool.query("update studio_speaker_links set revoked_at = null where id = $1", [id.id]), /stays stopped/);
  assert.equal((await pool.query("select studio_speaker_email($1) as e", [proof])).rows[0].e, null);
  assert.equal((await pool.query("select studio_speaker_sign_out($1) as s", [proof])).rows[0].s, false);
  // The browser-facing roles have nothing; the server's role runs the functions.
  for (const role of ["anon", "authenticated"]) {
    const t = (await pool.query(`select has_table_privilege($1, '${SCHEMA}.studio_speaker_links', 'select') as s`, [role])).rows[0].s;
    assert.equal(t, false, role);
    for (const fn of ["studio_speaker_email(text)", "studio_speaker_sign_out(text)", "studio_speaker_supersede(text)", "studio_speaker_pull(text, text, text)"]) {
      assert.equal((await pool.query(`select has_function_privilege($1, '${SCHEMA}.${fn}', 'execute') as x`, [role])).rows[0].x, false, `${role} ${fn}`);
    }
  }
  assert.equal((await pool.query(`select has_function_privilege('service_role', '${SCHEMA}.studio_speaker_pull(text, text, text)', 'execute') as x`)).rows[0].x, true);
  assert.equal((await pool.query(`select has_table_privilege('service_role', '${SCHEMA}.studio_speaker_links', 'truncate') as x`)).rows[0].x, false);
});

test("an ask that can't be emailed leaves the working link; a sent one stops the older; two at once leave one", async () => {
  await aFilm(() => [self("C6001", "Ada Quill", "ada@x.test")]);
  const first = await linkFor("ada@x.test");
  // Anyone can ask for the address: with mail down, the link they have stays.
  mailOk = false;
  ok(await page("/send-link", { email: "ada@x.test" }), "ask, mail down");
  await wait(120);
  assert.equal((await page("/view", { token: first })).status, 200, "the working link still works");
  mailOk = true;
  speakerRouter._reset();
  mails = [];
  const second = await linkFor("ada@x.test");
  await wait(100);
  assert.equal((await page("/view", { token: first })).status, 404, "a sent link stops the older one");
  assert.equal((await page("/view", { token: second })).status, 200);
  // Two made at the same moment: one stays live, the later one.
  speakerRouter._reset();
  mails = [];
  await Promise.all([page("/send-link", { email: "ada@x.test" }), page("/send-link", { email: "ada@x.test" })]);
  await wait(200);
  const live = (await pool.query("select count(*)::int as n from studio_speaker_links where email = 'ada@x.test' and revoked_at is null and expires_at > now()")).rows[0].n;
  assert.equal(live, 1);
});

test("after a new consent, the page offers to take it back again, and the old takedown is history", async () => {
  const { film } = await aFilm(() => [self("C6101", "Bo Lark", "bo@x.test")]);
  const token = await linkFor("bo@x.test");
  ok(await page("/pull", { token, person_code: "C6101", confirm: true }), "pull");
  // Everything on the takedown is done, so it closes.
  for (const it of (await pool.query("select i.id from studio_takedown_items i join studio_takedowns t on t.id = i.takedown_id where t.person_code = 'C6101' and i.done_at is null")).rows) {
    ok(await films("POST", `/takedown-items/${it.id}/done`, {}, "lead"), "item done");
  }
  assert.ok((await pool.query("select closed_at from studio_takedowns where person_code = 'C6101'")).rows[0].closed_at, "the takedown closed");
  // The producer records the new consent on a new card, on a new film.
  let film2 = ok(await films("POST", "/films", { kit_slug: "same-work", title: "C6101 again", lane: "youth", athlete_id: "C6101", format: "hero" }, "lead"), "start").film;
  const add = await films("POST", `/films/${film2.id}/people`, { ...self("C6101", "Bo Lark", "bo@x.test"), reconsent_note: "Signed a new release in person with the producer" }, "lead");
  const p2 = ok(add, "new card with new consent").person;
  ok(await films("POST", `/films/${film2.id}/people/${p2.id}/clear`, { seen: p2.updated_at }, "lead"), "clear");
  const v = ok(await page("/view", { token }), "view");
  assert.deepEqual([v.people[0].pulled, v.people[0].live], [false, true]);
  assert.ok(v.people[0].takedown, "the old takedown is still shown");
  ok(await page("/pull", { token, person_code: "C6101", confirm: true }), "take the new consent back too");
  void film;
});

test("a page pull another person's approval shares goes to the team, and nothing is taken back", async () => {
  // A parent's card from when the athlete was a minor; now the athlete approves for themself.
  const { film, people } = await aFilm((code) => [{ person_code: code, name: "Cy Dove", role: "athlete", is_minor: true, speaker: true, release_on_file: true, covers: { voice: true, formats: ["hero"] }, reviewer_relation: "parent", reviewer_name: "Pat Dove", reviewer_email: "pat@x.test" }]);
  const code = people[0].person_code;
  let film2 = ok(await films("POST", "/films", { kit_slug: "same-work", title: `${code} now`, lane: "youth", athlete_id: code, format: "hero" }, "lead"), "start").film;
  let p2 = ok(await films("POST", `/films/${film2.id}/people`, self(code, "Cy Dove", "cy@x.test"), "lead"), "adult card").person;
  ok(await films("POST", `/films/${film2.id}/people/${p2.id}/clear`, { seen: p2.updated_at }, "lead"), "clear");
  const token = await linkFor("pat@x.test");
  mails = [];
  const r = await page("/pull", { token, person_code: code, confirm: true, note: "Cy Dove wants this stopped" });
  assert.deepEqual([r.status, r.data.error], [409, "ask_the_team"]);
  assert.equal((await pool.query("select count(*)::int as n from studio_film_people where person_code = $1 and consent_pulled_at is not null", [code])).rows[0].n, 0);
  const alert = await mailTo("kyron@toj.test", /Asked to take consent back/);
  assert.ok(alert);
  assert.doesNotMatch(alert.text, /Cy|Dove|pat@/);
  void film;
});

test("an uncleared card's email gets no page; a new approver doesn't see the old one's decisions as theirs", async () => {
  // Uncleared: the email isn't checked yet.
  let film = ok(await films("POST", "/films", { kit_slug: "same-work", title: "S7001 hero", lane: "youth", athlete_id: "S7001", format: "hero" }, "lead"), "start").film;
  const p = ok(await films("POST", `/films/${film.id}/people`, self("C7001", "Di Fern", "di@x.test"), "lead"), "card").person;
  mails = [];
  ok(await page("/send-link", { email: "di@x.test" }), "ask");
  await wait(120);
  assert.equal(mails.filter((m) => m.to.includes("di@x.test")).length, 0);
  assert.equal((await films("POST", `/films/${film.id}/people/${p.id}/page-link`, {}, "lead")).data.error, "card_not_cleared");
  // The previous approver's decision isn't shown as the new one's.
  const { film: f2, people } = await aFilm(() => [self("C7101", "Eve Moss", "eve@x.test")]);
  await pool.query("insert into studio_reviews (film_id, cut_id, person_id, reviewer_email, reviewer_relation, asked_fingerprint, asked_by, decision, decided_at, decided_name) select $1, c.id, $2, 'old@x.test', 'self', repeat('a', 64), 'lead@toj.test', 'approved', now(), 'Old Name' from studio_film_cuts c where c.film_id = $1 limit 1", [f2.id, people[0].id]).catch(() => {});
  const token = await linkFor("eve@x.test");
  const v = ok(await page("/view", { token }), "view");
  assert.equal(v.people[0].films[0].approvals.length, 0);
});
