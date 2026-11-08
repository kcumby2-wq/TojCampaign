"use strict";
// Studio films: a room for every film made from a kit (migration 039,
// agents/studio/films.js, docs/studio-films.md). Team members with Studio,
// signed in:
//
//   GET    /api/studio-films/meta                         templates, tools, limits, what you can do
//   GET    /api/studio-films/today                        what's waiting on you
//   GET    /api/studio-films/films                        the films (?archived=1 for archived ones)
//   POST   /api/studio-films/films                        start a film from a kit
//   GET    /api/studio-films/films/:id                    the room: steps, cards, cuts, reviews, posts, history
//   PATCH  /api/studio-films/films/:id                    edit (with the updated_at you saw)
//   POST   /api/studio-films/films/:id/archive            { archived }
//   POST   /api/studio-films/films/:id/notes              { note }
//   POST   /api/studio-films/films/:id/people             a clearance card
//   PATCH  /api/studio-films/films/:id/people/:pid        edit a card (a cleared card is cleared again)
//   DELETE /api/studio-films/films/:id/people/:pid        a card never cleared or used
//   POST   /api/studio-films/films/:id/people/:pid/clear  the producer clears it
//   POST   /api/studio-films/people/pull                  { person_code, note }: consent pulled, the 72-hour clock starts
//   POST   /api/studio-films/films/:id/steps/:step/done   { note, cut_id }
//   POST   /api/studio-films/films/:id/second-yes         { note }: the second sign-off (Coach Hooks), recorded
//   POST   /api/studio-films/films/:id/steps/:step/reopen { note }
//   POST   /api/studio-films/films/:id/cuts/upload        a signed upload link for a review copy
//   POST   /api/studio-films/films/:id/cuts               register the uploaded cut, with who's in it
//   PATCH  /api/studio-films/films/:id/cuts/:cid          { people } before it goes to review
//   DELETE /api/studio-films/films/:id/cuts/:cid          a cut never reviewed or posted
//   POST   /api/studio-films/films/:id/cuts/:cid/reviews  { person_id }: email the reviewer a one-time link
//   POST   /api/studio-films/reviews/:rid/cancel-link
//   POST   /api/studio-films/reviews/:rid/withdraw        the speaker took their yes back
//   POST   /api/studio-films/films/:id/posts              { cut_id, platform, url } (owner only)
//   POST   /api/studio-films/posts/:pid/removed
//   GET    /api/studio-films/takedowns                    open takedowns and their clocks
//   POST   /api/studio-films/takedowns/:tid/items         { film_id, label }: something else to take down
//   POST   /api/studio-films/takedown-items/:iid/done     { note }
//   POST   /api/studio-films/tools/:tool                  { on, note } (owner only)
//   POST   /api/studio-films/films/:id/cut-notes          { cut_id, at_ms, note, label }: a note at a moment
//   POST   /api/studio-films/cut-notes/:nid/resolve       the editor marks it done
//   GET    /api/studio-films/labels                       note labels and how often each came up
//   POST   /api/studio-films/films/:id/delivery-checks    what the browser read from an export, checked
//   POST   /api/studio-films/films/:id/slides/upload      signed links for stills or slides (1 to 10 images)
//   POST   /api/studio-films/films/:id/slides             register them for review
//   GET    /api/studio-films/films/:id/shoot              shoot mode: times, lights, the kit's rules for the day
//
// Who does what: members run films and their cards and cuts; the film's
// director and editor finish their own steps; approvers (the producer's role)
// clear cards, send review links, check rights and sign off; only the owner
// posts and turns tools on. Names stay in the cards: never in the history,
// the activity log, a title or a file name.

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../utils/supabase");
const T = require("../utils/team");
const P = require("../utils/push");
const mailer = require("../utils/mailer");
const H = require("../utils/pylon-http");
const U = require("../utils/studio-films");
const F = require("../agents/studio/films");
const S = require("../agents/studio/service");
const K = require("../agents/studio/kit");
const worker = require("../utils/studio-review-worker");

const router = express.Router();
const safe = H.safe("studio-films");
const member = T.requireTeam("studio", "member");
const env = (k) => String(process.env[k] || "").trim();
const SITE_BASE = () => (env("STUDIO_SITE_BASE") || "https://www.tojcampaign.com").replace(/\/+$/, "");
const nowIso = () => new Date().toISOString();
const me = (req) => req.team.email;
const isProducer = (req) => T.can(req.team, "studio", "approver");
const isOwner = (req) => !!req.team.owner;

// Review links per mailbox: 20 a day (a typo'd address can't be flooded).
const linksToday = new Map();
function linkAllowed(address, now = Date.now()) {
  const key = U.mailbox(address);
  const day = new Date(now).toISOString().slice(0, 10);
  const h = linksToday.get(key);
  if (!h || h.day !== day) {
    linksToday.set(key, { day, n: 1 });
    if (linksToday.size > 5000) linksToday.delete(linksToday.keys().next().value);
    return true;
  }
  h.n += 1;
  return h.n <= 20;
}
function giveBackLink(address) {
  const h = linksToday.get(U.mailbox(address));
  if (h && h.n > 0) h.n -= 1;
}

// Writes are JSON from the app: another site can't send one through a
// signed-in browser.
router.use((req, res, next) => {
  if (["POST", "PATCH", "DELETE"].includes(req.method) && !req.is("application/json")) return res.status(415).json({ error: "json_only" });
  if (["POST", "PATCH", "DELETE"].includes(req.method) && !H.originOk(req)) return res.status(403).json({ error: "wrong_origin" });
  res.set("Cache-Control", "private, no-store");
  next();
});

function withDb(fn) {
  return safe(async (req, res) => {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ error: "storage_unavailable" });
    return fn(req, res, sb);
  });
}
// Postgres ends a deadlock (two changes to one film in the same instant) by
// rolling one back: that one is tried once more, after the other is through.
const RETRY = new Set(["40P01", "40001"]);
async function run(query) {
  let { data, error } = await query;
  if (error && RETRY.has(error.code)) {
    await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 70)));
    ({ data, error } = await query);
  }
  if (error) throw Object.assign(new Error(error.message), { db: error });
  return data;
}
// The single-row writes a cascade can also reach go through the database's
// film-first functions (migration 039's lock order).
const rpcRows = async (sb, fn, args) => {
  let { data, error } = await sb.rpc(fn, args);
  if (error && RETRY.has(error.code)) {
    await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 70)));
    ({ data, error } = await sb.rpc(fn, args));
  }
  if (error) throw Object.assign(new Error(error.message), { db: error });
  return Array.isArray(data) ? data : data ? [data] : [];
};
// The database's refusals are written for people (migration 039): pass them
// on. Anything else is a plain error.
function refused(res, e) {
  const err = (e && e.db) || e || {};
  if (err.code === "P0001") return res.status(409).json({ error: "refused", reason: String(err.message || "").slice(0, 300) });
  if (err.code === "23505") return res.status(409).json({ error: "exists" });
  if (/^(23|22)/.test(String(err.code || ""))) return res.status(400).json({ error: "invalid" });
  console.error("[studio-films] storage error:", err.message || err);
  return res.status(503).json({ error: "storage_unavailable" });
}
const bodyOf = H.bodyOf;
const idOk = (s) => U.UUID.test(String(s || ""));
// A note that names someone on the film's cards is refused: the history
// keeps no names (the database leaves such a note out regardless).
const NOTE_HAS_NAME = { error: "invalid", fields: ["note_has_name"] };
const NOTE_HAS_MINOR_NAME = { error: "invalid", fields: ["note_has_minor_name"] };
// A note's names: a whole name (or one run together) is refused, and so is
// any word of a minor's name. A single word of an adult's name ("Will",
// "Mark") is asked about, and kept once the writer says that word isn't a
// name here: { names_ok: ["will"] }, the exact words, for this exact text
// (the app forgets them when the text changes). null when the note can be kept.
function noteNames(text, people, body) {
  if (!text) return null;
  if (U.namesIn(text, people, { strong: true }).length) return NOTE_HAS_NAME;
  if (U.minorWords(text, people).length) return NOTE_HAS_MINOR_NAME;
  const ok = U.namesOkWords(body && body.names_ok);
  const words = U.namesIn(text, people).filter((w) => !ok.has(w));
  if (words.length) return { error: "invalid", fields: ["note_may_have_name"], words: words.slice(0, 10) };
  return null;
}

