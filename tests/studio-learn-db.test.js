// The kit learns from the work, against migrations 039–042 in a real
// Postgres: wrap-ups keep no names (of anyone on any film's cards) and fold
// into one refresh, suggested edits to a kit card are open until an approver
// folds or declines them, a review-note label used three times on a kit's
// films is a rule in the making, and the month's refresh and the gear
// re-check are marked with what they were given, folded in only once they
// save a draft, so Today knows what's due.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_studio_learn_test), which it DROPS and recreates.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = "gfs_studio_learn_test";
if (!URL_) {
  test("studio learn (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}
process.env.ADMIN_EMAILS = "kyron@toj.test";
process.env.STUDIO_API_KEY = "learn-test-key-0123456789abcdef";

const express = require("express");
const session = require("express-session");
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { fakeStorage } = require("./helpers/fake-storage");
const { setSupabase } = require("../utils/supabase");
const mailer = require("../utils/mailer");
const push = require("../utils/push");
const T = require("../utils/team");
const BR = require("../agents/studio-brief/request");

let pool, sb, server, base;
const cookies = {};
const as = { kyron: "kyron@toj.test", lead: "lead@toj.test", dir: "dir@toj.test", ed: "ed@toj.test", other: "other@toj.test" };
const agentsRouter = require("../routes/studio-agents");
const learnRouter = require("../routes/studio-learn");

before(async () => {
  pool = await makeSchema(URL_, SCHEMA, ["018_studio_kits.sql", "019_team.sql", "020_native_push.sql", "039_studio_films.sql", "040_studio_craft.sql", "041_studio_words.sql", "042_studio_learn.sql"]);
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
  // As server.js: form posts are read too (a refresh refuses them).
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: "learn", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.email === as.kyron ? "staff" : "user"; res.json({ ok: true }); });
  app.use("/api/studio-films", require("../routes/studio-films"));
  app.use("/api/studio-learn", learnRouter);
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
  if (pool) await pool.end();
});
beforeEach(() => T.forget());

