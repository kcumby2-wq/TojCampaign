// Team chat API — rooms and direct messages for the team (migration 026; the
// rules are in utils/chat.js, the screens in public/app/chat.js).
//
//   GET    /api/chat/me                    → your chat name, or that you haven't joined
//   POST   /api/chat/me                    → join (18 or older) or change your name
//   GET    /api/chat                       → your rooms and DMs, with unread counts
//   GET    /api/chat/unread                → the unread total (for the tab)
//   GET    /api/chat/people                → people you can message
//   POST   /api/chat/dm                    → open a DM   { person }
//   GET    /api/chat/stop/:eventId         → a Pylon stop's room (made on first open)
//   POST   /api/chat/rooms                 → make a room (owner, approvers)   { title, people }
//   GET    /api/chat/rooms/:id             → a room: who can read it, its rule, what you can do
//   PATCH  /api/chat/rooms/:id             → rename, add or remove people (owner, approvers)
//   PATCH  /api/chat/rooms/:id/me          → mute or unmute; leave a room you were added to
//   GET    /api/chat/rooms/:id/messages    → messages (?after=<id> | ?before=<id>, &read=1)
//   POST   /api/chat/rooms/:id/messages    → send   { body }
//   PATCH  /api/chat/messages/:id          → edit your message   { body }
//   DELETE /api/chat/messages/:id          → remove your message (the owner can remove any)
//
// Everyone on the team can use it once they've joined. A room you can't read
// answers 404, as if it weren't there. Team emails never leave the server:
// people are an id and the name they chose. Errors are logged with ids only,
// never a message's text.

"use strict";

const express = require("express");
const T = require("../utils/team");
const G = require("../utils/gfs");
const C = require("../utils/chat");
const P = require("../utils/push");
const { getSupabase } = require("../utils/supabase");
const { staffEmails } = require("../utils/staff");

const router = express.Router();
const team = T.requireTeam(null, "viewer");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 50;
const NEWER_MAX = 100;
const ROWS = 1000;
const LOOKING_MS = 20000; // had the room open this recently: no notification
const NOT_SET_UP = { error: "chat_not_set_up", hint: "Apply migration 026 in Supabase." };

// ── Plumbing ─────────────────────────────────────────────────────────────
function sb503(res) {
  return res.status(503).json({ error: "supabase_unavailable" });
}
// The chat tables or functions aren't there yet: migration 026.
function notSetUp(e) {
  if (!e) return false;
  const msg = String(e.message || "");
  return /chat_/.test(msg) && (["42P01", "42883", "PGRST202", "PGRST205"].includes(e.code) || /does not exist|Could not find the/i.test(msg));
}
function fail(res, e, what) {
  const m = e && typeof e.message === "string" ? e.message.trim() : "";
  if (/^chat_[a-z_]+$/.test(m)) return res.status(m === "chat_contact_details" ? 400 : 409).json({ error: m });
  if (e && e.code === "23505" && /chat_people_name_key/.test(m)) return res.status(409).json({ error: "name_taken" });
  if (notSetUp(e)) return res.status(503).json(NOT_SET_UP);
  // A check the app missed: a name or title with contact details in it.
  if (e && e.code === "23514" && /chat_/.test(m)) return res.status(400).json({ error: "chat_contact_details" });
  console.error(`[chat] ${what} failed:`, (e && e.code) || "", m.slice(0, 160));
  return res.status(500).json({ error: `${what}_failed` });
}
async function run(q) {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
// Every row (Supabase returns at most 1,000 a request).
async function all(build) {
  const out = [];
  for (let from = 0; ; from += ROWS) {
    const rows = await run(build().order("id", { ascending: true }).range(from, from + ROWS - 1));
    out.push(...(rows || []));
    if (!rows || rows.length < ROWS) return out;
  }
}
async function inChunks(list, fn, size = 100) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(...((await fn(list.slice(i, i + size))) || []));
  return out;
}
// An insert that may race another one for the same unique key.
async function insertOnce(q) {
  const { error } = await q;
  if (error && error.code !== "23505") throw error;
}
const now = () => new Date().toISOString();
const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));

async function personFor(sb, email) {
  return run(sb.from("chat_people").select("id,email,display_name").eq("email", email).maybeSingle());
}

