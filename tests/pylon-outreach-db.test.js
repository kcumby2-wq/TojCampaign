// The Recruiting Concierge's messages to coaches on a real Postgres
// (migrations 036 and 037): what the database refuses, the two functions the
// family's page uses, who may call them, and the whole path through the
// routes: a draft, the family's link by email, their decision, sent.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_pylonout_test), which it DROPS and recreates.
// Never point it at a real database.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
if (!URL_) {
  test("migration 037 on Postgres (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@toj.test";
const express = require("express");
const session = require("express-session");
const { setSupabase } = require("../utils/supabase");
const { pgSupabase } = require("./helpers/pg-supabase");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const pylon = require("../routes/pylon");
const outreachRoutes = require("../routes/pylon-outreach");
const parent = require("../routes/pylon-parent");

const NAME = "gfs_pylonout_test";
let pool, server, base, mails = [], pushes = [], mailOk = true;
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
async function call(method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get("set-cookie") };
}
let cookie;
const staff = (method, p, body) => call(method, p, body, { Cookie: cookie });
const refused = (p, re = /./) => p.then(() => false, (e) => re.test(e.message));
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

async function request(over = {}) {
  const r = { kind: "recruiting", package: "standard_monthly", package_name: "Recruiting Concierge: Standard, monthly", price_cents: 9900, cadence: "month", contact_role: "parent", contact_name: "Pat Ellis", contact_email: "pat@example.com", athlete_name: "Jordan Ellis", consent: "parent", consent_text: "I'm the athlete's parent. I agree.", ...over };
  const cols = Object.keys(r);
  return (await pool.query(`insert into pylon_requests (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")}) returning id`, cols.map((c) => r[c]))).rows[0].id;
}
async function draft(requestId, over = {}) {
  const d = { request_id: requestId, coach_name: "Coach Example", coach_email: "coach@example.edu", program_name: "Example State", program_level: "ncaa_d2", draft_subject: "Film for your review", draft_body: "Coach, here is the film.", created_by: "kyron@toj.test", ...over };
  const cols = Object.keys(d);
  return (await pool.query(`insert into pylon_outreach (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")}) returning id`, cols.map((c) => d[c]))).rows[0].id;
}
// A link issued the way the route issues one: only its hash is kept.
async function link(id, { expires = "now() + interval '14 days'" } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(`update pylon_outreach set parent_approval_token_hash = $2, parent_approval_requested_at = now(), parent_approval_expires_at = ${expires}, parent_decision = null, parent_decided_at = null, parent_decided_name = null where id = $1`, [id, sha(token)]);
  return token;
}
const decide = (token, decision = "approved", name = "Pat Ellis") => pool.query("select * from pylon_outreach_decide($1, $2, $3)", [sha(token), decision, name]);

before(async () => {
  const admin = new Pool({ connectionString: URL_ });
  await admin.query(`drop schema if exists ${NAME} cascade; create schema ${NAME};`);
  for (const r of ["anon", "authenticated", "service_role"]) await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  await admin.end();
  pool = new Pool({ connectionString: URL_, options: `-c search_path=${NAME} -c timezone=UTC`, max: 6 });
  await pool.query(`create table ${NAME}.push_subscriptions (id uuid primary key default gen_random_uuid(), email text, endpoint text, p256dh text, auth text, kind text, fail_count int default 0, apns_env text)`);
  await pool.query(`insert into ${NAME}.push_subscriptions (email, endpoint, p256dh, auth, kind) values ('kyron@toj.test', 'https://push.test/1', 'k', 'a', 'web')`);
  for (const f of ["036_pylon_requests.sql", "037_pylon_outreach.sql", "037_pylon_outreach.sql"]) {
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "db", "migrations", f), "utf8").replace(/public\./g, `${NAME}.`));
  }
  setSupabase(pgSupabase(pool, NAME));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "pylon-outreach-db", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = "kyron@toj.test"; req.session.userRole = "staff"; res.json({ ok: true }); });
  app.use("/api/pylon", pylon);
  app.use("/api/pylon-parent", parent);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  push.setSender(async (sub, payload) => { pushes.push(payload); return {}; });
  mailer.setSender(async (m) => { mails.push(m); return mailOk ? { sent: true } : { sent: false, reason: "send_failed" }; });
  cookie = (await call("POST", "/__test/session", {})).cookie.split(";")[0];
});
after(async () => {
  server && server.close();
  push.setSender(null);
  mailer.setSender(null);
  setSupabase(null);
  await pool.query(`drop schema if exists ${NAME} cascade`);
  await pool.end();
});
beforeEach(() => { mails = []; pushes = []; mailOk = true; outreachRoutes._reset(); parent._reset(); });

