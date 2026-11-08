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
  assert.deepEqual(TP.parse("1\n10:00:01,000 --> 10:00:04,000\nLate words.\n").error, "past_ten_hours");
});

test("agents read names as codes, run together and in handles too; a code is never read as a name", () => {
  const people = [{ name: "Jamie Rivers", person_code: "WJ01", is_minor: true }, { name: "Ty Ng", person_code: "TY1", is_minor: true, reviewer_name: "Ann Ng", reviewer_relation: "parent" }];
  assert.equal(W.maskNames("@jamierivers is up at five", people).includes("jamierivers"), false);
  assert.equal(W.maskNames("#JamieRivers2026", people).includes("Rivers"), false);
  assert.equal(W.maskNames("TyNg runs", people).trim(), "TY1  runs");
  assert.equal(W.maskNames("Ann Ng drove Ty", people), "TY1's parent drove TY1");
});

test("our own words: no promise of reach, no emoji chain, no line written for anyone, no word of a name", () => {
  for (const t of ["more reach with college coaches", "Millions of views", "Recruiters will notice you", "This will get you an offer"]) assert.ok(W.voiceTrouble(t).some((x) => /promises/.test(x)), t);
  for (const t of ["He reaches for the bar", "the views from the hill", "fire 🔥 and ice"]) assert.deepEqual(W.voiceTrouble(t), [], t);
  for (const t of ["🔥.🔥.🔥", "🇺🇸 🇺🇸", "1️⃣2️⃣"]) assert.ok(W.voiceTrouble(t).includes("no emoji chains"), t);
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
  assert.deepEqual(cap("Sundays, every week."), []);
  const promise = { ...tr, cues: [{ n: 1, s: 0, e: 4000, t: "This will get me exposure and followers." }] };
  assert.ok(W.checkWords({ captions: [{ lead: { transcript: "T1", from_cue: 1, to_cue: 1, quote: "This will get me exposure and followers" } }], structures: [] }, { transcripts: [promise], people, asks: new Set() }).issues.some((i) => /promises/.test(i.issue)));
});
