// Pylon events · QR codes and the public stop page (routes/gfs.js QR routes,
// routes/gfs-page.js, utils/gfs-page.js) against an in-memory Supabase.
// Made-up people and athletes only. Migration 025's checks run in Postgres in
// tests/gfs-qr-db.test.js.
//
//   node --test tests/gfs-qr.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

process.env.ADMIN_EMAILS = "kyron@example.com";
process.env.GFS_PAGE_BASE = "https://pages.example.com";
delete process.env.GFS_HELP_EMAIL;
// The Creator Club's address is TOJ's own; the stop page never falls back to it.
process.env.CREATOR_PAGE_BASE = "https://tojcampaign.com";

const { fakeSupabase } = require("./helpers/fake-supabase");
const { setSupabase } = require("../utils/supabase");
const GP = require("../utils/gfs-page");

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const D = (n) => iso(Date.now() + n * DAY);
const LAST_MONTH = D(-30);

let db, server, base;
let kyron, mw, west, view, ev, evId, otherEv;
const people = {};

// The counter in SQL (gfs_count_hit), over the fake tables.
function hitRpc(tables, { p_event, p_source, p_kind }) {
  const rows = (tables.gfs_qr_hits = tables.gfs_qr_hits || []);
  const day = new Date().toISOString().slice(0, 10);
  const r = rows.find((x) => x.event_id === p_event && x.day === day && x.source === p_source && x.kind === p_kind);
  if (r) r.hits++;
  else rows.push({ event_id: p_event, day, source: p_source, kind: p_kind, hits: 1 });
  return { data: null, error: null };
}
const hits = (kind, source) => (db.tables.gfs_qr_hits || []).filter((x) => x.event_id === evId && x.kind === kind && (!source || x.source === source)).reduce((n, x) => n + x.hits, 0);

