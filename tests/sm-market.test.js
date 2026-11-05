// The Subject Medias marketplace: the rules (utils/sm-market.js).
//
//   node --test tests/sm-market.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("../utils/sm-market");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ath = (id, over = {}) => ({ id, keep_out: false, ...over });
const consent = (athlete_id, level, over = {}) => ({ athlete_id, level, under_13: false, confirmed_at: "2026-11-04T20:00:00Z", ...over });

// ── Codes and tokens ─────────────────────────────────────────────────────
test("event codes: six characters people can read aloud (no 0/O, no 1/I)", () => {
  for (let i = 0; i < 200; i++) assert.match(M.newCode(), /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(M.codeOf(" ab2cd3 "), "AB2CD3");
  assert.equal(M.codeOf("AB0CD1"), null);
  assert.equal(M.codeOf("ABC"), null);
});

test("link tokens: random, and the database keeps only the hash", () => {
  const { token, hash } = M.newToken();
  assert.ok(M.tokenOk(token));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(M.hashToken(token), hash);
  assert.notEqual(M.newToken().token, token);
  assert.equal(M.tokenOk("short"), false);
  assert.equal(M.tokenOk({}), false);
});

// ── Events ───────────────────────────────────────────────────────────────
test("a new event: the default prices are $12 a clip and $8 a photo", () => {
  const { errors, value } = M.eventInput({ name: "Fall 7v7 Showcase", sport: "7v7 Football", starts_on: "2026-11-21", state: "ga" });
  assert.deepEqual(errors, []);
  assert.equal(value.clip_cents, 1200);
  assert.equal(value.photo_cents, 800);
  assert.equal(value.ends_on, "2026-11-21", "a one-day event ends the day it starts");
  assert.equal(value.state, "GA");
});

test("event fields that can't be used are named", () => {
  const { errors } = M.eventInput({ starts_on: "2026-02-30", state: "Georgia", clip_cents: 5, photo_cents: "x" });
  for (const f of ["name", "starts_on", "state", "clip_cents", "photo_cents"]) assert.ok(errors.includes(f), f);
  assert.ok(M.eventInput({ name: "x", starts_on: "2026-11-21", ends_on: "2026-11-20" }).errors.includes("ends_on"));
  assert.ok(M.eventInput({ name: "x", starts_on: "2026-11-01", ends_on: "2026-11-30" }).errors.includes("ends_on"), "two weeks at most");
  assert.deepEqual(M.eventInput({ clip_cents: 1500 }, { partial: true }).value, { clip_cents: 1500 });
});

test("prices typed as dollars", () => {
  assert.equal(M.centsOf("$12"), 1200);
  assert.equal(M.centsOf("8.5"), 850);
  assert.equal(M.centsOf("0.50"), null, "a dollar at least");
  assert.equal(M.centsOf("12.345"), null);
  assert.equal(M.money(1200), "$12.00");
});

test("jersey numbers: digits only, without the # or leading zeros; 0 and 00 stay two numbers", () => {
  assert.equal(M.jerseyOf("#07"), "7");
  assert.equal(M.jerseyOf("070"), "70");
  assert.equal(M.jerseyOf("23"), "23");
  // On a court, #0 and #00 are two different kids.
  assert.equal(M.jerseyOf("0"), "0");
  assert.equal(M.jerseyOf("00"), "00");
  assert.equal(M.jerseyOf("#00"), "00");
  assert.equal(M.jerseyOf("000"), null);
  assert.equal(M.jerseyOf("A7"), null);
  assert.equal(M.jerseyOf("1234"), null);
  const roster = [{ id: "a0", team_id: "t", jersey: "0" }, { id: "a00", team_id: "t", jersey: "00" }];
  assert.deepEqual(M.parseTagAnswer('{"numbers":[{"jersey":"00","team":null,"confidence":0.9}]}', [{ id: "t", name: "Lightning" }], roster), [{ athlete_id: "a00", confidence: 0.9 }]);
});

test("what loosens a guardian's answer waits for their email; what tightens doesn't", () => {
  const was = (level, under_13 = false) => ({ level, under_13 });
  assert.equal(M.looser(was("out"), was("sell")), true, "out to sell loosens");
  assert.equal(M.looser(was("family"), was("public")), true);
  assert.equal(M.looser(was("sell", true), was("sell", false)), true, "12 or younger to older loosens");
  assert.equal(M.looser(was("sell"), was("family")), false, "more careful");
  assert.equal(M.looser(was("sell"), was("sell", true)), false);
  assert.equal(M.looser(was("public", true), was("out", false)), false, "a keep-out never loosens");
});

// ── Consent ──────────────────────────────────────────────────────────────
test("the QR form: team, jersey, email, the choice, the age, and that they're the guardian", () => {
  const ok = M.consentInput({ team_id: T1, jersey: "#7", email: "Dana@Example.com", level: "sell", under_13: "no", guardian: "on" });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value, { team_id: T1, jersey: "7", email: "dana@example.com", level: "sell", under_13: false });
  const bad = M.consentInput({ team_id: "x", jersey: "?", email: "nope", level: "everything" });
  for (const f of ["team_id", "jersey", "email", "level", "under_13", "guardian"]) assert.ok(bad.errors.includes(f), f);
  assert.ok(M.consentInput({ team_id: T1, jersey: "7", email: "a@b.co", level: "public", under_13: "yes", guardian: true }).errors.includes("level"), "never public under 13");
});

