// Real words, three directions, the taste library and briefs not started,
// against migrations 039, 040 and 041 in a real Postgres: whose words can be
// kept (adults first), a line kept only as the transcript has it, Claude
// reading transcripts only while Kyron has it on (and its run keeping no
// words), a pulled consent taking the words and everything built on them,
// the directions a producer picks, and Today's briefs.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_studio_words_test), which it DROPS and recreates.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = "gfs_studio_words_test";
if (!URL_) {
  test("studio words (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@toj.test";

const express = require("express");
const session = require("express-session");
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { fakeStorage } = require("./helpers/fake-storage");
const { setSupabase } = require("../utils/supabase");
const mailer = require("../utils/mailer");
const push = require("../utils/push");
const T = require("../utils/team");
const TP = require("../public/app/transcript-parse.js");
const wordsTools = require("../agents/studio-words/tools");
const directionsTools = require("../agents/studio-directions/tools");

let pool, sb, server, base;
const cookies = {};
const as = { kyron: "kyron@toj.test", lead: "lead@toj.test", dir: "dir@toj.test", ed: "ed@toj.test", other: "other@toj.test" };
const wordsRouter = require("../routes/studio-words");
const agentsRouter = require("../routes/studio-agents");

before(async () => {
  pool = await makeSchema(URL_, SCHEMA, ["018_studio_kits.sql", "019_team.sql", "020_native_push.sql", "039_studio_films.sql", "040_studio_craft.sql", "041_studio_words.sql"]);
  // The columns of agent_runs the routes write (an earlier migration made them in production).
  await pool.query(`alter table agent_runs add column if not exists role text, add column if not exists client_id text, add column if not exists task text,
    add column if not exists status text, add column if not exists created_by text, add column if not exists output text, add column if not exists trace jsonb,
    add column if not exists usage jsonb, add column if not exists error text, add column if not exists eval_status text, add column if not exists retry_count int,
    add column if not exists eval_summary text, add column if not exists eval_biggest_miss text, add column if not exists completed_at timestamptz,
    add column if not exists created_at timestamptz not null default now()`);
  sb = pgSupabase(pool, SCHEMA);
  sb.storage = fakeStorage();
  setSupabase(sb);
  agentsRouter._setDeps({ sb, run: async () => ({ output: "ok", trace: [], eval_status: "not_run" }) });
  await pool.query(`insert into team_members (email, role, tools) values
    ('lead@toj.test', 'approver', array['studio']), ('dir@toj.test', 'member', array['studio']), ('ed@toj.test', 'member', array['studio']), ('other@toj.test', 'member', array['studio'])`);
  mailer.setSender(async () => ({ sent: true }));
  push.setSender(async () => ({}));
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(session({ secret: "words", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.email === as.kyron ? "staff" : "user"; res.json({ ok: true }); });
  app.use("/api/studio-films", require("../routes/studio-films"));
  app.use("/api/studio-words", wordsRouter);
  app.use("/api/studio-taste", require("../routes/studio-taste"));
  app.use("/api/studio-agents", agentsRouter);
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
  agentsRouter._setDeps({ sb: null, run: null });
  wordsRouter._setDeps({ words: null, directions: null });
  if (pool) await pool.end();
});
beforeEach(() => T.forget());

async function call(method, path, body, who = "kyron") {
  const r = await fetch(base + path, { method, headers: { Cookie: cookies[who], ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
const films = (m, p, b, w) => call(m, "/api/studio-films" + p, b, w);
const words = (m, p, b, w) => call(m, "/api/studio-words" + p, b, w);
const ok = (r, what) => { assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SRT = `1
00:00:01,000 --> 00:00:04,000
Coach: I ran this drill in 2017.

2
00:00:04,500 --> 00:00:08,000
I still run it on Sundays.

3
00:00:08,000 --> 00:00:09,000
Interviewer: Why?

4
00:00:09,000 --> 00:00:12,000
Coach: Because it’s mine. It made me.
`;
// The browser's part: parse the file, keep the speaker's cues only.
const coachCues = () => TP.only(TP.parse(SRT).cues, "Coach").map(({ s, e, t }) => ({ s, e, t }));

let n = 0;
// A film with a cleared adult speaker (voice covered), and more cards as asked.
async function aFilm(extra = []) {
  const code = "W" + String(1000 + ++n);
  let film = ok(await films("POST", "/films", { kit_slug: "same-work", title: `${code} hero`, lane: "college", athlete_id: code, format: "hero", one_sentence: "He ran this drill in 2017." }, "lead"), "start").film;
  film = ok(await films("PATCH", `/films/${film.id}`, { seen: film.updated_at, director_email: "dir@toj.test", editor_email: "ed@toj.test" }, "lead"), "assign").film;
  const cards = [{ person_code: code, name: "Marcus Hill", role: "coach", speaker: true, release_on_file: true, covers: { face: true, name: true, voice: true }, reviewer_relation: "self", reviewer_name: "Marcus Hill", reviewer_email: "marcus@x.test" }, ...extra];
  const people = [];
  for (const c of cards) {
    let p = ok(await films("POST", `/films/${film.id}/people`, c, "lead"), "card").person;
    if (c.clear !== false) p = ok(await films("POST", `/films/${film.id}/people/${p.id}/clear`, { seen: p.updated_at }, "lead"), "clear").person;
    people.push(p);
  }
  return { film, people, code };
}
async function addTranscript(film, person, cues = coachCues(), who = "ed") {
  return words("POST", `/films/${film.id}/transcripts`, { person_id: person.id, label: "Interview 1", cues }, who);
}
async function runDone(id, who = "ed") {
  for (let i = 0; i < 100; i++) {
    const r = ok(await words("GET", `/runs/${id}`, undefined, who), "poll").run;
    if (r.status !== "running") return r;
    await wait(30);
  }
  throw new Error("run never finished");
}

test("whose words can be kept: adults first, a cleared speaker whose release covers their voice", async () => {
  const kid = { person_code: "WK01", name: "Ty Ng", role: "athlete", is_minor: true, speaker: true, release_on_file: true, covers: { voice: true }, reviewer_relation: "parent", reviewer_name: "Lin Ng", reviewer_email: "lin@x.test" };
  const quiet = { person_code: "WQ01", name: "Sam Roe", role: "parent", release_on_file: true, covers: { face: true } };
  const novoice = { person_code: "WV01", name: "Dee Fox", role: "coach", speaker: true, release_on_file: true, covers: { face: true }, reviewer_relation: "self", reviewer_name: "Dee Fox", reviewer_email: "dee@x.test" };
  const later = { person_code: "WL01", name: "Bea Cole", role: "coach", speaker: true, release_on_file: true, covers: { voice: true }, reviewer_relation: "self", reviewer_name: "Bea Cole", reviewer_email: "bea@x.test", clear: false };
  const { film, people } = await aFilm([kid, quiet, novoice, later]);
  const [adult, minor, nonSpeaker, noVoice, uncleared] = people;
  const why = async (p) => (await addTranscript(film, p)).data;
  assert.deepEqual(await why(minor), { error: "words_not_usable", why: "adults_first" });
  assert.equal((await why(nonSpeaker)).why, "not_a_speaker");
  assert.equal((await why(noVoice)).why, "voice_not_covered");
  assert.equal((await why(uncleared)).why, "not_cleared");
  const t = ok(await addTranscript(film, adult), "the adult speaker's words").transcript;
  assert.equal(t.cue_count, 3);
  // The label keeps no names; the database holds the same rules.
  assert.deepEqual((await words("POST", `/films/${film.id}/transcripts`, { person_id: adult.id, label: "Marcus interview", cues: coachCues() }, "ed")).data.fields, ["label_has_name"]);
  await assert.rejects(pool.query("insert into studio_transcripts (film_id, person_id, label, cues, cue_count, words, duration_ms, created_by) values ($1, $2, 'x', '[{\"n\":1,\"s\":0,\"e\":5,\"t\":\"hi\"}]', 1, 1, 5, 'ed@toj.test')", [film.id, minor.id]), /adults first/);
  await assert.rejects(pool.query("insert into studio_transcripts (film_id, person_id, label, cues, cue_count, words, duration_ms, created_by) values ($1, $2, 'x', '[{\"n\":2,\"s\":0,\"e\":5,\"t\":\"hi\"}]', 1, 1, 5, 'ed@toj.test')", [film.id, adult.id]), /numbered cue/);
  // The room lists the transcript without its words; the words come one transcript at a time.
  const room = ok(await words("GET", `/films/${film.id}`, undefined, "dir"), "room");
  assert.equal(room.transcripts.length, 1);
  assert.equal(JSON.stringify(room.transcripts).includes("Sundays"), false);
  assert.equal(ok(await words("GET", `/transcripts/${t.id}`, undefined, "dir"), "cues").transcript.cues[1].t, "I still run it on Sundays.");
});

test("a line is kept only as the transcript has it, with its times worked out", async () => {
  const { film, people } = await aFilm([{ person_code: "WK02", name: "Bo Kidd", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: false } }]);
  const t = ok(await addTranscript(film, people[0]), "transcript").transcript;
  const line = ok(await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 1, to_cue: 2, quote: "drill in 2017. I still run it", note: "The turn" }, "ed"), "line").line;
  assert.deepEqual([line.quote, line.start_ms, line.end_ms], ["drill in 2017. I still run it", 2500, 6833]);
  const bad = await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 1, to_cue: 1, quote: "I ran a drill in 2017" }, "ed");
  assert.equal(bad.status, 400);
  assert.match(bad.data.issues[0], /exact words/);
  // A caption opens on the line and stays under 60 words.
  ok(await words("POST", `/films/${film.id}/lines`, { kind: "caption", transcript_id: t.id, from_cue: 3, to_cue: 3, quote: "It made me", after: "Seven years of Sundays." }, "ed"), "caption");
  assert.match((await words("POST", `/films/${film.id}/lines`, { kind: "caption", transcript_id: t.id, from_cue: 3, to_cue: 3, quote: "It made me", after: "word ".repeat(60) }, "ed")).data.issues[0], /under 60/);
  const room = ok(await words("GET", `/films/${film.id}`, undefined, "dir"), "room");
  assert.deepEqual([room.words.lines.length, room.words.captions[0].text], [1, "“It made me” Seven years of Sundays."]);
  // The database checks the same: the words, the times, no names.
  const ins = (quote, s, e, from = 1, to = 1) => pool.query("insert into studio_words (film_id, kind, transcript_id, from_cue, to_cue, quote, start_ms, end_ms, made_by, created_by) values ($1, 'line', $2, $3, $4, $5, $6, $7, 'ed@toj.test', 'ed@toj.test')", [film.id, t.id, from, to, quote, s, e]);
  await assert.rejects(ins("I ran a drill", 1000, 2000), /exact words/);
  await assert.rejects(ins("I ran this drill", 500, 2000), /inside its cues/);
  await assert.rejects(ins("I ran this drill", 1000, 2000, 1, 13), /names cues/);
  await assert.rejects(pool.query("update studio_words set note = 'x' where film_id = $1", [film.id]), /kept as it was picked/);
  // A member who isn't on the film can't remove a line; its editor can.
  const id = room.words.lines[0].id;
  assert.equal((await words("DELETE", `/words/${id}`, {}, "other")).status, 403);
  ok(await words("DELETE", `/words/${id}`, {}, "ed"), "removed");
});

test("Claude reads the transcripts only while Kyron has it on, and its run keeps no words", async () => {
  const { film, people } = await aFilm();
  const t = ok(await addTranscript(film, people[0]), "transcript").transcript;
  ok(await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 2, to_cue: 2, quote: "I still run it on Sundays" }, "ed"), "a line by hand");
  assert.deepEqual((await words("POST", `/films/${film.id}/ask-claude`, {}, "ed")).data, { error: "tool_off", tool: "claude_transcripts" });
  ok(await films("POST", "/tools/claude_transcripts", { on: true, note: "Anthropic's terms checked: no training on API data" }, "kyron"), "on");
  assert.equal((await words("POST", `/films/${film.id}/ask-claude`, {}, "other")).data.error, "not_your_film");
  let seen = null;
  wordsRouter._setDeps({
    words: async ({ scope }) => {
      seen = scope;
      const tools = wordsTools.toolsFor({ scope });
      const submit = tools.find((x) => x.name === "submit_words");
      const q = (from, to, quote) => ({ transcript: "T1", from_cue: from, to_cue: to, quote });
      const input = { lines: [{ ...q(3, 3, "It made me"), why: "His, and short" }], structures: [{ title: "Open on the drill", logline: "The drill first", beats: [q(1, 1, "I ran this drill in 2017"), q(2, 2, "I still run it on Sundays"), q(3, 3, "It made me")] }], cutdowns: [{ title: "Sundays", hook: q(3, 3, "It made me") }] };
      assert.match(await submit.run(input), /^Kept/);
      return { output: "The strongest is “It made me”.", trace: [{ type: "tool_use", name: "submit_words", input }], eval_status: "not_run" };
    },
  });
  try {
    const r = ok(await words("POST", `/films/${film.id}/ask-claude`, {}, "ed"), "ask");
    const done = await runDone(r.run_id);
    assert.equal(done.status, "completed", JSON.stringify(done));
    // Claude saw the speaker by role and code, never by name.
    assert.equal(seen.transcripts[0].speaker, `the coach (${people[0].person_code})`);
    assert.equal(JSON.stringify(seen.film).includes("Marcus"), false);
    const room = ok(await words("GET", `/films/${film.id}`, undefined, "dir"), "room");
    assert.equal(room.words.structures[0].beats.length, 3);
    assert.equal(room.words.lines.length, 2, "Claude's line and the one picked by hand");
    // The run's row has counts, and which tools ran: no words.
    const row = (await pool.query("select output, trace from agent_runs where id = $1", [r.run_id])).rows[0];
    assert.match(row.output, /^Picked 1 lines, 1 structures, 1 cutdowns, 0 captions/);
    assert.equal(JSON.stringify(row).includes("made me"), false);
    assert.deepEqual(row.trace, [{ type: "tool_use", name: "submit_words" }]);
    // Asked again: Claude's earlier set is replaced; the line picked by hand stays.
    const again = ok(await words("POST", `/films/${film.id}/ask-claude`, {}, "ed"), "ask again");
    await runDone(again.run_id);
    const room2 = ok(await words("GET", `/films/${film.id}`, undefined, "dir"), "room");
    assert.deepEqual([room2.words.structures.length, room2.words.lines.filter((l) => l.made_by === "claude").length, room2.words.lines.filter((l) => l.made_by === "ed@toj.test").length], [1, 1, 1]);
  } finally {
    wordsRouter._setDeps({ words: null });
  }
});

test("a pulled consent takes the speaker's words, and anything built on them, with it", async () => {
  const { film, people, code } = await aFilm([{ person_code: "WP02", name: "Ann Lee", role: "parent", speaker: true, release_on_file: true, covers: { voice: true }, reviewer_relation: "self", reviewer_name: "Ann Lee", reviewer_email: "ann@x.test" }]);
  const [coach, parent] = people;
  const t1 = ok(await addTranscript(film, coach), "coach").transcript;
  const t2 = ok(await addTranscript(film, parent, [{ s: 0, e: 2000, t: "He never missed a Sunday." }, { s: 2000, e: 4000, t: "Not one." }]), "parent").transcript;
  const rows = [
    { kind: "line", transcript_id: t2.id, from_cue: 2, to_cue: 2, quote: "Not one", start_ms: 2000, end_ms: 4000 },
    { id: "11111111-1111-4111-8111-111111111111", kind: "structure", title: "Both voices" },
    { kind: "beat", group_id: "11111111-1111-4111-8111-111111111111", position: 1, transcript_id: t1.id, from_cue: 1, to_cue: 1, quote: "I ran this drill in 2017", start_ms: 1000, end_ms: 3500 },
    { kind: "beat", group_id: "11111111-1111-4111-8111-111111111111", position: 2, transcript_id: t2.id, from_cue: 1, to_cue: 1, quote: "He never missed a Sunday", start_ms: 0, end_ms: 2000 },
    { kind: "line", transcript_id: t1.id, from_cue: 3, to_cue: 3, quote: "It made me", start_ms: 10500, end_ms: 12000 },
  ];
  assert.equal((await pool.query("select studio_words_save($1, null, 'ed@toj.test', 'ed@toj.test', $2::jsonb, false) as n", [film.id, JSON.stringify(rows)])).rows[0].n, 5);
  // The parent's release stops covering their voice: their words go, and so does the structure that used them.
  let card = (await pool.query("select updated_at from studio_film_people where id = $1", [parent.id])).rows[0];
  ok(await films("PATCH", `/films/${film.id}/people/${parent.id}`, { seen: card.updated_at, covers: { face: true, voice: false } }, "lead"), "voice no longer covered");
  let left = (await pool.query("select kind, quote from studio_words where film_id = $1 order by kind, quote", [film.id])).rows;
  assert.deepEqual(left, [{ kind: "line", quote: "It made me" }]);
  assert.equal((await pool.query("select count(*)::int as n from studio_transcripts where id = $1", [t2.id])).rows[0].n, 0);
  // The coach's consent is pulled: their transcript and lines are gone too.
  ok(await films("POST", "/people/pull", { person_code: code, confirm: true }, "lead"), "pull");
  assert.equal((await pool.query("select count(*)::int as n from studio_transcripts where film_id = $1", [film.id])).rows[0].n, 0);
  assert.equal((await pool.query("select count(*)::int as n from studio_words where film_id = $1", [film.id])).rows[0].n, 0);
  assert.equal((await addTranscript(film, coach)).data.error, "film_closed");
  void t1;
});

test("three directions for a film: no names in them, and the producer picks", async () => {
  const { film, people } = await aFilm([{ person_code: "WK03", name: "Jo Park", role: "athlete", is_minor: true, release_on_file: true, covers: {} }]);
  let r0 = (await pool.query("select updated_at, plan from studio_films where id = $1", [film.id])).rows[0];
  ok(await films("PATCH", `/films/${film.id}`, { seen: r0.updated_at, plan: { speaker: { role_in_life: "Marcus coaches Jo on Sundays" } } }, "lead"), "board");
  let seen = null;
  wordsRouter._setDeps({
    directions: async ({ scope }) => {
      seen = scope;
      const tools = directionsTools.toolsFor({ scope });
      const submit = tools.find((x) => x.name === "submit_directions");
      const d = (name, logline, beats) => ({ name, logline, beats, look: "Low sun", must_have: ["Cones from above", "Hands on the sled", "The gate at dusk"], why: "His routine" });
      const three = [
        d("Open on the drill", "The drill first, then why he still runs it", ["Cones set at first light", "Hands on the sled, close", "A line about the first Sunday"]),
        d("Start at the end", "The last rep of the day, then back to 2017", ["The empty field at dusk", "Archive frame of the same drill", "A line about what it made him"]),
        d("One take", "One unbroken pass of the whole drill, no cuts", ["Wide, locked off, the full run", "Breath and cleats on the turf", "His voice over the last metres"]),
      ];
      const out = await submit.run({ directions: three, recommended: 2, why_recommended: "Strongest close", questions: ["Is the 2017 footage cleared to use?"] });
      assert.match(out, /^Kept/, out);
      return { output: "Three ways.", trace: [], eval_status: "not_run" };
    },
  });
  try {
    assert.equal((await words("POST", `/films/${film.id}/directions`, {}, "ed")).data.error, "producer_only");
    const r = ok(await words("POST", `/films/${film.id}/directions`, {}, "dir"), "directions");
    const done = await runDone(r.run_id, "dir");
    assert.equal(done.status, "completed", JSON.stringify(done));
    // The board's notes reached the agent with names as codes.
    assert.equal(seen.film.board.speaker.role_in_life, `${people[0].person_code} coaches ${people[1].person_code} on Sundays`);
    assert.deepEqual(seen.cards.map((c) => [c.code, c.minor]), [[people[0].person_code, false], ["WK03", true]]);
    const room = ok(await words("GET", `/films/${film.id}`, undefined, "dir"), "room");
    const set = room.directions[0];
    assert.deepEqual([set.directions.length, set.recommended, set.why_recommended, set.questions], [3, 2, "Strongest close", ["Is the 2017 footage cleared to use?"]]);
    assert.equal((await words("POST", `/directions/${set.id}/pick`, { n: 2 }, "dir")).status, 403);
    assert.equal(ok(await words("POST", `/directions/${set.id}/pick`, { n: 2 }, "lead"), "pick").directions.picked, 2);
    await assert.rejects(pool.query("insert into studio_film_directions (film_id, directions, created_by) values ($1, $2, 'lead@toj.test')", [film.id, JSON.stringify([{ name: "Marcus Hill at dawn" }, {}, {}])]), /no names/);
  } finally {
    wordsRouter._setDeps({ directions: null });
  }
});

test("the taste library: notes and a link, never a picture; found by any form of a word; cited by briefs", async () => {
  const add = (body, who = "dir") => call("POST", "/api/studio-taste", body, who);
  assert.deepEqual((await add({ title: "x", url: "https://cdn.example.com/still.jpg?w=1", note: "y" })).data.fields, ["url_is_an_image"]);
  assert.deepEqual((await add({ title: "x", url: "http://vimeo.com/1", note: "y" })).data.fields, ["url"]);
  assert.deepEqual((await add({ title: "An elite look", url: "https://vimeo.com/1", note: "y" })).data.fields, ["banned_words"]);
  const e1 = ok(await add({ title: "Super 8 skate film", url: "https://vimeo.com/76979871", kind: "look", note: "Grainy, warm, handheld; the cuts land on the beat.", take: "The grain size and the warm highlights", leave: "The fisheye", tags: ["Grain", "super 8", "grain"] }), "add").entry;
  assert.deepEqual([e1.ref, e1.tags], [`Taste ${e1.ref_no}`, ["grain", "super 8"]]);
  ok(await add({ title: "A one-take portrait", url: "https://www.youtube.com/watch?v=abc", kind: "film", note: "One unbroken take of a man shaping a board.", tags: ["one take"] }, "ed"), "add 2");
  const find = async (qs) => ok(await call("GET", "/api/studio-taste" + qs, undefined, "lead"), "search").entries.map((x) => x.title);
  assert.deepEqual(await find("?q=grain"), ["Super 8 skate film"], "grain finds grainy");
  assert.deepEqual(await find("?q=shaping"), ["A one-take portrait"]);
  assert.deepEqual(await find("?tag=one%20take"), ["A one-take portrait"]);
  assert.equal((await find("")).length, 2);
  // Changed by whoever added it (or the producer); archived, never deleted.
  assert.equal((await call("PATCH", `/api/studio-taste/${e1.id}`, { seen: e1.updated_at, note: "x" }, "ed")).status, 403);
  const e1b = ok(await call("PATCH", `/api/studio-taste/${e1.id}`, { seen: e1.updated_at, take: "The warm highlights" }, "dir"), "edit").entry;
  assert.equal((await call("PATCH", `/api/studio-taste/${e1.id}`, { seen: e1.updated_at, take: "stale" }, "dir")).data.error, "changed_meanwhile");
  ok(await call("POST", `/api/studio-taste/${e1.id}/archive`, { archived: true }, "lead"), "archive");
  assert.deepEqual(await find("?q=grain"), []);
  // One note, archived too, to edit it; who can edit it says so.
  const one = ok(await call("GET", `/api/studio-taste/${e1.id}`, undefined, "ed"), "one");
  assert.deepEqual([one.entry.ref, !!one.entry.archived_at, one.can.edit], [e1.ref, true, false]);
  assert.equal(ok(await call("GET", `/api/studio-taste/${e1.id}`, undefined, "dir"), "mine").can.edit, true);
  assert.equal((await call("GET", "/api/studio-taste/00000000-0000-4000-8000-000000000000", undefined, "dir")).status, 404);
  assert.equal((await call("GET", "/api/studio-taste/tags", undefined, "dir")).status, 200, "tags still answer as tags");
  await assert.rejects(pool.query("delete from studio_taste where id = $1", [e1.id]), /archived, not deleted/);
  await assert.rejects(pool.query("insert into studio_taste (title, url, note, added_by) values ('x', 'https://x.test/a.PNG', 'y', 'dir@toj.test')"), /check constraint|picture or a video file/);
  // An image service's own address, an ending hidden behind ";v=2" or "%2E", a video file: all refused, by the app and the database.
  for (const url of ["https://pbs.twimg.com/media/abc?format=jpg", "https://x.test/a.jpg;v=2", "https://x.test/a%2Ejpg", "https://x.test/clip.mp4", "https://x.test/a.jpg/", "https://www.instagram.com/p/Cxyz123/media/?size=l"]) {
    assert.deepEqual((await add({ title: "x", url, note: "y" })).data.fields, ["url_is_an_image"], url);
    await assert.rejects(pool.query("insert into studio_taste (title, url, note, added_by) values ('x', $1, 'y', 'dir@toj.test')", [url]), /picture or a video file/, url);
  }
  void e1b;
});

test("a brief that came back waits on Today until it's started or set aside", async () => {
  const brief = async (title) => (await pool.query("insert into agent_runs (role, status, task, output, created_by) values ('brief-writer', 'completed', $1, $2, 'dir@toj.test') returning id", [`Kyron's idea:\n${title}`, `# ${title}\n\nbody`])).rows[0].id;
  const a = await brief("Add the grain look");
  const b = await brief("A gear re-check");
  const c = await brief("A new format");
  const list = async (who = "dir") => ok(await call("GET", "/api/studio-agents/briefs/unstarted", undefined, who), "unstarted").briefs.map((x) => x.label);
  assert.deepEqual((await list()).sort(), ["A gear re-check", "A new format", "Add the grain look"]);
  assert.deepEqual(await list("ed"), [], "someone else's briefs aren't yours to start");
  // Started from direction 2: it leaves Today.
  ok(await call("POST", "/api/studio-agents/run", { role: "kit-refresher", slug: "same-work", brief: "Goal: add the grain look as a proposed option.", from_brief: a, direction: 2 }, "dir"), "start");
  assert.deepEqual((await list()).sort(), ["A gear re-check", "A new format"]);
  const mark = (await pool.query("select direction, started_by from studio_brief_marks where brief_run_id = $1", [a])).rows[0];
  assert.deepEqual(mark, { direction: 2, started_by: "dir@toj.test" });
  // Set aside, and brought back.
  assert.equal((await call("POST", `/api/studio-agents/briefs/${b}/set-aside`, {}, "ed")).status, 403);
  ok(await call("POST", `/api/studio-agents/briefs/${b}/set-aside`, {}, "dir"), "aside");
  assert.deepEqual(await list(), ["A new format"]);
  ok(await call("POST", `/api/studio-agents/briefs/${b}/set-aside`, { aside: false }, "dir"), "back");
  assert.deepEqual((await list()).sort(), ["A gear re-check", "A new format"]);
  // A started brief stays started: the app can't set it aside or bring it back.
  await assert.rejects(pool.query("delete from studio_brief_marks where brief_run_id = $1", [a]), /stays started/);
  for (const aside of [true, false]) assert.equal((await call("POST", `/api/studio-agents/briefs/${a}/set-aside`, { aside }, "dir")).data.error, "already_started");
  assert.equal((await pool.query("select set_aside_at from studio_brief_marks where brief_run_id = $1", [a])).rows[0].set_aside_at, null);
  const run = ok(await call("GET", `/api/studio-agents/runs/${a}`, undefined, "dir"), "the brief").mark;
  assert.equal(run.direction, 2);
  void c;
});

test("Claude reads names as codes, and a run stops the moment its transcript can't be read any more", async () => {
  const { film, people, code } = await aFilm([{ person_code: "WK01", name: "Jamie Rivers", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true }, reviewer_relation: "parent", reviewer_name: "Dale Rivers", reviewer_email: "dale@x.test" }]);
  const t = ok(await addTranscript(film, people[0], [{ s: 0, e: 3000, t: "Jamie gets up at five." }, { s: 3000, e: 6000, t: "I just open the gate." }]), "transcript").transcript;
  await films("POST", "/tools/claude_transcripts", { on: true, note: "Anthropic's terms checked: no training on API data" }, "kyron");
  let pages = [];
  let second = null;
  wordsRouter._setDeps({
    words: async ({ scope }) => {
      const tools = wordsTools.toolsFor({ scope });
      const read = tools.find((x) => x.name === "words_read");
      pages.push(await read.run({ transcript: "T1" }));
      // Kyron turns it off while the run is going: the next page isn't read.
      await films("POST", "/tools/claude_transcripts", { on: false, note: "Checking the terms again" }, "kyron");
      second = await read.run({ transcript: "T1" });
      const submit = tools.find((x) => x.name === "submit_words");
      return { output: await submit.run({ lines: [], structures: [] }), trace: [], eval_status: "not_run" };
    },
  });
  try {
    const r = ok(await words("POST", `/films/${film.id}/ask-claude`, {}, "ed"), "ask");
    const done = await runDone(r.run_id);
    assert.match(pages[0], /WK01 gets up at five/);
    assert.doesNotMatch(pages[0], /Jamie/);
    assert.match(second, /^Stopped: Kyron turned off/);
    assert.equal(done.status, "failed");
    assert.match(done.output, /Stopped/);
    void code;
    void t;
  } finally {
    wordsRouter._setDeps({ words: null });
    await films("POST", "/tools/claude_transcripts", { on: true, note: "Anthropic's terms checked: no training on API data" }, "kyron");
  }
});

