// Studio craft against migrations 039 and 040 in a real Postgres: notes on a
// cut at a timecode and their labels, the delivery check, stills and slides
// going to speaker review like a video cut (marked copies, the files'
// fingerprint, every file gone in a takedown), and the shoot sheet.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_studio_craft_test), which it DROPS and recreates.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const crypto = require("crypto");

const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = "gfs_studio_craft_test";
if (!URL_) {
  test("studio craft (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
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
const cookies = {};
const as = { kyron: "kyron@toj.test", lead: "lead@toj.test", dir: "dir@toj.test", ed: "ed@toj.test" };

before(async () => {
  pool = await makeSchema(URL_, SCHEMA, ["018_studio_kits.sql", "019_team.sql", "020_native_push.sql", "039_studio_films.sql", "040_studio_craft.sql"]);
  sb = pgSupabase(pool, SCHEMA);
  store = fakeStorage();
  sb.storage = store;
  setSupabase(sb);
  await pool.query(`insert into team_members (email, role, tools) values
    ('lead@toj.test', 'approver', array['studio']), ('dir@toj.test', 'member', array['studio']), ('ed@toj.test', 'member', array['studio'])`);
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  push.setSender(async () => ({}));
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(session({ secret: "craft", resave: false, saveUninitialized: false }));
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
const room = async (id, who = "lead") => ok(await films("GET", `/films/${id}`, undefined, who), "room");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const tokenFrom = (m) => (/#t=([0-9a-f]{64})/.exec(m.text) || [])[1];

// ffmpeg stood in: what the worker would make, without making it.
const fakeMedia = (still) => ({
  ...require("../utils/sm-market-media"),
  async probe() { return still ? { duration_ms: null, width: 1080, height: 1350 } : { duration_ms: 75000, width: 1080, height: 1920 }; },
  async run(args) { const out = args[args.length - 1]; fs.writeFileSync(out, Buffer.from("made:" + out)); return { code: 0, stderr: "" }; },
});

// A film with an editor and one cleared adult speaker, ready for cuts.
async function aFilm(code, format = "hero") {
  let film = ok(await films("POST", "/films", { kit_slug: "same-work", title: `${code} ${format}`, lane: "college", athlete_id: code, format, one_sentence: "One line." }, "lead"), "start").film;
  film = ok(await films("PATCH", `/films/${film.id}`, { seen: film.updated_at, director_email: "dir@toj.test", editor_email: "ed@toj.test", plan: { shoot_date: "2026-11-20", locations: ["The Rivers family's driveway, 12 Oak St"], schedule: [{ time: "07:30", what: "B-roll in low light" }], must_have: ["Hands on the sled", "The drive in", "Sunday drill wide"], frame_pair: { opening: "Gate at dawn", closing: "Gate at dusk" } } }, "lead"), "assign").film;
  let p = ok(await films("POST", `/films/${film.id}/people`, { person_code: code, name: "Alex Doe", role: "athlete", speaker: true, release_on_file: true, covers: { face: true, name: true, voice: true }, reviewer_relation: "self", reviewer_name: "Alex Doe", reviewer_email: "alex@x.test" }, "lead"), "card").person;
  p = ok(await films("POST", `/films/${film.id}/people/${p.id}/clear`, { seen: p.updated_at }, "lead"), "clear").person;
  return { film, p };
}
async function videoCut(film, people, version = 1) {
  const file_name = `SW_COL_${film.athlete_id}_HERO_9x16_v0${version}_20261117.mp4`;
  const up = ok(await films("POST", `/films/${film.id}/cuts/upload`, { format: "hero", ratio: "9x16", version, file_name, bytes: 4096, people }, "ed"), "upload link");
  store.put(U.BUCKET, up.key, Buffer.alloc(4096, version), "video/mp4");
  const reg = ok(await films("POST", `/films/${film.id}/cuts`, { id: up.id, key: up.key, format: "hero", ratio: "9x16", version, file_name, bytes: 4096, people }, "ed"), "register");
  await W.drain({ media: fakeMedia(false), fetch: store.serve });
  return reg.cut;
}

test("notes on a cut: where and what, a label that groups, marked done once", async () => {
  const { film, p } = await aFilm("N0001");
  const cut = await videoCut(film, [p.id]);
  // A note at a moment, with a label in plain words.
  const n1 = ok(await films("POST", `/films/${film.id}/cut-notes`, { cut_id: cut.id, at_ms: 12345, note: "Open on the fact, not the wind-up.", label: "Open on the FACT!" }, "lead"), "note").note;
  assert.equal(n1.label, "open on the fact");
  assert.equal(n1.at_ms, 12345);
  // A timecode needs a cut; a cut is this film's.
  assert.deepEqual((await films("POST", `/films/${film.id}/cut-notes`, { at_ms: 1000, note: "x" }, "lead")).data.fields, ["at_ms"]);
  assert.deepEqual((await films("POST", `/films/${film.id}/cut-notes`, { note: "" }, "lead")).data.fields, ["note"]);
  const other = await aFilm("N0002");
  const otherCut = await videoCut(other.film, [other.p.id]);
  refused(await films("POST", `/films/${film.id}/cut-notes`, { cut_id: otherCut.id, note: "Wrong film" }, "lead"), /one of its film's cuts/);
  ok(await films("POST", `/films/${other.film.id}/cut-notes`, { cut_id: otherCut.id, at_ms: 0, note: "Same again here.", label: "open on the fact" }, "dir"), "note 2");
  // Notes are kept for good: no names in them, or in a label.
  assert.deepEqual((await films("POST", `/films/${film.id}/cut-notes`, { cut_id: cut.id, note: "Alex Doe says it too fast" }, "lead")).data.fields, ["note_has_name"]);
  assert.deepEqual((await films("POST", `/films/${film.id}/cut-notes`, { cut_id: cut.id, note: "Alex says it too fast" }, "lead")).data.fields, ["note_may_have_name"]);
  assert.deepEqual((await films("POST", `/films/${film.id}/cut-notes`, { cut_id: cut.id, note: "Too fast", label: "alex too fast" }, "lead")).data.fields, ["label_has_name"]);
  await assert.rejects(pool.query("insert into studio_notes (film_id, note, created_by) values ($1, 'Alex Doe again', 'lead@toj.test')", [film.id]), /no names/);
  ok(await films("POST", `/films/${film.id}/cut-notes`, { note: "The whole cut: music under the voice.", label: "music under the voice" }, "lead"), "note 3");
  ok(await films("POST", `/films/${film.id}/cut-notes`, { cut_id: cut.id, at_ms: 40000, note: "And here.", label: "open on the fact" }, "lead"), "note 4");

  // The room shows them; the editor's Today counts the open ones.
  const rm = await room(film.id, "ed");
  assert.equal(rm.notes.length, 3);
  let today = ok(await films("GET", "/today", undefined, "ed"), "today");
  assert.equal(today.needs.find((x) => x.kind === "notes" && x.film.id === film.id).count, 3);
  assert.equal(ok(await films("GET", "/today", undefined, "dir"), "today").needs.some((x) => x.kind === "notes"), false);

  // Labels, most used first, counted across films.
  const labels = ok(await films("GET", "/labels", undefined, "dir"), "labels").labels;
  assert.deepEqual(labels[0], { label: "open on the fact", notes: 3, films: 2 });
  assert.deepEqual(labels[1], { label: "music under the voice", notes: 1, films: 1 });

  // Marked done once; a note is never rewritten or deleted.
  const done = ok(await films("POST", `/cut-notes/${n1.id}/resolve`, {}, "ed"), "resolve").note;
  assert.equal(done.resolved_by, "ed@toj.test");
  assert.equal((await films("POST", `/cut-notes/${n1.id}/resolve`, {}, "lead")).data.error, "already_done");
  today = ok(await films("GET", "/today", undefined, "ed"), "today");
  assert.equal(today.needs.find((x) => x.kind === "notes" && x.film.id === film.id).count, 2);
  await assert.rejects(pool.query("update studio_notes set note = 'rewritten' where id = $1", [n1.id]), /stays as it was written/);
  await assert.rejects(pool.query("update studio_notes set resolved_at = null, resolved_by = null where id = $1", [n1.id]), /marked done once/);
  await assert.rejects(pool.query("delete from studio_notes where id = $1", [n1.id]), /never deleted/);
});

test("the delivery check: the server checks what the phone read, and keeps it as checked", async () => {
  const { film } = await aFilm("D0001");
  const good = ok(await films("POST", `/films/${film.id}/delivery-checks`, { file_name: "SW_COL_D0001_HERO_9x16_v03_20261117.mp4", format: "hero", ratio: "9x16", duration_ms: 74000, width: 1080, height: 1920, bytes: 12345678 }, "ed"), "check").check;
  assert.equal(good.passed, true, JSON.stringify(good.results));
  // A name in the file name fails, and the name never goes in the record.
  const bad = ok(await films("POST", `/films/${film.id}/delivery-checks`, { file_name: "alex_doe_hero.mp4", format: "hero", ratio: "9x16", duration_ms: 74000, width: 1080, height: 1920 }, "ed"), "check").check;
  assert.equal(bad.passed, false);
  assert.equal(bad.file_name, "(a file name with a name in it)");
  assert.doesNotMatch(JSON.stringify((await pool.query("select * from studio_delivery_checks")).rows), /alex|doe/i);
  assert.deepEqual((await films("POST", `/films/${film.id}/delivery-checks`, { file_name: "x.mp4", format: "hero", ratio: "9x16" }, "ed")).data.fields, ["size"]);
  assert.equal((await room(film.id)).delivery_checks.length, 2);
  await assert.rejects(pool.query("update studio_delivery_checks set passed = true where id = $1", [bad.id]), /kept as it was checked/);
  await assert.rejects(pool.query("delete from studio_delivery_checks"), /kept as it was checked/);
  await assert.rejects(pool.query("truncate studio_delivery_checks"), /kept as it was checked/);
});

test("stills and slides go to the speaker like a cut: marked copies, the files' fingerprint, gone in a takedown", async () => {
  const { film, p } = await aFilm("S0001", "own_words");
  const name = "SW_COL_S0001_WORDS_4x5_v01_20261117";
  const body = { format: "own_words", ratio: "4x5", version: 1, file_name: name, people: [p.id], slides: ["png", "jpg"] };
  // Made in the app with the graphics system: that waits for Kyron and Hooks.
  assert.deepEqual((await films("POST", `/films/${film.id}/slides/upload`, { ...body, made_with: "graphics" }, "ed")).data, { error: "tool_off", tool: "graphics_system" });
  assert.deepEqual((await films("POST", `/films/${film.id}/slides/upload`, { ...body }, "ed")).data.fields, ["made_with"]);
  assert.ok((await films("POST", `/films/${film.id}/slides/upload`, { ...body, made_with: "upload", file_name: "alex quote card" }, "ed")).data.fields.includes("file_name_has_name"));
  assert.deepEqual((await films("POST", `/films/${film.id}/slides/upload`, { ...body, made_with: "upload", slides: ["gif"] }, "ed")).data.fields, ["slides"]);
  assert.deepEqual((await films("POST", `/films/${film.id}/slides/upload`, { ...body, made_with: "upload", slides: new Array(11).fill("png") }, "ed")).data.fields, ["slides"]);
  const up = ok(await films("POST", `/films/${film.id}/slides/upload`, { ...body, made_with: "upload" }, "ed"), "slide links");
  assert.deepEqual(up.uploads.map((x) => [x.key, x.content_type]), [[U.slideKey(film.id, up.id, 1, "png"), "image/png"], [U.slideKey(film.id, up.id, 2, "jpg"), "image/jpeg"]]);
  // Registered only once every slide is in storage.
  store.put(U.BUCKET, up.uploads[0].key, Buffer.from("slide one"), "image/png");
  assert.equal((await films("POST", `/films/${film.id}/slides`, { ...body, made_with: "upload", id: up.id }, "ed")).data.error, "not_uploaded");
  store.put(U.BUCKET, up.uploads[1].key, Buffer.from("slide two"), "image/jpeg");
  const cut = ok(await films("POST", `/films/${film.id}/slides`, { ...body, made_with: "upload", id: up.id }, "ed"), "register").cut;
  assert.equal(cut.kind, "slides");
  assert.equal(cut.made_with, "upload");

  // The database keeps a set's files where the set keeps them.
  await assert.rejects(pool.query("update studio_film_cuts set slide_keys = array['films/x/slides/y/1.png'] where id = $1", [cut.id]), /keeps its files/);
  await assert.rejects(pool.query("update studio_film_cuts set made_with = 'graphics' where id = $1", [cut.id]), /keeps its files/);
  await assert.rejects(pool.query(`insert into studio_film_cuts (film_id, kind, format, ratio, version, file_name, slide_keys, made_with, created_by) values ($1, 'slides', 'own_words', '4x5', 9, 'x', array['films/elsewhere/1.png'], 'upload', 'ed@toj.test')`, [film.id]), /isn't where this set keeps it/);
  await assert.rejects(pool.query(`insert into studio_film_cuts (film_id, kind, format, ratio, version, file_name, object_key, made_with, created_by) values ($1, 'video', 'hero', '9x16', 9, 'x', $2, 'upload', 'ed@toj.test')`, [film.id, `films/${film.id}/cuts/${crypto.randomUUID()}.mp4`]), /one uploaded file/);

  // The worker: marked copies, the fingerprint of the files themselves.
  const pass = await W.drain({ media: fakeMedia(true), fetch: store.serve });
  assert.equal(pass.results.find((x) => x.id === cut.id).ok, true, JSON.stringify(pass));
  const row = (await pool.query("select status, sha256, preview_sha256, preview_key, poster_key from studio_film_cuts where id = $1", [cut.id])).rows[0];
  assert.equal(row.status, "ready");
  assert.equal(row.sha256, crypto.createHash("sha256").update(sha(Buffer.from("slide one")) + "\n" + sha(Buffer.from("slide two")), "utf8").digest("hex"));
  assert.equal(row.preview_key, U.slideCopyPrefix(film.id, cut.id, row.preview_sha256));
  for (const n of [1, 2]) assert.ok(store.has(U.BUCKET, `${row.preview_key}${n}.jpg`), `copy ${n}`);
  // The database holds the copies' place: under their own fingerprint.
  await assert.rejects(pool.query(`update studio_film_cuts set preview_key = 'films/x/' where id = $1`, [cut.id]), /ready/);
  // The team sees the copies, never the files.
  const rm = await room(film.id, "ed");
  const seen = rm.cuts.find((c) => c.id === cut.id);
  assert.equal(seen.slide_urls.length, 2);
  for (const u of seen.slide_urls) assert.match(u, /\/previews\//);
  assert.equal(seen.watch_url, null);

  // The speaker approves the set on their link, seeing the copies.
  ok(await films("POST", `/films/${film.id}/cuts/${cut.id}/reviews`, { person_id: p.id }, "lead"), "link");
  const token = tokenFrom(mails.at(-1));
  const view = await reviewer("/view", { token });
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.equal(view.data.kind, "slides");
  assert.equal(view.data.format, "In Their Own Words");
  assert.equal(view.data.slides.length, 2);
  for (const u of view.data.slides) assert.match(u, /\/previews\//);
  assert.doesNotMatch(JSON.stringify(view.data), /\/slides\//);
  assert.equal((await reviewer("/decide", { token, decision: "approved", name: "Alex Doe", confirm: true })).status, 200);
  assert.equal((await pool.query("select approved_fingerprint from studio_reviews where cut_id = $1", [cut.id])).rows[0].approved_fingerprint, row.sha256);

  // A set nobody reviewed can be removed, with every file it made.
  const up2 = ok(await films("POST", `/films/${film.id}/slides/upload`, { ...body, version: 2, made_with: "upload", slides: ["png"] }, "ed"), "slide links 2");
  store.put(U.BUCKET, up2.uploads[0].key, Buffer.from("draft"), "image/png");
  const cut2 = ok(await films("POST", `/films/${film.id}/slides`, { ...body, version: 2, made_with: "upload", slides: ["png"], id: up2.id }, "ed"), "register 2").cut;
  await W.drain({ media: fakeMedia(true), fetch: store.serve });
  const copy2 = (await pool.query("select preview_key from studio_film_cuts where id = $1", [cut2.id])).rows[0].preview_key + "1.jpg";
  assert.ok(store.has(U.BUCKET, copy2));
  ok(await films("DELETE", `/films/${film.id}/cuts/${cut2.id}`, {}, "ed"), "delete");
  assert.equal(store.has(U.BUCKET, up2.uploads[0].key), false);
  assert.equal(store.has(U.BUCKET, copy2), false);

  // Consent pulled: every file of the film leaves storage, copies included.
  const pulled = ok(await films("POST", "/people/pull", { person_code: "S0001", confirm: true, note: "Called" }, "lead"), "pull");
  assert.ok(pulled.files_removed >= 4, JSON.stringify(pulled));
  const files = (await pool.query("select k from studio_film_cuts c, lateral studio_cut_files(c) as k where c.id = $1", [cut.id])).rows.map((x) => x.k);
  assert.deepEqual(files.sort(), [...up.uploads.map((x) => x.key), `${row.preview_key}1.jpg`, `${row.preview_key}2.jpg`].sort());
  for (const k of files) assert.equal(store.has(U.BUCKET, k), false, k);
  assert.equal((await films("POST", `/films/${film.id}/slides/upload`, { ...body, version: 3, made_with: "upload" }, "ed")).data.error, "film_closed");
});

test("slides made in the app wait for the graphics system to be approved", async () => {
  const { film, p } = await aFilm("G0001", "quote_card");
  ok(await films("POST", "/tools/graphics_system", { on: true, note: "Kyron and Hooks approved the type system, Nov 18" }, "kyron"), "graphics on");
  const body = { format: "quote_card", ratio: "4x5", version: 1, file_name: "SW_COL_G0001_QUOTE_4x5_v01_20261118", people: [p.id], slides: ["png"], made_with: "graphics" };
  const up = ok(await films("POST", `/films/${film.id}/slides/upload`, body, "ed"), "links");
  store.put(U.BUCKET, up.uploads[0].key, Buffer.from("quote"), "image/png");
  const cut = ok(await films("POST", `/films/${film.id}/slides`, { ...body, id: up.id }, "ed"), "register").cut;
  assert.equal(cut.made_with, "graphics");
  ok(await films("POST", "/tools/graphics_system", { on: false }, "kyron"), "graphics off");
  assert.equal((await films("POST", `/films/${film.id}/slides/upload`, { ...body, version: 2 }, "ed")).data.tool, "graphics_system");
});

test("the shoot sheet: what the phone keeps for a dead signal has no names, contacts or places", async () => {
  const { film } = await aFilm("H0001", "same_drill");
  ok(await films("POST", `/films/${film.id}/people`, { person_code: "H0002", name: "Jordan Kid", role: "athlete", texas_youth: true, release_on_file: true, covers: { voice: true }, reviewer_relation: "parent", reviewer_name: "Pat Kid", reviewer_email: "pat@kid.test" }, "dir"), "kid");
  const d = ok(await films("GET", `/films/${film.id}/shoot`, undefined, "dir"), "shoot");
  const kept = JSON.stringify(d.offline);
  for (const word of ["Alex", "Doe", "Jordan", "Pat", "kid.test", "x.test", "Oak St", "driveway"]) assert.equal(kept.includes(word), false, word);
  assert.deepEqual(d.offline.people.map((x) => [x.code, x.cleared, x.texas_youth, x.is_minor]), [["H0001", true, false, false], ["H0002", false, true, true]]);
  assert.deepEqual(d.offline.must_have, ["Hands on the sled", "The drive in", "Sunday drill wide"]);
  assert.equal(d.offline.schedule[0].time, "07:30");
  assert.deepEqual(d.offline.cards.map((c) => c.title), ["6. Minors on set", "3. Thirteen interview rules", "4. Run the day", "5. The Same Drill match cut"]);
  assert.equal(d.offline.checklist.length, 13);
  // Online, the names and places are there for the director.
  assert.equal(Object.values(d.names).sort().join(","), "Alex Doe,Jordan Kid");
  assert.deepEqual(d.locations, ["The Rivers family's driveway, 12 Oak St"]);
});
