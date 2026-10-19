// Studio route — a run saves a NEW draft and never touches the approved kit;
// only a staff session approves; an API key can't approve or unlock rules;
// the kit page and template images are guarded. In-memory database fake,
// faked agent (the real tools, no model).
//
//   node --test tests/studio-route.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");

process.env.ADMIN_EMAILS = "staff@example.com";
process.env.STUDIO_API_KEY = "studio-key-123";
process.env.STUDIO_ASSET_SECRET = "asset-secret";

const K = require("../agents/studio/kit");
const studio = require("../agents/studio/orchestrator");
const router = require("../routes/studio-agents");
const BASE = require("../agents/studio/kits/same-work.v1.json");

// ── A small Supabase-shaped fake ─────────────────────────────────────────
function fakeDb() {
  const tables = { agent_runs: [], eval_runs: [], studio_kits: [] };
  class Q {
    constructor(table) {
      this.t = table;
      this.op = "select";
      this.filters = [];
      this.mode = "many";
      this.returning = false;
    }
    select() {
      if (this.op === "insert" || this.op === "update") this.returning = true;
      return this;
    }
    insert(rows) {
      this.op = "insert";
      this.rows = Array.isArray(rows) ? rows : [rows];
      return this;
    }
    update(patch) {
      this.op = "update";
      this.patch = patch;
      return this;
    }
    eq(c, v) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    in(c, vs) {
      this.filters.push((r) => vs.includes(r[c]));
      return this;
    }
    order(c, { ascending = true } = {}) {
      this.ord = [c, ascending];
      return this;
    }
    limit(n) {
      this.lim = n;
      return this;
    }
    single() {
      this.mode = "single";
      return this;
    }
    maybeSingle() {
      this.mode = "maybe";
      return this;
    }
    exec() {
      const rows = tables[this.t];
      if (this.op === "insert") {
        const made = [];
        for (const r of this.rows) {
          if (this.t === "studio_kits" && rows.some((x) => x.slug === r.slug && x.version === r.version)) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          made.push(row);
        }
        return this.finish(made);
      }
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        out.forEach((r) => Object.assign(r, this.patch));
        return this.returning ? this.finish(out) : { data: null, error: null };
      }
      if (this.ord) {
        const [c, asc] = this.ord;
        out = [...out].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (this.lim) out = out.slice(0, this.lim);
      return this.finish(out);
    }
    finish(out) {
      const copy = JSON.parse(JSON.stringify(out));
      if (this.mode === "single") return copy.length === 1 ? { data: copy[0], error: null } : { data: null, error: { message: "not one row" } };
      if (this.mode === "maybe") return { data: copy[0] || null, error: null };
      return { data: copy, error: null };
    }
    then(res, rej) {
      return Promise.resolve(this.exec()).then(res, rej);
    }
  }
  return {
    tables,
    from: (t) => new Q(t),
    rpc: async (fn, { p_id, p_by }) => {
      assert.equal(fn, "studio_kit_approve");
      const row = tables.studio_kits.find((r) => r.id === p_id);
      if (!row || row.status !== "draft") return { data: null, error: { message: "studio_kit_not_draft" } };
      tables.studio_kits.filter((r) => r.slug === row.slug && r.status === "approved").forEach((r) => (r.status = "superseded"));
      Object.assign(row, { status: "approved", approved_by: p_by, approved_at: new Date().toISOString() });
      return { data: p_id, error: null };
    },
  };
}

// The agent stand-in: the real per-run tools, driven by a script.
let script = async () => ({ output: "No changes needed." });
async function fakeRun({ role, task, scope }) {
  const tools = Object.fromEntries(studio.toolsForRun(role, { scope }).filter((t) => t.run).map((t) => [t.name, (i) => t.run(i || {})]));
  const out = await script(tools, { role, task, scope });
  return { output: out.output, eval_status: out.eval_status || "passed", retry_count: 0, trace: [], usage: {}, eval_history: [] };
}