// Everyone on the team now, by email: the owners on ADMIN_EMAILS and the
// active members, each as an access like utils/team.js accessFor's.
async function teamAccess(sb) {
  const map = new Map();
  let rows;
  try {
    rows = await run(sb.from("team_members").select("email,name,role,tools,regions,status").eq("status", "active"));
  } catch (e) {
    if (!T.missingColumn(e)) throw e;
    rows = await run(sb.from("team_members").select("email,name,role,tools,status").eq("status", "active"));
  }
  for (const m of rows || []) {
    if (!T.ROLE_RANK[m.role] || m.role === "owner") continue;
    map.set(m.email, {
      email: m.email,
      role: m.role,
      tools: Array.isArray(m.tools) ? m.tools : [],
      regions: Array.isArray(m.regions) ? m.regions.filter((r) => T.REGION_KEYS.includes(r)) : [],
      owner: false,
    });
  }
  // Owners: on ADMIN_EMAILS and with a staff account (utils/staff.js), as
  // GET /api/team counts them. A listed address without one isn't an owner.
  const listed = [...staffEmails()];
  if (listed.length) {
    const users = (await run(sb.from("users").select("email,role").in("email", listed))) || [];
    for (const u of users) {
      if (!["staff", "admin"].includes(u.role)) continue;
      map.set(u.email, { email: u.email, role: "owner", tools: Object.keys(T.GRANTABLE_TOOLS), regions: [...T.REGION_KEYS], owner: true });
    }
  }
  return map;
}

// Signed in, on the team, and joined chat.
async function joined(req, res, next) {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const me = await personFor(sb, req.team.email);
    if (!me) return res.status(403).json({ error: "chat_join_first" });
    req.chat = { sb, me };
    next();
  } catch (e) {
    fail(res, e, "chat_access");
  }
}

async function memberOf(sb, roomId, personId) {
  return !!(await run(sb.from("chat_room_members").select("person_id").eq("room_id", roomId).eq("person_id", personId).maybeSingle()));
}
async function ensureMember(sb, roomId, personId, addedBy) {
  if (await memberOf(sb, roomId, personId)) return;
  await insertOnce(sb.from("chat_room_members").insert({ room_id: roomId, person_id: personId, added_by: addedBy }));
}
async function stopEvent(sb, eventId) {
  return run(sb.from("gfs_events").select("id,name,region,city,state,starts_on,ends_on,status").eq("id", eventId).maybeSingle());
}
// The other person in a DM, or null once they've deleted their account.
async function dmOther(sb, room, me) {
  const mem = await run(sb.from("chat_room_members").select("person_id").eq("room_id", room.id));
  const id = (mem || []).map((m) => m.person_id).find((p) => p !== me.id);
  return id ? run(sb.from("chat_people").select("id,email,display_name").eq("id", id).maybeSingle()) : null;
}

// A room the signed-in person can read, or a 404.
async function loadRoom(sb, req, res, me, id = req.params.id) {
  if (!UUID.test(String(id))) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const room = await run(sb.from("chat_rooms").select("*").eq("id", id).maybeSingle());
  if (!room) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const ev = room.kind === "stop" ? await stopEvent(sb, room.event_id) : null;
  const member = room.kind === "topic" || room.kind === "dm" ? await memberOf(sb, room.id, me.id) : false;
  if (!C.canRead(req.team, room, { event: ev, member })) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return { room, ev, member };
}

// Who can read a room now: [{ id, email, name, access }] (people who joined
// chat and are still on the team).
async function audienceOf(sb, room, ev, teamMap) {
  const map = teamMap || (await teamAccess(sb));
  let rows;
  if (room.kind === "topic" || room.kind === "dm") {
    const ids = ((await run(sb.from("chat_room_members").select("person_id").eq("room_id", room.id))) || []).map((m) => m.person_id);
    rows = ids.length ? await inChunks(ids, (part) => run(sb.from("chat_people").select("id,email,display_name").in("id", part))) : [];
  } else {
    rows = await all(() => sb.from("chat_people").select("id,email,display_name"));
  }
  return rows
    .map((p) => ({ id: p.id, email: p.email, name: p.display_name, access: map.get(p.email) || null }))
    .filter((p) => p.access && (room.kind === "topic" || room.kind === "dm" || C.canRead(p.access, room, { event: ev })));
}