async function call(method, path, body, who = "kyron", headers = {}) {
  const r = await fetch(base + path, { method, headers: { ...(who ? { Cookie: cookies[who] } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
const films = (m, p, b, w) => call(m, "/api/studio-films" + p, b, w);
const learn = (m, p, b, w) => call(m, "/api/studio-learn" + p, b, w);
const ok = (r, what) => { assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

// The Kit Refresher, faked: "draft" changes a card (a draft is saved),
// "same" changes nothing, "none" stages nothing, "throw" fails. With a
// promise, it waits for it first (a run still going).
function agent(kind, hold) {
  return async ({ scope }) => {
    if (hold) await hold;
    if (kind === "throw") throw new Error("the model fell over");
    if (kind === "draft" || kind === "same") {
      const kit = JSON.parse(JSON.stringify(scope.base.kit));
      if (kind === "draft") {
        const card = kit.columns.flatMap((c) => c.cards).find((x) => !x.locked && x.type === "note");
        card.body = `${card.body}<p>Checked ${Date.now()}.</p>`;
      }
      scope.onStage({ mode: "refresh", base_kit: scope.base.kit, kit, base_id: scope.base.id, base_version: scope.base.version, ops: [] });
    }
    return { output: "ok", trace: [], eval_status: "not_run" };
  };
}
function later() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { p, open };
}
async function ended(runId) {
  for (let i = 0; i < 100; i++) {
    const row = (await pool.query("select outcome from studio_refresh_marks where run_id = $1", [runId])).rows[0];
    if (row && row.outcome) {
      // The run's own row is written just after.
      for (let j = 0; j < 50; j++) {
        const r = (await pool.query("select status from agent_runs where id = $1", [runId])).rows[0];
        if (r && r.status !== "running") break;
        await new Promise((x) => setTimeout(x, 20));
      }
      return row.outcome;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`run ${runId} never ended`);
}
const startRun = (body, who = "lead", headers) => call("POST", "/api/studio-agents/run", { role: "kit-refresher", slug: "same-work", ...body }, who, headers);
const BRIEF = "Monthly refresh of the Same Work kit: fold in what the team learned this month.";

let n = 0;
async function aFilm(extra = []) {
  const code = "L" + String(1000 + ++n);
  const film = ok(await films("POST", "/films", { kit_slug: "same-work", title: `${code} hero`, lane: "college", athlete_id: code, format: "hero" }, "lead"), "start").film;
  const people = [];
  for (const c of [{ person_code: code, name: "Marcus Hill", role: "coach", release_on_file: true, covers: { voice: true } }, ...extra]) {
    people.push(ok(await films("POST", `/films/${film.id}/people`, c, "lead"), "card").person);
  }
  return { film, people, code };
}

test("a wrap-up keeps no names, asks about a word that's also a name, and only its writer edits it", async () => {
  const { film } = await aFilm([{ person_code: "L9001", name: "Hope Field", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true } }]);
  const add = (body, who = "dir") => learn("POST", `/films/${film.id}/wraps`, body, who);
  assert.deepEqual((await add({ worked: "" })).data.fields, ["worked"]);
  assert.deepEqual((await add({ worked: "Marcus Hill nailed the open" })).data.fields, ["wrap_has_name"]);
  assert.deepEqual((await add({ worked: "The open landed", change: "Ask Hope before the drill" })).data.fields, ["wrap_has_minor_name"]);
  const asked = await add({ worked: "Mark the cones before the light goes", missed: "We lost the hill shot" });
  assert.deepEqual([asked.data.fields, asked.data.words], [["wrap_may_have_name"], ["hill"]]);
  const w = ok(await add({ worked: "Mark the cones before the light goes", missed: "We lost the hill shot", names_ok: ["hill"], card_title: "Shoot day: director" }), "kept").wrap;
  assert.equal(w.mine, true);
  // The database leaves no name in either.
  await assert.rejects(pool.query("insert into studio_film_wraps (film_id, worked, created_by) values ($1, 'Marcus Hill was great', 'dir@toj.test')", [film.id]), /keep no names/);
  // Its writer edits it; someone else can't; an approver can remove it.
  assert.equal((await learn("PATCH", `/wraps/${w.id}`, { worked: "x" }, "ed")).data.error, "not_yours");
  ok(await learn("PATCH", `/wraps/${w.id}`, { worked: "Cones down before the light goes", missed: "We lost the hill shot", names_ok: ["hill"] }, "dir"), "edit");
  const list = ok(await learn("GET", `/films/${film.id}/wraps`, undefined, "ed"), "list");
  assert.deepEqual([list.wraps.length, list.wraps[0].mine, list.film.athlete_id], [1, false, film.athlete_id]);
  assert.ok(list.cards.includes("Shoot day: director"), "the kit's card titles come with it");
  const w2 = ok(await add({ worked: "Room tone at every location" }, "ed"), "second").wrap;
  assert.equal((await learn("DELETE", `/wraps/${w2.id}`, {}, "dir")).data.error, "not_yours");
  ok(await learn("DELETE", `/wraps/${w2.id}`, {}, "lead"), "an approver removes it");
});

test("a wrap-up goes to the whole kit: no name of anyone on any film's cards, and names_ok can't clear one", async () => {
  const { film } = await aFilm();
  await aFilm([{ person_code: "L9101", name: "Kenji Moss", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true } },
    { person_code: "L9102", name: "Dana Cole", role: "parent", release_on_file: true, covers: { voice: true } }]);
  const add = (body) => learn("POST", `/films/${film.id}/wraps`, body, "dir");
  // Another film's minor, in any case, and run into a tag.
  assert.deepEqual((await add({ worked: "kenji's open was the best one" })).data.fields, ["wrap_has_minor_name"]);
  assert.deepEqual((await add({ worked: "The #kenjistrong cut landed" })).data.fields, ["wrap_has_minor_name"]);
  // Another film's adult: a whole name, or a word of one.
  assert.deepEqual((await add({ worked: "Dana Cole liked the cut" })).data.fields, ["wrap_has_name"]);
  assert.deepEqual((await add({ worked: "Ask Dana about the light" })).data.fields, ["wrap_has_name"]);
  // A word that's surely a name isn't cleared by saying it isn't.
  assert.deepEqual((await add({ worked: "Marcus ran the open", names_ok: ["marcus"] })).data.fields, ["wrap_has_name"]);
  // The database refuses another film's minor too.
  await assert.rejects(pool.query("insert into studio_film_wraps (film_id, worked, created_by) values ($1, 'kenji ran it', 'dir@toj.test')", [film.id]), /keep no names/);
  // A word that's a name only on a card added later: kept now, then held
  // back from the month's brief (and the brief refused) once the card is in.
  const w = ok(await add({ worked: "Riley set the lights early" }), "kept").wrap;
  for (let i = 0; i < 3; i++) ok(await films("POST", `/films/${film.id}/cut-notes`, { note: `Riley's light came late ${i}`, label: "late light" }, "lead"), "note");
  const before = ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "monthly");
  assert.ok(before.wraps.some((x) => x.id === w.id));
  assert.ok(before.rules.find((x) => x.label === "late light").samples.length > 0);
  await aFilm([{ person_code: "L9103", name: "Riley Stone", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true } }]);
  const m = ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "monthly after");
  assert.ok(!m.wraps.some((x) => x.id === w.id), "held back");
  assert.deepEqual(m.held.wraps.map((x) => [x.id, x.film.id]), [[w.id, film.id]]);
  assert.equal(JSON.stringify(m.held).includes("Riley"), false, "held back without its words");
  assert.deepEqual(m.rules.find((x) => x.label === "late light").samples, [], "a sample that names someone now is dropped");
  // The month's brief with the name in it doesn't start.
  assert.equal((await startRun({ brief: BRIEF + " Riley set the lights early.", purpose: "monthly", sources: { wraps: [w.id] } })).data.error, "brief_has_name");
  // Given to a refresh anyway (a page from before the card): it can't be
  // folded in now, so it's left open and counted.
  const run = (await pool.query("insert into agent_runs (role, task, status, created_by) values ('kit-refresher', 'x', 'running', 'lead@toj.test') returning id")).rows[0].id;
  assert.deepEqual((await pool.query("select given from studio_refresh_start($1, 'same-work', 'monthly', 'lead@toj.test', array[$2::uuid], '{}', '{}', true)", [run, w.id])).rows[0], { given: 1 });
  assert.deepEqual((await pool.query("select * from studio_refresh_end($1, 'drafted')", [run])).rows[0], { folded: 0, skipped: 1 });
  assert.equal((await pool.query("select folded_at from studio_film_wraps where id = $1", [w.id])).rows[0].folded_at, null);
  await pool.query("delete from agent_runs where id = $1", [run]);
});

test("a suggested edit names a real card, carries no name, and an approver folds or declines it, once", async () => {
  await aFilm([{ person_code: "L9002", name: "Ty Ng", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true } }]);
  const send = (body, who = "ed") => learn("POST", "/suggestions", { slug: "same-work", version: 1, column: "Gear", card_title: "Cameras", ...body }, who);
  assert.deepEqual((await send({ card_title: "Not a card", suggestion: "Add the FX3" })).data.fields, ["card"]);
  assert.deepEqual((await send({ suggestion: "Add the FX3 because Ty Ng liked it" })).data.fields, ["suggestion_has_name"]);
  assert.deepEqual((await send({ suggestion: "An elite camera list" })).data.fields, ["banned_words"]);
  const s1 = ok(await send({ suggestion: "Add the FX3 as a B camera", why: "Two shoots used it this month" }), "sent").suggestion;
  const s2 = ok(await send({ suggestion: "Drop the slider from the kit list" }), "sent 2").suggestion;
  assert.equal(s1.status, "open");
  const open = ok(await learn("GET", "/suggestions?slug=same-work", undefined, "dir"), "open").suggestions;
  assert.equal(open.length, 2);
  // Only an approver declines, with a reason; once.
  assert.equal((await learn("POST", `/suggestions/${s2.id}/decline`, { note: "No" }, "dir")).data.error, "producer_only");
  assert.deepEqual((await learn("POST", `/suggestions/${s2.id}/decline`, { note: "" }, "lead")).data.fields, ["note"]);
  ok(await learn("POST", `/suggestions/${s2.id}/decline`, { note: "We still use it on wides" }, "lead"), "declined");
  assert.equal((await learn("POST", `/suggestions/${s2.id}/decline`, { note: "Again" }, "lead")).data.error, "decided_already");
  // The database keeps them as written, and never deletes one.
  await assert.rejects(pool.query("update studio_kit_suggestions set suggestion = 'x y z' where id = $1", [s1.id]), /stays as it was written/);
  await assert.rejects(pool.query("delete from studio_kit_suggestions where id = $1", [s1.id]), /decline it instead/);
  await assert.rejects(pool.query("insert into studio_kit_suggestions (kit_slug, kit_version, column_name, card_title, suggestion, created_by) values ('same-work', 1, 'Gear', 'Cameras', 'Ask Ty Ng first', 'ed@toj.test')"), /keeps no names/);
});