let server;
let base;
let db;
before(async () => {
  db = fakeDb();
  router._setDeps({ sb: db, run: fakeRun });
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  // Session stand-in: the x-test-user header signs a user in.
  app.use((req, _res, next) => {
    const u = req.headers["x-test-user"];
    req.session = u ? { userEmail: u, userRole: "staff" } : {};
    next();
  });
  app.use("/api/studio-agents", router);
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api/studio-agents`;
});
after(() => server && server.close());

const STAFF = { "x-test-user": "staff@example.com" };
const KEY = { "x-studio-api-key": "studio-key-123" };
async function call(path, { method = "GET", headers = {}, body } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
async function waitForRun(id, headers = STAFF) {
  for (let i = 0; i < 100; i++) {
    const r = await call(`/runs/${id}`, { headers });
    if (r.json && r.json.status !== "running") return r.json;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("run never finished");
}

test("kits and pages need staff (or the key); strangers get nothing", async () => {
  assert.equal((await call("/kits")).status, 401);
  assert.equal((await call("/kits", { headers: { "x-test-user": "stranger@example.com" } })).status, 403);
  const list = await call("/kits", { headers: STAFF });
  assert.equal(list.status, 200);
  const v1 = list.json.kits.find((k) => k.id === "builtin:same-work:v1");
  assert.equal(v1.status, "approved");
  assert.equal((await call("/kits", { headers: KEY })).status, 200);
  assert.equal((await call("/kits/builtin:same-work:v1/page")).status, 401);
});

test("the kit page: status bar, nonce'd script under a strict CSP, signed image URLs", async () => {
  const r = await call("/kits/builtin:same-work:v1/page", { headers: STAFF });
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.ok(r.text.includes(`<script nonce="${nonce}">`));
  assert.match(r.text, /Approved v1 · the kit as built and approved on Oct 19, 2026/);
  assert.equal((r.text.match(/<article class="card/g) || []).length, 66);
  const img = r.text.match(/src='(\/api\/studio-agents\/assets\/same-work\/07-end-card\.jpg\?sig=[0-9a-f]+)'/)[1];
  // A signed URL loads without a login (so Milanote can fetch a dragged image)…
  const ok = await fetch(`http://127.0.0.1:${server.address().port}${img}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  // …an unsigned or wrongly signed one doesn't.
  assert.equal((await call("/assets/same-work/07-end-card.jpg")).status, 403);
  assert.equal((await call("/assets/same-work/07-end-card.jpg?sig=00000000000000000000000000000000")).status, 403);
  assert.equal((await call("/assets/same-work/07-end-card.jpg", { headers: STAFF })).status, 200);
  assert.equal((await call("/assets/same-work/..%2F..%2Fkit.js", { headers: STAFF })).status, 404);
});

test("run input is checked before anything starts", async () => {
  assert.equal((await call("/run", { method: "POST", headers: STAFF, body: { role: "nope" } })).json.error, "invalid_role");
  assert.equal((await call("/run", { method: "POST", headers: STAFF, body: { role: "kit-refresher", slug: "same-work", brief: "x" } })).json.error, "missing_brief");
  assert.equal((await call("/run", { method: "POST", headers: STAFF, body: { role: "kit-refresher", slug: "Same Work", brief: "Re-check the gear." } })).json.error, "invalid_slug");
  const exists = await call("/run", { method: "POST", headers: STAFF, body: { role: "kit-builder", slug: "same-work", brief: "Build it again please.", source_text: "x".repeat(300) } });
  assert.equal(exists.status, 409);
  assert.equal(exists.json.error, "slug_exists");
  const noSource = await call("/run", { method: "POST", headers: STAFF, body: { role: "kit-builder", slug: "new-kit", brief: "Build a new kit." } });
  assert.equal(noSource.json.error, "source_required");
  const unlock = await call("/run", { method: "POST", headers: KEY, body: { role: "kit-refresher", slug: "same-work", brief: "Change the rules.", allow_rule_changes: true } });
  assert.equal(unlock.status, 403);
  assert.equal(unlock.json.error, "rule_changes_need_a_person");
  assert.equal(db.tables.agent_runs.length, 0);
});

