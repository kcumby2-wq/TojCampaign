"use strict";
// The Subject Medias marketplace, the staff side (migration 033; the rules
// are in utils/sm-market.js). The TOJ app's Marketplace tool:
//
//   GET    /api/sm/market/events                   events (viewer)
//   POST   /api/sm/market/events                   new event (approver)
//   GET    /api/sm/market/events/:id               one event: teams, roster and consent, counts
//   PATCH  /api/sm/market/events/:id               details, prices, draft/live/closed (approver)
//   POST   /api/sm/market/events/:id/teams         add a team (member)
//   DELETE /api/sm/market/teams/:id                remove a team with no one on it (approver)
//   POST   /api/sm/market/events/:id/athletes      add jersey numbers to a team (member)
//   PATCH  /api/sm/market/athletes/:id             keep out, or not (approver)
//   DELETE /api/sm/market/athletes/:id             remove a number entered by mistake (approver)
//   POST   /api/sm/market/athletes/:id/consents    a consent given in person; emails the family link (approver)
//   DELETE /api/sm/market/consents/:id             remove a consent (approver)
//   POST   /api/sm/market/events/:id/uploads       signed upload links, straight to storage (member)
//   POST   /api/sm/market/events/:id/media         an uploaded file, ready to process (member)
//   GET    /api/sm/market/events/:id/media         its media, with preview links and tags (viewer)
//   PATCH  /api/sm/market/media/:id                confirm tags (member); approve or hide (approver)
//   POST   /api/sm/market/media/:id/retry          process a failed file again (member)
//   DELETE /api/sm/market/media/:id                remove an unsold file and its previews (approver)
//   GET    /api/sm/market/events/:id/orders        orders (approver)
//   GET    /api/sm/market/events/:id/qr/:which.svg the QR for the event or consent page (viewer)
//
// Every change is JSON only, so a form on another site can't make a
// signed-in member's browser do it. Consent emails show to approvers and the
// owner only; everyone else sees the level. Uploads go from the browser
// straight to storage on a signed link; the worker (utils/sm-market-worker.js)
// makes the previews and suggestions once a file is registered.

const express = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");
const T = require("../utils/team");
const M = require("../utils/sm-market");
const worker = require("../utils/sm-market-worker");
const mailer = require("../utils/mailer");
const { getSupabase } = require("../utils/supabase");

const router = express.Router();
const viewer = T.requireTeam("market", "viewer");
const member = T.requireTeam("market", "member");
const approver = T.requireTeam("market", "approver");
const ROLE_RANK = { viewer: 1, member: 2, approver: 3, owner: 4 };
const atLeast = (req, role) => (ROLE_RANK[req.team && req.team.role] || 0) >= ROLE_RANK[role];
const actor = (req) => String(req.team.email || "").toLowerCase().slice(0, 254);
const now = () => new Date().toISOString();

const safe = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res, next))
    .catch((e) => {
      console.error("[sm-market] handler failed:", e && e.message);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    });
const jsonOnly = (req, res, next) => (req.is("application/json") ? next() : res.status(415).json({ error: "json_only" }));
const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
const notSetUp = (e) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/i.test(String(e.message || "")));
function failed(res, e) {
  if (notSetUp(e)) return res.status(503).json({ error: "not_set_up" });
  console.error("[sm-market] storage error:", e && (e.code || "") + " " + (e.message || ""));
  return res.status(500).json({ error: "storage_error" });
}
async function run(q) {
  const { data, error } = await q;
  if (error) throw Object.assign(new Error(error.message || "storage_error"), { db: error });
  return data;
}
const withDb = (fn) =>
  safe(async (req, res) => {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ error: "storage_unavailable" });
    try {
      await fn(req, res, sb);
    } catch (e) {
      if (e && e.db) return failed(res, e.db);
      throw e;
    }
  });
const idOk = (id) => M.UUID.test(String(id || ""));

