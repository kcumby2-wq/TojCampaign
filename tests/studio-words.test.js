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

test("a subtitle with two voices or two labels is split, and only the chosen speaker's lines go", () => {
  // Two voices in one WebVTT cue, and two voice tags on one line.
  let p = TP.parse("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Dad>He gets up at five.\n\n00:00:04.000 --> 00:00:08.000\n<v Jamie>I want to play for my dad.\n<v Dad>He says that every day.\n");
  assert.deepEqual(TP.only(p.cues, "Dad").map((c) => c.t), ["He gets up at five.", "He says that every day."]);
  assert.deepEqual(TP.only(p.cues, "Jamie").map((c) => c.t), ["I want to play for my dad."]);
  p = TP.parse("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Coach>Because it's mine.</v> <v Interviewer>Why Sundays?</v>\n");
  assert.deepEqual(p.cues.map((c) => [c.who, c.t]), [["Coach", "Because it's mine."], ["Interviewer", "Why Sundays?"]]);
  // Its time is shared by the words.
  assert.ok(p.cues[0].e > p.cues[0].s && p.cues[0].e === p.cues[1].s && p.cues[1].e === 3000);
  // A second typed label in a cue, and a label in any alphabet.
  p = TP.parse("1\n00:00:01,000 --> 00:00:04,000\nCOACH: I ran this drill in 2017.\nINTERVIEWER: Why that year?\n\n2\n00:00:04,000 --> 00:00:07,000\nCOACH: Because nobody filmed it.\n\n3\n00:00:07,000 --> 00:00:09,000\nJOSÉ: And why Sundays?\n");
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["I ran this drill in 2017.", "Because nobody filmed it."]);
  assert.ok(p.speakers.some((x) => x.who === "JOSÉ"));
  // A line with no label in a labelled file is a voice the file doesn't name: only those go when it's picked.
  p = TP.parse("1\n00:00:00,500 --> 00:00:01,500\nOkay, we're rolling.\n\n2\n00:00:02,000 --> 00:00:04,000\nINTERVIEWER: What drives you?\n\n3\n00:00:04,000 --> 00:00:07,000\nJAMIE: My dad.\n\n4\n00:00:07,000 --> 00:00:09,000\nJAMIE: I want to make it for him.\n");
  assert.equal(p.labelled, true);
  assert.deepEqual(TP.only(p.cues, "").map((c) => c.t), ["Okay, we're rolling."]);
  assert.equal(p.speakers.some((x) => x.who === null), false, "no 'everything' choice in a labelled file");
  // A file with no labels: a "- " subtitle's lines are another voice, left out.
  p = TP.parse("1\n00:00:01,000 --> 00:00:04,000\nI have run here twenty years.\n\n2\n00:00:04,000 --> 00:00:08,000\n- Were you nervous?\n- Every single time.\n\n3\n00:00:08,000 --> 00:00:10,000\nAnd I still am.\n");
  assert.deepEqual([p.labelled, p.mixed], [false, 2]);
  assert.deepEqual(TP.only(p.cues, null).map((c) => c.t), ["I have run here twenty years.", "And I still am."]);
});

