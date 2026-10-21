// The Operating System builder's two drafting agents. Each one only drafts:
// a person with the approver role (or Kyron) approves what reaches a client.
//
//   draftScores(build)      the five pillars from the Foundation Score intake
//   draftTranscript(build)  the Operational Transcript from the approved scores
//
//   ANTHROPIC_API_KEY   required; without it the app offers scoring by hand
//   OS_MODEL            optional; defaults to the model the other TOJ agents use
//
// The model never sees contact details or anything that can name a minor
// (utils/os.js PRIVATE_KEYS, MINOR_KEYS).

"use strict";

const O = require("./os");

const DEFAULT_MODEL = "claude-opus-4-8"; // agents/orchestrator-factory.js
let caller = null; // tests

function configured() {
  return !!caller || !!String(process.env.ANTHROPIC_API_KEY || "").trim();
}

async function callModel({ system, prompt, maxTokens }) {
  if (caller) return caller({ system, prompt, maxTokens });
  if (!configured()) {
    const e = new Error("ai_not_configured");
    e.code = "ai_not_configured";
    throw e;
  }
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: process.env.OS_MODEL || DEFAULT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// The first JSON object in a reply.
function parseJson(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw Object.assign(new Error("no_json_in_reply"), { code: "bad_reply" });
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    throw Object.assign(new Error("reply_not_json"), { code: "bad_reply" });
  }
}

const RULES = `TOJ rules (they override everything else):
- Use only facts the intake gives you. Never invent a number, a result, a client, a testimonial, a ranking or a quote.
- If the intake doesn't say, write "Not in the intake" rather than guessing.
- Never promise offers, scholarships, rankings, exposure or placement.
- Never name a minor. Refer to athletes by counts or roles, never by name.
- Banned words (never use them, in any form): ${O.BANNED_WORDS.join(", ")}.
- Plain, specific, owner-facing US English. Numbers over adjectives. Name the task, the hours, the dollars when the intake gives them.`;

function laneLine(v) {
  const lane = O.VERTICALS[v] || O.VERTICALS["personal-brand"];
  return `Lane: ${lane.label} (${lane.for}).`;
}

function scoresPrompt(build) {
  const v = build.vertical;
  const names = O.PILLARS.map((k) => `- ${k}: ${O.pillarName(v, k)}`).join("\n");
  const system = `You score businesses against TOJ Campaign's Foundation Score: five pillars, each 0-100.

Bands:
- 0-39: broken or doesn't exist
- 40-69: exists but underperforming
- 70-89: solid, minor gaps
- 90-100: a defensible advantage

Ground every score in the intake. Do not score any pillar above 40 without concrete evidence from the intake. If the intake says nothing about a pillar, score it 40 or lower, write "Insufficient data in the intake." as the evidence, and say what to find out as the gap.

${RULES}

Reply with JSON only, no prose, in exactly this shape:
{"pillars":{"brand_identity":{"score":0,"evidence":"one line from their own answers","gap":"what's missing to reach 80"},"operational_health":{...},"revenue_architecture":{...},"content_credibility":{...},"growth_readiness":{...}},"summary":"two sentences: where the operation stands and what to fix first"}`;
  const prompt = `${laneLine(v)}
Pillars (keys and the names this lane uses):
${names}

Business: ${O.displayName(build.intake, build.name)}

Foundation Score intake:
${O.intakeText(build.intake) || "- (no answers yet)"}`;
  return { system, prompt, maxTokens: 3000 };
}

function transcriptPrompt(build) {
  const v = build.vertical;
  const sec = O.SECTIONS[v] || O.SECTIONS["personal-brand"];
  const cols = O.LINE_COLUMNS[v] || O.LINE_COLUMNS["personal-brand"];
  const p = build.pillars || {};
  const scoreLines = O.PILLARS.map((k) => `- ${O.pillarName(v, k)}: ${p[k] ? p[k].score : "?"}/100 (${p[k] ? O.band(p[k].score).name : "?"}). Evidence: ${p[k] ? p[k].evidence : ""} Gap: ${p[k] ? p[k].gap : ""}`).join("\n");
  const system = `You write TOJ Campaign's Operational Transcript: the graded written report a client gets after their Foundation Score. A person at TOJ reviews and approves it before the client sees it.

Its sections, in this lane: ${sec.map((s, i) => `${String(i + 1).padStart(2, "0")} ${s}`).join(" · ")}.
The radar (section 02) is drawn from the approved scores; you don't write it.

${RULES}
- Lead the plan with low-effort, high-impact moves the client can do in days. Name bigger builds as what comes after.
- Point every recommendation at a gap the scores or the intake name. Cut anything that doesn't make money, save time or raise quality for this client.
- "figure" and "value" hold a number only when the intake gives it; otherwise leave them "".

Reply with JSON only, no prose, in exactly this shape:
{"executive_summary":"one paragraph: where the operation stands, the gap, what to fix first",
 "lines":[{"name":"${cols[0]}","figure":"${cols[1]} from the intake or empty","standing":"Healthy | Under-shipped | Priced too low | Missing | Not in the intake","note":"one line"}],
 "recovery":[{"title":"${sec[3]}: one item","value":"dollar figure only if the intake supports it, else empty","ease":"Easy | Medium | Hard","note":"one line"}],
 "roster":"one paragraph for ${sec[4]}",
 "path":[{"label":"Focus","text":"..."},{"label":"Secondary","text":"..."},{"label":"Backburner","text":"..."}],
 "actions":[{"title":"...","detail":"...","owner":"Client | System | TOJ"}]}
Give 2-5 lines, 2-4 recovery items, and exactly 5 actions ranked by leverage.`;
  const prompt = `${laneLine(v)}
Business: ${O.displayName(build.intake, build.name)}

Approved five-pillar scores (total ${O.totalScore(p)}/500; weakest: ${O.pillarName(v, O.weakest(p) || "brand_identity")}):
${scoreLines}

Foundation Score intake:
${O.intakeText(build.intake) || "- (no answers)"}`;
  return { system, prompt, maxTokens: 6000 };
}

async function draftScores(build) {
  const reply = await callModel(scoresPrompt(build));
  const raw = parseJson(reply);
  const { pillars, issues } = O.cleanScores(raw);
  return { pillars, summary: O.clean(raw.summary, 600), issues, source: "agent", model: caller ? "test" : process.env.OS_MODEL || DEFAULT_MODEL, drafted_at: new Date().toISOString() };
}

async function draftTranscript(build) {
  const reply = await callModel(transcriptPrompt(build));
  const t = O.cleanTranscript(parseJson(reply), build.vertical);
  return { ...t, source: "agent", model: caller ? "test" : process.env.OS_MODEL || DEFAULT_MODEL, drafted_at: new Date().toISOString() };
}

function _setCaller(fn) {
  caller = fn;
}

module.exports = { configured, draftScores, draftTranscript, scoresPrompt, transcriptPrompt, parseJson, DEFAULT_MODEL, _setCaller };
