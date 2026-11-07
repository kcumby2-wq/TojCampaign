// The Recruiting Concierge's messages to coaches on a real Postgres
// (migrations 036 and 037): what the database refuses, the proof only the
// family's link carries, the history it keeps, who may call what, and the
// whole path through the routes: a checked contact, a draft, the family's
// link by email, their decision and receipt, sent, a coach's reply.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_pylonout_test), which it DROPS and recreates.
// Never point it at a real database.

const { test, before, after, beforeEach, afterEach } = require("node:test");
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
delete process.env.PYLON_APPROVAL_REPLY_TO;
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
const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));
async function call(method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get("set-cookie") };
}
let cookie;
const staff = (method, p, body) => call(method, p, body, { Cookie: cookie });
const refused = (p, re = /./) => p.then(() => false, (e) => re.test(e.message) || (console.error("refused for another reason:", e.message), false));
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const family = (p, body, headers) => call("POST", "/api/pylon-parent/approval/" + p, body, headers);

async function request(over = {}) {
  const r = {
    kind: "recruiting", package: "standard_monthly", package_name: "Recruiting Concierge: Standard, monthly", price_cents: 9900, cadence: "month",
    contact_role: "parent", contact_name: "Pat Ellis", contact_email: "pat@example.com", contact_phone: "555-010-2030", athlete_name: "Jordan Ellis",
    consent: "parent", consent_text: "I'm the athlete's parent. I agree.", contact_verified_at: new Date(), contact_verified_by: "kyron@toj.test", ...over,
  };
  const cols = Object.keys(r);
  return (await pool.query(`insert into pylon_requests (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")}) returning id`, cols.map((c) => r[c]))).rows[0].id;
}
async function draft(requestId, over = {}) {
  const d = { request_id: requestId, coach_name: "Coach Example", coach_email: "coach@example.edu", program_name: "Example State", program_level: "ncaa_d2", draft_subject: "Film for your review", draft_body: "Coach, here is the film.", created_by: "kyron@toj.test", ...over };
  const cols = Object.keys(d);
  return (await pool.query(`insert into pylon_outreach (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")}) returning id`, cols.map((c) => d[c]))).rows[0].id;
}
// A link issued the way the route issues one: the token's hash is the proof,
// and the table keeps the proof's hash.
async function link(id, { expires = "now() + interval '14 days'" } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(`update pylon_outreach set parent_approval_token_hash = $2, parent_approval_requested_at = now(), parent_approval_expires_at = ${expires}, parent_decision = null, parent_decided_at = null, parent_decided_name = null, changed_by = 'kyron@toj.test', updated_at = now() where id = $1`, [id, sha(sha(token))]);
  return token;
}
const decide = (token, decision = "approved", name = "Pat Ellis") => pool.query("select * from pylon_outreach_decide($1, $2, $3)", [sha(token), decision, name]);
const shown = (token) => pool.query("select * from pylon_outreach_for_family($1)", [sha(token)]);
const row = async (id) => (await pool.query("select * from pylon_outreach where id = $1", [id])).rows[0];
const events = async (id) => (await pool.query("select event, by_staff, by_family, note, text_sha256 from pylon_outreach_events where outreach_id = $1 order by id", [id])).rows;
// A direct UPDATE in a transaction that carries the family's proof, as
// someone holding the token could.
async function withProof(token, sql, params) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('pylon.outreach_proof', $1, true)", [sha(token)]);
    await c.query(sql, params);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
const decideSql = "update pylon_outreach set parent_decision = 'approved', parent_decided_at = now(), parent_decided_name = 'Pat Ellis', parent_approval_token_hash = null";