async function eventById(sb, id) {
  if (!idOk(id)) return null;
  return run(sb.from("sm_market_events").select("*").eq("id", id).maybeSingle());
}
// The clips link carries the event's access code; the consent link doesn't
// (it goes on the public poster at check-in).
const links = (ev) => ({ event: M.linkTo.event(ev.code, ev.view_key), consent: M.linkTo.consent(ev.code), access_code: M.viewKeyShown(ev.view_key) });

// Each athlete's level, from their roster row and every consent for them.
async function levelsFor(sb, ids) {
  if (!ids.length) return new Map();
  const [athletes, consents] = await Promise.all([
    run(sb.from("sm_market_athletes").select("id,keep_out").in("id", ids)),
    run(sb.from("sm_market_consents").select("athlete_id,level,under_13,confirmed_at").in("athlete_id", ids)),
  ]);
  return new Map((athletes || []).map((a) => [a.id, M.effectiveLevel(a, consents || [])]));
}

// The roster with each athlete's level, from every consent for the event.
async function rosterOf(sb, eventId, { withEmails = false } = {}) {
  const [teams, athletes] = await Promise.all([
    run(sb.from("sm_market_teams").select("id,name,created_at").eq("event_id", eventId).order("name", { ascending: true })),
    run(sb.from("sm_market_athletes").select("id,team_id,jersey,keep_out,keep_out_at").eq("event_id", eventId)),
  ]);
  const ids = (athletes || []).map((a) => a.id);
  const consents = ids.length
    ? await run(sb.from("sm_market_consents").select("id,athlete_id,email,level,under_13,age_band,source,confirmed_at,pending_level,pending_under_13,pending_age_band,created_at,updated_at").in("athlete_id", ids))
    : [];
  const list = (athletes || [])
    .map((a) => {
      const mine = consents.filter((c) => c.athlete_id === a.id);
      return {
        ...a,
        level: M.effectiveLevel(a, mine),
        consents: mine.map((c) => ({
          id: c.id,
          level: c.level,
          under_13: c.under_13,
          age_band: M.bandOf(c),
          source: c.source,
          confirmed: !!c.confirmed_at,
          pending: c.pending_level ? { level: c.pending_level, under_13: !!c.pending_under_13, age_band: c.pending_age_band || null } : null,
          at: c.updated_at || c.confirmed_at || c.created_at,
          ...(withEmails ? { email: c.email } : {}),
        })),
      };
    })
    .sort((x, y) => Number(x.jersey) - Number(y.jersey));
  return { teams: teams || [], athletes: list, consents };
}

// ── Events ───────────────────────────────────────────────────────────────
router.get("/events", viewer, withDb(async (req, res, sb) => {
  const events = await run(sb.from("sm_market_events").select("*").order("starts_on", { ascending: false }).limit(200));
  res.json({ events: (events || []).map((e) => ({ ...e, links: links(e) })) });
}));

router.post("/events", approver, jsonOnly, withDb(async (req, res, sb) => {
  const { errors, value } = M.eventInput(bodyOf(req));
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  // A fresh code, retried if it happens to be taken.
  for (let i = 0; i < 5; i++) {
    const { data, error } = await sb.from("sm_market_events").insert({ status: "draft", ...value, code: M.newCode(), view_key: M.newViewKey(), created_by: actor(req) }).select().single();
    if (!error) {
      await T.logActivity(actor(req), "market_event_added", data.code);
      return res.json({ event: { ...data, links: links(data) } });
    }
    if (error.code !== "23505") return failed(res, error);
  }
  res.status(500).json({ error: "no_code" });
}));

router.get("/events/:id", viewer, withDb(async (req, res, sb) => {
  const ev = await eventById(sb, req.params.id);
  if (!ev) return res.status(404).json({ error: "not_found" });
  const roster = await rosterOf(sb, ev.id, { withEmails: atLeast(req, "approver") });
  const media = await run(sb.from("sm_market_media").select("id,status,kind").eq("event_id", ev.id));
  const counts = {};
  for (const m of media || []) counts[m.status] = (counts[m.status] || 0) + 1;
  res.json({
    event: { ...ev, links: links(ev) },
    teams: roster.teams,
    athletes: roster.athletes,
    counts,
    levels: M.LEVEL_WORDS,
    can: { edit: atLeast(req, "approver"), upload: atLeast(req, "member") },
  });
}));

