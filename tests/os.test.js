// The Operating System builder — the trail in the video's order: door →
// Foundation Score intake → five pillars (agent drafts, approver approves) →
// Operational Transcript (agent drafts, approver approves, into the client
// portal) → Intake / Delivery / Follow-up installed → the operating brain →
// running. Plus the rules: Authority builds are owner-only, no pillar above 40
// without evidence, banned words block a transcript, the model never sees
// contact details or named athletes. Made-up data only.
//
//   node --test tests/os.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");

process.env.ADMIN_EMAILS = "kyron@example.com";
process.env.CREATOR_PAGE_BASE = "https://tojcampaign.com";

const { fakeSupabase } = require("./helpers/fake-supabase");
const { setSupabase } = require("../utils/supabase");
const P = require("../utils/push");
const O = require("../utils/os");
const AI = require("../utils/os-ai");
const { brainFiles } = require("../utils/os-brain");
const { zip, crc32 } = require("../utils/zip");

let db, server, base;
const sent = [];
const prompts = [];
let nextReply = null;

const SCORE_REPLY = {
  pillars: {
    brand_identity: { score: 78, evidence: "Ten years coaching; clear niche in strength for runners.", gap: "One consistent tagline across IG and site." },
    operational_health: { score: 52, evidence: "Books by DM and a paper calendar.", gap: "A booking form and automatic reminders." },
    revenue_architecture: { score: 61, evidence: "$84k trailing revenue, mostly 1:1.", gap: "A group offer to lift revenue per hour." },
    content_credibility: { score: 88, evidence: "", gap: "Collect testimonials with consent." },
    growth_readiness: { score: 35, evidence: "Fully booked; no waitlist.", gap: "A waitlist and a second coach." },
  },
  summary: "Strong coach, manual back office. Fix booking first.",
};
const TRANSCRIPT_REPLY = {
  executive_summary: "The coaching is strong and the calendar is full; the back office runs on DMs. Fix booking and reminders first.",
  lines: [{ name: "1:1 strength sessions", figure: "", standing: "Healthy", note: "Full calendar." }],
  recovery: [{ title: "Small-group sessions for runners", value: "", ease: "Easy", note: "Same hours, more clients." }],
  roster: "Not in the intake.",
  path: [{ label: "Focus", text: "Booking form with reminders." }, { label: "Secondary", text: "A waitlist." }, { label: "Backburner", text: "A second coach." }],
  actions: [
    { title: "Set up a booking form", detail: "Replace DM booking.", owner: "System" },
    { title: "Turn on reminders", detail: "24 hours before each session.", owner: "System" },
    { title: "Start a waitlist", detail: "On the site.", owner: "Client" },
    { title: "Ask five clients for a testimonial", detail: "Consent first.", owner: "Client" },
    { title: "Book the 30-day review", detail: "With TOJ.", owner: "TOJ" },
  ],
};

before(async () => {
  db = fakeSupabase({
    users: [{ email: "kyron@example.com", hash: "x", role: "admin" }],
    team_members: [
      { email: "member@example.com", name: "Mo", role: "member", tools: ["os"], status: "active" },
      { email: "approver@example.com", name: "Ap", role: "approver", tools: ["os"], status: "active" },
      { email: "viewer@example.com", name: "Vi", role: "viewer", tools: ["os"], status: "active" },
      { email: "studio-only@example.com", name: "St", role: "approver", tools: ["studio"], status: "active" },
    ],
    clients: [{ id: "11111111-1111-4111-8111-111111111111", email: "coach@example.com", business_name: "Sample Strength Co", operator_name: "Sample Coach", vertical: "personal-brand", tier: "founding", status: "pilot" }],
    foundation_scores: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        client_id: "11111111-1111-4111-8111-111111111111",
        vertical: "personal-brand",
        intake_version: "v1",
        submitted_at: "2026-10-20T14:00:00.000Z",
        intake_payload: { brand_name: "Sample Coach", business_name: "Sample Strength Co", city: "Portland", state: "OR", ttm_revenue: "$84k", blockers: "Booking by DM", contact_email: "coach@example.com", contact_phone: "555-0100" },
      },
      { id: "33333333-3333-4333-8333-333333333333", client_id: null, vertical: "authority", intake_version: "v1", submitted_at: "2026-10-19T14:00:00.000Z", intake_payload: { business_name: "Sample Program", named_athletes: "A Minor Name" } },
    ],
    push_subscriptions: [
      { id: "p1", email: "kyron@example.com", endpoint: "https://push.example.com/k", p256dh: "p", auth: "a", fail_count: 0, kind: "web" },
      { id: "p2", email: "approver@example.com", endpoint: "https://push.example.com/a", p256dh: "p", auth: "a", fail_count: 0, kind: "web" },
    ],
  });
  setSupabase(db);
  P.setSender(async (s, payload) => sent.push({ to: s.email, ...payload }));
  AI._setCaller(async ({ system, prompt }) => {
    prompts.push({ system, prompt });
    if (nextReply) return nextReply;
    return JSON.stringify(/Operational Transcript/.test(system) ? TRANSCRIPT_REPLY : SCORE_REPLY);
  });

  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/os", require("../routes/os"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { AI._setCaller(null); server && server.close(); });

