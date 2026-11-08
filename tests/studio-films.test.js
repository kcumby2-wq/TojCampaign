// Studio films: the input rules (utils/studio-films.js), the Same Work film
// template (agents/studio/films.js), and the review-copy worker making a real
// review copy with ffmpeg (skipped if ffmpeg isn't installed).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const U = require("../utils/studio-films");
const F = require("../agents/studio/films");
const K = require("../agents/studio/kit");

test("a Texas youth card is unidentifiable, and a minor's cut is approved by a parent", () => {
  const r = U.personInput({ person_code: "a0142", name: "Jamie Rivers", role: "athlete", texas_youth: true, covers: { face: true, name: true, jersey: true, voice: true }, reviewer_relation: "parent", reviewer_name: "Pat Rivers", reviewer_email: "PAT@family.test" });
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.person_code, "A0142");
  assert.equal(r.value.is_minor, true);
  assert.deepEqual([r.value.covers.face, r.value.covers.name, r.value.covers.jersey, r.value.covers.voice], [false, false, false, true]);
  assert.equal(r.value.reviewer_email, "pat@family.test");
  assert.ok(U.personInput({ person_code: "A", name: "Kid", role: "athlete", is_minor: true, reviewer_relation: "self", reviewer_name: "Kid One", reviewer_email: "k@x.test" }).errors.includes("person_code"));
  assert.deepEqual(U.personInput({ person_code: "A0001", name: "Kid One", role: "athlete", is_minor: true, reviewer_relation: "self", reviewer_name: "Kid One", reviewer_email: "k@x.test" }).errors, ["minor_needs_parent"]);
  assert.deepEqual(U.personInput({ person_code: "A0002", name: "Adult One", role: "athlete", reviewer_relation: "parent", reviewer_name: "Mom One", reviewer_email: "m@x.test" }).errors, ["adult_reviews_self"]);
  assert.deepEqual(U.personInput({ person_code: "A0003", name: "Adult One", role: "athlete", reviewer_relation: "self", reviewer_name: "Adult One" }).errors, ["reviewer_email"]);
  // Names are names: no links or addresses.
  assert.ok(U.personInput({ person_code: "A0004", name: "evil.example", role: "other" }).errors.includes("name"));
  // An edit keeps the card's Texas youth rule.
  const e = U.personInput({ covers: { face: true } }, { partial: true, current: { texas_youth: true, is_minor: true, covers: { face: false } } });
  assert.equal(e.value.covers.face, false);
});

test("what a card still needs before it's cleared", () => {
  assert.deepEqual(U.clearanceGaps({ release_on_file: false, speaker: true }), ["No release on file", "Who approves the cut (the speaker, or a minor's parent or guardian)"]);
  assert.deepEqual(U.clearanceGaps({ release_on_file: true, speaker: false }), []);
});