before(async () => {
  const admin = new Pool({ connectionString: URL_ });
  await admin.query(`drop schema if exists ${NAME} cascade; create schema ${NAME};`);
  for (const r of ["anon", "authenticated", "service_role"]) await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  // As Supabase sets up its schema: the API roles get everything new by default.
  await admin.query(`grant usage on schema ${NAME} to anon, authenticated, service_role`);
  for (const what of ["tables", "functions", "sequences"]) await admin.query(`alter default privileges in schema ${NAME} grant all on ${what} to anon, authenticated, service_role`);
  await admin.end();
  pool = new Pool({ connectionString: URL_, options: `-c search_path=${NAME} -c timezone=UTC`, max: 8 });
  await pool.query(`create table ${NAME}.push_subscriptions (id uuid primary key default gen_random_uuid(), email text, endpoint text, p256dh text, auth text, kind text, fail_count int default 0, apns_env text)`);
  await pool.query(`insert into ${NAME}.push_subscriptions (email, endpoint, p256dh, auth, kind) values ('kyron@toj.test', 'https://push.test/1', 'k', 'a', 'web')`);
  await pool.query(`create table ${NAME}.team_activity (id bigserial primary key, actor text, action text, subject text, detail text, created_at timestamptz default now())`);
  for (const f of ["036_pylon_requests.sql", "037_pylon_outreach.sql", "037_pylon_outreach.sql"]) {
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "db", "migrations", f), "utf8").replace(/public\./g, `${NAME}.`));
  }
  // Supabase's service_role skips row security; this cluster's doesn't, so it
  // gets an allow-all policy here instead (for the tests that act as it).
  for (const t of ["pylon_outreach", "pylon_outreach_events", "pylon_requests"]) await pool.query(`create policy t_service_role on ${NAME}.${t} for all to service_role using (true) with check (true)`);
  setSupabase(pgSupabase(pool, NAME));
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
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
beforeEach(() => { mails = []; pushes = []; mailOk = true; outreachRoutes._reset(); parent._reset(); pylon._reset(); });
// Let each test's after-the-reply emails (alerts, receipts) land before the next starts.
afterEach(() => wait(150));

// ── The database's line ──────────────────────────────────────────────────
test("a draft can't start decided, linked, approved, withdrawn or sent, and only a Concierge request has drafts", async () => {
  const req = await request();
  assert.ok(await draft(req));
  for (const over of [
    { parent_approved: true },
    { parent_decision: "approved", parent_decided_at: new Date(), parent_decided_name: "X Y" },
    { parent_approval_token_hash: "a".repeat(64), parent_approval_expires_at: new Date(Date.now() + 1e6) },
    { asked_text_sha256: "a".repeat(64) },
  ]) assert.ok(await refused(draft(req, over)), JSON.stringify(Object.keys(over)));
  const team = await request({ kind: "team_package", package: "1a", package_name: "Pylon Team Recap", cadence: "once", price_cents: 29900, contact_role: "coach", athlete_name: null, consent: null, consent_text: null });
  assert.ok(await refused(draft(team), /Recruiting Concierge request/));
  assert.ok(await refused(draft(req, { draft_subject: "Film\r\nBcc: someone@else.example" })), "no control characters in a subject");
});

test("no decision without the family's proof, even with the table in hand", async () => {
  const id = await draft(await request());
  assert.ok(await refused(pool.query("update pylon_outreach set parent_decision = 'declined', parent_decided_at = now(), parent_decided_name = 'Staff Member' where id = $1", [id]), /only be decided by the family/));
  const token = await link(id);
  const stored = (await row(id)).parent_approval_token_hash;
  // Burning the link and deciding in one statement, without the proof: refused.
  assert.ok(await refused(pool.query(`${decideSql} where id = $1`, [id]), /only be decided by the family/));
  // The stored hash isn't the proof.
  assert.equal((await pool.query("select * from pylon_outreach_decide($1, 'approved', 'Staff Member')", [stored])).rows.length, 0);
  assert.equal((await pool.query("select * from pylon_outreach_for_family($1)", [stored])).rows.length, 0);
  assert.ok(await refused(withProof(crypto.randomBytes(32).toString("hex"), `${decideSql} where id = $1`, [id]), /only be decided by the family/), "someone else's proof");
  // The proof decides only in the update that burns the link.
  assert.ok(await refused(withProof(token, "update pylon_outreach set parent_decision = 'approved', parent_decided_at = now(), parent_decided_name = 'Pat Ellis' where id = $1", [id])));
  // The family's own decision.
  assert.equal((await decide(token)).rows.length, 1);
  const r = await row(id);
  assert.equal(r.parent_approved, true);
  assert.equal(r.approved_text_sha256, r.asked_text_sha256);
  assert.equal(r.parent_approval_token_hash, null);
  assert.equal((await decide(token)).rows.length, 0, "a link works once");
});