function client() {
  let cookie = "";
  return async (path, { method = "GET", body } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get("set-cookie");
    if (c) cookie = c.split(";")[0];
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString("utf8");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, buf, headers: r.headers };
  };
}
async function as(email, role) {
  const c = client();
  await c("/test-login", { method: "POST", body: { email, role } });
  return c;
}
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

let kyron, mem, appr, view, id;

test("only people with the Operating Systems tool get in", async () => {
  kyron = await as("kyron@example.com", "admin");
  mem = await as("member@example.com");
  appr = await as("approver@example.com");
  view = await as("viewer@example.com");
  const studioOnly = await as("studio-only@example.com");
  assert.equal((await client()("/api/os")).status, 401);
  assert.equal((await studioOnly("/api/os")).status, 403, "Studio access isn't OS access");
  const r = await view("/api/os");
  assert.equal(r.status, 200);
  assert.equal(r.json.stages.length, 6);
  assert.deepEqual(r.json.stages.map((s) => s.key), ["raw", "intake", "standard", "transcript", "systemized", "running"]);
  assert.equal((await view("/api/os", { method: "POST", body: { vertical: "personal-brand", name: "X" } })).status, 403, "viewers can't start one");
});

test("members see the site's Foundation Score submissions, but not Authority ones (minors' data)", async () => {
  const m = await mem("/api/os/intakes");
  assert.equal(m.status, 200);
  assert.deepEqual(m.json.intakes.map((i) => i.vertical), ["personal-brand"]);
  assert.equal(m.json.intakes[0].name, "Sample Strength Co");
  const k = await kyron("/api/os/intakes");
  assert.equal(k.json.intakes.length, 2);
  const a = await mem("/api/os", { method: "POST", body: { foundation_score_id: "33333333-3333-4333-8333-333333333333" } });
  assert.equal(a.status, 403);
  assert.equal(a.json.error, "authority_owner_only");
});

test("step 1–2: pick the door and bring in the Foundation Score intake", async () => {
  const bad = await mem("/api/os", { method: "POST", body: { name: "No door" } });
  assert.equal(bad.json.error, "pick_a_door");
  const r = await mem("/api/os", { method: "POST", body: { foundation_score_id: "22222222-2222-4222-8222-222222222222" } });
  assert.equal(r.status, 201);
  const b = r.json.build;
  id = b.id;
  assert.equal(b.vertical, "personal-brand");
  assert.equal(b.stage, "intake");
  assert.equal(b.name, "Sample Strength Co");
  assert.equal(b.contact_email, "coach@example.com");
  assert.equal(b.intake_source, "foundation_score");
  assert.ok(b.transcript_due > "2026-10-22", "72 business hours after the intake");
  assert.equal((await mem("/api/os", { method: "POST", body: { foundation_score_id: "22222222-2222-4222-8222-222222222222" } })).status, 409, "one build per submission");
  const v = await view("/api/os/" + id);
  assert.equal(v.json.build.contact_email, undefined, "viewers don't see contact details");
  assert.ok(!v.json.build.intake.some((x) => x.key === "contact_phone"));
});