test("one words run at a time for a film, and only the film's people keep lines", async () => {
  const { film, people } = await aFilm();
  const t = ok(await addTranscript(film, people[0]), "transcript").transcript;
  // Someone who isn't on the film reads the lines, and doesn't keep them.
  assert.equal((await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 2, to_cue: 2, quote: "I still run it on Sundays" }, "other")).data.error, "not_your_film");
  let release;
  const gate = new Promise((r) => (release = r));
  wordsRouter._setDeps({ words: async () => { await gate; return { output: "", trace: [], eval_status: "not_run" }; } });
  try {
    const r = ok(await words("POST", `/films/${film.id}/ask-claude`, {}, "ed"), "ask");
    assert.equal((await words("POST", `/films/${film.id}/ask-claude`, {}, "dir")).data.error, "already_running");
    release();
    await runDone(r.run_id);
    ok(await words("POST", `/films/${film.id}/ask-claude`, {}, "dir"), "once it's back");
  } finally {
    release && release();
    wordsRouter._setDeps({ words: null });
  }
});

test("a line picked by hand that has a word of a card's name is asked about; across a question it isn't kept", async () => {
  const { film, people } = await aFilm([{ person_code: "WD01", name: "Darnell Price", role: "coach", release_on_file: true, covers: { voice: true } }]);
  const cues = [{ s: 0, e: 3000, t: "Darnell taught me everything." }, { s: 3000, e: 5000, t: "Every Sunday." }, { s: 9000, e: 11000, t: "That's why I stayed.", gap: true }];
  const t = ok(await addTranscript(film, people[0], cues), "transcript").transcript;
  const asked = await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 1, to_cue: 1, quote: "Darnell taught me everything" }, "ed");
  assert.deepEqual([asked.status, asked.data.fields, asked.data.words], [400, ["may_have_name"], ["darnell"]]);
  ok(await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 1, to_cue: 1, quote: "Darnell taught me everything", names_ok: ["darnell"] }, "ed"), "kept once they say");
  const across = await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 2, to_cue: 3, quote: "Every Sunday. That's why I stayed" }, "ed");
  assert.equal(across.status, 400);
  assert.match(across.data.issues[0], /across/);
  // The database holds the same: a line across a gap, or starting inside a word.
  await assert.rejects(pool.query("select studio_words_save($1, null, 'ed@toj.test', 'ed@toj.test', $2::jsonb, false)", [film.id, JSON.stringify([{ kind: "line", transcript_id: t.id, from_cue: 2, to_cue: 3, quote: "Every Sunday. That's why I stayed", start_ms: 3000, end_ms: 11000 }])]), /reach across/);
  await assert.rejects(pool.query("select studio_words_save($1, null, 'ed@toj.test', 'ed@toj.test', $2::jsonb, false)", [film.id, JSON.stringify([{ kind: "line", transcript_id: t.id, from_cue: 1, to_cue: 1, quote: "arnell taught", start_ms: 0, end_ms: 1000 }])]), /whole word/);
});

