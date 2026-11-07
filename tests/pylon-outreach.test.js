// The Recruiting Concierge's messages to coaches: the draft rules, the
// states staff see, and the family's email. The database's side (the gate,
// the link functions) is tests/pylon-outreach-db.test.js.
//
//   node --test tests/pylon-outreach.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const U = require("../utils/pylon");
const H = require("../utils/pylon-http");

const good = { coach_name: " Coach  Example ", coach_email: "Coach@Example.EDU", program_name: "Example State", program_level: "ncaa_d2", draft_subject: "Film for your review", draft_body: "Coach,\r\nhere is the film.\u0000" };

test("a draft: cleaned up, every field named when wrong", () => {
  const { errors, value } = U.normalizeDraft(good);
  assert.deepEqual(errors, []);
  assert.equal(value.coach_name, "Coach Example");
  assert.equal(value.coach_email, "coach@example.edu");
  assert.equal(value.draft_body, "Coach,\nhere is the film.");
  assert.equal(U.normalizeDraft({ ...good, program_level: "" }).value.program_level, null, "the level is optional");
  const bad = U.normalizeDraft({ coach_email: "x@y.co?bcc=a@b.c", program_level: "pro" });
  for (const f of ["coach_name", "coach_email", "program_name", "program_level", "draft_subject", "draft_body"]) assert.ok(bad.errors.includes(f), f);
  assert.doesNotThrow(() => U.normalizeDraft(null));
  assert.doesNotThrow(() => U.normalizeDraft({ coach_name: { toString: 1 }, draft_body: ["x"] }));
});

test("an edit checks and changes only what's sent", () => {
  assert.deepEqual(U.normalizeDraft({ draft_body: "Better." }, { partial: true }).value, { draft_body: "Better." });
  assert.deepEqual(U.normalizeDraft({ draft_body: "" }, { partial: true }).errors, ["draft_body"]);
  assert.deepEqual(U.normalizeDraft({}, { partial: true }).value, {});
});

test("where a message stands", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const later = "2026-11-20T12:00:00Z", earlier = "2026-11-01T12:00:00Z";
  assert.equal(U.outreachState({}, now), "draft");
  assert.equal(U.outreachState({ parent_approval_token_hash: "h", parent_approval_expires_at: later }, now), "waiting");
  assert.equal(U.outreachState({ parent_approval_token_hash: "h", parent_approval_expires_at: earlier }, now), "expired");
  assert.equal(U.outreachState({ parent_decision: "declined" }, now), "declined");
  assert.equal(U.outreachState({ parent_approved: true, parent_decision: "approved" }, now), "approved");
  assert.equal(U.outreachState({ parent_approved: true, sent_at: earlier }, now), "sent");
});

test("the family's email: the link, what it does, and nothing promised", () => {
  const req = { contact_name: "Pat Ellis", contact_role: "parent", athlete_name: "Jordan Ellis" };
  const o = { coach_name: "Coach Example", program_name: "Example State" };
  const m = U.approvalEmail(req, o, { link: "https://tojcampaign.com/parent-approval.html?token=abc" });
  assert.equal(m.subject, "Approve a message to Coach Example at Example State");
  assert.match(m.text, /^Hi Pat,/);
  assert.match(m.text, /about Jordan\. Nothing goes to the coach until you approve it\./);
  assert.match(m.text, /parent-approval\.html\?token=abc/);
  assert.match(m.text, /works once, for 14 days/);
  assert.ok(!/offer|scholarship|guarantee|viral/i.test(m.text));
  assert.match(U.approvalEmail({ ...req, contact_role: "athlete", contact_name: "Jordan Ellis" }, o, { link: "x" }).text, /Example State for you\./);
});

test("staff hear which message was decided, never the athlete", () => {
  const a = U.decisionAlert({ id: "o1", request_id: "r1", coach_name: "Coach Example", program_name: "Example State" }, "approved", "https://tojcampaign.com");
  assert.equal(a.push.title, "Pylon: message approved");
  assert.equal(a.push.url, "/app/#pylon-request/r1");
  assert.match(a.email.text, /Mark it sent in the app/);
  assert.match(U.decisionAlert({ id: "o1", request_id: "r1", coach_name: "C", program_name: "P" }, "declined", "x").email.text, /won't go out/);
});

test("the shared limiter counts per key, per window, and stays bounded", () => {
  const lim = H.windowLimiter(2, 1000, 3);
  assert.equal(lim("a", 0), false);
  assert.equal(lim("a", 10), false);
  assert.equal(lim("a", 20), true);
  assert.equal(lim("a", 2000), false, "a new window");
  for (const k of ["b", "c", "d", "e"]) lim(k, 2000);
  lim.reset();
  assert.equal(lim("a", 2001), false);
  assert.equal(H.visitorKey("2001:db8:0:1::5"), H.visitorKey("2001:0db8:0000:0001:ffff::9"));
});
