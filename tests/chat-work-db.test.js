// Migration 031 in a real Postgres: the Team room, rooms on kits, bookings
// and operating system builds, the tool shelf; and the chat routes against
// it, so the routes and the database's own checks run together. Made-up
// people only.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_chat_work_test), which it DROPS and recreates.
// Never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "gfs_chat_work_test";

if (!URL_) {
  test("migration 031 on Postgres (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

delete process.env.CHAT_DMS; // the default: direct messages off
process.env.ADMIN_EMAILS = "kyron@example.com,owen@example.com";
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { setSupabase } = require("../utils/supabase");
const T = require("../utils/team");
const P = require("../utils/push");

let pool, server, base, kit, build, authority, booking;
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const apply = async (file) => pool.query(fs.readFileSync(path.join(__dirname, "..", "db", "migrations", file), "utf8").replace(/public\./g, `${S}.`));
async function refused(sql, params, pattern) {
  try {
    await q(sql, params);
  } catch (e) {
    if (pattern) assert.match(e.message + " " + (e.constraint || ""), pattern, `expected ${pattern}, got: ${e.message}`);
    return;
  }
  assert.fail(`expected a refusal: ${sql} ${JSON.stringify(params || [])}`);
}

async function as(email, role) {
  let cookie = "";
  const call = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json };
  };
  await call("/test-login", { method: "POST", body: { email, role } });
  return call;
}