test("the month's refresh draws on what the team learned, folds each in once it saves a draft, and Today knows what's due", async () => {
  agentsRouter._setDeps({ run: agent("draft") });
  const { film } = await aFilm();
  const other = await aFilm();
  const w1 = ok(await learn("POST", `/films/${film.id}/wraps`, { worked: "The two-camera interview held up", change: "Say where the B camera sits" }, "dir"), "wrap").wrap;
  const w2 = ok(await learn("POST", `/films/${other.film.id}/wraps`, { worked: "Room tone saved the edit" }, "ed"), "wrap 2").wrap;
  const s = ok(await learn("POST", "/suggestions", { slug: "same-work", version: 1, column: "Gear", card_title: "Cameras", suggestion: "Add the FX3 as a B camera" }, "ed"), "suggestion").suggestion;
  // A label used three times is a rule in the making.
  for (let i = 0; i < 3; i++) ok(await films("POST", `/films/${film.id}/cut-notes`, { note: `The open drags, take ${i + 1}`, label: "slow open" }, "lead"), "note");
  ok(await films("POST", `/films/${film.id}/cut-notes`, { note: "Too loud", label: "music too loud" }, "lead"), "a label used once");
  // Only approvers see the month's brief.
  assert.equal((await learn("GET", "/monthly/same-work", undefined, "dir")).data.error, "producer_only");
  // (Earlier tests left a wrap-up and a suggestion open: this one looks at its own.)
  const m = ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "monthly");
  const has = (list, id) => list.some((x) => x.id === id);
  assert.ok(has(m.wraps, w1.id) && has(m.wraps, w2.id) && has(m.suggestions, s.id));
  assert.deepEqual(m.rules.filter((x) => x.label === "slow open").map((x) => [x.notes, x.films]), [[3, 1]]);
  assert.ok(!m.rules.some((x) => x.label === "music too loud"), "a label used once isn't one");
  assert.equal(m.wraps.find((x) => x.id === w1.id).film.athlete_id, film.athlete_id);
  const today = ok(await learn("GET", "/today", undefined, "lead"), "today");
  const due = today.monthly.find((x) => x.slug === "same-work");
  assert.ok(due && due.counts.wraps >= 2 && due.counts.suggestions >= 1 && due.counts.rules >= 1, JSON.stringify(today));
  assert.equal(today.gear.due, true);
  assert.deepEqual(ok(await learn("GET", "/today", undefined, "dir"), "member").monthly, [], "a member isn't asked for the month's refresh");
  // A member can't start it; an approver starts it with what it drew on.
  const brief = "Monthly refresh of the Same Work kit: fold in the wrap-ups and the FX3 suggestion; propose a rule for slow opens.";
  const body = { role: "kit-refresher", slug: "same-work", brief, purpose: "monthly", sources: { wraps: [w1.id], suggestions: [s.id], labels: ["slow open"] } };
  assert.equal((await call("POST", "/api/studio-agents/run", body, "dir")).data.error, "producer_only");
  // Something it wasn't shown, or another kit's, doesn't start it.
  assert.equal((await call("POST", "/api/studio-agents/run", { ...body, sources: { labels: ["never used"] } }, "lead")).data.error, "refresh_refused");
  const run = ok(await call("POST", "/api/studio-agents/run", body, "lead"), "start").run_id;
  const mark = (await pool.query("select kind, kit_slug, month, started_by from studio_refresh_marks where run_id = $1", [run])).rows[0];
  assert.deepEqual([mark.kind, mark.kit_slug, mark.started_by], ["monthly", "same-work", "lead@toj.test"]);
  assert.equal(mark.month, learnRouter._thisMonth());
  const given = (await pool.query("select kind, coalesce(ref_id::text, label) as what, uses from studio_refresh_sources where run_id = $1 order by kind", [run])).rows;
  assert.deepEqual(given.map((x) => [x.kind, x.what, x.uses]), [["label", "slow open", 3], ["suggestion", s.id, null], ["wrap", w1.id, null]]);
  assert.equal(await ended(run), "drafted");
  assert.match((await pool.query("select output from agent_runs where id = $1", [run])).rows[0].output, /Folded in 3 of what it was given/);
  // Folded once: the wrap-up and the suggestion it drew on, and the rule.
  assert.ok((await pool.query("select folded_at from studio_film_wraps where id = $1", [w1.id])).rows[0].folded_at);
  assert.equal((await pool.query("select folded_at from studio_film_wraps where id = $1", [w2.id])).rows[0].folded_at, null, "one it didn't draw on stays");
  assert.deepEqual((await pool.query("select status, folded_run_id from studio_kit_suggestions where id = $1", [s.id])).rows[0], { status: "folded", folded_run_id: run });
  const after = ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "after");
  assert.deepEqual([has(after.wraps, w1.id), has(after.wraps, w2.id), has(after.suggestions, s.id), after.rules.some((x) => x.label === "slow open"), after.done_this_month], [false, true, false, false, true]);
  assert.deepEqual(ok(await learn("GET", "/today", undefined, "lead"), "today after").monthly, [], "done for this month");
  // A folded wrap-up stays as it is.
  assert.equal((await learn("PATCH", `/wraps/${w1.id}`, { worked: "x" }, "dir")).data.error, "folded");
  await assert.rejects(pool.query("update studio_film_wraps set worked = 'changed' where id = $1", [w1.id]), /stays as it was/);
  await assert.rejects(pool.query("delete from studio_film_wraps where id = $1", [w1.id]), /is kept/);
  // A second one this month is on purpose only.
  const s2 = ok(await learn("POST", "/suggestions", { slug: "same-work", column: "Gear", card_title: "Audio", suggestion: "Add a backup lav to the audio list" }, "ed"), "another").suggestion;
  const again = { ...body, sources: { suggestions: [s2.id] } };
  const refused = await call("POST", "/api/studio-agents/run", again, "lead");
  assert.deepEqual([refused.status, refused.data.error, /run already/.test(refused.data.reason)], [409, "refresh_refused", true]);
  const r2 = ok(await call("POST", "/api/studio-agents/run", { ...again, again: true }, "lead"), "again").run_id;
  assert.equal(await ended(r2), "drafted");
  // A gear re-check is marked too, and Today stops asking for a month.
  const gear = ok(await startRun({ brief: "Re-check the Gear and Edit suite against current sources.", purpose: "gear" }, "dir"), "gear").run_id;
  assert.equal((await pool.query("select kind from studio_refresh_marks where run_id = $1", [gear])).rows[0].kind, "gear");
  assert.equal(await ended(gear), "drafted");
  const t2 = ok(await learn("GET", "/today", undefined, "dir"), "today gear");
  assert.equal(t2.gear.due, false);
  // A purpose is for a refresh only, and the gear re-check is Same Work's.
  assert.equal((await call("POST", "/api/studio-agents/run", { role: "kit-builder", slug: "new-kit", brief: "x".repeat(20), purpose: "gear", source_text: "y".repeat(300) }, "dir")).data.error, "invalid_purpose");
  assert.equal((await startRun({ slug: "pylon-events", brief: "Re-check the gear for this kit.", purpose: "gear" }, "dir")).data.error, "invalid_purpose");
  // Its run deleted: the mark and what it was given go, what was folded stays.
  await pool.query("delete from agent_runs where id = $1", [run]);
  assert.equal((await pool.query("select count(*)::int as n from studio_refresh_sources where run_id = $1", [run])).rows[0].n, 0);
  assert.deepEqual((await pool.query("select folded_run_id, folded_at is not null as folded from studio_film_wraps where id = $1", [w1.id])).rows[0], { folded_run_id: null, folded: true });
});