async function filmById(sb, id) {
  if (!idOk(id)) return null;
  return (await run(sb.from("studio_films").select("*").eq("id", id).maybeSingle())) || null;
}
async function peopleOf(sb, filmId) {
  return (await run(sb.from("studio_film_people").select("*").eq("film_id", filmId).order("created_at", { ascending: true }))) || [];
}
async function toolOn(sb, tool) {
  const row = await run(sb.from("studio_tool_approvals").select("is_on").eq("tool", tool).maybeSingle());
  return !!(row && row.is_on);
}

// Who finishes a step: its owner in the kit's template.
function canFinish(req, film, stepKey) {
  const t = F.templateFor(film.kit_slug);
  const s = F.stepFor(t, stepKey);
  const owner = s ? s.owner : "producer";
  if (owner === "owner") return isOwner(req);
  if (isProducer(req)) return true;
  if (owner === "director") return !!film.director_email && film.director_email === me(req);
  if (owner === "editor") return !!film.editor_email && film.editor_email === me(req);
  return false;
}

// A review as staff see it: never the link itself.
function reviewView(r, now = Date.now()) {
  let state = "cancelled";
  if (r.decision === "approved") state = r.withdrawn_at ? "withdrawn" : "approved";
  else if (r.decision === "changes") state = "changes";
  else if (r.link_hash) state = new Date(r.expires_at).getTime() > now ? "live" : "expired";
  return {
    id: r.id, cut_id: r.cut_id, person_id: r.person_id, state, reviewer_relation: r.reviewer_relation,
    requested_at: r.requested_at, expires_at: r.expires_at, asked_by: r.asked_by, decided_at: r.decided_at,
    decided_name: r.decided_name, note: r.note, withdrawn_at: r.withdrawn_at, withdrawn_by: r.withdrawn_by,
  };
}

// Where a film is: its first step to do, and who that's waiting on.
function where(film, steps) {
  const t = F.templateFor(film.kit_slug);
  const next = steps.filter((s) => s.status === "todo").sort((a, b) => a.position - b.position)[0] || null;
  if (film.pulled_at) return { state: "pulled", step: null, label: "Consent pulled", waiting_on: "the producer (takedown)" };
  if (film.archived_at) return { state: "archived", step: null, label: "Archived", waiting_on: null };
  if (!next) return { state: "published", step: null, label: "Published", waiting_on: null };
  const st = F.stepFor(t, next.step);
  const owner = st ? st.owner : "producer";
  const who = owner === "director" ? film.director_email || "the director" : owner === "editor" ? film.editor_email || "the editor" : owner === "owner" ? "Kyron" : "the producer";
  return { state: "active", step: next.step, label: st ? st.label : next.step, owner, waiting_on: who };
}

// ── Meta ─────────────────────────────────────────────────────────────────
router.get("/meta", member, withDb(async (req, res, sb) => {
  const tools = (await run(sb.from("studio_tool_approvals").select("*").order("tool"))) || [];
  const templates = {};
  for (const [slug, t] of Object.entries(F.TEMPLATES)) {
    templates[slug] = { name: t.name, file_prefix: t.file_prefix, lanes: t.lanes, formats: t.formats, steps: t.steps, second_yes_label: t.second_yes_label, takedown: t.takedown };
  }
  res.json({
    templates,
    tools: tools.map((x) => ({ tool: x.tool, label: U.TOOLS[x.tool] || x.tool, is_on: x.is_on, decided_by: x.decided_by, decided_at: x.decided_at, note: x.note })),
    max_review_mb: U.MAX_REVIEW_MB(),
    platforms: U.PLATFORMS,
    // The TOJ banned list, for words on graphics (the kit: none on screen).
    banned: { words: K.BANNED_RE.source, phrases: K.BANNED_PHRASES_RE.source },
    // Two-letter name words that are everyday words: a minor's counts only
    // with a capital mid-sentence (utils/studio-films.js minorWords).
    everyday_2: [...U.EVERYDAY_2],
    // The export sizes the kit names, for the delivery check and graphics.
    sizes: U.KIT_SIZES,
    can: { producer: isProducer(req), owner: isOwner(req) },
  });
}));

// ── Films ────────────────────────────────────────────────────────────────
router.get("/films", member, withDb(async (req, res, sb) => {
  const archived = req.query.archived === "1";
  let qf = sb.from("studio_films").select("*").order("created_at", { ascending: false }).limit(200);
  qf = archived ? qf.not("archived_at", "is", null) : qf.is("archived_at", null);
  const films = (await run(qf)) || [];
  const ids = films.map((f) => f.id);
  const steps = ids.length ? (await run(sb.from("studio_film_steps").select("film_id,step,position,status").in("film_id", ids))) || [] : [];
  const people = ids.length ? (await run(sb.from("studio_film_people").select("film_id,cleared_at,consent_pulled_at").in("film_id", ids))) || [] : [];
  res.json({
    films: films.map((f) => {
      const mine = steps.filter((s) => s.film_id === f.id);
      const cards = people.filter((p) => p.film_id === f.id);
      return {
        id: f.id, title: f.title, kit_slug: f.kit_slug, lane: f.lane, athlete_id: f.athlete_id, format: f.format,
        post_date: f.post_date, created_at: f.created_at, pulled_at: f.pulled_at, archived_at: f.archived_at,
        done: mine.filter((s) => s.status === "done").length, cards: cards.length, cleared: cards.filter((p) => p.cleared_at && !p.consent_pulled_at).length,
        where: where(f, mine),
      };
    }),
  });
}));

router.post("/films", member, withDb(async (req, res, sb) => {
  const body = bodyOf(req);
  const slug = U.clean(body.kit_slug || "same-work", 60);
  const t = F.templateFor(slug);
  if (!t) return res.status(400).json({ error: "invalid", fields: ["kit_slug"] });
  const kit = await S.approvedKit(sb, slug);
  if (!kit) return res.status(409).json({ error: "no_approved_kit" });
  const { errors, value } = U.filmInput(body);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (!isProducer(req)) {
    // Members start films; the producer assigns who directs and edits.
    delete value.director_email;
    delete value.editor_email;
  }
  const row = { ...value, kit_slug: slug, kit_id: String(kit.id), kit_version: kit.version, second_yes_label: t.second_yes_label || null, created_by: me(req) };
  try {
    const film = await run(sb.from("studio_films").insert(row).select().single());
    await T.logActivity(me(req), "started_film", `${film.athlete_id} ${film.format}`, { film_id: film.id });
    res.json({ film });
  } catch (e) {
    refused(res, e);
  }
}));