async function namesOf(sb, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await inChunks(list, (part) => run(sb.from("chat_people").select("id,display_name").in("id", part)));
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

// Owners and approvers are marked on their messages, so a name alone can't
// stand in for them.
async function rolesOf(sb, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  const out = new Map();
  if (!list.length) return out;
  const rows = await inChunks(list, (part) => run(sb.from("chat_people").select("id,email").in("id", part)));
  const teamMap = await teamAccess(sb);
  for (const p of rows) {
    const a = teamMap.get(p.email);
    if (a && (a.owner || a.role === "approver")) out.set(p.id, C.roleLabel(a));
  }
  return out;
}

function messageView(m, me, names, roles) {
  const removed = !!m.removed_at;
  return {
    id: m.id,
    author: m.author_id ? { id: m.author_id, name: names.get(m.author_id) || "Former teammate", role: (roles && roles.get(m.author_id)) || null } : null,
    mine: !!me && m.author_id === me.id,
    body: removed ? null : m.body,
    removed,
    edited: !!m.edited_at && !removed,
    at: m.created_at,
  };
}

function readBody(req, res) {
  const body = C.cleanBody(req.body && req.body.body);
  if (!body) {
    res.status(400).json({ error: "body_required" });
    return null;
  }
  if (body.length > C.BODY_MAX) {
    res.status(400).json({ error: "body_too_long", max: C.BODY_MAX });
    return null;
  }
  if (C.hasContact(body)) {
    res.status(400).json({ error: "chat_contact_details" });
    return null;
  }
  return body;
}
function readLine(value, max, res, field) {
  const s = C.cleanLine(value, max + 1);
  if (!s) {
    res.status(400).json({ error: `${field}_required` });
    return null;
  }
  if (s.length > max) {
    res.status(400).json({ error: `${field}_too_long`, max });
    return null;
  }
  if (C.hasContact(s)) {
    res.status(400).json({ error: "chat_contact_details" });
    return null;
  }
  return s;
}

// ── Joining ──────────────────────────────────────────────────────────────
router.get("/me", team, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const me = await personFor(sb, req.team.email);
    res.json({ me: me ? { id: me.id, name: me.display_name } : null, suggested_name: C.cleanLine(req.team.name || "", C.NAME_MAX) });
  } catch (e) {
    fail(res, e, "chat_me");
  }
});

// Someone else already goes by this name (any case)?
async function nameTaken(sb, name, myId) {
  const rows = await all(() => sb.from("chat_people").select("id,display_name"));
  const want = name.toLowerCase();
  return rows.some((p) => p.id !== myId && String(p.display_name).toLowerCase() === want);
}
// A youth creator's address on the crew list never joins chat, whatever the
// form says. Before migration 024 there's no list to check.
async function youthCreator(sb, email) {
  const { data, error } = await sb.from("gfs_creators").select("id,tier").eq("email", email);
  if (error) return false;
  return (data || []).some((c) => c.tier === "youth");
}

router.post("/me", team, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const name = readLine(req.body && req.body.name, C.NAME_MAX, res, "name");
  if (!name) return;
  try {
    const me = await personFor(sb, req.team.email);
    if (await nameTaken(sb, name, me ? me.id : null)) return res.status(409).json({ error: "name_taken" });
    if (me) {
      await run(sb.from("chat_people").update({ display_name: name, updated_at: now() }).eq("id", me.id));
      return res.json({ me: { id: me.id, name } });
    }
    // Nobody joins without saying they're 18 or older.
    if (!req.body || req.body.adult !== true) return res.status(400).json({ error: "adult_required" });
    if (await youthCreator(sb, req.team.email)) return res.status(403).json({ error: "adults_only" });
    const { data, error } = await sb.from("chat_people").insert({ email: req.team.email, display_name: name, adult_confirmed_at: now() }).select("id,display_name").single();
    if (error && error.code === "23505") {
      const again = await personFor(sb, req.team.email);
      if (!again) return res.status(409).json({ error: "name_taken" });
      return res.json({ me: { id: again.id, name: again.display_name } });
    }
    if (error) throw error;
    res.status(201).json({ me: { id: data.id, name: data.display_name } });
  } catch (e) {
    fail(res, e, "chat_join");
  }
});

// ── Rooms ────────────────────────────────────────────────────────────────
// All of Pylon and the person's region rooms, made the first time anyone
// needs them.
async function derivedRooms(sb, access) {
  if (!T.can(access, "gfs", "viewer")) return [];
  const want = [{ slug: "all", kind: "all" }, ...G.regionsOf(access).map((r) => ({ slug: C.slugFor("region", r), kind: "region", region: r }))];
  const slugs = want.map((w) => w.slug);
  let have = (await run(sb.from("chat_rooms").select("*").in("slug", slugs))) || [];
  const gone = want.filter((w) => !have.some((h) => h.slug === w.slug));
  if (gone.length) {
    for (const row of gone) await insertOnce(sb.from("chat_rooms").insert(row));
    have = (await run(sb.from("chat_rooms").select("*").in("slug", slugs))) || [];
  }
  return have;
}