test("dashed subtitles are two voices, with or without a space; a label is read where it looks like one", () => {
  // Labelled, Netflix-style dashes: nobody's, not the last speaker's, and never a choice.
  let p = TP.parse("1\n00:00:01,000 --> 00:00:03,000\nDAD: I always tell him to work.\n\n2\n00:00:03,000 --> 00:00:05,000\n-I want to play for my dad.\n-He says that every day.\n\n3\n00:00:05,000 --> 00:00:07,000\nDAD: And I mean it.\n");
  const dad = TP.only(p.cues, "DAD");
  assert.deepEqual(dad.map((c) => c.t), ["I always tell him to work.", "And I mean it."]);
  assert.equal(p.mixed, 2);
  assert.equal(p.speakers.some((x) => x.who === TP.TWO), false, "never a choice");
  assert.deepEqual(TP.only(p.cues, "").map((c) => c.t), [], "nor in (no label)");
  assert.equal(dad[1].gap, true, "a line doesn't reach across them");
  assert.equal(TP.find(dad, 1, 2, "I want to play").ok, false);
  // No labels, only the second line dashed: the question goes nowhere either.
  p = TP.parse("1\n00:00:01,000 --> 00:00:03,000\nI always tell him to work.\n\n2\n00:00:03,000 --> 00:00:05,000\nWere you nervous?\n-No.\n\n3\n00:00:05,000 --> 00:00:07,000\nAnd I mean it.\n");
  assert.deepEqual([p.labelled, p.mixed], [false, 2]);
  assert.deepEqual(TP.only(p.cues, null).map((c) => c.t), ["I always tell him to work.", "And I mean it."]);
  // A wrapped line with a colon is words; a later line that looks like a label is one.
  p = TP.parse("1\n00:00:01,000 --> 00:00:04,000\nCOACH: We do it together,\nfor all of us: show up every Sunday.\n\n2\n00:00:04,000 --> 00:00:06,000\nCOACH: Every one.\nINTERVIEWER: Why?\n");
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["We do it together, for all of us: show up every Sunday.", "Every one."]);
  // Someone quoting someone isn't a label, and doesn't make the file a labelled one.
  p = TP.parse("1\n00:00:01,000 --> 00:00:03,000\nHe said: you can do it.\n\n2\n00:00:03,000 --> 00:00:05,000\nHe said: keep going.\n");
  assert.deepEqual([p.labelled, TP.only(p.cues, null).length], [false, 2]);
  // In a labelled file, words before a colon that don't look like a label: nobody's (whose they are isn't known).
  p = TP.parse("1\n00:00:01,000 --> 00:00:03,000\nCOACH: Ready.\n\n2\n00:00:03,000 --> 00:00:05,000\nfor all of us: show up.\n\n3\n00:00:05,000 --> 00:00:07,000\nCOACH: Go.\n");
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["Ready.", "Go."]);
  assert.deepEqual([TP.only(p.cues, "").length, p.mixed], [0, 1]);
  // A pause is a gap unless the file names two voices or more: one whose only label is the speaker's may have had its questions cut out.
  p = TP.parse("1\n00:00:01,000 --> 00:00:02,000\nCOACH: I ran it.\n\n2\n00:00:06,000 --> 00:00:08,000\nCOACH: Every Sunday.\n");
  assert.deepEqual([p.voices, TP.pausesFor(p)], [1, true]);
  assert.deepEqual(TP.only(p.cues, "COACH", { pauses: TP.pausesFor(p) }).map((c) => !!c.gap), [false, true]);
  p = TP.parse("1\n00:00:01,000 --> 00:00:02,000\nCOACH: I ran it.\n\n2\n00:00:02,000 --> 00:00:03,000\nINTERVIEWER: When?\n\n3\n00:00:03,000 --> 00:00:04,000\nCOACH: Sundays.\n\n4\n00:00:09,000 --> 00:00:10,000\nCOACH: Every one.\n");
  assert.deepEqual([p.voices, TP.pausesFor(p)], [2, false]);
  const two = [{ s: 0, e: 1000, t: "a" }, { s: 5000, e: 6000, t: "b" }];
  assert.deepEqual(W.transcriptInput({ labelled: true, voices: 2, cues: two }).value.cues.map((c) => !!c.gap), [false, false]);
  assert.deepEqual(W.transcriptInput({ labelled: true, voices: 1, cues: two }).value.cues.map((c) => !!c.gap), [false, true]);
  assert.deepEqual(W.transcriptInput({ labelled: true, cues: two }).value.cues.map((c) => !!c.gap), [false, true], "an older phone sends no count: a pause is a gap");
  assert.deepEqual(W.transcriptInput({ cues: two }).value.cues.map((c) => !!c.gap), [false, true]);
});

