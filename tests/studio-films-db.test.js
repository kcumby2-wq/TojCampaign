// Studio films end to end against migration 039 in a real Postgres: a film is
// started from the Same Work kit, its cards are cleared, a review copy is
// uploaded and made, the speaker's parent approves it on their one-time link,
// it's signed off, posted, and then consent is pulled and the takedown runs.
// Every write meets the database's own rules on the way.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_studio_films_test), which it DROPS and recreates.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = "gfs_studio_films_test";
if (!URL_) {
  test("studio films end to end (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
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

let pool, sb, store, server, base;
let mails = [];
const cookies = {};
const as = { kyron: "kyron@toj.test", lead: "lead@toj.test", dir: "dir@toj.test", ed: "ed@toj.test", viewer: "viewer@toj.test", other: "other@toj.test" };

before(async () => {
  pool = await makeSchema(URL_, SCHEMA, ["018_studio_kits.sql", "019_team.sql", "020_native_push.sql", "039_studio_films.sql"]);
  sb = pgSupabase(pool, SCHEMA);
  store = fakeStorage();
  sb.storage = store;
  setSupabase(sb);
  await pool.query(`insert into team_members (email, role, tools) values
    ('lead@toj.test', 'approver', array['studio']), ('dir@toj.test', 'member', array['studio']),
    ('ed@toj.test', 'member', array['studio']), ('viewer@toj.test', 'viewer', array['studio']),
    ('other@toj.test', 'member', array['gfs'])`);
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  push.setSender(async () => ({}));
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(session({ secret: "films", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.email === as.kyron ? "staff" : "user"; res.json({ ok: true }); });
  app.use("/api/studio-films", require("../routes/studio-films"));
  app.use("/api/studio-review", require("../routes/studio-review"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of Object.entries(as)) {
    const r = await fetch(base + "/__test/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    cookies[k] = r.headers.get("set-cookie").split(";")[0];
  }
});
after(async () => {
  server && server.close();
  mailer.setSender(null);
  push.setSender(null);
  setSupabase(null);
  if (pool) await pool.end();
});
beforeEach(() => { T.forget(); mails = []; require("../routes/studio-review")._reset(); });

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function room(id, who = "kyron") { return ok(await films("GET", `/films/${id}`, undefined, who), "room"); }
async function step(id, key, who, extra = {}) { return films("POST", `/films/${id}/steps/${key}/done`, extra, who); }

// ffmpeg stood in: what the worker would make, without making it.
const fakeMedia = {
  ...require("../utils/sm-market-media"),
  async probe() { return { duration_ms: 75000, width: 1080, height: 1920 }; },
  async run(args) { const out = args[args.length - 1]; fs.writeFileSync(out, Buffer.from("made:" + out)); return { code: 0, stderr: "" }; },
};
async function uploadCut(film, { who = "ed", people, version = 3, name } = {}) {
  const file_name = name || `SW_YTH_${film.athlete_id}_HERO_9x16_v0${version}_20261117.mp4`;
  const up = ok(await films("POST", `/films/${film.id}/cuts/upload`, { format: "hero", ratio: "9x16", version, file_name, bytes: 4096, people }, who), "upload link");
  const bytes = Buffer.alloc(4096, version);
  store.put(U.BUCKET, up.key, bytes, "video/mp4");
  const reg = ok(await films("POST", `/films/${film.id}/cuts`, { id: up.id, key: up.key, format: "hero", ratio: "9x16", version, file_name, bytes: 4096, people }, who), "register cut");
  const pass = await W.drain({ media: fakeMedia, fetch: store.serve });
  assert.equal(pass.results.find((x) => x.id === reg.cut.id).ok, true, JSON.stringify(pass));
  return { cut: reg.cut, bytes };
}
const tokenFrom = (m) => (/#t=([0-9a-f]{64})/.exec(m.text) || [])[1];

test("a film from brief to takedown, inside the database's rules", async () => {
  // The tools that touch footage start off.
  const meta = ok(await films("GET", "/meta", undefined, "dir"), "meta");
  assert.ok(meta.tools.every((t) => t.is_on === false));
  assert.equal(meta.can.producer, false);
  assert.equal((await films("GET", "/meta", undefined, "viewer")).status, 403);
  assert.equal((await films("GET", "/meta", undefined, "other")).status, 403);

  // A member starts the film; only the producer assigns the crew.
  let r = ok(await films("POST", "/films", { kit_slug: "same-work", title: "A0142 hero", lane: "youth", athlete_id: "a0142", format: "hero", director_email: "dir@toj.test" }, "dir"), "start");
  let film = r.film;
  assert.equal(film.athlete_id, "A0142");
  assert.equal(film.director_email, null);
  assert.equal(film.second_yes_label, "Coach Hooks");
  r = ok(await films("PATCH", `/films/${film.id}`, { seen: film.updated_at, director_email: "dir@toj.test", editor_email: "ed@toj.test", one_sentence: "He ran this drill in 2017. He runs it on Sundays now." }, "lead"), "assign");
  film = r.film;
  assert.equal((await films("PATCH", `/films/${film.id}`, { seen: "2020-01-01T00:00:00Z", title: "x" }, "lead")).data.error, "changed_meanwhile");

  // The brief is the producer's; the board is the director's.
  assert.equal((await step(film.id, "brief", "dir")).data.error, "not_your_step");
  ok(await step(film.id, "brief", "lead"), "brief");
  assert.equal((await step(film.id, "clearance", "lead")).status, 409);
  ok(await step(film.id, "board", "dir"), "board");
  refused(await step(film.id, "clearance", "lead"), /no card, no shoot/);

  // A Texas youth athlete stays unidentifiable, whatever the form says.
  r = ok(await films("POST", `/films/${film.id}/people`, {
    person_code: "a0142", name: "Jamie Rivers", role: "athlete", is_minor: false, texas_youth: true, speaker: true, release_on_file: true,
    covers: { face: true, name: true, jersey: true, voice: true, formats: ["hero", "cutdown"] },
    reviewer_relation: "parent", reviewer_name: "Pat Rivers", reviewer_email: "Pat@Family.test",
  }, "dir"), "card");
  let kid = r.person;
  assert.deepEqual([kid.is_minor, kid.covers.face, kid.covers.name, kid.covers.jersey, kid.covers.voice], [true, false, false, false, true]);
  assert.equal(kid.reviewer_email, "pat@family.test");
  // A minor's cut is approved by a parent or guardian, never by the minor.
  assert.deepEqual((await films("POST", `/films/${film.id}/people`, { person_code: "A0143", name: "Kid Two", role: "athlete", is_minor: true, speaker: true, reviewer_relation: "self", reviewer_name: "Kid Two", reviewer_email: "kid@x.test" }, "dir")).data.fields, ["minor_needs_parent"]);
  // A title never carries a name.
  const named = await films("PATCH", `/films/${film.id}`, { seen: film.updated_at, title: "Jamie's drill" }, "lead");
  assert.equal((named.data.fields || [])[0], "title_has_name", JSON.stringify(named));

  // The producer clears the card; then the steps run on.
  assert.equal((await films("POST", `/films/${film.id}/people/${kid.id}/clear`, { seen: kid.updated_at }, "dir")).data.error, "producer_only");
  kid = ok(await films("POST", `/films/${film.id}/people/${kid.id}/clear`, { seen: kid.updated_at }, "lead"), "clear").person;
  ok(await step(film.id, "clearance", "lead"), "clearance");
  ok(await step(film.id, "shoot", "dir"), "shoot");
  ok(await step(film.id, "selects", "dir"), "selects");
  assert.equal((await step(film.id, "rough_cut", "dir")).data.error, "not_your_step");
  ok(await step(film.id, "rough_cut", "ed"), "rough cut");

  // Review copies wait for the owner's OK, with a reason.
  assert.equal((await films("POST", `/films/${film.id}/cuts/upload`, { format: "hero", ratio: "9x16", version: 3, file_name: "SW_YTH_A0142_HERO_9x16_v03_20261117.mp4", bytes: 4096, people: [kid.id] }, "ed")).data.error, "tool_off");
  assert.equal((await films("POST", "/tools/review_copies", { on: true, note: "checked" }, "lead")).data.error, "owner_only");
  assert.deepEqual((await films("POST", "/tools/review_copies", { on: true }, "kyron")).data.fields, ["note"]);
  ok(await films("POST", "/tools/review_copies", { on: true, note: "Supabase Storage terms checked: no training on stored files. Screenshot saved." }, "kyron"), "tool on");

  // File names carry the athlete ID, never a name.
  assert.deepEqual((await films("POST", `/films/${film.id}/cuts/upload`, { format: "hero", ratio: "9x16", version: 3, file_name: "jamie_final.mp4", bytes: 4096, people: [kid.id] }, "ed")).data.fields, ["file_name_has_name"]);
  assert.ok((await films("POST", `/films/${film.id}/cuts/upload`, { format: "hero", ratio: "9x16", version: 3, file_name: "x.mp4", bytes: 999 * 1024 * 1024, people: [kid.id] }, "ed")).data.fields.includes("too_big"));
  const { cut, bytes } = await uploadCut(film, { people: [kid.id] });
  let rm = await room(film.id, "ed");
  const ready = rm.cuts.find((c) => c.id === cut.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.sha256, require("crypto").createHash("sha256").update(bytes).digest("hex"));
  assert.ok(ready.watch_url);
  assert.deepEqual(ready.warnings, []);

  // The review link goes to the parent, only from the producer.
  assert.equal((await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: kid.id }, "ed")).data.error, "producer_only");
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: kid.id }, "lead"), "send link");
  assert.equal(mails.length, 1);
  const link = mails[0];
  assert.deepEqual(link.to, ["pat@family.test"]);
  assert.equal(link.replyTo, "pat@family.test");
  assert.doesNotMatch(link.text, /Jamie|Rivers/);
  const token = tokenFrom(link);
  assert.ok(token);
  // The database never holds the token or its proof.
  const stored = (await pool.query("select link_hash from studio_reviews")).rows[0].link_hash;
  assert.equal(stored, U.sha256(U.sha256(token)));
  refused(await step(film.id, "speaker_review", "lead", { cut_id: cut.id }), /say yes/);

  // The parent watches and answers.
  const view = await reviewer("/view", { token });
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.equal(view.data.relation, "parent");
  assert.equal(view.data.format, "Hero film");
  assert.match(view.data.video_url, /previews/);
  assert.equal(JSON.stringify(view.data).includes("Jamie"), false);
  assert.equal((await reviewer("/decide", { token, decision: "changes", name: "Pat Rivers", note: "", confirm: true })).data.error, "say_what_to_change");
  assert.equal((await reviewer("/decide", { token, decision: "approved", name: "Pat Rivers" })).data.error, "confirm_required");
  mails = [];
  assert.equal((await reviewer("/decide", { token, decision: "approved", name: "Pat Rivers", confirm: true })).status, 200);
  assert.equal((await reviewer("/decide", { token, decision: "approved", name: "Pat Rivers", confirm: true })).status, 404);
  assert.equal((await reviewer("/view", { token })).status, 404);
  await wait(120);
  assert.deepEqual(mails[0].to, ["pat@family.test"], "the receipt goes first");
  assert.match(mails[0].subject, /approved/i);
  assert.ok(mails[1].to.includes("kyron@toj.test"));
  assert.doesNotMatch(mails[1].text, /Jamie|Rivers|Pat/);

  // The approved cut carries the rest of the steps.
  ok(await step(film.id, "speaker_review", "lead", { cut_id: cut.id }), "speaker review");
  ok(await step(film.id, "rights_check", "lead"), "rights");
  refused(await step(film.id, "final_signoff", "lead"), /Coach Hooks says yes/);
  ok(await films("POST", `/films/${film.id}/second-yes`, { note: "Hooks said yes by text, Nov 17 3:02pm" }, "lead"), "second yes");
  ok(await step(film.id, "final_signoff", "lead"), "final");
  assert.equal((await films("POST", `/films/${film.id}/posts`, { cut_id: cut.id, platform: "instagram", url: "https://instagram.com/p/abc" }, "lead")).data.error, "owner_only");
  const post = ok(await films("POST", `/films/${film.id}/posts`, { cut_id: cut.id, platform: "instagram", url: "https://instagram.com/p/abc" }, "kyron"), "post").post;
  assert.equal((await step(film.id, "publish", "lead")).data.error, "not_your_step");
  ok(await step(film.id, "publish", "kyron"), "publish");
  refused(await films("POST", `/films/${film.id}/steps/rough_cut/reopen`, { note: "redo" }, "lead"), /taken down/);
  // A cleared card in something posted doesn't change quietly.
  rm = await room(film.id);
  kid = rm.people[0];
  refused(await films("PATCH", `/films/${film.id}/people/${kid.id}`, { seen: kid.updated_at, covers: { face: false, voice: false } }, "lead"), /posted/);

  // The family pulls consent: the film is pulled, the clock starts.
  assert.equal((await films("POST", "/people/pull", { person_code: "A0142", confirm: true }, "dir")).data.error, "producer_only");
  assert.equal((await films("POST", "/people/pull", { person_code: "A0142" }, "lead")).data.error, "confirm_first");
  const pulled = ok(await films("POST", "/people/pull", { person_code: "a0142", confirm: true, note: "Parent called" }, "lead"), "pull");
  assert.ok(pulled.takedown);
  assert.equal(new Date(pulled.takedown.due_at) - new Date(pulled.takedown.requested_at), 72 * 3600 * 1000);
  assert.ok(pulled.files_removed >= 3);
  const madeKeys = (await pool.query("select object_key, preview_key, poster_key from studio_film_cuts where id = $1", [cut.id])).rows[0];
  for (const k of Object.values(madeKeys)) assert.equal(store.has(U.BUCKET, k), false, k);
  rm = await room(film.id);
  assert.equal(rm.where.state, "pulled");
  const today = ok(await films("GET", "/today", undefined, "lead"), "today");
  assert.ok(today.needs.some((n) => n.kind === "takedown" && n.person_code === "A0142"));
  const tds = ok(await films("GET", "/takedowns", undefined, "lead"), "takedowns");
  const td = tds.open[0];
  assert.deepEqual(td.items.map((i) => i.what).sort(), ["elsewhere", "post"]);
  assert.equal(td.items.find((i) => i.what === "post").post.url, "https://instagram.com/p/abc");
  ok(await films("POST", `/takedown-items/${td.items.find((i) => i.what === "post").id}/done`, { note: "Deleted on Instagram" }, "lead"), "post down");
  assert.ok((await pool.query("select removed_at from studio_film_posts where id = $1", [post.id])).rows[0].removed_at);
  ok(await films("POST", `/takedown-items/${td.items.find((i) => i.what === "elsewhere").id}/done`, { note: "Drive and board cleared" }, "lead"), "elsewhere down");
  assert.equal(ok(await films("GET", "/takedowns", undefined, "lead"), "takedowns").open.length, 0);

  // The history: in order, from the database, with no names in it.
  const ev = (await pool.query("select kind, subject, by_staff, by_reviewer, note from studio_events where film_id = $1 order by id", [film.id])).rows;
  const kinds = ev.map((e) => e.kind);
  for (const k of ["film_created", "person_added", "person_cleared", "cut_added", "cut_ready", "review_asked", "review_approved", "second_yes", "posted", "consent_pulled", "film_pulled", "takedown_item_done", "post_removed"]) assert.ok(kinds.includes(k), k);
  assert.ok(kinds.indexOf("consent_pulled") < kinds.indexOf("film_pulled"));
  const all = JSON.stringify(ev) + JSON.stringify((await pool.query("select * from team_activity")).rows);
  assert.doesNotMatch(all, /Jamie/);
});

test("a decision needs the reviewer's link: no forging, no second answer, nothing after a change", async () => {
  await pool.query("update studio_tool_approvals set is_on = true, decided_by = 'kyron@toj.test', note = 'ok' where tool = 'review_copies'");
  let film = ok(await films("POST", "/films", { kit_slug: "same-work", title: "B0007 hero", lane: "college", athlete_id: "B0007", format: "hero", one_sentence: "One line." }, "lead"), "start").film;
  let p = ok(await films("POST", `/films/${film.id}/people`, { person_code: "B0007", name: "Alex Doe", role: "athlete", speaker: true, release_on_file: true, covers: { face: true, voice: true }, reviewer_relation: "self", reviewer_name: "Alex Doe", reviewer_email: "alex@x.test" }, "lead"), "card").person;
  const other = ok(await films("POST", `/films/${film.id}/people`, { person_code: "B0008", name: "Sam Roe", role: "coach", release_on_file: true }, "lead"), "card 2").person;
  p = ok(await films("POST", `/films/${film.id}/people/${p.id}/clear`, { seen: p.updated_at }, "lead"), "clear").person;
  const { cut } = await uploadCut(film, { who: "lead", people: [p.id, other.id], version: 1 });
  // Nobody uncleared goes to review; a non-speaker gets no link.
  assert.equal((await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: other.id }, "lead")).data.error, "no_reviewer");
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead"), "link");
  const token = tokenFrom(mails.at(-1));
  // Once a link is out, who's in the cut stays.
  refused(await films("PATCH", `/films/${film.id}/cuts/${cut.id}`, { people: [p.id] }, "lead"), /stays as it was/);
  // Not even the database's owner decides by hand, and a staff member can't
  // write the database's history entries.
  await assert.rejects(pool.query("update studio_reviews set decision = 'approved', decided_name = 'Alex Doe', link_hash = null where cut_id = $1", [cut.id]), /only by the reviewer/);
  await assert.rejects(pool.query("insert into studio_events (film_id, kind, by_staff) values ($1, 'review_approved', 'x@toj.test')", [film.id]), /written by the database/);
  await assert.rejects(pool.query("delete from studio_events"), /kept as it was written/);
  // A role with every right but not the owner's still can't forge history.
  // (As Supabase's service role: every table right, and row security bypassed.)
  await pool.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 't_studio_svc') then create role t_studio_svc nologin; end if; end $$; alter role t_studio_svc bypassrls");
  await pool.query(`grant usage on schema ${SCHEMA} to t_studio_svc; grant all on all tables in schema ${SCHEMA} to t_studio_svc; grant usage on all sequences in schema ${SCHEMA} to t_studio_svc`);
  // What the migration grants service_role.
  await pool.query(`grant execute on function ${SCHEMA}.studio_names_in(uuid, text), ${SCHEMA}.studio_cut_files(${SCHEMA}.studio_film_cuts), ${SCHEMA}.studio_cut_approved(uuid), ${SCHEMA}.studio_tool_on(text) to t_studio_svc`);
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role t_studio_svc");
    await c.query("select set_config('studio.logging', 'on', true)");
    await c.query("savepoint forge");
    await assert.rejects(c.query("insert into studio_events (film_id, kind, by_staff) values ($1, 'review_approved', 'x@toj.test')", [film.id]), /written by the database/);
    await c.query("rollback to savepoint forge");
    // Its own note goes in, as staff notes do.
    await c.query("insert into studio_events (film_id, kind, by_staff, note) values ($1, 'note', 'x@toj.test', 'A note')", [film.id]);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
  // A wrong proof doesn't decide; the right one does, once.
  assert.equal((await reviewer("/decide", { token: "f".repeat(64), decision: "approved", name: "Alex Doe", confirm: true })).status, 404);
  assert.equal((await reviewer("/decide", { token, decision: "changes", name: "Alex Doe", note: "Cut the line about my knee.", confirm: true })).status, 200);
  const row = (await pool.query("select decision, note, approved_fingerprint from studio_reviews where cut_id = $1", [cut.id])).rows[0];
  assert.deepEqual(row, { decision: "changes", note: "Cut the line about my knee.", approved_fingerprint: null });
  const today = ok(await films("GET", "/today", undefined, "lead"), "today");
  assert.ok(today.needs.some((n) => n.kind === "changes" && n.note === "Cut the line about my knee."));
  // Changing a cleared card clears it again (it's in nothing posted).
  const fresh = (await room(film.id)).people.find((x) => x.id === p.id);
  const changed = ok(await films("PATCH", `/films/${film.id}/people/${p.id}`, { seen: fresh.updated_at, covers: { face: false, voice: true } }, "lead"), "change card");
  assert.equal(changed.uncleared, true);
  assert.equal(changed.person.cleared_at, null);
  // The producer can't send a link to an uncleared card.
  refused(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead"), /isn't cleared/);
});

