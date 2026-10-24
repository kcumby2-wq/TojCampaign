// Pylon events · the asset library API (migration 027; the rules are in
// utils/gfs-assets.js, the screens in public/app/gfs-assets.js). Mounted at
// /api/gfs/assets.
//
//   GET    /meta                 kinds, formats, places, checks, stages
//   GET    /                     the library: assets in your regions, with what
//                                blocks each, and each stop's clip counts
//                                (?event=, ?kind=, ?stage=)
//   POST   /                     a new draft (Regional Directors and up)
//   GET    /:id                  one asset: athletes, checks, what blocks it, what you can do
//   PATCH  /:id                  change a draft's details, where it lives, its athletes
//   DELETE /:id                  delete a draft
//   POST   /:id/check            record or clear a check   { check, on }
//   POST   /:id/stage            move it: review, back to draft, approved, live   { to, confirm }
//   POST   /:id/retire           retire it   { reason }
//   GET    /:id/roster           the stop's athletes to pick from, and which can be in it
//
// Region rules as everywhere in Pylon events: owners and approvers see every
// region, a Regional Director or viewer only their own. Viewers read; they
// see that an asset is held, never why, and never a roster ID or a file's
// ID. Athletes are team and jersey number, never a name.

"use strict";

const express = require("express");
const T = require("../utils/team");
const G = require("../utils/gfs");
const A = require("../utils/gfs-assets");
const { getSupabase } = require("../utils/supabase");

const router = express.Router();
const viewer = T.requireTeam("gfs", "viewer");
const member = T.requireTeam("gfs", "member");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROWS = 1000;
const ASSET_COLS = "*";
const EVENT_COLS = "id,code,name,region,city,state,starts_on,ends_on,status";

