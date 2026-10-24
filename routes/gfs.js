// Ground Floor Sports · Pylon events — the event-media system (the "gfs"
// tool in the TOJ app; rules in utils/gfs.js, enforced again by migration 024).
//
// Who sees what: owners and approvers see every region; a Regional Director
// (member) and a viewer see only the regions on their team record. Viewers
// read; directors plan, crew, load, tag and send work to approval; approvers
// clear what posts on Pylon's channels and what lists on SportsClippers.
//
//   GET    /api/gfs/meta                              regions, sizes, roles, rules          viewer
//   GET    /api/gfs/today                             what needs you, the next event        viewer
//   GET    /api/gfs/desk                              every event's pipeline, at once       viewer
//   GET    /api/gfs/events                            events in your regions                viewer
//   POST   /api/gfs/events                            new event (+ its Schedule C rows)     member
//   GET    /api/gfs/events/:id                        the plan: checklist, crew, deliverables viewer
//   PATCH  /api/gfs/events/:id                        edit, checklist, status               member
//   GET    /api/gfs/events/:id/crew                   crew and who can be crewed            viewer
//   POST   /api/gfs/events/:id/crew                   add a creator to the crew             member
//   PATCH  /api/gfs/events/:id/crew/:cid              confirm, decline, remove, rating      member
//   POST   /api/gfs/events/:id/roster                 load the Sports Thread roster CSV     member
//   GET    /api/gfs/events/:id/roster                 the roster (IDs and flags, no names)  member
//   POST   /api/gfs/events/:id/uploads                load the upload log CSV               member
//   GET    /api/gfs/events/:id/clips                  ?view=unmatched|held|matched|out|all  viewer
//   PATCH  /api/gfs/events/:id/clips/:clipId          tag to a roster row, or not a player  member
//   POST   /api/gfs/events/:id/tags/approve           matched clips → tagged                member
//   POST   /api/gfs/events/:id/clips/edited           tagged → edited                       member
//   POST   /api/gfs/events/:id/clips/approve          edited → approved                     approver
//   POST   /api/gfs/events/:id/clips/delivered        approved → sent to families           member
//   POST   /api/gfs/events/:id/clips/removed          taken off every surface               member
//   GET    /api/gfs/events/:id/families.csv           roster ID → approved clips            member
//   GET    /api/gfs/events/:id/listings.csv           the SportsClippers listing file       approver
//   POST   /api/gfs/events/:id/clips/listed           mark listed (family or public)        approver
//   PATCH  /api/gfs/events/:id/deliverables/:did      counts, late cause, featured          member
//   POST   /api/gfs/events/:id/deliverables/:did/submit    to the approver queue            member
//   POST   /api/gfs/events/:id/deliverables/:did/approve   clear for Pylon's channels       approver
//   POST   /api/gfs/events/:id/deliverables/:did/changes   send back with a note            approver
//   POST   /api/gfs/events/:id/deliverables/:did/done      a non-posting deliverable done   member
//   POST   /api/gfs/events/:id/deliverables/:did/reopen    undo done                        member
//   GET    /api/gfs/creators                          the pool, with credentials            viewer
//   POST   /api/gfs/creators                          add a creator                         member
//   PATCH  /api/gfs/creators/:id                      edit (credentials: owner only)        member
//   GET    /api/gfs/scorecards                        the four measures, this quarter       viewer
//   GET    /api/gfs/takedowns                         open takedowns, soonest first         viewer
//   POST   /api/gfs/takedowns                         log one (the clock starts)            member
//   PATCH  /api/gfs/takedowns/:id                     mark a step done                      member
//
// Nothing here posts, lists or messages anyone: listings and family links go
// out through SportsClippers, posts through Pylon's own channels. Logs and
// notifications carry event codes and counts, never an athlete's identity.

"use strict";

const express = require("express");
const T = require("../utils/team");
const G = require("../utils/gfs");
const P = require("../utils/push");
const { getSupabase } = require("../utils/supabase");
const { staffEmails } = require("../utils/staff");

const router = express.Router();
const viewer = T.requireTeam("gfs", "viewer");
const member = T.requireTeam("gfs", "member");
const approver = T.requireTeam("gfs", "approver");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE = 1000;
const CSV_MAX = 2 * 1024 * 1024;

// ── Plumbing ─────────────────────────────────────────────────────────────
function sb503(res) {
  return res.status(503).json({ error: "supabase_unavailable" });
}
// A rule the database refused (migration 024 raises these by name).
function ruleCode(e) {
  const m = e && typeof e.message === "string" ? e.message.trim() : "";
  return /^(crew|gfs)_[a-z0-9_]+$/.test(m) ? m : null;
}
function fail(res, e, what) {
  const rule = ruleCode(e);
  if (rule) return res.status(409).json({ error: rule });
  if (e && e.code === "23505") return res.status(409).json({ error: "already_exists" });
  // The tables aren't there yet: migration 024 hasn't been applied.
  if (e && (e.code === "42P01" || e.code === "PGRST205" || /relation .*gfs_.* does not exist|Could not find the table/i.test(String(e.message || "")))) {
    return res.status(503).json({ error: "gfs_not_set_up", hint: "Apply migration 024 in Supabase." });
  }
  console.error(`[gfs] ${what} failed:`, e && e.message);
  return res.status(500).json({ error: `${what}_failed` });
}
async function run(q) {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
// Every row of a query, a page at a time (Supabase returns at most 1,000).
async function all(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const rows = await run(build().range(from, from + PAGE - 1));
    out.push(...(rows || []));
    if (!rows || rows.length < PAGE) return out;
  }
}
// .in() over a long list, in URL-sized chunks.
async function inChunks(list, fn, size = 100) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(...((await fn(list.slice(i, i + size))) || []));
  return out;
}
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const isOwner = (req) => !!(req.team && req.team.owner);
const atLeast = (req, role) => T.ROLE_RANK[req.team.role] >= T.ROLE_RANK[role];
const actor = (req) => req.team.email;

async function loadEvent(sb, req, res, id = req.params.id) {
  if (!sb) {
    sb503(res);
    return null;
  }
  if (!UUID.test(String(id))) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const ev = await run(sb.from("gfs_events").select("*").eq("id", id).maybeSingle());
  if (!ev || !G.canSee(req.team, ev.region)) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return ev;
}

// Push to the people who should know about an event: owners, approvers, and
// the directors whose regions include it.
async function regionEmails(region, minRole = "member") {
  const out = new Set(staffEmails());
  const sb = getSupabase();
  if (!sb) return [...out];
  const rows = await run(sb.from("team_members").select("email,role,tools,regions,status").eq("status", "active"));
  for (const m of rows || []) {
    if (!(m.tools || []).includes("gfs") || T.ROLE_RANK[m.role] < T.ROLE_RANK[minRole]) continue;
    if (m.role === "approver" || (m.regions || []).includes(region)) out.add(m.email);
  }
  return [...out];
}
function notify(emailsPromise, payload) {
  P.notifySoon(emailsPromise, payload);
}