test("an email that fails takes its link back; links per mailbox are capped", async () => {
  await pool.query("update studio_tool_approvals set is_on = true, decided_by = 'kyron@toj.test', note = 'ok' where tool = 'review_copies'");
  const film = ok(await films("POST", "/films", { kit_slug: "same-work", title: "C0001 cut", lane: "nfl", athlete_id: "C0001", format: "hero" }, "lead"), "start").film;
  let p = ok(await films("POST", `/films/${film.id}/people`, { person_code: "C0001", name: "Lee Moe", role: "athlete", speaker: true, release_on_file: true, reviewer_relation: "self", reviewer_name: "Lee Moe", reviewer_email: "lee@x.test" }, "lead"), "card").person;
  p = ok(await films("POST", `/films/${film.id}/people/${p.id}/clear`, { seen: p.updated_at }, "lead"), "clear").person;
  const { cut } = await uploadCut(film, { who: "lead", people: [p.id], version: 1 });
  mailer.setSender(async () => ({ sent: false, reason: "daily_limit" }));
  try {
    assert.equal((await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead")).data.error, "email_failed");
  } finally {
    mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  }
  const live = (await pool.query("select count(*)::int as n from studio_reviews where cut_id = $1 and link_hash is not null", [cut.id])).rows[0].n;
  assert.equal(live, 0);
  // A new link replaces nothing live: one live link per cut and reviewer.
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead"), "link");
  assert.equal((await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead")).data.error, "exists");
  const rv = (await room(film.id)).reviews.find((x) => x.state === "live");
  ok(await films("POST", `/reviews/${rv.id}/cancel-link`, {}, "lead"), "cancel");
  assert.equal((await room(film.id)).reviews.find((x) => x.id === rv.id).state, "cancelled");
});

test("writes are JSON from the app's own pages", async () => {
  const r = await fetch(base + "/api/studio-films/films", { method: "POST", headers: { Cookie: cookies.kyron, "Content-Type": "application/x-www-form-urlencoded" }, body: "title=x" });
  assert.equal(r.status, 415);
  const o = await fetch(base + "/api/studio-films/films", { method: "POST", headers: { Cookie: cookies.kyron, "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  assert.equal(o.status, 403);
  const g = await fetch(base + "/api/studio-review/view", { method: "GET" });
  assert.equal(g.status, 405);
});
