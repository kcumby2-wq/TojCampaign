// The marketplace's staff routes (routes/sm-market.js), in-process on the fake
// Supabase and a fake Storage: who may do what, the roster and consent,
// uploads straight to storage, review and approval, and removal.
//
//   node --test tests/sm-market-routes.test.js

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.ADMIN_EMAILS = "kyron@toj.test";
process.env.SM_SITE_BASE = "https://www.subjectmedias.com";
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const express = require("express");
const session = require("express-session");
const { setSupabase } = require("../utils/supabase");
const { fakeSupabase } = require("./helpers/fake-supabase");
const { fakeStorage } = require("./helpers/fake-storage");
const mailer = require("../utils/mailer");
const T = require("../utils/team");
const M = require("../utils/sm-market");
const router = require("../routes/sm-market");

let server, base, db, store, mails;
const cookies = {};

async function call(method, path, body, who, { form = false } = {}) {
  const headers = {};
  if (who) headers.Cookie = cookies[who];
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json";
    payload = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  }
  const r = await fetch(base + path, { method, headers, body: payload });
  const type = r.headers.get("content-type") || "";
  const data = type.includes("json") ? await r.json() : await r.text();
  return { status: r.status, data, type };
}
const as = {
  kyron: "kyron@toj.test",
  lead: "lead@toj.test",
  crew: "crew@toj.test",
  viewer: "viewer@toj.test",
  pylon: "pylon@toj.test",
  stranger: "someone@else.test",
};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: "sm-market-test", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => {
    req.session.userEmail = req.body.email;
    req.session.userRole = req.body.role || "user";
    res.json({ ok: true });
  });
  app.use("/api/sm/market", router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of Object.entries(as)) {
    const r = await fetch(base + "/__test/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role: k === "kyron" ? "staff" : "user" }) });
    cookies[k] = r.headers.get("set-cookie").split(";")[0];
  }
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
});
after(() => { server && server.close(); mailer.setSender(null); setSupabase(null); });

beforeEach(() => {
  T.forget();
  mails = [];
  const member = (email, role, tools = ["market"]) => ({ email, name: null, role, tools, regions: [], status: "active", joined_at: "2026-11-01T00:00:00Z" });
  db = fakeSupabase(
    {
      team_members: [member(as.lead, "approver"), member(as.crew, "member"), member(as.viewer, "viewer"), member(as.pylon, "approver", ["gfs"])],
    },
    { unique: { sm_market_events: ["code"], sm_market_media: ["object_key"], sm_market_consents: ["family_hash"] } }
  );
  store = fakeStorage();
  db.storage = store;
  setSupabase(db);
});