// Directors' names for display (team emails stay with owners).
async function namesFor(sb, emails) {
  const list = [...new Set(emails.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await run(sb.from("team_members").select("email,name").in("email", list));
  return new Map((rows || []).map((r) => [r.email, r.name]));
}

// ── Shapes ───────────────────────────────────────────────────────────────
const EVENT_FIELDS = ["id", "code", "name", "series", "size", "region", "city", "state", "venue", "tz", "starts_on", "ends_on", "wraps_at", "ends_at", "status", "crew_target", "clip_price_cents", "storefront_url", "storefront_ready_at", "roster_in_at", "brief_sent_at", "tags_approved_at", "created_at"];
function eventView(ev, req, names) {
  const out = {};
  for (const k of EVENT_FIELDS) out[k] = ev[k] === undefined ? null : ev[k];
  out.wraps_at = String(ev.wraps_at || "18:00").slice(0, 5);
  out.region_name = G.REGIONS[ev.region] || ev.region;
  out.size_name = G.SIZES[ev.size] || ev.size;
  out.days = G.eventDays(ev);
  out.director = ev.director_email ? { name: (names && names.get(ev.director_email)) || null, email: req.team.owner || ev.director_email === req.team.email ? ev.director_email : null, you: ev.director_email === req.team.email } : null;
  return out;
}
function crewView(row, creator, req) {
  return {
    id: row.id,
    role: row.role,
    role_name: G.CREW_ROLES[row.role] || row.role,
    status: row.status,
    note: row.note || null,
    family_rating: row.family_rating == null ? null : Number(row.family_rating),
    rating_count: row.rating_count == null ? null : row.rating_count,
    on_site: G.ON_SITE.includes(row.role),
    creator: creator ? creatorView(creator, req) : null,
  };
}
function creatorView(c, req, ev) {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    email: atLeast(req, "member") ? c.email || null : null,
    region: c.region,
    region_name: G.REGIONS[c.region] || c.region,
    home_city: c.home_city || null,
    tier: c.tier,
    lead_scout: !!c.lead_scout,
    shadow_events: c.shadow_events || 0,
    status: c.status,
    contract_signed_on: c.contract_signed_on || null,
    background_check_on: c.background_check_on || null,
    safety_training_on: c.safety_training_on || null,
    notes: atLeast(req, "member") ? c.notes || null : null,
    badges: G.credentialBadges(c, ev),
  };
}
function checklist(ev, crew) {
  const start = G.zonedToUtc(ev.starts_on, "00:00", ev.tz).getTime();
  const at = (h) => new Date(start - h * 3600000).toISOString();
  const onSite = crew.filter((c) => c.status === "confirmed" && G.ON_SITE.includes(c.role));
  const lead = onSite.some((c) => c.role === "lead");
  const crewDone = onSite.length >= ev.crew_target && (lead || ev.crew_target === 0);
  return [
    { key: "storefront", label: "QR code and storefront page", due_at: at(7 * 24), done: !!ev.storefront_ready_at, done_at: ev.storefront_ready_at || null },
    { key: "roster", label: "Roster and consent from Sports Thread", due_at: at(72), done: !!ev.roster_in_at, done_at: ev.roster_in_at || null },
    { key: "brief", label: "Crew brief sent", due_at: at(48), done: !!ev.brief_sent_at, done_at: ev.brief_sent_at || null },
    { key: "crew", label: `Crew ${onSite.length} of ${ev.crew_target} confirmed on site${ev.crew_target && !lead ? ", no lead yet" : ""}`, due_at: at(48), done: crewDone, done_at: null, confirmed: onSite.length, target: ev.crew_target, lead },
  ];
}
function deliverableView(d, ev) {
  const info = G.deliverableInfo(d.kind) || {};
  const nowMs = Date.now();
  const met = d.delivered >= d.required;
  const cleared = d.publishes ? d.approved_count >= d.required && d.required > 0 : d.status === "done";
  const late = d.required === 0 ? false : d.delivered_at ? new Date(d.delivered_at) > new Date(d.due_at) : !met && new Date(d.due_at).getTime() < nowMs;
  return {
    id: d.id,
    kind: d.kind,
    day: d.day,
    name: info.name ? (d.day ? `${info.name} · day ${d.day}` : info.name) : d.kind,
    group: info.group || null,
    note: info.note || null,
    required: d.required,
    delivered: d.delivered,
    approved_count: d.approved_count,
    to_submit: d.publishes ? Math.max(0, d.delivered - d.approved_count) : 0,
    due_at: d.due_at,
    delivered_at: d.delivered_at || null,
    late,
    late_cause: d.late_cause || null,
    publishes: d.publishes,
    featured_needed: !!info.featured,
    featured: d.featured || [],
    status: d.status,
    cleared,
    submitted_at: d.submitted_at || null,
    decided_at: d.decided_at || null,
    note_from_approver: d.status === "changes" ? d.note || null : null,
    note: d.note || null,
  };
}

// Pipeline counts: the SQL function, or the same counts from the clips.
async function eventCounts(sb, ids) {
  const out = new Map(ids.map((id) => [id, { shot: 0, matched: 0, unmatched: 0, not_a_player: 0, tagged: 0, edited: 0, approved: 0, delivered: 0, listed: 0, held: 0, needs_removal: 0 }]));
  if (!ids.length) return out;
  const { data, error } = await sb.rpc("gfs_event_counts", { p_events: ids });
  if (!error && Array.isArray(data)) {
    for (const r of data) out.set(r.event_id, { ...out.get(r.event_id), ...r });
    return out;
  }
  for (const id of ids) {
    const rows = await all(() => sb.from("gfs_clips").select("event_id,match,stage,held,delivered_at,listed_at,removed_at").eq("event_id", id));
    const c = out.get(id);
    for (const r of rows) {
      c.shot++;
      if (r.match === "matched") c.matched++;
      if (r.match === "unmatched") c.unmatched++;
      if (r.match === "not_a_player") c.not_a_player++;
      if (["tagged", "edited", "approved"].includes(r.stage)) c.tagged++;
      if (["edited", "approved"].includes(r.stage)) c.edited++;
      if (r.stage === "approved") c.approved++;
      if (r.delivered_at) c.delivered++;
      if (r.listed_at && !r.removed_at) c.listed++;
      if (r.held) c.held++;
      if (r.held && (r.listed_at || r.delivered_at) && !r.removed_at) c.needs_removal++;
    }
  }
  return out;
}

// Re-check every matched clip's hold against the roster (the database does
// this itself through migration 024; this keeps the answer right either way).
async function refreshHolds(sb, ev, rosterById) {
  const clips = await all(() => sb.from("gfs_clips").select("id,roster_row,held,hold_reason").eq("event_id", ev.id).eq("match", "matched"));
  let changed = 0;
  for (const c of clips) {
    const reason = G.holdReason(rosterById.get(c.roster_row));
    if ((reason || null) !== (c.hold_reason || null) || !!reason !== !!c.held) {
      await run(sb.from("gfs_clips").update({ held: !!reason, hold_reason: reason }).eq("id", c.id));
      changed++;
    }
  }
  return changed;
}
async function rosterRows(sb, eventId) {
  return all(() => sb.from("gfs_roster").select("*").eq("event_id", eventId).order("team", { ascending: true }));
}

// ── Meta ─────────────────────────────────────────────────────────────────
router.get("/meta", viewer, (req, res) => {
  res.json({
    regions: G.REGIONS,
    sizes: G.SIZES,
    statuses: G.STATUSES,
    crew_roles: G.CREW_ROLES,
    on_site: G.ON_SITE,
    youth_roles: G.YOUTH_ROLES,
    crew_target: G.CREW_TARGET,
    angles: G.ANGLES,
    consents: G.CONSENTS,
    flags: G.FLAGS,
    standard: G.STANDARD,
    takedown: G.TAKEDOWN,
    deliverables: G.DELIVERABLES.map((d) => ({ kind: d.kind, group: d.group, name: d.name, note: d.note || null, publishes: d.publishes, featured: !!d.featured, counts: d.counts })),
    state_tz: G.STATE_TZ,
    // The app keeps only these roster columns before a file leaves the
    // device (the server drops the rest again).
    roster_columns: G.ROSTER_COLUMNS,
    you: { role: req.team.role, owner: !!req.team.owner, all_regions: G.seesAll(req.team), regions: G.regionsOf(req.team) },
  });
});

// ── Events ───────────────────────────────────────────────────────────────
function regionFilter(req, res) {
  const visible = G.regionsOf(req.team);
  if (!req.query.region) return visible;
  const r = String(req.query.region);
  if (!visible.includes(r)) {
    res.status(404).json({ error: "region_not_yours" });
    return null;
  }
  return [r];
}

router.get("/events", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const regions = regionFilter(req, res);
  if (!regions) return;
  if (!regions.length) return res.json({ events: [], regions: [] });
  const from = G.isDate(req.query.from) ? req.query.from : G.addDays(today(), -30);
  const to = G.isDate(req.query.to) ? req.query.to : G.addDays(today(), 400);
  try {
    let q = sb.from("gfs_events").select("*").in("region", regions).gte("ends_on", from).lte("starts_on", to);
    if (req.query.series) q = q.eq("series", G.clean(req.query.series, 60));
    const events = await run(q.order("starts_on", { ascending: true }).limit(300));
    const ids = events.map((e) => e.id);
    const crew = ids.length ? await inChunks(ids, (chunk) => run(sb.from("gfs_crew").select("event_id,role,status").in("event_id", chunk))) : [];
    const names = await namesFor(sb, events.map((e) => e.director_email));
    res.json({
      events: events.map((ev) => {
        const mine = crew.filter((c) => c.event_id === ev.id);
        const list = checklist(ev, mine);
        return { ...eventView(ev, req, names), checklist: list, ready: list.filter((x) => x.done).length };
      }),
      regions: G.regionsOf(req.team),
    });
  } catch (e) {
    fail(res, e, "list_events");
  }
});

function readEventBody(body, prev, req) {
  const b = body || {};
  const ev = { ...(prev || {}) };
  const errors = [];
  const set = (k, v) => (ev[k] = v);
  if (b.name !== undefined || !prev) {
    const v = G.clean(b.name, 120);
    if (v.length < 2) errors.push("name");
    set("name", v);
  }
  if (b.series !== undefined) set("series", G.clean(b.series, 60) || null);
  if (b.venue !== undefined) set("venue", G.clean(b.venue, 120) || null);
  if (!prev) {
    if (!G.SIZES[b.size]) errors.push("size");
    set("size", b.size);
  }
  if (b.region !== undefined || !prev) {
    if (!G.REGIONS[b.region]) errors.push("region");
    set("region", b.region);
  }
  if (b.city !== undefined || !prev) {
    const v = G.clean(b.city, 80);
    if (!v) errors.push("city");
    set("city", v);
  }
  if (b.state !== undefined || !prev) {
    const v = String(b.state || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(v)) errors.push("state");
    set("state", v);
  }
  if (b.tz !== undefined) set("tz", String(b.tz || ""));
  if (!ev.tz) set("tz", G.STATE_TZ[ev.state] || "America/Chicago");
  if (!G.validTz(ev.tz)) errors.push("tz");
  if (b.starts_on !== undefined || !prev) {
    if (!G.isDate(b.starts_on)) errors.push("starts_on");
    set("starts_on", b.starts_on);
  }
  if (b.ends_on !== undefined || !prev) set("ends_on", b.ends_on || ev.starts_on);
  if (!G.isDate(ev.ends_on) || (G.isDate(ev.starts_on) && (ev.ends_on < ev.starts_on || G.daysBetween(ev.starts_on, ev.ends_on) > 6))) errors.push("ends_on");
  if (b.wraps_at !== undefined) {
    if (!G.isTime(String(b.wraps_at).slice(0, 5))) errors.push("wraps_at");
    set("wraps_at", String(b.wraps_at).slice(0, 5));
  }
  if (!ev.wraps_at) set("wraps_at", "18:00");
  if (b.crew_target !== undefined) {
    const n = Number(b.crew_target);
    if (!Number.isInteger(n) || n < 0 || n > 30) errors.push("crew_target");
    set("crew_target", n);
  }
  if (b.director_email !== undefined) {
    const e = String(b.director_email || "").trim().toLowerCase();
    if (e && !EMAIL_RE.test(e)) errors.push("director_email");
    set("director_email", e || null);
  }
  if (b.storefront_url !== undefined) {
    const u = String(b.storefront_url || "").trim();
    if (u && !/^https:\/\/[^\s]{4,300}$/.test(u)) errors.push("storefront_url");
    set("storefront_url", u || null);
  }
  if (b.clip_price_cents !== undefined) {
    const n = Number(b.clip_price_cents);
    if (!atLeast(req, "approver")) errors.push("clip_price_needs_approver");
    else if (!Number.isInteger(n) || n < 0 || n > 100000) errors.push("clip_price_cents");
    set("clip_price_cents", n);
  }
  return { ev, errors };
}

async function uniqueCode(sb, base) {
  const clean = String(base).replace(/[^A-Za-z0-9]/g, "").slice(0, 22) || "Event";
  for (let i = 0; i < 30; i++) {
    const c = i === 0 ? clean : `${clean}${String.fromCharCode(65 + ((i - 1) % 26))}${i > 26 ? i : ""}`.slice(0, 24);
    const hit = await run(sb.from("gfs_events").select("id").eq("code", c).maybeSingle());
    if (!hit) return c;
  }
  return `${clean.slice(0, 18)}${G.code(4)}`;
}

router.post("/events", member, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const { ev, errors } = readEventBody(req.body, null, req);
  if (errors.length) return res.status(400).json({ error: "invalid_event", fields: errors });
  if (!G.canSee(req.team, ev.region)) return res.status(403).json({ error: "region_not_yours" });
  try {
    const wanted = req.body && req.body.code ? String(req.body.code) : G.eventCode(ev.city, ev.starts_on);
    if (!/^[A-Za-z0-9]{2,24}$/.test(wanted)) return res.status(400).json({ error: "invalid_event", fields: ["code"] });
    const row = {
      ...ev,
      code: await uniqueCode(sb, wanted),
      crew_target: ev.crew_target === undefined ? G.CREW_TARGET[ev.size] : ev.crew_target,
      clip_price_cents: ev.clip_price_cents === undefined ? 1999 : ev.clip_price_cents,
      director_email: ev.director_email === undefined ? (req.team.role === "member" ? req.team.email : null) : ev.director_email,
      status: "planning",
      created_by: actor(req),
    };
    row.ends_at = G.endsAt(row);
    const created = await run(sb.from("gfs_events").insert(row).select("*").single());
    const rows = G.deliverablesFor(created).map((d) => newDeliverable(created, d));
    await run(sb.from("gfs_deliverables").insert(rows));
    await T.logActivity(actor(req), "gfs_event_created", created.code, { region: created.region, size: created.size });
    res.json({ event: eventView(created, req) });
  } catch (e) {
    fail(res, e, "create_event");
  }
});