// ── Plumbing ─────────────────────────────────────────────────────────────
function sb503(res) {
  return res.status(503).json({ error: "supabase_unavailable" });
}
function notSetUp(e) {
  const msg = String((e && e.message) || "");
  return /gfs_asset/.test(msg) && (["42P01", "42883", "PGRST202", "PGRST205"].includes(e.code) || /does not exist|Could not find the/i.test(msg));
}
function fail(res, e, what) {
  const m = e && typeof e.message === "string" ? e.message.trim() : "";
  if (/^gfs_[a-z0-9_]+$/.test(m)) return res.status(409).json({ error: m });
  if (notSetUp(e)) return res.status(503).json({ error: "gfs_assets_not_set_up", hint: "Apply migration 027 in Supabase." });
  if (e && e.code === "23514" && /gfs_assets/.test(m)) return res.status(400).json({ error: "invalid_asset" });
  console.error(`[gfs-assets] ${what} failed:`, (e && e.code) || "", m.slice(0, 160));
  return res.status(500).json({ error: `${what}_failed` });
}
async function run(q) {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
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
const now = () => new Date().toISOString();
const atLeast = (req, role) => !!req.team && (req.team.owner || T.ROLE_RANK[req.team.role] >= T.ROLE_RANK[role]);
const actor = (req) => req.team.email;

// Can this person see (and, as a director, work on) an asset's region?
// A national brand asset (no region) is everyone's to see and an approver's
// to change.
function seesAsset(req, asset) {
  return asset.region ? G.canSee(req.team, asset.region) : asset.kind === "brand";
}
function worksOn(req, asset) {
  if (!atLeast(req, "member")) return false;
  return asset.region ? G.canSee(req.team, asset.region) : atLeast(req, "approver");
}

async function namesFor(sb, emails) {
  const list = [...new Set(emails.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await run(sb.from("team_members").select("email,name").in("email", list));
  return new Map((rows || []).map((r) => [r.email, r.name]));
}

// Everything an asset's record needs, for a set of assets.
async function context(sb, assets) {
  const ids = assets.map((a) => a.id);
  const links = ids.length ? await inChunks(ids, (part) => run(sb.from("gfs_asset_athletes").select("asset_id,roster_row,team,jersey").in("asset_id", part))) : [];
  const rowIds = [...new Set(links.map((l) => l.roster_row))];
  const rows = rowIds.length ? await inChunks(rowIds, (part) => run(sb.from("gfs_roster").select("*").in("id", part))) : [];
  const rosterById = new Map(rows.map((r) => [r.id, r]));
  const evIds = [...new Set(assets.map((a) => a.event_id).filter(Boolean))];
  const evs = evIds.length ? await inChunks(evIds, (part) => run(sb.from("gfs_events").select(EVENT_COLS).in("id", part))) : [];
  const events = new Map(evs.map((e) => [e.id, e]));
  const srcIds = [...new Set(assets.map((a) => a.source_asset_id).filter(Boolean))];
  const srcs = srcIds.length ? await inChunks(srcIds, (part) => run(sb.from("gfs_assets").select("id,kind,title,stage,school_venue,event_id").in("id", part))) : [];
  const sources = new Map(srcs.map((s) => [s.id, s]));
  const byAsset = new Map();
  for (const l of links) {
    const r = rosterById.get(l.roster_row);
    if (!r) continue;
    if (!byAsset.has(l.asset_id)) byAsset.set(l.asset_id, []);
    byAsset.get(l.asset_id).push({ roster: r, team: l.team, jersey: l.jersey });
  }
  return { byAsset, events, sources };
}

const CHECK_COLS = { venue_permission: "venue_permission", deidentified: "deidentified", tier4: "tier4", mint_consent: "mint_consent", marks_licensed: "marks_licensed" };

function assetView(asset, ctx, req, names) {
  const member = atLeast(req, "member");
  const athletes = ctx.byAsset.get(asset.id) || [];
  const ev = asset.event_id ? ctx.events.get(asset.event_id) || null : null;
  const source = asset.source_asset_id ? ctx.sources.get(asset.source_asset_id) || null : null;
  const blocks = asset.stage === "retired" ? [] : A.assetBlocks(asset, athletes, ev, source);
  const byRow = new Map(athletes.map((a) => [a.roster.id, a]));
  const held = blocks.some(A.athleteReason);
  const checks = {};
  for (const k of A.checksFor(asset)) {
    const at = asset[CHECK_COLS[k] + "_at"];
    const by = asset[CHECK_COLS[k] + "_by"];
    checks[k] = { on: !!at, at: at || null, by: at ? names.get(by) || (by && staffName(by)) || null : null, can: A.canCheck(req.team, k) && worksOn(req, asset) && ["draft", "review"].includes(asset.stage) };
  }
  const kind = A.KINDS[asset.kind];
  return {
    id: asset.id,
    kind: asset.kind,
    kind_name: kind.name,
    format: asset.format || null,
    title: asset.title,
    stage: asset.stage,
    stage_name: asset.stage === "live" ? kind.liveLabel : A.STAGE_NAMES[asset.stage],
    region: asset.region || null,
    event: ev ? { id: ev.id, code: ev.code, name: ev.name, region: ev.region, state: ev.state, starts_on: ev.starts_on, ends_on: ev.ends_on } : null,
    location: asset.location || null,
    ref: member ? asset.ref || null : null,
    sha256: member ? asset.sha256 || null : null,
    price_cents: asset.price_cents == null ? null : asset.price_cents,
    school_venue: !!asset.school_venue,
    sponsor_marks: !!asset.sponsor_marks,
    note: member ? asset.note || null : null,
    source: source ? { id: source.id, title: source.title, stage: source.stage } : null,
    athletes: athletes.map((a) => ({
      roster_row: a.roster.id,
      team: a.roster.team,
      jersey: a.roster.jersey,
      position: a.roster.position || null,
      roster_id: member ? a.roster.roster_id : null,
    })),
    checks,
    // Directors and up see why; viewers see only that it's held or ready.
    blocks: member
      ? blocks.map((b) => {
          const s = A.splitBlock(b);
          const a = s.row ? byRow.get(s.row) : null;
          return { code: s.code, athlete: a ? { team: a.roster.team, jersey: a.roster.jersey } : null };
        })
      : null,
    held,
    ready: blocks.length === 0,
    needs_retiring: asset.stage === "live" && blocks.length > 0,
    approved: asset.approved_at ? { at: asset.approved_at, by: names.get(asset.approved_by) || staffName(asset.approved_by) } : null,
    live_at: asset.live_at || null,
    retired: asset.retired_at ? { at: asset.retired_at, reason: asset.retire_reason } : null,
    created_at: asset.created_at,
    can: {
      edit: worksOn(req, asset) && asset.stage === "draft",
      place: worksOn(req, asset) && ["draft", "review", "approved"].includes(asset.stage),
      moves: worksOn(req, asset) ? A.moves(req.team, asset) : [],
      delete: worksOn(req, asset) && asset.stage === "draft",
    },
  };
}
// Owners aren't in team_members, so they show as "the owner".
function staffName(email) {
  return email ? "the owner" : null;
}

async function loadAsset(sb, req, res, id = req.params.id) {
  if (!sb) {
    sb503(res);
    return null;
  }
  if (!UUID.test(String(id))) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const asset = await run(sb.from("gfs_assets").select(ASSET_COLS).eq("id", id).maybeSingle());
  if (!asset || !seesAsset(req, asset)) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return asset;
}
async function oneView(sb, req, asset) {
  const ctx = await context(sb, [asset]);
  const emails = [asset.approved_by, ...A.CHECK_KEYS.map((k) => asset[CHECK_COLS[k] + "_by"])];
  return assetView(asset, ctx, req, await namesFor(sb, emails));
}
function log(req, action, asset, ev) {
  return T.logActivity(actor(req), action, ev ? ev.code : "the national brand kit", { region: asset.region || null, kind: asset.kind });
}

// ── Meta ─────────────────────────────────────────────────────────────────
router.get("/meta", viewer, (req, res) => {
  res.json({
    kinds: A.KINDS,
    formats: A.FORMAT_NAMES,
    stages: A.STAGE_NAMES,
    locations: A.LOCATIONS,
    checks: A.CHECKS,
    retire_reasons: A.RETIRE_REASONS,
    regions: G.REGIONS,
    you: { role: req.team.role, owner: !!req.team.owner, regions: G.regionsOf(req.team) },
  });
});

// ── The library ──────────────────────────────────────────────────────────
router.get("/", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const regions = G.regionsOf(req.team);
    const kind = A.KIND_KEYS.includes(req.query.kind) ? req.query.kind : null;
    const stage = A.STAGES.includes(req.query.stage) ? req.query.stage : null;
    const eventId = UUID.test(String(req.query.event || "")) ? String(req.query.event) : null;
    let assets = regions.length ? await all(() => sb.from("gfs_assets").select(ASSET_COLS).in("region", regions)) : [];
    if (!eventId) assets = assets.concat(await all(() => sb.from("gfs_assets").select(ASSET_COLS).is("region", null)));
    if (eventId) assets = assets.filter((a) => a.event_id === eventId);
    if (kind) assets = assets.filter((a) => a.kind === kind);
    if (stage) assets = assets.filter((a) => a.stage === stage);
    assets = assets.filter((a) => seesAsset(req, a));
    const ctx = await context(sb, assets);
    const emails = assets.flatMap((a) => [a.approved_by, ...A.CHECK_KEYS.map((k) => a[CHECK_COLS[k] + "_by"])]);
    const names = await namesFor(sb, emails);
    const views = assets.map((a) => assetView(a, ctx, req, names)).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));

    // The stops in view, with their clips (the clips tool keeps those).
    let events = [];
    if (eventId) {
      const ev = await run(sb.from("gfs_events").select(EVENT_COLS).eq("id", eventId).maybeSingle());
      if (!ev || !G.canSee(req.team, ev.region)) return res.status(404).json({ error: "not_found" });
      events = [ev];
    } else if (regions.length) {
      events = await all(() => sb.from("gfs_events").select(EVENT_COLS).in("region", regions));
    }
    const counts = events.length ? await require("./gfs").eventCounts(sb, events.map((e) => e.id)) : new Map();
    const clipStops = events
      .map((e) => ({ id: e.id, code: e.code, name: e.name, region: e.region, starts_on: e.starts_on, ends_on: e.ends_on, clips: pickCounts(counts.get(e.id)) }))
      .filter((e) => eventId || e.clips.shot > 0)
      .sort((a, b) => String(b.starts_on).localeCompare(String(a.starts_on)));

    const totals = { all: views.length, needs_retiring: views.filter((v) => v.needs_retiring).length, held: views.filter((v) => v.held && v.stage !== "retired").length, by_kind: {}, by_stage: {} };
    for (const v of views) {
      totals.by_kind[v.kind] = (totals.by_kind[v.kind] || 0) + 1;
      totals.by_stage[v.stage] = (totals.by_stage[v.stage] || 0) + 1;
    }
    res.json({ assets: views, stops: clipStops, totals });
  } catch (e) {
    fail(res, e, "list_assets");
  }
});
function pickCounts(c) {
  const x = c || {};
  return { shot: x.shot || 0, approved: x.approved || 0, delivered: x.delivered || 0, listed: x.listed || 0, held: x.held || 0, needs_removal: x.needs_removal || 0 };
}

