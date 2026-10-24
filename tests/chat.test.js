// Team chat (routes/chat.js, utils/chat.js) against an in-memory Supabase:
// joining, who can read which room, messages and their limits, unread counts,
// DMs, topic rooms, edits and removals, notifications, and deleting an
// account. Made-up people only. Migration 026's own checks run in Postgres in
// tests/chat-db.test.js.
//
//   node --test tests/chat.test.js

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

process.env.ADMIN_EMAILS = "kyron@example.com";
const { fakeSupabase } = require("./helpers/fake-supabase");
const { setSupabase } = require("../utils/supabase");
const T = require("../utils/team");
const C = require("../utils/chat");
const P = require("../utils/push");

let db, server, base;
const ev = {};
const sentPush = [];

// public.chat_room_stats over the fake tables.
function statsRpc(tables, { p_person, p_rooms }) {
  const msgs = tables.chat_messages || [];
  const reads = tables.chat_reads || [];
  const data = (tables.chat_rooms || [])
    .filter((r) => p_rooms.includes(r.id))
    .map((r) => {
      const inRoom = msgs.filter((m) => m.room_id === r.id).sort((a, b) => a.id - b.id);
      const read = reads.find((x) => x.person_id === p_person && x.room_id === r.id);
      const upto = read ? read.last_read_id || 0 : 0;
      const last = inRoom[inRoom.length - 1];
      return {
        room_id: r.id,
        unread: inRoom.filter((m) => !m.removed_at && m.author_id !== p_person && m.id > upto).length,
        last_id: last ? last.id : null,
        last_at: last ? last.created_at : null,
        last_author: last ? last.author_id : null,
        last_body: last && last.body ? last.body.slice(0, 140) : null,
        last_removed: !!(last && last.removed_at),
      };
    });
  return { data, error: null };
}

const MEMBERS = [
  { email: "wes@example.com", name: "Wes West", role: "member", tools: ["gfs"], regions: ["west"], status: "active" },
  { email: "sam@example.com", name: "Sam South", role: "member", tools: ["gfs"], regions: ["south_central"], status: "active" },
  { email: "abby@example.com", name: "Abby Approver", role: "approver", tools: ["gfs", "studio"], regions: [], status: "active" },
  { email: "vic@example.com", name: "Vic Viewer", role: "viewer", tools: ["gfs"], regions: ["west"], status: "active" },
  { email: "stu@example.com", name: "Stu Studio", role: "member", tools: ["studio"], regions: [], status: "active" },
];