router.get("/events/:id", viewer, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const [crew, deliverables, roster, takedowns] = await Promise.all([
      run(sb.from("gfs_crew").select("*").eq("event_id", ev.id)),
      run(sb.from("gfs_deliverables").select("*").eq("event_id", ev.id)),
      rosterRows(sb, ev.id),
      run(sb.from("gfs_takedowns").select("id,number,team,reason,received_at,pylon_due_at,other_due_at,offsite_due_at,pylon_done_at,other_done_at,offsite_requested_at,status").eq("event_id", ev.id).eq("status", "open")),
    ]);
    const creatorIds = [...new Set(crew.map((c) => c.creator_id))];
    const creators = creatorIds.length ? await run(sb.from("gfs_creators").select("*").in("id", creatorIds)) : [];
    const byId = new Map(creators.map((c) => [c.id, c]));
    const counts = (await eventCounts(sb, [ev.id])).get(ev.id);
    const names = await namesFor(sb, [ev.director_email]);
    const teams = new Set(roster.map((r) => G.norm(r.team)));
    const order = new Map(G.DELIVERABLE_KINDS.map((k, i) => [k, i]));
    res.json({
      event: eventView(ev, req, names),
      checklist: checklist(ev, crew),
      crew: crew.filter((c) => c.status !== "removed").map((c) => crewView(c, byId.get(c.creator_id), req)),
      roster: {
        teams: teams.size,
        athletes: roster.length,
        do_not_publish: roster.filter((r) => r.do_not_publish || r.takedown_at).length,
        no_capture: roster.filter((r) => !r.consent_capture).length,
        no_marketing: roster.filter((r) => !r.consent_marketing).length,
        sale_ok: roster.filter((r) => r.consent_sale && !G.holdReason(r)).length,
        under_13: roster.filter((r) => G.under13(r)).length,
        priority: roster.filter((r) => r.priority).length,
        low_profile: roster.filter((r) => r.low_profile).length,
        no_jersey: roster.filter((r) => r.jersey == null).length,
      },
      counts,
      deliverables: deliverables.sort((a, b) => order.get(a.kind) - order.get(b.kind) || a.day - b.day).map((d) => deliverableView(d, ev)),
      takedowns: takedowns.map((t) => ({ ...t, reason_name: (G.TAKEDOWN[t.reason] || {}).label })),
    });
  } catch (e) {
    fail(res, e, "get_event");
  }
});

// A Schedule C row as it starts: nothing delivered, nothing approved.
function newDeliverable(ev, d) {
  return { ...d, event_id: ev.id, delivered: 0, approved_count: 0, status: "open", featured: [] };
}

// Keep the Schedule C rows in step with the event's dates and size.
async function resyncDeliverables(sb, ev) {
  const want = G.deliverablesFor(ev);
  const have = await run(sb.from("gfs_deliverables").select("id,kind,day,delivered,status").eq("event_id", ev.id));
  const key = (d) => `${d.kind}|${d.day}`;
  const haveBy = new Map(have.map((d) => [key(d), d]));
  for (const w of want) {
    const h = haveBy.get(key(w));
    if (h) {
      await run(sb.from("gfs_deliverables").update({ due_at: w.due_at }).eq("id", h.id));
      haveBy.delete(key(w));
    } else {
      await run(sb.from("gfs_deliverables").insert(newDeliverable(ev, w)));
    }
  }
  // Extra cut-down days from a shortened event go, unless work was logged.
  for (const h of haveBy.values()) {
    if (h.kind === "cutdowns" && h.delivered === 0 && h.status === "open") await run(sb.from("gfs_deliverables").delete().eq("id", h.id));
  }
}

router.patch("/events/:id", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const b = req.body || {};
    if (b.size !== undefined && b.size !== ev.size) return res.status(400).json({ error: "size_fixed", hint: "Cancel this event and make a new one at the other size." });
    const { ev: next, errors } = readEventBody(b, { ...ev, wraps_at: String(ev.wraps_at || "18:00").slice(0, 5) }, req);
    if (errors.length) return res.status(400).json({ error: "invalid_event", fields: errors });
    if (next.region !== ev.region && !G.canSee(req.team, next.region)) return res.status(403).json({ error: "region_not_yours" });
    const patch = {};
    for (const k of ["name", "series", "venue", "region", "city", "state", "tz", "starts_on", "ends_on", "wraps_at", "crew_target", "director_email", "storefront_url", "clip_price_cents"]) {
      if (b[k] !== undefined || (k === "tz" && next.tz !== ev.tz)) patch[k] = next[k];
    }
    if (b.storefront_ready !== undefined) patch.storefront_ready_at = b.storefront_ready ? ev.storefront_ready_at || now() : null;
    if (b.brief_sent !== undefined) patch.brief_sent_at = b.brief_sent ? ev.brief_sent_at || now() : null;
    if (b.status !== undefined) {
      if (!G.STATUSES.includes(b.status)) return res.status(400).json({ error: "invalid_event", fields: ["status"] });
      patch.status = b.status;
    }
    if (!Object.keys(patch).length) return res.json({ event: eventView(ev, req) });
    const merged = { ...ev, ...patch };
    patch.ends_at = G.endsAt(merged);
    const updated = await run(sb.from("gfs_events").update(patch).eq("id", ev.id).select("*").single());
    if (["starts_on", "ends_on", "wraps_at", "tz"].some((k) => patch[k] !== undefined)) await resyncDeliverables(sb, updated);
    await T.logActivity(actor(req), "gfs_event_changed", updated.code, { fields: Object.keys(patch).filter((k) => k !== "ends_at") });
    res.json({ event: eventView(updated, req) });
  } catch (e) {
    fail(res, e, "update_event");
  }
});

// ── Crew ─────────────────────────────────────────────────────────────────
async function visibleCreators(sb, req) {
  const regions = G.regionsOf(req.team);
  if (!regions.length) return [];
  return all(() => sb.from("gfs_creators").select("*").in("region", regions).order("name", { ascending: true }));
}

router.get("/events/:id/crew", viewer, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const crew = await run(sb.from("gfs_crew").select("*").eq("event_id", ev.id));
    const pool = await visibleCreators(sb, req);
    const assignedIds = crew.map((c) => c.creator_id);
    const missing = assignedIds.filter((id) => !pool.some((c) => c.id === id));
    const extra = missing.length ? await run(sb.from("gfs_creators").select("*").in("id", missing)) : [];
    const byId = new Map([...pool, ...extra].map((c) => [c.id, c]));
    const active = new Set(crew.filter((c) => ["invited", "confirmed"].includes(c.status)).map((c) => c.creator_id));
    res.json({
      event: eventView(ev, req),
      checklist: checklist(ev, crew),
      crew: crew.filter((c) => c.status !== "removed").map((c) => crewView(c, byId.get(c.creator_id), req)),
      candidates: pool
        .filter((c) => c.status === "active" && !active.has(c.id))
        .sort((a, b) => (a.region === ev.region ? 0 : 1) - (b.region === ev.region ? 0 : 1) || a.name.localeCompare(b.name))
        .map((c) => ({ ...creatorView(c, req, ev), blocks: G.credentialProblems(c, ev, null), nearby: c.region === ev.region })),
    });
  } catch (e) {
    fail(res, e, "get_crew");
  }
});

function youthCheck(crew, creators, ev, change) {
  // change: { id?, creator, role, status } — the row as it would be.
  const rows = crew.filter((c) => c.id !== change.id).concat([{ ...change, creator_id: change.creator.id }]);
  const tier = (c) => ((creators.get(c.creator_id) || change.creator).tier || "adult");
  const adultsOnSite = rows.filter((c) => c.status === "confirmed" && G.ADULT_ON_SITE.includes(c.role) && tier(c) === "adult");
  const youthConfirmed = rows.filter((c) => c.status === "confirmed" && tier(c) === "youth");
  const mine = change.creator.tier || "adult";
  if (mine === "youth" && change.status === "confirmed" && !adultsOnSite.length) return "crew_youth_needs_adult";
  if (mine === "adult" && ["declined", "removed"].includes(change.status) && youthConfirmed.length && !adultsOnSite.length) return "crew_youth_left_alone";
  return null;
}

router.post("/events/:id/crew", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const b = req.body || {};
    if (!G.CREW_ROLES[b.role]) return res.status(400).json({ error: "invalid_role", allowed: Object.keys(G.CREW_ROLES) });
    if (!UUID.test(String(b.creator_id || ""))) return res.status(400).json({ error: "invalid_creator" });
    const c = await run(sb.from("gfs_creators").select("*").eq("id", b.creator_id).maybeSingle());
    if (!c || !G.canSee(req.team, c.region)) return res.status(404).json({ error: "creator_not_found" });
    const problems = G.credentialProblems(c, ev, b.role);
    if (problems.length) return res.status(409).json({ error: "credentials", problems });
    const crew = await run(sb.from("gfs_crew").select("*").eq("event_id", ev.id));
    if (crew.some((x) => x.creator_id === c.id && ["invited", "confirmed"].includes(x.status))) return res.status(409).json({ error: "already_on_crew" });
    const row = await run(
      sb.from("gfs_crew").insert({ event_id: ev.id, creator_id: c.id, role: b.role, status: "invited", note: G.clean(b.note, 120) || null, assigned_by: actor(req) }).select("*").single()
    );
    await T.logActivity(actor(req), "gfs_crew_added", ev.code, { role: b.role, creator: c.code });
    res.json({ crew: crewView(row, c, req) });
  } catch (e) {
    fail(res, e, "add_crew");
  }
});

router.patch("/events/:id/crew/:cid", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    if (!UUID.test(String(req.params.cid))) return res.status(404).json({ error: "not_found" });
    const crew = await run(sb.from("gfs_crew").select("*").eq("event_id", ev.id));
    const row = crew.find((x) => x.id === req.params.cid);
    if (!row) return res.status(404).json({ error: "not_found" });
    const ids = [...new Set(crew.map((x) => x.creator_id))];
    const creators = new Map((await run(sb.from("gfs_creators").select("*").in("id", ids))).map((x) => [x.id, x]));
    const c = creators.get(row.creator_id);
    const b = req.body || {};
    const patch = {};
    if (b.role !== undefined) {
      if (!G.CREW_ROLES[b.role]) return res.status(400).json({ error: "invalid_role" });
      patch.role = b.role;
    }
    if (b.status !== undefined) {
      if (!["invited", "confirmed", "declined", "removed"].includes(b.status)) return res.status(400).json({ error: "invalid_status" });
      patch.status = b.status;
    }
    if (b.note !== undefined) patch.note = G.clean(b.note, 120) || null;
    if (b.family_rating !== undefined) {
      const n = b.family_rating === null ? null : Math.round(Number(b.family_rating) * 10) / 10;
      if (n !== null && !(n >= 1 && n <= 5)) return res.status(400).json({ error: "invalid_rating" });
      patch.family_rating = n;
    }
    if (b.rating_count !== undefined) {
      const n = b.rating_count === null ? null : Number(b.rating_count);
      if (n !== null && !(Number.isInteger(n) && n >= 0 && n <= 100000)) return res.status(400).json({ error: "invalid_rating" });
      patch.rating_count = n;
    }
    patch.updated_at = now();
    const next = { ...row, ...patch };
    if (!["declined", "removed"].includes(next.status)) {
      const problems = G.credentialProblems(c, ev, next.role);
      if (problems.length) return res.status(409).json({ error: "credentials", problems });
      if (["declined", "removed"].includes(row.status) && crew.some((x) => x.id !== row.id && x.creator_id === row.creator_id && ["invited", "confirmed"].includes(x.status))) return res.status(409).json({ error: "already_on_crew" });
    }
    const youth = youthCheck(crew, creators, ev, { ...next, creator: c });
    if (youth) return res.status(409).json({ error: youth });
    const updated = await run(sb.from("gfs_crew").update(patch).eq("id", row.id).select("*").single());
    if (patch.status && patch.status !== row.status) await T.logActivity(actor(req), "gfs_crew_" + patch.status, ev.code, { role: updated.role, creator: c.code });
    res.json({ crew: crewView(updated, c, req) });
  } catch (e) {
    fail(res, e, "update_crew");
  }
});