router.get("/films/:id", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const [steps, people, cuts, reviews, posts, events] = await Promise.all([
    run(sb.from("studio_film_steps").select("*").eq("film_id", film.id).order("position", { ascending: true })),
    peopleOf(sb, film.id),
    run(sb.from("studio_film_cuts").select("*").eq("film_id", film.id).order("created_at", { ascending: true })),
    run(sb.from("studio_reviews").select("*").eq("film_id", film.id).order("created_at", { ascending: true })),
    run(sb.from("studio_film_posts").select("*").eq("film_id", film.id).order("posted_at", { ascending: true })),
    run(sb.from("studio_events").select("*").eq("film_id", film.id).order("id", { ascending: false }).limit(200)),
  ]);
  const [notes, checks] = await Promise.all([
    run(sb.from("studio_notes").select("*").eq("film_id", film.id).order("created_at", { ascending: true }).limit(500)).catch(() => []),
    run(sb.from("studio_delivery_checks").select("*").eq("film_id", film.id).order("created_at", { ascending: false }).limit(20)).catch(() => []),
  ]);
  const t = F.templateFor(film.kit_slug);
  let kit = null;
  try {
    kit = await S.approvedKit(sb, film.kit_slug);
  } catch (e) {
    kit = null;
  }
  // Watch links for ready cuts (an hour), for the team only.
  const keys = [];
  for (const c of cuts || []) if (c.status === "ready" && !film.pulled_at) keys.push(c.kind === "slides" ? null : c.preview_key, c.poster_key, ...U.slideCopyKeys(c));
  const signed = {};
  if (keys.filter(Boolean).length && sb.storage) {
    try {
      const { data } = await sb.storage.from(U.BUCKET).createSignedUrls(keys.filter(Boolean), 3600);
      for (const s of data || []) if (s && s.path && s.signedUrl) signed[s.path] = s.signedUrl;
    } catch (e) {
      console.warn("[studio-films] signed watch links failed:", e && e.message);
    }
  }
  const codes = new Set(people.map((p) => p.person_code));
  const takedowns = codes.size ? (await run(sb.from("studio_takedowns").select("*").in("person_code", [...codes]).order("requested_at", { ascending: false }).limit(20))) || [] : [];
  const items = takedowns.length ? (await run(sb.from("studio_takedown_items").select("*").in("takedown_id", takedowns.map((x) => x.id)))) || [] : [];
  res.json({
    film,
    where: where(film, steps || []),
    template: t ? { name: t.name, lanes: t.lanes, formats: t.formats, second_yes_label: t.second_yes_label, takedown: t.takedown } : null,
    kit: kit ? { id: kit.id, version: kit.version, title: kit.title } : null,
    steps: (steps || []).map((s) => {
      const ts = F.stepFor(t, s.step) || {};
      return { ...s, label: ts.label || s.step, owner: ts.owner || "producer", carries: ts.carries || "", done_when: ts.done_when || "", checklist: ts.checklist ? F.checklistFor(kit && kit.kit, ts.checklist) : [], checklist_title: ts.checklist || null, can_finish: canFinish(req, film, s.step) };
    }),
    people: people.map((p) => ({ ...p, gaps: U.clearanceGaps(p) })),
    cuts: (cuts || []).map((c) => ({
      ...c,
      poster_url: c.poster_key ? signed[c.poster_key] || null : null,
      watch_url: c.kind === "slides" ? null : c.preview_key ? signed[c.preview_key] || null : null,
      slide_urls: c.status === "ready" ? U.slideCopyKeys(c).map((k) => signed[k] || null) : [],
      warnings: [...(U.strictNames(String(c.file_name || "").replace(/\.[a-z0-9]+$/i, ""), people).length ? ["The file name has a name in it: rename the export, the kit's way"] : []), ...(c.kind === "video" ? U.nameWarnings(c.file_name, film, c) : [])],
    })),
    notes: notes || [],
    delivery_checks: checks || [],
    reviews: (reviews || []).map((r) => reviewView(r)),
    posts: posts || [],
    takedowns: takedowns.map((x) => ({ ...x, items: items.filter((i) => i.takedown_id === x.id) })),
    events: events || [],
    can: { producer: isProducer(req), owner: isOwner(req) },
  });
}));