router.patch("/events/:id", approver, jsonOnly, withDb(async (req, res, sb) => {
  const ev = await eventById(sb, req.params.id);
  if (!ev) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const { errors, value } = M.eventInput(body, { partial: true });
  // A date change is checked against the other date as it stands.
  const starts = value.starts_on || ev.starts_on;
  const ends = value.ends_on || ev.ends_on;
  if ((value.starts_on || value.ends_on) && (ends < starts || (Date.parse(ends) - Date.parse(starts)) / 864e5 > 14)) errors.push("ends_on");
  if (errors.length) return res.status(400).json({ error: "invalid", fields: [...new Set(errors)] });
  if (!Object.keys(value).length) return res.status(400).json({ error: "nothing_to_change" });
  value.updated_at = now();
  const data = await run(sb.from("sm_market_events").update(value).eq("id", ev.id).select().single());
  res.json({ event: { ...data, links: links(data) } });
}));

// A new access code for the clips page, when the old one has got around.
// The old clips QR and handouts stop working; family links and orders don't.
router.post("/events/:id/access-code", approver, jsonOnly, withDb(async (req, res, sb) => {
  const ev = await eventById(sb, req.params.id);
  if (!ev) return res.status(404).json({ error: "not_found" });
  let key = M.newViewKey();
  while (key === ev.view_key) key = M.newViewKey();
  const data = await run(sb.from("sm_market_events").update({ view_key: key, updated_at: now() }).eq("id", ev.id).select().single());
  await T.logActivity(actor(req), "market_access_code_changed", data.code);
  res.json({ event: { ...data, links: links(data) } });
}));

// ── The roster ───────────────────────────────────────────────────────────
router.post("/events/:id/teams", member, jsonOnly, withDb(async (req, res, sb) => {
  const ev = await eventById(sb, req.params.id);
  if (!ev) return res.status(404).json({ error: "not_found" });
  const name = M.teamName(bodyOf(req).name);
  if (!name) return res.status(400).json({ error: "invalid", fields: ["name"] });
  const { data, error } = await sb.from("sm_market_teams").insert({ event_id: ev.id, name }).select().single();
  if (error && error.code === "23505") return res.status(409).json({ error: "team_exists" });
  if (error) return failed(res, error);
  res.json({ team: data });
}));

router.delete("/teams/:id", approver, withDb(async (req, res, sb) => {
  if (!idOk(req.params.id)) return res.status(404).json({ error: "not_found" });
  const team = await run(sb.from("sm_market_teams").select("id").eq("id", req.params.id).maybeSingle());
  if (!team) return res.status(404).json({ error: "not_found" });
  const on = await run(sb.from("sm_market_athletes").select("id").eq("team_id", team.id).limit(1));
  if ((on || []).length) return res.status(409).json({ error: "team_has_athletes" });
  await run(sb.from("sm_market_teams").delete().eq("id", team.id));
  res.json({ ok: true });
}));