// ── A new draft ──────────────────────────────────────────────────────────
router.post("/", member, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const b = req.body || {};
  const kind = String(b.kind || "");
  if (!A.KIND_KEYS.includes(kind)) return res.status(400).json({ error: "kind_required", allowed: A.KIND_KEYS });
  const title = A.cleanTitle(b.title);
  const tp = A.textProblem(title, A.TITLE_MAX, "title");
  if (tp) return res.status(400).json({ error: tp });
  const format = b.format == null || b.format === "" ? null : String(b.format);
  if (format && !A.KINDS[kind].formats.includes(format)) return res.status(400).json({ error: "format", allowed: A.KINDS[kind].formats });
  try {
    const row = { kind, title, format, stage: "draft", school_venue: false, sponsor_marks: false, created_by: actor(req) };
    let ev = null;
    if (b.event_id) {
      if (!UUID.test(String(b.event_id))) return res.status(404).json({ error: "not_found" });
      ev = await run(sb.from("gfs_events").select(EVENT_COLS).eq("id", b.event_id).maybeSingle());
      if (!ev || !G.canSee(req.team, ev.region)) return res.status(404).json({ error: "not_found" });
      row.event_id = ev.id;
      row.region = ev.region;
    } else if (kind !== "brand") {
      return res.status(400).json({ error: "event_required" });
    } else if (b.region) {
      if (!G.REGIONS[b.region]) return res.status(400).json({ error: "region" });
      if (!G.canSee(req.team, b.region)) return res.status(403).json({ error: "region_not_yours" });
      row.region = b.region;
    } else if (!atLeast(req, "approver")) {
      return res.status(403).json({ error: "national_needs_approver" });
    }
    const asset = await run(sb.from("gfs_assets").insert(row).select(ASSET_COLS).single());
    await log(req, "gfs_asset_created", asset, ev);
    res.status(201).json({ asset: await oneView(sb, req, asset) });
  } catch (e) {
    fail(res, e, "create_asset");
  }
});

