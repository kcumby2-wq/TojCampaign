// Parent approval for Recruiting Concierge outreach (migration 013).
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// The test applies migrations 008 and 013 to that database and DROPS its public
// schema first, so never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const express = require("express");
const { Pool } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
const ROOT = path.join(__dirname, "..");

if (!URL_) {
  test("parent approval (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

let pool, server, base, outreachId, athleteId, subscriptionId;

// routes/pylon*.js require("../db"), which the app does not ship yet.
// Point that one require at the test pool.
function stubDb(p) {
  const fake = path.join(ROOT, "db", "__test_db__.js");
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

async function call(method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

before(async () => {
  pool = new Pool({ connectionString: URL_ });
  await pool.query("drop schema public cascade; create schema public;");
  for (const f of ["008_pylon_partnership.sql", "013_recruiting_parent_approval.sql"])
    await pool.query(fs.readFileSync(path.join(ROOT, "db", "migrations", f), "utf8"));

  stubDb(pool);
  const app = express();
  app.use(express.json());
  // Staff routes behind a fake signed-in session; the parent routes stay public.
  app.use("/api/pylon", (req, _res, next) => { req.session = { user: { email: "staff@example.com" } }; next(); },
    require("../routes/pylon"));
  app.use("/api/pylon-parent", require("../routes/pylon-parent"));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  athleteId = (await pool.query(
    `insert into pylon_athletes (canonical_name, parent_email) values ('Jordan Sample', 'parent@example.com') returning id`
  )).rows[0].id;
  subscriptionId = (await pool.query(
    `insert into pylon_recruiting_subscriptions (athlete_id, tier, billing_cadence, amount_cents, toj_take_cents, active_until)
     values ($1, 'standard', 'monthly', 9900, 4455, now() + interval '30 days') returning id`, [athleteId]
  )).rows[0].id;
});

after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
});

test("staff create a draft; it starts unapproved", async () => {
  const r = await call("POST", "/api/pylon/recruiting/draft", {
    subscription_id: subscriptionId, athlete_id: athleteId, coach_name: "Coach Example",
    coach_email: "coach@example.edu", program_name: "Example State", program_level: "ncaa_d2",
    outreach_type: "intro", draft_subject: "Film for your review", draft_body: "Coach, here is the film.",
  });
  assert.equal(r.status, 200);
  outreachId = r.body.id;
  assert.equal(r.body.parent_approved, false);
});

test("the old staff approve route refuses and points to the new path", async () => {
  const r = await call("POST", `/api/pylon/recruiting/approve/${outreachId}`);
  assert.equal(r.status, 410);
  const row = (await pool.query("select parent_approved from pylon_recruiting_outreach where id=$1", [outreachId])).rows[0];
  assert.equal(row.parent_approved, false);
});

test("the database refuses a direct approval with no parent link", async () => {
  await assert.rejects(
    pool.query("update pylon_recruiting_outreach set parent_approved=true, parent_decision='approved' where id=$1", [outreachId]),
    /only be approved by the parent/
  );
});

test("the database refuses to send an unapproved draft", async () => {
  await assert.rejects(
    pool.query("update pylon_recruiting_outreach set sent_at=now() where id=$1", [outreachId]),
    /sent_needs_parent/
  );
});

test("a draft cannot be inserted already approved", async () => {
  await assert.rejects(
    pool.query(`insert into pylon_recruiting_outreach (subscription_id, athlete_id, parent_approved)
                values ($1, $2, true)`, [subscriptionId, athleteId]),
    /cannot start approved/
  );
});

let token;

test("staff request approval: a one-time link, with only its hash stored", async () => {
  const r = await call("POST", `/api/pylon/recruiting/request-approval/${outreachId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.parent_email_on_file, true);
  token = new URL(r.body.approval_url).searchParams.get("token");
  assert.match(token, /^[0-9a-f]{64}$/);
  const row = (await pool.query("select parent_approval_token_hash from pylon_recruiting_outreach where id=$1", [outreachId])).rows[0];
  assert.notEqual(row.parent_approval_token_hash, token);
  assert.equal(row.parent_approval_token_hash.length, 64);
});

test("the parent sees the draft and only the athlete's first name", async () => {
  const r = await call("GET", `/api/pylon-parent/approval/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.athlete_first_name, "Jordan");
  assert.equal(r.body.draft_body, "Coach, here is the film.");
  assert.ok(!JSON.stringify(r.body).includes("Sample"));
  assert.ok(!JSON.stringify(r.body).includes("parent@example.com"));
});

test("editing the draft cancels the outstanding link", async () => {
  await pool.query("update pylon_recruiting_outreach set draft_body='Coach, updated film link.' where id=$1", [outreachId]);
  const r = await call("GET", `/api/pylon-parent/approval/${token}`);
  assert.equal(r.status, 404);
  const again = await call("POST", `/api/pylon/recruiting/request-approval/${outreachId}`);
  token = new URL(again.body.approval_url).searchParams.get("token");
});

test("the parent must confirm and give a name", async () => {
  assert.equal((await call("POST", `/api/pylon-parent/approval/${token}`, { decision: "approved", parent_name: "Pat Parent" })).status, 400);
  assert.equal((await call("POST", `/api/pylon-parent/approval/${token}`, { decision: "approved", confirm: true })).status, 400);
  assert.equal((await call("POST", `/api/pylon-parent/approval/${token}`, { decision: "maybe", parent_name: "Pat Parent", confirm: true })).status, 400);
});

test("a malformed or unknown link is refused", async () => {
  assert.equal((await call("GET", "/api/pylon-parent/approval/not-a-token")).status, 400);
  assert.equal((await call("GET", `/api/pylon-parent/approval/${"a".repeat(64)}`)).status, 404);
});

test("the parent approves; the link is burned and the exact text is fingerprinted", async () => {
  const r = await call("POST", `/api/pylon-parent/approval/${token}`, { decision: "approved", parent_name: "Pat Parent", confirm: true });
  assert.equal(r.status, 200);
  const row = (await pool.query(
    `select parent_approved, parent_decision, parent_decided_name, parent_approval_token_hash, approved_text_sha256,
            encode(sha256(convert_to(draft_subject || E'\\n' || draft_body, 'UTF8')), 'hex') as expected
       from pylon_recruiting_outreach where id=$1`, [outreachId])).rows[0];
  assert.equal(row.parent_approved, true);
  assert.equal(row.parent_decision, "approved");
  assert.equal(row.parent_decided_name, "Pat Parent");
  assert.equal(row.parent_approval_token_hash, null);
  assert.equal(row.approved_text_sha256, row.expected);
});

test("the same link cannot be used twice", async () => {
  const r = await call("POST", `/api/pylon-parent/approval/${token}`, { decision: "declined", parent_name: "Someone Else", confirm: true });
  assert.equal(r.status, 404);
});

test("approved text cannot be edited afterwards", async () => {
  await assert.rejects(
    pool.query("update pylon_recruiting_outreach set draft_body='Changed after approval' where id=$1", [outreachId]),
    /was approved by the parent/
  );
});

test("staff cannot re-request approval on an approved draft", async () => {
  const r = await call("POST", `/api/pylon/recruiting/request-approval/${outreachId}`);
  assert.equal(r.status, 409);
});

test("an approved draft can be marked sent", async () => {
  await pool.query("update pylon_recruiting_outreach set sent_at=now() where id=$1", [outreachId]);
});

test("a declined draft stays unsendable", async () => {
  const d = await call("POST", "/api/pylon/recruiting/draft", {
    subscription_id: subscriptionId, athlete_id: athleteId, coach_email: "coach2@example.edu",
    draft_subject: "Second", draft_body: "Second draft",
  });
  const req = await call("POST", `/api/pylon/recruiting/request-approval/${d.body.id}`);
  const t = new URL(req.body.approval_url).searchParams.get("token");
  const r = await call("POST", `/api/pylon-parent/approval/${t}`, { decision: "declined", parent_name: "Pat Parent", confirm: true });
  assert.equal(r.status, 200);
  await assert.rejects(pool.query("update pylon_recruiting_outreach set sent_at=now() where id=$1", [d.body.id]), /sent_needs_parent/);
});

test("an expired link is refused", async () => {
  const d = await call("POST", "/api/pylon/recruiting/draft", {
    subscription_id: subscriptionId, athlete_id: athleteId, coach_email: "coach3@example.edu",
    draft_subject: "Third", draft_body: "Third draft",
  });
  const req = await call("POST", `/api/pylon/recruiting/request-approval/${d.body.id}`);
  const t = new URL(req.body.approval_url).searchParams.get("token");
  await pool.query("update pylon_recruiting_outreach set parent_approval_expires_at = now() - interval '1 minute' where id=$1", [d.body.id]);
  assert.equal((await call("GET", `/api/pylon-parent/approval/${t}`)).status, 404);
  assert.equal((await call("POST", `/api/pylon-parent/approval/${t}`, { decision: "approved", parent_name: "Pat Parent", confirm: true })).status, 404);
});