// ── Roster ───────────────────────────────────────────────────────────────
function csvText(req, res) {
  const t = req.body && typeof req.body.csv === "string" ? req.body.csv : "";
  if (!t.trim()) {
    res.status(400).json({ error: "csv_required" });
    return null;
  }
  if (t.length > CSV_MAX) {
    res.status(413).json({ error: "csv_too_big", max_bytes: CSV_MAX });
    return null;
  }
  return t;
}
const ROSTER_KEEP = ["roster_id", "team", "division", "jersey", "position", "under_13", ...Object.keys(G.CONSENTS), ...Object.keys(G.FLAGS)];

router.post("/events/:id/roster", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const text = csvText(req, res);
    if (text == null) return;
    const parsed = G.parseRoster(text);
    if (!parsed.ok) return res.status(400).json({ error: "roster_columns", problems: parsed.problems, dropped_columns: parsed.dropped });
    const existing = await rosterRows(sb, ev.id);
    const byRid = new Map(existing.map((r) => [r.roster_id, r]));
    let added = 0, updated = 0, unchanged = 0;
    const upserts = [];
    for (const r of parsed.rows) {
      const row = { event_id: ev.id };
      for (const k of ROSTER_KEEP) row[k] = r[k];
      const prev = byRid.get(r.roster_id);
      if (prev && prev.takedown_at) row.do_not_publish = true; // a takedown stands
      if (!prev) added++;
      else if (ROSTER_KEEP.some((k) => (prev[k] ?? null) !== (row[k] ?? null))) updated++;
      else { unchanged++; continue; }
      row.imported_at = now();
      upserts.push(row);
    }
    for (let i = 0; i < upserts.length; i += 500) await run(sb.from("gfs_roster").upsert(upserts.slice(i, i + 500), { onConflict: "event_id,roster_id" }));
    await run(sb.from("gfs_events").update({ roster_in_at: now() }).eq("id", ev.id));
    const fresh = await rosterRows(sb, ev.id);
    const byId = new Map(fresh.map((r) => [r.id, r]));
    const holds = await refreshHolds(sb, ev, byId);
    const rematched = await rematch(sb, ev, fresh);
    await T.logActivity(actor(req), "gfs_roster_loaded", ev.code, { rows: parsed.rows.length, added, updated });
    res.json({
      summary: {
        rows: parsed.rows.length,
        added,
        updated,
        unchanged,
        skipped: parsed.skipped.length,
        skipped_lines: parsed.skipped.slice(0, 20),
        dropped_columns: parsed.dropped,
        warnings: parsed.warnings,
        athletes: fresh.length,
        do_not_publish: fresh.filter((r) => r.do_not_publish || r.takedown_at).length,
        no_capture: fresh.filter((r) => !r.consent_capture).length,
        under_13: fresh.filter((r) => G.under13(r)).length,
        priority: fresh.filter((r) => r.priority).length,
        low_profile: fresh.filter((r) => r.low_profile).length,
        no_jersey: fresh.filter((r) => r.jersey == null).length,
        holds_changed: holds,
        clips_matched_now: rematched,
      },
    });
  } catch (e) {
    fail(res, e, "load_roster");
  }
});

// Unmatched clips get another try against the roster as it is now.
async function rematch(sb, ev, roster) {
  const index = G.rosterIndex(roster);
  const clips = await all(() => sb.from("gfs_clips").select("*").eq("event_id", ev.id).eq("match", "unmatched"));
  let n = 0;
  for (const c of clips) {
    const m = G.matchClip({ jersey: c.jersey, team: c.team, teamHint: c.team_hint, teams: teamsOfGame(c.game) }, index);
    if (m.match === "matched") {
      const reason = G.holdReason(m.row);
      await run(sb.from("gfs_clips").update({ match: "matched", why: null, roster_row: m.row.id, team: m.row.team, label: G.finalLabel(ev, m.row, c), held: !!reason, hold_reason: reason }).eq("id", c.id));
      n++;
    } else if (m.why !== c.why) {
      await run(sb.from("gfs_clips").update({ why: m.why }).eq("id", c.id));
    }
  }
  return n;
}
function teamsOfGame(game) {
  const m = game ? /^(.+?)_vs_(.+?)_(\d{8})$/i.exec(game) : null;
  return m ? [m[1], m[2]] : null;
}

function rosterView(r) {
  const out = { id: r.id, roster_id: r.roster_id, team: r.team, division: r.division || null, jersey: r.jersey, position: r.position || null };
  for (const k of [...Object.keys(G.CONSENTS), ...Object.keys(G.FLAGS)]) out[k] = !!r[k];
  out.under_13 = G.under13(r);
  out.age_verified = r.under_13 === false;
  out.takedown = !!r.takedown_at;
  out.hold = G.holdReason(r);
  out.visibility = G.visibilityFor(r);
  return out;
}

router.get("/events/:id/roster", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const rows = await rosterRows(sb, ev.id);
    const teams = new Map();
    for (const r of rows) {
      const t = teams.get(r.team) || { team: r.team, athletes: 0, held: 0 };
      t.athletes++;
      if (G.holdReason(r)) t.held++;
      teams.set(r.team, t);
    }
    let list = rows;
    if (req.query.team) list = list.filter((r) => r.team === String(req.query.team));
    const f = String(req.query.flag || "");
    if (f === "held") list = list.filter((r) => G.holdReason(r));
    if (f === "priority") list = list.filter((r) => r.priority);
    if (f === "low_profile") list = list.filter((r) => r.low_profile);
    if (f === "no_jersey") list = list.filter((r) => r.jersey == null);
    list.sort((a, b) => a.team.localeCompare(b.team) || Number(a.jersey ?? 999) - Number(b.jersey ?? 999));
    res.json({ event: eventView(ev, req), teams: [...teams.values()].sort((a, b) => a.team.localeCompare(b.team)), athletes: list.map(rosterView) });
  } catch (e) {
    fail(res, e, "get_roster");
  }
});

// ── The upload log ───────────────────────────────────────────────────────
router.post("/events/:id/uploads", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const text = csvText(req, res);
    if (text == null) return;
    const parsed = G.parseUploads(text, ev);
    if (!parsed.ok) return res.status(400).json({ error: "upload_columns", problems: parsed.problems });

    // Creators by code or email.
    const named = [...new Set([...parsed.games, ...parsed.clips].map((x) => x.creator).filter(Boolean))];
    const creators = named.length ? await all(() => sb.from("gfs_creators").select("id,code,email")) : [];
    const findCreator = (s) => {
      if (!s) return null;
      const c = creators.find((x) => x.code === s.toUpperCase() || (x.email && x.email === s.toLowerCase()));
      return c ? c.id : null;
    };
    const unknownCreators = named.filter((s) => !findCreator(s)).length;

    // Game files → the creator measures.
    let gamesAdded = 0, gamesUpdated = 0;
    const prevUploads = new Map((await all(() => sb.from("gfs_uploads").select("id,log_key").eq("event_id", ev.id))).map((u) => [u.log_key, u.id]));
    const uploadRows = [];
    for (const g of parsed.games) {
      const key = G.uploadKey(ev.id, g);
      const row = { event_id: ev.id, log_key: key, game: g.game.slice(0, 160), angle: g.angle, file: g.file.slice(0, 160), creator_id: findCreator(g.creator), final_whistle_at: g.final_whistle_at, uploaded_at: g.uploaded_at, usable: g.usable, logged_by: actor(req) };
      if (prevUploads.has(key)) gamesUpdated++;
      else gamesAdded++;
      uploadRows.push(row);
    }
    const dedup = new Map(uploadRows.map((r) => [r.log_key, r]));
    const ups = [...dedup.values()];
    for (let i = 0; i < ups.length; i += 500) await run(sb.from("gfs_uploads").upsert(ups.slice(i, i + 500), { onConflict: "log_key" }));

    // Clips → tagged by jersey against the roster.
    const roster = await rosterRows(sb, ev.id);
    const index = G.rosterIndex(roster);
    const known = new Set((await all(() => sb.from("gfs_clips").select("log_key").eq("event_id", ev.id))).map((c) => c.log_key));
    const fresh = new Map();
    let already = 0;
    const tally = { matched: 0, unmatched: 0, held: 0, why: {} };
    for (const c of parsed.clips) {
      const key = G.clipKey(ev.id, c);
      if (known.has(key) || fresh.has(key)) { already++; continue; }
      const m = G.matchClip(c, index);
      const row = {
        event_id: ev.id,
        log_key: key,
        game: c.game ? String(c.game).slice(0, 160) : null,
        team: m.row ? m.row.team : c.team || null,
        team_hint: c.teamHint ? G.clean(c.teamHint, 80) : null,
        folder: c.folder ? String(c.folder).slice(0, 40) : null,
        file: c.file,
        angle: c.angle,
        clip_no: c.clip_no,
        jersey: c.jersey,
        creator_id: findCreator(c.creator),
        roster_row: m.row ? m.row.id : null,
        match: m.match,
        why: m.why || null,
        label: m.row ? G.finalLabel(ev, m.row, c) : null,
        held: false,
        hold_reason: null,
        stage: "shot",
        uploaded_at: c.uploaded_at,
        logged_by: actor(req),
      };
      if (m.row) {
        const reason = G.holdReason(m.row);
        row.held = !!reason;
        row.hold_reason = reason;
        tally.matched++;
        if (reason) tally.held++;
      } else {
        tally.unmatched++;
        tally.why[m.why] = (tally.why[m.why] || 0) + 1;
      }
      fresh.set(key, row);
    }
    const rows = [...fresh.values()];
    for (let i = 0; i < rows.length; i += 500) await run(sb.from("gfs_clips").insert(rows.slice(i, i + 500)));
    await T.logActivity(actor(req), "gfs_uploads_loaded", ev.code, { clips: rows.length, games: ups.length });
    res.json({
      summary: {
        games: { added: gamesAdded, updated: gamesUpdated },
        clips: { added: rows.length, already, matched: tally.matched, unmatched: tally.unmatched, held: tally.held, why: tally.why },
        skipped: parsed.skipped.length,
        skipped_lines: parsed.skipped.slice(0, 20),
        unknown_creators: unknownCreators,
        no_final_whistle: parsed.games.filter((g) => !g.final_whistle_at).length,
        roster_loaded: roster.length > 0,
      },
    });
  } catch (e) {
    fail(res, e, "load_uploads");
  }
});

