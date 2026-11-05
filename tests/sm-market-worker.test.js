// The marketplace's processing queue (utils/sm-market-worker.js), on the fake
// Supabase and a fake Storage: a file goes from uploaded to review with a
// preview, a poster and the AI's suggestions; failures retry, then stop;
// a restart's leftovers go back in the queue. The last test runs the real
// ffmpeg steps (utils/sm-market-media.js) when ffmpeg is on this machine.
//
//   node --test tests/sm-market-worker.test.js

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { fakeSupabase } = require("./helpers/fake-supabase");
const { fakeStorage } = require("./helpers/fake-storage");
const M = require("../utils/sm-market");
const media = require("../utils/sm-market-media");
const W = require("../utils/sm-market-worker");

const EV = "11111111-1111-4111-8111-111111111111";
const LIGHTNING = "22222222-2222-4222-8222-222222222222";
const STORM = "33333333-3333-4333-8333-333333333333";
const A7 = "44444444-4444-4444-8444-444444444444";
const A11 = "55555555-5555-4555-8555-555555555555";
const S7 = "66666666-6666-4666-8666-666666666666";
const CLIP = "77777777-7777-4777-8777-777777777777";
const PHOTO = "88888888-8888-4888-8888-888888888888";

let db, store, asked, clock;
const row = (id) => db.tables.sm_market_media.find((m) => m.id === id);
const mediaRow = (id, kind, over = {}) => ({
  id,
  event_id: EV,
  kind,
  object_key: M.originalKey(EV, id, kind === "clip" ? "mp4" : "jpg"),
  status: "uploaded",
  attempts: 0,
  uploaded_by: "crew@toj.test",
  created_at: "2026-11-21T18:00:00.000Z",
  ...over,
});

beforeEach(() => {
  clock = new Date("2026-11-21T20:00:00.000Z");
  asked = [];
  db = fakeSupabase({
    sm_market_events: [{ id: EV, code: "AB2CD3", name: "Fall Showcase", sport: "Football", clip_cents: 1200, photo_cents: 800 }],
    sm_market_teams: [{ id: LIGHTNING, event_id: EV, name: "Lightning" }, { id: STORM, event_id: EV, name: "Storm" }],
    sm_market_athletes: [
      { id: A7, event_id: EV, team_id: LIGHTNING, jersey: "7" },
      { id: A11, event_id: EV, team_id: LIGHTNING, jersey: "11" },
      { id: S7, event_id: EV, team_id: STORM, jersey: "7" },
    ],
    sm_market_consents: [{ id: "c1", athlete_id: A7, email: "dana@example.com", level: "sell", under_13: false, confirmed_at: "2026-11-21T10:00:00Z" }],
    sm_market_media: [mediaRow(CLIP, "clip")],
    sm_market_tags: [],
  });
  store = fakeStorage();
  db.storage = store;
  store.put(M.BUCKET, row(CLIP).object_key, Buffer.alloc(4096, 7));
});

// ffmpeg's part, stood in: files appear where they should, sizes as given.
function stubMedia(over = {}) {
  return {
    ...media,
    async probe(file) {
      return /preview/.test(file) ? { duration_ms: 12480, width: 854, height: 480 } : { duration_ms: 12480, width: 1920, height: 1080 };
    },
    async preview(src, kind, out) { fs.writeFileSync(out, "PREVIEW " + kind); },
    async poster(src, kind, out) { fs.writeFileSync(out, "POSTER " + kind); },
    async frames(src, kind, dir) {
      const files = [];
      for (let i = 1; i <= (kind === "clip" ? 3 : 1); i++) {
        files.push(path.join(dir, `frame-${i}.jpg`));
        fs.writeFileSync(files[i - 1], "FRAME" + i);
      }
      return files;
    },
    ...over,
  };
}
const answer = (numbers) => async (q) => {
  asked.push(q);
  return "Here you go:\n" + JSON.stringify({ numbers });
};
const deps = (over = {}) => ({ sb: db, media: stubMedia(), suggest: answer([]), fetch: store.serve, now: () => clock, tmp: os.tmpdir(), ...over });

