// Real words without a database: the transcript parser (SubRip, WebVTT, a
// Resolve-style timecode list), the word-for-word check and its times, the
// limits on hooks and captions, and the submit tools of the Real-Words
// Editor, Three Directions and the Brief Writer's three directions.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const TP = require("../public/app/transcript-parse.js");
const W = require("../utils/studio-words");

const SRT = `1
00:00:01,000 --> 00:00:04,000
Coach: I ran this drill in 2017.

2
00:00:04,500 --> 00:00:08,000
I still run it on Sundays.

3
00:00:08,000 --> 00:00:09,000
Interviewer: Why?

4
00:00:09,000 --> 00:00:12,000
Coach: Because it’s mine. It made me.

5
00:00:12,500 --> 00:00:13,000
Interviewer: Okay.
`;

test("transcripts: SubRip with typed labels, WebVTT voices, a timecode list with frames", () => {
  const r = TP.parse(SRT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.speakers, [{ who: "Coach", cues: 3 }, { who: "Interviewer", cues: 2 }]);
  const mine = TP.only(r.cues, "Coach");
  assert.deepEqual(mine.map((c) => [c.n, c.t]), [[1, "I ran this drill in 2017."], [2, "I still run it on Sundays."], [3, "Because it’s mine. It made me."]]);
  const vtt = TP.parse("WEBVTT\n\nNOTE made in Resolve\n\n00:01.000 --> 00:03.500 align:start\n<v Speaker 1>We get up at five.\n\n00:03.500 --> 00:05.000\n<v Speaker 2>Every day?\n");
  assert.deepEqual(vtt.cues.map((c) => [c.s, c.e, c.who, c.t]), [[1000, 3500, "Speaker 1", "We get up at five."], [3500, 5000, "Speaker 2", "Every day?"]]);
  const list = "01:00:00:00 - 01:00:03:12\nSpeaker 1\nI never missed a Sunday.\n\n01:00:03:12 - 01:00:06:00\nSpeaker 2\nNot one?\n";
  assert.deepEqual(TP.parse(list), { ok: false, error: "needs_fps", format: "timecodes", frames: true });
  const at24 = TP.parse(list, { fps: 24 });
  assert.deepEqual(at24.cues.map((c) => [c.s, c.e, c.who]), [[3600000, 3603500, "Speaker 1"], [3603500, 3606000, "Speaker 2"]]);
  assert.equal(TP.tc(3603500, { frames: true, fps: 24 }), "01:00:03:12");
  // A one-off "Listen:" isn't a speaker's label.
  const once = TP.parse("[00:00:05] Listen: you have to want it.\n[00:00:09] And then you go.");
  assert.deepEqual(once.cues.map((c) => [c.who, c.t]), [[null, "Listen: you have to want it."], [null, "And then you go."]]);
  // Sound notes and tags out.
  assert.equal(TP.parse("1\n00:00:01,000 --> 00:00:02,000\n<i>[music]</i> Here we go ♪\n").cues[0].t, "Here we go");
  assert.equal(TP.parse("nothing timed here").error, "no_timecodes");
});

test("a line is the speaker's exact words, found in its cues, with when it's said", () => {
  const cues = TP.only(TP.parse(SRT).cues, "Coach");
  const a = TP.find(cues, 1, 2, "drill in 2017. I still run it");
  assert.deepEqual(a, { ok: true, quote: "drill in 2017. I still run it", from: 1, to: 2, s: 2500, e: 6833, words: 7 });
  // Case and curly quotes set aside; the transcript's own text kept.
  assert.equal(TP.find(cues, 3, 3, "it's MINE").quote, "it’s mine");
  // Not their words: changed, joined from elsewhere, or out of range.
  assert.equal(TP.find(cues, 3, 3, "its mine").why, "not_verbatim");
  assert.equal(TP.find(cues, 1, 1, "I ran this drill in 2018").why, "not_verbatim");
  assert.equal(TP.find(cues, 2, 3, "Sundays. It made me").why, "not_verbatim");
  assert.equal(TP.find(cues, 3, 5, "x").why, "cues");
  // A wider range is narrowed to the cues the words are in.
  assert.deepEqual([TP.find(cues, 1, 3, "It made me").from, TP.find(cues, 1, 3, "It made me").to], [3, 3]);
});