// ── The database's line ──────────────────────────────────────────────────
test("a draft can't start decided, linked, approved or sent, and only a Concierge request has drafts", async () => {
  const req = await request();
  assert.ok(await draft(req));
  for (const over of [{ parent_approved: true }, { parent_decision: "approved", parent_decided_at: new Date(), parent_decided_name: "X Y" }, { parent_approval_token_hash: "a".repeat(64), parent_approval_expires_at: new Date(Date.now() + 1e6) }]) {
    assert.ok(await refused(draft(req, over)), JSON.stringify(Object.keys(over)));
  }
  const team = await request({ kind: "team_package", package: "1a", package_name: "Pylon Team Recap", cadence: "once", price_cents: 29900, contact_role: "coach", athlete_name: null, consent: null, consent_text: null });
  assert.ok(await refused(draft(team), /Recruiting Concierge request/));
});

test("no decision except by burning the family's link", async () => {
  const id = await draft(await request());
  assert.ok(await refused(pool.query("update pylon_outreach set parent_approved = true, parent_decision = 'approved', parent_decided_at = now(), parent_decided_name = 'Staff Member', approved_text_sha256 = pylon_outreach_text_sha256(draft_subject, draft_body) where id = $1", [id]), /only be (decided|approved) by the family/));
  assert.ok(await refused(pool.query("update pylon_outreach set parent_decision = 'declined', parent_decided_at = now(), parent_decided_name = 'Staff Member' where id = $1", [id]), /only be decided by the family/));
  // With a link out, staff still can't decide without burning it.
  await link(id);
  assert.ok(await refused(pool.query("update pylon_outreach set parent_decision = 'declined', parent_decided_at = now(), parent_decided_name = 'Staff Member' where id = $1", [id])));
  // Burning it with a wrong fingerprint: refused.
  assert.ok(await refused(pool.query("update pylon_outreach set parent_approved = true, parent_decision = 'approved', parent_decided_at = now(), parent_decided_name = 'X Y', approved_text_sha256 = $2, parent_approval_token_hash = null, parent_approval_expires_at = null where id = $1", [id, "b".repeat(64)]), /only be approved by the family/));
});

test("nothing is sent without approval", async () => {
  const id = await draft(await request());
  assert.ok(await refused(pool.query("update pylon_outreach set sent_at = now(), sent_by = 'kyron@toj.test' where id = $1", [id]), /sent_needs_approval/));
});

test("the family's link: shows the message once, decides once, then stops working", async () => {
  const req = await request();
  const id = await draft(req);
  const token = await link(id);
  const { rows: [shown] } = await pool.query("select * from pylon_outreach_for_family($1)", [sha(token)]);
  assert.equal(shown.athlete_first_name, "Jordan");
  assert.equal(shown.approver, "parent");
  assert.equal(shown.draft_body, "Coach, here is the film.");
  assert.equal((await pool.query("select * from pylon_outreach_for_family($1)", [sha("x")])).rows.length, 0);
  const { rows: [done] } = await decide(token, "approved", "Pat Ellis");
  assert.equal(done.outreach_id, id);
  const { rows: [o] } = await pool.query("select * from pylon_outreach where id = $1", [id]);
  assert.equal(o.parent_approved, true);
  assert.equal(o.parent_approval_token_hash, null, "the link is burned");
  assert.equal(o.approved_text_sha256, sha("Film for your review\nCoach, here is the film."), "the fingerprint of the words as approved");
  assert.equal((await decide(token, "declined")).rows.length, 0, "a link works once");
  assert.equal((await pool.query("select * from pylon_outreach_for_family($1)", [sha(token)])).rows.length, 0);
  // Sent, once.
  await pool.query("update pylon_outreach set sent_at = now(), sent_by = 'kyron@toj.test' where id = $1", [id]);
  assert.ok(await refused(pool.query("update pylon_outreach set sent_at = now() + interval '1 hour' where id = $1", [id]), /already sent/));
});