test("a line never reaches across a question, a pause or missing words, and starts and ends on whole words", () => {
  const p = TP.parse("1\n00:00:01,000 --> 00:00:04,000\nCOACH: I ran this drill.\n\n2\n00:00:04,000 --> 00:00:05,000\nINTERVIEWER: When?\n\n3\n00:00:05,000 --> 00:00:08,000\nCOACH: Every Sunday since.\n\n4\n00:00:12,000 --> 00:00:14,000\nCOACH: I never [inaudible] quit.\n");
  const mine = TP.only(p.cues, "COACH");
  assert.deepEqual(mine.map((c) => !!c.gap), [false, true, true], "after the question, and after four seconds of nothing");
  assert.deepEqual(TP.find(mine, 1, 2, "I ran this drill. Every Sunday"), { ok: false, why: "across_a_gap" });
  assert.equal(TP.find(mine, 3, 3, "I never quit").why, "missing_words");
  assert.equal(TP.find(mine, 3, 3, "quit").ok, true);
  const cues = [{ n: 1, s: 0, e: 4000, t: "I ran a 4.4 forty, 1,000 times. I can‘t lose. A well-known drill." }];
  for (const q of ["4 forty", "000 times", "I can", "known drill"]) assert.equal(TP.find(cues, 1, 1, q).why, "part_of_a_word", q);
  for (const q of ["a 4.4 forty", "1,000 times", "I can‘t lose", "A well-known drill"]) assert.equal(TP.find(cues, 1, 1, q).ok, true, q);
  // A time's colon, an apostrophe typed as ´ or ′, and a dash in a number join words too.
  const more = [{ n: 1, s: 0, e: 4000, t: "Up at 5:30 every morning. I can´t lose. I can′t quit. From 1990–95 we won." }];
  for (const q of ["30 every morning", "I can", "95 we won"]) assert.equal(TP.find(more, 1, 1, q).why, "part_of_a_word", q);
  // The first match that's whole is the one.
  assert.equal(TP.find([{ n: 1, s: 0, e: 1000, t: "well-known and known" }], 1, 1, "known").ok, true);
  // Said in two of the cues picked: which one isn't clear.
  assert.equal(TP.find([{ n: 1, s: 0, e: 1000, t: "Never quit." }, { n: 2, s: 1000, e: 2000, t: "Never quit, ever." }], 1, 2, "never quit").why, "said_twice");
  // The server keeps the browser's gap marks and finds pauses itself.
  const v = W.transcriptInput({ cues: [{ s: 0, e: 1000, t: "a" }, { s: 1100, e: 2000, t: "b", gap: true }, { s: 6000, e: 7000, t: "c" }, { s: 7100, e: 8000, t: "d" }] }).value;
  assert.deepEqual(v.cues.map((c) => !!c.gap), [false, true, true, false]);
});

test("timecodes round to the nearest frame; a transcript past ten hours says so", () => {
  for (const fps of TP.FPS) {
    for (let f = 0; f < Math.round(fps); f++) {
      const ms = Math.round((61 + f / fps) * 1000);
      assert.equal(TP.tc(ms, { frames: true, fps }), "00:01:01:" + String(f).padStart(2, "0"), `${fps} fps, frame ${f}`);
    }
  }
  assert.equal(TP.tc(61500, { frames: true, fps: 29.97, drop: true }).includes(";"), true);
  // Drop-frame never shows frames 00 and 01 at the start of a minute (but every tenth).
  assert.equal(TP.tc(60000, { frames: true, fps: 29.97, drop: true }), "00:01:00;02");
  assert.equal(TP.tc(600000, { frames: true, fps: 29.97, drop: true }), "00:10:00;00");
  assert.equal(W.transcriptInput({ frames: true, fps: 29.97, drop: true, cues: [{ s: 0, e: 1000, t: "a" }] }).value.df_timecode, true);
  assert.equal(W.transcriptInput({ frames: true, fps: 25, drop: true, cues: [{ s: 0, e: 1000, t: "a" }] }).value.df_timecode, false);
  assert.deepEqual(TP.parse("1\n10:00:01,000 --> 10:00:04,000\nLate words.\n").error, "past_ten_hours");
});