test("no confirmed consent means nothing is shown", () => {
  assert.equal(M.effectiveLevel(ath(A), []), "none");
  assert.equal(M.effectiveLevel(ath(A), [consent(A, "public", { confirmed_at: null })]), "none", "unconfirmed doesn't count");
});

test("the most careful guardian wins", () => {
  assert.equal(M.effectiveLevel(ath(A), [consent(A, "public"), consent(A, "family")]), "family");
  assert.equal(M.effectiveLevel(ath(A), [consent(A, "public"), consent(A, "sell")]), "sell");
  assert.equal(M.effectiveLevel(ath(A), [consent(A, "public")]), "public");
});

test("a keep-out counts at once, confirmed or not; staff keep-out beats everything", () => {
  assert.equal(M.effectiveLevel(ath(A), [consent(A, "public"), consent(A, "out", { confirmed_at: null })]), "out");
  assert.equal(M.effectiveLevel(ath(A, { keep_out: true }), [consent(A, "public")]), "out");
  assert.equal(M.effectiveLevel(null, [consent(A, "public")]), "out");
});

test("under 13, from any guardian, is never public", () => {
  assert.equal(M.effectiveLevel(ath(A), [consent(A, "public"), consent(A, "sell", { under_13: true })]), "sell");
  assert.equal(M.effectiveLevel(ath(A), [consent(A, "public"), consent(A, "family", { under_13: true, confirmed_at: null })]), "sell", "even an unconfirmed answer about age counts");
});

test("consents for another athlete don't count", () => {
  assert.equal(M.effectiveLevel(ath(A), [consent(B, "out"), consent(A, "sell")]), "sell");
});

// ── Who sees what ────────────────────────────────────────────────────────
const item = (over = {}) => ({ id: "m1", status: "approved", ...over });
const tag = (athlete_id, confirmed = true) => ({ media_id: "m1", athlete_id, confirmed });
const allowed = (levelsObj, opts) => M.itemAllowed(item(opts.item), { tags: opts.tags, levels: new Map(Object.entries(levelsObj)), access: opts.access, forAthlete: opts.forAthlete || null });

test("the event link (team and jersey): every athlete in the item OK to sell", () => {
  assert.equal(allowed({ [A]: "sell" }, { tags: [tag(A)], access: "event", forAthlete: A }), true);
  assert.equal(allowed({ [A]: "public" }, { tags: [tag(A)], access: "event", forAthlete: A }), true);
  assert.equal(allowed({ [A]: "family" }, { tags: [tag(A)], access: "event", forAthlete: A }), false, "family only isn't on the event link");
  assert.equal(allowed({ [A]: "sell", [B]: "family" }, { tags: [tag(A), tag(B)], access: "event", forAthlete: A }), false, "someone else in it is family only");
  assert.equal(allowed({ [A]: "sell", [B]: "none" }, { tags: [tag(A), tag(B)], access: "event", forAthlete: A }), false, "someone else in it has no consent");
  assert.equal(allowed({ [A]: "sell" }, { tags: [tag(A)], access: "event", forAthlete: B }), false, "not their athlete's item");
});

test("a family's own link: their athlete family or more, everyone else OK to sell", () => {
  assert.equal(allowed({ [A]: "family" }, { tags: [tag(A)], access: "family", forAthlete: A }), true);
  assert.equal(allowed({ [A]: "family", [B]: "sell" }, { tags: [tag(A), tag(B)], access: "family", forAthlete: A }), true);
  assert.equal(allowed({ [A]: "family", [B]: "family" }, { tags: [tag(A), tag(B)], access: "family", forAthlete: A }), false, "another family's family-only athlete");
  assert.equal(allowed({ [A]: "out" }, { tags: [tag(A)], access: "family", forAthlete: A }), false);
});

