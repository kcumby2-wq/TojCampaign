// Live Event Console cards pass the Pylon approver gate (migration 016).
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// The test works in its own schema (live_gate_test), which it DROPS and
// recreates, so it can run beside the other database tests. Never point it at
// a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const express = require("express");
const { Pool } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
const ROOT = path.join(__dirname, "..");
const SCHEMA = "live_gate_test";
const APPROVER = "approver@example.com";
const STAFF = "staff@example.com";

if (!URL_) {
  test("live post approval (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

let pool, server, base, eventId;

// routes/pylon*.js require("../db"), which the app does not ship yet.
// Point that one require at the test pool.
function stubDb(p) {
  const fake = path.join(ROOT, "db", "__test_db_live__.js");
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (request === "../db" && parent && parent.filename && parent.filename.startsWith(path.join(ROOT, "routes")))
      return fake;
    return orig.call(this, request, parent, ...rest);
  };
  const m = new Module(fake);
  m.filename = fake;
  m.loaded = true;
  m.exports = { query: (text, params) => p.query(text, params) };
  require.cache[fake] = m;
}

async function call(method, url, body, user = STAFF) {
  const r = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": user },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

async function queueCard(extra = {}) {
  const r = await call("POST", "/api/pylon/live-posts", {
    event_id: eventId, post_type: "stat_card", operator: "live-console",
    metadata: { stat_type: "Touchdowns", stat_value: "2" }, ...extra,
  });
  assert.equal(r.status, 200);
  return r.body;
}

before(async () => {
  process.env.PYLON_APPROVERS = `${APPROVER}, someone-else@example.com`;
  const admin = new Pool({ connectionString: URL_ });
  await admin.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA};`);
  await admin.end();

  pool = new Pool({ connectionString: URL_, options: `-c search_path=${SCHEMA}` });
  for (const f of ["008_pylon_partnership.sql", "016_live_post_approval.sql"])
    await pool.query(fs.readFileSync(path.join(ROOT, "db", "migrations", f), "utf8"));

  stubDb(pool);
  const app = express();
  app.use(express.json());
  // A fake signed-in session; the test picks the user per request.
  app.use("/api/pylon", (req, _res, next) => { req.session = { user: { email: req.headers["x-test-user"] } }; next(); },
    require("../routes/pylon"));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  eventId = (await pool.query(
    `insert into pylon_events (name, season, start_date) values ('Test Regional', 2026, '2026-11-07') returning id`
  )).rows[0].id;
});

after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
});

test("a new card starts queued, with its metadata saved", async () => {
  const card = await queueCard();
  assert.equal(card.status, "queued");
  assert.equal(card.posted_at, null);
  assert.equal(card.metadata.stat_value, "2");
});

test("an unapproved card cannot be published", async () => {
  const card = await queueCard();
  const r = await call("POST", `/api/pylon/live-posts/${card.id}/publish`, { channels: ["pylon_ig"] });
  assert.equal(r.status, 400);
  const row = (await pool.query("select status, posted_at from pylon_live_posts where id=$1", [card.id])).rows[0];
  assert.equal(row.status, "queued");
  assert.equal(row.posted_at, null);
});

test("staff who aren't approvers cannot approve", async () => {
  const card = await queueCard();
  const r = await call("POST", `/api/pylon/live-posts/${card.id}/approve`, null, STAFF);
  assert.equal(r.status, 403);
});

test("an approver approves, then the card publishes", async () => {
  const card = await queueCard();
  const a = await call("POST", `/api/pylon/live-posts/${card.id}/approve`, null, APPROVER);
  assert.equal(a.status, 200);
  assert.equal(a.body.status, "approved");
  assert.equal(a.body.decided_by, APPROVER);
  const again = await call("POST", `/api/pylon/live-posts/${card.id}/approve`, null, APPROVER);
  assert.equal(again.status, 409);
  const p = await call("POST", `/api/pylon/live-posts/${card.id}/publish`, { channels: ["pylon_ig", "team_ig"] });
  assert.equal(p.status, 200);
  assert.equal(p.body.status, "published");
  assert.deepEqual(p.body.channels, ["pylon_ig", "team_ig"]);
  assert.ok(p.body.posted_at);
});

test("a rejected card can never publish", async () => {
  const card = await queueCard();
  assert.equal((await call("POST", `/api/pylon/live-posts/${card.id}/reject`, null, APPROVER)).status, 200);
  assert.equal((await call("POST", `/api/pylon/live-posts/${card.id}/publish`, { channels: ["pylon_ig"] })).status, 400);
  assert.equal((await call("POST", `/api/pylon/live-posts/${card.id}/approve`, null, APPROVER)).status, 409);
});

test("the queue lists cards by status", async () => {
  const r = await call("GET", `/api/pylon/live-posts?event_id=${eventId}&status=queued`);
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 2);
  assert.ok(r.body.every((c) => c.status === "queued"));
});

test("the database refuses a card inserted already approved or posted", async () => {
  await assert.rejects(
    pool.query(`insert into pylon_live_posts (event_id, post_type, status, decided_by, decided_at)
                values ($1, 'stat_card', 'approved', 'x', now())`, [eventId]),
    /must start queued/
  );
  await assert.rejects(
    pool.query(`insert into pylon_live_posts (event_id, post_type, posted_at) values ($1, 'stat_card', now())`, [eventId]),
    /must start queued/
  );
});

test("the database refuses to post a queued card directly", async () => {
  const card = await queueCard();
  await assert.rejects(
    pool.query("update pylon_live_posts set posted_at=now() where id=$1", [card.id]),
    /posted_needs_publish/
  );
  await assert.rejects(
    pool.query("update pylon_live_posts set status='published', decided_by='x', decided_at=now() where id=$1", [card.id]),
    /cannot move from queued to published/
  );
});

test("what an approved card shows cannot change", async () => {
  const card = await queueCard();
  await call("POST", `/api/pylon/live-posts/${card.id}/approve`, null, APPROVER);
  await assert.rejects(
    pool.query(`update pylon_live_posts set metadata='{"stat_value":"5"}' where id=$1`, [card.id]),
    /queue a new card instead/
  );
  await assert.rejects(
    pool.query(`update pylon_live_posts set sponsor_tag='Someone' where id=$1`, [card.id]),
    /queue a new card instead/
  );
  // Engagement numbers can still be recorded.
  await pool.query(`update pylon_live_posts set engagement_metrics='{"likes":10}' where id=$1`, [card.id]);
});