// "7, 11 22" (or a list) → the numbers on one team. Numbers already there are skipped.
router.post("/events/:id/athletes", member, jsonOnly, withDb(async (req, res, sb) => {
  const ev = await eventById(sb, req.params.id);
  if (!ev) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const teamId = String(body.team_id || "");
  const team = idOk(teamId) ? await run(sb.from("sm_market_teams").select("id,event_id").eq("id", teamId).maybeSingle()) : null;
  if (!team || team.event_id !== ev.id) return res.status(400).json({ error: "invalid", fields: ["team_id"] });
  const given = Array.isArray(body.jerseys) ? body.jerseys.slice(0, 200).map((j) => (typeof j === "string" || typeof j === "number" ? String(j) : "x")).join(",") : body.jerseys;
  const raw = String(typeof given === "string" || typeof given === "number" ? given : "").slice(0, 2000);
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  const nums = [...new Set(parts.map(M.jerseyOf))];
  if (!parts.length || nums.includes(null) || nums.length > 150) return res.status(400).json({ error: "invalid", fields: ["jerseys"] });
  const have = await run(sb.from("sm_market_athletes").select("jersey").eq("team_id", team.id));
  const known = new Set((have || []).map((a) => a.jersey));
  const add = nums.filter((n) => !known.has(n)).map((jersey) => ({ event_id: ev.id, team_id: team.id, jersey }));
  if (add.length) await run(sb.from("sm_market_athletes").insert(add));
  res.json({ added: add.length, skipped: nums.length - add.length });
}));

router.patch("/athletes/:id", approver, jsonOnly, withDb(async (req, res, sb) => {
  if (!idOk(req.params.id)) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  if (typeof body.keep_out !== "boolean") return res.status(400).json({ error: "invalid", fields: ["keep_out"] });
  const a = await run(sb.from("sm_market_athletes").select("id,event_id").eq("id", req.params.id).maybeSingle());
  if (!a) return res.status(404).json({ error: "not_found" });
  const patch = body.keep_out ? { keep_out: true, keep_out_at: now(), keep_out_by: actor(req) } : { keep_out: false, keep_out_at: null, keep_out_by: null };
  const data = await run(sb.from("sm_market_athletes").update(patch).eq("id", a.id).select().single());
  await T.logActivity(actor(req), body.keep_out ? "market_keep_out" : "market_keep_out_lifted", null, { event_id: a.event_id });
  res.json({ athlete: data });
}));

// A number entered by mistake. Never one a guardian has answered for: their
// choice (a keep-out above all) would go with it.
router.delete("/athletes/:id", approver, withDb(async (req, res, sb) => {
  if (!idOk(req.params.id)) return res.status(404).json({ error: "not_found" });
  const a = await run(sb.from("sm_market_athletes").select("id").eq("id", req.params.id).maybeSingle());
  if (!a) return res.status(404).json({ error: "not_found" });
  const answered = await run(sb.from("sm_market_consents").select("id").eq("athlete_id", a.id).limit(1));
  if ((answered || []).length) return res.status(409).json({ error: "has_consent" });
  await run(sb.from("sm_market_athletes").delete().eq("id", a.id));
  res.json({ ok: true });
}));

// A consent given in person (a paper form, a parent at check-in). The staff
// member recording it vouches for it, so it counts at once. Unless it's a
// keep-out, the guardian gets their family link by email, and staff see it
// once here too, to hand over in person when email isn't set up.
router.post("/athletes/:id/consents", approver, jsonOnly, withDb(async (req, res, sb) => {
  if (!idOk(req.params.id)) return res.status(404).json({ error: "not_found" });
  const a = await run(sb.from("sm_market_athletes").select("id,event_id,team_id,jersey").eq("id", req.params.id).maybeSingle());
  if (!a) return res.status(404).json({ error: "not_found" });
  const { errors, value } = M.consentInput({ ...bodyOf(req), team_id: a.team_id, jersey: a.jersey, guardian: true });
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const fam = value.level === "out" ? null : M.newToken();
  const at = now();
  const row = {
    athlete_id: a.id,
    email: value.email,
    level: value.level,
    under_13: value.under_13,
    age_band: value.age_band,
    source: "staff",
    confirmed_at: at,
    confirm_hash: null,
    pending_level: null,
    pending_under_13: null,
    pending_age_band: null,
    family_hash: fam ? fam.hash : null,
    recorded_by: actor(req),
    updated_at: at,
  };
  const { data, error } = await sb.from("sm_market_consents").upsert(row, { onConflict: "athlete_id,email" }).select().single();
  if (error) return failed(res, error);
  let emailed = false;
  const link = fam ? M.linkTo.family(fam.token) : null;
  if (link) {
    const [ev, team] = await Promise.all([
      run(sb.from("sm_market_events").select("id,name").eq("id", a.event_id).maybeSingle()),
      run(sb.from("sm_market_teams").select("id,name").eq("id", a.team_id).maybeSingle()),
    ]);
    if (ev && team) {
      try {
        const r = await mailer.sendMail({ to: value.email, ...M.familyEmail(ev, team.name, a.jersey, value.level, link) });
        emailed = !!(r && r.sent);
      } catch (e) {
        console.warn("[sm-market] family link email failed:", e && e.message);
      }
    }
  }
  await T.logActivity(actor(req), "market_consent_recorded", null, { event_id: a.event_id, level: value.level });
  res.json({
    consent: { id: data.id, level: data.level, under_13: data.under_13, age_band: data.age_band, source: data.source, confirmed: true, email: data.email },
    family_link: link,
    emailed,
  });
}));