test("a refresh that saves no draft folds nothing in: a failed run or one with nothing to change leaves it all open", async () => {
  const { film } = await aFilm();
  const w = ok(await learn("POST", `/films/${film.id}/wraps`, { worked: "The slate at the top saved the sync" }, "dir"), "wrap").wrap;
  const kept = async () => !!(await pool.query("select folded_at from studio_film_wraps where id = $1", [w.id])).rows[0].folded_at;
  const go = async (kind) => {
    agentsRouter._setDeps({ run: agent(kind) });
    const r = ok(await startRun({ brief: BRIEF, purpose: "monthly", sources: { wraps: [w.id] }, again: true }), kind).run_id;
    return [await ended(r), r];
  };
  const [o1, r1] = await go("throw");
  assert.deepEqual([o1, await kept()], ["failed", false]);
  assert.match((await pool.query("select output, error from agent_runs where id = $1", [r1])).rows[0].error || "", /fell over/);
  const [o2] = await go("none");
  assert.deepEqual([o2, await kept()], ["failed", false]);
  const [o3, r3] = await go("same");
  assert.deepEqual([o3, await kept()], ["no_changes", false]);
  assert.match((await pool.query("select output from agent_runs where id = $1", [r3])).rows[0].output, /stays open for the next refresh/);
  // Still on the month's page.
  assert.ok(ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "monthly").wraps.some((x) => x.id === w.id));
  // A mark ends once, and only its outcome changes.
  await assert.rejects(pool.query("update studio_refresh_marks set outcome = 'drafted' where run_id = $1", [r3]), /kept as it was made/);
  await assert.rejects(pool.query("update studio_film_wraps set folded_at = now() where id = $1", [w.id]), /folded into a refresh it was given to/);
  await assert.rejects(pool.query("update studio_film_wraps set folded_at = now(), folded_run_id = $2 where id = $1", [w.id, r3]), /folded into a refresh it was given to/);
  const [o4] = await go("draft");
  assert.deepEqual([o4, await kept()], ["drafted", true]);
});

