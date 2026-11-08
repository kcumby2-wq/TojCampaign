"use strict";
// Studio real words and three directions (migration 041, agents/studio-words,
// agents/studio-directions, docs/studio-films.md). Team members with Studio,
// signed in:
//
//   GET    /api/studio-words/films/:id                transcripts (no words), the lines kept, directions, runs, what you can do
//   GET    /api/studio-words/transcripts/:tid         one transcript's cues, to pick a line by hand
//   POST   /api/studio-words/films/:id/transcripts    { person_id, label, frames, fps, cues: [{ s, e, t }] }: the speaker's cues only
//   DELETE /api/studio-words/transcripts/:tid         the producer, or whoever added it (its lines go with it)
//   POST   /api/studio-words/films/:id/lines          { transcript_id, from_cue, to_cue, quote, note }: a line picked by hand
//   DELETE /api/studio-words/words/:wid               a line, a caption, or a whole structure or cutdown
//   POST   /api/studio-words/films/:id/ask-claude     the Real-Words Editor reads the transcripts (needs "Claude reads transcripts" on)
//   POST   /api/studio-words/films/:id/directions     Three Directions for the film
//   POST   /api/studio-words/directions/:did/pick     { n }: the producer picks one (or n: null)
//   GET    /api/studio-words/runs/:rid                how a run is going
//
// The transcript is read in the browser (public/app/transcript-parse.js):
// only the chosen speaker's cues arrive, never the questions or anyone else's
// words. Adults first: a minor's words wait for a later review. Every line
// kept is the speaker's exact words with its times, checked here
// (utils/studio-words.js) and again by the database. Claude reads a
// transcript only while Kyron has "Claude reads transcripts" on, and a words
// run's agent_runs row keeps no words (its output is counts, its trace only
// which tools ran). Agents see people by code and role, never by name.

const express = require("express");
const { getSupabase } = require("../utils/supabase");
const T = require("../utils/team");
const P = require("../utils/push");
const H = require("../utils/pylon-http");
const U = require("../utils/studio-films");
const W = require("../utils/studio-words");
const F = require("../agents/studio/films");
const S = require("../agents/studio/service");

const router = express.Router();
const safe = H.safe("studio-words");
const member = T.requireTeam("studio", "member");
const me = (req) => req.team.email;
const isProducer = (req) => T.can(req.team, "studio", "approver");
const idOk = (s) => U.UUID.test(String(s || ""));
const bodyOf = H.bodyOf;
const nowIso = () => new Date().toISOString();
const STALE_RUN_MS = 90 * 60 * 1000;