async function myRooms(sb, access, me) {
  const derived = await derivedRooms(sb, access);
  const memberIds = ((await run(sb.from("chat_room_members").select("room_id").eq("person_id", me.id))) || []).map((m) => m.room_id);
  const listed = memberIds.length ? await inChunks(memberIds, (part) => run(sb.from("chat_rooms").select("*").in("id", part))) : [];
  // Stops someone has talked about, in the person's regions.
  const events = new Map();
  let stops = [];
  if (T.can(access, "gfs", "viewer")) {
    const rows = (await run(sb.from("chat_rooms").select("*").eq("kind", "stop").gt("last_message_at", "1970-01-01T00:00:00Z"))) || [];
    const evIds = [...new Set(rows.map((r) => r.event_id))];
    const evRows = evIds.length ? await inChunks(evIds, (part) => run(sb.from("gfs_events").select("id,name,region,city,state,starts_on,ends_on,status").in("id", part))) : [];
    evRows.forEach((e) => events.set(e.id, e));
    stops = rows.filter((r) => events.has(r.event_id) && G.canSee(access, events.get(r.event_id).region));
  }
  const seen = new Set();
  const rooms = [...derived, ...listed, ...stops].filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
  if (!rooms.length) return [];
  const ids = rooms.map((r) => r.id);

  const stats = (await run(sb.rpc("chat_room_stats", { p_person: me.id, p_rooms: ids }))) || [];
  const statOf = new Map(stats.map((s) => [s.room_id, s]));
  const reads = await inChunks(ids, (part) => run(sb.from("chat_reads").select("room_id,muted").eq("person_id", me.id).in("room_id", part)));
  const mutedIn = new Set(reads.filter((r) => r.muted).map((r) => r.room_id));

  // Who's in each topic room and DM.
  const pairIds = rooms.filter((r) => r.kind === "dm" || r.kind === "topic").map((r) => r.id);
  const pairs = pairIds.length ? await inChunks(pairIds, (part) => run(sb.from("chat_room_members").select("room_id,person_id").in("room_id", part))) : [];
  const teamMap = await teamAccess(sb);
  const others = pairs.filter((m) => m.person_id !== me.id).map((m) => m.person_id);
  const otherRows = others.length ? await inChunks([...new Set(others)], (part) => run(sb.from("chat_people").select("id,email,display_name").in("id", part))) : [];
  const personOf = new Map(otherRows.map((p) => [p.id, p]));
  const names = await namesOf(sb, stats.map((s) => s.last_author));

  return rooms
    .map((r) => {
      const s = statOf.get(r.id) || {};
      const ev = r.kind === "stop" ? events.get(r.event_id) : null;
      const inRoom = pairs.filter((m) => m.room_id === r.id);
      let other = null;
      if (r.kind === "dm") {
        const o = inRoom.find((m) => m.person_id !== me.id);
        const p = o ? personOf.get(o.person_id) : null;
        other = p ? { name: p.display_name, role: C.roleLabel(teamMap.get(p.email) || null) } : null;
      }
      return {
        id: r.id,
        kind: r.kind,
        title: C.titleOf(r, { ev, other }),
        region: r.region || (ev ? ev.region : null),
        event: ev ? { id: ev.id, starts_on: ev.starts_on, ends_on: ev.ends_on, city: ev.city, state: ev.state, status: ev.status } : null,
        people: r.kind === "topic" ? inRoom.filter((m) => m.person_id === me.id || teamMap.has((personOf.get(m.person_id) || {}).email)).length : null,
        other_role: other ? other.role : r.kind === "dm" ? "Former teammate" : null,
        unread: s.unread || 0,
        muted: mutedIn.has(r.id),
        last: s.last_id
          ? { at: s.last_at, by: s.last_author === me.id ? "You" : s.last_author ? names.get(s.last_author) || "Former teammate" : "Former teammate", text: s.last_removed ? null : s.last_body, removed: !!s.last_removed }
          : null,
        sort: s.last_at || r.created_at,
      };
    })
    .sort((a, b) => String(b.sort).localeCompare(String(a.sort)));
}

router.get("/", team, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const me = await personFor(sb, req.team.email);
    if (!me) return res.json({ me: null, rooms: [], unread_total: 0, can_make_rooms: C.canMakeRooms(req.team) });
    const rooms = await myRooms(sb, req.team, me);
    res.json({
      me: { id: me.id, name: me.display_name },
      rooms,
      unread_total: rooms.reduce((n, r) => n + (r.muted ? 0 : r.unread), 0),
      can_make_rooms: C.canMakeRooms(req.team),
    });
  } catch (e) {
    fail(res, e, "chat_rooms");
  }
});