test("agents read names as codes, run together and in handles too; a code is never read as a name", () => {
  const people = [{ name: "Jamie Rivers", person_code: "WJ01", is_minor: true }, { name: "Ty Ng", person_code: "TY1", is_minor: true, reviewer_name: "Ann Ng", reviewer_relation: "parent" }];
  assert.equal(W.maskNames("@jamierivers is up at five", people).includes("jamierivers"), false);
  assert.equal(W.maskNames("#JamieRivers2026", people).includes("Rivers"), false);
  // One word of a minor's name run into a tag or a word.
  for (const t of ["#PrayForJamie", "JamieStrong", "#teamjamie"]) assert.equal(/jamie/i.test(W.maskNames(t, people)), false, t);
  assert.equal(W.maskNames("hopeful", [{ name: "Hope Field", person_code: "HF1", is_minor: true }]), "hopeful", "an everyday word in lower case stays");
  assert.equal(W.maskNames("TyNg runs", people).trim(), "TY1  runs");
  assert.equal(W.maskNames("Ann Ng drove Ty", people), "TY1's parent drove TY1");
});

test("our own words: no promise of reach, no emoji chain, no line written for anyone, no word of a name", () => {
  for (const t of ["more reach with college coaches", "Millions of views", "Recruiters will notice you", "This will get you an offer"]) assert.ok(W.voiceTrouble(t).some((x) => /promises/.test(x)), t);
  for (const t of ["He reaches for the bar", "the views from the hill", "fire 🔥 and ice"]) assert.deepEqual(W.voiceTrouble(t), [], t);
  for (const t of ["🔥.🔥.🔥", "🇺🇸 🇺🇸", "1️⃣2️⃣", "💯-💯"]) assert.ok(W.voiceTrouble(t).includes("no emoji chains"), t);
  for (const t of ["👨‍👩‍👧 one family", "👍🏽 great work"]) assert.deepEqual(W.voiceTrouble(t), [], t);
  for (const t of ["Your offer list starts here.", "Trending on every feed."]) assert.ok(W.voiceTrouble(t).some((x) => /promises/.test(x)), t);
  for (const t of ["He says: I do it for my mom", "A note with ‘it made me better’ inside", "'Never quit on the hill' he said", "«Je ne lâche rien jamais»"]) assert.ok(W.writtenLines(t).length, t);
  for (const t of ["don't stop, it's fine", "the coach's \"why\"", "Look: warm light, slow push"]) assert.deepEqual(W.writtenLines(t), [], t);
  // A word of an adult's name: Claude is refused; a person is asked.
  const tr = { ref: "T1", id: "t1", person_id: "p1", cues: [{ n: 1, s: 0, e: 4000, t: "Darnell taught me everything." }, { n: 2, s: 4000, e: 8000, t: "I do it all for my mom." }] };
  const people = [{ name: "Darnell Price", person_code: "C1", is_minor: false }, { name: "Sam Rowe", person_code: "S1", is_minor: false }];
  const claude = W.checkWords({ lines: [{ transcript: "T1", from_cue: 1, to_cue: 1, quote: "Darnell taught me everything", why: "Marcus at his most honest" }], structures: [] }, { transcripts: [tr], people, byClaude: true });
  assert.ok(claude.issues.some((i) => /darnell/i.test(i.issue)), JSON.stringify(claude.issues));
  const asks = new Set();
  const person = W.checkWords({ lines: [{ transcript: "T1", from_cue: 1, to_cue: 1, quote: "Darnell taught me everything" }], structures: [] }, { transcripts: [tr], people, asks });
  assert.deepEqual([person.issues.filter((i) => i.where !== "structures"), [...asks]], [[], ["darnell"]]);
  const okd = W.checkWords({ lines: [{ transcript: "T1", from_cue: 1, to_cue: 1, quote: "Darnell taught me everything" }], structures: [] }, { transcripts: [tr], people, asks: new Set(), namesOk: new Set(["darnell"]) });
  assert.equal(okd.value.lines.length, 1);
  // A note in our words with an adult's name: refused, whoever writes it.
  assert.ok(W.checkWords({ lines: [{ transcript: "T1", from_cue: 2, to_cue: 2, quote: "I do it all for my mom", why: "Sam Rowe at his best" }], structures: [] }, { transcripts: [tr], people, asks: new Set() }).issues.some((i) => /no names/.test(i.issue)));
  // A caption with a second, made-up quote after the real one; a caption that opens on a promise.
  const cap = (after, line = 2) => W.checkWords({ captions: [{ lead: { transcript: "T1", from_cue: line, to_cue: line, quote: line === 2 ? "I do it all for my mom" : "Darnell taught me everything" }, after }], structures: [] }, { transcripts: [tr], people, asks: new Set(), namesOk: new Set(["darnell"]) }).issues.filter((i) => i.where !== "structures");
  assert.ok(cap("He told us “It made me who I am.”").length);
  // A minor's name run into a hashtag in our words.
  const kidd = [...people, { name: "Jordan Kidd", person_code: "JK1", is_minor: true }];
  assert.ok(W.checkWords({ captions: [{ lead: { transcript: "T1", from_cue: 2, to_cue: 2, quote: "I do it all for my mom" }, after: "#jordanstrong every Sunday" }], structures: [] }, { transcripts: [tr], people: kidd, asks: new Set() }).issues.some((i) => /no names/.test(i.issue)));
  assert.deepEqual(cap("Sundays, every week."), []);
  const promise = { ...tr, cues: [{ n: 1, s: 0, e: 4000, t: "This will get me exposure and followers." }] };
  assert.ok(W.checkWords({ captions: [{ lead: { transcript: "T1", from_cue: 1, to_cue: 1, quote: "This will get me exposure and followers" } }], structures: [] }, { transcripts: [promise], people, asks: new Set() }).issues.some((i) => /promises/.test(i.issue)));
});