function ctx(people = []) {
  const cues = TP.only(TP.parse(SRT).cues, "Coach");
  return { transcripts: [{ ref: "T1", id: "t-1", person_id: "p-1", cues, frames: false, fps: null }], people };
}
const q = (from, to, quote) => ({ transcript: "T1", from_cue: from, to_cue: to, quote });

test("the judge: hooks land in two seconds, captions open on the line and stay under 60 words, no names, no promises", () => {
  const c = ctx([{ id: "p-1", name: "Marcus Hill", person_code: "A0142" }, { id: "p-2", name: "Ty Ng", person_code: "A0143", is_minor: true }]);
  const good = W.checkWords({
    lines: [{ ...q(3, 3, "It made me"), why: "Short, and it's his" }],
    structures: [{ title: "Open on the drill", logline: "The drill, then why", beats: [q(1, 1, "I ran this drill in 2017"), q(2, 2, "I still run it on Sundays"), q(3, 3, "Because it's mine")] }],
    cutdowns: [{ title: "Sundays", hook: q(3, 3, "It made me"), then: [q(2, 2, "I still run it on Sundays")] }],
    captions: [{ lead: q(3, 3, "It made me"), after: "Seven years of Sundays, coached by Hooks." }],
  }, c);
  assert.deepEqual(good.issues, []);
  assert.equal(good.value.captions[0].text, "“It made me” Seven years of Sundays, coached by Hooks.");
  assert.equal(good.value.cutdowns[0].beats[0].quote, "It made me");
  // The rows: a structure and its beats point at each other.
  const rows = W.rowsFor(good.value);
  const head = rows.find((r) => r.kind === "structure");
  assert.deepEqual(rows.filter((r) => r.group_id === head.id).map((r) => r.position), [1, 2, 3]);

  const issues = (input) => W.checkWords({ structures: [], ...input }, c).issues.filter((i) => i.where !== "structures").map((i) => i.issue);
  assert.match(issues({ cutdowns: [{ title: "x", hook: q(1, 2, "I ran this drill in 2017. I still run it on Sundays") }] })[0], /takes about 7\.0 s/);
  assert.match(issues({ captions: [{ lead: q(3, 3, "It made me"), after: "word ".repeat(60) }] })[0], /under 60/);
  assert.match(issues({ captions: [{ lead: q(3, 3, "It made me"), after: "This will go viral" }] })[0], /no promises/);
  assert.match(issues({ captions: [{ lead: q(3, 3, "It made me"), after: "Sundays 🔥🔥🔥" }] })[0], /emoji/);
  assert.match(issues({ captions: [{ lead: q(3, 3, "It made me"), after: "With Ty after practice" }] })[0], /no names/);
  assert.match(issues({ lines: [{ ...q(3, 3, "It made me"), why: "Marcus Hill at his best" }] })[0], /no names/);
  assert.match(issues({ lines: [{ ...q(3, 3, "It made me"), why: "An elite line" }] })[0], /banned/);
  assert.match(issues({ lines: [{ ...q(3, 3, "It really made me"), why: "x" }] })[0], /exact words/);
  // Two structures with the same beats are one.
  const same = { title: "A", logline: "x", beats: [q(1, 1, "I ran this drill in 2017"), q(2, 2, "I still run it on Sundays"), q(3, 3, "It made me")] };
  assert.ok(W.checkWords({ structures: [same, { ...same, title: "B" }] }, c).issues.some((i) => /same beats/.test(i.issue)));
});

