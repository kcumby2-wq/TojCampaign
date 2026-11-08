// Studio films: the rules the independent review of PR #45 asked for, against
// migration 039 in a real Postgres. No names in the history; an approval
// comes from the reviewer the card names now; the sign-off is for named cuts
// and only those go out; every minor stays unidentifiable; a pulled consent
// stays pulled; one change to a film at a time; nothing is made for a closed
// film and its files are removed (and retried); records can't be truncated.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_studio_rules_test), which it DROPS and recreates.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = "gfs_studio_rules_test";
if (!URL_) {
  test("studio film rules (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@toj.test";
process.env.STUDIO_SITE_BASE = "https://www.tojcampaign.com";

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

let pool, sb, store, server, base;
let mails = [];
let pushes = [];
const cookies = {};
const as = { kyron: "kyron@toj.test", lead: "lead@toj.test", dir: "dir@toj.test", ed: "ed@toj.test" };

before(async () => {
  pool = await makeSchema(URL_, SCHEMA, ["018_studio_kits.sql", "019_team.sql", "020_native_push.sql", "039_studio_films.sql"]);
  sb = pgSupabase(pool, SCHEMA);
  store = fakeStorage();
  sb.storage = store;
  setSupabase(sb);
  await pool.query(`insert into team_members (email, role, tools) values
    ('lead@toj.test', 'approver', array['studio']), ('dir@toj.test', 'member', array['studio']), ('ed@toj.test', 'member', array['studio'])`);
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  // Who a push reached: one phone each for the producer and the editor.
  await pool.query(`insert into push_subscriptions (email, endpoint, p256dh, auth) values
    ('lead@toj.test', 'https://push.test/lead', 'k', 'a'), ('ed@toj.test', 'https://push.test/ed', 'k', 'a')`);
  push.setSender(async (sub, payload) => { pushes.push({ email: sub.email, payload }); return {}; });
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(session({ secret: "rules", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.email === as.kyron ? "staff" : "user"; res.json({ ok: true }); });
  app.use("/api/studio-films", require("../routes/studio-films"));
  app.use("/api/studio-review", require("../routes/studio-review"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of Object.entries(as)) {
    const r = await fetch(base + "/__test/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    cookies[k] = r.headers.get("set-cookie").split(";")[0];
  }
  await pool.query("update studio_tool_approvals set is_on = true, decided_by = 'kyron@toj.test', note = 'Supabase Storage terms checked' where tool = 'review_copies'");
});
after(async () => {
  server && server.close();
  mailer.setSender(null);
  push.setSender(null);
  setSupabase(null);
  if (pool) await pool.end();
});
beforeEach(() => { T.forget(); mails = []; pushes = []; require("../routes/studio-review")._reset(); });

async function call(method, path, body, who = "kyron") {
  const r = await fetch(base + path, { method, headers: { Cookie: cookies[who], ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
const films = (method, path, body, who) => call(method, "/api/studio-films" + path, body, who);
const reviewer = async (path, body) => {
  const r = await fetch(base + "/api/studio-review" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const ok = (r, what) => { assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const refused = (r, words) => { assert.equal(r.status, 409, JSON.stringify(r.data)); assert.equal(r.data.error, "refused"); if (words) assert.match(r.data.reason, words); };
const room = async (id) => ok(await films("GET", `/films/${id}`, undefined, "lead"), "room");
const step = (id, key, who, extra = {}) => films("POST", `/films/${id}/steps/${key}/done`, extra, who);
const tokenFrom = (m) => (/#t=([0-9a-f]{64})/.exec(m.text) || [])[1];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fakeMedia = {
  ...require("../utils/sm-market-media"),
  async probe() { return { duration_ms: 75000, width: 1080, height: 1920 }; },
  async run(args) { const out = args[args.length - 1]; fs.writeFileSync(out, Buffer.from("made:" + out)); return { code: 0, stderr: "" }; },
};

let n = 0;
// A film through rough cut with one cleared speaker (an adult unless minor).
async function aFilm({ minor = false } = {}) {
  const code = "R" + String(1000 + ++n);
  let film = ok(await films("POST", "/films", { kit_slug: "same-work", title: `${code} hero`, lane: "college", athlete_id: code, format: "hero", one_sentence: "One line." }, "lead"), "start").film;
  film = ok(await films("PATCH", `/films/${film.id}`, { seen: film.updated_at, director_email: "dir@toj.test", editor_email: "ed@toj.test" }, "lead"), "assign").film;
  const card = minor
    ? { person_code: code, name: "Jordan Kid", role: "athlete", is_minor: true, speaker: true, release_on_file: true, covers: { voice: true }, reviewer_relation: "parent", reviewer_name: "Pat Kid", reviewer_email: "pat@kid.test" }
    : { person_code: code, name: "Alex Doe", role: "athlete", speaker: true, release_on_file: true, covers: { face: true, name: true, voice: true }, reviewer_relation: "self", reviewer_name: "Alex Doe", reviewer_email: "alex@x.test" };
  let p = ok(await films("POST", `/films/${film.id}/people`, card, "lead"), "card").person;
  p = ok(await films("POST", `/films/${film.id}/people/${p.id}/clear`, { seen: p.updated_at }, "lead"), "clear").person;
  for (const [k, who] of [["brief", "lead"], ["board", "dir"], ["clearance", "lead"], ["shoot", "dir"], ["selects", "dir"], ["rough_cut", "ed"]]) ok(await step(film.id, k, who), k);
  return { film, p, code };
}
async function aCut(film, people, { version = 1, ratio = "9x16", drain = true } = {}) {
  const file_name = `SW_COL_${film.athlete_id}_HERO_${ratio}_v0${version}_20261117.mp4`;
  const up = ok(await films("POST", `/films/${film.id}/cuts/upload`, { format: "hero", ratio, version, file_name, bytes: 4096, people }, "ed"), "upload link");
  store.put(U.BUCKET, up.key, Buffer.alloc(4096, version + (ratio === "4x5" ? 50 : 0)), "video/mp4");
  const cut = ok(await films("POST", `/films/${film.id}/cuts`, { id: up.id, key: up.key, format: "hero", ratio, version, file_name, bytes: 4096, people }, "ed"), "register").cut;
  if (drain) await W.drain({ media: fakeMedia, fetch: store.serve });
  return cut;
}
async function approve(film, cut, p, name = "Alex Doe") {
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead"), "link");
  const token = tokenFrom(mails.at(-1));
  assert.equal((await reviewer("/decide", { token, decision: "approved", name, confirm: true })).status, 200);
  return token;
}
const approved = async (cutId) => (await pool.query("select studio_cut_approved($1) as ok", [cutId])).rows[0].ok;

test("the history keeps no names: reviewers by who they are, their notes on the review, staff notes checked", async () => {
  const { film, p } = await aFilm({ minor: true });
  const cut = await aCut(film, [p.id]);
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead"), "link");
  const token = tokenFrom(mails.at(-1));
  assert.equal((await reviewer("/decide", { token, decision: "changes", name: "Pat Kid", note: "Cut the part where Jordan cries.", confirm: true })).status, 200);
  const ev = (await pool.query("select kind, by_reviewer, note from studio_events where film_id = $1 and kind = 'review_changes'", [film.id])).rows[0];
  assert.deepEqual(ev, { kind: "review_changes", by_reviewer: "their parent", note: null });
  // The change note stays on the review (the speaker's own record).
  assert.equal((await pool.query("select note from studio_reviews where cut_id = $1", [cut.id])).rows[0].note, "Cut the part where Jordan cries.");
  // Staff notes: a whole name (or one run together) is refused, here and in
  // the database; a single word that's also a name is asked about first.
  assert.deepEqual((await films("POST", `/films/${film.id}/notes`, { note: "Called Pat Kid about the shoot" }, "lead")).data.fields, ["note_has_name"]);
  assert.deepEqual((await films("POST", `/films/${film.id}/notes`, { note: "JordanKid file renamed" }, "lead")).data.fields, ["note_has_name"]);
  const asked = (await films("POST", `/films/${film.id}/notes`, { note: "Called Pat about the shoot" }, "lead")).data;
  assert.deepEqual([asked.fields, asked.words], [["note_may_have_name"], ["pat"]]);
  ok(await films("POST", `/films/${film.id}/notes`, { note: "Called the parent of " + p.person_code + " about the shoot" }, "lead"), "note with the code");
  await assert.rejects(pool.query("insert into studio_events (film_id, kind, by_staff, note) values ($1, 'note', 'lead@toj.test', 'Jordan Kid was great')", [film.id]), /keeps no names/);
  // Any word of a minor's name is refused, and saying it isn't a name here
  // changes nothing: the history never keeps a child's name.
  assert.deepEqual((await step(film.id, "speaker_review", "lead", { cut_ids: [cut.id], note: "Jordan's mum said yes" })).data.fields, ["note_has_minor_name"]);
  assert.deepEqual((await films("POST", `/films/${film.id}/notes`, { note: "Jordan's mum called about Saturday", names_ok: ["jordan"] }, "lead")).data.fields, ["note_has_minor_name"]);
  assert.deepEqual((await films("POST", `/films/${film.id}/notes`, { note: "Jordan's mum called about Saturday", names_ok: true }, "lead")).data.fields, ["note_has_minor_name"]);
  await assert.rejects(pool.query("insert into studio_events (film_id, kind, by_staff, note) values ($1, 'note', 'lead@toj.test', 'Jordan''s mum called')", [film.id]), /keeps no names/);
  // A note that reaches the database another way is left out of the history.
  await pool.query("select studio_film_reopen($1, 'rough_cut', 'lead@toj.test', 'Pat Kid asked for it')", [film.id]);
  const reopened = (await pool.query("select note from studio_events where film_id = $1 and kind = 'step_reopened'", [film.id])).rows[0];
  assert.equal(reopened.note, "(left out: it named someone on a card)");
  const all = JSON.stringify((await pool.query("select * from studio_events where film_id = $1", [film.id])).rows);
  assert.doesNotMatch(all, /Jordan|Pat|Kid/);
});

test("a word of an adult's name is asked about, then kept for those words in that text; the database holds whole names", async () => {
  const { film } = await aFilm();
  // A card named Will Hunter, reviewed by Grace Hunter.
  ok(await films("POST", `/films/${film.id}/people`, { person_code: "W0001", name: "Will Hunter", role: "coach", release_on_file: true, speaker: true, reviewer_relation: "self", reviewer_name: "Grace Hunter", reviewer_email: "grace@x.test" }, "lead"), "card");
  const first = await films("POST", `/films/${film.id}/notes`, { note: "We will reshoot the wide on Tuesday" }, "lead");
  assert.deepEqual([first.status, first.data.fields, first.data.words], [400, ["note_may_have_name"], ["will"]]);
  // `true` acknowledges nothing: it's the exact words, for this text.
  assert.deepEqual((await films("POST", `/films/${film.id}/notes`, { note: "We will reshoot the wide on Tuesday", names_ok: true }, "lead")).data.words, ["will"]);
  ok(await films("POST", `/films/${film.id}/notes`, { note: "We will reshoot the wide on Tuesday", names_ok: ["Will"] }, "lead"), "kept once it's said not to be a name");
  // A rewritten note with another name word is asked about again.
  assert.deepEqual((await films("POST", `/films/${film.id}/notes`, { note: "We will reshoot it, by grace", names_ok: ["will"] }, "lead")).data.words, ["grace"]);
  assert.deepEqual((await films("POST", `/films/${film.id}/notes`, { note: "Will Hunter called", names_ok: ["will", "hunter"] }, "lead")).data.fields, ["note_has_name"]);
  await pool.query("insert into studio_events (film_id, kind, by_staff, note) values ($1, 'note', 'lead@toj.test', 'By grace it is done')", [film.id]);
  await assert.rejects(pool.query("insert into studio_events (film_id, kind, by_staff, note) values ($1, 'note', 'lead@toj.test', 'Grace Hunter said yes')", [film.id]), /keeps no names/);
});

test("a minor's two-letter name is kept out of titles, stories and file names; an everyday word in it isn't", async () => {
  const code = "B" + String(7000 + ++n);
  let film = ok(await films("POST", "/films", { kit_slug: "same-work", title: `${code} hero`, lane: "youth", athlete_id: code, format: "hero", one_sentence: "He ran this drill at nine. He runs it now." }, "lead"), "start").film;
  const card = { person_code: code, name: "Bo He", role: "athlete", is_minor: true, speaker: true, release_on_file: true, covers: { voice: true }, reviewer_relation: "parent", reviewer_name: "Pat Roe", reviewer_email: "pat@roe.test" };
  const p = ok(await films("POST", `/films/${film.id}/people`, card, "lead"), "card: the story's \"He\" starts its sentences").person;
  const people = [p];
  assert.deepEqual(U.filmInput({ title: "Bo hero" }, { partial: true, people }).errors, ["title_has_name"]);
  assert.deepEqual(U.filmInput({ one_sentence: "Bo learned this drill at nine." }, { partial: true, people }).errors, ["story_has_name"]);
  assert.deepEqual(U.filmInput({ one_sentence: "Then He came back to it." }, { partial: true, people }).errors, ["story_has_name"]);
  assert.deepEqual(U.filmInput({ one_sentence: "He came back to it, and he stayed." }, { partial: true, people }).errors, []);
  const patched = await films("PATCH", `/films/${film.id}`, { seen: film.updated_at, title: "Bo hero" }, "lead");
  assert.deepEqual([patched.status, patched.data.fields], [400, ["title_has_name"]]);
  assert.ok(U.cutInput({ format: "hero", ratio: "9x16", version: 1, file_name: `SW_YTH_${code}_BO_9x16_v01_20261117.mp4`, people: [p.id] }, { filmPeople: people }).errors.includes("file_name_has_name"));
  // Notes: "he" is an everyday word, so it counts only with a capital mid-sentence.
  ok(await films("POST", `/films/${film.id}/notes`, { note: "He was great today, and he wants another take" }, "lead"), "an everyday he");
  assert.deepEqual((await films("POST", `/films/${film.id}/notes`, { note: "Talked to He's mom about Saturday" }, "lead")).data.fields, ["note_has_minor_name"]);
  assert.deepEqual((await films("POST", `/films/${film.id}/notes`, { note: "Bo was great" }, "lead")).data.fields, ["note_has_minor_name"]);
  await pool.query("insert into studio_events (film_id, kind, by_staff, note) values ($1, 'note', 'lead@toj.test', 'he was great')", [film.id]);
  await assert.rejects(pool.query("insert into studio_events (film_id, kind, by_staff, note) values ($1, 'note', 'lead@toj.test', 'Bo was great')", [film.id]), /keeps no names/);
  await assert.rejects(pool.query("insert into studio_events (film_id, kind, by_staff, note) values ($1, 'note', 'lead@toj.test', 'Bo He was great')", [film.id]), /keeps no names/);
  // A card renamed to a name the title or story has is refused too.
  film = ok(await films("POST", "/films", { kit_slug: "same-work", title: `${code} Ty cut`, lane: "youth", athlete_id: code, format: "cutdown" }, "lead"), "start 2").film;
  const q = ok(await films("POST", `/films/${film.id}/people`, { ...card, name: "Sam Roe" }, "lead"), "card 2").person;
  assert.equal((await films("PATCH", `/films/${film.id}/people/${q.id}`, { seen: q.updated_at, name: "Ty Roe" }, "lead")).data.error, "title_has_name");
});

test("an approval comes from the reviewer the card names now; a card change stops its links", async () => {
  const { film, p } = await aFilm();
  const cut = await aCut(film, [p.id]);
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead"), "link");
  const oldToken = tokenFrom(mails.at(-1));
  // A member can't change who approves; the producer can, and that stops the link.
  const cur = (await room(film.id)).people[0];
  assert.equal((await films("PATCH", `/films/${film.id}/people/${p.id}`, { seen: cur.updated_at, reviewer_email: "someone@else.test" }, "dir")).data.error, "producer_only");
  ok(await films("PATCH", `/films/${film.id}/people/${p.id}`, { seen: cur.updated_at, reviewer_email: "alex.new@x.test" }, "lead"), "change reviewer");
  assert.equal((await reviewer("/view", { token: oldToken })).status, 404);
  assert.equal((await reviewer("/decide", { token: oldToken, decision: "approved", name: "Alex Doe", confirm: true })).status, 404);
  // An approval from before a correction no longer counts.
  const again = (await room(film.id)).people[0];
  ok(await films("POST", `/films/${film.id}/people/${p.id}/clear`, { seen: again.updated_at }, "lead"), "re-clear");
  assert.equal(await approved(cut.id), false);
  await approve(film, cut, p);
  assert.equal(await approved(cut.id), true);
  // Corrected to a minor (a parent approves): the adult's own yes stops counting.
  const before = (await room(film.id)).people[0];
  ok(await films("PATCH", `/films/${film.id}/people/${p.id}`, { seen: before.updated_at, is_minor: true, reviewer_relation: "parent", reviewer_name: "Sam Doe", reviewer_email: "sam@x.test" }, "lead"), "now a minor");
  const minor = (await room(film.id)).people[0];
  assert.deepEqual([minor.covers.face, minor.covers.name, minor.covers.jersey], [false, false, false]);
  ok(await films("POST", `/films/${film.id}/people/${p.id}/clear`, { seen: minor.updated_at }, "lead"), "re-clear");
  assert.equal(await approved(cut.id), false);
  refused(await step(film.id, "speaker_review", "lead", { cut_ids: [cut.id] }), /say yes/);
});

test("the sign-off is for named cuts: Hooks says yes after the rights check, and only those cuts go out", async () => {
  const { film, p } = await aFilm();
  const tall = await aCut(film, [p.id], { ratio: "9x16" });
  const feed = await aCut(film, [p.id], { ratio: "4x5" });
  await approve(film, tall, p);
  await approve(film, feed, p);
  // Coach Hooks's yes waits for the rights check.
  refused(await films("POST", `/films/${film.id}/second-yes`, { note: "Hooks said yes by text" }, "lead"), /rights check comes first/);
  ok(await step(film.id, "speaker_review", "lead", { cut_ids: [tall.id] }), "speaker review: the 9:16 only");
  ok(await step(film.id, "rights_check", "lead"), "rights");
  ok(await films("POST", `/films/${film.id}/second-yes`, { note: "Hooks said yes by text, Nov 17" }, "lead"), "second yes");
  // Walking back past the rights check takes Hooks's yes with it.
  ok(await films("POST", `/films/${film.id}/steps/rights_check/reopen`, { note: "Recheck the jersey" }, "lead"), "reopen");
  assert.equal((await pool.query("select second_yes_by from studio_film_steps where film_id = $1 and step = 'final_signoff'", [film.id])).rows[0].second_yes_by, null);
  ok(await films("POST", `/films/${film.id}/steps/speaker_review/reopen`, { note: "Both ratios go out" }, "lead"), "reopen review");
  ok(await step(film.id, "speaker_review", "lead", { cut_ids: [tall.id, feed.id] }), "speaker review: both");
  ok(await step(film.id, "rights_check", "lead"), "rights");
  ok(await films("POST", `/films/${film.id}/second-yes`, { note: "Hooks said yes by text, Nov 18" }, "lead"), "second yes");
  ok(await step(film.id, "final_signoff", "lead"), "final");
  const fin = (await room(film.id)).steps.find((s) => s.step === "final_signoff");
  assert.deepEqual(fin.cut_ids.sort(), [tall.id, feed.id].sort());
  // A cut approved after the sign-off doesn't go out.
  const late = await aCut(film, [p.id], { version: 2 });
  await approve(film, late, p);
  assert.equal(await approved(late.id), true);
  refused(await films("POST", `/films/${film.id}/posts`, { cut_id: late.id, platform: "instagram", url: "https://instagram.com/p/late" }, "kyron"), /final sign-off was for/);
  ok(await films("POST", `/films/${film.id}/posts`, { cut_id: tall.id, platform: "instagram", url: "https://instagram.com/p/tall" }, "kyron"), "post 9:16");
  ok(await films("POST", `/films/${film.id}/posts`, { cut_id: feed.id, platform: "instagram", url: "https://instagram.com/p/feed" }, "kyron"), "post 4:5");
  // A film that's out isn't walked back, and its cards don't change or uncleared.
  refused(await films("POST", `/films/${film.id}/steps/final_signoff/reopen`, { note: "redo" }, "lead"), /take its posts down first/);
  const card = (await room(film.id)).people[0];
  refused(await films("PATCH", `/films/${film.id}/people/${p.id}`, { seen: card.updated_at, covers: { face: false, voice: true } }, "lead"), /posted/);
  await assert.rejects(pool.query("update studio_film_people set cleared_at = null, changed_by = 'lead@toj.test' where id = $1", [p.id]), /posted/);
});

test("every minor stays unidentifiable, Texas youth or not", async () => {
  const { film } = await aFilm();
  const r = ok(await films("POST", `/films/${film.id}/people`, { person_code: "M0001", name: "Riley Young", role: "athlete", is_minor: true, release_on_file: true, covers: { face: true, name: true, jersey: true, voice: true } }, "dir"), "minor card").person;
  assert.deepEqual([r.covers.face, r.covers.name, r.covers.jersey, r.covers.voice], [false, false, false, true]);
  await assert.rejects(pool.query(`update studio_film_people set covers = '{"face": true}'::jsonb, changed_by = 'lead@toj.test' where id = $1`, [r.id]), /studio_film_people_minor/);
  await assert.rejects(pool.query(`insert into studio_film_people (film_id, person_code, name, role, is_minor, covers, created_by) values ($1, 'M0002', 'Kid', 'athlete', true, '{"jersey": true}'::jsonb, 'lead@toj.test')`, [film.id]), /studio_film_people_minor/);
});

test("a pulled consent stays pulled: a new card waits for the takedown and the family's new consent", async () => {
  const { film, p, code } = await aFilm();
  ok(await films("POST", "/people/pull", { person_code: code, confirm: true, note: "The family called" }, "lead"), "pull");
  const other = ok(await films("POST", "/films", { kit_slug: "same-work", title: "Another hero", lane: "college", athlete_id: code, format: "hero" }, "lead"), "another film").film;
  const card = { person_code: code, name: "Alex Doe", role: "athlete", speaker: true, release_on_file: true, reviewer_relation: "self", reviewer_name: "Alex Doe", reviewer_email: "alex@x.test" };
  refused(await films("POST", `/films/${other.id}/people`, card, "lead"), /takedown is still open/);
  const td = ok(await films("GET", "/takedowns", undefined, "lead"), "takedowns").open.find((x) => x.person_code === code);
  for (const i of td.items) ok(await films("POST", `/takedown-items/${i.id}/done`, { note: "Done" }, "lead"), "item down");
  refused(await films("POST", `/films/${other.id}/people`, card, "lead"), /new consent/);
  assert.equal((await films("POST", `/films/${other.id}/people`, { ...card, reconsent_note: "New release signed Nov 20" }, "dir")).data.error, "producer_only");
  ok(await films("POST", `/films/${other.id}/people`, { ...card, reconsent_note: "New release signed Nov 20, on file" }, "lead"), "re-consented card");
  // From then on the code is back: a further card needs no note.
  const third = ok(await films("POST", "/films", { kit_slug: "same-work", title: "Third", lane: "college", athlete_id: code, format: "cutdown" }, "lead"), "third").film;
  ok(await films("POST", `/films/${third.id}/people`, card, "lead"), "card after re-consent");
  void p; void film;
});

test("one change to a film at a time: a post recorded during a pull waits, then is refused", async () => {
  const { film, p, code } = await aFilm();
  const cut = await aCut(film, [p.id]);
  await approve(film, cut, p);
  ok(await step(film.id, "speaker_review", "lead", { cut_ids: [cut.id] }), "review");
  ok(await step(film.id, "rights_check", "lead"), "rights");
  ok(await films("POST", `/films/${film.id}/second-yes`, { note: "Hooks said yes" }, "lead"), "yes");
  ok(await step(film.id, "final_signoff", "lead"), "final");
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query("begin");
    await a.query("select * from studio_pull_consent($1, 'lead@toj.test', 'staff', null)", [code]);
    await b.query("begin");
    let settled = false;
    const posting = b.query("insert into studio_film_posts (film_id, cut_id, platform, url, posted_by) values ($1, $2, 'instagram', 'https://instagram.com/p/race', 'kyron@toj.test')", [film.id, cut.id]).then(
      () => { settled = true; return null; },
      (e) => { settled = true; return e; }
    );
    await wait(250);
    assert.equal(settled, false, "the post waits for the pull");
    await a.query("commit");
    const err = await posting;
    assert.ok(err, "the post is refused once the pull is in");
    assert.match(err.message, /closed/);
    await b.query("rollback");
  } finally {
    await a.query("rollback").catch(() => {});
    a.release();
    b.release();
  }
});

test("nothing is made for a closed film, and its files are removed even when storage fails first", async () => {
  const { film, p, code } = await aFilm();
  const made = await aCut(film, [p.id]);
  const row = (await pool.query("select preview_key, poster_key, preview_sha256 from studio_film_cuts where id = $1", [made.id])).rows[0];
  assert.equal(row.preview_key, U.previewKey(film.id, made.id, row.preview_sha256));
  // A cut waiting when consent is pulled is never made.
  const waiting = await aCut(film, [p.id], { version: 2, drain: false });
  const realRemove = store.from(U.BUCKET).remove;
  let failRemovals = true;
  const from = store.from;
  store.from = (bucket) => { const o = from(bucket); return { ...o, async remove(keys) { if (failRemovals) return { data: null, error: { message: "storage is down" } }; return o.remove(keys); } }; };
  try {
    ok(await films("POST", "/people/pull", { person_code: code, confirm: true }, "lead"), "pull");
    const pending = (await pool.query("select key, tries from studio_storage_removals where done_at is null order by key")).rows;
    assert.ok(pending.some((x) => x.key === row.preview_key) && pending.some((x) => x.key === made.object_key), JSON.stringify(pending));
    assert.ok(store.has(U.BUCKET, row.preview_key), "storage was down: still there");
    failRemovals = false;
    const pass = await W.drain({ media: fakeMedia, fetch: store.serve });
    assert.equal(pass.processed, 0);
  } finally {
    store.from = from;
  }
  void realRemove;
  assert.equal(store.has(U.BUCKET, row.preview_key), false);
  assert.equal(store.has(U.BUCKET, made.object_key), false);
  assert.equal((await pool.query("select count(*)::int as n from studio_storage_removals where done_at is null")).rows[0].n, 0);
  const w = (await pool.query("select status, error from studio_film_cuts where id = $1", [waiting.id])).rows[0];
  assert.equal(w.status, "failed");
  assert.match(w.error, /closed/);
  // The database refuses a review copy for a closed film outright.
  await assert.rejects(pool.query("update studio_film_cuts set status = 'processing' where id = $1", [waiting.id]), /closed/);
});

test("Studio records can't be truncated", async () => {
  for (const t of ["studio_tool_approvals", "studio_films", "studio_film_steps", "studio_film_people", "studio_film_cuts", "studio_reviews", "studio_film_posts", "studio_takedowns", "studio_takedown_items", "studio_events", "studio_storage_removals"]) {
    await assert.rejects(pool.query(`truncate ${t} cascade`), /kept/, t);
  }
});

test("small rules: who brought a film back, a story with a name, the editor hears of a change, review copies off stops links", async () => {
  const { film, p } = await aFilm();
  ok(await films("POST", `/films/${film.id}/archive`, { archived: true }, "lead"), "archive");
  refused(await films("POST", `/films/${film.id}/steps/selects/reopen`, { note: "x" }, "lead"), /closed/);
  await pool.query("update team_members set role = 'approver' where email = 'ed@toj.test'");
  T.forget();
  ok(await films("POST", `/films/${film.id}/archive`, { archived: false }, "ed"), "unarchive");
  await pool.query("update team_members set role = 'member' where email = 'ed@toj.test'");
  T.forget();
  const ev = (await pool.query("select kind, by_staff from studio_events where film_id = $1 and kind in ('film_archived', 'film_unarchived') order by id", [film.id])).rows;
  assert.deepEqual(ev, [{ kind: "film_archived", by_staff: "lead@toj.test" }, { kind: "film_unarchived", by_staff: "ed@toj.test" }]);
  // The story is on the review page: no names in it, and a new card's name can't be in it.
  const fresh = (await room(film.id)).film;
  assert.deepEqual((await films("PATCH", `/films/${film.id}`, { seen: fresh.updated_at, one_sentence: "Alex ran this drill in 2017." }, "lead")).data.fields, ["story_has_name"]);
  const f2 = ok(await films("POST", "/films", { kit_slug: "same-work", title: "Q hero", lane: "college", athlete_id: "Q0001", format: "hero", one_sentence: "Casey ran this drill in 2017." }, "lead"), "film").film;
  assert.equal((await films("POST", `/films/${f2.id}/people`, { person_code: "Q0001", name: "Casey Lane", role: "athlete", release_on_file: true }, "lead")).data.error, "story_has_name");
  // A change asked: the film's editor hears too.
  const cut = await aCut(film, [p.id]);
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead"), "link");
  const token = tokenFrom(mails.at(-1));
  assert.equal((await reviewer("/decide", { token, decision: "changes", name: "Alex Doe", note: "Shorter, please.", confirm: true })).status, 200);
  await wait(150);
  assert.ok(pushes.some((x) => x.email === "ed@toj.test" && /asked for a change/.test(x.payload.title)), JSON.stringify(pushes));
  // Review copies turned off: live links stop.
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead"), "new link");
  const live = tokenFrom(mails.at(-1));
  ok(await films("POST", "/tools/review_copies", { on: false }, "kyron"), "off");
  try {
    assert.equal((await reviewer("/view", { token: live })).status, 404);
    assert.equal((await pool.query("select count(*)::int as n from studio_reviews where link_hash is not null")).rows[0].n, 0);
  } finally {
    ok(await films("POST", "/tools/review_copies", { on: true, note: "Back on for the tests" }, "kyron"), "on");
  }
});

// Two transactions on one connection pool: the first holds its lock while the
// second is started, then lets go.
async function holding(sql, params) {
  const c = await pool.connect();
  await c.query("begin");
  await c.query(sql, params);
  return { c, done: async (how = "commit") => { try { await c.query(how); } finally { c.release(); } } };
}
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, msg: e.message }));

test("film first: a link cancelled during a pull waits its turn instead of deadlocking", async () => {
  const { film, p, code } = await aFilm();
  const cut = await aCut(film, [p.id]);
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead"), "link");
  const review = (await pool.query("select id from studio_reviews where cut_id = $1", [cut.id])).rows[0].id;
  // A card edit holds the card's row for a moment, so the pull has the film
  // and waits; the cancel (through its function) waits for the film.
  const t0 = await holding("select 1 from studio_film_people where id = $1 for update", [p.id]);
  const pull = settle(pool.query("select * from studio_pull_consent($1, 'lead@toj.test', 'staff', null)", [code]));
  await wait(250);
  const cancel = settle(pool.query("select * from studio_review_cancel($1, 'lead@toj.test')", [review]));
  await wait(250);
  await t0.done();
  const [a, b] = await Promise.all([pull, cancel]);
  assert.ok(a.ok, JSON.stringify(a));
  assert.ok(b.ok, JSON.stringify(b));
  assert.equal(b.v.rows.length, 0, "the pull had already stopped the link");
  // The same for a post taken down by hand while its takedown line is marked down.
  const x = await aFilm();
  const c2 = await aCut(x.film, [x.p.id]);
  await approve(x.film, c2, x.p);
  ok(await step(x.film.id, "speaker_review", "lead", { cut_ids: [c2.id] }), "review");
  ok(await step(x.film.id, "rights_check", "lead"), "rights");
  ok(await films("POST", `/films/${x.film.id}/second-yes`, { note: "Hooks said yes" }, "lead"), "yes");
  ok(await step(x.film.id, "final_signoff", "lead"), "final");
  const post = ok(await films("POST", `/films/${x.film.id}/posts`, { cut_id: c2.id, platform: "instagram", url: "https://instagram.com/p/z" }, "kyron"), "post").post;
  const td = ok(await films("POST", "/people/pull", { person_code: x.code, confirm: true }, "lead"), "pull").takedown;
  const item = (await pool.query("select id from studio_takedown_items where takedown_id = $1 and post_id = $2", [td.id, post.id])).rows[0].id;
  const t1 = await holding("select 1 from studio_films where id = $1 for update", [x.film.id]);
  const byHand = settle(pool.query("select * from studio_post_remove($1, 'lead@toj.test')", [post.id]));
  await wait(200);
  const line = settle(pool.query("select * from studio_takedown_item_done($1, 'lead@toj.test', null)", [item]));
  await wait(200);
  await t1.done();
  const [e, f] = await Promise.all([byHand, line]);
  assert.ok(e.ok && f.ok, JSON.stringify([e, f]));
  assert.ok((await pool.query("select removed_at from studio_film_posts where id = $1", [post.id])).rows[0].removed_at);
});

test("a card added for a code while it's being pulled waits for the pull, and is pulled with it", async () => {
  const { code } = await aFilm();
  const other = ok(await films("POST", "/films", { kit_slug: "same-work", title: "Other", lane: "college", athlete_id: code, format: "cutdown" }, "lead"), "film").film;
  const t1 = await holding(`insert into studio_film_people (film_id, person_code, name, role, release_on_file, created_by) values ($1, $2, 'Alex Doe', 'athlete', true, 'lead@toj.test')`, [other.id, code]);
  let pulled = false;
  const pull = settle(pool.query("select * from studio_pull_consent($1, 'lead@toj.test', 'staff', null)", [code]).then((r) => { pulled = true; return r; }));
  await wait(250);
  assert.equal(pulled, false, "the pull waits for the card's insert");
  await t1.done();
  assert.ok((await pull).ok);
  const r = (await pool.query(`select (select count(*)::int from studio_film_people where person_code = $1 and consent_pulled_at is null) as unpulled,
      (select pulled_at is not null from studio_films where id = $2) as other_pulled`, [code, other.id])).rows[0];
  assert.deepEqual(r, { unpulled: 0, other_pulled: true });
  // And the other way round: a card added while the pull is under way is refused.
  const y = await aFilm();
  const film3 = ok(await films("POST", "/films", { kit_slug: "same-work", title: "Third", lane: "college", athlete_id: y.code, format: "cutdown" }, "lead"), "film").film;
  const t2 = await holding("select * from studio_pull_consent($1, 'lead@toj.test', 'staff', null)", [y.code]);
  const adding = settle(pool.query(`insert into studio_film_people (film_id, person_code, name, role, release_on_file, created_by) values ($1, $2, 'Alex Doe', 'athlete', true, 'lead@toj.test')`, [film3.id, y.code]));
  await wait(250);
  await t2.done();
  const added = await adding;
  assert.equal(added.ok, false);
  assert.match(added.msg, /takedown is still open/);
});

test("a takedown closes when its last lines are marked down at once, and not before a line added meanwhile", async () => {
  const code = "D" + String(5000 + ++n);
  const a = await aFilm();
  const b = await aFilm();
  // Both films carry the same person.
  for (const f of [a, b]) ok(await films("POST", `/films/${f.film.id}/people`, { person_code: code, name: "Sam Roe", role: "coach", release_on_file: true }, "lead"), "card");
  const td = ok(await films("POST", "/people/pull", { person_code: code, confirm: true }, "lead"), "pull").takedown;
  const items = (await pool.query("select id from studio_takedown_items where takedown_id = $1 order by film_id", [td.id])).rows;
  assert.equal(items.length, 2);
  const t1 = await holding("select * from studio_takedown_item_done($1, 'lead@toj.test', null)", [items[0].id]);
  const second = settle(pool.query("select * from studio_takedown_item_done($1, 'lead@toj.test', null)", [items[1].id]));
  await wait(200);
  await t1.done();
  assert.ok((await second).ok);
  assert.ok((await pool.query("select closed_at from studio_takedowns where id = $1", [td.id])).rows[0].closed_at, "closed");
  // A line added while the last one is marked down: the takedown stays open for it.
  const c = await aFilm();
  const d = await aFilm();
  const code2 = "E" + String(5000 + ++n);
  for (const f of [c, d]) ok(await films("POST", `/films/${f.film.id}/people`, { person_code: code2, name: "Kim Poe", role: "coach", release_on_file: true }, "lead"), "card");
  const td2 = ok(await films("POST", "/people/pull", { person_code: code2, confirm: true }, "lead"), "pull").takedown;
  const lines = (await pool.query("select id, film_id from studio_takedown_items where takedown_id = $1 order by film_id", [td2.id])).rows;
  ok(await films("POST", `/takedown-items/${lines[0].id}/done`, {}, "lead"), "first line down");
  const adding = await holding("insert into studio_takedown_items (takedown_id, film_id, what, label) values ($1, $2, 'other', 'a repost on a fan page')", [td2.id, lines[0].film_id]);
  const last = settle(pool.query("select * from studio_takedown_item_done($1, 'lead@toj.test', null)", [lines[1].id]));
  await wait(200);
  await adding.done();
  assert.ok((await last).ok);
  const r = (await pool.query(`select (select count(*)::int from studio_takedown_items where takedown_id = $1 and done_at is null) as left_to_do,
      (select closed_at is null from studio_takedowns where id = $1) as open`, [td2.id])).rows[0];
  assert.deepEqual(r, { left_to_do: 1, open: true });
  // The worker's safety net closes a takedown with nothing left on it.
  await pool.query("update studio_takedown_items set done_at = now(), done_by = 'lead@toj.test' where takedown_id = $1 and done_at is null", [td2.id]);
  await W.sweep({ sb });
  assert.ok((await pool.query("select closed_at from studio_takedowns where id = $1", [td2.id])).rows[0].closed_at);
});

// A film through its sign-off and posted, with two cleared adults in the cut:
// the speaker (x) and someone else on camera (y).
async function postedWithTwo(x, y) {
  let film = ok(await films("POST", "/films", { kit_slug: "same-work", title: `${x} hero`, lane: "college", athlete_id: x, format: "hero", one_sentence: "One line." }, "lead"), "start").film;
  film = ok(await films("PATCH", `/films/${film.id}`, { seen: film.updated_at, director_email: "dir@toj.test", editor_email: "ed@toj.test" }, "lead"), "assign").film;
  let p = ok(await films("POST", `/films/${film.id}/people`, { person_code: x, name: "Alex Doe", role: "athlete", speaker: true, release_on_file: true, covers: { face: true, name: true, voice: true }, reviewer_relation: "self", reviewer_name: "Alex Doe", reviewer_email: "alex@x.test" }, "lead"), "card").person;
  p = ok(await films("POST", `/films/${film.id}/people/${p.id}/clear`, { seen: p.updated_at }, "lead"), "clear").person;
  let q = ok(await films("POST", `/films/${film.id}/people`, { person_code: y, name: "Sam Roe", role: "coach", release_on_file: true, covers: { face: true, name: true, voice: true } }, "lead"), "card 2").person;
  q = ok(await films("POST", `/films/${film.id}/people/${q.id}/clear`, { seen: q.updated_at }, "lead"), "clear 2").person;
  for (const [k, who] of [["brief", "lead"], ["board", "dir"], ["clearance", "lead"], ["shoot", "dir"], ["selects", "dir"], ["rough_cut", "ed"]]) ok(await step(film.id, k, who), k);
  const cut = await aCut(film, [p.id, q.id]);
  await approve(film, cut, p);
  ok(await step(film.id, "speaker_review", "lead", { cut_ids: [cut.id] }), "review");
  ok(await step(film.id, "rights_check", "lead"), "rights");
  ok(await films("POST", `/films/${film.id}/second-yes`, { note: "Hooks said yes" }, "lead"), "yes");
  ok(await step(film.id, "final_signoff", "lead"), "final");
  const post = ok(await films("POST", `/films/${film.id}/posts`, { cut_id: cut.id, platform: "instagram", url: "https://instagram.com/p/" + film.id.slice(0, 8) }, "kyron"), "post").post;
  return { film, post };
}

test("two takedowns listing the same two posts: lines marked down at once lock in one order", async () => {
  const x = "X" + String(5000 + ++n), y = "Y" + String(5000 + n);
  const F = await postedWithTwo(x, y);
  const G = await postedWithTwo(x, y);
  const tX = ok(await films("POST", "/people/pull", { person_code: x, confirm: true }, "lead"), "pull x").takedown;
  const tY = ok(await films("POST", "/people/pull", { person_code: y, confirm: true }, "lead"), "pull y").takedown;
  const line = async (td, post) => (await pool.query("select id from studio_takedown_items where takedown_id = $1 and post_id = $2", [td, post])).rows[0].id;
  const xF = await line(tX.id, F.post.id);
  const yG = await line(tY.id, G.post.id);
  // Both posts held for a moment, so each line gets as far as its post.
  const t0 = await holding("select 1 from studio_film_posts where id = any($1) for update", [[F.post.id, G.post.id]]);
  const a = settle(pool.query("select * from studio_takedown_item_done($1, 'lead@toj.test', null)", [xF]));
  const b = settle(pool.query("select * from studio_takedown_item_done($1, 'kyron@toj.test', null)", [yG]));
  await wait(300);
  await t0.done();
  const [ra, rb] = await Promise.all([a, b]);
  assert.ok(ra.ok && rb.ok, JSON.stringify([ra, rb]));
  // Each post came down, and that ticked its line on the other takedown too.
  const lines = (await pool.query("select done_at is not null as done from studio_takedown_items where post_id = any($1)", [[F.post.id, G.post.id]])).rows;
  assert.deepEqual(lines.map((r) => r.done), [true, true, true, true]);
  // The same two posts taken down by hand at once.
  const H = await postedWithTwo("X" + String(5000 + ++n), "Y" + String(5000 + n));
  const J = await postedWithTwo(H.film.athlete_id, "Y" + String(5000 + n));
  for (const code of [H.film.athlete_id, "Y" + String(5000 + n)]) ok(await films("POST", "/people/pull", { person_code: code, confirm: true }, "lead"), "pull");
  const t1 = await holding("select 1 from studio_film_posts where id = any($1) for update", [[H.post.id, J.post.id]]);
  const c = settle(pool.query("select * from studio_post_remove($1, 'lead@toj.test')", [H.post.id]));
  const d = settle(pool.query("select * from studio_post_remove($1, 'kyron@toj.test')", [J.post.id]));
  await wait(300);
  await t1.done();
  const [rc, rd] = await Promise.all([c, d]);
  assert.ok(rc.ok && rd.ok, JSON.stringify([rc, rd]));
});

test("the worker's safety net closes what it can and leaves a takedown that's busy for the next pass", async () => {
  const codes = ["S" + String(5000 + ++n), "S" + String(5000 + ++n)];
  const tds = [];
  for (const code of codes) {
    const f = await aFilm();
    ok(await films("POST", `/films/${f.film.id}/people`, { person_code: code, name: "Kim Poe", role: "coach", release_on_file: true }, "lead"), "card");
    tds.push(ok(await films("POST", "/people/pull", { person_code: code, confirm: true }, "lead"), "pull").takedown);
  }
  // Both are finished, but nobody's lines closed them (marked down by hand in the database).
  await pool.query("alter table studio_takedown_items disable trigger studio_takedown_items_then");
  try {
    await pool.query("update studio_takedown_items set done_at = now(), done_by = 'lead@toj.test' where takedown_id = any($1) and done_at is null", [tds.map((t) => t.id)]);
  } finally {
    await pool.query("alter table studio_takedown_items enable trigger studio_takedown_items_then");
  }
  const busy = await holding("select 1 from studio_takedowns where id = $1 for update", [tds[0].id]);
  const closed = (await pool.query("select studio_close_finished_takedowns() as n")).rows[0].n;
  await busy.done();
  assert.equal(closed, 1, "the one nobody was changing closed, without waiting");
  const open = (await pool.query("select id from studio_takedowns where id = any($1) and closed_at is null", [tds.map((t) => t.id)])).rows.map((r) => r.id);
  assert.deepEqual(open, [tds[0].id]);
  assert.equal((await pool.query("select studio_close_finished_takedowns() as n")).rows[0].n, 1, "and the next pass closes it");
});

test("an upload that lands after a pull is swept from the pulled film's folder", async () => {
  const { film, p, code } = await aFilm();
  const file_name = `SW_COL_${film.athlete_id}_HERO_9x16_v01_20261117.mp4`;
  const up = ok(await films("POST", `/films/${film.id}/cuts/upload`, { format: "hero", ratio: "9x16", version: 1, file_name, bytes: 4096, people: [p.id] }, "ed"), "upload link");
  ok(await films("POST", "/people/pull", { person_code: code, confirm: true }, "lead"), "pull");
  store.put(U.BUCKET, up.key, Buffer.alloc(4096, 1), "video/mp4");
  refused(await films("POST", `/films/${film.id}/cuts`, { id: up.id, key: up.key, format: "hero", ratio: "9x16", version: 1, file_name, bytes: 4096, people: [p.id] }, "ed"), /closed|pulled consent/);
  assert.ok(store.has(U.BUCKET, up.key));
  await W.sweep({ sb });
  assert.equal(store.has(U.BUCKET, up.key), false);
});