test("other voices are nobody's however a file marks them: >>, a name in brackets, odd labels, what follows them", () => {
  const S = (...subs) => subs.map((t, i) => `${i + 1}\n00:00:${String(i * 3).padStart(2, "0")},000 --> 00:00:${String(i * 3 + 3).padStart(2, "0")},000\n${t}\n`).join("\n");
  const voice = (r) => r.cues.map((c) => [c.who === TP.TWO ? "two" : c.who, c.t]);
  // ">>", a broadcast caption's new speaker: with no labels, nobody's throughout.
  let p = TP.parse(S(">> Were you nervous before the game?\n>> No. Never.", ">> I ran it like any other Sunday.", "And I still do."));
  assert.deepEqual([p.labelled, p.voices, p.mixed, TP.only(p.cues, null).length], [false, 0, 4, 0]);
  // In a labelled file, a ">>" subtitle is two voices; ">> COACH:" is a label.
  p = TP.parse(S("COACH: I ran this drill in 2017.", ">> Why that year?\n>> Because nobody filmed it.", "COACH: And I still run it."));
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["I ran this drill in 2017.", "And I still run it."]);
  p = TP.parse(S(">> COACH: I ran this drill in 2017.", ">> INTERVIEWER: Why that year?", ">> COACH: Because nobody filmed it."));
  assert.deepEqual(voice(p), [["COACH", "I ran this drill in 2017."], ["INTERVIEWER", "Why that year?"], ["COACH", "Because nobody filmed it."]]);
  // A speaker named in brackets or parentheses, as SDH subtitles write it; a sound note isn't one.
  p = TP.parse(S("[COACH] I ran this drill in 2017.", "[INTERVIEWER] Why that year?", "[COACH] Because nobody filmed it."));
  assert.deepEqual(voice(p), [["COACH", "I ran this drill in 2017."], ["INTERVIEWER", "Why that year?"], ["COACH", "Because nobody filmed it."]]);
  p = TP.parse(S("COACH: I ran this drill in 2017.", "(INTERVIEWER) Why that year?", "COACH: Because nobody filmed it."));
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["I ran this drill in 2017.", "Because nobody filmed it."]);
  // A note isn't a voice: a sound, how the speaker says it, the language,
  // the editor's own; the voice goes on.
  p = TP.parse(S("[APPLAUSE] Thank you all.", "[MUSIC PLAYING]", "I ran it every Sunday. [laughs]", "[DOOR CLOSES] And that was it.", "(sighs) It was hard.", "[SCOFFS] Yeah, right.", "[SCOFFS] Sure."));
  assert.deepEqual(voice(p), [[null, "Thank you all."], [null, "I ran it every Sunday."], [null, "And that was it."], [null, "It was hard."], [null, "Yeah, right."], [null, "Sure."]]);
  assert.equal(p.labelled, false);
  p = TP.parse(S("[in Spanish] Mi papá corría.", "That was some [bleep] call, man.", "He told [Coach Hooks] he'd be there.", "[laughs nervously] I don't know."));
  assert.deepEqual([p.mixed, TP.only(p.cues, null).length], [0, 4]);
  p = TP.parse(S("COACH: I ran it.", "[whistle blows] Same cones, same field.", "[sighs heavily] My dad made sure.", "INTERVIEWER: Why?", "COACH: [chuckles softly] Every single Sunday."));
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["I ran it.", "Same cones, same field.", "My dad made sure.", "Every single Sunday."]);
  // A label or a name in parentheses mid-line after a sentence's end, italics, a sung line: another voice.
  p = TP.parse(S("COACH: I ran it.", "COACH: Every Sunday. INTERVIEWER: Why Sunday?", "COACH: Every Sunday. (INTERVIEWER) Why that day?", "COACH: Church."));
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["I ran it.", "Every Sunday.", "Every Sunday.", "Church."]);
  p = TP.parse(S("I ran every day.", "<i>Why that year?</i>", "Because nobody filmed it.", "♪ We are the champions ♪", "Again."));
  assert.deepEqual(TP.only(p.cues, null).map((c) => c.t), ["I ran every day.", "Because nobody filmed it.", "Again."]);
  // More voices in brackets, a label written once, italics and lyrics written other ways.
  p = TP.parse(S("COACH: I ran it.", "[male voice] Why that year?", "COACH: Because.", "[woman's voice] Really?", "COACH: Yes.", "[grandma] He was up first.", "COACH: True.", "[off camera] Why?", "COACH: Done."));
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["I ran it.", "Because.", "Yes.", "True.", "Done."]);
  p = TP.parse(S("I ran every day.", "Producer: Why that year?", "{\\i1}Why then?{\\i0}", "<i>Why then?</i> Because nobody filmed it.", "# We are the champions #", "We are the champions ♪", "Listen: you show up."));
  assert.deepEqual(TP.only(p.cues, null).map((c) => c.t), ["I ran every day.", "Because nobody filmed it.", "Listen: you show up."]);
  // A manner note that starts with "voice", and a background note mid-sentence, keep the voice; notes are listed.
  p = TP.parse(S("I ran.", "[voice trembling] He never missed one.", "We did it [crowd cheering] every single one of us.", "[whistle blows] Again."));
  assert.deepEqual(TP.only(p.cues, null).map((c) => c.t), ["I ran.", "He never missed one.", "We did it every single one of us.", "Again."]);
  assert.deepEqual(p.notes, ["voice trembling", "whistle blows"]);
  // Marks in the middle of a line, a voice in lower case or with more in its
  // brackets, a voice named with a word sound notes use, a label with a note
  // after the name: the other voice's words are nobody's, or theirs.
  p = TP.parse(S("COACH: I ran it.", "COACH: Every Sunday. >> Why Sunday?", "COACH: Every Sunday. [INTERVIEWER] Why that day?", "COACH: Church."));
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["I ran it.", "Every Sunday.", "Every Sunday.", "Church."]);
  p = TP.parse(S("I ran it every Sunday.", "[man] Why that year?", "[REFEREE] Foul on number three.", "[crowd chanting] Let's go, Bulldogs!", "[INTERVIEWER, OFF-SCREEN] Why?", "[INTERVIEWER LAUGHING] Really?", "[TV] Breaking news.", "Because nobody filmed it."));
  assert.deepEqual(TP.only(p.cues, null).map((c) => c.t), ["I ran it every Sunday.", "Because nobody filmed it."]);
  p = TP.parse(S("[COACH] I ran it.", "[interviewer] Why that year?", "[COACH] Because nobody filmed it.", "[COACH] And I still run it."));
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["I ran it.", "Because nobody filmed it.", "And I still run it."]);
  p = TP.parse(S("COACH: I ran it.", "INTERVIEWER (O.S.): Why that year?", "COACH (CONT'D): Because nobody filmed it.", "COACH: Yes."));
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["I ran it.", "Because nobody filmed it.", "Yes."]);
  p = TP.parse(S("How many a day?\n- 500 a day.", "And every day after."));
  assert.deepEqual(TP.only(p.cues, null).map((c) => c.t), ["And every day after."]);
  p = TP.parse(S("I ran it every Sunday. >> Why Sunday?"));
  assert.deepEqual([p.voices, TP.only(p.cues, null).length], [0, 0]);
  // Odd labels in a labelled file: nobody's, on a dashed line or a subtitle's
  // first; and so is what follows them with no label, until the next one.
  p = TP.parse(S("DAD: He gets up at five.", "-me and him: we play every day.\n-He says that every day.", "DAD: I never had that at his age."));
  assert.deepEqual([TP.only(p.cues, "").length, TP.only(p.cues, "DAD").length, p.mixed], [0, 2, 2]);
  p = TP.parse(S("INTERVIEWER: What did your dad tell you", "the night before the final: what did he say?", "He said to just play.", "INTERVIEWER: And did you?"));
  assert.deepEqual(voice(p).map((x) => x[0]), ["INTERVIEWER", "two", "two", "INTERVIEWER"]);
  // One voice: a minus before a number, or an em dash carrying a line on, isn't a second voice.
  p = TP.parse(S("I was going to quit—", "—and then my dad showed up.", "It was cold that morning,", "-5 degrees, and we still ran."));
  assert.deepEqual([p.mixed, TP.only(p.cues, null).length], [0, 4]);
  // A dialogue dash in Spanish (an em dash, then a capital or ¿) still is.
  p = TP.parse(S("— ¿Estabas nervioso?\n— Nunca.", "Yo corro aquí."));
  assert.deepEqual(voice(p), [["two", "¿Estabas nervioso?"], ["two", "Nunca."], [null, "Yo corro aquí."]]);
  // "Saturday:" on a wrapped line is words, not a speaker.
  p = TP.parse(S("COACH: The plan for every\nSaturday: run it again.", "INTERVIEWER: Every one?", "COACH: Every one."));
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["The plan for every Saturday: run it again.", "Every one."]);
  // A one-word voice, a voice-over, someone shouting from afar: another voice.
  const asked = (b) => TP.only(TP.parse(S("COACH: I ran it.", `[${b}] Why that year?`, "COACH: Because.")).cues, "COACH").map((c) => c.t);
  for (const b of ["scout", "recruiter", "agent", "officer", "nurse", "pastor", "manager", "neighbor", "voice-over", "voiceover", "distant shouting"]) {
    assert.deepEqual(asked(b), ["I ran it.", "Because."], b);
  }
  // A note naming someone that's about the speaker, a sound people make, a
  // one-word sound or thing, an adverb, the footage: the speaker's words go on.
  for (const b of ["to coach", "on phone with mom", "speaking to a teammate", "imitating his dad", "players warming up", "kids playing in background", "radio static", "gunshot", "explosion", "fireworks", "heartbeat", "phone", "barks", "quietly", "flashback", "shouting", "applause", "laughter"]) {
    assert.deepEqual(asked(b), ["I ran it.", "Why that year?", "Because."], b);
  }
  // A word in italics for stress stays in its line; italics that end a sentence are their own.
  p = TP.parse(S("COACH: I ran it.", "COACH: <i>Never</i> again, I said.", "<i>I</i> did that.", "That's how it was."));
  assert.deepEqual(TP.only(p.cues, "COACH").map((c) => c.t), ["I ran it.", "Never again, I said.", "I did that.", "That's how it was."]);
  // Written once in a file with no labels, a day, a game or a score before a colon is words.
  p = TP.parse(S("I ran this drill in 2017.", "Day One: nobody believed in us.", "Touchdown: that's all I remember.", "Producer: Why that year?", "That was the year."));
  assert.deepEqual(TP.only(p.cues, null).map((c) => c.t), ["I ran this drill in 2017.", "Day One: nobody believed in us.", "Touchdown: that's all I remember.", "That was the year."]);
});