test("a clip: a preview, a poster and the AI's suggestions, then it waits for a person", async () => {
  const suggest = answer([
    { jersey: "7", team: "Lightning", confidence: 0.92 },
    { jersey: "11", team: null, confidence: 0.81 }, // only Lightning has an 11
    { jersey: "7", team: null, confidence: 0.99 }, // two teams have a 7: no one
    { jersey: "99", team: "Storm", confidence: 0.9 }, // not on the roster
    { jersey: "11", team: "Lightning", confidence: 0.3 }, // too unsure
  ]);
  const r = await W.drain(deps({ suggest }));
  assert.equal(r.processed, 1);
  const m = row(CLIP);
  assert.equal(m.status, "review");
  assert.equal(m.attempts, 1);
  assert.equal(m.preview_key, M.previewKey(EV, CLIP, "clip"));
  assert.equal(m.poster_key, M.posterKey(EV, CLIP));
  assert.equal(m.duration_ms, 12480);
  assert.deepEqual([m.width, m.height], [1920, 1080]);
  assert.equal(m.error, null);
  assert.equal(m.processed_at, clock.toISOString());
  assert.equal(store.get(M.BUCKET, m.preview_key).contentType, "video/mp4");
  assert.equal(store.get(M.BUCKET, m.poster_key).contentType, "image/jpeg");
  assert.equal(store.get(M.BUCKET, m.object_key).bytes.length, 4096, "the original is untouched");
  const tags = db.tables.sm_market_tags.map((t) => [t.athlete_id, t.source, t.confidence, t.confirmed]).sort();
  assert.deepEqual(tags, [[A11, "ai", 0.81, false], [A7, "ai", 0.92, false]].sort(), "suggestions only; a person confirms");
  // What the AI saw: three frames and the roster's team names and numbers.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].images.length, 3);
  assert.equal(Buffer.from(asked[0].images[0], "base64").toString(), "FRAME1");
  assert.match(asked[0].prompt, /Lightning: 7, 11/);
  assert.match(asked[0].prompt, /Storm: 7/);
  assert.ok(!/dana|example\.com|sell/i.test(asked[0].prompt), "nothing about families or consent goes to the AI");
});

test("a photo: one frame for the AI, no length; its turn comes from the preview", async () => {
  db.tables.sm_market_media = [mediaRow(PHOTO, "photo")];
  store.put(M.BUCKET, row(PHOTO).object_key, Buffer.alloc(100, 1));
  const m = stubMedia({
    // A phone photo stored sideways: ffmpeg turns it upright for the preview.
    async probe(file) { return /preview/.test(file) ? { duration_ms: 40, width: 640, height: 960 } : { duration_ms: 40, width: 6000, height: 4000 }; },
  });
  await W.drain(deps({ media: m, suggest: answer([{ jersey: "7", team: "Storm", confidence: 0.7 }]) }));
  const p = row(PHOTO);
  assert.equal(p.status, "review");
  assert.equal(p.duration_ms, null);
  assert.deepEqual([p.width, p.height], [4000, 6000]);
  assert.equal(p.preview_key, M.previewKey(EV, PHOTO, "photo"));
  assert.match(p.preview_key, /\.jpg$/);
  assert.equal(store.get(M.BUCKET, p.preview_key).contentType, "image/jpeg");
  assert.equal(asked[0].images.length, 1);
  assert.deepEqual(db.tables.sm_market_tags.map((t) => t.athlete_id), [S7]);
});

test("the AI is a help, never a blocker: no key, no answer, or an error, the file still reaches review", async () => {
  for (const suggest of [async () => null, async () => "I can't see any numbers.", async () => { throw new Error("overloaded"); }]) {
    db.tables.sm_market_media = [mediaRow(CLIP, "clip")];
    db.tables.sm_market_tags = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      await W.drain(deps({ suggest }));
    } finally {
      console.warn = warn;
    }
    assert.equal(row(CLIP).status, "review");
    assert.equal(db.tables.sm_market_tags.length, 0);
  }
  const before = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(await W.suggestWithClaude({ prompt: "x", images: [] }), null, "no key: no call");
  } finally {
    if (before !== undefined) process.env.ANTHROPIC_API_KEY = before;
  }
  assert.equal(W.tagModel(), process.env.MARKET_TAG_MODEL || "claude-haiku-5-5");
});

test("no roster yet: no AI call at all", async () => {
  db.tables.sm_market_athletes = [];
  await W.drain(deps({ suggest: answer([{ jersey: "7", team: "Lightning", confidence: 0.9 }]) }));
  assert.equal(asked.length, 0);
  assert.equal(row(CLIP).status, "review");
});

