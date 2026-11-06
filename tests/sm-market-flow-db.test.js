// The marketplace end to end against migration 033 in a real Postgres: staff
// set up an event, a guardian answers the QR form and confirms, a crew member
// uploads, the worker makes the preview (ffmpeg stood in), staff confirm and
// approve, a family finds it, pays (Stripe stood in) and downloads. Every
// write meets the database's own rules on the way.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_market_flow_test), which it DROPS and recreates.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = "gfs_market_flow_test";
if (!URL_) {
  test("marketplace end to end (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@toj.test";
process.env.SM_SITE_BASE = "https://www.subjectmedias.com";
process.env.SUPABASE_URL = "https://ckaocyldpvypegwbyahh.supabase.co";
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const express = require("express");
const session = require("express-session");
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { fakeStorage } = require("./helpers/fake-storage");
const { setSupabase } = require("../utils/supabase");
const mailer = require("../utils/mailer");
const push = require("../utils/push");
const S = require("../utils/sm-stripe");
const M = require("../utils/sm-market");
const media = require("../utils/sm-market-media");
const W = require("../utils/sm-market-worker");

let pool, sb, store, server, base, cookie;
const mails = [];
const sessions = new Map();

before(async () => {
  pool = await makeSchema(URL_, SCHEMA, ["019_team.sql", "020_native_push.sql", "033_sm_market.sql"]);
  sb = pgSupabase(pool, SCHEMA);
  store = fakeStorage();
  sb.storage = store;
  setSupabase(sb);
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  push.setSender(async () => ({}));
  S._set({
    mode: "test",
    stripe: {
      checkout: {
        sessions: {
          async create(p) {
            const id = "cs_test_" + crypto.randomBytes(12).toString("hex");
            sessions.set(id, { id, status: "open", payment_status: "unpaid", amount_total: p.line_items.reduce((s, l) => s + l.quantity * l.price_data.unit_amount, 0), metadata: p.metadata, livemode: false });
            return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
          },
          async retrieve(id) { return sessions.get(id); },
        },
      },
    },
  });
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: "flow", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = "staff"; res.json({ ok: true }); });
  app.use("/api/sm/market", require("../routes/sm-market"));
  app.use("/m", require("../routes/sm-market-public"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + "/__test/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "kyron@toj.test" }) });
  cookie = r.headers.get("set-cookie").split(";")[0];
});
after(async () => {
  server && server.close();
  mailer.setSender(null);
  push.setSender(null);
  S._set(null);
  setSupabase(null);
  if (pool) await pool.end();
});

const api = async (method, path, body) => {
  const r = await fetch(base + "/api/sm/market" + path, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json();
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
};
const form = async (path, fields) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, x);
  const r = await fetch(base + path, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  return { status: r.status, location: r.headers.get("location"), html: await r.text() };
};
const page = async (path) => (await fetch(base + path)).text();

test("event, QR answer, upload, review, sale, download: every step within the database's rules", async () => {
  // Staff: the event, a team, the numbers they know.
  const { event: ev } = await api("POST", "/events", { name: "Fall Showcase", sport: "Football", starts_on: "2026-11-21", ends_on: "2026-11-22", city: "Houston", state: "TX" });
  const { team } = await api("POST", `/events/${ev.id}/teams`, { name: "Lightning" });
  await api("POST", `/events/${ev.id}/athletes`, { team_id: team.id, jerseys: "7 11" });
  await api("PATCH", `/events/${ev.id}`, { status: "live" });

  // A guardian at the event: the QR form, then the confirm link from the email.
  const sent = await form(`/m/${ev.code}/consent`, { team_id: team.id, jersey: "7", level: "sell", age: "16_17", email: "Dana@Example.com", who: "guardian" });
  assert.equal(sent.status, 303, sent.html.slice(0, 300));
  const confirm = mails.at(-1).text.match(/\/m\/confirm\/([A-Za-z0-9_-]{43})/)[1];
  const done = await form(`/m/confirm/${confirm}`, {});
  assert.equal(done.status, 200);
  assert.match(done.html, /\/m\/f\/[A-Za-z0-9_-]{43}/);
  // Another guardian, for #11, keeps them out: it counts at once.
  await form(`/m/${ev.code}/consent`, { team_id: team.id, jersey: "11", level: "out", age: "u13", email: "sam@example.com" });
  // A number the crew hadn't entered, from the form.
  await form(`/m/${ev.code}/consent`, { team_id: team.id, jersey: "4", level: "family", age: "u13", email: "jo@example.com", who: "guardian" });
  const levels = Object.fromEntries((await api("GET", `/events/${ev.id}`)).athletes.map((a) => [a.jersey, a.level]));
  assert.deepEqual(levels, { 4: "none", 7: "sell", 11: "out" });

  // A crew member uploads a clip; the worker makes its preview and suggests #7.
  const [up] = (await api("POST", `/events/${ev.id}/uploads`, { files: [{ filename: "C0042.MP4", bytes: 4096 }] })).uploads;
  store.put(M.BUCKET, up.key, Buffer.alloc(4096, 3));
  const { media: m } = await api("POST", `/events/${ev.id}/media`, { key: up.key, filename: "C0042.MP4", bytes: 4096 });
  const roster = (await api("GET", `/events/${ev.id}`)).athletes;
  const seven = roster.find((a) => a.jersey === "7");
  const stub = {
    ...media,
    async probe(f) { return { duration_ms: 9000, width: f.includes("preview") ? 854 : 1920, height: f.includes("preview") ? 480 : 1080 }; },
    async preview(src, kind, out) { fs.writeFileSync(out, "P"); },
    async poster(src, kind, out) { fs.writeFileSync(out, "Q"); },
    async frames(src, kind, dir) { fs.writeFileSync(dir + "/f.jpg", "F"); return [dir + "/f.jpg"]; },
  };
  const ran = await W.drain({ sb, media: stub, suggest: async () => '{"numbers":[{"jersey":"7","team":"Lightning","confidence":0.9},{"jersey":"11","team":"Lightning","confidence":0.8}]}', fetch: store.serve, tmp: os.tmpdir() });
  assert.equal(ran.processed, 1, JSON.stringify(ran.results));
  let list = (await api("GET", `/events/${ev.id}/media?status=review`)).media;
  assert.equal(list.length, 1);
  assert.equal(list[0].tags.length, 2, "two suggestions");

  // Staff: with #11 (kept out) still in it, it can't go on sale.
  const eleven = roster.find((a) => a.jersey === "11");
  const blocked = await fetch(base + `/api/sm/market/media/${m.id}`, { method: "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ tags: [seven.id, eleven.id], status: "approved", everyone_tagged: true }) });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "kept_out");
  // Only #7 is really in it; approve, having checked everyone who stands out is tagged.
  await api("PATCH", `/media/${m.id}`, { tags: [seven.id] });
  await api("PATCH", `/media/${m.id}`, { status: "approved", everyone_tagged: true });

  // Without the event's access code, the clips page shows only the way in.
  const gate = await page(`/m/${ev.code}?team=${team.id}&jersey=7`);
  assert.ok(!gate.includes(m.id), "no clip without the code");
  assert.match(gate, /Enter the access code/);
  // The family finds it by team and number, with the code, and buys it.
  const found = await page(`/m/${ev.code}?k=${ev.view_key}&team=${team.id}&jersey=7`);
  assert.ok(found.includes(`value="${m.id}"`));
  const out = await form(`/m/${ev.code}/checkout`, { k: ev.view_key, team: team.id, jersey: "7", item: m.id });
  assert.equal(out.status, 303);
  const sid = out.location.split("/").pop();
  const ses = sessions.get(sid);
  Object.assign(ses, { status: "complete", payment_status: "paid", customer_details: { email: "dana@example.com" } });
  const token = ses.metadata.order_token;
  const orderPage = await page(`/m/o/${token}?session_id=${sid}`);
  assert.match(orderPage, /Your downloads/);
  assert.match(orderPage, /\/originals\/[^"]+\.mp4\?t=3600&amp;download=Fall-Showcase-clip-/);
  const orders = await api("GET", `/events/${ev.id}/orders`);
  assert.deepEqual(orders.totals, { paid_orders: 1, paid_cents: 1200 });

  // Sold: it can't be removed, and the database agrees.
  const del = await fetch(base + `/api/sm/market/media/${m.id}`, { method: "DELETE", headers: { Cookie: cookie } });
  assert.equal(del.status, 409);
  const row = (await pool.query(`select status, preview_key, approved_by, everyone_tagged_by from ${SCHEMA}.sm_market_media where id = $1`, [m.id])).rows[0];
  assert.deepEqual(row, { status: "approved", preview_key: M.previewKey(ev.id, m.id, "clip"), approved_by: "kyron@toj.test", everyone_tagged_by: "kyron@toj.test" });
  const tok = (await pool.query(`select count(*)::int as n from ${SCHEMA}.sm_market_orders where token_hash = $1`, [M.hashToken(token)])).rows[0].n;
  assert.equal(tok, 1, "the order is found by its link's hash");
});