// ── Clips ────────────────────────────────────────────────────────────────
function clipView(c, row, req) {
  return {
    id: c.id,
    file: c.file,
    folder: c.folder || null,
    game: c.game || null,
    team: c.team || null,
    team_hint: c.team_hint || null,
    angle: c.angle || null,
    clip_no: c.clip_no,
    jersey: c.jersey,
    match: c.match,
    why: c.why || null,
    label: c.label || null,
    held: !!c.held,
    hold_reason: c.hold_reason || null,
    stage: c.stage,
    delivered: !!c.delivered_at,
    listed: !!c.listed_at && !c.removed_at,
    removed: !!c.removed_at,
    visibility: c.visibility || null,
    athlete: row ? { roster_row: row.id, team: row.team, jersey: row.jersey, position: row.position || null, roster_id: atLeast(req, "member") ? row.roster_id : null } : null,
  };
}

router.get("/events/:id/clips", viewer, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const view = String(req.query.view || "unmatched");
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const base = () => {
      let q = sb.from("gfs_clips").select("*").eq("event_id", ev.id);
      if (view === "unmatched") q = q.eq("match", "unmatched");
      else if (view === "held" || view === "out") q = q.eq("held", true);
      else if (view === "matched") q = q.eq("match", "matched");
      else if (view === "not_a_player") q = q.eq("match", "not_a_player");
      if (req.query.team) q = q.eq("team", G.clean(req.query.team, 80));
      return q.order("created_at", { ascending: true });
    };
    // "out": held clips that reached a family or SportsClippers and still
    // need taking down (a short list, so it's filtered here).
    const clips = view === "out"
      ? (await all(base)).filter((c) => (c.listed_at || c.delivered_at) && !c.removed_at).slice(offset, offset + limit)
      : await run(base().range(offset, offset + limit - 1));
    const roster = await rosterRows(sb, ev.id);
    const byId = new Map(roster.map((r) => [r.id, r]));
    const showSuggestions = atLeast(req, "member") && view === "unmatched";
    const teams = [...new Set(roster.map((r) => r.team))].sort();
    res.json({
      event: eventView(ev, req),
      counts: (await eventCounts(sb, [ev.id])).get(ev.id),
      clips: clips.map((c) => {
        const hint = c.team_hint && roster.some((r) => G.norm(r.team) === G.norm(c.team_hint)) ? c.team_hint : null;
        return { ...clipView(c, byId.get(c.roster_row), req), suggestions: showSuggestions ? G.suggestions({ jersey: c.jersey, team: c.team || hint, teams: teamsOfGame(c.game) }, roster) : undefined };
      }),
      teams: atLeast(req, "member") ? teams.map((t) => ({ team: t, jerseys: roster.filter((r) => r.team === t && r.jersey != null).map((r) => ({ roster_row: r.id, jersey: r.jersey, position: r.position || null })).sort((a, b) => Number(a.jersey) - Number(b.jersey)) })) : [],
      tags_approved_at: ev.tags_approved_at || null,
      offset,
      limit,
    });
  } catch (e) {
    fail(res, e, "list_clips");
  }
});

router.patch("/events/:id/clips/:clipId", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    if (!UUID.test(String(req.params.clipId))) return res.status(404).json({ error: "not_found" });
    const c = await run(sb.from("gfs_clips").select("*").eq("id", req.params.clipId).eq("event_id", ev.id).maybeSingle());
    if (!c) return res.status(404).json({ error: "not_found" });
    if ((c.delivered_at || c.listed_at) && !c.removed_at) return res.status(409).json({ error: "gfs_clip_already_out", hint: "This clip has reached families or SportsClippers. Log a takedown instead." });
    const b = req.body || {};
    let patch;
    if (b.not_a_player === true) {
      patch = { match: "not_a_player", why: null, roster_row: null, label: null, stage: "shot", held: false, hold_reason: null };
    } else if (b.untag === true) {
      patch = { match: "unmatched", why: c.jersey ? "not_on_roster" : "no_number", roster_row: null, label: null, stage: "shot", held: false, hold_reason: null };
    } else if (UUID.test(String(b.roster_row || ""))) {
      const row = await run(sb.from("gfs_roster").select("*").eq("id", b.roster_row).eq("event_id", ev.id).maybeSingle());
      if (!row) return res.status(400).json({ error: "not_on_this_roster" });
      if (row.jersey == null) return res.status(400).json({ error: "athlete_has_no_jersey" });
      const reason = G.holdReason(row);
      patch = { match: "matched", why: null, roster_row: row.id, team: row.team, jersey: row.jersey, label: G.finalLabel(ev, row, c), stage: "shot", held: !!reason, hold_reason: reason };
    } else {
      return res.status(400).json({ error: "tag_required", hint: "Send roster_row, or not_a_player: true." });
    }
    const updated = await run(sb.from("gfs_clips").update(patch).eq("id", c.id).select("*").single());
    const row = updated.roster_row ? await run(sb.from("gfs_roster").select("*").eq("id", updated.roster_row).maybeSingle()) : null;
    res.json({ clip: clipView(updated, row, req) });
  } catch (e) {
    fail(res, e, "tag_clip");
  }
});

async function markDeliverable(sb, ev, kind, delivered) {
  const rows = await run(sb.from("gfs_deliverables").select("*").eq("event_id", ev.id).eq("kind", kind));
  for (const d of rows) {
    const patch = { delivered: Math.max(d.delivered, delivered) };
    if (!d.publishes && d.status === "open" && patch.delivered >= d.required) patch.status = "done";
    await run(sb.from("gfs_deliverables").update(patch).eq("id", d.id));
  }
}

router.post("/events/:id/tags/approve", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const ready = await all(() => sb.from("gfs_clips").select("id").eq("event_id", ev.id).eq("match", "matched").eq("stage", "shot").eq("held", false));
    if (ready.length) await run(sb.from("gfs_clips").update({ stage: "tagged" }).eq("event_id", ev.id).eq("match", "matched").eq("stage", "shot").eq("held", false));
    await run(sb.from("gfs_events").update({ tags_approved_at: now(), tags_approved_by: actor(req) }).eq("id", ev.id));
    await markDeliverable(sb, ev, "tagging", 1);
    const counts = (await eventCounts(sb, [ev.id])).get(ev.id);
    await T.logActivity(actor(req), "gfs_tags_approved", ev.code, { tagged: ready.length, unmatched: counts.unmatched });
    res.json({ tagged: ready.length, counts });
  } catch (e) {
    fail(res, e, "approve_tags");
  }
});

function teamFilter(q, req) {
  return req.body && req.body.team ? q.eq("team", G.clean(req.body.team, 80)) : q;
}

router.post("/events/:id/clips/edited", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const ids = (await all(() => teamFilter(sb.from("gfs_clips").select("id").eq("event_id", ev.id).eq("stage", "tagged"), req))).map((c) => c.id);
    await inChunks(ids, (chunk) => run(sb.from("gfs_clips").update({ stage: "edited" }).in("id", chunk).eq("stage", "tagged")));
    await T.logActivity(actor(req), "gfs_clips_edited", ev.code, { clips: ids.length });
    res.json({ edited: ids.length });
  } catch (e) {
    fail(res, e, "mark_edited");
  }
});

router.post("/events/:id/clips/approve", approver, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const ids = (await all(() => teamFilter(sb.from("gfs_clips").select("id").eq("event_id", ev.id).eq("stage", "edited").eq("held", false), req))).map((c) => c.id);
    const at = now();
    await inChunks(ids, (chunk) => run(sb.from("gfs_clips").update({ stage: "approved", approved_by: actor(req), approved_at: at }).in("id", chunk).eq("stage", "edited").eq("held", false)));
    await T.logActivity(actor(req), "gfs_clips_approved", ev.code, { clips: ids.length });
    res.json({ approved: ids.length });
  } catch (e) {
    fail(res, e, "approve_clips");
  }
});

// Approved clips that may go to a family: matched, not held, not removed.
async function outgoing(sb, ev) {
  const clips = await all(() => sb.from("gfs_clips").select("*").eq("event_id", ev.id).eq("stage", "approved").eq("held", false));
  const roster = await rosterRows(sb, ev.id);
  const byId = new Map(roster.map((r) => [r.id, r]));
  return clips.filter((c) => !c.removed_at && !G.holdReason(byId.get(c.roster_row))).map((c) => ({ c, row: byId.get(c.roster_row) }));
}

router.post("/events/:id/clips/delivered", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const list = (await outgoing(sb, ev)).filter((x) => !x.c.delivered_at);
    const at = now();
    await inChunks(list.map((x) => x.c.id), (chunk) => run(sb.from("gfs_clips").update({ delivered_at: at }).in("id", chunk).is("delivered_at", null)));
    await T.logActivity(actor(req), "gfs_clips_delivered", ev.code, { clips: list.length, athletes: new Set(list.map((x) => x.row.id)).size });
    res.json({ delivered: list.length, athletes: new Set(list.map((x) => x.row.id)).size });
  } catch (e) {
    fail(res, e, "mark_delivered");
  }
});

router.get("/events/:id/families.csv", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const list = await outgoing(sb, ev);
    const by = new Map();
    for (const { c, row } of list) {
      const x = by.get(row.id) || { roster_id: row.roster_id, team: row.team, jersey: row.jersey, clips: 0, labels: [] };
      x.clips++;
      x.labels.push(c.label);
      by.set(row.id, x);
    }
    const rows = [...by.values()].map((x) => ({ ...x, event: ev.code, visibility: "family", labels: x.labels.join(" ") }));
    await T.logActivity(actor(req), "gfs_families_exported", ev.code, { athletes: rows.length });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${ev.code}-family-links.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(G.toCsv(["event", "roster_id", "team", "jersey", "clips", "visibility", "labels"], rows));
  } catch (e) {
    fail(res, e, "families_csv");
  }
});

// SportsClippers §5: roster ID, jersey, position, team, event, consent
// flags. No names (the roster doesn't keep them), no birth dates, no contact.
async function listable(sb, ev, includeListed) {
  const list = await outgoing(sb, ev);
  return list.filter(({ c, row }) => row && row.consent_sale && (includeListed || !c.listed_at));
}
router.get("/events/:id/listings.csv", approver, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const list = await listable(sb, ev, req.query.all === "1");
    const rows = list.map(({ c, row }) => ({
      label: c.label,
      file: c.file,
      event_code: ev.code,
      event: ev.name,
      team: row.team,
      jersey: row.jersey,
      position: row.position || "",
      roster_id: row.roster_id,
      angle: c.angle || "",
      visibility: G.visibilityFor(row),
      consent_capture: "yes",
      consent_marketing: row.consent_marketing ? "yes" : "no",
      consent_sale: "yes",
      consent_commercial: row.consent_commercial ? "yes" : "no",
      public_display: row.public_display ? "yes" : "no",
      under_13: G.under13(row) ? "yes" : "no",
      price_cents: ev.clip_price_cents,
    }));
    await T.logActivity(actor(req), "gfs_listings_exported", ev.code, { clips: rows.length });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${ev.code}-sportsclippers.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(G.toCsv(["label", "file", "event_code", "event", "team", "jersey", "position", "roster_id", "angle", "visibility", "consent_capture", "consent_marketing", "consent_sale", "consent_commercial", "public_display", "under_13", "price_cents"], rows));
  } catch (e) {
    fail(res, e, "listings_csv");
  }
});

