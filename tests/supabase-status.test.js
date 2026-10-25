// /api/health's "supabase" field: whether the server could make its Supabase
// client. When it can't, every database read (the Pylon stop pages too) acts
// as if the database were empty, while the health check used to still say
// "supabase". On Oct 24, 2026 that happened live: supabase-js needed Node.js
// 22's built-in WebSocket and Render ran Node 20.
//
//   node --test tests/supabase-status.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const MODULE = require.resolve("../utils/supabase");
const SUPABASE_JS = require.resolve("@supabase/supabase-js");
const KEY = "test-service-key-value";
const URL_OK = "https://abcdefghijklmnopqrst.supabase.co";

// A fresh copy of utils/supabase.js under the given settings, optionally with
// supabase-js's createClient swapped for a stand-in.
function withSettings(url, key, createClient) {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  const realLib = require.cache[SUPABASE_JS];
  const logged = [];
  const consoleError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    if (url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = url;
    if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    if (createClient) require.cache[SUPABASE_JS] = { id: SUPABASE_JS, filename: SUPABASE_JS, loaded: true, exports: { createClient } };
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
    if (createClient) {
      if (realLib) require.cache[SUPABASE_JS] = realLib;
      else delete require.cache[SUPABASE_JS];
    }
    delete require.cache[MODULE];
  }
}

test("a full https address and a key make a client", () => {
  const r = withSettings(URL_OK, KEY);
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

test("an address without https:// is an error, logged once with the fix and never the key", () => {
  const r = withSettings("abcdefghijklmnopqrst.supabase.co", KEY);
  assert.equal(r.status, "error");
  assert.equal(r.client, false);
  assert.equal(r.logged.length, 1, "said once, however often it's asked");
  assert.match(r.logged[0], /https:\/\/<project-ref>\.supabase\.co/);
  assert.doesNotMatch(r.logged[0], new RegExp(KEY));
});

test("an address in quotes is an error too", () => {
  const r = withSettings(`"${URL_OK}"`, KEY);
  assert.equal(r.status, "error");
  assert.equal(r.client, false);
});

test("Node.js without a built-in WebSocket (older than 22): an error that says to use Node 22", () => {
  const r = withSettings(URL_OK, KEY, () => {
    throw new Error("Node.js detected but native WebSocket not found.");
  });
  assert.equal(r.status, "error");
  assert.equal(r.client, false);
  assert.equal(r.logged.length, 1);
  assert.match(r.logged[0], /native WebSocket not found/);
  assert.match(r.logged[0], /NODE_VERSION to 22/);
  assert.doesNotMatch(r.logged[0], /<project-ref>/, "not blamed on the address");
});

test("a key that is only spaces counts as not set", () => {
  const r = withSettings(URL_OK, "   ");
  assert.equal(r.status, "not_set");
  assert.equal(r.client, false);
});

test("server.js reports it on /api/health", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /supabase: require\("\.\/utils\/supabase"\)\.supabaseStatus\(\)/);
});