test("an expired link, a bad decision or a missing name records nothing", async () => {
  const id = await draft(await request());
  const old = await link(id, { expires: "now() - interval '1 minute'" });
  assert.equal((await decide(old)).rows.length, 0);
  const fresh = await link(id);
  assert.equal((await decide(fresh, "maybe")).rows.length, 0);
  assert.equal((await decide(fresh, "approved", " ")).rows.length, 0);
  const { rows: [o] } = await pool.query("select parent_decision, parent_approval_token_hash from pylon_outreach where id = $1", [id]);
  assert.equal(o.parent_decision, null);
  assert.ok(o.parent_approval_token_hash, "the good link still stands");
});

test("once approved, the words and the coach are fixed, and no new link can go out", async () => {
  const id = await draft(await request());
  await decide(await link(id));
  for (const set of ["draft_body = 'Changed.'", "draft_subject = 'Changed'", "coach_email = 'other@example.edu'", "coach_name = 'Someone Else'", "parent_approved = false, parent_decision = null, parent_decided_at = null, parent_decided_name = null, approved_text_sha256 = null"]) {
    assert.ok(await refused(pool.query(`update pylon_outreach set ${set} where id = $1`, [id]), /approved/), set);
  }
  assert.ok(await refused(link(id)), "no new link on an approved message");
});

test("editing while a link is out cancels the link", async () => {
  const id = await draft(await request());
  const token = await link(id);
  await pool.query("update pylon_outreach set draft_body = 'A better message.' where id = $1", [id]);
  const { rows: [o] } = await pool.query("select parent_approval_token_hash, parent_approval_expires_at from pylon_outreach where id = $1", [id]);
  assert.equal(o.parent_approval_token_hash, null);
  assert.equal(o.parent_approval_expires_at, null);
  assert.equal((await decide(token)).rows.length, 0, "the old link approves nothing");
});

test("a decline stays until the family is asked again", async () => {
  const id = await draft(await request());
  await decide(await link(id), "declined", "Pat Ellis");
  assert.ok(await refused(pool.query("update pylon_outreach set parent_decision = null, parent_decided_at = null, parent_decided_name = null where id = $1", [id]), /declined/));
  const again = await link(id);
  const { rows: [o] } = await pool.query("select parent_decision from pylon_outreach where id = $1", [id]);
  assert.equal(o.parent_decision, null);
  assert.equal((await decide(again)).rows[0].outreach_id, id, "the new link works");
});

test("the API roles can't use the table or the family's functions", async () => {
  for (const fn of ["pylon_outreach_for_family(text)", "pylon_outreach_decide(text, text, text)", "pylon_outreach_text_sha256(text, text)"]) {
    for (const role of ["anon", "authenticated"]) {
      const { rows: [r] } = await pool.query(`select has_function_privilege($1, $2, 'execute') as ok`, [role, `${NAME}.${fn}`]);
      assert.equal(r.ok, false, `${role} ${fn}`);
    }
    const { rows: [s] } = await pool.query(`select has_function_privilege('service_role', $1, 'execute') as ok`, [`${NAME}.${fn}`]);
    assert.equal(s.ok, true, `service_role ${fn}`);
  }
  const { rows: [t] } = await pool.query(`select relrowsecurity from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = $1 and relname = 'pylon_outreach'`, [NAME]);
  assert.equal(t.relrowsecurity, true);
  const { rows: g } = await pool.query(`select grantee from information_schema.role_table_grants where table_schema = $1 and table_name = 'pylon_outreach' and grantee in ('anon','authenticated')`, [NAME]);
  assert.equal(g.length, 0);
});