// Removing a family's answer is logged like a keep-out (never with their address).
router.delete("/consents/:id", approver, withDb(async (req, res, sb) => {
  if (!idOk(req.params.id)) return res.status(404).json({ error: "not_found" });
  const c = await run(sb.from("sm_market_consents").select("id,athlete_id,level,source").eq("id", req.params.id).maybeSingle());
  if (!c) return res.status(404).json({ error: "not_found" });
  const a = await run(sb.from("sm_market_athletes").select("id,event_id").eq("id", c.athlete_id).maybeSingle());
  await run(sb.from("sm_market_consents").delete().eq("id", c.id));
  await T.logActivity(actor(req), "market_consent_removed", null, { event_id: a ? a.event_id : null, level: c.level, source: c.source });
  res.json({ ok: true });
}));

// ── Uploads ──────────────────────────────────────────────────────────────
// Signed links that put each file straight into storage, so footage never
// passes through this server. The file is registered once it's there.
router.post("/events/:id/uploads", member, jsonOnly, withDb(async (req, res, sb) => {
  const ev = await eventById(sb, req.params.id);
  if (!ev) return res.status(404).json({ error: "not_found" });
  if (ev.status === "closed") return res.status(409).json({ error: "event_closed" });
  const files = Array.isArray(bodyOf(req).files) ? bodyOf(req).files.slice(0, 51) : [];
  if (!files.length || files.length > 50) return res.status(400).json({ error: "invalid", fields: ["files"] });
  const out = [];
  for (const f of files) {
    const { errors, value } = M.uploadInput(f);
    if (errors.length) {
      out.push({ filename: value.filename, error: errors[0] });
      continue;
    }
    const key = M.originalKey(ev.id, crypto.randomUUID(), value.ext);
    const { data, error } = await sb.storage.from(M.BUCKET).createSignedUploadUrl(key);
    if (error || !data) {
      console.error("[sm-market] signed upload failed:", error && error.message);
      out.push({ filename: value.filename, error: "storage" });
      continue;
    }
    out.push({ filename: value.filename, key, kind: value.kind, content_type: value.content_type, bytes: value.bytes, signed_url: data.signedUrl });
  }
  res.json({ uploads: out });
}));