test("a refresh that changes nothing saves no draft", async () => {
  script = async (t) => {
    await t.kit_overview();
    return { output: "Checked the gear. Nothing moved." };
  };
  const start = await call("/run", { method: "POST", headers: KEY, body: { role: "kit-refresher", slug: "same-work", brief: "Re-check the gear and sources." } });
  assert.equal(start.status, 200);
  const done = await waitForRun(start.json.run_id, KEY);
  assert.equal(done.status, "completed");
  assert.match(done.output, /No changes were needed, so no new draft was saved/);
  assert.equal(done.kit, null);
  assert.equal(db.tables.studio_kits.length, 0);
});

let draftId;
test("a refresh saves draft v2; the approved v1 is untouched; a locked card stays locked", async () => {
  const cams = BASE.columns[5].cards.find((k) => k.title === "Cameras");
  script = async (t) => {
    const locked = await t.kit_put_card({ column: "Start here", card: { type: "note", title: "Who owns what", body: "<p>Everyone owns everything.</p>" }, reason: "brief asked to simplify" });
    assert.match(locked, /locked rule card/);
    await t.kit_put_card({ column: "Gear", card: { ...cams, body: cams.body + "<p>Re-checked Nov 1, 2026.</p>" }, reason: "Lensrentals list re-checked 2026-11-01" });
    return { output: "Changed Cameras (re-checked Nov 1). Suggest no rule changes." };
  };
  const start = await call("/run", { method: "POST", headers: STAFF, body: { role: "kit-refresher", slug: "same-work", brief: "Re-check the gear and sources." } });
  const done = await waitForRun(start.json.run_id);
  assert.equal(done.status, "completed");
  assert.equal(done.kit.version, 2);
  assert.equal(done.kit.status, "draft");
  draftId = done.kit.id;

  const row = db.tables.studio_kits.find((r) => r.id === draftId);
  assert.equal(row.base_kit_id, "builtin:same-work:v1");
  assert.equal(row.kit.version, 2);
  assert.equal(row.changes.length, 1);
  assert.equal(row.created_by, "staff@example.com");
  // The repo baseline is exactly as it was.
  assert.equal(JSON.stringify(require("../agents/studio/kits/same-work.v1.json")), JSON.stringify(BASE));

  const kit = await call(`/kits/${draftId}`, { headers: STAFF });
  assert.equal(kit.json.diff.totals.changed, 1);
  assert.deepEqual(kit.json.diff.columns.filter((c) => c.status !== "same").map((c) => c.name), ["Gear"]);
  assert.equal(kit.json.check.ok, true);

  const page = await call(`/kits/${draftId}/page`, { headers: STAFF });
  assert.match(page.text, /Draft v2 · not approved yet · checks: passed/);
  assert.match(page.text, /Re-checked Nov 1, 2026\./);
});

test("only a staff session approves; approving retires v1 and the next refresh starts from v2", async () => {
  assert.equal((await call(`/kits/${draftId}/approve`, { method: "POST", headers: KEY })).status, 401);
  assert.equal((await call("/kits/builtin:same-work:v1/approve", { method: "POST", headers: STAFF })).status, 400);
  const ok = await call(`/kits/${draftId}/approve`, { method: "POST", headers: STAFF });
  assert.equal(ok.status, 200);
  assert.equal((await call(`/kits/${draftId}/approve`, { method: "POST", headers: STAFF })).status, 409);

  const list = (await call("/kits", { headers: STAFF })).json.kits;
  assert.equal(list.find((k) => k.id === draftId).status, "approved");
  assert.equal(list.find((k) => k.id === "builtin:same-work:v1").status, "superseded");

  let seenBase = null;
  script = async (t, { scope }) => {
    seenBase = scope.base;
    return { output: "Nothing to change." };
  };
  const start = await call("/run", { method: "POST", headers: STAFF, body: { role: "kit-refresher", slug: "same-work", brief: "Re-check the gear and sources." } });
  await waitForRun(start.json.run_id);
  assert.equal(seenBase.id, draftId);
  assert.equal(seenBase.version, 2);
});