router.post("/events/:id/clips/listed", approver, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    let list = await listable(sb, ev, false);
    if (Array.isArray(req.body && req.body.ids)) {
      const want = new Set(req.body.ids.map(String));
      list = list.filter((x) => want.has(x.c.id));
    }
    const at = now();
    const tally = { family: 0, public: 0 };
    for (const vis of ["family", "public"]) {
      const ids = list.filter((x) => G.visibilityFor(x.row) === vis).map((x) => x.c.id);
      tally[vis] = ids.length;
      await inChunks(ids, (chunk) => run(sb.from("gfs_clips").update({ listed_at: at, visibility: vis }).in("id", chunk).is("listed_at", null)));
    }
    await T.logActivity(actor(req), "gfs_clips_listed", ev.code, tally);
    res.json({ listed: tally.family + tally.public, ...tally });
  } catch (e) {
    fail(res, e, "mark_listed");
  }
});

router.post("/events/:id/clips/removed", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String).filter((x) => UUID.test(x)).slice(0, 2000) : [];
    if (!ids.length) return res.status(400).json({ error: "ids_required" });
    const at = now();
    const rows = await inChunks(ids, (chunk) => run(sb.from("gfs_clips").select("id,listed_at,delivered_at,removed_at").eq("event_id", ev.id).in("id", chunk)));
    const out = rows.filter((c) => (c.listed_at || c.delivered_at) && !c.removed_at).map((c) => c.id);
    await inChunks(out, (chunk) => run(sb.from("gfs_clips").update({ removed_at: at }).in("id", chunk).is("removed_at", null)));
    await T.logActivity(actor(req), "gfs_clips_removed", ev.code, { clips: out.length });
    res.json({ removed: out.length });
  } catch (e) {
    fail(res, e, "mark_removed");
  }
});

// ── Deliverables ─────────────────────────────────────────────────────────
async function loadDeliverable(sb, ev, req, res) {
  if (!UUID.test(String(req.params.did))) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const d = await run(sb.from("gfs_deliverables").select("*").eq("id", req.params.did).eq("event_id", ev.id).maybeSingle());
  if (!d) res.status(404).json({ error: "not_found" });
  return d;
}
async function consentBlocks(sb, ev, featured) {
  if (!featured || !featured.length) return [];
  const rows = await inChunks(featured, (chunk) => run(sb.from("gfs_roster").select("*").in("id", chunk)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return featured
    .map((id) => {
      const r = byId.get(id);
      const why = r && r.event_id === ev.id ? G.featureBlock(r) : "not_on_roster";
      return why ? { roster_row: id, team: r ? r.team : null, jersey: r ? r.jersey : null, why } : null;
    })
    .filter(Boolean);
}

router.patch("/events/:id/deliverables/:did", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const d = await loadDeliverable(sb, ev, req, res);
    if (!d) return;
    const b = req.body || {};
    if (d.status === "submitted" && (b.delivered !== undefined || b.featured !== undefined)) return res.status(409).json({ error: "in_review", hint: "It's with an approver. Wait for a decision, or ask them to send it back." });
    const patch = {};
    if (b.delivered !== undefined) {
      const n = Number(b.delivered);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return res.status(400).json({ error: "invalid_count" });
      if (n < d.approved_count) return res.status(409).json({ error: "gfs_deliverable_below_approved" });
      patch.delivered = n;
    }
    if (b.required !== undefined) {
      if (!atLeast(req, "approver")) return res.status(403).json({ error: "role_too_low", need: "approver" });
      const n = Number(b.required);
      if (!Number.isInteger(n) || n < 0 || n > 1000) return res.status(400).json({ error: "invalid_count" });
      patch.required = n;
    }
    if (b.late_cause !== undefined) patch.late_cause = G.clean(b.late_cause, 200) || null;
    if (b.featured !== undefined) {
      const list = (Array.isArray(b.featured) ? b.featured : []).map(String).filter((x) => UUID.test(x));
      const uniq = [...new Set(list)].slice(0, 200);
      const rows = uniq.length ? await inChunks(uniq, (chunk) => run(sb.from("gfs_roster").select("id,event_id").in("id", chunk))) : [];
      if (rows.filter((r) => r.event_id === ev.id).length !== uniq.length) return res.status(400).json({ error: "not_on_this_roster" });
      patch.featured = uniq;
    }
    const next = { ...d, ...patch };
    if (next.delivered < next.required && next.delivered_at) patch.delivered_at = null;
    else if (next.required > 0 && next.delivered >= next.required && !next.delivered_at) patch.delivered_at = now();
    const updated = await run(sb.from("gfs_deliverables").update(patch).eq("id", d.id).select("*").single());
    res.json({ deliverable: deliverableView(updated, ev) });
  } catch (e) {
    fail(res, e, "update_deliverable");
  }
});

router.post("/events/:id/deliverables/:did/submit", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const d = await loadDeliverable(sb, ev, req, res);
    if (!d) return;
    if (!d.publishes) return res.status(400).json({ error: "not_for_approval", hint: "This one doesn't post on Pylon's channels. Mark it done instead." });
    if (d.status === "submitted") return res.status(409).json({ error: "already_submitted" });
    if (d.delivered <= d.approved_count) return res.status(409).json({ error: "gfs_deliverable_nothing_new" });
    const info = G.deliverableInfo(d.kind);
    if (info.featured && !(d.featured || []).length) return res.status(409).json({ error: "featured_required", hint: "Name the athletes it features, so their consent can be checked." });
    const blocks = await consentBlocks(sb, ev, d.featured);
    if (blocks.length) return res.status(409).json({ error: "gfs_featured_consent", blocks });
    const updated = await run(sb.from("gfs_deliverables").update({ status: "submitted", submitted_by: actor(req), submitted_at: now() }).eq("id", d.id).select("*").single());
    await T.logActivity(actor(req), "gfs_submitted", ev.code, { kind: d.kind, day: d.day || undefined, pieces: d.delivered - d.approved_count });
    notify(regionEmails(ev.region, "approver"), { title: `${info.name} is waiting for approval`, body: `${ev.name} · ${d.delivered - d.approved_count} to clear for Pylon's channels`, url: `/app/#gfs-deliver/${ev.id}`, tag: `gfs-approve-${d.id}` });
    res.json({ deliverable: deliverableView(updated, ev) });
  } catch (e) {
    fail(res, e, "submit_deliverable");
  }
});

router.post("/events/:id/deliverables/:did/approve", approver, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const d = await loadDeliverable(sb, ev, req, res);
    if (!d) return;
    if (d.status !== "submitted") return res.status(409).json({ error: "not_submitted" });
    const blocks = await consentBlocks(sb, ev, d.featured);
    if (blocks.length) return res.status(409).json({ error: "gfs_featured_consent", blocks });
    const updated = await run(sb.from("gfs_deliverables").update({ status: "approved", decided_by: actor(req), decided_at: now(), approved_count: d.delivered, note: null }).eq("id", d.id).select("*").single());
    const info = G.deliverableInfo(d.kind);
    await T.logActivity(actor(req), "gfs_approved", ev.code, { kind: d.kind, day: d.day || undefined, pieces: d.delivered - d.approved_count });
    if (d.submitted_by && d.submitted_by !== actor(req)) notify([d.submitted_by], { title: `${info.name} is approved`, body: `${ev.name} · cleared for Pylon's channels`, url: `/app/#gfs-deliver/${ev.id}`, tag: `gfs-approve-${d.id}` });
    res.json({ deliverable: deliverableView(updated, ev) });
  } catch (e) {
    fail(res, e, "approve_deliverable");
  }
});

router.post("/events/:id/deliverables/:did/changes", approver, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const d = await loadDeliverable(sb, ev, req, res);
    if (!d) return;
    if (d.status !== "submitted") return res.status(409).json({ error: "not_submitted" });
    const note = G.clean(req.body && req.body.note, 300);
    if (!note) return res.status(400).json({ error: "note_required", hint: "Say what needs to change." });
    const updated = await run(sb.from("gfs_deliverables").update({ status: "changes", decided_by: actor(req), decided_at: now(), note }).eq("id", d.id).select("*").single());
    const info = G.deliverableInfo(d.kind);
    await T.logActivity(actor(req), "gfs_changes_asked", ev.code, { kind: d.kind, day: d.day || undefined });
    if (d.submitted_by && d.submitted_by !== actor(req)) notify([d.submitted_by], { title: `${info.name} needs changes`, body: `${ev.name} · open it for the approver's note`, url: `/app/#gfs-deliver/${ev.id}`, tag: `gfs-approve-${d.id}` });
    res.json({ deliverable: deliverableView(updated, ev) });
  } catch (e) {
    fail(res, e, "changes_deliverable");
  }
});

router.post("/events/:id/deliverables/:did/done", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const d = await loadDeliverable(sb, ev, req, res);
    if (!d) return;
    if (d.publishes) return res.status(400).json({ error: "needs_approval", hint: "This one posts on Pylon's channels, so an approver clears it." });
    if (d.status === "done") return res.json({ deliverable: deliverableView(d, ev) });
    if (d.delivered < d.required) return res.status(409).json({ error: "gfs_deliverable_short", hint: `Log ${d.required} before marking it done.` });
    // Interviews and tracked Top Performers feature athletes: capture and
    // marketing consent for each, posted or not (Schedule C-1 "Consent").
    if (G.deliverableInfo(d.kind).featured) {
      if (!(d.featured || []).length) return res.status(409).json({ error: "featured_required", hint: "Name the athletes it features, so their consent can be checked." });
      const blocks = await consentBlocks(sb, ev, d.featured);
      if (blocks.length) return res.status(409).json({ error: "gfs_featured_consent", blocks });
    }
    const updated = await run(sb.from("gfs_deliverables").update({ status: "done" }).eq("id", d.id).select("*").single());
    await T.logActivity(actor(req), "gfs_delivered", ev.code, { kind: d.kind });
    res.json({ deliverable: deliverableView(updated, ev) });
  } catch (e) {
    fail(res, e, "done_deliverable");
  }
});

router.post("/events/:id/deliverables/:did/reopen", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const d = await loadDeliverable(sb, ev, req, res);
    if (!d) return;
    if (d.status !== "done") return res.status(409).json({ error: "not_done" });
    const updated = await run(sb.from("gfs_deliverables").update({ status: "open" }).eq("id", d.id).select("*").single());
    res.json({ deliverable: deliverableView(updated, ev) });
  } catch (e) {
    fail(res, e, "reopen_deliverable");
  }
});