test("what the family saw is what's approved: the coach, the program, its level and the words", async () => {
  const req = await request();
  for (const change of ["draft_body = 'Something else'", "coach_email = 'rival@other.edu'", "coach_name = 'Coach Two'", "program_name = 'Rival University'", "program_level = 'juco'", "draft_subject = 'Other'"]) {
    const id = await draft(req);
    const token = await link(id);
    assert.ok(await refused(withProof(token, `${decideSql}, ${change} where id = $1`, [id]), /only be decided by the family|changed since/), change);
    // Changing it without deciding cancels the link instead.
    await pool.query(`update pylon_outreach set ${change} where id = $1`, [id]);
    assert.equal((await row(id)).parent_approval_token_hash, null, change);
    assert.equal((await shown(token)).rows.length, 0);
  }
  // The fingerprint covers each field on its own: moving text between the
  // subject and the body isn't the same message.
  const fp = (s, b) => pool.query("select pylon_outreach_fingerprint('C', 'c@x.edu', 'P', null, $1, $2) as f", [s, b]).then((x) => x.rows[0].f);
  assert.notEqual(await fp("ab", "c"), await fp("a", "bc"));
});

test("a link goes out only on an open request whose contact staff checked, and stops if that changes", async () => {
  const unchecked = await request({ contact_verified_at: null, contact_verified_by: null });
  assert.ok(await refused(link(await draft(unchecked)), /contact staff have checked/));
  const closed = await request({ status: "closed" });
  assert.ok(await refused(link(await draft(closed)), /open request/));
  const req = await request();
  const id = await draft(req);
  const token = await link(id);
  assert.equal((await shown(token)).rows.length, 1);
  await pool.query("update pylon_requests set contact_verified_at = null, contact_verified_by = null, status_by = 'kyron@toj.test' where id = $1", [req]);
  assert.equal((await shown(token)).rows.length, 0, "the check taken back: the link stops");
  assert.equal((await decide(token)).rows.length, 0);
  assert.equal((await row(id)).parent_approval_token_hash, null, "cancelled, not just hidden");
  await pool.query("update pylon_requests set contact_verified_at = now(), contact_verified_by = 'kyron@toj.test' where id = $1", [req]);
  assert.equal((await shown(token)).rows.length, 0, "checking again doesn't bring it back");
  const ev = await events(id);
  assert.deepEqual(ev.slice(-2).map((e) => e.event), ["link_cancelled", "note"]);
  assert.equal(ev[ev.length - 2].by_staff, "kyron@toj.test");
  assert.match(ev[ev.length - 1].note, /check of who the contact is was taken back/);
  // Done (or closed) cancels too, and reopening doesn't bring it back.
  const again = await link(id);
  await pool.query("update pylon_requests set status = 'done' where id = $1", [req]);
  assert.equal((await row(id)).parent_approval_token_hash, null);
  await pool.query("update pylon_requests set status = 'confirmed' where id = $1", [req]);
  assert.equal((await shown(again)).rows.length, 0);
  assert.match((await events(id)).pop().note, /marked done/);
  // Other requests' links are left alone.
  const other = await draft(await request());
  const t2 = await link(other);
  await pool.query("update pylon_requests set status = 'closed' where id = $1", [req]);
  assert.equal((await shown(t2)).rows.length, 1);
});

test("an expired link shows and decides nothing; a live link keeps its expiry; a new one lasts 14 days at most", async () => {
  const req = await request();
  const old = await draft(req);
  const token = await link(old, { expires: "now() - interval '1 minute'" });
  assert.equal((await shown(token)).rows.length, 0);
  assert.equal((await decide(token)).rows.length, 0);
  assert.ok(await refused(withProof(token, `${decideSql} where id = $1`, [old]), /only be decided by the family/));
  const live = await draft(req);
  await link(live);
  assert.ok(await refused(pool.query("update pylon_outreach set parent_approval_expires_at = now() + interval '90 days' where id = $1", [live]), /keeps its expiry/));
  assert.ok(await refused(link(live, { expires: "now() + interval '30 days'" }), /14 days at most/));
});

test("once approved: nothing shown or decided changes, no new link, never deleted", async () => {
  const id = await draft(await request());
  await decide(await link(id));
  for (const change of ["draft_body = 'x'", "program_level = 'juco'", "parent_decided_name = 'Someone Else'", "parent_decided_at = now() - interval '1 day'", "parent_approval_requested_at = now()", "parent_approved = false, parent_decision = null, parent_decided_at = null, parent_decided_name = null, approved_text_sha256 = null", "approved_text_sha256 = repeat('b', 64)"]) {
    assert.ok(await refused(pool.query(`update pylon_outreach set ${change} where id = $1`, [id])), change);
  }
  assert.ok(await refused(link(id), /was approved/));
  assert.ok(await refused(pool.query("delete from pylon_outreach where id = $1", [id]), /kept/));
});