test("the store: every athlete in it public", () => {
  assert.equal(allowed({ [A]: "public", [B]: "public" }, { tags: [tag(A), tag(B)], access: "store" }), true);
  assert.equal(allowed({ [A]: "public", [B]: "sell" }, { tags: [tag(A), tag(B)], access: "store" }), false);
});

test("only approved items with a confirmed tag are shown anywhere", () => {
  assert.equal(allowed({ [A]: "public" }, { tags: [tag(A, false)], access: "store" }), false, "an AI guess isn't enough");
  assert.equal(allowed({ [A]: "public" }, { tags: [], access: "store" }), false);
  assert.equal(allowed({ [A]: "public" }, { tags: [tag(A)], access: "store", item: { status: "review" } }), false);
  assert.equal(allowed({ [A]: "public" }, { tags: [tag(A)], access: "store", item: { status: "hidden" } }), false);
});

// ── Uploads ──────────────────────────────────────────────────────────────
test("uploads: video and photos only, up to 2 GB", () => {
  assert.deepEqual(M.uploadInput({ filename: "C0042.MP4", bytes: 52428800 }).value, { filename: "C0042.MP4", ext: "mp4", kind: "clip", content_type: "video/mp4", bytes: 52428800 });
  assert.equal(M.uploadInput({ filename: "IMG_1.JPG", bytes: 1 }).value.kind, "photo");
  assert.deepEqual(M.uploadInput({ filename: "notes.pdf", bytes: 10 }).errors, ["filename"]);
  assert.deepEqual(M.uploadInput({ filename: "a.mov", bytes: 3 * 1024 ** 3 }).errors, ["bytes"]);
  assert.equal(M.originalKey(T1, A, "mp4"), `events/${T1}/originals/${A}.mp4`);
  assert.equal(M.previewKey(T1, A, "clip"), `events/${T1}/previews/${A}.mp4`);
  assert.equal(M.posterKey(T1, A), `events/${T1}/previews/${A}-poster.jpg`);
});

// ── Jersey suggestions ───────────────────────────────────────────────────
const teams = [{ id: T1, name: "Lightning" }, { id: T2, name: "Storm" }];
const roster = [{ id: A, team_id: T1, jersey: "7" }, { id: B, team_id: T2, jersey: "7" }, { id: C, team_id: T2, jersey: "22" }];

test("the model sees teams and numbers only", () => {
  const p = M.tagPrompt({ name: "Fall Showcase", sport: "7v7 Football" }, teams, roster);
  assert.match(p, /Lightning: 7/);
  assert.match(p, /Storm: 7, 22/);
  assert.match(p, /JSON only/);
});

test("the model's answer becomes suggestions on the roster", () => {
  const answer = 'Sure: {"numbers": [{"jersey": "7", "team": "lightning", "confidence": 0.93}, {"jersey": "22", "team": null, "confidence": 0.81}, {"jersey": "7", "team": null, "confidence": 0.9}, {"jersey": "99", "team": null, "confidence": 0.99}, {"jersey": "22", "team": "Storm", "confidence": 0.3}]}';
  const s = M.parseTagAnswer(answer, teams, roster);
  assert.deepEqual(s.sort((x, y) => x.athlete_id.localeCompare(y.athlete_id)), [{ athlete_id: A, confidence: 0.93 }, { athlete_id: C, confidence: 0.81 }]);
});

test("a broken or hostile answer is no suggestion, never a throw", () => {
  for (const a of ["", "no json here", "{not json}", '{"numbers": "lots"}', '{"numbers": [null, 5, {"jersey": {}}]}', null, { numbers: [] }]) {
    assert.deepEqual(M.parseTagAnswer(a, teams, roster), []);
  }
});

// ── Emails ───────────────────────────────────────────────────────────────
test("the confirmation email says what was chosen and that ignoring it changes nothing", () => {
  const m = M.consentEmail({ name: "Fall Showcase" }, "Lightning", "7", "family", "https://www.subjectmedias.com/m/confirm/x");
  assert.match(m.subject, /Lightning #7 at Fall Showcase/);
  assert.match(m.text, /Family only \(only your family sees and buys their footage\)/);
  assert.match(m.text, /ignore this email and nothing changes/);
});