test("a card added or renamed after the words were kept waits until the lines with its name are gone", async () => {
  const { film, people } = await aFilm();
  const t = ok(await addTranscript(film, people[0], [{ s: 0, e: 3000, t: "Kenji gets up at five." }, { s: 3000, e: 5000, t: "I open the gate." }]), "transcript").transcript;
  ok(await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 1, to_cue: 1, quote: "Kenji gets up at five" }, "ed"), "kept before the card");
  const kid = { person_code: "WG01", name: "Kenji Sato", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true } };
  const r = await films("POST", `/films/${film.id}/people`, kid, "lead");
  assert.equal(r.status, 409);
  assert.match(r.data.reason, /a line, caption, title or note kept on this film names someone on this card: remove it/);
  // A transcript's label with a word of a card added later: the card waits too, and the label can be renamed.
  const f3 = await aFilm();
  const lt = ok(await words("POST", `/films/${f3.film.id}/transcripts`, { person_id: f3.people[0].id, label: "Hooks session", cues: [{ s: 0, e: 2000, t: "I open the gate." }] }, "ed"), "a label first").transcript;
  const hooks = { person_code: "WH01", name: "Darnell Hooks", role: "coach", release_on_file: true, covers: { voice: true } };
  const later = await films("POST", `/films/${f3.film.id}/people`, hooks, "lead");
  assert.equal(later.status, 409);
  assert.match(later.data.reason, /transcript's label on this film has a word of a name on this card: rename it/);
  assert.equal((await words("PATCH", `/transcripts/${lt.id}`, { label: "Session 1" }, "other")).data.error, "not_your_film");
  ok(await words("PATCH", `/transcripts/${lt.id}`, { label: "Session 1" }, "ed"), "renamed");
  ok(await films("POST", `/films/${f3.film.id}/people`, hooks, "lead"), "now the card");
  assert.deepEqual((await words("PATCH", `/transcripts/${lt.id}`, { label: "Hooks again" }, "ed")).data.fields, ["label_has_name"]);
  // Gone from Real words, the card goes in.
  const w = ok(await words("GET", `/films/${film.id}`, undefined, "ed"), "room").words.lines[0];
  ok(await words("DELETE", `/words/${w.id}`, {}, "ed"), "removed");
  ok(await films("POST", `/films/${film.id}/people`, kid, "lead"), "now the card");
});