router.get("/:id", viewer, async (req, res) => {
  const sb = getSupabase();
  try {
    const asset = await loadAsset(sb, req, res);
    if (!asset) return;
    res.json({ asset: await oneView(sb, req, asset) });
  } catch (e) {
    fail(res, e, "asset");
  }
});

// ── Changing a draft, and where a file lives ─────────────────────────────
router.patch("/:id", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const asset = await loadAsset(sb, req, res);
    if (!asset) return;
    if (!worksOn(req, asset)) return res.status(403).json({ error: "region_not_yours" });
    const b = req.body || {};
    const patch = {};
    const draftOnly = ["title", "format", "price_cents", "school_venue", "sponsor_marks", "source_asset_id", "note", "athletes"];
    if (asset.stage !== "draft" && draftOnly.some((k) => b[k] !== undefined)) return res.status(409).json({ error: "gfs_asset_locked" });
    if (asset.stage === "live" || asset.stage === "retired") {
      if (b.location !== undefined || b.ref !== undefined || b.sha256 !== undefined) return res.status(409).json({ error: asset.stage === "live" ? "gfs_asset_locked" : "gfs_asset_retired" });
    }
    if (b.title !== undefined) {
      const title = A.cleanTitle(b.title);
      const tp = A.textProblem(title, A.TITLE_MAX, "title");
      if (tp) return res.status(400).json({ error: tp });
      patch.title = title;
    }
    if (b.format !== undefined) {
      const f = b.format === null || b.format === "" ? null : String(b.format);
      if (f && !A.KINDS[asset.kind].formats.includes(f)) return res.status(400).json({ error: "format" });
      patch.format = f;
    }
    if (b.note !== undefined) {
      const n = b.note === null ? "" : G.clean(b.note, A.NOTE_MAX + 1);
      if (n && A.textProblem(n, A.NOTE_MAX, "note")) return res.status(400).json({ error: A.textProblem(n, A.NOTE_MAX, "note") });
      patch.note = n || null;
    }
    if (b.price_cents !== undefined) {
      if (asset.kind !== "world_pass") return res.status(400).json({ error: "price_world_pass_only" });
      const p = b.price_cents === null ? null : Number(b.price_cents);
      if (p !== null && !(Number.isInteger(p) && p >= 100 && p <= 100000)) return res.status(400).json({ error: "price" });
      patch.price_cents = p;
    }
    if (b.school_venue !== undefined) {
      if (asset.kind !== "venue_world") return res.status(400).json({ error: "school_venue_world_only" });
      patch.school_venue = b.school_venue === true;
    }
    if (b.sponsor_marks !== undefined) patch.sponsor_marks = b.sponsor_marks === true;
    if (b.source_asset_id !== undefined) {
      if (asset.kind !== "world_pass") return res.status(400).json({ error: "source_world_pass_only" });
      if (b.source_asset_id === null) patch.source_asset_id = null;
      else {
        const src = UUID.test(String(b.source_asset_id)) ? await run(sb.from("gfs_assets").select("id,kind,event_id,region").eq("id", b.source_asset_id).maybeSingle()) : null;
        if (!src || src.kind !== "venue_world" || src.event_id !== asset.event_id) return res.status(400).json({ error: "source_world" });
        patch.source_asset_id = src.id;
      }
    }
    if (b.location !== undefined || b.ref !== undefined) {
      const location = b.location !== undefined ? (b.location ? String(b.location) : null) : asset.location;
      const ref = b.ref !== undefined ? (b.ref ? String(b.ref).trim() : null) : asset.ref;
      const p = A.refProblem(asset.kind, location, ref);
      if (p) return res.status(400).json({ error: p });
      patch.location = location;
      patch.ref = ref;
    }
    if (b.sha256 !== undefined) {
      const h = b.sha256 ? String(b.sha256).trim().toLowerCase() : null;
      if (h && !A.SHA_RE.test(h)) return res.status(400).json({ error: "sha256" });
      patch.sha256 = h;
    }
    if (Object.keys(patch).length) await run(sb.from("gfs_assets").update(patch).eq("id", asset.id));

    // Athletes: roster rows of this stop, added and removed by id.
    if (b.athletes !== undefined) {
      const add = [...new Set((Array.isArray(b.athletes.add) ? b.athletes.add : []).map(String))];
      const remove = [...new Set((Array.isArray(b.athletes.remove) ? b.athletes.remove : []).map(String))];
      if ([...add, ...remove].some((x) => !UUID.test(x))) return res.status(400).json({ error: "athlete" });
      if (add.length && A.KINDS[asset.kind].athletes === "none") return res.status(409).json({ error: "gfs_asset_no_athletes" });
      const have = ((await run(sb.from("gfs_asset_athletes").select("roster_row").eq("asset_id", asset.id))) || []).map((x) => x.roster_row);
      const after = have.filter((x) => !remove.includes(x)).concat(add.filter((x) => !have.includes(x)));
      if (A.KINDS[asset.kind].athletes === "one" && after.length > 1) return res.status(409).json({ error: "gfs_asset_one_athlete" });
      if (after.length > 200) return res.status(400).json({ error: "too_many_athletes" });
      if (remove.length) await run(sb.from("gfs_asset_athletes").delete().eq("asset_id", asset.id).in("roster_row", remove));
      const fresh = add.filter((x) => !have.includes(x));
      if (fresh.length) {
        const rows = await inChunks(fresh, (part) => run(sb.from("gfs_roster").select("id,event_id,team,jersey").in("id", part)));
        if (rows.length !== fresh.length || rows.some((r) => r.event_id !== asset.event_id)) return res.status(409).json({ error: "gfs_asset_not_on_roster" });
        await run(sb.from("gfs_asset_athletes").insert(rows.map((r) => ({ asset_id: asset.id, roster_row: r.id, team: r.team, jersey: r.jersey, added_by: actor(req) }))));
      }
    }
    const fresh = await run(sb.from("gfs_assets").select(ASSET_COLS).eq("id", asset.id).single());
    res.json({ asset: await oneView(sb, req, fresh) });
  } catch (e) {
    fail(res, e, "change_asset");
  }
});

