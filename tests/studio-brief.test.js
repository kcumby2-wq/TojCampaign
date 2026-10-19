// Brief Writer — an idea plus references in, one brief out. Requests are
// checked (sizes, types, links), photos never reach the database, every
// reference must be accounted for, and the model gets the photos as images.
// No database, no network, no API key (the API is faked where needed).
//
//   node --test tests/studio-brief.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const BR = require("../agents/studio-brief/request");
const BT = require("../agents/studio-brief/tools");
const spec = require("../agents/studio-brief/evals/brief-principles");
const BASE = require("../agents/studio/kits/same-work.v1.json");

// A real 1×1 JPEG, base64.
const PIXEL =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

function req(extra = {}) {
  return {
    idea: "I like the grain on these, can we get that look for Same Work?",
    target: { mode: "refresh", slug: "same-work" },
    links: [{ url: "https://www.youtube.com/watch?v=4ikhg-fOfUg", caption: "the grain at 0:40" }],
    images: [
      { media_type: "image/jpeg", data: PIXEL, caption: "this grain" },
      { media_type: "image/jpeg", data: PIXEL, caption: "the dusk one", video: { group: 1, at: 30, duration: 42 } },
      { media_type: "image/jpeg", data: PIXEL, caption: "the dusk one", video: { group: 1, at: 5, duration: 42 } },
    ],
    files: [{ caption: "notes", text: "Grain should be fine, not heavy." }],
    ...extra,
  };
}

