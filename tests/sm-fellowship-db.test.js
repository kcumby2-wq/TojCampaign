// Migration 032 in a real Postgres: the rules the database enforces for
// fellowship applications, so no route bug can break them.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (sm_fellow_db_test), which it DROPS and recreates.
// Never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const F = require("../utils/sm-fellowship");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "sm_fellow_db_test";

if (!URL_) {
  test("fellowship database rules (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

let pool;
let n = 0;
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
// A fresh address each time, so the one-open-application rule stays out of
// the way unless a test is about it.
const app = (over = {}) => {
  n += 1;
  const row = {
    name: "Jordan Reyes",
    email: `jordan${n}@example.com`,
    city: "Houston",
    state: "TX",
    region: "south_central",
    age_group: "adult",
    seat: "shooter",
    plan: "tools",
    links: ["https://instagram.com/jordan"],
    confirmed: true,
    ...over,
  };
  const cols = Object.keys(row);
  return [`insert into sm_fellowship_applications (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")}) returning *`, Object.values(row)];
};
const teen = (over = {}) => app({ age_group: "teen", seat: "photographer", guardian_name: "Dana Park", guardian_email: `dana${n + 1}@example.com`, ...over });

before(async () => {
  const admin = new Pool({ connectionString: URL_ });
  await admin.query(`drop schema if exists ${S} cascade; create schema ${S};`);
  for (const r of ["anon", "authenticated", "service_role"])
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  await admin.end();
  pool = new Pool({ connectionString: URL_, options: `-c search_path=${S}` });
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "032_sm_fellowship.sql"), "utf8").replace(/public\./g, `${S}.`);
  await q(sql);
  await q(sql); // safe to run twice
});
after(async () => {
  if (pool) await pool.end();
});

test("an adult's application goes in, confirmed, with no guardian on it", async () => {
  const a = (await q(...app())).rows[0];
  assert.equal(a.status, "new");
  assert.deepEqual(a.links, ["https://instagram.com/jordan"]);
  await refused(...app({ confirmed: false }));
  await refused(...app({ guardian_name: "Someone" }), "sm_fellowship_adult_chk");
  await refused(...app({ guardian_email: "someone@example.com" }), "sm_fellowship_adult_chk");
});

test("16 or 17: a guardian with their own email, and only the seats open at 16 or 17", async () => {
  assert.equal((await q(...teen())).rows[0].age_group, "teen");
  await refused(...teen({ guardian_name: null }), "sm_fellowship_teen_chk");
  await refused(...teen({ guardian_email: null }), "sm_fellowship_teen_chk");
  await refused(...teen({ email: "same@example.com", guardian_email: "same@example.com" }), "sm_fellowship_teen_chk");
  for (const seat of ["lead", "editor", "story"]) await refused(...teen({ seat }), "sm_fellowship_teen_seat_chk");
  for (const seat of ["unsure", "shadow", "shooter"]) assert.ok((await q(...teen({ seat }))).rows[0].id, seat);
  await refused(...app({ age_group: "kid" }));
});

test("links: one to three https addresses with a real host and no sign-in details", async () => {
  assert.ok((await q(...app({ links: ["https://a.co/1", "https://www.youtube.com/@jordan", "https://drive.google.com/drive/folders/abc?usp=sharing"] }))).rows[0].id);
  await refused(...app({ links: [] }));
  await refused(...app({ links: ["https://a.co/1", "https://a.co/2", "https://a.co/3", "https://a.co/4"] }));
  for (const bad of ["http://a.co/1", "javascript:alert(1)", "https://user:pass@a.co/x", "https://localhost/x", "https://a.co/has space", "https://" + "a".repeat(500) + ".co"]) await refused(...app({ links: [bad] }));
  await refused(...app({ links: ["https://a.co/1", null] }));
  await refused(...app({ links: [["https://a.co/1"], ["https://a.co/2"]] }));
});

test("whatever the form's rules let through, the database takes", async () => {
  // The two sets of rules agree: a link utils/sm-fellowship.js cleans goes in.
  for (const raw of ["instagram.com/sky.lens", "HTTP://Example.com/a b", "www.dropbox.com:443/s/abc?dl=0", "https://vimeo.com/123#t=10s"]) {
    const link = F.linkOf(raw);
    assert.ok(link, raw);
    assert.ok((await q(...app({ links: [link] }))).rows[0].id, link);
  }
  const { value } = F.normalize({ name: "Riley Park", email: "Riley@Example.com", city: "Houston", state: "tx", age_group: "teen", seat: "shadow", guardian_name: "Dana Park", guardian_email: "dana.p@example.com", links: ["youtube.com/@riley"], confirmed: true, handle: "@Riley.Lens" });
  const cols = Object.keys(value);
  const row = (await q(`insert into sm_fellowship_applications (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")}) returning *`, Object.values(value))).rows[0];
  assert.equal(row.handle, "riley.lens");
});

test("contact and place stay in shape", async () => {
  await refused(...app({ email: "Jordan@Example.com" }));
  await refused(...app({ email: "x@y.co?cc=thief%40evil.example" }));
  await refused(...app({ handle: "@jordan" }));
  await refused(...app({ handle: "Jordan" }));
  await refused(...app({ state: "Texas" }));
  await refused(...app({ region: "mars" }));
  await refused(...app({ phone: "12" }));
  await refused(...app({ about: "x".repeat(1001) }));
  await refused(...app({ gear: "x".repeat(201) }));
  await refused(...app({ seat: "director" }));
  await refused(...app({ plan: "free" }));
});

test("one open application per address; a closed one doesn't block a new one", async () => {
  const [sql, args] = app({ email: "once@example.com" });
  const first = (await q(sql, args)).rows[0];
  await refused(...app({ email: "once@example.com" }), "sm_fellowship_open_email_idx|duplicate key");
  await q(`update sm_fellowship_applications set status = 'declined' where id = $1`, [first.id]);
  const again = (await q(...app({ email: "once@example.com" }))).rows[0];
  // Reopening the old one while the new one is open is refused too.
  await refused(`update sm_fellowship_applications set status = 'talking' where id = $1`, [first.id], "sm_fellowship_open_email_idx|duplicate key");
  assert.ok(again.id);
});

test("approved and joined carry when they were approved", async () => {
  const a = (await q(...app())).rows[0];
  await refused(`update sm_fellowship_applications set status = 'approved' where id = $1`, [a.id], "sm_fellowship_approved_chk");
  await q(`update sm_fellowship_applications set status = 'approved', approved_at = now() where id = $1`, [a.id]);
  await q(`update sm_fellowship_applications set status = 'joined' where id = $1`, [a.id]);
  await refused(`update sm_fellowship_applications set status = 'won' where id = $1`, [a.id]);
});

test("the API roles can't read applications at all", async () => {
  const anon = await q(`select has_table_privilege('anon', '${S}.sm_fellowship_applications', 'select') as can`);
  assert.equal(anon.rows[0].can, false);
  const auth = await q(`select has_table_privilege('authenticated', '${S}.sm_fellowship_applications', 'insert') as can`);
  assert.equal(auth.rows[0].can, false);
  const rls = await q(`select relrowsecurity from pg_class where oid = '${S}.sm_fellowship_applications'::regclass`);
  assert.equal(rls.rows[0].relrowsecurity, true);
});