router.delete("/:id", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const asset = await loadAsset(sb, req, res);
    if (!asset) return;
    if (!worksOn(req, asset)) return res.status(403).json({ error: "region_not_yours" });
    if (asset.stage !== "draft") return res.status(409).json({ error: "gfs_asset_keep" });
    const used = await run(sb.from("gfs_assets").select("id").eq("source_asset_id", asset.id).limit(1));
    if (used && used.length) return res.status(409).json({ error: "gfs_asset_in_use" });
    await run(sb.from("gfs_asset_athletes").delete().eq("asset_id", asset.id));
    await run(sb.from("gfs_assets").delete().eq("id", asset.id));
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, "delete_asset");
  }
});

// ── Checks a person records ──────────────────────────────────────────────
router.post("/:id/check", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const asset = await loadAsset(sb, req, res);
    if (!asset) return;
    const check = String((req.body && req.body.check) || "");
    if (!A.CHECK_KEYS.includes(check)) return res.status(400).json({ error: "check", allowed: A.CHECK_KEYS });
    if (!A.checksFor(asset).includes(check)) return res.status(400).json({ error: "check_not_for_this_asset" });
    if (!worksOn(req, asset)) return res.status(403).json({ error: "region_not_yours" });
    if (!A.canCheck(req.team, check)) return res.status(403).json({ error: A.CHECKS[check].role === "owner" ? "check_owner_only" : "role_too_low", need: A.CHECKS[check].role });
    if (!["draft", "review"].includes(asset.stage)) return res.status(409).json({ error: "gfs_asset_locked" });
    const on = req.body.on === true;
    const col = CHECK_COLS[check];
    await run(sb.from("gfs_assets").update({ [col + "_at"]: on ? now() : null, [col + "_by"]: on ? actor(req) : null }).eq("id", asset.id));
    const fresh = await run(sb.from("gfs_assets").select(ASSET_COLS).eq("id", asset.id).single());
    res.json({ asset: await oneView(sb, req, fresh) });
  } catch (e) {
    fail(res, e, "asset_check");
  }
});

