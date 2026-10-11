// Staff access tests — the open-registration hole stays closed.
//
// Runs the real route files in-process on the JSON fallback (no Supabase, no
// database, no network). db/users.json is backed up and restored around the
// run (and db/intake_submissions.json), so a developer's local data is
// untouched.
//
//   node --test tests/staff-access.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Force the JSON fallback everywhere before any route is loaded.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ADMIN_EMAILS;
process.env.HOOKS_API_KEY = "hooks-test-key-0123456789";

const express = require("express");
const session = require("express-session");

const USERS_FILE = path.join(__dirname, "..", "db", "users.json");
const INTAKE_FILE = path.join(__dirname, "..", "db", "intake_submissions.json");
let usersBackup = null;
let intakeBackup = null;
let server;
let base;

function writeUsers(list) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2));
}
function readUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

before(async () => {
  if (fs.existsSync(USERS_FILE)) usersBackup = fs.readFileSync(USERS_FILE);
  if (fs.existsSync(INTAKE_FILE)) intakeBackup = fs.readFileSync(INTAKE_FILE);

  // Legacy accounts: made before roles existed (no role in the JSON file).
  const bcrypt = require("bcryptjs");
  const hash = await bcrypt.hash("legacy-pass-1", 4);
  writeUsers([
    { email: "kyron@toj.test", hash, createdAt: "2026-01-01T00:00:00Z" },
    { email: "old-client@toj.test", hash, createdAt: "2026-01-02T00:00:00Z" },
  ]);

  const app = express();
  app.use(express.json());
  app.use(
    session({ secret: "staff-access-test", resave: false, saveUninitialized: false })
  );
  // Test-only: a session from before this change (email, no role).
  app.post("/__test/old-session", (req, res) => {
    req.session.userEmail = req.body.email;
    res.json({ ok: true });
  });
  // Same mounts as server.js.
  app.use("/api/auth", require("../routes/auth"));
  app.use("/api/intake", require("../routes/intake"));
  app.use("/api/onboarding", require("../routes/onboarding"));
  app.use("/api/waitlist", require("../routes/waitlist"));
  app.use("/api/admin", require("../routes/admin"));
  app.use("/api/client", require("../routes/client"));
  app.use("/api/rag", require("../utils/staff").requireStaff, require("../routes/rag"));
  app.use("/api/agents", require("../routes/agents"));
  app.use("/api/hooks-agents", require("../routes/hooks-agents"));
  app.use("/api/diagnostic-agents", require("../routes/diagnostic-agents"));
  app.use("/api/performance-agents", require("../routes/performance-agents"));
  app.get("/api/me", (req, res) => {
    if (req.session && req.session.userEmail)
      return res.json({
        authenticated: true,
        email: req.session.userEmail,
        staff: require("../utils/staff").isStaff(req),
      });
    res.json({ authenticated: false });
  });

  await new Promise((r) => (server = app.listen(0, r)));
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  server && server.close();
  if (usersBackup) fs.writeFileSync(USERS_FILE, usersBackup);
  else if (fs.existsSync(USERS_FILE)) fs.unlinkSync(USERS_FILE);
  if (intakeBackup) fs.writeFileSync(INTAKE_FILE, intakeBackup);
  else if (fs.existsSync(INTAKE_FILE)) fs.unlinkSync(INTAKE_FILE);
});

// Tiny cookie-keeping client.
function client() {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    async req(method, url, body, headers = {}) {
      const res = await fetch(base + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      let json = null;
      try {
        json = await res.json();
      } catch {}
      return { status: res.status, body: json };
    },
  };
}