// Tests swap in the agents.
let wordsImpl = null;
let directionsImpl = null;
let wordsPack = null;
let directionsPack = null;
function runWords(args) {
  if (wordsImpl) return wordsImpl(args);
  if (!wordsPack) wordsPack = require("../agents/studio-words/orchestrator");
  return wordsPack.runAgent(args);
}
function runDirections(args) {
  if (directionsImpl) return directionsImpl(args);
  if (!directionsPack) directionsPack = require("../agents/studio-directions/orchestrator");
  return directionsPack.runAgent(args);
}
router._setDeps = ({ words, directions } = {}) => {
  if (words !== undefined) wordsImpl = words;
  if (directions !== undefined) directionsImpl = directions;
};

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
async function rpcRows(sb, fn, args) {
  let { data, error } = await sb.rpc(fn, args);
  if (error && RETRY.has(error.code)) {
    await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 70)));
    ({ data, error } = await sb.rpc(fn, args));
  }
  if (error) throw Object.assign(new Error(error.message), { db: error });
  return Array.isArray(data) ? data : data == null ? [] : [data];
}
function refused(res, e) {
  const err = (e && e.db) || e || {};
  if (err.code === "P0001") return res.status(409).json({ error: "refused", reason: String(err.message || "").slice(0, 300) });
  if (err.code === "23505") return res.status(409).json({ error: "exists" });
  if (/^(23|22)/.test(String(err.code || ""))) return res.status(400).json({ error: "invalid" });
  console.error("[studio-words] storage error:", err.message || err);
  return res.status(503).json({ error: "storage_unavailable" });
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
// The film's director and editor, and the producer, run its words.
const onFilm = (req, film) => isProducer(req) || (film.director_email && film.director_email === me(req)) || (film.editor_email && film.editor_email === me(req));
const closed = (film) => !!(film.pulled_at || film.archived_at);

// A film's transcripts as Claude reads them: only speakers whose words can
// be used now, as T1, T2, ... by role and code.
// cues are the transcript as it is (every line is checked against them);
// shown is what an agent reads: the same cues with every card's name as its
// code ("WJ01 gets up at five"). A line Claude quotes with a code in it
// isn't the speaker's words, so it's refused: a line with a name is anyway.
async function readable(sb, film, people) {
  const rows = (await run(sb.from("studio_transcripts").select("*").eq("film_id", film.id).order("created_at", { ascending: true }))) || [];
  const out = [];
  for (const t of rows) {
    const p = people.find((x) => x.id === t.person_id);
    if (!p || W.whyNot(p)) continue;
    const shown = t.cues.map((c) => ({ ...c, t: W.maskNames(c.t, people) }));
    out.push({ ref: `T${out.length + 1}`, id: t.id, person_id: t.person_id, speaker: W.speakerLabel(p), label: t.label, frames: !!t.frames, fps: t.fps == null ? null : Number(t.fps), cues: t.cues, shown });
  }
  return out;
}
// Whether an agent may still read a transcript, right now: the switch is
// on, the film open, the transcript still there, its speaker's words still
// usable. null, or why not.
async function stillReadable(sb, filmId, transcriptId) {
  if (!(await toolOn(sb, "claude_transcripts"))) return "Kyron turned off \"Claude reads transcripts\"";
  const f = await filmById(sb, filmId);
  if (!f || closed(f)) return "the film was closed";
  const t = await run(sb.from("studio_transcripts").select("id,person_id").eq("id", transcriptId).maybeSingle());
  if (!t) return "that transcript was removed";
  const p = await run(sb.from("studio_film_people").select("*").eq("id", t.person_id).maybeSingle());
  const why = W.whyNot(p);
  return why ? `that speaker's words can't be used now (${why.replace(/_/g, " ")})` : null;
}

// The film's kept words, grouped, each line with its times.
function wordsView(rows, transcripts, people) {
  const tr = new Map(transcripts.map((t) => [t.id, t]));
  const who = (pid) => {
    const p = people.find((x) => x.id === pid);
    return p ? { code: p.person_code, role: p.role, on_hold: W.whyNot(p) } : null;
  };
  const line = (r) => {
    const t = tr.get(r.transcript_id) || {};
    const opts = { frames: !!t.frames, fps: t.fps == null ? null : Number(t.fps) };
    return { id: r.id, quote: r.quote, from_cue: r.from_cue, to_cue: r.to_cue, start_ms: r.start_ms, end_ms: r.end_ms, at: `${W.TP.tc(r.start_ms, opts)}–${W.TP.tc(r.end_ms, opts)}`, transcript_id: r.transcript_id, label: t.label || null, speaker: who(r.person_id), note: r.note, text: r.text, made_by: r.made_by, run_id: r.run_id, created_at: r.created_at };
  };
  const groups = (kind) =>
    rows.filter((r) => r.kind === kind).map((g) => ({
      id: g.id, title: g.title, note: g.note, made_by: g.made_by, run_id: g.run_id, created_at: g.created_at,
      beats: rows.filter((b) => b.group_id === g.id).sort((a, b) => a.position - b.position).map(line),
    }));
  return {
    lines: rows.filter((r) => r.kind === "line").map(line),
    structures: groups("structure"),
    cutdowns: groups("cutdown"),
    captions: rows.filter((r) => r.kind === "caption").map(line),
  };
}

const stale = (r) => r.status === "running" && Date.now() - new Date(r.created_at).getTime() > STALE_RUN_MS;
function runStatus(r) {
  const status = stale(r) ? "failed" : r.status;
  return { id: r.id, role: r.role, status, eval_status: r.eval_status, created_at: r.created_at, completed_at: r.completed_at, output: r.output, error: status === "failed" && r.status === "running" ? "This run hasn't answered in 90 minutes (the server may have restarted). Ask again." : r.error };
}
// A film's run of one kind still going (not gone quiet), or null.
async function runningRun(sb, filmId, kind) {
  const links = (await run(sb.from("studio_film_runs").select("run_id,created_at").eq("film_id", filmId).eq("kind", kind).order("created_at", { ascending: false }).limit(5))) || [];
  if (!links.length) return null;
  const rows = (await run(sb.from("agent_runs").select("id,status,created_at").in("id", links.map((l) => l.run_id)))) || [];
  return rows.find((r) => r.status === "running" && !stale(r)) || null;
}

// ── The film's words ─────────────────────────────────────────────────────
router.get("/films/:id", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  const people = await peopleOf(sb, film.id);
  const [transcripts, rows, directions, links, claudeOn] = await Promise.all([
    run(sb.from("studio_transcripts").select("id,person_id,label,frames,fps,cue_count,words,duration_ms,created_by,created_at").eq("film_id", film.id).order("created_at", { ascending: true })),
    run(sb.from("studio_words").select("*").eq("film_id", film.id).order("created_at", { ascending: true }).limit(2000)),
    run(sb.from("studio_film_directions").select("*").eq("film_id", film.id).order("created_at", { ascending: false }).limit(5)),
    run(sb.from("studio_film_runs").select("run_id,kind,created_at").eq("film_id", film.id).order("created_at", { ascending: false }).limit(10)),
    toolOn(sb, "claude_transcripts"),
  ]);
  const runIds = (links || []).map((x) => x.run_id);
  const runs = runIds.length ? (await run(sb.from("agent_runs").select("id,role,status,output,error,created_at,completed_at,eval_status").in("id", runIds))) || [] : [];
  const kindOf = new Map((links || []).map((x) => [x.run_id, x.kind]));
  res.json({
    film: { id: film.id, kit_slug: film.kit_slug, title: film.title, athlete_id: film.athlete_id, format: film.format, lane: film.lane, one_sentence: film.one_sentence, closed: closed(film), plan: film.plan || {}, updated_at: film.updated_at },
    claude_on: claudeOn,
    can: { producer: isProducer(req), run: onFilm(req, film) && !closed(film) },
    people: people.map((p) => ({ id: p.id, code: p.person_code, role: p.role, is_minor: !!p.is_minor, speaker: !!p.speaker, why_not: W.whyNot(p) })),
    transcripts: (transcripts || []).map((t) => {
      const p = people.find((x) => x.id === t.person_id);
      return { ...t, fps: t.fps == null ? null : Number(t.fps), code: p ? p.person_code : null, role: p ? p.role : null, on_hold: p ? W.whyNot(p) : "not_on_this_film" };
    }),
    words: wordsView(rows || [], transcripts || [], people),
    directions: (directions || []).map((d) => ({ id: d.id, directions: d.directions, recommended: d.recommended, why_recommended: d.why_recommended, questions: d.questions, picked: d.picked, picked_by: d.picked_by, picked_at: d.picked_at, created_at: d.created_at })),
    runs: runs.map((r) => ({ ...runStatus(r), kind: kindOf.get(r.id) })).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
  });
}));