test("sent once, only approved and not taken back; taken back once, only when approved", async () => {
  const req = await request();
  const draftOnly = await draft(req);
  assert.ok(await refused(pool.query("update pylon_outreach set sent_at = now(), sent_by = 'kyron@toj.test' where id = $1", [draftOnly])));
  assert.ok(await refused(pool.query("update pylon_outreach set withdrawn_at = now(), withdrawn_by = 'kyron@toj.test' where id = $1", [draftOnly]), /no approval to withdraw/));
  const back = await draft(req);
  await decide(await link(back));
  await pool.query("update pylon_outreach set withdrawn_at = now(), withdrawn_by = 'kyron@toj.test' where id = $1", [back]);
  assert.ok(await refused(pool.query("update pylon_outreach set sent_at = now(), sent_by = 'kyron@toj.test' where id = $1", [back])), "a withdrawn approval is never sent");
  assert.ok(await refused(pool.query("update pylon_outreach set withdrawn_at = now() - interval '1 hour' where id = $1", [back]), /withdrawn by the family/));
  const out = await draft(req);
  await decide(await link(out));
  await pool.query("update pylon_outreach set sent_at = now(), sent_by = 'kyron@toj.test' where id = $1", [out]);
  assert.ok(await refused(pool.query("update pylon_outreach set sent_at = now() + interval '1 hour' where id = $1", [out]), /already sent/));
  assert.ok(await refused(pool.query("update pylon_outreach set sent_at = null, sent_by = null where id = $1", [out]), /already sent/));
  assert.ok(await refused(pool.query("update pylon_outreach set withdrawn_at = now(), withdrawn_by = 'kyron@toj.test' where id = $1", [out])));
});

test("a decline stays as the family recorded it until they're asked again", async () => {
  const id = await draft(await request());
  await decide(await link(id), "declined");
  assert.ok(await refused(pool.query("update pylon_outreach set parent_decision = null, parent_decided_at = null, parent_decided_name = null where id = $1", [id]), /only asking the family again/));
  assert.ok(await refused(pool.query("update pylon_outreach set parent_decided_name = 'Someone Else' where id = $1", [id]), /stays as the family recorded it/));
  assert.ok(await refused(pool.query("update pylon_outreach set parent_decided_at = now() + interval '1 day' where id = $1", [id]), /stays as the family recorded it/));
  const again = await link(id);
  const r = await row(id);
  assert.equal(r.parent_decision, null);
  assert.equal((await shown(again)).rows.length, 1);
});