before(async () => {
  const today = new Date().toISOString().slice(0, 10);
  ev.west = { id: crypto.randomUUID(), code: "Portland2027", name: "Legacy Tour · Portland", region: "west", city: "Portland", state: "OR", starts_on: today, ends_on: today, status: "planning" };
  ev.south = { id: crypto.randomUUID(), code: "Dallas2027", name: "Legacy Tour · Dallas", region: "south_central", city: "Dallas", state: "TX", starts_on: today, ends_on: today, status: "planning" };
  db = fakeSupabase(
    {
      users: [{ email: "kyron@example.com", hash: "x", role: "admin" }],
      team_members: MEMBERS.map((m) => ({ ...m })),
      gfs_events: [ev.west, ev.south],
      push_subscriptions: ["kyron", "wes", "sam", "abby", "vic", "stu"].map((n) => ({ id: crypto.randomUUID(), email: n + "@example.com", endpoint: "https://push.example.com/" + n, p256dh: "k", auth: "a", kind: "web", fail_count: 0 })),
    },
    { unique: { chat_people: ["email"], chat_rooms: ["slug"] }, rpc: { chat_room_stats: statsRpc }, serial: ["chat_messages"] }
  );
  setSupabase(db);
  P.setSender(async (sub, payload) => {
    sentPush.push({ email: sub.email, payload });
    return {};
  });
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/chat", require("../routes/chat"));
  app.use("/api/team", require("../routes/team"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server && server.close(); P.setSender(null); });
beforeEach(() => { C.resetRate(); });

async function as(email, role) {
  let cookie = "";
  const call = async (path, { method = "GET", body } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  if (email) await call("/test-login", { method: "POST", body: { email, role } });
  return call;
}
const people = {};
async function joinedAs(key, email, role) {
  const c = await as(email, role);
  if (!people[key]) {
    const r = await c("/api/chat/me", { method: "POST", body: { name: key, adult: true } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    people[key] = r.json.me.id;
  }
  return c;
}
async function pushesSoon(n, pred = () => true) {
  for (let i = 0; i < 50; i++) {
    const hits = sentPush.filter(pred);
    if (hits.length >= n) return hits;
    await new Promise((r) => setTimeout(r, 10));
  }
  return sentPush.filter(pred);
}
const roomOf = (list, kind, extra = () => true) => list.json.rooms.find((r) => r.kind === kind && extra(r));
function setMember(email, patch) {
  Object.assign(db.tables.team_members.find((m) => m.email === email), patch);
  T.forget();
}

let kyron, wes, sam, abby, vic, stu;

test("joining: signed in and on the team, 18 or older, a name without contact details", async () => {
  const nobody = await as(null);
  assert.equal((await nobody("/api/chat")).status, 401);
  const stranger = await as("stranger@example.com");
  assert.equal((await stranger("/api/chat")).json.error, "not_on_team");

  const w = await as("wes@example.com");
  const me = await w("/api/chat/me");
  assert.deepEqual(me.json, { me: null, suggested_name: "Wes West" });
  assert.deepEqual((await w("/api/chat")).json.rooms, [], "nothing until they join");
  assert.equal((await w("/api/chat/people")).json.error, "chat_join_first");
  assert.equal((await w("/api/chat/me", { method: "POST", body: { name: "Wes" } })).json.error, "adult_required");
  assert.equal((await w("/api/chat/me", { method: "POST", body: { name: "Wes", adult: "yes" } })).json.error, "adult_required");
  assert.equal((await w("/api/chat/me", { method: "POST", body: { name: "Wes 503-555-0142", adult: true } })).json.error, "chat_contact_details");
  assert.equal((await w("/api/chat/me", { method: "POST", body: { name: "wes@example.com", adult: true } })).json.error, "chat_contact_details");
  assert.equal((await w("/api/chat/me", { method: "POST", body: { name: "x".repeat(41), adult: true } })).json.error, "name_too_long");
  assert.equal((await w("/api/chat/me", { method: "POST", body: { name: "   ", adult: true } })).json.error, "name_required");
  const ok = await w("/api/chat/me", { method: "POST", body: { name: "  Wes \u202e West ", adult: true } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.me.name, "Wes West", "direction overrides and extra spaces go");
  const row = db.tables.chat_people.find((p) => p.email === "wes@example.com");
  assert.ok(row.adult_confirmed_at, "the confirmation is recorded");
  // A second POST renames, and doesn't need the confirmation again.
  assert.equal((await w("/api/chat/me", { method: "POST", body: { name: "Wes" } })).json.me.name, "Wes");
  people.wes = ok.json.me.id;

  kyron = await joinedAs("Kyron", "kyron@example.com", "admin");
  wes = w;
  sam = await joinedAs("Sam", "sam@example.com");
  abby = await joinedAs("Abby", "abby@example.com");
  vic = await joinedAs("Vic", "vic@example.com");
  stu = await joinedAs("Stu", "stu@example.com");
});

test("rooms follow roles and regions: All of Pylon, your regions, stops you can see", async () => {
  const w = await wes("/api/chat");
  assert.deepEqual(w.json.rooms.map((r) => r.title).sort(), ["All of Pylon", "West region"]);
  const k = await kyron("/api/chat");
  assert.deepEqual(k.json.rooms.filter((r) => r.kind === "region").map((r) => r.region).sort(), ["midwest", "northeast", "south_central", "southeast", "west"]);
  assert.equal((await abby("/api/chat")).json.rooms.filter((r) => r.kind === "region").length, 5, "approvers see every region");
  assert.deepEqual((await stu("/api/chat")).json.rooms, [], "no Pylon events, no Pylon rooms");
  assert.equal(k.json.can_make_rooms, true);
  assert.equal(w.json.can_make_rooms, false);

  const westRoom = roomOf(w, "region");
  const southRoom = roomOf(await sam("/api/chat"), "region");
  assert.equal((await sam(`/api/chat/rooms/${westRoom.id}`)).status, 404, "another region's room isn't there");
  assert.equal((await stu(`/api/chat/rooms/${westRoom.id}`)).status, 404);
  assert.equal((await vic(`/api/chat/rooms/${westRoom.id}`)).status, 200, "a viewer in the region reads it");
  assert.equal((await kyron(`/api/chat/rooms/${southRoom.id}`)).status, 200);

  // A stop's room: made on first open, for the people who can see the event.
  const stop = await wes(`/api/chat/stop/${ev.west.id}`);
  assert.equal(stop.status, 200);
  assert.equal((await wes(`/api/chat/stop/${ev.west.id}`)).json.room.id, stop.json.room.id, "one room per stop");
  assert.equal((await sam(`/api/chat/stop/${ev.west.id}`)).status, 404);
  assert.equal((await stu(`/api/chat/stop/${ev.west.id}`)).status, 404);
  assert.equal((await wes(`/api/chat/stop/not-a-uuid`)).status, 404);
  const info = await vic(`/api/chat/rooms/${stop.json.room.id}`);
  assert.equal(info.json.room.title, "Legacy Tour · Portland");
  assert.match(info.json.room.rule, /viewers included/);
  assert.match(info.json.room.rule, /team and jersey number only/);
  assert.deepEqual(info.json.room.people.map((p) => p.name).sort(), ["Abby", "Kyron", "Vic", "Wes"], "owner, approvers and West's team");
  assert.equal((await sam(`/api/chat/rooms/${stop.json.room.id}`)).status, 404);
  // A stop shows in the list once someone writes in it.
  assert.ok(!roomOf(await wes("/api/chat"), "stop"));
  assert.equal((await wes(`/api/chat/rooms/${stop.json.room.id}/messages`, { method: "POST", body: { body: "Field 3 is short a shooter at noon." } })).status, 201);
  assert.equal(roomOf(await vic("/api/chat"), "stop").title, "Legacy Tour · Portland");
  assert.ok(!roomOf(await sam("/api/chat"), "stop"), "not in another region's list");

  // Changing someone's regions changes their rooms on the next request.
  setMember("wes@example.com", { regions: ["south_central"] });
  assert.equal((await wes(`/api/chat/rooms/${westRoom.id}`)).status, 404);
  assert.equal((await wes(`/api/chat/rooms/${southRoom.id}`)).status, 200);
  setMember("wes@example.com", { regions: ["west"] });
});

test("messages: text only, no email addresses or phone numbers, a length cap, a rate cap", async () => {
  const room = roomOf(await wes("/api/chat"), "region").id;
  const send = (c, body) => c(`/api/chat/rooms/${room}/messages`, { method: "POST", body: { body } });
  for (const bad of ["call me 503-555-0142", "(503) 555 0142", "+44 20 7946 0958", "5035550142", "mom's email is jane.doe@example.org"]) {
    assert.equal((await send(wes, bad)).json.error, "chat_contact_details", bad);
  }
  for (const fine of ["Bulldogs 21-14, #12 and #24 on field 3", "2026-10-24 10-26 at 9:00-10:30", "Footage page https://sportsclippers.com/e/12345678901", "Order 1234567, $1,499"]) {
    assert.equal((await send(wes, fine)).status, 201, fine);
  }
  assert.equal((await send(wes, "   \n\n ")).json.error, "body_required");
  assert.equal((await send(wes, "x".repeat(2001))).json.error, "body_too_long");
  const kept = await send(wes, "line one\n\n\n\nline two\u200b ");
  assert.equal(kept.json.message.body, "line one\n\nline two", "one blank line at most; invisible characters go");
  C.resetRate();
  let last;
  for (let i = 0; i < 21; i++) last = await send(wes, "tick " + i);
  assert.equal(last.status, 429);
  assert.equal(last.json.error, "chat_too_fast");
  C.resetRate();
  // Nobody outside the room can write in it.
  assert.equal((await send(sam, "hi")).status, 404);
  // Viewers can talk.
  assert.equal((await send(vic, "Looks good from here.")).status, 201);
});

test("reading: newest first page, older pages, newer since an id; unread counts and the read mark", async () => {
  const kw = await kyron("/api/chat");
  const all = roomOf(kw, "all").id;
  const before = (await abby("/api/chat")).json.rooms.find((r) => r.id === all).unread;
  for (let i = 0; i < 3; i++) await kyron(`/api/chat/rooms/${all}/messages`, { method: "POST", body: { body: "Update " + i } });
  const list = await abby("/api/chat");
  const r = list.json.rooms.find((x) => x.id === all);
  assert.equal(r.unread, before + 3);
  assert.equal(r.last.by, "Kyron");
  assert.equal(r.last.text, "Update 2");
  assert.ok(list.json.unread_total >= 3);
  // Opening the room with read=1 marks it read.
  const page = await abby(`/api/chat/rooms/${all}/messages?read=1`);
  assert.equal(page.json.messages[page.json.messages.length - 1].body, "Update 2");
  assert.equal(page.json.messages[0].mine, false);
  assert.equal((await abby("/api/chat")).json.rooms.find((x) => x.id === all).unread, 0);
  // Newer since an id, older before one.
  const lastId = page.json.messages[page.json.messages.length - 1].id;
  assert.deepEqual((await abby(`/api/chat/rooms/${all}/messages?after=${lastId}`)).json.messages, []);
  await kyron(`/api/chat/rooms/${all}/messages`, { method: "POST", body: { body: "One more" } });
  assert.deepEqual((await abby(`/api/chat/rooms/${all}/messages?after=${lastId}`)).json.messages.map((m) => m.body), ["One more"]);
  const older = await abby(`/api/chat/rooms/${all}/messages?before=${lastId}`);
  assert.ok(older.json.messages.every((m) => m.id < lastId));
  // Your own messages never count as unread, and a muted room stays out of the total.
  assert.equal((await kyron("/api/chat")).json.rooms.find((x) => x.id === all).unread, 0);
  await abby(`/api/chat/rooms/${all}/me`, { method: "PATCH", body: { muted: true } });
  await kyron(`/api/chat/rooms/${all}/messages`, { method: "POST", body: { body: "Muted?" } });
  const muted = await abby("/api/chat");
  const row = muted.json.rooms.find((x) => x.id === all);
  assert.equal(row.muted, true);
  assert.equal(row.unread, 2);
  assert.equal(muted.json.unread_total, muted.json.rooms.filter((x) => !x.muted).reduce((n, x) => n + x.unread, 0));
  assert.equal((await abby("/api/chat/unread")).json.unread_total, muted.json.unread_total);
  await abby(`/api/chat/rooms/${all}/me`, { method: "PATCH", body: { muted: false } });
  assert.equal((await abby(`/api/chat/rooms/${all}/me`, { method: "PATCH", body: {} })).json.error, "muted_required");
});

test("direct messages: two people on the team; nobody else can read them", async () => {
  const pick = (await wes("/api/chat/people")).json.people;
  assert.deepEqual(pick.map((p) => p.name).sort(), ["Abby", "Kyron", "Sam", "Stu", "Vic"]);
  assert.equal(pick.find((p) => p.name === "Sam").role, "Regional Director");
  assert.equal(pick.find((p) => p.name === "Kyron").role, "Owner");
  assert.equal(pick.find((p) => p.name === "Stu").role, "Member");
  assert.ok(!JSON.stringify(pick).includes("@example.com"), "no emails");
  assert.equal((await wes("/api/chat/dm", { method: "POST", body: { person: people.wes } })).json.error, "person_required", "not yourself");
  assert.equal((await wes("/api/chat/dm", { method: "POST", body: { person: crypto.randomUUID() } })).json.error, "person_not_found");
  const dm = await wes("/api/chat/dm", { method: "POST", body: { person: people.Stu } });
  assert.equal(dm.status, 200);
  assert.equal((await stu("/api/chat/dm", { method: "POST", body: { person: people.wes } })).json.room.id, dm.json.room.id, "the same room from either side");
  assert.equal(db.tables.chat_room_members.filter((m) => m.room_id === dm.json.room.id).length, 2);
  await wes(`/api/chat/rooms/${dm.json.room.id}/messages`, { method: "POST", body: { body: "Got a minute for the recap edit?" } });
  const s = roomOf(await stu("/api/chat"), "dm");
  assert.equal(s.title, "Wes");
  assert.equal(s.other_role, "Regional Director");
  assert.equal(s.unread, 1);
  assert.equal((await sam(`/api/chat/rooms/${dm.json.room.id}`)).status, 404);
  assert.equal((await kyron(`/api/chat/rooms/${dm.json.room.id}`)).status, 404, "not even the owner reads a DM he isn't in");
  // Someone who leaves the team: the DM closes.
  setMember("stu@example.com", { status: "removed" });
  assert.equal((await wes("/api/chat/people")).json.people.some((p) => p.name === "Stu"), false);
  const closed = await wes(`/api/chat/rooms/${dm.json.room.id}`);
  assert.equal(closed.json.room.can.post, false);
  assert.equal(closed.json.room.other_gone, true);
  assert.equal((await wes(`/api/chat/rooms/${dm.json.room.id}/messages`, { method: "POST", body: { body: "hello?" } })).json.error, "chat_dm_gone");
  assert.equal((await wes("/api/chat/dm", { method: "POST", body: { person: people.Stu } })).json.error, "person_not_found");
  setMember("stu@example.com", { status: "active" });
});

test("topic rooms: owners and approvers make them; only the people listed read them", async () => {
  assert.equal((await wes("/api/chat/rooms", { method: "POST", body: { title: "Mine", people: [] } })).status, 403);
  assert.equal((await abby("/api/chat/rooms", { method: "POST", body: { title: "Call 214-555-0199", people: [] } })).json.error, "chat_contact_details");
  assert.equal((await abby("/api/chat/rooms", { method: "POST", body: { title: "3D crew", people: [crypto.randomUUID()] } })).json.error, "person_not_found");
  const made = await abby("/api/chat/rooms", { method: "POST", body: { title: "3D crew · Dallas", people: [people.Sam, people.Stu] } });
  assert.equal(made.status, 201);
  const id = made.json.room.id;
  const info = await sam(`/api/chat/rooms/${id}`);
  assert.equal(info.json.room.title, "3D crew · Dallas");
  assert.deepEqual(info.json.room.people.map((p) => p.name).sort(), ["Abby", "Sam", "Stu"]);
  assert.equal(info.json.room.can.manage, false);
  assert.equal(info.json.room.can.leave, true);
  assert.equal((await wes(`/api/chat/rooms/${id}`)).status, 404);
  assert.equal((await kyron(`/api/chat/rooms/${id}`)).status, 404, "a room is for the people listed");
  assert.equal(roomOf(await stu("/api/chat"), "topic").people, 3);
  // Managing: rename, add, take out. Members can't.
  assert.equal((await sam(`/api/chat/rooms/${id}`, { method: "PATCH", body: { title: "x" } })).status, 403);
  assert.equal((await abby(`/api/chat/rooms/${id}`, { method: "PATCH", body: { title: "3D crew", add: [people.wes], remove: [people.Stu] } })).status, 200);
  assert.equal((await wes(`/api/chat/rooms/${id}`)).json.room.title, "3D crew");
  assert.equal((await stu(`/api/chat/rooms/${id}`)).status, 404);
  // Leaving; and a derived room can't be left.
  assert.equal((await sam(`/api/chat/rooms/${id}/me`, { method: "PATCH", body: { leave: true } })).json.left, true);
  assert.equal((await sam(`/api/chat/rooms/${id}`)).status, 404);
  const region = roomOf(await sam("/api/chat"), "region").id;
  assert.equal((await sam(`/api/chat/rooms/${region}/me`, { method: "PATCH", body: { leave: true } })).json.error, "cant_leave");
  assert.equal((await abby(`/api/chat/rooms/${region}`, { method: "PATCH", body: { title: "x" } })).status, 403, "derived rooms have no name to change");
});

test("edits and removals: your own; the owner can remove anyone's, and it's logged", async () => {
  const room = roomOf(await wes("/api/chat"), "region").id;
  const m = (await wes(`/api/chat/rooms/${room}/messages`, { method: "POST", body: { body: "Wrap at 6" } })).json.message;
  assert.equal((await vic(`/api/chat/messages/${m.id}`, { method: "PATCH", body: { body: "Wrap at 7" } })).json.error, "not_yours");
  assert.equal((await wes(`/api/chat/messages/${m.id}`, { method: "PATCH", body: { body: "text 503-555-0142" } })).json.error, "chat_contact_details");
  const ed = await wes(`/api/chat/messages/${m.id}`, { method: "PATCH", body: { body: "Wrap at 6:30" } });
  assert.equal(ed.json.message.edited, true);
  assert.equal((await vic(`/api/chat/messages/${m.id}`, { method: "DELETE" })).json.error, "not_yours");
  assert.equal((await sam(`/api/chat/messages/${m.id}`, { method: "DELETE" })).status, 404, "can't reach a room you can't read");
  assert.equal((await kyron(`/api/chat/messages/${m.id}`, { method: "DELETE" })).status, 200);
  const shown = (await vic(`/api/chat/rooms/${room}/messages`)).json.messages.find((x) => x.id === m.id);
  assert.deepEqual([shown.removed, shown.body, shown.edited], [true, null, false]);
  assert.equal((await wes(`/api/chat/messages/${m.id}`, { method: "PATCH", body: { body: "back" } })).json.error, "chat_message_removed");
  const log = db.tables.team_activity.find((a) => a.action === "chat_removed_message");
  assert.ok(log && log.actor === "kyron@example.com" && log.subject === null && log.detail.kind === "region", "logged without the room, so a room someone can't read stays unknown to them");
  assert.ok(!JSON.stringify(log).includes("Wrap"), "the log has no message text");
  const own = (await vic(`/api/chat/rooms/${room}/messages`, { method: "POST", body: { body: "oops" } })).json.message;
  assert.equal((await vic(`/api/chat/messages/${own.id}`, { method: "DELETE" })).status, 200);
  assert.equal(db.tables.team_activity.filter((a) => a.action === "chat_removed_message").length, 1, "removing your own isn't logged");
});

test("notifications: the room's people, not the sender, not the muted, never the text", async () => {
  const stop = (await wes(`/api/chat/stop/${ev.west.id}`)).json.room.id;
  await vic(`/api/chat/rooms/${stop}/me`, { method: "PATCH", body: { muted: true } });
  // Abby has the room open right now.
  await abby(`/api/chat/rooms/${stop}/messages?read=1`);
  sentPush.length = 0;
  await wes(`/api/chat/rooms/${stop}/messages`, { method: "POST", body: { body: "Secret plan: #12 Bulldogs interview at 2" } });
  const got = await pushesSoon(1);
  await new Promise((r) => setTimeout(r, 50));
  const to = sentPush.map((p) => p.email).sort();
  assert.deepEqual(to, ["kyron@example.com"], "Abby is looking, Vic muted it, Wes sent it, Sam and Stu can't read it");
  assert.equal(got[0].payload.title, "Legacy Tour · Portland");
  assert.equal(got[0].payload.body, "Wes sent a message");
  assert.equal(got[0].payload.url, `/app/#chat/${stop}`);
  assert.ok(!JSON.stringify(sentPush).includes("Secret"), "no message text in a notification");
  // A mention reaches someone who muted the room.
  sentPush.length = 0;
  await wes(`/api/chat/rooms/${stop}/messages`, { method: "POST", body: { body: "@Vic can you check the end zone angle?" } });
  await pushesSoon(2);
  await new Promise((r) => setTimeout(r, 50));
  const vicPush = sentPush.find((p) => p.email === "vic@example.com");
  assert.ok(vicPush, "mentioned, so notified while muted");
  assert.equal(vicPush.payload.body, "Wes mentioned you");
  // DMs.
  sentPush.length = 0;
  const dm = (await sam("/api/chat/dm", { method: "POST", body: { person: people.Kyron } })).json.room.id;
  await sam(`/api/chat/rooms/${dm}/messages`, { method: "POST", body: { body: "Dallas roster is in." } });
  const d = await pushesSoon(1);
  assert.equal(d[0].email, "kyron@example.com");
  assert.deepEqual([d[0].payload.title, d[0].payload.body], ["Sam", "Sent you a message"]);
});

test("mentions: whole names, longest first", () => {
  const ppl = [{ id: "a", name: "Ana" }, { id: "b", name: "Ana Lopez" }, { id: "c", name: "Ben" }];
  assert.deepEqual(C.mentionsIn("hey @Ana Lopez", ppl), ["b"]);
  assert.deepEqual(C.mentionsIn("@ana and @BEN!", ppl).sort(), ["a", "c"]);
  assert.deepEqual(C.mentionsIn("mail@Ana.com @Anatole", ppl), [], "inside a word isn't a mention");
});

test("no team emails in what chat sends back", async () => {
  const room = roomOf(await wes("/api/chat"), "region").id;
  for (const path of ["/api/chat", `/api/chat/rooms/${room}`, `/api/chat/rooms/${room}/messages`, "/api/chat/people", "/api/chat/me"]) {
    const r = await wes(path);
    assert.equal(r.status, 200, path);
    assert.ok(!/@example\.com/.test(r.text), path + " leaks an email");
  }
});

test("deleting your account: your messages lose their text and your chat record goes", async () => {
  const room = roomOf(await vic("/api/chat"), "region").id;
  const m = (await vic(`/api/chat/rooms/${room}/messages`, { method: "POST", body: { body: "Vic was here" } })).json.message;
  db.tables.users.push({ email: "vic@example.com", hash: "x", role: "creator" });
  const del = await vic("/api/team/me", { method: "DELETE", body: { confirm: true } });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.ok(!db.tables.chat_people.some((p) => p.email === "vic@example.com"));
  const row = db.tables.chat_messages.find((x) => x.id === m.id);
  assert.equal(row.body, null);
  assert.ok(row.removed_at);
  assert.ok(!db.tables.chat_messages.some((x) => x.body && x.body.includes("Vic was here")));
  const seen = (await wes(`/api/chat/rooms/${room}/messages`)).json.messages.find((x) => x.id === m.id);
  assert.deepEqual([seen.removed, seen.body, seen.author.name], [true, null, "Former teammate"]);
});

test("names are unique whatever the case, and a youth creator's address can't join", async () => {
  const sam2 = await as("sam@example.com");
  assert.equal((await sam2("/api/chat/me", { method: "POST", body: { name: "KYRON" } })).json.error, "name_taken");
  assert.equal((await sam2("/api/chat/me", { method: "POST", body: { name: "Sam" } })).status, 200, "your own name is fine");
  db.tables.team_members.push({ email: "teen@example.com", name: "Teen Shooter", role: "viewer", tools: ["gfs"], regions: ["west"], status: "active" });
  db.tables.gfs_creators = [{ id: crypto.randomUUID(), code: "TEEN1", name: "Teen Shooter", email: "teen@example.com", tier: "youth" }];
  T.forget();
  const teen = await as("teen@example.com");
  assert.equal((await teen("/api/chat/me", { method: "POST", body: { name: "Teen", adult: true } })).json.error, "adults_only");
  assert.ok(!db.tables.chat_people.some((p) => p.email === "teen@example.com"));
});

test("someone taken off the team and invited back isn't handed the rooms they were in", async () => {
  const made = await abby("/api/chat/rooms", { method: "POST", body: { title: "Edit bay", people: [people.Stu] } });
  const id = made.json.room.id;
  assert.equal((await stu(`/api/chat/rooms/${id}`)).status, 200);
  assert.equal((await kyron("/api/team/members/stu@example.com", { method: "DELETE" })).status, 200);
  await abby(`/api/chat/rooms/${id}/messages`, { method: "POST", body: { body: "Said while Stu was away." } });
  setMember("stu@example.com", { status: "active" });
  assert.equal((await stu(`/api/chat/rooms/${id}`)).status, 404, "back on the team, but not back in the room");
  assert.ok(!(await stu("/api/chat")).json.rooms.some((r) => r.id === id));
});

test("an address on ADMIN_EMAILS without a staff account isn't an owner in chat", async () => {
  const before_ = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "kyron@example.com,ops@example.com";
  db.tables.users.push({ email: "ops@example.com", hash: "x", role: "creator" });
  db.tables.chat_people.push({ id: crypto.randomUUID(), email: "ops@example.com", display_name: "Ops", adult_confirmed_at: new Date().toISOString() });
  db.tables.push_subscriptions.push({ id: crypto.randomUUID(), email: "ops@example.com", endpoint: "https://push.example.com/ops", p256dh: "k", auth: "a", kind: "web", fail_count: 0 });
  try {
    const room = roomOf(await wes("/api/chat"), "region").id;
    assert.ok(!(await wes(`/api/chat/rooms/${room}`)).json.room.people.some((p) => p.name === "Ops"));
    sentPush.length = 0;
    await wes(`/api/chat/rooms/${room}/messages`, { method: "POST", body: { body: "Who gets this?" } });
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(!sentPush.some((p) => p.email === "ops@example.com"));
  } finally {
    process.env.ADMIN_EMAILS = before_;
  }
});

test("DMs never with yourself, whatever the case of the id", async () => {
  assert.equal((await wes("/api/chat/dm", { method: "POST", body: { person: people.wes.toUpperCase() } })).json.error, "person_required");
});

test("owners and approvers are marked on their messages; sending doesn't mark others' messages read", async () => {
  const all = roomOf(await kyron("/api/chat"), "all").id;
  await kyron(`/api/chat/rooms/${all}/messages`, { method: "POST", body: { body: "Owner here." } });
  const page = await wes(`/api/chat/rooms/${all}/messages`);
  const mine = page.json.messages[page.json.messages.length - 1];
  assert.deepEqual([mine.author.name, mine.author.role], ["Kyron", "Owner"]);
  const sams = (await sam(`/api/chat/rooms/${all}/messages`, { method: "POST", body: { body: "Director here." } })).json.message;
  assert.equal(sams.author.role, null, "directors aren't marked");
  // Kyron writes, then Wes sends without having fetched it: it stays unread for Wes.
  await wes(`/api/chat/rooms/${all}/messages?read=1`);
  await kyron(`/api/chat/rooms/${all}/messages`, { method: "POST", body: { body: "Did you see this?" } });
  await wes(`/api/chat/rooms/${all}/messages`, { method: "POST", body: { body: "Replying to something else." } });
  assert.equal((await wes("/api/chat")).json.rooms.find((r) => r.id === all).unread, 1);
});

test("contact details in other forms: Unicode spaces and hyphens, full-width characters, hidden characters, dial links", () => {
  for (const s of ["503\u00a0555\u00a00142", "503\u2011555\u20110142", "503\u2013555\u20130142", "\uff15\uff10\uff13-555-0142", "jane\uff20example.com", "503\u2060555\u20600142", "https://wa.me/15035550142", "call tel:+15035550142", "sms:5035550142"]) {
    assert.equal(C.hasContact(s), true, JSON.stringify(s));
  }
  for (const s of ["https://sportsclippers.com/e/12345678901", "Bulldogs 21-14", "2026\u201310\u201324", "Field 3 at 9:00\u201310:30"]) {
    assert.equal(C.hasContact(s), false, JSON.stringify(s));
  }
  assert.equal(C.cleanBody("a\u2060b\u00adc"), "abc", "hidden characters don't survive");
});