test("a card corrected to a minor never waits: what names them goes with it", async () => {
  const { film, people } = await aFilm([{ person_code: "WB01", name: "Bo Jensen", role: "athlete", speaker: true, release_on_file: true, covers: { face: true, name: true, voice: true }, reviewer_relation: "self", reviewer_name: "Bo Jensen", reviewer_email: "bo@x.test" }]);
  const [coach, bo] = people;
  // The coach's transcript, labelled with Bo's two-letter name (an adult's isn't read), and a line naming Bo.
  const tc = ok(await words("POST", `/films/${film.id}/transcripts`, { person_id: coach.id, label: "Bo session", cues: [{ s: 0, e: 3000, t: "Bo runs it every morning." }, { s: 3000, e: 6000, t: "I open the gate." }] }, "ed"), "coach's transcript").transcript;
  ok(await words("POST", `/films/${film.id}/lines`, { transcript_id: tc.id, from_cue: 1, to_cue: 1, quote: "Bo runs it every morning" }, "ed"), "a line naming Bo");
  ok(await words("POST", `/films/${film.id}/lines`, { transcript_id: tc.id, from_cue: 2, to_cue: 2, quote: "I open the gate" }, "ed"), "a line that doesn't");
  // Bo's own transcript, with a line from it that says Bo's name.
  const tb = ok(await addTranscript(film, bo, [{ s: 0, e: 3000, t: "Bo is up at five." }, { s: 3000, e: 6000, t: "Every single morning." }]), "Bo's transcript").transcript;
  ok(await words("POST", `/films/${film.id}/lines`, { transcript_id: tb.id, from_cue: 1, to_cue: 1, quote: "Bo is up at five" }, "ed"), "Bo's own line");
  // Directions naming Bo (straight to the table: an adult's first name isn't read there).
  await pool.query("insert into studio_film_directions (film_id, directions, created_by) values ($1, $2::jsonb, 'lead@toj.test')", [film.id, JSON.stringify([{ name: "Bo leads the warm-up" }, { name: "b" }, { name: "c" }])]);
  const card = (await pool.query("select updated_at from studio_film_people where id = $1", [bo.id])).rows[0];
  const r = await films("PATCH", `/films/${film.id}/people/${bo.id}`, { seen: card.updated_at, is_minor: true, reviewer_relation: "parent", reviewer_name: "Kim Jensen", reviewer_email: "kim@x.test" }, "lead");
  assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.data)}`);
  assert.equal((await pool.query("select is_minor from studio_film_people where id = $1", [bo.id])).rows[0].is_minor, true);
  // Their transcript and line, the coach's line naming them, and the directions: gone. The label: the transcript's own code.
  assert.equal((await pool.query("select count(*)::int as n from studio_transcripts where person_id = $1", [bo.id])).rows[0].n, 0);
  assert.deepEqual((await pool.query("select quote from studio_words where film_id = $1 order by quote", [film.id])).rows.map((x) => x.quote), ["I open the gate"]);
  assert.equal((await pool.query("select label from studio_transcripts where id = $1", [tc.id])).rows[0].label, `${coach.person_code} transcript`);
  assert.equal((await pool.query("select count(*)::int as n from studio_film_directions where film_id = $1", [film.id])).rows[0].n, 0);
  // Directions are still kept otherwise.
  await pool.query("insert into studio_film_directions (film_id, directions, created_by) values ($1, $2::jsonb, 'lead@toj.test')", [film.id, JSON.stringify([{ name: "a" }, { name: "b" }, { name: "c" }])]);
  await assert.rejects(pool.query("delete from studio_film_directions where film_id = $1", [film.id]), /directions are kept/);
});

test("a minor's name run into a tag or a word isn't kept, as the app and the database read it; nor a line cut inside a word", async () => {
  const { film, people } = await aFilm([{ person_code: "WJ02", name: "Jamie Ortiz", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true }, reviewer_relation: "parent", reviewer_name: "Lu Ortiz", reviewer_email: "lu@x.test" }]);
  const t = ok(await addTranscript(film, people[0], [{ s: 0, e: 3000, t: "We all wore #PrayForJamie bands." }, { s: 3000, e: 6000, t: "Up at 5:30 every morning." }]), "transcript").transcript;
  const r = await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 1, to_cue: 1, quote: "We all wore #PrayForJamie bands" }, "ed");
  assert.equal(r.status, 400);
  await assert.rejects(pool.query("select studio_words_save($1, null, 'ed@toj.test', 'ed@toj.test', $2::jsonb, false)", [film.id, JSON.stringify([{ kind: "line", transcript_id: t.id, from_cue: 1, to_cue: 1, quote: "We all wore #PrayForJamie bands", start_ms: 0, end_ms: 3000 }])]), /names someone/);
  for (const [text, q] of [["Up at 5:30 every morning", "30 every morning"], ["I can´t lose", "I can"], ["I can′t quit", "I can"], ["From 1990–95 we won", "95 we won"]]) {
    assert.equal((await pool.query("select studio_quote_whole($1, $2) as ok", [text, q])).rows[0].ok, false, q);
  }
  assert.equal((await pool.query("select studio_quote_whole('well-known and known', 'known') as ok")).rows[0].ok, true, "a later whole match counts");
});

test("a taste note written before a card can still be archived; two asks at once start one run", async () => {
  const note = ok(await call("POST", "/api/studio-taste", { title: "The Rook doc's cold open", url: "https://vimeo.com/91", note: "Cold open on the empty gym." }, "ed"), "note").entry;
  await aFilm([{ person_code: "WR01", name: "Rook Bell", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true }, reviewer_relation: "parent", reviewer_name: "Ann Bell", reviewer_email: "ann@x.test" }]);
  ok(await call("POST", `/api/studio-taste/${note.id}/archive`, { archived: true }, "ed"), "archived");
  assert.ok((await pool.query("select archived_at from studio_taste where id = $1", [note.id])).rows[0].archived_at, "archived");
  assert.equal((await call("PATCH", `/api/studio-taste/${note.id}`, { note: "Rook again" }, "ed")).status >= 400, true, "an edit that keeps the name isn't");
  // Two asks at once: one run.
  const { film, people } = await aFilm();
  ok(await addTranscript(film, people[0]), "transcript");
  await films("POST", "/tools/claude_transcripts", { on: true, note: "Anthropic's terms checked: no training on API data" }, "kyron");
  let release;
  const gate = new Promise((r) => (release = r));
  wordsRouter._setDeps({ words: async () => { await gate; return { output: "", trace: [], eval_status: "not_run" }; } });
  try {
    const both = await Promise.all([words("POST", `/films/${film.id}/ask-claude`, {}, "ed"), words("POST", `/films/${film.id}/ask-claude`, {}, "dir")]);
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
    assert.equal(both.find((x) => x.status === 409).data.error, "already_running");
    release();
    await runDone(both.find((x) => x.status === 200).data.run_id);
  } finally {
    release && release();
    wordsRouter._setDeps({ words: null });
  }
});

test("a release taken off file lets the speaker's words go; a deleted run lets go of what it kept", async () => {
  const { film, people } = await aFilm();
  ok(await addTranscript(film, people[0]), "transcript");
  const card = (await pool.query("select updated_at from studio_film_people where id = $1", [people[0].id])).rows[0];
  ok(await films("PATCH", `/films/${film.id}/people/${people[0].id}`, { seen: card.updated_at, release_on_file: false }, "lead"), "release off file");
  assert.equal((await pool.query("select count(*)::int as n from studio_transcripts where person_id = $1", [people[0].id])).rows[0].n, 0);
  // A run that kept words and directions can be deleted: they stay, without it.
  const f2 = await aFilm();
  const t2 = ok(await addTranscript(f2.film, f2.people[0]), "transcript 2").transcript;
  const runId = (await pool.query("insert into agent_runs (role, status, created_by) values ('words-editor', 'completed', 'ed@toj.test') returning id")).rows[0].id;
  await pool.query("select studio_words_save($1, $2, 'claude', 'ed@toj.test', $3::jsonb, false)", [f2.film.id, runId, JSON.stringify([{ kind: "line", transcript_id: t2.id, from_cue: 2, to_cue: 2, quote: "I still run it on Sundays", start_ms: 4500, end_ms: 8000 }])]);
  await pool.query("insert into studio_film_directions (film_id, run_id, directions, created_by) values ($1, $2, $3::jsonb, 'lead@toj.test')", [f2.film.id, runId, JSON.stringify([{ name: "a" }, { name: "b" }, { name: "c" }])]);
  await pool.query("delete from agent_runs where id = $1", [runId]);
  assert.equal((await pool.query("select count(*)::int as n from studio_words where film_id = $1 and run_id is null", [f2.film.id])).rows[0].n, 1);
});

test("a taste note keeps no name from any film's cards, and agents read it with names as codes", async () => {
  await aFilm([{ person_code: "WT01", name: "Rosa Diaz", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true } }]);
  const add = (body) => call("POST", "/api/studio-taste", body, "ed");
  assert.deepEqual((await add({ title: "Rosa's first season", url: "https://vimeo.com/2", note: "The light on the field." })).data.fields, ["taste_has_name"]);
  await assert.rejects(pool.query("insert into studio_taste (title, url, note, added_by) values ('x', 'https://vimeo.com/3', 'Rosa Diaz at the gate', 'ed@toj.test')"), /keep no names/);
  // A cited note is kept with its ref, title, link and use only.
  const TA = require("../agents/studio-brief/taste");
  const row = { ref_no: 7, title: "A film", url: "https://vimeo.com/7", note: "Long note", take: "x", leave: "y", tags: [] };
  const c = await TA.checkCited({ tasteByRef: async () => row }, [{ ref: "Taste 7", take: "the grain" }], "taste");
  assert.deepEqual(c.cited, [{ ref: "Taste 7", title: "A film", url: "https://vimeo.com/7", use: "the grain" }]);
  const tool = TA.tasteSearchTool({ searchTaste: async () => [{ ...row, note: "Kenji Sato opens the gate" }], maskTaste: (x) => String(x).replace(/Kenji Sato/g, "WG01") });
  assert.match(await tool.run({ query: "gate" }), /WG01 opens the gate/);
});

test("a brief is started only by whoever asked for it (or the producer), and its first start is kept", async () => {
  const brief = (by) => pool.query("insert into agent_runs (role, status, task, output, created_by) values ('brief-writer', 'completed', 'x', 'y', $1) returning id", [by]).then((r) => r.rows[0].id);
  const mine = await brief("dir@toj.test");
  const start = (from, who = "dir", direction = 1) => call("POST", "/api/studio-agents/run", { role: "kit-refresher", slug: "same-work", brief: "Refresh the gear card for winter shoots.", from_brief: from, direction }, who);
  assert.equal((await start(mine, "ed")).data.error, "not_your_brief");
  const notBrief = (await pool.query("insert into agent_runs (role, status, created_by) values ('kit-refresher', 'completed', 'dir@toj.test') returning id")).rows[0].id;
  assert.equal((await start(notBrief)).data.error, "not_a_brief");
  const first = ok(await start(mine, "dir", 2), "started");
  const again = ok(await start(mine, "lead", 3), "the producer starts it again");
  const m = (await pool.query("select direction, started_by, started_run_id from studio_brief_marks where brief_run_id = $1", [mine])).rows[0];
  assert.deepEqual([m.direction, m.started_by, m.started_run_id], [2, "dir@toj.test", first.run_id]);
  // The second run says where it came from.
  assert.match((await pool.query("select task from agent_runs where id = $1", [again.run_id])).rows[0].task, new RegExp(`Started from brief ${mine}, direction 3`));
  // Setting a brief aside is JSON from the app's own pages.
  const other = await brief("dir@toj.test");
  const form = await fetch(base + `/api/studio-agents/briefs/${other}/set-aside`, { method: "POST", headers: { Cookie: cookies.dir, "Content-Type": "application/x-www-form-urlencoded" }, body: "aside=true" });
  assert.equal(form.status, 415);
  const cross = await fetch(base + `/api/studio-agents/briefs/${other}/set-aside`, { method: "POST", headers: { Cookie: cookies.dir, "Content-Type": "application/json", Origin: "https://elsewhere.example" }, body: "{}" });
  assert.equal(cross.status, 403);
});

test("a correction to a minor doesn't wait on the film's title or story: their name there becomes the card's code", async () => {
  const { film, people } = await aFilm([{ person_code: "WT02", name: "Ty Ng", role: "athlete", speaker: true, release_on_file: true, covers: { face: true, name: true, voice: true }, reviewer_relation: "self", reviewer_name: "Ty Ng", reviewer_email: "ty@x.test" }]);
  const ty = people[1];
  // An adult's two-letter name isn't read in the story; a minor's is.
  const f0 = (await pool.query("select updated_at from studio_films where id = $1", [film.id])).rows[0];
  ok(await films("PATCH", `/films/${film.id}`, { seen: f0.updated_at, one_sentence: "Ty runs this drill every morning." }, "lead"), "story");
  const card = (await pool.query("select updated_at from studio_film_people where id = $1", [ty.id])).rows[0];
  const r = await films("PATCH", `/films/${film.id}/people/${ty.id}`, { seen: card.updated_at, is_minor: true, reviewer_relation: "parent", reviewer_name: "Lin Ng", reviewer_email: "lin@x.test" }, "lead");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.story_coded, true);
  assert.equal((await pool.query("select one_sentence from studio_films where id = $1", [film.id])).rows[0].one_sentence, "WT02 runs this drill every morning.");
  // A form of the name the old swap didn't reach ("Ty2", "Ty_23") becomes the code too.
  const g = await aFilm([{ person_code: "WT03", name: "Ty Lo", role: "athlete", speaker: true, release_on_file: true, covers: { face: true, name: true, voice: true }, reviewer_relation: "self", reviewer_name: "Ty Lo", reviewer_email: "tylo@x.test" }]);
  const g0 = (await pool.query("select updated_at from studio_films where id = $1", [g.film.id])).rows[0];
  ok(await films("PATCH", `/films/${g.film.id}`, { seen: g0.updated_at, one_sentence: "Ty2 runs this drill, Ty_23 films it, and Ty never misses." }, "lead"), "story ty2");
  const gc = (await pool.query("select updated_at from studio_film_people where id = $1", [g.people[1].id])).rows[0];
  const gr = ok(await films("PATCH", `/films/${g.film.id}/people/${g.people[1].id}`, { seen: gc.updated_at, is_minor: true, reviewer_relation: "parent", reviewer_name: "Mai Lo", reviewer_email: "mai@x.test" }, "lead"), "corrected ty2");
  assert.deepEqual([gr.story_coded, gr.story_named], [true, undefined]);
  assert.equal((await pool.query("select one_sentence from studio_films where id = $1", [g.film.id])).rows[0].one_sentence, "WT032 runs this drill, WT03_23 films it, and WT03 never misses.");
  // A correction that also sets a reviewer whose name the story has is read as any change is.
  const h = await aFilm([{ person_code: "WT04", name: "Bo Diaz", role: "athlete", speaker: true, release_on_file: true, covers: { face: true, name: true, voice: true }, reviewer_relation: "self", reviewer_name: "Bo Diaz", reviewer_email: "bo@x.test" }]);
  const h0 = (await pool.query("select updated_at from studio_films where id = $1", [h.film.id])).rows[0];
  ok(await films("PATCH", `/films/${h.film.id}`, { seen: h0.updated_at, one_sentence: "Lin drives him to every early practice." }, "lead"), "story lin");
  const hc = (await pool.query("select updated_at from studio_film_people where id = $1", [h.people[1].id])).rows[0];
  const hr = await films("PATCH", `/films/${h.film.id}/people/${h.people[1].id}`, { seen: hc.updated_at, is_minor: true, reviewer_relation: "parent", reviewer_name: "Lin Hale", reviewer_email: "lin2@x.test" }, "lead");
  assert.deepEqual([hr.status, hr.data.error], [409, "story_has_name"]);
  // A new card with a name in the story still waits for the story to change.
  const f1 = (await pool.query("select updated_at from studio_films where id = $1", [film.id])).rows[0];
  ok(await films("PATCH", `/films/${film.id}`, { seen: f1.updated_at, one_sentence: "Rhea runs this drill every morning." }, "lead"), "story 2");
  const add = await films("POST", `/films/${film.id}/people`, { person_code: "WR02", name: "Rhea Moss", role: "athlete", is_minor: true, release_on_file: true, covers: {} }, "lead");
  assert.equal(add.status, 409);
});

test("a minor's card waits for a kept line with their name run into a tag; three-letter names run in where camelCase marks them", async () => {
  const { film, people } = await aFilm();
  const t = ok(await addTranscript(film, people[0], [{ s: 0, e: 3000, t: "We all wore #PrayForKai bands." }, { s: 3000, e: 6000, t: "We ran the same drill." }]), "transcript").transcript;
  ok(await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 1, to_cue: 1, quote: "We all wore #PrayForKai bands" }, "ed"), "kept before the card");
  const add = await films("POST", `/films/${film.id}/people`, { person_code: "WK05", name: "Kai Moreno", role: "athlete", is_minor: true, release_on_file: true, covers: {} }, "lead");
  assert.equal(add.status, 409, JSON.stringify(add.data));
  // As an adult's card it goes in (a run-in is read for minors).
  ok(await films("POST", `/films/${film.id}/people`, { person_code: "WK06", name: "Kai Ortiz", role: "coach", release_on_file: true, covers: {} }, "lead"), "an adult Kai");
  // The database reads three-letter names where camelCase starts and ends them, not in ordinary words.
  const f2 = await aFilm([{ person_code: "WK07", name: "Kai Lund", role: "athlete", is_minor: true, release_on_file: true, covers: {} }, { person_code: "WS07", name: "Sam Lund", role: "athlete", is_minor: true, release_on_file: true, covers: {} }]);
  const run = async (x) => (await pool.query("select studio_minor_run_in($1, $2) as x", [f2.film.id, x])).rows[0].x;
  assert.deepEqual([await run("We all wore #PrayForKai bands"), await run("The town is KaiStrong"), await run("#teamkai on every truck"), await run("the same drill"), await run("the kaiser roll")], [true, true, false, false, false]);
  // Four letters or more: beside a tag's or a file's word, or initials in a
  // handle; an ordinary word that starts or ends with the name isn't.
  const f3 = await aFilm([{ person_code: "WI07", name: "Isla Moss", role: "athlete", is_minor: true, release_on_file: true, covers: {} }, { person_code: "WE07", name: "Ella Lund", role: "athlete", is_minor: true, release_on_file: true, covers: {} }]);
  const run3 = async (x) => (await pool.query("select studio_minor_run_in($1, $2) as x", [f3.film.id, x])).rows[0].x;
  for (const x of ["#islastrong", "#teamisla", "islaquote_v2", "instagram.com/islab_hoops", "IslaStrong"]) assert.equal(await run3(x), true, x);
  for (const x of ["We grew up on the island", "Grab an umbrella", "#islandlife"]) assert.equal(await run3(x), false, x);
});

test("an ordinary word that holds a minor's name is asked about, kept on the writer's say-so, and a correction leaves it", async () => {
  const { film, people } = await aFilm();
  const t = ok(await addTranscript(film, people[0], [{ s: 0, e: 3000, t: "We grew up on the island." }, { s: 3000, e: 6000, t: "Every summer." }]), "transcript").transcript;
  ok(await films("POST", `/films/${film.id}/people`, { person_code: "WI08", name: "Isla Moss", role: "athlete", is_minor: true, release_on_file: true, covers: {} }, "lead"), "a minor Isla");
  const asked = await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 1, to_cue: 1, quote: "We grew up on the island" }, "ed");
  assert.deepEqual([asked.status, asked.data.words], [400, ["isla"]], JSON.stringify(asked.data));
  ok(await words("POST", `/films/${film.id}/lines`, { transcript_id: t.id, from_cue: 1, to_cue: 1, quote: "We grew up on the island", names_ok: ["isla"] }, "ed"), "kept");
  // A minor Ella's card goes in beside it; an adult Liam corrected to a minor leaves it.
  ok(await films("POST", `/films/${film.id}/people`, { person_code: "WE08", name: "Ella Ruiz", role: "athlete", is_minor: true, release_on_file: true, covers: {} }, "lead"), "Ella");
  const liam = ok(await films("POST", `/films/${film.id}/people`, { person_code: "WL08", name: "Liam Cruz", role: "coach", release_on_file: true, covers: {} }, "lead"), "Liam").person;
  ok(await films("PATCH", `/films/${film.id}/people/${liam.id}`, { seen: liam.updated_at, is_minor: true, reviewer_relation: "parent", reviewer_name: "Ana Cruz", reviewer_email: "ana@x.test" }, "lead"), "corrected");
  assert.equal((await pool.query("select count(*)::int as n from studio_words where film_id = $1 and quote = 'We grew up on the island'", [film.id])).rows[0].n, 1);
});

test("the correction's flag is read only from inside the correction", async () => {
  const { film } = await aFilm();
  await pool.query("insert into studio_film_directions (film_id, directions, created_by) values ($1, $2::jsonb, 'lead@toj.test')", [film.id, JSON.stringify([{ name: "a" }, { name: "b" }, { name: "c" }])]);
  const card = (await pool.query("select id from studio_film_people where film_id = $1 limit 1", [film.id])).rows[0];
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('studio.correcting', $1, true)", [card.id]);
    await assert.rejects(c.query("delete from studio_film_directions where film_id = $1", [film.id]), /directions are kept/);
  } finally {
    await c.query("rollback");
    c.release();
  }
});