test("the history: written by the database, kept as written", async () => {
  const id = await draft(await request());
  await link(id);
  await pool.query("update pylon_outreach set draft_body = 'Edited.' where id = $1", [id]);
  await decide(await link(id), "declined");
  const asked = (await pool.query("select pylon_outreach_fingerprint(coach_name, coach_email, program_name, program_level, draft_subject, draft_body) as f from pylon_outreach where id = $1", [id])).rows[0].f;
  await decide(await link(id), "approved");
  await pool.query("update pylon_outreach set sent_at = now(), sent_by = 'kyron@toj.test' where id = $1", [id]);
  const ev = await events(id);
  assert.deepEqual(ev.map((e) => e.event), ["asked", "link_cancelled", "asked", "declined", "asked", "approved", "sent"]);
  assert.equal(ev[0].by_staff, "kyron@toj.test");
  assert.match(ev[1].note, /message changed/);
  assert.equal(ev[3].by_family, "Pat Ellis");
  assert.equal(ev[3].text_sha256, asked, "what they declined");
  assert.equal(ev[5].text_sha256, (await row(id)).approved_text_sha256);
  assert.ok(await refused(pool.query("update pylon_outreach_events set by_family = 'Someone Else' where outreach_id = $1", [id]), /kept as it was written/));
  assert.ok(await refused(pool.query("delete from pylon_outreach_events where outreach_id = $1", [id]), /kept as it was written/));
  assert.ok(await refused(pool.query("truncate pylon_outreach_events"), /kept as it was written/));
  assert.ok(await refused(pool.query("insert into pylon_outreach_events (outreach_id, event, by_family) values ($1, 'approved', 'Pat Ellis')", [id]), /written by the database/), "not even the owner, by hand");
  assert.ok(await refused(pool.query("insert into pylon_outreach_events (outreach_id, event, note) values ($1, 'reply', 'No staff name')", [id]), /staff member/));
  await pool.query("insert into pylon_outreach_events (outreach_id, event, by_staff, note, at) values ($1, 'reply', 'kyron@toj.test', 'Wants more film.', '2020-01-01')", [id]);
  const reply = (await pool.query("select at from pylon_outreach_events where outreach_id = $1 and event = 'reply'", [id])).rows[0];
  assert.ok(new Date(reply.at).getFullYear() >= 2026, "nobody backdates the history");
  const unsent = await draft(await request());
  assert.ok(await refused(pool.query("insert into pylon_outreach_events (outreach_id, event, by_staff, note) values ($1, 'reply', 'kyron@toj.test', 'x')", [unsent]), /message that was sent/));
  // As the server's own role (what the API key is): no forging, whatever it sets.
  await link(unsent);
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role service_role");
    await c.query("select set_config('pylon.outreach_logging', 'on', true)");
    await assert.rejects(c.query("insert into pylon_outreach_events (outreach_id, event, by_family) values ($1, 'approved', 'Pat Ellis')", [unsent]), /written by the database/);
    await c.query("rollback");
    await c.query("begin");
    await c.query("set local role service_role");
    await c.query("insert into pylon_outreach_events (outreach_id, event, by_staff, note) values ($1, 'note', 'kyron@toj.test', 'Called the family.')", [unsent]);
    // The database's own entries still land when the service role makes the change.
    await c.query("update pylon_outreach set draft_body = 'Changed by the service role.' where id = $1", [unsent]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  assert.deepEqual((await events(unsent)).map((e) => e.event), ["asked", "note", "link_cancelled"]);
});

test("deleting: a plain draft can go; one with history stays; a request with messages stays", async () => {
  const req = await request();
  const plain = await draft(req);
  await pool.query("delete from pylon_outreach where id = $1", [plain]);
  const used = await draft(req);
  await link(used);
  await pool.query("update pylon_outreach set parent_approval_token_hash = null, parent_approval_expires_at = null where id = $1", [used]);
  assert.ok(await refused(pool.query("delete from pylon_outreach where id = $1", [used]), /foreign key|violates/), "its history keeps it");
  assert.ok(await refused(pool.query("delete from pylon_requests where id = $1", [req]), /foreign key|violates/));
});

test("the API roles can't use the tables or any of the functions", async () => {
  const fns = ["pylon_outreach_for_family(text)", "pylon_outreach_decide(text, text, text)", "pylon_outreach_fingerprint(text, text, text, text, text, text)", "pylon_outreach_gate()", "pylon_outreach_log()", "pylon_outreach_events_gate()", "pylon_requests_stop_links()"];
  for (const role of ["anon", "authenticated"]) {
    for (const t of ["pylon_outreach", "pylon_outreach_events"]) {
      const { rows } = await pool.query("select has_table_privilege($1, $2, 'select, insert, update, delete') as ok", [role, `${NAME}.${t}`]);
      assert.equal(rows[0].ok, false, `${role} ${t}`);
    }
    for (const f of fns) {
      const { rows } = await pool.query("select has_function_privilege($1, $2, 'execute') as ok", [role, `${NAME}.${f}`]);
      assert.equal(rows[0].ok, false, `${role} ${f}`);
    }
    const { rows: seq } = await pool.query("select has_sequence_privilege($1, $2, 'usage, select, update') as ok", [role, `${NAME}.pylon_outreach_events_id_seq`]);
    assert.equal(seq[0].ok, false, `${role} the history's sequence`);
  }
  const { rows } = await pool.query("select relname, relrowsecurity from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = $1 and relname in ('pylon_outreach', 'pylon_outreach_events') order by 1", [NAME]);
  assert.deepEqual(rows.map((x) => x.relrowsecurity), [true, true]);
});

// ── Through the routes ──────────────────────────────────────────────────
const tokenIn = (text) => (/parent-approval\.html#t=([0-9a-f]{64})/.exec(text) || [])[1];
// The newest approval email to an address. Found by what it is, never by
// position: a receipt from the test before can land late.
const askMail = (to = "pat@example.com") => mails.filter((m) => /^Approve a message/.test(m.subject) && [].concat(m.to).includes(to)).pop();
async function listFor(req) {
  return (await staff("GET", `/api/pylon/requests/${req}/outreach`)).data;
}
async function seenOf(id) {
  return (await row(id)).updated_at;
}
const newDraft = async (req) => (await staff("POST", `/api/pylon/requests/${req}/outreach`, { coach_name: "Coach Example", coach_email: "coach@example.edu", program_name: "Example State", program_level: "ncaa_d2", draft_subject: "Film for your review", draft_body: "Coach,\nhere is Jordan's film from the Nov 21 event." })).data.outreach;

test("the whole path: a checked contact, a draft, the link by email, approval and receipt, sent, a reply", async () => {
  const req = await request({ contact_verified_at: null, contact_verified_by: null });
  const o = await newDraft(req);
  assert.equal(o.state, "draft");
  assert.equal(o.parent_approval_token_hash, undefined, "the app never gets the link's hash");
  assert.equal((await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: o.updated_at })).data.error, "contact_unchecked");
  assert.equal((await staff("PATCH", `/api/pylon/requests/${req}`, { verified: true })).status, 200);
  assert.equal((await listFor(req)).request.checked, true);

  const ask = await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) });
  assert.equal(ask.status, 200);
  assert.equal(ask.data.sent_to, "pat@example.com");
  const mail = mails.find((m) => [].concat(m.to).includes("pat@example.com"));
  const token = tokenIn(mail.text);
  assert.ok(token, "the link carries the token after #t=");
  assert.ok(!/\?token=/.test(mail.text));
  assert.equal(mail.replyTo, "pat@example.com", "a reply goes back to the family, never to staff");
  assert.match(mail.text, /don't forward this email or reply to it/);
  assert.ok(!JSON.stringify(ask.data).includes(token) && !JSON.stringify(ask.data).includes(sha(token)), "staff never see the link or its proof");

  const seen = await family("view", { token });
  assert.equal(seen.status, 200);
  assert.equal(seen.data.athlete_first_name, "Jordan");
  assert.equal(seen.data.program_level, "NCAA D2");
  assert.equal(seen.data.approver, "family");
  mails = [];
  const yes = await family("decide", { token, decision: "approved", parent_name: "Pat Ellis", confirm: true });
  assert.deepEqual(yes.data, { ok: true, decision: "approved" });
  await wait();
  assert.ok(pushes.some((p) => p.title === "Pylon: message approved"));
  assert.ok(mails.some((m) => [].concat(m.to).includes("kyron@toj.test") && /approved the message to Example State/.test(m.subject)));
  const receipt = mails.find((m) => [].concat(m.to).includes("pat@example.com"));
  assert.equal(receipt.subject, "You approved the message to Example State");
  assert.match(receipt.text, /If you didn't approve it/);
  assert.equal((await family("view", { token })).status, 404, "the link is spent");

  assert.equal((await staff("POST", `/api/pylon/outreach/${o.id}/sent`, {})).status, 200);
  assert.equal((await staff("POST", `/api/pylon/outreach/${o.id}/sent`, {})).data.error, "already_sent");
  assert.equal((await staff("POST", `/api/pylon/outreach/${o.id}/reply`, { note: "Wants film from the next event." })).status, 200);
  const after = (await listFor(req)).outreach[0];
  assert.equal(after.state, "sent");
  assert.deepEqual(after.history.map((e) => e.event), ["asked", "approved", "sent", "reply"]);
  assert.equal(after.history[1].by_family, "Pat Ellis");
  assert.equal(after.history[3].note, "Wants film from the next event.");
});

