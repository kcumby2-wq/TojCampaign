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
  // Staff notes: refused with a name, here and in the database.
  assert.deepEqual((await films("POST", `/films/${film.id}/notes`, { note: "Called Pat about the shoot" }, "lead")).data.fields, ["note_has_name"]);
  assert.deepEqual((await films("POST", `/films/${film.id}/notes`, { note: "JordanKid file renamed" }, "lead")).data.fields, ["note_has_name"]);
  ok(await films("POST", `/films/${film.id}/notes`, { note: "Called the parent of " + p.person_code + " about the shoot" }, "lead"), "note with the code");
  await assert.rejects(pool.query("insert into studio_events (film_id, kind, by_staff, note) values ($1, 'note', 'lead@toj.test', 'Jordan was great')", [film.id]), /keeps no names/);
  assert.deepEqual((await step(film.id, "speaker_review", "lead", { cut_ids: [cut.id], note: "Jordan's mum said yes" })).data.fields, ["note_has_name"]);
  // A note that reaches the database another way is left out of the history.
  await pool.query("select studio_film_reopen($1, 'rough_cut', 'lead@toj.test', 'Pat Kid asked for it')", [film.id]);
  const reopened = (await pool.query("select note from studio_events where film_id = $1 and kind = 'step_reopened'", [film.id])).rows[0];
  assert.equal(reopened.note, "(left out: it named someone on a card)");
  const all = JSON.stringify((await pool.query("select * from studio_events where film_id = $1", [film.id])).rows);
  assert.doesNotMatch(all, /Jordan|Pat|Kid/);
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
