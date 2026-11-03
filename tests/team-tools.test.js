// The tool shelf: the rules (utils/tools.js) and the routes
// (routes/team-tools.js), in-process on the fake Supabase.
//
//   node --test tests/team-tools.test.js

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.ADMIN_EMAILS = "kyron@toj.test";

const express = require("express");
const session = require("express-session");
const X = require("../utils/tools");
const T = require("../utils/team");
const { setSupabase } = require("../utils/supabase");
const { fakeSupabase } = require("./helpers/fake-supabase");
const shelf = require("../routes/team-tools");

const OWNER = "kyron@toj.test", ANA = "ana@toj.test", DEV = "devin@toj.test", VAL = "val@toj.test";

test("links: https only, no sign-in details, nothing that isn't a link", () => {
  assert.equal(X.cleanUrl("https://claude.ai/artifact/abc"), "https://claude.ai/artifact/abc");
  assert.equal(X.cleanUrl("  https://app.milanote.com/x?y=1 "), "https://app.milanote.com/x?y=1");
  assert.equal(X.cleanUrl("http://example.com"), null);
  assert.equal(X.cleanUrl("javascript:alert(1)"), null);
  assert.equal(X.cleanUrl("data:text/html,hi"), null);
  assert.equal(X.cleanUrl("https://user:pass@example.com"), null);
  assert.equal(X.cleanUrl("https://user@example.com"), null);
  assert.equal(X.cleanUrl("not a link"), null);
  assert.equal(X.cleanUrl("https://x.com/" + "a".repeat(2000)), null);
});

test("a tool's fields: each problem named; a change can touch one field", () => {
  assert.deepEqual(X.toolInput({ name: "", url: "ftp://x", about: "x".repeat(141), audience: "public" }).errors, ["name", "url", "about", "audience"]);
  assert.deepEqual(X.toolInput({ name: "Board", url: "https://app.milanote.com/x", audience: "studio" }).value, { name: "Board", url: "https://app.milanote.com/x", about: null, audience: "studio" });
  assert.deepEqual(X.toolInput({ about: "New note" }, { partial: true }), { errors: [], value: { about: "New note" } });
});

test("who sees a tool: the team, one tool, or owners only", () => {
  const owner = { owner: true, tools: [] }, studio = { owner: false, tools: ["studio"] };
  assert.equal(X.sees(owner, "owners"), true);
  assert.equal(X.sees(studio, "team"), true);
  assert.equal(X.sees(studio, "studio"), true);
  assert.equal(X.sees(studio, "gfs"), false);
  assert.equal(X.sees(studio, "owners"), false);
  assert.equal(X.sees(studio, "nope"), false);
  assert.equal(X.sees(null, "team"), false);
});

let server, base, db;
async function call(method, path, body, cookie) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data, cookie: r.headers.get("set-cookie") };
}
const jar = {};
async function as(email) {
  if (jar[email]) return jar[email];
  const r = await call("POST", "/__test/session", { email, role: email === OWNER ? "staff" : "user" });
  return (jar[email] = r.cookie.split(";")[0]);
}
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "tools-test", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role; res.json({ ok: true }); });
  app.use("/api/team-tools", shelf);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server && server.close(); setSupabase(null); });
beforeEach(() => {
  db = fakeSupabase({
    team_members: [
      { email: ANA, name: "Ana Ruiz", role: "approver", tools: ["studio", "creators", "os", "gfs"], regions: [], status: "active" },
      { email: DEV, name: "Devin Price", role: "member", tools: ["gfs"], regions: ["west"], status: "active" },
      { email: VAL, name: "Val Ortiz", role: "viewer", tools: ["studio"], regions: [], status: "active" },
    ],
    team_tools: [],
    team_activity: [],
  });
  setSupabase(db);
  T.forget();
});

test("only the team opens the shelf; only the owner changes it", async () => {
  assert.equal((await call("GET", "/api/team-tools")).status, 401);
  assert.equal((await call("GET", "/api/team-tools", undefined, await as("stranger@toj.test"))).status, 403);
  assert.equal((await call("POST", "/api/team-tools", { name: "X", url: "https://x.test/a" }, await as(ANA))).status, 403);
  assert.equal((await call("PATCH", "/api/team-tools/11111111-1111-4111-8111-111111111111", { name: "X" }, await as(ANA))).status, 403);
});

test("the owner adds tools by link; each person sees the ones meant for them", async () => {
  const bad = await call("POST", "/api/team-tools", { name: "", url: "http://x.test" }, await as(OWNER));
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.data.fields, ["name", "url"]);
  const add = async (name, url, audience) => call("POST", "/api/team-tools", { name, url, audience }, await as(OWNER));
  assert.equal((await add("Bookings Secret Maker", "https://claude.ai/artifact/VRfi5", "owners")).status, 201);
  assert.equal((await add("Shoot board", "https://app.milanote.com/board", "studio")).status, 201);
  const crew = await add("Crew sheet", "https://docs.google.com/sheet", "team");
  assert.equal(crew.status, 201);
  assert.equal(db.tables.team_activity.length, 3);
  const names = async (who) => (await call("GET", "/api/team-tools", undefined, await as(who))).data.tools.map((t) => t.name);
  assert.deepEqual(await names(VAL), ["Crew sheet", "Shoot board"]);
  assert.deepEqual(await names(DEV), ["Crew sheet"]);
  assert.deepEqual(await names(OWNER), ["Bookings Secret Maker", "Crew sheet", "Shoot board"]);
  // Off the shelf: hidden from the team, kept for the owner to put back.
  const off = await call("PATCH", "/api/team-tools/" + crew.data.tool.id, { archived: true }, await as(OWNER));
  assert.equal(off.data.tool.archived, true);
  assert.deepEqual(await names(DEV), []);
  assert.ok((await call("GET", "/api/team-tools", undefined, await as(OWNER))).data.tools.find((t) => t.name === "Crew sheet").archived);
  assert.equal((await call("PATCH", "/api/team-tools/" + crew.data.tool.id, { url: "javascript:alert(1)" }, await as(OWNER))).status, 400);
  assert.equal((await call("PATCH", "/api/team-tools/" + crew.data.tool.id, {}, await as(OWNER))).status, 400);
  assert.equal((await call("PATCH", "/api/team-tools/not-an-id", { name: "x" }, await as(OWNER))).status, 404);
  const back = await call("PATCH", "/api/team-tools/" + crew.data.tool.id, { archived: false, name: "Crew sheet 2027" }, await as(OWNER));
  assert.deepEqual([back.data.tool.name, back.data.tool.archived], ["Crew sheet 2027", false]);
});

test("before migration 031 the shelf is just empty", async () => {
  setSupabase({ from: () => ({ select: () => ({ order: async () => ({ data: null, error: { code: "42P01", message: 'relation "team_tools" does not exist' } }) }) }) });
  const r = await call("GET", "/api/team-tools", undefined, await as(OWNER));
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { tools: [], set_up: false });
});
