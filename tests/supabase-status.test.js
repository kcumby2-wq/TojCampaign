// /api/health's "supabase" field: whether the server could make its Supabase
// client. A SUPABASE_URL without https:// (or in quotes) used to fail
// silently: every database read, the Pylon stop pages included, acted as if
// the database were empty, while the health check still said "supabase".
//
//   node --test tests/supabase-status.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const MODULE = require.resolve("../utils/supabase");
const KEY = "test-service-key-value";

// A fresh copy of utils/supabase.js under the given settings.
function withSettings(url, key) {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  const logged = [];
  const consoleError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    if (url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = url;
    if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    delete require.cache[MODULE];
    const S = require(MODULE);
    const status = S.supabaseStatus();
    const client = S.getSupabase();
    S.supabaseStatus();
    return { status, client, logged };
  } finally {
    console.error = consoleError;
    for (const [name, v] of [["SUPABASE_URL", saved.url], ["SUPABASE_SERVICE_ROLE_KEY", saved.key]]) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
    delete require.cache[MODULE];
  }
}

test("a full https address and a key make a client", () => {
  const r = withSettings("https://abcdefghijklmnopqrst.supabase.co", KEY);
  assert.equal(r.status, "ok");
  assert.ok(r.client);
  assert.deepEqual(r.logged, []);
});

test("nothing set: not_set, and nothing logged", () => {
  const r = withSettings(undefined, undefined);
  assert.equal(r.status, "not_set");
  assert.equal(r.client, false);
  assert.deepEqual(r.logged, []);
});

test("an address without https:// is invalid, logged once with the fix and never the key", () => {
  const r = withSettings("abcdefghijklmnopqrst.supabase.co", KEY);
  assert.equal(r.status, "invalid");
  assert.equal(r.client, false);
  assert.equal(r.logged.length, 1, "said once, however often it's asked");
  assert.match(r.logged[0], /https:\/\/<project-ref>\.supabase\.co/);
  assert.doesNotMatch(r.logged[0], new RegExp(KEY));
});

test("an address in quotes is invalid too", () => {
  const r = withSettings('"https://abcdefghijklmnopqrst.supabase.co"', KEY);
  assert.equal(r.status, "invalid");
  assert.equal(r.client, false);
});

test("a key that is only spaces counts as not set", () => {
  const r = withSettings("https://abcdefghijklmnopqrst.supabase.co", "   ");
  assert.equal(r.status, "not_set");
  assert.equal(r.client, false);
});

test("server.js reports it on /api/health", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /supabase: require\("\.\/utils\/supabase"\)\.supabaseStatus\(\)/);
});
