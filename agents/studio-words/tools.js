// Real-Words Editor tools: read a film's cleared adult transcripts and hand
// back the lines, structures, cutdowns and captions, every one checked word
// for word against the transcript (utils/studio-words.js checkWords). The
// set is staged in memory; routes/studio-words.js keeps it once the run is
// through (studio_words_save, where the database checks every line again).
//
// scope (set by the route, never by the model):
//   { film: { format, format_label, spec, lane, one_sentence, must_have, questions },
//     transcripts: [{ ref: "T1", id, person_id, speaker, label, frames, fps, cues: [{ n, s, e, t }] }],
//     people,          // the film's cards, for the name screen (never shown to the model)
//     onStage(stage) }

"use strict";

const { betaTool } = require("@anthropic-ai/sdk/helpers/beta/json-schema");
const W = require("../../utils/studio-words");
const K = require("../studio/kit");

const PAGE = 300;

function json(x) {
  return JSON.stringify(x, null, 1);
}
function refused(msg, issues) {
  return `Refused: ${msg}` + (issues && issues.length ? `\n${issues.slice(0, 40).map((i) => `- ${i.where}: ${i.issue}`).join("\n")}` : "");
}

const QUOTE = {
  type: "object",
  properties: {
    transcript: { type: "string", description: "T1, T2, ... as words_transcripts lists them" },
    from_cue: { type: "integer", description: "The cue the line starts in (its number after #)" },
    to_cue: { type: "integer", description: "The cue it ends in (the same cue for a one-cue line; 12 cues at most)" },
    quote: { type: "string", description: "The speaker's exact words, copied from those cues: nothing added, changed, cut from the middle or joined from elsewhere" },
  },
  required: ["transcript", "from_cue", "to_cue", "quote"],
};

function toolsFor(ctx) {
  const scope = ctx && ctx.scope;
  if (!scope || !Array.isArray(scope.transcripts)) throw new Error("words tools need a run scope");
  const stage = { submitted: null, rows: null, submits: 0 };
  if (typeof scope.onStage === "function") scope.onStage(stage);
  const film = scope.film || {};
  // Claude can't be asked "is that a name here?": a word of a card's name is a refusal.
  const checkCtx = { transcripts: scope.transcripts, people: scope.people || [], byClaude: true };
  const control = scope.control || { stopped: null };
  const stopNote = () => `Stopped: ${control.stopped}. Don't read or hand back anything more; say that the run stopped.`;

  const list = betaTool({
    name: "words_transcripts",
    description: "The film's transcripts you may read: whose words (by role and code), how many cues and words, how long. Call this first.",
    inputSchema: { type: "object", properties: {} },
    run: async () =>
      json(
        scope.transcripts.map((t) => ({
          transcript: t.ref,
          speaker: t.speaker,
          label: t.label,
          cues: t.cues.length,
          words: t.cues.reduce((n, c) => n + W.wordCount(c.t), 0),
          minutes: Math.round(((t.cues.length ? t.cues[t.cues.length - 1].e - t.cues[0].s : 0) / 60000) * 10) / 10,
        }))
      ),
  });

  const read = betaTool({
    name: "words_read",
    description: `One transcript's cues, numbered (T1#12 is cue 12 of T1), with when each is said. ${PAGE} cues a call: pass from_cue to read on. Only this speaker's words are here; the questions they were asked aren't.`,
    inputSchema: {
      type: "object",
      properties: { transcript: { type: "string" }, from_cue: { type: "integer" } },
      required: ["transcript"],
    },
    run: async ({ transcript, from_cue }) => {
      if (control.stopped) return stopNote();
      const t = scope.transcripts.find((x) => x.ref === transcript);
      if (!t) return refused(`no transcript "${transcript}". Call words_transcripts.`);
      // Read again, now: the switch, the film, the transcript, its speaker.
      const why = typeof scope.recheck === "function" ? await scope.recheck(t.id) : null;
      if (why) {
        control.stopped = why;
        return stopNote();
      }
      const from = Math.max(1, Math.floor(Number(from_cue) || 1));
      const to = from + PAGE - 1;
      const body = W.transcriptText(t, { from, to });
      const more = t.cues.length > to ? `\n(${t.cues.length - to} more cues: call again with from_cue ${to + 1})` : "";
      return `${t.ref} · ${t.speaker} · ${t.label}\n${body}${more}`;
    },
  });

  const brief = betaTool({
    name: "film_brief",
    description: "What the film is: its format and length, its lane, the one-sentence story, the must-have shots and the questions on the board.",
    inputSchema: { type: "object", properties: {} },
    run: async () =>
      json({
        format: film.format_label || film.format,
        spec: film.spec || null,
        lane: film.lane || null,
        one_sentence: film.one_sentence || null,
        must_have: film.must_have || [],
        questions: film.questions || [],
      }),
  });

  const submit = betaTool({
    name: "submit_words",
    description:
      "Hand back the set. Every quote must be the speaker's exact words from the cues you name; the times are worked out from the cues, so don't give any. Refusals say what to fix; call again with the whole set. Call again later to replace it.",
    inputSchema: {
      type: "object",
      properties: {
        lines: {
          type: "array",
          description: `The strongest lines, best first (${W.LIMITS.lines} at most).`,
          items: { type: "object", properties: { ...QUOTE.properties, why: { type: "string", description: "Why it's strong, in a sentence (300 characters at most)" } }, required: [...QUOTE.required, "why"] },
        },
        structures: {
          type: "array",
          description: "Two or three ways to build the film from these lines, each a different way in.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "A few words: 'Open on the drill'" },
              logline: { type: "string", description: "One sentence: how this version goes" },
              beats: {
                type: "array",
                description: `${W.LIMITS.beats[0]} to ${W.LIMITS.beats[1]} lines in the order they play`,
                items: { type: "object", properties: { ...QUOTE.properties, under: { type: "string", description: "What we see under it (200 characters at most)" } }, required: QUOTE.required },
              },
            },
            required: ["title", "logline", "beats"],
          },
        },
        cutdowns: {
          type: "array",
          description: `Short cuts that stand alone (${W.LIMITS.cutdowns} at most; a hero film gets three). The hook lands in the first two seconds.`,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              hook: { ...QUOTE, description: "The first line: said in two seconds or less" },
              then: { type: "array", items: QUOTE, description: `Up to ${W.LIMITS.then} lines after it` },
              why: { type: "string" },
            },
            required: ["title", "hook"],
          },
        },
        captions: {
          type: "array",
          description: `Post captions (${W.LIMITS.captions} at most): each opens on the speaker's own line, then a few words of ours; under ${W.CAPTION_WORDS} words in all.`,
          items: {
            type: "object",
            properties: { lead: QUOTE, after: { type: "string", description: "What follows the quote (plain, direct, no hype)" } },
            required: ["lead"],
          },
        },
      },
      required: ["lines", "structures"],
    },
    run: async (input) => {
      if (control.stopped) return stopNote();
      const { issues, value } = W.checkWords(input, checkCtx);
      if (issues.length) return refused("fix these and send the whole set again.", issues);
      stage.submits++;
      stage.submitted = value;
      stage.rows = W.rowsFor(value);
      const n = value.lines.length + value.structures.length + value.cutdowns.length + value.captions.length;
      return `Kept for review: ${value.lines.length} lines, ${value.structures.length} structures, ${value.cutdowns.length} cutdowns, ${value.captions.length} captions (${n} in all). Every quote matched the transcript.`;
    },
  });

  return [list, read, brief, submit];
}

