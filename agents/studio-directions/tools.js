// Three Directions tools: read a film's brief and board (no names: cards by
// code and role), the kit's cards and the taste library, and hand back three
// different ways to make the film. Staged in memory; routes/studio-words.js
// keeps them (studio_film_directions) and the producer picks one.
//
// scope (set by the route, never by the model):
//   { film: { title, athlete_id, lane, format, format_label, spec, one_sentence, board, second_yes_label },
//     cards: [{ code, role, minor, speaker, covers: { face, name, jersey, voice } }],
//     people,                 // the film's cards with names, for the name screen only
//     kitTitles: [..], kitCard(title) → { title, parts } | null,
//     searchTaste(query, tag), tasteByRef(n),
//     onStage(stage) }

"use strict";

const { betaTool } = require("@anthropic-ai/sdk/helpers/beta/json-schema");
const W = require("../../utils/studio-words");
const TA = require("../studio-brief/taste");
const { overlap } = require("../studio-brief/tools");

const LIMITS = Object.freeze({ name: 60, logline: 220, beat: 160, beats: [3, 8], look: 300, sound: 300, must_have: 3, must: 120, why: 300, risks: 300 });
const SAME_SHARE = 0.7;
// "Real words only": a quoted run of three words or more is a line written
// for someone. Describe the kind of line to find instead.
const QUOTED = /[“"]([^”"]{1,400})[”"]/g;

function json(x) {
  return JSON.stringify(x, null, 1);
}
function refused(msg, issues) {
  return `Refused: ${msg}` + (issues && issues.length ? `\n${issues.slice(0, 40).map((i) => `- ${i.where}: ${i.issue}`).join("\n")}` : "");
}

function toolsFor(ctx) {
  const scope = ctx && ctx.scope;
  if (!scope || !scope.film) throw new Error("directions tools need a run scope");
  const stage = { submitted: null, submits: 0 };
  if (typeof scope.onStage === "function") scope.onStage(stage);
  const people = scope.people || [];

  const read = betaTool({
    name: "film_read",
    description: "The film: its format and length, lane, one-sentence story, the board so far, who's on camera (by code and role, with what each release covers), and the titles of the kit's cards you can read.",
    inputSchema: { type: "object", properties: {} },
    run: async () => json({ ...scope.film, cards: scope.cards || [], kit_cards: scope.kitTitles || [] }),
  });

  const card = betaTool({
    name: "kit_card",
    description: "One card of the approved kit, by its exact title from film_read's kit_cards: the format's rules, the interview rules, minors on set, the looks.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    run: async ({ title }) => {
      const c = typeof scope.kitCard === "function" ? scope.kitCard(String(title || "")) : null;
      if (!c) return refused(`no kit card "${title}". Use a title from film_read's kit_cards.`);
      return `${c.title}\n${c.parts.map((p) => `- ${p.lead ? p.lead + " " : ""}${p.text}`).join("\n")}`;
    },
  });

  const submit = betaTool({
    name: "submit_directions",
    description:
      "Hand back three different ways to make this film, and the one you'd pick. Real words only: never write a line for a real person; describe the kind of line to find. Refusals say what to fix; call again with all three.",
    inputSchema: {
      type: "object",
      properties: {
        directions: {
          type: "array",
          description: "Exactly three, each a different way in.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "A few words: 'Open on the drill'." },
              logline: { type: "string", description: "One sentence: the film this direction makes." },
              beats: { type: "array", items: { type: "string" }, description: `${LIMITS.beats[0]} to ${LIMITS.beats[1]} beats in order, each a short line: what we see and what kind of line we hear` },
              look: { type: "string", description: "Light, color, framing, pace." },
              sound: { type: "string", description: "Voice, room sound, music (licensed or none)." },
              must_have: { type: "array", items: { type: "string" }, description: "Exactly three shots the director can't leave without." },
              why: { type: "string", description: "Why this way fits this film and this speaker." },
              risks: { type: "string", description: "What could go wrong on the day, and the fallback." },
              taste: { type: "array", items: { type: "object", properties: { ref: { type: "string" }, take: { type: "string" } }, required: ["ref"] }, description: "Taste notes this draws on: { ref: 'Taste 12', take }." },
            },
            required: ["name", "logline", "beats", "look", "must_have", "why"],
          },
        },
        recommended: { type: "integer", description: "1, 2 or 3." },
        why_recommended: { type: "string" },
        questions: { type: "array", items: { type: "string" }, description: "Up to 3 things only the producer can answer." },
      },
      required: ["directions", "recommended"],
    },
    run: async (input) => {
      const issues = [];
      const raw = Array.isArray(input && input.directions) ? input.directions : [];
      if (raw.length !== 3) issues.push({ where: "directions", issue: "exactly three: three ways in, not one answer" });
      const out = [];
      const s = (v, max, where, required) => {
        const t = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
        if (required && !t) issues.push({ where, issue: "fill it in" });
        if (t.length > max) issues.push({ where, issue: `${max} characters at most` });
        return t.slice(0, max);
      };
      for (let i = 0; i < Math.min(raw.length, 3); i++) {
        const d = raw[i] || {};
        const where = `directions[${i}]`;
        const beats = (Array.isArray(d.beats) ? d.beats : []).map((b, j) => s(b, LIMITS.beat, `${where}.beats[${j}]`, true));
        if (beats.length < LIMITS.beats[0] || beats.length > LIMITS.beats[1]) issues.push({ where: `${where}.beats`, issue: `${LIMITS.beats[0]} to ${LIMITS.beats[1]} beats` });
        const must = (Array.isArray(d.must_have) ? d.must_have : []).map((m, j) => s(m, LIMITS.must, `${where}.must_have[${j}]`, true));
        if (must.length !== LIMITS.must_have) issues.push({ where: `${where}.must_have`, issue: "exactly three must-have shots" });
        const taste = await TA.checkCited(scope, d.taste, `${where}.taste`);
        issues.push(...taste.issues);
        out.push({
          name: s(d.name, LIMITS.name, `${where}.name`, true),
          logline: s(d.logline, LIMITS.logline, `${where}.logline`, true),
          beats,
          look: s(d.look, LIMITS.look, `${where}.look`, true),
          sound: s(d.sound, LIMITS.sound, `${where}.sound`, false) || null,
          must_have: must,
          why: s(d.why, LIMITS.why, `${where}.why`, true),
          risks: s(d.risks, LIMITS.risks, `${where}.risks`, false) || null,
          taste: taste.cited,
        });
      }
      out.forEach((d, i) => {
        const where = `directions[${i}]`;
        const all = [d.name, d.logline, ...d.beats, d.look, d.sound, ...d.must_have, d.why, d.risks, ...d.taste.map((t) => t.use)].filter(Boolean).join("\n");
        for (const m of all.matchAll(QUOTED)) {
          if (W.wordCount(m[1]) >= 3) {
            issues.push({ where, issue: `"${m[1].slice(0, 60)}" reads as a line written for someone. Real words only: describe the kind of line to find (a line about Sundays), never write it` });
            break;
          }
        }
        if (W.namesTrouble(all, people)) issues.push({ where, issue: "no names: cards by code and role" });
        for (const v of W.voiceTrouble(all)) issues.push({ where, issue: v });
        for (let j = 0; j < i; j++) {
          if (d.name && out[j].name && d.name.toLowerCase() === out[j].name.toLowerCase()) issues.push({ where: `${where}.name`, issue: `the same name as direction ${j + 1}` });
          if (overlap([d.logline, ...d.beats].join(" "), [out[j].logline, ...out[j].beats].join(" ")) > SAME_SHARE) issues.push({ where, issue: `nearly the same film as direction ${j + 1}: find another way in` });
        }
      });
      const recommended = Math.floor(Number(input && input.recommended));
      if (!(recommended >= 1 && recommended <= 3)) issues.push({ where: "recommended", issue: "1, 2 or 3" });
      const why = s(input && input.why_recommended, 300, "why_recommended", false);
      const questions = (Array.isArray(input && input.questions) ? input.questions : []).map((q) => String(q).trim()).filter(Boolean);
      if (questions.length > 3) issues.push({ where: "questions", issue: "three at most" });
      for (const t of [why, ...questions]) {
        if (W.namesTrouble(t, people)) issues.push({ where: "why_recommended / questions", issue: "no names: cards by code and role" });
        for (const v of W.voiceTrouble(t)) issues.push({ where: "why_recommended / questions", issue: v });
      }
      if (issues.length) return refused("fix these and send all three again.", issues);
      stage.submits++;
      stage.submitted = { directions: out, recommended, why_recommended: why || null, questions };
      return `Kept for the producer: three directions, recommending ${recommended} (${out[recommended - 1].name}).`;
    },
  });

  return [read, card, TA.tasteSearchTool(scope), submit];
}