router.post("/events/:id/media", member, jsonOnly, withDb(async (req, res, sb) => {
  const ev = await eventById(sb, req.params.id);
  if (!ev) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const key = String(body.key || "");
  const m = /^events\/([0-9a-f-]{36})\/originals\/([0-9a-f-]{36})\.(mp4|mov|m4v|jpg|jpeg|png)$/.exec(key);
  if (!m || m[1] !== ev.id || !idOk(m[2])) return res.status(400).json({ error: "invalid", fields: ["key"] });
  const { errors, value } = M.uploadInput({ filename: body.filename, bytes: body.bytes });
  if (errors.length || value.ext !== m[3]) return res.status(400).json({ error: "invalid", fields: errors.length ? errors : ["filename"] });
  // It has to be in storage, and its size is what storage holds.
  const { data: stored, error: missing } = await sb.storage.from(M.BUCKET).info(key);
  if (missing || !stored) return res.status(409).json({ error: "not_uploaded" });
  const size = Number(stored.size);
  const bytes = Number.isInteger(size) && size > 0 ? size : value.bytes;
  if (bytes > M.MAX_UPLOAD_BYTES) return res.status(400).json({ error: "invalid", fields: ["bytes"] });
  const row = { id: m[2], event_id: ev.id, kind: value.kind, object_key: key, filename: value.filename, bytes, status: "uploaded", uploaded_by: actor(req) };
  const { data, error } = await sb.from("sm_market_media").insert(row).select().single();
  if (error && error.code === "23505") return res.status(409).json({ error: "already_added" });
  if (error) return failed(res, error);
  worker.kick();
  res.json({ media: data });
}));

// Media with preview links (an hour), its tags and who's in it.
router.get("/events/:id/media", viewer, withDb(async (req, res, sb) => {
  const ev = await eventById(sb, req.params.id);
  if (!ev) return res.status(404).json({ error: "not_found" });
  let q = sb.from("sm_market_media").select("*").eq("event_id", ev.id).order("created_at", { ascending: true }).limit(500);
  const status = String(req.query.status || "");
  if (status) {
    if (!M.MEDIA_STATUSES.includes(status)) return res.status(400).json({ error: "invalid", fields: ["status"] });
    q = q.eq("status", status);
  }
  const media = (await run(q)) || [];
  const ids = media.map((m) => m.id);
  const tags = ids.length ? await run(sb.from("sm_market_tags").select("media_id,athlete_id,source,confidence,confirmed").in("media_id", ids)) : [];
  const keys = media.flatMap((m) => [m.preview_key, m.poster_key]).filter(Boolean);
  const signed = new Map();
  if (keys.length) {
    const { data } = await sb.storage.from(M.BUCKET).createSignedUrls(keys, 3600);
    for (const s of data || []) if (s && s.signedUrl) signed.set(s.path, s.signedUrl);
  }
  res.json({
    media: media.map((m) => ({
      id: m.id,
      kind: m.kind,
      status: m.status,
      filename: m.filename,
      duration_ms: m.duration_ms,
      error: m.error,
      created_at: m.created_at,
      preview_url: signed.get(m.preview_key) || null,
      poster_url: signed.get(m.poster_key) || null,
      tags: tags.filter((t) => t.media_id === m.id).map(({ athlete_id, source, confidence, confirmed }) => ({ athlete_id, source, confidence, confirmed })),
    })),
  });
}));