// ── Requests ─────────────────────────────────────────────────────────────
test("references are labelled Image / Video / Link / File, video stills in time order", () => {
  const p = BR.parseBriefRequest(req());
  assert.equal(p.ok, true);
  assert.deepEqual(p.refs.map((r) => r.ref), ["Link 1", "Image 1", "Video 1", "File 1"]);
  const v = p.refs.find((r) => r.ref === "Video 1");
  assert.deepEqual(v.stills, [5, 30]);
  // The model gets a label before each picture.
  const kinds = p.attachments.map((a) => a.type);
  assert.deepEqual(kinds, ["text", "image", "text", "image", "text", "image"]);
  assert.match(p.attachments[0].text, /^Image 1 — Kyron's note: "this grain"/);
  assert.match(p.attachments[2].text, /^Video 1, still 1 of 2 at 0:05/);
  assert.equal(p.attachments[1].source.media_type, "image/jpeg");
});

test("the stored task has the idea, notes and links, and no picture data", () => {
  const p = BR.parseBriefRequest(req());
  const task = BR.buildBriefTask(p, "2026-10-19");
  assert.match(task, /What it's for: Refresh the approved kit "same-work"\./);
  assert.match(task, /- Link 1: https:\/\/www\.youtube\.com\/watch\?v=4ikhg-fOfUg: "the grain at 0:40"/);
  assert.match(task, /- Video 1 \(2 stills from a 0:42 video at 0:05, 0:30; attached below; no sound\)/);
  assert.match(task, /<file ref="File 1">\nGrain should be fine, not heavy\.\n<\/file>/);
  assert.ok(!task.includes(PIXEL.slice(0, 40)), "no base64 in the task");
});

test("requests are checked: idea, links, image types, data, sizes, counts", () => {
  assert.equal(BR.parseBriefRequest({ idea: "short" }).error, "missing_idea");
  assert.equal(BR.parseBriefRequest(req({ links: [{ url: "javascript:alert(1)" }] })).error, "invalid_link");
  assert.equal(BR.parseBriefRequest(req({ links: [{ url: "not a link" }] })).error, "invalid_link");
  assert.equal(BR.parseBriefRequest(req({ images: [{ media_type: "image/heic", data: PIXEL }] })).error, "unsupported_image_type");
  assert.equal(BR.parseBriefRequest(req({ images: [{ media_type: "image/png", data: "<script>" }] })).error, "bad_image_data");
  const big = "A".repeat(BR.LIMITS.imageChars);
  const tooMuch = Array.from({ length: 3 }, () => ({ media_type: "image/jpeg", data: big }));
  assert.equal(BR.parseBriefRequest(req({ images: tooMuch })).error, "images_too_large");
  const frames = Array.from({ length: 9 }, (_, i) => ({ media_type: "image/jpeg", data: PIXEL, video: { group: 1, at: i, duration: 9 } }));
  assert.equal(BR.parseBriefRequest(req({ images: frames })).error, "too_many_frames");
  assert.equal(BR.parseBriefRequest(req({ target: { mode: "refresh", slug: "Same Work" } })).error, "invalid_slug");
});

// ── Tools ────────────────────────────────────────────────────────────────
function scopeFor(p) {
  let stage = null;
  const scope = {
    references: p.refs.map(({ ref, kind, caption, url }) => ({ ref, kind, caption, url })),
    listApproved: async () => [{ slug: "same-work", title: BASE.title, version: 1 }],
    approvedKit: async (slug) => (slug === "same-work" ? { slug, version: 1, kit: BASE } : null),
    slugTaken: async (slug) => slug === "same-work",
    onStage: (s) => (stage = s),
  };
  const tools = Object.fromEntries(BT.toolsFor({ scope }).filter((t) => t.run).map((t) => [t.name, (i) => t.run(i || {})]));
  return { tools, stage: () => stage };
}

const GOOD_BRIEF = `Goal: Add a fine film-grain look to Same Work as a proposed option for next season.

Kit: Same Work (refresh)

Do:
1. The look and sound › Vintage looks: three ways to get them: add the grain from Image 1 as a fourth option, marked "(proposed)".
2. Handoffs and checklists › Sources: add Link 1 with today's date.

Leave alone:
- Color: the base look, and every locked rule card.

Done when:
- One card changed and Sources has the new link.`;

function goodSubmit(extra = {}) {
  return {
    mode: "refresh",
    slug: "same-work",
    title: "Add a fine grain look",
    brief: GOOD_BRIEF,
    references: [
      { ref: "Link 1", what_it_shows: "A Resolve grain walkthrough.", take: "The grain settings.", leave: "The LUT pack.", seen: "partly" },
      { ref: "Image 1", what_it_shows: "Fine even grain, lifted blacks.", take: "Grain size.", leave: "", seen: "fully" },
      { ref: "Video 1", what_it_shows: "Dusk field, slow push-in.", take: "The pace.", leave: "", seen: "partly" },
      { ref: "File 1", what_it_shows: "A note: fine grain.", take: "Keep it fine.", leave: "", seen: "fully" },
    ],
    questions: [],
    ...extra,
  };
}

test("kit_outline names every column and card, with the locked rule cards marked", async () => {
  const { tools } = scopeFor(BR.parseBriefRequest(req()));
  const out = JSON.parse(await tools.kit_outline({ slug: "same-work" }));
  assert.equal(out.columns.length, 10);
  assert.ok(out.columns[0].cards.includes("note [locked]: The seven rules nobody breaks"));
  assert.match(await tools.kit_outline({ slug: "nope" }), /^Refused/);
});

test("submit_brief: every reference accounted for, no unknown ones, no banned words, a real kit", async () => {
  const { tools, stage } = scopeFor(BR.parseBriefRequest(req()));
  const missing = await tools.submit_brief(goodSubmit({ references: goodSubmit().references.slice(0, 2) }));
  assert.match(missing, /say what you took from: Video 1, File 1/);
  const unknown = await tools.submit_brief(goodSubmit({ references: [...goodSubmit().references, { ref: "Image 7", what_it_shows: "x", take: "y", seen: "fully" }] }));
  assert.match(unknown, /Image 7.*not one of the references given/);
  const banned = await tools.submit_brief(goodSubmit({ title: "An elite grain look" }));
  assert.match(banned, /banned word\(s\): elite/);
  const noKit = await tools.submit_brief(goodSubmit({ slug: "other-kit" }));
  assert.match(noKit, /no approved kit "other-kit"/);
  const taken = await tools.submit_brief(goodSubmit({ mode: "build", slug: "same-work" }));
  assert.match(taken, /already exists/);
  const short = await tools.submit_brief(goodSubmit({ brief: "Make it grainy." }));
  assert.match(short, /too short/);
  assert.equal(stage().submitted, null);
  assert.match(await tools.submit_brief(goodSubmit()), /^Submitted "Add a fine grain look"/);
  assert.equal(stage().submitted.references.length, 4);
});

// ── What the judge sees ──────────────────────────────────────────────────
function autoFails(output) {
  return spec.auto_fails.filter((r) => r.check_type === "regex" && new RegExp(r.pattern, r.flags || "").test(output)).map((r) => r.id);
}

test("judge view: the idea as given (banned words masked), the references and the brief", async () => {
  const p = BR.parseBriefRequest(req({ idea: "Make our elite look feel like these photos" }));
  const { tools, stage } = scopeFor(p);
  const none = BT.evalView({ output: "Done." }, stage(), { idea: p.idea, references: p.refs }).output;
  assert.deepEqual(autoFails(none), ["no_brief"]);
  await tools.submit_brief(goodSubmit());
  const view = BT.evalView({ output: "Done." }, stage(), { idea: p.idea, references: p.refs }).output;
  assert.match(view, /Idea: Make our \[banned word\] look/);
  assert.match(view, /- Image 1 \(image\): "this grain"/);
  assert.match(view, /## What I took from your references\n- Link 1 \(partly\)/);
  assert.match(view, /\[brief\] submitted$/);
  assert.deepEqual(autoFails(view), []);
});

// ── The engine sends the pictures ────────────────────────────────────────
test("the Brief Writer's first message carries the photos and stills as images", async () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const p = BR.parseBriefRequest(req());
  const calls = [];
  const msg = (content, stop_reason) => ({ id: "m", type: "message", role: "assistant", model: "claude-opus-4-8", content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    let out;
    if (!body.tools) {
      assert.match(body.messages[0].content, /## The submitted brief\n# Add a fine grain look/);
      out = msg([{ type: "text", text: JSON.stringify({ scores: [], total: 10, verdict: "PASS", biggest_miss: "", retry_guidance: "", auto_fail_hits: [] }) }], "end_turn");
    } else if (calls.filter((c) => c.tools).length === 1) {
      const first = body.messages[0].content;
      assert.ok(Array.isArray(first), "content blocks, not a string");
      assert.equal(first[0].type, "text");
      assert.match(first[0].text, /Kyron's idea:\nI like the grain/);
      assert.equal(first.filter((b) => b.type === "image").length, 3);
      assert.equal(first[1].text.startsWith("Image 1"), true);
      out = msg([{ type: "tool_use", id: "toolu_1", name: "submit_brief", input: goodSubmit() }], "tool_use");
    } else {
      out = msg([{ type: "text", text: "The brief asks for one new look card and a source." }], "end_turn");
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const pack = require("../agents/studio-brief/orchestrator");
    let staged = null;
    const scope = {
      idea: p.idea,
      references: p.refs,
      listApproved: async () => [],
      approvedKit: async (slug) => (slug === "same-work" ? { slug, version: 1, kit: BASE } : null),
      slugTaken: async () => false,
      onStage: (s) => (staged = s),
    };
    const result = await pack.runAgent({ role: "brief-writer", task: BR.buildBriefTask(p, "2026-10-19"), attachments: p.attachments, scope });
    assert.equal(result.eval_status, "passed");
    assert.equal(staged.submitted.title, "Add a fine grain look");
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
});