// ── The whole path, through the routes ───────────────────────────────────
test("staff write, the family gets the link by email and approves, staff mark it sent", async () => {
  const req = await request({ contact_email: "family@example.com" });
  assert.equal((await call("GET", `/api/pylon/requests/${req}/outreach`)).status, 401, "staff only");
  const bad = await staff("POST", `/api/pylon/requests/${req}/outreach`, { coach_name: "", coach_email: "nope", program_name: "X", draft_subject: "S", draft_body: "B" });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.fields.includes("coach_name") && bad.data.fields.includes("coach_email"));
  const made = await staff("POST", `/api/pylon/requests/${req}/outreach`, { coach_name: "Coach Example", coach_email: "Coach@Example.EDU", program_name: "Example State", program_level: "hbcu", draft_subject: "Film for your review", draft_body: "Coach,\nhere is the film." });
  assert.equal(made.status, 200);
  const oid = made.data.outreach.id;
  assert.equal(made.data.outreach.state, "draft");
  assert.equal(made.data.outreach.coach_email, "coach@example.edu");
  assert.equal(made.data.outreach.parent_approval_token_hash, undefined, "the app never gets the hash");
  // Can't send a draft.
  assert.equal((await staff("POST", `/api/pylon/outreach/${oid}/sent`, {})).status, 409);
  // Ask: the link goes to the family by email, and not to staff.
  const ask = await staff("POST", `/api/pylon/outreach/${oid}/ask`, {});
  assert.equal(ask.status, 200);
  assert.equal(ask.data.sent_to, "family@example.com");
  assert.ok(!JSON.stringify(ask.data).match(/[0-9a-f]{64}/), "no token in what staff get back");
  assert.equal(ask.data.outreach.state, "waiting");
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ["family@example.com"]);
  assert.match(mails[0].text, /Nothing goes to the coach until you approve it/);
  assert.match(mails[0].text, /about Jordan/);
  const token = /parent-approval\.html\?token=([0-9a-f]{64})/.exec(mails[0].text)[1];
  // The family's page.
  const view = await call("GET", `/api/pylon-parent/approval/${token}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.approver, "family");
  assert.equal(view.data.athlete_first_name, "Jordan");
  assert.equal(view.data.program_level, "HBCU (any level)");
  assert.equal(view.data.draft_body, "Coach,\nhere is the film.");
  assert.equal((await call("POST", `/api/pylon-parent/approval/${token}`, { decision: "approved", parent_name: "Pat Ellis" })).status, 400, "the box has to be ticked");
  assert.equal((await call("POST", `/api/pylon-parent/approval/${token}`, { decision: "approved", parent_name: "P", confirm: true })).status, 400, "a name");
  const yes = await call("POST", `/api/pylon-parent/approval/${token}`, { decision: "approved", parent_name: "Pat Ellis", confirm: true });
  assert.equal(yes.status, 200);
  await wait();
  assert.ok(pushes.some((p) => p.title === "Pylon: message approved" && !/Jordan/.test(p.body)));
  assert.equal((await call("POST", `/api/pylon-parent/approval/${token}`, { decision: "declined", parent_name: "Pat Ellis", confirm: true })).status, 404, "once");
  assert.equal((await call("GET", `/api/pylon-parent/approval/${token}`)).status, 404);
  // Approved: no edits, no new link; then sent, once.
  assert.equal((await staff("PATCH", `/api/pylon/outreach/${oid}`, { draft_body: "Changed." })).status, 409);
  assert.equal((await staff("POST", `/api/pylon/outreach/${oid}/ask`, {})).status, 409);
  const list = await staff("GET", `/api/pylon/requests/${req}/outreach`);
  assert.equal(list.data.outreach[0].state, "approved");
  assert.equal(list.data.outreach[0].parent_decided_name, "Pat Ellis");
  assert.equal((await staff("POST", `/api/pylon/outreach/${oid}/sent`, {})).status, 200);
  assert.equal((await staff("POST", `/api/pylon/outreach/${oid}/sent`, {})).status, 409);
  const { rows: [o] } = await pool.query("select sent_by from pylon_outreach where id = $1", [oid]);
  assert.equal(o.sent_by, "kyron@toj.test");
});

test("an athlete of 18+ approves their own: the page and the email say so", async () => {
  const req = await request({ contact_role: "athlete", consent: "adult", contact_name: "Jordan Ellis", contact_email: "jordan@example.com" });
  const oid = (await staff("POST", `/api/pylon/requests/${req}/outreach`, { coach_name: "Coach Example", coach_email: "coach@example.edu", program_name: "Example State", draft_subject: "Film", draft_body: "Here." })).data.outreach.id;
  await staff("POST", `/api/pylon/outreach/${oid}/ask`, {});
  assert.match(mails[0].text, /for you\./);
  const token = /token=([0-9a-f]{64})/.exec(mails[0].text)[1];
  assert.equal((await call("GET", `/api/pylon-parent/approval/${token}`)).data.approver, "athlete");
});

test("if the family's email can't go, no link is left out; editing cancels a link that is", async () => {
  const req = await request();
  const oid = (await staff("POST", `/api/pylon/requests/${req}/outreach`, { coach_name: "Coach Example", coach_email: "coach@example.edu", program_name: "Example State", draft_subject: "Film", draft_body: "Here." })).data.outreach.id;
  mailOk = false;
  const failed = await staff("POST", `/api/pylon/outreach/${oid}/ask`, {});
  assert.equal(failed.status, 502);
  assert.equal(failed.data.error, "email_not_sent");
  let { rows: [o] } = await pool.query("select parent_approval_token_hash from pylon_outreach where id = $1", [oid]);
  assert.equal(o.parent_approval_token_hash, null);
  mailOk = true;
  await staff("POST", `/api/pylon/outreach/${oid}/ask`, {});
  const token = /token=([0-9a-f]{64})/.exec(mails[mails.length - 1].text)[1];
  const edit = await staff("PATCH", `/api/pylon/outreach/${oid}`, { draft_body: "Here is the better film." });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.link_cancelled, true);
  assert.equal(edit.data.outreach.state, "draft");
  assert.equal((await call("GET", `/api/pylon-parent/approval/${token}`)).status, 404, "the old link shows nothing");
});

test("only a Concierge request has messages; odd ids and links are refused plainly", async () => {
  const team = await request({ kind: "team_package", package: "1a", package_name: "Pylon Team Recap", cadence: "once", price_cents: 29900, contact_role: "coach", athlete_name: null, consent: null, consent_text: null });
  assert.equal((await staff("POST", `/api/pylon/requests/${team}/outreach`, { coach_name: "C", coach_email: "c@example.edu", program_name: "P", draft_subject: "S", draft_body: "B" })).status, 400);
  assert.equal((await staff("GET", "/api/pylon/requests/not-a-uuid/outreach")).status, 404);
  assert.equal((await staff("POST", "/api/pylon/outreach/not-a-uuid/ask", {})).status, 404);
  assert.equal((await call("GET", "/api/pylon-parent/approval/NOT-HEX")).status, 400);
  assert.equal((await call("GET", `/api/pylon-parent/approval/${"a".repeat(64)}`)).status, 404);
});

test("guessing at links is slowed down", async () => {
  let last;
  for (let i = 0; i < 31; i++) last = await call("GET", `/api/pylon-parent/approval/${crypto.randomBytes(32).toString("hex")}`, undefined, { "X-Forwarded-For": "203.0.113.200" });
  assert.equal(last.status, 429);
});