test("asking needs the card's current view, an open request and a checked contact", async () => {
  const req = await request();
  const o = await newDraft(req);
  assert.equal((await staff("POST", `/api/pylon/outreach/${o.id}/ask`, {})).data.error, "seen_required");
  assert.equal((await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: "2020-01-01T00:00:00+00:00" })).data.error, "changed_meanwhile");
  await staff("PATCH", `/api/pylon/requests/${req}`, { status: "closed" });
  assert.equal((await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) })).data.error, "request_closed");
  assert.equal(mails.length, 0);
});

test("a stale card can't wipe the family's decline", async () => {
  const req = await request();
  const o = await newDraft(req);
  await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) });
  const cardSaw = await seenOf(o.id);
  const token = tokenIn(askMail().text);
  assert.equal((await family("decide", { token, decision: "declined", parent_name: "Pat Ellis", confirm: true })).status, 200);
  // The card still shows "waiting" and offers "Send a new link".
  mails = [];
  const again = await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: cardSaw });
  assert.equal(again.data.error, "changed_meanwhile");
  assert.equal((await row(o.id)).parent_decision, "declined");
  await wait();
  assert.ok(!mails.some((m) => /^Approve a message/.test(m.subject)), "no new approval email");
});

test("if the email can't go, the link is taken back, and the decline stays in the history", async () => {
  const req = await request();
  const o = await newDraft(req);
  await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) });
  await family("decide", { token: tokenIn(askMail().text), decision: "declined", parent_name: "Pat Ellis", confirm: true });
  mailOk = false;
  const r = await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) });
  assert.equal(r.status, 502);
  assert.equal(r.data.error, "email_not_sent");
  const now = await row(o.id);
  assert.equal(now.parent_approval_token_hash, null, "nobody holds a link");
  const listed = (await listFor(req)).outreach[0];
  assert.deepEqual(listed.history.map((e) => e.event), ["asked", "declined", "asked", "link_cancelled", "note"]);
  assert.equal(listed.history[1].by_family, "Pat Ellis");
  assert.match(listed.history[4].note, /didn't go/);
});

