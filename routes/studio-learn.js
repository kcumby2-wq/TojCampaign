"use strict";
// The kit learns from the work (migration 042, docs/studio-films.md): wrap-ups
// on films, suggested edits to kit cards, review-note labels that come up
// three times, and the month's refresh brief built from them. Team members
// with Studio, signed in; approvers decide.
//
//   GET    /api/studio-learn/films/:id/wraps           a film's wrap-ups, and its kit's card titles
//   POST   /api/studio-learn/films/:id/wraps           { worked, missed, change, card_title, names_ok }
//   PATCH  /api/studio-learn/wraps/:wid                the same (whoever wrote it, until it's folded)
//   DELETE /api/studio-learn/wraps/:wid                whoever wrote it, or an approver, until it's folded
//   GET    /api/studio-learn/suggestions?slug=&status= suggested edits to a kit's cards
//   POST   /api/studio-learn/suggestions               { slug, column, card_title, suggestion, why } (not a locked rule card)
//   POST   /api/studio-learn/suggestions/:id/decline   { note } (approver)
//   POST   /api/studio-learn/labels/decline            { slug, label, note } (approver)
//   GET    /api/studio-learn/monthly/:slug             what the month's refresh would draw on (approver)
//   GET    /api/studio-learn/today                     what's due: the month's refresh (approvers), the gear re-check
//
// The refresh itself starts as any kit run does (POST /api/studio-agents/run),
// with { purpose: "monthly", sources, again } or { purpose: "gear" }: that
// route marks it with what it was given (studio_refresh_start), and when it
// ends folds that in, only if it saved a draft (studio_refresh_end).

const express = require("express");
const { getSupabase } = require("../utils/supabase");
const T = require("../utils/team");
const H = require("../utils/pylon-http");
const U = require("../utils/studio-films");
const S = require("../agents/studio/service");
const K = require("../agents/studio/kit");