test("one refresh at a time: what a running one was given stays as it read it, and a second start is refused with the reason", async () => {
  const { film } = await aFilm();
  const w = ok(await learn("POST", `/films/${film.id}/wraps`, { worked: "Two lavs on the interview saved it" }, "dir"), "wrap").wrap;
  const sg = ok(await learn("POST", "/suggestions", { slug: "same-work", column: "Gear", card_title: "Audio", suggestion: "Say two lavs on every interview" }, "ed"), "suggestion").suggestion;
  for (let i = 0; i < 3; i++) ok(await films("POST", `/films/${film.id}/cut-notes`, { note: `Hum under the voice ${i}`, label: "audio hum" }, "lead"), "note");
  for (let i = 0; i < 3; i++) ok(await films("POST", `/films/${film.id}/cut-notes`, { note: `Clipped peak ${i}`, label: "clipped audio" }, "lead"), "note");
  const hold = later();
  agentsRouter._setDeps({ run: agent("draft", hold.p) });
  const sources = (labels) => ({ wraps: [w.id], suggestions: [sg.id], labels });
  // Two at once, the labels in either order: one starts, the other is refused.
  const both = await Promise.all([
    startRun({ brief: BRIEF, purpose: "monthly", sources: sources(["audio hum", "clipped audio"]), again: true }),
    startRun({ brief: BRIEF, purpose: "monthly", sources: sources(["clipped audio", "audio hum"]), again: true }),
  ]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.data)));
  const lost = both.find((r) => r.status === 409).data;
  assert.equal(lost.error, "refresh_refused");
  const run = both.find((r) => r.status === 200).data.run_id;
  // While it runs: the month's page leaves out what it has, and a third start waits.
  const m = ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "monthly");
  assert.ok(m.running && m.running.run_id === run);
  assert.ok(!m.wraps.some((x) => x.id === w.id) && !m.suggestions.some((x) => x.id === sg.id) && !m.rules.some((x) => x.label === "audio hum"));
  assert.match((await startRun({ brief: BRIEF, purpose: "monthly", sources: sources([]), again: true })).data.reason, /running already/);
  assert.ok(!ok(await learn("GET", "/today", undefined, "lead"), "today").monthly.some((x) => x.slug === "same-work"), "not due while it runs");
  // What it was given stays as it read it.
  const edit = await learn("PATCH", `/wraps/${w.id}`, { worked: "Changed while it runs" }, "dir");
  assert.deepEqual([edit.status, /drawing on this wrap-up/.test(edit.data.reason)], [409, true]);
  assert.equal((await learn("DELETE", `/wraps/${w.id}`, {}, "dir")).status, 409);
  assert.match((await learn("POST", `/suggestions/${sg.id}/decline`, { note: "Not now please" }, "lead")).data.reason, /drawing on this suggested edit/);
  assert.match((await learn("POST", "/labels/decline", { slug: "same-work", label: "audio hum", note: "Not a kit thing" }, "lead")).data.reason, /drawing on this rule/);
  hold.open();
  assert.equal(await ended(run), "drafted");
  assert.deepEqual((await pool.query("select status from studio_kit_suggestions where id = $1", [sg.id])).rows[0].status, "folded");
  const marks = (await pool.query("select label, status from studio_label_marks where kit_slug = 'same-work' and run_id = $1 order by label", [run])).rows;
  assert.deepEqual(marks.map((x) => [x.label, x.status]), [["audio hum", "folded"], ["clipped audio", "folded"]]);
});

test("a declined rule in the making comes back after three more uses", async () => {
  const { film } = await aFilm();
  const notes = (k) => Promise.all(Array.from({ length: k }, (_, i) => films("POST", `/films/${film.id}/cut-notes`, { note: `Cut it sooner ${i}`, label: "late cut" }, "lead")));
  await notes(3);
  const rules = async () => ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "monthly").rules.filter((x) => x.label === "late cut");
  assert.equal((await rules()).length, 1);
  assert.equal((await learn("POST", "/labels/decline", { slug: "same-work", label: "late cut", note: "No" }, "dir")).data.error, "producer_only");
  ok(await learn("POST", "/labels/decline", { slug: "same-work", label: "late cut", note: "The edit decides this, not the kit" }, "lead"), "declined");
  assert.equal((await rules()).length, 0);
  // Declined: not a rule in the making for now, so it can't be folded either.
  assert.equal((await startRun({ brief: BRIEF, purpose: "monthly", sources: { labels: ["late cut"] }, again: true })).data.error, "refresh_refused");
  assert.match((await learn("POST", "/labels/decline", { slug: "same-work", label: "late cut", note: "Again" }, "lead")).data.reason, /isn't a rule in the making/);
  await notes(2);
  assert.equal((await rules()).length, 0, "two more isn't three");
  await notes(1);
  const back = await rules();
  assert.deepEqual([back.length, back[0].notes, back[0].declined_before], [1, 6, true]);
  // Declined again: a second decision, the first one kept as it was.
  ok(await learn("POST", "/labels/decline", { slug: "same-work", label: "late cut", note: "Still the edit's call" }, "lead"), "declined again");
  const kept = (await pool.query("select status, uses_at, note from studio_label_marks where kit_slug = 'same-work' and label = 'late cut' order by decided_at, id")).rows;
  assert.deepEqual(kept.map((x) => [x.status, x.uses_at, x.note]), [["declined", 3, "The edit decides this, not the kit"], ["declined", 6, "Still the edit's call"]]);
  await assert.rejects(pool.query("delete from studio_label_marks where label = 'late cut'"), /is kept/);
  await assert.rejects(pool.query("update studio_label_marks set status = 'folded', note = null where label = 'late cut'"), /kept as it was made/);
  // A decision's reason keeps no names; nor does the label of a rule folded
  // into a kit (a declined one may: it stays out of every kit).
  await assert.rejects(pool.query("insert into studio_label_marks (kit_slug, label, status, uses_at, note, decided_by) values ('same-work', 'late cut', 'declined', 3, 'Ty Ng says no', 'lead@toj.test')"), /keeps no names/);
  const someRun = (await pool.query("select id from agent_runs limit 1")).rows[0].id;
  await assert.rejects(pool.query("insert into studio_label_marks (kit_slug, label, status, uses_at, run_id, decided_by) values ('same-work', 'ty ng drill', 'folded', 3, $1, 'lead@toj.test')", [someRun]), /keeps no names/);
  // Another kit's: counted on its own films only, so none of these are its.
  assert.equal((await pool.query("select count(*)::int as n from studio_rule_candidates('pylon-events')")).rows[0].n, 0);
  const other = (await pool.query("select id from agent_runs limit 1")).rows[0].id;
  await assert.rejects(pool.query("select * from studio_refresh_start($1, 'pylon-events', 'monthly', 'lead@toj.test', '{}', '{}', array['slow open'], true)", [other]), /picked up by another refresh meanwhile|decided, folded/);
});

