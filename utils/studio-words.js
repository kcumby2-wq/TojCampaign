"use strict";
// Real words (migration 041, docs/studio-films.md): a speaker's transcript,
// the lines picked from it, and the checks every line passes before it's
// kept. A line is the speaker's own words, word for word, found in the cues
// it names, with the times it's said (worked out here, never taken from
// whoever picked it). Claude's picks pass the same checks as a person's.
//
// The transcript itself is read in the browser (public/app/transcript-parse.js,
// required here too), so only the chosen speaker's words reach the server.

const crypto = require("crypto");
const TP = require("../public/app/transcript-parse.js");
const U = require("./studio-films");
const K = require("../agents/studio/kit");

const LABEL_MAX = 60;
const NOTE_MAX = 300;
const UNDER_MAX = 200;
const TITLE_MAX = 80;
// A caption is under 60 words and opens on the speaker's own line.
const CAPTION_WORDS = 60;
// A cutdown's first line lands in the first two seconds.
const HOOK_MS = 2000;
const LIMITS = Object.freeze({ lines: 12, structures: 3, beats: [3, 12], cutdowns: 6, then: 5, captions: 6 });
// The TOJ voice: never a promise of reach.
const PROMISE_RE = /\b(go(?:es|ing)?\s+viral|viral|followers?|exposure|blow(?:s|ing)?\s+up|famous|clout)\b/gi;
// Emoji one after another ("🔥🔥🔥"): an emoji chain.
const EMOJI_RUN = /\p{Extended_Pictographic}[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]*\s*\p{Extended_Pictographic}/u;

const clean = (s, max) => U.clean(s, max);
const wordCount = (s) => TP.tokens(String(s || "")).length;

// Whose words can be kept, or why not. Adults first: a minor's words wait
// for a later review. A speaker whose release covers their voice, cleared,
// consent not pulled.
function whyNot(person) {
  if (!person) return "not_on_this_film";
  if (person.is_minor) return "adults_first";
  if (!person.speaker) return "not_a_speaker";
  if (person.consent_pulled_at) return "consent_pulled";
  if (!person.cleared_at) return "not_cleared";
  if (!(person.covers && person.covers.voice === true)) return "voice_not_covered";
  return null;
}

// What the browser sends for a transcript: the speaker's cues only.
function transcriptInput(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const value = {};
  value.label = clean(r.label, LABEL_MAX) || "Interview";
  value.frames = r.frames === true;
  value.fps = value.frames ? Number(r.fps) : null;
  if (value.frames && !TP.FPS.includes(value.fps)) errors.push("fps");
  const list = Array.isArray(r.cues) ? r.cues : null;
  if (!list || !list.length) errors.push("cues");
  else if (list.length > TP.MAX_CUES) errors.push("too_many_cues");
  else {
    const cues = [];
    let total = 0;
    for (const c of list) {
      const s = Math.round(Number(c && c.s));
      const e = Math.round(Number(c && c.e));
      const t = String((c && c.t) || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
      if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e < s || e > TP.MAX_MS || !t || t.length > TP.MAX_CUE) {
        errors.push("cues");
        break;
      }
      total += t.length;
      cues.push({ n: cues.length + 1, s, e, t });
    }
    if (total > TP.MAX_TOTAL) errors.push("too_long");
    value.cues = cues;
    value.words = cues.reduce((n, c) => n + wordCount(c.t), 0);
    value.duration_ms = cues.length ? Math.max(0, cues[cues.length - 1].e - cues[0].s) : 0;
  }
  return { errors: [...new Set(errors)], value };
}

// Names in what's kept: a whole name or one run together, or any word of a
// minor's name (the database refuses the same: studio_names_in).
function namesTrouble(text, people) {
  return U.namesIn(text, people, { strong: true }).length > 0 || U.minorWords(text, people).length > 0;
}
function voiceTrouble(text) {
  const t = String(text || "");
  const out = [];
  const banned = K.lintWords(t, "x");
  if (banned.length) out.push(banned.map((i) => i.issue).join("; "));
  const promises = [...new Set((t.match(PROMISE_RE) || []).map((w) => w.toLowerCase()))];
  if (promises.length) out.push(`no promises of reach (${promises.join(", ")}): say what's true instead`);
  if (EMOJI_RUN.test(t)) out.push("no emoji chains");
  return out;
}