const router = express.Router();
const safe = H.safe("studio-learn");
const member = T.requireTeam("studio", "member");
const me = (req) => req.team.email;
const isProducer = (req) => T.can(req.team, "studio", "approver");
const bodyOf = H.bodyOf;
const idOk = (s) => U.UUID.test(String(s || ""));
// The gear re-check is due a month after the last one that ran through.
const GEAR_DAYS = 30;
// A refresh still "running" after this long died with a server restart
// (routes/studio-agents.js STALE_RUN_MS, 042's studio_refresh_live).
const LIVE_MS = 90 * 60 * 1000;
const TZ = "America/Chicago";

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
// The database's own name check (042) read a name the app let through: it
// can't say which word, so the writer is told what it reads.
const DB_NAMES = /keep(?:s)? no names/;
function refused(res, e) {
  const err = (e && e.db) || e || {};
  if (err.code === "P0001" && DB_NAMES.test(String(err.message || ""))) {
    return res.status(409).json({
      error: "refused",
      names: true,
      reason: "the database read a name on a card in it, a minor's most likely, maybe as a plural or a possessive (\u201cJordans\u201d): write their code instead",
    });
  }
  if (err.code === "P0001") return res.status(409).json({ error: "refused", reason: String(err.message || "").slice(0, 300) });
  if (err.code === "23505") return res.status(409).json({ error: "exists" });
  if (/^(23|22)/.test(String(err.code || ""))) return res.status(400).json({ error: "invalid" });
  console.error("[studio-learn] storage error:", err.message || err);
  return res.status(503).json({ error: "storage_unavailable" });
}
async function filmById(sb, id) {
  if (!idOk(id)) return null;
  return (await run(sb.from("studio_films").select("id,kit_slug,title,athlete_id,format,pulled_at,archived_at").eq("id", id).maybeSingle())) || null;
}
async function peopleOf(sb, filmId) {
  return (await run(sb.from("studio_film_people").select("name,reviewer_name,is_minor,person_code").eq("film_id", filmId))) || [];
}
// Every card on every film, for what every film shares (a kit, a label, the
// month's refresh), every page of them (utils/studio-films.js everyCardRows).
const everyCard = (sb) => U.everyCardRows(sb);
// What every film shares is read against every card (utils/studio-films.js
// kitNames): a name for certain holds it back.
const named = (text, everyone) => U.kitNames(text, everyone).sure.length > 0;
// Before something is kept for the kit: a name for certain is refused, with
// the words read as one; a word that may be a name is asked about first
// ({ names_ok }, for this exact text). A wrap-up is also read against its
// film's cards ({ film }): a minor's name there is refused as a minor's, and
// any word of a name on them is asked about, in any case.
function checkNames(text, everyone, body, prefix, film) {
  const k = U.kitNames(text, everyone, { film: film || [] });
  if (film && k.minor.length) return { error: "invalid", fields: [prefix + "_has_minor_name"], words: k.minor.slice(0, 10) };
  if (k.sure.length) return { error: "invalid", fields: [prefix + "_has_name"], words: k.sure.slice(0, 10) };
  const ok = U.namesOkWords(body && body.names_ok);
  const words = [...new Set([...(film ? U.namesIn(text, film) : []), ...k.maybe])].filter((w) => !ok.has(w));
  if (words.length) return { error: "invalid", fields: [prefix + "_may_have_name"], words: words.slice(0, 10) };
  return null;
}
// The month it is in Texas, as YYYY-MM-01.
function thisMonth(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-01`;
}
const clean = (v, max) => U.clean(v, max) || null;

// A wrap-up's names. It goes into the kit's refresh, so it's held to what a
// kit holds, as a suggested edit is: a name of anyone on any film's cards is
// refused (checkNames), and a word that may be one is asked about first.
function wrapNames(text, people, everyone, body) {
  return checkNames(text, everyone, body, "wrap", people || []);
}
function wrapInput(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const v = { worked: clean(r.worked, 600), missed: clean(r.missed, 600), change: clean(r.change, 600), card_title: clean(r.card_title, 200) };
  const errors = [];
  if (!v.worked) errors.push("worked");
  const words = [v.worked, v.missed, v.change].filter(Boolean).join("\n");
  if (K.lintWords(words, "x").length) errors.push("banned_words");
  return { errors, value: v, text: [v.worked, v.missed, v.change, v.card_title].filter(Boolean).join("\n") };
}
const wrapView = (w, req) => ({ ...w, mine: w.created_by === me(req), folded: !!w.folded_at });

// The approved kit's cards, by column, as titles (and which are locked
// rules, which a refresh can't change).
async function kitCards(sb, slug) {
  let kit = null;
  try {
    kit = await S.approvedKit(sb, slug);
  } catch (e) {
    kit = null;
  }
  if (!kit || !kit.kit || !Array.isArray(kit.kit.columns)) return { kit: null, columns: [] };
  return {
    kit,
    columns: kit.kit.columns.map((c) => ({ name: c.name, cards: (c.cards || []).map((x) => x.title), locked: (c.cards || []).filter((x) => x.locked).map((x) => x.title) })),
  };
}

// ── Wrap-ups ─────────────────────────────────────────────────────────────
router.get("/films/:id/wraps", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const wraps = (await run(sb.from("studio_film_wraps").select("*").eq("film_id", film.id).order("created_at", { ascending: true }))) || [];
  const { columns } = await kitCards(sb, film.kit_slug);
  res.json({
    film: { id: film.id, title: film.title, athlete_id: film.athlete_id, format: film.format, kit_slug: film.kit_slug, closed: !!(film.pulled_at || film.archived_at) },
    wraps: wraps.map((w) => wrapView(w, req)),
    cards: [...new Set(columns.flatMap((c) => c.cards))],
    can: { producer: isProducer(req) },
  });
}));

router.post("/films/:id/wraps", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const { errors, value, text } = wrapInput(body);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const asked = wrapNames(text, await peopleOf(sb, film.id), await everyCard(sb), body);
  if (asked) return res.status(400).json(asked);
  try {
    const row = await run(sb.from("studio_film_wraps").insert({ film_id: film.id, ...value, created_by: me(req) }).select().single());
    await T.logActivity(me(req), "studio_wrap_added", film.athlete_id, { film_id: film.id });
    res.json({ wrap: wrapView(row, req) });
  } catch (e) {
    refused(res, e);
  }
}));

async function wrapById(sb, id) {
  if (!idOk(id)) return null;
  return (await run(sb.from("studio_film_wraps").select("*").eq("id", id).maybeSingle())) || null;
}

router.patch("/wraps/:wid", member, withDb(async (req, res, sb) => {
  const w = await wrapById(sb, req.params.wid);
  if (!w) return res.status(404).json({ error: "not_found" });
  if (w.created_by !== me(req)) return res.status(403).json({ error: "not_yours" });
  if (w.folded_at) return res.status(409).json({ error: "folded" });
  const body = bodyOf(req);
  const { errors, value, text } = wrapInput(body);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const asked = wrapNames(text, await peopleOf(sb, w.film_id), await everyCard(sb), body);
  if (asked) return res.status(400).json(asked);
  try {
    const rows = await run(sb.from("studio_film_wraps").update(value).eq("id", w.id).is("folded_at", null).select());
    if (!rows || !rows.length) return res.status(409).json({ error: "folded" });
    res.json({ wrap: wrapView(rows[0], req) });
  } catch (e) {
    refused(res, e);
  }
}));

router.delete("/wraps/:wid", member, withDb(async (req, res, sb) => {
  const w = await wrapById(sb, req.params.wid);
  if (!w) return res.status(404).json({ error: "not_found" });
  if (w.created_by !== me(req) && !isProducer(req)) return res.status(403).json({ error: "not_yours" });
  if (w.folded_at) return res.status(409).json({ error: "folded" });
  try {
    const rows = await run(sb.from("studio_film_wraps").delete().eq("id", w.id).is("folded_at", null).select());
    if (!rows || !rows.length) return res.status(409).json({ error: "folded" });
    res.json({ ok: true });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Suggested edits ──────────────────────────────────────────────────────
router.get("/suggestions", member, withDb(async (req, res, sb) => {
  const slug = String(req.query.slug || "");
  if (!K.SLUG_RE.test(slug)) return res.status(400).json({ error: "invalid", fields: ["slug"] });
  const status = ["open", "declined", "folded"].includes(req.query.status) ? req.query.status : "open";
  const rows = (await run(sb.from("studio_kit_suggestions").select("*").eq("kit_slug", slug).eq("status", status).order("created_at", { ascending: false }).limit(200))) || [];
  res.json({ suggestions: rows, can: { producer: isProducer(req) } });
}));

router.post("/suggestions", member, withDb(async (req, res, sb) => {
  const b = bodyOf(req);
  const slug = String(b.slug || "");
  const errors = [];
  if (!K.SLUG_RE.test(slug)) errors.push("slug");
  const suggestion = clean(b.suggestion, 1000);
  const why = clean(b.why, 500);
  if (!suggestion || suggestion.length < 3) errors.push("suggestion");
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  // The card has to be one of the approved kit's.
  const { kit, columns } = await kitCards(sb, slug);
  if (!kit) return res.status(404).json({ error: "no_approved_kit" });
  const col = columns.find((c) => c.name === String(b.column || ""));
  if (!col || !col.cards.includes(String(b.card_title || ""))) return res.status(400).json({ error: "invalid", fields: ["card"] });
  // A locked rule card: a refresh can't change it (only Kyron, by hand).
  if (col.locked.includes(String(b.card_title))) return res.status(400).json({ error: "invalid", fields: ["card_is_a_rule"] });
  const words = [suggestion, why].filter(Boolean).join("\n");
  if (K.lintWords(words, "x").length) return res.status(400).json({ error: "invalid", fields: ["banned_words"] });
  // A kit never carries a name: checked against every film's cards.
  const asked = checkNames(words, await everyCard(sb), b, "suggestion");
  if (asked) return res.status(400).json(asked);
  try {
    const row = await run(sb.from("studio_kit_suggestions").insert({ kit_slug: slug, kit_version: kit.version, column_name: col.name, card_title: String(b.card_title), suggestion, why, created_by: me(req) }).select().single());
    await T.logActivity(me(req), "studio_kit_suggestion", slug, { card: row.card_title });
    res.json({ suggestion: row });
  } catch (e) {
    refused(res, e);
  }
}));

router.post("/suggestions/:id/decline", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  if (!idOk(req.params.id)) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const note = clean(body.note, 300);
  if (!note || note.length < 3) return res.status(400).json({ error: "invalid", fields: ["note"] });
  const asked = checkNames(note, await everyCard(sb), body, "note");
  if (asked) return res.status(400).json(asked);
  try {
    const rows = await run(sb.from("studio_kit_suggestions").update({ status: "declined", decided_by: me(req), decided_at: new Date().toISOString(), decided_note: note }).eq("id", req.params.id).eq("status", "open").select());
    if (!rows || !rows.length) return res.status(409).json({ error: "decided_already" });
    res.json({ suggestion: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Rules in the making ──────────────────────────────────────────────────
// A kit's: labels on its films' notes used three times or more, not decided
// yet (or declined three uses ago, or back from a discarded draft), 042's
// studio_rule_candidates. A label that names someone on a card added since
// is held back (it can still be declined); so is a sample note that does.
async function ruleCandidates(sb, slug, everyone) {
  const rows = (await run(sb.rpc("studio_rule_candidates", { p_slug: slug }))) || [];
  const out = [];
  const held = [];
  for (const x of rows) {
    if (named(x.label, everyone)) {
      held.push({ label: x.label, notes: x.notes, films: x.films, declined_before: !!x.declined_before });
      continue;
    }
    out.push({
      label: x.label,
      notes: x.notes,
      films: x.films,
      declined_before: !!x.declined_before,
      samples: (x.samples || []).filter((t) => t && !named(t, everyone)).map((t) => String(t).slice(0, 200)),
    });
  }
  return { rules: out, held };
}

router.post("/labels/decline", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const b = bodyOf(req);
  const slug = String(b.slug || "");
  const label = String(b.label || "");
  const note = clean(b.note, 300);
  if (!K.SLUG_RE.test(slug)) return res.status(400).json({ error: "invalid", fields: ["slug"] });
  if (!label) return res.status(400).json({ error: "invalid", fields: ["label"] });
  if (!note || note.length < 3) return res.status(400).json({ error: "invalid", fields: ["note"] });
  const asked = checkNames(note, await everyCard(sb), b, "note");
  if (asked) return res.status(400).json(asked);
  try {
    // A new decision, kept with the earlier ones (042's studio_label_decline).
    const rows = await run(sb.rpc("studio_label_decline", { p_slug: slug, p_label: label, p_note: note, p_by: me(req) }));
    res.json({ ok: true, uses: rows && rows[0] ? rows[0].uses : null });
  } catch (e) {
    refused(res, e);
  }
}));

// ── The month's refresh ──────────────────────────────────────────────────
async function marksOf(sb, slug, kind) {
  return (await run(sb.from("studio_refresh_marks").select("run_id,month,started_at,started_by,outcome,ended_at,undone_at").eq("kit_slug", slug).eq("kind", kind).order("started_at", { ascending: false }).limit(20))) || [];
}
const live = (m) => !m.outcome && Date.now() - new Date(m.started_at).getTime() < LIVE_MS;
// Ran through: a draft (not discarded since), or nothing needed changing.
const ran = (m) => (m.outcome === "drafted" && !m.undone_at) || m.outcome === "no_changes";
// This month's refresh: running, or ran through; a run that failed or went
// quiet, or whose draft was discarded, leaves it due.
function monthState(list) {
  const month = thisMonth();
  const mine = list.filter((m) => m.month === month);
  const running = mine.find(live) || null;
  return { running, ran: mine.find(ran) || null, last: list[0] || null };
}
// The gear re-check: due a month after the last one that ran through.
function gearState(list) {
  const running = list.find(live) || null;
  const last = list.find(ran) || null;
  const due = !running && (!last || Date.now() - new Date(last.started_at).getTime() > GEAR_DAYS * 86400000);
  return { last_at: last ? last.started_at : null, running: !!running, due };
}
const markView = (m) => (m ? { run_id: m.run_id, month: m.month, started_at: m.started_at, started_by: m.started_by, outcome: m.undone_at ? "discarded" : m.outcome || (live(m) ? "running" : "failed") } : null);
// A kit's open wrap-ups (042's studio_open_wraps), and which now name someone
// on a card added since (held back: edit it on its film).
async function openWraps(sb, slug, everyone) {
  const rows = (await run(sb.rpc("studio_open_wraps", { p_slug: slug }))) || [];
  const wraps = [];
  const held = [];
  for (const w of rows) {
    const film = { id: w.film_id, athlete_id: w.athlete_id, format: w.format };
    if (named([w.worked, w.missed, w.change, w.card_title].filter(Boolean).join("\n"), everyone)) held.push({ id: w.id, film });
    else wraps.push({ id: w.id, film_id: w.film_id, worked: w.worked, missed: w.missed, change: w.change, card_title: w.card_title, created_by: w.created_by, created_at: w.created_at, film });
  }
  return { wraps, held };
}
// A kit's open suggested edits, and which now name someone on a card added
// since (held back: they can't be edited, so an approver declines them).
async function openSuggestions(sb, slug, everyone) {
  const rows = (await run(sb.from("studio_kit_suggestions").select("*").eq("kit_slug", slug).eq("status", "open").order("created_at", { ascending: true }).limit(200))) || [];
  const isHeld = (x) => named([x.suggestion, x.why].filter(Boolean).join("\n"), everyone);
  return { suggestions: rows.filter((x) => !isHeld(x)), held: rows.filter(isHeld) };
}
// What a running refresh was given (it keeps those as it read them).
async function heldByRunning(sb, slug, list) {
  const runs = list.filter(live).map((m) => m.run_id);
  if (!runs.length) return [];
  return (await run(sb.from("studio_refresh_sources").select("kind,ref_id,label").in("run_id", runs).limit(1000))) || [];
}

router.get("/monthly/:slug", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const slug = String(req.params.slug || "");
  if (!K.SLUG_RE.test(slug)) return res.status(404).json({ error: "not_found" });
  const { kit } = await kitCards(sb, slug);
  if (!kit) return res.status(404).json({ error: "no_approved_kit" });
  const everyone = await everyCard(sb);
  const [w, sg, r, monthly, gear] = await Promise.all([
    openWraps(sb, slug, everyone),
    openSuggestions(sb, slug, everyone),
    ruleCandidates(sb, slug, everyone),
    marksOf(sb, slug, "monthly"),
    marksOf(sb, slug, "gear"),
  ]);
  const state = monthState(monthly);
  const busy = await heldByRunning(sb, slug, monthly);
  const taken = (kind, key) => busy.some((x) => x.kind === kind && (kind === "label" ? x.label === key : x.ref_id === key));
  res.json({
    kit: { slug, title: kit.kit.title || slug, version: kit.version },
    month: thisMonth(),
    last_monthly: markView(state.last),
    // The last one that ran through: what's here came in since then.
    last_ran: markView(monthly.find(ran) || null),
    running: markView(state.running),
    done_this_month: !!state.ran,
    last_gear: markView(gear[0]),
    wraps: w.wraps.filter((x) => !taken("wrap", x.id)),
    suggestions: sg.suggestions.filter((x) => !taken("suggestion", x.id)),
    rules: r.rules.filter((x) => !taken("label", x.label)),
    // Held back: they name someone on a card added since. A wrap-up is
    // edited on its film; a suggested edit or a rule can be declined.
    held: {
      wraps: w.held.filter((x) => !taken("wrap", x.id)),
      suggestions: sg.held.filter((x) => !taken("suggestion", x.id)),
      rules: r.held.filter((x) => !taken("label", x.label)),
    },
    brief_max: S.BRIEF_MAX,
  });
}));

router.get("/today", member, withDb(async (req, res, sb) => {
  const kits = (await run(sb.from("studio_kits").select("slug").eq("status", "approved"))) || [];
  // Built-in kits that were never saved count as approved too.
  const slugs = [...new Set([...kits.map((k) => k.slug), ...K.builtinKits().map((b) => b.slug)])];
  const out = { monthly: [], gear: null };
  const everyone = isProducer(req) ? await everyCard(sb) : [];
  for (const slug of slugs) {
    let kit = null;
    try {
      kit = await S.approvedKit(sb, slug);
    } catch (e) {
      kit = null;
    }
    if (!kit) continue;
    if (isProducer(req)) {
      const monthly = await marksOf(sb, slug, "monthly");
      const state = monthState(monthly);
      if (!state.running && !state.ran) {
        const [w, sg, r] = await Promise.all([openWraps(sb, slug, everyone), openSuggestions(sb, slug, everyone), ruleCandidates(sb, slug, everyone)]);
        const counts = { wraps: w.wraps.length, suggestions: sg.suggestions.length, rules: r.rules.length };
        if (counts.wraps + counts.suggestions + counts.rules > 0) out.monthly.push({ slug, title: (kit.kit && kit.kit.title) || slug, counts });
      }
    }
    // The gear re-check is the Same Work kit's (its Gear and Edit suite).
    if (slug === "same-work") out.gear = { slug, ...gearState(await marksOf(sb, slug, "gear")) };
  }
  res.json(out);
}));

router.use((req, res) => res.status(404).json({ error: "not_found" }));

router._thisMonth = thisMonth;
router._refused = refused;
module.exports = router;
