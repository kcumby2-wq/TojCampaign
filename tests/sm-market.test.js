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
const consent = (athlete_id, level, over = {}) => ({ athlete_id, level, under_13: false, age_band: "16_17", confirmed_at: "2026-11-04T20:00:00Z", ...over });

// ── Codes and tokens ─────────────────────────────────────────────────────
test("event codes: six characters people can read aloud (no 0/O, no 1/I)", () => {
  for (let i = 0; i < 200; i++) assert.match(M.newCode(), /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(M.codeOf(" ab2cd3 "), "AB2CD3");
  assert.equal(M.codeOf("AB0CD1"), null);
  assert.equal(M.codeOf("ABC"), null);
});

test("the clips page's access code: eight readable characters, typed any way, compared exactly", () => {
  for (let i = 0; i < 200; i++) assert.match(M.newViewKey(), /^[A-HJ-NP-Z2-9]{8}$/);
  const ev = { view_key: "ABCD2345" };
  assert.equal(M.viewKeyShown("ABCD2345"), "ABCD-2345");
  assert.equal(M.viewKeyOf(" abcd-2345 "), "ABCD2345");
  assert.equal(M.viewKeyMatches("abcd 2345", ev), true);
  assert.equal(M.viewKeyMatches("ABCD2346", ev), false);
  assert.equal(M.viewKeyMatches("ABCD234", ev), false);
  assert.equal(M.viewKeyMatches(["ABCD2345"], ev), false, "a repeated ?k= is no code");
  assert.equal(M.viewKeyMatches("ABCD2345", {}), false, "an event without a code opens nothing");
  assert.equal(M.linkTo.event("AB2CD3", "ABCD2345"), "https://www.subjectmedias.com/m/AB2CD3?k=ABCD2345");
  assert.equal(M.linkTo.event("AB2CD3"), "https://www.subjectmedias.com/m/AB2CD3");
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
  const was = (level, age_band = "16_17") => ({ level, age_band, under_13: age_band === "u13" });
  assert.equal(M.looser(was("out"), was("sell")), true, "out to sell loosens");
  assert.equal(M.looser(was("family"), was("public")), true);
  assert.equal(M.looser(was("family", "u13"), was("family", "13_15")), true, "12 or younger to older loosens");
  assert.equal(M.looser(was("sell", "16_17"), was("sell", "18_plus")), true, "any older band loosens");
  assert.equal(M.looser(was("sell"), was("family")), false, "more careful");
  assert.equal(M.looser(was("sell", "16_17"), was("sell", "13_15")), false, "a younger band is more careful");
  assert.equal(M.looser(was("family", "u13"), was("out", "18_plus")), false, "a keep-out never loosens");
  // A row from before age bands reads carefully.
  assert.equal(M.bandOf({ under_13: true }), "u13");
  assert.equal(M.bandOf({ under_13: null }), "u13");
  assert.equal(M.bandOf({ under_13: false }), "13_15");
});

// ── Consent ──────────────────────────────────────────────────────────────
test("the QR form: team, jersey, email, the choice, the age band, and that they're the guardian", () => {
  const ok = M.consentInput({ team_id: T1, jersey: "#7", email: "Dana@Example.com", level: "sell", age: "16_17", guardian: "on" });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value, { team_id: T1, jersey: "7", email: "dana@example.com", level: "sell", age_band: "16_17", under_13: false });
  assert.equal(M.consentInput({ team_id: T1, jersey: "7", email: "a@b.co", level: "family", age: "u13", guardian: true }).value.under_13, true);
  const bad = M.consentInput({ team_id: "x", jersey: "?", email: "nope", level: "everything", age: "12" });
  for (const f of ["team_id", "jersey", "email", "level", "age", "guardian"]) assert.ok(bad.errors.includes(f), f);
});

test("12 or younger: family only or keep out, never sold to other families or public", () => {
  const u13 = (level) => M.consentInput({ team_id: T1, jersey: "7", email: "a@b.co", level, age: "u13", guardian: true }).errors;
  assert.ok(u13("sell").includes("level"));
  assert.ok(u13("public").includes("level"));
  assert.deepEqual(u13("family"), []);
  assert.deepEqual(u13("out"), []);
});