router.get("/unread", team, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const me = await personFor(sb, req.team.email);
    if (!me) return res.json({ joined: false, unread_total: 0 });
    const rooms = await myRooms(sb, req.team, me);
    res.json({ joined: true, unread_total: rooms.reduce((n, r) => n + (r.muted ? 0 : r.unread), 0) });
  } catch (e) {
    fail(res, e, "chat_unread");
  }
});

router.get("/people", team, joined, async (req, res) => {
  const { sb, me } = req.chat;
  try {
    const teamMap = await teamAccess(sb);
    const rows = await all(() => sb.from("chat_people").select("id,email,display_name"));
    const people = rows
      .filter((p) => p.id !== me.id && teamMap.has(p.email))
      .map((p) => ({ id: p.id, name: p.display_name, role: C.roleLabel(teamMap.get(p.email)) }))
      .sort(byName);
    res.json({ people });
  } catch (e) {
    fail(res, e, "chat_people");
  }
});

router.post("/dm", team, joined, async (req, res) => {
  const { sb, me } = req.chat;
  const otherId = String((req.body && req.body.person) || "").toLowerCase();
  if (!UUID.test(otherId) || otherId === me.id) return res.status(400).json({ error: "person_required" });
  try {
    const other = await run(sb.from("chat_people").select("id,email").eq("id", otherId).maybeSingle());
    if (other && other.id === me.id) return res.status(400).json({ error: "person_required" });
    const teamMap = await teamAccess(sb);
    if (!other || !teamMap.has(other.email)) return res.status(404).json({ error: "person_not_found" });
    const slug = C.slugFor("dm", [me.id, other.id]);
    let room = await run(sb.from("chat_rooms").select("id").eq("slug", slug).maybeSingle());
    if (!room) {
      await insertOnce(sb.from("chat_rooms").insert({ slug, kind: "dm", created_by: me.id }));
      room = await run(sb.from("chat_rooms").select("id").eq("slug", slug).single());
    }
    for (const pid of [me.id, other.id]) await ensureMember(sb, room.id, pid, me.id);
    res.json({ room: { id: room.id } });
  } catch (e) {
    fail(res, e, "chat_dm");
  }
});

router.get("/stop/:eventId", team, joined, async (req, res) => {
  const { sb, me } = req.chat;
  const id = String(req.params.eventId);
  if (!UUID.test(id) || !T.can(req.team, "gfs", "viewer")) return res.status(404).json({ error: "not_found" });
  try {
    const ev = await run(sb.from("gfs_events").select("id,region").eq("id", id).maybeSingle());
    if (!ev || !G.canSee(req.team, ev.region)) return res.status(404).json({ error: "not_found" });
    const slug = C.slugFor("stop", ev.id);
    let room = await run(sb.from("chat_rooms").select("id").eq("slug", slug).maybeSingle());
    if (!room) {
      await insertOnce(sb.from("chat_rooms").insert({ slug, kind: "stop", event_id: ev.id, created_by: me.id }));
      room = await run(sb.from("chat_rooms").select("id").eq("slug", slug).single());
    }
    res.json({ room: { id: room.id } });
  } catch (e) {
    fail(res, e, "chat_stop");
  }
});

// People for a topic room: on the team and joined chat.
async function teamPeopleByIds(sb, ids, teamMap) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (list.some((x) => !UUID.test(x))) return null;
  if (!list.length) return [];
  const rows = await inChunks(list, (part) => run(sb.from("chat_people").select("id,email").in("id", part)));
  const ok = rows.filter((p) => teamMap.has(p.email));
  return ok.length === list.length ? ok : null;
}

router.post("/rooms", team, joined, async (req, res) => {
  const { sb, me } = req.chat;
  if (!C.canMakeRooms(req.team)) return res.status(403).json({ error: "role_too_low", need: "approver" });
  const title = readLine(req.body && req.body.title, C.TITLE_MAX, res, "title");
  if (!title) return;
  const ids = (Array.isArray(req.body.people) ? req.body.people : []).map(String).filter((x) => x !== me.id);
  if (ids.length > C.TOPIC_PEOPLE_MAX) return res.status(400).json({ error: "too_many_people", max: C.TOPIC_PEOPLE_MAX });
  try {
    const teamMap = await teamAccess(sb);
    const people = await teamPeopleByIds(sb, ids, teamMap);
    if (!people) return res.status(400).json({ error: "person_not_found" });
    const room = await run(sb.from("chat_rooms").insert({ slug: C.slugFor("topic"), kind: "topic", title, created_by: me.id }).select("id").single());
    for (const pid of [me.id, ...people.map((p) => p.id)]) await ensureMember(sb, room.id, pid, me.id);
    res.status(201).json({ room: { id: room.id } });
  } catch (e) {
    fail(res, e, "chat_make_room");
  }
});