test("staff can cancel a link that's out; it stops working at once", async () => {
  const req = await request();
  const o = await newDraft(req);
  await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) });
  const token = tokenIn(askMail().text);
  assert.equal((await staff("POST", `/api/pylon/outreach/${o.id}/cancel-link`, { seen: await seenOf(o.id) })).status, 200);
  assert.equal((await family("view", { token })).status, 404);
  assert.equal((await staff("POST", `/api/pylon/outreach/${o.id}/cancel-link`, { seen: await seenOf(o.id) })).data.error, "no_link");
  const h = (await listFor(req)).outreach[0].history;
  assert.equal(h[h.length - 1].event, "link_cancelled");
  assert.equal(h[h.length - 1].by_staff, "kyron@toj.test");
});

test("taking the check back through the app cancels the link for good", async () => {
  const req = await request();
  const o = await newDraft(req);
  await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) });
  const token = tokenIn(askMail().text);
  assert.equal((await staff("PATCH", `/api/pylon/requests/${req}`, { verified: false })).status, 200);
  assert.equal((await family("view", { token })).status, 404);
  assert.equal((await staff("PATCH", `/api/pylon/requests/${req}`, { verified: true })).status, 200);
  assert.equal((await family("view", { token })).status, 404, "a later check doesn't hand the old link back");
  const h = (await listFor(req)).outreach[0].history;
  assert.deepEqual(h.slice(-2).map((e) => e.event), ["link_cancelled", "note"]);
});

test("the family's receipt goes even if the staff alert can't", async () => {
  const req = await request();
  const o = await newDraft(req);
  await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) });
  const token = tokenIn(askMail().text);
  mailer.setSender(async (m) => {
    if ([].concat(m.to).includes("kyron@toj.test")) throw Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 });
    mails.push(m);
    return { sent: true };
  });
  try {
    mails = [];
    assert.equal((await family("decide", { token, decision: "approved", parent_name: "Pat Ellis", confirm: true })).status, 200);
    await wait(200);
    assert.ok(mails.some((m) => m.subject === "You approved the message to Example State"));
  } finally {
    mailer.setSender(async (m) => { mails.push(m); return mailOk ? { sent: true } : { sent: false, reason: "send_failed" }; });
  }
});

test("the family takes an approval back: it's never sent", async () => {
  const req = await request();
  const o = await newDraft(req);
  await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) });
  await family("decide", { token: tokenIn(askMail().text), decision: "approved", parent_name: "Pat Ellis", confirm: true });
  assert.equal((await staff("POST", `/api/pylon/outreach/${o.id}/withdraw`, { seen: await seenOf(o.id) })).status, 200);
  assert.equal((await staff("POST", `/api/pylon/outreach/${o.id}/sent`, {})).data.error, "withdrawn");
  const listed = (await listFor(req)).outreach[0];
  assert.equal(listed.state, "withdrawn");
  assert.equal(listed.history[listed.history.length - 1].event, "withdrawn");
});