const goodEvent = (over = {}) => ({ name: "Fall Showcase", sport: "Football", starts_on: "2026-11-21", ends_on: "2026-11-22", venue: "Memorial Stadium", city: "Houston", state: "tx", ...over });
async function newEvent(over) {
  const r = await call("POST", "/api/sm/market/events", goodEvent(over), "lead");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.event;
}
async function newTeam(ev, name = "Lightning") {
  const r = await call("POST", `/api/sm/market/events/${ev.id}/teams`, { name }, "crew");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.team;
}
async function roster(ev, who = "lead") {
  const r = await call("GET", `/api/sm/market/events/${ev.id}`, undefined, who);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const athlete = (data, jersey) => data.athletes.find((a) => a.jersey === jersey);
// A file uploaded and registered, then made ready for review as the worker would.
async function readyItem(ev, { kind = "clip" } = {}) {
  const ext = kind === "clip" ? "mp4" : "jpg";
  const signed = await call("POST", `/api/sm/market/events/${ev.id}/uploads`, { files: [{ filename: `IMG_0042.${ext}`, bytes: 2048 }] }, "crew");
  const up = signed.data.uploads[0];
  store.put(M.BUCKET, up.key, Buffer.alloc(2048, 1));
  const reg = await call("POST", `/api/sm/market/events/${ev.id}/media`, { key: up.key, filename: `IMG_0042.${ext}`, bytes: 2048 }, "crew");
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const row = db.tables.sm_market_media.find((m) => m.id === reg.data.media.id);
  Object.assign(row, { status: "review", preview_key: M.previewKey(ev.id, row.id, kind), poster_key: M.posterKey(ev.id, row.id) });
  store.put(M.BUCKET, row.preview_key, "preview");
  store.put(M.BUCKET, row.poster_key, "poster");
  return row;
}

// ── Who may do what ──────────────────────────────────────────────────────
test("signed out, off the team, or without the Marketplace tool: no way in", async () => {
  assert.equal((await call("GET", "/api/sm/market/events")).status, 401);
  assert.equal((await call("GET", "/api/sm/market/events", undefined, "stranger")).status, 403);
  const pylon = await call("GET", "/api/sm/market/events", undefined, "pylon");
  assert.equal(pylon.status, 403, "an approver on Pylon events only doesn't see the marketplace");
  assert.equal(pylon.data.error, "role_too_low");
  assert.equal((await call("GET", "/api/sm/market/events", undefined, "viewer")).status, 200);
  assert.equal((await call("GET", "/api/sm/market/events", undefined, "kyron")).status, 200, "the owner has every tool");
});

test("viewers look, members add and upload, approvers decide", async () => {
  assert.equal((await call("POST", "/api/sm/market/events", goodEvent(), "crew")).status, 403);
  const ev = await newEvent();
  assert.equal((await call("POST", `/api/sm/market/events/${ev.id}/teams`, { name: "Storm" }, "viewer")).status, 403);
  assert.equal((await call("POST", `/api/sm/market/events/${ev.id}/teams`, { name: "Storm" }, "crew")).status, 200);
  assert.equal((await call("PATCH", `/api/sm/market/events/${ev.id}`, { status: "live" }, "crew")).status, 403);
  assert.equal((await call("PATCH", `/api/sm/market/events/${ev.id}`, { status: "live" }, "lead")).status, 200);
  const view = await roster(ev, "viewer");
  assert.deepEqual(view.can, { edit: false, upload: false });
  assert.deepEqual((await roster(ev, "crew")).can, { edit: false, upload: true });
  assert.deepEqual((await roster(ev, "lead")).can, { edit: true, upload: true });
});

test("every change is JSON only, so another site's form can't make one", async () => {
  const r = await call("POST", "/api/sm/market/events", goodEvent(), "lead", { form: true });
  assert.equal(r.status, 415);
  assert.equal((db.tables.sm_market_events || []).length, 0);
  const ev = await newEvent();
  assert.equal((await call("PATCH", `/api/sm/market/events/${ev.id}`, { status: "closed" }, "lead", { form: true })).status, 415);
  assert.equal(db.tables.sm_market_events[0].status, "draft");
});

// ── Events ───────────────────────────────────────────────────────────────
test("a new event: a readable code, its links, $12 a clip and $8 a photo", async () => {
  const ev = await newEvent();
  assert.match(ev.code, M.CODE);
  assert.equal(ev.state, "TX");
  assert.equal(ev.clip_cents, 1200);
  assert.equal(ev.photo_cents, 800);
  assert.equal(ev.status, "draft");
  assert.equal(ev.created_by, as.lead);
  assert.deepEqual(ev.links, { event: `https://www.subjectmedias.com/m/${ev.code}`, consent: `https://www.subjectmedias.com/m/${ev.code}/consent` });
  const bad = await call("POST", "/api/sm/market/events", goodEvent({ name: "", starts_on: "2026-02-30", state: "ZZ" }), "lead");
  assert.equal(bad.status, 400);
  for (const f of ["name", "starts_on", "state"]) assert.ok(bad.data.fields.includes(f), f);
});

test("a code that's taken is drawn again", async () => {
  const first = await newEvent();
  const real = M.newCode;
  const draws = [first.code, "ZZ9ZZ9"];
  M.newCode = () => draws.shift() || real();
  try {
    const second = await newEvent({ name: "Winter Classic" });
    assert.equal(second.code, "ZZ9ZZ9");
  } finally {
    M.newCode = real;
  }
});

test("dates change against the other date as it stands; prices in cents within limits", async () => {
  const ev = await newEvent();
  const late = await call("PATCH", `/api/sm/market/events/${ev.id}`, { starts_on: "2026-11-25" }, "lead");
  assert.equal(late.status, 400, "a start after the end");
  assert.deepEqual(late.data.fields, ["ends_on"]);
  const long = await call("PATCH", `/api/sm/market/events/${ev.id}`, { ends_on: "2026-12-30" }, "lead");
  assert.equal(long.status, 400, "more than two weeks");
  const price = await call("PATCH", `/api/sm/market/events/${ev.id}`, { clip_cents: 1500, photo_cents: 50 }, "lead");
  assert.equal(price.status, 400);
  assert.deepEqual(price.data.fields, ["photo_cents"]);
  const ok = await call("PATCH", `/api/sm/market/events/${ev.id}`, { clip_cents: 1500, ends_on: "2026-11-23" }, "lead");
  assert.equal(ok.status, 200);
  assert.equal(ok.data.event.clip_cents, 1500);
  assert.equal(ok.data.event.ends_on, "2026-11-23");
  assert.equal((await call("PATCH", `/api/sm/market/events/${ev.id}`, {}, "lead")).data.error, "nothing_to_change");
  assert.equal((await call("PATCH", "/api/sm/market/events/not-an-id", { status: "live" }, "lead")).status, 404);
});

// ── The roster and consent ───────────────────────────────────────────────
test("jersey numbers in one go; repeats and leading zeros fold together", async () => {
  const ev = await newEvent();
  const team = await newTeam(ev);
  const r = await call("POST", `/api/sm/market/events/${ev.id}/athletes`, { team_id: team.id, jerseys: "7, 11 #22; 007" }, "crew");
  assert.deepEqual(r.data, { added: 3, skipped: 0 });
  const again = await call("POST", `/api/sm/market/events/${ev.id}/athletes`, { team_id: team.id, jerseys: ["7", 9] }, "crew");
  assert.deepEqual(again.data, { added: 1, skipped: 1 });
  assert.deepEqual((await roster(ev)).athletes.map((a) => a.jersey), ["7", "9", "11", "22"]);
  const bad = await call("POST", `/api/sm/market/events/${ev.id}/athletes`, { team_id: team.id, jerseys: "7, A1" }, "crew");
  assert.equal(bad.status, 400);
  const other = await newEvent({ name: "Winter Classic" });
  const wrongTeam = await call("POST", `/api/sm/market/events/${other.id}/athletes`, { team_id: team.id, jerseys: "3" }, "crew");
  assert.deepEqual(wrongTeam.data.fields, ["team_id"], "a team from another event can't be used");
  assert.equal((await call("POST", `/api/sm/market/events/${ev.id}/athletes`, { team_id: team.id, jerseys: { toString: 1 } }, "crew")).status, 400);
});

test("each athlete's level: none until a consent counts, keep-out beats everything", async () => {
  const ev = await newEvent();
  const team = await newTeam(ev);
  await call("POST", `/api/sm/market/events/${ev.id}/athletes`, { team_id: team.id, jerseys: "7 11" }, "crew");
  let data = await roster(ev);
  assert.equal(athlete(data, "7").level, "none");
  const seven = athlete(data, "7");
  const r = await call("POST", `/api/sm/market/athletes/${seven.id}/consents`, { email: "Dana@Example.com", level: "sell", under_13: "no" }, "lead");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  data = await roster(ev);
  assert.equal(athlete(data, "7").level, "sell");
  assert.equal(athlete(data, "7").consents[0].email, "dana@example.com", "approvers see who answered");
  const view = await roster(ev, "crew");
  assert.equal(athlete(view, "7").level, "sell");
  assert.ok(!JSON.stringify(view).includes("dana@example.com"), "members see the level, not the address");
  const out = await call("PATCH", `/api/sm/market/athletes/${seven.id}`, { keep_out: true }, "lead");
  assert.equal(out.status, 200);
  assert.equal(athlete(await roster(ev), "7").level, "out");
  assert.equal((await call("PATCH", `/api/sm/market/athletes/${seven.id}`, { keep_out: "yes" }, "lead")).status, 400);
  await call("PATCH", `/api/sm/market/athletes/${seven.id}`, { keep_out: false }, "lead");
  assert.equal(athlete(await roster(ev), "7").level, "sell");
  assert.ok(db.tables.team_activity.some((a) => a.action === "market_keep_out"), "keep-outs are in the activity log");
  assert.ok(!JSON.stringify(db.tables.team_activity).includes("dana@example.com"), "the log carries no guardian's address");
});

test("a consent recorded in person counts at once and emails the guardian their family link", async () => {
  const ev = await newEvent();
  const team = await newTeam(ev);
  await call("POST", `/api/sm/market/events/${ev.id}/athletes`, { team_id: team.id, jerseys: "7" }, "crew");
  const seven = athlete(await roster(ev), "7");
  const r = await call("POST", `/api/sm/market/athletes/${seven.id}/consents`, { email: "dana@example.com", level: "family", under_13: "yes" }, "lead");
  assert.equal(r.status, 200);
  assert.equal(r.data.emailed, true);
  const m = /^https:\/\/www\.subjectmedias\.com\/m\/f\/([A-Za-z0-9_-]{43})$/.exec(r.data.family_link);
  assert.ok(m, r.data.family_link);
  const row = db.tables.sm_market_consents[0];
  assert.equal(row.family_hash, M.hashToken(m[1]), "only the link's hash is kept");
  assert.equal(row.source, "staff");
  assert.equal(row.recorded_by, as.lead);
  assert.ok(row.confirmed_at);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ["dana@example.com"]);
  assert.match(mails[0].subject, /Lightning #7 at Fall Showcase/);
  assert.ok(mails[0].text.includes(r.data.family_link));
  // The same guardian again: one consent, a new link (the old one stops working).
  const again = await call("POST", `/api/sm/market/athletes/${seven.id}/consents`, { email: "dana@example.com", level: "sell", under_13: "yes" }, "lead");
  assert.equal(db.tables.sm_market_consents.length, 1);
  assert.notEqual(again.data.family_link, r.data.family_link);
  assert.equal(athlete(await roster(ev), "7").level, "sell");
});

test("a keep-out recorded in person sends nothing; under 13 is never public; members can't record", async () => {
  const ev = await newEvent();
  const team = await newTeam(ev);
  await call("POST", `/api/sm/market/events/${ev.id}/athletes`, { team_id: team.id, jerseys: "7" }, "crew");
  const seven = athlete(await roster(ev), "7");
  assert.equal((await call("POST", `/api/sm/market/athletes/${seven.id}/consents`, { email: "dana@example.com", level: "out", under_13: "no" }, "crew")).status, 403);
  const kid = await call("POST", `/api/sm/market/athletes/${seven.id}/consents`, { email: "dana@example.com", level: "public", under_13: "yes" }, "lead");
  assert.equal(kid.status, 400);
  assert.deepEqual(kid.data.fields, ["level"]);
  const out = await call("POST", `/api/sm/market/athletes/${seven.id}/consents`, { email: "dana@example.com", level: "out", under_13: "no" }, "lead");
  assert.equal(out.status, 200);
  assert.equal(out.data.family_link, null);
  assert.equal(mails.length, 0);
  assert.equal(athlete(await roster(ev), "7").level, "out");
});

test("removing: a consent; a number nobody answered for; a team with no one on it", async () => {
  const ev = await newEvent();
  const team = await newTeam(ev);
  await call("POST", `/api/sm/market/events/${ev.id}/athletes`, { team_id: team.id, jerseys: "7 70" }, "crew");
  const data = await roster(ev);
  const seven = athlete(data, "7");
  const c = await call("POST", `/api/sm/market/athletes/${seven.id}/consents`, { email: "dana@example.com", level: "out", under_13: "no" }, "lead");
  assert.equal((await call("DELETE", `/api/sm/market/athletes/${seven.id}`, undefined, "lead")).data.error, "has_consent", "a guardian's answer never goes with a typo fix");
  assert.equal((await call("DELETE", `/api/sm/market/athletes/${athlete(data, "70").id}`, undefined, "crew")).status, 403);
  assert.equal((await call("DELETE", `/api/sm/market/athletes/${athlete(data, "70").id}`, undefined, "lead")).status, 200);
  assert.equal((await call("DELETE", `/api/sm/market/teams/${team.id}`, undefined, "lead")).data.error, "team_has_athletes");
  assert.equal((await call("DELETE", `/api/sm/market/consents/${c.data.consent.id}`, undefined, "lead")).status, 200);
  assert.equal(athlete(await roster(ev), "7").level, "none");
  const logged = db.tables.team_activity.find((x) => x.action === "market_consent_removed");
  assert.ok(logged, "removing a family's answer is logged");
  assert.equal(logged.detail.level, "out");
  assert.ok(!JSON.stringify(logged).includes("dana@example.com"), "without their address");
  assert.equal((await call("DELETE", `/api/sm/market/athletes/${seven.id}`, undefined, "lead")).status, 200);
  assert.equal((await call("DELETE", `/api/sm/market/teams/${team.id}`, undefined, "lead")).status, 200);
  assert.equal((await call("DELETE", `/api/sm/market/teams/${team.id}`, undefined, "lead")).status, 404);
});

// ── Uploads ──────────────────────────────────────────────────────────────
test("signed upload links go straight to storage, one per good file", async () => {
  const ev = await newEvent();
  const r = await call("POST", `/api/sm/market/events/${ev.id}/uploads`, { files: [{ filename: "C0042.MP4", bytes: 50e6 }, { filename: "notes.pdf", bytes: 10 }, { filename: "DSC_1.jpg", bytes: 3e9 }, { filename: "DSC_2.JPG", bytes: 4e6 }] }, "crew");
  assert.equal(r.status, 200);
  const [clip, pdf, huge, photo] = r.data.uploads;
  assert.match(clip.key, new RegExp(`^events/${ev.id}/originals/[0-9a-f-]{36}\\.mp4$`));
  assert.equal(clip.kind, "clip");
  assert.equal(clip.content_type, "video/mp4");
  assert.match(clip.signed_url, /^https:\/\/store\.test\/object\/upload\/sign\/sm-market\//);
  assert.equal(pdf.error, "filename");
  assert.equal(huge.error, "bytes", "over 2 GB");
  assert.equal(photo.kind, "photo");
  assert.equal((await call("POST", `/api/sm/market/events/${ev.id}/uploads`, { files: [] }, "crew")).status, 400);
  assert.equal((await call("POST", `/api/sm/market/events/${ev.id}/uploads`, { files: Array.from({ length: 51 }, (_, i) => ({ filename: `${i}.jpg`, bytes: 1 })) }, "crew")).status, 400);
  assert.equal((await call("POST", `/api/sm/market/events/${ev.id}/uploads`, { files: [{ filename: "a.mp4", bytes: 1 }] }, "viewer")).status, 403);
  await call("PATCH", `/api/sm/market/events/${ev.id}`, { status: "closed" }, "lead");
  assert.equal((await call("POST", `/api/sm/market/events/${ev.id}/uploads`, { files: [{ filename: "a.mp4", bytes: 1 }] }, "crew")).data.error, "event_closed");
});

test("a file is registered once it's in storage, at the size storage holds", async () => {
  const ev = await newEvent();
  const other = await newEvent({ name: "Winter Classic" });
  const up = (await call("POST", `/api/sm/market/events/${ev.id}/uploads`, { files: [{ filename: "C0042.MP4", bytes: 9999 }] }, "crew")).data.uploads[0];
  const reg = (body) => call("POST", `/api/sm/market/events/${ev.id}/media`, { key: up.key, filename: "C0042.MP4", bytes: 9999, ...body }, "crew");
  assert.equal((await reg()).data.error, "not_uploaded");
  store.put(M.BUCKET, up.key, Buffer.alloc(4096));
  assert.equal((await call("POST", `/api/sm/market/events/${other.id}/media`, { key: up.key, filename: "C0042.MP4", bytes: 9999 }, "crew")).status, 400, "a key from another event");
  assert.equal((await reg({ filename: "C0042.jpg" })).status, 400, "the name must match the key's type");
  assert.equal((await reg({ key: "events/../../etc/passwd" })).status, 400);
  const r = await reg();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.media.status, "uploaded");
  assert.equal(r.data.media.bytes, 4096);
  assert.equal(r.data.media.uploaded_by, as.crew);
  assert.equal(r.data.media.id, up.key.split("/").pop().split(".")[0], "the file's id is in its key");
  assert.equal((await reg()).data.error, "already_added");
});

// ── Review ───────────────────────────────────────────────────────────────
test("the review list: preview links, tags, and a filter by status", async () => {
  const ev = await newEvent();
  const team = await newTeam(ev);
  await call("POST", `/api/sm/market/events/${ev.id}/athletes`, { team_id: team.id, jerseys: "7" }, "crew");
  const seven = athlete(await roster(ev), "7");
  const item = await readyItem(ev);
  db.tables.sm_market_tags = [{ media_id: item.id, athlete_id: seven.id, event_id: ev.id, source: "ai", confidence: 0.91, confirmed: false }];
  const r = await call("GET", `/api/sm/market/events/${ev.id}/media?status=review`, undefined, "viewer");
  assert.equal(r.status, 200);
  assert.equal(r.data.media.length, 1);
  const m = r.data.media[0];
  assert.match(m.preview_url, /^https:\/\/store\.test\/object\/sign\/sm-market\/events\/.+\/previews\/.+\.mp4/);
  assert.match(m.poster_url, /-poster\.jpg/);
  assert.deepEqual(m.tags, [{ athlete_id: seven.id, source: "ai", confidence: 0.91, confirmed: false }]);
  assert.ok(!("object_key" in m), "the original's key isn't handed out");
  assert.equal((await call("GET", `/api/sm/market/events/${ev.id}/media?status=approved`, undefined, "viewer")).data.media.length, 0);
  assert.equal((await call("GET", `/api/sm/market/events/${ev.id}/media?status=sold`, undefined, "viewer")).status, 400);
  const counts = (await roster(ev)).counts;
  assert.deepEqual(counts, { review: 1 });
});

test("confirming who's in it, then approving: a person decides, the AI only suggests", async () => {
  const ev = await newEvent();
  const team = await newTeam(ev);
  await call("POST", `/api/sm/market/events/${ev.id}/athletes`, { team_id: team.id, jerseys: "7 11" }, "crew");
  const data = await roster(ev);
  const [seven, eleven] = [athlete(data, "7"), athlete(data, "11")];
  const item = await readyItem(ev);
  db.tables.sm_market_tags = [
    { media_id: item.id, athlete_id: seven.id, event_id: ev.id, source: "ai", confidence: 0.91, confirmed: false },
    { media_id: item.id, athlete_id: eleven.id, event_id: ev.id, source: "ai", confidence: 0.55, confirmed: false },
  ];
  const noTag = await call("PATCH", `/api/sm/market/media/${item.id}`, { status: "approved" }, "lead");
  assert.equal(noTag.data.error, "no_confirmed_tag", "nothing is approved before a person says who's in it");
  assert.equal((await call("PATCH", `/api/sm/market/media/${item.id}`, { status: "approved" }, "crew")).status, 403, "members confirm tags, approvers approve");
  const tagged = await call("PATCH", `/api/sm/market/media/${item.id}`, { tags: [seven.id] }, "crew");
  assert.equal(tagged.status, 200, JSON.stringify(tagged.data));
  assert.deepEqual(tagged.data.media.tags.map((t) => [t.athlete_id, t.source, t.confirmed]), [[seven.id, "ai", true]], "the AI's wrong guess goes; the right one is confirmed");
  const tag = db.tables.sm_market_tags[0];
  assert.equal(tag.confirmed_by, as.crew);
  const approved = await call("PATCH", `/api/sm/market/media/${item.id}`, { status: "approved" }, "lead");
  assert.equal(approved.status, 200);
  assert.equal(approved.data.media.status, "approved");
  const row = db.tables.sm_market_media.find((m) => m.id === item.id);
  assert.equal(row.approved_by, as.lead);
  // Nobody confirmed in it any more: back to review.
  await call("PATCH", `/api/sm/market/media/${item.id}`, { tags: [] }, "crew");
  assert.equal(row.status, "review");
  // A tag from another event's roster is refused.
  const other = await newEvent({ name: "Winter Classic" });
  const t2 = await newTeam(other, "Storm");
  await call("POST", `/api/sm/market/events/${other.id}/athletes`, { team_id: t2.id, jerseys: "3" }, "crew");
  const three = athlete(await roster(other), "3");
  assert.deepEqual((await call("PATCH", `/api/sm/market/media/${item.id}`, { tags: [three.id] }, "crew")).data.fields, ["tags"]);
  assert.equal((await call("PATCH", `/api/sm/market/media/${item.id}`, { tags: ["nope"] }, "crew")).status, 400);
  const hidden = await call("PATCH", `/api/sm/market/media/${item.id}`, { status: "hidden" }, "lead");
  assert.equal(hidden.data.media.status, "hidden");
});

test("a review change is checked whole before anything is written", async () => {
  const ev = await newEvent();
  const team = await newTeam(ev);
  await call("POST", `/api/sm/market/events/${ev.id}/athletes`, { team_id: team.id, jerseys: "7 11" }, "crew");
  const data = await roster(ev);
  const [seven, eleven] = [athlete(data, "7"), athlete(data, "11")];
  const item = await readyItem(ev);
  await call("PATCH", `/api/sm/market/media/${item.id}`, { tags: [seven.id], status: "approved" }, "lead");
  assert.equal(item.status, "approved");
  // Emptying who's in it while approving: refused, and nothing changed.
  assert.equal((await call("PATCH", `/api/sm/market/media/${item.id}`, { tags: [], status: "approved" }, "lead")).data.error, "no_confirmed_tag");
  assert.deepEqual(db.tables.sm_market_tags.filter((t) => t.confirmed).map((t) => t.athlete_id), [seven.id]);
  // A status that doesn't exist: refused before the tags change.
  assert.equal((await call("PATCH", `/api/sm/market/media/${item.id}`, { tags: [eleven.id], status: "sold" }, "lead")).status, 400);
  assert.deepEqual(db.tables.sm_market_tags.filter((t) => t.confirmed).map((t) => t.athlete_id), [seven.id]);
  // A member changing who's in an approved item sends it back for an approver to see.
  await call("PATCH", `/api/sm/market/media/${item.id}`, { tags: [seven.id, eleven.id] }, "crew");
  assert.equal(item.status, "review");
  // An approver's change keeps it on sale; the same set again changes nothing.
  await call("PATCH", `/api/sm/market/media/${item.id}`, { status: "approved" }, "lead");
  await call("PATCH", `/api/sm/market/media/${item.id}`, { tags: [eleven.id] }, "lead");
  assert.equal(item.status, "approved");
  await call("PATCH", `/api/sm/market/media/${item.id}`, { tags: [eleven.id] }, "crew");
  assert.equal(item.status, "approved", "saving the same numbers isn't a change");
});

test("a file still processing can't be reviewed; a failed one can be retried", async () => {
  const ev = await newEvent();
  const item = await readyItem(ev);
  Object.assign(item, { status: "processing" });
  assert.equal((await call("PATCH", `/api/sm/market/media/${item.id}`, { tags: [] }, "crew")).data.error, "not_ready");
  assert.equal((await call("POST", `/api/sm/market/media/${item.id}/retry`, {}, "crew")).data.error, "not_failed");
  Object.assign(item, { status: "failed", attempts: 3, error: "preview: Invalid data" });
  const r = await call("POST", `/api/sm/market/media/${item.id}/retry`, {}, "crew");
  assert.equal(r.status, 200);
  assert.equal(item.status, "uploaded");
  assert.equal(item.attempts, 0);
  assert.equal(item.error, null);
});

test("an unsold file can be removed, with its files; a sold one can't; an abandoned checkout doesn't hold it", async () => {
  const ev = await newEvent();
  const item = await readyItem(ev);
  const sold = await readyItem(ev);
  const abandoned = await readyItem(ev);
  const recent = await readyItem(ev);
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  db.tables.sm_market_orders = [
    { id: "o1", event_id: ev.id, status: "paid", amount_cents: 1200, created_at: ago(300) },
    { id: "o2", event_id: ev.id, status: "expired", amount_cents: 1200, created_at: ago(300) },
    { id: "o3", event_id: ev.id, status: "pending", amount_cents: 1200, created_at: ago(200) },
    { id: "o4", event_id: ev.id, status: "pending", amount_cents: 1200, created_at: ago(5) },
  ];
  db.tables.sm_market_order_items = [
    { order_id: "o1", media_id: sold.id, price_cents: 1200 },
    { order_id: "o2", media_id: abandoned.id, price_cents: 1200 },
    { order_id: "o3", media_id: abandoned.id, price_cents: 1200 },
    { order_id: "o4", media_id: recent.id, price_cents: 1200 },
  ];
  assert.equal((await call("DELETE", `/api/sm/market/media/${sold.id}`, undefined, "lead")).data.error, "sold");
  assert.equal((await call("DELETE", `/api/sm/market/media/${recent.id}`, undefined, "lead")).data.error, "in_checkout", "someone is checking out with it right now");
  assert.equal((await call("DELETE", `/api/sm/market/media/${abandoned.id}`, undefined, "lead")).status, 200, "checkouts that ended unpaid don't count as sales");
  assert.ok(!db.tables.sm_market_order_items.some((l) => l.media_id === abandoned.id), "their lines are cleared away");
  // A file whose row never got its preview keys still loses the previews the worker made.
  Object.assign(item, { preview_key: null, poster_key: null, status: "failed" });
  assert.equal((await call("DELETE", `/api/sm/market/media/${item.id}`, undefined, "crew")).status, 403);
  assert.equal((await call("DELETE", `/api/sm/market/media/${item.id}`, undefined, "lead")).status, 200);
  assert.ok(!db.tables.sm_market_media.some((m) => m.id === item.id));
  for (const k of [item.object_key, M.previewKey(ev.id, item.id, "clip"), M.posterKey(ev.id, item.id)]) assert.ok(!store.has(M.BUCKET, k), k);
  assert.ok(store.has(M.BUCKET, sold.object_key));
  assert.ok(db.tables.team_activity.some((a) => a.action === "market_media_removed"));
});

// ── Orders and QR codes ──────────────────────────────────────────────────
test("orders: approvers see them and what's been paid", async () => {
  const ev = await newEvent();
  db.tables.sm_market_orders = [
    { id: "o1", event_id: ev.id, email: "dana@example.com", status: "paid", amount_cents: 2000, mode: "test", paid_at: "2026-11-21T20:00:00Z", created_at: "2026-11-21T19:59:00Z" },
    { id: "o2", event_id: ev.id, email: null, status: "pending", amount_cents: 1200, mode: "test", created_at: "2026-11-21T21:00:00Z" },
  ];
  db.tables.sm_market_order_items = [{ order_id: "o1", media_id: "m1", price_cents: 1200 }, { order_id: "o1", media_id: "m2", price_cents: 800 }];
  assert.equal((await call("GET", `/api/sm/market/events/${ev.id}/orders`, undefined, "crew")).status, 403);
  const r = await call("GET", `/api/sm/market/events/${ev.id}/orders`, undefined, "lead");
  assert.deepEqual(r.data.totals, { paid_orders: 1, paid_cents: 2000 });
  assert.equal(r.data.orders.find((o) => o.id === "o1").items, 2);
  assert.ok(!("token_hash" in r.data.orders[0]));
});

test("the QR codes: the event page and the consent page, as SVG", async () => {
  const ev = await newEvent();
  const r = await call("GET", `/api/sm/market/events/${ev.id}/qr/consent.svg`, undefined, "viewer");
  assert.equal(r.status, 200);
  assert.match(r.type, /image\/svg\+xml/);
  assert.match(r.data, /^<svg/);
  assert.equal((await call("GET", `/api/sm/market/events/${ev.id}/qr/event.svg`, undefined, "viewer")).status, 200);
  assert.equal((await call("GET", `/api/sm/market/events/${ev.id}/qr/other.svg`, undefined, "viewer")).status, 404);
});

test("before migration 033: a plain 'not set up', not a crash", async () => {
  const broken = fakeSupabase({ team_members: [] });
  broken.from = (name) => {
    if (name === "team_members") return fakeSupabase({}).from(name);
    const q = fakeSupabase({}).from(name);
    q.then = (res) => Promise.resolve({ data: null, error: { code: "42P01", message: `relation "public.${name}" does not exist` } }).then(res);
    return q;
  };
  setSupabase(broken);
  const r = await call("GET", "/api/sm/market/events", undefined, "kyron");
  assert.equal(r.status, 503);
  assert.equal(r.data.error, "not_set_up");
});