// Confirm who's in it (member); approve it for sale or hide it (approver).
// Everything is checked before anything is written. Approving takes the
// approver's check that everyone who stands out in it is tagged
// (everyone_tagged), and never goes through with a kept-out athlete in it.
// A change to who's in an approved item sends it back to review, unless an
// approver checks everyone again; so does leaving nobody confirmed in it, or
// tagging someone kept out.
router.patch("/media/:id", member, jsonOnly, withDb(async (req, res, sb) => {
  if (!idOk(req.params.id)) return res.status(404).json({ error: "not_found" });
  const media = await run(sb.from("sm_market_media").select("*").eq("id", req.params.id).maybeSingle());
  if (!media) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  if (body.tags === undefined && body.status === undefined) return res.status(400).json({ error: "nothing_to_change" });
  if (body.status !== undefined && !atLeast(req, "approver")) return res.status(403).json({ error: "role_too_low", need: "approver" });
  if (body.everyone_tagged !== undefined && typeof body.everyone_tagged !== "boolean") return res.status(400).json({ error: "invalid", fields: ["everyone_tagged"] });
  if (body.everyone_tagged === true && !atLeast(req, "approver")) return res.status(403).json({ error: "role_too_low", need: "approver" });
  if (!["review", "approved", "hidden"].includes(media.status)) return res.status(409).json({ error: "not_ready" });
  if (body.status !== undefined && !["approved", "hidden", "review"].includes(body.status)) return res.status(400).json({ error: "invalid", fields: ["status"] });

  const existing = (await run(sb.from("sm_market_tags").select("athlete_id,source,confidence,confirmed").eq("media_id", media.id))) || [];
  const confirmedNow = existing.filter((t) => t.confirmed).map((t) => t.athlete_id);
  let want = null;
  if (body.tags !== undefined) {
    want = Array.isArray(body.tags) ? [...new Set(body.tags.map(String))] : null;
    if (!want || want.length > 40 || !want.every(idOk)) return res.status(400).json({ error: "invalid", fields: ["tags"] });
    const roster = want.length ? await run(sb.from("sm_market_athletes").select("id,event_id").in("id", want)) : [];
    if (roster.length !== want.length || roster.some((a) => a.event_id !== media.event_id)) return res.status(400).json({ error: "invalid", fields: ["tags"] });
  }
  const confirmedAfter = want || confirmedNow;
  const checked = body.everyone_tagged === true;
  if (body.status === "approved" && !confirmedAfter.length) return res.status(409).json({ error: "no_confirmed_tag" });
  if (body.status === "approved" && !checked) return res.status(409).json({ error: "check_everyone_tagged" });
  const changed = !!want && (want.length !== confirmedNow.length || want.some((id) => !confirmedNow.includes(id)));
  // Nobody kept out goes on sale, whatever else their family has said.
  const onSale = body.status === "approved" || (body.status === undefined && media.status === "approved" && changed);
  const levels = onSale ? await levelsFor(sb, confirmedAfter) : new Map();
  const keptOut = confirmedAfter.filter((id) => levels.get(id) === "out");
  if (body.status === "approved" && keptOut.length) return res.status(409).json({ error: "kept_out", athletes: keptOut });

  if (want) {
    // What a person confirms is who's in it; any other suggestion goes.
    const drop = existing.filter((t) => !want.includes(t.athlete_id)).map((t) => t.athlete_id);
    if (drop.length) await run(sb.from("sm_market_tags").delete().eq("media_id", media.id).in("athlete_id", drop));
    const at = now();
    for (const id of want) {
      const had = existing.find((t) => t.athlete_id === id);
      const row = { media_id: media.id, athlete_id: id, event_id: media.event_id, source: had ? had.source : "staff", confidence: had ? had.confidence : null, confirmed: true, confirmed_by: actor(req), confirmed_at: at };
      await run(sb.from("sm_market_tags").upsert(row, { onConflict: "media_id,athlete_id" }));
    }
  }

  let status = body.status;
  if (status === undefined && media.status === "approved" && changed && (!confirmedAfter.length || !atLeast(req, "approver") || !checked || keptOut.length)) status = "review";
  const at = now();
  if (status !== undefined && status !== media.status) {
    const patch = { status, updated_at: at };
    if (status === "approved") Object.assign(patch, { approved_at: at, approved_by: actor(req), everyone_tagged_at: at, everyone_tagged_by: actor(req) });
    await run(sb.from("sm_market_media").update(patch).eq("id", media.id));
  } else if (media.status === "approved" && checked && (changed || status === "approved")) {
    // Still on sale, checked again by an approver.
    await run(sb.from("sm_market_media").update({ everyone_tagged_at: at, everyone_tagged_by: actor(req), updated_at: at }).eq("id", media.id));
  }
  const data = await run(sb.from("sm_market_media").select("id,status,approved_at").eq("id", media.id).single());
  const tags = await run(sb.from("sm_market_tags").select("athlete_id,source,confidence,confirmed").eq("media_id", media.id));
  res.json({ media: { ...data, tags } });
}));