// ── Creators ─────────────────────────────────────────────────────────────
const CREDENTIAL_FIELDS = ["contract_signed_on", "background_check_on", "safety_training_on", "tier", "lead_scout", "shadow_events"];
function readCreator(b, req, prev) {
  const out = {};
  const errors = [];
  if (b.name !== undefined || !prev) {
    const v = G.clean(b.name, 80);
    if (!v) errors.push("name");
    out.name = v;
  }
  if (b.email !== undefined) {
    const e = String(b.email || "").trim().toLowerCase();
    if (e && (!EMAIL_RE.test(e) || e.length > 200)) errors.push("email");
    out.email = e || null;
  }
  if (b.region !== undefined || !prev) {
    if (!G.REGIONS[b.region]) errors.push("region");
    else if (!G.canSee(req.team, b.region)) errors.push("region_not_yours");
    out.region = b.region;
  }
  if (b.home_city !== undefined) out.home_city = G.clean(b.home_city, 80) || null;
  if (b.notes !== undefined) out.notes = G.clean(b.notes, 500) || null;
  if (b.status !== undefined) {
    if (!["active", "paused", "inactive"].includes(b.status)) errors.push("status");
    out.status = b.status;
  }
  // Screening is GFS ops' call (Creator Playbook steps 4 and the checklist):
  // only the owner records contracts, checks, training and the tier.
  const creds = CREDENTIAL_FIELDS.filter((k) => b[k] !== undefined);
  if (creds.length && !req.team.owner) errors.push("credentials_owner_only");
  for (const k of ["contract_signed_on", "background_check_on", "safety_training_on"]) {
    if (b[k] === undefined) continue;
    if (b[k] !== null && b[k] !== "" && (!G.isDate(b[k]) || b[k] > today())) errors.push(k);
    out[k] = b[k] || null;
  }
  if (b.tier !== undefined) {
    if (!["adult", "youth"].includes(b.tier)) errors.push("tier");
    out.tier = b.tier;
  }
  if (b.lead_scout !== undefined) out.lead_scout = !!b.lead_scout;
  if (b.shadow_events !== undefined) {
    const n = Number(b.shadow_events);
    if (!Number.isInteger(n) || n < 0 || n > 50) errors.push("shadow_events");
    out.shadow_events = n;
  }
  const tier = out.tier || (prev && prev.tier) || "adult";
  const lead = out.lead_scout !== undefined ? out.lead_scout : prev && prev.lead_scout;
  if (tier === "youth" && lead) errors.push("youth_lead_scout");
  return { out, errors };
}
async function uniqueCreatorCode(sb) {
  for (let i = 0; i < 20; i++) {
    const c = G.code(5);
    const hit = await run(sb.from("gfs_creators").select("id").eq("code", c).maybeSingle());
    if (!hit) return c;
  }
  throw new Error("no_code");
}

async function scorecards(sb, creatorIds, quarter) {
  if (!creatorIds.length) return new Map();
  const uploads = await inChunks(creatorIds, (chunk) => all(() => sb.from("gfs_uploads").select("event_id,game,angle,creator_id,final_whistle_at,uploaded_at,usable,created_at").in("creator_id", chunk).gte("created_at", quarter.from).lt("created_at", quarter.to)), 50);
  const eventIds = [...new Set(uploads.map((u) => u.event_id))];
  const allGameUploads = eventIds.length ? await inChunks(eventIds, (chunk) => all(() => sb.from("gfs_uploads").select("event_id,game,angle").in("event_id", chunk))) : [];
  const angles = G.angleMap(allGameUploads);
  // Ratings are entered after an event, from SportsClippers' statements.
  const ratings = await inChunks(creatorIds, (chunk) => all(() => sb.from("gfs_crew").select("creator_id,family_rating,rating_count,updated_at").in("creator_id", chunk).gte("updated_at", quarter.from).lt("updated_at", quarter.to)), 50);
  const out = new Map();
  for (const id of creatorIds) out.set(id, G.scorecard(uploads.filter((u) => u.creator_id === id), ratings.filter((r) => r.creator_id === id), angles));
  return out;
}

router.get("/creators", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const regions = regionFilter(req, res);
    if (!regions) return;
    const pool = regions.length ? await all(() => sb.from("gfs_creators").select("*").in("region", regions).order("name", { ascending: true })) : [];
    const quarter = G.quarterOf();
    const cards = await scorecards(sb, pool.map((c) => c.id), quarter);
    res.json({ quarter, standard: G.STANDARD, creators: pool.map((c) => ({ ...creatorView(c, req), scorecard: cards.get(c.id) })) });
  } catch (e) {
    fail(res, e, "list_creators");
  }
});

router.post("/creators", member, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const { out, errors } = readCreator(req.body || {}, req, null);
  if (errors.includes("credentials_owner_only")) return res.status(403).json({ error: "credentials_owner_only", hint: "Kyron records contracts, background checks and training." });
  if (errors.length) return res.status(400).json({ error: "invalid_creator", fields: errors });
  try {
    const row = await run(
      sb
        .from("gfs_creators")
        .insert({ tier: "adult", lead_scout: false, shadow_events: 0, ...out, code: await uniqueCreatorCode(sb), status: out.status || "active", created_by: actor(req) })
        .select("*")
        .single()
    );
    await T.logActivity(actor(req), "gfs_creator_added", row.code, { region: row.region });
    res.json({ creator: creatorView(row, req) });
  } catch (e) {
    fail(res, e, "add_creator");
  }
});

router.patch("/creators/:id", member, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    if (!UUID.test(String(req.params.id))) return res.status(404).json({ error: "not_found" });
    const prev = await run(sb.from("gfs_creators").select("*").eq("id", req.params.id).maybeSingle());
    if (!prev || !G.canSee(req.team, prev.region)) return res.status(404).json({ error: "not_found" });
    const { out, errors } = readCreator(req.body || {}, req, prev);
    if (errors.includes("credentials_owner_only")) return res.status(403).json({ error: "credentials_owner_only", hint: "Kyron records contracts, background checks and training." });
    if (errors.length) return res.status(400).json({ error: "invalid_creator", fields: errors });
    if (!Object.keys(out).length) return res.json({ creator: creatorView(prev, req) });
    out.updated_at = now();
    const row = await run(sb.from("gfs_creators").update(out).eq("id", prev.id).select("*").single());
    await T.logActivity(actor(req), "gfs_creator_changed", row.code, { fields: Object.keys(out).filter((k) => k !== "updated_at") });
    res.json({ creator: creatorView(row, req) });
  } catch (e) {
    fail(res, e, "update_creator");
  }
});

router.get("/scorecards", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const regions = regionFilter(req, res);
    if (!regions) return;
    let quarter = G.quarterOf();
    if (req.query.quarter === "previous") quarter = G.quarterOf(new Date(Date.parse(quarter.from + "T00:00:00Z") - 86400000));
    const pool = regions.length ? await all(() => sb.from("gfs_creators").select("*").in("region", regions).eq("status", "active").order("name", { ascending: true })) : [];
    const cards = await scorecards(sb, pool.map((c) => c.id), quarter);
    const people = pool.map((c) => ({ id: c.id, name: c.name, code: c.code, region: c.region, home_city: c.home_city || null, tier: c.tier, badges: G.credentialBadges(c), scorecard: cards.get(c.id) }));
    const rollup = regions.map((r) => {
      const ps = people.filter((p) => p.region === r);
      const avg = (k) => {
        const v = ps.map((p) => p.scorecard[k]).filter((x) => x !== null);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      };
      return { region: r, region_name: G.REGIONS[r], creators: ps.length, on_standard: ps.filter((p) => p.scorecard.on_standard).length, with_games: ps.filter((p) => p.scorecard.games > 0).length, on_time: avg("on_time"), angles_hit: avg("angles_hit"), usable: avg("usable"), rating: avg("rating") };
    });
    res.json({ quarter, standard: G.STANDARD, creators: people, regions: rollup });
  } catch (e) {
    fail(res, e, "scorecards");
  }
});

// ── Takedowns ────────────────────────────────────────────────────────────
function takedownView(t, events, outByRid) {
  const ev = events.get(t.event_id);
  const steps = [
    { key: "pylon", label: "Off Pylon's channels", due_at: t.pylon_due_at, done_at: t.pylon_done_at || null },
    { key: "other", label: "Off every other surface, SportsClippers included", due_at: t.other_due_at, done_at: t.other_done_at || null },
    { key: "offsite", label: "Removal asked of accounts Pylon doesn't run", due_at: t.offsite_due_at, done_at: t.offsite_requested_at || null },
  ];
  const open = steps.filter((s) => !s.done_at);
  return {
    id: t.id,
    number: t.number || null,
    event: ev ? { id: ev.id, code: ev.code, name: ev.name } : null,
    region: t.region,
    team: t.team || null,
    reason: t.reason,
    reason_name: (G.TAKEDOWN[t.reason] || {}).label || t.reason,
    received_at: t.received_at,
    status: t.status,
    steps,
    next_due_at: open.length ? open.map((s) => s.due_at).sort()[0] : null,
    overdue: open.some((s) => new Date(s.due_at).getTime() < Date.now()),
    clips_out: outByRid ? outByRid.get(t.roster_id) || 0 : 0,
    note: t.note || null,
  };
}
async function clipsOut(sb, rosterIds) {
  const out = new Map();
  if (!rosterIds.length) return out;
  const rows = await inChunks(rosterIds, (chunk) => run(sb.from("gfs_roster").select("id,roster_id").in("roster_id", chunk)));
  const rid = new Map(rows.map((r) => [r.id, r.roster_id]));
  const ids = rows.map((r) => r.id);
  const clips = ids.length ? await inChunks(ids, (chunk) => all(() => sb.from("gfs_clips").select("id,roster_row,listed_at,delivered_at,removed_at").in("roster_row", chunk))) : [];
  for (const c of clips) {
    if ((c.listed_at || c.delivered_at) && !c.removed_at) out.set(rid.get(c.roster_row), (out.get(rid.get(c.roster_row)) || 0) + 1);
  }
  return out;
}

router.get("/takedowns", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const regions = regionFilter(req, res);
    if (!regions) return;
    if (!regions.length) return res.json({ takedowns: [] });
    let q = sb.from("gfs_takedowns").select("*").in("region", regions);
    const status = String(req.query.status || "open");
    if (status !== "all") q = q.eq("status", status === "done" ? "done" : "open");
    const rows = await run(q.order("received_at", { ascending: false }).limit(200));
    const evIds = [...new Set(rows.map((t) => t.event_id).filter(Boolean))];
    const events = new Map((evIds.length ? await run(sb.from("gfs_events").select("id,code,name").in("id", evIds)) : []).map((e) => [e.id, e]));
    const out = await clipsOut(sb, [...new Set(rows.filter((t) => t.status === "open").map((t) => t.roster_id))]);
    const list = rows.map((t) => takedownView(t, events, out));
    list.sort((a, b) => (a.status === b.status ? String(a.next_due_at || "~").localeCompare(String(b.next_due_at || "~")) : a.status === "open" ? -1 : 1));
    res.json({ takedowns: list, windows: G.TAKEDOWN });
  } catch (e) {
    fail(res, e, "list_takedowns");
  }
});