let pushes = [];
before(async () => {
  pool = await makeSchema(URL_, S, ["019_team.sql", "020_native_push.sql", "024_gfs_events.sql", "025_gfs_qr.sql"]);
  // What 022 points at, from earlier migrations.
  await q(`create table ${S}.clients (id uuid primary key default gen_random_uuid())`);
  await q(`create table ${S}.foundation_scores (id uuid primary key default gen_random_uuid())`);
  for (const f of ["018_studio_kits.sql", "022_operating_systems.sql", "026_team_chat.sql", "030_sm_bookings.sql", "031_chat_work_rooms_and_tools.sql", "031_chat_work_rooms_and_tools.sql"]) await apply(f);
  await q("create table users (email text primary key, hash text, role text)");
  await q("insert into users (email, hash, role) values ('kyron@example.com', 'x', 'admin'), ('owen@example.com', 'x', 'admin')");
  await q(`insert into team_members (email, name, role, tools, regions) values
    ('val@example.com', 'Val Viewer', 'viewer', array['studio'], '{}'),
    ('ola@example.com', 'Ola Os', 'member', array['os'], '{}'),
    ('ana@example.com', 'Ana Approver', 'approver', array['studio','os','gfs','creators'], '{}'),
    ('wes@example.com', 'Wes West', 'member', array['gfs'], array['west'])`);
  kit = await one(`insert into studio_kits (slug, version, status, title, kit) values ('same-work', 1, 'approved', 'Same Work Milanote Kit', '{}'::jsonb) returning *`);
  await one(`insert into studio_kits (slug, version, status, title, kit) values ('same-work', 2, 'draft', 'Same Work Milanote Kit', '{}'::jsonb) returning *`);
  build = await one(`insert into os_builds (name, vertical, intake) values ('Sample Client', 'nonprofit', '{"business_name":"Sample Nonprofit"}'::jsonb) returning *`);
  // Authority builds can hold minors' details: owners only, in Operating Systems and in chat.
  authority = await one(`insert into os_builds (name, vertical) values ('Jordan Example (QB)', 'authority') returning *`);
  booking = await one(`insert into sm_bookings (source, kind, contact_name, contact_email, adult_confirmed, event_state, event_city, event_date, sport) values ('form', 'athlete', 'Sample Parent', 'parent@example.com', true, 'CA', 'Los Angeles', '2026-11-21', 'Girls Flag Football') returning *`);

  setSupabase(pgSupabase(pool, S));
  P.setSender(async (sub, payload) => { pushes.push({ to: sub.email, payload }); return {}; });
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/chat", require("../routes/chat"));
  app.use("/api/team-tools", require("../routes/team-tools"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) server.close();
  P.setSender(null);
  setSupabase(null);
  if (pool) await pool.end();
});

test("031: the new rooms keep their shapes, and the old ones still work", async () => {
  assert.equal((await q("insert into chat_rooms (slug, kind) values ('team', 'team') returning id")).length, 1);
  await refused("insert into chat_rooms (slug, kind) values ('team-2', 'team')", [], /chat_rooms_team_chk/);
  await q("delete from chat_rooms where slug = 'team'");
  await refused("insert into chat_rooms (slug, kind, title) values ('team', 'team', 'x')", [], /chat_rooms_team_chk/);
  assert.equal((await q("insert into chat_rooms (slug, kind, kit_slug) values ('kit:same-work', 'kit', 'same-work') returning id")).length, 1);
  await refused("insert into chat_rooms (slug, kind, kit_slug) values ('kit:other', 'kit', 'same-work')", [], /chat_rooms_kit_chk/);
  await refused("insert into chat_rooms (slug, kind, kit_slug) values ('kit:../x', 'kit', '../x')", [], /chat_rooms_kit_chk/);
  await refused("insert into chat_rooms (slug, kind) values ('kit:anything', 'kit')", [], /chat_rooms_kit_chk/);
  await refused("insert into chat_rooms (slug, kind, booking_id) values ($1, 'booking', $2)", ["booking:00000000-0000-4000-8000-000000000000", booking.id], /chat_rooms_booking_chk/);
  await refused("insert into chat_rooms (slug, kind, os_build_id) values ('os:x', 'os', $1)", [build.id], /chat_rooms_os_chk/);
  // A work column on another kind of room.
  await refused("insert into chat_rooms (slug, kind, booking_id) values ('all', 'all', $1)", [booking.id], /chat_rooms_work_cols_chk/);
  await refused("insert into chat_rooms (slug, kind) values ('x', 'lobby')", [], /chat_rooms_kind_check/);
  assert.equal((await q("insert into chat_rooms (slug, kind, region) values ('region:west', 'region', 'west') returning id")).length, 1);
  await q("delete from chat_rooms");
});

test("031: a booking's or a build's room goes when the work does", async () => {
  const b = await one(`insert into sm_bookings (source, kind, contact_name, contact_email, adult_confirmed, event_state) values ('form', 'team', 'Coach', 'coach@example.com', true, 'TX') returning *`);
  const o = await one(`insert into os_builds (name, vertical) values ('Gone Soon', 'nonprofit') returning *`);
  await q("insert into chat_rooms (slug, kind, booking_id) values ($1, 'booking', $2)", ["booking:" + b.id, b.id]);
  await q("insert into chat_rooms (slug, kind, os_build_id) values ($1, 'os', $2)", ["os:" + o.id, o.id]);
  await q("delete from sm_bookings where id = $1", [b.id]);
  await q("delete from os_builds where id = $1", [o.id]);
  assert.equal((await one("select count(*)::int as n from chat_rooms where kind in ('booking', 'os')")).n, 0);
});

test("031: tool shelf links are https with no sign-in details; server only", async () => {
  const add = (url) => q("insert into team_tools (name, url, created_by) values ('Board', $1, 'kyron@example.com') returning id", [url]);
  assert.equal((await add("https://app.milanote.com/1Example/board?p=1")).length, 1);
  await refused("insert into team_tools (name, url, created_by) values ('x', 'http://example.com/a', 'k@x.co')", [], /team_tools_url_check/);
  await refused("insert into team_tools (name, url, created_by) values ('x', 'https://user:pw@example.com/a', 'k@x.co')", [], /team_tools_url_check/);
  await refused("insert into team_tools (name, url, created_by) values ('x', 'javascript:alert(1)', 'k@x.co')", [], /team_tools_url_check/);
  await refused("insert into team_tools (name, url, audience, created_by) values ('x', 'https://example.com/a', 'public', 'k@x.co')", [], /team_tools_audience_check/);
  for (const role of ["anon", "authenticated"]) assert.equal((await one(`select has_table_privilege('${role}', '${S}.team_tools', 'select') as can`)).can, false, role);
  assert.equal((await one(`select relrowsecurity from pg_class where oid = '${S}.team_tools'::regclass`)).relrowsecurity, true);
  await q("delete from team_tools");
});

test("routes on Postgres: the Team room for everyone; kit, booking and build rooms for the people who can open the work", async () => {
  T.forget();
  const kyron = await as("kyron@example.com", "staff");
  const owen = await as("owen@example.com", "staff");
  const val = await as("val@example.com");
  const ola = await as("ola@example.com");
  const ana = await as("ana@example.com");
  const wes = await as("wes@example.com");
  for (const [c, name] of [[kyron, "Kyron"], [owen, "Owen"], [val, "Val"], [ola, "Ola"], [ana, "Ana"], [wes, "Wes"]]) {
    assert.equal((await c("/api/chat/me", { method: "POST", body: { name, adult: true } })).status, 201, name);
  }
  // Everyone has the Team room, once.
  const team = (await val("/api/chat")).json.rooms.filter((r) => r.kind === "team");
  assert.equal(team.length, 1);
  assert.equal(team[0].title, "Team");
  assert.equal((await wes("/api/chat")).json.rooms.filter((r) => r.kind === "team")[0].id, team[0].id);
  assert.equal((await val("/api/chat")).json.dms, false);
  assert.equal((await val("/api/chat/dm", { method: "POST", body: { person: "x" } })).status, 404, "direct messages are off");

  // A kit's room: Studio people only; one room across the kit's versions; opens the approved version.
  const k = await val("/api/chat/kit/same-work");
  assert.equal(k.status, 200);
  assert.equal((await ana("/api/chat/kit/same-work")).json.room.id, k.json.room.id);
  assert.equal((await wes("/api/chat/kit/same-work")).status, 404);
  assert.equal((await val("/api/chat/kit/nope")).status, 404);
  const kInfo = await val(`/api/chat/rooms/${k.json.room.id}`);
  assert.equal(kInfo.json.room.title, "Same Work Milanote Kit");
  assert.equal(kInfo.json.room.link, "#kit/" + kit.id);
  assert.deepEqual(kInfo.json.room.people.map((p) => p.name).sort(), ["Ana", "Kyron", "Owen", "Val"]);
  assert.equal((await wes(`/api/chat/rooms/${k.json.room.id}`)).status, 404);

  // A booking's room: owners only. Its push says "A booking", never the family's details.
  assert.equal((await ana(`/api/chat/booking/${booking.id}`)).status, 404);
  const b = await kyron(`/api/chat/booking/${booking.id}`);
  assert.equal(b.status, 200);
  const bInfo = await kyron(`/api/chat/rooms/${b.json.room.id}`);
  assert.match(bInfo.json.room.title, /Los Angeles/);
  assert.equal(bInfo.json.room.link, "#booking/" + booking.id);
  assert.match(bInfo.json.room.rule, /Only owners can read this room/);
  assert.equal((await ana(`/api/chat/rooms/${b.json.room.id}`)).status, 404);

  // A build's room: people with Operating Systems.
  const o = await ola(`/api/chat/os/${build.id}`);
  assert.equal(o.status, 200);
  assert.equal((await val(`/api/chat/os/${build.id}`)).status, 404);
  await q("insert into push_subscriptions (email, endpoint, p256dh, auth) values ('ana@example.com', 'https://push.example.com/ana', 'k', 'a')");
  pushes = [];
  assert.equal((await ola(`/api/chat/rooms/${o.json.room.id}/messages`, { method: "POST", body: { body: "Intake is in. @Ana can you score it?" } })).status, 201);
  await new Promise((r) => setTimeout(r, 400));
  const toAna = pushes.filter((p) => p.to === "ana@example.com");
  assert.equal(toAna.length, 1);
  assert.equal(toAna[0].payload.title, "An operating system build");
  assert.equal(toAna[0].payload.body, "Ola mentioned you");
  assert.ok(!JSON.stringify(pushes).includes("Sample Client"), "the build's name stays out of pushes");
  assert.ok(!JSON.stringify(pushes).includes("Intake is in"), "the message stays out of pushes");

  assert.equal((await ola(`/api/chat/rooms/${o.json.room.id}`)).json.room.title, "Sample Nonprofit", "the name the OS screens use");

  // An Authority build: owners only. Not for Ola or Ana, not in their lists, no push to them.
  assert.equal((await ola(`/api/chat/os/${authority.id}`)).status, 404);
  assert.equal((await ana(`/api/chat/os/${authority.id}`)).status, 404);
  const auth = await kyron(`/api/chat/os/${authority.id}`);
  assert.equal(auth.status, 200);
  assert.equal((await ola(`/api/chat/rooms/${auth.json.room.id}`)).status, 404);
  assert.equal((await ola(`/api/chat/rooms/${auth.json.room.id}/messages`, { method: "POST", body: { body: "hi" } })).status, 404);
  pushes = [];
  assert.equal((await kyron(`/api/chat/rooms/${auth.json.room.id}/messages`, { method: "POST", body: { body: "@Ana @Ola nothing for you here" } })).status, 201);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!pushes.some((p) => p.to === "ana@example.com" || p.to === "ola@example.com"), "no push to non-owners");
  for (const c of [ola, ana]) assert.ok(!(await c("/api/chat")).json.rooms.some((r) => r.id === auth.json.room.id));
  assert.ok((await owen("/api/chat")).json.rooms.some((r) => r.id === auth.json.room.id), "another owner has it");

  // Rooms someone wrote in show in the list for the people who can open them.
  assert.ok((await ana("/api/chat")).json.rooms.some((r) => r.kind === "os"));
  assert.ok(!(await val("/api/chat")).json.rooms.some((r) => r.kind === "os"));
  await q("insert into push_subscriptions (email, endpoint, p256dh, auth) values ('owen@example.com', 'https://push.example.com/owen', 'k', 'a')");
  pushes = [];
  await kyron(`/api/chat/rooms/${b.json.room.id}/messages`, { method: "POST", body: { body: "Calling them back tomorrow." } });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(pushes.map((p) => [p.to, p.payload.title, p.payload.body]), [["owen@example.com", "A booking", "Kyron sent a message"]]);
  assert.ok((await kyron("/api/chat")).json.rooms.some((r) => r.kind === "booking"));
  assert.ok(!(await ana("/api/chat")).json.rooms.some((r) => r.kind === "booking"));
});