test("the guardian's word: needed for any choice but keep-out, which anyone may ask for", () => {
  const without = (level) => M.consentInput({ team_id: T1, jersey: "7", email: "a@b.co", level, age: "13_15" }).errors;
  assert.deepEqual(without("family"), ["guardian"]);
  assert.deepEqual(without("sell"), ["guardian"]);
  assert.deepEqual(without("out"), []);
  // Nor is an age: a keep-out without one is taken as 12 or younger.
  const out = M.consentInput({ team_id: T1, jersey: "7", email: "a@b.co", level: "out" });
  assert.deepEqual(out.errors, []);
  assert.equal(out.value.age_band, "u13");
  assert.equal(out.value.under_13, true);
  assert.deepEqual(M.consentInput({ team_id: T1, jersey: "7", email: "a@b.co", level: "family", guardian: true }).errors, ["age"], "every other choice needs the age");
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

test("12 or younger, from any guardian, is family only", () => {
  assert.equal(M.effectiveLevel(ath(A), [consent(A, "public"), consent(A, "family", { under_13: true, age_band: "u13" })]), "family");
  assert.equal(M.effectiveLevel(ath(A), [consent(A, "public"), consent(A, "family", { under_13: true, age_band: "u13", confirmed_at: null })]), "family", "even an unconfirmed answer about age counts");
  assert.equal(M.effectiveLevel(ath(A), [consent(A, "sell", { under_13: null })]), "family", "an age nobody gave reads as 12 or younger");
  assert.equal(M.effectiveLevel(ath(A), [consent(A, "public", { age_band: "13_15" })]), "public", "13 and up can be public");
});

// ── What a guardian's QR answer does ─────────────────────────────────────
const NOW = "2026-11-06T12:00:00Z";
const row = (level, age_band, over = {}) => ({ level, age_band, under_13: age_band === "u13", confirmed_at: "2026-11-04T20:00:00Z", confirm_hash: null, ...over });
const ans = (level, age_band) => ({ level, age_band, under_13: age_band === "u13" });

test("answer plan: a first answer waits for its email; a keep-out counts at once and keeps the youngest age", () => {
  const first = M.answerPlan(null, ans("sell", "16_17"), NOW);
  assert.equal(first.now, false);
  assert.ok(first.tok);
  assert.equal(first.write.level, "sell");
  assert.equal(first.write.age_band, "16_17");
  const out = M.answerPlan(row("family", "u13"), ans("out", "18_plus"), NOW);
  assert.equal(out.now, true);
  assert.deepEqual([out.write.level, out.write.age_band, out.write.under_13], ["out", "u13", true]);
});

test("answer plan: an unconfirmed 12 or younger carries over, and the row never holds more than family only", () => {
  // Nothing of theirs counts yet, but "12 or younger" does: a looser answer
  // waits for the email, with the row capped meanwhile.
  const p = M.answerPlan(row("family", "u13", { confirmed_at: null }), ans("public", "18_plus"), NOW);
  assert.equal(p.now, false);
  assert.deepEqual([p.write.level, p.write.age_band, p.write.under_13], ["family", "u13", true]);
  assert.deepEqual([p.write.pending_level, p.write.pending_age_band, p.write.pending_under_13], ["public", "18_plus", false]);
});

test("answer plan: once theirs counts, a younger band or a lower level counts now; an older band waits", () => {
  const younger = M.answerPlan(row("sell", "16_17"), ans("sell", "13_15"), NOW);
  assert.equal(younger.now, true);
  assert.equal(younger.write.age_band, "13_15");
  const u13 = M.answerPlan(row("sell", "16_17"), ans("family", "u13"), NOW);
  assert.equal(u13.now, true);
  assert.deepEqual([u13.write.level, u13.write.age_band], ["family", "u13"]);
  const older = M.answerPlan(row("sell", "13_15"), ans("sell", "18_plus"), NOW);
  assert.equal(older.now, false);
  assert.deepEqual([older.write.age_band, older.write.pending_age_band], ["13_15", "18_plus"]);
  // Looser on both counts: the careful parts stand until the email.
  const both = M.answerPlan(row("family", "u13"), ans("sell", "16_17"), NOW);
  assert.equal(both.now, false);
  assert.deepEqual([both.write.level, both.write.age_band, both.write.pending_level, both.write.pending_age_band], ["family", "u13", "sell", "16_17"]);
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