router.patch("/films/:id", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  if (typeof body.seen !== "string") return res.status(400).json({ error: "invalid", fields: ["seen"] });
  const people = await peopleOf(sb, film.id);
  const { errors, value } = U.filmInput(body, { partial: true, people });
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (!isProducer(req) && ("director_email" in value || "editor_email" in value)) return res.status(403).json({ error: "producer_only" });
  if (!Object.keys(value).length) return res.json({ film });
  try {
    const rows = await run(sb.from("studio_films").update({ ...value, changed_by: me(req), updated_at: nowIso() }).eq("id", film.id).eq("updated_at", body.seen).select());
    if (!rows || !rows.length) return res.status(409).json({ error: "changed_meanwhile" });
    res.json({ film: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

router.post("/films/:id/archive", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const archived = bodyOf(req).archived === true;
  try {
    const rows = await run(sb.from("studio_films").update(archived ? { archived_at: nowIso(), archived_by: me(req), changed_by: me(req), updated_at: nowIso() } : { archived_at: null, changed_by: me(req), updated_at: nowIso() }).eq("id", film.id).select());
    res.json({ film: rows && rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

router.post("/films/:id/notes", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const note = U.cleanNotes(bodyOf(req).note, 1000);
  if (!note) return res.status(400).json({ error: "invalid", fields: ["note"] });
  const why = noteNames(note, await peopleOf(sb, film.id), bodyOf(req));
  if (why) return res.status(400).json(why);
  try {
    await run(sb.from("studio_events").insert({ film_id: film.id, kind: "note", by_staff: me(req), note }));
    res.json({ ok: true });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Clearance cards ──────────────────────────────────────────────────────
router.post("/films/:id/people", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const { errors, value } = U.personInput(bodyOf(req));
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (value.reconsent_note && !isProducer(req)) return res.status(403).json({ error: "producer_only" });
  // The title and the story never carry a name: if they have this one, they
  // change first.
  if (U.strictNames(film.title, [value]).length) return res.status(409).json({ error: "title_has_name" });
  if (film.one_sentence && U.strictNames(film.one_sentence, [value]).length) return res.status(409).json({ error: "story_has_name" });
  try {
    const person = await run(sb.from("studio_film_people").insert({ ...value, film_id: film.id, created_by: me(req) }).select().single());
    res.json({ person: { ...person, gaps: U.clearanceGaps(person) } });
  } catch (e) {
    refused(res, e);
  }
}));

router.patch("/films/:id/people/:pid", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film || !idOk(req.params.pid)) return res.status(404).json({ error: "not_found" });
  const current = await run(sb.from("studio_film_people").select("*").eq("id", req.params.pid).eq("film_id", film.id).maybeSingle());
  if (!current) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  if (typeof body.seen !== "string") return res.status(400).json({ error: "invalid", fields: ["seen"] });
  if ("reconsent_note" in body) return res.status(400).json({ error: "invalid", fields: ["reconsent_note"] });
  const { errors, value } = U.personInput(body, { partial: true, current });
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  // Who approves the cut is the producer's to change (a change stops that
  // card's live links; the database holds that).
  const reviewerChanged = ["reviewer_relation", "reviewer_name", "reviewer_email"].some((k) => k in value && value[k] !== current[k]);
  if (reviewerChanged && !isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const next = { ...current, ...value };
  if ((value.name || value.reviewer_name || "is_minor" in value) && U.strictNames(film.title, [next]).length) return res.status(409).json({ error: "title_has_name" });
  if ((value.name || value.reviewer_name || "is_minor" in value) && film.one_sentence && U.strictNames(film.one_sentence, [next]).length) return res.status(409).json({ error: "story_has_name" });
  if (!Object.keys(value).length) return res.json({ person: current });
  try {
    const rows = await rpcRows(sb, "studio_card_save", { p_person: current.id, p_seen: body.seen, p_patch: value, p_by: me(req) });
    if (!rows.length) return res.status(409).json({ error: "changed_meanwhile" });
    res.json({ person: { ...rows[0], gaps: U.clearanceGaps(rows[0]) }, uncleared: !!current.cleared_at && !rows[0].cleared_at });
  } catch (e) {
    refused(res, e);
  }
}));

router.delete("/films/:id/people/:pid", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film || !idOk(req.params.pid)) return res.status(404).json({ error: "not_found" });
  const card = await run(sb.from("studio_film_people").select("id").eq("id", req.params.pid).eq("film_id", film.id).maybeSingle());
  if (!card) return res.status(404).json({ error: "not_found" });
  try {
    const rows = await rpcRows(sb, "studio_card_remove", { p_person: card.id });
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    refused(res, e);
  }
}));

router.post("/films/:id/people/:pid/clear", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const film = await filmById(sb, req.params.id);
  if (!film || !idOk(req.params.pid)) return res.status(404).json({ error: "not_found" });
  const person = await run(sb.from("studio_film_people").select("*").eq("id", req.params.pid).eq("film_id", film.id).maybeSingle());
  if (!person) return res.status(404).json({ error: "not_found" });
  const gaps = U.clearanceGaps(person);
  if (gaps.length) return res.status(409).json({ error: "gaps", gaps });
  const seen = bodyOf(req).seen;
  if (typeof seen !== "string") return res.status(400).json({ error: "invalid", fields: ["seen"] });
  try {
    const rows = await rpcRows(sb, "studio_card_clear", { p_person: person.id, p_seen: seen, p_by: me(req) });
    if (!rows.length) return res.status(409).json({ error: "changed_meanwhile" });
    res.json({ person: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

// A pulled consent: every film the person is in is pulled, its live posts go
// on the takedown list, and the 72-hour clock starts. Review copies of those
// films come out of storage now.
router.post("/people/pull", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const body = bodyOf(req);
  const code = U.code(body.person_code);
  if (!code) return res.status(400).json({ error: "invalid", fields: ["person_code"] });
  if (body.confirm !== true) return res.status(400).json({ error: "confirm_first" });
  const note = U.cleanNotes(body.note, 500) || null;
  if (note) {
    const cards = (await run(sb.from("studio_film_people").select("name,reviewer_name").eq("person_code", code))) || [];
    const why = noteNames(note, cards, body);
    if (why) return res.status(400).json(why);
  }
  const out = await pullConsent(sb, { code, by: me(req), source: "staff", note });
  if (out.error) return refused(res, out.error);
  if (!out.takedown) return res.status(404).json({ error: "nothing_to_pull" });
  await T.logActivity(me(req), "pulled_consent", code, { takedown_id: out.takedown.id });
  res.json(out);
}));

async function pullConsent(sb, { code, by, source, note }) {
  const films = (await run(sb.from("studio_film_people").select("film_id").eq("person_code", code).is("consent_pulled_at", null))) || [];
  let takedown = null;
  try {
    const data = await run(sb.rpc("studio_pull_consent", { p_person_code: code, p_by: by, p_source: source, p_note: note }));
    const first = Array.isArray(data) ? data[0] : data;
    const id = first && (first.takedown_id || (typeof first === "string" ? first : null));
    if (id) takedown = await run(sb.from("studio_takedowns").select("*").eq("id", id).maybeSingle());
  } catch (e) {
    return { error: e };
  }
  // Their films' files leave storage: the database listed them in the same
  // change; what fails now, the worker retries.
  const filmIds = [...new Set(films.map((f) => f.film_id))];
  const removed = (await worker.sweep({ sb }).catch(() => ({ removed: 0 }))).removed;
  if (takedown) {
    P.notifySoon(P.teamEmails("approver"), { title: "Consent pulled: takedown clock started", body: `${code}: everything down within 72 hours.`, url: "/app/#film-takedowns", tag: `takedown-${takedown.id}` });
  }
  return { takedown, films: filmIds.length, files_removed: removed };
}

// ── Steps ────────────────────────────────────────────────────────────────
router.post("/films/:id/steps/:step/done", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film || !F.STEP_KEYS.includes(req.params.step)) return res.status(404).json({ error: "not_found" });
  if (!canFinish(req, film, req.params.step)) return res.status(403).json({ error: "not_your_step" });
  const body = bodyOf(req);
  const patch = { status: "done", done_by: me(req), note: U.cleanNotes(body.note, 500) || null, updated_at: nowIso() };
  const why = noteNames(patch.note, await peopleOf(sb, film.id), body);
  if (why) return res.status(400).json(why);
  if (req.params.step === "speaker_review") {
    // The cuts that go on: the rights check and the sign-off are for these,
    // and only these are posted.
    const ids = Array.isArray(body.cut_ids) ? body.cut_ids : body.cut_id ? [body.cut_id] : [];
    const list = [...new Set(ids.map((x) => String(x || "").toLowerCase()))];
    if (!list.length || list.length > 10 || !list.every(idOk)) return res.status(400).json({ error: "invalid", fields: ["cut_ids"] });
    patch.cut_ids = list;
  }
  try {
    const rows = await rpcRows(sb, "studio_step_done", { p_film: film.id, p_step: req.params.step, p_by: me(req), p_note: patch.note, p_cut_ids: patch.cut_ids || null });
    if (!rows.length) return res.status(409).json({ error: "already_done" });
    if (req.params.step === "publish") await T.logActivity(me(req), "published_film", `${film.athlete_id} ${film.format}`, { film_id: film.id });
    res.json({ step: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

router.post("/films/:id/second-yes", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  if (!film.second_yes_label) return res.status(409).json({ error: "no_second_yes" });
  const note = U.clean(bodyOf(req).note, 300);
  if (!note) return res.status(400).json({ error: "invalid", fields: ["note"] });
  const why = noteNames(note, await peopleOf(sb, film.id), bodyOf(req));
  if (why) return res.status(400).json(why);
  try {
    const rows = await rpcRows(sb, "studio_second_yes", { p_film: film.id, p_by: film.second_yes_label, p_note: note });
    if (!rows.length) return res.status(409).json({ error: "already_done" });
    res.json({ step: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

router.post("/films/:id/steps/:step/reopen", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const film = await filmById(sb, req.params.id);
  if (!film || !F.STEP_KEYS.includes(req.params.step)) return res.status(404).json({ error: "not_found" });
  const note = U.cleanNotes(bodyOf(req).note, 500);
  if (!note) return res.status(400).json({ error: "invalid", fields: ["note"] });
  const why = noteNames(note, await peopleOf(sb, film.id), bodyOf(req));
  if (why) return res.status(400).json(why);
  try {
    await run(sb.rpc("studio_film_reopen", { p_film: film.id, p_step: req.params.step, p_by: me(req), p_note: note }));
    res.json({ ok: true });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Cuts ─────────────────────────────────────────────────────────────────
router.post("/films/:id/cuts/upload", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  if (film.pulled_at || film.archived_at) return res.status(409).json({ error: "film_closed" });
  if (!(await toolOn(sb, "review_copies"))) return res.status(409).json({ error: "tool_off", tool: "review_copies" });
  const people = await peopleOf(sb, film.id);
  const { errors, value } = U.cutInput(bodyOf(req), { filmPeople: people });
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors, max_mb: U.MAX_REVIEW_MB() });
  const id = crypto.randomUUID();
  const key = U.cutKey(film.id, id, value.ext);
  const { data, error } = await sb.storage.from(U.BUCKET).createSignedUploadUrl(key);
  if (error || !data) {
    console.error("[studio-films] signed upload failed:", error && error.message);
    return res.status(503).json({ error: "storage_unavailable" });
  }
  res.json({ id, key, signed_url: data.signedUrl, content_type: value.content_type, warnings: U.nameWarnings(value.file_name, film, value) });
}));

router.post("/films/:id/cuts", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const people = await peopleOf(sb, film.id);
  const { errors, value } = U.cutInput(body, { filmPeople: people });
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (!idOk(body.id) || String(body.key || "") !== U.cutKey(film.id, String(body.id).toLowerCase(), value.ext)) return res.status(400).json({ error: "invalid", fields: ["key"] });
  // It has to be in storage, and its size is what storage holds.
  const { data: stored, error: missing } = await sb.storage.from(U.BUCKET).info(body.key);
  if (missing || !stored) return res.status(409).json({ error: "not_uploaded" });
  const size = Number(stored.size);
  const bytes = Number.isInteger(size) && size > 0 ? size : value.bytes;
  if (bytes > U.MAX_REVIEW_MB() * 1024 * 1024) return res.status(400).json({ error: "invalid", fields: ["too_big"] });
  const row = { id: String(body.id).toLowerCase(), film_id: film.id, kind: "video", format: value.format, ratio: value.ratio, version: value.version, file_name: value.file_name, people: value.people, object_key: body.key, bytes, created_by: me(req) };
  try {
    const cut = await run(sb.from("studio_film_cuts").insert(row).select().single());
    worker.kick();
    res.json({ cut });
  } catch (e) {
    refused(res, e);
  }
}));

router.patch("/films/:id/cuts/:cid", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film || !idOk(req.params.cid)) return res.status(404).json({ error: "not_found" });
  const people = await peopleOf(sb, film.id);
  const ids = new Set(people.map((p) => p.id));
  const list = Array.isArray(bodyOf(req).people) ? [...new Set(bodyOf(req).people.slice(0, 50).map((x) => String(x).toLowerCase()))] : null;
  if (!list || list.some((x) => !ids.has(x))) return res.status(400).json({ error: "invalid", fields: ["people"] });
  try {
    const rows = await run(sb.from("studio_film_cuts").update({ people: list, updated_at: nowIso() }).eq("id", req.params.cid).eq("film_id", film.id).select());
    if (!rows || !rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ cut: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

router.delete("/films/:id/cuts/:cid", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film || !idOk(req.params.cid)) return res.status(404).json({ error: "not_found" });
  try {
    const rows = await run(sb.from("studio_film_cuts").delete().eq("id", req.params.cid).eq("film_id", film.id).select("id"));
    if (!rows || !rows.length) return res.status(404).json({ error: "not_found" });
    // The database listed its files for removal in the same change.
    await worker.sweep({ sb }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Review links ─────────────────────────────────────────────────────────
// The link carries a token after "#t="; the database keeps sha256 of its
// proof (sha256 of the token), so nobody who can read the table can answer.
router.post("/films/:id/cuts/:cid/reviews", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const film = await filmById(sb, req.params.id);
  if (!film || !idOk(req.params.cid)) return res.status(404).json({ error: "not_found" });
  const personId = String(bodyOf(req).person_id || "").toLowerCase();
  if (!idOk(personId)) return res.status(400).json({ error: "invalid", fields: ["person_id"] });
  const [cut, person] = await Promise.all([
    run(sb.from("studio_film_cuts").select("*").eq("id", req.params.cid).eq("film_id", film.id).maybeSingle()),
    run(sb.from("studio_film_people").select("*").eq("id", personId).eq("film_id", film.id).maybeSingle()),
  ]);
  if (!cut || !person) return res.status(404).json({ error: "not_found" });
  if (!person.reviewer_email) return res.status(409).json({ error: "no_reviewer" });
  if (!linkAllowed(person.reviewer_email)) return res.status(429).json({ error: "too_many_links_today" });
  const token = crypto.randomBytes(32).toString("hex");
  const proof = U.sha256(token);
  const expires = new Date(Date.now() + U.REVIEW_TTL_MS).toISOString();
  let review;
  try {
    review = await run(
      sb.from("studio_reviews").insert({
        film_id: film.id, cut_id: cut.id, person_id: person.id, reviewer_email: person.reviewer_email, reviewer_relation: person.reviewer_relation,
        link_hash: U.sha256(proof), expires_at: expires, asked_fingerprint: cut.sha256 || "0".repeat(64), asked_by: me(req),
      }).select().single()
    );
  } catch (e) {
    giveBackLink(person.reviewer_email);
    return refused(res, e);
  }
  const t = F.templateFor(film.kit_slug);
  const fmt = t && t.formats[cut.format];
  const m = U.reviewEmail({ reviewerName: person.reviewer_name, relation: person.reviewer_relation, formatLabel: fmt ? fmt.label : "film", link: `${SITE_BASE()}/film-review.html#t=${token}`, expiresAt: expires });
  // Replies go back to the reviewer (or an address nobody reads), never to
  // staff: a reply quotes the link.
  const replyTo = U.email(env("STUDIO_REVIEW_REPLY_TO")) || person.reviewer_email;
  let sent = null;
  try {
    sent = await mailer.sendMail({ to: person.reviewer_email, subject: m.subject, text: m.text, replyTo, pool: "studio_review" });
  } catch (e) {
    console.warn("[studio-films] review email failed:", mailer.errorCode(e));
  }
  if (!sent || !sent.sent) {
    // No email, no link: take it back (film first, like every cancel). If
    // that fails too, the link is live but was never sent: say so, so it's
    // cancelled by hand before another goes out.
    giveBackLink(person.reviewer_email);
    let cancelled = false;
    try {
      cancelled = (await rpcRows(sb, "studio_review_cancel", { p_review: review.id, p_by: me(req) })).length > 0;
    } catch (e) {
      console.error("[studio-films] couldn't take back an unsent review link:", e && e.message);
    }
    const reason = sent && sent.reason === "email_not_configured" ? "email_not_set_up" : "email_failed";
    return res.status(502).json(cancelled ? { error: reason } : { error: reason, link_live: true, review_id: review.id });
  }
  await T.logActivity(me(req), "sent_review_link", person.person_code, { film_id: film.id, cut_id: cut.id });
  res.json({ review: reviewView(review) });
}));

router.post("/reviews/:rid/cancel-link", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  if (!idOk(req.params.rid)) return res.status(404).json({ error: "not_found" });
  try {
    const rows = await rpcRows(sb, "studio_review_cancel", { p_review: req.params.rid, p_by: me(req) });
    if (!rows.length) return res.status(409).json({ error: "no_live_link" });
    res.json({ review: reviewView(rows[0]) });
  } catch (e) {
    refused(res, e);
  }
}));

router.post("/reviews/:rid/withdraw", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  if (!idOk(req.params.rid)) return res.status(404).json({ error: "not_found" });
  try {
    const rows = await rpcRows(sb, "studio_review_withdraw", { p_review: req.params.rid, p_by: me(req) });
    if (!rows.length) return res.status(409).json({ error: "not_approved" });
    res.json({ review: reviewView(rows[0]) });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Posts ────────────────────────────────────────────────────────────────
router.post("/films/:id/posts", member, withDb(async (req, res, sb) => {
  if (!isOwner(req)) return res.status(403).json({ error: "owner_only" });
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const platform = U.clean(body.platform, 20).toLowerCase();
  const url = U.https(body.url);
  const fields = [];
  if (!idOk(body.cut_id)) fields.push("cut_id");
  if (!U.PLATFORMS.includes(platform)) fields.push("platform");
  if (!url) fields.push("url");
  if (fields.length) return res.status(400).json({ error: "invalid", fields });
  try {
    const post = await run(sb.from("studio_film_posts").insert({ film_id: film.id, cut_id: body.cut_id, platform, url, posted_by: me(req) }).select().single());
    res.json({ post });
  } catch (e) {
    refused(res, e);
  }
}));

router.post("/posts/:pid/removed", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  if (!idOk(req.params.pid)) return res.status(404).json({ error: "not_found" });
  try {
    const rows = await rpcRows(sb, "studio_post_remove", { p_post: req.params.pid, p_by: me(req) });
    if (!rows.length) return res.status(409).json({ error: "already_removed" });
    res.json({ post: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Takedowns ────────────────────────────────────────────────────────────
router.get("/takedowns", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const open = (await run(sb.from("studio_takedowns").select("*").is("closed_at", null).order("due_at", { ascending: true }).limit(50))) || [];
  const recent = (await run(sb.from("studio_takedowns").select("*").gte("closed_at", since).order("closed_at", { ascending: false }).limit(20))) || [];
  const all = [...open, ...recent];
  const items = all.length ? (await run(sb.from("studio_takedown_items").select("*").in("takedown_id", all.map((t) => t.id)))) || [] : [];
  const postIds = items.map((i) => i.post_id).filter(Boolean);
  const filmIds = [...new Set(items.map((i) => i.film_id))];
  const posts = postIds.length ? (await run(sb.from("studio_film_posts").select("id,platform,url,removed_at").in("id", postIds))) || [] : [];
  const films = filmIds.length ? (await run(sb.from("studio_films").select("id,title,athlete_id,format").in("id", filmIds))) || [] : [];
  const view = (t) => ({
    ...t,
    items: items.filter((i) => i.takedown_id === t.id).map((i) => ({ ...i, post: posts.find((p) => p.id === i.post_id) || null, film: films.find((f) => f.id === i.film_id) || null })),
  });
  res.json({ open: open.map(view), recent: recent.map(view) });
}));

router.post("/takedowns/:tid/items", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const body = bodyOf(req);
  const label = U.clean(body.label, 200);
  if (!idOk(req.params.tid) || !idOk(body.film_id) || !label) return res.status(400).json({ error: "invalid" });
  const td = await run(sb.from("studio_takedowns").select("id,person_code").eq("id", req.params.tid).maybeSingle());
  if (!td) return res.status(404).json({ error: "not_found" });
  const inFilm = await run(sb.from("studio_film_people").select("id").eq("film_id", body.film_id).eq("person_code", td.person_code).limit(1));
  if (!inFilm || !inFilm.length) return res.status(400).json({ error: "invalid", fields: ["film_id"] });
  const why = noteNames(label, await peopleOf(sb, body.film_id), body);
  if (why) return res.status(400).json(why.fields[0] === "note_has_name" ? { error: "invalid", fields: ["label_has_name"] } : why);
  try {
    const item = await run(sb.from("studio_takedown_items").insert({ takedown_id: td.id, film_id: body.film_id, what: "other", label }).select().single());
    res.json({ item });
  } catch (e) {
    refused(res, e);
  }
}));

router.post("/takedown-items/:iid/done", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  if (!idOk(req.params.iid)) return res.status(404).json({ error: "not_found" });
  const note = U.cleanNotes(bodyOf(req).note, 500) || null;
  if (note) {
    const item = await run(sb.from("studio_takedown_items").select("film_id").eq("id", req.params.iid).maybeSingle());
    if (!item) return res.status(404).json({ error: "not_found" });
    const why = noteNames(note, await peopleOf(sb, item.film_id), bodyOf(req));
    if (why) return res.status(400).json(why);
  }
  try {
    const rows = await rpcRows(sb, "studio_takedown_item_done", { p_item: req.params.iid, p_by: me(req), p_note: note });
    if (!rows.length) return res.status(409).json({ error: "already_done" });
    res.json({ item: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Tool approvals ───────────────────────────────────────────────────────
// The kit: a new tool touches footage only once the producer has checked its
// terms and added it, with a one-line reason.
router.post("/tools/:tool", member, withDb(async (req, res, sb) => {
  if (!isOwner(req)) return res.status(403).json({ error: "owner_only" });
  if (!U.TOOLS[req.params.tool]) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const on = body.on === true;
  const note = U.clean(body.note, 500) || null;
  if (on && !note) return res.status(400).json({ error: "invalid", fields: ["note"] });
  try {
    const rows = await run(sb.from("studio_tool_approvals").update({ is_on: on, note, decided_by: me(req) }).eq("tool", req.params.tool).select());
    if (!rows || !rows.length) return res.status(404).json({ error: "not_found" });
    await T.logActivity(me(req), on ? "tool_on" : "tool_off", req.params.tool, null);
    res.json({ tool: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Notes on a cut ───────────────────────────────────────────────────────
router.post("/films/:id/cut-notes", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const note = U.cleanNotes(body.note, 1000);
  const fields = [];
  if (!note) fields.push("note");
  const cutId = body.cut_id ? String(body.cut_id).toLowerCase() : null;
  if (cutId && !idOk(cutId)) fields.push("cut_id");
  let atMs = null;
  if (body.at_ms !== undefined && body.at_ms !== null) {
    atMs = Math.round(Number(body.at_ms));
    if (!Number.isFinite(atMs) || atMs < 0 || atMs > 36000000 || !cutId) fields.push("at_ms");
  }
  const lab = body.label ? U.label(body.label) : null;
  if (body.label && !lab) fields.push("label");
  if (fields.length) return res.status(400).json({ error: "invalid", fields });
  // Notes are kept for good: no names in them (a word that's also a name is
  // asked about first), and none in a label, which is shared across films.
  const people = await peopleOf(sb, film.id);
  const why = noteNames(note, people, body);
  if (why) return res.status(400).json(why);
  if (lab && U.strictNames(lab, people).length) return res.status(400).json({ error: "invalid", fields: ["label_has_name"] });
  try {
    const row = await run(sb.from("studio_notes").insert({ film_id: film.id, cut_id: cutId, at_ms: atMs, note, label: lab, created_by: me(req) }).select().single());
    res.json({ note: row });
  } catch (e) {
    refused(res, e);
  }
}));

router.post("/cut-notes/:nid/resolve", member, withDb(async (req, res, sb) => {
  if (!idOk(req.params.nid)) return res.status(404).json({ error: "not_found" });
  try {
    const rows = await run(sb.from("studio_notes").update({ resolved_at: nowIso(), resolved_by: me(req) }).eq("id", req.params.nid).is("resolved_at", null).select());
    if (!rows || !rows.length) return res.status(409).json({ error: "already_done" });
    res.json({ note: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

// The labels in use, most used first: the same note made three times is
// proposed as a rule (docs/studio-films.md).
router.get("/labels", member, withDb(async (req, res, sb) => {
  const rows = (await run(sb.from("studio_notes").select("label,film_id").not("label", "is", null).limit(5000))) || [];
  const by = new Map();
  for (const r of rows) {
    const x = by.get(r.label) || { label: r.label, notes: 0, films: new Set() };
    x.notes += 1;
    x.films.add(r.film_id);
    by.set(r.label, x);
  }
  res.json({ labels: [...by.values()].map((x) => ({ label: x.label, notes: x.notes, films: x.films.size })).sort((a, b) => b.notes - a.notes || a.label.localeCompare(b.label)) });
}));

// ── Delivery checks ──────────────────────────────────────────────────────
router.post("/films/:id/delivery-checks", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const { errors, value } = U.deliveryInput(bodyOf(req));
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const people = await peopleOf(sb, film.id);
  const { passed, results } = U.deliveryCheck(film, value, people);
  // A name never goes into the record: a file name that has one is kept as
  // "(a file name with a name in it)".
  const fileName = results.some((r) => r.key === "names" && r.ok === false) ? "(a file name with a name in it)" : value.file_name;
  try {
    const row = await run(sb.from("studio_delivery_checks").insert({ film_id: film.id, created_by: me(req), file_name: fileName, format: value.format, ratio: value.ratio, duration_ms: value.duration_ms, width: value.width, height: value.height, bytes: value.bytes, passed, results }).select().single());
    res.json({ check: row });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Stills and slides for review ─────────────────────────────────────────
// A parent card, a quote card, a carousel: 1 to 10 images (PNG or JPEG), each
// straight to storage on a signed link, in order. Uploaded from the editor's
// own tools, or made in the app with the graphics system, which waits for
// Kyron and Coach Hooks (Tool approvals). The worker makes the copies speakers
// see, marked REVIEW COPY, and fingerprints the files themselves.
const MAX_SLIDES = 10;
const MAX_SLIDE_BYTES = 20 * 1024 * 1024;
const SLIDE_TYPES = { png: "image/png", jpg: "image/jpeg" };
async function slidesAllowed(sb, res, film, madeWith) {
  if (film.pulled_at || film.archived_at) {
    res.status(409).json({ error: "film_closed" });
    return false;
  }
  if (!(await toolOn(sb, "review_copies"))) {
    res.status(409).json({ error: "tool_off", tool: "review_copies" });
    return false;
  }
  if (madeWith === "graphics" && !(await toolOn(sb, "graphics_system"))) {
    res.status(409).json({ error: "tool_off", tool: "graphics_system" });
    return false;
  }
  return true;
}
function slidesInput(body, filmPeople) {
  const errors = [];
  const v = {
    format: U.clean(body.format, 20).toLowerCase(),
    ratio: U.clean(body.ratio, 5).toLowerCase(),
    version: Number(body.version),
    file_name: U.clean(body.file_name, 200).replace(/[/\\]/g, ""),
    made_with: body.made_with === "graphics" ? "graphics" : body.made_with === "upload" ? "upload" : null,
    slides: Array.isArray(body.slides) ? body.slides.slice(0, MAX_SLIDES + 1).map((x) => (x === "jpeg" ? "jpg" : String(x || "").toLowerCase())) : [],
  };
  if (!U.FORMATS.includes(v.format)) errors.push("format");
  if (!U.RATIOS.includes(v.ratio)) errors.push("ratio");
  if (!Number.isInteger(v.version) || v.version < 1 || v.version > 999) errors.push("version");
  if (!v.made_with) errors.push("made_with");
  if (!v.slides.length || v.slides.length > MAX_SLIDES || v.slides.some((x) => !SLIDE_TYPES[x])) errors.push("slides");
  if (!v.file_name) errors.push("file_name");
  else if (U.strictNames(v.file_name, filmPeople).length) errors.push("file_name_has_name");
  const ids = new Set(filmPeople.map((p) => p.id));
  v.people = Array.isArray(body.people) ? [...new Set(body.people.slice(0, 50).map((x) => String(x).toLowerCase()))] : [];
  if (v.people.some((x) => !ids.has(x))) errors.push("people");
  return { errors, value: v };
}

router.post("/films/:id/slides/upload", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const people = await peopleOf(sb, film.id);
  const { errors, value } = slidesInput(bodyOf(req), people);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (!(await slidesAllowed(sb, res, film, value.made_with))) return;
  const id = crypto.randomUUID();
  const uploads = [];
  for (let n = 1; n <= value.slides.length; n++) {
    const ext = value.slides[n - 1];
    const key = U.slideKey(film.id, id, n, ext);
    const { data, error } = await sb.storage.from(U.BUCKET).createSignedUploadUrl(key);
    if (error || !data) return res.status(503).json({ error: "storage_unavailable" });
    uploads.push({ n, key, signed_url: data.signedUrl, content_type: SLIDE_TYPES[ext] });
  }
  res.json({ id, uploads, max_bytes: MAX_SLIDE_BYTES });
}));

router.post("/films/:id/slides", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const people = await peopleOf(sb, film.id);
  const { errors, value } = slidesInput(body, people);
  const id = String(body.id || "").toLowerCase();
  if (!idOk(id)) errors.push("id");
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (!(await slidesAllowed(sb, res, film, value.made_with))) return;
  const keys = [];
  for (let n = 1; n <= value.slides.length; n++) {
    const key = U.slideKey(film.id, id, n, value.slides[n - 1]);
    const { data: stored, error: missing } = await sb.storage.from(U.BUCKET).info(key);
    if (missing || !stored) return res.status(409).json({ error: "not_uploaded" });
    if (Number(stored.size) > MAX_SLIDE_BYTES) {
      await sb.storage.from(U.BUCKET).remove(value.slides.map((x, i) => U.slideKey(film.id, id, i + 1, x))).catch(() => {});
      return res.status(400).json({ error: "invalid", fields: ["too_big"] });
    }
    keys.push(key);
  }
  try {
    const cut = await run(sb.from("studio_film_cuts").insert({ id, film_id: film.id, kind: "slides", format: value.format, ratio: value.ratio, version: value.version, file_name: value.file_name, people: value.people, slide_keys: keys, made_with: value.made_with, created_by: me(req) }).select().single());
    await T.logActivity(me(req), "studio_slides_uploaded", film.id, { slides: keys.length, made_with: value.made_with });
    worker.kick();
    res.json({ cut });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Shoot mode ───────────────────────────────────────────────────────────
// What the director needs on set: call times, the cards' lights, the kit's
// rules for the day and the shots. "offline" is the part the phone may keep
// for a dead signal: codes, times and shots, never names, contacts or places.
const SHOOT_CARDS = ["6. Minors on set", "3. Thirteen interview rules", "4. Run the day"];
const FORMAT_CARDS = { same_drill: ["5. The Same Drill match cut"], on_the_mic: ["8. On set for the new formats"], own_words: ["8. On set for the new formats"] };
router.get("/films/:id/shoot", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const people = await peopleOf(sb, film.id);
  let kit = null;
  try {
    kit = await S.approvedKit(sb, film.kit_slug);
  } catch (e) {
    kit = null;
  }
  const k = kit && kit.kit;
  const titles = [...SHOOT_CARDS, ...(FORMAT_CARDS[film.format] || [])];
  const cards = titles.map((t) => F.cardFor(k, t)).filter(Boolean);
  const checklist = F.cardFor(k, "Shoot day: director");
  const plan = film.plan || {};
  const fp = plan.frame_pair || {};
  const t = F.templateFor(film.kit_slug);
  const light = (p) => ({
    id: p.id,
    code: p.person_code,
    role: p.role,
    is_minor: !!p.is_minor,
    texas_youth: !!p.texas_youth,
    speaker: !!p.speaker,
    cleared: !!p.cleared_at && !p.consent_pulled_at,
    pulled: !!p.consent_pulled_at,
    covers: { face: !!(p.covers || {}).face, name: !!(p.covers || {}).name, jersey: !!(p.covers || {}).jersey, voice: !!(p.covers || {}).voice },
  });
  const offline = {
    v: 1,
    film_id: film.id,
    saved_at: nowIso(),
    title: film.title,
    athlete_id: film.athlete_id,
    format: film.format,
    format_label: t && t.formats[film.format] ? t.formats[film.format].label : film.format,
    closed: !!(film.pulled_at || film.archived_at),
    shoot_date: plan.shoot_date || null,
    // Times and codes, and only the lines that carry no name, contact or
    // place (U.offlineSafe); the rest shows online only ("details").
    schedule: (Array.isArray(plan.schedule) ? plan.schedule.slice(0, 40) : []).map((x) => ({ time: x.time || null, what: U.offlineSafe(x.what, people) ? x.what : null })),
    must_have: (Array.isArray(plan.must_have) ? plan.must_have.slice(0, 3) : []).map((m) => (U.offlineSafe(m, people) ? m : null)),
    frame_pair: { opening: U.offlineSafe(fp.opening, people) ? fp.opening : null, closing: U.offlineSafe(fp.closing, people) ? fp.closing : null },
    people: people.map(light),
    cards,
    checklist: checklist ? checklist.parts.map((x) => x.text) : [],
    kit_version: kit ? kit.version || null : null,
  };
  res.json({
    offline,
    // Online only: never saved on the phone.
    names: Object.fromEntries(people.map((p) => [p.id, p.name])),
    details: {
      schedule: Array.isArray(plan.schedule) ? plan.schedule.slice(0, 40) : [],
      must_have: Array.isArray(plan.must_have) ? plan.must_have.slice(0, 3) : [],
      frame_pair: { opening: fp.opening || null, closing: fp.closing || null },
    },
    locations: Array.isArray(plan.locations) ? plan.locations : [],
    one_sentence: film.one_sentence || null,
  });
}));

// ── Today ────────────────────────────────────────────────────────────────
router.get("/today", member, withDb(async (req, res, sb) => {
  const films = (await run(sb.from("studio_films").select("*").is("archived_at", null).order("created_at", { ascending: false }).limit(200))) || [];
  const live = films.filter((f) => !f.pulled_at);
  const ids = live.map((f) => f.id);
  const steps = ids.length ? (await run(sb.from("studio_film_steps").select("film_id,step,position,status").in("film_id", ids))) || [] : [];
  const needs = [];
  for (const f of live) {
    const w = where(f, steps.filter((s) => s.film_id === f.id));
    if (w.state !== "active") continue;
    // A director's or editor's step waits on them (on the producer while
    // nobody's assigned); the producer's on approvers; the owner's on the owner.
    const assigned = w.owner === "director" ? f.director_email : w.owner === "editor" ? f.editor_email : null;
    const mine = w.owner === "owner" ? isOwner(req) : assigned ? assigned === me(req) : isProducer(req);
    if (mine) needs.push({ kind: "step", film: { id: f.id, title: f.title, athlete_id: f.athlete_id, format: f.format }, step: w.step, label: w.label });
  }
  if (isProducer(req)) {
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const changes = ids.length ? (await run(sb.from("studio_reviews").select("id,film_id,cut_id,decided_at,note").in("film_id", ids).eq("decision", "changes").gte("decided_at", since))) || [] : [];
    for (const c of changes) {
      const f = live.find((x) => x.id === c.film_id);
      needs.push({ kind: "changes", film: { id: f.id, title: f.title, athlete_id: f.athlete_id, format: f.format }, note: c.note, decided_at: c.decided_at });
    }
    const open = (await run(sb.from("studio_takedowns").select("*").is("closed_at", null).order("due_at", { ascending: true }).limit(20))) || [];
    for (const t of open) needs.push({ kind: "takedown", id: t.id, person_code: t.person_code, due_at: t.due_at });
  }
  const failed = ids.length ? (await run(sb.from("studio_film_cuts").select("id,film_id,format,ratio,version,error,created_by").in("film_id", ids).eq("status", "failed"))) || [] : [];
  for (const c of failed) {
    if (c.created_by !== me(req) && !isProducer(req)) continue;
    const f = live.find((x) => x.id === c.film_id);
    needs.push({ kind: "cut_failed", film: { id: f.id, title: f.title }, cut: { id: c.id, label: `${c.format} ${c.ratio} v${c.version}`, error: c.error } });
  }
  // Notes on a cut wait on the film's editor (on the producer while nobody's
  // assigned). Before migration 040 there are none.
  const mineToEdit = live.filter((f) => (f.editor_email ? f.editor_email === me(req) : isProducer(req)));
  if (mineToEdit.length) {
    let open = [];
    try {
      open = (await run(sb.from("studio_notes").select("film_id").in("film_id", mineToEdit.map((f) => f.id)).is("resolved_at", null).limit(1000))) || [];
    } catch (e) {
      open = [];
    }
    for (const f of mineToEdit) {
      const n = open.filter((x) => x.film_id === f.id).length;
      if (n) needs.push({ kind: "notes", film: { id: f.id, title: f.title, athlete_id: f.athlete_id, format: f.format }, count: n });
    }
  }
  res.json({ needs, count: needs.length });
}));

router.use((req, res) => res.status(404).json({ error: "not_found" }));

router._pullConsent = pullConsent;
router._linksToday = linksToday;
module.exports = router;