// One quoted line, checked: { ok, value } or { ok: false, issue }.
//   pick = { transcript: "T1" | id, from_cue, to_cue, quote }
function checkQuote(pick, ctx, where) {
  const p = pick && typeof pick === "object" ? pick : {};
  const tr = (ctx.transcripts || []).find((t) => t.ref === p.transcript || t.id === p.transcript);
  if (!tr) return { ok: false, issue: { where, issue: `no transcript "${p.transcript}"; use one of ${(ctx.transcripts || []).map((t) => t.ref).join(", ")}` } };
  const found = TP.find(tr.cues, p.from_cue, p.to_cue, p.quote);
  if (!found.ok) {
    const why = {
      cues: `cues ${p.from_cue}–${p.to_cue} aren't in ${tr.ref} (it has ${tr.cues.length})`,
      too_many_cues: "a line spans 12 cues at most",
      empty: "the quote is empty",
      not_verbatim: `those aren't the speaker's exact words in ${tr.ref}#${p.from_cue}–${p.to_cue}: copy them word for word, nothing added, changed or joined from elsewhere`,
    }[found.why] || "not found";
    return { ok: false, issue: { where, issue: why } };
  }
  if (namesTrouble(found.quote, ctx.people)) return { ok: false, issue: { where, issue: "this line names someone on the film's cards (or a word of a minor's name): pick another" } };
  const voice = K.lintWords(found.quote, where);
  if (voice.length) return { ok: false, issue: { where, issue: `${voice[0].issue} (on screen the kit allows none): pick another line` } };
  return {
    ok: true,
    value: { transcript_id: tr.id, person_id: tr.person_id, from_cue: found.from, to_cue: found.to, quote: found.quote, start_ms: found.s, end_ms: found.e, words: found.words, ref: tr.ref },
  };
}

function ownWords(text, max, where, ctx, issues) {
  const t = clean(text, max * 2);
  if (t && t.length > max) issues.push({ where, issue: `${max} characters at most` });
  if (t && namesTrouble(t, ctx.people)) issues.push({ where, issue: "no names here: the code or the role instead" });
  for (const v of t ? voiceTrouble(t) : []) issues.push({ where, issue: v });
  return t ? t.slice(0, max) : null;
}

// Claude's submission (agents/studio-words), or a person's by-hand picks,
// checked line by line. Returns { issues, value } with every quote as the
// transcript has it and its times worked out here.
function checkWords(input, ctx) {
  const r = input && typeof input === "object" ? input : {};
  const issues = [];
  const value = { lines: [], structures: [], cutdowns: [], captions: [] };
  const list = (v) => (Array.isArray(v) ? v : []);

  const lines = list(r.lines);
  if (lines.length > LIMITS.lines) issues.push({ where: "lines", issue: `${LIMITS.lines} at most: the strongest only` });
  lines.slice(0, LIMITS.lines).forEach((l, i) => {
    const q = checkQuote(l, ctx, `lines[${i}]`);
    if (!q.ok) return issues.push(q.issue);
    value.lines.push({ ...q.value, note: ownWords(l.why, NOTE_MAX, `lines[${i}].why`, ctx, issues) });
  });

  const structures = list(r.structures);
  const totalCues = (ctx.transcripts || []).reduce((n, t) => n + t.cues.length, 0);
  const minStructures = totalCues >= 12 ? 2 : 1;
  if (structures.length < minStructures || structures.length > LIMITS.structures) issues.push({ where: "structures", issue: `${minStructures === 2 ? "two or three" : "one to three"} structures` });
  const seenShapes = new Set();
  structures.slice(0, LIMITS.structures).forEach((s, i) => {
    const where = `structures[${i}]`;
    const title = ownWords(s && s.title, TITLE_MAX, `${where}.title`, ctx, issues);
    if (!title) issues.push({ where: `${where}.title`, issue: "name it (a few words)" });
    const beats = list(s && s.beats);
    if (beats.length < LIMITS.beats[0] || beats.length > LIMITS.beats[1]) issues.push({ where: `${where}.beats`, issue: `${LIMITS.beats[0]} to ${LIMITS.beats[1]} beats` });
    const out = [];
    beats.slice(0, LIMITS.beats[1]).forEach((b, j) => {
      const q = checkQuote(b, ctx, `${where}.beats[${j}]`);
      if (!q.ok) return issues.push(q.issue);
      out.push({ ...q.value, note: ownWords(b.under, UNDER_MAX, `${where}.beats[${j}].under`, ctx, issues) });
    });
    const shape = out.map((b) => `${b.transcript_id}:${b.from_cue}:${b.to_cue}:${b.quote}`).join("|");
    if (out.length && seenShapes.has(shape)) issues.push({ where, issue: "the same beats as another structure: make it a different way in" });
    seenShapes.add(shape);
    value.structures.push({ title, note: ownWords(s && s.logline, NOTE_MAX, `${where}.logline`, ctx, issues), beats: out });
  });

  const cutdowns = list(r.cutdowns);
  if (cutdowns.length > LIMITS.cutdowns) issues.push({ where: "cutdowns", issue: `${LIMITS.cutdowns} at most` });
  cutdowns.slice(0, LIMITS.cutdowns).forEach((c, i) => {
    const where = `cutdowns[${i}]`;
    const hook = checkQuote(c && c.hook, ctx, `${where}.hook`);
    const beats = [];
    if (!hook.ok) issues.push(hook.issue);
    else {
      const ms = hook.value.end_ms - hook.value.start_ms;
      if (ms > HOOK_MS) issues.push({ where: `${where}.hook`, issue: `it takes about ${(ms / 1000).toFixed(1)} s to say; a cutdown's first line lands in the first two seconds: pick a shorter one` });
      else beats.push({ ...hook.value, note: null });
    }
    const then = list(c && c.then);
    if (then.length > LIMITS.then) issues.push({ where: `${where}.then`, issue: `${LIMITS.then} lines at most after the hook` });
    then.slice(0, LIMITS.then).forEach((b, j) => {
      const q = checkQuote(b, ctx, `${where}.then[${j}]`);
      if (!q.ok) return issues.push(q.issue);
      beats.push({ ...q.value, note: null });
    });
    value.cutdowns.push({ title: ownWords(c && c.title, TITLE_MAX, `${where}.title`, ctx, issues) || `Cutdown ${i + 1}`, note: ownWords(c && c.why, NOTE_MAX, `${where}.why`, ctx, issues), beats });
  });

  const captions = list(r.captions);
  if (captions.length > LIMITS.captions) issues.push({ where: "captions", issue: `${LIMITS.captions} at most` });
  captions.slice(0, LIMITS.captions).forEach((c, i) => {
    const where = `captions[${i}]`;
    const lead = checkQuote(c && c.lead, ctx, `${where}.lead`);
    if (!lead.ok) return issues.push(lead.issue);
    const after = clean(c && c.after, 600) || "";
    const text = `“${lead.value.quote}”${after ? " " + after : ""}`;
    const n = wordCount(text);
    if (n >= CAPTION_WORDS) issues.push({ where, issue: `${n} words: a caption is under ${CAPTION_WORDS}` });
    if (after && namesTrouble(after, ctx.people)) issues.push({ where: `${where}.after`, issue: "no names here: the code or the role instead" });
    for (const v of voiceTrouble(after)) issues.push({ where: `${where}.after`, issue: v });
    value.captions.push({ ...lead.value, text, note: null });
  });
  return { issues, value };
}