router.get("/transcripts/:tid", member, withDb(async (req, res, sb) => {
  if (!idOk(req.params.tid)) return res.status(404).json({ error: "not_found" });
  const t = await run(sb.from("studio_transcripts").select("*").eq("id", req.params.tid).maybeSingle());
  if (!t) return res.status(404).json({ error: "not_found" });
  const people = await peopleOf(sb, t.film_id);
  const p = people.find((x) => x.id === t.person_id);
  res.json({ transcript: { id: t.id, film_id: t.film_id, label: t.label, frames: !!t.frames, fps: t.fps == null ? null : Number(t.fps), cues: t.cues, code: p && p.person_code, role: p && p.role, on_hold: p ? W.whyNot(p) : "not_on_this_film" } });
}));

// ── Transcripts ──────────────────────────────────────────────────────────
router.post("/films/:id/transcripts", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  if (closed(film)) return res.status(409).json({ error: "film_closed" });
  const body = bodyOf(req);
  const people = await peopleOf(sb, film.id);
  const p = people.find((x) => x.id === String(body.person_id || "").toLowerCase());
  if (!p) return res.status(400).json({ error: "invalid", fields: ["person_id"] });
  const why = W.whyNot(p);
  if (why) return res.status(409).json({ error: "words_not_usable", why });
  const { errors, value } = W.transcriptInput(body);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (U.idNames(value.label, people).length) return res.status(400).json({ error: "invalid", fields: ["label_has_name"] });
  try {
    const t = await run(sb.from("studio_transcripts").insert({ film_id: film.id, person_id: p.id, label: value.label, frames: value.frames, fps: value.fps, cues: value.cues, cue_count: value.cues.length, words: value.words, duration_ms: value.duration_ms, created_by: me(req) }).select("id,person_id,label,cue_count,words,duration_ms,created_at").single());
    await T.logActivity(me(req), "studio_transcript_added", p.person_code, { film_id: film.id, cues: value.cues.length });
    res.json({ transcript: t });
  } catch (e) {
    refused(res, e);
  }
}));