test("titles and file names carry the athlete ID, never a name", () => {
  const people = [{ name: "Jamie Rivers" }, { name: "Sean O'Brien" }, { name: "Al" }];
  assert.deepEqual(U.namesIn("Jamie's drill", people), ["jamie"]);
  assert.deepEqual(U.namesIn("SW_YTH_A0142_HERO_9x16_v03_20261117", people), []);
  assert.deepEqual(U.namesIn("brien_final", people), ["brien"]);
  assert.deepEqual(U.namesIn("All about the drill", people), [], "a two-letter name doesn't match inside words");
  assert.deepEqual(U.filmInput({ title: "Rivers at dawn", lane: "youth", athlete_id: "A0142", format: "hero" }, { people }).errors, ["title_has_name"]);
  const ok = U.filmInput({ title: "A0142 hero", lane: "youth", athlete_id: "a0142", format: "hero", post_date: "2026-11-30", board_url: "https://app.milanote.com/x" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.athlete_id, "A0142");
  assert.deepEqual(U.filmInput({ title: "x", lane: "pro", athlete_id: "a", format: "reel", post_date: "2026-02-30", board_url: "http://x.test" }).errors, ["lane", "athlete_id", "format", "post_date", "board_url"]);
});

test("a cut names who's in it, from this film's cards, and stays under the size cap", () => {
  const filmPeople = [{ id: "11111111-1111-4111-8111-111111111111", name: "Jamie Rivers" }];
  const good = U.cutInput({ format: "hero", ratio: "9x16", version: 3, file_name: "SW_YTH_A0142_HERO_9x16_v03_20261117.mp4", bytes: 1000, people: ["11111111-1111-4111-8111-111111111111"] }, { filmPeople });
  assert.deepEqual(good.errors, []);
  assert.equal(good.value.content_type, "video/mp4");
  const bad = U.cutInput({ format: "x", ratio: "3x2", version: 0, file_name: "Jamie.mp4", bytes: 1024 * 1024 * 1024, people: ["22222222-2222-4222-8222-222222222222"] }, { filmPeople });
  assert.deepEqual(bad.errors, ["format", "ratio", "version", "file_name_has_name", "too_big", "people"]);
  assert.ok(U.cutInput({ format: "hero", ratio: "9x16", version: 1, file_name: "a.exe", bytes: 10 }, { filmPeople }).errors.includes("file_name"));
});

test("the kit's file-name pattern: warnings, never refusals", () => {
  const film = { kit_slug: "same-work", lane: "youth", athlete_id: "A0142" };
  const cut = { format: "hero", ratio: "9x16", version: 3 };
  assert.deepEqual(U.nameWarnings("SW_YTH_A0142_HERO_9x16_v03_20261117.mp4", film, cut), []);
  assert.deepEqual(U.nameWarnings("SW_COL_A0142_HERO_4x5_v02_2026.mp4", film, cut), ["Lane: YTH", "Ratio: 9x16", "Version: v03", "Date: YYYYMMDD"]);
  assert.match(U.nameWarnings("final.mp4", film, cut)[0], /^The kit names files SW_YTH_A0142_HERO_9x16_v03_\d{8}\.mp4$/);
  assert.equal(F.fileNameFor(F.templateFor("same-work"), film, cut, new Date("2026-11-17T12:00:00Z")), "SW_YTH_A0142_HERO_9x16_v03_20261117");
});

test("the Same Work template follows the kit's ten steps and reads its checklists", () => {
  const t = F.templateFor("same-work");
  assert.deepEqual(t.steps.map((s) => s.key), F.STEP_KEYS);
  assert.equal(t.steps.find((s) => s.key === "publish").owner, "owner");
  const kit = K.builtinKits().find((b) => b.slug === "same-work").kit;
  for (const s of t.steps.filter((x) => x.checklist)) assert.ok(F.checklistFor(kit, s.checklist).length >= 5, s.checklist);
  // The kit's formats column names every format the template knows.
  const formats = kit.columns.find((c) => c.name === "The formats").cards.map((c) => c.title.toLowerCase()).join(" | ");
  for (const f of ["hero film", "cutdowns", "parent sit-down", "quote card", "same drill", "in their own words", "on the mic"]) assert.ok(formats.includes(f), f);
});

test("the board's parts are cleaned and capped", () => {
  const v = U.planInput({ references: [{ url: "javascript:alert(1)", note: "x" }, { url: "https://example.com/a" }], must_have: ["a", "b", "c", "d"], schedule: [{ time: "25:00", what: "late" }, { time: "09:30", what: "B-roll" }], quotes: Array(30).fill({ quote: "q", question: "?" }), shoot_date: "2026-13-01" });
  assert.deepEqual(v.references, [{ url: null, note: "x" }, { url: "https://example.com/a", note: "" }]);
  assert.equal(v.must_have.length, 3);
  assert.deepEqual(v.schedule, [{ time: null, what: "late" }, { time: "09:30", what: "B-roll" }]);
  assert.equal(v.quotes.length, 20);
  assert.equal(v.shoot_date, null);
});

test("the review email: first name, the link, one use, no replies with the link", () => {
  const m = U.reviewEmail({ reviewerName: "Pat Rivers", relation: "parent", formatLabel: "Hero film", link: "https://www.tojcampaign.com/film-review.html#t=" + "a".repeat(64), expiresAt: "2026-11-24T12:00:00Z" });
  assert.match(m.text, /^Hi Pat,/);
  assert.match(m.text, /your child/);
  assert.match(m.text, /#t=a{64}/);
  assert.match(m.text, /works once/);
  assert.match(m.text, /don't reply/);
  assert.doesNotMatch(m.text, /views|followers|viral|scholarship offer/i);
  const r = U.reviewReceipt({ reviewerName: "Alex Doe", decision: "changes", formatLabel: "Hero film", decidedName: "Alex Doe" });
  assert.match(r.text, /asked for a change/);
  assert.match(r.text, /72 hours/);
});

const ffmpeg = (() => {
  try {
    const p = require("ffmpeg-static");
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

test("the worker makes a real review copy: 720 wide, with its sound, fingerprinted", { skip: !ffmpeg && "ffmpeg isn't installed" }, async () => {
  const media = require("../utils/sm-market-media");
  const W = require("../utils/studio-review-worker");
  const { fakeStorage } = require("./helpers/fake-storage");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-worker-"));
  try {
    const src = path.join(dir, "cut.mp4");
    const made = await media.run(["-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", src]);
    assert.equal(made.code, 0, made.stderr);
    const bytes = fs.readFileSync(src);
    const store = fakeStorage();
    const filmId = crypto.randomUUID();
    const cutId = crypto.randomUUID();
    const key = U.cutKey(filmId, cutId, "mp4");
    store.put(U.BUCKET, key, bytes, "video/mp4");
    let update = null;
    const open = { eq: () => open, maybeSingle: async () => ({ data: { pulled_at: null, archived_at: null }, error: null }) };
    const sb = {
      storage: store,
      from: () => ({
        select: () => open,
        update(v) {
          update = v;
          const chain = { eq: () => chain, select: async () => ({ data: [{ id: cutId }], error: null }) };
          return chain;
        },
      }),
    };
    const out = await W.processOne({ id: cutId, film_id: filmId, object_key: key, attempts: 1 }, { sb, media, fetch: store.serve, tmp: dir, now: () => new Date() });
    assert.equal(out.ok, true);
    assert.equal(update.status, "ready");
    assert.equal(update.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    assert.equal(update.width, 1080);
    assert.ok(update.duration_ms >= 1900 && update.duration_ms <= 2200, String(update.duration_ms));
    // The copy is named by its own fingerprint, which is kept with the cut.
    const theCopy = store.get(U.BUCKET, update.preview_key);
    assert.ok(theCopy);
    assert.equal(update.preview_sha256, crypto.createHash("sha256").update(theCopy.bytes).digest("hex"));
    assert.equal(update.preview_key, U.previewKey(filmId, cutId, update.preview_sha256));
    assert.equal(update.poster_key, U.posterKey(filmId, cutId, update.preview_sha256));
    const copy = path.join(dir, "check.mp4");
    fs.writeFileSync(copy, theCopy.bytes);
    const r = await media.run(["-i", copy]);
    assert.match(r.stderr, /Video: h264[^\n]*720x1280/);
    assert.match(r.stderr, /Audio: aac/);
    assert.ok(store.has(U.BUCKET, update.poster_key));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
