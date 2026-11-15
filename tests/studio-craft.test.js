// Studio craft (migration 040): the delivery check, note labels, the kit's
// cards as plain parts for shoot mode, where a cut's files live, and the
// worker making real review copies of stills and slides with ffmpeg (skipped
// if ffmpeg isn't installed).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const U = require("../utils/studio-films");
const F = require("../agents/studio/films");
const KIT = require("../agents/studio/kits/same-work.v1.json");

const film = { id: "f", kit_slug: "same-work", lane: "youth", athlete_id: "A0142", format: "hero" };
const people = [{ id: "p1", name: "Jamie Rivers", person_code: "A0142" }];
const check = (raw) => {
  const { errors, value } = U.deliveryInput(raw);
  assert.deepEqual(errors, []);
  return U.deliveryCheck(film, value, people);
};
const byKey = (r) => Object.fromEntries(r.results.map((x) => [x.key, x.ok]));

test("the delivery check passes a file exported the kit's way", () => {
  const r = check({ file_name: "SW_YTH_A0142_HERO_9x16_v03_20261117.mp4", format: "hero", ratio: "9x16", duration_ms: 75000, width: 1080, height: 1920, bytes: 9e6 });
  assert.equal(r.passed, true, JSON.stringify(r));
  assert.deepEqual(byKey(r), { size: true, length: true, names: true, pattern: true });
});

test("the delivery check fails the wrong size, shape or length, and a name in the file name", () => {
  let r = check({ file_name: "SW_YTH_A0142_HERO_9x16_v03_20261117.mp4", format: "hero", ratio: "9x16", duration_ms: 75000, width: 720, height: 1280 });
  assert.equal(r.passed, false);
  assert.equal(byKey(r).size, false);
  r = check({ file_name: "SW_YTH_A0142_HERO_9x16_v03_20261117.mp4", format: "hero", ratio: "9x16", duration_ms: 75000, width: 1080, height: 1080 });
  assert.equal(byKey(r).shape, false);
  r = check({ file_name: "SW_YTH_A0142_HERO_9x16_v03_20261117.mp4", format: "hero", ratio: "9x16", duration_ms: 120000, width: 1080, height: 1920 });
  assert.equal(byKey(r).length, false);
  assert.match(r.results.find((x) => x.key === "length").text, /60–90 seconds; this one is 120/);
  r = check({ file_name: "jamie-hero-final.mp4", format: "hero", ratio: "9x16", duration_ms: 75000, width: 1080, height: 1920 });
  assert.equal(byKey(r).names, false);
  assert.equal(byKey(r).pattern, "warn");
  assert.equal(r.passed, false);
  // A ratio the format doesn't use.
  r = check({ file_name: "SW_YTH_A0142_CUT_4x5_v01_20261117.mp4", format: "cutdown", ratio: "4x5", duration_ms: 20000, width: 1080, height: 1350 });
  assert.equal(byKey(r).ratio, false);
});

test("the delivery check reads stills, and only warns where the kit names no size", () => {
  let r = check({ file_name: "SW_PAR_A0142-P1_PCARD_4x5_v01_20261117.jpg", format: "parent_card", ratio: "4x5", duration_ms: null, width: 1080, height: 1350 });
  assert.equal(r.passed, true, JSON.stringify(r));
  assert.equal(byKey(r).length, undefined);
  r = check({ file_name: "SW_YTH_A0142_QUOTE_4x5_v01_20261117.png", format: "quote_card", ratio: "4x5", duration_ms: 0, width: 1080, height: 1350 });
  assert.equal(byKey(r).length, true);
  r = check({ file_name: "SW_YTH_A0142_HERO_1x1_v01_20261117.mp4", format: "hero", ratio: "1x1", duration_ms: 75000, width: 1080, height: 1080 });
  assert.equal(byKey(r).size, "warn");
  assert.deepEqual(U.deliveryInput({ file_name: "", format: "nope", ratio: "2x3" }).errors, ["file_name", "format", "ratio", "size"]);
});

