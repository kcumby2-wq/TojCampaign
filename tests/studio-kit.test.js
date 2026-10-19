// Studio kits — the approved Same Work kit renders exactly as published, the
// checks catch what a Milanote paste or TOJ's rules can't take, the tools
// stage writes and protect locked rule cards, and the judge scores the staged
// kit. No database, no network, no API key (the API is faked where needed).
//
//   node --test tests/studio-kit.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const K = require("../agents/studio/kit");
const R = require("../agents/studio/kit-render");
const T = require("../agents/studio/tools");
const S = require("../agents/studio/service");
const spec = require("../agents/studio/evals/studio-principles");

const BASE = require("../agents/studio/kits/same-work.v1.json");
// sha256 of same-work-milanote-kit.html as published on Oct 19, 2026.
const PUBLISHED_SHA256 = "b49734804eef624b1f11f20a270766ac385cfea231787b80e30322bb309837e8";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function toolsByName(scope) {
  const list = T.toolsFor({ role: "test", scope });
  return Object.fromEntries(list.filter((t) => t.run).map((t) => [t.name, (input) => t.run(input || {})]));
}

function refreshScope(extra = {}) {
  let stage = null;
  const scope = {
    mode: "refresh",
    slug: "same-work",
    assets: "same-work",
    base: { id: "builtin:same-work:v1", version: 1, kit: K.clone(BASE) },
    allow_locked: false,
    onStage: (s) => (stage = s),
    ...extra,
  };
  return { scope, stage: () => stage };
}

// ── The approved kit ────────────────────────────────────────────────────
test("the approved kit renders byte-for-byte as the page published on Oct 19", () => {
  const html = R.renderFragment(BASE);
  assert.equal(sha(html), PUBLISHED_SHA256);
});

test("the approved kit passes every check: 10 columns, 66 cards, 8 images, 6 locked rule cards", () => {
  const r = K.checkKit(BASE);
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
  assert.deepEqual(r.counts, { columns: 10, cards: 66, images: 8, locked: 6 });
  const locked = BASE.columns.flatMap((c) => c.cards.filter((k) => k.locked).map((k) => k.title));
  assert.ok(locked.includes("The seven rules nobody breaks"));
  assert.ok(locked.includes("Not approved for Same Work footage"));
});

