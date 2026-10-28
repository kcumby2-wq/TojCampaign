// Migration 030 in a real Postgres: the rules the database enforces for
// Subject Medias bookings, so no route bug can break them.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (sm_db_test), which it DROPS and recreates. Never
// point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "sm_db_test";

if (!URL_) {
  test("sm bookings database rules (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

let pool, creator;
const q = (sql, params) => pool.query(sql, params);
async function refused(sql, params, name) {
  try {
    await q(sql, params);
  } catch (e) {
    if (name) assert.match(e.message + " " + (e.constraint || ""), new RegExp(name), `expected ${name}, got: ${e.message}`);
    return;
  }
  assert.fail(`expected a refusal${name ? " (" + name + ")" : ""}: ${sql}`);
}
const form = (over = {}) => {
  const row = { source: "form", kind: "athlete", contact_name: "Jamie Parent", contact_email: "jamie@example.com", adult_confirmed: true, event_state: "CA", ...over };
  const cols = Object.keys(row);
  return [`insert into sm_bookings (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")}) returning *`, Object.values(row)];
};

before(async () => {
  const admin = new Pool({ connectionString: URL_ });
  await admin.query(`drop schema if exists ${S} cascade; create schema ${S};`);
  for (const r of ["anon", "authenticated", "service_role"])
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  await admin.end();
  pool = new Pool({ connectionString: URL_, options: `-c search_path=${S}` });
  // The one table 030 points at (migration 024 makes the real one).
  await q(`create table ${S}.gfs_creators (id uuid primary key default gen_random_uuid(), name text not null)`);
  creator = (await q(`insert into gfs_creators (name) values ('Amy Near') returning *`)).rows[0];
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "030_sm_bookings.sql"), "utf8").replace(/public\./g, `${S}.`);
  await q(sql);
  await q(sql); // safe to run twice
});
after(async () => {
  if (pool) await pool.end();
});

test("a form booking needs an adult who said so and an email; a paid one needs its Stripe checkout", async () => {
  const [ok, args] = form();
  assert.equal((await q(ok, args)).rows[0].status, "new");
  await refused(...form({ adult_confirmed: false }), "sm_bookings_source_chk");
  await refused(...form({ contact_email: null }), "sm_bookings_source_chk");
  // A request paid from the success panel carries its checkout.
  const joined = (await q(...form({ stripe_session_id: "cs_test_abcdefgh123", amount_cents: 13999 }))).rows[0];
  assert.equal(joined.source, "form");
  await refused(...form({ source: "stripe" }), "sm_bookings_source_chk");
  const [paid, pargs] = form({ source: "stripe", adult_confirmed: false, stripe_session_id: "cs_live_abcdefgh123" });
  assert.equal((await q(paid, pargs)).rows[0].source, "stripe");
  await refused(paid, pargs, "stripe_session_id");
  await refused(...form({ source: "form", stripe_session_id: "cs_live_abcdefgh123" }), "stripe_session_id");
  await refused(...form({ source: "stripe", stripe_session_id: "not-a-session" }));
  // A checkout without an email still lands.
  const bare = (await q(...form({ source: "stripe", adult_confirmed: false, stripe_session_id: "cs_live_noemail1234", contact_email: null }))).rows[0];
  assert.equal(bare.contact_email, null);
});

test("contact and place stay in shape", async () => {
  await refused(...form({ contact_email: "Jamie@Example.com" }));
  await refused(...form({ contact_email: "x@y.co?cc=thief%40evil.example" }));
  await refused(...form({ contact_email: "x y@z.co" }));
  assert.ok((await q(...form({ contact_email: "o'brien+games@example.co.uk" }))).rows[0].id);
  await refused(...form({ amount_cents: 100000000 }));
  await refused(...form({ amount_cents: -1 }));
  await refused(...form({ event_state: "California" }));
  await refused(...form({ region: "mars" }));
  await refused(...form({ athletes: 0 }));
  await refused(...form({ contact_phone: "12" }));
  await refused(...form({ notes: "x".repeat(1001) }));
  await refused(...form({ kind: "fan" }));
});

test("staffed and delivered name the creator, who then can't be deleted", async () => {
  const b = (await q(...form())).rows[0];
  await refused(`update sm_bookings set status = 'staffed' where id = $1`, [b.id], "sm_bookings_staffed_chk");
  await q(`update sm_bookings set status = 'staffed', staffed_creator_id = $2 where id = $1`, [b.id, creator.id]);
  await refused(`update sm_bookings set status = 'won' where id = $1`, [b.id]);
  await refused(`delete from gfs_creators where id = $1`, [creator.id], "staffed_creator_id|foreign key");
  await refused(`update sm_bookings set staffed_creator_id = null where id = $1`, [b.id], "sm_bookings_staffed_chk");
  await q(`update sm_bookings set status = 'cancelled', staffed_creator_id = null where id = $1`, [b.id]);
});

test("the API roles can't read bookings at all", async () => {
  const anon = await q(`select has_table_privilege('anon', '${S}.sm_bookings', 'select') as can`);
  assert.equal(anon.rows[0].can, false);
  const rls = await q(`select relrowsecurity from pg_class where oid = '${S}.sm_bookings'::regclass`);
  assert.equal(rls.rows[0].relrowsecurity, true);
});