test("a draft with blockers can't be approved; a draft that failed the judge is saved and marked", async () => {
  script = async (t) => {
    await t.kit_put_card({ column: "Gear", card: { type: "note", title: "Drones", body: "<p>DJI Mini 4 Pro, under 250 g.</p>" }, reason: "brief asked for a drone card" });
    return { output: "Added a drone card.", eval_status: "failed_after_retries" };
  };
  const start = await call("/run", { method: "POST", headers: STAFF, body: { role: "kit-refresher", slug: "same-work", brief: "Add a drone card to Gear." } });
  const done = await waitForRun(start.json.run_id);
  assert.equal(done.status, "waiting");
  assert.equal(done.kit.version, 3);
  const page = await call(`/kits/${done.kit.id}/page`, { headers: STAFF });
  assert.match(page.text, /FAILED the agent checks, review closely/);

  // Simulate a stored draft that somehow carries a blocker: approval refuses it.
  const row = db.tables.studio_kits.find((r) => r.id === done.kit.id);
  row.kit.columns[5].cards[0].body = "<p>An elite camera.</p>";
  const refused = await call(`/kits/${done.kit.id}/approve`, { method: "POST", headers: STAFF });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, "fix_blockers_first");
  const discard = await call(`/kits/${done.kit.id}/discard`, { method: "POST", headers: STAFF });
  assert.equal(discard.json.status, "discarded");
});

test("a build makes v1 of a new slug from the source", async () => {
  script = async (t, { task }) => {
    assert.match(task, /<source>\n# Night Shift playbook/);
    await t.kit_set_meta({ title: "Night Shift Kit", eyebrow: "Night Shift · playbook", lead_html: "The playbook as cards.", board_name: "Night Shift: Playbook", stats_label: "Built Nov 1, 2026", footer_html: "Built from the Night Shift playbook." });
    await t.kit_put_column({ name: "Start here", color: "Red", lead: "The rules.", cards: [{ type: "note", title: "Rules", body: "<p>Real words only.</p>", locked: true }] });
    await t.kit_put_column({ name: "Handoffs", color: "Grey", lead: "Last.", cards: [{ type: "note", title: "Sources", body: "<p>The playbook.</p>" }] });
    return { output: "Built 2 columns, 2 cards." };
  };
  const source = "# Night Shift playbook\n" + "Rule: real words only.\n".repeat(20);
  const start = await call("/run", { method: "POST", headers: STAFF, body: { role: "kit-builder", slug: "night-shift", brief: "Build a kit from this playbook.", source_text: source } });
  assert.equal(start.status, 200);
  const done = await waitForRun(start.json.run_id);
  assert.equal(done.kit.version, 1);
  assert.equal(done.kit.slug, "night-shift");
  const kit = (await call(`/kits/${done.kit.id}`, { headers: STAFF })).json;
  assert.equal(kit.check.ok, true);
  assert.equal(kit.kit.assets, null);
  assert.equal(K.checkKit(kit.kit).counts.cards, 2);
});

test("a draft made from an older approved version can't be approved", async () => {
  const cams = BASE.columns[5].cards.find((k) => k.title === "Cameras");
  script = async (t) => {
    await t.kit_put_card({ column: "Gear", card: { ...cams, body: cams.body + "<p>Second look, Nov 2.</p>" }, reason: "re-check 2026-11-02" });
    return { output: "Changed Cameras." };
  };
  const a = await waitForRun((await call("/run", { method: "POST", headers: STAFF, body: { role: "kit-refresher", slug: "same-work", brief: "Re-check the cameras card." } })).json.run_id);
  const b = await waitForRun((await call("/run", { method: "POST", headers: STAFF, body: { role: "kit-refresher", slug: "same-work", brief: "Re-check the cameras card." } })).json.run_id);
  assert.equal((await call(`/kits/${a.kit.id}/approve`, { method: "POST", headers: STAFF })).status, 200);
  const stale = await call(`/kits/${b.kit.id}/approve`, { method: "POST", headers: STAFF });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, "stale_draft");
  assert.equal(stale.json.approved_version, a.kit.version);
});

// ── Brief Writer ─────────────────────────────────────────────────────────
const PIXEL = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