test("step 3: an agent drafts the five pillars from the intake; no pillar above 40 without evidence", async () => {
  const s = await mem(`/api/os/${id}/scores/draft`, { method: "POST" });
  assert.equal(s.status, 202);
  assert.equal(s.json.build.score.status, "running");
  const done = await until(async () => { const r = await mem("/api/os/" + id); return r.json.build.score.status === "ready" ? r.json.build : null; });
  const p = done.score.draft.pillars;
  assert.equal(p.brand_identity.score, 78);
  assert.equal(p.content_credibility.score, 40, "88 with no evidence is capped at 40");
  assert.match(p.content_credibility.evidence, /Insufficient/);
  assert.equal(done.stage, "intake", "a draft doesn't move the trail");
  const pr = prompts[prompts.length - 1];
  assert.ok(!/coach@example\.com|555-0100/.test(pr.prompt), "the model never sees contact details");
  assert.ok(/no pillar above 40|above 40 without/i.test(pr.system));
  assert.ok(sent.some((x) => x.to === "approver@example.com" && /scores drafted/i.test(x.title)), "approvers hear the draft is ready");
});

test("members can't approve; approvers can, and the trail moves to The Standard", async () => {
  assert.equal((await mem(`/api/os/${id}/scores/approve`, { method: "POST" })).status, 403);
  const edit = await mem(`/api/os/${id}/scores`, { method: "PUT", body: { pillars: { ...SCORE_REPLY.pillars, growth_readiness: { score: 38, evidence: "Fully booked; no waitlist.", gap: "A waitlist." } } } });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.build.score.draft.source, "agent+edited");
  const a = await appr(`/api/os/${id}/scores/approve`, { method: "POST" });
  assert.equal(a.status, 200);
  assert.equal(a.json.build.stage, "standard");
  assert.equal(a.json.build.score.approved.growth_readiness.score, 38);
  assert.equal(a.json.build.score.total, 78 + 52 + 61 + 40 + 38);
  assert.equal(a.json.build.score.weakest, "growth_readiness");
  assert.equal((await mem("/api/os/" + id, { method: "PATCH", body: { intake: { notes: "late" } } })).json.error, "intake_locked_after_scoring");
});