test("a note's label is lower case words, so the same note groups", () => {
  assert.equal(U.label("Music under the VOICE!"), "music under the voice");
  assert.equal(U.label("  open on   the fact "), "open on the fact");
  assert.equal(U.label("Kid's name on screen?"), "kid's name on screen");
  assert.equal(U.label("x"), null);
  assert.equal(U.label("!!!"), null);
  assert.equal(U.label(""), null);
});

test("shoot mode reads the kit's cards as plain parts, never its HTML", () => {
  const rules = F.cardFor(KIT, "3. Thirteen interview rules");
  assert.equal(rules.parts.length, 13);
  assert.equal(rules.parts[0].lead, "The best question is the follow-up.");
  assert.match(rules.parts[0].text, /→/);
  for (const p of rules.parts) assert.doesNotMatch(p.lead + p.text, /[<>]/);
  const minors = F.cardFor(KIT, "6. Minors on set");
  assert.ok(minors.parts.some((p) => /Texas youth stay unidentifiable/.test(p.lead)));
  assert.equal(F.cardFor(KIT, "Shoot day: director").parts.length, 13);
  assert.equal(F.cardFor(KIT, "No such card"), null);
  assert.equal(F.cardFor(null, "6. Minors on set"), null);
  assert.equal(F.plain("<p>A &amp; B &lt;i&gt; &#8594; &#x2192; &bogus;</p><script>x</script>"), "A & B <i> → → &bogus;x");
});

test("a set's files: where they live, and its copies under their own fingerprint", () => {
  assert.equal(U.slideKey("f", "c", 2), "films/f/slides/c/2.png");
  assert.equal(U.slideKey("f", "c", 2, "jpg"), "films/f/slides/c/2.jpg");
  assert.equal(U.slideKey("f", "c", 2, "exe"), "films/f/slides/c/2.png");
  const sha = "ab".repeat(32);
  assert.equal(U.slideCopyPrefix("f", "c", sha), "films/f/previews/c-abababababababab/");
  const set = { kind: "slides", id: "c", film_id: "f", slide_keys: ["films/f/slides/c/1.png", "films/f/slides/c/2.jpg"] };
  assert.deepEqual(U.slideCopyKeys({ ...set, preview_key: U.slideCopyPrefix("f", "c", sha) }), ["films/f/previews/c-abababababababab/1.jpg", "films/f/previews/c-abababababababab/2.jpg"]);
  assert.deepEqual(U.slideCopyKeys({ ...set, preview_key: null }), [], "not made yet");
  assert.deepEqual(U.slideCopyKeys({ kind: "video", preview_key: "films/f/previews/c-x.mp4" }), []);
});

const ffmpeg = (() => {
  try {
    return require("ffmpeg-static");
  } catch (e) {
    return null;
  }
})();

function memorySb(store, cutId) {
  const updates = [];
  const open = { eq: () => open, maybeSingle: async () => ({ data: { pulled_at: null, archived_at: null }, error: null }) };
  return {
    updates,
    sb: {
      storage: store,
      from: () => ({
        select: () => open,
        update(v) {
          updates.push(v);
          const chain = { eq: () => chain, select: async () => ({ data: [{ id: cutId }], error: null }) };
          return chain;
        },
      }),
    },
  };
}