test("transcripts from the browser: cues checked, numbered, counted; names masked for agents", () => {
  const ok = W.transcriptInput({ label: "Sunday sit-down", cues: [{ s: 0, e: 1200, t: "We get up at five." }, { s: 1200, e: 2000, t: "Every day." }] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value.cues.map((c) => c.n), [1, 2]);
  assert.equal(ok.value.words, 7);
  assert.deepEqual(W.transcriptInput({ cues: [{ s: 5, e: 1, t: "x" }] }).errors, ["cues"]);
  assert.deepEqual(W.transcriptInput({ frames: true, fps: 31, cues: [{ s: 0, e: 1, t: "x" }] }).errors, ["fps"]);
  assert.equal(W.whyNot({ is_minor: true }), "adults_first");
  assert.equal(W.whyNot({ speaker: true, cleared_at: "x", covers: {} }), "voice_not_covered");
  assert.equal(W.whyNot({ speaker: true, cleared_at: "x", covers: { voice: true } }), null);
  const people = [{ person_code: "A0142", name: "Jamie Rivers" }, { person_code: "A0143", name: "Ty Ng", is_minor: true, reviewer_name: "Lin Ng", reviewer_relation: "parent" }];
  assert.equal(W.maskNames("Jamie runs with Ty; Lin Ng drives. He's fast.", people), "A0142 runs with A0143; A0143's parent drives. He's fast.");
});

test("the Real-Words Editor's submit tool stages only a set that passes, and reads transcripts by role and code", async () => {
  const { toolsFor, evalView } = require("../agents/studio-words/tools");
  let stage = null;
  const c = ctx([{ id: "p-1", name: "Marcus Hill", person_code: "A0142" }]);
  const tools = toolsFor({ scope: { film: { format_label: "Hero film", spec: "60–90 seconds", one_sentence: "He ran it in 2017." }, transcripts: c.transcripts.map((t) => ({ ...t, speaker: "the coach (A0142)", label: "Interview 1" })), people: c.people, onStage: (s) => (stage = s) } });
  const by = (n) => tools.find((t) => t.name === n);
  assert.match(await by("words_transcripts").run({}), /the coach \(A0142\)/);
  assert.match(await by("words_read").run({ transcript: "T1" }), /T1#2 \[00:00:04\.5–00:00:08\.0\] I still run it on Sundays\./);
  const bad = await by("submit_words").run({ lines: [{ ...q(1, 1, "I ran a drill in 2017"), why: "x" }], structures: [] });
  assert.match(bad, /^Refused/);
  assert.equal(stage.submitted, null);
  const fine = await by("submit_words").run({ lines: [{ ...q(3, 3, "It made me"), why: "His" }], structures: [{ title: "Short", logline: "x", beats: [q(1, 1, "I ran this drill"), q(2, 2, "I still run it"), q(3, 3, "It made me")] }] });
  assert.match(fine, /^Kept for review/);
  assert.equal(stage.rows.filter((r) => r.kind === "beat").length, 3);
  const judged = evalView({ output: "Done." }, stage, { film: { format_label: "Hero film" }, transcripts: c.transcripts });
  assert.match(judged.output, /“It made me” \(T1#3 00:00:10\.5–00:00:12\.0\)/);
  assert.match(judged.output, /\[words\] submitted/);
});

test("Three Directions: three different ways in, no line written for anyone, no names, taste cited", async () => {
  const { toolsFor } = require("../agents/studio-directions/tools");
  let stage = null;
  const taste = { ref_no: 3, title: "A single-take portrait", url: "https://vimeo.com/123", kind: "film", note: "One take", take: "the patience", tags: [] };
  const tools = toolsFor({ scope: { film: { format_label: "Hero film" }, cards: [{ code: "A0142", role: "coach" }], people: [{ person_code: "A0142", name: "Marcus Hill" }], kitTitles: [], kitCard: () => null, searchTaste: async () => [taste], tasteByRef: async (n) => (n === 3 ? taste : null), onStage: (s) => (stage = s) } });
  const submit = tools.find((t) => t.name === "submit_directions");
  const d = (name, logline, extra = {}) => ({ name, logline, beats: [`${name}: the cones at dawn`, `${name}: hands on the sled`, `${name}: a line about the first Sunday`], look: "Low sun, handheld", sound: "Room sound", must_have: ["Cones from above", "Hands on the sled", "The gate at dusk"], why: "It's his routine", ...extra });
  const three = [d("Open on the drill", "The drill first, then why"), d("Start at the end", "The last Sunday, then back"), d("One take", "One unbroken run of the drill", { taste: [{ ref: "Taste 3", take: "Hold the shot" }] })];
  assert.match(await submit.run({ directions: three.slice(0, 2), recommended: 1 }), /exactly three/);
  assert.match(await submit.run({ directions: [three[0], three[1], d("Wordy", "x", { beats: ["He says “I never missed a Sunday” here", "b", "c"] })], recommended: 1 }), /written for someone/);
  assert.match(await submit.run({ directions: [three[0], three[1], d("Named", "Marcus Hill at dawn")], recommended: 1 }), /no names/);
  assert.match(await submit.run({ directions: [three[0], three[1], d("x", "y", { taste: [{ ref: "Taste 9" }] })], recommended: 1 }), /no taste note "Taste 9"/);
  assert.match(await submit.run({ directions: three, recommended: 3, why_recommended: "The most his" }), /^Kept/);
  assert.equal(stage.submitted.directions[2].taste[0].ref, "Taste 3");
});

test("the Brief Writer hands back three directions, each a whole brief, and names its pick", async () => {
  const { toolsFor, briefText } = require("../agents/studio-brief/tools");
  let stage = null;
  const tools = toolsFor({ scope: { approvedKit: async (slug) => (slug === "same-work" ? { slug, version: 3, kit: { title: "Same Work", columns: [] } } : null), slugTaken: async () => false, listApproved: async () => [], references: [], searchTaste: async () => [], tasteByRef: async () => null, onStage: (s) => (stage = s) } });
  const submit = tools.find((t) => t.name === "submit_brief");
  const brief = (n, words) => `Goal: ${words}\n\nKit: Same Work (refresh)\n\nDo:\n1. The look and sound › Vintage looks: ${words} (proposed), direction ${n}.\n\nLeave alone:\n- Every locked rule card.\n\nDone when:\n- One card changed.`;
  const dirs = [
    { name: "The close one", angle: "One card", brief: brief(1, "add a fine film grain to the looks card as a fourth option") },
    { name: "Push it", angle: "Three cards", brief: brief(2, "a whole Super 8 section across looks, gear and the delivery checklist with sources") },
    { name: "Another way in", angle: "A checklist", brief: brief(3, "a grain check step in the editor's delivery checklist instead of a new look") },
  ];
  assert.match(await submit.run({ mode: "refresh", slug: "same-work", title: "Grain", directions: dirs.slice(0, 2), recommended: 1, references: [] }), /exactly 3/);
  assert.match(await submit.run({ mode: "refresh", slug: "same-work", title: "Grain", directions: [dirs[0], dirs[0], dirs[2]], recommended: 1, references: [] }), /same name|nearly the same/);
  assert.match(await submit.run({ mode: "refresh", slug: "same-work", title: "Grain", directions: dirs, recommended: 2, why_recommended: "It's what the idea asked", references: [] }), /recommending 2/);
  assert.equal(stage.submitted.brief, dirs[1].brief, "the pick's brief is the one a kit run reads by default");
  const text = briefText(stage.submitted);
  assert.match(text, /Three directions\. I'd pick 2: It's what the idea asked/);
  assert.match(text, /## Direction 3: Another way in/);
  // A brief from before directions still reads.
  assert.match(briefText({ title: "Old", mode: "refresh", slug: "same-work", brief: "Goal: x", references: [], questions: [] }), /Goal: x/);
});