router.delete("/transcripts/:tid", member, withDb(async (req, res, sb) => {
  if (!idOk(req.params.tid)) return res.status(404).json({ error: "not_found" });
  const t = await run(sb.from("studio_transcripts").select("id,film_id,person_id,created_by").eq("id", req.params.tid).maybeSingle());
  if (!t) return res.status(404).json({ error: "not_found" });
  if (!isProducer(req) && t.created_by !== me(req)) return res.status(403).json({ error: "producer_only" });
  try {
    const rows = await rpcRows(sb, "studio_transcript_remove", { p_transcript: t.id });
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    await T.logActivity(me(req), "studio_transcript_removed", null, { film_id: t.film_id });
    res.json({ ok: true });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Lines picked by hand ─────────────────────────────────────────────────
router.post("/films/:id/lines", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  if (closed(film)) return res.status(409).json({ error: "film_closed" });
  // The film's people keep and remove its lines (everyone else reads them).
  if (!onFilm(req, film)) return res.status(403).json({ error: "not_your_film" });
  const body = bodyOf(req);
  const people = await peopleOf(sb, film.id);
  const transcripts = await readable(sb, film, people);
  const tid = String(body.transcript_id || "").toLowerCase();
  if (!transcripts.some((t) => t.id === tid)) return res.status(409).json({ error: "words_not_usable", why: "that transcript isn't one whose words can be used now" });
  const kind = body.kind === "caption" ? "caption" : "line";
  const pick = { transcript: tid, from_cue: body.from_cue, to_cue: body.to_cue, quote: body.quote };
  const asks = new Set();
  const { issues, value } = W.checkWords(kind === "caption" ? { captions: [{ lead: pick, after: body.after }], structures: [] } : { lines: [{ ...pick, why: body.note }], structures: [] }, { transcripts, people, asks, namesOk: U.namesOkWords(body.names_ok) });
  // A by-hand pick has no structures: that rule is Claude's.
  const real = issues.filter((i) => i.where !== "structures");
  if (real.length) return res.status(400).json({ error: "invalid", issues: real.map((i) => i.issue).slice(0, 5) });
  // A word of a card's name: asked, and kept once they say it isn't a name here.
  if (asks.size) return res.status(400).json({ error: "invalid", fields: ["may_have_name"], words: [...asks].slice(0, 10) });
  const rows = W.rowsFor(value);
  try {
    await rpcRows(sb, "studio_words_save", { p_film: film.id, p_run: null, p_made_by: me(req), p_by: me(req), p_rows: rows, p_replace: false });
    res.json({ ok: true, kept: rows.length, line: value.lines[0] || value.captions[0] || null });
  } catch (e) {
    refused(res, e);
  }
}));

router.delete("/words/:wid", member, withDb(async (req, res, sb) => {
  if (!idOk(req.params.wid)) return res.status(404).json({ error: "not_found" });
  const w = await run(sb.from("studio_words").select("id,film_id,kind").eq("id", req.params.wid).maybeSingle());
  if (!w) return res.status(404).json({ error: "not_found" });
  const film = await filmById(sb, w.film_id);
  if (!film || !onFilm(req, film)) return res.status(403).json({ error: "not_your_film" });
  if (w.kind === "beat") return res.status(400).json({ error: "invalid", fields: ["remove_the_whole_structure"] });
  try {
    const rows = await rpcRows(sb, "studio_words_remove", { p_word: w.id });
    res.json({ ok: rows.length > 0 });
  } catch (e) {
    refused(res, e);
  }
}));

// ── Agent runs ───────────────────────────────────────────────────────────
async function startRun(sb, req, film, role, kind, task) {
  const row = await run(sb.from("agent_runs").insert({ role, client_id: null, task, status: "running", created_by: me(req) }).select("id").single());
  await run(sb.from("studio_film_runs").insert({ run_id: row.id, film_id: film.id, kind, created_by: me(req) }));
  return row.id;
}
async function finishRun(sb, runId, patch, history, keepJudgeWords) {
  await sb.from("agent_runs").update({ ...patch, completed_at: nowIso() }).eq("id", runId);
  if (history && history.length) {
    await sb.from("eval_runs").insert(
      history.map((h) => ({ agent_run_id: runId, attempt: h.attempt, verdict: h.verdict, total_score: h.total_score, biggest_miss: keepJudgeWords ? h.biggest_miss : null, auto_fail_triggered: h.auto_fail_triggered, evaluator_model: h.evaluator_model }))
    ).then(() => {}, () => {});
  }
}
const passedEval = (r) => ["passed", "passed_after_retry", "not_run"].includes(r.eval_status);

router.post("/films/:id/ask-claude", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  if (closed(film)) return res.status(409).json({ error: "film_closed" });
  if (!onFilm(req, film)) return res.status(403).json({ error: "not_your_film" });
  // Claude goes on the approved-tools list first: Kyron's switch.
  if (!(await toolOn(sb, "claude_transcripts"))) return res.status(409).json({ error: "tool_off", tool: "claude_transcripts" });
  const people = await peopleOf(sb, film.id);
  const transcripts = await readable(sb, film, people);
  if (!transcripts.length) return res.status(409).json({ error: "no_transcripts", hint: "add a cleared adult speaker's transcript first" });
  // One words run at a time for a film: a second one waits for the first.
  if (await runningRun(sb, film.id, "words")) return res.status(409).json({ error: "already_running" });
  const t = F.templateFor(film.kit_slug);
  const fmt = t && t.formats[film.format];
  const plan = film.plan || {};
  const scope = {
    film: {
      format: film.format,
      format_label: fmt ? fmt.label : film.format,
      spec: fmt ? fmt.spec : null,
      lane: film.lane,
      one_sentence: film.one_sentence ? W.maskNames(film.one_sentence, people) : null,
      must_have: (plan.must_have || []).map((x) => W.maskNames(x, people)),
      questions: (plan.quotes || []).map((q) => q && q.question).filter(Boolean).map((x) => W.maskNames(x, people)),
    },
    transcripts,
    people,
    // Read again before every page Claude reads: the switch, the film, the
    // transcript and its speaker. The first "no" stops the run.
    recheck: (transcriptId) => stillReadable(sb, film.id, transcriptId),
    control: { stopped: null },
  };
  const task = [
    `Film ${film.athlete_id}: ${scope.film.format_label}${scope.film.spec ? ` (${scope.film.spec})` : ""}, lane ${film.lane}.`,
    `One-sentence story: ${W.maskNames(film.one_sentence || "(not written yet)", people)}`,
    `Transcripts: ${transcripts.map((x) => `${x.ref} ${x.speaker}, ${x.cues.length} cues`).join("; ")}.`,
    "Read them all, then hand back the strongest lines, two or three structures, cutdowns and captions, as the skill says.",
  ].join("\n");
  let runId;
  try {
    runId = await startRun(sb, req, film, "words-editor", "words", task);
  } catch (e) {
    return refused(res, e);
  }
  res.json({ ok: true, run_id: runId, transcripts: transcripts.length });
  await T.logActivity(me(req), "studio_words_claude", film.athlete_id, { film_id: film.id, transcripts: transcripts.length, run_id: runId });
  const by = me(req);
  setImmediate(async () => {
    let stage = null;
    try {
      const result = await runWords({ role: "words-editor", task, scope: { ...scope, onStage: (s) => (stage = s) } });
      let rows = stage && stage.rows ? stage.rows : null;
      let kept = 0;
      let saveError = null;
      // Stopped on the way (the switch, a consent, a card), or a newer run
      // started since: nothing is kept.
      let stopped = scope.control.stopped;
      if (!stopped && rows && rows.length) {
        for (const tid of [...new Set(rows.map((r) => r.transcript_id).filter(Boolean))]) {
          stopped = stopped || (await stillReadable(sb, film.id, tid));
        }
        const newer = (await run(sb.from("studio_film_runs").select("run_id,created_at").eq("film_id", film.id).eq("kind", "words").order("created_at", { ascending: false }).limit(1))) || [];
        if (!stopped && newer[0] && newer[0].run_id !== runId) stopped = "a newer run started for this film";
      }
      if (stopped) rows = null;
      if (rows && rows.length) {
        try {
          kept = (await rpcRows(sb, "studio_words_save", { p_film: film.id, p_run: runId, p_made_by: "claude", p_by: by, p_rows: rows, p_replace: true }))[0];
          kept = typeof kept === "object" && kept ? Object.values(kept)[0] : kept;
        } catch (e) {
          saveError = String((e && e.message) || e).slice(0, 300);
        }
      }
      const v = stage && stage.submitted;
      const counts = v ? `${v.lines.length} lines, ${v.structures.length} structures, ${v.cutdowns.length} cutdowns, ${v.captions.length} captions` : "nothing";
      // The row keeps no words: counts, and which tools ran.
      await finishRun(sb, runId, {
        status: stopped || saveError || !v ? "failed" : passedEval(result) ? "completed" : "waiting",
        output: stopped ? `Stopped: ${stopped}. Nothing was kept.` : saveError ? `Picked ${counts}, but they couldn't be kept: ${saveError}` : v ? `Picked ${counts}.` : "The Real-Words Editor didn't hand back a set.",
        error: stopped ? `Stopped: ${stopped}.` : saveError || (v ? null : "No set came back."),
        trace: (result.trace || []).filter((x) => x && x.type === "tool_use").map((x) => ({ type: "tool_use", name: x.name })),
        usage: result.usage,
        eval_status: result.eval_status,
        retry_count: result.retry_count || 0,
        eval_summary: result.eval_history && result.eval_history.length ? `Score ${result.eval_history[result.eval_history.length - 1].total_score}` : null,
      }, result.eval_history, false);
      void kept;
      const good = v && !saveError && !stopped;
      P.notifySoon([by], { title: good ? "Real words are ready" : "The Real-Words Editor stopped", body: good ? `${film.athlete_id}: ${counts}` : "Open the film to see why.", url: `/app/#film-words/${film.id}`, tag: `words-${film.id}` });
    } catch (e) {
      console.error(`[studio-words] words run ${runId} failed:`, e && e.message);
      await finishRun(sb, runId, { status: "failed", error: String((e && e.message) || e).slice(0, 300) }, null, false);
    }
  });
}));