router.post("/takedowns", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const b = req.body || {};
    if (!G.TAKEDOWN[b.reason]) return res.status(400).json({ error: "invalid_reason", allowed: Object.keys(G.TAKEDOWN) });
    const ev = await loadEvent(sb, req, res, b.event_id);
    if (!ev) return;
    if (!UUID.test(String(b.roster_row || ""))) return res.status(400).json({ error: "athlete_required", hint: "Pick the athlete from this event's roster." });
    const row = await run(sb.from("gfs_roster").select("*").eq("id", b.roster_row).eq("event_id", ev.id).maybeSingle());
    if (!row) return res.status(400).json({ error: "not_on_this_roster" });
    let received = now();
    if (b.received_at) {
      const t = Date.parse(b.received_at);
      if (isNaN(t) || t > Date.now() + 5 * 60000 || t < Date.now() - 30 * 86400000) return res.status(400).json({ error: "invalid_received_at" });
      received = new Date(t).toISOString();
    }
    const insert = {
      event_id: ev.id,
      region: ev.region,
      roster_id: row.roster_id,
      team: row.team,
      reason: b.reason,
      received_at: received,
      ...G.takedownDue(b.reason, received),
      status: "open",
      logged_by: actor(req),
      note: G.clean(b.note, 300) || null,
    };
    const t = await run(sb.from("gfs_takedowns").insert(insert).select("*").single());
    // The athlete goes do-not-publish at every event (the database does this
    // too, through migration 024's trigger).
    const rows = await run(sb.from("gfs_roster").select("*").eq("roster_id", row.roster_id));
    for (const r of rows) {
      await run(sb.from("gfs_roster").update({ takedown_at: r.takedown_at || received, do_not_publish: true }).eq("id", r.id));
      await run(sb.from("gfs_clips").update({ held: true, hold_reason: "takedown" }).eq("roster_row", r.id));
    }
    const out = await clipsOut(sb, [row.roster_id]);
    const view = takedownView(t, new Map([[ev.id, ev]]), out);
    await T.logActivity(actor(req), "gfs_takedown_logged", ev.code, { number: t.number || undefined, reason: b.reason });
    const w = G.TAKEDOWN[b.reason];
    notify(regionEmails(ev.region, "member"), { title: `Takedown${t.number ? " #" + t.number : ""} · ${w.label}`, body: `${ev.name} · off Pylon's channels within ${w.pylon} hours, everywhere else within ${w.other}`, url: `/app/#gfs-desk`, tag: `gfs-takedown-${t.id}` });
    res.json({ takedown: view });
  } catch (e) {
    fail(res, e, "log_takedown");
  }
});

router.patch("/takedowns/:id", member, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    if (!UUID.test(String(req.params.id))) return res.status(404).json({ error: "not_found" });
    const t = await run(sb.from("gfs_takedowns").select("*").eq("id", req.params.id).maybeSingle());
    if (!t || !G.canSee(req.team, t.region)) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    const patch = {};
    const at = now();
    if (b.pylon_done === true && !t.pylon_done_at) Object.assign(patch, { pylon_done_at: at, pylon_done_by: actor(req) });
    if (b.other_done === true && !t.other_done_at) Object.assign(patch, { other_done_at: at, other_done_by: actor(req) });
    if (b.offsite_requested === true && !t.offsite_requested_at) Object.assign(patch, { offsite_requested_at: at, offsite_requested_by: actor(req) });
    if (b.note !== undefined) patch.note = G.clean(b.note, 300) || null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing_to_change" });
    const next = { ...t, ...patch };
    patch.status = next.pylon_done_at && next.other_done_at && next.offsite_requested_at ? "done" : "open";
    const updated = await run(sb.from("gfs_takedowns").update(patch).eq("id", t.id).select("*").single());
    // "Every other surface" includes SportsClippers and family links: the
    // athlete's clips there are marked removed.
    if (patch.other_done_at) {
      const rows = await run(sb.from("gfs_roster").select("id").eq("roster_id", t.roster_id));
      for (const r of rows) {
        const clips = await all(() => sb.from("gfs_clips").select("id,listed_at,delivered_at,removed_at").eq("roster_row", r.id));
        const ids = clips.filter((c) => (c.listed_at || c.delivered_at) && !c.removed_at).map((c) => c.id);
        await inChunks(ids, (chunk) => run(sb.from("gfs_clips").update({ removed_at: at }).in("id", chunk)));
      }
    }
    const events = new Map();
    if (updated.event_id) {
      const ev = await run(sb.from("gfs_events").select("id,code,name").eq("id", updated.event_id).maybeSingle());
      if (ev) events.set(ev.id, ev);
    }
    await T.logActivity(actor(req), "gfs_takedown_step", (events.get(updated.event_id) || {}).code || null, { number: updated.number || undefined, steps: Object.keys(patch).filter((k) => k.endsWith("_at")) });
    res.json({ takedown: takedownView(updated, events, await clipsOut(sb, [t.roster_id])) });
  } catch (e) {
    fail(res, e, "update_takedown");
  }
});

// ── Today and the desk ───────────────────────────────────────────────────
router.get("/today", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const regions = G.regionsOf(req.team);
    if (!regions.length) return res.json({ needs: [], next: null, upcoming: [], regions });
    const from = G.addDays(today(), -10);
    const events = await run(sb.from("gfs_events").select("*").in("region", regions).gte("ends_on", from).neq("status", "cancelled").order("starts_on", { ascending: true }).limit(200));
    const ids = events.map((e) => e.id);
    const [crew, dels, tds] = await Promise.all([
      ids.length ? inChunks(ids, (c) => run(sb.from("gfs_crew").select("event_id,role,status").in("event_id", c))) : [],
      ids.length ? inChunks(ids, (c) => run(sb.from("gfs_deliverables").select("*").in("event_id", c))) : [],
      run(sb.from("gfs_takedowns").select("*").in("region", regions).eq("status", "open")),
    ]);
    const byId = new Map(events.map((e) => [e.id, e]));
    const needs = [];
    for (const t of tds) needs.push({ kind: "takedown", ...takedownView(t, byId, null) });
    const soon = Date.now() + 3 * 86400000;
    for (const ev of events) {
      const start = G.zonedToUtc(ev.starts_on, "00:00", ev.tz).getTime();
      if (start < Date.now() - 86400000 || start > soon) continue;
      const gaps = checklist(ev, crew.filter((c) => c.event_id === ev.id)).filter((x) => !x.done);
      if (gaps.length) needs.push({ kind: "event_gaps", event: eventView(ev, req), gaps: gaps.map((g) => g.label) });
    }
    for (const d of dels) {
      const ev = byId.get(d.event_id);
      if (!ev) continue;
      const v = deliverableView(d, ev);
      if (d.status === "submitted" && atLeast(req, "approver")) needs.push({ kind: "approve", event: eventView(ev, req), deliverable: v });
      else if (d.status === "changes" && (d.submitted_by === actor(req) || ev.director_email === actor(req))) needs.push({ kind: "changes", event: eventView(ev, req), deliverable: v });
      else if (v.late && !v.cleared && ev.status !== "cancelled" && (atLeast(req, "approver") || ev.director_email === actor(req) || !ev.director_email)) needs.push({ kind: "overdue", event: eventView(ev, req), deliverable: v });
    }
    const order = { takedown: 0, approve: 1, changes: 2, event_gaps: 3, overdue: 4 };
    needs.sort((a, b) => order[a.kind] - order[b.kind]);
    const upcoming = events.filter((e) => new Date(e.ends_at).getTime() + 24 * 3600000 > Date.now() && e.status !== "closed");
    const next = upcoming[0] || null;
    const names = await namesFor(sb, upcoming.slice(0, 4).map((e) => e.director_email));
    res.json({
      needs: needs.slice(0, 30),
      next: next ? { ...eventView(next, req, names), checklist: checklist(next, crew.filter((c) => c.event_id === next.id)) } : null,
      upcoming: upcoming.slice(1, 4).map((e) => eventView(e, req, names)),
      regions,
    });
  } catch (e) {
    fail(res, e, "today");
  }
});

router.get("/desk", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const regions = regionFilter(req, res);
    if (!regions) return;
    const win = String(req.query.window || "default");
    let from = G.addDays(today(), -14);
    let to = G.addDays(today(), 30);
    if (win === "weekend") {
      // This weekend, Friday to Sunday (the one under way, or the next).
      const dow = new Date(today() + "T00:00:00Z").getUTCDay();
      from = G.addDays(today(), dow === 6 ? -1 : dow === 0 ? -2 : 5 - dow);
      to = G.addDays(from, 2);
    }
    let q = regions.length ? sb.from("gfs_events").select("*").in("region", regions).gte("ends_on", from).lte("starts_on", to).neq("status", "cancelled") : null;
    if (q && req.query.series) q = q.eq("series", G.clean(req.query.series, 60));
    const events = q ? await run(q.order("starts_on", { ascending: true }).limit(200)) : [];
    const ids = events.map((e) => e.id);
    const counts = await eventCounts(sb, ids);
    const dels = ids.length ? await inChunks(ids, (c) => run(sb.from("gfs_deliverables").select("*").in("event_id", c))) : [];
    const tds = regions.length ? await run(sb.from("gfs_takedowns").select("*").in("region", regions).eq("status", "open")) : [];
    const names = await namesFor(sb, events.map((e) => e.director_email));
    const byId = new Map(events.map((e) => [e.id, e]));
    const allTdEvents = [...new Set(tds.map((t) => t.event_id).filter((x) => x && !byId.has(x)))];
    for (const e of allTdEvents.length ? await run(sb.from("gfs_events").select("id,code,name").in("id", allTdEvents)) : []) byId.set(e.id, e);
    const rows = events.map((ev) => {
      const c = counts.get(ev.id);
      const mine = dels.filter((d) => d.event_id === ev.id).map((d) => deliverableView(d, ev));
      return {
        event: eventView(ev, req, names),
        ...c,
        waiting: mine.filter((d) => d.status === "submitted").length,
        overdue: mine.filter((d) => d.late && !d.cleared).length,
        waiting_items: mine.filter((d) => d.status === "submitted").map((d) => ({ id: d.id, name: d.name, pieces: d.to_submit })),
      };
    });
    const pool = regions.length ? await all(() => sb.from("gfs_creators").select("*").in("region", regions).eq("status", "active")) : [];
    const quarter = G.quarterOf();
    const cards = await scorecards(sb, pool.map((c) => c.id), quarter);
    const below = pool
      .map((c) => ({ id: c.id, name: c.name, region: c.region, scorecard: cards.get(c.id), badges: G.credentialBadges(c) }))
      .filter((c) => (c.scorecard.games && !c.scorecard.on_standard) || c.badges.some((b) => !b.ok && b.key !== "youth"));
    const tdViews = tds.map((t) => takedownView(t, byId, null)).sort((a, b) => String(a.next_due_at || "~").localeCompare(String(b.next_due_at || "~")));
    res.json({
      window: { from, to, name: win },
      regions,
      totals: {
        waiting: rows.reduce((s, r) => s + r.waiting, 0),
        unmatched: rows.reduce((s, r) => s + r.unmatched, 0),
        held: rows.reduce((s, r) => s + r.held, 0),
        needs_removal: rows.reduce((s, r) => s + r.needs_removal, 0),
        overdue: rows.reduce((s, r) => s + r.overdue, 0),
        takedowns_open: tds.length,
        next_takedown_due_at: tdViews.length ? tdViews[0].next_due_at : null,
      },
      rows,
      takedowns: tdViews.slice(0, 20),
      creators: { quarter, total: pool.length, with_games: pool.filter((c) => cards.get(c.id).games > 0).length, on_standard: pool.filter((c) => cards.get(c.id).on_standard).length, attention: below.slice(0, 12) },
      sportsclippers: { share: "75% of net to GFS; SportsClippers keeps 25% (hosting, payment processing, delivery)", payouts: "[Weekly], with a statement for each sale", data_rule: "Roster ID, jersey, position, team, event and consent flags. Never birth dates or contact details." },
    });
  } catch (e) {
    fail(res, e, "desk");
  }
});

module.exports = router;