test("who may start a refresh from what the team learned, and how", async () => {
  // The automation key starts runs, but not these (a person does).
  const key = { "x-studio-api-key": process.env.STUDIO_API_KEY };
  assert.equal((await startRun({ brief: "Re-check the Gear and Edit suite against current sources.", purpose: "gear" }, null, key)).data.error, "refresh_needs_a_person");
  assert.equal((await startRun({ brief: BRIEF, purpose: "monthly", sources: {} }, null, key)).data.error, "refresh_needs_a_person");
  // JSON from the app's own pages only.
  const other = await startRun({ brief: "Re-check the Gear and Edit suite against current sources.", purpose: "gear" }, "lead", { Origin: "https://evil.example" });
  assert.deepEqual([other.status, other.data.error], [403, "wrong_origin"]);
  const form = await fetch(base + "/api/studio-agents/run", { method: "POST", headers: { Cookie: cookies.lead, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ role: "kit-refresher", slug: "same-work", brief: BRIEF, purpose: "monthly" }).toString() });
  assert.equal(form.status, 415);
});

test("a decision's note keeps no names, and a suggested edit can't be about a locked rule card", async () => {
  await aFilm([{ person_code: "L9201", name: "Ty Ng", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true } }]);
  await assert.rejects(pool.query("insert into studio_kit_suggestions (kit_slug, kit_version, column_name, card_title, suggestion, decided_note, created_by) values ('same-work', 1, 'Gear', 'Cameras', 'Add a cage', 'ask ty ng', 'ed@toj.test')"), /keeps no names/);
  const sg = ok(await learn("POST", "/suggestions", { slug: "same-work", column: "Gear", card_title: "Lenses and filters", suggestion: "Add a 1/8 mist filter" }, "ed"), "sent").suggestion;
  await assert.rejects(pool.query("update studio_kit_suggestions set decided_note = 'ask ty ng' where id = $1", [sg.id]), /keeps no names/);
  const rule = learn("POST", "/suggestions", { slug: "same-work", column: "Start here", card_title: "The seven rules nobody breaks", suggestion: "Make it eight rules" }, "ed");
  assert.deepEqual((await rule).data.fields, ["card_is_a_rule"]);
});

test("a brief from the gear preset carries its purpose, only aimed at Same Work", () => {
  const p = BR.parseBriefRequest({ idea: "Re-check the gear against current sources", target: { mode: "refresh", slug: "same-work" }, purpose: "gear" });
  assert.equal(p.purpose, "gear");
  assert.equal(BR.parseBriefRequest({ idea: "Re-check the gear against current sources", purpose: "monthly" }).purpose, null, "only gear comes from a brief");
  assert.equal(BR.parseBriefRequest({ idea: "Re-check the gear against current sources", target: { mode: "build" }, purpose: "gear" }).purpose, null, "aimed at a new kit, it's an ordinary brief");
  assert.equal(BR.parseBriefRequest({ idea: "Re-check the gear against current sources", target: { mode: "refresh", slug: "pylon-events" }, purpose: "gear" }).purpose, null, "aimed at another kit too");
});

test("what every film shares is read against every card for names, not for ordinary words that hold one", () => {
  const U = require("../utils/studio-films");
  const cards = [
    { name: "Mila Reyes", is_minor: true }, { name: "Kit Ramos" }, { name: "Ana Ruiz", is_minor: true, reviewer_name: "April Stone" },
    { name: "Tate Owens", is_minor: true }, { name: "Kate Lin", is_minor: true }, { name: "Mark Diaz" }, { name: "Abel Cruz", is_minor: true },
    { name: "Jordan Kidd", is_minor: true }, { name: "Hope Lane", is_minor: true }, { name: "Dana Rivers" }, { name: "Will Park", is_minor: true },
  ];
  const read = (t, o) => U.kitNames(t, cards, o);
  // Ordinary words that hold a name: never read as one.
  for (const t of ["Pin the shot list to the Milanote board", "The state finals b-roll carried the open", "The skate park b-roll", "Every review-note label came up twice", "Jordanian tea at craft services"]) {
    assert.deepEqual(read(t), { sure: [], maybe: [], minor: [] }, t);
  }
  // An everyday word that's a name, with a capital: asked, unless it's a
  // minor's on the film it's written about; a month or a day, always asked.
  assert.deepEqual(read("The Canon 5D Mark IV held up"), { sure: [], maybe: ["mark"], minor: [] });
  assert.deepEqual(read("talked to Will after"), { sure: [], maybe: ["will"], minor: [] });
  assert.deepEqual(read("talked to Will after", { film: [{ name: "Will Park", is_minor: true }] }).minor, ["will"]);
  assert.deepEqual(read("We shot in April", { film: [{ name: "April Moss", is_minor: true }] }), { sure: [], maybe: ["april"], minor: [] });
  assert.deepEqual(read("in lower case: will, hope, mark, kit"), { sure: [], maybe: [], minor: [] });
  // A name for certain: a word of one that's no everyday word, a whole name,
  // one run together, a minor's run into a tag, a handle, a file name or camelCase.
  assert.deepEqual(read("Talked to Jordan after").minor, ["jordan"]);
  assert.deepEqual(read("coach Dana gave notes"), { sure: ["dana"], maybe: [], minor: [] });
  for (const t of ["#jordanstrong worked", "@jordan.hoops reposted it", "jordan_final_v2.mp4 was the cut", "the JordanStrong graphic", "instagram.com/jordanhoops"]) assert.deepEqual(read(t).minor, ["jordan"], t);
  const sorted = (r) => ({ sure: [...r.sure].sort(), maybe: [...r.maybe].sort(), minor: [...r.minor].sort() });
  assert.deepEqual(sorted(read("#hopestrong and #ourjordanfam")), { sure: [], maybe: ["hope", "jordan"], minor: [] });
  assert.deepEqual(read("#teamrivers"), { sure: [], maybe: ["rivers"], minor: [] });
  // Certain only where a tag's own word is beside the name: "#teamtate", but
  // "#teamstate" (a Tate, or "team state") and "#dallascowboys" are asked.
  assert.deepEqual(read("#teamtate").minor, ["tate"]);
  assert.deepEqual(read("#teamstate"), { sure: [], maybe: ["tate"], minor: [] });
  assert.deepEqual(U.kitNames("#dallascowboys", [{ name: "Dallas Cole", is_minor: true }]), { sure: [], maybe: ["dallas"], minor: [] });
  // An ordinary word holds a name only beside a tag's word: "Jordanstrong", "teamjordan".
  assert.deepEqual(read("Jordanstrong all season").minor, ["jordan"]);
  assert.deepEqual(read("the teamjordan shirts").minor, ["jordan"]);
  // What the app wrote is taken out before a brief is read.
  const head = "Monthly refresh of Same Work Milanote Kit (v3), April 2027: fold in what the team learned since Oct 3, 2026.";
  assert.deepEqual(read(U.withoutKnown(head, ["Same Work Milanote Kit", "same-work"])), { sure: [], maybe: [], minor: [] });
  assert.deepEqual(read(head).maybe.sort(), ["april", "kit"]);
});