router.post("/films/:id/directions", member, withDb(async (req, res, sb) => {
  const film = await filmById(sb, req.params.id);
  if (!film) return res.status(404).json({ error: "not_found" });
  if (closed(film)) return res.status(409).json({ error: "film_closed" });
  if (!(isProducer(req) || (film.director_email && film.director_email === me(req)))) return res.status(403).json({ error: "producer_only" });
  const people = await peopleOf(sb, film.id);
  if (await runningRun(sb, film.id, "directions")) return res.status(409).json({ error: "already_running" });
  const t = F.templateFor(film.kit_slug);
  const fmt = t && t.formats[film.format];
  let kit = null;
  try {
    kit = await S.approvedKit(sb, film.kit_slug);
  } catch (e) {
    kit = null;
  }
  const titles = kit && kit.kit && Array.isArray(kit.kit.columns) ? kit.kit.columns.flatMap((c) => (c.cards || []).map((k) => k.title)).slice(0, 200) : [];
  const plan = film.plan || {};
  const mask = (x) => (x == null ? null : W.maskNames(x, people));
  const scope = {
    film: {
      athlete_id: film.athlete_id,
      lane: film.lane,
      format: film.format,
      format_label: fmt ? fmt.label : film.format,
      spec: fmt ? fmt.spec : null,
      one_sentence: film.one_sentence ? W.maskNames(film.one_sentence, people) : null,
      second_yes_label: film.second_yes_label || null,
      board: {
        references: (plan.references || []).map((r) => ({ url: r.url || null, note: mask(r.note) })),
        song: mask(plan.song),
        speaker: Object.fromEntries(Object.entries(plan.speaker || {}).map(([k, v]) => [k, mask(v)])),
        questions: (plan.quotes || []).map((q) => q && q.question).filter(Boolean).map(mask),
        must_have: (plan.must_have || []).map(mask),
        frame_pair: { opening: mask((plan.frame_pair || {}).opening), closing: mask((plan.frame_pair || {}).closing) },
        shoot_date: plan.shoot_date || null,
      },
    },
    cards: people.map((p) => ({ code: p.person_code, role: p.role, minor: !!(p.is_minor || p.texas_youth), speaker: !!p.speaker, cleared: !!p.cleared_at && !p.consent_pulled_at, covers: { face: !!(p.covers || {}).face, name: !!(p.covers || {}).name, jersey: !!(p.covers || {}).jersey, voice: !!(p.covers || {}).voice } })),
    people,
    kitTitles: titles,
    kitCard: (title) => (kit ? F.cardFor(kit.kit, title) : null),
    searchTaste: async (q, tag) => rpcRows(sb, "studio_taste_search", { p_q: q || null, p_tag: tag || null, p_limit: 12 }),
    // Taste notes are read with every card's name (any film's) as a code too.
    maskTaste: (x) => (x == null ? x : W.maskNames(x, people)),
    tasteByRef: async (n) => (await run(sb.from("studio_taste").select("*").eq("ref_no", n).maybeSingle())) || null,
  };
  const task = [
    `Film ${film.athlete_id}: ${scope.film.format_label}${scope.film.spec ? ` (${scope.film.spec})` : ""}, lane ${film.lane}.`,
    `One-sentence story: ${W.maskNames(film.one_sentence || "(not written yet)", people)}`,
    `On camera: ${scope.cards.map((c) => `${c.code} ${c.role}${c.minor ? " (minor)" : ""}`).join(", ") || "(no cards yet)"}.`,
    "Give three different ways to make this film, as the skill says.",
  ].join("\n");
  let runId;
  try {
    runId = await startRun(sb, req, film, "film-directions", "directions", task);
  } catch (e) {
    return refused(res, e);
  }
  res.json({ ok: true, run_id: runId });
  await T.logActivity(me(req), "studio_directions", film.athlete_id, { film_id: film.id, run_id: runId });
  const by = me(req);
  setImmediate(async () => {
    let stage = null;
    try {
      const result = await runDirections({ role: "film-directions", task, scope: { ...scope, onStage: (s) => (stage = s) } });
      const v = stage && stage.submitted;
      let saveError = null;
      if (v) {
        try {
          const row = { film_id: film.id, run_id: runId, directions: v.directions, recommended: v.recommended, why_recommended: v.why_recommended, created_by: by };
          if (v.questions && v.questions.length) row.questions = v.questions;
          await run(sb.from("studio_film_directions").insert(row));
        } catch (e) {
          saveError = String((e && e.message) || e).slice(0, 300);
        }
      }
      await finishRun(sb, runId, {
        status: saveError || !v ? "failed" : passedEval(result) ? "completed" : "waiting",
        output: v ? `${require("../agents/studio-directions/tools").directionsText(v)}\n\n---\n${result.output || ""}` : result.output || "",
        error: saveError || (v ? null : "No directions came back."),
        trace: result.trace,
        usage: result.usage,
        eval_status: result.eval_status,
        retry_count: result.retry_count || 0,
        eval_summary: result.eval_summary,
        eval_biggest_miss: result.eval_biggest_miss,
      }, result.eval_history, true);
      P.notifySoon([by], { title: v && !saveError ? "Three directions are ready" : "Three Directions stopped", body: film.athlete_id, url: `/app/#film-words/${film.id}`, tag: `directions-${film.id}` });
    } catch (e) {
      console.error(`[studio-words] directions run ${runId} failed:`, e && e.message);
      await finishRun(sb, runId, { status: "failed", error: String((e && e.message) || e).slice(0, 300) }, null, true);
    }
  });
}));

