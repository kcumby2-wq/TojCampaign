// The kit learns from the work, against migrations 039–042 in a real
// Postgres: wrap-ups keep no names and fold into one refresh, suggested
// edits to a kit card are open until an approver folds or declines them,
// a review-note label used three times is a rule in the making, and the
// month's refresh and the gear re-check are marked so Today knows what's due.
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

async function call(method, path, body, who = "kyron") {
  const r = await fetch(base + path, { method, headers: { Cookie: cookies[who], ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
const films = (m, p, b, w) => call(m, "/api/studio-films" + p, b, w);
const learn = (m, p, b, w) => call(m, "/api/studio-learn" + p, b, w);
const ok = (r, what) => { assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

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

test("the month's refresh draws on what the team learned, folds each in once, and Today knows what's due", async () => {
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
  assert.deepEqual([today.gear.due, today.gear.last_at], [true, null]);
  assert.deepEqual(ok(await learn("GET", "/today", undefined, "dir"), "member").monthly, [], "a member isn't asked for the month's refresh");
  // A member can't start it; an approver starts it with what it drew on.
  const brief = "Monthly refresh of the Same Work kit: fold in the wrap-ups and the FX3 suggestion; propose a rule for slow opens.";
  const body = { role: "kit-refresher", slug: "same-work", brief, purpose: "monthly", sources: { wraps: [w1.id], suggestions: [s.id], labels: [{ label: "slow open", uses: 3 }] } };
  assert.equal((await call("POST", "/api/studio-agents/run", body, "dir")).data.error, "producer_only");
  const run = ok(await call("POST", "/api/studio-agents/run", body, "lead"), "start").run_id;
  const mark = (await pool.query("select kind, kit_slug, month, started_by from studio_refresh_marks where run_id = $1", [run])).rows[0];
  assert.deepEqual([mark.kind, mark.kit_slug, mark.started_by], ["monthly", "same-work", "lead@toj.test"]);
  assert.equal(mark.month, learnRouter._thisMonth());
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
  // A gear re-check is marked too, and Today stops asking for a month.
  const gear = ok(await call("POST", "/api/studio-agents/run", { role: "kit-refresher", slug: "same-work", brief: "Re-check the Gear and Edit suite against current sources.", purpose: "gear" }, "dir"), "gear").run_id;
  assert.equal((await pool.query("select kind from studio_refresh_marks where run_id = $1", [gear])).rows[0].kind, "gear");
  const t2 = ok(await learn("GET", "/today", undefined, "dir"), "today gear");
  assert.equal(t2.gear.due, false);
  // A purpose is for a refresh only.
  assert.equal((await call("POST", "/api/studio-agents/run", { role: "kit-builder", slug: "new-kit", brief: "x".repeat(20), purpose: "gear", source_text: "y".repeat(300) }, "dir")).data.error, "invalid_purpose");
});

test("a declined rule in the making comes back after three more uses", async () => {
  const { film } = await aFilm();
  const notes = (k) => Promise.all(Array.from({ length: k }, (_, i) => films("POST", `/films/${film.id}/cut-notes`, { note: `Cut it sooner ${i}`, label: "late cut" }, "lead")));
  await notes(3);
  const rules = async () => ok(await learn("GET", "/monthly/same-work", undefined, "lead"), "monthly").rules.filter((x) => x.label === "late cut");
  assert.equal((await rules()).length, 1);
  assert.equal((await learn("POST", "/labels/decline", { label: "late cut", note: "No" }, "dir")).data.error, "producer_only");
  ok(await learn("POST", "/labels/decline", { label: "late cut", note: "The edit decides this, not the kit" }, "lead"), "declined");
  assert.equal((await rules()).length, 0);
  await notes(2);
  assert.equal((await rules()).length, 0, "two more isn't three");
  await notes(1);
  const back = await rules();
  assert.deepEqual([back.length, back[0].notes, back[0].declined_before], [1, 6, true]);
  await assert.rejects(pool.query("delete from studio_label_marks where label = 'late cut'"), /is kept/);
});

test("a brief from the gear preset carries its purpose", () => {
  const p = BR.parseBriefRequest({ idea: "Re-check the gear against current sources", target: { mode: "refresh", slug: "same-work" }, purpose: "gear" });
  assert.equal(p.purpose, "gear");
  assert.equal(BR.parseBriefRequest({ idea: "Re-check the gear against current sources", purpose: "monthly" }).purpose, null, "only gear comes from a brief");
});