before(async () => {
  const screened = { contract_signed_on: LAST_MONTH, background_check_on: LAST_MONTH, safety_training_on: LAST_MONTH, status: "active", lead_scout: false, shadow_events: 0, created_by: "kyron@example.com" };
  const creator = (code, name, tier, extra) => ({ id: crypto.randomUUID(), code, name, region: "midwest", tier, ...screened, ...extra });
  people.ana = creator("ANA01", "Ana Lopez", "adult", { sportsclippers_url: "https://sportsclippers.com/ana-films" });
  people.ben = creator("BEN01", "Ben Okafor", "adult", {});
  people.yuri = creator("YURI1", "Yuri Kim", "youth", {});
  people.paula = creator("PAUL1", "Paula Reyes", "adult", { sportsclippers_url: "https://sportsclippers.com/paula", status: "paused" });
  people.otto = creator("OTTO1", "Otto Vance", "adult", { sportsclippers_url: "https://sportsclippers.com/otto" });
  db = fakeSupabase(
    {
      users: [{ email: "kyron@example.com", hash: "x", role: "admin" }],
      team_members: [
        { email: "mw@example.com", name: "Midwest Director", role: "member", tools: ["gfs"], regions: ["midwest"], status: "active" },
        { email: "west@example.com", name: "West Director", role: "member", tools: ["gfs"], regions: ["west"], status: "active" },
        { email: "viewer@example.com", name: "Vi", role: "viewer", tools: ["gfs"], regions: ["midwest"], status: "active" },
      ],
      gfs_creators: Object.values(people),
    },
    { unique: { gfs_events: ["code"], gfs_creators: ["code"] }, rpc: { gfs_count_hit: hitRpc } }
  );
  setSupabase(db);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/gfs", require("../routes/gfs"));
  app.use("/e", require("../routes/gfs-page"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server && server.close(); });

function client(ip) {
  let cookie = "";
  return async (path, { method = "GET", body, redirect = "follow" } = {}) => {
    const r = await fetch(base + path, { method, redirect, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), "x-forwarded-for": ip || "203.0.113.9" }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get("set-cookie");
    if (c) cookie = c.split(";")[0];
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString("utf8");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, buf, headers: r.headers };
  };
}
async function as(email, role) {
  const c = client();
  await c("/test-login", { method: "POST", body: { email, role } });
  return c;
}
const patch = (c, path, body) => c(path, { method: "PATCH", body });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const visitor = client("198.51.100.20");
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
// TOJ's names and marks, which never go on a Pylon surface.
const TOJ_MARKS = /Subject Media|Subject Report|Trail of Joy|\bTOJ\b|tojcampaign|Kyron/i;

test("link rules: SportsClippers only, numbers families can text, placement keys", () => {
  assert.deepEqual(GP.sportsClippersUrl("https://sportsclippers.com/pylon/mecca-2027"), { url: "https://sportsclippers.com/pylon/mecca-2027" });
  assert.deepEqual(GP.sportsClippersUrl("https://WWW.SportsClippers.com/Pylon?x=1"), { url: "https://www.sportsclippers.com/Pylon?x=1" });
  assert.deepEqual(GP.sportsClippersUrl(""), { url: null }, "blank clears it");
  for (const bad of ["http://sportsclippers.com/x", "https://sportsclippers.com.evil.example/x", "https://evilsportsclippers.com/x", "https://user@sportsclippers.com/x", "https://sportsclippers.com:8443/x", "javascript:alert(1)", "sportsclippers.com/x", "https://example.com/?u=https://sportsclippers.com"]) {
    assert.ok(GP.sportsClippersUrl(bad).error, bad);
  }
  assert.deepEqual(GP.phone("(555) 234-5678"), { phone: "+15552345678" });
  assert.deepEqual(GP.phone("1-555-234-5678"), { phone: "+15552345678" });
  assert.deepEqual(GP.phone("+44 20 7946 0958"), { phone: "+442079460958" });
  assert.ok(GP.phone("555-1234").error);
  assert.equal(GP.phoneWords("+15552345678"), "(555) 234-5678");
  assert.equal(GP.placementKey("Field 3 Sign"), "field-3-sign");
  assert.equal(GP.placementKey("  Team tent!! "), "team-tent");
  assert.equal(GP.placementKey("x"), null, "too short");
  assert.equal(GP.placementKey("🏈"), null);
  assert.deepEqual(GP.parseKey("s-field-3-sign"), { kind: "placement", placement: "field-3-sign", source: "s:field-3-sign" });
  assert.deepEqual(GP.parseKey("c-ANA01"), { kind: "creator", creator: "ANA01", source: "c:ANA01" });
  assert.equal(GP.parseKey("c-ana01"), null);
  assert.equal(GP.parseKey("../etc"), null);
  assert.equal(GP.dateSpan({ starts_on: "2027-02-27", ends_on: "2027-02-28" }), "Feb 27–28, 2027");
  assert.equal(GP.dateSpan({ starts_on: "2027-01-30", ends_on: "2027-02-01" }), "Jan 30 – Feb 1, 2027");
  assert.equal(GP.firstName("Ana María Lopez"), "Ana");
  assert.equal(GP.firstName("Lopez, Ana"), "Ana", "a surname-first entry still shows the first name");
  assert.equal(GP.firstName("Dr. Ana Lopez"), "Ana");
  assert.equal(GP.firstName("Coach Ana"), "Ana");
  const t = new URL(GP.tagged("https://sportsclippers.com/pylon?ref=gfs", { code: "LasVegas2027" }, { kind: "placement", placement: "booth" }));
  assert.equal(t.searchParams.get("ref"), "gfs", "SportsClippers' own parameters stay");
  assert.equal(t.searchParams.get("utm_campaign"), "lasvegas2027");
  assert.equal(t.searchParams.get("utm_content"), "s-booth");
  assert.equal(t.searchParams.get("utm_source"), "pylon");
});

test("a director sets the stop page's links; the rules hold and viewers can't", async () => {
  kyron = await as("kyron@example.com", "admin");
  mw = await as("mw@example.com");
  west = await as("west@example.com");
  view = await as("viewer@example.com");
  const r = await kyron("/api/gfs/events", { method: "POST", body: { name: "Legacy Tour · Indianapolis", size: "premier", region: "midwest", city: "Indianapolis", state: "IN", starts_on: D(10), ends_on: D(11) } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ev = r.json.event;
  evId = ev.id;
  const o = await kyron("/api/gfs/events", { method: "POST", body: { name: "Legacy Tour · Seattle", size: "premier", region: "west", city: "Seattle", state: "WA", starts_on: D(12), ends_on: D(13) } });
  otherEv = o.json.event;

  const bad = await patch(mw, `/api/gfs/events/${evId}`, { sportsclippers_url: "https://example.com/footage", help_phone: "12" });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json.fields.sort(), ["help_phone", "sportsclippers_url"]);
  assert.equal((await patch(view, `/api/gfs/events/${evId}`, { sportsclippers_url: "https://sportsclippers.com/x" })).status, 403);
  assert.equal((await patch(west, `/api/gfs/events/${evId}`, { sportsclippers_url: "https://sportsclippers.com/x" })).status, 404, "another region's director can't see it");

  const ok = await patch(mw, `/api/gfs/events/${evId}`, { sportsclippers_url: "https://sportsclippers.com/pylon/indy-2027", help_phone: "(555) 234-5678", qr_sources: ["Field 3 sign", "booth", "Field 3 Sign", "Team tent"] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.event.sportsclippers_url, "https://sportsclippers.com/pylon/indy-2027");
  assert.equal(ok.json.event.help_phone, "+15552345678");
  assert.deepEqual(ok.json.event.qr_sources, ["field-3-sign", "team-tent"], "presets aren't stored; duplicates drop");
  const many = await patch(mw, `/api/gfs/events/${evId}`, { qr_sources: Array.from({ length: 21 }, (_, i) => "spot " + (i + 10)) });
  assert.equal(many.status, 400, "at most 20 placements");
  assert.equal((await patch(mw, `/api/gfs/events/${evId}`, { qr_sources: "booth" })).status, 400, "a list, not a string");
});

test("creators: an adult's own SportsClippers page; a youth creator never gets one", async () => {
  const bad = await patch(mw, `/api/gfs/creators/${people.ben.id}`, { sportsclippers_url: "https://instagram.com/ben" });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json.fields, ["sportsclippers_url"]);
  const youth = await patch(mw, `/api/gfs/creators/${people.yuri.id}`, { sportsclippers_url: "https://sportsclippers.com/yuri" });
  assert.equal(youth.status, 400);
  assert.deepEqual(youth.json.fields, ["youth_no_public_link"]);
  assert.equal((await patch(mw, `/api/gfs/creators/${people.yuri.id}`, { sportsclippers_url: "" })).status, 200, "clearing is fine");
  // Ben's screening is on file, so where his page sends families is Kyron's call.
  const locked = await patch(mw, `/api/gfs/creators/${people.ben.id}`, { sportsclippers_url: "https://sportsclippers.com/someone-else" });
  assert.equal(locked.status, 403);
  assert.equal(locked.json.error, "identity_owner_only");
  assert.equal((await patch(mw, `/api/gfs/creators/${people.ben.id}`, { sportsclippers_url: "", notes: "Saturday only" })).status, 200, "sending the unchanged (empty) link is fine");
  const ok = await patch(kyron, `/api/gfs/creators/${people.ben.id}`, { sportsclippers_url: "https://sportsclippers.com/ben" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.creator.sportsclippers_url, "https://sportsclippers.com/ben");
  assert.equal((await patch(mw, `/api/gfs/creators/${people.ben.id}`, { sportsclippers_url: "https://sportsclippers.com/ben" })).status, 200, "the same link again changes nothing");
  // A director adding a creator who isn't screened yet can set it.
  const fresh = await mw("/api/gfs/creators", { method: "POST", body: { name: "Cara New", region: "midwest", sportsclippers_url: "https://sportsclippers.com/cara" } });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.json));
  assert.equal(fresh.json.creator.sportsclippers_url, "https://sportsclippers.com/cara");
  // Kyron moves Otto (on no crew) to youth: his public link goes with it.
  const moved = await patch(kyron, `/api/gfs/creators/${people.otto.id}`, { tier: "youth" });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.creator.sportsclippers_url, null);
  await patch(kyron, `/api/gfs/creators/${people.otto.id}`, { tier: "adult" });
});

