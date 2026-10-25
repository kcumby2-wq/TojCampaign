// The sign-in cookie is httpOnly, and Secure whenever the request came in over
// HTTPS through the proxy (Render, with Vercel's rewrite in front). Uses the
// same settings server.js does (utils/session-cookie.js).
//
//   node --test tests/session-cookie.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const { sessionCookie, TRUST_PROXY_HOPS, WEEK_MS } = require("../utils/session-cookie");

let server;
let base;

before(async () => {
  const app = express();
  app.set("trust proxy", TRUST_PROXY_HOPS);
  app.use(session({ secret: "test-secret", resave: false, saveUninitialized: false, cookie: sessionCookie() }));
  app.post("/sign-in", (req, res) => {
    req.session.userEmail = "kyron@example.com";
    res.json({ ok: true });
  });
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const cookieFrom = (res) => res.headers.get("set-cookie") || "";

test("over HTTPS through the proxy, the cookie is Secure and httpOnly", async () => {
  const res = await fetch(base + "/sign-in", { method: "POST", headers: { "X-Forwarded-Proto": "https" } });
  const c = cookieFrom(res);
  assert.match(c, /connect\.sid=/, "a session cookie is set");
  assert.match(c, /;\s*Secure/i);
  assert.match(c, /;\s*HttpOnly/i);
  assert.match(c, /Max-Age=604800|Expires=/i, "it lasts a week");
});

test("over plain HTTP (local development), sign-in still works, without the Secure flag", async () => {
  const res = await fetch(base + "/sign-in", { method: "POST" });
  const c = cookieFrom(res);
  assert.match(c, /connect\.sid=/, "a session cookie is still set");
  assert.doesNotMatch(c, /;\s*Secure/i);
  assert.match(c, /;\s*HttpOnly/i);
});

test("the settings are the ones server.js uses", () => {
  assert.deepEqual(sessionCookie(), { maxAge: WEEK_MS, httpOnly: true, secure: "auto" });
  assert.equal(TRUST_PROXY_HOPS, 1);
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /app\.set\("trust proxy", TRUST_PROXY_HOPS\)/);
  assert.match(src, /cookie: sessionCookie\(\)/);
});
