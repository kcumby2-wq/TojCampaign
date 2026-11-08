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
//   POST   /api/studio-learn/suggestions               { slug, version, column, card_title, suggestion, why }
//   POST   /api/studio-learn/suggestions/:id/decline   { note } (approver)
//   POST   /api/studio-learn/labels/decline            { label, note } (approver)
//   GET    /api/studio-learn/monthly/:slug             what the month's refresh would draw on (approver)
//   GET    /api/studio-learn/today                     what's due: the month's refresh (approvers), the gear re-check
//
// The refresh itself starts as any kit run does (POST /api/studio-agents/run),
// with { purpose: "monthly", sources } or { purpose: "gear" }: that route
// marks it and folds the sources in (studio_refresh_fold).

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
// A label used this many times is a rule in the making; a declined one comes
// back after this many more.
const RULE_AT = 3;
// The gear re-check is due a month after the last one.
const GEAR_DAYS = 30;
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
function refused(res, e) {
  const err = (e && e.db) || e || {};
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
// Every card on every film, for what every film shares (a kit, a label).
async function everyCard(sb) {
  return (await run(sb.from("studio_film_people").select("name,reviewer_name,is_minor").limit(10000))) || [];
}
// The month it is in Texas, as YYYY-MM-01.
function thisMonth(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-01`;
}
const clean = (v, max) => U.clean(v, max) || null;

// A wrap-up's names: refused like a note in the history (a whole name, one
// run together, any word of a minor's name), and a word that's also a name
// is asked about first ({ names_ok }, for this exact text).
function wrapNames(text, people, body) {
  if (U.namesIn(text, people, { strong: true }).length) return { error: "invalid", fields: ["wrap_has_name"] };
  if (U.minorWords(text, people).length) return { error: "invalid", fields: ["wrap_has_minor_name"] };
  const ok = U.namesOkWords(body && body.names_ok);
  const words = [...new Set([...U.namesIn(text, people), ...U.minorMaybe(text, people)])].filter((w) => !ok.has(w));
  if (words.length) return { error: "invalid", fields: ["wrap_may_have_name"], words: words.slice(0, 10) };
  return null;
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

// The approved kit's cards, by column, as titles.
async function kitCards(sb, slug) {
  let kit = null;
  try {
    kit = await S.approvedKit(sb, slug);
  } catch (e) {
    kit = null;
  }
  if (!kit || !kit.kit || !Array.isArray(kit.kit.columns)) return { kit: null, columns: [] };
  return { kit, columns: kit.kit.columns.map((c) => ({ name: c.name, cards: (c.cards || []).map((x) => x.title) })) };
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
  const named = wrapNames(text, await peopleOf(sb, film.id), body);
  if (named) return res.status(400).json(named);
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
  const named = wrapNames(text, await peopleOf(sb, w.film_id), body);
  if (named) return res.status(400).json(named);
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
  const words = [suggestion, why].filter(Boolean).join("\n");
  if (K.lintWords(words, "x").length) return res.status(400).json({ error: "invalid", fields: ["banned_words"] });
  // A kit never carries a name: checked against every film's cards.
  if (U.strictNames(words, await everyCard(sb)).length) return res.status(400).json({ error: "invalid", fields: ["suggestion_has_name"] });
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
  const note = clean(bodyOf(req).note, 300);
  if (!note || note.length < 3) return res.status(400).json({ error: "invalid", fields: ["note"] });
  if (U.strictNames(note, await everyCard(sb)).length) return res.status(400).json({ error: "invalid", fields: ["note_has_name"] });
  try {
    const rows = await run(sb.from("studio_kit_suggestions").update({ status: "declined", decided_by: me(req), decided_at: new Date().toISOString(), decided_note: note }).eq("id", req.params.id).eq("status", "open").select());
    if (!rows || !rows.length) return res.status(409).json({ error: "decided_already" });
    res.json({ suggestion: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Rules in the making ──────────────────────────────────────────────────
// Labels used RULE_AT times or more, not yet decided (or declined RULE_AT
// uses ago).
async function ruleCandidates(sb) {
  const rows = (await run(sb.from("studio_notes").select("label,film_id,note").not("label", "is", null).limit(5000))) || [];
  const marks = (await run(sb.from("studio_label_marks").select("label,status,uses_at"))) || [];
  const mark = new Map(marks.map((m) => [m.label, m]));
  const by = new Map();
  for (const r of rows) {
    const x = by.get(r.label) || { label: r.label, notes: 0, films: new Set(), samples: [] };
    x.notes += 1;
    x.films.add(r.film_id);
    if (x.samples.length < 3 && r.note) x.samples.push(String(r.note).slice(0, 200));
    by.set(r.label, x);
  }
  return [...by.values()]
    .filter((x) => {
      if (x.notes < RULE_AT) return false;
      const m = mark.get(x.label);
      if (!m) return true;
      return m.status === "declined" && x.notes >= m.uses_at + RULE_AT;
    })
    .map((x) => ({ label: x.label, notes: x.notes, films: x.films.size, samples: x.samples, declined_before: !!mark.get(x.label) }))
    .sort((a, b) => b.notes - a.notes || a.label.localeCompare(b.label));
}

router.post("/labels/decline", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const b = bodyOf(req);
  const label = String(b.label || "");
  const note = clean(b.note, 300);
  if (!label) return res.status(400).json({ error: "invalid", fields: ["label"] });
  if (!note || note.length < 3) return res.status(400).json({ error: "invalid", fields: ["note"] });
  if (U.strictNames(note, await everyCard(sb)).length) return res.status(400).json({ error: "invalid", fields: ["note_has_name"] });
  const found = (await ruleCandidates(sb)).find((x) => x.label === label);
  if (!found) return res.status(404).json({ error: "not_found" });
  try {
    await run(sb.from("studio_label_marks").upsert({ label, status: "declined", uses_at: found.notes, note, run_id: null, decided_by: me(req) }, { onConflict: "label" }));
    res.json({ ok: true });
  } catch (e) {
    refused(res, e);
  }
}));

// ── The month's refresh ──────────────────────────────────────────────────
async function lastMark(sb, slug, kind) {
  const rows = (await run(sb.from("studio_refresh_marks").select("run_id,month,started_at,started_by").eq("kit_slug", slug).eq("kind", kind).order("started_at", { ascending: false }).limit(1))) || [];
  return rows[0] || null;
}
async function openWraps(sb, slug) {
  const films = (await run(sb.from("studio_films").select("id,athlete_id,format,title").eq("kit_slug", slug).limit(2000))) || [];
  if (!films.length) return [];
  const byId = new Map(films.map((f) => [f.id, f]));
  const wraps = (await run(sb.from("studio_film_wraps").select("*").is("folded_at", null).in("film_id", films.map((f) => f.id)).order("created_at", { ascending: true }).limit(200))) || [];
  return wraps.map((w) => ({ ...w, film: { id: w.film_id, athlete_id: byId.get(w.film_id).athlete_id, format: byId.get(w.film_id).format } }));
}

router.get("/monthly/:slug", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  const slug = String(req.params.slug || "");
  if (!K.SLUG_RE.test(slug)) return res.status(404).json({ error: "not_found" });
  const { kit } = await kitCards(sb, slug);
  if (!kit) return res.status(404).json({ error: "no_approved_kit" });
  const [wraps, suggestions, rules, monthly, gear] = await Promise.all([
    openWraps(sb, slug),
    run(sb.from("studio_kit_suggestions").select("*").eq("kit_slug", slug).eq("status", "open").order("created_at", { ascending: true }).limit(200)),
    ruleCandidates(sb),
    lastMark(sb, slug, "monthly"),
    lastMark(sb, slug, "gear"),
  ]);
  res.json({
    kit: { slug, title: kit.kit.title || slug, version: kit.version },
    month: thisMonth(),
    last_monthly: monthly,
    done_this_month: !!(monthly && monthly.month === thisMonth()),
    last_gear: gear,
    wraps,
    suggestions: suggestions || [],
    rules,
    brief_max: S.BRIEF_MAX,
  });
}));

router.get("/today", member, withDb(async (req, res, sb) => {
  const kits = (await run(sb.from("studio_kits").select("slug").eq("status", "approved"))) || [];
  // Built-in kits that were never saved count as approved too.
  const slugs = [...new Set([...kits.map((k) => k.slug), ...K.builtinKits().map((b) => b.slug)])];
  const out = { monthly: [], gear: null };
  for (const slug of slugs) {
    let kit = null;
    try {
      kit = await S.approvedKit(sb, slug);
    } catch (e) {
      kit = null;
    }
    if (!kit) continue;
    if (isProducer(req)) {
      const [wraps, suggestions, monthly] = await Promise.all([
        openWraps(sb, slug),
        run(sb.from("studio_kit_suggestions").select("id").eq("kit_slug", slug).eq("status", "open").limit(200)),
        lastMark(sb, slug, "monthly"),
      ]);
      const rules = await ruleCandidates(sb);
      const done = !!(monthly && monthly.month === thisMonth());
      const counts = { wraps: wraps.length, suggestions: (suggestions || []).length, rules: rules.length };
      if (!done && counts.wraps + counts.suggestions + counts.rules > 0) out.monthly.push({ slug, title: (kit.kit && kit.kit.title) || slug, counts });
    }
    // The gear re-check is the Same Work kit's (its Gear and Edit suite).
    if (slug === "same-work") {
      const gear = await lastMark(sb, slug, "gear");
      const due = !gear || Date.now() - new Date(gear.started_at).getTime() > GEAR_DAYS * 86400000;
      out.gear = { slug, last_at: gear ? gear.started_at : null, due };
    }
  }
  res.json(out);
}));

router.use((req, res) => res.status(404).json({ error: "not_found" }));

router._thisMonth = thisMonth;
module.exports = router;