test("the month's brief is read for what a person wrote: the kit's own words pass, a name is refused with the word, and a maybe is asked", async () => {
  agentsRouter._setDeps({ run: agent("same") });
  const { film } = await aFilm();
  // Cards on other films: a minor Mila, an adult Kit, a parent April, a coach Mark.
  await aFilm([{ person_code: "L9301", name: "Mila Reyes", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true } }]);
  await aFilm([{ person_code: "L9302", name: "Kit Ramos", role: "other", release_on_file: true, covers: { voice: true } },
    { person_code: "L9303", name: "Ana Ruiz", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true }, reviewer_relation: "parent", reviewer_name: "April Stone", reviewer_email: "april@toj.test" },
    { person_code: "L9304", name: "Mark Diaz", role: "coach", release_on_file: true, covers: { voice: true } }]);
  // Ordinary words in wrap-ups and suggestions are kept.
  const w = ok(await learn("POST", `/films/${film.id}/wraps`, { worked: "Pin the shot list to the Milanote board before the shoot", missed: "The state finals b-roll ran long" }, "dir"), "wrap").wrap;
  ok(await learn("POST", "/suggestions", { slug: "same-work", column: "Gear", card_title: "Cameras", suggestion: "Add a Milanote checklist card for the skate park shoot" }, "ed"), "suggestion");
  // A word that may be a name is asked about, and kept once you say it isn't one.
  const asked = await learn("POST", "/suggestions", { slug: "same-work", column: "Gear", card_title: "Cameras", suggestion: "Keep the Canon 5D Mark IV for low light" }, "ed");
  assert.deepEqual([asked.status, asked.data.fields, asked.data.words], [400, ["suggestion_may_have_name"], ["mark"]]);
  ok(await learn("POST", "/suggestions", { slug: "same-work", column: "Gear", card_title: "Cameras", suggestion: "Keep the Canon 5D Mark IV for low light", names_ok: ["mark"] }, "ed"), "kept");
  const sure = await learn("POST", "/suggestions", { slug: "same-work", column: "Gear", card_title: "Cameras", suggestion: "Ask Mila about the FX3" }, "ed");
  assert.deepEqual([sure.data.fields, sure.data.words], [["suggestion_has_name"], ["mila"]]);
  // The brief as the app writes it: the kit's title and the month aren't names.
  const m = ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "monthly");
  const head = `Monthly refresh of ${m.kit.title} (v${m.kit.version}), April 2027: fold in what the team learned.\n\n`;
  const brief = head + "## Wrap-ups from films\n- Hero film " + film.athlete_id + ": worked: Pin the shot list to the Milanote board before the shoot";
  const body = { brief, purpose: "monthly", sources: { wraps: [w.id] }, again: true };
  const r = ok(await startRun(body), "the app's own words start").run_id;
  assert.equal(await ended(r), "no_changes");
  // A name typed in is refused, with the word; a maybe is asked, then starts.
  const named = await startRun({ ...body, brief: brief + "\nMila liked the open." });
  assert.deepEqual([named.status, named.data.error, named.data.words], [400, "brief_has_name", ["mila"]]);
  const maybe = await startRun({ ...body, brief: brief + "\nIn April we moved the shoot." });
  assert.deepEqual([maybe.data.error, maybe.data.words], ["brief_may_have_name", ["april"]]);
  const r2 = ok(await startRun({ ...body, brief: brief + "\nIn April we moved the shoot.", names_ok: ["april"] }), "said it isn't").run_id;
  assert.equal(await ended(r2), "no_changes");
});

test("held back for a name on a card added since: a suggested edit and a rule can still be declined", async () => {
  const { film } = await aFilm();
  const sg = ok(await learn("POST", "/suggestions", { slug: "same-work", column: "Gear", card_title: "Audio", suggestion: "Rhea taught us the two-lav trick" }, "ed"), "suggestion").suggestion;
  for (let i = 0; i < 3; i++) ok(await films("POST", `/films/${film.id}/cut-notes`, { note: `The rhea drill ran long ${i}`, label: "rhea drill" }, "lead"), "note");
  await aFilm([{ person_code: "L9401", name: "Rhea Banks", role: "athlete", is_minor: true, release_on_file: true, covers: { voice: true } }]);
  const m = ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "monthly");
  assert.ok(!m.suggestions.some((x) => x.id === sg.id) && !m.rules.some((x) => x.label === "rhea drill"), "out of the brief");
  assert.ok(m.held.suggestions.some((x) => x.id === sg.id), "listed, to decline");
  assert.ok(m.held.rules.some((x) => x.label === "rhea drill"), "listed, to decline");
  ok(await learn("POST", `/suggestions/${sg.id}/decline`, { note: "It's about one athlete" }, "lead"), "declined");
  ok(await learn("POST", "/labels/decline", { slug: "same-work", label: "rhea drill", note: "It's about one athlete" }, "lead"), "rule declined");
  const after = ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "after");
  assert.ok(!after.held.suggestions.some((x) => x.id === sg.id) && !after.held.rules.some((x) => x.label === "rhea drill"));
  // A decline's note is asked about too.
  const s2 = ok(await learn("POST", "/suggestions", { slug: "same-work", column: "Gear", card_title: "Audio", suggestion: "Add a deadcat to the audio list" }, "ed"), "s2").suggestion;
  const q = await learn("POST", `/suggestions/${s2.id}/decline`, { note: "Rhea's call, not the kit's" }, "lead");
  assert.deepEqual([q.data.fields, q.data.words], [["note_has_name"], ["rhea"]]);
});