router.post("/media/:id/retry", member, jsonOnly, withDb(async (req, res, sb) => {
  if (!idOk(req.params.id)) return res.status(404).json({ error: "not_found" });
  const media = await run(sb.from("sm_market_media").select("id,status").eq("id", req.params.id).maybeSingle());
  if (!media) return res.status(404).json({ error: "not_found" });
  if (media.status !== "failed") return res.status(409).json({ error: "not_failed" });
  await run(sb.from("sm_market_media").update({ status: "uploaded", attempts: 0, error: null, updated_at: now() }).eq("id", media.id).eq("status", "failed"));
  worker.kick();
  res.json({ ok: true });
}));

// An unsold file, with its original, preview and poster. A paid (or refunded)
// sale keeps it. A checkout started in the last hour holds it for now; lines
// from checkouts that ended unpaid are cleared away.
router.delete("/media/:id", approver, withDb(async (req, res, sb) => {
  if (!idOk(req.params.id)) return res.status(404).json({ error: "not_found" });
  const media = await run(sb.from("sm_market_media").select("*").eq("id", req.params.id).maybeSingle());
  if (!media) return res.status(404).json({ error: "not_found" });
  const lines = (await run(sb.from("sm_market_order_items").select("order_id").eq("media_id", media.id))) || [];
  if (lines.length) {
    const orders = (await run(sb.from("sm_market_orders").select("id,status,created_at").in("id", lines.map((l) => l.order_id)))) || [];
    if (orders.some((o) => o.status === "paid" || o.status === "refunded")) return res.status(409).json({ error: "sold" });
    const hour = Date.now() - 60 * 60 * 1000;
    if (orders.some((o) => o.status === "pending" && Date.parse(o.created_at) > hour)) return res.status(409).json({ error: "in_checkout" });
    await run(sb.from("sm_market_order_items").delete().eq("media_id", media.id).in("order_id", orders.map((o) => o.id)));
  }
  await run(sb.from("sm_market_media").delete().eq("id", media.id));
  // Every file this one could have made, whether or not the row says so.
  const keys = [...new Set([media.object_key, media.preview_key, media.poster_key, M.previewKey(media.event_id, media.id, media.kind), M.posterKey(media.event_id, media.id)].filter(Boolean))];
  const { error } = await sb.storage.from(M.BUCKET).remove(keys);
  if (error) console.warn("[sm-market] files left in storage:", keys.join(", "), error.message);
  await T.logActivity(actor(req), "market_media_removed", null, { event_id: media.event_id, kind: media.kind });
  res.json({ ok: true });
}));

// ── Orders ───────────────────────────────────────────────────────────────
router.get("/events/:id/orders", approver, withDb(async (req, res, sb) => {
  const ev = await eventById(sb, req.params.id);
  if (!ev) return res.status(404).json({ error: "not_found" });
  const orders = (await run(sb.from("sm_market_orders").select("id,email,status,amount_cents,mode,paid_at,created_at").eq("event_id", ev.id).order("created_at", { ascending: false }).limit(500))) || [];
  const ids = orders.map((o) => o.id);
  const items = ids.length ? await run(sb.from("sm_market_order_items").select("order_id,media_id,price_cents").in("order_id", ids)) : [];
  const paid = orders.filter((o) => o.status === "paid");
  res.json({
    orders: orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id).length })),
    totals: { paid_orders: paid.length, paid_cents: paid.reduce((s, o) => s + o.amount_cents, 0) },
  });
}));

// ── QR codes ─────────────────────────────────────────────────────────────
router.get("/events/:id/qr/:which.svg", viewer, withDb(async (req, res, sb) => {
  const ev = await eventById(sb, req.params.id);
  if (!ev) return res.status(404).json({ error: "not_found" });
  const l = links(ev);
  const url = req.params.which === "consent" ? l.consent : req.params.which === "event" ? l.event : null;
  if (!url) return res.status(404).json({ error: "not_found" });
  const svg = await QRCode.toString(url, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "no-store");
  res.send(svg);
}));

module.exports = router;