// Every route that exposes intake data, minors' records, client memory,
// agent runs or accounts.
const STAFF_ROUTES = [
  ["GET", "/api/onboarding/list"],
  ["GET", "/api/onboarding/stats"],
  ["PATCH", "/api/onboarding/some-id", { status: "contacted" }],
  ["GET", "/api/intake"],
  ["POST", "/api/intake/transcript", { foundation_score_id: "x" }],
  ["GET", "/api/waitlist/list"],
  ["GET", "/api/admin/pilots"],
  ["GET", "/api/admin/dashboard"],
  ["GET", "/api/admin/users"],
  ["PATCH", "/api/admin/users/role", { email: "x@toj.test", role: "client" }],
  ["POST", "/api/rag/retrieve", { client_id: "c1", query: "q" }],
  ["POST", "/api/agents/run", { role: "x", task: "hello world" }],
  ["GET", "/api/agents/runs/some-id"],
  ["POST", "/api/hooks-agents/run", { role: "x", task: "hello world" }],
  ["GET", "/api/hooks-agents/runs/some-id"],
  ["POST", "/api/diagnostic-agents/run", { role: "x", task: "hello world" }],
  ["GET", "/api/diagnostic-agents/runs/some-id"],
  ["POST", "/api/performance-agents/run", { role: "x", task: "hello world" }],
  ["GET", "/api/performance-agents/runs/some-id"],
];

async function expectAll(c, statuses, label) {
  for (const [m, url, body] of STAFF_ROUTES) {
    const r = await c.req(m, url, body);
    assert.ok(
      statuses.includes(r.status),
      `${label}: ${m} ${url} → ${r.status} ${JSON.stringify(r.body)}`
    );
  }
}

async function login(email, password = "legacy-pass-1") {
  const c = client();
  const r = await c.req("POST", "/api/auth/login", { email, password });
  assert.equal(r.status, 200, "login " + email);
  return c;
}

test("ADMIN_EMAILS unset: staff routes refuse everyone, even legacy accounts", async () => {
  delete process.env.ADMIN_EMAILS;
  const k = await login("kyron@toj.test");
  const r = await k.req("GET", "/api/onboarding/list");
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "staff_access_not_configured");
});

test("anonymous: every staff route is 401 (incl. legacy intake list)", async () => {
  process.env.ADMIN_EMAILS = " Kyron@TOJ.test , ops@toj.test ";
  await expectAll(client(), [401], "anonymous");
});

test("stranger who self-registers: 403 everywhere, not staff, no portal", async () => {
  process.env.ADMIN_EMAILS = "kyron@toj.test,ops@toj.test";
  const s = client();
  const reg = await s.req("POST", "/api/auth/register", {
    email: "stranger@evil.test",
    password: "123456",
  });
  assert.equal(reg.status, 200);
  const stored = readUsers().find((u) => u.email === "stranger@evil.test");
  assert.equal(stored.role, "creator", "new accounts are creators");

  await expectAll(s, [403], "stranger");
  const me = await s.req("GET", "/api/me");
  assert.equal(me.body.staff, false);
  const portal = await s.req("GET", "/api/client/me");
  assert.equal(portal.status, 403);
  assert.equal(portal.body.error, "not_a_client_account");
});

test("signing up with a listed staff email that has no account does NOT make you staff", async () => {
  process.env.ADMIN_EMAILS = "kyron@toj.test,ops@toj.test";
  const s = client();
  const reg = await s.req("POST", "/api/auth/register", {
    email: "OPS@toj.test",
    password: "123456",
  });
  assert.equal(reg.status, 200);
  await expectAll(s, [403], "listed email, self-registered");
  assert.equal((await s.req("GET", "/api/me")).body.staff, false);
});

test("legacy account on the list is staff; gates pass", async () => {
  process.env.ADMIN_EMAILS = "kyron@toj.test,ops@toj.test";
  const k = await login("kyron@toj.test");
  assert.equal((await k.req("GET", "/api/me")).body.staff, true);
  for (const [m, url, body] of STAFF_ROUTES) {
    const r = await k.req(m, url, body);
    assert.ok(
      ![401, 403].includes(r.status),
      `staff blocked: ${m} ${url} → ${r.status} ${JSON.stringify(r.body)}`
    );
  }
  assert.equal((await k.req("GET", "/api/onboarding/list")).status, 200);
  assert.equal((await k.req("GET", "/api/intake")).status, 200);
  const users = await k.req("GET", "/api/admin/users");
  assert.equal(users.status, 200);
  assert.ok(users.body.users.every((u) => !("hash" in u)), "no password hashes");
});

