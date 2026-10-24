// Migration 026 in a real Postgres (team chat), and the chat routes against
// it, so the routes and the database's own checks run together. Made-up
// people only.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schemas (gfs_chat_db_test, gfs_chat_pre_test), which it
// DROPS and recreates. Never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "gfs_chat_db_test";
const PRE = "gfs_chat_pre_test";
const BASE = ["019_team.sql", "020_native_push.sql", "024_gfs_events.sql", "025_gfs_qr.sql"];

if (!URL_) {
  test("migration 026 on Postgres (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@example.com";
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { setSupabase } = require("../utils/supabase");
const C = require("../utils/chat");

let pool, prePool, server, base;
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
async function refused(sql, params, pattern) {
  try {
    await q(sql, params);
  } catch (e) {
    if (pattern) assert.match(e.message, pattern, `expected ${pattern}, got: ${e.message}`);
    return;
  }
  assert.fail(`expected a refusal: ${sql} ${JSON.stringify(params || [])}`);
}
const person = (email, name) => one("insert into chat_people (email, display_name, adult_confirmed_at) values ($1, $2, now()) returning *", [email, name]);

function appFor(sb) {
  setSupabase(sb);
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/chat", require("../routes/chat"));
  return app;
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

before(async () => {
  pool = await makeSchema(URL_, S, [...BASE, "026_team_chat.sql"]);
  await q("insert into team_members (email, name, role, tools, regions) values ('wes@example.com', 'Wes West', 'member', array['gfs'], array['west']), ('sam@example.com', 'Sam South', 'member', array['gfs'], array['south_central'])");
  const app = appFor(pgSupabase(pool, S));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
  if (prePool) await prePool.end();
});

test("026: no contact details in a message, a name or a room title", async () => {
  const a = await person("a@example.com", "Ana");
  await refused("insert into chat_people (email, display_name, adult_confirmed_at) values ('b@example.com', 'Ben 214-555-0199', now())", [], /check constraint/);
  await refused("insert into chat_people (email, display_name, adult_confirmed_at) values ('b@example.com', 'Ben', null)", [], /null value/);
  await refused("insert into chat_people (email, display_name, adult_confirmed_at) values ('B@example.com', 'Ben', now())", [], /check constraint/);
  const room = await one("insert into chat_rooms (slug, kind) values ('all', 'all') returning *");
  const send = (body) => q("insert into chat_messages (room_id, author_id, body) values ($1, $2, $3) returning *", [room.id, a.id, body]);
  for (const bad of ["call 214-555-0199", "+1 (214) 555-0199", "+44 20 7946 0958", "write ana@example.org"]) await refused("insert into chat_messages (room_id, author_id, body) values ($1, $2, $3)", [room.id, a.id, bad], /chat_contact_details/);
  for (const fine of ["Bulldogs 21-14, #12 and #24", "https://sportsclippers.com/e/12345678901", "2026-10-24 10-26"]) assert.equal((await send(fine)).length, 1, fine);
  // The app's check and the database's agree.
  for (const s of ["call 214-555-0199", "+44 20 7946 0958", "x@y.co", "https://sportsclippers.com/e/12345678901", "Bulldogs 21-14", "5035550142", "ok 1234567"]) {
    const db = (await one("select chat_text_ok($1) as ok", [s])).ok;
    assert.equal(db, !C.hasContact(s), s);
  }
  await refused("insert into chat_rooms (slug, kind, title) values ($1, 'topic', 'Mail me at a@b.co')", ["topic:" + crypto.randomUUID()], /check constraint/);
  const m = (await send("Wrap at 6"))[0];
  await refused("update chat_messages set body = 'call 214-555-0199' where id = $1", [m.id], /chat_contact_details/);
  await refused("update chat_messages set body = null where id = $1", [m.id], /check constraint/);
  await q("update chat_messages set body = null, removed_at = now(), removed_by = $2 where id = $1", [m.id, a.id]);
  await refused("update chat_messages set body = 'back', removed_at = null where id = $1", [m.id], /chat_message_removed/);
  const other = await one("insert into chat_rooms (slug, kind, region) values ('region:west', 'region', 'west') returning *");
  await refused("update chat_messages set room_id = $1 where id = (select max(id) from chat_messages where body is not null)", [other.id], /chat_message_moved/);
});

test("026: room shapes; members only in topic rooms and DMs, two in a DM", async () => {
  const [x, y, z] = [await person("x@example.com", "Xa"), await person("y@example.com", "Ya"), await person("z@example.com", "Za")];
  await refused("insert into chat_rooms (slug, kind, region) values ('region:east', 'region', 'east')", [], /check constraint/);
  await refused("insert into chat_rooms (slug, kind, region) values ('region:west2', 'region', 'west')", [], /check constraint/);
  await refused("insert into chat_rooms (slug, kind) values ('topic:abc', 'topic')", [], /check constraint/);
  const ids = [x.id, y.id].sort();
  const dm = await one("insert into chat_rooms (slug, kind) values ($1, 'dm') returning *", [`dm:${ids[0]}:${ids[1]}`]);
  await q("insert into chat_room_members (room_id, person_id) values ($1, $2), ($1, $3)", [dm.id, x.id, y.id]);
  await refused("insert into chat_room_members (room_id, person_id) values ($1, $2)", [dm.id, z.id], /chat_dm_two_people/);
  const region = await one("select * from chat_rooms where slug = 'region:west'");
  await refused("insert into chat_room_members (room_id, person_id) values ($1, $2)", [region.id, x.id], /chat_room_has_no_members/);
  // A person deleted: their messages stay, without an author.
  const m = await one("insert into chat_messages (room_id, author_id, body) values ($1, $2, 'hi') returning *", [dm.id, x.id]);
  await q("update chat_messages set body = null, removed_at = now(), removed_by = $1 where author_id = $1", [x.id]);
  await q("delete from chat_people where id = $1", [x.id]);
  const after_ = await one("select * from chat_messages where id = $1", [m.id]);
  assert.deepEqual([after_.author_id, after_.body, after_.removed_by], [null, null, null]);
  assert.equal((await q("select * from chat_room_members where room_id = $1", [dm.id])).length, 1);
});

test("026: server only (RLS on, functions not callable by the API roles), and it runs twice", async () => {
  for (const t of ["chat_people", "chat_rooms", "chat_room_members", "chat_messages", "chat_reads"]) {
    const r = await one("select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2", [S, t]);
    assert.equal(r.relrowsecurity, true, t);
  }
  for (const [fn, args] of [["chat_room_stats", "uuid, uuid[]"], ["chat_text_ok", "text"]]) {
    const sig = `${S}.${fn}(${args})`;
    assert.equal((await one("select has_function_privilege('anon', $1, 'execute') as ok", [sig])).ok, false, fn);
    assert.equal((await one("select has_function_privilege('authenticated', $1, 'execute') as ok", [sig])).ok, false, fn);
    assert.equal((await one("select has_function_privilege('service_role', $1, 'execute') as ok", [sig])).ok, true, fn);
  }
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "026_team_chat.sql"), "utf8").replace(/public\./g, `${S}.`);
  await pool.query(sql);
});

test("the routes on Postgres: join, rooms, a message, unread from the real stats, a DM, forgetting a person", async () => {
  const wes = await as("wes@example.com");
  const sam = await as("sam@example.com");
  const kyron = await as("kyron@example.com", "admin");
  for (const [c, n] of [[wes, "Wes"], [sam, "Sam"], [kyron, "Kyron"]]) assert.equal((await c("/api/chat/me", { method: "POST", body: { name: n, adult: true } })).status, 201);
  const w = await wes("/api/chat");
  const all = w.json.rooms.find((r) => r.kind === "all");
  const west = w.json.rooms.find((r) => r.kind === "region");
  assert.equal(west.title, "West region");
  assert.equal((await sam(`/api/chat/rooms/${west.id}`)).status, 404);
  // (The first test wrote in All of Pylon too: Sam reads up to now.)
  await sam(`/api/chat/rooms/${all.id}/messages?read=1`);
  assert.equal((await sam("/api/chat")).json.rooms.find((r) => r.id === all.id).unread, 0);
  assert.equal((await wes(`/api/chat/rooms/${all.id}/messages`, { method: "POST", body: { body: "Portland crew is set." } })).status, 201);
  assert.equal((await wes(`/api/chat/rooms/${all.id}/messages`, { method: "POST", body: { body: "text me 503-555-0142" } })).json.error, "chat_contact_details");
  const s = (await sam("/api/chat")).json.rooms.find((r) => r.id === all.id);
  assert.equal(s.unread, 1);
  assert.equal(s.last.by, "Wes");
  await sam(`/api/chat/rooms/${all.id}/messages?read=1`);
  assert.equal((await sam("/api/chat")).json.rooms.find((r) => r.id === all.id).unread, 0);
  const people = (await sam("/api/chat/people")).json.people;
  const dm = await sam("/api/chat/dm", { method: "POST", body: { person: people.find((p) => p.name === "Wes").id } });
  assert.equal(dm.status, 200);
  assert.equal((await kyron(`/api/chat/rooms/${dm.json.room.id}`)).status, 404);
  await sam(`/api/chat/rooms/${dm.json.room.id}/messages`, { method: "POST", body: { body: "Dallas roster is in." } });
  // Deleting Sam's account (routes/team.js calls this).
  await require("../routes/chat").forgetPerson(pgSupabase(pool, S), "sam@example.com");
  assert.equal((await one("select count(*)::int as n from chat_people where email = 'sam@example.com'")).n, 0);
  assert.equal((await one("select count(*)::int as n from chat_messages where body = 'Dallas roster is in.'")).n, 0);
  const seen = (await wes(`/api/chat/rooms/${dm.json.room.id}/messages`)).json.messages;
  assert.deepEqual(seen.map((m) => [m.removed, m.author]), [[true, null]]);
  assert.equal((await wes(`/api/chat/rooms/${dm.json.room.id}`)).json.room.can.post, false);
});

test("before 026: chat says it isn't set up, and deleting an account still works", async () => {
  prePool = await makeSchema(URL_, PRE, BASE);
  await prePool.query("insert into team_members (email, name, role, tools, regions) values ('wes@example.com', 'Wes West', 'member', array['gfs'], array['west'])");
  const sb = pgSupabase(prePool, PRE);
  setSupabase(sb);
  const wes = await as("wes@example.com");
  for (const p of ["/api/chat", "/api/chat/me", "/api/chat/unread"]) {
    const r = await wes(p);
    assert.equal(r.status, 503, p);
    assert.equal(r.json.error, "chat_not_set_up", p);
  }
  assert.equal((await wes("/api/chat/me", { method: "POST", body: { name: "Wes", adult: true } })).json.error, "chat_not_set_up");
  await require("../routes/chat").forgetPerson(sb, "wes@example.com");
  setSupabase(pgSupabase(pool, S));
});