test("the worker makes marked copies of slides and fingerprints the files themselves", { skip: !ffmpeg && "ffmpeg isn't installed" }, async () => {
  const media = require("../utils/sm-market-media");
  const W = require("../utils/studio-review-worker");
  const { fakeStorage } = require("./helpers/fake-storage");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-slides-test-"));
  try {
    const one = path.join(dir, "1.png");
    const two = path.join(dir, "2.jpg");
    assert.equal((await media.run(["-f", "lavfi", "-i", "color=c=0x1b1d22:s=1080x1350", "-frames:v", "1", "-y", one])).code, 0);
    assert.equal((await media.run(["-f", "lavfi", "-i", "testsrc=size=1080x1350", "-frames:v", "1", "-y", two])).code, 0);
    const store = fakeStorage();
    const filmId = crypto.randomUUID();
    const cutId = crypto.randomUUID();
    const keys = [U.slideKey(filmId, cutId, 1, "png"), U.slideKey(filmId, cutId, 2, "jpg")];
    const files = [fs.readFileSync(one), fs.readFileSync(two)];
    store.put(U.BUCKET, keys[0], files[0], "image/png");
    store.put(U.BUCKET, keys[1], files[1], "image/jpeg");
    const { sb, updates } = memorySb(store, cutId);
    const out = await W.processOne({ id: cutId, film_id: filmId, kind: "slides", slide_keys: keys, attempts: 1 }, { sb, media, fetch: store.serve, tmp: dir, now: () => new Date() });
    assert.equal(out.ok, true);
    const u = updates[0];
    const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
    assert.equal(u.status, "ready");
    assert.equal(u.sha256, crypto.createHash("sha256").update(hash(files[0]) + "\n" + hash(files[1]), "utf8").digest("hex"));
    assert.equal(u.bytes, files[0].length + files[1].length);
    assert.deepEqual([u.width, u.height], [1080, 1350]);
    // The copies' folder is named by their own fingerprint.
    assert.equal(u.preview_key, U.slideCopyPrefix(filmId, cutId, u.preview_sha256));
    assert.equal(u.poster_key, u.preview_key + "1.jpg");
    const copyHashes = [1, 2].map((n) => hash(store.get(U.BUCKET, `${u.preview_key}${n}.jpg`).bytes));
    assert.equal(u.preview_sha256, crypto.createHash("sha256").update(copyHashes.join("\n"), "utf8").digest("hex"));
    // The copies are marked and smaller; the files are untouched.
    for (const n of [1, 2]) {
      const copy = store.get(U.BUCKET, `${u.preview_key}${n}.jpg`);
      assert.ok(copy, `copy ${n}`);
      const f = path.join(dir, `check-${n}.jpg`);
      fs.writeFileSync(f, copy.bytes);
      const info = await media.probe(f, { dir });
      assert.deepEqual([info.width, info.height], [864, 1080]);
      assert.notEqual(hash(copy.bytes), hash(files[n - 1]));
    }
    assert.equal(hash(store.get(U.BUCKET, keys[0]).bytes), hash(files[0]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the worker refuses a moving picture in a set of slides", { skip: !ffmpeg && "ffmpeg isn't installed" }, async () => {
  const media = require("../utils/sm-market-media");
  const W = require("../utils/studio-review-worker");
  const { fakeStorage } = require("./helpers/fake-storage");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-slides-test-"));
  try {
    const clip = path.join(dir, "clip.mp4");
    assert.equal((await media.run(["-f", "lavfi", "-i", "testsrc=size=1080x1350:rate=10", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", clip])).code, 0);
    const store = fakeStorage();
    const filmId = crypto.randomUUID();
    const cutId = crypto.randomUUID();
    const key = U.slideKey(filmId, cutId, 1, "png");
    store.put(U.BUCKET, key, fs.readFileSync(clip), "image/png");
    const { sb, updates } = memorySb(store, cutId);
    await assert.rejects(
      W.processOne({ id: cutId, film_id: filmId, kind: "slides", slide_keys: [key], attempts: 1 }, { sb, media, fetch: store.serve, tmp: dir, now: () => new Date() }),
      (e) => e instanceof media.MediaError && e.final === true && /isn't a still image|isn't a PNG or a JPEG/.test(e.message)
    );
    assert.equal(updates.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the still check refuses a file it can't read whole, rather than throwing, and reads only one header", () => {
  const zlib = require("zlib");
  const Still = require("../utils/studio-still");
  const I = require("./helpers/images");
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(t, "latin1"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(b) >>> 0); return Buffer.concat([l, b, c]); };
  const ihdr = (w, h, depth, color) => { const d = Buffer.alloc(13); d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = depth; d[9] = color; return chunk("IHDR", d); };
  const png = (...c) => Buffer.concat([SIG, ...c, chunk("IEND", Buffer.alloc(0))]);
  // A picture encoded with every row filter (None, Sub, Up, Average, Paeth),
  // as an encoder would: read back right, opaque or not.
  const encode = (px, w, h, bpp) => {
    const stride = w * bpp;
    const out = [];
    for (let y = 0; y < h; y++) {
      const f = y % 5;
      const row = Buffer.alloc(1 + stride);
      row[0] = f;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[y * stride + x - bpp] : 0;
        const b = y > 0 ? px[(y - 1) * stride + x] : 0;
        const c = y > 0 && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
        row[1 + x] = (px[y * stride + x] - pred) & 255;
      }
      out.push(row);
    }
    return zlib.deflateSync(Buffer.concat(out));
  };
  const w = 7, h = 10, bpp = 4;
  const px = Buffer.alloc(w * h * bpp);
  for (let i = 0; i < px.length; i++) px[i] = i % 4 === 3 ? 255 : (i * 37 + 11) % 256;
  assert.deepEqual(Still.check(png(ihdr(w, h, 8, 6), chunk("IDAT", encode(px, w, h, bpp)))), { ok: true, type: "png", width: w, height: h, marked: false });
  for (const at of [3, (w * 4 + 2) * 4 + 3, px.length - 1]) {
    const one = Buffer.from(px);
    one[at] = 254;
    assert.match(Still.check(png(ihdr(w, h, 8, 6), chunk("IDAT", encode(one, w, h, bpp)))).why, /see-through/, String(at));
  }
  // Malformed: refused with a reason, never thrown.
  const bad = [
    png(chunk("IHDR", Buffer.alloc(0))),
    png(chunk("IHDR", Buffer.alloc(4))),
    Buffer.concat([SIG, Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from("IDAT")]),
    png(ihdr(10, 10, 8, 6)),
    png(ihdr(10, 10, 8, 6), chunk("IDAT", Buffer.from("not zlib"))),
    png(ihdr(2, 2, 8, 6), chunk("IDAT", zlib.deflateSync(Buffer.from([9, 1, 1, 1, 255, 1, 1, 1, 255, 9, 1, 1, 1, 255, 1, 1, 1, 255])))),
    png(ihdr(2, 2, 8, 6), chunk("IDAT", zlib.deflateSync(Buffer.from([0, 1, 1, 1, 255, 1, 1, 1, 255])))),
    png(ihdr(0, 10, 8, 2)),
    png(ihdr(0x80000000, 1, 8, 2)),
    // Two headers (the browser reads the first, a decoder may read the second), or one after the pixels.
    png(ihdr(4, 4, 8, 6), ihdr(4, 4, 8, 2), chunk("IDAT", zlib.deflateSync(Buffer.alloc(4 * 17)))),
    png(chunk("IDAT", zlib.deflateSync(Buffer.alloc(4 * 13))), ihdr(4, 4, 8, 2)),
    // 16-bit alpha: refused, with what to do.
    png(ihdr(4, 4, 16, 6), chunk("IDAT", zlib.deflateSync(Buffer.alloc(4 * 33, 255)))),
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]),
  ];
  for (const b of bad) {
    const out = Still.check(b);
    assert.equal(out.ok, false);
    assert.equal(typeof out.why, "string");
  }
  assert.match(Still.check(bad[11]).why, /16-bit/);
  // A JPEG with two frame headers (small, then huge) is refused; fill bytes before one are fine.
  const j = I.jpeg(100, 100);
  const sof = j.subarray(2, 2 + 19);
  const big = Buffer.from(sof); big.writeUInt16BE(16000, 5); big.writeUInt16BE(16000, 7);
  assert.equal(Still.check(Buffer.concat([j.subarray(0, 21), big, j.subarray(21)])).ok, false);
  assert.deepEqual(Still.check(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), j.subarray(2)])), { ok: true, type: "jpeg", width: 100, height: 100, marked: false });
  // Through a scan to the end: a second frame header after the first scan
  // is refused; a second picture after the end (a phone's) isn't read; a
  // scan cut short is refused.
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);
  const withScan = Buffer.concat([j.subarray(0, 21), scan, Buffer.from([0xff, 0xd9])]);
  assert.equal(Still.check(withScan).ok, true);
  assert.equal(Still.check(Buffer.concat([j.subarray(0, 21), scan, big, scan, Buffer.from([0xff, 0xd9])])).ok, false);
  assert.equal(Still.check(Buffer.concat([withScan, withScan])).ok, true);
  assert.match(Still.check(Buffer.concat([j.subarray(0, 21), scan])).why, /cut short/);
});