test("a minor's three-letter name run into a tag or camelCase is masked and read; in an ordinary word it's the word", async () => {
  const kai = [{ name: "Kai Moreno", person_code: "WK29", is_minor: true }];
  assert.equal(W.maskNames("We all wore #PrayForKai bands.", kai).includes("WK29"), true);
  assert.equal(W.maskNames("The whole town is KaiStrong now.", kai).includes("WK29"), true);
  assert.equal(W.maskNames("#teamkai on every truck", kai).includes("WK29"), true);
  assert.equal(W.maskNames("The kaiser roll", kai), "The kaiser roll");
  assert.deepEqual(W.runIns("We all wore #PrayForKai bands.", kai), { sure: ["kai"], maybe: [] });
  assert.deepEqual(W.runIns("#teamkai on every truck", kai), { sure: [], maybe: ["kai"] });
  assert.deepEqual(W.runIns("the same drill", [{ name: "Sam Lund", is_minor: true }]), { sure: [], maybe: [] });
  // An everyday name in a lower-case tag is masked too.
  assert.equal(W.maskNames("We all wore #prayforhope bands.", [{ name: "Hope Lee", person_code: "WH29", is_minor: true }]).includes("WH29"), true);
  assert.equal(W.maskNames("hopeful", [{ name: "Hope Lee", person_code: "WH29", is_minor: true }]), "hopeful");
  // In a tag, capitals that mark the name off win over the English word
  // that holds its letters, and a name word left on its own is masked too.
  const ct = [{ name: "Chris Tian Doe", person_code: "WC29", is_minor: true }];
  assert.equal(W.maskNames("#ChrisTian rules", ct), "# WC29 WC29 rules");
  assert.equal(W.maskNames("#christian rules", ct), "#christian rules");
  assert.equal(W.maskNames("Merry Christmas", ct), "Merry Christmas");
  // A long tag of the name over and over is read once.
  const isla = [{ name: "Isla Moon", person_code: "WI29", is_minor: true }];
  const t0 = Date.now();
  for (let k = 0; k < 500; k++) W.maskNames(`#${"isla".repeat(35)} ${k}`, isla);
  assert.ok(Date.now() - t0 < 500, "500 long tags in under half a second");
});

test("every card is read page by page, past the API's cap on one answer", async () => {
  const U = require("../utils/studio-films");
  const rows = Array.from({ length: 2503 }, (_, i) => ({ id: String(i).padStart(6, "0"), name: "P" + i }));
  // A stand-in that answers at most 1,000 rows, whatever the limit asked.
  const sb = { from: () => {
    const q = { after: null, n: 0, select() { return q; }, order() { return q; }, limit(n) { q.n = n; return q; }, gt(_, v) { q.after = v; return q; },
      then(res) { const data = rows.filter((r) => q.after == null || r.id > q.after).slice(0, Math.min(q.n, 1000)); return Promise.resolve({ data, error: null }).then(res); } };
    return q;
  } };
  assert.equal((await U.everyCardRows(sb)).length, 2503);
});
