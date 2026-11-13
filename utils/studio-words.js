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
// The TOJ voice: never a promise of reach (views, followers, being noticed
// by recruiters, an offer).
const PROMISE_RE = new RegExp(
  "\\b(go(?:es|ing)?\\s+viral|viral|followers?|subscribers?|exposure|clout|famous|fame|blow(?:s|ing)?\\s+up|" +
    "(?:more|bigger|wider|huge|massive|real|your|our|extra|national|nationwide)\\s+(?:reach|visibility|attention|buzz)|reach\\s+(?:more|thousands|millions|recruiters|scouts|coaches|colleges)|" +
    "(?:thousands|millions|hundreds|tons|lots|more|\\d[\\d,.]*\\s*[km]?)\\s+(?:of\\s+)?(?:views|likes|impressions|plays|eyes|fans)|" +
    "get(?:s|ting)?\\s+(?:you\\s+|him\\s+|her\\s+|them\\s+)?(?:noticed|seen|discovered|recruited|an?\\s+offer|offers|a\\s+scholarship)|" +
    "(?:recruiters?|scouts?|coaches|colleges?|schools?|teams?)\\s+(?:will|are\\s+going\\s+to|gonna)\\s+(?:notice|see|find|call|watch|come|reach\\s+out)|" +
    "(?:will|guaranteed\\s+to)\\s+(?:get|land|earn)\\s+(?:you\\s+|him\\s+|her\\s+|them\\s+)?(?:an?\\s+)?(?:offers?|scholarships?|recruited|noticed|signed)|" +
    "(?:your|his|her|their)\\s+(?:offer|offers|recruiting|scholarship)\\s+(?:list|sheet|board|count)|trending|on\\s+every\\s+(?:feed|timeline|phone|screen)|for\\s+you\\s+page|fyp)\\b",
  "giu"
);
// One emoji: a picture with its variation, skin tone and any pictures it's
// joined to ("👨‍👩‍👧" is one), a flag, or a keycap.
const EMOJI = "(?:\\p{Extended_Pictographic}(?:[\\u{FE0F}\\u{1F3FB}-\\u{1F3FF}]|\\u{200D}\\p{Extended_Pictographic})*|\\p{Regional_Indicator}{2}|[0-9#*]\\u{FE0F}?\\u{20E3})";
// Emoji one after another, whatever's between them but words ("🔥🔥🔥",
// "🔥.🔥.🔥", "🇺🇸 🇺🇸"): an emoji chain.
const EMOJI_RUN = new RegExp(`${EMOJI}[\\s\\p{P}\\p{Z}]*${EMOJI}`, "u");
// A line written for someone: a run of three words or more in quotes of any
// kind (“ ” " " ‘ ’ ' ' « » „ “ ‹ › 「 」), or put after "says:" / "the
// line:". Real words only: describe the kind of line instead.
const QUOTED_RUNS = [
  /[“"„«»‹›「『]([^“”"„«»‹›「」『』]{1,400})[”"“»«›‹」』]/gu,
  /(?:^|[\s(\[—–-])['‘]([^'‘’\n]{1,400}?)['’](?=$|[\s.,;:!?)\]—–-])/gu,
  /\b(?:says?|said|saying|tells?|told|line|quote|goes)\s*[:—–]\s*([^\n.!?]{1,400})/giu,
];
function writtenLines(text) {
  const out = [];
  for (const re of QUOTED_RUNS) {
    re.lastIndex = 0;
    for (const m of String(text || "").matchAll(re)) if (wordCount(m[1]) >= 3) out.push(m[1].trim());
  }
  return out;
}

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
  // Drop-frame (";"), only at the rates that have it.
  value.df_timecode = value.frames && r.drop === true && (value.fps === 29.97 || value.fps === 59.94);
  // A file with speaker labels for two voices or more: its questions are
  // other voices' lines, so a pause alone isn't a gap there
  // (public/app/transcript-parse.js pausesFor). One whose only label is the
  // speaker's may have had its questions cut out. An older phone sends no
  // count: one, so a pause is a gap (a line can't bridge it; nothing goes
  // that shouldn't).
  value.labelled = r.labelled === true;
  value.voices = Number.isInteger(r.voices) && r.voices >= 0 && r.voices <= 500 ? r.voices : 1;
  const pauses = TP.pausesFor({ labelled: value.labelled, voices: value.voices });
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
      // A cue after someone else's words (the browser marks it: a question
      // left out), or, unless the file names two voices, after a long pause:
      // a line doesn't reach back across it.
      const prev = cues[cues.length - 1];
      const gap = !!prev && (c.gap === true || (pauses && s - prev.e > TP.PAUSE_MS) || s < prev.s);
      cues.push(gap ? { n: cues.length + 1, s, e, t, gap: true } : { n: cues.length + 1, s, e, t });
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
// A word of a card's name (an adult's too), for certain or to ask about:
// the strict screen titles and stories use. { sure, maybe }.
function nameWords(text, people) {
  return { sure: U.strictNames(text, people), maybe: U.strictMaybe(text, people) };
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
// ctx.byClaude: Claude can't be asked, so a word of a card's name is a
// refusal; for a person it's a question (ctx.asks), kept once they say it
// isn't a name here (ctx.namesOk).
function askOrRefuse(words, ctx, where, issues, what) {
  const open = words.filter((w) => !(ctx.namesOk && ctx.namesOk.has(w)));
  if (!open.length) return;
  if (ctx.byClaude || !ctx.asks) issues.push({ where, issue: `${what} has "${open.join('", "')}", a word of a name on the film's cards: pick another` });
  else for (const w of open) ctx.asks.add(w);
}
// A minor's name run into a hashtag or a word: four letters or more as
// utils/studio-films.js minorRunIns reads it (an ordinary word that starts
// or ends with one, "island" for an Isla, is asked); three, certain where camelCase
// starts and ends it ("#PrayForKai", "KaiStrong"), asked at the start or the
// end of a word in a tag ("#teamkai", "#kaistrong"). In an ordinary word a
// three-letter one is the word ("same" for a Sam). 041's studio_minor_run_in
// reads the certain ones.
function runIns(text, people) {
  const r = U.minorRunIns(text, people);
  const sure = new Set(r.sure);
  const maybe = new Set(r.maybe);
  const raw = String(text || "");
  const shorts = new Set();
  for (const p of people || []) if (p && p.is_minor) for (const w of String(p.name || "").toLowerCase().split(/[^\p{L}\p{M}]+/u)) if (Array.from(w).length === 3) shorts.add(w);
  if (shorts.size) {
    const tags = [...raw.matchAll(/[#@][^\s#@]+/gu)].map((c) => [c.index, c.index + c[0].length]);
    for (const m of raw.matchAll(/[\p{L}\p{M}]+/gu)) {
      const tok = m[0];
      const low = tok.toLowerCase();
      if (low.length !== tok.length) continue;
      const bounds = new Set([0, tok.length]);
      let camel = false;
      for (let i = 1; i < tok.length; i++) {
        if (/\p{Lu}/u.test(tok[i]) && /\p{Ll}/u.test(tok[i - 1])) {
          bounds.add(i);
          camel = true;
        }
      }
      const inTag = tags.some(([a, b]) => m.index >= a && m.index < b);
      for (const w of shorts) {
        if (low === w) continue;
        for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) {
          const j = i + w.length;
          const everyday = U.EVERYDAY_NAMES.has(w);
          if (camel && bounds.has(i) && bounds.has(j)) (everyday ? maybe : sure).add(w);
          else if (inTag && (i === 0 || j === low.length) && !everyday) maybe.add(w);
        }
      }
    }
  }
  for (const w of sure) maybe.delete(w);
  return { sure: [...sure], maybe: [...maybe] };
}
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
      part_of_a_word: "a line starts and ends on whole words (not inside \"4.4\", \"1,000\" or \"can't\")",
      missing_words: "the transcript marks words as missing there: a line doesn't reach across them",
      across_a_gap: "a line doesn't reach across someone else's words or a long pause: pick it from one side",
      said_twice: "those words are said more than once in those cues: name only the cue it's in",
    }[found.why] || "not found";
    return { ok: false, issue: { where, issue: why } };
  }
  // A minor's name run into a hashtag or a word ("#PrayForJamie") counts too:
  // the name where a word starts or ends, asked about inside one.
  const runIn = runIns(found.quote, ctx.people);
  if (namesTrouble(found.quote, ctx.people) || runIn.sure.length) return { ok: false, issue: { where, issue: "this line names someone on the film's cards (or a word of a minor's name): pick another" } };
  // One word of an adult's name ("Darnell taught me everything"): Claude
  // picks another; a person is asked.
  const nw = nameWords(found.quote, ctx.people);
  const held = [];
  askOrRefuse([...nw.sure, ...nw.maybe, ...runIn.maybe], ctx, where, held, "this line");
  if (held.length) return { ok: false, issue: held[0] };
  const voice = K.lintWords(found.quote, where);
  if (voice.length) return { ok: false, issue: { where, issue: `${voice[0].issue} (on screen the kit allows none): pick another line` } };
  return {
    ok: true,
    value: { transcript_id: tr.id, person_id: tr.person_id, from_cue: found.from, to_cue: found.to, quote: found.quote, start_ms: found.s, end_ms: found.e, words: found.words, ref: tr.ref },
  };
}

// Our own words about a line (a why, what's under it, a title, a logline,
// what follows a caption's quote): no names (a word of anyone's, read
// strictly), no line written for someone, the TOJ voice.
function ownWords(text, max, where, ctx, issues) {
  const t = clean(text, max * 2);
  if (t && t.length > max) issues.push({ where, issue: `${max} characters at most` });
  if (t) {
    const nw = nameWords(t, ctx.people);
    // A word of a minor's name run into a hashtag or a word counts too ("#jordanstrong").
    const runIn = runIns(t, ctx.people);
    if (namesTrouble(t, ctx.people) || nw.sure.length || runIn.sure.length) issues.push({ where, issue: "no names here: the code or the role instead" });
    else askOrRefuse([...nw.maybe, ...runIn.maybe], ctx, where, issues, "this");
    for (const q of writtenLines(t)) {
      issues.push({ where, issue: `"${q.slice(0, 60)}" reads as a line written for someone. Real words only: quote the transcript (pick it as a line), or describe the kind of line` });
      break;
    }
  }
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
    // A caption is post text: its opening line keeps the TOJ voice too.
    for (const v of voiceTrouble(lead.value.quote)) issues.push({ where: `${where}.lead`, issue: `${v} (a caption goes out as ours): pick another line` });
    const before = issues.length;
    const after = ownWords(c && c.after, 600, `${where}.after`, ctx, issues) || "";
    const text = `“${lead.value.quote}”${after ? " " + after : ""}`;
    const n = wordCount(text);
    if (n >= CAPTION_WORDS) issues.push({ where, issue: `${n} words: a caption is under ${CAPTION_WORDS}` });
    void before;
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

// A transcript as Claude reads it: numbered cues with their times, the
// names in them as codes (tr.shown, when the route masked them).
function transcriptText(tr, { from = 1, to = Infinity } = {}) {
  const opts = { frames: !!tr.frames, fps: tr.fps, drop: !!tr.df_timecode };
  return (tr.shown || tr.cues)
    .filter((c) => c.n >= from && c.n <= to)
    .map((c) => `${tr.ref}#${c.n} [${TP.tc(c.s, opts)}–${TP.tc(c.e, opts)}]${c.gap ? " (after a question or a pause: a line doesn't reach back across it)" : ""} ${c.t}`)
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
  let out = String(text || "").replace(/[\u0001\u0002]/g, " ");
  if (!out) return out;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Codes go in as marks, and are written out last, so a code's own letters
  // ("TY1") are never read as a name.
  const codes = [];
  const mark = (by) => {
    codes.push(by);
    return `\u0001${codes.length - 1}\u0002`;
  };
  const swap = (word, by) => {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{M}])${esc(word)}(?![\\p{L}\\p{M}])`, "giu"), () => mark(by));
  };
  const subjects = [];
  for (const p of people || []) {
    if (p.name) subjects.push({ full: p.name, by: p.person_code, minor: !!p.is_minor });
    if (p.reviewer_name && p.reviewer_relation !== "self") subjects.push({ full: p.reviewer_name, by: `${p.person_code}'s ${p.reviewer_relation}`, minor: false });
  }
  // Whole names first, longest first; then each word of a name.
  subjects.sort((a, b) => b.full.length - a.full.length).forEach((x) => swap(x.full.trim(), x.by));
  // A name run together, anywhere in a word: "@jamierivers", "#JamieRivers2026",
  // "TyNg" (five letters or more; four for a minor).
  for (const x of subjects) {
    const parts = x.full.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);
    const joined = parts.join("");
    if (parts.length > 1 && Array.from(joined).length >= (x.minor ? 4 : 5)) out = out.replace(new RegExp(esc(joined), "giu"), () => ` ${mark(x.by)} `);
  }
  for (const x of subjects) {
    for (const w of x.full.split(/[^\p{L}\p{M}]+/u).filter(Boolean)) {
      const n = Array.from(w).length;
      if (n >= 3 || (x.minor && n === 2 && !U.EVERYDAY_2.has(w.toLowerCase()))) swap(w, x.by);
    }
  }
  // One word of a minor's name run into another word ("#PrayForJamie",
  // "JamieStrong", "#teamjamie"): four letters or more, anywhere in a tag,
  // and in an ordinary word where it's the name (utils/studio-films.js
  // minorRunIns: "Jamiestrong", "JamieStrong"), not where the word is a word
  // ("island" for an Isla, "umbrella" for an Ella); an everyday one ("hope")
  // written with its capital ("#PrayForHope"), or in a tag ("#prayforhope"),
  // not in an ordinary word ("hopeful"). Three letters: where camelCase
  // starts and ends it ("#PrayForKai", "KaiStrong"), or at the start or the
  // end of a word in a tag ("#teamkai"), never in an ordinary word ("same"
  // for a Sam).
  // The chunk (a run with no space) a token sits in, found once per chunk:
  // tokens come in order, so the last one found is reused.
  let span = { str: null, a: 0, b: 0 };
  const spanAt = (str, off) => {
    if (span.str !== str || off < span.a || off >= span.b) {
      let a = off;
      let b = off;
      while (a > 0 && !/\s/u.test(str[a - 1])) a -= 1;
      while (b < str.length && !/\s/u.test(str[b])) b += 1;
      span = { str, a, b };
    }
    return span;
  };
  const inTag = (str, off) => /[#@]/.test(str.slice(spanAt(str, off).a, off));
  // The run-in reading, once per chunk and name (a long run of letters with
  // the name many times in it is read once, not once a time); a chunk past
  // 200 characters isn't read: a name that's no everyday word in it is
  // coded wherever it stands.
  const reads = new Map();
  const runInSure = (chunk, full, w) => {
    if (chunk.length > 200) return true;
    const key = full + "\u0000" + chunk;
    if (!reads.has(key)) reads.set(key, new Set(U.minorRunIns(chunk, [{ name: full, is_minor: true }]).sure));
    return reads.get(key).has(w);
  };
  const chunkAt = (str, off) => {
    const sp = spanAt(str, off);
    return str.slice(sp.a, sp.b);
  };
  for (const x of subjects.filter((v) => v.minor)) {
    for (const w of x.full.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter((v) => Array.from(v).length >= 3)) {
      const short = Array.from(w).length === 3;
      out = out.replace(/[\p{L}\p{M}]+/gu, (tok, off, str) => {
        const low = tok.toLowerCase();
        if (low === w || !low.includes(w)) return tok;
        if (low.length !== tok.length) return short ? tok : ` ${mark(x.by)} `;
        const tag = inTag(str, off);
        const bounds = new Set([0, tok.length]);
        let camel = false;
        for (let k = 1; k < tok.length; k++) {
          if (/\p{Lu}/u.test(tok[k]) && /\p{Ll}/u.test(tok[k - 1])) {
            bounds.add(k);
            camel = true;
          }
        }
        let res = "";
        let i = 0;
        let chunk = null;
        for (let at = low.indexOf(w); at >= 0; at = low.indexOf(w, at + w.length)) {
          const j = at + w.length;
          // In a tag, coded unless an English word holds the letters
          // ("#islandlife"); in an ordinary word, where it's the name.
          const here = short
            ? (camel && bounds.has(at) && bounds.has(j)) || (tag && (at === 0 || j === low.length))
            : U.EVERYDAY_NAMES.has(w)
              ? /\p{Lu}/u.test(tok[at]) || tag
              : tag
                ? !U.heldInRun(low, at, w.length)
                : runInSure(chunk === null ? (chunk = chunkAt(str, off)) : chunk, x.full, w);
          if (here) {
            res += tok.slice(i, at) + ` ${mark(x.by)} `;
            i = j;
          }
        }
        return res + tok.slice(i);
      });
    }
  }
  return out.replace(/\u0001(\d+)\u0002/g, (_, k) => codes[Number(k)]);
}

module.exports = {
  LABEL_MAX,
  clean,
  TP,
  maskNames,
  runIns,
  writtenLines,
  nameWords,
  EMOJI_RUN,
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