// The rows a checked value becomes (studio_words, through studio_words_save).
// A structure or cutdown gets its id here, so its beats can point at it.
function rowsFor(value) {
  const rows = [];
  const quoteRow = (kind, v, extra = {}) => ({
    kind, transcript_id: v.transcript_id, from_cue: v.from_cue, to_cue: v.to_cue, quote: v.quote, start_ms: v.start_ms, end_ms: v.end_ms, note: v.note || null, ...extra,
  });
  for (const l of value.lines || []) rows.push(quoteRow("line", l));
  for (const [kind, groups] of [["structure", value.structures || []], ["cutdown", value.cutdowns || []]]) {
    for (const g of groups) {
      if (!g.beats || !g.beats.length) continue;
      const id = crypto.randomUUID();
      rows.push({ id, kind, title: g.title, note: g.note || null });
      g.beats.forEach((b, k) => rows.push(quoteRow("beat", b, { group_id: id, position: k + 1 })));
    }
  }
  for (const c of value.captions || []) rows.push(quoteRow("caption", c, { text: c.text }));
  return rows;
}

// A transcript as Claude reads it: numbered cues with their times.
function transcriptText(tr, { from = 1, to = Infinity } = {}) {
  const opts = { frames: !!tr.frames, fps: tr.fps };
  return tr.cues
    .filter((c) => c.n >= from && c.n <= to)
    .map((c) => `${tr.ref}#${c.n} [${TP.tc(c.s, opts)}–${TP.tc(c.e, opts)}] ${c.t}`)
    .join("\n");
}

// What a person calls a card's speaker in front of Claude: the role and the
// code, never the name.
function speakerLabel(p) {
  const role = { athlete: "the athlete", parent: "the parent", guardian: "the guardian", coach: "the coach", other: "the speaker" }[p && p.role] || "the speaker";
  return `${role} (${p && p.person_code})`;
}

// Free text written about a film (the board's notes on the speaker, say)
// with every card's name replaced by its code, before an agent reads it:
// agents see people by code and role only.
function maskNames(text, people) {
  let out = String(text || "");
  if (!out) return out;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const swap = (word, by) => {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{M}])${esc(word)}(?![\\p{L}\\p{M}])`, "giu"), by);
  };
  const subjects = [];
  for (const p of people || []) {
    if (p.name) subjects.push({ full: p.name, by: p.person_code, minor: !!p.is_minor });
    if (p.reviewer_name && p.reviewer_relation !== "self") subjects.push({ full: p.reviewer_name, by: `${p.person_code}'s ${p.reviewer_relation}`, minor: false });
  }
  // Whole names first, longest first; then each word of a name.
  subjects.sort((a, b) => b.full.length - a.full.length).forEach((x) => swap(x.full.trim(), x.by));
  for (const x of subjects) {
    for (const w of x.full.split(/[^\p{L}\p{M}]+/u).filter(Boolean)) {
      const n = Array.from(w).length;
      if (n >= 3 || (x.minor && n === 2 && !U.EVERYDAY_2.has(w.toLowerCase()))) swap(w, x.by);
    }
  }
  return out;
}

module.exports = {
  TP,
  maskNames,
  LIMITS,
  CAPTION_WORDS,
  HOOK_MS,
  PROMISE_RE,
  whyNot,
  transcriptInput,
  checkQuote,
  checkWords,
  rowsFor,
  transcriptText,
  speakerLabel,
  namesTrouble,
  voiceTrouble,
  wordCount,
};