// ── Moving it along ──────────────────────────────────────────────────────
router.post("/:id/stage", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const asset = await loadAsset(sb, req, res);
    if (!asset) return;
    if (!worksOn(req, asset)) return res.status(403).json({ error: "region_not_yours" });
    const b = req.body || {};
    const to = String(b.to || "");
    if (!["review", "draft", "approved", "live"].includes(to)) return res.status(400).json({ error: "stage" });
    if (asset.stage === "retired") return res.status(409).json({ error: "gfs_asset_retired" });
    if (!A.moves(req.team, asset).includes(to)) return res.status(atLeast(req, "approver") ? 409 : 403).json({ error: atLeast(req, "approver") ? "gfs_asset_stage" : "role_too_low", need: "approver" });
    const patch = { stage: to };
    const ctx = await context(sb, [asset]);
    const ev = asset.event_id ? ctx.events.get(asset.event_id) : null;
    const src = asset.source_asset_id ? ctx.sources.get(asset.source_asset_id) : null;
    if (to === "approved" || to === "live") {
      // The same checks the database runs, said first and in full.
      const blocks = A.assetBlocks(asset, ctx.byAsset.get(asset.id) || [], ev, src);
      if (blocks.length) {
        const view = await oneView(sb, req, asset);
        return res.status(409).json({ error: "gfs_asset_blocked", blocks: view.blocks });
      }
    }
    if (to === "approved") {
      // The approver confirms the kind's checklist.
      if (b.confirm !== true) return res.status(400).json({ error: "confirm_checklist", checklist: A.KINDS[asset.kind].checklist });
      patch.approved_at = now();
      patch.approved_by = actor(req);
    }
    if (to === "live") {
      const location = b.location !== undefined ? String(b.location || "") || null : asset.location;
      const ref = b.ref !== undefined ? (b.ref ? String(b.ref).trim() : null) : asset.ref;
      const p = A.refProblem(asset.kind, location, ref);
      if (p) return res.status(400).json({ error: p });
      if (!A.liveLocationOk({ kind: asset.kind, location, ref })) return res.status(409).json({ error: "gfs_asset_live_location", allowed: A.KINDS[asset.kind].live });
      patch.location = location;
      patch.ref = ref;
    }
    const updated = await run(sb.from("gfs_assets").update(patch).eq("id", asset.id).select(ASSET_COLS).single());
    await log(req, "gfs_asset_" + to, updated, ev);
    res.json({ asset: await oneView(sb, req, updated) });
  } catch (e) {
    fail(res, e, "asset_stage");
  }
});

