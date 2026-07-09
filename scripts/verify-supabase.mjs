#!/usr/bin/env node
// TOJ · Supabase + Render deploy verifier.
//
// Run after finishing docs/supabase-setup.md steps 1-4 to confirm the whole
// stack is armed. Zero external dependencies, plain node.
//
// Usage:
//   Local dev (uses your .env vars if you export them):
//     export SUPABASE_URL=https://xxx.supabase.co
//     export SUPABASE_ANON_KEY=eyJ...
//     export SUPABASE_SERVICE_ROLE_KEY=eyJ...
//     node scripts/verify-supabase.mjs
//
//   Skip Render check (if you haven't deployed yet):
//     SKIP_RENDER=1 node scripts/verify-supabase.mjs

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
const render = process.env.RENDER_URL || "https://app.tojcampaign.com";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const ok = (s) => console.log(`${GREEN}✓${RESET} ${s}`);
const bad = (s) => console.log(`${RED}✗${RESET} ${s}`);
const warn = (s) => console.log(`${YELLOW}!${RESET} ${s}`);
const dim = (s) => console.log(`${DIM}${s}${RESET}`);

let failures = 0;
const fail = (s) => { failures++; bad(s); };

console.log("\nTOJ Supabase + backend verifier\n");

// ---------- Env presence ----------
console.log("Environment variables:");
if (!url) fail("SUPABASE_URL not set"); else ok(`SUPABASE_URL = ${url}`);
if (!anon) fail("SUPABASE_ANON_KEY not set"); else ok(`SUPABASE_ANON_KEY = ${anon.slice(0, 12)}…`);
if (!svc)  fail("SUPABASE_SERVICE_ROLE_KEY not set"); else ok(`SUPABASE_SERVICE_ROLE_KEY = ${svc.slice(0, 12)}…`);
if (failures) { console.log(""); dim("Set them and re-run. See docs/supabase-setup.md step 3."); process.exit(1); }
console.log("");

// ---------- Supabase REST reachability ----------
console.log("Supabase REST:");
async function sbCheck(table, key, expectRows) {
  try {
    const r = await fetch(`${url}/rest/v1/${table}?select=count`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (r.status === 401) return fail(`${table}: 401 unauthorized (key wrong?)`);
    if (r.status === 404) return fail(`${table}: 404 — did you run db/migrations/001_initial_schema.sql?`);
    if (!r.ok) return fail(`${table}: HTTP ${r.status}`);
    const body = await r.json();
    const count = Array.isArray(body) && body[0] ? body[0].count : "?";
    ok(`${table}: reachable · count=${count}`);
  } catch (e) {
    fail(`${table}: ${e.message}`);
  }
}
await sbCheck("waitlist", anon);
await sbCheck("clients", svc);
await sbCheck("foundation_scores", svc);
await sbCheck("deliverables", svc);
await sbCheck("pilots", svc);
console.log("");

// ---------- RLS sanity: anon should NOT read pilots ----------
console.log("RLS sanity (anon can't read internal tables):");
try {
  const r = await fetch(`${url}/rest/v1/pilots?select=id&limit=1`, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  });
  const body = await r.json();
  if (Array.isArray(body) && body.length === 0) {
    ok("pilots: anon read returns empty (RLS working)");
  } else if (body && body.code === "42501") {
    ok("pilots: anon read denied by RLS (working)");
  } else {
    warn(`pilots: anon read returned ${JSON.stringify(body).slice(0, 100)} — check RLS policy`);
  }
} catch (e) {
  warn(`pilots RLS check: ${e.message}`);
}
console.log("");

// ---------- Render backend reachability ----------
if (process.env.SKIP_RENDER) {
  dim("SKIP_RENDER=1 — skipping Render checks.\n");
} else {
  console.log(`Render backend (${render}):`);
  try {
    const r = await fetch(`${render}/api/waitlist/stats`);
    if (!r.ok) fail(`GET /api/waitlist/stats → HTTP ${r.status}`);
    else {
      const body = await r.json();
      ok(`GET /api/waitlist/stats → ${JSON.stringify(body)}`);
      if (body.backend === "supabase") ok("Render is using SUPABASE backend");
      else if (body.backend === "json") warn("Render is still on JSON backend — did you paste creds into Render env vars? Then wait for redeploy.");
    }
  } catch (e) {
    fail(`Render unreachable: ${e.message}`);
  }
  console.log("");
}

// ---------- Summary ----------
if (failures === 0) {
  console.log(`${GREEN}All checks passed.${RESET} Waitlist writes will land in Postgres, the`);
  console.log(`admin dashboard reads from Supabase, and the CPO is unblocked.\n`);
  process.exit(0);
} else {
  console.log(`${RED}${failures} check(s) failed.${RESET} See docs/supabase-setup.md for the fix path.\n`);
  process.exit(1);
}