test("a file that won't process: tried on three passes, then failed with a reason staff can read", async () => {
  const bad = stubMedia({ async preview() { throw new media.MediaError("preview: Invalid data found when processing input"); } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const first = await W.drain(deps({ media: bad }));
    assert.equal(first.processed, 1, "one try a pass, never three in a row");
    assert.equal(row(CLIP).status, "uploaded");
    assert.equal(row(CLIP).attempts, 1);
    assert.equal(row(CLIP).error, "preview: Invalid data found when processing input");
    await W.drain(deps({ media: bad }));
    assert.equal(row(CLIP).attempts, 2);
    await W.drain(deps({ media: bad }));
    assert.equal(row(CLIP).status, "failed");
    assert.equal(row(CLIP).attempts, 3);
    assert.equal((await W.drain(deps({ media: bad }))).processed, 0, "a failed file waits for staff to retry");
    // Something unexpected (not ffmpeg's answer) says so plainly.
    db.tables.sm_market_media = [mediaRow(CLIP, "clip")];
    await W.drain(deps({ media: stubMedia({ async poster() { throw new TypeError("x is not a function"); } }) }));
    assert.equal(row(CLIP).error, "Processing stopped: x is not a function");
    // The original missing from storage.
    db.tables.sm_market_media = [mediaRow(CLIP, "clip")];
    store.objects.clear();
    await W.drain(deps());
    assert.equal(row(CLIP).error, "The original isn't in storage.");
  } finally {
    console.warn = warn;
  }
});

test("a clip over an hour fails plainly, with nothing left in storage; so does a value the database won't take", async () => {
  const long = stubMedia({ async probe() { return { duration_ms: 3601 * 1000, width: 1920, height: 1080 }; } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await W.drain(deps({ media: long }));
    assert.equal(row(CLIP).status, "failed", "at once: trying again won't make it shorter");
    assert.equal(row(CLIP).attempts, 1);
    assert.equal(row(CLIP).error, "Longer than an hour. Cut it into clips, then upload those.");
    assert.ok(!store.has(M.BUCKET, M.previewKey(EV, CLIP, "clip")), "no work was done for it");
    // The database refusing the details (a check) is this file's failure, not the queue's.
    db.tables.sm_market_media = [mediaRow(CLIP, "clip")];
    const from = db.from;
    db.from = (name) => {
      const q = from(name);
      if (name !== "sm_market_media") return q;
      const update = q.update.bind(q);
      q.update = (patch) => {
        if (patch.status === "review") q.then = (res) => Promise.resolve({ data: null, error: { code: "23514", message: "new row violates check constraint" } }).then(res);
        return update(patch);
      };
      return q;
    };
    const r = await W.drain(deps());
    db.from = from;
    assert.equal(r.processed, 1);
    assert.equal(row(CLIP).status, "failed", "failed plainly, not stuck in processing");
    assert.match(row(CLIP).error, /^Its details didn't fit/);
    assert.ok(!store.has(M.BUCKET, M.previewKey(EV, CLIP, "clip")), "its previews were taken back out");
  } finally {
    console.warn = warn;
  }
});

test("after a restart: files stuck in processing go back in the queue, or fail on their third try", async () => {
  const old = new Date(clock.getTime() - W.STALE_MS - 60000).toISOString();
  const recent = new Date(clock.getTime() - 5 * 60000).toISOString();
  db.tables.sm_market_media = [
    mediaRow(CLIP, "clip", { status: "processing", attempts: 1, processing_at: old }),
    mediaRow(PHOTO, "photo", { status: "processing", attempts: 3, processing_at: old }),
    mediaRow("99999999-9999-4999-8999-999999999999", "clip", { status: "processing", attempts: 1, processing_at: recent }),
  ];
  assert.equal(await W.recover(deps()), 2);
  assert.equal(row(CLIP).status, "uploaded");
  assert.equal(row(PHOTO).status, "failed");
  assert.match(row(PHOTO).error, /three times/);
  assert.equal(row("99999999-9999-4999-8999-999999999999").status, "processing", "one still being worked on is left alone");
  await W.drain(deps());
  assert.equal(row(CLIP).status, "review");
  assert.equal(row(CLIP).attempts, 2);
});

test("one claim per file", async () => {
  const d = deps();
  const first = await W.claim(d);
  assert.equal(first.id, CLIP);
  assert.equal(first.status, "processing");
  assert.equal(await W.claim(d), null, "already taken");
});

test("removed while it was being worked on: its new files don't stay behind", async () => {
  const m = stubMedia({
    async poster(src, kind, out) {
      fs.writeFileSync(out, "POSTER");
      db.tables.sm_market_media = db.tables.sm_market_media.filter((x) => x.id !== CLIP); // staff removed it
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await W.drain(deps({ media: m }));
  } finally {
    console.warn = warn;
  }
  assert.ok(!store.has(M.BUCKET, M.previewKey(EV, CLIP, "clip")));
  assert.ok(!store.has(M.BUCKET, M.posterKey(EV, CLIP)));
});

test("kick does nothing where the worker wasn't started (tests, or SM_MARKET_WORKER=off)", async () => {
  await W.kick();
  assert.equal(row(CLIP).status, "uploaded");
  const before = process.env.SM_MARKET_WORKER;
  process.env.SM_MARKET_WORKER = "off";
  try {
    assert.equal(W.start(), false);
  } finally {
    if (before === undefined) delete process.env.SM_MARKET_WORKER;
    else process.env.SM_MARKET_WORKER = before;
  }
});

test("what ffmpeg says, read: length, size, and a phone's turn", () => {
  const said = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mov':
  Duration: 00:01:02.48, start: 0.000000, bitrate: 16000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 15000 kb/s, 59.94 fps
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s`;
  assert.deepEqual(media.parseProbe(said), { duration_ms: 62480, width: 1080, height: 1920 });
  assert.deepEqual(media.parseProbe("Stream #0:0: Video: png, rgba(pc), 1600x1600, 25 tbr\n"), { duration_ms: null, width: 1600, height: 1600 });
  assert.deepEqual(media.parseProbe("x.txt: Invalid data found when processing input"), { duration_ms: null, width: null, height: null });
  assert.deepEqual(media.displaySize({ width: 4000, height: 3000 }, { width: 640, height: 854 }), { width: 3000, height: 4000 });
  assert.deepEqual(media.displaySize({ width: 1920, height: 1080 }, { width: 854, height: 480 }), { width: 1920, height: 1080 });
  assert.equal(media.lastWords("frame=1\n/tmp/sm-market-abc/original.mp4: moov atom not found\n", "/tmp/sm-market-abc"), "/original.mp4: moov atom not found");
});

// ── The real thing, where ffmpeg is installed ────────────────────────────
test("with real ffmpeg: a 2-second clip and a photo become a watermarked preview and poster", async (t) => {
  const probe = await media.run(["-version"], { timeoutMs: 20000 });
  if (probe.code !== 0) return t.skip("ffmpeg isn't available here");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-market-test-"));
  try {
    const clip = path.join(dir, "in.mp4");
    const photo = path.join(dir, "in.jpg");
    const made = await media.run(["-f", "lavfi", "-i", "testsrc=s=1280x720:r=30:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", clip]);
    assert.equal(made.code, 0, made.stderr);
    const still = await media.run(["-f", "lavfi", "-i", "testsrc=s=1200x800:d=1", "-frames:v", "1", "-y", photo]);
    assert.equal(still.code, 0, still.stderr);
    db.tables.sm_market_media = [mediaRow(CLIP, "clip"), mediaRow(PHOTO, "photo", { created_at: "2026-11-21T18:00:01.000Z" })];
    store.put(M.BUCKET, row(CLIP).object_key, fs.readFileSync(clip));
    store.put(M.BUCKET, row(PHOTO).object_key, fs.readFileSync(photo));
    const r = await W.drain(deps({ media, suggest: async () => null }));
    assert.equal(r.processed, 2, JSON.stringify(r.results));
    const c = row(CLIP);
    assert.equal(c.status, "review", c.error);
    assert.deepEqual([c.width, c.height], [1280, 720]);
    assert.ok(Math.abs(c.duration_ms - 2000) < 100, String(c.duration_ms));
    const mp4 = store.get(M.BUCKET, c.preview_key).bytes;
    assert.equal(mp4.subarray(4, 8).toString(), "ftyp", "an MP4");
    const jpg = store.get(M.BUCKET, c.poster_key).bytes;
    assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff], "a JPEG");
    const p = row(PHOTO);
    assert.equal(p.status, "review", p.error);
    assert.deepEqual([p.width, p.height], [1200, 800]);
    // The preview really is smaller: 480 on the short side for the clip.
    const out = path.join(dir, "check.mp4");
    fs.writeFileSync(out, mp4);
    assert.deepEqual(await media.probe(out).then((i) => [i.width, i.height]), [854, 480]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