test("legacy account NOT on the list: not staff, but keeps the client portal", async () => {
  process.env.ADMIN_EMAILS = "kyron@toj.test";
  const c = await login("old-client@toj.test");
  await expectAll(c, [403], "legacy non-staff");
  const portal = await c.req("GET", "/api/client/me");
  assert.ok(![401, 403].includes(portal.status), "portal gate passes: " + portal.status);
});

test("a session from before the change (no role) must sign in again", async () => {
  process.env.ADMIN_EMAILS = "kyron@toj.test";
  const c = client();
  await c.req("POST", "/__test/old-session", { email: "kyron@toj.test" });
  const r = await c.req("GET", "/api/onboarding/list");
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "sign_in_again");
  const p = await c.req("GET", "/api/client/me");
  assert.equal(p.body.error, "sign_in_again");
});

test("staff promotes accounts: 'staff' needs the list too; 'client' opens the portal", async () => {
  process.env.ADMIN_EMAILS = "kyron@toj.test,ops@toj.test";
  const k = await login("kyron@toj.test");

  // ops@toj.test self-registered earlier (creator). Promote to staff.
  const bad = await k.req("PATCH", "/api/admin/users/role", { email: "ops@toj.test", role: "admin" });
  assert.equal(bad.status, 400, "legacy 'admin' can't be assigned");
  const ok = await k.req("PATCH", "/api/admin/users/role", { email: "ops@toj.test", role: "staff" });
  assert.equal(ok.status, 200);
  const ops = await login("ops@toj.test", "123456");
  assert.equal((await ops.req("GET", "/api/onboarding/list")).status, 200);

  // The stranger gets role 'staff' but is not on ADMIN_EMAILS → still 403.
  await k.req("PATCH", "/api/admin/users/role", { email: "stranger@evil.test", role: "staff" });
  const s1 = await login("stranger@evil.test", "123456");
  assert.equal((await s1.req("GET", "/api/onboarding/list")).status, 403);

  // Made a client → portal opens, admin stays closed.
  await k.req("PATCH", "/api/admin/users/role", { email: "stranger@evil.test", role: "client" });
  const s2 = await login("stranger@evil.test", "123456");
  const portal = await s2.req("GET", "/api/client/me");
  assert.ok(![401, 403].includes(portal.status), "client portal gate passes");
  assert.equal((await s2.req("GET", "/api/admin/users")).status, 403);

  // A non-staff account can't change roles.
  const self = await s2.req("PATCH", "/api/admin/users/role", { email: "stranger@evil.test", role: "staff" });
  assert.equal(self.status, 403);
});

test("integration API key still works; a wrong key does not", async () => {
  process.env.ADMIN_EMAILS = "kyron@toj.test";
  const anon = client();
  const good = await anon.req("GET", "/api/hooks-agents/runs/x", undefined, {
    "x-hooks-api-key": "hooks-test-key-0123456789",
  });
  assert.ok(![401, 403].includes(good.status), "key passes gate: " + good.status);
  const wrong = await anon.req("GET", "/api/hooks-agents/runs/x", undefined, {
    "x-hooks-api-key": "nope",
  });
  assert.equal(wrong.status, 401);
  const s = await login("old-client@toj.test");
  const wrongWithSession = await s.req("GET", "/api/hooks-agents/runs/x", undefined, {
    "x-hooks-api-key": "hooks-test-key-0123456789X",
  });
  assert.equal(wrongWithSession.status, 403);
});

test("sign-in issues a fresh session id", async () => {
  process.env.ADMIN_EMAILS = "kyron@toj.test";
  const c = client();
  await c.req("POST", "/__test/old-session", { email: "someone@toj.test" });
  const before = c.cookie;
  assert.ok(before);
  await c.req("POST", "/api/auth/login", { email: "kyron@toj.test", password: "legacy-pass-1" });
  assert.notEqual(c.cookie, before);
});

test("legacy intake submit logs an id, not the email", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const r = await client().req("POST", "/api/intake", {
      avenue: { primary: "sports" },
      brand: { email: "parent@family.test" },
    });
    assert.equal(r.status, 200);
  } finally {
    console.log = orig;
  }
  const intakeLines = lines.filter((l) => l.includes("[LEGACY INTAKE]"));
  assert.equal(intakeLines.length, 1);
  assert.ok(!intakeLines[0].includes("parent@family.test"), intakeLines[0]);
});
