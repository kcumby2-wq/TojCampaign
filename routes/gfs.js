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
//   POST   /api/gfs/events/import                     Pylon's calendar as a CSV             approver
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
//   GET    /api/gfs/events/:id/families.csv           roster ID → approved clips (exports)  member
//   POST   /api/gfs/events/:id/clips/delivered        exported clips → sent to families     member
//   POST   /api/gfs/events/:id/clips/removed          taken off every surface               member
//   GET    /api/gfs/events/:id/listings.csv           the SportsClippers file (exports)     approver
//   POST   /api/gfs/events/:id/clips/listed           exported clips → listed               approver
//   POST   /api/gfs/events/:id/clips/family-only      public listings that lost it → family approver
//   GET    /api/gfs/events/:id/keep-out               who can't appear on Pylon's channels  member
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
// A takedown follows the athlete: anyone whose regions include an event the
// athlete is on sees it, and each region takes down its own clips.
//
// Nothing here posts, lists or messages anyone: listings and family links go
// out through SportsClippers, posts through Pylon's own channels. Logs and
// notifications carry event codes and counts, never an athlete's identity.
// Activity entries carry the event's region, so the feed shows each person
// only their regions.

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
// The id is the last sort key, so pages don't shift between requests.
async function all(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const rows = await run(build().order("id", { ascending: true }).range(from, from + PAGE - 1));
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
// the directors whose regions include it (any of them, for a list).
async function regionEmails(region, minRole = "member") {
  const regions = [].concat(region).filter(Boolean);
  const out = new Set(staffEmails());
  const sb = getSupabase();
  if (!sb) return [...out];
  const rows = await run(sb.from("team_members").select("email,role,tools,regions,status").eq("status", "active"));
  for (const m of rows || []) {
    if (!(m.tools || []).includes("gfs") || T.ROLE_RANK[m.role] < T.ROLE_RANK[minRole]) continue;
    if (m.role === "approver" || (m.regions || []).some((r) => regions.includes(r))) out.add(m.email);
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
function crewView(row, creator, req, ev) {
  const active = ["invited", "confirmed"].includes(row.status);
  return {
    id: row.id,
    role: row.role,
    role_name: G.CREW_ROLES[row.role] || row.role,
    status: row.status,
    note: row.note || null,
    family_rating: row.family_rating == null ? null : Number(row.family_rating),
    rating_count: row.rating_count == null ? null : row.rating_count,
    on_site: G.ON_SITE.includes(row.role),
    // Screening that lapsed (or a pause) since they were crewed: they don't
    // count toward the crew until it's fixed.
    problems: active && ev ? G.credentialProblems(creator, ev, row.role) : [],
    creator: creator ? creatorView(creator, req, ev) : null,
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
// The four checks before an event. A crew member counts only while they're
// screened for this event (a check that lapsed, or a pause, takes them out of
// the count), and the crew isn't ready while a youth creator lacks a screened
// adult on site. creators: Map of creator id → row.
function checklist(ev, crew, creators) {
  const start = G.zonedToUtc(ev.starts_on, "00:00", ev.tz).getTime();
  const at = (h) => new Date(start - h * 3600000).toISOString();
  const valid = (c) => !G.credentialProblems(creators.get(c.creator_id), ev, c.role).length;
  const confirmed = crew.filter((c) => c.status === "confirmed");
  const onSite = confirmed.filter((c) => G.ON_SITE.includes(c.role) && valid(c));
  const lapsed = confirmed.filter((c) => !valid(c)).length;
  const lead = onSite.some((c) => c.role === "lead");
  const alone = G.youthAlone(crew, creators, ev);
  const crewDone = onSite.length >= ev.crew_target && (lead || ev.crew_target === 0) && !alone;
  const notes = [];
  if (ev.crew_target && !lead) notes.push("no lead yet");
  if (lapsed) notes.push(`${lapsed} not screened for this event`);
  if (alone) notes.push("a youth creator needs a screened adult");
  return [
    { key: "storefront", label: "QR code and storefront page", due_at: at(7 * 24), done: !!ev.storefront_ready_at, done_at: ev.storefront_ready_at || null },
    { key: "roster", label: "Roster and consent from Sports Thread", due_at: at(72), done: !!ev.roster_in_at, done_at: ev.roster_in_at || null },
    { key: "brief", label: "Crew brief sent", due_at: at(48), done: !!ev.brief_sent_at, done_at: ev.brief_sent_at || null },
    { key: "crew", label: `Crew ${onSite.length} of ${ev.crew_target} confirmed on site${notes.length ? ", " + notes.join(", ") : ""}`, due_at: at(48), done: crewDone, done_at: null, confirmed: onSite.length, target: ev.crew_target, lead, not_screened: lapsed, youth_alone: alone },
  ];
}
// The creators behind a set of crew rows.
async function creatorsFor(sb, crew) {
  const ids = [...new Set(crew.map((c) => c.creator_id).filter(Boolean))];
  const rows = ids.length ? await inChunks(ids, (chunk) => run(sb.from("gfs_creators").select("*").in("id", chunk))) : [];
  return new Map(rows.map((c) => [c.id, c]));
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
    // Named athletes: required where the piece is about them; anything that
    // posts can name the athletes it shows, and they're checked the same way.
    featured_needed: !!info.featured,
    featured_allowed: !!info.featured || !!d.publishes,
    featured: d.featured || [],
    status: d.status,
    cleared,
    submitted_at: d.submitted_at || null,
    decided_at: d.decided_at || null,
    attested: !!d.attested_at,
    note_from_approver: d.status === "changes" ? d.note || null : null,
    note: d.note || null,
  };
}

// Pipeline counts: the SQL function, or the same counts from the clips.
const ZERO_COUNTS = { shot: 0, matched: 0, unmatched: 0, not_a_player: 0, tagged: 0, edited: 0, approved: 0, delivered: 0, listed: 0, held: 0, needs_removal: 0, to_family_only: 0, to_send: 0, to_list: 0 };
function countClips(rows) {
  const c = { ...ZERO_COUNTS };
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
    if ((r.held || r.pull_reason === "no_sale_consent") && G.isOut(r)) c.needs_removal++;
    if (r.pull_reason === "not_public" && !r.held) c.to_family_only++;
    const ready = r.stage === "approved" && !r.held && !r.removed_at;
    if (ready && r.family_export_at && !r.delivered_at) c.to_send++;
    if (ready && r.exported_at && !r.listed_at) c.to_list++;
  }
  return c;
}
async function eventCounts(sb, ids) {
  const out = new Map(ids.map((id) => [id, { ...ZERO_COUNTS }]));
  if (!ids.length) return out;
  const { data, error } = await sb.rpc("gfs_event_counts", { p_events: ids });
  if (!error && Array.isArray(data)) {
    for (const r of data) out.set(r.event_id, { ...out.get(r.event_id), ...r });
    return out;
  }
  for (const id of ids) {
    const rows = await all(() => sb.from("gfs_clips").select("id,event_id,match,stage,held,pull_reason,family_export_at,delivered_at,exported_at,listed_at,removed_at").eq("event_id", id));
    out.set(id, countClips(rows));
  }
  return out;
}

// Re-check every matched clip's hold and pull reason against the roster (the
// database does this itself through migration 024; this keeps the answer
// right either way).
async function refreshHolds(sb, ev, rosterById) {
  const clips = await all(() => sb.from("gfs_clips").select("id,roster_row,held,hold_reason,retag,pull_reason,listed_at,removed_at,visibility").eq("event_id", ev.id).eq("match", "matched"));
  const groups = new Map(); // one update per distinct hold and pull
  for (const c of clips) {
    const row = rosterById.get(c.roster_row);
    const hold = G.clipHold(row, c.retag) || null;
    const pull = G.pullReason(c, row) || null;
    if (hold === (c.hold_reason || null) && !!hold === !!c.held && pull === (c.pull_reason || null)) continue;
    const key = `${hold || ""}|${pull || ""}`;
    if (!groups.has(key)) groups.set(key, { hold, pull, ids: [] });
    groups.get(key).ids.push(c.id);
  }
  let changed = 0;
  for (const { hold, pull, ids } of groups.values()) {
    await inChunks(ids, (chunk) => run(sb.from("gfs_clips").update({ held: !!hold, hold_reason: hold, pull_reason: pull }).in("id", chunk)));
    changed += ids.length;
  }
  return changed;
}

// A roster correction (a new jersey or team) means the athlete's clips may
// show someone else. The ones not out go back to tag review (jersey-matched
// ones are matched again against the corrected roster; a director's own tags
// wait for them); the ones out stay held until they're taken down and tagged
// again. The database does the same in gfs_roster_refresh.
async function retagFor(sb, rowIds) {
  if (!rowIds.length) return { untagged: 0, held_out: 0 };
  const clips = await inChunks(rowIds, (chunk) => all(() => sb.from("gfs_clips").select("id,roster_row,team_given,delivered_at,listed_at,removed_at").in("roster_row", chunk)));
  const out = clips.filter((c) => G.isOut(c)).map((c) => c.id);
  const back = clips.filter((c) => !G.isOut(c));
  await inChunks(out, (chunk) => run(sb.from("gfs_clips").update({ retag: true, held: true, hold_reason: "roster_changed" }).in("id", chunk)));
  // team_given differs clip to clip, so these go one by one.
  await pool(back, 8, (c) => run(sb.from("gfs_clips").update({ match: "unmatched", why: "roster_changed", roster_row: null, label: null, stage: "shot", team: c.team_given || null, held: false, hold_reason: null, pull_reason: null, retag: false }).eq("id", c.id)));
  return { untagged: back.length, held_out: out.length };
}
// Run fn over items, a few at a time.
async function pool(items, size, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
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
    const crew = ids.length ? await inChunks(ids, (chunk) => all(() => sb.from("gfs_crew").select("id,event_id,creator_id,role,status").in("event_id", chunk)), 50) : [];
    const creators = await creatorsFor(sb, crew);
    const names = await namesFor(sb, events.map((e) => e.director_email));
    res.json({
      events: events.map((ev) => {
        const mine = crew.filter((c) => c.event_id === ev.id);
        const list = checklist(ev, mine, creators);
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

// One event and its Schedule C rows.
async function createEvent(sb, req, ev, wanted) {
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
  await run(sb.from("gfs_deliverables").insert(G.deliverablesFor(created).map((d) => newDeliverable(created, d))));
  await T.logActivity(actor(req), "gfs_event_created", created.code, { region: created.region, size: created.size });
  return created;
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
    const created = await createEvent(sb, req, ev, wanted);
    res.json({ event: eventView(created, req) });
  } catch (e) {
    fail(res, e, "create_event");
  }
});

// Pylon's calendar as a CSV (Schedule A of the agreement, or the 90-day
// calendar Pylon sends): one event per row. Rows already in (same city and
// first day) are skipped, so the same file can be loaded twice.
const CAL_COLUMNS = {
  name: ["name", "event", "eventname", "title"],
  series: ["series", "tour", "program"],
  size: ["size", "type", "eventtype", "format"],
  region: ["region", "territory"],
  city: ["city", "stop"],
  state: ["state", "st"],
  venue: ["venue", "location"],
  starts_on: ["startson", "start", "startdate", "firstday", "date", "dates"],
  ends_on: ["endson", "end", "enddate", "lastday"],
  wraps_at: ["wrapsat", "wrap", "wraptime", "endtime"],
  tz: ["tz", "timezone", "zone"],
  director_email: ["director", "directoremail", "lead", "leademail"],
};
function sizeOf(v) {
  const n = G.norm(v);
  if (/premier|legacy|tour|2day/.test(n)) return "premier";
  if (/clinic/.test(n)) return "clinic";
  if (/oneday|1day|quickstrike|single|tournament/.test(n)) return "one_day";
  return G.SIZES[v] ? v : null;
}
function regionOf(v) {
  const n = G.norm(v);
  return Object.keys(G.REGIONS).find((k) => G.norm(k) === n || G.norm(G.REGIONS[k]) === n) || null;
}
router.post("/events/import", approver, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const text = csvText(req, res);
  if (text == null) return;
  const { headers, rows } = G.parseTable(text);
  const { map } = G.columnMap(headers, CAL_COLUMNS);
  if (map.city === undefined || map.starts_on === undefined) return res.status(400).json({ error: "calendar_columns", hint: "Needs at least a city column and a first-day column." });
  try {
    const created = [];
    const skipped = [];
    for (let i = 0; i < Math.min(rows.length, 200); i++) {
      const r = rows[i];
      const get = (k) => (map[k] === undefined ? "" : String(r[map[k]] || "").trim());
      const city = G.clean(get("city"), 80);
      const state = get("state").toUpperCase();
      const body = {
        name: get("name") || `${get("series") ? G.clean(get("series"), 60) + " · " : ""}${city}${state ? ", " + state : ""}`,
        series: get("series") || undefined,
        size: sizeOf(get("size")) || "premier",
        region: regionOf(get("region")),
        city,
        state,
        venue: get("venue") || undefined,
        starts_on: get("starts_on"),
        ends_on: get("ends_on") || get("starts_on"),
        wraps_at: get("wraps_at") || undefined,
        tz: get("tz") || undefined,
        director_email: get("director_email") || null,
      };
      const { ev, errors } = readEventBody(body, null, req);
      if (errors.length) { skipped.push({ line: i + 2, why: errors.join(",") }); continue; }
      const same = await run(sb.from("gfs_events").select("id,city").eq("starts_on", ev.starts_on).eq("state", ev.state));
      if (same.some((x) => G.norm(x.city) === G.norm(ev.city))) { skipped.push({ line: i + 2, why: "already_in" }); continue; }
      const made = await createEvent(sb, req, ev, G.eventCode(ev.city, ev.starts_on));
      created.push({ id: made.id, code: made.code, name: made.name });
    }
    if (rows.length > 200) skipped.push({ line: 202, why: "too_many_rows" });
    res.json({ created: created.length, events: created, skipped });
  } catch (e) {
    fail(res, e, "import_calendar");
  }
});

router.get("/events/:id", viewer, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const [crew, deliverables, roster, open] = await Promise.all([
      run(sb.from("gfs_crew").select("*").eq("event_id", ev.id)),
      run(sb.from("gfs_deliverables").select("*").eq("event_id", ev.id)),
      rosterRows(sb, ev.id),
      run(sb.from("gfs_takedowns").select("*").eq("status", "open").order("received_at", { ascending: false }).limit(500)),
    ]);
    const byId = await creatorsFor(sb, crew);
    const counts = (await eventCounts(sb, [ev.id])).get(ev.id);
    const names = await namesFor(sb, [ev.director_email]);
    const teams = new Set(roster.map((r) => G.norm(r.team)));
    const order = new Map(G.DELIVERABLE_KINDS.map((k, i) => [k, i]));
    // Open takedowns for anyone on this roster, wherever they were logged.
    const rids = new Set(roster.map((r) => r.roster_id));
    const takedowns = open.filter((t) => t.event_id === ev.id || rids.has(t.roster_id));
    const tdEvents = new Map([[ev.id, ev]]);
    const others = [...new Set(takedowns.map((t) => t.event_id).filter((x) => x && x !== ev.id))];
    for (const e of others.length ? await run(sb.from("gfs_events").select("id,code,name,region").in("id", others)) : []) tdEvents.set(e.id, e);
    res.json({
      event: eventView(ev, req, names),
      checklist: checklist(ev, crew, byId),
      crew: crew.filter((c) => c.status !== "removed").map((c) => crewView(c, byId.get(c.creator_id), req, ev)),
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
      takedowns: takedowns.map((t) => takedownView(t, tdEvents, null, req)),
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
    await T.logActivity(actor(req), "gfs_event_changed", updated.code, { region: updated.region, fields: Object.keys(patch).filter((k) => k !== "ends_at") });
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
      checklist: checklist(ev, crew, byId),
      crew: crew.filter((c) => c.status !== "removed").map((c) => crewView(c, byId.get(c.creator_id), req, ev)),
      candidates: pool
        .filter((c) => c.status === "active" && !active.has(c.id))
        .sort((a, b) => (a.region === ev.region ? 0 : 1) - (b.region === ev.region ? 0 : 1) || a.name.localeCompare(b.name))
        .map((c) => ({ ...creatorView(c, req, ev), blocks: G.credentialProblems(c, ev, null), nearby: c.region === ev.region })),
    });
  } catch (e) {
    fail(res, e, "get_crew");
  }
});

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
    await T.logActivity(actor(req), "gfs_crew_added", ev.code, { region: ev.region, role: b.role, creator: c.code });
    res.json({ crew: crewView(row, c, req, ev) });
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
    // A note or a family rating (after the event, even if the creator has been
    // paused since) changes nothing about who's on the crew.
    if (next.role !== row.role || next.status !== row.status) {
      if (!["declined", "removed"].includes(next.status)) {
        const problems = G.credentialProblems(c, ev, next.role);
        if (problems.length) return res.status(409).json({ error: "credentials", problems });
        if (["declined", "removed"].includes(row.status) && crew.some((x) => x.id !== row.id && x.creator_id === row.creator_id && ["invited", "confirmed"].includes(x.status))) return res.status(409).json({ error: "already_on_crew" });
      }
      const problem = G.crewProblem(crew, creators, ev, next);
      if (problem) return res.status(409).json({ error: problem });
    }
    const updated = await run(sb.from("gfs_crew").update(patch).eq("id", row.id).select("*").single());
    if (patch.status && patch.status !== row.status) await T.logActivity(actor(req), "gfs_crew_" + patch.status, ev.code, { region: ev.region, role: updated.role, creator: c.code });
    res.json({ crew: crewView(updated, c, req, ev) });
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
    // A takedown logged at any event stands here too, even for an athlete
    // this roster is only now adding (the database does the same as the row
    // goes in).
    const rids = parsed.rows.map((r) => r.roster_id);
    const tds = rids.length ? await inChunks(rids, (chunk) => run(sb.from("gfs_takedowns").select("roster_id,received_at").in("roster_id", chunk))) : [];
    const takedownAt = new Map();
    for (const t of tds) if (!takedownAt.has(t.roster_id) || t.received_at < takedownAt.get(t.roster_id)) takedownAt.set(t.roster_id, t.received_at);
    let added = 0, updated = 0, unchanged = 0;
    const upserts = [];
    const moved = []; // existing rows whose jersey or team changed
    for (const r of parsed.rows) {
      const row = { event_id: ev.id };
      for (const k of ROSTER_KEEP) row[k] = r[k];
      const prev = byRid.get(r.roster_id);
      row.takedown_at = (prev && prev.takedown_at) || takedownAt.get(r.roster_id) || null;
      if (row.takedown_at) row.do_not_publish = true; // a takedown stands
      if (!prev) added++;
      else if (ROSTER_KEEP.some((k) => (prev[k] ?? null) !== (row[k] ?? null)) || (row.takedown_at && !prev.takedown_at)) updated++;
      else { unchanged++; continue; }
      if (prev && ((prev.jersey ?? null) !== (row.jersey ?? null) || prev.team !== row.team)) moved.push(prev.id);
      row.imported_at = now();
      upserts.push(row);
    }
    const inFile = new Set(rids);
    const missingFromFile = existing.filter((r) => !inFile.has(r.roster_id)).length;
    for (let i = 0; i < upserts.length; i += 500) await run(sb.from("gfs_roster").upsert(upserts.slice(i, i + 500), { onConflict: "event_id,roster_id" }));
    await run(sb.from("gfs_events").update({ roster_in_at: now() }).eq("id", ev.id));
    const retag = await retagFor(sb, moved);
    const fresh = await rosterRows(sb, ev.id);
    const byId = new Map(fresh.map((r) => [r.id, r]));
    const holds = await refreshHolds(sb, ev, byId);
    const rematched = await rematch(sb, ev, fresh);
    await T.logActivity(actor(req), "gfs_roster_loaded", ev.code, { region: ev.region, rows: parsed.rows.length, added, updated, renumbered: moved.length });
    res.json({
      summary: {
        rows: parsed.rows.length,
        added,
        updated,
        unchanged,
        // On file from an earlier load but not in this one: they keep the
        // permissions they had (log a takedown if a family withdrew).
        missing_from_file: missingFromFile,
        skipped: parsed.skipped.length,
        skipped_lines: parsed.skipped.slice(0, 20),
        dropped_columns: parsed.dropped,
        warnings: parsed.warnings,
        athletes: fresh.length,
        renumbered: moved.length,
        clips_back_to_review: retag.untagged,
        clips_out_held: retag.held_out,
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

// Unmatched clips get another try against the roster as it is now, except
// the ones a director decided on (tag_source "manual").
async function rematch(sb, ev, roster) {
  const index = G.rosterIndex(roster);
  const clips = await all(() => sb.from("gfs_clips").select("*").eq("event_id", ev.id).eq("match", "unmatched").neq("tag_source", "manual"));
  let n = 0;
  const changes = [];
  for (const c of clips) {
    const m = G.matchClip({ jersey: c.jersey, team: c.team_given, teamHint: c.team_hint, teams: teamsOfGame(c.game) }, index);
    if (m.match === "matched") {
      const reason = G.holdReason(m.row);
      changes.push([c.id, { match: "matched", why: null, roster_row: m.row.id, team: m.row.team, label: G.finalLabel(ev, m.row, c), held: !!reason, hold_reason: reason, retag: false }]);
      n++;
    } else if (m.why !== c.why) {
      changes.push([c.id, { why: m.why }]);
    }
  }
  // Each clip gets its own athlete and label, so these go one by one, eight
  // at a time.
  await pool(changes, 8, ([id, patch]) => run(sb.from("gfs_clips").update(patch).eq("id", id).eq("match", "unmatched")));
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
    const rosterTeams = new Set(roster.map((r) => G.norm(r.team)));
    const known = new Set((await all(() => sb.from("gfs_clips").select("id,log_key").eq("event_id", ev.id))).map((c) => c.log_key));
    const fresh = new Map();
    let already = 0;
    const tally = { matched: 0, unmatched: 0, held: 0, why: {} };
    for (const c of parsed.clips) {
      const key = G.clipKey(ev.id, c);
      if (known.has(key) || fresh.has(key)) { already++; continue; }
      // A team folder counts only when it names one of the game's teams or a
      // roster team; any other folder (an angle, a person) is dropped.
      const hint = G.teamHintOf(c, rosterTeams);
      const m = G.matchClip({ ...c, teamHint: hint }, index);
      const row = {
        event_id: ev.id,
        log_key: key,
        game: c.game ? String(c.game).slice(0, 160) : null,
        team: m.row ? m.row.team : c.team || null,
        team_given: c.team || null,
        team_hint: hint,
        folder: c.folder || null,
        file: c.file,
        angle: c.angle,
        clip_no: c.clip_no,
        jersey: c.jersey,
        creator_id: findCreator(c.creator),
        roster_row: m.row ? m.row.id : null,
        match: m.match,
        tag_source: "jersey",
        why: m.why || null,
        label: m.row ? G.finalLabel(ev, m.row, c) : null,
        held: false,
        hold_reason: null,
        retag: false,
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
    await T.logActivity(actor(req), "gfs_uploads_loaded", ev.code, { region: ev.region, clips: rows.length, games: ups.length });
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
// Viewers see that a clip is held, never why (a takedown is a family's
// private business), and never an athlete's roster ID.
function clipView(c, row, req) {
  const member = atLeast(req, "member");
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
    tag_source: c.tag_source || "jersey",
    why: c.why || null,
    label: c.label || null,
    held: !!c.held,
    hold_reason: member ? c.hold_reason || null : null,
    pull_reason: member ? c.pull_reason || null : null,
    stage: c.stage,
    delivered: !!c.delivered_at,
    listed: !!c.listed_at && !c.removed_at,
    removed: !!c.removed_at,
    out: G.isOut(c),
    visibility: c.visibility || null,
    athlete: row ? { roster_row: row.id, team: row.team, jersey: row.jersey, position: row.position || null, roster_id: member ? row.roster_id : null } : null,
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
      else if (view === "held") q = q.eq("held", true);
      else if (view === "matched") q = q.eq("match", "matched");
      else if (view === "not_a_player") q = q.eq("match", "not_a_player");
      else if (view === "out") q = q.eq("match", "matched");
      if (req.query.team) q = q.eq("team", G.clean(req.query.team, 80));
      return q.order("created_at", { ascending: true });
    };
    // "out": clips that reached a family or SportsClippers and now have to
    // come down (held, or listed without sale consent) or go family-only (a
    // short list, so it's filtered here).
    const clips = view === "out"
      ? (await all(base)).filter((c) => G.isOut(c) && (c.held || c.pull_reason)).slice(offset, offset + limit)
      : await run(base().range(offset, offset + limit - 1));
    const roster = await rosterRows(sb, ev.id);
    const byId = new Map(roster.map((r) => [r.id, r]));
    const showSuggestions = atLeast(req, "member") && view === "unmatched";
    const teams = [...new Set(roster.map((r) => r.team))].sort();
    const onRoster = new Set(roster.map((r) => G.norm(r.team)));
    res.json({
      event: eventView(ev, req),
      counts: (await eventCounts(sb, [ev.id])).get(ev.id),
      clips: clips.map((c) => {
        const hint = c.team_hint && onRoster.has(G.norm(c.team_hint)) ? c.team_hint : null;
        return { ...clipView(c, byId.get(c.roster_row), req), suggestions: showSuggestions ? G.suggestions({ jersey: c.jersey, team: c.team_given || hint, teams: teamsOfGame(c.game) }, roster) : undefined };
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
    if (G.isOut(c)) return res.status(409).json({ error: "gfs_clip_already_out", hint: "This clip has reached families or SportsClippers. Take it down first, then tag it again." });
    const b = req.body || {};
    // A director's call: re-matching leaves it alone from here on. The file's
    // own jersey number stays as filed. A clip that was taken down starts
    // over (it can go out again once it's approved again).
    const fresh = c.removed_at ? { delivered_at: null, family_export_at: null, listed_at: null, exported_at: null, export_visibility: null, visibility: null, removed_at: null } : {};
    const reset = { ...fresh, stage: "shot", tag_source: "manual", retag: false, pull_reason: null };
    let patch;
    if (b.not_a_player === true) {
      patch = { ...reset, match: "not_a_player", why: null, roster_row: null, label: null, team: c.team_given || null, held: false, hold_reason: null };
    } else if (b.untag === true) {
      patch = { ...reset, match: "unmatched", why: "untagged", roster_row: null, label: null, team: c.team_given || null, held: false, hold_reason: null };
    } else if (UUID.test(String(b.roster_row || ""))) {
      const row = await run(sb.from("gfs_roster").select("*").eq("id", b.roster_row).eq("event_id", ev.id).maybeSingle());
      if (!row) return res.status(400).json({ error: "not_on_this_roster" });
      if (row.jersey == null) return res.status(400).json({ error: "athlete_has_no_jersey" });
      const reason = G.holdReason(row);
      patch = { ...reset, match: "matched", why: null, roster_row: row.id, team: row.team, label: G.finalLabel(ev, row, c), held: !!reason, hold_reason: reason };
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
    await T.logActivity(actor(req), "gfs_tags_approved", ev.code, { region: ev.region, tagged: ready.length, unmatched: counts.unmatched });
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
    await T.logActivity(actor(req), "gfs_clips_edited", ev.code, { region: ev.region, clips: ids.length });
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
    await T.logActivity(actor(req), "gfs_clips_approved", ev.code, { region: ev.region, clips: ids.length });
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

// Marked sent only for clips that went out in a family-links file: what the
// app records is what was actually handed over.
router.post("/events/:id/clips/delivered", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const ready = (await outgoing(sb, ev)).filter((x) => !x.c.delivered_at);
    const list = ready.filter((x) => x.c.family_export_at);
    const at = now();
    await inChunks(list.map((x) => x.c.id), (chunk) => run(sb.from("gfs_clips").update({ delivered_at: at }).in("id", chunk).is("delivered_at", null)));
    const athletes = new Set(list.map((x) => x.row.id)).size;
    await T.logActivity(actor(req), "gfs_clips_delivered", ev.code, { region: ev.region, clips: list.length, athletes });
    res.json({ delivered: list.length, athletes, not_exported: ready.length - list.length });
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
    // These clips are now in a file; "Mark sent" covers exactly these.
    const stamp = list.filter((x) => !x.c.family_export_at).map((x) => x.c.id);
    const at = now();
    await inChunks(stamp, (chunk) => run(sb.from("gfs_clips").update({ family_export_at: at }).in("id", chunk).is("family_export_at", null)));
    await T.logActivity(actor(req), "gfs_families_exported", ev.code, { region: ev.region, athletes: rows.length });
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
    // Record what went out and how it was listed, so "Mark listed" marks
    // exactly these, at the visibility the file gave SportsClippers.
    const at = now();
    for (const vis of ["family", "public"]) {
      const ids = list.filter(({ c, row }) => !c.listed_at && G.visibilityFor(row) === vis).map(({ c }) => c.id);
      await inChunks(ids, (chunk) => run(sb.from("gfs_clips").update({ exported_at: at, export_visibility: vis }).in("id", chunk).is("listed_at", null)));
    }
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
    await T.logActivity(actor(req), "gfs_listings_exported", ev.code, { region: ev.region, clips: rows.length });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${ev.code}-sportsclippers.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(G.toCsv(["label", "file", "event_code", "event", "team", "jersey", "position", "roster_id", "angle", "visibility", "consent_capture", "consent_marketing", "consent_sale", "consent_commercial", "public_display", "under_13", "price_cents"], rows));
  } catch (e) {
    fail(res, e, "listings_csv");
  }
});

// Marked listed only for clips in a SportsClippers file, at the visibility
// that file gave. A clip exported as public whose guardian has since turned
// public display off isn't marked: export again, so the listing goes up
// family-only.
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
    const exported = list.filter((x) => x.c.exported_at);
    const changed = exported.filter((x) => x.c.export_visibility === "public" && G.visibilityFor(x.row) !== "public");
    const ok = exported.filter((x) => !changed.includes(x));
    const at = now();
    const tally = { family: 0, public: 0 };
    for (const vis of ["family", "public"]) {
      const ids = ok.filter((x) => (x.c.export_visibility || "family") === vis).map((x) => x.c.id);
      tally[vis] = ids.length;
      await inChunks(ids, (chunk) => run(sb.from("gfs_clips").update({ listed_at: at, visibility: vis }).in("id", chunk).is("listed_at", null)));
    }
    await T.logActivity(actor(req), "gfs_clips_listed", ev.code, { region: ev.region, ...tally });
    res.json({ listed: tally.family + tally.public, ...tally, not_exported: list.length - exported.length, changed_since_export: changed.length });
  } catch (e) {
    fail(res, e, "mark_listed");
  }
});

// Public listings the roster no longer allows as public (the guardian turned
// public display off, or the athlete turned out to be under 13): once they're
// family-only on SportsClippers, mark them here.
router.post("/events/:id/clips/family-only", approver, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    const want = Array.isArray(req.body && req.body.ids) ? new Set(req.body.ids.map(String)) : null;
    const roster = new Map((await rosterRows(sb, ev.id)).map((r) => [r.id, r]));
    const clips = await all(() => sb.from("gfs_clips").select("*").eq("event_id", ev.id).eq("visibility", "public").is("removed_at", null));
    const ids = clips
      .filter((c) => c.listed_at && !c.held && (!want || want.has(c.id)))
      .filter((c) => G.pullReason(c, roster.get(c.roster_row)) === "not_public")
      .map((c) => c.id);
    await inChunks(ids, (chunk) => run(sb.from("gfs_clips").update({ visibility: "family", export_visibility: "family", pull_reason: null }).in("id", chunk)));
    await T.logActivity(actor(req), "gfs_clips_family_only", ev.code, { region: ev.region, clips: ids.length });
    res.json({ family_only: ids.length });
  } catch (e) {
    fail(res, e, "family_only");
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
    const out = rows.filter((c) => G.isOut(c)).map((c) => c.id);
    await inChunks(out, (chunk) => run(sb.from("gfs_clips").update({ removed_at: at, pull_reason: null }).in("id", chunk).is("removed_at", null)));
    await T.logActivity(actor(req), "gfs_clips_removed", ev.code, { region: ev.region, clips: out.length });
    res.json({ removed: out.length });
  } catch (e) {
    fail(res, e, "mark_removed");
  }
});

// Who can't appear in anything that posts on Pylon's channels: on hold
// (takedown, do-not-publish, no capture consent) or without marketing
// consent. By team and jersey; an approver checks the pieces against it
// before clearing them.
router.get("/events/:id/keep-out", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const ev = await loadEvent(sb, req, res);
    if (!ev) return;
    res.json(keepOut(await rosterRows(sb, ev.id)));
  } catch (e) {
    fail(res, e, "keep_out");
  }
});
function keepOut(roster) {
  const teams = new Map();
  let total = 0, noJersey = 0;
  for (const r of roster) {
    const why = G.featureBlock(r);
    if (!why) continue;
    total++;
    if (r.jersey == null) noJersey++;
    if (!teams.has(r.team)) teams.set(r.team, []);
    teams.get(r.team).push({ roster_row: r.id, jersey: r.jersey, position: r.position || null, why });
  }
  return {
    total,
    no_jersey: noJersey,
    athletes: roster.length,
    teams: [...teams.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([team, list]) => ({ team, athletes: list.sort((a, b) => Number(a.jersey ?? 999) - Number(b.jersey ?? 999)) })),
  };
}

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
    await T.logActivity(actor(req), "gfs_submitted", ev.code, { region: ev.region, kind: d.kind, day: d.day || undefined, pieces: d.delivered - d.approved_count });
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
    // Recaps, montages, stills and cut-downs show athletes nobody names: the
    // approver checks them against the event's keep-out list and says so.
    if (!req.body || req.body.attest !== true) return res.status(409).json({ error: "attest_required", hint: "Check the pieces against the keep-out list first, then confirm that no one on it appears." });
    const blocks = await consentBlocks(sb, ev, d.featured);
    if (blocks.length) return res.status(409).json({ error: "gfs_featured_consent", blocks });
    const at = now();
    const updated = await run(sb.from("gfs_deliverables").update({ status: "approved", decided_by: actor(req), decided_at: at, attested_by: actor(req), attested_at: at, approved_count: d.delivered, note: null }).eq("id", d.id).select("*").single());
    const info = G.deliverableInfo(d.kind);
    await T.logActivity(actor(req), "gfs_approved", ev.code, { region: ev.region, kind: d.kind, day: d.day || undefined, pieces: d.delivered - d.approved_count, attested: true });
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
    await T.logActivity(actor(req), "gfs_changes_asked", ev.code, { region: ev.region, kind: d.kind, day: d.day || undefined });
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
    await T.logActivity(actor(req), "gfs_delivered", ev.code, { region: ev.region, kind: d.kind });
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
  if (prev && !req.team.owner) {
    // Once screening is on file it belongs to a person: a director can't
    // point the record at someone else.
    if (G.screeningOnFile(prev) && ((out.name !== undefined && out.name !== prev.name) || (out.email !== undefined && (out.email || null) !== (prev.email || null)))) errors.push("identity_owner_only");
    // Pausing is anyone's call; putting someone back to work is Kyron's.
    if (out.status === "active" && prev.status !== "active") errors.push("reactivate_owner_only");
  }
  return { out, errors };
}
const OWNER_ONLY = {
  credentials_owner_only: "Kyron records contracts, background checks and training.",
  identity_owner_only: "This creator's screening is on file, so Kyron changes their name or email.",
  reactivate_owner_only: "Kyron puts a paused or inactive creator back to work.",
};
function ownerOnly(res, errors) {
  const code = Object.keys(OWNER_ONLY).find((k) => errors.includes(k));
  if (!code) return false;
  res.status(403).json({ error: code, hint: OWNER_ONLY[code] });
  return true;
}
async function uniqueCreatorCode(sb) {
  for (let i = 0; i < 20; i++) {
    const c = G.code(5);
    const hit = await run(sb.from("gfs_creators").select("id").eq("code", c).maybeSingle());
    if (!hit) return c;
  }
  throw new Error("no_code");
}

// The quarter an event counts in is the quarter it ended in: uploads loaded
// late, and family ratings typed in weeks later from SportsClippers'
// statements, still count for the event's quarter.
async function scorecards(sb, creatorIds, quarter) {
  if (!creatorIds.length) return new Map();
  const events = await all(() => sb.from("gfs_events").select("id,ends_on").gte("ends_on", quarter.from).lt("ends_on", quarter.to));
  const eventIds = events.map((e) => e.id);
  const mine = new Set(creatorIds);
  const gameUploads = eventIds.length ? await inChunks(eventIds, (chunk) => all(() => sb.from("gfs_uploads").select("id,event_id,game,angle,creator_id,final_whistle_at,uploaded_at,usable").in("event_id", chunk)), 50) : [];
  const angles = G.angleMap(gameUploads);
  const uploads = gameUploads.filter((u) => mine.has(u.creator_id));
  const ratings = eventIds.length ? (await inChunks(eventIds, (chunk) => all(() => sb.from("gfs_crew").select("id,event_id,creator_id,family_rating,rating_count").in("event_id", chunk)), 50)).filter((r) => mine.has(r.creator_id)) : [];
  const out = new Map();
  for (const id of creatorIds) out.set(id, G.scorecard(uploads.filter((u) => u.creator_id === id), ratings.filter((r) => r.creator_id === id), angles));
  return out;
}
// ?quarter=previous, ?on=YYYY-MM-DD (the quarter holding that day), or now.
function quarterFor(req) {
  if (G.isDate(req.query.on)) return G.quarterOf(new Date(req.query.on + "T12:00:00Z"));
  const q = G.quarterOf();
  return req.query.quarter === "previous" ? G.quarterOf(new Date(Date.parse(q.from + "T00:00:00Z") - 86400000)) : q;
}

router.get("/creators", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const regions = regionFilter(req, res);
    if (!regions) return;
    const pool = regions.length ? await all(() => sb.from("gfs_creators").select("*").in("region", regions).order("name", { ascending: true })) : [];
    const quarter = quarterFor(req);
    const cards = await scorecards(sb, pool.map((c) => c.id), quarter);
    res.json({ quarter, standard: G.STANDARD, creators: pool.map((c) => ({ ...creatorView(c, req), scorecard: cards.get(c.id), identity_locked: G.screeningOnFile(c) && !isOwner(req) })) });
  } catch (e) {
    fail(res, e, "list_creators");
  }
});

router.post("/creators", member, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const { out, errors } = readCreator(req.body || {}, req, null);
  if (ownerOnly(res, errors)) return;
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
    if (ownerOnly(res, errors)) return;
    if (errors.length) return res.status(400).json({ error: "invalid_creator", fields: errors });
    if (!Object.keys(out).length) return res.json({ creator: creatorView(prev, req) });
    // A youth creator's roles are limited, and an adult may be the one a youth
    // creator works alongside: the tier doesn't change mid-crew.
    if (out.tier !== undefined && out.tier !== prev.tier) {
      const rows = await run(sb.from("gfs_crew").select("id,event_id,status").eq("creator_id", prev.id).in("status", ["invited", "confirmed"]));
      const evIds = [...new Set(rows.map((r) => r.event_id))];
      const upcoming = evIds.length ? (await run(sb.from("gfs_events").select("id,ends_on").in("id", evIds))).filter((e) => e.ends_on >= today()) : [];
      if (upcoming.length) return res.status(409).json({ error: "gfs_creator_on_crew", events: upcoming.length, hint: "Take them off their upcoming crews first." });
    }
    out.updated_at = now();
    const row = await run(sb.from("gfs_creators").update(out).eq("id", prev.id).select("*").single());
    await T.logActivity(actor(req), "gfs_creator_changed", row.code, { region: row.region, fields: Object.keys(out).filter((k) => k !== "updated_at") });
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
    const quarter = quarterFor(req);
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
// A takedown follows the athlete (one Sports Thread ID at every event), so who
// sees it, and whose clips it reaches, comes from every event the athlete is
// on: the region it was logged in, plus the regions of those events now.
function takedownView(t, events, outClips, req, regions) {
  const ev = events.get(t.event_id);
  const member = !req || atLeast(req, "member");
  const steps = [
    { key: "pylon", label: "Off Pylon's channels", due_at: t.pylon_due_at, done_at: t.pylon_done_at || null },
    { key: "other", label: "Off every other surface, SportsClippers included", due_at: t.other_due_at, done_at: t.other_done_at || null },
    { key: "offsite", label: "Removal asked of accounts Pylon doesn't run", due_at: t.offsite_due_at, done_at: t.offsite_requested_at || null },
  ];
  const open = steps.filter((s) => !s.done_at);
  const out = outClips ? outClips.get(t.roster_id) || [] : [];
  const mine = req ? new Set(G.regionsOf(req.team)) : null;
  return {
    id: t.id,
    number: t.number || null,
    event: ev ? { id: ev.id, code: ev.code, name: ev.name } : null,
    region: t.region,
    regions: regions ? [...regions].sort() : [t.region],
    team: t.team || null,
    // Why a family asked is theirs: viewers see that there's a takedown, not
    // the reason or the note.
    reason: member ? t.reason : null,
    reason_name: member ? (G.TAKEDOWN[t.reason] || {}).label || t.reason : null,
    received_at: t.received_at,
    status: t.status,
    steps,
    next_due_at: open.length ? open.map((s) => s.due_at).sort()[0] : null,
    overdue: open.some((s) => new Date(s.due_at).getTime() < Date.now()),
    clips_out: out.length,
    clips_out_yours: mine ? out.filter((c) => mine.has((events.get(c.event_id) || {}).region)).length : out.length,
    note: member ? t.note || null : null,
  };
}
// The athlete's clips that are still out (a family link or a listing, not
// taken down), at every event: roster ID → [{ id, event_id }].
async function outClipsFor(sb, rosterIds) {
  const out = new Map();
  if (!rosterIds.length) return out;
  const rows = await inChunks(rosterIds, (chunk) => all(() => sb.from("gfs_roster").select("id,roster_id").in("roster_id", chunk)));
  const rid = new Map(rows.map((r) => [r.id, r.roster_id]));
  const ids = rows.map((r) => r.id);
  const clips = ids.length ? await inChunks(ids, (chunk) => all(() => sb.from("gfs_clips").select("id,event_id,roster_row,listed_at,delivered_at,removed_at").in("roster_row", chunk))) : [];
  for (const c of clips) {
    if (!G.isOut(c)) continue;
    const k = rid.get(c.roster_row);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ id: c.id, event_id: c.event_id });
  }
  return out;
}
// For each takedown: the regions it reaches, and the events involved.
async function takedownScope(sb, tds) {
  const rids = [...new Set(tds.map((t) => t.roster_id))];
  const rows = rids.length ? await inChunks(rids, (chunk) => all(() => sb.from("gfs_roster").select("id,roster_id,event_id").in("roster_id", chunk))) : [];
  const evIds = [...new Set([...rows.map((r) => r.event_id), ...tds.map((t) => t.event_id).filter(Boolean)])];
  const events = new Map((evIds.length ? await inChunks(evIds, (chunk) => run(sb.from("gfs_events").select("id,code,name,region").in("id", chunk))) : []).map((e) => [e.id, e]));
  const byRid = new Map();
  for (const r of rows) {
    if (!byRid.has(r.roster_id)) byRid.set(r.roster_id, new Set());
    const e = events.get(r.event_id);
    if (e) byRid.get(r.roster_id).add(e.region);
  }
  const scope = new Map();
  for (const t of tds) {
    const set = new Set([t.region, ...(byRid.get(t.roster_id) || [])]);
    const e = events.get(t.event_id);
    if (e) set.add(e.region);
    scope.set(t.id, set);
  }
  return { scope, events };
}
// Takedowns that reach any of these regions (all regions for owners and
// approvers when none are given).
async function visibleTakedowns(sb, req, { status = "open", regions = null } = {}) {
  let q = sb.from("gfs_takedowns").select("*");
  if (status !== "all") q = q.eq("status", status);
  const tds = await run(q.order("received_at", { ascending: false }).limit(500));
  const { scope, events } = await takedownScope(sb, tds);
  const want = new Set(regions || G.regionsOf(req.team));
  const list = tds.filter((t) => [...scope.get(t.id)].some((r) => want.has(r)));
  return { list, scope, events };
}

router.get("/takedowns", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const regions = regionFilter(req, res);
    if (!regions) return;
    if (!regions.length) return res.json({ takedowns: [] });
    const status = String(req.query.status || "open");
    const { list: rows, scope, events } = await visibleTakedowns(sb, req, { status: status === "all" ? "all" : status === "done" ? "done" : "open", regions });
    const out = await outClipsFor(sb, [...new Set(rows.filter((t) => t.status === "open").map((t) => t.roster_id))]);
    const list = rows.slice(0, 200).map((t) => takedownView(t, events, out, req, scope.get(t.id)));
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
    // too, through migration 024's trigger; rosters loaded later pick it up).
    const rows = await run(sb.from("gfs_roster").select("*").eq("roster_id", row.roster_id));
    for (const r of rows) {
      await run(sb.from("gfs_roster").update({ takedown_at: r.takedown_at || received, do_not_publish: true }).eq("id", r.id));
      await run(sb.from("gfs_clips").update({ held: true, hold_reason: "takedown" }).eq("roster_row", r.id));
    }
    const { scope, events } = await takedownScope(sb, [t]);
    events.set(ev.id, ev);
    const reach = scope.get(t.id);
    const out = await outClipsFor(sb, [row.roster_id]);
    const view = takedownView(t, events, out, req, reach);
    await T.logActivity(actor(req), "gfs_takedown_logged", ev.code, { region: ev.region, number: t.number || undefined });
    const w = G.TAKEDOWN[b.reason];
    // Everyone running an event this athlete is on hears about it.
    notify(regionEmails([...reach], "member"), { title: `Takedown${t.number ? " #" + t.number : ""} · ${w.label}`, body: `${ev.name} · off Pylon's channels within ${w.pylon} hours, everywhere else within ${w.other}`, url: `/app/#gfs-desk`, tag: `gfs-takedown-${t.id}` });
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
    if (!t) return res.status(404).json({ error: "not_found" });
    const { scope, events } = await takedownScope(sb, [t]);
    const reach = scope.get(t.id);
    const mine = new Set(G.regionsOf(req.team));
    if (![...reach].some((r) => mine.has(r))) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    const patch = {};
    const at = now();
    let partial = null;
    if (b.pylon_done === true && !t.pylon_done_at) Object.assign(patch, { pylon_done_at: at, pylon_done_by: actor(req) });
    if (b.other_done === true && !t.other_done_at) {
      // "Every other surface" includes SportsClippers and family links. Each
      // region takes down its own events' clips; the step is done once none
      // are out anywhere.
      const out = (await outClipsFor(sb, [t.roster_id])).get(t.roster_id) || [];
      const here = out.filter((c) => mine.has((events.get(c.event_id) || {}).region));
      await inChunks(here.map((c) => c.id), (chunk) => run(sb.from("gfs_clips").update({ removed_at: at, pull_reason: null }).in("id", chunk).is("removed_at", null)));
      const left = out.filter((c) => !here.includes(c));
      if (!left.length) Object.assign(patch, { other_done_at: at, other_done_by: actor(req) });
      else {
        const regions = [...new Set(left.map((c) => (events.get(c.event_id) || {}).region).filter(Boolean))];
        const codes = [...new Set(left.map((c) => (events.get(c.event_id) || {}).code).filter(Boolean))];
        partial = { removed: here.length, still_out: left.length, regions, events: codes };
        notify(regionEmails(regions, "member"), { title: `Takedown${t.number ? " #" + t.number : ""} · clips still out`, body: `${left.length} still out at ${codes.join(", ")}: take them down, then mark the step done`, url: `/app/#gfs-desk`, tag: `gfs-takedown-${t.id}` });
      }
    }
    if (b.offsite_requested === true && !t.offsite_requested_at) Object.assign(patch, { offsite_requested_at: at, offsite_requested_by: actor(req) });
    if (b.note !== undefined) patch.note = G.clean(b.note, 300) || null;
    if (!Object.keys(patch).length && !partial) return res.status(400).json({ error: "nothing_to_change" });
    let updated = t;
    if (Object.keys(patch).length) {
      const next = { ...t, ...patch };
      patch.status = next.pylon_done_at && next.other_done_at && next.offsite_requested_at ? "done" : "open";
      updated = await run(sb.from("gfs_takedowns").update(patch).eq("id", t.id).select("*").single());
    }
    const ev = events.get(updated.event_id) || {};
    await T.logActivity(actor(req), "gfs_takedown_step", ev.code || null, { region: mine.has(t.region) ? t.region : [...reach].find((r) => mine.has(r)), number: updated.number || undefined, steps: Object.keys(patch).filter((k) => k.endsWith("_at")), removed: partial ? partial.removed : undefined });
    res.json({ takedown: takedownView(updated, events, await outClipsFor(sb, [t.roster_id]), req, reach), partial });
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
      ids.length ? inChunks(ids, (c) => all(() => sb.from("gfs_crew").select("id,event_id,creator_id,role,status").in("event_id", c)), 50) : [],
      ids.length ? inChunks(ids, (c) => all(() => sb.from("gfs_deliverables").select("*").in("event_id", c)), 50) : [],
      visibleTakedowns(sb, req),
    ]);
    const creators = await creatorsFor(sb, crew);
    const byId = new Map(events.map((e) => [e.id, e]));
    const needs = [];
    for (const t of tds.list) needs.push({ kind: "takedown", ...takedownView(t, tds.events, null, req, tds.scope.get(t.id)) });
    const soon = Date.now() + 3 * 86400000;
    for (const ev of events) {
      const start = G.zonedToUtc(ev.starts_on, "00:00", ev.tz).getTime();
      if (start < Date.now() - 86400000 || start > soon) continue;
      const gaps = checklist(ev, crew.filter((c) => c.event_id === ev.id), creators).filter((x) => !x.done);
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
      next: next ? { ...eventView(next, req, names), checklist: checklist(next, crew.filter((c) => c.event_id === next.id), creators) } : null,
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
    const dels = ids.length ? await inChunks(ids, (c) => all(() => sb.from("gfs_deliverables").select("*").in("event_id", c)), 50) : [];
    const td = regions.length ? await visibleTakedowns(sb, req, { regions }) : { list: [], scope: new Map(), events: new Map() };
    const tds = td.list;
    const names = await namesFor(sb, events.map((e) => e.director_email));
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
    const outNow = await outClipsFor(sb, [...new Set(tds.map((t) => t.roster_id))]);
    const tdViews = tds.map((t) => takedownView(t, td.events, outNow, req, td.scope.get(t.id))).sort((a, b) => String(a.next_due_at || "~").localeCompare(String(b.next_due_at || "~")));
    res.json({
      window: { from, to, name: win },
      regions,
      totals: {
        waiting: rows.reduce((s, r) => s + r.waiting, 0),
        unmatched: rows.reduce((s, r) => s + r.unmatched, 0),
        held: rows.reduce((s, r) => s + r.held, 0),
        needs_removal: rows.reduce((s, r) => s + r.needs_removal, 0),
        to_family_only: rows.reduce((s, r) => s + (r.to_family_only || 0), 0),
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