test("routes on Postgres: a built-in kit (no row of its own) has its room too", async () => {
  T.forget();
  await q("delete from chat_rooms where kind = 'kit'");
  await q("delete from studio_kits where slug = 'same-work'");
  const val = await as("val@example.com");
  const r = await val("/api/chat/kit/same-work");
  assert.equal(r.status, 200);
  const info = await val(`/api/chat/rooms/${r.json.room.id}`);
  assert.equal(info.json.room.title, "Same Work Milanote Kit");
  assert.equal(info.json.room.link, "#kit/builtin:same-work:v1");
});

test("routes on Postgres: the tool shelf", async () => {
  T.forget();
  const kyron = await as("kyron@example.com", "staff");
  const val = await as("val@example.com");
  assert.equal((await val("/api/team-tools", { method: "POST", body: { name: "x", url: "https://x.example.com" } })).status, 403);
  const made = await kyron("/api/team-tools", { method: "POST", body: { name: "Shoot board", url: "https://app.milanote.com/x", audience: "studio" } });
  assert.equal(made.status, 201);
  await kyron("/api/team-tools", { method: "POST", body: { name: "Bookings Secret Maker", url: "https://claude.ai/artifact/x", audience: "owners" } });
  assert.deepEqual((await val("/api/team-tools")).json.tools.map((t) => t.name), ["Shoot board"]);
  assert.equal((await kyron("/api/team-tools")).json.tools.length, 2);
});