test("editing while a link is out cancels it, whatever the family is shown that changes", async () => {
  const req = await request();
  const o = await newDraft(req);
  await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) });
  const token = tokenIn(askMail().text);
  const r = await staff("PATCH", `/api/pylon/outreach/${o.id}`, { program_level: "juco", seen: await seenOf(o.id) });
  assert.equal(r.data.link_cancelled, true);
  assert.equal((await family("view", { token })).status, 404);
  assert.equal((await staff("PATCH", `/api/pylon/outreach/${o.id}`, { draft_body: "x", seen: "2020-01-01T00:00:00+00:00" })).data.error, "changed_meanwhile");
});

test("the family's page: JSON from the site only, a real name, one decision however many taps", async () => {
  const req = await request();
  const o = await newDraft(req);
  await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) });
  const token = tokenIn(askMail().text);
  assert.equal((await call("GET", "/api/pylon-parent/approval/view")).status, 405);
  assert.equal((await call("POST", "/api/pylon-parent/approval/view", `token=${token}`, { "Content-Type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await family("view", { token }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await family("view", { token: "nope" })).status, 400);
  assert.equal((await family("view", { token: "f".repeat(64) })).status, 404);
  for (const name of ["​​", "A", "https://evil.example", "Pat 2"]) {
    assert.equal((await family("decide", { token, decision: "approved", parent_name: name, confirm: true })).data.error, "name_required", JSON.stringify(name));
  }
  assert.equal((await family("decide", { token, decision: "maybe", parent_name: "Pat Ellis", confirm: true })).data.error, "bad_decision");
  assert.equal((await family("decide", { token, decision: "approved", parent_name: "Pat Ellis" })).data.error, "confirm_required");
  const all = await Promise.all(Array.from({ length: 12 }, () => family("decide", { token, decision: "approved", parent_name: "Pat Ellis", confirm: true })));
  assert.equal(all.filter((x) => x.status === 200).length, 1);
  assert.ok(all.every((x) => x.status === 200 || x.status === 404));
});

test("an athlete of 18+ approves their own: the page and the email say so", async () => {
  const req = await request({ contact_role: "athlete", consent: "adult", contact_name: "Jordan Ellis", contact_email: "jordan@example.com" });
  const o = await newDraft(req);
  await staff("POST", `/api/pylon/outreach/${o.id}/ask`, { seen: await seenOf(o.id) });
  const mail = askMail("jordan@example.com");
  assert.match(mail.text, /^Hi Jordan,/);
  assert.match(mail.text, /Example State for you\./);
  assert.equal((await family("view", { token: tokenIn(mail.text) })).data.approver, "athlete");
});

test("approval emails: 20 a day to one mailbox, across requests; one that didn't go doesn't count", async () => {
  const a = await request({ contact_email: "pat.ellis@gmail.com" });
  const b = await request({ contact_email: "patellis@gmail.com" });
  const oa = await newDraft(a);
  const ob = await newDraft(b);
  for (let i = 0; i < 20; i++) {
    const id = i % 2 ? ob.id : oa.id;
    assert.equal((await staff("POST", `/api/pylon/outreach/${id}/ask`, { seen: await seenOf(id) })).status, 200, `ask ${i + 1}`);
  }
  assert.equal((await staff("POST", `/api/pylon/outreach/${oa.id}/ask`, { seen: await seenOf(oa.id) })).data.error, "too_many_asks");
  outreachRoutes._reset();
  mailOk = false;
  for (let i = 0; i < 20; i++) assert.equal((await staff("POST", `/api/pylon/outreach/${oa.id}/ask`, { seen: await seenOf(oa.id) })).status, 502);
  mailOk = true;
  assert.equal((await staff("POST", `/api/pylon/outreach/${oa.id}/ask`, { seen: await seenOf(oa.id) })).status, 200, "failures gave their places back");
});

test("guessing at links is slowed down", async () => {
  let limited = 0;
  for (let i = 0; i < 35; i++) if ((await family("view", { token: crypto.randomBytes(32).toString("hex") }, { "X-Forwarded-For": "203.0.113.9" })).status === 429) limited += 1;
  assert.equal(limited, 5, "30 tries per visitor per 10 minutes");
  parent._reset();
  let ok = 0;
  for (let i = 0; i < 300; i++) if ((await family("view", { token: crypto.randomBytes(32).toString("hex") }, { "X-Forwarded-For": `192.0.${Math.floor(i / 200)}.${i % 200}` })).status !== 429) ok += 1;
  assert.equal(ok, 300, "the shared breaker is for floods: hundreds of visitors don't reach it");
});