router.get("/rooms/:id", team, joined, async (req, res) => {
  const { sb, me } = req.chat;
  try {
    const r = await loadRoom(sb, req, res, me);
    if (!r) return;
    const { room, ev } = r;
    const teamMap = await teamAccess(sb);
    const people = await audienceOf(sb, room, ev, teamMap);
    const read = await run(sb.from("chat_reads").select("muted").eq("person_id", me.id).eq("room_id", room.id).maybeSingle());
    const other = room.kind === "dm" ? await dmOther(sb, room, me) : null;
    const otherHere = !!other && teamMap.has(other.email);
    res.json({
      room: {
        id: room.id,
        kind: room.kind,
        title: C.titleOf(room, { ev, other: other ? { name: other.display_name } : null }),
        region: room.region || (ev ? ev.region : null),
        event: ev ? { id: ev.id, name: ev.name, starts_on: ev.starts_on, ends_on: ev.ends_on, city: ev.city, state: ev.state, status: ev.status } : null,
        audience: C.audienceText(room, { ev }),
        rule: C.ruleFor(room, { ev }),
        people: people.map((p) => ({ id: p.id, name: p.name, role: C.roleLabel(p.access), you: p.id === me.id })).sort(byName),
        other_gone: room.kind === "dm" && !otherHere,
        muted: !!(read && read.muted),
        can: {
          post: room.kind !== "dm" || otherHere,
          manage: C.canManage(req.team, room),
          leave: room.kind === "topic",
          remove_any: !!req.team.owner,
        },
      },
    });
  } catch (e) {
    fail(res, e, "chat_room");
  }
});

router.patch("/rooms/:id", team, joined, async (req, res) => {
  const { sb, me } = req.chat;
  try {
    const r = await loadRoom(sb, req, res, me);
    if (!r) return;
    if (!C.canManage(req.team, r.room)) return res.status(403).json({ error: "role_too_low", need: "approver" });
    const b = req.body || {};
    // Everything is checked before anything changes.
    let title = null;
    if (b.title !== undefined) {
      title = readLine(b.title, C.TITLE_MAX, res, "title");
      if (!title) return;
    }
    const teamMap = await teamAccess(sb);
    let adding = [];
    if (b.add !== undefined) {
      const people = await teamPeopleByIds(sb, (Array.isArray(b.add) ? b.add : []).map((x) => String(x).toLowerCase()), teamMap);
      if (!people) return res.status(400).json({ error: "person_not_found" });
      const current = ((await run(sb.from("chat_room_members").select("person_id").eq("room_id", r.room.id))) || []).length;
      adding = people.filter((p) => p.id !== me.id);
      if (current + adding.length > C.TOPIC_PEOPLE_MAX + 1) return res.status(400).json({ error: "too_many_people", max: C.TOPIC_PEOPLE_MAX });
    }
    const removing = b.remove !== undefined ? [...new Set((Array.isArray(b.remove) ? b.remove : []).map((x) => String(x).toLowerCase()))].filter((x) => UUID.test(x)) : [];
    if (title) await run(sb.from("chat_rooms").update({ title }).eq("id", r.room.id));
    for (const p of adding) await ensureMember(sb, r.room.id, p.id, me.id);
    if (removing.length) await run(sb.from("chat_room_members").delete().eq("room_id", r.room.id).in("person_id", removing));
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, "chat_change_room");
  }
});

router.patch("/rooms/:id/me", team, joined, async (req, res) => {
  const { sb, me } = req.chat;
  try {
    const r = await loadRoom(sb, req, res, me);
    if (!r) return;
    const b = req.body || {};
    if (b.leave === true) {
      if (r.room.kind !== "topic") return res.status(400).json({ error: "cant_leave" });
      await run(sb.from("chat_room_members").delete().eq("room_id", r.room.id).eq("person_id", me.id));
      return res.json({ ok: true, left: true });
    }
    if (typeof b.muted !== "boolean") return res.status(400).json({ error: "muted_required" });
    await run(sb.from("chat_reads").upsert({ person_id: me.id, room_id: r.room.id, muted: b.muted }, { onConflict: "person_id,room_id" }));
    res.json({ ok: true, muted: b.muted });
  } catch (e) {
    fail(res, e, "chat_room_me");
  }
});

// ── Messages ─────────────────────────────────────────────────────────────
function idParam(v, zeroOk) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && (n > 0 || (zeroOk && n === 0)) ? n : null;
}

