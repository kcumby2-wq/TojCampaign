// iPhone notifications (APNs): the provider token, what's sent, the sandbox
// fallback, dead tokens dropped, and the subscribe route for device tokens.
// A local HTTP/2 server stands in for Apple. No network.
//
//   node --test tests/apns.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http2 = require("http2");
const express = require("express");
const session = require("express-session");

process.env.ADMIN_EMAILS = "kyron@example.com";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const P8 = privateKey.export({ type: "pkcs8", format: "pem" }); // the same shape as Apple's .p8
const TOKEN_A = "a1".repeat(32);
const TOKEN_SANDBOX = "b2".repeat(32);
const TOKEN_DEAD = "c3".repeat(32);

const { fakeSupabase } = require("./helpers/fake-supabase");
const { setSupabase } = require("../utils/supabase");
const apns = require("../utils/apns");
const P = require("../utils/push");

let fakeApple = {}; // env → server
let seen = [];
let db;
let server;
let base;

function apple(env) {
  return new Promise((resolve) => {
    const srv = http2.createServer();
    srv.on("stream", (stream, headers) => {
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (c) => (body += c));
      stream.on("end", () => {
        const token = headers[":path"].split("/").pop();
        seen.push({ env, headers, body: JSON.parse(body), token });
        const reply = (status, reason) => {
          stream.respond({ ":status": status, "content-type": "application/json" });
          stream.end(reason ? JSON.stringify({ reason }) : "");
        };
        if (token === TOKEN_DEAD) return reply(410, "Unregistered");
        if (token === TOKEN_SANDBOX && env === "production") return reply(400, "BadDeviceToken");
        if (token !== TOKEN_SANDBOX && env === "sandbox") return reply(400, "BadDeviceToken");
        reply(200);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

before(async () => {
  fakeApple.production = await apple("production");
  fakeApple.sandbox = await apple("sandbox");
  apns._setOrigins({
    production: `http://127.0.0.1:${fakeApple.production.address().port}`,
    sandbox: `http://127.0.0.1:${fakeApple.sandbox.address().port}`,
  });
  db = fakeSupabase({ team_members: [{ email: "member@example.com", name: "M", role: "member", tools: ["studio"], status: "active" }] }, { unique: { push_subscriptions: ["endpoint"] } });
  setSupabase(db);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => {
    req.session.userEmail = req.body.email;
    req.session.userRole = "creator";
    req.session.save(() => res.json({ ok: true }));
  });
  app.use("/api/push", require("../routes/push"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  apns._setOrigins(null);
  fakeApple.production.close();
  fakeApple.sandbox.close();
  server && server.close();
});

function setKey(on) {
  if (on) Object.assign(process.env, { APNS_KEY_ID: "ABC123DEFG", APNS_TEAM_ID: "TEAM123456", APNS_KEY_P8: P8, APNS_BUNDLE_ID: "com.tojcampaign.app" });
  else for (const k of ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_KEY_P8", "APNS_BUNDLE_ID"]) delete process.env[k];
}

test("a send carries a signed provider token, the bundle ID, and only a title, a line and an app link", async () => {
  setKey(true);
  seen = [];
  const r = await apns.deliver({ endpoint: "apns:" + TOKEN_A }, { title: "Draft v2 of Same Work is ready", body: "Open it to review.", url: "/app/#review/k1", tag: "kit-k1" });
  assert.deepEqual(r, { env: "production" });
  const req = seen[0];
  assert.equal(req.headers[":path"], "/3/device/" + TOKEN_A);
  assert.equal(req.headers["apns-topic"], "com.tojcampaign.app");
  assert.equal(req.headers["apns-push-type"], "alert");
  assert.equal(req.headers["apns-collapse-id"], "kit-k1");
  const [h, c, s] = req.headers.authorization.replace(/^bearer /, "").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "ES256", kid: "ABC123DEFG" });
  assert.equal(JSON.parse(Buffer.from(c, "base64url")).iss, "TEAM123456");
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), "ES256 signature checks out");
  assert.deepEqual(req.body, { aps: { alert: { title: "Draft v2 of Same Work is ready", body: "Open it to review." }, sound: "default", "thread-id": "kit-k1" }, url: "/app/#review/k1" });
});

test("links outside the app are replaced with Today; the key also works base64-encoded", async () => {
  setKey(true);
  process.env.APNS_KEY_P8 = Buffer.from(P8).toString("base64");
  seen = [];
  await apns.deliver({ endpoint: "apns:" + TOKEN_A }, { title: "t", body: "b", url: "https://evil.example.com/" });
  assert.equal(seen[0].body.url, "/app/#today");
});

test("a token from a build run straight from Xcode goes to Apple's sandbox, and that's remembered", async () => {
  setKey(true);
  db.tables.push_subscriptions = [{ id: "s1", email: "member@example.com", endpoint: "apns:" + TOKEN_SANDBOX, kind: "apns", apns_env: null, fail_count: 0 }];
  seen = [];
  assert.equal((await P.notify(["member@example.com"], { title: "t", body: "b", url: "/app/#today" })).sent, 1);
  assert.deepEqual(seen.map((s) => s.env), ["production", "sandbox"]);
  assert.equal(db.tables.push_subscriptions[0].apns_env, "sandbox");
  seen = [];
  await P.notify(["member@example.com"], { title: "t", body: "b", url: "/app/#today" });
  assert.deepEqual(seen.map((s) => s.env), ["sandbox"], "goes straight to sandbox next time");
});

test("a dead token is dropped; with no Apple key on the server, devices are kept, not counted as failures", async () => {
  setKey(true);
  db.tables.push_subscriptions = [{ id: "s2", email: "member@example.com", endpoint: "apns:" + TOKEN_DEAD, kind: "apns", fail_count: 0 }];
  await P.notify(["member@example.com"], { title: "t", body: "b", url: "/app/#today" });
  assert.equal(db.tables.push_subscriptions.length, 0);

  setKey(false);
  db.tables.push_subscriptions = [{ id: "s3", email: "member@example.com", endpoint: "apns:" + TOKEN_A, kind: "apns", fail_count: 0 }];
  for (let i = 0; i < 6; i++) await P.notify(["member@example.com"], { title: "t", body: "b", url: "/app/#today" });
  assert.equal(db.tables.push_subscriptions.length, 1);
  assert.equal(db.tables.push_subscriptions[0].fail_count, 0);
});

test("the iPhone app registers its device token under your own email", async () => {
  setKey(false);
  db.tables.push_subscriptions = [];
  let cookie = "";
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const c = r.headers.get("set-cookie");
    if (c) cookie = c.split(";")[0];
    return { status: r.status, json: await r.json() };
  };
  assert.equal((await call("/api/push/subscribe", { apns: { token: TOKEN_A } })).status, 401, "signed out");
  await call("/test-login", { email: "member@example.com" });
  assert.equal((await call("/api/push/subscribe", { apns: { token: "not-hex" } })).status, 400);
  const ok = await call("/api/push/subscribe", { apns: { token: TOKEN_A.toUpperCase() } });
  assert.deepEqual(ok.json, { ok: true, ready: false }, "kept, but the server has no Apple key yet");
  assert.equal(db.tables.push_subscriptions[0].endpoint, "apns:" + TOKEN_A);
  assert.equal(db.tables.push_subscriptions[0].kind, "apns");
  assert.equal(db.tables.push_subscriptions[0].email, "member@example.com");
  setKey(true);
  assert.equal((await call("/api/push/subscribe", { apns: { token: TOKEN_A } })).json.ready, true);
  assert.equal(db.tables.push_subscriptions.length, 1, "the same phone again is one row");
  await call("/api/push/unsubscribe", { endpoint: "apns:" + TOKEN_A });
  assert.equal(db.tables.push_subscriptions.length, 0);
});