test("the codes: the stop, its placements, and each adult creator with a page; never a youth creator", async () => {
  const crew = (c, role, status) => db.tables.gfs_crew.push({ id: crypto.randomUUID(), event_id: evId, creator_id: c.id, role, status, assigned_by: "mw@example.com" });
  db.tables.gfs_crew = db.tables.gfs_crew || [];
  crew(people.ana, "lead", "confirmed");
  crew(people.ben, "shooter", "invited");
  crew(people.yuri, "shooter", "confirmed");
  crew(people.paula, "photographer", "confirmed");
  crew(people.otto, "story", "removed");
  const d = await mw(`/api/gfs/events/${evId}/qr`);
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const keys = d.json.codes.map((c) => c.key);
  assert.deepEqual(keys, ["stop", "s-booth", "s-wristband", "s-team-packet", "s-field-3-sign", "s-team-tent", "c-ANA01", "c-BEN01"]);
  assert.equal(d.json.codes[0].url, `https://pages.example.com/e/${ev.code}`);
  assert.equal(d.json.codes.find((c) => c.key === "s-booth").url, `https://pages.example.com/e/${ev.code}?s=booth`);
  const ana = d.json.codes.find((c) => c.key === "c-ANA01");
  assert.equal(ana.url, `https://pages.example.com/e/${ev.code}?c=ANA01`);
  assert.equal(ana.first, "Ana");
  assert.deepEqual(d.json.creators_without_link.map((c) => [c.code, c.paused]), [["PAUL1", true]], "paused: no code");
  assert.equal(d.json.youth_on_crew, 1);
  assert.ok(!JSON.stringify(d.json).includes("YURI1"), "a youth creator's code never appears");
  assert.equal(d.json.help.email, GP.HELP_EMAIL_DEFAULT);
  assert.equal(d.json.help.phone, "+15552345678");
  assert.equal((await view(`/api/gfs/events/${evId}/qr`)).status, 200, "viewers can print");
  assert.equal((await west(`/api/gfs/events/${evId}/qr`)).status, 404);

  const png = await mw(`/api/gfs/events/${evId}/qr/s-booth.png?download=1`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.equal(png.buf.subarray(1, 4).toString(), "PNG");
  assert.match(png.headers.get("content-disposition"), new RegExp(`${ev.code}-s-booth\\.png`));
  const svgOut = await mw(`/api/gfs/events/${evId}/qr/c-ANA01.svg`);
  assert.equal(svgOut.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.match(svgOut.text, /^<svg /);
  for (const k of ["c-YURI1", "c-PAUL1", "c-OTTO1", "s-nowhere", "c-NOPE9", "stop.."]) {
    assert.equal((await mw(`/api/gfs/events/${evId}/qr/${k}.svg`)).status, 404, k);
  }
  const card = await mw(`/api/gfs/events/${evId}/qr/c-ANA01/card`);
  assert.equal(card.status, 200);
  assert.match(card.headers.get("content-security-policy"), /script-src 'nonce-/);
  assert.match(card.text, /Filmed by Ana/);
  assert.ok(!card.text.includes("Lopez"), "first name only");
  const sign = await mw(`/api/gfs/events/${evId}/qr/stop/card`);
  assert.match(sign.text, /Find your footage/);
  assert.ok(sign.text.includes(`pages.example.com/e/${ev.code}`));
  for (const html of [card.text, sign.text]) {
    assert.ok(!TOJ_MARKS.test(html), "no TOJ or Subject marks, or TOJ's domain, anywhere on a card");
    assert.match(html, /@page\{size:(letter|4in 6in);margin:0\}/, "printed at the page's own size, with no browser header or footer");
    assert.ok(!/googleapis|gstatic/.test(html), "no font host");
  }
  assert.equal((await mw(`/api/gfs/events/${evId}/qr/stop.SVG`)).headers.get("content-type"), "image/svg+xml; charset=utf-8", "an upper-case extension still gets the SVG");
});

test("the stop page: footage on SportsClippers, the creator, help; nothing about an athlete", async () => {
  // A roster at the stop, so there's athlete data the page could leak.
  db.tables.gfs_roster = [{ id: crypto.randomUUID(), event_id: evId, roster_id: "ST-9001", team: "Indy Elite 14U", jersey: "7", consent_capture: true }];
  const page = await visitor(`/e/${ev.code}?s=booth`);
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /script-src 'none'/);
  assert.ok(!/googleapis|gstatic/.test(csp + page.text), "no font host learns who opened the page");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.text, /noindex/);
  assert.ok(page.text.includes(`href="/e/${ev.code}/go/footage?s=booth"`), "footage goes through the counted link");
  assert.ok(page.text.includes("mailto:support@groundfloorsports.com"));
  assert.ok(page.text.includes("sms:+15552345678"));
  assert.match(page.text, /subject=Takedown%20request/);
  assert.match(textOf(page.text), /Ask for a takedown/);
  const words = textOf(page.text);
  assert.match(words, /Legacy Tour · Indianapolis/);
  for (const leak of ["ST-9001", "Indy Elite", "Ana", "Ben", "Yuri"]) assert.ok(!words.includes(leak), leak);
  assert.ok(!TOJ_MARKS.test(page.text), "no TOJ names, marks or domain anywhere in the page");
  await wait(20);
  assert.equal(hits("scan", "s:booth"), 1, "the scan counts against the booth code");

  const anaPage = await visitor(`/e/${ev.code}?c=ANA01`);
  assert.match(textOf(anaPage.text), /Ana is on the crew/);
  assert.ok(!anaPage.text.includes("Lopez"));
  assert.ok(anaPage.text.includes(`href="/e/${ev.code}/go/creator/ANA01"`));
  assert.ok(anaPage.text.includes(`href="/e/${ev.code}/go/footage?c=ANA01"`));
  // Ben is only invited so far: his code works, and the page shows him once he's confirmed.
  for (const c of ["YURI1", "PAUL1", "OTTO1", "BEN01", "NOPE9", "<script>"]) {
    const p = await visitor(`/e/${ev.code}?c=${encodeURIComponent(c)}`);
    assert.equal(p.status, 200);
    assert.ok(!/is on the crew/.test(p.text), `${c}: no creator section`);
    assert.ok(!p.text.includes("Yuri") && !p.text.includes("Ben") && !p.text.includes("<script>"));
  }
  assert.equal((await mw(`/api/gfs/events/${evId}/qr`)).json.codes.find((c) => c.key === "c-BEN01").on_page, false);
  await wait(20);
  assert.equal(hits("scan", "c:ANA01"), 1);
  assert.equal(hits("scan", "c:YURI1"), 0, "a youth creator's code counts as the stop's");

  const unknown = await visitor("/e/Nowhere2027");
  assert.equal(unknown.status, 404);
  assert.match(unknown.text, /This page isn't here/);
  assert.equal((await visitor("/e/bad%20code")).status, 404);
  // The bare /e/, where media.groundfloorsports.com sends everything else: Pylon's page, no TOJ.
  const bare = await visitor("/e/");
  assert.equal(bare.status, 404);
  assert.match(bare.text, /This page isn't here/);
  assert.ok(!TOJ_MARKS.test(bare.text), "no TOJ names, marks or domain");
  assert.match(bare.headers.get("content-security-policy"), /script-src 'none'/);
});

test("counted links go only to the stored SportsClippers pages, tagged with the stop and the code", async () => {
  const go = await visitor(`/e/${ev.code}/go/footage?s=booth`, { redirect: "manual" });
  assert.equal(go.status, 302);
  const to = new URL(go.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://sportsclippers.com/pylon/indy-2027");
  assert.equal(to.searchParams.get("utm_campaign"), ev.code.toLowerCase());
  assert.equal(to.searchParams.get("utm_content"), "s-booth");
  const cr = await visitor(`/e/${ev.code}/go/creator/ANA01`, { redirect: "manual" });
  assert.equal(cr.status, 302);
  assert.equal(new URL(cr.headers.get("location")).origin + new URL(cr.headers.get("location")).pathname, "https://sportsclippers.com/ana-films");
  assert.equal(new URL(cr.headers.get("location")).searchParams.get("utm_content"), "c-ana01");
  for (const c of ["YURI1", "PAUL1", "OTTO1", "BEN01"]) {
    const back = await visitor(`/e/${ev.code}/go/creator/${c}`, { redirect: "manual" });
    assert.equal(back.headers.get("location"), `/e/${ev.code}`, `${c} goes back to the page`);
  }
  await wait(20);
  assert.equal(hits("footage", "s:booth"), 1);
  assert.equal(hits("creator", "c:ANA01"), 1);
  const d = await mw(`/api/gfs/events/${evId}/qr`);
  assert.deepEqual(d.json.codes.find((c) => c.key === "s-booth").counts, { scan: 1, footage: 1, creator: 0 });
  assert.equal(d.json.totals.creator, 1);

  // No footage link yet: the button isn't there, and the link comes back.
  const none = await visitor(`/e/${otherEv.code}`);
  assert.match(textOf(none.text), /isn't up yet/);
  assert.ok(!none.text.includes("/go/footage"));
  assert.equal((await visitor(`/e/${otherEv.code}/go/footage`, { redirect: "manual" })).headers.get("location"), `/e/${otherEv.code}`);
});

test("a cancelled stop keeps only help; counting is capped per visitor", async () => {
  await patch(kyron, `/api/gfs/events/${otherEv.id}`, { sportsclippers_url: "https://sportsclippers.com/pylon/seattle", status: "cancelled" });
  const p = await visitor(`/e/${otherEv.code}`);
  assert.match(textOf(p.text), /This stop was cancelled/);
  assert.ok(!p.text.includes("/go/footage"));
  assert.equal((await visitor(`/e/${otherEv.code}/go/footage`, { redirect: "manual" })).headers.get("location"), `/e/${otherEv.code}`);

  const loud = client("192.0.2.77");
  const before = hits("scan", "stop");
  for (let i = 0; i < 310; i++) await loud(`/e/${ev.code}`);
  await wait(50);
  assert.equal(hits("scan", "stop") - before, 300, "one address counts at most 300 a minute");
  assert.equal((await loud(`/e/${ev.code}`)).status, 200, "the page itself still opens");
});

test("no codes until there's a Ground Floor Sports or Pylon address to put on them", async () => {
  const run = async (base) => {
    if (base === undefined) delete process.env.GFS_PAGE_BASE;
    else process.env.GFS_PAGE_BASE = base;
    return [await mw(`/api/gfs/events/${evId}/qr`), await mw(`/api/gfs/events/${evId}/qr/stop.png`), await mw(`/api/gfs/events/${evId}/qr/stop/card`)];
  };
  try {
    for (const [base, problem] of [[undefined, "not_set"], ["https://tojcampaign.com", "toj_address"], ["https://www.tojcampaign.com", "toj_address"], ["https://toj-csv-app.onrender.com", "toj_address"], ["http://media.example.com", "not_https"], ["https://media.example.com/e", "not_an_address"]]) {
      const [list, png, card] = await run(base);
      assert.equal(list.status, 200, "links and counts still show");
      assert.equal(list.json.page.address_problem, problem, String(base));
      assert.deepEqual(list.json.codes, []);
      assert.equal(list.json.page.url, null);
      assert.equal(png.status, 503);
      assert.equal(png.json.error, "gfs_qr_no_address");
      assert.equal(card.status, 503);
    }
    const page = await visitor(`/e/${ev.code}`);
    assert.equal(page.status, 200, "the page itself answers on any host, so codes printed later still work");
  } finally {
    process.env.GFS_PAGE_BASE = "https://pages.example.com";
  }
  const [list] = await run("https://pages.example.com");
  assert.equal(list.json.page.address_problem, null);
  assert.equal(list.json.codes[0].url, `https://pages.example.com/e/${ev.code}`);
});