router.get("/rooms/:id/messages", team, joined, async (req, res) => {
  const { sb, me } = req.chat;
  try {
    const r = await loadRoom(sb, req, res, me);
    if (!r) return;
    const cols = "id,room_id,author_id,body,created_at,edited_at,removed_at";
    const after = idParam(req.query.after, true);
    const before = idParam(req.query.before);
    let rows;
    let more = false;
    if (after !== null) {
      rows = (await run(sb.from("chat_messages").select(cols).eq("room_id", r.room.id).gt("id", after).order("id", { ascending: true }).limit(NEWER_MAX))) || [];
      more = rows.length === NEWER_MAX;
    } else {
      let q = sb.from("chat_messages").select(cols).eq("room_id", r.room.id);
      if (before) q = q.lt("id", before);
      rows = ((await run(q.order("id", { ascending: false }).limit(PAGE))) || []).reverse();
      more = rows.length === PAGE;
    }
    const read = await run(sb.from("chat_reads").select("last_read_id").eq("person_id", me.id).eq("room_id", r.room.id).maybeSingle());
    const upto = read ? Number(read.last_read_id) || 0 : 0;
    // The room is open on the person's screen: everything up to the newest
    // message they have is read, and they're looking at it.
    if (req.query.read === "1") {
      const newest = rows.length ? rows[rows.length - 1].id : 0;
      await run(sb.from("chat_reads").upsert({ person_id: me.id, room_id: r.room.id, last_read_id: Math.max(upto, before ? 0 : newest), seen_at: now() }, { onConflict: "person_id,room_id" }));
    }
    const names = await namesOf(sb, rows.map((m) => m.author_id));
    const roles = rows.length ? await rolesOf(sb, rows.map((m) => m.author_id)) : new Map();
    res.json({ messages: rows.map((m) => messageView(m, me, names, roles)), more, read_upto: upto });
  } catch (e) {
    fail(res, e, "chat_messages");
  }
});

// Push to everyone who can read the room, except the sender, anyone who has
// it open right now, and anyone who muted it (unless they're mentioned).
// Notifications carry the room and the sender's name, never the text.
async function notifyRoom(sb, r, me, body) {
  const teamMap = await teamAccess(sb);
  const people = (await audienceOf(sb, r.room, r.ev, teamMap)).filter((p) => p.id !== me.id);
  if (!people.length) return;
  const reads = (await run(sb.from("chat_reads").select("person_id,muted,seen_at").eq("room_id", r.room.id))) || [];
  const readOf = new Map(reads.map((x) => [x.person_id, x]));
  const mentioned = new Set(C.mentionsIn(body, people));
  const cutoff = Date.now() - LOOKING_MS;
  const looking = (p) => {
    const x = readOf.get(p.id);
    return !!(x && x.seen_at && new Date(x.seen_at).getTime() > cutoff);
  };
  const muted = (p) => !!(readOf.get(p.id) || {}).muted;
  const url = "/app/#chat/" + r.room.id;
  const tag = "chat-" + r.room.id;
  if (r.room.kind === "dm") {
    const to = people.filter((p) => !looking(p) && (!muted(p) || mentioned.has(p.id)));
    if (to.length) P.notifySoon(to.map((p) => p.email), { title: me.display_name, body: "Sent you a message", url, tag, renotify: true });
    return;
  }
  const title = C.titleOf(r.room, { ev: r.ev });
  const tagged = people.filter((p) => mentioned.has(p.id) && !looking(p));
  const rest = people.filter((p) => !mentioned.has(p.id) && !muted(p) && !looking(p));
  if (tagged.length) P.notifySoon(tagged.map((p) => p.email), { title, body: me.display_name + " mentioned you", url, tag, renotify: true });
  if (rest.length) P.notifySoon(rest.map((p) => p.email), { title, body: me.display_name + " sent a message", url, tag });
}