router.post("/:id/retire", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const asset = await loadAsset(sb, req, res);
    if (!asset) return;
    if (!worksOn(req, asset)) return res.status(403).json({ error: "region_not_yours" });
    if (asset.stage === "retired") return res.status(409).json({ error: "gfs_asset_retired" });
    const reason = String((req.body && req.body.reason) || "");
    if (!A.RETIRE_REASONS[reason]) return res.status(400).json({ error: "reason", allowed: Object.keys(A.RETIRE_REASONS) });
    const patch = { stage: "retired", retired_at: now(), retired_by: actor(req), retire_reason: reason };
    // A retired Moment or NFT keeps no content and nothing about the athlete
    // (NFT Terms §6): where the file was goes, then the athlete.
    const personal = asset.kind === "moment" || asset.kind === "narrative_nft";
    if (personal) {
      patch.ref = null;
      patch.sha256 = null;
    }
    const updated = await run(sb.from("gfs_assets").update(patch).eq("id", asset.id).select(ASSET_COLS).single());
    if (personal) await run(sb.from("gfs_asset_athletes").delete().eq("asset_id", asset.id));
    const ev = asset.event_id ? await run(sb.from("gfs_events").select(EVENT_COLS).eq("id", asset.event_id).maybeSingle()) : null;
    await log(req, "gfs_asset_retired", updated, ev);
    res.json({ asset: await oneView(sb, req, updated) });
  } catch (e) {
    fail(res, e, "retire_asset");
  }
});

// ── Picking athletes ─────────────────────────────────────────────────────
// The stop's roster, by team and jersey, with whether each athlete can be in
// this kind of asset (and why not). Directors and up.
router.get("/:id/roster", member, async (req, res) => {
  const sb = getSupabase();
  try {
    const asset = await loadAsset(sb, req, res);
    if (!asset) return;
    if (!worksOn(req, asset)) return res.status(403).json({ error: "region_not_yours" });
    if (!asset.event_id || A.KINDS[asset.kind].athletes === "none") return res.json({ athletes: [] });
    const rows = await all(() => sb.from("gfs_roster").select("*").eq("event_id", asset.event_id));
    const have = new Set(((await run(sb.from("gfs_asset_athletes").select("roster_row").eq("asset_id", asset.id))) || []).map((x) => x.roster_row));
    const athletes = rows
      .map((r) => {
        const why = A.assetBlocks({ kind: asset.kind }, [{ roster: r, team: r.team, jersey: r.jersey }], null, null)
          .filter(A.athleteReason)
          .map((b) => A.splitBlock(b).code);
        return { roster_row: r.id, roster_id: r.roster_id, team: r.team, jersey: r.jersey, position: r.position || null, in_asset: have.has(r.id), can: why.length === 0, why };
      })
      .sort((a, b) => String(a.team).localeCompare(String(b.team)) || (Number(a.jersey) || 0) - (Number(b.jersey) || 0));
    res.json({ athletes });
  } catch (e) {
    fail(res, e, "asset_roster");
  }
});

module.exports = router;