test("brief: the request is checked, and the brief role can't be started as a kit run", async () => {
  assert.equal((await call("/brief", { method: "POST", body: { idea: "a grain look please" } })).status, 401);
  const r = await call("/brief", { method: "POST", headers: STAFF, body: { idea: "x" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "missing_idea");
  const badImg = await call("/brief", { method: "POST", headers: STAFF, body: { idea: "a grain look please", images: [{ media_type: "image/heic", data: PIXEL }] } });
  assert.equal(badImg.json.error, "unsupported_image_type");
  assert.equal((await call("/run", { method: "POST", headers: STAFF, body: { role: "brief-writer", slug: "same-work", brief: "Write a brief." } })).json.error, "invalid_role");
});

test("brief: photos go to the agent, never to the database; the poll returns the brief", async () => {
  const brief = require("../agents/studio-brief/orchestrator");
  let gotAttachments = null;
  router._setDeps({
    brief: async ({ role, task, scope, attachments }) => {
      gotAttachments = attachments;
      const tools = Object.fromEntries(brief.toolsForRun(role, { scope }).filter((t) => t.run).map((t) => [t.name, (i) => t.run(i || {})]));
      const outline = JSON.parse(await tools.kit_outline({ slug: "same-work" }));
      assert.ok(outline.columns.length >= 10);
      const out = await tools.submit_brief({
        mode: "refresh",
        slug: "same-work",
        title: "Add a fine grain look",
        brief: "Goal: Add a fine film-grain look as a proposed option.\n\nKit: Same Work (refresh)\n\nDo:\n1. The look and sound › Vintage looks: three ways to get them: add the grain from Image 1, marked (proposed).\n\nLeave alone:\n- Every locked rule card.\n\nDone when:\n- One card changed.",
        references: [
          { ref: "Image 1", what_it_shows: "Fine even grain.", take: "Grain size.", seen: "fully" },
          { ref: "Link 1", what_it_shows: "A grain walkthrough.", take: "Settings.", seen: "partly" },
        ],
        questions: ["Replace a look, or add a fourth?"],
      });
      assert.match(out, /^Submitted/);
      return { output: "The brief asks for one new look card.", eval_status: "passed", retry_count: 0, trace: [{ type: "text", text: "ok" }], usage: {}, eval_history: [] };
    },
  });
  const start = await call("/brief", {
    method: "POST",
    headers: STAFF,
    body: {
      idea: "I like the grain on these, can we get that look for Same Work?",
      target: { mode: "refresh", slug: "same-work" },
      links: [{ url: "https://www.youtube.com/watch?v=4ikhg-fOfUg", caption: "grain at 0:40" }],
      images: [{ media_type: "image/jpeg", data: PIXEL, caption: "this grain" }],
    },
  });
  assert.equal(start.status, 200);
  assert.deepEqual(start.json.references, ["Link 1", "Image 1"]);
  const done = await waitForRun(start.json.run_id);
  assert.equal(done.status, "completed");
  assert.equal(done.brief.title, "Add a fine grain look");
  assert.deepEqual(done.brief.questions, ["Replace a look, or add a fourth?"]);
  assert.equal(done.kit, null);
  assert.equal(done.trace, undefined, "the trace stays server-side");
  assert.match(done.output, /^# Add a fine grain look/);
  assert.equal(gotAttachments.filter((a) => a.type === "image").length, 1);
  const row = db.tables.agent_runs.find((r) => r.id === start.json.run_id);
  assert.equal(row.role, "brief-writer");
  assert.ok(!JSON.stringify(row).includes(PIXEL.slice(0, 40)), "no photo data stored");
  assert.ok(row.trace.some((t) => t.type === "studio_brief"));
});

test("a run left 'running' by a server restart reports as failed", async () => {
  db.tables.agent_runs.push({ id: crypto.randomUUID(), role: "kit-refresher", status: "running", task: "x", created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() });
  const id = db.tables.agent_runs[db.tables.agent_runs.length - 1].id;
  const r = await call(`/runs/${id}`, { headers: STAFF });
  assert.equal(r.json.status, "failed");
  assert.match(r.json.error, /server restarted/);
});