router.post("/rooms/:id/messages", team, joined, async (req, res) => {
  const { sb, me } = req.chat;
  try {
    const r = await loadRoom(sb, req, res, me);
    if (!r) return;
    if (r.room.kind === "dm") {
      const other = await dmOther(sb, r.room, me);
      if (!other || !(await teamAccess(sb)).has(other.email)) return res.status(409).json({ error: "chat_dm_gone" });
    }
    const body = readBody(req, res);
    if (!body) return;
    if (C.tooFast(me.id)) return res.status(429).json({ error: "chat_too_fast" });
    const row = await run(sb.from("chat_messages").insert({ room_id: r.room.id, author_id: me.id, body }).select("id,room_id,author_id,body,created_at,edited_at,removed_at").single());
    // Sent. The room's sort time (the database sets it too) and "they're
    // looking at it" are extras: a failure there doesn't fail the send, so
    // a retry can't post it twice. The read mark isn't moved: the room's
    // next check marks read what it fetched.
    try {
      await run(sb.from("chat_rooms").update({ last_message_at: row.created_at || now() }).eq("id", r.room.id));
      await run(sb.from("chat_reads").upsert({ person_id: me.id, room_id: r.room.id, seen_at: now() }, { onConflict: "person_id,room_id" }));
    } catch (e2) {
      console.warn("[chat] after-send update failed for room", r.room.id, (e2 && e2.code) || "");
    }
    const roles = await rolesOf(sb, [me.id]);
    res.status(201).json({ message: messageView(row, me, new Map([[me.id, me.display_name]]), roles) });
    notifyRoom(sb, r, me, body).catch((e) => console.warn("[chat] notify failed for room", r.room.id, (e && e.code) || ""));
  } catch (e) {
    fail(res, e, "chat_send");
  }
});

async function loadMessage(sb, req, res, me) {
  const mid = idParam(req.params.mid);
  const m = mid ? await run(sb.from("chat_messages").select("*").eq("id", mid).maybeSingle()) : null;
  if (!m) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const r = await loadRoom(sb, req, res, me, m.room_id);
  return r ? { m, r } : null;
}

router.patch("/messages/:mid", team, joined, async (req, res) => {
  const { sb, me } = req.chat;
  try {
    const x = await loadMessage(sb, req, res, me);
    if (!x) return;
    if (x.m.author_id !== me.id) return res.status(403).json({ error: "not_yours" });
    if (x.m.removed_at) return res.status(409).json({ error: "chat_message_removed" });
    const body = readBody(req, res);
    if (!body) return;
    const at = now();
    await run(sb.from("chat_messages").update({ body, edited_at: at }).eq("id", x.m.id));
    res.json({ message: messageView({ ...x.m, body, edited_at: at }, me, new Map([[me.id, me.display_name]]), await rolesOf(sb, [me.id])) });
  } catch (e) {
    fail(res, e, "chat_edit");
  }
});

router.delete("/messages/:mid", team, joined, async (req, res) => {
  const { sb, me } = req.chat;
  try {
    const x = await loadMessage(sb, req, res, me);
    if (!x) return;
    if (!C.canRemove(req.team, x.m, me)) return res.status(403).json({ error: "not_yours" });
    if (x.m.removed_at) return res.json({ ok: true });
    await run(sb.from("chat_messages").update({ body: null, removed_at: now(), removed_by: me.id }).eq("id", x.m.id));
    if (x.m.author_id !== me.id) await T.logActivity(req.team.email, "chat_removed_message", null, { kind: x.r.room.kind });
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, "chat_remove");
  }
});

// ── Deleting an account (routes/team.js) ─────────────────────────────────
// Their messages lose their text, then their chat record goes. Before
// migration 026 there's nothing to do.
async function forgetPerson(sb, email) {
  const { data: p, error } = await sb.from("chat_people").select("id").eq("email", email).maybeSingle();
  if (error) {
    if (notSetUp(error)) return;
    throw new Error(error.message);
  }
  if (!p) return;
  const at = now();
  const steps = [
    sb.from("chat_messages").update({ body: null, removed_at: at, removed_by: p.id }).eq("author_id", p.id).is("removed_at", null),
    sb.from("chat_room_members").delete().eq("person_id", p.id),
    sb.from("chat_reads").delete().eq("person_id", p.id),
    sb.from("chat_people").delete().eq("id", p.id),
  ];
  for (const step of steps) {
    const { error: e } = await step;
    if (e) throw new Error(e.message);
  }
}

// Taking someone off the team (routes/team.js): they leave every room they
// were added to, so coming back later doesn't hand them what was said while
// they were gone. Their DMs close on their own (the other side can't send).
async function dropRooms(sb, email) {
  const { data: p, error } = await sb.from("chat_people").select("id").eq("email", email).maybeSingle();
  if (error) {
    if (notSetUp(error)) return;
    throw new Error(error.message);
  }
  if (!p) return;
  const mine = ((await run(sb.from("chat_room_members").select("room_id").eq("person_id", p.id))) || []).map((m) => m.room_id);
  if (!mine.length) return;
  const topics = (await inChunks(mine, (part) => run(sb.from("chat_rooms").select("id,kind").in("id", part)))).filter((r) => r.kind === "topic").map((r) => r.id);
  if (topics.length) await run(sb.from("chat_room_members").delete().eq("person_id", p.id).in("room_id", topics));
}

module.exports = router;
module.exports.forgetPerson = forgetPerson;
module.exports.dropRooms = dropRooms;