router.post("/directions/:did/pick", member, withDb(async (req, res, sb) => {
  if (!isProducer(req)) return res.status(403).json({ error: "producer_only" });
  if (!idOk(req.params.did)) return res.status(404).json({ error: "not_found" });
  const n = bodyOf(req).n === null ? null : Math.floor(Number(bodyOf(req).n));
  if (n !== null && !(n >= 1 && n <= 3)) return res.status(400).json({ error: "invalid", fields: ["n"] });
  try {
    const rows = await run(sb.from("studio_film_directions").update(n === null ? { picked: null, picked_by: null } : { picked: n, picked_by: me(req) }).eq("id", req.params.did).select());
    if (!rows || !rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ directions: rows[0] });
  } catch (e) {
    refused(res, e);
  }
}));

router.get("/runs/:rid", member, withDb(async (req, res, sb) => {
  if (!idOk(req.params.rid)) return res.status(404).json({ error: "not_found" });
  const link = await run(sb.from("studio_film_runs").select("run_id,film_id,kind").eq("run_id", req.params.rid).maybeSingle());
  if (!link) return res.status(404).json({ error: "not_found" });
  const r = await run(sb.from("agent_runs").select("id,role,status,output,error,created_at,completed_at,eval_status").eq("id", link.run_id).maybeSingle());
  if (!r) return res.status(404).json({ error: "not_found" });
  res.json({ run: { ...runStatus(r), kind: link.kind, film_id: link.film_id } });
}));

router.use((req, res) => res.status(404).json({ error: "not_found" }));

module.exports = router;