test("step 4: the transcript — drafted, banned words block it, approved into the client portal", async () => {
  const d = await mem(`/api/os/${id}/transcript/draft`, { method: "POST" });
  assert.equal(d.status, 202);
  const done = await until(async () => { const r = await mem("/api/os/" + id); return r.json.build.transcript.status === "ready" ? r.json.build : null; });
  assert.equal(done.transcript.draft.actions.length, 5);
  assert.deepEqual(done.transcript.blockers, []);
  const pr = prompts[prompts.length - 1];
  assert.ok(/Approved five-pillar scores/.test(pr.prompt));
  assert.ok(/Never name a minor/.test(pr.system));

  const page = await view(`/api/os/${id}/transcript.html?v=draft`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Standing of the <em>operation<\/em>/);
  assert.match(page.text, /Revenue recovery opportunities/);
  assert.match(page.text, /Draft\. Nobody outside the team/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.ok(!/<script/i.test(page.text));

  const bad = await mem(`/api/os/${id}/transcript`, { method: "PUT", body: { ...TRANSCRIPT_REPLY, executive_summary: "This will transform your business." } });
  assert.deepEqual(bad.json.blockers, ["banned_words"]);
  const blocked = await appr(`/api/os/${id}/transcript/approve`, { method: "POST" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, "fix_blockers_first");
  await mem(`/api/os/${id}/transcript`, { method: "PUT", body: TRANSCRIPT_REPLY });

  assert.equal((await mem(`/api/os/${id}/transcript/approve`, { method: "POST" })).status, 403);
  const ok = await appr(`/api/os/${id}/transcript/approve`, { method: "POST" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.published, true);
  assert.equal(ok.json.build.stage, "transcript");
  const fs = db.tables.foundation_scores.find((r) => r.id === "22222222-2222-4222-8222-222222222222");
  assert.equal(fs.transcript_url, `https://tojcampaign.com/api/os/client/${id}/transcript`);
  assert.equal(fs.pillar_scores.growth_readiness, 38);
  assert.ok(db.tables.deliverables.some((x) => x.kind === "transcript" && x.client_id === "11111111-1111-4111-8111-111111111111"));
});

test("the client sees their own approved transcript; nobody else does", async () => {
  const coach = await as("coach@example.com", "client");
  const r = await coach(`/api/os/client/${id}/transcript`);
  assert.equal(r.status, 200);
  assert.ok(!/Draft\. Nobody/.test(r.text));
  const stranger = await as("someone@example.com", "client");
  assert.equal((await stranger(`/api/os/client/${id}/transcript`)).status, 404);
  const selfReg = await as("coach@example.com", "creator");
  assert.equal((await selfReg(`/api/os/client/${id}/transcript`)).status, 404, "a self-registered account with the client's email can't read it");
  assert.equal((await client()(`/api/os/client/${id}/transcript`)).status, 401);
});

test("step 5: install Intake, Delivery and Follow-up, then generate the operating brain", async () => {
  assert.equal((await mem("/api/os/" + id, { method: "PATCH", body: { systems: [] } })).json.error, "install_not_started");
  const i = await mem(`/api/os/${id}/install`, { method: "POST" });
  assert.equal(i.json.build.stage, "systemized");
  const groups = new Set(i.json.build.systems.map((s) => s.group));
  assert.deepEqual([...groups], ["intake", "delivery", "follow_up"]);
  assert.equal((await mem(`/api/os/${id}/scores/draft`, { method: "POST" })).json.error, "scores_locked");

  const first = i.json.build.systems[0].id;
  const u = await mem("/api/os/" + id, { method: "PATCH", body: { systems: [{ id: first, status: "live" }, { add: true, group: "follow_up", label: "Birthday message" }] } });
  assert.equal(u.json.build.systems_progress.live, 1);
  assert.ok(u.json.build.systems.some((s) => s.label === "Birthday message"));

  const r1 = await appr(`/api/os/${id}/running`, { method: "POST" });
  assert.equal(r1.json.error, "systems_not_live");

  const g = await mem(`/api/os/${id}/brain`, { method: "POST" });
  assert.equal(g.status, 200);
  for (const f of ["CLAUDE.md", "workflows/daily.md", "skills/intake/SKILL.md", "skills/delivery/SKILL.md", "skills/follow-up/SKILL.md", "transcript/operational-transcript.md", "feedback/feedback-log.md", "config.md"]) assert.ok(g.json.files.includes(f), f);
  const files = (await view(`/api/os/${id}/brain`)).json.files;
  assert.match(files["CLAUDE.md"], /# Sample Strength Co Operating Brain/);
  assert.match(files["CLAUDE.md"], /Growth Readiness \| 38\/100/);
  const all = Object.values(files).join("\n");
  assert.ok(!/coach@example\.com|555-0100/.test(all), "no contact details in the brain");
  const outsideRules = all.split("\n").filter((l) => !/Banned words|These words, in any form|banned phrases/.test(l)).join("\n");
  assert.deepEqual(O.bannedIn(outsideRules), [], "no banned words outside the rule that lists them");

  const z = await mem(`/api/os/${id}/brain.zip`);
  assert.equal(z.status, 200);
  assert.equal(z.headers.get("content-type"), "application/zip");
  assert.equal(z.buf.readUInt32LE(0), 0x04034b50);
  assert.ok(z.buf.includes(Buffer.from("sample-strength-co-os/CLAUDE.md")));
  assert.equal((await view(`/api/os/${id}/brain.zip`)).status, 403, "viewers can read it in the app but not download the pack");
});

test("step 6: every system live → an approver hands it off; it's running on the Trail of Joy", async () => {
  const b = (await mem("/api/os/" + id)).json.build;
  await mem("/api/os/" + id, { method: "PATCH", body: { systems: b.systems.map((s) => ({ id: s.id, status: "live" })) } });
  assert.equal((await mem(`/api/os/${id}/running`, { method: "POST" })).status, 403);
  const r = await appr(`/api/os/${id}/running`, { method: "POST" });
  assert.equal(r.status, 200);
  assert.equal(r.json.build.stage, "running");
  assert.equal(r.json.build.stage_n, 6);
  const files = (await view(`/api/os/${id}/brain`)).json.files;
  assert.match(files["CLAUDE.md"], /Running on the Trail of Joy/);
  assert.equal((await mem("/api/os/" + id, { method: "PATCH", body: { systems: [{ id: b.systems[0].id, status: "todo" }] } })).json.error, "already_running");
  assert.ok(db.tables.team_activity.some((a) => a.action === "os_running"));
  assert.ok(!db.tables.team_activity.some((a) => JSON.stringify(a).includes("coach@example.com")), "no contact details in the activity log");
});

test("Authority builds stay with the owner, and the model never sees named athletes", async () => {
  const k = await kyron("/api/os", { method: "POST", body: { foundation_score_id: "33333333-3333-4333-8333-333333333333" } });
  assert.equal(k.status, 201);
  const aid = k.json.build.id;
  assert.equal((await appr("/api/os/" + aid)).status, 404, "an approver without owner rights can't open it");
  assert.ok(!(await mem("/api/os")).json.builds.some((b) => b.id === aid));
  await kyron("/api/os/" + aid, { method: "PATCH", body: { intake: { sport_position: "Football", playing_bg: "Former college WR", methodology: "Film first" } } });
  await kyron(`/api/os/${aid}/scores/draft`, { method: "POST" });
  await until(async () => (await kyron("/api/os/" + aid)).json.build.score.status === "ready");
  const pr = prompts[prompts.length - 1];
  assert.ok(!/A Minor Name/.test(pr.prompt), "named athletes are withheld from the model");
  const act = db.tables.team_activity.filter((a) => a.detail && a.detail.os_id === aid);
  assert.ok(act.length && act.every((a) => a.subject === "an Authority operating system"));
  assert.ok(sent.some((x) => x.to === "kyron@example.com" && /an Authority operating system/.test(x.title)), "only the owner hears about it");
  assert.ok(!sent.some((x) => x.to === "approver@example.com" && /Authority/.test(x.title)));
});

test("a build from scratch: in-app intake, hand scoring when no agent, published once there's an email", async () => {
  AI._setCaller(null);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await mem("/api/os", { method: "POST", body: { vertical: "nonprofit", name: "Sample Youth League" } });
    assert.equal(r.json.build.stage, "raw");
    const nid = r.json.build.id;
    const p = await mem("/api/os/" + nid, { method: "PATCH", body: { intake: { business_name: "Sample Youth League", mission_statement: "Free flag football for 8–14s.", participants: "240", annual_budget: "$60k" } } });
    assert.equal(p.json.build.stage, "intake");
    assert.equal(p.json.build.ai, false);
    assert.equal((await mem(`/api/os/${nid}/scores/draft`, { method: "POST" })).json.error, "ai_not_configured");
    await mem(`/api/os/${nid}/scores`, { method: "PUT", body: { pillars: { brand_identity: { score: 60, evidence: "Clear mission.", gap: "" }, operational_health: { score: 30, evidence: "", gap: "" }, revenue_architecture: { score: 45, evidence: "$60k budget.", gap: "" }, content_credibility: { score: 20, evidence: "", gap: "" }, growth_readiness: { score: 25, evidence: "", gap: "" } } } });
    await appr(`/api/os/${nid}/scores/approve`, { method: "POST" });
    await mem(`/api/os/${nid}/transcript`, { method: "PUT", body: TRANSCRIPT_REPLY });
    const a = await appr(`/api/os/${nid}/transcript/approve`, { method: "POST" });
    assert.equal(a.json.published, false, "no client email: approved, kept internal");
    assert.equal(a.json.reason, "no_client_email");
    const page = await view(`/api/os/${nid}/transcript.html`);
    assert.match(page.text, /Funding architecture/, "the non-profit lane's section names");
    assert.match(page.text, /Funding Architecture/, "the non-profit lane's pillar name");
  } finally {
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("utils: bands, the business-hours due date, the zip writer", () => {
  assert.equal(O.band(95).name, "Advantage");
  assert.equal(O.band(70).name, "Solid");
  assert.equal(O.band(40).name, "Underperforming");
  assert.equal(O.band(12).name, "Broken or missing");
  assert.equal(O.transcriptDue("2026-10-23T15:00:00.000Z").slice(0, 10), "2026-10-28", "Friday intake → Wednesday");
  assert.equal(crc32(Buffer.from("hello")), 0x3610a686);
  const z = zip({ "a.txt": "hi" });
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
  assert.deepEqual(O.bannedIn("We unlock growth"), ["unlock"]);
  assert.deepEqual(O.bannedIn("Premiere Pro"), [], "Premiere Pro is fine");
});