// The set as the judge reads it (and the run's output): each line with its
// transcript, cues and times.
function wordsText(v, transcripts = []) {
  if (!v) return "";
  const t = (id) => transcripts.find((x) => x.id === id) || {};
  const at = (q) => {
    const tr = t(q.transcript_id);
    const opts = { frames: !!tr.frames, fps: tr.fps, drop: !!tr.drop_frame };
    return `${tr.ref || "?"}#${q.from_cue}${q.to_cue !== q.from_cue ? "–" + q.to_cue : ""} ${W.TP.tc(q.start_ms, opts)}–${W.TP.tc(q.end_ms, opts)}`;
  };
  const out = [];
  if (v.lines.length) {
    out.push("## Strongest lines");
    v.lines.forEach((l, i) => out.push(`${i + 1}. “${l.quote}” (${at(l)})${l.note ? ` Why: ${l.note}` : ""}`));
  }
  v.structures.forEach((s, i) => {
    out.push("", `## Structure ${i + 1}: ${s.title}`, s.note || "");
    s.beats.forEach((b, j) => out.push(`${j + 1}. “${b.quote}” (${at(b)})${b.note ? ` Under it: ${b.note}` : ""}`));
  });
  v.cutdowns.forEach((c, i) => {
    out.push("", `## Cutdown ${i + 1}: ${c.title}`, c.note || "");
    c.beats.forEach((b, j) => out.push(`${j === 0 ? "Hook" : j + 1 + "."} “${b.quote}” (${at(b)}, ${((b.end_ms - b.start_ms) / 1000).toFixed(1)} s)`));
  });
  if (v.captions.length) {
    out.push("", "## Captions");
    v.captions.forEach((c, i) => out.push(`${i + 1}. ${c.text} (${W.wordCount(c.text)} words; the quote is ${at(c)})`));
  }
  return out.join("\n").trim();
}

function evalView(result, stage, scope = {}) {
  const film = scope.film || {};
  const v = stage && stage.submitted;
  const head = `## The film\nFormat: ${film.format_label || film.format || "?"} (${film.spec || ""})\nStory: ${K.maskBanned(film.one_sentence || "(none written)")}\nTranscripts: ${(scope.transcripts || []).map((t) => `${t.ref} ${t.speaker}, ${t.cues.length} cues`).join("; ")}`;
  return {
    ...result,
    output: `${result.output}\n\n---\n${head}\n\n## The set\n${v ? wordsText(v, scope.transcripts) : "(none)"}\n\n[words] ${v ? "submitted" : "none"}`,
  };
}

module.exports = { toolsFor, evalView, wordsText };