test("a discarded draft gives back what its refresh folded in, and its refresh no longer counts as run", async () => {
  agentsRouter._setDeps({ run: agent("draft") });
  const { film } = await aFilm();
  const w = ok(await learn("POST", `/films/${film.id}/wraps`, { worked: "A slate on every take saved the sync" }, "dir"), "wrap").wrap;
  const sg = ok(await learn("POST", "/suggestions", { slug: "same-work", column: "Gear", card_title: "Audio", suggestion: "Put a slate on the audio list" }, "ed"), "suggestion").suggestion;
  for (let i = 0; i < 3; i++) ok(await films("POST", `/films/${film.id}/cut-notes`, { note: `No slate on take ${i}`, label: "missing slate" }, "lead"), "note");
  const run = ok(await startRun({ brief: BRIEF, purpose: "monthly", sources: { wraps: [w.id], suggestions: [sg.id], labels: ["missing slate"] }, again: true }), "start").run_id;
  assert.equal(await ended(run), "drafted");
  const draft = (await pool.query("select id from studio_kits where source_run_id = $1", [run])).rows[0].id;
  const folded = async () => [
    !!(await pool.query("select folded_at from studio_film_wraps where id = $1", [w.id])).rows[0].folded_at,
    (await pool.query("select status from studio_kit_suggestions where id = $1", [sg.id])).rows[0].status,
    (await pool.query("select count(*)::int as n from studio_rule_candidates('same-work') where label = 'missing slate'")).rows[0].n,
  ];
  assert.deepEqual(await folded(), [true, "folded", 0]);
  // Only the refresh that folded it gives it back, by its draft being discarded.
  await assert.rejects(pool.query("update studio_film_wraps set folded_at = null, folded_run_id = null where id = $1", [w.id]), /stays as it was/);
  const d = ok(await call("POST", `/api/studio-agents/kits/${draft}/discard`, {}, "kyron"), "discard");
  assert.equal(d.given_back, true);
  assert.deepEqual(await folded(), [false, "open", 1]);
  const mark = (await pool.query("select outcome, undone_at from studio_refresh_marks where run_id = $1", [run])).rows[0];
  assert.deepEqual([mark.outcome, !!mark.undone_at], ["drafted", true]);
  const rule = (await pool.query("select status, run_id from studio_label_marks where kit_slug = 'same-work' and label = 'missing slate' order by decided_at desc, id limit 1")).rows[0];
  assert.deepEqual([rule.status, rule.run_id], ["reopened", run]);
  // Back on the month's page, and a refresh can fold them in again.
  const m = ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "monthly");
  assert.ok(m.wraps.some((x) => x.id === w.id) && m.suggestions.some((x) => x.id === sg.id) && m.rules.some((x) => x.label === "missing slate"));
  const r2 = ok(await startRun({ brief: BRIEF, purpose: "monthly", sources: { wraps: [w.id], suggestions: [sg.id], labels: ["missing slate"] }, again: true }), "again").run_id;
  assert.equal(await ended(r2), "drafted");
  assert.deepEqual(await folded(), [true, "folded", 0]);
  // A draft discarded while its refresh still runs: nothing is folded in.
  const w2 = ok(await learn("POST", `/films/${film.id}/wraps`, { worked: "Room tone first, every location" }, "dir"), "wrap 2").wrap;
  const r3 = (await pool.query("insert into agent_runs (role, task, status, created_by) values ('kit-refresher', 'x', 'running', 'lead@toj.test') returning id")).rows[0].id;
  await pool.query("select * from studio_refresh_start($1, 'same-work', 'monthly', 'lead@toj.test', array[$2::uuid], '{}', '{}', true)", [r3, w2.id]);
  const k3 = (await pool.query("select kit from studio_kits where id = $1", [draft])).rows[0].kit;
  const d3 = (await pool.query("insert into studio_kits (slug, version, title, status, kit, source_run_id, created_by) select slug, (select max(version) + 1 from studio_kits where slug = 'same-work'), title, 'draft', $1, $2, 'lead@toj.test' from studio_kits where id = $3 returning id", [k3, r3, draft])).rows[0].id;
  await pool.query("update studio_kits set status = 'discarded', discarded_by = 'kyron@toj.test', discarded_at = now() where id = $1", [d3]);
  assert.deepEqual((await pool.query("select * from studio_refresh_end($1, 'drafted')", [r3])).rows[0], { folded: 0, skipped: 0 });
  assert.equal((await pool.query("select folded_at from studio_film_wraps where id = $1", [w2.id])).rows[0].folded_at, null);
  assert.ok((await pool.query("select undone_at from studio_refresh_marks where run_id = $1", [r3])).rows[0].undone_at);
});

test("what a refresh draws on is given only as it starts", async () => {
  const { film } = await aFilm();
  const w = ok(await learn("POST", `/films/${film.id}/wraps`, { worked: "Two cards per camera, always" }, "dir"), "wrap").wrap;
  const r = (await pool.query("insert into agent_runs (role, task, status, created_by) values ('kit-refresher', 'x', 'running', 'lead@toj.test') returning id")).rows[0].id;
  await pool.query("select * from studio_refresh_start($1, 'same-work', 'gear', 'lead@toj.test', '{}', '{}', '{}', false)", [r]);
  await assert.rejects(pool.query("insert into studio_refresh_sources (run_id, kind, ref_id) values ($1, 'wrap', $2)", [r, w.id]), /as it starts, and only then/);
  await pool.query("select * from studio_refresh_end($1, 'drafted')", [r]);
  await assert.rejects(pool.query("insert into studio_refresh_sources (run_id, kind, ref_id) values ($1, 'wrap', $2)", [r, w.id]), /as it starts, and only then/);
  // So a wrap-up can't be folded into a refresh that never had it.
  await assert.rejects(pool.query("update studio_film_wraps set folded_run_id = $2, folded_at = now() where id = $1", [w.id, r]), /folded into a refresh it was given to/);
});