function directionsText(v) {
  if (!v) return "";
  const lines = [`Three directions. I'd pick ${v.recommended}${v.why_recommended ? `: ${v.why_recommended}` : "."}`];
  v.directions.forEach((d, i) => {
    lines.push("", `## ${i + 1}. ${d.name}`, d.logline, "", ...d.beats.map((b, j) => `${j + 1}. ${b}`), "", `Look: ${d.look}`);
    if (d.sound) lines.push(`Sound: ${d.sound}`);
    lines.push(`Must-have shots: ${d.must_have.join("; ")}`, `Why: ${d.why}`);
    if (d.risks) lines.push(`Risks: ${d.risks}`);
    for (const t of d.taste) lines.push(`From the taste library: ${t.ref} "${t.title}" ${t.url}${t.use ? `: ${t.use}` : ""}`);
  });
  if (v.questions && v.questions.length) lines.push("", "## Questions", ...v.questions.map((q) => `- ${q}`));
  return lines.join("\n");
}

function evalView(result, stage, scope = {}) {
  const f = scope.film || {};
  const v = stage && stage.submitted;
  const cards = (scope.cards || []).map((c) => `${c.code} ${c.role}${c.minor ? " (minor: wide, unidentifiable only)" : ""}${c.covers && !c.covers.face ? " (no face)" : ""}`).join("; ");
  return {
    ...result,
    output: `${result.output}\n\n---\n## The film\n${f.format_label || f.format} (${f.spec || ""}) · ${f.lane || ""}\nStory: ${f.one_sentence || "(none written)"}\nOn camera: ${cards || "(no cards yet)"}\n\n## The directions\n${v ? directionsText(v) : "(none)"}\n\n[directions] ${v ? "submitted" : "none"}`,
  };
}

module.exports = { toolsFor, evalView, directionsText, LIMITS };