test("the served page keeps the same body and only adds the status bar and a script nonce", () => {
  const doc = R.renderDocument(BASE, { banner: "Approved v1", nonce: "n0nce" });
  assert.match(doc, /^<!doctype html>/);
  assert.ok(doc.includes('<script nonce="n0nce">'));
  assert.equal((doc.match(/<script/g) || []).length, 1);
  assert.ok(doc.includes('class="kit-status"'));
  assert.equal((doc.match(/<article class="card/g) || []).length, 66);
});

test("plain-text copy matches the published page's numbered lists and links", () => {
  const rules = BASE.columns[0].cards.find((k) => k.title === "The seven rules nobody breaks");
  const plain = R.cardPlain(rules);
  assert.match(plain, /^The seven rules nobody breaks\n\n1\. Real words only\./);
  assert.match(plain, /\n7\. Nothing publishes without the producer's approval,/);
  const made = BASE.columns[1].cards.find((k) => k.title === "MADE Athletes");
  assert.match(R.cardPlain(made), /madeathletes\.com \(https:\/\/madeathletes\.com\/\)/);
});

// ── Card checks ──────────────────────────────────────────────────────────
test("checkCard: banned words and phrases are blockers; Adobe Premiere Pro is fine", () => {
  const bad = K.checkCard({ type: "note", title: "Gear", body: "<p>An elite camera for next-level footage.</p>" });
  assert.ok(bad.issues.some((i) => i.level === "blocker" && /elite, next-level/.test(i.issue)));
  const promise = K.checkCard({ type: "note", title: "Promise", body: "<p>Guaranteed placement for every athlete.</p>" });
  assert.ok(promise.issues.some((i) => /banned phrase/.test(i.issue)));
  const ok = K.checkCard({ type: "note", title: "Software", body: "<p>Adobe Premiere Pro and DaVinci Resolve. Premiere's captions are fine.</p>" });
  assert.deepEqual(ok.issues.filter((i) => i.level === "blocker"), []);
});

test("checkCard: only Milanote-safe HTML, https links, known template images", () => {
  const script = K.checkCard({ type: "note", title: "x", body: "<p>hi</p><script>alert(1)</script>" });
  assert.ok(script.issues.some((i) => /<script> is not allowed/.test(i.issue)));
  const style = K.checkCard({ type: "note", title: "x", body: '<p style="color:red">hi</p>' });
  assert.ok(style.issues.some((i) => /may not carry attributes/.test(i.issue)));
  const onclick = K.checkCard({ type: "note", title: "x", body: '<p><a href="https://a.com" onclick="x()">a</a></p>' });
  assert.ok(onclick.issues.some((i) => /links must be exactly/.test(i.issue)));
  const http = K.checkCard({ type: "link", title: "x", url: "http://example.com", body: "<p>notes</p>" });
  assert.ok(http.issues.some((i) => /https/.test(i.issue)));
  const img = K.checkCard({ type: "image", title: "x", img: "09-new-design", body: "<p>notes</p>" }, { assets: "same-work" });
  assert.ok(img.issues.some((i) => /img must be one of the templates/.test(i.issue)));
  const goodImg = K.checkCard({ type: "image", title: "x", img: "07-end-card", body: "<p>notes</p>" }, { assets: "same-work" });
  assert.deepEqual(goodImg.issues.filter((i) => i.level === "blocker"), []);
});

test("checkKit: a kit needs a Sources card", () => {
  const kit = K.clone(BASE);
  const last = kit.columns[kit.columns.length - 1];
  last.cards = last.cards.filter((k) => k.title !== "Sources");
  const r = K.checkKit(kit);
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => /no "Sources" card/.test(b.issue)));
});

// ── Refresh tools ────────────────────────────────────────────────────────
test("refresh: starts as an exact copy; a locked rule card can't be changed or removed", async () => {
  const { scope, stage } = refreshScope();
  const t = toolsByName(scope);
  assert.deepEqual(stage().kit.columns, BASE.columns);
  const rules = BASE.columns[0].cards.find((k) => k.title === "The seven rules nobody breaks");
  const edit = await t.kit_put_card({
    column: "Start here",
    card: { ...rules, body: "<p>Rules are suggestions.</p>" },
    reason: "Brief asked to shorten the rules",
  });
  assert.match(edit, /^Refused: "The seven rules nobody breaks" is a locked rule card/);
  const rm = await t.kit_remove_card({ column: "Start here", title: "Who owns what", reason: "Brief asked to tidy column 1" });
  assert.match(rm, /locked rule card/);
  assert.equal(K.diffKits(BASE, stage().kit).unchanged, true);
});

test("refresh: rule changes allowed only for that run, and the card stays locked", async () => {
  const { scope, stage } = refreshScope({ allow_locked: true });
  const t = toolsByName(scope);
  const rules = BASE.columns[0].cards.find((k) => k.title === "The seven rules nobody breaks");
  const body = rules.body.replace("within 72 hours", "within 48 hours");
  const out = await t.kit_put_card({ column: "Start here", card: { type: "note", title: rules.title, body }, reason: "Agreement amendment, Section 9 (Kyron, brief)" });
  assert.match(out, /^Replaced/);
  const now = K.findCard(stage().kit, "Start here", rules.title);
  assert.equal(now.locked, true);
});

test("refresh: every change needs a reason; one card changed leaves 65 untouched", async () => {
  const { scope, stage } = refreshScope();
  const t = toolsByName(scope);
  const cams = BASE.columns[5].cards.find((k) => k.title === "Cameras");
  const card = { type: "note", title: "Cameras", body: cams.body.replace("RED Komodo 6K", "RED Komodo 6K and Komodo-X") };
  assert.match(await t.kit_put_card({ column: "Gear", card }), /say why/);
  assert.match(await t.kit_put_card({ column: "Gear", card, reason: "Lensrentals list re-checked 2026-11-01" }), /^Replaced "Cameras"/);
  const d = K.diffKits(BASE, stage().kit);
  assert.deepEqual(d.totals, { added: 0, removed: 0, changed: 1, same: 65, moved: 0 });
  assert.equal(stage().ops.length, 1);
  assert.equal(stage().ops[0].reason, "Lensrentals list re-checked 2026-11-01");
  // The order of the other cards and columns is untouched.
  assert.deepEqual(stage().kit.columns.map((c) => c.name), BASE.columns.map((c) => c.name));
  assert.deepEqual(stage().kit.columns[5].cards.map((k) => k.title), BASE.columns[5].cards.map((k) => k.title));
  const check = JSON.parse(await t.kit_check());
  assert.equal(check.ok, true);
  assert.equal(check.changes.totals.changed, 1);
});

test("refresh: writes with banned words or bad HTML are refused and nothing changes", async () => {
  const { scope, stage } = refreshScope();
  const t = toolsByName(scope);
  const out = await t.kit_put_card({ column: "Gear", card: { type: "note", title: "Cameras", body: "<p>A game-changing body.</p>" }, reason: "re-check 2026-11-01" });
  assert.match(out, /^Refused: nothing was written/);
  assert.match(out, /game-changing/);
  const out2 = await t.kit_put_card({ column: "Gear", card: { type: "note", title: "New", body: "<div>x</div>" }, reason: "re-check 2026-11-01" });
  assert.match(out2, /<div> is not allowed/);
  assert.equal(K.diffKits(BASE, stage().kit).unchanged, true);
  assert.match(await t.kit_put_column({ name: "Gear", color: "Green", lead: "x", cards: [{ type: "note", title: "a", body: "<p>b</p>" }], reason: "re-check 2026-11-01" }), /already exists/);
});

// ── Build tools ──────────────────────────────────────────────────────────
test("build: whole columns at a time; kit_check flags the missing Sources card until it's there", async () => {
  let stage = null;
  const t = toolsByName({ mode: "build", slug: "test-kit", assets: null, onStage: (s) => (stage = s) });
  assert.match(await t.kit_set_meta({ title: "Test Kit", eyebrow: "Test · playbook", lead_html: "Two sentences.", board_name: "Test: Playbook", stats_label: "Built Nov 1, 2026", footer_html: "Built from <i>Test</i>." }), /^Set /);
  const col = { name: "Start here", color: "Red", lead: "The rules.", cards: [{ type: "note", title: "Rules", body: "<ol><li>Real words only.</li></ol>", locked: true }] };
  assert.match(await t.kit_put_column(col), /^Added column "Start here"/);
  let check = JSON.parse(await t.kit_check());
  assert.equal(check.ok, false);
  assert.ok(check.blockers.some((b) => /Sources/.test(b.issue)));
  assert.match(await t.kit_put_column({ name: "Handoffs", color: "Grey", lead: "Last.", cards: [{ type: "note", title: "Sources", body: "<p>None yet.</p>" }] }), /^Added/);
  check = JSON.parse(await t.kit_check());
  assert.equal(check.ok, true, JSON.stringify(check.blockers));
  // No template set: image cards are refused with a pointer to describe the image instead.
  const img = await t.kit_put_card({ column: "Handoffs", card: { type: "image", title: "Title card", img: "03-title-card", body: "<p>x</p>" } });
  assert.match(img, /no template images/);
  assert.equal(stage.kit.columns.length, 2);
  assert.equal(R.renderFragment(stage.kit).includes("Test Kit"), true);
});

test("build: a column with one bad card is refused whole", async () => {
  const t = toolsByName({ mode: "build", slug: "test-kit", assets: "same-work", onStage() {} });
  const out = await t.kit_put_column({
    name: "Gear",
    color: "Green",
    lead: "What we shoot on.",
    cards: [
      { type: "note", title: "Cameras", body: "<p>Sony FX6.</p>" },
      { type: "link", title: "List", url: "ftp://x", body: "<p>notes</p>" },
    ],
  });
  assert.match(out, /^Refused: nothing was written/);
  assert.match(await t.kit_overview(), /"columns": \[\]/);
});

// ── What the judge sees ──────────────────────────────────────────────────
function autoFails(output) {
  return spec.auto_fails
    .filter((r) => r.check_type === "regex")
    .filter((r) => new RegExp(r.pattern, r.flags || "").test(output))
    .map((r) => r.id);
}

test("judge view (refresh): the change, the locked cards' state, the reasons, the kit check", async () => {
  const { scope, stage } = refreshScope();
  const t = toolsByName(scope);
  const cams = BASE.columns[5].cards.find((k) => k.title === "Cameras");
  await t.kit_put_card({ column: "Gear", card: { ...cams, body: cams.body + "<p>Checked Nov 1, 2026.</p>" }, reason: "Lensrentals re-check 2026-11-01" });
  const view = T.evalView({ output: "Changed Cameras." }, stage()).output;
  assert.match(view, /### CHANGED: Cameras/);
  assert.match(view, /Totals: 1 changed, 0 added, 0 removed, 65 untouched/);
  assert.match(view, /Start here \/ The seven rules nobody breaks: unchanged/);
  assert.match(view, /Lensrentals re-check 2026-11-01/);
  assert.match(view, /\[kit-check\] blockers=0$/);
  assert.deepEqual(autoFails(view), []);
});

test("judge view (build): the whole kit; banned words in the source are masked; Premiere doesn't trip it", () => {
  const stage = { mode: "build", kit: K.clone(BASE), ops: [] };
  const view = T.evalView({ output: "Built the kit." }, stage, { sourceExcerpt: "Our elite crew. Guaranteed placement!" }).output;
  assert.match(view, /Adobe Premiere Pro/);
  assert.match(view, /Our \[banned word\] crew\. \[banned phrase\]!/);
  assert.deepEqual(autoFails(view), []);
  const bad = T.evalView({ output: "Built an elite kit." }, stage).output;
  assert.deepEqual(autoFails(bad), ["banned_vocabulary"]);
  const blocked = T.evalView({ output: "x" }, { mode: "build", kit: K.emptyKit("x"), ops: [] }).output;
  assert.deepEqual(autoFails(blocked), ["kit_check_blockers"]);
});

// ── Service helpers ──────────────────────────────────────────────────────
test("template images: only listed files, no traversal; signatures verify", () => {
  process.env.STUDIO_ASSET_SECRET = "test-secret";
  assert.ok(S.assetPath("same-work", "07-end-card.jpg"));
  assert.equal(S.assetPath("same-work", "../../server.js"), null);
  assert.equal(S.assetPath("same-work", "templates.json"), null);
  assert.equal(S.assetPath("..", "07-end-card.jpg"), null);
  const sig = S.signAsset("same-work", "07-end-card.jpg");
  assert.equal(S.verifyAsset("same-work", "07-end-card.jpg", sig), true);
  assert.equal(S.verifyAsset("same-work", "08-looks-board.jpg", sig), false);
  assert.equal(S.verifyAsset("same-work", "07-end-card.jpg", "nope"), false);
  const src = S.imgSrcFor(BASE)("07-end-card");
  assert.equal(src, `/api/studio-agents/assets/same-work/07-end-card.jpg?sig=${sig}`);
});

test("the run task says the mode, the base version, the templates and whether rules may change", () => {
  const task = S.buildTask({
    mode: "refresh",
    slug: "same-work",
    brief: "Re-check the gear.",
    base: { id: "builtin:same-work:v1", version: 1 },
    assets: "same-work",
    allowLocked: false,
    today: "2026-11-01",
  });
  assert.match(task, /REFRESH the approved kit "same-work" \(version 1, builtin:same-work:v1\)/);
  assert.match(task, /Template images: same-work \(8 templates/);
  assert.match(task, /Rule changes allowed: no/);
  assert.ok(!task.includes("<source>"));
});

// ── The engine: pause_turn continues, and the judge scores the staged kit ──
test("factory: a paused web-search turn is continued, and the judge reads the staged changes", async () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const calls = [];
  const msg = (content, stop_reason) => ({
    id: `msg_${calls.length}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
  const cams = BASE.columns[5].cards.find((k) => k.title === "Cameras");
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    let out;
    if (!body.tools) {
      // The judge (utils/evaluator.js).
      const prompt = body.messages[0].content;
      assert.match(prompt, /What changed against the approved kit \(v1\)/);
      assert.match(prompt, /### CHANGED: Cameras/);
      assert.match(prompt, /\[kit-check\] blockers=0/);
      out = msg([{ type: "text", text: JSON.stringify({ scores: [], total: 12, verdict: "PASS", biggest_miss: "", retry_guidance: "", auto_fail_hits: [] }) }], "end_turn");
    } else if (calls.filter((c) => c.body.tools).length === 1) {
      assert.ok(body.tools.some((t) => t.type === "web_search_20250305"));
      assert.equal(body.max_tokens, 12000);
      out = msg([{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "netflix approved cameras 2026" } }], "pause_turn");
    } else if (calls.filter((c) => c.body.tools).length === 2) {
      const last = body.messages[body.messages.length - 1];
      assert.equal(last.role, "assistant", "the paused turn is sent back to continue");
      assert.equal(last.content[0].type, "server_tool_use");
      out = msg(
        [{ type: "tool_use", id: "toolu_1", name: "kit_put_card", input: { column: "Gear", card: { ...cams, body: cams.body + "<p>Checked Nov 1, 2026.</p>" }, reason: "Netflix list re-checked 2026-11-01" } }],
        "tool_use"
      );
    } else {
      const last = body.messages[body.messages.length - 1];
      assert.equal(last.content[0].type, "tool_result");
      assert.match(String(last.content[0].content), /^Replaced "Cameras"/);
      out = msg([{ type: "text", text: "Changed one card: Cameras (re-checked Nov 1). Nothing else moved." }], "end_turn");
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
  };
  try {
    const studio = require("../agents/studio/orchestrator");
    const { scope, stage } = refreshScope();
    const result = await studio.runAgent({ role: "kit-refresher", task: "Re-check the gear.", scope });
    assert.equal(result.eval_status, "passed");
    assert.match(result.output, /^Changed one card: Cameras/);
    assert.ok(result.trace.some((t) => t.name === "web_search" && t.server), "server tool call is in the trace");
    assert.equal(stage().ops.length, 1);
    assert.equal(K.diffKits(BASE, stage().kit).totals.changed, 1);
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
});
